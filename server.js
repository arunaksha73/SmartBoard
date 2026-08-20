/**
 * Smartboard Remote — server.js
 * Express + Socket.io Backend for Render.com deployment
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MULTI-FORMAT DOCUMENT SUPPORT — PRODUCTION DEPLOYMENT NOTE
 * ─────────────────────────────────────────────────────────────────────────────
 * PPT, PPTX, DOC, and DOCX files are converted to PDF using LibreOffice in
 * headless mode. This requires LibreOffice to be installed on the server.
 *
 * LOCAL DEVELOPMENT (Windows):
 *   1. Install LibreOffice: https://www.libreoffice.org/download/libreoffice/
 *   2. Ensure 'soffice' is available on your system PATH, OR set the
 *      LIBREOFFICE_PATH environment variable to the full path of soffice/soffice.exe
 *      Example (Windows): LIBREOFFICE_PATH="C:\Program Files\LibreOffice\program\soffice.exe"
 *
 * PRODUCTION / RENDER.COM / DOCKER:
 *   Use a Dockerfile that installs LibreOffice:
 *     FROM node:20-slim
 *     RUN apt-get update && apt-get install -y libreoffice --no-install-recommends && rm -rf /var/lib/apt/lists/*
 *     WORKDIR /app
 *     COPY . .
 *     RUN npm install
 *     CMD ["node", "server.js"]
 *
 * If LibreOffice is NOT available, PDF uploads continue to work normally.
 * PPT/PPTX/DOC/DOCX uploads will return a clear error message without crashing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const express = require('express');
const http = require('http');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);

// Enable CORS for all origins
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Socket.io initialization with open CORS
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  pingTimeout: 60000
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Temp dir for LibreOffice conversion output (inside uploads, not publicly served directly)
const CONVERT_TMP_DIR = path.join(UPLOAD_DIR, '_convert_tmp');

[UPLOAD_DIR, CONVERT_TMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Allowed file extensions & MIME types ──────────────────────────────────
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.ppt', '.pptx', '.doc', '.docx']);
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Some browsers/OS may report these generics — allow but still require ext check
  'application/octet-stream',
  'application/zip', // OOXML files are ZIP containers
]);

// Conversion-needed file types
const NEEDS_CONVERSION = new Set(['.ppt', '.pptx', '.doc', '.docx']);

// ─── LibreOffice detection ─────────────────────────────────────────────────
let SOFFICE_PATH = process.env.LIBREOFFICE_PATH || null;
let libreOfficeAvailable = false;

function detectLibreOffice() {
  // 1. Use explicit env var if provided
  if (SOFFICE_PATH && fs.existsSync(SOFFICE_PATH)) {
    libreOfficeAvailable = true;
    console.log(`[LibreOffice] Found via LIBREOFFICE_PATH: ${SOFFICE_PATH}`);
    return;
  }

  // 2. Linux standard paths (Docker container / Linux servers)
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

  // 3. Try common Windows paths (local Windows development)
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

  // 4. Try PATH lookup via which/where
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['soffice'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (result) {
      const candidate = result.split(/[\r\n]+/)[0].trim();
      if (fs.existsSync(candidate)) {
        SOFFICE_PATH = candidate;
        libreOfficeAvailable = true;
        console.log(`[LibreOffice] Found on PATH (soffice): ${SOFFICE_PATH}`);
        return;
      }
    }
  } catch (_) {
    // Not found on PATH
  }

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['libreoffice'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (result) {
      const candidate = result.split(/[\r\n]+/)[0].trim();
      if (fs.existsSync(candidate)) {
        SOFFICE_PATH = candidate;
        libreOfficeAvailable = true;
        console.log(`[LibreOffice] Found on PATH (libreoffice): ${SOFFICE_PATH}`);
        return;
      }
    }
  } catch (_) {
    // Not found on PATH
  }

  libreOfficeAvailable = false;
  console.warn(
    '[LibreOffice] WARNING: LibreOffice (soffice) not found on this system.\n' +
    '  → PDF uploads will work normally.\n' +
    '  → PPT/PPTX/DOC/DOCX uploads will return an error message.\n' +
    '  → Docker / Render: ensured automatically via Dockerfile.\n' +
    '  → Windows: install LibreOffice or set the LIBREOFFICE_PATH environment variable.'
  );
}

detectLibreOffice();

// ─── PIN validation helper ────────────────────────────────────────────────
function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin.trim());
}

// ─── In-memory presentation room state: PIN → presentation data ────────────
const rooms = new Map();
const tokenToPinMap = new Map();

function generateSessionToken() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
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

// ─── Retrieve active room or restore from disk fallback ────────────────────
function getOrRestoreRoom(pin) {
  if (!isValidPin(pin)) return null;
  const pinStr = String(pin).trim();
  let room = rooms.get(pinStr);
  if (room) {
    if (!room.token) {
      room.token = generateSessionToken();
      tokenToPinMap.set(room.token, pinStr);
    }
    return room;
  }

  // Fallback: check if the PDF file exists on disk (e.g. across server restarts)
  const finalFilename = `${pinStr}.pdf`;
  const finalPath = path.join(UPLOAD_DIR, finalFilename);
  if (fs.existsSync(finalPath)) {
    try {
      const stats = fs.statSync(finalPath);
      const token = generateSessionToken();
      room = {
        pin: pinStr,
        token,
        filename: finalFilename,
        pdfUrl: `/uploads/${finalFilename}`,
        currentPage: 1,
        totalPages: 1,
        createdAt: stats.mtimeMs || Date.now(),
        hasPhoneConnected: false,
        boardConnected: false
      };
      rooms.set(pinStr, room);
      tokenToPinMap.set(token, pinStr);
      console.log(`[Session] Restored PIN from disk: ${pinStr} (token: ${token})`);
      return room;
    } catch (e) {
      console.warn(`[Session] Could not read file stats for PIN ${pinStr}:`, e.message);
    }
  }
  return null;
}

// ─── Scan and restore existing presentations from uploads folder on startup ──
function scanAndRestoreExistingRooms() {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return;
    const files = fs.readdirSync(UPLOAD_DIR);
    for (const f of files) {
      const match = f.match(/^(\d{4})\.pdf$/);
      if (match) {
        const pin = match[1];
        const filePath = path.join(UPLOAD_DIR, f);
        const stats = fs.statSync(filePath);
        const token = generateSessionToken();
        rooms.set(pin, {
          pin,
          token,
          filename: f,
          pdfUrl: `/uploads/${f}`,
          currentPage: 1,
          totalPages: 1,
          createdAt: stats.mtimeMs || Date.now(),
          hasPhoneConnected: false,
          boardConnected: false
        });
        tokenToPinMap.set(token, pin);
        console.log(`[Session] Loaded existing PIN on startup: ${pin}`);
      }
    }
  } catch (err) {
    console.warn('[Startup] Could not scan uploads directory:', err.message);
  }
}

scanAndRestoreExistingRooms();

// ─── Safe random temp filename (never derived from user input) ──────────────
function randomTempName(ext) {
  return `tmp-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
}

// ─── Delete a file silently ────────────────────────────────────────────────
function silentUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn(`[Cleanup] Could not delete ${filePath}:`, e.message);
  }
}

// ─── Room cleanup: delete PDF file + remove from rooms Map ─────────────────
function cleanupRoom(pin) {
  const pinStr = String(pin).trim();
  const room = rooms.get(pinStr);
  if (room) {
    if (room.token) tokenToPinMap.delete(room.token);
    silentUnlink(path.join(UPLOAD_DIR, room.filename));
    rooms.delete(pinStr);
  } else {
    silentUnlink(path.join(UPLOAD_DIR, `${pinStr}.pdf`));
  }
}

// ─── Auto-cleanup rooms older than 2 hours (every 10 minutes) ──────────────
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [pin, room] of rooms) {
    if (now - (room.createdAt || 0) > ROOM_TTL_MS) {
      console.log(`[Session] Expired PIN: ${pin} (older than 2h)`);
      cleanupRoom(pin);
    }
  }
}, 10 * 60 * 1000); // every 10 minutes

// ─── LibreOffice conversion ────────────────────────────────────────────────
/**
 * Convert a document to PDF using LibreOffice headless mode.
 * Uses execFile (NOT exec/shell) — no shell injection possible.
 * @param {string} inputPath  - Absolute path to source file
 * @param {string} outputDir  - Directory where LibreOffice will write the PDF
 * @returns {Promise<string>} - Absolute path to the converted PDF
 */
