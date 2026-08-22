/**
 * storage.js — Google Drive Persistent Object Storage Abstraction
 * Uses the official Google Drive API v3 with Service Account authentication.
 *
 * Presentations are stored privately in your designated Google Drive folder:
 * (GOOGLE_DRIVE_FOLDER_ID = 1EDu-v1jwhKUC91vIj_CVeCD_HooSvepg)
 *
 * Survives all Render container restarts, redeployments, and instance replacements.
 * When Google credentials are not set, transparently falls back to local disk (uploads/).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { google } = require('googleapis');

// ─── Environment Variables Resolution ────────────────────────────────────────
const GOOGLE_DRIVE_FOLDER_ID = (
  process.env.GOOGLE_DRIVE_FOLDER_ID ||
  '1EDu-v1jwhKUC91vIj_CVeCD_HooSvepg'
).trim();

const GOOGLE_SERVICE_ACCOUNT_EMAIL = (
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
  process.env.GOOGLE_CLIENT_EMAIL ||
  ''
).trim();

let GOOGLE_PRIVATE_KEY = (
  process.env.GOOGLE_PRIVATE_KEY ||
  ''
).trim();

// Support full JSON credential block if provided via GOOGLE_SERVICE_ACCOUNT_JSON
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  try {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (parsed.client_email) {
      if (!GOOGLE_SERVICE_ACCOUNT_EMAIL) {
        GOOGLE_SERVICE_ACCOUNT_EMAIL = parsed.client_email;
      }
    }
    if (parsed.private_key && !GOOGLE_PRIVATE_KEY) {
      GOOGLE_PRIVATE_KEY = parsed.private_key;
    }
  } catch (err) {
    console.warn('[Storage] Could not parse GOOGLE_SERVICE_ACCOUNT_JSON:', err.message);
  }
}

// Clean up private key formatting (handles escaped \n in environment variables)
if (GOOGLE_PRIVATE_KEY) {
  GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
}

let driveClient = null;
let isStorageConfigured = false;
// Fast in-memory cache: fileName -> Google Drive fileId
const fileIdCache = new Map();

if (GOOGLE_DRIVE_FOLDER_ID && GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY) {
  try {
    const auth = new google.auth.JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive'
      ]
    });

    driveClient = google.drive({ version: 'v3', auth });
    isStorageConfigured = true;
    console.log(`[Storage] Google Drive persistent storage active. Folder ID: "${GOOGLE_DRIVE_FOLDER_ID}"`);
  } catch (err) {
    console.error('[Storage] Failed to initialize Google Drive client:', err.message);
    isStorageConfigured = false;
  }
} else {
  console.log('[Storage] Google Drive credentials not configured. Using local disk fallback (ideal for local dev).');
}

/**
 * Check if Google Drive persistent storage is active
 */
function isConfigured() {
  return isStorageConfigured && driveClient !== null;
}

/**
 * Find a file in the Google Drive folder by exact filename
 * @param {string} fileName - e.g. "3872.pdf"
 * @returns {Promise<{id: string, name: string, size?: number, modifiedTime?: string}|null>}
 */
