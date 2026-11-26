const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { spawn, execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const sharp = require('sharp');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { createPdfRouter } = require('./pdf-routes');
const { wakeLockManager } = require('./wake-lock');
const { databaseManager } = require('./database/database');
const { jobManager } = require('./services/job-manager');
const { queueManager } = require('./services/queue-manager');
const { cleanupManager } = require('./services/cleanup-manager');
const { backupManager } = require('./services/backup-manager');
const { healthMonitor } = require('./services/health-monitor');
const { analyticsService } = require('./services/analytics-service');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Directories - Unified 2-folder system (uploads for all inputs, processed for all outputs)
const PUBLIC_DIR = path.join(__dirname, 'public');
const THUMBS_DIR = path.join(__dirname, 'temp_thumbs');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PROCESSED_DIR = path.join(__dirname, 'processed');

// Compatibility aliases
const TEMP_UPLOADS_DIR = UPLOADS_DIR;
const PDF_TEMP_UPLOADS_DIR = UPLOADS_DIR;
const PDF_OUTPUTS_DIR = PROCESSED_DIR;

for (const d of [PUBLIC_DIR, THUMBS_DIR, UPLOADS_DIR, PROCESSED_DIR]) {
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ======================== PATH SAFETY (ALLOWLIST) ========================
// Only media under phone storage or the Termux home directory may be accessed.
const ALLOWED_ROOTS = ['/sdcard', '/storage', process.env.HOME || os.homedir(), __dirname, UPLOADS_DIR, PROCESSED_DIR, THUMBS_DIR]
  .filter(Boolean);

// Resolve symlinks and canonicalize target paths with traversal and loop protection
function canonicalizeTarget(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return '';
  let clean = targetPath.trim();

  // Safely decode nested URL encodings (up to 5 iterations)
  try {
    for (let i = 0; i < 5; i++) {
      if (!clean.includes('%')) break;
      const next = decodeURIComponent(clean);
      if (next === clean) break;
      clean = next;
    }
  } catch (e) {
    return '';
  }

  // Reject null bytes, URL-encoded null bytes, or illegal control characters
  if (clean.includes('\0') || /%00/i.test(clean) || /[\x00-\x1f\x7f]/.test(clean)) {
    return '';
  }

  // Strip wrapping quotes
  clean = clean.replace(/^['"]|['"]$/g, '');

  // Expand home tilde safely
  if (clean.startsWith('~')) {
    clean = clean.replace(/^~(?=$|\/|\\)/, process.env.HOME || os.homedir());
  }

  let current;
  try {
    current = path.resolve(clean);
  } catch (e) {
    return '';
  }

  const visited = new Set();
  const suffix = [];

  while (true) {
    if (visited.has(current)) return ''; // symlink loop detected
    visited.add(current);

    try {
      const lstat = fs.lstatSync(current);
      if (lstat.isSymbolicLink()) {
        try {
          current = fs.realpathSync(current);
        } catch (e) {
          // Dangling or inaccessible symlink
          let linkTarget = fs.readlinkSync(current);
          if (!path.isAbsolute(linkTarget)) {
            linkTarget = path.resolve(path.dirname(current), linkTarget);
          }
          current = linkTarget;
          continue;
        }
      }
      break;
    } catch (e) {
      if (e.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) break;
        suffix.unshift(path.basename(current));
        current = parent;
        continue;
      }
      break;
    }
  }

  let real = current;
  try {
    real = fs.realpathSync(current);
  } catch (e) {}

  return suffix.length ? path.join(real, ...suffix) : real;
}

const CANONICAL_ALLOWED_ROOTS = ALLOWED_ROOTS
  .map(root => canonicalizeTarget(root))
  .filter(Boolean);

function isPathWithinRoot(candidate, root) {
  if (!candidate || !root) return false;
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function isPathInside(childPath, parentDir) {
  if (!childPath || !parentDir) return false;
  try {
    const canonicalChild = canonicalizeTarget(childPath) || path.resolve(childPath);
    const canonicalParent = canonicalizeTarget(parentDir) || path.resolve(parentDir);
    return isPathWithinRoot(canonicalChild, canonicalParent);
  } catch (e) {
    return false;
  }
}

function isPathAllowed(targetPath) {
  if (!targetPath || typeof targetPath !== 'string' || targetPath.includes('\0') || /%00/i.test(targetPath)) return false;
  const canonical = canonicalizeTarget(targetPath);
  if (!canonical) return false;
  return CANONICAL_ALLOWED_ROOTS.some(root => isPathWithinRoot(canonical, root));
}

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertPathAllowed(targetPath, label = 'Path') {
  if (!targetPath || !isPathAllowed(targetPath)) {
    throw createHttpError(403, `${label} is outside the allowed storage roots (/sdcard, /storage, Termux home).`);
  }
  const canonical = canonicalizeTarget(targetPath);
  return canonical || path.resolve(String(targetPath));
}

function getAllowedParent(dirPath) {
  if (!dirPath) return null;
  const parent = path.dirname(dirPath);
  if (parent === dirPath) return null;
  return isPathAllowed(parent) ? parent : null;
}

function getAllowedRootsForUi() {
  return ALLOWED_ROOTS.filter(root => {
    try { return fs.existsSync(root); } catch (e) { return false; }
  });
}

// Termux Wake Lock: Acquired on-demand ONLY when heavy tasks (FFmpeg, qpdf, sharp)
// are actively running, and released immediately when finished (via wakeLockManager).

// ======================== CORS & SECURITY HEADERS ========================
const allowedOriginsEnv = process.env.CORS_ORIGIN;

/**
 * Validates request origins for Termux Utility Studio.
 * Seamlessly supports:
 * - Localhost and loopbacks (127.0.0.1, ::1, 0.0.0.0)
 * - Wi-Fi and Hotspot interfaces (wlan0, ap0, 192.168.x.x, 10.x.x.x, 172.16-31.x.x)
 * - Android Mobile Cellular Data interfaces (ccmni*, rmnet*, pdp*):
 *   - IPv4 Carrier-Grade NAT (CGNAT 100.64.0.0/10)
 *   - Any dynamic carrier-assigned public IPv4
 *   - IPv6 mobile addresses (2400::, 2402::, 2409::, SLAAC, link-local fe80::)
 * - VPN and mesh networks (Tailscale 100.x, WireGuard, tun0)
 * - Local mDNS hostnames (.local, .lan, .home, .internal)
 * - Authorized dev tunnels (Cloudflare, Localtunnel, Ngrok)
 * - Any active IP currently assigned to device network interfaces
 */
function isOriginAllowed(origin) {
  // Allow requests with no origin (direct browser navigation, curl, Termux webview, local mobile apps)
  if (!origin) return true;

  // Explicit origins from environment override
  if (allowedOriginsEnv) {
    if (allowedOriginsEnv === '*') return true;
    const allowedList = allowedOriginsEnv.split(',').map(s => s.trim().toLowerCase());
    return allowedList.includes(origin.toLowerCase());
  }

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    // 1. Localhost and loopback addresses
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === '[::1]') {
      return true;
    }

    // 2. Any valid IPv4 address (LAN, Wi-Fi, Hotspot ap0, Cellular ccmni/rmnet, CGNAT 100.x, Tailscale)
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
      const octets = host.split('.').map(Number);
      if (octets.every(n => n >= 0 && n <= 255)) {
        return true;
      }
      return false;
    }

    // 3. Any valid IPv6 address (must contain at least two colons to exclude plain hex hostnames)
    const bareHost = host.replace(/^\[|\]$/g, '');
    if (bareHost.includes('::') || bareHost.split(':').length >= 3) {
      if (/^[0-9a-fA-F:]+$/.test(bareHost)) {
        return true;
      }
    }

    // 4. Local network domains and mDNS
    if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.internal')) {
      return true;
    }

    // 5. Authorized tunnels (restrictible via ALLOWED_TUNNEL_HOSTS env var)
    const allowedTunnelsEnv = process.env.ALLOWED_TUNNEL_HOSTS;
    if (allowedTunnelsEnv) {
      const tunnelHosts = allowedTunnelsEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (tunnelHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) {
        return true;
      }
    } else if (/(^|\.)(trycloudflare\.com|loca\.lt|ngrok(-free)?\.(io|app))$/i.test(host)) {
      return true;
    }

    // 6. Check against any active network interface currently assigned on this device
    const ifaces = os.networkInterfaces();
    for (const ifaceName of Object.keys(ifaces)) {
      for (const net of ifaces[ifaceName]) {
        const addr = net.address.toLowerCase();
        if (addr === host || `[${addr}]` === host) {
          return true;
        }
      }
    }
  } catch (e) {
    return false;
  }

  return false;
}

const corsOptions = {
  origin: function (origin, callback) {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    // Disallow without crashing Express with an unhandled 500 error
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'X-Session-ID',
    'Range',
    'Accept',
    'Authorization',
    'Cache-Control',
    'X-Requested-With',
    'X-Auth-Token',
    'X-Admin-Token'
  ],
  exposedHeaders: [
    'Content-Range',
    'Accept-Ranges',
    'Content-Length',
    'Content-Type'
  ],
  credentials: true
};

app.use(cors(corsOptions));

// HTTP Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ======================== AUTHENTICATION & ACCESS CONTROL ========================
const AUTH_COOKIE_NAME = 'ayush_auth_token';
const AUTH_SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1-hour session timeout

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, hash, salt) {
  try {
    const computed = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) {
    return false;
  }
}

function extractAuthToken(req) {
  if (req.cookies && req.cookies[AUTH_COOKIE_NAME]) {
    return req.cookies[AUTH_COOKIE_NAME];
  }
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.headers['x-auth-token']) {
    return String(req.headers['x-auth-token']).trim();
  }
  if (req.query && req.query.authToken) {
    return String(req.query.authToken).trim();
  }
  return null;
}

function authMiddleware(req, res, next) {
  const token = extractAuthToken(req);
  if (token) {
    const session = databaseManager.getAuthSession(token);
    if (session) {
      req.authSession = session;
      req.user = {
        userId: session.user_id,
        username: session.username,
        role: session.role
      };
      // Touch session to slide 1-hour inactivity expiration window
      databaseManager.touchAuthSession(token, AUTH_SESSION_MAX_AGE_MS);
    }
  }
  next();
}

// Periodic cleanup of expired auth sessions (every 15 minutes)
setInterval(() => {
  try {
    databaseManager.cleanupExpiredSessions();
  } catch (e) {}
}, 15 * 60 * 1000).unref();

// Middleware
app.use(morgan('dev'));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(authMiddleware);
app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'home.html'));
});

app.get(['/login', '/login/', '/login.html'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get(['/media', '/media/', '/media.html'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'media.html'));
});

app.get(['/pdf', '/pdf/', '/pdf.html'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pdf.html'));
});

app.get(['/image', '/image/', '/image.html'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'image.html'));
});

app.get('/index.html', (req, res) => {
  res.redirect(302, '/');
});

app.get(['/dashboard', '/dashboard/', '/dashboard.html'], (req, res) => {
  if (databaseManager.hasAnyAdmin() && req.user && req.user.role === 'guest') {
    return res.status(403).send('Access denied: Dashboard requires Admin access.');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

app.get('/docs/openapi.yaml', (req, res) => {
  res.sendFile(path.join(__dirname, 'docs', 'openapi.yaml'));
});

app.get('/docs/API.md', (req, res) => {
  res.sendFile(path.join(__dirname, 'docs', 'API.md'));
});

// Allowed Media Extensions for File Explorer
const ALLOWED_MEDIA_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.webm',
  '.mp3', '.wav', '.m4a', '.aac',
  '.flac', '.ogg', '.opus', '.ts', '.m4v', '.3gp'
]);

const PDF_EXTS = new Set(['.pdf']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const IMAGE_STUDIO_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff'
]);
const BROWSE_FILTERS = {
  media: ALLOWED_MEDIA_EXTS,
  pdf: PDF_EXTS,
  image: IMAGE_EXTS,
  'image-studio': IMAGE_STUDIO_EXTS,
  'pdf-image': new Set([...PDF_EXTS, ...IMAGE_EXTS])
};

// Formats the Media Studio can safely name/mux. Keeping this list tight is
// what stops a crafted `format` value from injecting path separators into the
// output filename (and escaping the allowed storage roots).
const SUPPORTED_OUTPUT_FORMATS = new Set([
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'ts', '3gp', 'gif',
  'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus'
]);

// Extensions that the generic /api/download route may serve. Used only when a
// caller provides an explicit `?path=` override (direct-path outputs).
const DOWNLOADABLE_EXTS = new Set([
  ...ALLOWED_MEDIA_EXTS,
  ...IMAGE_STUDIO_EXTS,
  '.gif', '.webp', '.avif', '.tif', '.tiff',
  '.flv', '.wmv', '.mpg', '.mpeg', '.vob', '.ogv',
  '.wma', '.aiff', '.alac', '.amr', '.3g2'
]);

function normalizeOutputFormatName(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase().replace(/^\./, '');
  if (!raw) return null;
  if (!/^[a-z0-9]{1,5}$/.test(raw) || !SUPPORTED_OUTPUT_FORMATS.has(raw)) {
    throw createHttpError(400, `Unsupported output format "${String(value).trim()}".`);
  }
  return raw;
}

function buildOutputDownloadUrl(filePath) {
  const resolved = path.resolve(String(filePath));
  const parent = path.dirname(resolved);
  const filename = path.basename(resolved);
  const isRootedInDownloadDir = [PROCESSED_DIR, UPLOADS_DIR]
    .filter(Boolean)
    .some(dir => path.resolve(dir) === parent);
  if (isRootedInDownloadDir) {
    return `/api/download/${encodeURIComponent(filename)}`;
  }
  return `/api/download/${encodeURIComponent(filename)}?path=${encodeURIComponent(resolved)}`;
}

// In-memory job store & SSE subscribers
const jobs = new Map();
const sseSubscribers = new Map();
const globalSseClients = new Set();

// Active FFmpeg Process Tracking (supports maxConcurrency > 1 without clobbering)
let currentFFmpegProcess = null;
const activeProcesses = new Map(); // jobId -> ChildProcess
let zombieInactivityTimer = null;

function setProcessActive(jobId, proc) {
  if (jobId && proc) {
    activeProcesses.set(jobId, proc);
  }
  currentFFmpegProcess = proc;
}

function clearProcessActive(jobId) {
  if (jobId) {
    activeProcesses.delete(jobId);
  }
  if (activeProcesses.size > 0) {
    const remaining = Array.from(activeProcesses.values());
    currentFFmpegProcess = remaining[remaining.length - 1];
  } else {
    currentFFmpegProcess = null;
  }
}

function syncActiveJobFromJob(job) {
  if (!job) return;
  const totalSec = job.totalDurationSec || job.expectedDuration || 0;
  activeJob = {
    jobId: job.id,
    sessionId: job.sessionId || null,
    status: job.status || 'processing',
    filePath: job.filePath || (Array.isArray(job.inputPaths) ? job.inputPaths[0] : '') || '',
    filename: job.filename || (job.filePath ? path.basename(job.filePath) : ''),
    operation: job.operation || '',
    progress: typeof job.progress === 'number' ? job.progress : (job.progress?.percent || 0),
    isRemoteUpload: Boolean(job.isRemoteUpload),
    currentTime: job.currentTime || '00:00:00',
    totalDuration: job.totalDuration || formatTime(totalSec),
    totalDurationSec: totalSec,
    speed: job.speed || '0.0x',
    outputPath: job.outputPath || '',
    commandString: job.commandString || '',
    error: job.error || null,
    outputFile: job.outputFile || null
  };
}

// A job is considered dead if FFmpeg produces no stdout/stderr for this long.
// FFmpeg emits progress lines roughly twice a second, so total silence means
// the process is hung (or waiting on a blocked read) and should be reclaimed.
const JOB_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// PDF/Image locks are not heartbeat-monitored, so a long batch can easily
// exceed the old 10-minute assumption. Keep a generous ceiling that still
// recovers from a genuinely crashed handler.
const STALE_LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Global Active Job State (Preserved across browser refreshes)
let activeJob = {
  jobId: null,
  sessionId: null,
  status: 'idle', // 'idle' | 'processing' | 'completed' | 'failed'
  filePath: '',
  filename: '',
  operation: '',
  progress: 0,
  currentTime: '00:00:00',
  totalDuration: '00:00:00',
  totalDurationSec: 0,
  speed: '0.0x',
  outputPath: '',
  commandString: '',
  error: null,
  outputFile: null,
  isRemoteUpload: false
};

// Standardize job payload for clients regardless of whether it came from activeJob or jobs Map
function formatJobForClient(job) {
  if (!job) return null;
  const progressPercent = typeof job.progress === 'number'
    ? job.progress
    : (job.progress && typeof job.progress.percent === 'number' ? job.progress.percent : 0);
  const currentTime = job.currentTime || (job.progress && job.progress.time) || '00:00:00';
  const speed = job.speed || (job.progress && job.progress.speed) || 'N/A';
  const totalDuration = job.totalDuration || (job.expectedDuration ? formatTime(job.expectedDuration) : '00:00:00');

  let queuePosition = 0;
  if (job.status === 'queued' && queueManager && Array.isArray(queueManager.queue)) {
    const idx = queueManager.queue.findIndex(q => q.id === (job.id || job.jobId));
    if (idx !== -1) queuePosition = idx + 1;
    else queuePosition = queueManager.queue.length || 1;
  }

  return {
    jobId: job.id || job.jobId || null,
    sessionId: job.sessionId || null,
    status: job.status || 'idle',
    queuePosition,
    filePath: job.filePath || (job.inputPaths && job.inputPaths[0]) || '',
    filename: job.filename || (job.filePath ? path.basename(job.filePath) : ''),
    operation: job.operation || '',
    progress: progressPercent,
    currentTime,
    totalDuration,
    totalDurationSec: job.totalDurationSec || job.expectedDuration || 0,
    speed,
    outputPath: job.outputPath || '',
    commandString: job.commandString || '',
    error: job.error || null,
    outputFile: job.outputFile || null,
    isRemoteUpload: Boolean(job.isRemoteUpload)
  };
}

// ==================== UNIFIED JOB CONCURRENCY LOCK ====================
// Termux on Android is resource-constrained. Ensure Media Studio (FFmpeg)
// and PDF Studio (qpdf, Ghostscript, pdf-lib, pdftoppm) do not run heavy jobs
// concurrently, preventing out-of-memory crashes and state corruption.
const concurrencyLock = {
  pdfJob: {
    isProcessing: false,
    tool: '',
    startedAt: null,
    activeFiles: new Set()
  },
  imageJob: {
    isProcessing: false,
    operation: '',
    startedAt: null,
    activeFiles: new Set()
  },
  removeFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return;
    try {
      const resolved = path.resolve(filePath);
      if (this.pdfJob && this.pdfJob.activeFiles) this.pdfJob.activeFiles.delete(resolved);
      if (this.imageJob && this.imageJob.activeFiles) this.imageJob.activeFiles.delete(resolved);
    } catch (e) {}
  },
  isMediaProcessing() {
    return Boolean(
      (queueManager && queueManager.activeJobs && queueManager.activeJobs.size > 0) ||
      activeProcesses.size > 0 ||
      (activeJob && activeJob.status === 'processing')
    );
  },
  acquireMediaLock() {
    if (this.pdfJob.isProcessing) {
      if (this.pdfJob.startedAt && (Date.now() - this.pdfJob.startedAt > STALE_LOCK_TIMEOUT_MS)) {
        console.warn(`[ConcurrencyLock] Auto-releasing stale PDF lock for ${this.pdfJob.tool} (>30m)`);
        this.releasePdfLock();
      } else {
        const err = new Error(`A PDF operation (${this.pdfJob.tool}) is currently running. Please wait for it to finish.`);
        err.status = 409;
        throw err;
      }
    }
    if (this.imageJob.isProcessing) {
      if (this.imageJob.startedAt && (Date.now() - this.imageJob.startedAt > STALE_LOCK_TIMEOUT_MS)) {
        console.warn(`[ConcurrencyLock] Auto-releasing stale image lock for ${this.imageJob.operation} (>30m)`);
        this.releaseImageLock();
      } else {
        const err = new Error(`An image operation (${this.imageJob.operation}) is currently running. Please wait for it to finish.`);
        err.status = 409;
        throw err;
      }
    }
    if (queueManager && queueManager.queue && queueManager.queue.length >= queueManager.maxQueueSize) {
      const err = new Error(`Queue is full (maximum ${queueManager.maxQueueSize} queued jobs). Please wait for current jobs to finish.`);
      err.status = 429;
      throw err;
    }
  },
  acquirePdfLock(toolName) {
    if (this.isMediaProcessing()) {
      const activeName = (activeJob && activeJob.filename) || (queueManager?.activeJobs ? Array.from(queueManager.activeJobs.values())[0]?.filename : '') || 'Video/Audio encoding';
      const qLen = queueManager?.queue?.length || 0;
      const err = new Error('A media conversion process is currently running. Please wait for it to finish or cancel it.');
      err.status = 409;
      err.busy = true;
      err.activeType = 'media';
      err.activeJobName = activeName;
      err.queuePosition = qLen + 1;
      err.queuedJobsCount = qLen;
      throw err;
    }
    if (this.imageJob.isProcessing) {
      if (this.imageJob.startedAt && (Date.now() - this.imageJob.startedAt > STALE_LOCK_TIMEOUT_MS)) {
        console.warn(`[ConcurrencyLock] Auto-releasing stale image lock for ${this.imageJob.operation} (>30m)`);
        this.releaseImageLock();
      } else {
        const err = new Error(`An image operation (${this.imageJob.operation}) is currently running. Please wait for it to finish.`);
        err.status = 409;
        err.busy = true;
        err.activeType = 'image';
        err.activeJobName = this.imageJob.operation || 'Image processing';
        err.queuePosition = 1;
        err.queuedJobsCount = 0;
        throw err;
      }
    }
    if (this.pdfJob.isProcessing) {
      if (this.pdfJob.startedAt && (Date.now() - this.pdfJob.startedAt > STALE_LOCK_TIMEOUT_MS)) {
        console.warn(`[ConcurrencyLock] Auto-releasing stale PDF lock for ${this.pdfJob.tool} (>30m)`);
        this.releasePdfLock();
      } else {
        const err = new Error(`Another PDF operation (${this.pdfJob.tool}) is currently running. Please wait for it to finish.`);
        err.status = 409;
        err.busy = true;
        err.activeType = 'pdf';
        err.activeJobName = this.pdfJob.tool || 'PDF Studio';
        err.queuePosition = 1;
        err.queuedJobsCount = 0;
        throw err;
      }
    }
    this.pdfJob.isProcessing = true;
    this.pdfJob.tool = toolName;
    this.pdfJob.startedAt = Date.now();
    this.pdfJob.activeFiles.clear();
    this._pdfWakeLock = wakeLockManager.acquire(`PDF Studio: ${toolName}`);
  },
  acquireImageLock(operationName) {
    if (this.isMediaProcessing()) {
      const activeName = (activeJob && activeJob.filename) || (queueManager?.activeJobs ? Array.from(queueManager.activeJobs.values())[0]?.filename : '') || 'Video/Audio encoding';
      const qLen = queueManager?.queue?.length || 0;
      const err = new Error('A media conversion process is currently running. Please wait for it to finish or cancel it.');
      err.status = 409;
      err.busy = true;
      err.activeType = 'media';
      err.activeJobName = activeName;
      err.queuePosition = qLen + 1;
      err.queuedJobsCount = qLen;
      throw err;
    }
    if (this.pdfJob.isProcessing) {
      if (this.pdfJob.startedAt && (Date.now() - this.pdfJob.startedAt > STALE_LOCK_TIMEOUT_MS)) {
        console.warn(`[ConcurrencyLock] Auto-releasing stale PDF lock for ${this.pdfJob.tool} (>30m)`);
        this.releasePdfLock();
      } else {
        const err = new Error(`A PDF operation (${this.pdfJob.tool}) is currently running. Please wait for it to finish.`);
        err.status = 409;
        err.busy = true;
        err.activeType = 'pdf';
        err.activeJobName = this.pdfJob.tool || 'PDF Studio';
        err.queuePosition = 1;
        err.queuedJobsCount = 0;
        throw err;
      }
    }
    if (this.imageJob.isProcessing) {
      if (this.imageJob.startedAt && (Date.now() - this.imageJob.startedAt > STALE_LOCK_TIMEOUT_MS)) {
        console.warn(`[ConcurrencyLock] Auto-releasing stale image lock for ${this.imageJob.operation} (>30m)`);
        this.releaseImageLock();
      } else {
        const err = new Error('Another image operation is currently running. Please wait for it to finish.');
        err.status = 409;
        err.busy = true;
        err.activeType = 'image';
        err.activeJobName = this.imageJob.operation || 'Image processing';
        err.queuePosition = 1;
        err.queuedJobsCount = 0;
        throw err;
      }
    }
    this.imageJob.isProcessing = true;
    this.imageJob.operation = operationName;
    this.imageJob.startedAt = Date.now();
    this.imageJob.activeFiles.clear();
    this._imageWakeLock = wakeLockManager.acquire(`Sharp: ${operationName}`);
  },
  releasePdfLock() {
    this.pdfJob.isProcessing = false;
    this.pdfJob.tool = '';
    this.pdfJob.startedAt = null;
    this.pdfJob.activeFiles.clear();
    if (this._pdfWakeLock) {
      try { this._pdfWakeLock.release(); } catch (e) {}
      this._pdfWakeLock = null;
    }
  },
  releaseImageLock() {
    this.imageJob.isProcessing = false;
    this.imageJob.operation = '';
    this.imageJob.startedAt = null;
    this.imageJob.activeFiles.clear();
    if (this._imageWakeLock) {
      try { this._imageWakeLock.release(); } catch (e) {}
      this._imageWakeLock = null;
    }
  }
};

