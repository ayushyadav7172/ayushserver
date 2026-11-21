# AyushServer: Termux Media & Document Processing Studio

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Android%20Termux-blue?logo=android&logoColor=white" alt="Platform">
  <img src="https://img.shields.io/badge/Node.js-v20%2B-green?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/FFmpeg-Ready-red?logo=ffmpeg&logoColor=white" alt="FFmpeg">
  <img src="https://img.shields.io/badge/Database-SQLite%20WAL-lightgrey?logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Tests-51%20Passed-brightgreen?logo=checkmarx&logoColor=white" alt="Tests">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
</p>

A high-performance, self-hosted, offline-first media and document studio built natively for **Android via Termux**. 

AyushServer turns your Android smartphone into a personal media workstation. It provides a modern, responsive web dashboard with direct access to internal phone storage (`/sdcard`), real-time Server-Sent Events (SSE) progress streaming, an intelligent FFmpeg background queue, and zero-RAM-buffering pipelines capable of processing 3GB+ files without memory pressure.

---

## 🌟 Key Engineering Highlights

* **Direct Storage Mode (Zero Disk Duplication):** Browse `/sdcard`, `Download`, `DCIM`, `Movies`, and `Music` directly through the server-side file explorer. Output files are written in-place with zero intermediary cache waste.
* **Stream-Based Processing:** Files are piped directly through streams and child processes, preventing Node.js buffer exhaustion and Out-Of-Memory (OOM) crashes on Android.
* **Intelligent Concurrency Queue:** Background worker queue manages concurrent FFmpeg operations with real-time speed calculation, ETA estimation, and graceful cancellation.
* **SQLite Persistence (WAL Mode):** Complete job history, system analytics, and runtime configurations persist safely across server restarts using a high-concurrency SQLite storage engine.
* **Android Wake-Lock Integration:** Automatically requests Termux CPU wake-lock during heavy FFmpeg or PDF operations and releases it immediately upon completion to conserve battery.
* **Multi-Network Connectivity:** Native support for Localhost, local Wi-Fi / LAN, Android Hotspot (`ap0`), and Cellular Mobile Carrier networks (`ccmni` CGNAT IPv4/IPv6).
* **Zero External Dependencies / 100% Offline:** Fully self-contained UI with bundled vanilla CSS/JS. No external CDNs or internet access required.

---

## 📱 Studios & Capabilities

### 1. 🎬 Media Studio (`/media`)
Powered by native FFmpeg with frame-level control:
* **Format Conversion & Remuxing:** Convert between MP4, WebM, MKV, AVI, and GIF. Includes ultra-fast lossless stream copy (`-c:v copy`) for instant container swaps.
* **Audio Track Manipulation:** Replace or convert audio streams (AAC, MP3, AC3, Opus, FLAC) while preserving 100% untouched video quality.
* **Audio Extraction:** Strip video tracks and export audio directly to MP3, AAC, FLAC, WAV (lossless), or OGG.
* **Video Compression:** Adjustable Constant Rate Factor (CRF 18–35), encoder speed presets (`ultrafast` to `slow`), and audio bitrate settings.
* **Trimming & Cutting:** Frame-accurate cut points with milliseconds precision or lightning-fast stream copy mode.
* **Scaling & Aspect Ratio:** Presets for 1080p, 720p, 480p, 360p, or custom dimensions with locked proportions.
* **Rotation & Mirroring:** 90° CW, 90° CCW, 180°, horizontal mirror, and vertical flip.
* **High-Quality GIF Creation:** Two-pass `palettegen` and `paletteuse` algorithm for crisp, artifact-free animated GIFs.
* **Raw FFmpeg Terminal Mode:** Direct tokenized execution (`{input}`, `{output_dir}`) with strict path allowlist security.
* **Live SSE Progress:** Real-time percentage, elapsed time, current frame, FPS, and encoding speed multiplier (e.g., `3.4x`).