function convertToPDF(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    if (!libreOfficeAvailable || !SOFFICE_PATH) {
      return reject(new Error(
        'Unable to convert this file. LibreOffice is not installed on this server. ' +
        'Please upload a PDF or contact the administrator.'
      ));
    }

    // Arguments passed as array — execFile does NOT use a shell, so injection is impossible
    const args = [
      '--headless',
      '--nofirststartwizard',
      '--convert-to', 'pdf',
      '--outdir', outputDir,
      inputPath
    ];

    console.log(`[LibreOffice] Converting: ${path.basename(inputPath)} → PDF`);

    execFile(SOFFICE_PATH, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[LibreOffice] Conversion error:', err.message);
        if (stderr) console.error('[LibreOffice] stderr:', stderr);
        return reject(new Error(
          'Unable to convert this file. Please try again or upload a PDF.'
        ));
      }

      // LibreOffice names the output PDF using the input file's basename
      const inputBasename = path.basename(inputPath, path.extname(inputPath));
      const convertedPath = path.join(outputDir, `${inputBasename}.pdf`);

      if (!fs.existsSync(convertedPath)) {
        console.error('[LibreOffice] Output PDF not found at expected path:', convertedPath);
        return reject(new Error(
          'Conversion produced no output. Please try again or upload a PDF.'
        ));
      }

      console.log(`[LibreOffice] Conversion successful → ${path.basename(convertedPath)}`);
      resolve(convertedPath);
    });
  });
}

