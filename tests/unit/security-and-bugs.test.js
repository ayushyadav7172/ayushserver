'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  app,
  isOriginAllowed,
  databaseManager,
  jobManager,
  queueManager,
  cleanupManager,
  healthMonitor,
  analyticsService
} = require('../../server');

describe('Security, Logic & Async Fixes (Sections 2, 3, 4)', () => {
  let server;
  let baseUrl;
  const sampleVideoPath = path.join(__dirname, '..', '..', 'uploads', 'sec_test_sample.mp4');

  before(async () => {
    if (!fs.existsSync(sampleVideoPath)) {
      fs.writeFileSync(sampleVideoPath, Buffer.from('dummy-mp4-data'));
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

  test('isOriginAllowed validates IPv4 octets and excludes non-IPv6 hex hostnames', () => {
    assert.equal(isOriginAllowed('http://999.999.999.999:3000'), false);
    assert.equal(isOriginAllowed('http://deadbeef:3000'), false);
    assert.equal(isOriginAllowed('http://cafe'), false);
    assert.equal(isOriginAllowed('http://[2402:3a80:313:d8fc::1]:3000'), true);
    assert.equal(isOriginAllowed('http://192.168.1.50:3000'), true);
  });

  test('isOriginAllowed respects ALLOWED_TUNNEL_HOSTS when configured', () => {
    const prev = process.env.ALLOWED_TUNNEL_HOSTS;
    try {
      process.env.ALLOWED_TUNNEL_HOSTS = 'my-trusted-box.trycloudflare.com';
      assert.equal(isOriginAllowed('https://my-trusted-box.trycloudflare.com'), true);
      assert.equal(isOriginAllowed('https://evil-attacker.trycloudflare.com'), false);
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_TUNNEL_HOSTS;
      else process.env.ALLOWED_TUNNEL_HOSTS = prev;
    }
  });

  test('POST /api/process-direct rejects crafted output format traversal and unsafe raw args', async () => {
    const badFmtRes = await fetch(`${baseUrl}/api/process-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({
        filePath: sampleVideoPath,
        operation: 'convert',
        options: { format: 'mp4/../../evil' }
      })
    });
    assert.equal(badFmtRes.status, 400);

    const badRawExtRes = await fetch(`${baseUrl}/api/process-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({
        filePath: sampleVideoPath,
        operation: 'raw',
        options: { rawCommand: '-c copy', outputExt: '../../outside.mp4' }
      })
    });
    assert.equal(badRawExtRes.status, 400);

    const badRawArgRes = await fetch(`${baseUrl}/api/process-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({
        filePath: sampleVideoPath,
        operation: 'raw',
        options: { rawCommand: '-i /etc/passwd -c copy', outputExt: 'mp4' }
      })
    });
    assert.equal(badRawArgRes.status, 403);
  });

  test('Session isolation prevents un-sessioned or cross-session access to session-owned jobs', async () => {
    const jobId = `job_iso_${Date.now()}`;
    const job = jobManager.createJob({
      id: jobId,
      sessionId: 'session_owner_A',
      name: 'Private Job',
      status: 'queued',
      filePath: sampleVideoPath
    });
    assert.equal(job.sessionId, 'session_owner_A');

    // Omitting sessionId must be rejected with 403
    const logsNoSess = await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers: { 'Connection': 'close' } });
    assert.equal(logsNoSess.status, 403);

    const delNoSess = await fetch(`${baseUrl}/api/jobs/${jobId}`, {
      method: 'DELETE',
      headers: { 'Connection': 'close' }
    });
    assert.equal(delNoSess.status, 403);

    const cancelNoSess = await fetch(`${baseUrl}/api/cancel-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify({ jobId })
    });
    assert.equal(cancelNoSess.status, 403);

    // Wrong sessionId must be rejected with 403
    const logsWrongSess = await fetch(`${baseUrl}/api/jobs/${jobId}/logs?sessionId=session_B`, {
      headers: { 'Connection': 'close' }
    });
    assert.equal(logsWrongSess.status, 403);

    // Unscoped DELETE /api/jobs without sessionId must preserve session_owner_A's job
    const clearUnscoped = await fetch(`${baseUrl}/api/jobs`, {
      method: 'DELETE',
      headers: { 'Connection': 'close' }
    });
    assert.equal(clearUnscoped.status, 200);
    assert.ok(databaseManager.getJob(jobId), 'Session-owned job must not be wiped by unscoped DELETE /api/jobs');

    // Matching sessionId succeeds
    const logsOwner = await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, {
      headers: { 'X-Session-ID': 'session_owner_A', 'Connection': 'close' }
    });
    assert.equal(logsOwner.status, 200);

    const delOwner = await fetch(`${baseUrl}/api/jobs/${jobId}`, {
      method: 'DELETE',
      headers: { 'X-Session-ID': 'session_owner_A', 'Connection': 'close' }
    });
    assert.equal(delOwner.status, 200);
  });

  test('Public tunnel requests cannot invoke destructive backup/cleanup endpoints without ADMIN_TOKEN', async () => {
    const restoreRes = await fetch(`${baseUrl}/api/backup/restore`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '1.2.3.4',
        'Connection': 'close'
      },
      body: JSON.stringify({ backupId: 'fake', confirm: true })
    });
    assert.equal(restoreRes.status, 403);

    const cleanupRes = await fetch(`${baseUrl}/api/cleanup/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '1.2.3.4',
        'Connection': 'close'
      },
      body: JSON.stringify({ force: true })
    });
    assert.equal(cleanupRes.status, 403);
  });

  test('Async health, cleanup, and analytics methods work without blocking', async () => {
    const [storage, summary, ready, dash] = await Promise.all([
      cleanupManager.getStorageStatsAsync(),
      healthMonitor.getHealthSummaryAsync(),
      healthMonitor.getReadinessAsync(),
      analyticsService.getDashboardStatsAsync()
    ]);
    assert.ok(storage.totalAppStorage);
    assert.ok(summary.status);
    assert.equal(typeof ready.ready, 'boolean');
    assert.ok(dash.server);
  });

  test('PDF split rejects oversized page ranges immediately without hanging', async () => {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const pdfBytes = await doc.save();
    const pdfPath = path.join(__dirname, '..', '..', 'uploads', `range_test_${Date.now()}.pdf`);
    fs.writeFileSync(pdfPath, pdfBytes);

    try {
      const res = await fetch(`${baseUrl}/api/pdf/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        body: JSON.stringify({ inputPath: pdfPath, pages: '1-10000000' })
      });
      assert.equal(res.status, 400); // out of range since PDF has 1 page
      const resHuge = await fetch(`${baseUrl}/api/pdf/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        body: JSON.stringify({ inputPath: pdfPath, pages: Array.from({ length: 200 }, (_, i) => '1').join(',') })
      });
      assert.equal(resHuge.status, 200);
      const dataHuge = await resHuge.json();
      if (dataHuge.outputPath && fs.existsSync(dataHuge.outputPath)) {
        try { fs.unlinkSync(dataHuge.outputPath); } catch (e) {}
      }
    } finally {
      if (fs.existsSync(pdfPath)) {
        try { fs.unlinkSync(pdfPath); } catch (e) {}
      }
    }
  });
});