### 2. 🖼️ Image Studio (`/image`)
High-throughput image processing powered by **Sharp**:
* **Format Conversion:** Seamlessly convert between WebP, AVIF, PNG, JPEG, and TIFF.
* **Smart Compression:** Configurable quality controls and lossy/lossless optimization.
* **Transformations:** Dimension scaling, cropping, rotation, and orientation flipping.
* **Visual Filters:** Grayscale, blur, sharpen, negate, and brightness adjustment.
* **Metadata Inspector:** Full EXIF, dimensions, color space, and channel analysis.

### 3. 📄 PDF Studio (`/pdf`)
Comprehensive document utilities powered by `qpdf`, `ghostscript`, and `poppler`:
* **Merge & Combine:** Combine multiple PDF documents into a single document in custom order.
* **Split & Extract:** Extract page ranges or split entire documents into single pages.
* **Multi-Stage Compression:** Optimize file size using Ghostscript presets (`screen`, `ebook`, `printer`).
* **Security & Encryption:** Add password protection and permission restrictions.
* **Page Transformations:** Rotate individual or all pages (90°, 180°, 270°).
* **Text & Image Extraction:** Extract text content and embedded images directly.

### 4. 📊 Dashboard & System Monitor (`/dashboard`)
* **Real-time Metrics:** Process and system RSS memory, heap allocations, and disk space usage.
* **Queue Controller:** Live view of active and pending jobs, with runtime worker concurrency configuration (1–4 concurrent processes).
* **Job History & Logs:** Searchable history of completed, failed, and cancelled tasks with terminal log inspect modal.
* **System Health & Warnings:** Live warning collector with one-click error clearing.
* **Auto-Refresh Engine:** Configurable live countdown controller (5s, 10s, 30s, 60s) with active spin indicator and mobile tab resume listeners.
* **Storage Maintenance:** One-click and automated sweep engine for purging expired temporary uploads and outputs.

---

## 🏗️ Architecture & Technology Stack

```text
ayushserver/
├── server.js               # Express application, API routes, SSE streaming, file explorer
├── pdf-routes.js           # PDF processing router (qpdf, poppler, ghostscript)
├── nodemon.json            # Development auto-reload configuration
├── package.json            # Project manifest & dependencies
├── setup.sh                # Automated alias and environment setup script
├── start.sh                # Production launcher script
├── database/
│   ├── database.js         # SQLite manager with WAL mode & automated schema migrations
│   └── migrations/         # Database schema definitions
├── services/
│   ├── backup-manager.js   # Automated SQLite database backups
│   ├── cleanup-manager.js  # Scheduled storage cleanup & retention policies
│   ├── network-monitor.js  # Multi-interface detection (wlan0, ap0, ccmni)
│   ├── path-safety.js      # Canonical path traversal & allowlist guards
│   ├── queue-manager.js    # Centralized FFmpeg concurrency queue
│   └── wake-lock.js        # Termux battery & CPU wake-lock manager
├── public/                 # Vanilla JS / CSS dark-themed frontend studios
│   ├── home.html           # Main studio navigation launchpad
│   ├── media.html          # Video & audio processing interface
│   ├── image.html          # Sharp-powered image manipulation studio
│   ├── pdf.html            # Document manipulation studio
│   ├── dashboard.html      # System health, analytics & queue monitor
│   └── *.css, *.js         # Studio logic, style sheets, and real-time SSE handlers
├── docs/
│   ├── openapi.yaml        # Complete OpenAPI 3.1 REST API specification
│   └── SECURITY_REPORT.md  # Comprehensive security audit report
└── tests/
    ├── unit/               # Fast, isolated unit test suites
    └── integration/        # End-to-end API and multi-GB media lifecycle tests
```

---

## 🚀 Getting Started

### Prerequisites

