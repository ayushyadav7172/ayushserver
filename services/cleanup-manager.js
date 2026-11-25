'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { databaseManager } = require('../database/database');

const DEFAULT_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_RETENTION_MS = 30 * 60 * 1000; // 30 minutes

class CleanupManager {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, '..');
    this.tempUploadsDir = options.tempUploadsDir || path.join(this.rootDir, 'temp_uploads');
    this.tempPdfUploadsDir = options.tempPdfUploadsDir || path.join(this.rootDir, 'temp_pdf_uploads');
    this.tempThumbsDir = options.tempThumbsDir || path.join(this.rootDir, 'temp_thumbs');
    this.processedDir = options.processedDir || path.join(this.rootDir, 'processed');
    this.pdfOutputsDir = options.pdfOutputsDir || path.join(this.rootDir, 'pdf_outputs');

    this.cleanupIntervalMs = options.cleanupIntervalMs || DEFAULT_CLEANUP_INTERVAL_MS;
    this.retentionMs = options.retentionMs || DEFAULT_RETENTION_MS;
    this.timer = null;
    this.lastCleanupResult = null;
    this.activeJobChecker = null; // optional hook provided by server
  }

  init(activeJobChecker = null) {
    this.activeJobChecker = activeJobChecker;
    this.startScheduler();
    console.log(`[CleanupManager] Initialized with ${Math.round(this.cleanupIntervalMs / 60000)}m interval and ${Math.round(this.retentionMs / 60000)}m retention.`);
    return this;
  }

  setRetention(retentionMinutes) {
    const min = parseInt(retentionMinutes, 10);
    if (isNaN(min) || min < 1) {
      throw new Error('Retention must be at least 1 minute');
    }
    this.retentionMs = min * 60 * 1000;
    databaseManager.setSetting('cleanup_retention_minutes', min);
    return this.retentionMs;
  }

  startScheduler() {
    this.stopScheduler();
    this.timer = setInterval(() => {
      this.runCleanup().catch(err => {
        console.error('[CleanupManager] Scheduled cleanup error:', err.message);
      });
    }, this.cleanupIntervalMs);
    // Don't keep the event loop alive if nothing else is running
    if (this.timer && this.timer.unref) {
      this.timer.unref();
    }
  }

  stopScheduler() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isFileBeingWritten(filePath, initialStats) {
    if (!filePath) return false;
    try {
      const s1 = initialStats || fs.statSync(filePath);
      if (s1.isDirectory()) return false;
      // If modified in the last 15 seconds, it is actively being written
      if (Date.now() - (s1.mtimeMs || 0) < 15000) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  isFileActive(filePath) {
    if (!filePath) return false;
    const resolved = path.resolve(filePath);

    if (this.activeJobChecker) {
      try {
        if (this.activeJobChecker(resolved)) return true;
      } catch (e) {}
    }

    return false;
  }

  isSafeToDelete(filePath, parentDir) {
    if (!filePath || !parentDir) return false;

    try {
      const resolvedTarget = path.resolve(filePath);
      const resolvedParent = path.resolve(parentDir);

      // Must be inside parent directory
      if (!resolvedTarget.startsWith(resolvedParent + path.sep)) {
        return false;
      }

      // Check if it's a symlink pointing outside
      const lstat = fs.lstatSync(resolvedTarget);
      if (lstat.isSymbolicLink()) {
        const realTarget = fs.realpathSync(resolvedTarget);
        if (!realTarget.startsWith(resolvedParent + path.sep)) {
          return false;
        }
      }

      // Check if active or being written
      if (this.isFileActive(resolvedTarget)) {
        return false;
      }

      if (this.isFileBeingWritten(resolvedTarget, lstat)) {
        return false;
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  cleanDirectory(dirPath, options = {}) {
    const { retentionMs = this.retentionMs, removeEmptyDirs = false, force = false } = options;
    const stats = { scanned: 0, deleted: 0, bytesFreed: 0, errors: [] };

    if (!fs.existsSync(dirPath)) return stats;

    const now = Date.now();
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      stats.errors.push(`Read error on ${dirPath}: ${err.message}`);
      return stats;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      stats.scanned++;

      try {
        if (entry.isDirectory()) {
          const subStats = this.cleanDirectory(fullPath, options);
          stats.scanned += subStats.scanned;
          stats.deleted += subStats.deleted;
          stats.bytesFreed += subStats.bytesFreed;
          stats.errors.push(...subStats.errors);

          if (removeEmptyDirs) {
            try {
              if (fs.readdirSync(fullPath).length === 0) {
                fs.rmdirSync(fullPath);
              }
            } catch (e) {}
          }
          continue;
        }

        const lstat = fs.lstatSync(fullPath);
        const age = now - (lstat.mtimeMs || lstat.ctimeMs || now);

        if (!force && age < retentionMs) {
          continue;
        }

        if (!this.isSafeToDelete(fullPath, dirPath)) {
          continue;
        }

        const size = lstat.size || 0;
        fs.unlinkSync(fullPath);
        stats.deleted++;
        stats.bytesFreed += size;
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          stats.errors.push(`Failed to delete ${fullPath}: ${err.message}`);
        }
      }
    }

    return stats;
  }

  async runCleanup(options = {}) {
    const startTime = Date.now();
    console.log('[CleanupManager] Starting cleanup cycle...');

    const summary = {
      tempUploads: this.cleanDirectory(this.tempUploadsDir, options),
      tempPdfUploads: this.cleanDirectory(this.tempPdfUploadsDir, options),
      tempThumbs: this.cleanDirectory(this.tempThumbsDir, options),
      timestamp: startTime,
      durationMs: 0,
      totalDeleted: 0,
      totalBytesFreed: 0,
      errors: []
    };

    summary.totalDeleted = summary.tempUploads.deleted + summary.tempPdfUploads.deleted + summary.tempThumbs.deleted;
    summary.totalBytesFreed = summary.tempUploads.bytesFreed + summary.tempPdfUploads.bytesFreed + summary.tempThumbs.bytesFreed;
    summary.errors = [
      ...summary.tempUploads.errors,
      ...summary.tempPdfUploads.errors,
      ...summary.tempThumbs.errors
    ];
    summary.durationMs = Date.now() - startTime;

    this.lastCleanupResult = summary;
    console.log(`[CleanupManager] Cycle finished: ${summary.totalDeleted} file(s) deleted, ${this.formatBytes(summary.totalBytesFreed)} freed in ${summary.durationMs}ms.`);

    return summary;
  }

  getDirectorySize(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    try {
      const files = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const f of files) {
        const full = path.join(dirPath, f.name);
        try {
          if (f.isDirectory()) {
            total += this.getDirectorySize(full);
          } else {
            const stat = fs.statSync(full);
            total += stat.size || 0;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return total;
  }

  async getDirectorySizeAsync(dirPath) {
    try {
      const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
      let total = 0;
      for (const f of files) {
        const full = path.join(dirPath, f.name);
        try {
          if (f.isDirectory()) {
            total += await this.getDirectorySizeAsync(full);
          } else {
            const stat = await fs.promises.stat(full);
            total += stat.size || 0;
          }
        } catch (e) {}
      }
      return total;
    } catch (e) {
      return 0;
    }
  }

  async getStorageStatsAsync() {
    const [
      tempUploadsSize,
      tempPdfUploadsSize,
      tempThumbsSize,
      processedSize,
      pdfOutputsSize,
      diskInfo
    ] = await Promise.all([
      this.getDirectorySizeAsync(this.tempUploadsDir),
      this.getDirectorySizeAsync(this.tempPdfUploadsDir),
      this.getDirectorySizeAsync(this.tempThumbsDir),
      this.getDirectorySizeAsync(this.processedDir),
      this.getDirectorySizeAsync(this.pdfOutputsDir),
      (async () => {
        try {
          const { stdout } = await execFileAsync('df', ['-k', this.rootDir], { timeout: 3000 });
          const lines = String(stdout || '').trim().split('\n');
          if (lines.length >= 2) {
            const parts = lines[1].trim().split(/\s+/);
            if (parts.length >= 4) {
              return {
                totalDiskBytes: parseInt(parts[1], 10) * 1024,
                freeDiskBytes: parseInt(parts[3], 10) * 1024
              };
            }
          }
        } catch (e) {}
        return { totalDiskBytes: 0, freeDiskBytes: 0 };
      })()
    ]);

    const { totalDiskBytes, freeDiskBytes } = diskInfo;
    const totalAppUsage = tempUploadsSize + tempPdfUploadsSize + tempThumbsSize + processedSize + pdfOutputsSize;

    return {
      tempUploads: {
        bytes: tempUploadsSize,
        formatted: this.formatBytes(tempUploadsSize)
      },
      tempPdfUploads: {
        bytes: tempPdfUploadsSize,
        formatted: this.formatBytes(tempPdfUploadsSize)
      },
      tempThumbs: {
        bytes: tempThumbsSize,
        formatted: this.formatBytes(tempThumbsSize)
      },
      processed: {
        bytes: processedSize,
        formatted: this.formatBytes(processedSize)
      },
      pdfOutputs: {
        bytes: pdfOutputsSize,
        formatted: this.formatBytes(pdfOutputsSize)
      },
      totalAppStorage: {
        bytes: totalAppUsage,
        formatted: this.formatBytes(totalAppUsage)
      },
      diskStorage: {
        totalBytes: totalDiskBytes,
        totalFormatted: this.formatBytes(totalDiskBytes),
        freeBytes: freeDiskBytes,
        freeFormatted: this.formatBytes(freeDiskBytes)
      },
      lastCleanup: this.lastCleanupResult,
      retentionMinutes: Math.round(this.retentionMs / 60000)
    };
  }

  getStorageStats() {
    const tempUploadsSize = this.getDirectorySize(this.tempUploadsDir);
    const tempPdfUploadsSize = this.getDirectorySize(this.tempPdfUploadsDir);
    const tempThumbsSize = this.getDirectorySize(this.tempThumbsDir);
    const processedSize = this.getDirectorySize(this.processedDir);
    const pdfOutputsSize = this.getDirectorySize(this.pdfOutputsDir);

    let freeDiskBytes = 0;
    let totalDiskBytes = 0;

    try {
      const dfOutput = execSync(`df -k "${this.rootDir}" 2>/dev/null`).toString();
      const lines = dfOutput.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        if (parts.length >= 4) {
          totalDiskBytes = parseInt(parts[1], 10) * 1024;
          freeDiskBytes = parseInt(parts[3], 10) * 1024;
        }
      }
    } catch (e) {}

    const totalAppUsage = tempUploadsSize + tempPdfUploadsSize + tempThumbsSize + processedSize + pdfOutputsSize;

    return {
      tempUploads: {
        bytes: tempUploadsSize,
        formatted: this.formatBytes(tempUploadsSize)
      },
      tempPdfUploads: {
        bytes: tempPdfUploadsSize,
        formatted: this.formatBytes(tempPdfUploadsSize)
      },
      tempThumbs: {
        bytes: tempThumbsSize,
        formatted: this.formatBytes(tempThumbsSize)
      },
      processed: {
        bytes: processedSize,
        formatted: this.formatBytes(processedSize)
      },
      pdfOutputs: {
        bytes: pdfOutputsSize,
        formatted: this.formatBytes(pdfOutputsSize)
      },
      totalAppStorage: {
        bytes: totalAppUsage,
        formatted: this.formatBytes(totalAppUsage)
      },
      diskStorage: {
        totalBytes: totalDiskBytes,
        totalFormatted: this.formatBytes(totalDiskBytes),
        freeBytes: freeDiskBytes,
        freeFormatted: this.formatBytes(freeDiskBytes)
      },
      lastCleanup: this.lastCleanupResult,
      retentionMinutes: Math.round(this.retentionMs / 60000)
    };
  }

  formatBytes(bytes) {
    if (bytes === 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

const defaultCleanupManager = new CleanupManager();

module.exports = {
  CleanupManager,
  cleanupManager: defaultCleanupManager
};
