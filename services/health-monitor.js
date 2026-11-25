'use strict';

const os = require('os');
const { execFile, execSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { databaseManager } = require('../database/database');
const { queueManager } = require('./queue-manager');
const { cleanupManager } = require('./cleanup-manager');

const MEMORY_WARNING_THRESHOLD_BYTES = parseInt(process.env.MEMORY_WARNING_THRESHOLD_MB, 10) * 1024 * 1024 || 512 * 1024 * 1024; // 512 MB
const DISK_LOW_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB

class HealthMonitor {
  constructor(options = {}) {
    this.startTime = Date.now();
    this.db = options.db || databaseManager;
    this.queue = options.queue || queueManager;
    this.cleanup = options.cleanup || cleanupManager;
    this._cachedFfmpeg = null;
    this._ffmpegCheckTime = 0;
  }

  getUptimeSeconds() {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  formatDuration(seconds) {
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor((seconds / 3600) % 24);
    const d = Math.floor(seconds / 86400);

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  }

  formatBytes(bytes) {
    if (bytes === 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  checkDatabase() {
    try {
      if (!this.db || !this.db.db) return { status: 'down', error: 'Database not initialized' };
      const row = this.db.db.prepare('SELECT 1 as ok').get();
      return { status: row && row.ok === 1 ? 'healthy' : 'degraded' };
    } catch (e) {
      return { status: 'down', error: e.message };
    }
  }

  async checkFFmpegAsync() {
    const now = Date.now();
    if (this._cachedFfmpeg && (now - this._ffmpegCheckTime < 60000)) {
      return this._cachedFfmpeg;
    }

    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: 3000 });
      const firstLine = String(stdout || '').split('\n')[0] || '';
      const versionMatch = firstLine.match(/ffmpeg version\s+([^\s]+)/i);
      const version = versionMatch ? versionMatch[1] : 'installed';
      this._cachedFfmpeg = { status: 'available', version };
    } catch (e) {
      this._cachedFfmpeg = { status: 'unavailable', error: 'ffmpeg command not found or failed' };
    }
    this._ffmpegCheckTime = now;
    return this._cachedFfmpeg;
  }

  checkFFmpeg() {
    const now = Date.now();
    // Cache for 60 seconds
    if (this._cachedFfmpeg && (now - this._ffmpegCheckTime < 60000)) {
      return this._cachedFfmpeg;
    }

    try {
      const output = execSync('ffmpeg -version 2>/dev/null', { timeout: 3000 }).toString();
      const firstLine = output.split('\n')[0] || '';
      const versionMatch = firstLine.match(/ffmpeg version\s+([^\s]+)/i);
      const version = versionMatch ? versionMatch[1] : 'installed';
      this._cachedFfmpeg = { status: 'available', version };
    } catch (e) {
      this._cachedFfmpeg = { status: 'unavailable', error: 'ffmpeg command not found or failed' };
    }
    this._ffmpegCheckTime = now;
    return this._cachedFfmpeg;
  }

  getMemoryInfo() {
    const mem = process.memoryUsage();
    const systemFree = os.freemem();
    const systemTotal = os.totalmem();

    return {
      process: {
        rss: mem.rss,
        rssFormatted: this.formatBytes(mem.rss),
        heapTotal: mem.heapTotal,
        heapTotalFormatted: this.formatBytes(mem.heapTotal),
        heapUsed: mem.heapUsed,
        heapUsedFormatted: this.formatBytes(mem.heapUsed),
        external: mem.external,
        externalFormatted: this.formatBytes(mem.external)
      },
      system: {
        freeBytes: systemFree,
        freeFormatted: this.formatBytes(systemFree),
        totalBytes: systemTotal,
        totalFormatted: this.formatBytes(systemTotal),
        usedPercentage: Math.round(((systemTotal - systemFree) / systemTotal) * 100)
      }
    };
  }

  getSystemWarnings() {
    const warnings = [];
    const mem = process.memoryUsage();
    if (mem.rss > MEMORY_WARNING_THRESHOLD_BYTES) {
      warnings.push(`Process memory usage is high (${this.formatBytes(mem.rss)})`);
    }

    const storageStats = this.cleanup.getStorageStats();
    if (storageStats.diskStorage && storageStats.diskStorage.freeBytes > 0 && storageStats.diskStorage.freeBytes < DISK_LOW_THRESHOLD_BYTES) {
      warnings.push(`Low disk space warning: only ${storageStats.diskStorage.freeFormatted} available`);
    }

    const qStatus = this.queue.getStatus();
    if (qStatus.queuedCount > 20) {
      warnings.push(`Queue backlog is high (${qStatus.queuedCount} jobs queued)`);
    }

    const ffmpegStatus = this.checkFFmpeg();
    if (ffmpegStatus.status !== 'available') {
      warnings.push('FFmpeg binary is unavailable');
    }

    const dbStatus = this.checkDatabase();
    if (dbStatus.status !== 'healthy') {
      warnings.push(`Database issue: ${dbStatus.error || dbStatus.status}`);
    }

    return warnings;
  }

  getHealthSummary() {
    const uptimeSec = this.getUptimeSeconds();
    const dbStatus = this.checkDatabase();
    const ffmpegStatus = this.checkFFmpeg();
    const memory = this.getMemoryInfo();
    const storage = this.cleanup.getStorageStats();
    const queue = this.queue.getStatus();
    const warnings = this.getSystemWarnings();

    const isHealthy = dbStatus.status === 'healthy' && ffmpegStatus.status === 'available' && warnings.length === 0;

    return {
      status: isHealthy ? 'healthy' : (warnings.length > 0 && dbStatus.status === 'healthy' ? 'degraded' : 'unhealthy'),
      uptime: {
        seconds: uptimeSec,
        formatted: this.formatDuration(uptimeSec)
      },
      timestamp: Date.now(),
      platform: {
        os: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        isTermux: Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes('com.termux'))
      },
      database: dbStatus,
      ffmpeg: ffmpegStatus,
      memory,
      queue: {
        active: queue.activeCount,
        queued: queue.queuedCount,
        maxConcurrency: queue.maxConcurrency
      },
      storage: {
        totalAppUsage: storage.totalAppStorage.formatted,
        diskFree: storage.diskStorage.freeFormatted,
        diskTotal: storage.diskStorage.totalFormatted
      },
      warnings
    };
  }

  getLiveness() {
    return {
      status: 'ok',
      uptime: this.getUptimeSeconds()
    };
  }

  async getSystemWarningsAsync(storageStatsOverride = null, ffmpegStatusOverride = null) {
    const warnings = [];
    const mem = process.memoryUsage();
    if (mem.rss > MEMORY_WARNING_THRESHOLD_BYTES) {
      warnings.push(`Process memory usage is high (${this.formatBytes(mem.rss)})`);
    }

    const storageStats = storageStatsOverride || await this.cleanup.getStorageStatsAsync();
    if (storageStats.diskStorage && storageStats.diskStorage.freeBytes > 0 && storageStats.diskStorage.freeBytes < DISK_LOW_THRESHOLD_BYTES) {
      warnings.push(`Low disk space warning: only ${storageStats.diskStorage.freeFormatted} available`);
    }

    const qStatus = this.queue.getStatus();
    if (qStatus.queuedCount > 20) {
      warnings.push(`Queue backlog is high (${qStatus.queuedCount} jobs queued)`);
    }

    const ffmpegStatus = ffmpegStatusOverride || await this.checkFFmpegAsync();
    if (ffmpegStatus.status !== 'available') {
      warnings.push('FFmpeg binary is unavailable');
    }

    const dbStatus = this.checkDatabase();
    if (dbStatus.status !== 'healthy') {
      warnings.push(`Database issue: ${dbStatus.error || dbStatus.status}`);
    }

    return warnings;
  }

  async getHealthSummaryAsync() {
    const uptimeSec = this.getUptimeSeconds();
    const dbStatus = this.checkDatabase();
    const [ffmpegStatus, storage] = await Promise.all([
      this.checkFFmpegAsync(),
      this.cleanup.getStorageStatsAsync()
    ]);
    const memory = this.getMemoryInfo();
    const queue = this.queue.getStatus();
    const warnings = await this.getSystemWarningsAsync(storage, ffmpegStatus);

    const isHealthy = dbStatus.status === 'healthy' && ffmpegStatus.status === 'available' && warnings.length === 0;

    return {
      status: isHealthy ? 'healthy' : (warnings.length > 0 && dbStatus.status === 'healthy' ? 'degraded' : 'unhealthy'),
      uptime: {
        seconds: uptimeSec,
        formatted: this.formatDuration(uptimeSec)
      },
      timestamp: Date.now(),
      platform: {
        os: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        isTermux: Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes('com.termux'))
      },
      database: dbStatus,
      ffmpeg: ffmpegStatus,
      memory,
      queue: {
        active: queue.activeCount,
        queued: queue.queuedCount,
        maxConcurrency: queue.maxConcurrency
      },
      storage: {
        totalAppUsage: storage.totalAppStorage.formatted,
        diskFree: storage.diskStorage.freeFormatted,
        diskTotal: storage.diskStorage.totalFormatted
      },
      warnings
    };
  }

  async getReadinessAsync() {
    const dbStatus = this.checkDatabase();
    const [ffmpegStatus, storage] = await Promise.all([
      this.checkFFmpegAsync(),
      this.cleanup.getStorageStatsAsync()
    ]);

    const isReady = dbStatus.status === 'healthy' && ffmpegStatus.status === 'available';

    return {
      ready: isReady,
      database: dbStatus.status,
      ffmpeg: ffmpegStatus.status,
      diskFree: storage.diskStorage.freeFormatted
    };
  }

  getReadiness() {
    const dbStatus = this.checkDatabase();
    const ffmpegStatus = this.checkFFmpeg();
    const storage = this.cleanup.getStorageStats();

    const isReady = dbStatus.status === 'healthy' && ffmpegStatus.status === 'available';

    return {
      ready: isReady,
      database: dbStatus.status,
      ffmpeg: ffmpegStatus.status,
      diskFree: storage.diskStorage.freeFormatted
    };
  }
}

const defaultHealthMonitor = new HealthMonitor();

module.exports = {
  HealthMonitor,
  healthMonitor: defaultHealthMonitor
};