async function findFileByName(fileName) {
  if (!isConfigured()) return null;

  // Check in-memory cache first
  const cachedId = fileIdCache.get(fileName);
  if (cachedId) {
    return { id: cachedId, name: fileName };
  }

  try {
    const res = await driveClient.files.list({
      q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and name = '${fileName}' and trashed = false`,
      fields: 'files(id, name, size, modifiedTime)',
      spaces: 'drive',
      pageSize: 1
    });

    const file = res.data.files && res.data.files[0];
    if (file && file.id) {
      fileIdCache.set(fileName, file.id);
      return file;
    }
    return null;
  } catch (err) {
    console.warn(`[Storage] Google Drive lookup failed for "${fileName}":`, err.message);
    return null;
  }
}

/**
 * Upload a local presentation file to the private Google Drive folder
 * @param {string} localFilePath - Path to local file
 * @param {string} fileName      - Target filename (e.g. "3872.pdf")
 * @param {string} contentType   - MIME type (e.g. "application/pdf")
 * @returns {Promise<boolean>}
 */
async function uploadFile(localFilePath, fileName, contentType = 'application/pdf') {
  if (!isConfigured()) return true;

  try {
    const stats = await fsp.stat(localFilePath);
    const media = {
      mimeType: contentType,
      body: fs.createReadStream(localFilePath)
    };

    // Check if file already exists in folder (update instead of duplicate)
    const existing = await findFileByName(fileName);
    let res;

    if (existing && existing.id) {
      res = await driveClient.files.update({
        fileId: existing.id,
        media,
        fields: 'id, name, size'
      });
      console.log(`[Storage] Updated existing Google Drive file: ${fileName} (ID: ${existing.id})`);
    } else {
      res = await driveClient.files.create({
        requestBody: {
          name: fileName,
          parents: [GOOGLE_DRIVE_FOLDER_ID]
        },
        media,
        fields: 'id, name, size'
      });
      console.log(`[Storage] Uploaded to Google Drive folder: ${fileName} (ID: ${res.data.id}, ${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
    }

    if (res && res.data && res.data.id) {
      fileIdCache.set(fileName, res.data.id);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`[Storage] Failed to upload "${fileName}" to Google Drive:`, err.message);
    return false;
  }
}

/**
 * Check if a file exists in Google Drive without downloading it
 * @param {string} fileName - e.g. "3872.pdf"
 * @returns {Promise<{exists: boolean, size?: number, lastModified?: Date}>}
 */
async function headFile(fileName) {
  if (!isConfigured()) return { exists: false };

  try {
    const file = await findFileByName(fileName);
    if (file && file.id) {
      return {
        exists: true,
        size: Number(file.size) || 0,
        lastModified: file.modifiedTime ? new Date(file.modifiedTime) : new Date()
      };
    }
    return { exists: false };
  } catch (err) {
    return { exists: false };
  }
}

/**
 * Download a file from Google Drive to a local file path
 * @param {string} fileName            - e.g. "3872.pdf"
 * @param {string} localDestinationPath - Destination on local disk
 * @returns {Promise<boolean>}
 */
async function downloadFile(fileName, localDestinationPath) {
  if (!isConfigured()) return false;

  try {
    const file = await findFileByName(fileName);
    if (!file || !file.id) {
      return false;
    }

    const res = await driveClient.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'stream' }
    );

    if (!res.data) return false;

    // Ensure parent destination folder exists
    await fsp.mkdir(path.dirname(localDestinationPath), { recursive: true });

    await new Promise((resolve, reject) => {
      const destStream = fs.createWriteStream(localDestinationPath);
      res.data.pipe(destStream);
      destStream.on('finish', resolve);
      destStream.on('error', reject);
    });

    console.log(`[Storage] Restored file from Google Drive to local cache: ${fileName}`);
    return true;
  } catch (err) {
    console.error(`[Storage] Failed to download "${fileName}" from Google Drive:`, err.message);
    return false;
  }
}

/**
 * Get a readable stream for a file from Google Drive
 * @param {string} fileName - e.g. "3872.pdf"
 * @returns {Promise<ReadableStream|null>}
 */
async function getFileStream(fileName) {
  if (!isConfigured()) return null;

  try {
    const file = await findFileByName(fileName);
    if (!file || !file.id) return null;

    const res = await driveClient.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'stream' }
    );

    return res.data || null;
  } catch (err) {
    console.error(`[Storage] Failed to get stream for "${fileName}" from Google Drive:`, err.message);
    return null;
  }
}

/**
 * Delete a presentation file from Google Drive
 * @param {string} fileName - e.g. "3872.pdf"
 * @returns {Promise<boolean>}
 */
async function deleteFile(fileName) {
  if (!isConfigured()) return true;

  try {
    const file = await findFileByName(fileName);
    if (file && file.id) {
      await driveClient.files.delete({ fileId: file.id });
      fileIdCache.delete(fileName);
      console.log(`[Storage] Deleted from Google Drive: ${fileName} (ID: ${file.id})`);
      return true;
    }
    return true;
  } catch (err) {
    console.warn(`[Storage] Could not delete "${fileName}" from Google Drive:`, err.message);
    return false;
  }
}

/**
 * List all presentation files stored in the Google Drive folder
 * @returns {Promise<Array<{pin: string, filename: string, size: number, lastModified: Date}>>}
 */
async function listPresentations() {
  if (!isConfigured()) return [];

  try {
    const res = await driveClient.files.list({
      q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, size, modifiedTime)',
      spaces: 'drive',
      pageSize: 100
    });

    const files = res.data.files || [];
    const presentations = [];

    for (const f of files) {
      const match = f.name && f.name.match(/^(\d{4})\.pdf$/);
      if (match) {
        fileIdCache.set(f.name, f.id);
        presentations.push({
          pin: match[1],
          filename: f.name,
          size: Number(f.size) || 0,
          lastModified: f.modifiedTime ? new Date(f.modifiedTime) : new Date()
        });
      }
    }

    return presentations;
  } catch (err) {
    console.error('[Storage] Failed to list presentations from Google Drive:', err.message);
    return [];
  }
}

module.exports = {
  isConfigured,
  uploadFile,
  headFile,
  downloadFile,
  getFileStream,
  deleteFile,
  listPresentations,
  GOOGLE_DRIVE_FOLDER_ID
};