You need an Android device with [Termux](https://termux.dev) installed.

### 1. Install System Dependencies

Open Termux and run:

```bash
pkg update && pkg upgrade -y
pkg install nodejs git ffmpeg qpdf ghostscript poppler -y
termux-setup-storage
```

> [!IMPORTANT]
> When prompted for storage permission (`termux-setup-storage`), tap **Allow** so the server can read and write to your phone storage (`/sdcard`).

### 2. Clone and Install

```bash
cd ~
git clone https://github.com/ayushyadav7172/ayushserver.git
cd ~/ayushserver
npm install
```

### 3. Setup Quick Command (Optional)

Run the automated setup script to register the `studio` command in your shell:

```bash
chmod +x setup.sh start.sh
./setup.sh
source ~/.bashrc
```

Now you can start the application anytime from any directory by typing:

```bash
studio
```

---

## 💻 Running the Server

### Normal Production Mode
```bash
npm start
```
*Or using the launcher script:*
```bash
./start.sh
```

### Development Mode (Hot Reload)
Automatically reloads the server when code files are modified and saved:
```bash
npm run dev
```

### Accessing the Web Studio
Once started, open your web browser (Chrome, Firefox, Kiwi) on your phone or any device connected to the same Wi-Fi network:

| Destination | Local URL | Description |
| :--- | :--- | :--- |
| **Home Portal** | `http://localhost:3000/` | Central launchpad with studio navigation |
| **Media Studio** | `http://localhost:3000/media` | Video/Audio converters, extractors, and trimmers |
| **Image Studio** | `http://localhost:3000/image` | Sharp-powered format conversion & optimization |
| **PDF Studio** | `http://localhost:3000/pdf` | PDF merging, splitting, and compression |
| **Dashboard** | `http://localhost:3000/dashboard` | Live CPU/RAM charts, queue control, and logs |

> [!TIP]
> To access the server from a computer or tablet on the same Wi-Fi, replace `localhost` with your phone's Wi-Fi IP address (displayed in the Termux console upon server start, e.g. `http://192.168.1.15:3000`).

---

## 🧪 Testing & Quality Assurance

AyushServer includes a comprehensive test suite written with the native Node.js test runner (`node:test`):

```bash
# Run all unit and integration tests (51 tests)
npm test

# Run all test suites including heavy integration
npm run test:all

# Run 3GB large-file streaming pipeline verification
npm run test:3gb
```

All 51 tests run and pass without external mock frameworks:
* ✅ Server & Health API probes
* ✅ Concurrency queue limits & priority scheduling
* ✅ Path traversal and double-encoding security checks
* ✅ SQLite migrations and WAL persistence
* ✅ Cellular (ccmni) CGNAT and Hotspot (ap0) CORS compatibility
* ✅ Centralized cleanup manager and storage audits

---

## 🔒 Security & Privacy

* **Zero Authentication on LAN:** Designed for private Android LAN/hotspot usage without annoying token dialogs or key expiry.
* **Multi-Iteration Path Guard:** Traversal attempts (`../`, `%252e%252e`, root escapes) are strictly rejected with HTTP 403.
* **Storage Allowlist:** File operations are strictly bound to `/sdcard`, `/storage`, and the Termux home directory. System root `/` access is completely blocked.
* **Full Security Audit:** See [docs/SECURITY_REPORT.md](docs/SECURITY_REPORT.md) for details.

---

## 📖 API Documentation

Complete REST API documentation is available via the OpenAPI 3.1 specification:
* **OpenAPI File:** [`docs/openapi.yaml`](docs/openapi.yaml)
* **Status Endpoints:**
  * `GET /api/health` — Full system status (Memory, FFmpeg, SQLite, Queue, Storage).
  * `GET /api/health/live` & `GET /api/health/ready` — Lightweight health probes.
  * `GET /api/analytics/stats` — Real-time performance metrics.
  * `GET /api/queue/status` — Active and waiting job queue status.
  * `POST /api/queue/concurrency` — Adjust maximum concurrent FFmpeg workers.
  * `GET /api/browse?path=/sdcard` — Safe phone storage directory explorer.
  * `POST /api/process-direct` — Submit video/audio processing jobs.
  * `POST /api/cancel-job` — Gracefully stop active or queued tasks.

---

## 📄 License

This project is open-source software licensed under the [MIT License](LICENSE).
