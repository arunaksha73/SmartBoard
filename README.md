# Smartboard Remote

Turn a phone into a real-time remote control for a PDF deck on a classroom smartboard.
Upload a PDF on your phone → get a 4-digit PIN → enter it on the board → drive slides live over WebSockets.

## How it works

1. **Phone** (`/index.html`) — upload a PDF. The server stores it and mints a 4-digit PIN.
2. **Board** (`/board.html`) — enter the PIN. The board loads the PDF with PDF.js and renders it fullscreen on a `<canvas>`.
3. Both devices join a **Socket.IO room named after the PIN**. Tapping Next/Previous on the phone emits a `control` event; the server updates the authoritative page number for that room and broadcasts `go-to-page` to everyone in it — including the board, instantly.
4. Page state lives server-side per PIN, so if the board's browser reloads or a socket reconnects (e.g. a Wi-Fi hiccup), it re-syncs to the correct slide on rejoin.

## Run locally

```bash
npm install
npm start
```

The server listens on `http://localhost:3000` (or `$PORT` if set).

- On the phone: open `http://<your-computer's-LAN-IP>:3000` (phone and computer must share a network for local testing — for real cross-network use, deploy it, see below).
- On the board/computer: open `http://<your-computer's-LAN-IP>:3000/board.html`.

## Deploy (Render / Glitch / Replit — free tier)

The app is a single Node process that serves both the API and the static frontend, so any of these work with zero config changes:

### Render
1. Push this folder to a GitHub repo.
2. New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Render sets `PORT` automatically — the server already reads `process.env.PORT`.
5. **Important:** Render's free tier has an *ephemeral filesystem* — uploaded PDFs and PIN mappings are lost on redeploy/restart. That's fine for single-class-period use; just re-upload if the service spins down after idling.

### Glitch
1. Import from GitHub (or paste in the files).
2. Glitch auto-detects `npm start` from `package.json`.
3. Glitch also has an ephemeral-ish filesystem on the free tier — same caveat as above.

### Replit
1. Create a Node.js Repl, add these files.
2. Click **Run** (it executes `npm start`).
3. Use the Replit-provided `https://<repl-name>.<user>.repl.co` URL on both the phone and the board.

## Why it works across cellular and Wi-Fi

- Socket.IO is configured with CORS wide open and both `polling` and `websocket` transports, so pairing succeeds even when a network's proxy blocks WebSocket upgrades — it falls back to long-polling automatically.
- All state sync happens through the server (not peer-to-peer), so the phone (4G/5G) and the board (school Wi-Fi) never need to talk to each other directly — they only need a path to your deployed server.

## Notes

- PDFs are capped at 75MB (`server.js` → `multer` `limits.fileSize`) — raise if needed.
- Rooms and files live in memory/disk for the life of the server process; there's no scheduled cleanup, which is intentional for a short-lived, single-session tool. Add a cron/interval if you want long-running multi-day retention limits.
