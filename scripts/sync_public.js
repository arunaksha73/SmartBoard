/**
 * sync_public.js
 * Copies the canonical HTML files from /public and static assets
 * to the project root so that both local (server.js) and Vercel
 * (static routing) always serve the same, clean, QR-free files.
 */

const fs   = require('fs');
const path = require('path');

const rootDir   = path.join(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Static assets: copy from root → public
const rootAssets = ['favicon.svg', 'favicon.png', 'icon-192.png'];
rootAssets.forEach(asset => {
  const src = path.join(rootDir, asset);
  const dst = path.join(publicDir, asset);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`Copied ${asset} → public/`);
  }
});

// HTML pages: public/ is the source of truth — copy to root too
// (so root-level board.html / index.html stay in sync)
const htmlFiles = ['index.html', 'board.html'];
htmlFiles.forEach(html => {
  const src = path.join(publicDir, html);
  const dst = path.join(rootDir, html);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`Synced public/${html} → root`);
  } else {
    console.warn(`WARNING: public/${html} not found — skipping`);
  }
});

console.log('Build: public assets synced successfully!');
