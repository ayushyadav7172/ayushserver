# AyushServer: Termux Media & Document Processing Studio

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Android%20Termux-blue?logo=android&logoColor=white" alt="Platform">
  <img src="https://img.shields.io/badge/Node.js-v20%2B-green?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/FFmpeg-Ready-red?logo=ffmpeg&logoColor=white" alt="FFmpeg">
  <img src="https://img.shields.io/badge/Database-SQLite%20WAL-lightgrey?logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Tests-94%20Passed-brightgreen?logo=checkmarx&logoColor=white" alt="Tests">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
</p>

A high-performance, self-hosted, offline-first media and document studio built natively for **Android via Termux**. 

AyushServer turns your Android smartphone into a personal media workstation. It provides a modern, responsive web dashboard with direct access to internal phone storage (`/sdcard`), real-time Server-Sent Events (SSE) progress streaming, an intelligent FFmpeg background queue, zero-RAM-buffering pipelines capable of processing 3GB+ files without memory pressure, and a production-grade **Authentication & Role-Based Access Control (RBAC)** system.

---

## 🌟 Key Engineering Highlights

* **Role-Based Access Control (RBAC):** Multi-tier access management separating Master Admin privileges (phone storage browsing, direct-path jobs, diagnostics) from Guest users (restricted strictly to temporary upload sandboxes).
* **Direct Storage Mode (Zero Disk Duplication):** Browse `/sdcard`, `Download`, `DCIM`, `Movies`, and `Music` directly through the server-side file explorer. Output files are written in-place with zero intermediary cache waste.
* **Stream-Based Processing:** Files are piped directly through streams and child processes, preventing Node.js buffer exhaustion and Out-Of-Memory (OOM) crashes on Android.
* **Intelligent Concurrency Queue:** Background worker queue manages concurrent FFmpeg operations with real-time speed calculation, ETA estimation, and graceful cancellation.
* **SQLite Persistence (WAL Mode):** Complete job history, user accounts, auth sessions, system analytics, and runtime configurations persist safely across server restarts using a high-concurrency SQLite storage engine.
* **1-Hour Auto-Logout & Session Security:** Sessions expire after 1 hour (3600 seconds) of inactivity or max age. Passwords are cryptographically salted and hashed using `crypto.scryptSync`.
* **Terminal Admin Recovery Tool:** Zero insecure web backdoors. Forgotten credentials can be reset directly from the Termux terminal using `npm run reset-admin`.
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

## 🔐 Authentication, Roles & Security Access Control

AyushServer includes an authentication system designed to protect personal phone storage while allowing guests on the local network to process media.

### 1. First-Time Admin Setup (Initialization)
* When AyushServer is started for the first time with an uninitialized database, visiting `/login` automatically presents the **"Create Admin Account (Initial Setup)"** form.
* Once the master administrator registers, the setup form is **permanently disabled and hidden**.
* Any subsequent attempts to call `/api/auth/register-admin` are strictly rejected with **HTTP 403 Forbidden**.

### 2. Admin vs. Guest Roles

| Capability / Resource | 🛡️ Admin User | 👤 Guest User |
| :--- | :---: | :---: |
| **Browse Phone Storage (`/sdcard`)** | ✅ Full Access | ❌ **Locked (403 Forbidden)** |
| **Direct Path Jobs (`/api/process-direct`)** | ✅ Any allowed path | ❌ **Locked (Uploads Only)** |
| **Stream / Preview Phone Files** | ✅ Full Access | ❌ **Locked (403 Forbidden)** |
| **Remote Upload Processing** | ✅ Yes | ✅ Yes (Isolated Sandbox) |
| **Media, Image & PDF Tools** | ✅ Full Access | ✅ Allowed via Uploads |
| **Diagnostics Dashboard (`/dashboard`)** | ✅ Full Access | ❌ **Access Denied (403)** |
| **Backups & Cleanup Controls** | ✅ Full Access | ❌ **Locked (403 Forbidden)** |
| **Session Lifetime** | ⏱️ 1 Hour (Auto-logout) | ⏱️ 1 Hour |

> [!IMPORTANT]
> **Zero Frontend-Only Security:** Guest restrictions are enforced on the backend. Even if a guest attempts to manipulate DOM buttons or send direct `curl` requests to `/api/browse`, `/api/process-direct`, or `/api/stream-file`, the server rejects the request with HTTP 403 Forbidden.

