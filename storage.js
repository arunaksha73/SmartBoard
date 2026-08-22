/**
 * storage.js — S3-Compatible Persistent Object Storage Abstraction
 * Supports Cloudflare R2, AWS S3, Supabase, Backblaze B2, MinIO, Wasabi, etc.
 *
 * When STORAGE_BUCKET and credentials are provided in environment variables,
 * presentations are saved persistently to object storage so they survive
 * all Render container restarts, redeployments, and instance replacements.
 *
 * When storage environment variables are absent, gracefully falls back to local disk
 * (safe for local development).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');

// ─── Environment Variables Resolution ────────────────────────────────────────
const STORAGE_ENDPOINT = (process.env.STORAGE_ENDPOINT || '').trim();
const STORAGE_REGION = (process.env.STORAGE_REGION || process.env.AWS_REGION || 'auto').trim();
const STORAGE_BUCKET = (process.env.STORAGE_BUCKET || '').trim();
const STORAGE_ACCESS_KEY = (
  process.env.STORAGE_ACCESS_KEY ||
  process.env.STORAGE_ACCESS_KEY_ID ||
  process.env.AWS_ACCESS_KEY_ID ||
  ''
).trim();
const STORAGE_SECRET_KEY = (
  process.env.STORAGE_SECRET_KEY ||
  process.env.STORAGE_SECRET_ACCESS_KEY ||
  process.env.AWS_SECRET_ACCESS_KEY ||
  ''
).trim();
const STORAGE_FORCE_PATH_STYLE = process.env.STORAGE_FORCE_PATH_STYLE === 'true';
const STORAGE_PUBLIC_URL = (process.env.STORAGE_PUBLIC_URL || '').trim().replace(/\/$/, '');

let s3Client = null;
let isStorageConfigured = false;

if (STORAGE_BUCKET && STORAGE_ACCESS_KEY && STORAGE_SECRET_KEY) {
  try {
    const s3Config = {
      region: STORAGE_REGION,
      credentials: {
        accessKeyId: STORAGE_ACCESS_KEY,
        secretAccessKey: STORAGE_SECRET_KEY
      }
    };

    if (STORAGE_ENDPOINT) {
      s3Config.endpoint = STORAGE_ENDPOINT;
    }
    if (STORAGE_FORCE_PATH_STYLE) {
      s3Config.forcePathStyle = true;
    }

    s3Client = new S3Client(s3Config);
    isStorageConfigured = true;
    console.log(`[Storage] Persistent S3-compatible storage active. Bucket: "${STORAGE_BUCKET}" (${STORAGE_ENDPOINT || 'AWS standard'})`);
  } catch (err) {
    console.error('[Storage] Failed to initialize S3 client:', err.message);
    isStorageConfigured = false;
  }
} else {
  console.log('[Storage] Storage credentials not configured. Using local disk fallback (ideal for local dev).');
}

/**
 * Check if remote persistent storage is active
 */
function isConfigured() {
  return isStorageConfigured && s3Client !== null;
}

/**
 * Upload a local file to persistent object storage
 * @param {string} localFilePath - Path to local file
 * @param {string} storageKey    - Target key (e.g. "3872.pdf")
 * @param {string} contentType   - MIME type (e.g. "application/pdf")
 * @returns {Promise<boolean>}
 */
async function uploadFile(localFilePath, storageKey, contentType = 'application/pdf') {
  if (!isConfigured()) return true;

  try {
    const fileStream = fs.createReadStream(localFilePath);
    const stats = await fsp.stat(localFilePath);

    const command = new PutObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: storageKey,
      Body: fileStream,
      ContentLength: stats.size,
      ContentType: contentType
    });

    await s3Client.send(command);
    console.log(`[Storage] Uploaded to persistent storage: ${storageKey} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
    return true;
  } catch (err) {
    console.error(`[Storage] Failed to upload ${storageKey} to object storage:`, err.message);
    return false;
  }
}

/**
 * Check if a file exists in persistent storage without downloading it
 * @param {string} storageKey - e.g. "3872.pdf"
 * @returns {Promise<{exists: boolean, size?: number, lastModified?: Date}>}
 */
async function headFile(storageKey) {
  if (!isConfigured()) return { exists: false };

  try {
    const command = new HeadObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: storageKey
    });

    const response = await s3Client.send(command);
    return {
      exists: true,
      size: response.ContentLength || 0,
      lastModified: response.LastModified || new Date()
    };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return { exists: false };
    }
    console.warn(`[Storage] HeadObject check failed for ${storageKey}:`, err.message);
    return { exists: false };
  }
}

/**
 * Download a file from persistent storage to a local file path
 * @param {string} storageKey          - e.g. "3872.pdf"
 * @param {string} localDestinationPath - Destination on local disk
 * @returns {Promise<boolean>}
 */
async function downloadFile(storageKey, localDestinationPath) {
  if (!isConfigured()) return false;

  try {
    const command = new GetObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: storageKey
    });

    const response = await s3Client.send(command);
    if (!response.Body) return false;

    // Ensure parent folder exists
    await fsp.mkdir(path.dirname(localDestinationPath), { recursive: true });

    // Stream download to destination file
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(localDestinationPath);
      response.Body.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    console.log(`[Storage] Restored file from persistent storage to local cache: ${storageKey}`);
    return true;
  } catch (err) {
    console.error(`[Storage] Failed to download ${storageKey} from object storage:`, err.message);
    return false;
  }
}

/**
 * Get a readable stream for a file from persistent storage
 * @param {string} storageKey - e.g. "3872.pdf"
 * @returns {Promise<ReadableStream|null>}
 */
async function getFileStream(storageKey) {
  if (!isConfigured()) return null;

  try {
    const command = new GetObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: storageKey
    });

    const response = await s3Client.send(command);
    return response.Body || null;
  } catch (err) {
    console.error(`[Storage] Failed to get stream for ${storageKey}:`, err.message);
    return null;
  }
}

/**
 * Delete a file from persistent object storage
 * @param {string} storageKey - e.g. "3872.pdf"
 * @returns {Promise<boolean>}
 */
async function deleteFile(storageKey) {
  if (!isConfigured()) return true;

  try {
    const command = new DeleteObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: storageKey
    });

    await s3Client.send(command);
    console.log(`[Storage] Deleted from persistent storage: ${storageKey}`);
    return true;
  } catch (err) {
    console.warn(`[Storage] Could not delete ${storageKey} from object storage:`, err.message);
    return false;
  }
}

/**
 * List all presentation files stored in the bucket
 * @returns {Promise<Array<{pin: string, filename: string, size: number, lastModified: Date}>>}
 */
async function listPresentations() {
  if (!isConfigured()) return [];

  try {
    const command = new ListObjectsV2Command({
      Bucket: STORAGE_BUCKET
    });

    const response = await s3Client.send(command);
    const contents = response.Contents || [];

    const presentations = [];
    for (const item of contents) {
      const match = item.Key && item.Key.match(/^(\d{4})\.pdf$/);
      if (match) {
        presentations.push({
          pin: match[1],
          filename: item.Key,
          size: item.Size || 0,
          lastModified: item.LastModified || new Date()
        });
      }
    }
    return presentations;
  } catch (err) {
    console.error('[Storage] Failed to list presentations from bucket:', err.message);
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
  STORAGE_BUCKET,
  STORAGE_ENDPOINT,
  STORAGE_PUBLIC_URL
};
