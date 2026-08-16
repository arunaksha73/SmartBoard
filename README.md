# SmartBoard Remote

Turn any smartphone or tablet into a real-time, interactive remote control for presentation decks displayed on a classroom smartboard, projector, or large monitor.

Supports **PDF**, **PPT**, **PPTX**, **DOC**, and **DOCX** with automated server-side LibreOffice conversion and instant WebSocket synchronization.

---

## Features

- **Multi-Format Support**: Upload PDF, PPT, PPTX, DOC, or DOCX documents (up to 150 MB).
- **Automated Document Conversion**: Converts PowerPoint and Word documents to PDF headlessly using LibreOffice.
- **PIN-Based Pairing**: Fast, friction-free 4-digit PIN pairing between mobile devices and smartboard displays.
- **Isolated Multi-Session Support**: Supports 10–30 simultaneous presentations with independent PIN rooms.
- **Real-Time Slide Control**: Instant Next / Previous / Go-to-slide commands synchronized over Socket.IO.
- **Advanced Presentation Tools**:
  - Zoom In / Zoom Out / Reset Zoom
  - Brightness Dimmer Control
  - Day / Night Contrast Themes
  - Fullscreen Mode
  - Hide / Show Controls Toggle
  - Keep Screen On (WakeLock API)
  - Live Digital Clock & Animated Particles
- **Resilient Connectivity**: Automatic reconnect with dual transport support (`websocket` + `polling` fallback) across cellular networks and restricted school/corporate Wi-Fi.
- **Dockerized & Render Ready**: Includes optimized multi-stage Linux container with LibreOffice and core font packages.

---

## Architecture & How It Works

```
  ┌─────────────────────────────────────────────────────────────┐
  │                        SMARTBOARD REMOTE                    │
  └─────────────────────────────────────────────────────────────┘
          │                                           ▲
   1. Upload Document                          2. Enter PIN
 (PDF / PPT / PPTX / DOCX)                            │
          ▼                                           │
 ┌─────────────────┐                         ┌─────────────────┐
 │  Mobile Remote  │                         │ SmartBoard View │
 │ (/index.html)   │                         │  (/board.html)  │
 └────────┬────────┘                         └────────▲────────┘
          │                                           │
          │         3. Real-Time Socket.IO Channel    │
          └─────────────────► PIN Room ◄──────────────┘
```

1. **Presenter Phone / Tablet (`/index.html`)**:
   - Uploads a PDF or Office deck.
   - The backend validates the file, converts PPT/PPTX/DOC/DOCX via headless LibreOffice (if needed), saves the deck, and generates a unique 4-digit PIN.
2. **Smartboard / Screen (`/board.html`)**:
   - The user enters the 4-digit PIN.
   - The board fetches the deck metadata, renders the presentation using PDF.js onto an HTML5 `<canvas>`, and joins the PIN's Socket.IO room.
3. **Real-Time State Synchronization**:
   - Presenter commands (Next, Previous, Jump, Zoom, Brightness, Theme) are transmitted via WebSockets to the server and relayed directly to the display.
   - Authoritative slide position is maintained server-side per room, enabling seamless reconnects without losing slide position.

---

## Local Development (Windows / macOS / Linux)