### 3. 1-Hour Auto-Logout
* Sessions expire automatically after **1 hour (3600 seconds)** of inactivity.
* When the session expires, the browser client displays a notification and redirects to `/login?expired=1`.
* Expired sessions are purged from the database automatically.

---

## 🔑 Admin Password Recovery (Terminal CLI)

To prevent web-based brute-force attacks and credential harvesting, AyushServer **does not expose a web "Forgot Password" button**. Instead, recovery is performed exclusively through the local Termux terminal, ensuring that only the physical owner of the device can reset credentials.

### Interactive Recovery Menu

Run the recovery script in Termux:

```bash
npm run reset-admin
```
*(or `node scripts/reset-admin.js`)*

This displays an interactive terminal menu:

```text
======================================================
       🛡️  AyushServer - Admin Account Recovery       
======================================================

Current Admin Account(s):
 [1] Username: "admin" (Created: 26/11/2026)

Select an action:
 [1] Set a new password for an existing admin
 [2] Change admin username & password
 [3] Complete Reset (Delete admin to show initial setup on web again)
 [4] Exit

Enter choice (1-4):
```

### Direct CLI Commands (Quick Flags)

* **Update password for existing admin:**
  ```bash
  node scripts/reset-admin.js --password <newPassword>
  ```
* **Change both username and password:**
  ```bash
  node scripts/reset-admin.js --username <newUsername> --password <newPassword>
  ```
* **Complete Reset (Re-opens initial web setup):**
  ```bash
  node scripts/reset-admin.js --reset
  ```
* **Check admin status:**
  ```bash
  node scripts/reset-admin.js --status
  ```

---

## 📱 Standalone Android App & In-App Tools Updates

AyushServer supports running both as an offline web service and as a **Standalone Android App** with in-app native tool update capabilities:

### 1. In-App Tools & System Center (`/dashboard`)
* **Real-Time Tool Detection:** Shows installed versions of `FFmpeg 9.x`, `ffprobe`, `Node.js`, and Android storage permissions directly from the Dashboard.
* **One-Click Tool Updates:** Admins can check for newer FFmpeg/tool versions and update them directly from the web interface without opening the command line (`POST /api/system/update-tools`).
* **In-App APK Updates:** Checks GitHub releases for newer APK builds and triggers seamless in-app downloads via Android's `DownloadManager` and `FileProvider`.

### 2. Standalone Android Project (`android/`)
* **Architecture:** Native Android application in Kotlin with full hardware-accelerated WebView.
* **Multi-Device & Custom Server IP Switcher:** Floating `🌐` connection button and embedded offline switcher allow connecting to any device on the Wi-Fi network (e.g. `192.168.1.15:3000`) or resetting to Localhost with persistent storage.
* **Persistent Background Processing:** Built-in `ServerForegroundService` holds a partial CPU wake-lock so video encoding and PDF rendering never sleep when the phone screen is locked.
* **Full Storage Access:** Configured with `MANAGE_EXTERNAL_STORAGE` (`All Files Access`) for browsing and processing `/sdcard` internal storage in Direct Mode.
* **Cloud Build via GitHub Actions:** Automatic CI/CD workflow (`.github/workflows/android-build.yml`) builds the APK in GitHub cloud and provides a direct `.apk` download link without burdening phone CPU/RAM.

### 3. Progressive Web App (PWA / WebAPK)
* Includes `manifest.json` and `sw.js` (Service Worker).
* Can be installed directly from Chrome / Firefox ("Install App" / "Add to Home screen") to run as a full-screen, frameless native mobile app on any Android device.

### 4. 🚀 1-Click Terminal Project Updater (`update ayushserver`)
Any user or friend running an older version can update to the latest code, dependencies, and database migrations with a single shortcut command from anywhere in Termux:
```bash
update ayushserver
# or from project folder:
./update.sh
```

---

## 🏗️ Architecture & Technology Stack

