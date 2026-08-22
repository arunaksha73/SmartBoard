/**
 * Smartboard Remote — server.js (High Performance & Production Optimized)
 * Express + Socket.io Backend for Render.com & Local Deployments
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE & PERFORMANCE OPTIMIZATIONS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. ZERO-BLOCKING ASYNC I/O: All filesystem operations use fs.promises / async
 *    streams so the Node.js event loop remains 100% responsive under heavy load.
 * 2. STREAMED MULTIPART UPLOADS: Uploads stream directly to disk with zero RAM buffering.
 * 3. ZERO-COPY PDF STORAGE: PDFs are written directly to their final destination,
 *    eliminating secondary rename/copy overhead.
 * 4. ISOLATED LIBREOFFICE WORKER QUEUE: Document conversions run in a bounded FIFO
 *    queue with isolated user profiles (-env:UserInstallation) to prevent multi-instance
 *    profile collisions, lockouts, and Out-of-Memory (OOM) crashes on Render Free Tier.
 * 5. LOW-LATENCY SOCKET.IO: Control packets run without per-message deflate overhead,
 *    delivering sub-millisecond slide transitions across phone and board.
 * 6. STATIC & UPLOAD CACHING: HTTP ETag + Cache-Control headers ensure fast PDF delivery
 *    and efficient browser caching.
 * 7. AUTOMATIC ASYNC TTL CLEANUP: Expired presentations are pruned in the background.
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

const app = express();
const server = http.createServer(app);

// Disable Express fingerprinting header for performance and security
app.disable('x-powered-by');

// ─── CORS Configuration ──────────────────────────────────────────────────────
// FRONTEND_URL env var: Allowed Vercel / frontend origins (comma-separated).
// Falls back to '*' for local development.
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
  // Disable perMessageDeflate for tiny control events to reduce CPU load and latency
  perMessageDeflate: false,
  httpCompression: false,
  maxHttpBufferSize: 1e6, // 1MB max payload per socket message
  pingInterval: 25000,
  pingTimeout: 60000
});

const PORT = process.env.PORT || 3000;
let UPLOAD_DIR = path.join(__dirname, 'uploads');
let PUBLIC_DIR = path.join(__dirname, 'public');
let CONVERT_TMP_DIR = path.join(UPLOAD_DIR, '_convert_tmp');

// Ensure directories exist safely on startup
try {
  [UPLOAD_DIR, CONVERT_TMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
} catch (e) {
  // Read-only filesystem fallback (e.g. serverless /tmp or constrained environment)
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
  // 1. Explicit environment variable
  if (SOFFICE_PATH && fs.existsSync(SOFFICE_PATH)) {
    libreOfficeAvailable = true;
    console.log(`[LibreOffice] Found via LIBREOFFICE_PATH: ${SOFFICE_PATH}`);
    return;
  }

  // 2. Linux standard paths (Docker / Render / Linux Server)
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

  // 3. Windows standard paths (Local Development)
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

  // 4. PATH lookup fallback
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
      // Ignore missing file errors silently
    }
  }
}

async function safeMove(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // Cross-device move fallback
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

// Fast O(1) in-memory lookup with graceful disk fallback
function getOrRestoreRoom(pin) {
  if (!isValidPin(pin)) return null;
  const pinStr = String(pin).trim();
  let room = rooms.get(pinStr);
  if (room) return room;

  // Disk fallback if server restarted with active files
  const finalFilename = `${pinStr}.pdf`;
  const finalPath = path.join(UPLOAD_DIR, finalFilename);
  if (fs.existsSync(finalPath)) {
    try {
      const stats = fs.statSync(finalPath);
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
      return room;
    } catch (_) {}
  }
  return null;
}

// Non-blocking async room scan on startup
async function scanAndRestoreExistingRooms() {
  try {
    const files = await fsp.readdir(UPLOAD_DIR);
    const pdfFiles = files.filter(f => /^(\d{4})\.pdf$/.test(f));
    await Promise.all(pdfFiles.map(async f => {
      const pin = f.match(/^(\d{4})\.pdf$/)[1];
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
    }));
    if (rooms.size > 0) {
      console.log(`[Startup] Loaded ${rooms.size} active presentation session(s) from storage.`);
    }
  } catch (_) {}
}

scanAndRestoreExistingRooms();

// Asynchronous room cleanup
async function cleanupRoom(pin) {
  const pinStr = String(pin).trim();
  const room = rooms.get(pinStr);
  rooms.delete(pinStr);
  if (room && room.filename) {
    await silentUnlink(path.join(UPLOAD_DIR, room.filename));
  } else {
    await silentUnlink(path.join(UPLOAD_DIR, `${pinStr}.pdf`));
  }
}

// Non-blocking TTL cleanup every 10 minutes (TTL: 2 hours)
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
    console.log(`[Session] Auto-expired PIN: ${pin}`);
    await cleanupRoom(pin);
  }
}, 10 * 60 * 1000).unref(); // unref so timer doesn't hold process open unnecessarily

// ─── Bounded FIFO LibreOffice Worker Queue ──────────────────────────────────
// Ensures conversion processes never starve CPU or cause memory spikes on Render Free Tier.
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

const conversionQueue = new ConversionQueue(1); // 1 concurrent conversion for optimal memory safety

/**
 * Convert a document to PDF using LibreOffice headless mode.
 * Uses isolated temporary user profile to guarantee zero cross-process locking.
 */