### Prerequisites
- Node.js 18+ installed
- *(Optional for PPT/PPTX/DOC/DOCX)* LibreOffice installed:
  - **Windows**: Install [LibreOffice](https://www.libreoffice.org/download/libreoffice/). The app will automatically check `C:\Program Files\LibreOffice\program\soffice.exe`.
  - **Linux / macOS**: Install LibreOffice via your package manager (`sudo apt install libreoffice` or `brew install --cask libreoffice`).

### Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

Open in your browser:
- **Mobile Remote**: [http://localhost:3000](http://localhost:3000)
- **SmartBoard Display**: [http://localhost:3000/board.html](http://localhost:3000/board.html)
- **Health Check**: [http://localhost:3000/health](http://localhost:3000/health)

---

## Docker Setup

The project includes a production-ready `Dockerfile` based on `node:20-bookworm-slim` containing LibreOffice, essential fonts (`fonts-liberation`, `fonts-dejavu-core`, `fonts-freefont-ttf`), and security hardening.

### Build and Run Locally with Docker

```bash
# Build the Docker image
docker build -t smartboard-remote .

# Run the container (maps host port 3000 to container port 3000)
docker run --rm -p 3000:3000 smartboard-remote
```

Test the container at `http://localhost:3000`.

---

## Deployment to Render

You can deploy SmartBoard Remote to **Render** using Docker.

### Method 1: Using Blueprint / `render.yaml` (Recommended)

1. Push this repository to GitHub:
   ```bash
   git add .
   git commit -m "Configure Docker deployment for Render"
   git push origin main
   ```
2. Log in to [Render Dashboard](https://dashboard.render.com).
3. Click **New +** → **Blueprint**.
4. Connect your `SmartBoard` GitHub repository.
5. Render will automatically detect `render.yaml` and configure the service as a Docker Web Service.
6. Click **Apply**.

---

### Method 2: Manual Web Service Setup on Render

1. Log in to [Render Dashboard](https://dashboard.render.com).
2. Click **New +** → **Web Service**.
3. Select **Build and deploy from a Git repository** and connect your repo: `https://github.com/arunaksha73/SmartBoard.git`.
4. Configure the service:
   - **Name**: `smartboard-remote`
   - **Region**: Select your preferred region (e.g., Oregon, Frankfurt, Singapore)
   - **Branch**: `main`
   - **Root Directory**: *(leave blank)*
   - **Language / Environment**: `Docker`
   - **Dockerfile Path**: `./Dockerfile`
   - **Instance Type**: `Free`
5. **Advanced Settings**:
   - **Health Check Path**: `/health`
   - **Environment Variables**:
     - `NODE_ENV` = `production`
6. Click **Create Web Service**.

---

## Environment Variables

Reference variables are defined in `.env.example`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on (Render sets this automatically). |
| `NODE_ENV` | `production` | Node environment (`development` / `production`). |
| `LIBREOFFICE_PATH` | *(Auto-detected)* | Custom path to `soffice` binary if needed. |

---

## Health Check Endpoint

```http
GET /health
```

**Response (200 OK):**
```json
{
  "status": "ok",
  "ok": true,
  "service": "smartboard-remote",
  "activeRooms": 0,
  "libreOfficeAvailable": true,
  "sofficePath": "/usr/bin/soffice",
  "uptime": 120,
  "timestamp": "2026-08-16T18:00:00.000Z"
}
```

---

## Render Free Tier Considerations

- **Spin-Down on Idle**: Render's free tier spins down instances after 15 minutes of inactivity. Incoming requests will automatically wake the instance within ~30–50 seconds.
- **Ephemeral Filesystem**: Uploaded presentations are stored locally in the container's `/uploads` directory. When an instance restarts or spins down, uploaded files and active PIN sessions reset. This is ideal for short classroom sessions and presentations.
- **Session Auto-Cleanup**: The server automatically purges presentations older than 2 hours to keep memory and disk usage minimal.

---

## Security Hardening

- **No Shell Execution**: Document conversion uses `execFile` with direct arguments, preventing arbitrary command injection.
- **Randomized File Names**: Uploaded files receive cryptographically safe random names.
- **Extension & MIME Validation**: Strict verification allows only `.pdf`, `.ppt`, `.pptx`, `.doc`, `.docx`.
- **Path Traversal Protection**: PIN parameters are strictly checked against `/^\d{4}$/` before referencing the filesystem.
- **150 MB Upload Ceiling**: Built-in limits protect memory and prevent storage exhaustion.

---

## Author & Credits

Created with ❤️ by **Arunaksha Das**  
- GitHub: [github.com/arunaksha73](https://github.com/arunaksha73)  
- LinkedIn: [linkedin.com/in/arunaksha-das](https://linkedin.com/in/arunaksha-das)  
- Instagram: [instagram.com/arunaksha_das](https://instagram.com/arunaksha_das)
