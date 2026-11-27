'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app, databaseManager } = require('../../server');

describe('System Tools & In-App Update API', () => {
  let server;
  let baseUrl;
  let adminCookie = '';

  before(async () => {
    // Setup test server
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // Create admin session for test if admin exists
    try {
      if (databaseManager.hasAnyAdmin()) {
        const session = databaseManager.createAuthSession(1, 'admin', 'admin', 3600);
        adminCookie = `ayush_auth_token=${session.token}`;
      }
    } catch (_) {}
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('GET /manifest.json returns valid PWA web app manifest', async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    assert.strictEqual(res.status, 200);
    const manifest = await res.json();
    assert.strictEqual(manifest.name, 'AyushServer Studio');
    assert.strictEqual(manifest.display, 'standalone');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  });

  test('GET /sw.js serves service worker script', async () => {
    const res = await fetch(`${baseUrl}/sw.js`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('CACHE_NAME'));
    assert.ok(text.includes('addEventListener'));
  });

  test('GET /api/system/tools-info returns detected media engines and system status', async () => {
    const res = await fetch(`${baseUrl}/api/system/tools-info`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.success, true);
    assert.ok(data.tools);
    assert.ok(data.tools.ffmpeg);
    assert.strictEqual(data.tools.ffmpeg.installed, true);
    assert.ok(data.tools.ffprobe);
    assert.strictEqual(data.tools.ffprobe.installed, true);
    assert.ok(data.system);
    assert.strictEqual(typeof data.system.node, 'string');
    assert.ok(data.app);
    assert.strictEqual(data.app.name, 'ayushserver');
    assert.strictEqual(data.app.version, '1.0.0');
  });

  test('POST /api/system/check-updates returns update check results', async () => {
    const headers = {};
    if (adminCookie) headers['Cookie'] = adminCookie;

    const res = await fetch(`${baseUrl}/api/system/check-updates`, {
      method: 'POST',
      headers
    });

    if (adminCookie) {
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.currentAppVersion, '1.0.0');
    } else {
      assert.ok([200, 401].includes(res.status));
    }
  });

  test('POST /api/system/update-tools requires admin access and blocks unauthorized calls', async () => {
    const res = await fetch(`${baseUrl}/api/system/update-tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'invalid-target' })
    });

    if (databaseManager.hasAnyAdmin()) {
      assert.strictEqual(res.status, 401);
    } else {
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.success, false);
    }
  });
});