// ─── Multer disk storage setup ─────────────────────────────────────────────
// File extension is preserved in the temp name so LibreOffice knows the format.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CONVERT_TMP_DIR),
  filename: (req, file, cb) => {
    // Extract extension from original filename safely (never used in shell commands)
    const origExt = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_EXTENSIONS.has(origExt) ? origExt : '.bin';
    const tempName = randomTempName(safeExt);
    cb(null, tempName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB limit
  fileFilter: (req, file, cb) => {
    const origExt = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(origExt)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE',
        `Unsupported file type: ${origExt}. Allowed: PDF, PPT, PPTX, DOC, DOCX`));
    }
    cb(null, true);
  }
});

// ---------------------------------------------------------------------------
// REST API ROUTES  (must come before express.static to avoid 405 on POST)
// ---------------------------------------------------------------------------

/**
 * POST /upload
 * Accepts PDF, PPT, PPTX, DOC, DOCX.
 * Converts non-PDF files to PDF via LibreOffice, then registers a room.
 */
app.post('/upload', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No file attached.' });
  }

  const uploadedTempPath = req.file.path;
  const origExt = path.extname(req.file.originalname || '').toLowerCase();

  // Extra security: validate extension again in route handler
  if (!ALLOWED_EXTENSIONS.has(origExt)) {
    silentUnlink(uploadedTempPath);
    return res.status(400).json({
      ok: false,
      error: `Unsupported file type: "${origExt}". Allowed: PDF, PPT, PPTX, DOC, DOCX.`
    });
  }

  const pin = generatePin();
  const finalFilename = `${pin}.pdf`;
  const finalPath = path.join(UPLOAD_DIR, finalFilename);

  try {
    if (origExt === '.pdf') {
      // ── PDF: rename directly (existing behaviour) ──
      fs.renameSync(uploadedTempPath, finalPath);
      console.log(`[Upload] PDF accepted. PIN: ${pin}`);
    } else {
      // ── PPT/PPTX/DOC/DOCX: convert via LibreOffice ──
      if (!libreOfficeAvailable) {
        silentUnlink(uploadedTempPath);
        return res.status(503).json({
          ok: false,
          error:
            'Unable to convert this file. LibreOffice is not installed on this server. ' +
            'Please upload a PDF or contact the administrator.'
        });
      }

      let convertedPath;
      try {
        convertedPath = await convertToPDF(uploadedTempPath, CONVERT_TMP_DIR);
      } catch (convErr) {
        silentUnlink(uploadedTempPath);
        return res.status(422).json({ ok: false, error: convErr.message });
      }

      // Move converted PDF to final location
      fs.renameSync(convertedPath, finalPath);
      // Clean up original uploaded non-PDF temp file
      silentUnlink(uploadedTempPath);
    }

    const pdfUrl = `/uploads/${finalFilename}`;
    const token = generateSessionToken();
    rooms.set(pin, {
      pin,
      token,
      filename: finalFilename,
      pdfUrl,
      currentPage: 1,
      totalPages: 1,
      createdAt: Date.now(),
      hasPhoneConnected: false,
      boardConnected: false
    });
    tokenToPinMap.set(token, pin);

    console.log(`[Session] Created PIN: ${pin} (token: ${token})`);
    return res.json({ ok: true, pin, token, pdfUrl });

  } catch (err) {
    console.error('[Upload Error]', err);
    silentUnlink(uploadedTempPath);
    silentUnlink(finalPath);
    return res.status(500).json({ ok: false, error: 'Could not save presentation file.' });
  }
});