```text
ayushserver/
├── server.js               # Express app, RBAC auth middleware, SSE streaming, file explorer
├── pdf-routes.js           # PDF processing router (qpdf, poppler, ghostscript)
├── nodemon.json            # Development auto-reload configuration
├── package.json            # Project manifest, dependencies & scripts
├── setup.sh                # Automated alias and environment setup script
├── start.sh                # Production launcher script
├── database/
│   ├── database.js         # SQLite manager (WAL mode, auth queries, prepared statements)
│   └── migrations/
│       ├── 001_initial_schema.js  # Jobs, logs, analytics, backups schema
│       └── 002_auth_schema.js    # Users and auth_sessions schema
├── scripts/
│   └── reset-admin.js      # Terminal CLI tool for admin password reset & recovery
├── services/
│   ├── analytics-service.js# Metrics aggregation service
│   ├── backup-manager.js   # Automated SQLite database backups
│   ├── cleanup-manager.js  # Scheduled storage cleanup & retention policies
│   ├── health-monitor.js   # System diagnostic monitor
│   ├── job-manager.js      # SQLite job lifecycle coordinator
│   ├── network-monitor.js  # Multi-interface detection (wlan0, ap0, ccmni)
│   ├── path-safety.js      # Canonical path traversal & allowlist guards
│   ├── queue-manager.js    # Centralized FFmpeg concurrency queue
│   └── wake-lock.js        # Termux battery & CPU wake-lock manager
├── public/                 # Vanilla JS / CSS dark-themed frontend studios
│   ├── login.html          # Dynamic Admin Setup & Login / Guest portal
│   ├── login.js            # Authentication UI handler & session initializer
│   ├── auth.js             # Shared client guard (auto-logout, guest storage lock)
│   ├── home.html           # Main studio navigation launchpad
│   ├── media.html          # Video & audio processing interface
│   ├── image.html          # Sharp-powered image manipulation studio
│   ├── pdf.html            # Document manipulation studio
│   ├── dashboard.html      # System health, analytics & queue monitor
│   └── *.css, *.js         # Studio logic, stylesheets, and real-time SSE handlers
├── docs/
│   ├── openapi.yaml        # Complete OpenAPI 3.1 REST API specification
│   └── SECURITY_REPORT.md  # Comprehensive security audit report
└── tests/
    ├── unit/               # Unit test suites (auth-security, network, queue, db, etc.)
    └── integration/        # End-to-end API, server, and multi-GB media lifecycle tests
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

### 3. Setup Quick Commands & Shortcuts (Recommended)

Run the automated setup script to register the `studio` (start) and `update ayushserver` (update) shortcuts:

```bash
chmod +x setup.sh start.sh update.sh
./setup.sh
source ~/.bashrc
```

Now you can control AyushServer anytime from **any directory** in Termux:

| Shortcut Command | Action |
| :--- | :--- |
| `studio` | 🚀 Starts AyushServer immediately |
| `update ayushserver` | 🔄 Automatically pulls latest GitHub updates, installs dependencies & runs migrations |

---

### 🔄 How to Update AyushServer (Latest Version Kaise Lein)

Jab bhi GitHub par naya update push kiya jaye, aap ya aapka koi bhi dost apne Termux me kisi bhi folder se sirf ye ek command chala kar latest version le sakta hai:

```bash
update ayushserver
```

*Ya manually project folder me jakar:*
```bash
cd ~/ayushserver
./update.sh
```

**Yeh command automatically kya karta hai:**
1. 📥 GitHub (`main` branch) se latest code fetch aur pull karta hai.
2. 📦 Zaruri npm packages aur dependencies ko install/update karta hai.
3. 🛡️ SQLite database migrations verify karta hai (purana admin login ya data delete nahi hota).
4. ⚙️ Execution permissions aur global shortcuts refresh kar deta hai.

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
Automatically reloads the server when code files are modified:
```bash
npm run dev
```

### Accessing the Web Studio
Once started, open your web browser (Chrome, Firefox, Kiwi) on your phone or any device connected to the same Wi-Fi network:

| Destination | Local URL | Access Level | Description |
| :--- | :--- | :---: | :--- |
| **Login / Setup** | `http://localhost:3000/login` | Public | Initial admin creation or sign-in / Guest choice |
| **Home Portal** | `http://localhost:3000/` | Auth Required | Central launchpad with studio navigation |
| **Media Studio** | `http://localhost:3000/media` | Auth Required | Video/Audio converters, extractors, and trimmers |
| **Image Studio** | `http://localhost:3000/image` | Auth Required | Sharp-powered format conversion & optimization |
| **PDF Studio** | `http://localhost:3000/pdf` | Auth Required | PDF merging, splitting, and compression |
| **Dashboard** | `http://localhost:3000/dashboard` | 🛡️ **Admin Only** | Live CPU/RAM charts, queue control, and logs |

