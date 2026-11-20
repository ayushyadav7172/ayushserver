'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { CleanupManager } = require('../../services/cleanup-manager');

describe('Centralized Cleanup Manager', () => {
  let cm;
  let testTempDir;

  before(() => {
    testTempDir = path.join(os.tmpdir(), `test_cleanup_${Date.now()}`);
    fs.mkdirSync(testTempDir, { recursive: true });

    cm = new CleanupManager({
      rootDir: testTempDir,
      tempUploadsDir: path.join(testTempDir, 'temp_uploads'),
      tempPdfUploadsDir: path.join(testTempDir, 'temp_pdf_uploads'),
      tempThumbsDir: path.join(testTempDir, 'temp_thumbs'),
      processedDir: path.join(testTempDir, 'processed'),
      pdfOutputsDir: path.join(testTempDir, 'pdf_outputs'),
      cleanupIntervalMs: 60000,
      retentionMs: 100 // 100ms for quick test
    });

    fs.mkdirSync(cm.tempUploadsDir, { recursive: true });
    fs.mkdirSync(cm.tempPdfUploadsDir, { recursive: true });
    fs.mkdirSync(cm.tempThumbsDir, { recursive: true });
  });

  after(() => {
    if (cm) cm.stopScheduler();
    if (testTempDir && fs.existsSync(testTempDir)) {
      try { fs.rmSync(testTempDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('deletes expired temporary files past retention period', async () => {
    const expiredFile = path.join(cm.tempUploadsDir, 'old_upload.mp4');
    fs.writeFileSync(expiredFile, 'dummy content');
    // Set mtime to 1 minute in the past
    const pastTime = (Date.now() - 60000) / 1000;
    fs.utimesSync(expiredFile, pastTime, pastTime);

    const summary = await cm.runCleanup();
    assert.equal(fs.existsSync(expiredFile), false);
    assert.ok(summary.totalDeleted >= 1);
  });

  test('protects active files from deletion', async () => {
    const activeFile = path.join(cm.tempUploadsDir, 'active_job.mp4');
    fs.writeFileSync(activeFile, 'in-flight upload');

    // Register active file hook
    cm.init((filePath) => path.resolve(filePath) === path.resolve(activeFile));

    const pastTime = (Date.now() - 60000) / 1000;
    fs.utimesSync(activeFile, pastTime, pastTime);

    await cm.runCleanup({ force: true });
    assert.equal(fs.existsSync(activeFile), true, 'Active file should NOT be deleted');

    // Clean up
    fs.unlinkSync(activeFile);
  });

  test('protects files outside allowed directory (prevents path escapes)', () => {
    const outsideFile = path.join(os.tmpdir(), 'do_not_delete.txt');
    fs.writeFileSync(outsideFile, 'safe');

    assert.equal(cm.isSafeToDelete(outsideFile, cm.tempUploadsDir), false);

    fs.unlinkSync(outsideFile);
  });

  test('calculates accurate directory storage statistics', () => {
    const testFile = path.join(cm.tempThumbsDir, 'thumb1.jpg');
    fs.writeFileSync(testFile, Buffer.alloc(1024)); // 1 KB

    const stats = cm.getStorageStats();
    assert.ok(stats.tempThumbs.bytes >= 1024);
    assert.ok(stats.diskStorage.totalBytes > 0);

    fs.unlinkSync(testFile);
  });
});
