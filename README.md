# Termux FFmpeg Web Studio (Direct Storage Mode)

A complete, production-ready, web-based FFmpeg media studio that runs locally on Android via **Termux**. It features a modern, mobile-first responsive dark UI, real-time Server-Sent Events (SSE) encoding progress streaming, and zero external CDN dependencies—functioning 100% offline.

---

## 🚀 Key Architecture: Server-Side File Explorer (Zero Storage Duplication)

Instead of uploading multi-gigabyte files (e.g., 2GB+ movies) through the browser and duplicating them on your phone, Termux FFmpeg Web Studio uses a **Server-Side File Explorer** that accesses your phone's storage directly:
- **Direct Storage Access**: Select files from `/sdcard`, `Download`, `Movies`, `Music`, `DCIM`, or any accessible folder.
- **In-Place Output**: Outputs are saved directly next to the original file (e.g., `/sdcard/Download/movie_processed.mp4`).
- **No Uploads Folder / No Multer**: Eliminates browser upload bottlenecks, multipart form overhead, and temporary duplicate files.
- **0% Storage Waste**: Process 50GB 4K videos without copying a single byte into app-private cache!

---

## 🛠️ Features & Operations

1. **Server-Side File Explorer**:
   - Modal explorer with interactive breadcrumbs and parent folder navigation (`Back`).
   - Quick jump buttons for `/sdcard`, `/sdcard/Download`, `/sdcard/Movies`, `/sdcard/Music`, `/sdcard/DCIM`.
   - Automatic media filtering: Displays only folders (📁) and media files (`.mp4, .mkv, .avi, .mov, .webm, .mp3, .wav, .m4a, .aac`).
   - Graceful permission handling for restricted Android folders.
2. **Operations Dashboard**:
   - **Format Conversion**: Convert between MP4, WebM, MKV, AVI, and GIF. Includes a lossless stream copy remux mode (`-c:v copy`) for instant conversion with zero quality loss!
   - **Change Video Audio Track**: Convert audio codec inside a video (AAC, MP3, AC3, Opus, FLAC) while keeping the original video stream 100% untouched (`-c:v copy`) in the same container.
   - **Audio Extraction**: Strip video stream and export to high-quality MP3, AAC, WAV (lossless), FLAC, or OGG.
   - **Video Compression**: Interactive CRF slider (18–35), presets (`ultrafast` to `slow`), and audio bitrate control.
   - **Trimming / Cutting**: Fast stream copy mode or frame-accurate re-encode with start and end timestamps.
   - **Resize & Scale**: Presets (1080p, 720p, 480p, 360p) or custom dimensions with aspect-ratio locking.
   - **Rotate & Flip**: 90° CW, 90° CCW, 180°, horizontal mirror, and vertical flip.
   - **GIF Creation**: High-grade two-pass `palettegen` & `paletteuse` algorithm with configurable FPS and width.
    - **Raw FFmpeg Command Mode**: Custom `ffmpeg`/`ffprobe` commands with `{input}` and `{output_dir}` placeholder tokenization. Runs without a shell; only local files under `/sdcard`, `/storage`, or the Termux home directory are permitted (remote protocols and the concat demuxer are blocked).
3. **Live Progress**:
   - Real-time Server-Sent Events (SSE) progress bar showing percentage, elapsed time, current frame, FPS, and speed multiplier (e.g. `2.5x`).
4. **Preview & Output Handling**:
   - Built-in video/audio player streaming directly from the newly processed file with HTTP 206 range request support.
   - One-click "Copy Path" button for the saved output.
   - "Use as Input for Next Operation" button for chaining FFmpeg operations.
5. **Job History & Logs**:
   - Last processed jobs with status badges, execution duration, and full terminal log inspector.

---

## 📁 Project Structure

```text
termux-ffmpeg-studio/
├── server.js            # Express backend, File Explorer API, direct FFmpeg runner, SSE stream
├── package.json         # Project metadata and dependencies (express, cors, morgan, body-parser)
├── start.sh             # Startup script
├── README.md            # Documentation
└── public/
    ├── index.html       # Single-page web studio UI
    ├── style.css        # Responsive dark theme
    └── app.js           # Client explorer logic, operations, and SSE listener
```

---

## 📦 Getting Started

### 1. Prerequisites (Termux)
```bash
pkg update -y
pkg install -y nodejs ffmpeg
termux-setup-storage
```

### 2. Launch Server
```bash
cd ~/termux-ffmpeg-studio
npm start
```
Or use the shortcut anywhere in Termux:
```bash
ffmpeg localhost
```

Open your mobile browser at **`http://localhost:3000`**.
