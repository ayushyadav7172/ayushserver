# Termux Utility Studio — API Documentation

This document describes all API endpoints available in **Termux Utility Studio**, including Media Studio (FFmpeg), PDF Studio, Image Studio, Queue Management, Health Monitoring, Backups, and Analytics.

The server operates without authentication, providing zero-friction local Wi-Fi / LAN access for personal phone devices running Termux.

---

## Base URLs

- **Localhost**: `http://localhost:3000`
- **Local Network**: `http://<PHONE-LAN-IP>:3000` (e.g., `http://192.168.1.100:3000`)

---

## Table of Contents

1. [System & Health Monitoring](#1-system--health-monitoring)
2. [Dashboard Analytics](#2-dashboard-analytics)
3. [Queue & Concurrency Management](#3-queue--concurrency-management)
4. [Media Studio (FFmpeg)](#4-media-studio-ffmpeg)
5. [Storage & File Operations](#5-storage--file-operations)
6. [PDF & Document Studio](#6-pdf--document-studio)
7. [Image Studio](#7-image-studio)
8. [Automatic Backups](#8-automatic-backups)
9. [Centralized Cleanup](#9-centralized-cleanup)

---

## 1. System & Health Monitoring

### `GET /api/health`
Performs a comprehensive health check across database, FFmpeg binary, memory limits, and queue status.

**Response (200 OK):**
```json
{
  "status": "healthy",
  "uptime": {
    "seconds": 3600,
    "formatted": "1h 0m 0s"
  },
  "timestamp": 1795153467521,
  "platform": {
    "os": "android",
    "arch": "arm64",
    "nodeVersion": "v26.13.1",
    "isTermux": true
  },
  "database": { "status": "healthy" },
  "ffmpeg": { "status": "available", "version": "9.0.2" },
  "memory": {
    "process": {
      "rss": 48820224,
      "rssFormatted": "46.56 MB",
      "heapTotal": 7737344,
      "heapTotalFormatted": "7.38 MB",
      "heapUsed": 4959152,
      "heapUsedFormatted": "4.73 MB"
    },
    "system": {
      "freeBytes": 2473639936,
      "freeFormatted": "2.3 GB",
      "totalBytes": 5865545728,
      "totalFormatted": "5.46 GB",
      "usedPercentage": 58
    }
  },
  "queue": { "active": 0, "queued": 0, "maxConcurrency": 1 },
  "storage": {
    "totalAppUsage": "19.54 MB",
    "diskFree": "77.76 GB",
    "diskTotal": "108.53 GB"
  },
  "warnings": []
}
```

### `GET /api/health/live`
Lightweight process liveness probe.
**Response (200 OK):**
```json
{ "status": "ok", "uptime": 3600 }
```

### `GET /api/health/ready`
Verifies database connectivity and storage readiness.
**Response (200 OK):**
```json
{
  "ready": true,
  "database": "healthy",
  "ffmpeg": "available",
  "diskFree": "77.76 GB"
}
```

---

## 2. Dashboard Analytics

### `GET /api/analytics/stats`
Retrieves aggregated statistics for the web dashboard.

**Response (200 OK):**
```json
{
  "timestamp": 1795153487396,
  "server": {
    "uptimeSeconds": 3600,
    "nodeVersion": "v26.13.1",
    "platform": "android (arm64)",
    "isTermux": true,
    "status": "online"
  },
  "processing": {
    "totalJobs": 42,
    "completedJobs": 38,
    "failedJobs": 2,
    "cancelledJobs": 2,
    "interruptedJobs": 0,
    "currentlyProcessing": 0,
    "queuedJobs": 0,
    "avgProcessingTimeSeconds": 14,
    "totalProcessedMediaSize": "1.42 GB",
    "recentErrors": []
  },
  "ffmpeg": {
    "activeWorkers": 0,
    "maxConcurrency": 1,
    "queueLength": 0,
    "activeJobs": []
  },
  "storage": {
    "tempUploads": { "bytes": 0, "formatted": "0 B" },
    "processed": { "bytes": 104857600, "formatted": "100 MB" },
    "diskStorage": { "freeFormatted": "77.76 GB", "totalFormatted": "108.53 GB" }
  }
}
```

---

## 3. Queue & Concurrency Management

### `GET /api/queue/status`
Returns details of the background job queue.
**Response (200 OK):**
```json
{
  "maxConcurrency": 1,
  "activeCount": 0,
  "queuedCount": 0,
  "queue": [],
  "activeJobs": []
}
```

### `POST /api/queue/concurrency`
Updates the maximum concurrent FFmpeg processes (persisted in SQLite).
**Request Body:**
```json
{ "limit": 2 }
```
**Response (200 OK):**
```json
{ "success": true, "maxConcurrency": 2 }
```

---

## 4. Media Studio (FFmpeg)

### `POST /api/process-direct` or `POST /api/process-multi`
Enqueues a media processing task (converting, compressing, audio extracting, or trimming).

**Request Body Example:**
```json
{
  "filePath": "/sdcard/Download/video.mp4",
  "operation": "convert",
  "options": {
    "format": "mp4",
    "preset": "fast",
    "crf": 23
  }
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "jobId": "job_1795153400_a1b2c3",
  "name": "CONVERT - video.mp4",
  "outputPath": "/sdcard/Download/video_convert.mp4",
  "commandString": "ffmpeg -i /sdcard/Download/video.mp4 ...",
  "activeJob": { "jobId": "job_1795153400_a1b2c3", "status": "processing", "progress": 0 }
}
```

### `POST /api/run-custom`
Executes custom FFmpeg arguments safely without shell injection risks.
**Request Body:**
```json
{
  "command": "-i input.mp4 -vf scale=1280:720 -c:a copy output_720p.mp4",
  "workingDir": "/sdcard/Download"
}
```

### `POST /api/cancel-job`
Cancels the running or queued job and kills the associated FFmpeg process.
**Request Body (optional):**
```json
{ "jobId": "job_1795153400_a1b2c3" }
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Conversion cancelled by user"
}
```

### `GET /api/current-job`
Returns the state and progress of the active job.
**Response (200 OK):**
```json
{
  "jobId": "job_1795153400_a1b2c3",
  "status": "processing",
  "progress": 45,
  "currentTime": "00:01:12",
  "totalDuration": "00:02:40",
  "speed": "1.8x",
  "outputPath": "/sdcard/Download/video_convert.mp4"
}
```

### `GET /api/progress`
Server-Sent Events (SSE) stream pushing real-time progress events.
Headers: `Accept: text/event-stream`.

---

## 5. Storage & File Operations

### `POST /api/upload`
Streams multipart form-data directly to disk using Multer disk storage. Supports 3 GB+ video files without RAM buffering.

### `GET /api/download/:filename?path=/absolute/path`
Streams file contents to client with support for resumable downloads.

### `GET /api/stream-file?path=/absolute/path`
Streams video/audio with HTTP 206 Byte Range support for fluid playback in browser video players.

### `GET /api/browse?path=/sdcard`
Returns directories and media files within phone storage, strictly restricted to safe roots.

---

## 6. PDF & Document Studio

- `POST /api/pdf/unlock` — Removes PDF passwords using `qpdf`.
- `POST /api/pdf/merge` — Merges multiple PDF files into one.
- `POST /api/pdf/split` — Splits or extracts pages.
- `POST /api/pdf/rotate` — Rotates pages by 90°, 180°, or 270°.
- `POST /api/pdf/compress` — Compresses PDF documents with Ghostscript.
- `POST /api/pdf/images-to-pdf` — Converts images into a PDF book.
- `POST /api/pdf/pdf-to-images` — Extracts PDF pages into high-resolution JPG images.

---

## 7. Image Studio

- `POST /api/image/convert` — Converts between JPG, PNG, WEBP, AVIF, TIFF with `sharp`.
- `POST /api/image/resize` — Resizes images by dimensions or percentage.
- `POST /api/image/compress` — Compresses to target file size or quality level.
- `POST /api/image/strip-exif` — Strips sensitive EXIF location metadata.

---

## 8. Automatic Backups

### `GET /api/backup/list`
Lists stored SQLite database backups.

### `POST /api/backup/run`
Triggers an immediate atomic database backup using `VACUUM INTO` and validates SHA-256 integrity.

### `POST /api/backup/restore`
Restores database from a selected backup after verifying integrity and creating a safety rollback snapshot.
**Request Body:**
```json
{
  "backupId": "backup_1795153400",
  "confirm": true
}
```

---

## 9. Centralized Cleanup

### `GET /api/cleanup/stats`
Reports space consumed by temp uploads, thumbs, outputs, and disk free space.

### `POST /api/cleanup/run`
Executes safe deletion of expired temporary files, strictly protecting active files, in-progress jobs, and user source media.

### `POST /api/cleanup/retention`
Configures temporary file retention window (in minutes).
**Request Body:**
```json
{ "minutes": 45 }
```
