const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

fs.copyFileSync(path.join(rootDir, 'index.html'), path.join(publicDir, 'index.html'));
fs.copyFileSync(path.join(rootDir, 'board.html'), path.join(publicDir, 'board.html'));
fs.copyFileSync(path.join(rootDir, 'favicon.svg'), path.join(publicDir, 'favicon.svg'));
fs.copyFileSync(path.join(rootDir, 'favicon.png'), path.join(publicDir, 'favicon.png'));
fs.copyFileSync(path.join(rootDir, 'icon-192.png'), path.join(publicDir, 'icon-192.png'));

console.log('Public assets synced successfully!');