analyticsService.setConcurrencyLock(concurrencyLock);

// Reset activeJob to idle after a delay (keeps data visible for result screen, then clears)
function scheduleActiveJobReset(expectedJobId = null, delayMs = 60000) {
  const timer = setTimeout(() => {
    // Only reset if the job is no longer processing and still refers to the same job
    if (activeJob.status !== 'processing' && (!expectedJobId || activeJob.jobId === expectedJobId)) {
      activeJob.status = 'idle';
      activeJob.filePath = '';
      activeJob.outputPath = '';
    }
  }, delayMs);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

// ==================== AUTO-CLEANUP & STORAGE LIFECYCLE (30 MIN) ====================
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

function isFileBeingWritten(filePath, initialStats) {
  if (!filePath) return false;
  try {
    const s1 = initialStats || fs.statSync(filePath);
    if (s1.isDirectory()) return false;
    // If modified within the last 15 seconds, treat as actively being written without blocking the event loop
    if (Date.now() - (s1.mtimeMs || 0) < 15000) {
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function isFileInActiveProcessing(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  let target;
  try {
    target = path.resolve(filePath);
  } catch (e) {
    return false;
  }

  const now = Date.now();
  const MAX_JOB_AGE_MS = 15 * 60 * 1000; // 15 minutes max active processing time

  // 1. Check global activeJob (Media Studio)
  if (activeJob && activeJob.status === 'processing') {
    if (!currentFFmpegProcess && activeJob.startedAt && (now - activeJob.startedAt > MAX_JOB_AGE_MS)) {
      activeJob.status = 'failed';
      activeJob.filePath = '';
      activeJob.outputPath = '';
    } else {
      if (activeJob.filePath && path.resolve(activeJob.filePath) === target) return true;
      if (activeJob.outputPath && path.resolve(activeJob.outputPath) === target) return true;
    }
  }

  // 2. Check all jobs in store and active queue workers (Media Studio jobs)
  const trackedJobs = new Map(jobs);
  if (queueManager && queueManager.activeJobs) {
    for (const [id, ctx] of queueManager.activeJobs.entries()) {
      if (ctx && ctx.job) trackedJobs.set(id, ctx.job);
    }
  }
  for (const job of trackedJobs.values()) {
    if (job && job.status === 'processing') {
      const jobAge = now - (job.startedAt || job.createdAt || now);
      if (jobAge > MAX_JOB_AGE_MS && !activeProcesses.has(job.id)) {
        job.status = 'failed';
        job.error = 'Job timed out in processing state';
        continue;
      }
      if (job.filePath && path.resolve(job.filePath) === target) return true;
      if (job.outputPath && path.resolve(job.outputPath) === target) return true;
      if (Array.isArray(job.inputPaths)) {
        for (const p of job.inputPaths) {
          if (p && path.resolve(p) === target) return true;
        }
      }
    }
  }

  // 3. Check PDF active operations
  if (concurrencyLock.pdfJob && concurrencyLock.pdfJob.isProcessing) {
    if (concurrencyLock.pdfJob.startedAt && (now - concurrencyLock.pdfJob.startedAt > STALE_LOCK_TIMEOUT_MS)) {
      console.warn(`[Auto-Cleanup] Auto-releasing stale PDF lock for ${concurrencyLock.pdfJob.tool} (>30m)`);
      concurrencyLock.releasePdfLock();
    } else if (concurrencyLock.pdfJob.activeFiles && concurrencyLock.pdfJob.activeFiles.has(target)) {
      return true;
    }
  }

  // 4. Check Image active operations
  if (concurrencyLock.imageJob && concurrencyLock.imageJob.isProcessing) {
    if (concurrencyLock.imageJob.startedAt && (now - concurrencyLock.imageJob.startedAt > STALE_LOCK_TIMEOUT_MS)) {
      console.warn(`[Auto-Cleanup] Auto-releasing stale image lock for ${concurrencyLock.imageJob.operation} (>30m)`);
      concurrencyLock.releaseImageLock();
    } else if (concurrencyLock.imageJob.activeFiles && concurrencyLock.imageJob.activeFiles.has(target)) {
      return true;
    }
  }

  return false;
}

// Rule D: Immediately clean up temp uploaded file(s) on cancel/error
function cleanupTempUploadsOnError(...filePaths) {
  const tempDirs = [UPLOADS_DIR, THUMBS_DIR];
  for (const p of filePaths) {
    if (!p || typeof p !== 'string') continue;
    try {
      const resolved = path.resolve(p);
      const isUnderTemp = tempDirs.some(dir => isPathWithinRoot(resolved, dir) || resolved === dir);
      if (isUnderTemp && fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
        console.log(`[Auto-Cleanup] Immediately deleted temp upload on error/cancel: ${resolved}`);
      }
    } catch (err) {
      console.warn(`[Auto-Cleanup] Error unlinking temp file ${p}:`, err.message);
    }
  }
}

function cleanDirectory(dirPath, isTempUploads = false) {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  try {
    const entries = fs.readdirSync(dirPath);
    const now = Date.now();

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch (e) {
        continue;
      }

      const ageMs = now - stats.mtimeMs;

      if (ageMs > THIRTY_MINUTES_MS) {
        // Skip files that are actively being read or written by any job
        if (isFileInActiveProcessing(fullPath)) {
          // Fallback: If a file is older than 30 minutes, it should be deleted EVEN IF it thinks it's processing,
          // UNLESS the file is currently being written to (which is rare).
          if (isFileBeingWritten(fullPath, stats)) {
            console.log(`[Auto-Cleanup] Skipping active file currently being written (${entry}) in ${path.basename(dirPath)}.`);
            continue;
          }
          console.warn(`[Auto-Cleanup] File (${entry}) was marked active but is older than 30m and not being written to; forcing deletion.`);
        }

        try {
          if (stats.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            console.log(`[Auto-Cleanup] Deleted expired directory (${Math.round(ageMs / 60000)}m old): ${entry}`);
          } else {
            fs.unlinkSync(fullPath);
            console.log(`[Auto-Cleanup] Deleted expired file (${Math.round(ageMs / 60000)}m old): ${entry}`);
          }
        } catch (delErr) {
          if (delErr && delErr.code !== 'ENOENT') {
            console.error('[Cleanup Failed]', fullPath, delErr);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Auto-Cleanup] Error reading ${dirPath}:`, err.message);
  }
}

function runAutoCleanup() {
  console.log('[Cleanup] Running periodic sweep...');
  try {
    wakeLockManager.cleanupStaleLocks(STALE_LOCK_TIMEOUT_MS);
    cleanDirectory(UPLOADS_DIR, true);
    cleanDirectory(PROCESSED_DIR, false);
    cleanDirectory(THUMBS_DIR, false);
  } catch (err) {
    console.error('[Cleanup] Periodic sweep encountered an error:', err);
  }
}

// Note: Cleanup scheduling is owned solely by cleanupManager (initialized in initServices)
// to prevent duplicate sweeps racing on the same directories.

// ======================== MULTER CONFIGURATION ========================
// Strict filename sanitizer: strips null bytes, path traversal, control chars, limits length
function sanitizeUploadFilename(originalName) {
  if (!originalName || typeof originalName !== 'string') return 'upload.bin';
  // Strip null bytes and control chars
  const clean = originalName.replace(/[\x00-\x1f\x7f]/g, '');
  const baseRaw = path.basename(clean);
  const extRaw = path.extname(baseRaw).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const nameWithoutExt = path.basename(baseRaw, extRaw)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 60);
  const finalBase = nameWithoutExt || 'file';
  const finalExt = extRaw.slice(0, 10);
  return `${finalBase}${finalExt}`;
}

const uploadStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, TEMP_UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const safeOriginal = sanitizeUploadFilename(file.originalname);
    cb(null, `${uniqueSuffix}-${safeOriginal}`);
  }
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: { fileSize: Infinity } // Completely remove file upload size restrictions
});

// Helper: Format bytes
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper: Format seconds to HH:MM:SS
function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00:00';
  const sec = Math.max(0, Math.floor(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// Helper: Parse time string (HH:MM:SS or HH:MM:SS.xx) to total seconds
function parseTimeToSeconds(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str;
  const clean = String(str).trim();
  const parts = clean.split(':');
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const s = parseFloat(parts[2]) || 0;
    return h * 3600 + m * 60 + s;
  } else if (parts.length === 2) {
    const m = parseInt(parts[0], 10) || 0;
    const s = parseFloat(parts[1]) || 0;
    return m * 60 + s;
  }
  return parseFloat(clean) || 0;
}

// Backward-compatible alias
const parseTimeString = parseTimeToSeconds;

// Helper: Parse FPS fraction
function parseFps(fpsStr) {
  if (!fpsStr) return 0;
  if (fpsStr.includes('/')) {
    const [num, den] = fpsStr.split('/').map(Number);
    return den ? +(num / den).toFixed(2) : 0;
  }
  return +parseFloat(fpsStr).toFixed(2) || 0;
}

// Helper: Get exact video duration using ffprobe
function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) {
        console.warn(`[ffprobe] Notice: duration probe gave no output or failed for ${filePath}:`, err ? err.message : 'empty stdout');
        return resolve(0);
      }
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const val = line.trim();
        if (val && val !== 'N/A') {
          const sec = parseFloat(val);
          if (!isNaN(sec) && sec > 0) {
            console.log(`[ffprobe] Extracted duration: ${sec}s (${formatTime(sec)}) for ${filePath}`);
            return resolve(sec);
          }
        }
      }
      console.warn(`[ffprobe] No valid numeric duration found in output for ${filePath}: "${stdout.trim()}"`);
      resolve(0);
    });
  });
}

// Helper: Tokenize arguments for Raw command mode
function tokenizeArgs(cmdString) {
  const args = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < cmdString.length; i++) {
    const char = cmdString[i];
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (/\s/.test(char) && !inDouble && !inSingle) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

// Media metadata probe using ffprobe
function probeMedia(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], { timeout: 15000 }, (err, stdout) => {
      if (err || !stdout) {
        return resolve({
          duration: 0,
          durationFormatted: '00:00:00',
          format: path.extname(filePath).replace('.', '') || 'unknown',
          size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
          streams: []
        });
      }

      try {
        const data = JSON.parse(stdout);
        const format = data.format || {};
        const duration = parseFloat(format.duration) || 0;
        const size = parseInt(format.size, 10) || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
        const videoStream = (data.streams || []).find(s => s.codec_type === 'video');
        const audioStream = (data.streams || []).find(s => s.codec_type === 'audio');

        resolve({
          duration,
          durationFormatted: formatTime(duration),
          format: format.format_name || path.extname(filePath).replace('.', ''),
          size,
          bitrate: format.bit_rate ? Math.round(parseInt(format.bit_rate, 10) / 1000) + ' kbps' : 'N/A',
          video: videoStream ? {
            codec: videoStream.codec_name,
            width: videoStream.width,
            height: videoStream.height,
            fps: parseFps(videoStream.r_frame_rate || videoStream.avg_frame_rate),
            bitrate: videoStream.bit_rate ? Math.round(parseInt(videoStream.bit_rate, 10) / 1000) + ' kbps' : null
          } : null,
          audio: audioStream ? {
            codec: audioStream.codec_name,
            sampleRate: audioStream.sample_rate ? audioStream.sample_rate + ' Hz' : null,
            channels: audioStream.channels,
            bitrate: audioStream.bit_rate ? Math.round(parseInt(audioStream.bit_rate, 10) / 1000) + ' kbps' : null
          } : null
        });
      } catch (parseErr) {
        resolve({
          duration: 0,
          durationFormatted: '00:00:00',
          format: 'unknown',
          size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
          streams: []
        });
      }
    });
  });
}

// ISO 639 language code mapping for human-readable track titles
const LANGUAGE_NAMES = {
  eng: 'English',
  hin: 'Hindi',
  tam: 'Tamil',
  tel: 'Telugu',
  kan: 'Kannada',
  mal: 'Malayalam',
  spa: 'Spanish',
  fre: 'French',
  fra: 'French',
  ger: 'German',
  deu: 'German',
  ita: 'Italian',
  jpn: 'Japanese',
  kor: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  rus: 'Russian',
  ara: 'Arabic',
  por: 'Portuguese',
  ben: 'Bengali',
  pan: 'Punjabi',
  mar: 'Marathi',
  guj: 'Gujarati',
  urd: 'Urdu',
  tur: 'Turkish',
  vie: 'Vietnamese',
  tha: 'Thai',
  ind: 'Indonesian',
  pol: 'Polish',
  ukr: 'Ukrainian',
  nld: 'Dutch',
  swe: 'Swedish',
  nor: 'Norwegian',
  dan: 'Danish',
  fin: 'Finnish',
  ces: 'Czech',
  cze: 'Czech',
  ell: 'Greek',
  gre: 'Greek',
  heb: 'Hebrew',
  hun: 'Hungarian',
  ron: 'Romanian',
  rum: 'Romanian'
};

// Auto-Detect & Analyze Media Details using ffprobe JSON output
function analyzeMedia(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        return reject(new Error(`ffprobe failed to analyze media: ${err.message}`));
      }

      try {
        const data = JSON.parse(stdout || '{}');
        const format = data.format || {};
        const duration = parseFloat(format.duration) || 0;
        const size = parseInt(format.size, 10) || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
        const streams = data.streams || [];

        // 1. Video Codec & Stream
        const videoStream = streams.find(s => s.codec_type === 'video');
        const videoCodec = videoStream ? (videoStream.codec_name || 'unknown') : null;

        // 2. All Audio Streams
        const audioStreams = [];
        let audioCounter = 0;

        for (const s of streams) {
          if (s.codec_type === 'audio') {
            audioCounter++;
            const tags = s.tags || {};
            const langRaw = (tags.language || '').toLowerCase().trim();
            const titleRaw = (tags.title || '').trim();

            // Language/title label: If no language tag exists, label it as "Audio Track 1"
            let label = '';
            if (titleRaw) {
              label = titleRaw;
            } else if (langRaw) {
              label = LANGUAGE_NAMES[langRaw] || langRaw.toUpperCase();
            } else {
              label = `Audio Track ${audioCounter}`;
            }

            audioStreams.push({
              index: `0:${s.index}`,
              streamIndex: s.index,
              audioIndex: audioCounter - 1,
              codec: s.codec_name || 'unknown',
              codecName: s.codec_name || 'unknown',
              language: langRaw,
              title: titleRaw,
              label: label,
              channels: s.channels || 2,
              sampleRate: s.sample_rate ? s.sample_rate + ' Hz' : null,
              bitrate: s.bit_rate ? Math.round(parseInt(s.bit_rate, 10) / 1000) + ' kbps' : null
            });
          }
        }

        // 3. All Subtitle Streams
        const subtitleStreams = [];
        let subCounter = 0;

        for (const s of streams) {
          if (s.codec_type === 'subtitle') {
            subCounter++;
            const tags = s.tags || {};
            const langRaw = (tags.language || '').toLowerCase().trim();
            const titleRaw = (tags.title || '').trim();

            let label = '';
            if (titleRaw) {
              label = titleRaw;
            } else if (langRaw) {
              label = LANGUAGE_NAMES[langRaw] || langRaw.toUpperCase();
            } else {
              label = `Subtitle Track ${subCounter}`;
            }

            subtitleStreams.push({
              index: `0:${s.index}`,
              streamIndex: s.index,
              subIndex: subCounter - 1,
              codec: s.codec_name || 'unknown',
              codecName: s.codec_name || 'unknown',
              language: langRaw,
              title: titleRaw,
              label: label,
              isDefault: Boolean(s.disposition && s.disposition.default),
              isForced: Boolean(s.disposition && s.disposition.forced)
            });
          }
        }

        resolve({
          success: true,
          filePath,
          filename: path.basename(filePath),
          duration,
          durationFormatted: formatTime(duration),
          videoCodec: videoCodec || 'None (Audio Only)',
          hasVideo: Boolean(videoStream),
          hasAudio: audioStreams.length > 0,
          hasSubtitles: subtitleStreams.length > 0,
          video: videoStream ? {
            codec: videoStream.codec_name,
            width: videoStream.width,
            height: videoStream.height,
            fps: parseFps(videoStream.r_frame_rate || videoStream.avg_frame_rate),
            bitrate: videoStream.bit_rate ? Math.round(parseInt(videoStream.bit_rate, 10) / 1000) + ' kbps' : null
          } : null,
          audioStreams,
          subtitleStreams,
          format: format.format_name || path.extname(filePath).replace('.', ''),
          size,
          sizeFormatted: formatBytes(size)
        });
      } catch (parseErr) {
        reject(new Error(`Failed to parse media analysis JSON: ${parseErr.message}`));
      }
    });
  });
}

// Quote a single argv token for human-readable shell display/copy.
// Execution NEVER uses a shell; this is only for the Debug Console.
function shellQuoteArg(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (str === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// Backward-compatible wrapper used by legacy call sites.
function quotePath(p) {
  if (p === null || p === undefined || p === '') return '""';
  let str = String(p).trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1);
  }
  return shellQuoteArg(str);
}

// Build a display-only FFmpeg command. The returned string must never be executed.
function buildSafeFfmpegCommand(args, inputPaths = [], outputPath = null, executable = 'ffmpeg') {
  const list = Array.isArray(args) ? args : [];
  return [executable, ...list.map(shellQuoteArg)].join(' ');
}

// Escape a local path for use inside an FFmpeg filtergraph option value.
function escapeFilterPath(filePath) {
  return String(filePath)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// Strict argv parser for the Advanced Custom Command box.
// Supports single/double quotes and backslash escapes, never shell expansion.
function parseCommandLine(command) {
  const args = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let hasToken = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === '\0' || ch === '\n' || ch === '\r') {
      throw createHttpError(400, 'Command contains invalid control characters. Keep it on a single line.');
    }

    if (escaped) {
      current += ch;
      escaped = false;
      hasToken = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      hasToken = true;
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < command.length && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        current += command[++i];
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      hasToken = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (escaped) throw createHttpError(400, 'Command ends with an incomplete escape sequence.');
  if (inSingle || inDouble) throw createHttpError(400, 'Command has an unterminated quote.');
  if (hasToken) args.push(current);
  return args;
}

function stripFileProtocol(value) {
  if (typeof value !== 'string') return value;
  if (/^file:\/\//i.test(value)) return value.replace(/^file:\/\//i, '/');
  if (/^file:/i.test(value)) return value.replace(/^file:/i, '');
  return value;
}

function hasNonFileProtocol(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  if (scheme === 'file') return false;
  // Avoid treating single-letter Windows-style drive prefixes as protocols.
  if (scheme.length === 1) return false;
  return true;
}

function validateFileReference(value, cwd, label) {
  if (typeof value !== 'string' || value === '' || value === '-') return;
  if (hasNonFileProtocol(value)) {
    throw createHttpError(400, `${label} uses a blocked URL protocol. Only local files are allowed.`);
  }
  const cleaned = stripFileProtocol(value);
  const resolved = path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
  assertPathAllowed(resolved, label);
}

function extractFilterFileReferences(filterExpr) {
  const refs = [];
  if (typeof filterExpr !== 'string' || !filterExpr) return refs;

  const reservedKeys = new Set([
    'filename', 'file', 'fontfile', 'textfile', 'psfile', 'subfile',
    'model', 'f', 'format', 'si', 'force_style', 'charenc', 'stream_index'
  ]);

  const cleanRef = (val) => {
    if (!val || typeof val !== 'string') return null;
    let s = val.trim();
    // Strip surrounding quotes (regular quotes or backslash-escaped quotes)
    s = s.replace(/^(\\?['"])(.*)\1$/, '$2');
    s = s.replace(/^['"]|['"]$/g, '');
    // Unescape backslash-escaped characters in FFmpeg filter syntax (e.g. \:, \', \\, \[, \], \,, \;)
    s = s.replace(/\\([:,'"\\[\];])/g, '$1');
    s = s.trim();
    // Exclude reserved filter keys, flags, or purely numeric/empty values
    if (!s || s === '-' || reservedKeys.has(s.toLowerCase()) || /^[0-9]+(?:\.[0-9]+)?$/.test(s)) return null;
    return s;
  };

  // 1. Explicit key=value pairs for file parameters in FFmpeg filters
  // Matches key=(quoted string OR unquoted token allowing escaped chars)
  const keyPattern = /(?:filename|file|fontfile|textfile|psfile|subfile|movie|amovie|subtitles|ass|lut3d|model|f)\s*=\s*(?:'([^']*)'|"([^"]*)"|((?:\\.|[^\s,;:=|\[\]'"])+))/gi;
  let match;
  while ((match = keyPattern.exec(filterExpr)) !== null) {
    const rawVal = match[1] || match[2] || match[3];
    const cleaned = cleanRef(rawVal);
    if (cleaned) refs.push(cleaned);
  }

  // 2. Catch file paths: absolute (/), file: URIs, relative (./, ../), or Windows drive (C:/, C:\)
  // Allows escaped colons/chars like \: within the path
  const pathPattern = /(?:^|[=\s'",;:\[\]])((?:file:|\/|\.\.?\/|[a-zA-Z]:[\\\/])(?:\\.|[^\s,;:|\[\]'"])+)/g;
  while ((match = pathPattern.exec(filterExpr)) !== null) {
    const cleaned = cleanRef(match[1]);
    if (cleaned) refs.push(cleaned);
  }

  // 3. Catch file references by common media/data extensions
  const extPattern = /(?:^|[=\s'",;:\[\]])((?:\\.|[^\s,;:=|\[\]'"])+\.(?:srt|ass|ssa|vtt|sub|idx|ttf|otf|ttc|woff|woff2|png|jpg|jpeg|webp|gif|bmp|mp4|mkv|avi|mov|webm|flv|ts|mp3|wav|flac|aac|ogg|m4a|cube|acv|txt|json|conf|log))(?=[=\s'",;:\[\]]|$)/gi;
  while ((match = extPattern.exec(filterExpr)) !== null) {
    const cleaned = cleanRef(match[1]);
    if (cleaned) refs.push(cleaned);
  }

  return Array.from(new Set(refs.filter(Boolean)));
}

const CUSTOM_PATH_VALUE_OPTIONS = new Set(['-i', '-filter_script', '-attach']);
const CUSTOM_FILTER_OPTIONS = new Set(['-vf', '-af', '-filter_complex', '-lavfi']);
const CUSTOM_FILTER_SCRIPT_OPTIONS = new Set(['-filter_complex_script']);

function validateCustomArgv(argv, cwd) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '-f' && i + 1 < argv.length && String(argv[i + 1]).toLowerCase() === 'concat') {
      throw createHttpError(400, 'The concat demuxer is not allowed.');
    }

    if (token === '-i') {
      if (i + 1 >= argv.length) throw createHttpError(400, 'Missing filename after -i.');
      validateFileReference(argv[i + 1], cwd, 'Input file');
      i++;
      continue;
    }

    if (CUSTOM_PATH_VALUE_OPTIONS.has(token) && token !== '-i') {
      if (i + 1 >= argv.length) throw createHttpError(400, `Missing value after ${token}.`);
      validateFileReference(argv[i + 1], cwd, `${token} path`);
      i++;
      continue;
    }

    if (CUSTOM_FILTER_SCRIPT_OPTIONS.has(token)) {
      if (i + 1 >= argv.length) throw createHttpError(400, `Missing value after ${token}.`);
      validateFileReference(argv[i + 1], cwd, 'Filter script');
      i++;
      continue;
    }

    if (CUSTOM_FILTER_OPTIONS.has(token)) {
      if (i + 1 >= argv.length) throw createHttpError(400, `Missing value after ${token}.`);
      for (const ref of extractFilterFileReferences(argv[i + 1])) {
        validateFileReference(ref, cwd, 'Filter file reference');
      }
      i++;
      continue;
    }

    if (token.startsWith('/') || /^file:/i.test(token)) {
      validateFileReference(token, cwd, 'File path');
    }
  }
}

function detectOutputPathFromArgv(argv, cwd) {
  if (!Array.isArray(argv) || argv.length < 2) return null;
  const skipAfter = new Set(['-i', '-filter_script', '-attach', '-filter_complex_script']);

  for (let i = argv.length - 1; i >= 0; i--) {
    const tok = argv[i];
    if (!tok || tok.startsWith('-')) continue;
    if (i > 0 && skipAfter.has(argv[i - 1])) continue;
    if (tok === '-') return null;
    if (hasNonFileProtocol(tok)) return null;

    const cleaned = stripFileProtocol(tok);
    if (cleaned.includes('.') || cleaned.includes('/')) {
      return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
    }
  }
  return null;
}

function substituteCommandPlaceholders(tokens, inputPath) {
  const inputDir = inputPath ? path.dirname(inputPath) : null;

  return tokens.map(token => {
    let out = String(token);

    if (inputPath) {
      out = out.split('{input}').join(inputPath).split('{INPUT}').join(inputPath);
    } else if (/\{input\}/i.test(out)) {
      throw createHttpError(400, 'A media file must be selected to replace the {input} placeholder.');
    }

    if (inputDir) {
      out = out.split('{output_dir}').join(inputDir).split('{OUTPUT_DIR}').join(inputDir);
    } else if (/\{output_dir\}/i.test(out)) {
      throw createHttpError(400, 'A media file must be selected to replace the {output_dir} placeholder.');
    }

    return out;
  });
}

function prepareCustomCommand(command, inputPath) {
  const rawTokens = parseCommandLine(command);
  if (rawTokens.length === 0) throw createHttpError(400, 'Command string is required.');

  const executable = rawTokens[0];
  if (!/^(ffmpeg|ffprobe)$/i.test(executable)) {
    throw createHttpError(400, 'Only FFmpeg/FFprobe commands are allowed.');
  }

  const execArgs = substituteCommandPlaceholders(rawTokens.slice(1), inputPath);
  const cwd = inputPath ? path.dirname(inputPath) : process.cwd();

  validateCustomArgv(execArgs, cwd);

  const isProbe = executable.toLowerCase() === 'ffprobe';
  const outputPath = isProbe ? null : detectOutputPathFromArgv(execArgs, cwd);
  if (outputPath) assertPathAllowed(outputPath, 'Output file');

  const displayCommand = buildSafeFfmpegCommand(execArgs, inputPath, outputPath, executable);

  return {
    executable: executable.toLowerCase(),
    execArgs,
    outputPath,
    displayCommand,
    cwd
  };
}

// Resolve a selected audio track to an explicit FFmpeg stream specifier.
// Explicit "0:N" indices are always preferred; language fallback is only used
// for legacy clients and must be unambiguous.
function resolveAudioTrack(track, mediaInfo = {}) {
  const audioStreams = Array.isArray(mediaInfo.audioStreams) ? mediaInfo.audioStreams : [];
  const raw = String(track || '').trim();
  if (!raw) throw createHttpError(400, 'Empty audio track selection.');

  if (/^0:\d+$/.test(raw)) {
    const streamIndex = parseInt(raw.split(':')[1], 10);
    if (audioStreams.length > 0 && !audioStreams.some(s => s.streamIndex === streamIndex)) {
      throw createHttpError(400, `Audio track ${raw} does not exist in this file.`);
    }
    return raw;
  }

  const lang = raw.toLowerCase();
  const matches = audioStreams.filter(s => (s.language || '').toLowerCase() === lang);
  if (matches.length === 1) return `0:${matches[0].streamIndex}`;
  if (matches.length > 1) {
    throw createHttpError(400, `Multiple audio tracks match "${raw}". Select a specific track by index.`);
  }
  throw createHttpError(400, `Unknown audio track "${raw}".`);
}

// Dynamic FFmpeg Command Builder for Multi-Operation, Audio Tracks, Subtitles & Hardware Accel
function buildDynamicFfmpegArgs({ inputPath, operations = {}, audioTracks = [], subtitleConfig = {}, outputPath, mediaInfo = {}, isLosslessCopy }) {
  const args = ['-hide_banner', '-stats'];

  // Containers that can only ever hold audio. Selecting one must implicitly
  // behave like "extract audio only", otherwise we would emit an invalid
  // "-map 0:v ... output.mp3" command that FFmpeg always rejects.
  const AUDIO_CONTAINER_FORMATS = new Set(['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'opus']);

  const muteAudio = Boolean(operations && (operations.muteAudio || operations.mute));
  const audioStreams = Array.isArray(mediaInfo.audioStreams) ? mediaInfo.audioStreams : [];
  const hasAudio = mediaInfo.hasAudio === true || audioStreams.length > 0 || Boolean(mediaInfo.audio);

  // Drop empty/invalid selections before resolving so a stray blank checkbox
  // value can never abort the whole job with "Empty audio track selection."
  const resolvedAudioTracks = (Array.isArray(audioTracks) ? audioTracks : [])
    .map(t => String(t === null || t === undefined ? '' : t).trim())
    .filter(Boolean)
    .map(track => resolveAudioTrack(track, mediaInfo));

  const formatRaw = operations && (typeof operations.format === 'string' ? operations.format : operations.format?.format);
  const requestedAudioOnly = Boolean(operations && (operations.audioOnly === true || operations.audioOnly?.enabled));
  let targetFormat = String(formatRaw || '').toLowerCase();
  const isAudioOnly = requestedAudioOnly || AUDIO_CONTAINER_FORMATS.has(targetFormat);
  if (!targetFormat) {
    targetFormat = (isAudioOnly ? 'mp3' : (path.extname(inputPath).replace('.', '') || 'mp4')).toLowerCase();
  }

  // Robust video detection. analyzeMedia() always reports hasVideo/video, but
  // probeMedia() only reports `video` (null when there is no video stream), and
  // an unknown mediaInfo must still default to "video present".
  const hasVideo = mediaInfo.hasVideo === false
    ? false
    : (mediaInfo.video === null ? false : true);

  // Subtitle burn check
  const subMode = (subtitleConfig && subtitleConfig.mode) ? subtitleConfig.mode : 'keep';
  const hasSubSelection = subtitleConfig && ((typeof subtitleConfig.burnIndex === 'number') || (Array.isArray(subtitleConfig.tracks) && subtitleConfig.tracks.length > 0));
  const isBurnSubtitles = !isAudioOnly && subMode === 'burn' && hasSubSelection;

  // Burning subtitles forces re-encoding, disabling lossless mode
  const isLossless = Boolean(
    !isBurnSubtitles &&
    (isLosslessCopy || operations.isLosslessCopy || operations.lossless || operations.videoMode === 'original' || operations.videoMode === 'copy')
  );

  // Hardware acceleration (MediaCodec on Android)
  const isHwAccel = Boolean(operations.hardwareAccel || operations.fastMode || operations.hwAccel);
  const targetBitrate = operations.bitrate || '2M';

  // 4. Trim: If trim is checked, add -ss [start] -to [end] BEFORE -i for fast input seeking
  const trim = operations.trim;
  const isTrimEnabled = trim && (trim.enabled !== false) && (trim.start || trim.end);
  if (isTrimEnabled) {
    if (trim.start) {
      args.push('-ss', String(trim.start));
    }
    if (trim.end) {
      args.push('-to', String(trim.end));
    }
  }

  // 1. Input file (placed AFTER -ss/-to for fast seek)
  args.push('-i', inputPath);

  // 2. Audio Mapping
  if (isAudioOnly) {
    args.push('-vn');

    if (muteAudio) {
      throw createHttpError(400, 'Select at least one audio track for audio extraction.');
    }
    if (mediaInfo.hasAudio === false) {
      throw createHttpError(400, 'This file has no audio tracks to extract.');
    }

    if (resolvedAudioTracks.length > 0) {
      if (targetFormat === 'mp3' || targetFormat === 'wav') {
        args.push('-map', resolvedAudioTracks[0]);
      } else {
        for (const track of resolvedAudioTracks) {
          args.push('-map', track);
        }
      }
    } else {
      args.push('-map', targetFormat === 'mp3' || targetFormat === 'wav' ? '0:a:0?' : '0:a?');
    }
  } else {
    // Video included. Use the optional "0:v?" form so a mis-detected video
    // stream degrades gracefully instead of aborting the whole job.
    if (hasVideo) {
      args.push('-map', '0:v?');
    }

    if (muteAudio) {
      args.push('-an');
    } else if (resolvedAudioTracks.length > 0) {
      for (const track of resolvedAudioTracks) {
        args.push('-map', track);
      }
    } else {
      args.push('-map', '0:a?');
    }

    // 2b. Subtitles Mapping (Soft Subtitles - if mode is 'keep')
    if (!isBurnSubtitles && subtitleConfig && Array.isArray(subtitleConfig.tracks) && subtitleConfig.tracks.length > 0) {
      for (const strk of subtitleConfig.tracks) {
        args.push('-map', strk.startsWith('0:') ? strk : `0:s:m:language:${strk}`);
      }
    }
  }

  // 3. Video Filters: Resize + Subtitle Burn
  const resize = operations.resize;
  const isResizeEnabled = resize && (resize.enabled !== false) && (resize.width != null || resize.height != null || resize.preset);
  const videoFilters = [];

  if (!isAudioOnly && isResizeEnabled) {
    const rawW = parseInt(resize.width, 10);
    const rawH = parseInt(resize.height, 10);
    const toEven = (v) => (v > 0 ? Math.max(2, v % 2 === 0 ? v : v - 1) : null);
    const w = toEven(rawW);
    const h = toEven(rawH);
    if (w && h) {
      videoFilters.push(`scale=${w}:${h}`);
    } else if (w) {
      videoFilters.push(`scale=${w}:-2`);
    } else if (h) {
      videoFilters.push(`scale=-2:${h}`);
    } else {
      videoFilters.push('scale=1280:720');
    }
  }

  if (isBurnSubtitles) {
    const burnIdx = (typeof subtitleConfig.burnIndex === 'number') ? subtitleConfig.burnIndex : 0;
    const escapedSubPath = escapeFilterPath(inputPath);
    videoFilters.push(`subtitles='${escapedSubPath}':si=${burnIdx}`);
  }

  if (videoFilters.length > 0) {
    args.push('-vf', videoFilters.join(','));
  }

  // 5. Codecs (trim args already placed before -i for fast seeking)
  const hasVideoFilters = videoFilters.length > 0;
  const hasFilters = hasVideoFilters || isTrimEnabled;
  const crf = (resize && resize.crf) ? String(resize.crf) : '23';

  if (isAudioOnly) {
    if (targetFormat === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-q:a', '2');
    } else if (targetFormat === 'wav') {
      args.push('-c:a', 'pcm_s16le');
    } else if (targetFormat === 'aac' || targetFormat === 'm4a' || targetFormat === 'mp4' || targetFormat === 'mkv') {
      // Audio-only output into a video container (e.g. MP4/MKV) must use AAC;
      // the previous fallback emitted an MP3 stream that these muxers reject.
      args.push('-c:a', 'aac', '-b:a', '192k');
    } else if (targetFormat === 'flac') {
      args.push('-c:a', 'flac');
    } else if (targetFormat === 'ogg') {
      args.push('-c:a', 'libvorbis', '-q:a', '4');
    } else if (targetFormat === 'opus') {
      args.push('-c:a', 'libopus', '-b:a', '192k');
    } else {
      args.push('-c:a', 'libmp3lame');
    }
  } else {
    // Subtitle codec configuration for soft subtitles
    if (!isBurnSubtitles && subtitleConfig && Array.isArray(subtitleConfig.tracks) && subtitleConfig.tracks.length > 0) {
      if (targetFormat === 'mp4') {
        args.push('-c:s', 'mov_text');
      } else {
        args.push('-c:s', 'copy');
      }
    }

    const audioCopyArgs = muteAudio ? [] : ['-c:a', 'copy'];

    if (isLossless && !hasVideoFilters) {
      // True Lossless Container Change (direct stream copy) — works with trim too
      args.push('-c:v', 'copy', ...audioCopyArgs);
      if (targetFormat === 'mp4') args.push('-movflags', '+faststart');
    } else {
      // Video re-encoding (Hardware Acceleration vs Software libx264)
      const videoCodecArgs = isHwAccel
        ? ['-c:v', 'h264_mediacodec', '-b:v', targetBitrate]
        : ['-c:v', 'libx264', '-crf', crf, '-preset', 'fast'];

      if (isLossless && hasFilters) {
        // Filters require video re-encoding fallback, but maintain lossless audio copy
        args.push(...videoCodecArgs, ...audioCopyArgs);
        if (targetFormat === 'mp4') args.push('-movflags', '+faststart');
      } else if (targetFormat === 'webm') {
        args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
        if (!muteAudio) args.push('-c:a', 'libopus');
      } else if (targetFormat === 'avi') {
        args.push('-c:v', 'mpeg4', '-q:v', '4');
        if (!muteAudio) args.push('-c:a', 'mp3');
      } else if (targetFormat === 'mkv') {
        args.push(...videoCodecArgs);
        if (!muteAudio) args.push('-c:a', 'aac');
      } else {
        args.push(...videoCodecArgs);
        if (!muteAudio) args.push('-c:a', 'aac', '-b:a', '192k');
        if (targetFormat === 'mp4') args.push('-movflags', '+faststart');
      }
    }
  }

  // 6. Overwrite output directly
  args.push('-y', outputPath);
  return args;
}

// Build FFmpeg arguments for operations
function buildFfmpegArgs(operation, options, inputPaths, outputPath, primaryDuration) {
  const args = ['-hide_banner', '-stats'];
  const primaryInput = inputPaths[0];

  switch (operation) {
    case 'convert': {
      const fmt = (options.format || 'mp4').toLowerCase();
      const videoMode = options.videoMode || 'original'; // 'original' (lossless stream copy) or 'reencode'
      args.push('-i', primaryInput);
      if (fmt === 'mp4') {
        if (videoMode === 'original' || videoMode === 'copy') {
          // Remux MKV/other container to MP4 with 100% original video quality!
          args.push('-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart');
        } else {
          args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
        }
      } else if (fmt === 'webm') {
        args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k');
      } else if (fmt === 'mkv') {
        if (videoMode === 'original' || videoMode === 'copy') {
          args.push('-c:v', 'copy', '-c:a', 'copy');
        } else {
          args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-c:a', 'aac');
        }
      } else if (fmt === 'avi') {
        args.push('-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'mp3');
      } else if (fmt === 'gif') {
        args.push('-vf', 'fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse');
      }
      break;
    }

    case 'change_audio': {
      const audioCodec = (options.audioCodec || 'aac').toLowerCase();
      const audioBitrate = options.audioBitrate || '192k';
      const volume = parseFloat(options.volume) || 1.0;
      args.push('-i', primaryInput, '-c:v', 'copy');

      if (audioCodec === 'none' || audioCodec === 'mute') {
        args.push('-an');
      } else {
        if (volume !== 1.0) {
          args.push('-af', `volume=${volume}`);
        }
        if (audioCodec === 'aac') {
          args.push('-c:a', 'aac', '-b:a', audioBitrate);
        } else if (audioCodec === 'mp3') {
          args.push('-c:a', 'libmp3lame', '-b:a', audioBitrate);
        } else if (audioCodec === 'ac3') {
          args.push('-c:a', 'ac3', '-b:a', audioBitrate);
        } else if (audioCodec === 'eac3') {
          args.push('-c:a', 'eac3', '-b:a', audioBitrate);
        } else if (audioCodec === 'opus') {
          args.push('-c:a', 'libopus', '-b:a', audioBitrate);
        } else if (audioCodec === 'flac') {
          args.push('-c:a', 'flac');
        } else {
          args.push('-c:a', 'aac', '-b:a', audioBitrate);
        }
      }
      break;
    }

    case 'extract_audio': {
      const audioFmt = (options.format || 'mp3').toLowerCase();
      args.push('-i', primaryInput, '-vn');
      if (audioFmt === 'mp3') {
        args.push('-c:a', 'libmp3lame', '-q:a', '2');
      } else if (audioFmt === 'aac' || audioFmt === 'm4a') {
        args.push('-c:a', 'aac', '-b:a', '192k');
      } else if (audioFmt === 'wav') {
        args.push('-c:a', 'pcm_s16le');
      } else if (audioFmt === 'flac') {
        args.push('-c:a', 'flac');
      } else if (audioFmt === 'ogg') {
        args.push('-c:a', 'libvorbis', '-q:a', '4');
      }
      break;
    }

    case 'compress': {
      const crf = String(options.crf || '26');
      const preset = options.preset || 'fast';
      const codec = options.codec || 'libx264';
      const audioBitrate = options.audioBitrate || '128k';
      args.push('-i', primaryInput, '-c:v', codec, '-crf', crf, '-preset', preset, '-c:a', 'aac', '-b:a', audioBitrate, '-movflags', '+faststart');
      break;
    }

    case 'trim': {
      const start = options.start || '0';
      const end = options.end;
      const duration = options.duration;
      const mode = options.mode || 'copy';

      if (start) {
        args.push('-ss', String(start));
      }
      if (end) {
        args.push('-to', String(end));
      } else if (duration) {
        args.push('-t', String(duration));
      }

      args.push('-i', primaryInput);
      if (mode === 'copy') {
        args.push('-c', 'copy');
      } else {
        args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'aac', '-movflags', '+faststart');
      }
      break;
    }

    case 'resize': {
      args.push('-i', primaryInput);
      let filter = '';
      const preset = options.preset || 'custom';
      const keepAspect = options.keepAspect !== false && options.keepAspect !== 'false';
      const w = parseInt(options.width, 10);
      const h = parseInt(options.height, 10);

      if (preset === '1080p') {
        filter = 'scale=1920:-2';
      } else if (preset === '720p') {
        filter = 'scale=1280:-2';
      } else if (preset === '480p') {
        filter = 'scale=854:-2';
      } else if (preset === '360p') {
        filter = 'scale=640:-2';
      } else {
        if (w && h && !keepAspect) {
          filter = `scale=${w}:${h}`;
        } else if (w) {
          filter = `scale=${w}:-2`;
        } else if (h) {
          filter = `scale=-2:${h}`;
        } else {
          filter = 'scale=1280:-2';
        }
      }
      args.push('-vf', filter, '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'copy', '-movflags', '+faststart');
      break;
    }

    case 'rotate': {
      args.push('-i', primaryInput);
      const action = options.action || 'cw90';
      const ROTATE_FILTERS = {
        cw90: 'transpose=1',
        '90_cw': 'transpose=1',
        ccw90: 'transpose=2',
        '90_ccw': 'transpose=2',
        '180': 'vflip,hflip',
        hflip: 'hflip',
        vflip: 'vflip'
      };
      const vf = ROTATE_FILTERS[action] || 'transpose=1';

      args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy', '-movflags', '+faststart');
      break;
    }

    case 'gif': {
      const fps = parseInt(options.fps, 10) || 15;
      const width = parseInt(options.width, 10) || 480;
      const start = options.start;
      const duration = options.duration;

      if (start) args.push('-ss', String(start));
      if (duration) args.push('-t', String(duration));
      args.push('-i', primaryInput);

      const filter = `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
      args.push('-vf', filter);
      break;
    }

    case 'speed': {
      const speed = parseFloat(options.speed) || 2.0;
      args.push('-i', primaryInput);
      const pts = (1.0 / speed).toFixed(4);

      let atempoFilter = '';
      if (speed <= 2.0 && speed >= 0.5) {
        atempoFilter = `atempo=${speed}`;
      } else if (speed > 2.0) {
        atempoFilter = `atempo=2.0,atempo=${(speed / 2.0).toFixed(2)}`;
      } else {
        atempoFilter = `atempo=0.5,atempo=${(speed / 0.5).toFixed(2)}`;
      }

      args.push('-filter_complex', `[0:v]setpts=${pts}*PTS[v];[0:a?]${atempoFilter}[a]`, '-map', '[v]', '-map', '[a?]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-movflags', '+faststart');
      break;
    }

    case 'raw': {
      const rawCmd = (options.rawCommand || '').trim();
      const rawTokens = parseCommandLine(rawCmd);
      const rawExecArgs = [];
      for (const tok of rawTokens) {
        if (tok === '{INPUT}' || tok === '$INPUT') {
          rawExecArgs.push(primaryInput);
        } else if (tok === '{OUTPUT}' || tok === '$OUTPUT') {
          // Output is appended at end
        } else {
          rawExecArgs.push(tok.split('{INPUT}').join(primaryInput));
        }
      }
      const cwd = primaryInput ? path.dirname(primaryInput) : process.cwd();
      validateCustomArgv(rawExecArgs, cwd);
      const detectedOut = detectOutputPathFromArgv(rawExecArgs, cwd);
      if (detectedOut) assertPathAllowed(detectedOut, 'Output file');
      args.push(...rawExecArgs);
      break;
    }

    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }

  // Overwrite output directly
  args.push('-y', outputPath);
  return args;
}

// SSE broadcaster
function notifyJobSubscribers(jobId, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  const targetJob = jobId ? jobs.get(jobId) : null;
  const targetSessionId = (targetJob && targetJob.sessionId) || (payload.activeJob && payload.activeJob.sessionId);

  // 1. Job-specific subscribers
  if (jobId && sseSubscribers.has(jobId)) {
    for (const client of sseSubscribers.get(jobId)) {
      try {
        client.write(data);
      } catch (e) {
        if (jobId && sseSubscribers.has(jobId)) {
          sseSubscribers.get(jobId).delete(client);
        }
      }
    }
  }

  // 2. Global SSE subscribers
  for (const client of globalSseClients) {
    if (jobId && sseSubscribers.has(jobId) && sseSubscribers.get(jobId).has(client)) {
      continue;
    }
    // If client is bound to a different session, don't leak private job details
    if (client.clientSessionId && targetSessionId && client.clientSessionId !== targetSessionId) {
      if (payload.type === 'status') {
        try {
          client.write(`data: ${JSON.stringify({ type: 'server_status', isServerBusy: payload.status === 'processing' })}\n\n`);
        } catch (e) {
          globalSseClients.delete(client);
        }
      }
      continue;
    }

    try {
      client.write(data);
    } catch (e) {
      globalSseClients.delete(client);
    }
  }

  // Gracefully close job-specific SSE subscribers when the job finishes
  if (jobId && sseSubscribers.has(jobId) && payload.type === 'status' && ['completed', 'failed', 'cancelled'].includes(payload.status)) {
    const jobSubs = Array.from(sseSubscribers.get(jobId));
    const sseCloseTimer = setTimeout(() => {
      for (const client of jobSubs) {
        try { client.end(); } catch (e) {}
      }
      sseSubscribers.delete(jobId);
    }, 500);
    if (sseCloseTimer && sseCloseTimer.unref) {
      sseCloseTimer.unref();
    }
  }
}

// Heartbeat for SSE clients
const sseHeartbeatTimer = setInterval(() => {
  for (const client of globalSseClients) {
    try {
      client.write(': keepalive\n\n');
    } catch (e) {
      // Dead socket: remove it from BOTH the global set and every per-job
      // subscriber set, otherwise it would be retained forever.
      globalSseClients.delete(client);
      for (const subs of sseSubscribers.values()) {
        subs.delete(client);
      }
    }
  }
}, 15000);
if (sseHeartbeatTimer && sseHeartbeatTimer.unref) {
  sseHeartbeatTimer.unref();
}

// Periodic cleanup: prune old completed/failed jobs from memory (keep last 50)
const jobPruneTimer = setInterval(() => {
  if (jobs.size > 50) {
    const allJobs = Array.from(jobs.entries())
      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    // Keep only the 50 most recent jobs
    const toRemove = allJobs.slice(50);
    for (const [id, job] of toRemove) {
      if (job.status !== 'processing') {
        jobs.delete(id);
        sseSubscribers.delete(id);
      }
    }
  }
}, 300000); // Every 5 minutes
if (jobPruneTimer && jobPruneTimer.unref) {
  jobPruneTimer.unref();
}

// Helper to extract relevant error line from raw FFmpeg stderr output
function extractFfmpegError(stderr) {
  if (!stderr) return null;
  const lines = stderr.trim().split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/error|invalid|at least one output|failed|cannot|unrecognized|not supported|no such/i.test(line)) {
      return line;
    }
  }
  return lines[lines.length - 1] || null;
}

// Execute FFmpeg Job directly (wrapped with on-demand Termux wake-lock)
function executeJob(job, isRetry = false) {
  if (isRetry) {
    return _executeJobInternal(job);
  }
  return wakeLockManager.withWakeLock(`FFmpeg: ${job.name || job.id}`, () => {
    return _executeJobInternal(job);
  });
}

function appendJobLogSafe(job, text) {
  if (!job || !text) return;
  try {
    if (job.id && jobManager.getJob(job.id)) {
      jobManager.appendLog(job.id, text);
      return;
    }
  } catch (e) {}
  if (!Array.isArray(job.logs)) job.logs = [];
  job.logs.push(text);
  if (job.logs.length > 300) job.logs.shift();
}

function _executeJobInternal(job) {
  return new Promise((resolve, reject) => {
    job.status = 'processing';
    job.startedAt = Date.now();
    job._settled = false;
    job.timedOut = false;

    const isPrimaryActiveJob = () => !activeJob.jobId || activeJob.jobId === job.id || activeProcesses.size <= 1;
    if (!activeJob.jobId || activeJob.status !== 'processing' || activeJob.jobId === job.id) {
      syncActiveJobFromJob(job);
    }

    notifyJobSubscribers(job.id, {
      type: 'status',
      status: 'processing',
      jobId: job.id,
      progress: (job.progress && typeof job.progress.percent === 'number') ? job.progress.percent : 0,
      activeJob: activeJob.jobId === job.id ? activeJob : formatJobForClient(job)
    });

    let ffmpegProc;
    const workingDir = (job.inputPaths && job.inputPaths[0] && fs.existsSync(job.inputPaths[0]))
      ? path.dirname(job.inputPaths[0])
      : process.cwd();

    const executable = job.executable || 'ffmpeg';
    const execArgs = Array.isArray(job.execArgs)
      ? job.execArgs
      : (Array.isArray(job.ffmpegArgs) ? job.ffmpegArgs : []);
    const jobWorkingDir = job.workingDir || workingDir;
    const displayCommand = job.commandString || buildSafeFfmpegCommand(execArgs, job.inputPaths?.[0], job.outputPath, executable);

    console.log(`[FFmpeg Execution] Spawning ${executable} (shell: false): ${displayCommand}`);

    // Inactivity watchdog: reclaim a hung FFmpeg that stops producing output.
    let inactivityTimer = null;
    const clearWatchdog = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
    };
    const armWatchdog = () => {
      clearWatchdog();
      inactivityTimer = setTimeout(() => {
        if (job._settled || job.status !== 'processing') return;
        if (ffmpegProc && !ffmpegProc.killed) {
          job.timedOut = true;
          console.warn(`[FFmpeg Watchdog] Job ${job.id} produced no output for ${Math.round(JOB_INACTIVITY_TIMEOUT_MS / 60000)} min — killing it.`);
          try { ffmpegProc.kill('SIGKILL'); } catch (e) {}
        }
      }, JOB_INACTIVITY_TIMEOUT_MS);
    };

    try {
      ffmpegProc = spawn(executable, execArgs, {
        shell: false,
        cwd: jobWorkingDir
      });
    } catch (spawnErr) {
      // spawn() can throw synchronously (e.g. bad cwd / args). Without this
      // guard activeJob would stay stuck in 'processing' forever and block
      // every subsequent request.
      job._settled = true;
      job.status = 'failed';
      job.error = spawnErr.message;
      job.completedAt = Date.now();
      if (activeJob.jobId === job.id || isPrimaryActiveJob()) {
        activeJob.status = 'failed';
        activeJob.error = spawnErr.message;
        activeJob.filePath = '';
        activeJob.outputPath = '';
        scheduleActiveJobReset(job.id);
      }
      if (concurrencyLock && concurrencyLock.removeFile) {
        concurrencyLock.removeFile(job.filePath);
        concurrencyLock.removeFile(job.outputPath);
      }
      cleanupTempUploadsOnError(job.filePath, ...(job.inputPaths || []));
      notifyJobSubscribers(job.id, {
        type: 'status',
        status: 'failed',
        jobId: job.id,
        error: spawnErr.message,
        activeJob: activeJob.jobId === job.id ? activeJob : formatJobForClient(job)
      });
      return reject(spawnErr);
    }

    setProcessActive(job.id, ffmpegProc);
    if (queueManager && typeof queueManager.attachProcess === 'function') {
      queueManager.attachProcess(job.id, ffmpegProc);
    }
    armWatchdog();
    let rawStderr = '';
    let stderrBuffer = '';

    // Capture stdout for commands like ffprobe
    if (ffmpegProc.stdout) {
      ffmpegProc.stdout.on('data', (chunk) => {
        armWatchdog();
        const text = chunk.toString();
        rawStderr += text;
        appendJobLogSafe(job, text);
      });
    }

    // Listen to stderr for FFmpeg progress (time=HH:MM:SS.xx and speed=x)
    ffmpegProc.stderr.on('data', (chunk) => {
      armWatchdog();
      const text = chunk.toString();
      rawStderr += text;
      stderrBuffer += text;

      appendJobLogSafe(job, text);

      const jobDurationSec = job.totalDurationSec || job.expectedDuration || 0;
      // 1. Fallback: Parse total duration from FFmpeg initial stderr if ffprobe failed or returned 0
      if (!jobDurationSec || jobDurationSec <= 0) {
        const durMatch = stderrBuffer.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/i);
        if (durMatch && durMatch[1]) {
          const durSec = parseTimeToSeconds(durMatch[1]);
          if (durSec > 0) {
            job.expectedDuration = durSec;
            job.totalDurationSec = durSec;
            job.totalDuration = formatTime(durSec);
            if (activeJob.jobId === job.id) {
              activeJob.totalDurationSec = durSec;
              activeJob.totalDuration = job.totalDuration;
            }
            console.log(`[FFmpeg Fallback] Duration parsed from stderr: ${job.totalDuration} (${durSec}s)`);
          }
        }
      }

      // 2. Extract time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?) and speed=(\s*[\d\.]+x|N/A)
      const timeMatches = [...stderrBuffer.matchAll(/time=\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
      const speedMatches = [...stderrBuffer.matchAll(/speed=\s*(\d+(?:\.\d+)?x|N\/A)/gi)];

      if (timeMatches.length > 0) {
        const lastTime = timeMatches[timeMatches.length - 1][1];
        const curSec = parseTimeToSeconds(lastTime);
        const formattedCurTime = formatTime(curSec);

        let curSpeed = job.speed || 'N/A';
        if (speedMatches.length > 0) {
          curSpeed = speedMatches[speedMatches.length - 1][1].trim();
        }

        const effectiveDuration = job.totalDurationSec || job.expectedDuration || 0;
        let progressPercent = 0;
        if (effectiveDuration > 0) {
          progressPercent = Math.min(99, Math.max(0, Math.round((curSec / effectiveDuration) * 100)));
        }

        job.currentTime = formattedCurTime;
        job.speed = curSpeed;
        if (!job.progress || typeof job.progress !== 'object') {
          job.progress = { percent: progressPercent, time: formattedCurTime, speed: curSpeed };
        } else {
          job.progress.time = formattedCurTime;
          job.progress.speed = curSpeed;
          job.progress.percent = progressPercent;
        }

        if (activeJob.jobId === job.id) {
          activeJob.currentTime = formattedCurTime;
          activeJob.speed = curSpeed;
          activeJob.progress = progressPercent;
        }

        const totDurStr = job.totalDuration || formatTime(effectiveDuration);
        console.log(`[FFmpeg Progress] Job ${job.id}: ${progressPercent}% | Time: ${formattedCurTime} / ${totDurStr} | Speed: ${curSpeed}`);

        notifyJobSubscribers(job.id, {
          type: 'progress',
          jobId: job.id,
          progress: progressPercent,
          currentTime: formattedCurTime,
          totalDuration: totDurStr,
          speed: curSpeed,
          activeJob: {
            status: job.status,
            filePath: job.filePath,
            filename: job.filename,
            progress: progressPercent,
            currentTime: formattedCurTime,
            totalDuration: totDurStr,
            speed: curSpeed,
            outputPath: job.outputPath
          }
        });
      }

      if (stderrBuffer.length > 4000) {
        stderrBuffer = stderrBuffer.slice(-2000);
      }
      if (rawStderr.length > 200000) {
        rawStderr = rawStderr.slice(-100000);
      }
    });

    ffmpegProc.on('error', (err) => {
      if (job._settled) return;
      job._settled = true;
      clearWatchdog();
      clearProcessActive(job.id);
      if (queueManager && typeof queueManager.detachProcess === 'function') {
        queueManager.detachProcess(job.id);
      }
      if (job.status === 'cancelled' || (activeJob.jobId === job.id && activeJob.status === 'cancelled')) {
        if (activeJob.jobId === job.id) {
          activeJob.filePath = '';
          activeJob.outputPath = '';
        }
        if (concurrencyLock && concurrencyLock.removeFile) {
          concurrencyLock.removeFile(job.filePath);
          concurrencyLock.removeFile(job.outputPath);
        }
        resolve(job);
        return;
      }

      // Clean up partial output file if present
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        try { fs.unlinkSync(job.outputPath); } catch (e) {}
      }
      cleanupTempUploadsOnError(job.filePath, ...(job.inputPaths || []));

      job.status = 'failed';
      job.error = err.message;
      job.completedAt = Date.now();

      if (activeJob.jobId === job.id || isPrimaryActiveJob()) {
        activeJob.status = 'failed';
        activeJob.error = err.message;
        activeJob.filePath = '';
        activeJob.outputPath = '';
        scheduleActiveJobReset(job.id);
      }
      if (concurrencyLock && concurrencyLock.removeFile) {
        concurrencyLock.removeFile(job.filePath);
        concurrencyLock.removeFile(job.outputPath);
      }

      notifyJobSubscribers(job.id, {
        type: 'status',
        status: 'failed',
        jobId: job.id,
        isDirectPath: true,
        error: err.message,
        activeJob: activeJob.jobId === job.id ? activeJob : formatJobForClient(job),
        stderr: rawStderr
      });
      reject(err);
    });

    ffmpegProc.on('close', async (code) => {
      if (job._settled) return;
      clearWatchdog();
      clearProcessActive(job.id);
      if (queueManager && typeof queueManager.detachProcess === 'function') {
        queueManager.detachProcess(job.id);
      }
      if (job.status === 'cancelled' || (activeJob.jobId === job.id && activeJob.status === 'cancelled')) {
        job._settled = true;
        if (activeJob.jobId === job.id) {
          activeJob.filePath = '';
          activeJob.outputPath = '';
        }
        if (concurrencyLock && concurrencyLock.removeFile) {
          concurrencyLock.removeFile(job.filePath);
          concurrencyLock.removeFile(job.outputPath);
        }
        resolve(job);
        return;
      }

      try {
        job.completedAt = Date.now();
        job.durationMs = job.completedAt - job.startedAt;

        // Check if candidate output file exists
        let resolvedOutput = job.outputPath;
        if (!resolvedOutput || !fs.existsSync(resolvedOutput)) {
          if (job.isCustom && Array.isArray(job.execArgs)) {
            const detected = detectOutputPathFromArgv(job.execArgs, job.workingDir || workingDir);
            if (detected && isPathAllowed(detected) && fs.existsSync(detected)) {
              resolvedOutput = detected;
              job.outputPath = detected;
              if (activeJob.jobId === job.id) activeJob.outputPath = detected;
            }
          }
        }

        const fileExists = Boolean(resolvedOutput && fs.existsSync(resolvedOutput));

        if (code === 0 && (fileExists || (job.isCustom && !job.outputPath))) {
          if (fileExists) {
            const stat = fs.statSync(resolvedOutput);
            const meta = await probeMedia(resolvedOutput).catch(() => null);

            job.outputFile = {
              filename: path.basename(resolvedOutput),
              path: resolvedOutput,
              isDirectPath: true,
              size: stat.size,
              sizeFormatted: formatBytes(stat.size),
              previewUrl: `/api/stream-file?path=${encodeURIComponent(resolvedOutput)}`,
              downloadUrl: buildOutputDownloadUrl(resolvedOutput),
              metadata: meta,
              expiresAt: Date.now() + (30 * 60 * 1000)
            };
          }

          job.status = 'completed';
          if (!job.progress || typeof job.progress !== 'object') job.progress = {};
          job.progress.percent = 100;

          if (activeJob.jobId === job.id || isPrimaryActiveJob()) {
            activeJob.status = 'completed';
            activeJob.progress = 100;
            activeJob.currentTime = activeJob.totalDuration;
            if (job.outputFile) activeJob.outputFile = job.outputFile;
            activeJob.filePath = '';
            activeJob.outputPath = '';
            scheduleActiveJobReset(job.id);
          }

          if (concurrencyLock && concurrencyLock.removeFile) {
            concurrencyLock.removeFile(job.filePath);
            concurrencyLock.removeFile(job.outputPath);
            if (Array.isArray(job.inputPaths)) {
              for (const p of job.inputPaths) concurrencyLock.removeFile(p);
            }
          }

          const clientPayload = activeJob.jobId === job.id ? activeJob : formatJobForClient(job);
          notifyJobSubscribers(job.id, {
            type: 'status',
            status: 'completed',
            jobId: job.id,
            isDirectPath: true,
            progress: 100,
            currentTime: clientPayload.totalDuration,
            totalDuration: clientPayload.totalDuration,
            speed: clientPayload.speed,
            activeJob: clientPayload,
            outputFile: job.outputFile
          });
          job._settled = true;
          resolve(job);
        } else {
          const isHwAccelError = Boolean(job.options && (job.options.hardwareAccel || job.options.fastMode)) &&
            (rawStderr.includes('h264_mediacodec') || rawStderr.includes('MediaCodec') || rawStderr.includes('Operation not permitted') || rawStderr.includes('Device does not support'));

          if (isHwAccelError && !job.hasFallenBackToSoftware) {
            console.warn('[HW Accel Fallback] Hardware encoder failed, falling back to software encoding (libx264)...');
            job.hasFallenBackToSoftware = true;
            job.options.hardwareAccel = false;
            job.options.fastMode = false;

            notifyJobSubscribers(job.id, {
              type: 'status',
              status: 'warning',
              message: 'Hardware acceleration not supported on this device, falling back to software encoding.',
              jobId: job.id
            });

            // Rebuild args using software libx264
            const resolvedPath = job.inputPaths[0];
            const fallbackArgs = buildDynamicFfmpegArgs({
              inputPath: resolvedPath,
              operations: { ...job.options, hardwareAccel: false, fastMode: false },
              audioTracks: job.options.audioTracks || [],
              subtitleConfig: job.options.subtitleConfig || {},
              outputPath: job.outputPath,
              mediaInfo: job.meta || {},
              isLosslessCopy: false
            });
            job.executable = 'ffmpeg';
            job.execArgs = fallbackArgs;
            job.commandString = buildSafeFfmpegCommand(fallbackArgs, resolvedPath, job.outputPath, 'ffmpeg');
            if (activeJob.jobId === job.id) {
              activeJob.commandString = job.commandString;
            }

            return executeJob(job, true).then(resolve).catch(reject);
          }

          job._settled = true;
          job.status = 'failed';
          job.stderr = rawStderr.slice(-4000);

          // Clean up partial output file on error/failure
          if (job.outputPath && fs.existsSync(job.outputPath)) {
            try {
              fs.unlinkSync(job.outputPath);
              console.log(`[FFmpeg Execution] Cleaned up partial output file after failure: ${job.outputPath}`);
            } catch (unlinkErr) {
              console.warn(`[FFmpeg Execution] Could not remove partial output file ${job.outputPath}:`, unlinkErr.message);
            }
          }
          cleanupTempUploadsOnError(job.filePath, ...(job.inputPaths || []));

          const isDirectCopy = (job.commandString && job.commandString.includes('-c:v copy')) ||
                               Boolean(job.options?.isLosslessCopy || (job.options?.operations && job.options?.operations?.isLosslessCopy));

          if (job.timedOut) {
            job.error = `Command produced no output for ${Math.round(JOB_INACTIVITY_TIMEOUT_MS / 60000)} minutes and was stopped. It may be waiting for input or stuck.`;
          } else if (job.isCustom) {
            const extractedErr = extractFfmpegError(rawStderr);
            job.error = extractedErr || `Custom command failed with exit code ${code}`;
          } else if (isDirectCopy) {
            job.error = 'Direct copy failed. The source file has codecs not supported by MP4. Please try Re-encoding.';
          } else {
            job.error = `FFmpeg exited with error code ${code}`;
          }

          if (activeJob.jobId === job.id || isPrimaryActiveJob()) {
            activeJob.status = 'failed';
            activeJob.error = job.error;
            activeJob.filePath = '';
            activeJob.outputPath = '';
            scheduleActiveJobReset(job.id);
          }
          if (concurrencyLock && concurrencyLock.removeFile) {
            concurrencyLock.removeFile(job.filePath);
            concurrencyLock.removeFile(job.outputPath);
            if (Array.isArray(job.inputPaths)) {
              for (const p of job.inputPaths) concurrencyLock.removeFile(p);
            }
          }

          notifyJobSubscribers(job.id, {
            type: 'status',
            status: 'failed',
            jobId: job.id,
            isDirectPath: true,
            error: job.error,
            activeJob: activeJob.jobId === job.id ? activeJob : formatJobForClient(job),
            stderr: job.stderr
          });
          reject(new Error(job.error));
        }
      } catch (closeErr) {
        job._settled = true;
        job.status = 'failed';
        job.error = closeErr.message;
        if (activeJob.jobId === job.id || isPrimaryActiveJob()) {
          activeJob.status = 'failed';
          activeJob.error = closeErr.message;
          activeJob.filePath = '';
          activeJob.outputPath = '';
          scheduleActiveJobReset(job.id);
        }
        if (concurrencyLock && concurrencyLock.removeFile) {
          concurrencyLock.removeFile(job.filePath);
          concurrencyLock.removeFile(job.outputPath);
        }
        reject(closeErr);
      }
    });
  });
}

// ======================== API ROUTES ========================

// PDF & Document Studio API (isolated from FFmpeg routes)
app.use('/api/pdf', createPdfRouter({
  assertPathAllowed,
  formatBytes,
  createHttpError,
  concurrencyLock,
  TEMP_UPLOADS_DIR,
  PROCESSED_DIR,
  cleanupTempUploadsOnError,
  wakeLockManager,
  recordAnalyticsEvent: (evt) => analyticsService.recordEvent(evt)
}));

// ======================== IMAGE STUDIO API (sharp) ========================
// Decoding and encoding happen locally through sharp. Every source, output and
// temporary path is still validated against the same storage allowlist.

const IMAGE_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
};

const IMAGE_OUTPUT_FORMATS = {
  jpeg: { format: 'jpeg', ext: '.jpg', label: 'JPG' },
  png: { format: 'png', ext: '.png', label: 'PNG' },
  webp: { format: 'webp', ext: '.webp', label: 'WebP' },
  avif: { format: 'avif', ext: '.avif', label: 'AVIF' },
  tiff: { format: 'tiff', ext: '.tiff', label: 'TIFF' }
};

const IMAGE_MAX_BATCH = 30;
const IMAGE_MAX_INSPECT = 60;
const IMAGE_MAX_PIXELS = 120 * 1000 * 1000;
const IMAGE_MAX_TARGET_BYTES = 2 * 1024 * 1024 * 1024;
const IMAGE_MAX_DIMENSION = 20000;
const IMAGE_TARGET_ATTEMPTS = 7;
const IMAGE_TARGET_TOLERANCE = 0.02;
const IMAGE_TEMP_PREFIX = '.imagestudio_';

function imageFormatFromExt(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  if (ext === '.avif') return 'avif';
  if (ext === '.tif' || ext === '.tiff') return 'tiff';
  return null;
}

function normalizeImageOutputFormat(value) {
  const raw = String(value || '').trim().toLowerCase();
  const key = raw === 'jpg' ? 'jpeg' : raw;
  return IMAGE_OUTPUT_FORMATS[key] || null;
}

function parseTargetSizeInput(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.round(value) : null;
  }
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return null;
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 * 1024,
    mib: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    gib: 1024 * 1024 * 1024
  };
  return Math.round(amount * multipliers[unit]);
}

function clampImageInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function parseBooleanFlag(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

function safeImageStem(value) {
  const raw = String(value || 'image');
  const base = path.basename(raw, path.extname(raw));
  const cleaned = base
    .replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 100);
  return cleaned || 'image';
}

function ensureImageOutputDir(rawDir, fallbackDir) {
  const chosen = rawDir && String(rawDir).trim() ? String(rawDir).trim() : fallbackDir;
  const resolved = assertPathAllowed(chosen, 'Output folder');
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) {
      throw createHttpError(400, `Output path is not a folder: ${resolved}`);
    }
    return resolved;
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function uniqueImageOutputPath(dir, stem, ext) {
  let candidate = path.join(dir, `${safeImageStem(stem)}${ext}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${safeImageStem(stem)}_${counter}${ext}`);
    counter++;
  }
  return assertPathAllowed(candidate, 'Output file');
}

function createImageTempPath(dir) {
  const candidate = path.join(
    dir,
    `${IMAGE_TEMP_PREFIX}${Date.now()}_${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  return assertPathAllowed(candidate, 'Temporary image file');
}

function removeImageFileQuietly(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (err) {}
}

function friendlyImageError(err, label) {
  const prefix = label ? `${label}: ` : '';
  const message = String((err && err.message) || '').replace(/\s+/g, ' ').trim();
  if (err && err.status) return message || `${prefix}Request failed.`;
  if (!message) return `${prefix}Unknown image error.`;
  if (/unsupported image format|Input file contains unsupported|not a known file format|VipsForeignLoad|load_buffer/i.test(message)) {
    return `${prefix}This file is not a supported or valid image.`;
  }
  if (/corrupt|premature end|unexpected end|truncated/i.test(message)) {
    return `${prefix}The image appears to be corrupted.`;
  }
  if (/pixel limit|too large|exceeds.*pixels/i.test(message)) {
    return `${prefix}The image is too large to process safely.`;
  }
  if (/out of memory|Cannot allocate|ENOMEM/i.test(message)) {
    return `${prefix}There was not enough memory to process this image.`;
  }
  if (/ENOENT|no such file/i.test(message)) {
    return `${prefix}The image was not found.`;
  }
  if (/EACCES|permission denied/i.test(message)) {
    return `${prefix}Storage permission denied.`;
  }
  return `${prefix}${message}`;
}

function imageFileUrls(filePath) {
  const resolved = path.resolve(String(filePath));
  const encoded = encodeURIComponent(resolved);
  const filename = path.basename(resolved);
  const parent = path.dirname(resolved);
  const isDirectInRoot = parent === path.resolve(PROCESSED_DIR) || parent === path.resolve(TEMP_UPLOADS_DIR);
  return {
    previewUrl: `/api/image/preview?path=${encoded}`,
    downloadUrl: isDirectInRoot ? `/api/download/${encodeURIComponent(filename)}` : `/api/image/preview?path=${encoded}&download=1`
  };
}

function orientedImageDimensions(meta) {
  if (!meta) return { width: 0, height: 0 };
  if (meta.autoOrient && meta.autoOrient.width && meta.autoOrient.height) {
    return {
      width: Math.round(meta.autoOrient.width),
      height: Math.round(meta.autoOrient.height)
    };
  }
  const orientation = Number(meta.orientation) || 1;
  const swapped = orientation >= 5 && orientation <= 8;
  return {
    width: Math.round(swapped ? meta.height : meta.width) || 0,
    height: Math.round(swapped ? meta.width : meta.height) || 0
  };
}

async function readImageMetadata(filePath) {
  const meta = await sharp(filePath, {
    failOn: 'error',
    limitInputPixels: IMAGE_MAX_PIXELS,
    sequentialRead: true
  }).metadata();
  return { meta, ...orientedImageDimensions(meta) };
}

function buildImagePipeline(inputPath, options) {
  const opts = options || {};
  let pipeline = sharp(inputPath, {
    failOn: 'error',
    limitInputPixels: IMAGE_MAX_PIXELS,
    sequentialRead: true
  }).rotate();

  if (opts.resize && (opts.resize.width || opts.resize.height)) {
    pipeline = pipeline.resize({
      width: opts.resize.width || undefined,
      height: opts.resize.height || undefined,
      fit: opts.resize.fit || 'inside',
      position: 'centre',
      withoutEnlargement: opts.resize.withoutEnlargement !== false
    });
  }

  if (opts.outputFormat === 'jpeg') {
    pipeline = pipeline.flatten({ background: '#ffffff' });
  }

  if (!opts.stripMetadata) {
    pipeline = pipeline.withMetadata({ orientation: 1 });
  }

  return pipeline;
}

function applyImageEncoder(pipeline, outputFormat, options) {
  const opts = options || {};
  const quality = clampImageInt(opts.quality, 1, 100, 85);

  switch (outputFormat) {
    case 'jpeg':
      return pipeline.jpeg({
        quality,
        mozjpeg: true,
        progressive: true,
        chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0'
      });
    case 'webp':
      return pipeline.webp({
        quality,
        effort: 4,
        smartSubsample: quality >= 90
      });
    case 'avif':
      return pipeline.avif({
        quality,
        effort: 1,
        chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0'
      });
    case 'png':
      if (opts.palette) {
        return pipeline.png({ compressionLevel: 9, palette: true, quality, effort: 4 });
      }
      return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    case 'tiff':
      if (opts.lossy) {
        return pipeline.tiff({ compression: 'jpeg', quality, predictor: 'horizontal' });
      }
      return pipeline.tiff({ compression: 'deflate', predictor: 'horizontal' });
    default:
      throw createHttpError(400, `Unsupported output format: ${outputFormat}`);
  }
}

async function encodeImageCandidate(params) {
  const pipeline = buildImagePipeline(params.inputPath, {
    resize: params.resize,
    stripMetadata: params.stripMetadata,
    outputFormat: params.outputFormat
  });
  applyImageEncoder(pipeline, params.outputFormat, {
    quality: params.quality,
    palette: params.palette,
    lossy: params.lossy
  });
  await pipeline.toFile(params.tempPath);
  return fs.statSync(params.tempPath).size;
}

// Target-size compression:
// 1. Binary-search quality (up to 5 encodes) for the highest quality that fits.
// 2. If the smallest quality is still too large, proportionally shrink the
//    dimensions (up to 2 more encodes) using the measured size as feedback.
// Total attempts never exceed IMAGE_TARGET_ATTEMPTS (7).
async function compressImageToTarget(params) {
  const targetBytes = Math.max(1, Math.floor(params.targetBytes));
  const acceptableBytes = Math.max(1, Math.ceil(targetBytes * (1 + IMAGE_TARGET_TOLERANCE)));
  const qualityBudget = Math.max(3, IMAGE_TARGET_ATTEMPTS - 2);
  const tempFiles = params.tempFiles;
  const outputFormat = params.outputFormat;
  const usePalette = outputFormat === 'png';
  const useLossyTiff = outputFormat === 'tiff';

  let attempts = 0;
  let best = null;
  let smallest = null;

  const encode = async (quality, resize) => {
    const tempPath = createImageTempPath(params.outputDir);
    tempFiles.add(tempPath);
    attempts++;
    try {
      const size = await encodeImageCandidate({
        inputPath: params.inputPath,
        tempPath,
        outputFormat,
        quality,
        resize,
        stripMetadata: params.stripMetadata,
        palette: usePalette,
        lossy: useLossyTiff
      });
      return {
        tempPath,
        size,
        quality,
        width: resize && resize.width ? resize.width : params.baseWidth,
        height: resize && resize.height ? resize.height : params.baseHeight
      };
    } catch (err) {
      removeImageFileQuietly(tempPath);
      tempFiles.delete(tempPath);
      throw err;
    }
  };

  const discard = (candidate) => {
    if (!candidate) return;
    removeImageFileQuietly(candidate.tempPath);
    tempFiles.delete(candidate.tempPath);
  };

  const keepBest = (candidate) => {
    if (best) discard(best);
    best = candidate;
  };

  let low = 1;
  let high = 100;
  while (low <= high && attempts < qualityBudget) {
    const quality = Math.floor((low + high) / 2);
    const candidate = await encode(quality, null);

    if (!smallest || candidate.size < smallest.size) {
      smallest = { size: candidate.size, quality, width: candidate.width, height: candidate.height };
    }

    if (candidate.size <= acceptableBytes) {
      keepBest(candidate);
      low = quality + 1;
    } else {
      discard(candidate);
      high = quality - 1;
    }
  }

  if (!best && smallest) {
    let currentWidth = params.baseWidth;
    let currentHeight = params.baseHeight;
    let currentSize = smallest.size;
    let previousSize = null;

    while (attempts < IMAGE_TARGET_ATTEMPTS) {
      const ratio = Math.sqrt(Math.max(1, targetBytes) / Math.max(1, currentSize));
      const factor = Math.max(0.08, Math.min(0.92, ratio * 0.92));
      const width = Math.max(1, Math.floor(currentWidth * factor));
      const height = Math.max(1, Math.floor(currentHeight * factor));
      if (previousSize !== null && width === currentWidth && height === currentHeight) break;

      const candidate = await encode(outputFormat === 'png' ? 80 : 72, {
        width,
        height,
        fit: 'inside',
        withoutEnlargement: true
      });

      if (!best || candidate.size < best.size) {
        keepBest(candidate);
      } else {
        discard(candidate);
      }

      if (candidate.size <= acceptableBytes) break;
      if (previousSize !== null && candidate.size >= previousSize) break;

      previousSize = candidate.size;
      currentWidth = width;
      currentHeight = height;
      currentSize = candidate.size;
      if (width <= 1 || height <= 1) break;
    }
  }

  if (!best) {
    throw createHttpError(500, 'Could not reach the requested size within the safe attempt limit.');
  }

  return {
    candidate: best,
    attempts,
    targetMet: best.size <= acceptableBytes
  };
}

function computeResizeSpec(resize, sourceWidth, sourceHeight) {
  if (resize.mode === 'percent') {
    const factor = resize.percent / 100;
    return {
      width: Math.max(1, Math.round(sourceWidth * factor)),
      height: Math.max(1, Math.round(sourceHeight * factor)),
      fit: 'inside',
      withoutEnlargement: true
    };
  }
  return {
    width: resize.width || null,
    height: resize.height || null,
    fit: 'inside',
    withoutEnlargement: true
  };
}

function normalizeImageRequest(body) {
  const payload = body || {};
  const operation = String(payload.operation || '').trim().toLowerCase();
  const allowedOperations = new Set(['convert', 'compress-percent', 'compress-target', 'resize']);
  if (!allowedOperations.has(operation)) {
    throw createHttpError(400, 'operation must be convert, compress-percent, compress-target, or resize.');
  }

  const format = normalizeImageOutputFormat(payload.format);
  if (operation === 'convert' && !format) {
    throw createHttpError(400, 'Choose an output format: JPG, PNG, WebP, or AVIF.');
  }

  const normalized = {
    operation,
    outputDir: String(payload.outputDir || '').trim(),
    format,
    stripMetadata: parseBooleanFlag(payload.stripMetadata, true),
    quality: clampImageInt(payload.quality, 1, 100, 85),
    percent: null,
    targetBytes: null,
    resize: null,
    resizeQuality: clampImageInt(payload.quality, 1, 100, 92)
  };

  if (operation === 'compress-percent') {
    const percent = Number(payload.percent);
    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      throw createHttpError(400, 'percent must be between 1 and 100.');
    }
    normalized.percent = percent;
  }

  if (operation === 'compress-target') {
    const targetBytes = parseTargetSizeInput(payload.targetSize);
    if (!targetBytes) {
      throw createHttpError(400, 'Enter a valid target size such as "500 KB" or "2 MB".');
    }
    if (targetBytes > IMAGE_MAX_TARGET_BYTES) {
      throw createHttpError(400, 'Target size is too large.');
    }
    normalized.targetBytes = targetBytes;
  }

  if (operation === 'resize') {
    const input = payload.resize || {};
    const mode = String(input.mode || 'percent').toLowerCase();
    if (mode === 'dimensions') {
      const parseDimension = (value, label) => {
        if (value === undefined || value === null || String(value).trim() === '') return null;
        const n = Number(value);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > IMAGE_MAX_DIMENSION) {
          throw createHttpError(400, `${label} must be a whole number between 1 and ${IMAGE_MAX_DIMENSION}.`);
        }
        return n;
      };
      const width = parseDimension(input.width, 'Width');
      const height = parseDimension(input.height, 'Height');
      if (!width && !height) {
        throw createHttpError(400, 'Enter a width, a height, or both.');
      }
      normalized.resize = { mode: 'dimensions', width, height };
    } else if (mode === 'percent') {
      const percent = Number(input.percent);
      if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
        throw createHttpError(400, 'Resize percentage must be between 1 and 100.');
      }
      normalized.resize = { mode: 'percent', percent };
    } else {
      throw createHttpError(400, 'Resize mode must be dimensions or percent.');
    }
  }

  return normalized;
}

async function processImageFile(inputPath, normalized) {
  const fileName = path.basename(inputPath);
  const sourceFormat = imageFormatFromExt(inputPath);
  if (!sourceFormat) {
    throw createHttpError(400, `${fileName} is not a supported image (JPG, PNG, WebP, AVIF, TIFF).`);
  }

  const sourceStat = fs.statSync(inputPath);
  const sourceMeta = await readImageMetadata(inputPath);
  const sourceWidth = sourceMeta.width;
  const sourceHeight = sourceMeta.height;
  const fallbackDir = (isPathWithinRoot(path.resolve(inputPath), path.resolve(TEMP_UPLOADS_DIR)) || normalized.isRemoteUpload)
    ? PROCESSED_DIR
    : path.dirname(inputPath);
  const outputDir = ensureImageOutputDir(normalized.outputDir, fallbackDir);
  const outputInfo = normalized.format || IMAGE_OUTPUT_FORMATS[sourceFormat];
  const tempFiles = new Set();
  let finalPath = null;

  try {
    let tempPath = null;
    let attempts = 1;
    let quality = null;
    let targetBytes = null;
    let targetMet = null;
    let note = '';
    let outputWidth = sourceWidth;
    let outputHeight = sourceHeight;
    let suffix = 'processed';

    if (normalized.operation === 'convert') {
      tempPath = createImageTempPath(outputDir);
      tempFiles.add(tempPath);
      quality = ['jpeg', 'webp', 'avif'].includes(outputInfo.format) ? normalized.quality : 100;
      await encodeImageCandidate({
        inputPath,
        tempPath,
        outputFormat: outputInfo.format,
        quality,
        resize: null,
        stripMetadata: normalized.stripMetadata
      });
      suffix = outputInfo.format === 'jpeg' ? 'jpg' : outputInfo.format;
      note = 'Format converted on-device.';
    } else if (normalized.operation === 'compress-percent') {
      targetBytes = Math.max(1, Math.floor(sourceStat.size * (normalized.percent / 100)));
      const effectiveTarget = Math.min(targetBytes, sourceStat.size);
      const outcome = await compressImageToTarget({
        inputPath,
        outputFormat: outputInfo.format,
        targetBytes: effectiveTarget,
        stripMetadata: normalized.stripMetadata,
        outputDir,
        originalSize: sourceStat.size,
        baseWidth: sourceWidth,
        baseHeight: sourceHeight,
        tempFiles
      });
      tempPath = outcome.candidate.tempPath;
      attempts = outcome.attempts;
      quality = outcome.candidate.quality;
      targetBytes = effectiveTarget;
      targetMet = outcome.targetMet;
      outputWidth = outcome.candidate.width;
      outputHeight = outcome.candidate.height;
      suffix = `${Math.round(normalized.percent)}pct`;
      note = targetMet
        ? `Reduced toward ${Math.round(normalized.percent)}% of the original size in ${attempts} attempt${attempts === 1 ? '' : 's'}.`
        : `Could not quite reach ${Math.round(normalized.percent)}%; the smallest result was kept after ${attempts} attempts.`;
    } else if (normalized.operation === 'compress-target') {
      const effectiveTarget = Math.min(normalized.targetBytes, sourceStat.size);
      const outcome = await compressImageToTarget({
        inputPath,
        outputFormat: outputInfo.format,
        targetBytes: effectiveTarget,
        stripMetadata: normalized.stripMetadata,
        outputDir,
        originalSize: sourceStat.size,
        baseWidth: sourceWidth,
        baseHeight: sourceHeight,
        tempFiles
      });
      tempPath = outcome.candidate.tempPath;
      attempts = outcome.attempts;
      quality = outcome.candidate.quality;
      targetBytes = effectiveTarget;
      targetMet = outcome.targetMet;
      outputWidth = outcome.candidate.width;
      outputHeight = outcome.candidate.height;
      suffix = 'target';
      note = targetMet
        ? `Target reached in ${attempts} attempt${attempts === 1 ? '' : 's'}.`
        : `Target was not reachable after ${attempts} attempts; the smallest result was kept.`;
      if (normalized.targetBytes >= sourceStat.size) {
        note += ' The requested target was larger than the source, so the source size was used as the cap.';
      }
    } else if (normalized.operation === 'resize') {
      const resizeSpec = computeResizeSpec(normalized.resize, sourceWidth, sourceHeight);
      tempPath = createImageTempPath(outputDir);
      tempFiles.add(tempPath);
      quality = ['jpeg', 'webp', 'avif'].includes(outputInfo.format) ? normalized.resizeQuality : 100;
      await encodeImageCandidate({
        inputPath,
        tempPath,
        outputFormat: outputInfo.format,
        quality,
        resize: resizeSpec,
        stripMetadata: normalized.stripMetadata
      });
      outputWidth = resizeSpec.width || sourceWidth;
      outputHeight = resizeSpec.height || sourceHeight;
      suffix = 'resized';
      note = `Resized to ${outputWidth} × ${outputHeight}px.`;
    }

    finalPath = uniqueImageOutputPath(
      outputDir,
      `${safeImageStem(inputPath)}_${suffix}`,
      outputInfo.ext
    );
    fs.renameSync(tempPath, finalPath);
    tempFiles.delete(tempPath);

    const outputStat = fs.statSync(finalPath);
    let outputMeta = null;
    try {
      outputMeta = await readImageMetadata(finalPath);
    } catch (err) {}

    const savedBytes = sourceStat.size - outputStat.size;
    const savedPercent = sourceStat.size > 0
      ? Math.round((savedBytes / sourceStat.size) * 100)
      : 0;

    if (normalized.operation === 'resize') {
      const finalWidth = outputMeta ? outputMeta.width : outputWidth;
      const finalHeight = outputMeta ? outputMeta.height : outputHeight;
      note = `Resized to ${finalWidth} × ${finalHeight}px.`;
    }

    return {
      success: true,
      operation: normalized.operation,
      inputPath,
      inputFileName: fileName,
      outputPath: finalPath,
      outputFileName: path.basename(finalPath),
      format: outputInfo.format,
      formatLabel: outputInfo.label,
      originalSize: sourceStat.size,
      originalSizeFormatted: formatBytes(sourceStat.size),
      size: outputStat.size,
      sizeFormatted: formatBytes(outputStat.size),
      savedBytes,
      savedPercent,
      width: outputMeta ? outputMeta.width : outputWidth,
      height: outputMeta ? outputMeta.height : outputHeight,
      sourceWidth,
      sourceHeight,
      quality,
      attempts,
      targetBytes: targetBytes === null ? undefined : targetBytes,
      targetSizeFormatted: targetBytes === null ? undefined : formatBytes(targetBytes),
      targetMet: targetMet === null ? undefined : targetMet,
      stripMetadata: normalized.stripMetadata,
      note,
      ...imageFileUrls(finalPath)
    };
  } finally {
    for (const temp of tempFiles) {
      removeImageFileQuietly(temp);
    }
  }
}

const imageRouter = express.Router();

imageRouter.use((req, res, next) => {
  if (req.user && req.user.role === 'guest') {
    const rawPaths = [];
    if (req.query && req.query.path) rawPaths.push(req.query.path);
    if (req.body) {
      if (req.body.path) rawPaths.push(req.body.path);
      if (Array.isArray(req.body.paths)) rawPaths.push(...req.body.paths);
      if (req.body.inputPath) rawPaths.push(req.body.inputPath);
      if (Array.isArray(req.body.inputPaths)) rawPaths.push(...req.body.inputPaths);
    }
    for (const p of rawPaths) {
      if (p && !isPathInside(p, UPLOADS_DIR) && !isPathInside(p, PROCESSED_DIR)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Guests cannot access or process images from local server storage.'
        });
      }
    }
  }
  next();
});

const imageAsyncRoute = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

imageRouter.get('/preview', (req, res) => {
  try {
    const resolved = assertPathAllowed(req.query.path, 'Image file');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).json({ success: false, error: 'Image was not found.' });
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = IMAGE_CONTENT_TYPES[ext];
    if (!contentType) {
      return res.status(403).json({
        success: false,
        error: 'Only JPG, PNG, WebP, AVIF, and TIFF images can be served.'
      });
    }

    const download = req.query.download === '1' || req.query.download === 'true';
    const fileName = path.basename(resolved);
    const encodedName = encodeURIComponent(fileName);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${encodedName}"; filename*=UTF-8''${encodedName}`
    );
    return res.sendFile(resolved);
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

imageRouter.post('/inspect', imageAsyncRoute(async (req, res) => {
  const body = req.body || {};
  const rawPaths = Array.isArray(body.paths)
    ? body.paths
    : (body.path ? [body.path] : []);

  if (rawPaths.length === 0) {
    throw createHttpError(400, 'Provide at least one image path.');
  }
  if (rawPaths.length > IMAGE_MAX_INSPECT) {
    throw createHttpError(400, `Inspect at most ${IMAGE_MAX_INSPECT} images at once.`);
  }

  const results = [];
  for (const rawPath of rawPaths) {
    const label = path.basename(String(rawPath || '')) || 'Image';
    try {
      const resolved = assertPathAllowed(rawPath, 'Image file');
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw createHttpError(404, 'Image was not found.');
      }
      if (!IMAGE_STUDIO_EXTS.has(path.extname(resolved).toLowerCase())) {
        throw createHttpError(400, 'Unsupported image format.');
      }

      const stat = fs.statSync(resolved);
      const info = await readImageMetadata(resolved);
      results.push({
        success: true,
        path: resolved,
        name: path.basename(resolved),
        size: stat.size,
        sizeFormatted: formatBytes(stat.size),
        width: info.width,
        height: info.height,
        format: info.meta.format,
        space: info.meta.space,
        channels: info.meta.channels,
        hasAlpha: Boolean(info.meta.hasAlpha),
        hasExif: Boolean(info.meta.exif),
        orientation: info.meta.orientation || 1,
        ...imageFileUrls(resolved)
      });
    } catch (err) {
      results.push({
        success: false,
        path: String(rawPath || ''),
        name: label,
        error: friendlyImageError(err, label)
      });
    }
  }

  res.json({ success: true, results });
}));

