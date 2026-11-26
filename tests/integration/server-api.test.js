'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, cleanupManager, backupManager, queueManager } = require('../../server');
const { databaseManager } = require('../../database/database');

describe('API Integration: Server, Health, Analytics, Queue & Storage', () => {
  let server;
  let baseUrl;
  let testPort;
  let adminCookie = '';

  before(async () => {
    databaseManager.init();
    if (databaseManager.hasAnyAdmin()) {
      const session = databaseManager.createAuthSession({
        userId: 'integration_test_admin',
        username: 'admin',
        role: 'admin'
      });
      adminCookie = `ayush_auth_token=${session.token}`;
    }

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        testPort = server.address().port;
        baseUrl = `http://127.0.0.1:${testPort}`;
        console.log(`[Integration Test] Server listening on ${baseUrl}`);
        resolve();
      });
    });
  });

  after(async () => {
    if (cleanupManager && typeof cleanupManager.stopScheduler === 'function') cleanupManager.stopScheduler();
    if (backupManager && typeof backupManager.stopScheduler === 'function') backupManager.stopScheduler();
    if (queueManager && typeof queueManager.shutdown === 'function') queueManager.shutdown();
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(r => server.close(r));
    }
  });

  async function apiGet(route) {
    const headers = { 'Connection': 'close' };
    if (adminCookie) headers['Cookie'] = adminCookie;
    const res = await fetch(`${baseUrl}${route}`, { headers });
    const data = await res.json().catch(() => null);
    return { status: res.status, headers: res.headers, data };
  }

  async function apiPost(route, body = {}) {
    const headers = { 'Content-Type': 'application/json', 'Connection': 'close' };
    if (adminCookie) headers['Cookie'] = adminCookie;
    const res = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, headers: res.headers, data };
  }

  test('GET / returns 200 and loads home dashboard without authentication', async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { 'Connection': 'close' } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Termux Utility Studio'));
  });

  test('GET /dashboard returns 200 and serves HTML view; /docs is removed', async () => {
    const dashRes = await fetch(`${baseUrl}/dashboard`, { headers: { 'Connection': 'close' } });
    assert.equal(dashRes.status, 200);
    const dashHtml = await dashRes.text();
    assert.ok(dashHtml.includes('Live Analytics Dashboard'));

    const docsRes = await fetch(`${baseUrl}/docs`, { headers: { 'Connection': 'close' } });
    assert.equal(docsRes.status, 404, '/docs HTML webpage should be removed from Web UI');
  });

  test('GET /docs/openapi.yaml serves valid OpenAPI 3.1 specification', async () => {
    const res = await fetch(`${baseUrl}/docs/openapi.yaml`);
    assert.equal(res.status, 200);
    const yaml = await res.text();
    assert.ok(yaml.includes('openapi: 3.1.0'));
  });

  test('GET /api/health returns comprehensive system health status', async () => {
    const { status, data } = await apiGet('/api/health');
    assert.equal(status, 200);
    assert.ok(data.status);
    assert.ok(data.uptime);
    assert.ok(data.database);
    assert.ok(data.ffmpeg);
    assert.ok(data.memory);
    assert.ok(data.storage);
  });

  test('GET /api/health/live and GET /api/health/ready return readiness probes', async () => {
    const live = await apiGet('/api/health/live');
    assert.equal(live.status, 200);
    assert.equal(live.data.status, 'ok');

    const ready = await apiGet('/api/health/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.data.ready, true);
  });

  test('GET /api/analytics/stats and POST /api/analytics/clear-errors manages metrics and clears warnings', async () => {
    const { status, data } = await apiGet('/api/analytics/stats');
    assert.equal(status, 200);
    assert.ok(data.server);
    assert.ok(data.processing);
    assert.ok(data.ffmpeg);
    assert.ok(data.storage);
    assert.equal(typeof data.processing.totalJobs, 'number');

    const clearRes = await apiPost('/api/analytics/clear-errors');
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.data.success, true);

    const afterClear = await apiGet('/api/analytics/stats');
    assert.equal(afterClear.status, 200);
    assert.equal(afterClear.data.processing.recentErrors.length, 0);
  });

  test('GET and POST /api/queue/concurrency controls queue worker limits', async () => {
    const getStatus = await apiGet('/api/queue/status');
    assert.equal(getStatus.status, 200);
    assert.ok(getStatus.data.maxConcurrency >= 1);

    const updateRes = await apiPost('/api/queue/concurrency', { limit: 2 });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.maxConcurrency, 2);

    // Invalid limit rejection
    const invalidRes = await apiPost('/api/queue/concurrency', { limit: 99 });
    assert.equal(invalidRes.status, 400);

    // Reset back to 1
    await apiPost('/api/queue/concurrency', { limit: 1 });
  });

  test('GET /api/cleanup/stats and POST /api/cleanup/run executes safe cleanup', async () => {
    const stats = await apiGet('/api/cleanup/stats');
    assert.equal(stats.status, 200);
    assert.ok(stats.data.tempUploads);
    assert.ok(stats.data.diskStorage);

    const runRes = await apiPost('/api/cleanup/run');
    assert.equal(runRes.status, 200);
    assert.equal(typeof runRes.data.totalDeleted, 'number');

    const retRes = await apiPost('/api/cleanup/retention', { minutes: 45 });
    assert.equal(retRes.status, 200);
    assert.equal(retRes.data.retentionMinutes, 45);
  });

  test('GET /api/backup/list and POST /api/backup/run executes atomic backup', async () => {
    const backupRes = await apiPost('/api/backup/run');
    assert.equal(backupRes.status, 200);
    assert.equal(backupRes.data.success, true);
    assert.ok(backupRes.data.backup.filename);
    assert.ok(backupRes.data.backup.checksumSha256);

    const listRes = await apiGet('/api/backup/list');
    assert.equal(listRes.status, 200);
    assert.ok(listRes.data.backups.length >= 1);
  });

  test('GET /api/browse lists safe phone directories and blocks traversal', async () => {
    const safeBrowsePath = process.env.HOME || __dirname;
    const browseRes = await apiGet(`/api/browse?path=${encodeURIComponent(safeBrowsePath)}`);
    assert.equal(browseRes.status, 200);
    assert.ok(Array.isArray(browseRes.data.items) || Array.isArray(browseRes.data.files));

    // Traversal rejection
    const escapeRes = await apiGet('/api/browse?path=/etc');
    assert.equal(escapeRes.status, 403);
  });
});
