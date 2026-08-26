/**
 * Smartboard Remote — server.js (Persistent Storage & High Performance)
 * Express + Socket.io Backend for Render.com & Local Deployments
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERSISTENT GOOGLE DRIVE STORAGE ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 * - GOOGLE DRIVE API PERSISTENCE: Presentations are stored privately in your
 *   dedicated Google Drive folder (GOOGLE_DRIVE_FOLDER_ID) via Service Account.
 * - RECOVERY AFTER RESTART: Even after Render restarts, redeploys, or replaces
 *   the instance, presentations and PIN sessions are automatically restored
 *   from Google Drive storage.
 * - LOCAL DEV FALLBACK: When Google Drive credentials are not provided, gracefully
 *   falls back to local disk storage (zero configuration needed for local dev).
 * - HYBRID STREAMED CACHE: Files are served through local disk cache with HTTP
 *   ETag and Range headers, downloading on-demand from Google Drive if needed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const express = require('express');
const http = require('http');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');

// Persistent Object Storage Provider
const storage = require('./storage');

const app = express();
const server = http.createServer(app);

// Disable Express fingerprinting header for performance and security
app.disable('x-powered-by');

// ─── CORS Configuration ──────────────────────────────────────────────────────
function buildAllowedOrigins() {
  const raw = (process.env.FRONTEND_URL || '').trim();
  if (!raw) return '*';
  return raw.split(',').map(o => o.trim()).filter(Boolean);
}
const ALLOWED_ORIGINS = buildAllowedOrigins();

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Socket.IO Real-time Engine (Low Latency Tuned) ──────────────────────────
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: false
  },
  transports: ['polling', 'websocket'],
  perMessageDeflate: false,
  httpCompression: false,
  maxHttpBufferSize: 1e6, // 1MB
  pingInterval: 25000,
  pingTimeout: 60000
});

const PORT = process.env.PORT || 3000;
let UPLOAD_DIR = path.join(__dirname, 'uploads');
let PUBLIC_DIR = path.join(__dirname, 'public');
let CONVERT_TMP_DIR = path.join(UPLOAD_DIR, '_convert_tmp');

// Ensure local cache directories exist safely on startup
try {
  [UPLOAD_DIR, CONVERT_TMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
} catch (e) {
  UPLOAD_DIR = path.join(os.tmpdir(), 'smartboard_uploads');
  CONVERT_TMP_DIR = path.join(UPLOAD_DIR, '_convert_tmp');
  [UPLOAD_DIR, CONVERT_TMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

// ─── Allowed File Formats ────────────────────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.ppt', '.pptx', '.doc', '.docx']);
const CONVERSION_EXTENSIONS = new Set(['.ppt', '.pptx', '.doc', '.docx']);

// ─── LibreOffice Detection & Configuration ──────────────────────────────────
let SOFFICE_PATH = process.env.LIBREOFFICE_PATH || null;
let libreOfficeAvailable = false;

function detectLibreOffice() {
  if (SOFFICE_PATH && fs.existsSync(SOFFICE_PATH)) {
    libreOfficeAvailable = true;
    console.log(`[LibreOffice] Found via LIBREOFFICE_PATH: ${SOFFICE_PATH}`);
    return;
  }

  const linuxPaths = [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/opt/libreoffice/program/soffice'
  ];
  for (const p of linuxPaths) {
    if (fs.existsSync(p)) {
      SOFFICE_PATH = p;
      libreOfficeAvailable = true;
      console.log(`[LibreOffice] Found Linux executable: ${SOFFICE_PATH}`);
      return;
    }
  }

  const windowsPaths = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];
  for (const p of windowsPaths) {
    if (fs.existsSync(p)) {
      SOFFICE_PATH = p;
      libreOfficeAvailable = true;
      console.log(`[LibreOffice] Found Windows executable: ${SOFFICE_PATH}`);
      return;
    }
  }

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['soffice'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (result) {
      const candidate = result.split(/[\r\n]+/)[0].trim();
      if (fs.existsSync(candidate)) {
        SOFFICE_PATH = candidate;
        libreOfficeAvailable = true;
        console.log(`[LibreOffice] Found on PATH (soffice): ${SOFFICE_PATH}`);
        return;
      }
    }
  } catch (_) {}

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['libreoffice'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (result) {
      const candidate = result.split(/[\r\n]+/)[0].trim();
      if (fs.existsSync(candidate)) {
        SOFFICE_PATH = candidate;
        libreOfficeAvailable = true;
        console.log(`[LibreOffice] Found on PATH (libreoffice): ${SOFFICE_PATH}`);
        return;
      }
    }
  } catch (_) {}

  libreOfficeAvailable = false;
  console.warn('[LibreOffice] Notice: LibreOffice not detected. PDF uploads will work; PPT/PPTX conversion unavailable.');
}

detectLibreOffice();

// ─── Asynchronous Filesystem Helpers ────────────────────────────────────────
async function silentUnlink(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Ignore missing files
    }
  }
}

async function safeMove(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(src, dest);
      await silentUnlink(src);
    } else {
      throw err;
    }
  }
}

// ─── In-Memory Presentation Room Store ──────────────────────────────────────
const rooms = new Map();

function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin.trim());
}

function generatePin() {
  let pin;
  let attempts = 0;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
  } while (rooms.has(pin) && attempts < 100);
  return pin;
}

// Async presentation lookup: Memory -> Local Cache -> Persistent S3 Storage
async function getOrRestoreRoom(pin) {
  if (!isValidPin(pin)) return null;
  const pinStr = String(pin).trim();

  // 1. Instant in-memory lookup
  let room = rooms.get(pinStr);
  if (room) return room;

  const finalFilename = `${pinStr}.pdf`;
  const localPath = path.join(UPLOAD_DIR, finalFilename);

  // 2. Check local disk cache
  if (fs.existsSync(localPath)) {
    try {
      const stats = await fsp.stat(localPath);
      room = {
        pin: pinStr,
        filename: finalFilename,
        pdfUrl: `/uploads/${finalFilename}`,
        currentPage: 1,
        totalPages: 1,
        createdAt: stats.mtimeMs || Date.now(),
        hasPhoneConnected: false
      };
      rooms.set(pinStr, room);
      console.log(`[Session] Restored PIN from local cache: ${pinStr}`);
      return room;
    } catch (_) {}
  }

  // 3. Check persistent object storage (survives Render restart / redeploy)
  if (storage.isConfigured()) {
    try {
      const head = await storage.headFile(finalFilename);
      if (head.exists) {
        room = {
          pin: pinStr,
          filename: finalFilename,
          pdfUrl: `/uploads/${finalFilename}`,
          currentPage: 1,
          totalPages: 1,
          createdAt: head.lastModified ? head.lastModified.getTime() : Date.now(),
          hasPhoneConnected: false
        };
        rooms.set(pinStr, room);
        console.log(`[Session] Restored PIN from persistent S3 storage: ${pinStr}`);
        return room;
      }
    } catch (err) {
      console.warn(`[Storage] Check failed for PIN ${pinStr}:`, err.message);
    }
  }

  return null;
}

// Non-blocking async room scan on startup (both local and S3 storage)
async function scanAndRestoreExistingRooms() {
  // 1. Scan persistent S3 storage first if configured
  if (storage.isConfigured()) {
    try {
      const remoteList = await storage.listPresentations();
      for (const item of remoteList) {
        if (!rooms.has(item.pin)) {
          rooms.set(item.pin, {
            pin: item.pin,
            filename: item.filename,
            pdfUrl: `/uploads/${item.filename}`,
            currentPage: 1,
            totalPages: 1,
            createdAt: item.lastModified ? item.lastModified.getTime() : Date.now(),
            hasPhoneConnected: false
          });
        }
      }
      if (remoteList.length > 0) {
        console.log(`[Startup] Restored ${remoteList.length} presentation(s) from persistent S3 storage.`);
      }
    } catch (e) {
      console.warn('[Startup] Could not list from S3 storage:', e.message);
    }
  }

  // 2. Scan local disk cache
  try {
    const files = await fsp.readdir(UPLOAD_DIR);
    const pdfFiles = files.filter(f => /^(\d{4})\.pdf$/.test(f));
    await Promise.all(pdfFiles.map(async f => {
      const pin = f.match(/^(\d{4})\.pdf$/)[1];
      if (!rooms.has(pin)) {
        const filePath = path.join(UPLOAD_DIR, f);
        try {
          const stats = await fsp.stat(filePath);
          rooms.set(pin, {
            pin,
            filename: f,
            pdfUrl: `/uploads/${f}`,
            currentPage: 1,
            totalPages: 1,
            createdAt: stats.mtimeMs || Date.now(),
            hasPhoneConnected: false
          });
        } catch (_) {}
      }
    }));
  } catch (_) {}
}

scanAndRestoreExistingRooms();

// Asynchronous room cleanup (local cache + persistent storage)
async function cleanupRoom(pin) {
  const pinStr = String(pin).trim();
  const room = rooms.get(pinStr);
  rooms.delete(pinStr);

  const filename = room && room.filename ? room.filename : `${pinStr}.pdf`;
  await silentUnlink(path.join(UPLOAD_DIR, filename));

  // Only delete from persistent storage when explicitly exiting session
  if (storage.isConfigured()) {
    await storage.deleteFile(filename);
  }
}

// Background TTL cleanup (2 hours)
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(async () => {
  const now = Date.now();
  const toClean = [];
  for (const [pin, room] of rooms) {
    if (now - (room.createdAt || 0) > ROOM_TTL_MS) {
      toClean.push(pin);
    }
  }
  for (const pin of toClean) {
    console.log(`[Session] Expired session: ${pin}`);
    await cleanupRoom(pin);
  }
}, 10 * 60 * 1000).unref();

// ─── Bounded FIFO LibreOffice Worker Queue ──────────────────────────────────
class ConversionQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.next();
    });
  }

  next() {
    if (this.running >= this.concurrency || this.queue.length === 0) return;
    this.running++;
    const { task, resolve, reject } = this.queue.shift();

    task()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this.running--;
        this.next();
      });
  }
}

const conversionQueue = new ConversionQueue(1);

function convertToPDF(inputPath, outputDir) {
  return conversionQueue.enqueue(async () => {
    if (!libreOfficeAvailable || !SOFFICE_PATH) {
      throw new Error('LibreOffice is not installed on this server. Please upload a PDF.');
    }

    const profileDir = path.join(os.tmpdir(), `lo_profile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    try {
      await fsp.mkdir(profileDir, { recursive: true });
    } catch (_) {}

    const args = [
      '--headless',
      '--invisible',
      '--nocrashreport',
      '--nodefault',
      '--nofirststartwizard',
      '--nologo',
      '--norestore',
      `-env:UserInstallation=file://${profileDir.replace(/\\/g, '/')}`,
      '--convert-to', 'pdf',
      '--outdir', outputDir,
      inputPath
    ];

    console.log(`[LibreOffice] Converting document: ${path.basename(inputPath)} → PDF`);

    try {
      await new Promise((resolve, reject) => {
        execFile(SOFFICE_PATH, args, { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) {
            console.error('[LibreOffice] Execution error:', err.message);
            if (stderr) console.error('[LibreOffice] stderr:', stderr);
            return reject(new Error('Document conversion failed. Please verify the file format.'));
          }
          resolve();
        });
      });

      const inputBasename = path.basename(inputPath, path.extname(inputPath));
      const convertedPath = path.join(outputDir, `${inputBasename}.pdf`);

      if (!fs.existsSync(convertedPath)) {
        throw new Error('Conversion completed without producing an output PDF.');
      }

      console.log(`[LibreOffice] Conversion complete: ${path.basename(convertedPath)}`);
      return convertedPath;

    } finally {
      fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

// ─── Streamed Multer Storage Setup ──────────────────────────────────────────
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const origExt = path.extname(file.originalname || '').toLowerCase();
    cb(null, origExt === '.pdf' ? UPLOAD_DIR : CONVERT_TMP_DIR);
  },
  filename: (req, file, cb) => {
    const origExt = path.extname(file.originalname || '').toLowerCase();
    const pin = generatePin();
    req.generatedPin = pin;
    if (origExt === '.pdf') {
      cb(null, `${pin}.pdf`);
    } else {
      cb(null, `${pin}-${Date.now()}${origExt}`);
    }
  }
});

const upload = multer({
  storage: diskStorage,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB
  fileFilter: (req, file, cb) => {
    const origExt = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(origExt)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE',
        `Unsupported file type: ${origExt}. Allowed: PDF, PPT, PPTX, DOC, DOCX`));
    }
    cb(null, true);
  }
});

// ─── Upload Handler (Persistent Storage Integrated) ─────────────────────────
const handleUpload = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No presentation file attached.' });
  }

  const uploadedPath = req.file.path;
  const origExt = path.extname(req.file.originalname || '').toLowerCase();
  const pin = req.generatedPin || generatePin();
  const finalFilename = `${pin}.pdf`;
  const finalPath = path.join(UPLOAD_DIR, finalFilename);

  try {
    if (origExt === '.pdf') {
      // PDF streamed directly to local destination
      console.log(`[Upload] PDF streamed to local cache. PIN: ${pin}`);
    } else {
      // Non-PDF conversion path
      if (!libreOfficeAvailable) {
        await silentUnlink(uploadedPath);
        return res.status(503).json({
          ok: false,
          error: 'Document conversion is not available on this server. Please upload a PDF.'
        });
      }

      let convertedPath;
      try {
        convertedPath = await convertToPDF(uploadedPath, CONVERT_TMP_DIR);
      } catch (convErr) {
        await silentUnlink(uploadedPath);
        return res.status(422).json({ ok: false, error: convErr.message });
      }

      await safeMove(convertedPath, finalPath);
      silentUnlink(uploadedPath);
    }

    // Persist to Google Drive storage asynchronously
    if (storage.isConfigured()) {
      storage.uploadFile(finalPath, finalFilename, 'application/pdf').catch(err => {
        console.error(`[Storage] Background upload to Google Drive failed for PIN ${pin}:`, err);
      });
    }

    const pdfUrl = `/uploads/${finalFilename}`;
    rooms.set(pin, {
      pin,
      filename: finalFilename,
      pdfUrl,
      currentPage: 1,
      totalPages: 1,
      createdAt: Date.now(),
      hasPhoneConnected: false
    });

    console.log(`[Session] Created PIN: ${pin}`);
    return res.json({ ok: true, pin, pdfUrl });

  } catch (err) {
    console.error('[Upload Error]', err);
    await silentUnlink(uploadedPath);
    await silentUnlink(finalPath);
    return res.status(500).json({ ok: false, error: 'Failed to process presentation file.' });
  }
};

app.post('/upload', upload.single('pdf'), handleUpload);
app.post('/api/upload', upload.single('pdf'), handleUpload);

app.all('/upload', (req, res, next) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: `/upload only accepts POST, received ${req.method}` });
  }
  next();
});

// Multer error handler
app.use((err, req, res, next) => {
  if (err && err.code) {
    if (err.code.startsWith('LIMIT_')) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File exceeds maximum size limit (150MB).'
        : err.message || 'Upload limit exceeded.';
      return res.status(400).json({ ok: false, error: msg });
    }
  }
  next(err);
});

// ─── Presentation Session Lookup ────────────────────────────────────────────
app.get('/api/presentation/:pin', async (req, res) => {
  const { pin } = req.params;
  const room = await getOrRestoreRoom(pin);
  if (!room) {
    return res.status(404).json({ ok: false, error: 'Invalid or expired presentation PIN.' });
  }
  return res.json({
    ok: true,
    pin: room.pin,
    pdfUrl: room.pdfUrl,
    currentPage: room.currentPage,
    totalPages: room.totalPages
  });
});

// ─── Health Check & Platform Uptime ─────────────────────────────────────────
const handleHealth = (req, res) => {
  try {
    return res.json({
      status: 'ok',
      ok: true,
      service: 'smartboard-remote',
      activeRooms: rooms.size,
      storage: {
        persistent: storage.isConfigured(),
        provider: storage.isConfigured() ? 'google-drive' : 'local-disk',
        folderId: storage.GOOGLE_DRIVE_FOLDER_ID || null
      },
      libreOfficeAvailable,
      sofficePath: SOFFICE_PATH || null,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Health check failure' });
  }
};

app.get('/health', handleHealth);
app.get('/api/health', handleHealth);

// Dynamic config endpoint to broadcast configured socket / backend URL
app.get('/api/config', (req, res) => {
  const backendUrl = (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_SOCKET_URL ||
    process.env.SOCKET_URL ||
    ''
  ).trim();
  res.json({
    ok: true,
    backendUrl,
    env: process.env.NODE_ENV || 'production'
  });
});

// ─── Persistent PDF Delivery & On-Demand Restore ────────────────────────────
// If a file is not in local disk cache (e.g. after Render restart), restore from Google Drive!
app.get('/uploads/:filename', async (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const localPath = path.join(UPLOAD_DIR, filename);

  // 1. If present in local cache, let express.static stream it
  if (fs.existsSync(localPath)) {
    return next();
  }

  // 2. If missing locally, restore from persistent Google Drive storage
  if (storage.isConfigured()) {
    const downloaded = await storage.downloadFile(filename, localPath);
    if (downloaded) {
      return next();
    }
  }

  return res.status(404).send('Presentation file not found or expired.');
});

// Serve cached PDFs with HTTP ETag & Cache-Control headers
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  }
}));

app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  etag: true
}));

// Static Assets
app.get('/favicon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(PUBLIC_DIR, 'favicon.svg'));
});

app.get('/favicon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(PUBLIC_DIR, 'favicon.png'));
});

app.get('/icon-192.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(PUBLIC_DIR, 'icon-192.png'));
});

app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(PUBLIC_DIR, 'favicon.png'));
});

// Explicit UI Page Serving
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/board', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'board.html'));
});

app.get('/board.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'board.html'));
});

app.get('/remote', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'remote.html'));
});

app.get('/remote.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'remote.html'));
});

// ─── Socket.IO Real-Time Slide Synchronization ──────────────────────────────
io.on('connection', (socket) => {
  // Join room by 4-digit PIN
  socket.on('join-room', async ({ pin, role }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = await getOrRestoreRoom(pinStr);

    if (room) {
      socket.join(pinStr);
      const isReconnect = socket.data && socket.data.joinedPin === pinStr;
      socket.data = socket.data || {};
      socket.data.joinedPin = pinStr;
      socket.data.role = role;

      if (role === 'board') {
        console.log(`[Session] Board connected PIN: ${pinStr}`);
      } else {
        if (isReconnect || room.hasPhoneConnected) {
          console.log(`[Session] Phone reconnected PIN: ${pinStr}`);
        } else {
          console.log(`[Session] Phone connected PIN: ${pinStr}`);
          room.hasPhoneConnected = true;
        }
      }

      socket.emit('room-status', {
        ok: true,
        pin: pinStr,
        pdfUrl: room.pdfUrl,
        currentPage: room.currentPage,
        totalPages: room.totalPages
      });
    } else {
      socket.emit('room-status', { ok: false, error: 'PIN not found' });
    }
  });

  // Support legacy phone-join / board-join events
  socket.on('phone-join', async ({ pin }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = await getOrRestoreRoom(pinStr);
    socket.join(pinStr);
    if (room) {
      if (room.hasPhoneConnected) {
        console.log(`[Session] Phone reconnected PIN: ${pinStr}`);
      } else {
        console.log(`[Session] Phone connected PIN: ${pinStr}`);
        room.hasPhoneConnected = true;
      }
    }
    socket.emit('phone-joined', {
      ok: !!room,
      currentPage: room ? room.currentPage : 1,
      totalPages: room ? room.totalPages : 1
    });
  });

  socket.on('board-join', async ({ pin }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = await getOrRestoreRoom(pinStr);
    if (!room) {
      socket.emit('board-joined', { ok: false, error: 'PIN not found' });
      return;
    }
    socket.join(pinStr);
    console.log(`[Session] Board connected PIN: ${pinStr}`);
    socket.emit('board-joined', {
      ok: true,
      pdfUrl: room.pdfUrl,
      currentPage: room.currentPage,
      totalPages: room.totalPages
    });
  });

  // Slide navigation ('NEXT', 'PREV', 'GOTO')
  socket.on('slide-command', async ({ pin, action, page }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = await getOrRestoreRoom(pinStr);
    if (room) {
      const maxPage = room.totalPages || 999;
      if (action === 'NEXT') room.currentPage = Math.min(maxPage, room.currentPage + 1);
      else if (action === 'PREV') room.currentPage = Math.max(1, room.currentPage - 1);
      else if (action === 'GOTO' && page) room.currentPage = Math.max(1, Math.min(maxPage, page));

      console.log(`[Session] Slide changed PIN: ${pinStr} → page ${room.currentPage}`);

      io.to(pinStr).emit('slide-command', {
        action,
        page: room.currentPage,
        totalPages: room.totalPages
      });
    } else {
      io.to(pinStr).emit('slide-command', { action, page });
    }
  });

  // Support legacy control event
  socket.on('control', async ({ pin, action, page }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = await getOrRestoreRoom(pinStr);
    if (room) {
      if (action === 'NEXT') room.currentPage++;
      else if (action === 'PREV') room.currentPage = Math.max(1, room.currentPage - 1);
      else if (action === 'GOTO' && page !== undefined) room.currentPage = page + 1;

      console.log(`[Session] Slide changed PIN: ${pinStr} → page ${room.currentPage}`);

      io.to(pinStr).emit('slide-command', {
        action,
        page: room.currentPage,
        totalPages: room.totalPages
      });
      io.to(pinStr).emit('go-to-page', { page: room.currentPage - 1, totalPages: room.totalPages });
    }
  });

  // Board reports total pages loaded
  socket.on('pdf-loaded', async ({ pin, totalPages }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = await getOrRestoreRoom(pinStr);
    if (room) {
      room.totalPages = totalPages;
      io.to(pinStr).emit('total-pages', { totalPages, currentPage: room.currentPage });
    }
  });

  // Brightness control
  socket.on('brightness-command', ({ pin, brightness }) => {
    if (pin && brightness !== undefined) {
      io.to(String(pin).trim()).emit('brightness-command', { brightness });
    }
  });

  // Theme control (day/night)
  socket.on('theme-command', ({ pin, theme }) => {
    if (pin && theme) {
      io.to(String(pin).trim()).emit('theme-command', { theme });
    }
  });

  // Zoom control
  socket.on('zoom-command', ({ pin, action }) => {
    if (pin && action) {
      io.to(String(pin).trim()).emit('zoom-command', { action });
    }
  });

  // Presentation controls visibility
  socket.on('presentation-controls', ({ pin, visible }) => {
    if (pin && typeof visible === 'boolean') {
      io.to(String(pin).trim()).emit('presentation-controls', { visible });
    }
  });

  // Exit presentation (cleans up presentation room & files asynchronously)
  socket.on('exit-presentation', async ({ pin }) => {
    if (pin) {
      const pinStr = String(pin).trim();
      console.log(`[Session] Closed PIN: ${pinStr}`);
      io.to(pinStr).emit('exit-presentation', { pin: pinStr });
      await cleanupRoom(pinStr);
    }
  });

  // Leave room cleanly
  socket.on('leave-room', ({ pin }) => {
    if (pin) {
      const pinStr = String(pin).trim();
      socket.leave(pinStr);
    }
  });

  socket.on('disconnect', () => {
    // Sockets may reconnect on tab switch / background state
  });
});

// Launch server if run as main entry point
if (require.main === module || !process.env.VERCEL) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Smartboard Remote server active on port ${PORT}`);
    console.log(`[LibreOffice] Conversion engine available: ${libreOfficeAvailable}`);
  });
}

module.exports = app;
module.exports.app = app;
module.exports.server = server;
module.exports.io = io;
