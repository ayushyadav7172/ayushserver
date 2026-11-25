'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  app,
  databaseManager,
  analyticsService,
  concurrencyLock
} = require('../../server');

describe('Image & PDF Studio Analytics Tracking', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(r => server.close(r));
    }
  });

  test('DatabaseManager summarizes image and PDF events accurately', () => {
    const testNow = Date.now();
    // Insert test events
    databaseManager.recordAnalyticsEvent({
      type: 'image',
      operation: 'convert',
      status: 'completed',
      bytesProcessed: 50000,
      durationMs: 150,
      createdAt: testNow
    });

    databaseManager.recordAnalyticsEvent({
      type: 'image',
      operation: 'resize',
      status: 'failed',
      bytesProcessed: 0,
      durationMs: 80,
      createdAt: testNow
    });

    databaseManager.recordAnalyticsEvent({
      type: 'pdf',
      operation: 'PDF Merge',
      status: 'completed',
      bytesProcessed: 120000,
      durationMs: 450,
      createdAt: testNow
    });

    const summary = databaseManager.getAnalyticsSummary();
    assert.ok(summary.image);
    assert.ok(summary.pdf);
    assert.ok(summary.image.total >= 2);
    assert.ok(summary.image.completed >= 1);
    assert.ok(summary.image.failed >= 1);
    assert.ok(summary.image.totalBytes >= 50000);

    assert.ok(summary.pdf.total >= 1);
    assert.ok(summary.pdf.completed >= 1);
    assert.ok(summary.pdf.totalBytes >= 120000);
  });

  test('AnalyticsService exposes image and pdf metrics in getDashboardStats', async () => {
    const stats = await analyticsService.getDashboardStatsAsync();
    assert.ok(stats.image);
    assert.ok(stats.pdf);

    assert.equal(stats.image.engine, 'Sharp (libvips)');
    assert.equal(typeof stats.image.totalProcessed, 'number');
    assert.equal(typeof stats.image.failed, 'number');
    assert.equal(typeof stats.image.totalProcessedSize, 'string');
    assert.equal(typeof stats.image.avgProcessingTimeSeconds, 'number');
    assert.equal(typeof stats.image.isProcessing, 'boolean');

    assert.equal(stats.pdf.engine, 'QPDF & Ghostscript');
    assert.equal(typeof stats.pdf.totalProcessed, 'number');
    assert.equal(typeof stats.pdf.failed, 'number');
    assert.equal(typeof stats.pdf.totalProcessedSize, 'string');
    assert.equal(typeof stats.pdf.avgProcessingTimeSeconds, 'number');
    assert.equal(typeof stats.pdf.isProcessing, 'boolean');
  });

  test('Analytics dynamically reflects image and PDF active lock state', () => {
    // Initially idle
    let stats = analyticsService.getDashboardStats();
    assert.equal(stats.image.isProcessing, false);
    assert.equal(stats.image.currentOperation, 'Idle');
    assert.equal(stats.pdf.isProcessing, false);
    assert.equal(stats.pdf.currentTool, 'Idle');

    // Simulate Image lock
    concurrencyLock.acquireImageLock('compress');
    stats = analyticsService.getDashboardStats();
    assert.equal(stats.image.isProcessing, true);
    assert.equal(stats.image.currentOperation, 'compress');

    concurrencyLock.releaseImageLock();
    stats = analyticsService.getDashboardStats();
    assert.equal(stats.image.isProcessing, false);
    assert.equal(stats.image.currentOperation, 'Idle');

    // Simulate PDF lock
    concurrencyLock.acquirePdfLock('PDF Split');
    stats = analyticsService.getDashboardStats();
    assert.equal(stats.pdf.isProcessing, true);
    assert.equal(stats.pdf.currentTool, 'PDF Split');

    concurrencyLock.releasePdfLock();
    stats = analyticsService.getDashboardStats();
    assert.equal(stats.pdf.isProcessing, false);
    assert.equal(stats.pdf.currentTool, 'Idle');
  });

  test('GET /api/analytics/stats serves image and pdf metrics over HTTP', async () => {
    const res = await fetch(`${baseUrl}/api/analytics/stats`, {
      headers: { 'Connection': 'close' }
    });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(data.image, 'Response should contain image stats');
    assert.ok(data.pdf, 'Response should contain pdf stats');
    assert.equal(data.image.engine, 'Sharp (libvips)');
    assert.equal(data.pdf.engine, 'QPDF & Ghostscript');
    assert.ok(data.image.totalProcessed >= 0);
    assert.ok(data.pdf.totalProcessed >= 0);
  });

  test('GET /api/queue/status returns locks and isIdle state', async () => {
    const res = await fetch(`${baseUrl}/api/queue/status`, {
      headers: { 'Connection': 'close' }
    });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(data.locks, 'Should contain locks property');
    assert.equal(typeof data.locks.media, 'boolean');
    assert.equal(typeof data.locks.image, 'boolean');
    assert.equal(typeof data.locks.pdf, 'boolean');
    assert.equal(typeof data.isIdle, 'boolean');
  });

  test('acquireImageLock and acquirePdfLock throw 409 with busy metadata when media is processing', () => {
    const originalIsMedia = concurrencyLock.isMediaProcessing;
    concurrencyLock.isMediaProcessing = () => true;

    try {
      assert.throws(() => {
        concurrencyLock.acquireImageLock('convert');
      }, (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.busy, true);
        assert.equal(err.activeType, 'media');
        assert.ok(err.queuePosition >= 1);
        return true;
      });

      assert.throws(() => {
        concurrencyLock.acquirePdfLock('PDF Merge');
      }, (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.busy, true);
        assert.equal(err.activeType, 'media');
        assert.ok(err.queuePosition >= 1);
        return true;
      });
    } finally {
      concurrencyLock.isMediaProcessing = originalIsMedia;
    }
  });
});