// If a client/platform somehow reaches /upload with anything but POST,
// return a clear JSON diagnostic instead of a silent platform-level 405.
app.all('/upload', (req, res, next) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: `/upload only accepts POST, got ${req.method}` });
  }
  next();
});

// Multer error handler (file too large, wrong field name, unsupported type, etc.)
app.use((err, req, res, next) => {
  if (err && err.code) {
    if (err.code.startsWith('LIMIT_')) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File too large. Maximum allowed size is 150MB.'
        : err.message || 'Upload limit exceeded.';
      return res.status(400).json({ ok: false, error: msg });
    }
  }
  next(err);
});

// GET /api/presentation/:pin: Retrieve presentation details by PIN
app.get('/api/presentation/:pin', async (req, res) => {
  const { pin } = req.params;
  const room = getOrRestoreRoom(pin);
  if (!room) {
    return res.status(404).json({ ok: false, error: 'Invalid or expired presentation PIN.' });
  }

  // Ensure room has a secure token
  if (!room.token) {
    room.token = generateSessionToken();
    tokenToPinMap.set(room.token, room.pin);
  }

  return res.json({
    ok: true,
    pin: room.pin,
    token: room.token,
    filename: room.filename || `${room.pin}.pdf`,
    pdfUrl: room.pdfUrl,
    currentPage: room.currentPage,
    totalPages: room.totalPages
  });
});

// GET /api/session/validate/:token: Validate QR pairing token and return session state
app.get('/api/session/validate/:token', (req, res) => {
  const { token } = req.params;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ ok: false, error: 'Invalid session token format.' });
  }
  const tokenStr = token.trim();
  const pin = tokenToPinMap.get(tokenStr);
  if (!pin) {
    return res.status(404).json({ ok: false, error: 'Presentation session expired or invalid.' });
  }
  const room = getOrRestoreRoom(pin);
  if (!room || room.token !== tokenStr) {
    return res.status(404).json({ ok: false, error: 'Presentation session expired or invalid.' });
  }
  return res.json({
    ok: true,
    pin: room.pin,
    token: room.token,
    filename: room.filename || `${room.pin}.pdf`,
    pdfUrl: room.pdfUrl,
    currentPage: room.currentPage,
    totalPages: room.totalPages
  });
});

// POST /api/session/regenerate-token: Invalidate previous QR token and create a fresh one
app.post('/api/session/regenerate-token', (req, res) => {
  const { pin } = req.body;
  if (!isValidPin(pin)) {
    return res.status(400).json({ ok: false, error: 'Invalid PIN.' });
  }
  const room = getOrRestoreRoom(pin);
  if (!room) {
    return res.status(404).json({ ok: false, error: 'Presentation session not found.' });
  }
  // Invalidate old token
  if (room.token) {
    tokenToPinMap.delete(room.token);
  }
  const newToken = generateSessionToken();
  room.token = newToken;
  tokenToPinMap.set(newToken, room.pin);

  console.log(`[Session] Regenerated QR token for PIN ${room.pin}: ${newToken}`);
  io.to(room.pin).emit('token-regenerated', { token: newToken });
  return res.json({ ok: true, pin: room.pin, token: newToken });
});

// ─── Reachable Network & LAN IP Resolution Helpers ─────────────────────────
function getLocalIpAddress() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal (127.0.0.1) and non-IPv4 addresses
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch (err) {
    console.warn('[Network] Could not determine local IP:', err.message);
  }
  return 'localhost';
}

