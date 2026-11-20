'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { app, databaseManager, jobManager, queueManager, cleanupManager, backupManager } = require('../../server');

describe('API Integration: Media Job Lifecycle, Queue & Recovery', () => {
  let server;
  let baseUrl;
  const sampleVideoPath = path.join(__dirname, '..', '..', 'temp_uploads', 'sample_test.mp4');

  before(async () => {
    // Generate sample test video if missing
    if (!fs.existsSync(sampleVideoPath)) {
      try {
        const { execSync } = require('child_process');
        execSync(`ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=10 -c:v libx264 -y "${sampleVideoPath}" 2>/dev/null`);
      } catch (e) {}
    }

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (cleanupManager && typeof cleanupManager.stopScheduler === 'function') cleanupManager.stopScheduler();
    if (backupManager && typeof backupManager.stopScheduler === 'function') backupManager.stopScheduler();
    if (queueManager && typeof queueManager.shutdown === 'function') queueManager.shutdown();
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

  async function apiGet(route) {
    const res = await fetch(`${baseUrl}${route}`, {
      headers: { 'Connection': 'close' }
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  async function apiPost(route, body = {}) {
    const res = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  test('POST /api/probe-file and GET /api/analyze-media analyze video metadata', async () => {
    assert.equal(fs.existsSync(sampleVideoPath), true);

    const probeRes = await apiPost('/api/probe-file', { filePath: sampleVideoPath });
    assert.equal(probeRes.status, 200);
    assert.ok(probeRes.data.file);
    assert.ok(probeRes.data.file.metadata);
    assert.equal(probeRes.data.file.metadata.duration, 1);

    const analyzeRes = await apiGet(`/api/analyze-media?path=${encodeURIComponent(sampleVideoPath)}`);
    assert.equal(analyzeRes.status, 200);
    assert.ok(analyzeRes.data.duration !== undefined);
  });

  test('POST /api/process-direct processes video to completion and records to SQLite', async () => {
    const outPath = path.join(path.dirname(sampleVideoPath), 'sample_output_converted.mp4');
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    const postRes = await apiPost('/api/process-direct', {
      filePath: sampleVideoPath,
      operation: 'convert',
      options: { format: 'mp4', crf: 28 }
    });

    assert.equal(postRes.status, 200);
    assert.equal(postRes.data.success, true);
    assert.ok(postRes.data.jobId);

    const jobId = postRes.data.jobId;

    // Poll until completed in SQLite/memory
    let completed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      const job = databaseManager.getJob(jobId);
      if (job && job.status === 'completed') {
        completed = true;
        break;
      }
    }

    assert.equal(completed, true, 'Job should complete within polling window');

    // Verify persisted in SQLite jobs history
    const historyRes = await apiGet('/api/jobs');
    assert.equal(historyRes.status, 200);
    const found = historyRes.data.jobs.find(j => j.id === jobId);
    assert.ok(found);
    assert.equal(found.status, 'completed');

    // Verify logs
    const logsRes = await apiGet(`/api/jobs/${jobId}/logs`);
    assert.equal(logsRes.status, 200);
    assert.ok(logsRes.data.logs !== undefined);

    // Clean up output
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  });

  test('POST /api/cancel-job cancels running or queued job gracefully', async () => {
    // Submit a multi-operation job
    const postRes = await apiPost('/api/process-direct', {
      filePath: sampleVideoPath,
      operation: 'convert',
      options: { format: 'mp4', crf: 28 }
    });

    const jobId = postRes.data.jobId;

    // Cancel immediately
    const cancelRes = await apiPost('/api/cancel-job', { jobId });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.success, true);

    const job = databaseManager.getJob(jobId);
    assert.ok(job);
    assert.equal(job.status === 'cancelled' || job.status === 'completed', true);
  });

  test('recovers interrupted jobs safely on server restart', () => {
    // Simulate a job left in 'processing' status from a simulated crash
    const fakeCrashJob = {
      id: `job_crash_${Date.now()}`,
      name: 'Crashed Transcode',
      type: 'media',
      status: 'processing',
      progress: 33,
      filePath: sampleVideoPath,
      outputPath: path.join(__dirname, 'non_existent_output.mp4'),
      createdAt: Date.now()
    };
    databaseManager.saveJob(fakeCrashJob);

    // Call recovery
    const recovered = jobManager.recoverInterruptedJobs();
    assert.ok(recovered.some(j => j.id === fakeCrashJob.id));

    const checkJob = databaseManager.getJob(fakeCrashJob.id);
    assert.equal(checkJob.status, 'interrupted');
    assert.ok(checkJob.error.includes('interrupted'));

    // Clean up
    databaseManager.deleteJob(fakeCrashJob.id);
  });
});
