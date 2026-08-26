/**
 * sync_public.js — SmartBoard Build Script
 *
 * Copies static assets from root → public/ and syncs public/ HTML → root.
 * Generates remote.html as a direct alias of index.html.
 * If BACKEND_URL is set (e.g. on Vercel), it is injected into the HTML as
 * a synchronous inline <script> so the frontend knows the Render backend URL
 * immediately at runtime — no async fetch race condition.
 *
 * Usage:
 *   node scripts/sync_public.js
 *
 * Environment variables:
 *   BACKEND_URL   — the production backend origin (e.g. https://smartboard-remote.onrender.com)
 *                   If not set, defaults to empty string (frontend uses window.location.origin)
 */

const fs   = require('fs');
const path = require('path');

const rootDir    = path.join(__dirname, '..');
const publicDir  = path.join(rootDir, 'public');
const backendUrl = (process.env.BACKEND_URL || '').trim().replace(/\/$/, '');

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Static assets: root → public
const rootAssets = ['favicon.svg', 'favicon.png', 'icon-192.png'];
rootAssets.forEach(asset => {
  const src = path.join(rootDir, asset);
  const dst = path.join(publicDir, asset);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`Copied ${asset} → public/`);
  }
});

/**
 * Inject BACKEND_URL as a synchronous inline <script> into an HTML file.
 * Replaces (or inserts) a <script id="smartboard-config"> block so the
 * value is available synchronously before any other script runs.
 * If BACKEND_URL is empty, the injection is a no-op (safe for local dev).
 */
function injectBackendUrl(htmlPath) {
  if (!fs.existsSync(htmlPath)) {
    console.warn(`WARNING: ${htmlPath} not found — skipping injection`);
    return;
  }

  let html = fs.readFileSync(htmlPath, 'utf8');

  // Remove any previously injected block (idempotent)
  html = html.replace(/<script id="smartboard-config"[\s\S]*?<\/script>\s*/g, '');

  if (backendUrl) {
    // Inject immediately before the first <script> tag so it's always first
    const injection = `<script id="smartboard-config">window.SMARTBOARD_BACKEND_URL="${backendUrl}";</script>\n  `;
    html = html.replace(/(<script[\s>])/, injection + '$1');
    console.log(`Injected BACKEND_URL="${backendUrl}" into ${path.basename(htmlPath)}`);
  } else {
    console.log(`BACKEND_URL not set — skipping injection in ${path.basename(htmlPath)} (local dev mode)`);
  }

  fs.writeFileSync(htmlPath, html, 'utf8');
}

// HTML pages: public/ is the source of truth — inject then sync to root
//
// NOTE: index.html is the device-detection entry point (NOT the Remote UI).
//       remote.html is its own standalone Remote UI file.
//       board.html  is the standalone Display/Board UI file.
//       Each is injected and synced independently.
const htmlFiles = ['index.html', 'board.html', 'remote.html'];
htmlFiles.forEach(html => {
  const src = path.join(publicDir, html);
  const dst = path.join(rootDir, html);
  if (fs.existsSync(src)) {
    // Inject BACKEND_URL into the public/ copy
    injectBackendUrl(src);
    // Sync public/ → root (so server.js local dev also serves the right file)
    fs.copyFileSync(src, dst);
    console.log(`Synced public/${html} → root`);
  } else {
    console.warn(`WARNING: public/${html} not found — skipping`);
  }
});

console.log('Build: public assets synced successfully!');
if (backendUrl) {
  console.log(`Build: BACKEND_URL = ${backendUrl}`);
} else {
  console.log('Build: BACKEND_URL not set (local dev — frontend will use window.location.origin)');
}
