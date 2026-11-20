'use strict';

const os = require('os');
const { databaseManager } = require('../database/database');
const { queueManager } = require('./queue-manager');
const { cleanupManager } = require('./cleanup-manager');

class AnalyticsService {
  constructor(options = {}) {
    this.db = options.db || databaseManager;
    this.queue = options.queue || queueManager;
    this.cleanup = options.cleanup || cleanupManager;
    this.startTime = Date.now();

    this._cachedStorageStats = null;
    this._storageCacheTime = 0;
  }

  formatBytes(bytes) {
    if (bytes === 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  getDashboardStats() {
    const now = Date.now();
    const uptimeSec = Math.floor((now - this.startTime) / 1000);

    // 1. Server & System stats
    const mem = process.memoryUsage();
    const systemFree = os.freemem();
    const systemTotal = os.totalmem();
    let loadAvg = [0, 0, 0];
    try { loadAvg = os.loadavg(); } catch (e) {}

    const serverStats = {
      uptimeSeconds: uptimeSec,
      nodeVersion: process.version,
      platform: `${process.platform} (${process.arch})`,
      isTermux: Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes('com.termux')),
      loadAverage: loadAvg,
      cpuCount: os.cpus() ? os.cpus().length : 1,
      processMemory: {
        rss: mem.rss,
        rssFormatted: this.formatBytes(mem.rss),
        heapUsed: mem.heapUsed,
        heapUsedFormatted: this.formatBytes(mem.heapUsed),
        heapTotal: mem.heapTotal,
        heapTotalFormatted: this.formatBytes(mem.heapTotal)
      },
      systemMemory: {
        freeBytes: systemFree,
        freeFormatted: this.formatBytes(systemFree),
        totalBytes: systemTotal,
        totalFormatted: this.formatBytes(systemTotal),
        usedPercent: Math.round(((systemTotal - systemFree) / systemTotal) * 100)
      },
      status: 'online'
    };

    // 2. Processing & Jobs summary from SQLite
    const summary = this.db.getAnalyticsSummary();
    const qStatus = this.queue.getStatus();

    const processingStats = {
      totalJobs: summary.jobs.total,
      completedJobs: summary.jobs.completed,
      failedJobs: summary.jobs.failed,
      cancelledJobs: summary.jobs.cancelled,
      interruptedJobs: summary.jobs.interrupted,
      currentlyProcessing: qStatus.activeCount,
      queuedJobs: qStatus.queuedCount,
      avgProcessingTimeSeconds: summary.jobs.avgDurationMs ? Math.round(summary.jobs.avgDurationMs / 1000) : 0,
      totalProcessedMediaSize: this.formatBytes(summary.totalBytesProcessed),
      recentErrors: summary.recentErrors
    };

    // 3. Queue & FFmpeg stats
    const ffmpegStats = {
      activeWorkers: qStatus.activeCount,
      maxConcurrency: qStatus.maxConcurrency,
      queueLength: qStatus.queuedCount,
      activeJobs: qStatus.activeJobs
    };

    // 4. Storage stats (cached for 15s)
    if (!this._cachedStorageStats || (now - this._storageCacheTime > 15000)) {
      this._cachedStorageStats = this.cleanup.getStorageStats();
      this._storageCacheTime = now;
    }

    return {
      timestamp: now,
      server: serverStats,
      processing: processingStats,
      ffmpeg: ffmpegStats,
      storage: this._cachedStorageStats
    };
  }

  recordEvent(event) {
    this.db.recordAnalyticsEvent(event);
  }
}

const defaultAnalyticsService = new AnalyticsService();

module.exports = {
  AnalyticsService,
  analyticsService: defaultAnalyticsService
};
