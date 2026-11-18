const express = require('express');
const fileUpload = require('express-fileupload');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, degrees } = require('pdf-lib');

const PDF_EXTS = new Set(['.pdf']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
};

const A4_PAGE_WIDTH = 595.28;
const A4_PAGE_HEIGHT = 841.89;
const PDF_PAGE_MARGIN = 20;

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_PDFLIB_FILE_BYTES = 128 * 1024 * 1024;
const MAX_PDFLIB_TOTAL_BYTES = 160 * 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 50 * 1000 * 1000;
const MAX_TOTAL_IMAGE_PIXELS = 120 * 1000 * 1000;
const MAX_MERGE_FILES = 30;
const MAX_MERGE_PAGES = 5000;
const MAX_IMAGES = 60;
const MAX_SPLIT_PAGES = 10000;
const MAX_SPLIT_RANGE_CHARS = 2000;
const STALE_TEMP_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const PACKAGE_BY_COMMAND = {
  qpdf: 'qpdf',
  gs: 'ghostscript',
  pdftoppm: 'poppler',
  pdfinfo: 'poppler'
};

const COMPRESSION_PRESETS = {
  light: 'printer',
  balanced: 'ebook',
  strong: 'screen'
};

const UPLOAD_TEMP_DIR = path.join(__dirname, 'temp_pdf_uploads');
const UPLOAD_OUTPUT_DIR = path.join(__dirname, 'pdf_outputs');

function isMemoryFailure(err) {
  if (!err) return false;
  const message = String(err.message || '');
  return err.code === 'ENOMEM' || /out of memory|heap out of memory|array buffer allocation failed|cannot allocate memory|enomem/i.test(message);
}

function findExecutable(command) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (err) {}
  }
  return null;
}