imageRouter.post('/process', imageAsyncRoute(async (req, res) => {
  const body = req.body || {};
  const rawPaths = Array.isArray(body.inputPaths)
    ? body.inputPaths
    : (body.inputPath ? [body.inputPath] : []);

  if (rawPaths.length === 0) {
    throw createHttpError(400, 'Select at least one image.');
  }
  if (rawPaths.length > IMAGE_MAX_BATCH) {
    throw createHttpError(400, `Process at most ${IMAGE_MAX_BATCH} images in one batch.`);
  }

  const normalized = normalizeImageRequest(body);

  let lockAcquired = false;
  const imageStartTime = Date.now();
  try {
    concurrencyLock.acquireImageLock(normalized.operation);
    lockAcquired = true;
    for (const p of rawPaths) {
      try { concurrencyLock.imageJob.activeFiles.add(path.resolve(p)); } catch (e) {}
    }

    const results = [];
    for (const rawPath of rawPaths) {
      const label = path.basename(String(rawPath || '')) || 'Image';
      try {
        const resolved = assertPathAllowed(rawPath, 'Image file');
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          throw createHttpError(404, 'Image was not found.');
        }
        if (!IMAGE_STUDIO_EXTS.has(path.extname(resolved).toLowerCase())) {
          throw createHttpError(400, 'Unsupported image format.');
        }
        results.push(await processImageFile(resolved, normalized));
      } catch (err) {
        cleanupTempUploadsOnError(rawPath);
        results.push({
          success: false,
          inputPath: String(rawPath || ''),
          inputFileName: label,
          error: friendlyImageError(err, label)
        });
      }
    }

    const successful = results.filter((item) => item.success);
    const failed = results.length - successful.length;
    const totalOriginalSize = successful.reduce((sum, item) => sum + item.originalSize, 0);
    const totalOutputSize = successful.reduce((sum, item) => sum + item.size, 0);
    const savedBytes = totalOriginalSize - totalOutputSize;

    if (results.length > 0) {
      try {
        analyticsService.recordEvent({
          type: 'image',
          operation: normalized.operation || 'process',
          status: successful.length > 0 ? 'completed' : 'failed',
          bytesProcessed: totalOutputSize || totalOriginalSize || 0,
          durationMs: Date.now() - imageStartTime
        });
      } catch (evtErr) {}
    }

    res.json({
      success: true,
      operation: normalized.operation,
      processed: successful.length,
      failed,
      results,
      summary: {
        totalOriginalSize,
        totalOriginalSizeFormatted: formatBytes(totalOriginalSize),
        totalOutputSize,
        totalOutputSizeFormatted: formatBytes(totalOutputSize),
        savedBytes,
        savedPercent: totalOriginalSize > 0
          ? Math.round((savedBytes / totalOriginalSize) * 100)
          : 0
      },
      message: successful.length > 0
        ? `${successful.length} image${successful.length === 1 ? '' : 's'} processed${failed > 0 ? `, ${failed} failed` : ''}.`
        : 'No images could be processed.'
    });
  } finally {
    if (lockAcquired) concurrencyLock.releaseImageLock();
  }
}));