function getReachableRemoteUrl(req, sessionToken) {
  const forwardedHost = req.headers['x-forwarded-host'];
  const forwardedProto = req.headers['x-forwarded-proto'];
  const rawHost = forwardedHost || req.get('host') || `localhost:${PORT}`;
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto || (req.secure ? 'https' : 'http');

  let targetHost = rawHost;
  // If host is localhost/127.0.0.1 and not behind a public proxy, substitute reachable LAN IP
  const [hostname, port] = rawHost.split(':');
  if (!forwardedHost && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1')) {
    const lanIp = getLocalIpAddress();
    if (lanIp && lanIp !== 'localhost') {
      targetHost = port ? `${lanIp}:${port}` : `${lanIp}:${PORT}`;
    }
  }

  const remoteUrl = new URL('/remote', `${proto}://${targetHost}`);
  if (sessionToken) {
    remoteUrl.searchParams.set('session', sessionToken);
  }
  return remoteUrl.toString();
}

// GET /api/server-info: Network diagnostics & reachable pairing URL base
app.get('/api/server-info', (req, res) => {
  const lanIp = getLocalIpAddress();
  const remoteUrlBase = getReachableRemoteUrl(req, '');
  return res.json({
    ok: true,
    lanIp,
    port: PORT,
    remoteUrlBase
  });
});

// GET /api/session/qr/:token: Generate high-contrast QR Data URL directly
app.get('/api/session/qr/:token', async (req, res) => {
  const rawToken = typeof req.params.token === 'string' ? req.params.token.trim() : '';
  console.log(`[QR API] Request received for token: "${rawToken}"`);
  if (!rawToken) {
    console.warn('[QR API] Bad Request: Missing token');
    return res.status(400).json({ ok: false, error: 'Missing token' });
  }

  const pin = tokenToPinMap.get(rawToken);
  if (!pin) {
    console.warn(`[QR API] Not Found: Token "${rawToken}" is not mapped to any active session`);
    return res.status(404).json({ ok: false, error: 'Invalid or expired token' });
  }

  const remoteUrlString = getReachableRemoteUrl(req, rawToken);
  console.log(`[QR API] Derived reachable remote URL for pairing: "${remoteUrlString}"`);

  try {
    const dataUrl = await QRCode.toDataURL(remoteUrlString, {
      margin: 2,
      scale: 8,
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    console.log(`[QR API] Successfully generated QR code. Base64 length: ${dataUrl.length}`);
    return res.json({ ok: true, pin, remoteUrl: remoteUrlString, qrDataUrl: dataUrl });
  } catch (err) {
    console.error(`[QR API] Error generating QR code for URL "${remoteUrlString}":`, err);
    return res.status(500).json({ ok: false, error: 'Could not generate QR code.' });
  }
});

// Health check endpoint for Render platform monitoring and uptime checks
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ok: true,
  service: 'smartboard-remote',
  activeRooms: rooms.size,
  libreOfficeAvailable,
  sofficePath: SOFFICE_PATH || null,
  uptime: Math.floor(process.uptime()),
  timestamp: new Date().toISOString()
}));

// ---------------------------------------------------------------------------
// STATIC FILE SERVING
// NOTE: express.static(__dirname) was removed — it returns HTTP 405 for any
// non-GET/HEAD request (e.g. POST /upload), blocking file uploads entirely.
// Only /uploads and /public are served statically; HTML pages use sendFile.
// ---------------------------------------------------------------------------
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

// Serve Favicon & Static Brand Assets
app.get('/favicon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.sendFile(path.join(__dirname, 'favicon.svg'));
});

app.get('/favicon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(path.join(__dirname, 'favicon.png'));
});

app.get('/icon-192.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(path.join(__dirname, 'icon-192.png'));
});

app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(path.join(__dirname, 'favicon.png'));
});

// Serve UI Pages explicitly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/remote', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/board', (req, res) => {
  res.sendFile(path.join(__dirname, 'board.html'));
});

app.get('/board.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'board.html'));
});