for (const dir of [UPLOAD_TEMP_DIR, UPLOAD_OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createPdfRouter(deps) {
  const {
    assertPathAllowed,
    formatBytes,
    createHttpError,
    concurrencyLock,
    TEMP_UPLOADS_DIR,
    PROCESSED_DIR,
    cleanupTempUploadsOnError,
    wakeLockManager
  } = deps || {};

  const EFFECTIVE_OUTPUT_DIR = PROCESSED_DIR || UPLOAD_OUTPUT_DIR;

  if (typeof assertPathAllowed !== 'function' || typeof createHttpError !== 'function') {
    throw new Error('createPdfRouter requires assertPathAllowed and createHttpError helpers.');
  }

  const router = express.Router();

  const upload = fileUpload({
    useTempFiles: true,
    tempFileDir: UPLOAD_TEMP_DIR,
    preserveExtension: true,
    safeFileNames: true,
    createParentPath: true,
    abortOnLimit: true,
    limits: {
      fileSize: Infinity,
      files: MAX_IMAGES,
      fields: 100
    }
  });

  const asyncRoute = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  function pdfConcurrencyMiddleware(toolName) {
    return (req, res, next) => {
      let directWakeLock = null;
      if (concurrencyLock) {
        try {
          concurrencyLock.acquirePdfLock(toolName);
        } catch (err) {
          return next(err);
        }
      } else if (wakeLockManager) {
        directWakeLock = wakeLockManager.acquire(`PDF Studio: ${toolName}`);
      }
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          if (concurrencyLock) {
            concurrencyLock.releasePdfLock();
          }
          if (directWakeLock) {
            try { directWakeLock.release(); } catch (e) {}
            directWakeLock = null;
          }
        }
      };
      res.once('finish', release);
      res.once('close', release);
      res.once('error', release);
      next();
    };
  }

  function listUploads(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    return [value];
  }

  function listPathValues(value) {
    if (!value) return [];
    const values = Array.isArray(value) ? value : [value];
    return values
      .map((item) => (typeof item === 'string' ? item.trim().replace(/^['"]|['"]$/g, '') : ''))
      .filter(Boolean);
  }

  function allRequestUploads(req) {
    const files = req && req.files;
    if (!files) return [];
    return Object.values(files).flatMap(listUploads);
  }

  function removeFileQuietly(filePath) {
    if (!filePath) return;
    fs.promises.unlink(filePath).catch(() => {});
  }

  function cleanupUploads(req) {
    for (const file of allRequestUploads(req)) {
      removeFileQuietly(file && file.tempFilePath);
      if (file && file._createdTempPath && file._createdTempPath !== file.tempFilePath) {
        removeFileQuietly(file._createdTempPath);
      }
    }
  }

  async function cleanupStaleTempFiles() {
    let entries = [];
    try {
      entries = await fs.promises.readdir(UPLOAD_TEMP_DIR);
    } catch (err) {
      return;
    }

    const cutoff = Date.now() - STALE_TEMP_MAX_AGE_MS;
    await Promise.all(entries.map(async (name) => {
      const filePath = path.join(UPLOAD_TEMP_DIR, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
        }
      } catch (err) {}
    }));
  }

  cleanupStaleTempFiles().catch(() => {});

  router.use((req, res, next) => {
    res.on('finish', () => cleanupUploads(req));
    res.on('close', () => cleanupUploads(req));
    next();
  });

  function getUploads(req, field) {
    return listUploads(req.files && req.files[field]);
  }

  function getFirstUpload(req, field) {
    return getUploads(req, field)[0] || null;
  }

  function validateExtension(filename, allowed, label) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    if (!allowed.has(ext)) {
      const list = Array.from(allowed).join(', ');
      throw createHttpError(400, `${label} must be one of: ${list}`);
    }
    return ext;
  }

  function resolveInputFile(rawPath, allowed, label) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      throw createHttpError(400, `${label} path is required.`);
    }
    let cleaned = rawPath.trim().replace(/^['"]|['"]$/g, '');
    if (cleaned.startsWith('~')) {
      cleaned = cleaned.replace(/^~(?=$|\/|\\)/, process.env.HOME || os.homedir());
    }
    const resolved = assertPathAllowed(cleaned, label);
    if (!fs.existsSync(resolved)) {
      throw createHttpError(404, `${label} was not found: ${rawPath}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw createHttpError(400, `${label} is not a file: ${rawPath}`);
    }
    validateExtension(resolved, allowed, label);
    return resolved;
  }

  function getBodyValue(body, key) {
    const value = body ? body[key] : undefined;
    if (value === undefined || value === null) return '';
    return String(value).trim();
  }

  function safeStem(name) {
    const cleaned = String(name || '')
      .replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 60);
    return cleaned || 'document';
  }

  function baseStem(filename) {
    return safeStem(path.basename(String(filename || 'document'), path.extname(String(filename || ''))));
  }

  function timestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      '_',
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds())
    ].join('');
  }

  function ensureOutputDir(rawDir, fallbackDir) {
    let chosen = String(rawDir || '').trim().replace(/^['"]|['"]$/g, '');
    if (chosen.startsWith('~')) {
      chosen = chosen.replace(/^~(?=$|\/|\\)/, process.env.HOME || os.homedir());
    }
    if (!chosen) chosen = fallbackDir;
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

  function uniqueOutputPath(dir, stem, ext) {
    let candidate = path.join(dir, `${safeStem(stem)}${ext}`);
    let counter = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${safeStem(stem)}_${counter}${ext}`);
      counter++;
    }
    return assertPathAllowed(candidate, 'Output file');
  }

  function uniqueOutputDir(parentDir, stem) {
    const resolvedParent = ensureOutputDir(parentDir, EFFECTIVE_OUTPUT_DIR);
    let candidate = path.join(resolvedParent, `${safeStem(stem)}_images_${timestamp()}`);
    let counter = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(resolvedParent, `${safeStem(stem)}_images_${timestamp()}_${counter}`);
      counter++;
    }
    fs.mkdirSync(candidate, { recursive: true });
    return assertPathAllowed(candidate, 'Output folder');
  }

  function fileInfo(filePath) {
    const stat = fs.statSync(filePath);
    return {
      size: stat.size,
      sizeFormatted: typeof formatBytes === 'function' ? formatBytes(stat.size) : `${stat.size} B`
    };
  }

  function buildDownloadUrl(filePath, download = true) {
    const parent = path.dirname(filePath);
    const isDirectInRoot = parent === PROCESSED_DIR || parent === TEMP_UPLOADS_DIR || parent === UPLOAD_OUTPUT_DIR;
    if (download && isDirectInRoot) {
      return `/api/download/${encodeURIComponent(path.basename(filePath))}`;
    }
    return `/api/pdf/download?path=${encodeURIComponent(filePath)}${download ? '&download=1' : ''}`;
  }

  function describeOutput(filePath) {
    const stats = fileInfo(filePath);
    return {
      outputPath: filePath,
      fileName: path.basename(filePath),
      size: stats.size,
      sizeFormatted: stats.sizeFormatted,
      downloadUrl: buildDownloadUrl(filePath, true),
      previewUrl: buildDownloadUrl(filePath, false)
    };
  }

  async function materializeUpload(file, ext) {
    if (!file) throw createHttpError(400, 'Uploaded file is missing.');
    if (file.tempFilePath) return file.tempFilePath;
    if (!file.data) throw createHttpError(400, 'Uploaded file has no data.');
    const tempPath = path.join(
      UPLOAD_TEMP_DIR,
      `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`
    );
    try {
      await fs.promises.writeFile(tempPath, Buffer.from(file.data));
    } catch (writeErr) {
      if (writeErr.code === 'ENOSPC' || (writeErr.message && writeErr.message.includes('ENOSPC'))) {
        throw createHttpError(507, 'Upload failed: Not enough storage space on the server.');
      }
      throw writeErr;
    }
    file._createdTempPath = tempPath;
    file.data = null; // GC hint: free uploaded in-memory buffer after persisting to disk
    return tempPath;
  }

  function runCommand(command, args, label, timeoutMs = 180000, req = null) {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn(command, args, {
          windowsHide: true
        });

        let stdout = '';
        let stderr = '';
        let isDone = false;

        if (child.stdout) {
          child.stdout.on('data', (d) => { stdout += d; });
        }
        if (child.stderr) {
          child.stderr.on('data', (d) => { stderr += d; });
        }

        const timeout = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e) {}
          reject(createHttpError(504, `${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);

        const res = req && (req.res || (req.writableEnded !== undefined ? req : null));
        const abortHandler = () => {
          const resEnded = req && req.res ? req.res.writableEnded : (res ? res.writableEnded : false);
          if (!isDone && !resEnded && child && !child.killed) {
            try { child.kill('SIGKILL'); } catch (e) {}
          }
        };

        if (res) {
          res.once('close', abortHandler);
        }

        child.on('error', (err) => {
          if (isDone) return;
          isDone = true;
          clearTimeout(timeout);
          if (res) res.off('close', abortHandler);

          if (err.code === 'ENOENT') {
            const packageName = PACKAGE_BY_COMMAND[command] || command;
            return reject(createHttpError(503, `${command} is not installed. Run: pkg install ${packageName}`));
          }
          return reject(createHttpError(500, `${label} could not be started: ${err.message}`));
        });

        child.on('close', (code) => {
          if (isDone) return;
          isDone = true;
          clearTimeout(timeout);
          if (res) res.off('close', abortHandler);

          if (code === 0 || (command === 'qpdf' && code === 3)) {
            return resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
          }

          if (isMemoryFailure({ message: stderr })) {
            return reject(createHttpError(413, `${label} ran out of memory. Try a smaller PDF or lower settings.`));
          }

          const lines = String(stderr || '').trim().split('\n').map((line) => line.trim()).filter(Boolean);
          const detail = lines.length > 0 ? lines[lines.length - 1] : `Process exited with code ${code}`;
          const invalidPassword = /password/i.test(detail);
          return reject(createHttpError(invalidPassword ? 400 : 500, `${label} failed: ${detail}`));
        });
      } catch (spawnErr) {
        return reject(createHttpError(500, `${label} could not be started: ${spawnErr.message}`));
      }
    });
  }

  function parsePositiveInt(raw, fallback, min, max) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = parseInt(raw, 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function parseOptionalPage(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  async function loadPdfDocument(bytes, label) {
    try {
      return await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (err) {
      if (isMemoryFailure(err)) {
        throw createHttpError(413, `${label} is too large to process safely on this device. Compress it first or use a smaller file.`);
      }
      if (/encrypt/i.test(err.message || '')) {
        throw createHttpError(400, `${label} is encrypted. Remove its password first with the Unlock tool.`);
      }
      throw createHttpError(400, `Could not read ${label}: ${err.message}`);
    }
  }

  async function embedImage(pdfDoc, bytes, ext, label) {
    try {
      return ext === '.png'
        ? await pdfDoc.embedPng(bytes)
        : await pdfDoc.embedJpg(bytes);
    } catch (err) {
      if (isMemoryFailure(err)) {
        throw createHttpError(413, `The image ${label} is too large to embed safely. Resize it and try again.`);
      }
      throw createHttpError(400, `Could not read image ${label}: ${err.message}`);
    }
  }

  function readImageDimensions(bytes, ext) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;

    if (ext === '.png') {
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      for (let i = 0; i < signature.length; i++) {
        if (bytes[i] !== signature[i]) return null;
      }
      return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20)
      };
    }

    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }

      let marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }

      const segmentLength = bytes.readUInt16BE(offset + 2);
      if (segmentLength < 2) return null;

      const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);

      if (isStartOfFrame && offset + 8 < bytes.length) {
        return {
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7)
        };
      }

      offset += 2 + segmentLength;
    }

    return null;
  }

  async function savePdf(pdfDoc, outputPath) {
    let bytes;
    try {
      bytes = await pdfDoc.save();
      await fs.promises.writeFile(outputPath, bytes);
    } catch (err) {
      if (isMemoryFailure(err)) {
        throw createHttpError(413, 'The generated PDF is too large for this device to save safely. Try fewer pages or images.');
      }
      throw err;
    } finally {
      bytes = null;
    }
  }

  async function readSource(source) {
    if (source.kind === 'direct') {
      return fs.promises.readFile(source.path);
    }
    const tempPath = await materializeUpload(source.file, source.ext);
    return fs.promises.readFile(tempPath);
  }

  function sourceLabel(source) {
    return source.kind === 'direct' ? path.basename(source.path) : source.name;
  }

  function directFallbackDir(sources, isRemote = false) {
    if (isRemote) return EFFECTIVE_OUTPUT_DIR;
    const direct = sources.find((source) => source.kind === 'direct');
    if (direct && TEMP_UPLOADS_DIR && direct.path.startsWith(TEMP_UPLOADS_DIR)) {
      return EFFECTIVE_OUTPUT_DIR;
    }
    return direct ? path.dirname(direct.path) : EFFECTIVE_OUTPUT_DIR;
  }

  function collectPdfSources(req, body, opts) {
    const field = opts.field || 'files';
    const minCount = opts.minCount || 1;
    const pathsField = opts.pathsField || 'inputPaths';

    const directValues = listPathValues(body[pathsField]);
    const uploads = getUploads(req, field);
    const sources = [];

    for (const rawPath of directValues) {
      const resolved = resolveInputFile(rawPath, PDF_EXTS, opts.label || 'PDF file');
      sources.push({ kind: 'direct', path: resolved, ext: '.pdf' });
    }

    for (const file of uploads) {
      const ext = validateExtension(file.name, PDF_EXTS, opts.label || 'PDF file');
      sources.push({ kind: 'upload', file, name: file.name, ext });
    }

    if (sources.length < minCount) {
      throw createHttpError(400, `Select at least ${minCount} PDF file${minCount === 1 ? '' : 's'}.`);
    }

    return sources;
  }

  function collectImageSources(req, body, opts) {
    const field = opts.field || 'images';
    const pathsField = opts.pathsField || 'imagePaths';
    const minCount = opts.minCount || 1;

    const directValues = listPathValues(body[pathsField]);
    const uploads = getUploads(req, field);
    const sources = [];

    for (const rawPath of directValues) {
      const resolved = resolveInputFile(rawPath, IMAGE_EXTS, 'Image');
      sources.push({
        kind: 'direct',
        path: resolved,
        ext: path.extname(resolved).toLowerCase()
      });
    }

    for (const file of uploads) {
      const ext = validateExtension(file.name, IMAGE_EXTS, 'Image');
      sources.push({ kind: 'upload', file, name: file.name, ext });
    }

    if (sources.length < minCount) {
      throw createHttpError(400, `Select at least ${minCount} image${minCount === 1 ? '' : 's'} (JPG or PNG).`);
    }

    return sources;
  }

  function humanBytes(value) {
    return typeof formatBytes === 'function' ? formatBytes(value) : `${value} B`;
  }

  function sourceSizeBytes(source) {
    if (!source) return 0;
    if (source.kind === 'direct') {
      try {
        return fs.statSync(source.path).size;
      } catch (err) {
        return 0;
      }
    }
    if (source.file && Number.isFinite(source.file.size) && source.file.size > 0) {
      return source.file.size;
    }
    if (source.file && source.file.tempFilePath) {
      try {
        return fs.statSync(source.file.tempFilePath).size;
      } catch (err) {}
    }
    return 0;
  }

  function assertSourceBudget(sources, opts) {
    if (sources.length > opts.maxFiles) {
      throw createHttpError(413, `Too many files selected. The limit is ${opts.maxFiles}.`);
    }

    let total = 0;
    for (const source of sources) {
      const size = sourceSizeBytes(source);
      if (size > opts.fileBytes) {
        throw createHttpError(413, `${sourceLabel(source)} is ${humanBytes(size)}. The per-file limit for this tool is ${humanBytes(opts.fileBytes)}.`);
      }
      total += size;
    }

    if (total > opts.totalBytes) {
      throw createHttpError(413, `The selected ${opts.label} total ${humanBytes(total)}. The limit is ${humanBytes(opts.totalBytes)} on this device.`);
    }

    return total;
  }

  function assertPdfLibFileSize(filePath, label) {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      throw createHttpError(400, `${label} is empty.`);
    }
    if (stat.size > MAX_PDFLIB_FILE_BYTES) {
      throw createHttpError(413, `${label} is ${humanBytes(stat.size)}. The pdf-lib limit on this device is ${humanBytes(MAX_PDFLIB_FILE_BYTES)}. Compress the PDF first or process a smaller file.`);
    }
    return stat.size;
  }

  async function resolveSinglePdfSource(req, body) {
    const directPath = getBodyValue(body, 'inputPath') || getBodyValue(body, 'filePath');
    if (directPath) {
      const resolved = resolveInputFile(directPath, PDF_EXTS, 'PDF file');
      return { path: resolved, name: path.basename(resolved), isDirect: true };
    }

    const uploadFile = getFirstUpload(req, 'file');
    if (!uploadFile) {
      throw createHttpError(400, 'Select a PDF file or upload one.');
    }

    validateExtension(uploadFile.name, PDF_EXTS, 'PDF file');
    const tempPath = await materializeUpload(uploadFile, '.pdf');
    return { path: tempPath, name: uploadFile.name, isDirect: false };
  }

  function parsePageRange(raw, pageCount) {
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!text) {
      throw createHttpError(400, 'Enter a page range such as 1-5, 8, 10-12.');
    }
    if (text.length > MAX_SPLIT_RANGE_CHARS) {
      throw createHttpError(400, 'The page range is too long. Use a shorter range.');
    }

    const tokens = text.split(/[,;]/).map((token) => token.trim()).filter(Boolean);
    if (tokens.length === 0) {
      throw createHttpError(400, 'Enter a page range such as 1-5, 8, 10-12.');
    }

    const indices = [];
    const seen = new Set();

    for (const token of tokens) {
      const match = token.match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
      if (!match) {
        throw createHttpError(400, `Invalid page range "${token}". Use formats like 1-5, 8, 10-12.`);
      }

      const start = parseInt(match[1], 10);
      const end = match[2] === undefined ? start : parseInt(match[2], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) {
        throw createHttpError(400, 'Page numbers must be 1 or greater.');
      }
      if (start > pageCount || end > pageCount) {
        throw createHttpError(400, `Page ${Math.max(start, end)} is out of range. This PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
      }

      const step = start <= end ? 1 : -1;
      for (let page = start; step > 0 ? page <= end : page >= end; page += step) {
        const index = page - 1;
        if (!seen.has(index)) {
          seen.add(index);
          indices.push(index);
        }
      }

      if (indices.length > MAX_SPLIT_PAGES) {
        throw createHttpError(413, `The range selects more than ${MAX_SPLIT_PAGES} pages. Choose a smaller range.`);
      }
    }

    if (indices.length === 0) {
      throw createHttpError(400, 'The page range did not select any pages.');
    }

    return indices;
  }

  function tempOutputPath(outputDir, tag) {
    const candidate = path.join(
      outputDir,
      `.pdfstudio_${tag}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.pdf`
    );
    return assertPathAllowed(candidate, 'Temporary output file');
  }

  async function cleanupAbandonedCompressionTemps(outputDir) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(outputDir);
    } catch (err) {
      return;
    }

    const cutoff = Date.now() - STALE_TEMP_MAX_AGE_MS;
    await Promise.all(entries.map(async (name) => {
      if (!name.startsWith('.pdfstudio_') || !name.endsWith('.pdf')) return;
      const filePath = path.join(outputDir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
        }
      } catch (err) {}
    }));
  }

  function fileSize(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch (err) {
      return 0;
    }
  }

  router.get('/download', (req, res) => {
    try {
      const resolved = assertPathAllowed(req.query.path, 'File');
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return res.status(404).json({ success: false, error: 'File not found.' });
      }

      const ext = path.extname(resolved).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(CONTENT_TYPES, ext)) {
        return res.status(403).json({ success: false, error: 'Only PDF, JPG, and PNG files can be served by the PDF studio.' });
      }

      const fileName = path.basename(resolved);
      const encodedName = encodeURIComponent(fileName);
      const safeAsciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
      const download = req.query.download === '1' || req.query.download === 'true';

      res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Disposition',
        `${download ? 'attachment' : 'inline'}; filename="${safeAsciiName}"; filename*=UTF-8''${encodedName}`
      );
      return res.sendFile(resolved);
    } catch (err) {
      return res.status(err.status || 500).json({ success: false, error: err.message });
    }
  });

  router.get('/capabilities', (req, res) => {
    res.json({
      success: true,
      tools: {
        qpdf: Boolean(findExecutable('qpdf')),
        ghostscript: Boolean(findExecutable('gs')),
        poppler: Boolean(findExecutable('pdftoppm'))
      },
      limits: {
        upload: MAX_UPLOAD_BYTES,
        pdfLibFile: MAX_PDFLIB_FILE_BYTES,
        pdfLibTotal: MAX_PDFLIB_TOTAL_BYTES,
        mergeFiles: MAX_MERGE_FILES,
        images: MAX_IMAGES
      }
    });
  });

  router.post('/unlock', pdfConcurrencyMiddleware('Password removal'), upload, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const directPath = getBodyValue(body, 'inputPath') || getBodyValue(body, 'filePath');
    const uploadFile = getFirstUpload(req, 'file');
    let sourcePath = directPath ? resolveInputFile(directPath, PDF_EXTS, 'PDF file') : null;
    let sourceName = sourcePath ? path.basename(sourcePath) : '';

    if (!sourcePath) {
      if (!uploadFile) {
        throw createHttpError(400, 'Select a PDF file or upload one.');
      }
      validateExtension(uploadFile.name, PDF_EXTS, 'PDF file');
      sourcePath = await materializeUpload(uploadFile, '.pdf');
      sourceName = uploadFile.name;
    }

    const isRemote = Boolean(body.isRemoteUpload || (directPath && TEMP_UPLOADS_DIR && directPath.startsWith(TEMP_UPLOADS_DIR)));
    const fallbackDir = (isRemote || !directPath) ? EFFECTIVE_OUTPUT_DIR : path.dirname(sourcePath);
    const outputDir = ensureOutputDir(
      getBodyValue(body, 'outputDir'),
      fallbackDir
    );
    const outputPath = uniqueOutputPath(outputDir, `${baseStem(sourceName)}_unlocked`, '.pdf');
    const password = body.password === undefined || body.password === null ? '' : String(body.password);

    try {
      if (concurrencyLock && concurrencyLock.pdfJob) concurrencyLock.pdfJob.activeFiles.add(path.resolve(sourcePath));
      await runCommand('qpdf', [`--password=${password}`, '--decrypt', sourcePath, outputPath], 'Password removal', 180000, req);
    } catch (err) {
      removeFileQuietly(outputPath);
      throw err;
    } finally {
      if (concurrencyLock && concurrencyLock.pdfJob && concurrencyLock.pdfJob.activeFiles) {
        concurrencyLock.pdfJob.activeFiles.delete(path.resolve(sourcePath));
      }
    }

    res.json({
      success: true,
      tool: 'unlock',
      message: 'PDF password removed successfully.',
      ...describeOutput(outputPath)
    });
  }));

  router.post('/merge', pdfConcurrencyMiddleware('PDF Merge'), upload, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const sources = collectPdfSources(req, body, {
      field: 'files',
      pathsField: 'inputPaths',
      minCount: 2,
      label: 'PDF file'
    });

    assertSourceBudget(sources, {
      maxFiles: MAX_MERGE_FILES,
      fileBytes: MAX_PDFLIB_FILE_BYTES,
      totalBytes: MAX_PDFLIB_TOTAL_BYTES,
      label: 'PDFs'
    });

    const isRemote = Boolean(body.isRemoteUpload);
    const outputDir = ensureOutputDir(getBodyValue(body, 'outputDir'), directFallbackDir(sources, isRemote));
    const outputPath = uniqueOutputPath(outputDir, `merged_${timestamp()}`, '.pdf');
    let merged = await PDFDocument.create();
    let totalMergedPages = 0;
    let finalPageCount = 0;

    try {
      if (concurrencyLock && concurrencyLock.pdfJob) {
        for (const s of sources) {
          if (s.kind === 'direct' && s.path) concurrencyLock.pdfJob.activeFiles.add(path.resolve(s.path));
        }
      }
      for (const source of sources) {
        let bytes = await readSource(source);
        let pdf = null;
        let pages = null;
        try {
          pdf = await loadPdfDocument(bytes, sourceLabel(source));
          // GC hint: free the raw file bytes immediately now that pdf-lib has loaded the document
          bytes = null;

          totalMergedPages += pdf.getPageCount();
          if (totalMergedPages > MAX_MERGE_PAGES) {
            throw createHttpError(413, `The PDFs contain more than ${MAX_MERGE_PAGES} pages in total. Merge fewer documents.`);
          }
          pages = await merged.copyPages(pdf, pdf.getPageIndices());
          for (const page of pages) {
            merged.addPage(page);
          }
        } finally {
          bytes = null;
          pages = null;
          pdf = null; // GC hint: immediately destroy/free source PDF document from memory
          if (global.gc) {
            try { global.gc(); } catch (e) {}
          }
        }
      }

      finalPageCount = merged.getPageCount();
      if (finalPageCount === 0) {
        throw createHttpError(400, 'The selected PDFs do not contain any pages.');
      }

      merged.setTitle('Merged document');
      merged.setProducer('Termux PDF & Docs Studio');
      merged.setCreator('Termux PDF & Docs Studio');
      await savePdf(merged, outputPath);
    } catch (err) {
      removeFileQuietly(outputPath);
      throw err;
    } finally {
      if (concurrencyLock && concurrencyLock.pdfJob && concurrencyLock.pdfJob.activeFiles) {
        for (const s of sources) {
          if (s.kind === 'direct' && s.path) concurrencyLock.pdfJob.activeFiles.delete(path.resolve(s.path));
        }
      }
      merged = null;
      if (global.gc) {
        try { global.gc(); } catch (e) {}
      }
    }

    res.json({
      success: true,
      tool: 'merge',
      message: `Merged ${sources.length} PDFs into one document.`,
      sourceCount: sources.length,
      pageCount: finalPageCount,
      ...describeOutput(outputPath)
    });
  }));

  router.post('/compress', pdfConcurrencyMiddleware('PDF Compression'), upload, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const source = await resolveSinglePdfSource(req, body);
    const level = (getBodyValue(body, 'level') || 'balanced').toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(COMPRESSION_PRESETS, level)) {
      throw createHttpError(400, 'Compression level must be light, balanced, or strong.');
    }

    const sourceStat = fs.statSync(source.path);
    if (sourceStat.size === 0) {
      throw createHttpError(400, 'The selected PDF is empty.');
    }
    if (sourceStat.size > MAX_UPLOAD_BYTES) {
      throw createHttpError(413, `The PDF is ${humanBytes(sourceStat.size)}. The compression limit is ${humanBytes(MAX_UPLOAD_BYTES)}.`);
    }

    const qpdfAvailable = Boolean(findExecutable('qpdf'));
    const gsAvailable = Boolean(findExecutable('gs'));
    if (!qpdfAvailable && !gsAvailable) {
      throw createHttpError(503, 'PDF compression needs qpdf or Ghostscript. Run: pkg install qpdf ghostscript');
    }

    const isRemote = Boolean(body.isRemoteUpload || (source.isDirect && TEMP_UPLOADS_DIR && source.path.startsWith(TEMP_UPLOADS_DIR)));
    const fallbackDir = (isRemote || !source.isDirect) ? EFFECTIVE_OUTPUT_DIR : path.dirname(source.path);
    const outputDir = ensureOutputDir(
      getBodyValue(body, 'outputDir'),
      fallbackDir
    );
    await cleanupAbandonedCompressionTemps(outputDir);
    const outputPath = uniqueOutputPath(outputDir, `${baseStem(source.name)}_compressed`, '.pdf');
    const candidates = [];
    const tempPaths = [];
    const failures = [];

    try {
      if (concurrencyLock && concurrencyLock.pdfJob && source.path) {
        concurrencyLock.pdfJob.activeFiles.add(path.resolve(source.path));
      }
      if (qpdfAvailable) {
        const qpdfOutput = tempOutputPath(outputDir, 'qpdf');
        tempPaths.push(qpdfOutput);
        try {
          await runCommand(
            'qpdf',
            [
              '--linearize',
              '--object-streams=generate',
              '--compress-streams=y',
              '--recompress-flate',
              '--compression-level=9',
              source.path,
              qpdfOutput
            ],
            'PDF compression (qpdf)',
            300000,
            req
          );
          const size = fileSize(qpdfOutput);
          if (size > 0) {
            candidates.push({ engine: 'qpdf', path: qpdfOutput, size });
          }
        } catch (err) {
          failures.push({ engine: 'qpdf', status: err.status || 500, message: err.message });
          removeFileQuietly(qpdfOutput);
        }
      }

      if (gsAvailable) {
        const gsOutput = tempOutputPath(outputDir, 'gs');
        tempPaths.push(gsOutput);
        try {
          await runCommand(
            'gs',
            [
              '-sDEVICE=pdfwrite',
              '-dCompatibilityLevel=1.7',
              `-dPDFSETTINGS=/${COMPRESSION_PRESETS[level]}`,
              '-dSAFER',
              '-dNOPAUSE',
              '-dBATCH',
              '-dQUIET',
              '-dNOPROMPT',
              '-dAutoRotatePages=/None',
              '-dDetectDuplicateImages=true',
              '-dCompressFonts=true',
              '-dSubsetFonts=true',
              `-sOutputFile=${gsOutput}`,
              source.path
            ],
            'PDF compression (Ghostscript)',
            600000,
            req
          );
          const size = fileSize(gsOutput);
          if (size > 0) {
            candidates.push({ engine: 'ghostscript', path: gsOutput, size });
          }
        } catch (err) {
          failures.push({ engine: 'ghostscript', status: err.status || 500, message: err.message });
          removeFileQuietly(gsOutput);
        }
      }

      if (candidates.length === 0) {
        const passwordFailure = failures.find((failure) => failure.status === 400);
        const primary = passwordFailure || failures[failures.length - 1];
        throw primary
          ? createHttpError(primary.status, primary.message)
          : createHttpError(500, 'PDF compression did not produce an output file.');
      }

      candidates.sort((a, b) => a.size - b.size);
      const best = candidates[0];
      try {
        await fs.promises.rename(best.path, outputPath);
      } catch (renameErr) {
        if (!['EXDEV', 'EPERM', 'EACCES'].includes(renameErr.code)) throw renameErr;
        await fs.promises.copyFile(best.path, outputPath);
      }

      const outputSize = fileSize(outputPath);
      if (outputSize <= 0) {
        throw createHttpError(500, 'PDF compression produced an empty output file.');
      }
      const savedBytes = Math.max(0, sourceStat.size - outputSize);
      const savedPercent = sourceStat.size > 0
        ? Math.round((savedBytes / sourceStat.size) * 1000) / 10
        : 0;
      const didShrink = outputSize < sourceStat.size;
      const notes = [];

      if (!gsAvailable) {
        notes.push('Ghostscript is not installed, so only lossless qpdf optimization was applied. Install it with: pkg install ghostscript');
      } else if (best.engine === 'qpdf' && failures.some((failure) => failure.engine === 'ghostscript')) {
        notes.push('Ghostscript could not process this PDF, so qpdf optimization was used.');
      } else if (best.engine === 'qpdf') {
        notes.push('qpdf produced the smaller file.');
      } else {
        notes.push('Ghostscript recompressed the document.');
      }

      if (!didShrink) {
        notes.push('No size reduction was possible; the output is an optimized copy.');
      }

      res.json({
        success: true,
        tool: 'compress',
        message: didShrink
          ? `Compressed from ${humanBytes(sourceStat.size)} to ${humanBytes(outputSize)} (${savedPercent}% smaller).`
          : `Optimized copy created at ${humanBytes(outputSize)}. This PDF was already close to its smallest size.`,
        engine: best.engine,
        compressionLevel: level,
        originalSize: sourceStat.size,
        originalSizeFormatted: humanBytes(sourceStat.size),
        savedBytes,
        savedPercent,
        didShrink,
        note: notes.join(' '),
        ...describeOutput(outputPath)
      });
    } catch (err) {
      removeFileQuietly(outputPath);
      throw err;
    } finally {
      if (concurrencyLock && concurrencyLock.pdfJob && concurrencyLock.pdfJob.activeFiles && source.path) {
        concurrencyLock.pdfJob.activeFiles.delete(path.resolve(source.path));
      }
      for (const tempPath of tempPaths) {
        removeFileQuietly(tempPath);
      }
    }
  }));

  router.post('/split', pdfConcurrencyMiddleware('PDF Split'), upload, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const source = await resolveSinglePdfSource(req, body);
    assertPdfLibFileSize(source.path, source.name);

    const isRemote = Boolean(body.isRemoteUpload || (source.isDirect && TEMP_UPLOADS_DIR && source.path.startsWith(TEMP_UPLOADS_DIR)));
    const fallbackDir = (isRemote || !source.isDirect) ? EFFECTIVE_OUTPUT_DIR : path.dirname(source.path);
    const outputDir = ensureOutputDir(
      getBodyValue(body, 'outputDir'),
      fallbackDir
    );
    const outputPath = uniqueOutputPath(outputDir, `${baseStem(source.name)}_pages`, '.pdf');
    const rangeText = getBodyValue(body, 'pages') || getBodyValue(body, 'range') || getBodyValue(body, 'pageRange');

    let bytes = await fs.promises.readFile(source.path);
    let sourceDoc = null;
    let outputDoc = null;
    let sourcePageCount = 0;
    let selectedPageCount = 0;

    try {
      if (concurrencyLock && concurrencyLock.pdfJob && source.path) {
        concurrencyLock.pdfJob.activeFiles.add(path.resolve(source.path));
      }
      sourceDoc = await loadPdfDocument(bytes, source.name);
      sourcePageCount = sourceDoc.getPageCount();
      const indices = parsePageRange(rangeText, sourcePageCount);

      outputDoc = await PDFDocument.create();
      const pages = await outputDoc.copyPages(sourceDoc, indices);
      for (const page of pages) {
        outputDoc.addPage(page);
      }

      selectedPageCount = outputDoc.getPageCount();
      outputDoc.setTitle(`${baseStem(source.name)} - pages ${rangeText}`);
      outputDoc.setProducer('Termux PDF & Docs Studio');
      outputDoc.setCreator('Termux PDF & Docs Studio');
      await savePdf(outputDoc, outputPath);
    } catch (err) {
      removeFileQuietly(outputPath);
      throw err;
    } finally {
      if (concurrencyLock && concurrencyLock.pdfJob && concurrencyLock.pdfJob.activeFiles && source.path) {
        concurrencyLock.pdfJob.activeFiles.delete(path.resolve(source.path));
      }
      bytes = null;
      sourceDoc = null;
      outputDoc = null;
    }

    res.json({
      success: true,
      tool: 'split',
      message: `Extracted ${selectedPageCount} page${selectedPageCount === 1 ? '' : 's'} into a new PDF.`,
      pageRange: rangeText,
      sourcePageCount,
      pageCount: selectedPageCount,
      ...describeOutput(outputPath)
    });
  }));

  router.post('/rotate', pdfConcurrencyMiddleware('PDF Rotate'), upload, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const source = await resolveSinglePdfSource(req, body);
    assertPdfLibFileSize(source.path, source.name);

    const rawAngle = getBodyValue(body, 'angle') || getBodyValue(body, 'rotation');
    const angle = parseInt(rawAngle, 10);
    if (![90, 180, 270].includes(angle)) {
      throw createHttpError(400, 'Rotation must be 90, 180, or 270 degrees.');
    }

    const isRemote = Boolean(body.isRemoteUpload || (source.isDirect && TEMP_UPLOADS_DIR && source.path.startsWith(TEMP_UPLOADS_DIR)));
    const fallbackDir = (isRemote || !source.isDirect) ? EFFECTIVE_OUTPUT_DIR : path.dirname(source.path);
    const outputDir = ensureOutputDir(
      getBodyValue(body, 'outputDir'),
      fallbackDir
    );
    const outputPath = uniqueOutputPath(outputDir, `${baseStem(source.name)}_rotated_${angle}`, '.pdf');

    let bytes = await fs.promises.readFile(source.path);
    let pdfDoc = null;
    let pageCount = 0;

    try {
      if (concurrencyLock && concurrencyLock.pdfJob && source.path) {
        concurrencyLock.pdfJob.activeFiles.add(path.resolve(source.path));
      }
      pdfDoc = await loadPdfDocument(bytes, source.name);
      pageCount = pdfDoc.getPageCount();
      for (const page of pdfDoc.getPages()) {
        const current = Number(page.getRotation().angle) || 0;
        page.setRotation(degrees(((current + angle) % 360 + 360) % 360));
      }

      pdfDoc.setProducer('Termux PDF & Docs Studio');
      pdfDoc.setCreator('Termux PDF & Docs Studio');
      await savePdf(pdfDoc, outputPath);
    } catch (err) {
      removeFileQuietly(outputPath);
      throw err;
    } finally {
      if (concurrencyLock && concurrencyLock.pdfJob && concurrencyLock.pdfJob.activeFiles && source.path) {
        concurrencyLock.pdfJob.activeFiles.delete(path.resolve(source.path));
      }
      bytes = null;
      pdfDoc = null;
    }

    res.json({
      success: true,
      tool: 'rotate',
      message: `Rotated all ${pageCount} page${pageCount === 1 ? '' : 's'} by ${angle}°.`,
      angle,
      pageCount,
      ...describeOutput(outputPath)
    });
  }));

  router.post('/images-to-pdf', pdfConcurrencyMiddleware('Images to PDF'), upload, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const sources = collectImageSources(req, body, {
      field: 'images',
      pathsField: 'imagePaths',
      minCount: 1
    });

    assertSourceBudget(sources, {
      maxFiles: MAX_IMAGES,
      fileBytes: MAX_IMAGE_FILE_BYTES,
      totalBytes: MAX_IMAGE_TOTAL_BYTES,
      label: 'images'
    });

    const isRemote = Boolean(body.isRemoteUpload);
    const outputDir = ensureOutputDir(getBodyValue(body, 'outputDir'), directFallbackDir(sources, isRemote));
    const outputPath = uniqueOutputPath(outputDir, `images_${timestamp()}`, '.pdf');
    let pdfDoc = await PDFDocument.create();
    let totalImagePixels = 0;
    let finalPageCount = 0;

    try {
      if (concurrencyLock && concurrencyLock.pdfJob) {
        for (const s of sources) {
          if (s.kind === 'direct' && s.path) concurrencyLock.pdfJob.activeFiles.add(path.resolve(s.path));
        }
      }
      for (const source of sources) {
        let bytes = await readSource(source);
        let image = null;
        try {
          const dimensions = readImageDimensions(bytes, source.ext);
          if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
            const pixels = dimensions.width * dimensions.height;
            if (pixels > MAX_IMAGE_PIXELS) {
              throw createHttpError(413, `${sourceLabel(source)} is ${dimensions.width}×${dimensions.height}. Resize images above ${MAX_IMAGE_PIXELS} pixels before converting.`);
            }
            totalImagePixels += pixels;
            if (totalImagePixels > MAX_TOTAL_IMAGE_PIXELS) {
              throw createHttpError(413, 'The selected images are too large in total resolution for this device. Use fewer or smaller images.');
            }
          }
          image = await embedImage(pdfDoc, bytes, source.ext, sourceLabel(source));
        } finally {
          bytes = null;
        }

        // Handle both portrait and landscape orientation gracefully without stretching
        const isLandscape = image.width > image.height;
        const pageWidth = isLandscape ? A4_PAGE_HEIGHT : A4_PAGE_WIDTH;
        const pageHeight = isLandscape ? A4_PAGE_WIDTH : A4_PAGE_HEIGHT;
        const scaledDims = image.scaleToFit(pageWidth - 40, pageHeight - 40);

        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        page.drawImage(image, {
          x: (pageWidth - scaledDims.width) / 2,
          y: (pageHeight - scaledDims.height) / 2,
          width: scaledDims.width,
          height: scaledDims.height
        });
        image = null; // Free image buffer reference after draw
      }

      finalPageCount = pdfDoc.getPageCount();
      pdfDoc.setTitle('Images to PDF');
      pdfDoc.setProducer('Termux PDF & Docs Studio');
      pdfDoc.setCreator('Termux PDF & Docs Studio');
      await savePdf(pdfDoc, outputPath);
    } catch (err) {
      removeFileQuietly(outputPath);
      throw err;
    } finally {
      if (concurrencyLock && concurrencyLock.pdfJob && concurrencyLock.pdfJob.activeFiles) {
        for (const s of sources) {
          if (s.kind === 'direct' && s.path) concurrencyLock.pdfJob.activeFiles.delete(path.resolve(s.path));
        }
      }
      pdfDoc = null;
    }

    res.json({
      success: true,
      tool: 'images-to-pdf',
      message: `Converted ${sources.length} image${sources.length === 1 ? '' : 's'} into a PDF.`,
      sourceCount: sources.length,
      pageCount: finalPageCount,
      ...describeOutput(outputPath)
    });
  }));

  router.post('/pdf-to-images', pdfConcurrencyMiddleware('PDF to Images'), upload, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const directPath = getBodyValue(body, 'inputPath') || getBodyValue(body, 'filePath');
    const uploadFile = getFirstUpload(req, 'file');
    let sourcePath = directPath ? resolveInputFile(directPath, PDF_EXTS, 'PDF file') : null;
    let sourceName = sourcePath ? path.basename(sourcePath) : '';

    if (!sourcePath) {
      if (!uploadFile) {
        throw createHttpError(400, 'Select a PDF file or upload one.');
      }
      validateExtension(uploadFile.name, PDF_EXTS, 'PDF file');
      sourcePath = await materializeUpload(uploadFile, '.pdf');
      sourceName = uploadFile.name;
    }

    const dpi = parsePositiveInt(body.dpi, 150, 36, 600);
    const firstPage = parseOptionalPage(body.firstPage);
    const lastPage = parseOptionalPage(body.lastPage);

    if (firstPage && lastPage && firstPage > lastPage) {
      throw createHttpError(400, 'First page cannot be greater than last page.');
    }

    const isRemote = Boolean(body.isRemoteUpload || (directPath && TEMP_UPLOADS_DIR && directPath.startsWith(TEMP_UPLOADS_DIR)));
    const fallbackDir = (isRemote || !directPath) ? EFFECTIVE_OUTPUT_DIR : path.dirname(sourcePath);
    const parentDir = ensureOutputDir(getBodyValue(body, 'outputDir'), fallbackDir);
    const outputDir = uniqueOutputDir(parentDir, baseStem(sourceName));
    const prefix = path.join(outputDir, 'page');

    const formatFlag = (body.format && String(body.format).toLowerCase() === 'png') ? '-png' : '-jpeg';
    const args = [formatFlag, '-r', String(dpi)];
    if (firstPage) args.push('-f', String(firstPage));
    if (lastPage) args.push('-l', String(lastPage));
    args.push(sourcePath, prefix);

    try {
      if (concurrencyLock && concurrencyLock.pdfJob && sourcePath) {
        concurrencyLock.pdfJob.activeFiles.add(path.resolve(sourcePath));
      }

      await new Promise((resolve, reject) => {
        const proc = spawn('pdftoppm', args, {
          windowsHide: true
        });

        let stderr = '';
        let stdout = '';

        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });

        const timeout = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (e) {}
          reject(createHttpError(504, 'PDF to image conversion timed out after 3 minutes.'));
        }, 180000);

        proc.on('error', (err) => {
          clearTimeout(timeout);
          if (err.code === 'ENOENT') {
            return reject(createHttpError(503, 'pdftoppm is not installed. Run: pkg install poppler'));
          }
          reject(createHttpError(500, `pdftoppm failed to start: ${err.message}`));
        });

        let isDone = false;
        const abortHandler = () => {
          if (!isDone && !res.writableEnded && !proc.killed) {
            try { proc.kill('SIGKILL'); } catch (e) {}
          }
        };
        res.once('close', abortHandler);

        proc.on('close', (code) => {
          isDone = true;
          clearTimeout(timeout);
          res.off('close', abortHandler);

          // Check if images were written even if poppler exited with non-zero due to benign syntax/font warnings
          const generated = fs.existsSync(outputDir)
            ? fs.readdirSync(outputDir).filter((name) => /\.(jpe?g|png)$/i.test(name))
            : [];

          if (code === 0 || generated.length > 0) {
            return resolve({ stdout, stderr, count: generated.length });
          }

          const lines = String(stderr || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
          const detail = lines.length > 0 ? lines[lines.length - 1] : `pdftoppm exited with code ${code}`;
          const isEncrypted = /password|encrypted/i.test(stderr);
          reject(createHttpError(isEncrypted ? 400 : 500, isEncrypted ? 'The PDF is encrypted. Please unlock it first.' : `PDF to image conversion failed: ${detail}`));
        });
      });
    } catch (err) {
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch (cleanupErr) {}
      // NOTE: Do NOT delete sourcePath here! The uploaded input file must remain in temp_uploads
      // so the user can retry without encountering a 404 error.
      throw err;
    } finally {
      if (concurrencyLock && concurrencyLock.pdfJob && concurrencyLock.pdfJob.activeFiles && sourcePath) {
        concurrencyLock.pdfJob.activeFiles.delete(path.resolve(sourcePath));
      }
    }

    const files = fs.readdirSync(outputDir)
      .filter((name) => /\.(jpe?g|png)$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map((name) => {
        const filePath = path.join(outputDir, name);
        const stats = fileInfo(filePath);
        return {
          name,
          path: filePath,
          size: stats.size,
          sizeFormatted: stats.sizeFormatted,
          downloadUrl: buildDownloadUrl(filePath, true),
          previewUrl: buildDownloadUrl(filePath, false)
        };
      });

    if (files.length === 0) {
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch (cleanupErr) {}
      throw createHttpError(500, 'No images were produced. The PDF may be encrypted or the page range may be empty.');
    }

    res.json({
      success: true,
      tool: 'pdf-to-images',
      message: `Converted ${files.length} page${files.length === 1 ? '' : 's'} to JPG.`,
      outputDir,
      outputPath: outputDir,
      fileCount: files.length,
      files
    });
  }));

  router.use((err, req, res, next) => {
    if (concurrencyLock && typeof concurrencyLock.releasePdfLock === 'function') {
      try { concurrencyLock.releasePdfLock(); } catch (e) {}
    }
    cleanupUploads(req);
    if (res.headersSent) return next(err);
    if (err.code === 'ENOSPC' || (err.message && err.message.includes('ENOSPC'))) {
      return res.status(507).json({ success: false, error: 'Upload failed: Not enough storage space on the server.' });
    }
    const status = err.status || (err.name === 'AbortError' ? 413 : 500);
    const message = err.status ? err.message : `PDF operation failed: ${err.message}`;
    res.status(status).json({ success: false, error: message });
  });

  return router;
}

module.exports = { createPdfRouter, PDF_EXTS, IMAGE_EXTS };