> [!TIP]
> To access the server from a computer or tablet on the same Wi-Fi, replace `localhost` with your phone's Wi-Fi IP address (displayed in the Termux console upon server start, e.g. `http://192.168.1.15:3000`).

---

## 🧪 Testing & Quality Assurance

AyushServer includes a comprehensive test suite written with the native Node.js test runner (`node:test`):

```bash
# Run all unit, security, and integration tests (89 tests)
npm test

# Run all test suites including heavy integration
npm run test:all

# Run 3GB large-file streaming pipeline verification
npm run test:3gb
```

All 89 tests run and pass without external mock frameworks:
* ✅ Authentication, Scrypt hashing, and session expiration
* ✅ Guest bypass attacks (phone storage, custom commands, streaming) blocked (403)
* ✅ Initial admin setup closure & privilege escalation blocked
* ✅ Server & Health API probes
* ✅ Concurrency queue limits & priority scheduling
* ✅ Path traversal and double-encoding security checks
* ✅ SQLite migrations and WAL persistence
* ✅ Cellular (ccmni) CGNAT and Hotspot (ap0) CORS compatibility
* ✅ Centralized cleanup manager and storage audits

---

## 🔒 Security & Privacy

* **Zero Plaintext Credentials:** Passwords are salted with 16 cryptographically random bytes and hashed using `crypto.scryptSync`.
* **Database Isolation:** Database files (`database/*.db*`) are excluded in `.gitignore` and never committed or pushed to Git repositories.
* **Storage Allowlist & Confinement:** File operations are strictly bound to `/sdcard`, `/storage`, and the Termux home directory. System root `/` access is completely blocked.
* **Multi-Iteration Path Guard:** Traversal attempts (`../`, `%252e%252e`, null bytes, symlink loops) are strictly canonicalized and rejected with HTTP 403.
* **Full Security Verification:** See [tests/unit/auth-security.test.js](tests/unit/auth-security.test.js) for automated bypass test cases.

---

## 📖 API Documentation

Complete REST API documentation is available via OpenAPI 3.1:
* **OpenAPI File:** [`docs/openapi.yaml`](docs/openapi.yaml)
* **Authentication Endpoints:**
  * `GET /api/auth/status` — Current session status, role, and expiration timestamp.
  * `POST /api/auth/register-admin` — Initial admin registration (locked once configured).
  * `POST /api/auth/login` — Administrator credential authentication.
  * `POST /api/auth/guest` — Start temporary guest session (local storage locked).
  * `POST /api/auth/logout` — Terminate session and invalidate token.
* **Core Endpoints:**
  * `GET /api/health` — Full system status (Memory, FFmpeg, SQLite, Queue, Storage).
  * `GET /api/analytics/stats` — Real-time performance metrics.
  * `GET /api/queue/status` — Active and waiting job queue status.
  * `POST /api/queue/concurrency` — Adjust maximum concurrent FFmpeg workers (Admin only).
  * `GET /api/browse?dir=/sdcard` — Safe phone storage directory explorer (Admin only).
  * `POST /api/process-direct` — Submit video/audio processing jobs.
  * `POST /api/cancel-job` — Gracefully stop active or queued tasks.

---

## 📄 License

This project is open-source software licensed under the [MIT License](LICENSE).

---

## 🙏 Acknowledgements & Credits

This project is built upon and makes use of the following open-source tools and libraries:

* **[FFmpeg](https://ffmpeg.org/)** — Industry standard multimedia framework for video and audio transcoding, filtering, and stream extraction.
* **[Sharp](https://sharp.pixelplumbing.com/)** — High-performance Node.js image processing library powered by libvips.
* **[PDF-lib](https://pdf-lib.js.org/)** — JavaScript library for PDF document generation and modification.
* **[QPDF](https://qpdf.sourceforge.io/) & [Poppler](https://poppler.freedesktop.org/)** — Robust CLI utilities for PDF manipulation and rendering.
* **[Termux](https://termux.dev/)** — Powerful Android terminal emulation and Linux environment.