// ---------------------------------------------------------------------------
// SOCKET.IO REALTIME CONNECTIONS
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // Join PIN channel / room
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
        room.boardConnected = true;
        io.to(pinStr).emit('board-status', { connected: true });
      } else {
        if (isReconnect || room.hasPhoneConnected) {
          console.log(`[Session] Phone reconnected PIN: ${pinStr}`);
        } else {
          console.log(`[Session] Phone connected PIN: ${pinStr}`);
          room.hasPhoneConnected = true;
        }
        // Send current board connection status to the joining phone
        socket.emit('board-status', { connected: !!room.boardConnected });
      }

      socket.emit('room-status', {
        ok: true,
        pin: pinStr,
        token: room.token,
        pdfUrl: room.pdfUrl,
        currentPage: room.currentPage,
        totalPages: room.totalPages,
        boardConnected: !!room.boardConnected
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
      socket.emit('board-status', { connected: !!room.boardConnected });
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
    socket.data = socket.data || {};
    socket.data.joinedPin = pinStr;
    socket.data.role = 'board';
    room.boardConnected = true;
    io.to(pinStr).emit('board-status', { connected: true });
    console.log(`[Session] Board connected PIN: ${pinStr}`);
    socket.emit('board-joined', {
      ok: true,
      pdfUrl: room.pdfUrl,
      currentPage: room.currentPage,
      totalPages: room.totalPages
    });
  });

  // Relay slide control command ('NEXT', 'PREV', 'GOTO')
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

  // Brightness control — relay to all clients in the room
  socket.on('brightness-command', ({ pin, brightness }) => {
    if (pin && brightness !== undefined) {
      io.to(String(pin).trim()).emit('brightness-command', { brightness });
    }
  });

  // Day/Night theme — relay to all clients in the room
  socket.on('theme-command', ({ pin, theme }) => {
    if (pin && theme) {
      io.to(String(pin).trim()).emit('theme-command', { theme });
    }
  });

  // Zoom control — relay to all clients in the room
  socket.on('zoom-command', ({ pin, action }) => {
    if (pin && action) {
      io.to(String(pin).trim()).emit('zoom-command', { action });
    }
  });

  // Fullscreen control — relay to all clients in the room
  socket.on('fullscreen-command', ({ pin, action }) => {
    if (pin) {
      const act = action || 'toggle';
      io.to(String(pin).trim()).emit('fullscreen-command', { action: act });
      io.to(String(pin).trim()).emit('request-fullscreen', { action: act });
    }
  });

  socket.on('request-fullscreen', ({ pin, action }) => {
    if (pin) {
      const act = action || 'toggle';
      io.to(String(pin).trim()).emit('fullscreen-command', { action: act });
      io.to(String(pin).trim()).emit('request-fullscreen', { action: act });
    }
  });

  // Fullscreen status report from board — relay to phone
  socket.on('fullscreen-status', ({ pin, isFullscreen }) => {
    if (pin) {
      io.to(String(pin).trim()).emit('fullscreen-status', { isFullscreen });
    }
  });

  // Presentation controls visibility — relay to all clients in the room
  socket.on('presentation-controls', ({ pin, visible }) => {
    if (pin && typeof visible === 'boolean') {
      io.to(String(pin).trim()).emit('presentation-controls', { visible });
    }
  });

  // Exit current presentation session (closes room and cleans up)
  socket.on('exit-presentation', ({ pin }) => {
    if (pin) {
      const pinStr = String(pin).trim();
      console.log(`[Session] Closed PIN: ${pinStr}`);
      io.to(pinStr).emit('exit-presentation', { pin: pinStr });
      cleanupRoom(pinStr);
    }
  });

  // Allow a client to cleanly leave a PIN room
  socket.on('leave-room', ({ pin }) => {
    if (pin) {
      const pinStr = String(pin).trim();
      socket.leave(pinStr);
    }
  });

  socket.on('disconnect', () => {
    if (socket.data && socket.data.joinedPin && socket.data.role === 'board') {
      const pinStr = socket.data.joinedPin;
      console.log(`[Session] Board disconnected PIN: ${pinStr}`);
      const room = rooms.get(pinStr);
      if (room) {
        room.boardConnected = false;
      }
      io.to(pinStr).emit('board-status', { connected: false });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Smartboard Remote server active on port ${PORT}`);
  console.log(`[LibreOffice] Conversion available: ${libreOfficeAvailable}`);
});
