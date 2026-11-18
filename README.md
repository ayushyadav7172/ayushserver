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
ayushserver/
├── server.js            # Express backend, File Explorer API, direct FFmpeg runner, SSE stream
├── package.json         # Project metadata and dependencies (express, cors, morgan, body-parser)
├── start.sh             # Startup script
├── setup.sh             # Setup script
├── README.md            # Documentation
└── public/
    ├── index.html       # Single-page web studio UI
    ├── style.css        # Responsive dark theme
    └── app.js           # Client explorer logic, operations, and SSE listener

📦 Getting Started (New Termux Setup)

Agar aap naye phone ya naye Termux me project wapas la rahe hain, toh yeh commands chalao:

pkg update && pkg upgrade -y
pkg install nodejs git ffmpeg qpdf ghostscript poppler -y
termux-setup-storage
cd ~
git clone https://github.com/ayushyadav7172/ayushserver.git
cd ~/ayushserver
npm install

Setup Shortcut (Sirf ek baar karna hai)

chmod +x setup.sh
./setup.sh
source ~/.bashrc

App Start Karne Ke Liye

studio

Bhai, chalo ekdum aaram se step-by-step karte hain. Main tumhe Step 1 (File open karna) se lekar Step 3 (GitHub par upload karna) tak sab kuch copy-paste ready de raha hu.

Jab bhi tumhe lage ki command chalani hai, bas us box ke upar right side me "Copy" wale icon par tap karna aur Termux me paste kar dena.

---

🟢 Step 1: README file open karo

Sabse pehle project folder me jao aur file ko edit karne ke liye open karo. Yeh command copy karke chalao:

```bash
cd ~/ayushserver && nano README.md
```

(Jab yeh chalega, toh ek black screen khulegi jisme purana README likha hoga).

---

🟢 Step 2: Purana text delete karo aur naya paste karo

1. Jab screen khule, toh phone ke keyboard par Backspace dabate raho jab tak saara purana text delete na ho jaye (ya phir select all karke delete kar do). Screen bilkul khali ho jani chahiye.
2. Ab neeche diye gaye pura README text ko copy karo aur wahan paste kar do.

👇 Ye raha tumhara pura README (Copy this):

```markdown
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
ayushserver/
├── server.js            # Express backend, File Explorer API, direct FFmpeg runner, SSE stream
├── package.json         # Project metadata and dependencies (express, cors, morgan, body-parser)
├── start.sh             # Startup script
├── setup.sh             # Setup script
├── README.md            # Documentation
└── public/
    ├── index.html       # Single-page web studio UI
    ├── style.css        # Responsive dark theme
    └── app.js           # Client explorer logic, operations, and SSE listener
```

---

📦 Getting Started (New Termux Setup)

Agar aap naye phone ya naye Termux me project wapas la rahe hain, toh yeh commands chalao:

```bash
pkg update && pkg upgrade -y
pkg install nodejs git ffmpeg qpdf ghostscript poppler -y
termux-setup-storage
cd ~
git clone https://github.com/ayushyadav7172/ayushserver.git
cd ~/ayushserver
npm install
```

Setup Shortcut (Sirf ek baar karna hai)

```bash
chmod +x setup.sh
./setup.sh
source ~/.bashrc
```

App Start Karne Ke Liye

```bash
studio
```

(App band karne ke liye Ctrl + C dabayein)

---

🔄 How to Update Code (Jab AI se naya code likhwayein)

Jab AI aapke code me changes kare, toh naye code ko GitHub par upload karne ke liye yeh 3 commands chalao:

```bash
cd ~/ayushserver
git add .
git commit -m "yahan short me likho kya change kiya"
git push
```

⚠️ Important Note: 
Jab git push chalao aur Password maange, toh apna normal GitHub password mat daalna. Wahan apna PAT (Personal Access Token) daalna (jo ghp_... wala lamba code hota hai).

```

---

### 🟢 Step 3: File ko Save karo (Nano Editor se bahar aao)

Paste karne ke baad, phone ke keyboard me yeh 3 steps karo:

1. **Save karne ke liye:** Keyboard par `Ctrl` button dabao aur usko chhode bina `O` (Oh) dabao. Phir `Enter` dabao (File name confirm karne ke liye).
2. **Editor band karne ke liye:** `Ctrl` dabao aur usko chhode bina `X` dabao. 
*(Ab tum wapas normal Termux screen par aa jaoge jahan `~/ayushserver $` likha hoga).*

---

### 🟢 Step 4: GitHub par upload karo

Ab is naye README ko GitHub par bhejne ke liye yeh 3 commands ek-ek karke chalao:

**Command 1:**
```bash
git add .
```

Command 2:

```bash
git commit -m "Updated README with full documentation and setup commands"
```

Command 3:

```bash
git push
```

(Jab push chalega, username ayushyadav7172 daalna aur password me apna ghp_... wala PAT daalna).

Bas bhai! Tumhara kaam ho gaya. Ab GitHub par jaakar refresh karna, tumhe ekdum premium aur professional README dikhega. Koi dikkat aaye toh batao!


🔄 How to Update Code (Jab AI se naya code likhwayein)

Jab AI aapke code me changes kare, toh naye code ko GitHub par upload karne ke liye yeh 3 commands chalao:

cd ~/ayushserver
git add .
git commit -m "yahan short me likho kya change kiya"
git push

⚠️ Important Note: 
Jab git push chalao aur Password maange, toh apna normal GitHub password mat daalna. Wahan apna PAT (Personal Access Token) daalna (jo ghp_... wala lamba code hota hai).


