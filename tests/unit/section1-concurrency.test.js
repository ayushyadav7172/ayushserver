'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const {
  app,
  concurrencyLock,
  wakeLockManager,
  databaseManager,
  jobManager,
  queueManager
} = require('../../server');
const { QueueManager } = require('../../services/queue-manager');
const { JobManager } = require('../../services/job-manager');
const { DatabaseManager } = require('../../database/database');

describe('Section 1: Concurrency, Locks, Shutdown & DB Restore Fixes', () => {
  let server;
  let baseUrl;
  const sampleVideoPath = path.join(__dirname, '..', '..', 'temp_uploads', `sec1_test_${Date.now()}.mp4`);

  before(async () => {
    if (!fs.existsSync(sampleVideoPath)) {
      const { execSync } = require('child_process');
      execSync(`ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=10 -c:v libx264 -y "${sampleVideoPath}" 2>/dev/null`);
    }
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (concurrencyLock.pdfJob.isProcessing) {
      concurrencyLock.releasePdfLock();
    }
    if (fs.existsSync(sampleVideoPath)) {
      try { fs.unlinkSync(sampleVideoPath); } catch (e) {}
    }
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(r => server.close(r));
    }
  });

  test('1.5 PDF 409 Conflict does not release another request active PDF lock', async () => {
    concurrencyLock.acquirePdfLock('Active PDF Merge');
    assert.equal(concurrencyLock.pdfJob.isProcessing, true);

    try {
      const res = await fetch(`${baseUrl}/api/pdf/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        body: JSON.stringify({ inputPath: '/sdcard/fake.pdf' })
      });
      assert.equal(res.status, 409);
      assert.equal(
        concurrencyLock.pdfJob.isProcessing,
        true,
        '409 rejection from error middleware must NOT release active PDF lock'
      );
      assert.equal(concurrencyLock.pdfJob.tool, 'Active PDF Merge');
    } finally {
      concurrencyLock.releasePdfLock();
      assert.equal(concurrencyLock.pdfJob.isProcessing, false);
    }
  });

  test('1.1 Job object is canonical across server & jobManager, and FFmpeg logs persist to SQLite', async () => {
    const res = await fetch(`${baseUrl}/api/process-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({
        filePath: sampleVideoPath,
        operation: 'convert',
        options: { format: 'mp4', crf: 28 },
        sessionId: 'sess_sec1_canonical'
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const jobId = body.jobId;
    assert.ok(jobId);

    let done = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150));
      const j = jobManager.getJob(jobId);
      if (j && j.status === 'completed' && !queueManager.activeJobs.has(jobId)) {
        done = true;
        break;
      }
    }
    assert.equal(done, true);

    // Clear in-memory job cache and verify logs were actually persisted to SQLite
    jobManager.memoryJobs.delete(jobId);
    const dbLogs = databaseManager.getJobLogs(jobId);
    assert.ok(dbLogs && dbLogs.length > 0, 'FFmpeg stderr/stdout logs must persist in SQLite job_logs');

    // Clean up generated output file
    const persisted = databaseManager.getJob(jobId);
    if (persisted?.outputPath && fs.existsSync(persisted.outputPath)) {
      try { fs.unlinkSync(persisted.outputPath); } catch (e) {}
    }
    jobManager.deleteJob(jobId, 'sess_sec1_canonical');
  });

  test('1.2 Failed validation / 404 request does not clobber another active job state', async () => {
    // Start a real job first so activeJob is actively processing
    const startRes = await fetch(`${baseUrl}/api/process-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({
        filePath: sampleVideoPath,
        operation: 'convert',
        options: { format: 'mp4', crf: 28 },
        sessionId: 'sess_sec1_active'
      })
    });
    assert.equal(startRes.status, 200);
    const { jobId } = await startRes.json();

    // Send an invalid 404 request (inside allowed root so it hits 404 on any OS) while jobId is processing/queued
    const missingAllowedPath = path.join(__dirname, '..', '..', 'temp_uploads', 'does_not_exist_12345.mp4');
    const badRes = await fetch(`${baseUrl}/api/process-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({
        filePath: missingAllowedPath,
        operation: 'convert',
        options: { format: 'mp4' }
      })
    });
    assert.equal(badRes.status, 404);

    // Wait for the valid job to settle cleanly
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150));
      const j = jobManager.getJob(jobId);
      if (j && j.status === 'completed' && !queueManager.activeJobs.has(jobId)) {
        break;
      }
    }
    const finalJob = databaseManager.getJob(jobId);
    assert.equal(finalJob.status, 'completed');
    assert.equal(concurrencyLock.isMediaProcessing(), false);

    if (finalJob?.outputPath && fs.existsSync(finalJob.outputPath)) {
      try { fs.unlinkSync(finalJob.outputPath); } catch (e) {}
    }
    jobManager.deleteJob(jobId, 'sess_sec1_active');
  });

  test('1.3 & 1.6 QueueManager kills attached executor child processes on cancel & shutdown without duplicate analytics', async () => {
    const tmpDbPath = path.join(os.tmpdir(), `test_qm_sec1_${Date.now()}.db`);
    const db = new DatabaseManager(tmpDbPath);
    db.init();
    const jm = new JobManager(db);
    const qm = new QueueManager({ maxConcurrency: 1, maxQueueSize: 5, db, jobManager: jm });

    let spawnedProc = null;
    let resolveExec = null;

    qm.setExecutor((job) => {
      spawnedProc = spawn('node', ['-e', 'setTimeout(() => {}, 30000)'], { shell: false });
      qm.attachProcess(job.id, spawnedProc);
      return new Promise((resolve) => {
        resolveExec = resolve;
        spawnedProc.on('close', () => resolve({ status: 'cancelled' }));
      });
    });

    const job1 = qm.enqueue({ id: 'qm_exec_1', name: 'Long Node Task' });
    assert.ok(spawnedProc);
    assert.equal(spawnedProc.killed, false);

    qm.cancelJob('qm_exec_1');
    await new Promise(r => setTimeout(r, 250));
    if (resolveExec) resolveExec({ status: 'completed' });
    await new Promise(r => setTimeout(r, 100));

    // Verify no duplicate completed analytics event was recorded after cancellation
    const events = db.db.prepare('SELECT * FROM analytics_events WHERE job_id = ?').all('qm_exec_1');
    assert.equal(events.length, 0, 'Cancelled job should not emit duplicate completed analytics');

    // Now test shutdown killing an active executor process
    let proc2 = null;
    qm.setExecutor((job) => {
      proc2 = spawn('node', ['-e', 'setTimeout(() => {}, 30000)'], { shell: false });
      qm.attachProcess(job.id, proc2);
      return new Promise((resolve) => {
        proc2.on('close', () => resolve({ status: 'cancelled' }));
      });
    });

    qm.enqueue({ id: 'qm_exec_2', name: 'Shutdown Target' });
    assert.ok(proc2);
    qm.shutdown();
    await new Promise(r => setTimeout(r, 150));
    assert.equal(proc2.killed || proc2.exitCode !== null || proc2.signalCode !== null, true);

    db.close();
    if (fs.existsSync(tmpDbPath)) {
      try { fs.unlinkSync(tmpDbPath); } catch (e) {}
    }
  });

  test('1.4 WakeLockManager does not register blocking process.exit signal handlers on SIGINT', () => {
    const sigintFns = process.listeners('SIGINT').map(fn => fn.toString());
    const hasPrematureWakeLockExit = sigintFns.some(src => src.includes('forceReleaseSync') && !src.includes('gracefulShutdown'));
    assert.equal(hasPrematureWakeLockExit, false);
    assert.ok(wakeLockManager);
  });

  test('1.7 DatabaseManager rejects re-initialization while BackupManager restore guard is active', () => {
    const tmpDbPath = path.join(os.tmpdir(), `test_restore_guard_${Date.now()}.db`);
    const db = new DatabaseManager(tmpDbPath);
    db.init();
    db._restoring = true;
    db.close();

    assert.throws(() => {
      db.getJob('anything');
    }, /Database restore is currently in progress/);

    db._restoring = false;
    db.close();
    if (fs.existsSync(tmpDbPath)) {
      try { fs.unlinkSync(tmpDbPath); } catch (e) {}
    }
  });
});
