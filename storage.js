/**
 * storage.js — Google Drive Persistent Storage Module
 * Official Google Drive API v3 with JWT Service Account Authentication
 *
 * Folder ID: 1EDu-v1jwhKUC91vIj_CVeCD_HooSvepg
 * Supports: GOOGLE_SERVICE_ACCOUNT_JSON OR (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { google } = require('googleapis');

// ─── Environment Variable Resolution ────────────────────────────────────────
const GOOGLE_DRIVE_FOLDER_ID = (
  process.env.GOOGLE_DRIVE_FOLDER_ID ||
  '1EDu-v1jwhKUC91vIj_CVeCD_HooSvepg'
).trim();

let GOOGLE_SERVICE_ACCOUNT_EMAIL = (
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
  process.env.GOOGLE_CLIENT_EMAIL ||
  ''
).trim();

let GOOGLE_PRIVATE_KEY = (
  process.env.GOOGLE_PRIVATE_KEY ||
  ''
).trim();

let initError = null;

// Parse GOOGLE_SERVICE_ACCOUNT_JSON if provided
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  try {
    let rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    // Handle base64 encoded JSON if provided
    if (!rawJson.startsWith('{') && !rawJson.startsWith('"')) {
      try {
        const decoded = Buffer.from(rawJson, 'base64').toString('utf8').trim();
        if (decoded.startsWith('{')) {
          rawJson = decoded;
        }
      } catch (_) {}
    }
    // Remove enclosing quotes if user wrapped the whole JSON string in quotes
    if ((rawJson.startsWith('"') && rawJson.endsWith('"')) || (rawJson.startsWith("'") && rawJson.endsWith("'"))) {
      rawJson = rawJson.slice(1, -1);
    }

    const parsed = JSON.parse(rawJson);
    if (parsed.client_email && !GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      GOOGLE_SERVICE_ACCOUNT_EMAIL = parsed.client_email.trim();
    }
    if (parsed.private_key && !GOOGLE_PRIVATE_KEY) {
      GOOGLE_PRIVATE_KEY = parsed.private_key.trim();
    }
  } catch (err) {
    initError = `Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: ${err.message}`;
    console.error(`[Storage] ${initError}`);
  }
}

// Format private key properly (convert escaped \\n to real \n)
if (GOOGLE_PRIVATE_KEY) {
  // Strip outer quotes if key was pasted with quotes
  if ((GOOGLE_PRIVATE_KEY.startsWith('"') && GOOGLE_PRIVATE_KEY.endsWith('"')) ||
      (GOOGLE_PRIVATE_KEY.startsWith("'") && GOOGLE_PRIVATE_KEY.endsWith("'"))) {
    GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.slice(1, -1);
  }
  GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
}

let driveClient = null;
let isStorageConfigured = false;
const fileIdCache = new Map();

if (GOOGLE_DRIVE_FOLDER_ID && GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY) {
  try {
    console.log('[Storage] Google Drive configuration detected');
    console.log(`[Storage] Service account: ${GOOGLE_SERVICE_ACCOUNT_EMAIL}`);
    console.log(`[Storage] Folder ID: ${GOOGLE_DRIVE_FOLDER_ID}`);

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
    console.log('[Storage] Google Drive persistent storage ACTIVE');
  } catch (err) {
    initError = `Google Drive client initialization failed: ${err.message}`;
    console.error(`[Storage] ${initError}`);
    isStorageConfigured = false;
  }
} else {
  if (!initError) {
    const missing = [];
    if (!GOOGLE_SERVICE_ACCOUNT_EMAIL) missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_JSON');
    if (!GOOGLE_PRIVATE_KEY) missing.push('GOOGLE_PRIVATE_KEY / GOOGLE_SERVICE_ACCOUNT_JSON');
    if (!GOOGLE_DRIVE_FOLDER_ID) missing.push('GOOGLE_DRIVE_FOLDER_ID');
    initError = `Missing required variables: ${missing.join(', ')}`;
  }
  console.log(`[Storage] ${initError}`);
  console.log('[Storage] Using local-disk fallback (ideal for local dev).');
}

/**
 * Check if Google Drive storage is active
 */
function isConfigured() {
  return isStorageConfigured && driveClient !== null;
}

/**
 * Find a file in Google Drive folder by exact filename
 */
async function findFileByName(fileName) {
  if (!isConfigured()) return null;

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
    console.warn(`[Storage] Google Drive file lookup error for "${fileName}":`, err.message);
    return null;
  }
}

/**
 * Upload local presentation file to private Google Drive folder
 */
async function uploadFile(localFilePath, fileName, contentType = 'application/pdf') {
  if (!isConfigured()) return true;

  try {
    const stats = await fsp.stat(localFilePath);
    const media = {
      mimeType: contentType,
      body: fs.createReadStream(localFilePath)
    };

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
      console.log(`[Storage] Uploaded to Google Drive: ${fileName} (ID: ${res.data.id}, ${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
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
 * Check if a file exists in Google Drive folder without downloading
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
  GOOGLE_DRIVE_FOLDER_ID,
  getInitError: () => initError
};