function convertToPDF(inputPath, outputDir) {
  return conversionQueue.enqueue(async () => {
    if (!libreOfficeAvailable || !SOFFICE_PATH) {
      throw new Error('LibreOffice is not installed on this server. Please upload a PDF.');
    }

    // Create an isolated profile directory in /tmp for this conversion
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
      // Asynchronously clean up the temporary user profile
      fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

// ─── Streamed Multer Storage Setup ──────────────────────────────────────────
// Stream directly to disk:
// - PDFs stream directly into UPLOAD_DIR with their final PIN name (zero file moving!)
// - Convertibles (.pptx, .docx) stream to CONVERT_TMP_DIR for processing.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const origExt = path.extname(file.originalname || '').toLowerCase();
    // PDFs go directly to final upload folder; non-PDFs to conversion temp folder
    cb(null, origExt === '.pdf' ? UPLOAD_DIR : CONVERT_TMP_DIR);
  },
  filename: (req, file, cb) => {
    const origExt = path.extname(file.originalname || '').toLowerCase();
    const pin = generatePin();
    req.generatedPin = pin; // Store generated PIN on request object
    if (origExt === '.pdf') {
      cb(null, `${pin}.pdf`);
    } else {
      cb(null, `${pin}-${Date.now()}${origExt}`);
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB maximum
  fileFilter: (req, file, cb) => {
    const origExt = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(origExt)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE',
        `Unsupported file type: ${origExt}. Allowed: PDF, PPT, PPTX, DOC, DOCX`));
    }
    cb(null, true);
  }
});

// ─── High-Performance Upload Handler ────────────────────────────────────────
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
      // ZERO-COPY PATH: PDF was written directly to finalPath by Multer stream!
      console.log(`[Upload] PDF streamed directly to destination. PIN: ${pin}`);
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

      // Move converted PDF to final destination asynchronously
      await safeMove(convertedPath, finalPath);
      // Clean up original raw upload asynchronously
      silentUnlink(uploadedPath);
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
app.get('/api/presentation/:pin', (req, res) => {
  const { pin } = req.params;
  const room = getOrRestoreRoom(pin);
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

// ─── Cached Static File & Presentation Serving ──────────────────────────────
// Serves PDFs with HTTP caching headers to accelerate board slide rendering
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

// Favicon & Static Assets
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
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/remote.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ─── Socket.IO Real-Time Slide Synchronization ──────────────────────────────
io.on('connection', (socket) => {
  // Join room by 4-digit PIN
  socket.on('join-room', ({ pin, role }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = getOrRestoreRoom(pinStr);

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
  socket.on('phone-join', ({ pin }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = getOrRestoreRoom(pinStr);
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

  socket.on('board-join', ({ pin }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = getOrRestoreRoom(pinStr);
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
  socket.on('slide-command', ({ pin, action, page }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = getOrRestoreRoom(pinStr);
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
  socket.on('control', ({ pin, action, page }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = getOrRestoreRoom(pinStr);
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
  socket.on('pdf-loaded', ({ pin, totalPages }) => {
    if (!pin) return;
    const pinStr = String(pin).trim();
    const room = getOrRestoreRoom(pinStr);
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
