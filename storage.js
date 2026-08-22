/**
 * storage.js — Google Drive Persistent Storage Module (OAuth 2.0)
 * Uses official Google Drive API v3 with User OAuth 2.0 & Refresh Token
 * to store presentation files directly under your personal Google Drive 15GB quota.
 *
 * Folder ID: 1EDu-v1jwhKUC91vIj_CVeCD_HooSvepg
 * Environment Variables:
 *   - GOOGLE_CLIENT_ID
 *   - GOOGLE_CLIENT_SECRET
 *   - GOOGLE_REFRESH_TOKEN
 *   - GOOGLE_DRIVE_FOLDER_ID
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

const GOOGLE_CLIENT_ID = (
  process.env.GOOGLE_CLIENT_ID ||
  ''
).trim();

const GOOGLE_CLIENT_SECRET = (
  process.env.GOOGLE_CLIENT_SECRET ||
  ''
).trim();

const GOOGLE_REFRESH_TOKEN = (
  process.env.GOOGLE_REFRESH_TOKEN ||
  ''
).trim();

let oauth2Client = null;
let driveClient = null;
let isStorageConfigured = false;
let initError = null;

// In-memory cache for fast fileName -> Google Drive fileId mapping
const fileIdCache = new Map();

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN) {
  try {
    console.log('[Storage] Google Drive OAuth configuration detected');
    console.log('[Storage] Google account storage active');
    console.log(`[Storage] Folder ID: ${GOOGLE_DRIVE_FOLDER_ID}`);

    oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );

    oauth2Client.setCredentials({
      refresh_token: GOOGLE_REFRESH_TOKEN
    });

    driveClient = google.drive({ version: 'v3', auth: oauth2Client });
    isStorageConfigured = true;
    console.log('[Storage] Google Drive persistent storage ACTIVE');
  } catch (err) {
    initError = `Google Drive OAuth initialization failed: ${err.message}`;
    console.error(`[Storage] ${initError}`);
    isStorageConfigured = false;
  }
} else {
  const missing = [];
  if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!GOOGLE_REFRESH_TOKEN) missing.push('GOOGLE_REFRESH_TOKEN');
  initError = `Missing required OAuth variables: ${missing.join(', ')}`;
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
 * Upload local presentation file to private Google Drive folder using personal account quota
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