app.use('/api/image', imageRouter);

// ==================== AUTHENTICATION & ACCESS CONTROL API ====================

// GET /api/auth/status
app.get('/api/auth/status', (req, res) => {
  try {
    const hasAdmin = databaseManager.hasAnyAdmin();
    const authenticated = Boolean(req.user);
    res.json({
      success: true,
      hasAdmin,
      authenticated,
      user: req.user || null,
      expiresAt: req.authSession ? req.authSession.expires_at : null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/register-admin
app.post('/api/auth/register-admin', (req, res) => {
  try {
    if (databaseManager.hasAnyAdmin()) {
      return res.status(403).json({
        success: false,
        error: 'Registration is closed. An admin account has already been registered.'
      });
    }

    const { username, password } = req.body || {};
    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({
        success: false,
        error: 'Username must be at least 3 characters long.'
      });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters long.'
      });
    }

    const cleanUsername = username.trim();
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);

    const user = databaseManager.createUser({
      username: cleanUsername,
      passwordHash,
      salt,
      role: 'admin'
    });

    const session = databaseManager.createAuthSession({
      userId: user.id,
      username: user.username,
      role: 'admin',
      maxAgeMs: AUTH_SESSION_MAX_AGE_MS
    });

    res.cookie(AUTH_COOKIE_NAME, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: AUTH_SESSION_MAX_AGE_MS,
      path: '/'
    });

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully.',
      token: session.token,
      user: { id: user.id, username: user.username, role: 'admin' },
      expiresAt: session.expires_at
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Username and password are required.'
      });
    }

    const user = databaseManager.getUserByUsername(username.trim());
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password.'
      });
    }

    const valid = verifyPassword(password, user.password_hash, user.salt);
    if (!valid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password.'
      });
    }

    databaseManager.updateUserLastLogin(user.id);
    const session = databaseManager.createAuthSession({
      userId: user.id,
      username: user.username,
      role: user.role,
      maxAgeMs: AUTH_SESSION_MAX_AGE_MS
    });

    res.cookie(AUTH_COOKIE_NAME, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: AUTH_SESSION_MAX_AGE_MS,
      path: '/'
    });

    res.json({
      success: true,
      message: 'Login successful.',
      token: session.token,
      user: { id: user.id, username: user.username, role: user.role },
      expiresAt: session.expires_at
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/guest
app.post('/api/auth/guest', (req, res) => {
  try {
    const guestUsername = 'guest_' + crypto.randomBytes(3).toString('hex');
    const session = databaseManager.createAuthSession({
      userId: null,
      username: guestUsername,
      role: 'guest',
      maxAgeMs: AUTH_SESSION_MAX_AGE_MS
    });

    res.cookie(AUTH_COOKIE_NAME, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: AUTH_SESSION_MAX_AGE_MS,
      path: '/'
    });

    res.json({
      success: true,
      message: 'Guest session started. Local storage is restricted.',
      token: session.token,
      user: { username: guestUsername, role: 'guest' },
      expiresAt: session.expires_at
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  try {
    const token = extractAuthToken(req);
    if (token) {
      databaseManager.deleteAuthSession(token);
    }
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1. Current Active Job State (For browser refresh / state restore)
// GET /api/current-job
app.get('/api/current-job', (req, res) => {
  const clientSessionId = req.query.sessionId || req.headers['x-session-id'] || null;
  let returnedJob = null;

  if (clientSessionId) {
    if (activeJob && activeJob.sessionId === clientSessionId) {
      returnedJob = activeJob;
    } else {
      for (const [id, j] of Array.from(jobs.entries()).reverse()) {
        if (j && j.sessionId === clientSessionId) {
          returnedJob = j;
          break;
        }
      }
    }
  } else {
    // Local / direct client without session ID: only return if activeJob has no session ID
    if (activeJob && !activeJob.sessionId) {
      returnedJob = activeJob;
    }
  }

  const clientJob = returnedJob ? formatJobForClient(returnedJob) : {
    jobId: null,
    sessionId: clientSessionId,
    status: 'idle',
    filePath: '',
    filename: '',
    operation: '',
    progress: 0,
    currentTime: '00:00:00',
    totalDuration: '00:00:00',
    totalDurationSec: 0,
    speed: '0.0x',
    outputPath: '',
    commandString: '',
    error: null,
    outputFile: null,
    isRemoteUpload: false
  };

  const outPath = clientJob?.outputPath || clientJob?.outputFile?.path;
  const isAvailable = Boolean(outPath && fs.existsSync(outPath));

  const isServerBusy = Boolean(
    (activeJob && activeJob.status === 'processing') ||
    (concurrencyLock.pdfJob && concurrencyLock.pdfJob.isProcessing) ||
    (concurrencyLock.imageJob && concurrencyLock.imageJob.isProcessing)
  );

  res.json({
    success: true,
    activeJob: clientJob,
    isAvailable,
    outputAvailable: isAvailable,
    isServerBusy,
    serverBusyDetails: isServerBusy ? {
      mediaProcessing: Boolean(activeJob && activeJob.status === 'processing'),
      pdfProcessing: Boolean(concurrencyLock.pdfJob && concurrencyLock.pdfJob.isProcessing),
      imageProcessing: Boolean(concurrencyLock.imageJob && concurrencyLock.imageJob.isProcessing)
    } : null,
    activePdfJob: concurrencyLock ? concurrencyLock.pdfJob : { isProcessing: false },
    activeImageJob: concurrencyLock ? concurrencyLock.imageJob : { isProcessing: false }
  });
});

// ======================== REMOTE UPLOAD & DOWNLOAD ENDPOINTS ========================
// POST /api/upload: Upload files to uploads/ with no file size limit & 30-min auto-cleanup
app.post('/api/upload', (req, res) => {
  uploadMiddleware.any()(req, res, (err) => {
    if (err) {
      // Clean up any files that were partially saved during this request
      if (req.files && Array.isArray(req.files)) {
        for (const f of req.files) {
          try { if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (e) {}
        }
      }
      if (req.file && req.file.path) {
        try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (e) {}
      }

      if (err.code === 'ENOSPC' || (err.message && err.message.includes('ENOSPC'))) {
        return res.status(507).json({ success: false, error: 'Upload failed: Not enough storage space on the server.' });
      }

      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'File upload exceeds limit.' });
      }
      return res.status(400).json({ success: false, error: err.message || 'File upload failed.' });
    }
    const uploadedFiles = req.files || [];
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ success: false, error: 'No files were uploaded.' });
    }

    const sessionId = req.headers['x-session-id'] || req.body?.sessionId || null;
    const now = Date.now();
    const files = uploadedFiles.map(f => {
      const fullPath = path.resolve(f.path);
      return {
        filename: f.filename,
        originalname: f.originalname,
        path: fullPath,
        size: f.size,
        sizeFormatted: formatBytes(f.size),
        mimetype: f.mimetype,
        sessionId,
        uploadedAt: now,
        expiresAt: now + (30 * 60 * 1000)
      };
    });

    res.json({
      success: true,
      files,
      file: files[0]
    });
  });
});

// GET /api/download/:filename: Serve processed and temp files securely
app.get('/api/download/:filename', (req, res) => {
  try {
    const rawParam = req.params.filename;
    if (!rawParam || typeof rawParam !== 'string' || rawParam.includes('\0') || rawParam.includes('/') || rawParam.includes('\\')) {
      return res.status(400).send('Invalid filename.');
    }

    const rawFilename = path.basename(rawParam);
    if (!rawFilename || rawFilename === '.' || rawFilename === '..') {
      return res.status(400).send('Invalid filename.');
    }

    const allowedDownloadDirs = [
      PROCESSED_DIR,
      UPLOADS_DIR
    ].filter(Boolean);

    let foundPath = null;

    for (const dir of allowedDownloadDirs) {
      const candidate = path.join(dir, rawFilename);
      const canonical = canonicalizeTarget(candidate);
      const canonicalDir = canonicalizeTarget(dir);
      if (isPathWithinRoot(canonical, canonicalDir) || canonical === canonicalDir) {
        if (fs.existsSync(canonical) && fs.statSync(canonical).isFile()) {
          foundPath = canonical;
          break;
        }
      }
    }

    // Direct-path support: Allow downloading output files explicitly located within allowed roots
    if (!foundPath && req.query.path) {
      if (req.user && req.user.role === 'guest') {
        return res.status(403).send('Access denied: Guests cannot download files from local server storage.');
      }
      try {
        const queryPath = assertPathAllowed(req.query.path, 'Download file');
        if (fs.existsSync(queryPath) && fs.statSync(queryPath).isFile()) {
          const ext = path.extname(queryPath).toLowerCase();
          if (DOWNLOADABLE_EXTS.has(ext)) {
            foundPath = queryPath;
          }
        }
      } catch (err) {
        // Path validation error handled below
      }
    }

    if (!foundPath) {
      return res.status(404).send('File not found or has expired (auto-deleted after 30 minutes).');
    }

    const safeDownloadName = sanitizeUploadFilename(rawFilename);
    return res.download(foundPath, safeDownloadName);
  } catch (err) {
    console.error('[Download Error]', err);
    res.status(500).send('Error downloading file: ' + err.message);
  }
});

// 2. System Info
app.get('/api/info', (req, res) => {
  execFile('ffmpeg', ['-version'], (err, stdout) => {
    const versionLine = stdout ? stdout.split('\n')[0] : 'FFmpeg (Termux)';
    let storagePermission = false;
    try {
      if (fs.existsSync('/sdcard')) {
        fs.readdirSync('/sdcard');
        storagePermission = true;
      }
    } catch (e) {
      storagePermission = false;
    }

    res.json({
      ffmpeg: versionLine,
      storagePermission,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  });
});

// 3. Server-Side File Explorer API
// GET /api/browse?dir=/sdcard/
app.get('/api/browse', requireAdminAccess(), (req, res) => {
  try {
    const rawDir = (req.query.dir || req.query.path) ? String(req.query.dir || req.query.path).trim() : '/sdcard';
    const requestedKind = String(req.query.kind || 'media').toLowerCase();
    const activeKind = BROWSE_FILTERS[requestedKind] ? requestedKind : 'media';
    const allowedExtensions = BROWSE_FILTERS[activeKind];
    let targetDir;
    try {
      targetDir = assertPathAllowed(rawDir, 'Directory');
    } catch (pathErr) {
      return res.status(pathErr.status || 403).json({ error: pathErr.message });
    }

    const fallbackDir = ['/sdcard', '/storage/emulated/0', process.env.HOME]
      .find(dir => dir && fs.existsSync(dir) && isPathAllowed(dir));

    if (!fs.existsSync(targetDir)) {
      targetDir = fallbackDir || ALLOWED_ROOTS[0];
    }

    let stats;
    try {
      stats = fs.statSync(targetDir);
      if (!stats.isDirectory()) {
        targetDir = path.dirname(targetDir);
        if (!isPathAllowed(targetDir)) targetDir = fallbackDir || ALLOWED_ROOTS[0];
      }
    } catch (statErr) {
      return res.json({
        success: true,
        currentDir: targetDir,
        parentDir: getAllowedParent(targetDir),
        allowedRoots: getAllowedRootsForUi(),
        items: [],
        error: `Cannot access directory: ${statErr.message}`
      });
    }

    let entries = [];
    try {
      entries = fs.readdirSync(targetDir, { withFileTypes: true });
    } catch (readErr) {
      return res.json({
        success: true,
        currentDir: targetDir,
        parentDir: getAllowedParent(targetDir),
        allowedRoots: getAllowedRootsForUi(),
        items: [],
        error: `Permission denied: ${readErr.message}`
      });
    }

    const items = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // ignore hidden

      const fullPath = path.join(targetDir, entry.name);

      let isDir = false;
      let isFil = false;

      if (entry.isDirectory()) {
        isDir = true;
      } else if (entry.isFile()) {
        isFil = true;
      } else if (entry.isSymbolicLink()) {
        try {
          if (isPathAllowed(fullPath)) {
            const st = fs.statSync(fullPath);
            if (st.isDirectory()) isDir = true;
            else if (st.isFile()) isFil = true;
          }
        } catch (e) {
          continue; // broken or unreadable symlink
        }
      }

      if (isDir) {
        items.push({
          name: entry.name,
          path: fullPath,
          isDirectory: true
        });
      } else if (isFil) {
        const ext = path.extname(entry.name).toLowerCase();
        if (allowedExtensions.has(ext)) {
          let size = 0;
          let mtime = 0;
          try {
            const st = fs.statSync(fullPath);
            size = st.size;
            mtime = st.mtimeMs || 0;
          } catch (e) {}
          items.push({
            name: entry.name,
            path: fullPath,
            isDirectory: false,
            size,
            sizeFormatted: formatBytes(size),
            mtime,
            mtimeFormatted: mtime ? new Date(mtime).toLocaleDateString() : '',
            ext: ext.replace('.', '').toUpperCase(),
            fileKind: PDF_EXTS.has(ext) ? 'pdf' : (IMAGE_STUDIO_EXTS.has(ext) ? 'image' : 'media')
          });
        }
      }
    }

    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    res.json({
      success: true,
      kind: activeKind,
      currentDir: targetDir,
      parentDir: getAllowedParent(targetDir),
      allowedRoots: getAllowedRootsForUi(),
      items
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 4. Auto-Detect Audio Tracks & Analyze Media
// GET /api/analyze-media?path=/sdcard/Download/movie.mkv
app.get('/api/analyze-media', async (req, res) => {
  try {
    const rawPath = req.query.path || req.query.filePath;
    if (!rawPath) {
      return res.status(400).json({ error: 'path query parameter is required (e.g. /api/analyze-media?path=/sdcard/movie.mkv)' });
    }

    const resolved = assertPathAllowed(String(rawPath).trim(), 'Media file');

    if (req.user && req.user.role === 'guest') {
      const isAllowedForGuest = isPathInside(resolved, UPLOADS_DIR) || isPathInside(resolved, PROCESSED_DIR);
      if (!isAllowedForGuest) {
        return res.status(403).json({ error: 'Access denied: Guests cannot inspect files from local server storage.' });
      }
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: `File not found on storage: ${rawPath}` });
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return res.status(400).json({ error: `Target path is not a file: ${rawPath}` });
    }

    const analysis = await analyzeMedia(resolved);
    res.json(analysis);
  } catch (err) {
    console.error('[analyze-media] Error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 4b. Probe Media File Details (Backward-compatible)
// POST /api/probe-file  body: { filePath }
app.post('/api/probe-file', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const resolved = assertPathAllowed(filePath, 'Media file');

    if (req.user && req.user.role === 'guest') {
      const isAllowedForGuest = isPathInside(resolved, UPLOADS_DIR) || isPathInside(resolved, PROCESSED_DIR);
      if (!isAllowedForGuest) {
        return res.status(403).json({ error: 'Access denied: Guests cannot probe files from local server storage.' });
      }
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return res.status(400).json({ error: `Target path is not a file: ${filePath}` });
    }

    const meta = await analyzeMedia(resolved).catch(async () => {
      return await probeMedia(resolved);
    });

    res.json({
      success: true,
      file: {
        name: path.basename(resolved),
        path: resolved,
        directory: path.dirname(resolved),
        size: stat.size,
        sizeFormatted: formatBytes(stat.size),
        metadata: meta
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 4c. Automatic Video Thumbnail Generator (deduplicated + atomic writes)
const inflightThumbnails = new Map();

function generateThumbnailFile(resolvedPath, thumbFile) {
  if (inflightThumbnails.has(thumbFile)) {
    return inflightThumbnails.get(thumbFile);
  }

  const runExec = (args) => new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 10000 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  const promise = (async () => {
    let seekTime = '00:00:05';
    try {
      const dur = await getVideoDuration(resolvedPath);
      if (dur > 0 && dur < 10) {
        const half = Math.max(0.1, dur / 2);
        seekTime = formatTime(half);
      }
    } catch (e) {}

    const tempThumb = `${thumbFile}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp.jpg`;
    const runAttempt = async (seek) => {
      await runExec([
        '-hide_banner',
        '-ss', seek,
        '-i', resolvedPath,
        '-vframes', '1',
        '-f', 'image2',
        '-update', '1',
        '-y',
        tempThumb
      ]);
      if (!fs.existsSync(tempThumb) || fs.statSync(tempThumb).size === 0) {
        throw new Error('Empty thumbnail output');
      }
    };

    try {
      try {
        await runAttempt(seekTime);
      } catch (e) {
        await runAttempt('00:00:01');
      }
      fs.renameSync(tempThumb, thumbFile);
      return thumbFile;
    } finally {
      if (fs.existsSync(tempThumb)) {
        try { fs.unlinkSync(tempThumb); } catch (e) {}
      }
      inflightThumbnails.delete(thumbFile);
    }
  })();

  inflightThumbnails.set(thumbFile, promise);
  return promise;
}

// GET /api/get-thumbnail?path=/sdcard/movie.mp4
app.get('/api/get-thumbnail', async (req, res) => {
  try {
    const rawPath = req.query.path || req.query.filePath;
    if (!rawPath) return res.status(400).send('Missing path parameter');
    const resolvedPath = assertPathAllowed(String(rawPath).trim(), 'Media file');

    if (req.user && req.user.role === 'guest') {
      const isAllowedForGuest = isPathInside(resolvedPath, UPLOADS_DIR) || isPathInside(resolvedPath, PROCESSED_DIR);
      if (!isAllowedForGuest) {
        return res.status(403).send('Access denied: Guests cannot preview files from local server storage.');
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).send('File not found');
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return res.status(400).send('Path is not a file');
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const isVideo = ALLOWED_MEDIA_EXTS.has(ext) && !['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(ext);
    if (!isVideo) {
      return res.status(400).send('Thumbnail only supported for video files');
    }

    const hash = crypto.createHash('md5').update(`${resolvedPath}_${stat.mtimeMs}_${stat.size}`).digest('hex');
    const thumbFile = path.join(THUMBS_DIR, `thumb_${hash}.jpg`);

    if (fs.existsSync(thumbFile) && fs.statSync(thumbFile).size > 0) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(thumbFile);
    }

    try {
      await generateThumbnailFile(resolvedPath, thumbFile);
    } catch (genErr) {
      return res.status(404).send('Failed to generate thumbnail');
    }

    if (!fs.existsSync(thumbFile) || fs.statSync(thumbFile).size === 0) {
      return res.status(404).send('Failed to generate thumbnail');
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(thumbFile);
  } catch (err) {
    console.error('[Thumbnail Error]:', err.message);
    res.status(err.status || 500).send('Thumbnail error: ' + err.message);
  }
});

// 5. Direct Path Processing Endpoint (Supports Multi-Operation and Single-Operation)
// POST /api/process-direct & POST /api/process-multi
app.post(['/api/process-direct', '/api/process-multi'], async (req, res) => {
  try {
    concurrencyLock.acquireMediaLock();
  } catch (lockErr) {
    return res.status(lockErr.status || 409).json({
      success: false,
      error: lockErr.message
    });
  }

  let resolvedPath = null;
  try {
    const { filePath, operation, options = {}, operations, audioTracks, subtitleConfig, hardwareAccel, isLosslessCopy, muteAudio } = req.body;

    if (!filePath) {
      return res.status(400).json({ error: 'Absolute file path is required' });
    }

    resolvedPath = assertPathAllowed(filePath, 'Media file');

    // Guest protection: Guests cannot process files from local server storage
    if (req.user && req.user.role === 'guest') {
      const isInsideUploads = isPathInside(resolvedPath, UPLOADS_DIR);
      if (!isInsideUploads) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Guests cannot process files from local server storage. Please use Remote Upload mode.'
        });
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: `File not found on storage: ${filePath}` });
    }

    // 1. Analyze media info and get exact duration
    let totalDurationSec = await getVideoDuration(resolvedPath);
    let meta = null;
    try {
      meta = await analyzeMedia(resolvedPath);
    } catch (aErr) {
      meta = await probeMedia(resolvedPath);
    }

    if ((!totalDurationSec || totalDurationSec <= 0) && meta && meta.duration) {
      totalDurationSec = meta.duration;
      console.log(`[analyzeMedia] Fallback duration from format probe: ${totalDurationSec}s (${formatTime(totalDurationSec)})`);
    }

    const isMultiOp = Boolean(operations && typeof operations === 'object');
    let outExt = path.extname(resolvedPath) || '.mp4';
    let jobOpName = operation || 'multi_op';

    if (isMultiOp) {
      const hasAnyOperation = Boolean(
        (operations.format && operations.format.enabled !== false) ||
        (operations.resize && operations.resize.enabled !== false) ||
        (operations.trim && operations.trim.enabled !== false) ||
        (operations.audioOnly === true || (operations.audioOnly && operations.audioOnly.enabled))
      );
      if (!hasAnyOperation) {
        return res.status(400).json({ error: 'Select at least one operation (Convert, Compress/Resize, Trim, or Extract audio).' });
      }

      const isAudioOnly = Boolean(operations.audioOnly === true || operations.audioOnly?.enabled);
      const rawFmt = operations.format ? (typeof operations.format === 'string' ? operations.format : operations.format.format) : null;
      const fmt = rawFmt ? normalizeOutputFormatName(rawFmt) : null;

      if (isAudioOnly) {
        outExt = fmt ? `.${fmt}` : '.mp3';
        jobOpName = 'audio_extract';
      } else if (fmt) {
        outExt = `.${fmt}`;
        jobOpName = fmt;
      } else {
        outExt = path.extname(resolvedPath) || '.mp4';
        jobOpName = 'multi';
      }

      // Account for trim duration & validate
      if (operations.trim && (operations.trim.enabled !== false)) {
        const startSec = operations.trim.start ? parseTimeToSeconds(operations.trim.start) : 0;
        const endSec = operations.trim.end ? parseTimeToSeconds(operations.trim.end) : null;
        if (endSec !== null && endSec <= startSec) {
          return res.status(400).json({ error: 'Trim End time must be greater than Start time.' });
        }
        if (endSec !== null && endSec > startSec) {
          totalDurationSec = endSec - startSec;
        }
      }
    } else {
      // Legacy single operation duration & extension
      if (operation === 'trim') {
        const startSec = options.start ? parseTimeToSeconds(options.start) : 0;
        const endSec = options.end ? parseTimeToSeconds(options.end) : totalDurationSec;
        if (endSec > startSec) {
          totalDurationSec = endSec - startSec;
        }
      } else if (operation === 'gif' && options.duration) {
        const gifDur = parseFloat(options.duration);
        if (gifDur > 0) totalDurationSec = gifDur;
      } else if (operation === 'speed' && options.speed && totalDurationSec > 0) {
        const spdVal = parseFloat(options.speed);
        if (spdVal > 0) totalDurationSec = totalDurationSec / spdVal;
      }

      if (operation === 'convert') {
        const fmt = normalizeOutputFormatName(options.format || 'mp4') || 'mp4';
        options.format = fmt;
        outExt = `.${fmt}`;
      } else if (operation === 'change_audio' || operation === 'speed') {
        outExt = path.extname(resolvedPath) || '.mp4';
      } else if (operation === 'extract_audio') {
        const fmt = normalizeOutputFormatName(options.format || 'mp3') || 'mp3';
        options.format = fmt;
        outExt = `.${fmt}`;
      } else if (operation === 'gif') {
        outExt = '.gif';
      } else if (operation === 'raw' && options.outputExt) {
        const safeRawExt = normalizeOutputFormatName(options.outputExt);
        outExt = `.${safeRawExt}`;
      }
    }

    const totalDurationStr = formatTime(totalDurationSec);
    const dir = path.dirname(resolvedPath);
    const ext = path.extname(resolvedPath);
    const base = path.basename(resolvedPath, ext);

    const isRemoteUpload = Boolean(req.body.isRemoteUpload || isPathWithinRoot(path.resolve(resolvedPath), path.resolve(TEMP_UPLOADS_DIR)));
    const safeJobOp = String(jobOpName || 'process').replace(/[^a-z0-9_-]/gi, '_');
    const outputFilename = `${base}_${safeJobOp}${outExt}`;
    let outputPath = isRemoteUpload
      ? path.join(PROCESSED_DIR, outputFilename)
      : path.join(dir, outputFilename);

    // Prevent overwriting original file
    if (outputPath === resolvedPath) {
      outputPath = isRemoteUpload
        ? path.join(PROCESSED_DIR, `${base}_output_${Date.now().toString().slice(-4)}${outExt}`)
        : path.join(dir, `${base}_output_${Date.now().toString().slice(-4)}${outExt}`);
    }

    if (!isRemoteUpload) {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
      } catch (wErr) {
        const fallbackDir = fs.existsSync('/sdcard/Download') ? '/sdcard/Download' : (process.env.HOME || '/sdcard');
        outputPath = path.join(fallbackDir, outputFilename);
      }
    }
    outputPath = assertPathAllowed(outputPath, 'Output file');

    // Build FFmpeg command arguments dynamically or via legacy builder
    const effectiveSubConfig = subtitleConfig || (operations && operations.subtitleConfig) || {};
    const effectiveHwAccel = Boolean(hardwareAccel || (operations && (operations.hardwareAccel || operations.fastMode)));
    const effectiveLossless = Boolean(isLosslessCopy || (operations && (operations.isLosslessCopy || operations.lossless)));
    const effectiveMuteAudio = Boolean(muteAudio || (operations && (operations.muteAudio || operations.mute)));

    let ffmpegArgs = [];
    if (isMultiOp) {
      ffmpegArgs = buildDynamicFfmpegArgs({
        inputPath: resolvedPath,
        operations: { ...operations, hardwareAccel: effectiveHwAccel, muteAudio: effectiveMuteAudio },
        audioTracks: Array.isArray(audioTracks) ? audioTracks : [],
        subtitleConfig: effectiveSubConfig,
        outputPath,
        mediaInfo: meta,
        isLosslessCopy: effectiveLossless
      });
    } else {
      ffmpegArgs = buildFfmpegArgs(operation, options, [resolvedPath], outputPath, totalDurationSec || meta.duration);
    }

    const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const commandString = buildSafeFfmpegCommand(ffmpegArgs, resolvedPath, outputPath, 'ffmpeg');
    const clientSessionId = req.body.sessionId || req.headers['x-session-id'] || null;

    const jobPayload = {
      id: jobId,
      sessionId: clientSessionId,
      name: `${jobOpName.toUpperCase()} - ${path.basename(resolvedPath)}`,
      filename: path.basename(resolvedPath),
      operation: jobOpName,
      options: isMultiOp ? { ...operations, subtitleConfig: effectiveSubConfig, hardwareAccel: effectiveHwAccel, isLosslessCopy: effectiveLossless } : options,
      isHardwareAccel: effectiveHwAccel,
      isRemoteUpload,
      meta,
      status: 'queued',
      isDirectPath: true,
      createdAt: Date.now(),
      totalDuration: totalDurationStr,
      totalDurationSec: totalDurationSec || meta.duration || 0,
      expectedDuration: totalDurationSec || meta.duration || 0,
      filePath: resolvedPath,
      inputPaths: [resolvedPath],
      outputPath,
      ffmpegArgs,
      executable: 'ffmpeg',
      execArgs: ffmpegArgs,
      workingDir: isRemoteUpload ? PROCESSED_DIR : dir,
      commandString
    };

    const canonicalJob = queueManager.enqueue(jobPayload);
    jobs.set(jobId, canonicalJob);

    res.json({
      success: true,
      jobId,
      name: canonicalJob.name,
      outputPath,
      commandString: canonicalJob.commandString,
      activeJob: activeJob.jobId === jobId ? activeJob : formatJobForClient(canonicalJob)
    });
  } catch (err) {
    console.error('Process error:', err);
    // Keep temp upload on validation/enqueue error so user can fix options and retry without 404.
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// 5c. Advanced Custom FFmpeg Command Runner
// POST /api/run-custom
app.post('/api/run-custom', async (req, res) => {
  try {
    concurrencyLock.acquireMediaLock();
  } catch (lockErr) {
    return res.status(lockErr.status || 409).json({
      success: false,
      error: lockErr.message
    });
  }

  let resolvedPath = null;
  try {
    const clientSessionId = req.body?.sessionId || req.headers['x-session-id'] || null;
    const { command, filePath } = req.body || {};

    if (!command || typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: 'Command string is required.' });
    }

    let totalDurationSec = 0;
    let meta = null;

    if (filePath) {
      resolvedPath = assertPathAllowed(filePath, 'Media file');
      if (req.user && req.user.role === 'guest') {
        const isInsideUploads = isPathInside(resolvedPath, UPLOADS_DIR);
        if (!isInsideUploads) {
          return res.status(403).json({
            success: false,
            error: 'Access denied: Guests cannot process files from local server storage.'
          });
        }
      }
      if (!fs.existsSync(resolvedPath)) {
        return res.status(404).json({ error: `File not found on storage: ${filePath}` });
      }
      try {
        totalDurationSec = await getVideoDuration(resolvedPath);
      } catch (e) {}
      try {
        meta = await probeMedia(resolvedPath);
      } catch (e) {}
      if ((!totalDurationSec || totalDurationSec <= 0) && meta && meta.duration) {
        totalDurationSec = meta.duration;
      }
    }

    const prepared = prepareCustomCommand(command.trim(), resolvedPath);
    const { executable, execArgs, outputPath: detectedOutput, displayCommand, cwd } = prepared;

    const totalDurationStr = formatTime(totalDurationSec);
    const filename = resolvedPath ? path.basename(resolvedPath) : 'custom_command';
    const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const jobPayload = {
      id: jobId,
      sessionId: clientSessionId,
      name: `CUSTOM - ${filename}`,
      filename,
      operation: 'custom',
      isCustom: true,
      executable,
      execArgs,
      workingDir: cwd,
      options: { command: displayCommand, filePath: resolvedPath },
      status: 'queued',
      isDirectPath: true,
      isRemoteUpload: Boolean(req.body?.isRemoteUpload || (resolvedPath && isPathWithinRoot(resolvedPath, path.resolve(TEMP_UPLOADS_DIR)))),
      createdAt: Date.now(),
      totalDuration: totalDurationStr,
      totalDurationSec: totalDurationSec || 0,
      expectedDuration: totalDurationSec || 0,
      filePath: resolvedPath || '',
      inputPaths: resolvedPath ? [resolvedPath] : [],
      outputPath: detectedOutput || '',
      ffmpegArgs: execArgs,
      commandString: displayCommand
    };

    const canonicalJob = queueManager.enqueue(jobPayload);
    jobs.set(jobId, canonicalJob);

    res.json({
      success: true,
      jobId,
      name: canonicalJob.name,
      outputPath: detectedOutput || '',
      commandString: displayCommand,
      activeJob: activeJob.jobId === jobId ? activeJob : formatJobForClient(canonicalJob)
    });
  } catch (err) {
    console.error('[Run Custom] Error starting custom job:', err);
    // Keep temp upload on validation/enqueue error so user can fix command and retry without 404.
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// 5b. Cancel Active FFmpeg Job
// POST /api/cancel-job
app.post('/api/cancel-job', (req, res) => {
  try {
    const clientSessionId = req.body?.sessionId || req.headers['x-session-id'] || null;
    const targetJobId = req.body && req.body.jobId ? req.body.jobId : activeJob.jobId;
    const job = targetJobId ? (jobs.get(targetJobId) || jobManager.getJob(targetJobId)) : null;

    // Security check: If target job has a sessionId, caller MUST provide the matching sessionId
    const jobSession = (job && job.sessionId) || activeJob.sessionId;
    if (jobSession && jobSession !== clientSessionId) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized: You cannot cancel a job belonging to another session.'
      });
    }

    // Check if target is in waiting queue
    if (job && job.status === 'queued') {
      queueManager.cancelJob(targetJobId, clientSessionId);
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.error = 'Cancelled while waiting in queue';
      return res.json({
        success: true,
        message: 'Queued job cancelled.',
        activeJob: formatJobForClient(activeJob)
      });
    }

    const resolvedTargetId = targetJobId || activeJob.jobId;
    const targetProc = (resolvedTargetId && activeProcesses.get(resolvedTargetId)) || (job && job._process) || (!targetJobId ? currentFFmpegProcess : null);
    const isActuallyRunning = Boolean(targetProc) ||
      (job && job.status === 'processing') ||
      (activeJob.status === 'processing' && activeJob.jobId === resolvedTargetId);

    if (!isActuallyRunning) {
      console.log('[Cancel Job] Ignored: no active job is running.');
      return res.json({
        success: true,
        message: 'No active job to cancel.',
        activeJob: formatJobForClient(activeJob)
      });
    }

    const outputPath = (job && job.outputPath) || (activeJob.jobId === resolvedTargetId ? activeJob.outputPath : '');

    console.log(`[Cancel Job] Stop request received for job: ${resolvedTargetId}`);

    // Update job state in store
    if (job) {
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.error = 'Conversion cancelled by user';
    }

    const isGlobalActiveTarget = activeJob.jobId === resolvedTargetId || !activeJob.jobId;
    if (isGlobalActiveTarget) {
      activeJob.status = 'cancelled';
      activeJob.error = 'Conversion cancelled by user';
    }

    try {
      queueManager.cancelJob(resolvedTargetId, clientSessionId);
    } catch (e) {}

    // Forcefully kill ONLY the targeted FFmpeg process if running
    if (targetProc) {
      try {
        console.log(`[Cancel Job] Killing FFmpeg process (PID: ${targetProc.pid}) for job ${resolvedTargetId} with SIGKILL`);
        const pidToKill = targetProc.pid;
        targetProc.kill('SIGKILL');
        if (pidToKill) {
          try {
            process.kill(-pidToKill, 'SIGKILL');
          } catch (e) {}
          try {
            exec(`kill -9 ${pidToKill} 2>/dev/null; pkill -9 -P ${pidToKill} 2>/dev/null`, () => {});
          } catch (e) {}
        }
      } catch (killErr) {
        console.warn('[Cancel Job] Error killing process:', killErr.message);
      }
      clearProcessActive(resolvedTargetId);
    }

    // Clean up partially created output file if exists
    if (outputPath && fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
        console.log(`[Cancel Job] Successfully removed partial output file: ${outputPath}`);
      } catch (unlinkErr) {
        console.warn(`[Cancel Job] Failed to remove partial file ${outputPath}:`, unlinkErr.message);
      }
    }

    // Rule D: Immediately delete temp uploaded input file on cancel
    cleanupTempUploadsOnError(
      isGlobalActiveTarget ? activeJob.filePath : null,
      job && job.filePath,
      ...(job && job.inputPaths ? job.inputPaths : [])
    );

    const ssePayload = {
      type: 'status',
      status: 'cancelled',
      jobId: resolvedTargetId,
      message: 'Conversion cancelled by user',
      activeJob: isGlobalActiveTarget ? formatJobForClient(activeJob) : formatJobForClient(job)
    };

    const cancelledFilePath = isGlobalActiveTarget ? activeJob.filePath : '';
    const cancelledOutputPath = isGlobalActiveTarget ? activeJob.outputPath : '';
    if (isGlobalActiveTarget) {
      activeJob.filePath = '';
      activeJob.outputPath = '';
      scheduleActiveJobReset(resolvedTargetId);
    }
    if (concurrencyLock && concurrencyLock.removeFile) {
      concurrencyLock.removeFile(cancelledFilePath);
      concurrencyLock.removeFile(cancelledOutputPath);
      if (job) {
        concurrencyLock.removeFile(job.filePath);
        concurrencyLock.removeFile(job.outputPath);
      }
    }

    if (resolvedTargetId) {
      notifyJobSubscribers(resolvedTargetId, ssePayload);
    }
    if (activeJob.jobId && activeJob.jobId !== resolvedTargetId && isGlobalActiveTarget) {
      notifyJobSubscribers(activeJob.jobId, ssePayload);
    }

    res.json({
      success: true,
      message: 'Conversion cancelled by user',
      activeJob: formatJobForClient(activeJob)
    });
  } catch (err) {
    console.error('[Cancel Job] Error cancelling job:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. SSE Progress Stream
app.get(['/api/progress/:jobId', '/api/progress'], (req, res) => {
  const clientSessionId = req.query.sessionId || req.headers['x-session-id'] || null;
  const jobId = req.params.jobId || req.query.jobId || (activeJob.sessionId === clientSessionId ? activeJob.jobId : null);

  // Clear any pending zombie kill timer only when an authorized/matching client connects
  if (zombieInactivityTimer && (!activeJob.sessionId || clientSessionId === activeJob.sessionId)) {
    clearTimeout(zombieInactivityTimer);
    zombieInactivityTimer = null;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.clientSessionId = clientSessionId;
  res.clientJobId = jobId;

  if (jobId) {
    if (!sseSubscribers.has(jobId)) {
      sseSubscribers.set(jobId, new Set());
    }
    sseSubscribers.get(jobId).add(res);
  }
  globalSseClients.add(res);

  console.log(`[SSE Connection] Client connected to /api/progress (Job: ${jobId || 'none'}, Session: ${clientSessionId || 'none'}, Active SSE: ${globalSseClients.size})`);

  // Send initial state immediately upon connection
  let targetJob = jobId ? jobs.get(jobId) : null;
  if (!targetJob && activeJob && (!clientSessionId || activeJob.sessionId === clientSessionId)) {
    targetJob = activeJob;
  }
  const formattedInit = targetJob ? formatJobForClient(targetJob) : {
    jobId: null,
    sessionId: clientSessionId,
    status: 'idle',
    progress: 0,
    currentTime: '00:00:00',
    totalDuration: '00:00:00',
    speed: '0.0x',
    outputFile: null
  };

  const initialPayload = {
    type: 'init',
    jobId: formattedInit.jobId,
    status: formattedInit.status,
    progress: formattedInit.progress,
    currentTime: formattedInit.currentTime,
    totalDuration: formattedInit.totalDuration,
    speed: formattedInit.speed,
    activeJob: formattedInit,
    outputFile: formattedInit.outputFile
  };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  req.on('close', () => {
    globalSseClients.delete(res);
    if (jobId && sseSubscribers.has(jobId)) {
      const subs = sseSubscribers.get(jobId);
      if (subs) {
        subs.delete(res);
        if (subs.size === 0) sseSubscribers.delete(jobId);
      }
    }
    console.log(`[SSE Connection] Client disconnected (Remaining SSE: ${globalSseClients.size})`);

    // Zombie process prevention: If user closes browser mid-conversion on remote uploads,
    // allow a 5-minute grace period (handles mobile backgrounding, screen locks, and tunnel reconnects).
    // Local storage jobs run to completion without being killed when the phone screen is locked.
    if (activeJob.isRemoteUpload && globalSseClients.size === 0 && activeJob.status === 'processing') {
      if (zombieInactivityTimer) clearTimeout(zombieInactivityTimer);
      zombieInactivityTimer = setTimeout(() => {
        if (globalSseClients.size === 0 && activeJob.status === 'processing' && activeJob.isRemoteUpload) {
          console.warn(`[Zombie Protection] No client connected for 5 minutes during remote job ${activeJob.jobId}. Terminating abandoned job.`);
          if (currentFFmpegProcess && !currentFFmpegProcess.killed) {
            try {
              const pid = currentFFmpegProcess.pid;
              currentFFmpegProcess.kill('SIGKILL');
              if (pid) {
                try { process.kill(-pid, 'SIGKILL'); } catch (e) {}
                try { exec(`kill -9 ${pid} 2>/dev/null; pkill -9 -P ${pid} 2>/dev/null`, () => {}); } catch (e) {}
              }
            } catch (e) {}
            currentFFmpegProcess = null;
          }
          activeJob.status = 'idle';
          activeJob.jobId = null;
          activeJob.error = 'Job cancelled: remote browser disconnected for over 5 minutes.';
        }
      }, 5 * 60 * 1000);
      if (zombieInactivityTimer && zombieInactivityTimer.unref) {
        zombieInactivityTimer.unref();
      }
    }
  });
});

// 7. Direct Media Streaming for Browser Preview
app.get('/api/stream-file', (req, res) => {
  let filePath;
  try {
    filePath = assertPathAllowed(req.query.path, 'Media file');
  } catch (pathErr) {
    return res.status(pathErr.status || 403).send(pathErr.message);
  }

  try {
    if (!filePath) {
      return res.status(404).send('File not found');
    }

    if (req.user && req.user.role === 'guest') {
      const isAllowedForGuest = isPathInside(filePath, UPLOADS_DIR) || isPathInside(filePath, PROCESSED_DIR);
      if (!isAllowedForGuest) {
        return res.status(403).send('Access denied: Guests cannot stream files from local server storage.');
      }
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();

    if (!ALLOWED_MEDIA_EXTS.has(ext) && ext !== '.gif') {
      return res.status(403).send('Only media files can be streamed.');
    }

    let contentType = 'video/mp4';
    if (ext === '.webm') contentType = 'video/webm';
    else if (ext === '.mkv') contentType = 'video/x-matroska';
    else if (ext === '.mp3') contentType = 'audio/mpeg';
    else if (ext === '.wav') contentType = 'audio/wav';
    else if (ext === '.aac') contentType = 'audio/aac';
    else if (ext === '.m4a') contentType = 'audio/mp4';
    else if (ext === '.ogg') contentType = 'audio/ogg';
    else if (ext === '.flac') contentType = 'audio/flac';
    else if (ext === '.gif') contentType = 'image/gif';

    if (req.query.download === '1' || req.query.download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);
    }

    if (fileSize === 0) {
      const head = {
        'Content-Length': 0,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      };
      if (req.query.download === '1' || req.query.download === 'true') {
        head['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`;
      }
      res.writeHead(200, head);
      return res.end();
    }

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start) || start >= fileSize || end >= fileSize || start > end) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).send('Requested range not satisfiable');
      }

      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };
      if (req.query.download === '1' || req.query.download === 'true') {
        head['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`;
      }
      res.writeHead(206, head);
      res.on('close', () => { file.destroy(); });
      file.on('error', (err) => {
        if (!res.headersSent) res.status(500).end();
        file.destroy();
      });
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      };
      if (req.query.download === '1' || req.query.download === 'true') {
        head['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`;
      }
      res.writeHead(200, head);
      const stream = fs.createReadStream(filePath);
      res.on('close', () => { stream.destroy(); });
      stream.on('error', (err) => {
        if (!res.headersSent) res.status(500).end();
        stream.destroy();
      });
      stream.pipe(res);
    }
  } catch (err) {
    res.status(500).send('Streaming error: ' + err.message);
  }
});

// 8. Job History & Logs (Persistent SQLite & Session-Isolated)
app.get('/api/jobs', (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    const dbJobs = databaseManager.getJobs({ sessionId, limit });
    const formatted = dbJobs.map(j => ({
      id: j.id,
      name: j.name,
      operation: j.operation,
      status: j.status,
      isDirectPath: true,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      durationMs: j.durationMs,
      commandString: j.commandString,
      outputFile: j.outputFile,
      error: j.error
    }));
    res.json({ jobs: formatted });
  } catch (err) {
    // Fallback to in-memory jobs if DB lookup fails
    let all = Array.from(jobs.values());
    if (sessionId) {
      all = all.filter(j => j.sessionId === sessionId);
    }
    const jobList = all.map(j => ({
      id: j.id,
      name: j.name,
      operation: j.operation,
      status: j.status,
      isDirectPath: true,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      durationMs: j.durationMs,
      commandString: j.commandString,
      outputFile: j.outputFile,
      error: j.error
    })).reverse().slice(0, limit);
    res.json({ jobs: jobList });
  }
});

app.get('/api/jobs/:id/logs', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId) || jobManager.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || null;
  if (job.sessionId && job.sessionId !== sessionId) {
    return res.status(403).json({ error: 'Unauthorized to view logs for this job' });
  }
  const persistentLogs = jobManager.getLogs(jobId);
  const memLogs = (job.logs || []).join('');
  const finalLogs = persistentLogs || memLogs;

  res.json({
    id: job.id,
    name: job.name,
    commandString: job.commandString,
    logs: finalLogs,
    stderr: job.stderr || (job.logs ? job.logs.slice(-50).join('') : ''),
    status: job.status
  });
});

// Clear Job History (Session-Isolated & Persistent)
app.delete('/api/jobs', (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || null;
  if (sessionId) {
    let count = 0;
    for (const [id, job] of jobs.entries()) {
      if (job.sessionId === sessionId) {
        jobs.delete(id);
        count++;
      }
    }
    jobManager.clearJobs(sessionId);
    return res.json({ success: true, message: `Cleared ${count} job(s) for your session` });
  }
  let count = 0;
  for (const [id, job] of jobs.entries()) {
    if (!job.sessionId) {
      jobs.delete(id);
      count++;
    }
  }
  jobManager.clearJobs(null, { onlyUnscoped: true });
  res.json({ success: true, message: `Cleared ${count} unscoped job(s)` });
});

app.delete('/api/jobs/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId) || jobManager.getJob(jobId);
  if (!job) return res.json({ success: false, message: 'Job not found' });
  const sessionId = req.headers['x-session-id'] || req.query.sessionId || null;
  if (job.sessionId && job.sessionId !== sessionId) {
    return res.status(403).json({ error: 'Unauthorized to delete this job' });
  }
  jobs.delete(jobId);
  jobManager.deleteJob(jobId, sessionId);
  res.json({ success: true, message: 'Job log deleted' });
});

// Admin & Tunnel Access Guard for administrative/destructive routes
function isTunneledRequest(req) {
  const fwdHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const hasProxyIp = Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
  const isTunnelHost = /(trycloudflare\.com|loca\.lt|ngrok(-free)?\.(io|app))/i.test(fwdHost);
  return hasProxyIp || isTunnelHost;
}

function requireAdminAccess(options = {}) {
  const { blockPublicTunnelWithoutToken = false } = options;
  return (req, res, next) => {
    // 1. Session-authenticated Admin user
    if (req.user && req.user.role === 'admin') {
      return next();
    }

    // 2. Legacy / Tunnel ADMIN_TOKEN check
    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken) {
      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const headerToken = String(req.headers['x-admin-token'] || req.query?.adminToken || '').trim();
      if (bearer === adminToken || headerToken === adminToken) {
        req.user = { userId: 'env_admin', username: 'admin', role: 'admin' };
        return next();
      }
      return res.status(403).json({ success: false, error: 'Forbidden: Valid admin token required.' });
    }

    // 3. Authenticated Guest: Strictly forbidden from administrative & local storage access
    if (req.user && req.user.role === 'guest') {
      return res.status(403).json({
        success: false,
        error: 'Access denied: Local server storage and administration are restricted to Admin.'
      });
    }

    // 4. Block public tunnel without token if requested
    if (blockPublicTunnelWithoutToken && isTunneledRequest(req)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Destructive operation is disabled over public tunnels unless ADMIN_TOKEN is configured.'
      });
    }

    // 5. If no admin account exists yet in DB, allow access (for initial setup & test suites)
    if (!databaseManager.hasAnyAdmin()) {
      return next();
    }

    // 6. Admin exists, but caller is unauthenticated
    return res.status(401).json({
      success: false,
      error: 'Authentication required: Please log in with admin credentials.'
    });
  };
}

// ==================== QUEUE MANAGEMENT API ====================
app.get('/api/queue/status', (req, res) => {
  const qStatus = queueManager.getStatus();
  const isImageActive = Boolean(concurrencyLock?.imageJob?.isProcessing);
  const isPdfActive = Boolean(concurrencyLock?.pdfJob?.isProcessing);
  const isMediaActive = Boolean(concurrencyLock?.isMediaProcessing());
  const activeMediaName = (activeJob && activeJob.filename) || (qStatus.activeJobs ? qStatus.activeJobs[0]?.filename : null);

  res.json({
    ...qStatus,
    locks: {
      media: isMediaActive,
      image: isImageActive,
      pdf: isPdfActive
    },
    activeJobInfo: activeMediaName || (isImageActive ? `Image (${concurrencyLock.imageJob.operation})` : (isPdfActive ? `PDF (${concurrencyLock.pdfJob.tool})` : null)),
    isIdle: !isMediaActive && !isImageActive && !isPdfActive
  });
});

app.post('/api/queue/concurrency', requireAdminAccess(), (req, res) => {
  try {
    const { limit } = req.body;
    const newLimit = queueManager.setConcurrency(limit);
    res.json({ success: true, maxConcurrency: newLimit });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==================== HEALTH MONITORING API ====================
app.get('/api/health', async (req, res) => {
  try {
    const summary = await healthMonitor.getHealthSummaryAsync();
    const statusCode = summary.status === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json(summary);
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/api/health/live', (req, res) => {
  res.json(healthMonitor.getLiveness());
});

app.get('/api/health/ready', async (req, res) => {
  try {
    const ready = await healthMonitor.getReadinessAsync();
    res.status(ready.ready ? 200 : 503).json(ready);
  } catch (err) {
    res.status(503).json({ ready: false, error: err.message });
  }
});

// ==================== ANALYTICS API ====================
app.get('/api/analytics/stats', async (req, res) => {
  try {
    const stats = await analyticsService.getDashboardStatsAsync();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/analytics/clear-errors', requireAdminAccess(), (req, res) => {
  try {
    const result = analyticsService.clearErrors();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== APPLICATION BACKUPS API ====================
app.get('/api/backup/list', requireAdminAccess(), (req, res) => {
  res.json({ backups: backupManager.getBackupsList() });
});

app.post('/api/backup/run', requireAdminAccess(), async (req, res) => {
  try {
    const backup = await backupManager.createBackup();
    res.json({ success: true, backup });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/backup/restore', requireAdminAccess({ blockPublicTunnelWithoutToken: true }), async (req, res) => {
  try {
    const { backupId, confirm } = req.body;
    const result = await backupManager.restoreBackup(backupId, confirm);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==================== CENTRALIZED CLEANUP API ====================
app.get('/api/cleanup/stats', requireAdminAccess(), async (req, res) => {
  try {
    const stats = await cleanupManager.getStorageStatsAsync();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cleanup/run', requireAdminAccess({ blockPublicTunnelWithoutToken: true }), async (req, res) => {
  try {
    const result = await cleanupManager.runCleanup({ force: Boolean(req.body?.force) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cleanup/retention', requireAdminAccess(), (req, res) => {
  try {
    const { minutes } = req.body;
    const retentionMs = cleanupManager.setRetention(minutes);
    res.json({ success: true, retentionMinutes: Math.round(retentionMs / 60000) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.code === 'ENOSPC' || (err.message && err.message.includes('ENOSPC'))) {
    const errorMsg = 'Upload failed: Not enough storage space on the server.';
    if (req.path.startsWith('/api/')) {
      return res.status(507).json({ success: false, error: errorMsg });
    }
    return res.status(507).send(errorMsg);
  }
  if (err.message === 'Not allowed by CORS') {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ success: false, error: 'Forbidden: Origin not allowed by CORS policy.' });
    }
    return res.status(403).send('Forbidden: Origin not allowed by CORS policy.');
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('Unhandled server error:', err);
  }

  if (req.path.startsWith('/api/')) {
    const clientMessage = (status < 500 || err.expose)
      ? (err.message || 'Request failed.')
      : 'An unexpected internal server error occurred.';
    const responsePayload = {
      success: false,
      error: clientMessage
    };
    if (err.busy) {
      responsePayload.busy = true;
      responsePayload.activeType = err.activeType || 'unknown';
      responsePayload.activeJobName = err.activeJobName || '';
      responsePayload.queuePosition = err.queuePosition || 1;
      responsePayload.queuedJobsCount = err.queuedJobsCount || 0;
    }
    return res.status(status).json(responsePayload);
  }
  return res.status(status).send(status < 500 ? (err.message || 'Request failed.') : 'Request failed.');
});

// Helper: Detect Local Network IPv4 Address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const priorityKeys = Object.keys(interfaces).sort((a, b) => {
    // Priority: Wi-Fi/Hotspot > Mobile Cellular (ccmni/rmnet) > Ethernet > VPN > Other
    const score = (name) => {
      if (/^(wlan|ap|softap)/i.test(name)) return 10;
      if (/^(ccmni|rmnet|pdp)/i.test(name)) return 8;
      if (/^(eth|en)/i.test(name)) return 6;
      if (/^(tun|tailscale|wg)/i.test(name)) return 4;
      return 1;
    };
    return score(b) - score(a);
  });

  for (const name of priorityKeys) {
    for (const net of interfaces[name]) {
      if ((net.family === 'IPv4' || net.family === 4) && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// Helper: Summarize all active device network interfaces (Wi-Fi, Hotspot, Cellular ccmni, VPN)
function getNetworkInterfacesSummary() {
  const interfaces = os.networkInterfaces();
  const list = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const net of addrs) {
      if (!net.internal) {
        let type = 'Other';
        if (/^(wlan|ap|softap)/i.test(name)) type = 'Wi-Fi / Hotspot';
        else if (/^(ccmni|rmnet|pdp)/i.test(name)) type = 'Mobile Cellular Data';
        else if (/^(tun|tailscale|wg)/i.test(name)) type = 'VPN / Mesh';
        else if (/^(eth|en)/i.test(name)) type = 'Ethernet';

        const isIPv6 = net.family === 'IPv6' || net.family === 6;
        const displayAddr = isIPv6 ? `[${net.address}]` : net.address;

        list.push({
          interface: name,
          type,
          family: isIPv6 ? 'IPv6' : 'IPv4',
          address: net.address,
          url: `http://${displayAddr}:${PORT}`
        });
      }
    }
  }

  return list;
}

// Background Services Initialization
function initServices() {
  try {
    databaseManager.init();
    jobManager.recoverInterruptedJobs();
    cleanupManager.init(filePath => isFileInActiveProcessing(filePath));
    backupManager.init();
    queueManager.setExecutor(executeJob);
    console.log('[Services] Database, Queue, Cleanup, and Backup managers initialized.');
  } catch (err) {
    console.error('[Services] Failed to initialize background services:', err.message);
  }
}

initServices();

let activeServerInstance = null;

// Graceful Shutdown
function gracefulShutdown(signal) {
  console.log(`[Server] Received ${signal}, starting graceful shutdown...`);
  try {
    queueManager.shutdown();
    for (const [id, proc] of activeProcesses.entries()) {
      try {
        if (proc && !proc.killed) proc.kill('SIGTERM');
      } catch (e) {}
    }
    activeProcesses.clear();
    currentFFmpegProcess = null;
    cleanupManager.stopScheduler();
    backupManager.stopScheduler();
    databaseManager.close();
    wakeLockManager.forceReleaseSync();
    if (activeServerInstance) {
      try {
        if (typeof activeServerInstance.closeAllConnections === 'function') {
          activeServerInstance.closeAllConnections();
        }
        activeServerInstance.close(() => {
          if (require.main === module) process.exit(0);
        });
        const forceExitTimer = setTimeout(() => {
          if (require.main === module) process.exit(0);
        }, 1500);
        if (forceExitTimer.unref) forceExitTimer.unref();
        return;
      } catch (e) {}
    }
  } catch (e) {
    console.warn('[Server] Error during graceful shutdown:', e.message);
  }
  if (require.main === module) {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start Server with dual-stack IPv6 + IPv4 support
if (require.main === module) {
  const BIND_HOST = process.env.HOST || '::';

  function onListen(hostUsed) {
    const localIP = getLocalIP();
    const ifaceList = getNetworkInterfacesSummary();

    console.log('=========================================');
    console.log('Termux Utility Studio is running!');
    console.log(`Bound to:          ${hostUsed}:${PORT}`);
    console.log(`Localhost:         http://localhost:${PORT}`);
    console.log(`Dashboard:         http://localhost:${PORT}/dashboard`);
    console.log(`Media Studio:      http://localhost:${PORT}/media`);
    console.log(`PDF & Docs Studio: http://localhost:${PORT}/pdf`);
    console.log(`Image Studio:      http://localhost:${PORT}/image`);
    console.log('');
    console.log('Active Network Addresses:');
    if (ifaceList.length > 0) {
      for (const iface of ifaceList) {
        console.log(`  • [${iface.interface}] (${iface.type} ${iface.family}): ${iface.url}`);
      }
    } else {
      console.log(`  • http://${localIP}:${PORT}`);
    }
    console.log('(Access the site from other devices or browsers using any of the above network URLs)');
    console.log('=========================================');
  }

  const serverInstance = app.listen(PORT, BIND_HOST, () => {
    onListen(BIND_HOST);
  });
  activeServerInstance = serverInstance;

  serverInstance.on('error', (err) => {
    if (BIND_HOST === '::' && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[Server] Dual-stack :: bind unavailable, falling back to 0.0.0.0...');
      activeServerInstance = app.listen(PORT, '0.0.0.0', () => {
        onListen('0.0.0.0');
      });
    } else {
      throw err;
    }
  });
}

module.exports = {
  app,
  concurrencyLock,
  wakeLockManager,
  isFileInActiveProcessing,
  cleanDirectory,
  runAutoCleanup,
  isFileBeingWritten,
  databaseManager,
  jobManager,
  queueManager,
  cleanupManager,
  backupManager,
  healthMonitor,
  analyticsService,
  isOriginAllowed,
  corsOptions,
  getLocalIP,
  getNetworkInterfacesSummary
};
