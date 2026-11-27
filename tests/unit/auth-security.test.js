'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, cleanupManager, backupManager, queueManager } = require('../../server');
const { databaseManager } = require('../../database/database');

describe('Security Verification: Authentication, RBAC & Bypass Prevention', () => {
  let server;
  let baseUrl;
  let adminCookie = '';
  let guestCookie = '';
  let adminToken = '';
  let guestToken = '';
  let savedUsers = [];
  let savedSessions = [];

  const testUploadFile = path.join(__dirname, '../../uploads/guest_test_sample.mp4');

  before(async () => {
    // Ensure test directories exist
    const uploadsDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(testUploadFile, 'dummy content for upload validation');

    // Initialize database and snapshot existing production data
    databaseManager.init();
    try {
      savedUsers = databaseManager.db.prepare('SELECT * FROM users').all();
      savedSessions = databaseManager.db.prepare('SELECT * FROM auth_sessions').all();
    } catch (e) {}

    // Start ephemeral test server
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        console.log(`[Security Test] Server listening at ${baseUrl}`);
        resolve();
      });
    });
  });

  after(async () => {
    try {
      databaseManager.db.exec('DELETE FROM auth_sessions;');
      databaseManager.db.exec('DELETE FROM users;');

      // Restore user database state as before test
      if (savedUsers.length > 0) {
        const insertUser = databaseManager.db.prepare(`
          INSERT INTO users (id, username, password_hash, salt, role, created_at, last_login)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const u of savedUsers) {
          insertUser.run(u.id, u.username, u.password_hash, u.salt, u.role, u.created_at, u.last_login);
        }
      }
      if (savedSessions.length > 0) {
        const insertSession = databaseManager.db.prepare(`
          INSERT INTO auth_sessions (token, user_id, username, role, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const s of savedSessions) {
          insertSession.run(s.token, s.user_id, s.username, s.role, s.created_at, s.expires_at);
        }
      }
    } catch (e) {}
    if (fs.existsSync(testUploadFile)) {
      try { fs.unlinkSync(testUploadFile); } catch (e) {}
    }
    if (cleanupManager && typeof cleanupManager.stopScheduler === 'function') cleanupManager.stopScheduler();
    if (backupManager && typeof backupManager.stopScheduler === 'function') backupManager.stopScheduler();
    if (queueManager && typeof queueManager.shutdown === 'function') queueManager.shutdown();
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  });

  async function reqGet(route, cookie = '') {
    const headers = { 'Connection': 'close' };
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(`${baseUrl}${route}`, { headers });
    const data = await res.json().catch(() => null);
    return { status: res.status, headers: res.headers, data };
  }

  async function reqPost(route, body = {}, cookie = '') {
    const headers = {
      'Content-Type': 'application/json',
      'Connection': 'close'
    };
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie');
    const data = await res.json().catch(() => null);
    return { status: res.status, headers: res.headers, setCookie, data };
  }

  test('1. Initial Setup: Registration validation and first-time admin creation', async () => {
    // Clean any existing users in test db to test initial state
    databaseManager.db.exec('DELETE FROM auth_sessions;');
    databaseManager.db.exec('DELETE FROM users;');

    const statusInitial = await reqGet('/api/auth/status');
    assert.equal(statusInitial.status, 200);
    assert.equal(statusInitial.data.hasAdmin, false);
    assert.equal(statusInitial.data.authenticated, false);

    // Rejection on invalid inputs
    const badUserRes = await reqPost('/api/auth/register-admin', { username: 'a', password: 'password123' });
    assert.equal(badUserRes.status, 400);

    const badPassRes = await reqPost('/api/auth/register-admin', { username: 'admin', password: '123' });
    assert.equal(badPassRes.status, 400);

    // Successful admin creation
    const regRes = await reqPost('/api/auth/register-admin', {
      username: 'securityAdmin',
      password: 'StrongAdminPassword!2026'
    });

    assert.equal(regRes.status, 201);
    assert.equal(regRes.data.success, true);
    assert.equal(regRes.data.user.username, 'securityAdmin');
    assert.equal(regRes.data.user.role, 'admin');
    assert.ok(regRes.data.token);
    assert.ok(regRes.setCookie && regRes.setCookie.includes('ayush_auth_token'));

    adminToken = regRes.data.token;
    adminCookie = `ayush_auth_token=${adminToken}`;

    // Verify status now reports hasAdmin = true
    const statusAfter = await reqGet('/api/auth/status', adminCookie);
    assert.equal(statusAfter.status, 200);
    assert.equal(statusAfter.data.hasAdmin, true);
    assert.equal(statusAfter.data.authenticated, true);
    assert.equal(statusAfter.data.user.role, 'admin');
  });

  test('2. Bypass Prevention: Second admin registration attempt is strictly blocked (403)', async () => {
    // Attacker tries to register another admin account
    const secondReg = await reqPost('/api/auth/register-admin', {
      username: 'attacker',
      password: 'HackerPassword123'
    });

    assert.equal(secondReg.status, 403);
    assert.equal(secondReg.data.success, false);
    assert.ok(secondReg.data.error.includes('Registration is closed'));

    // Verify attacker account was NOT created in DB
    const attackerUser = databaseManager.getUserByUsername('attacker');
    assert.equal(attackerUser, null);
  });

  test('3. Password Hashing: Passwords are cryptographically salted and hashed with scrypt', async () => {
    const userRow = databaseManager.getUserByUsername('securityAdmin');
    assert.ok(userRow);
    assert.notEqual(userRow.password_hash, 'StrongAdminPassword!2026');
    assert.ok(userRow.salt && userRow.salt.length >= 32);
    assert.ok(userRow.password_hash.length >= 64);
  });

  test('4. Admin Login: Rejects invalid credentials and accepts valid credentials', async () => {
    const wrongLogin = await reqPost('/api/auth/login', {
      username: 'securityAdmin',
      password: 'WrongPassword'
    });
    assert.equal(wrongLogin.status, 401);
    assert.equal(wrongLogin.data.success, false);

    const validLogin = await reqPost('/api/auth/login', {
      username: 'securityAdmin',
      password: 'StrongAdminPassword!2026'
    });
    assert.equal(validLogin.status, 200);
    assert.equal(validLogin.data.success, true);
    assert.equal(validLogin.data.user.role, 'admin');
    assert.ok(validLogin.data.token);

    adminToken = validLogin.data.token;
    adminCookie = `ayush_auth_token=${adminToken}`;
  });

  test('5. 1-Hour Auto-Logout: Expired sessions are rejected with 401', async () => {
    // Manually expire the current session
    databaseManager.db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token = ?')
      .run(Date.now() - 5000, adminToken);

    // Calling status with expired token
    const res = await reqGet('/api/auth/status', adminCookie);
    assert.equal(res.status, 200);
    assert.equal(res.data.authenticated, false);

    // Calling protected admin route with expired token
    const browseRes = await reqGet('/api/browse?dir=/sdcard', adminCookie);
    assert.equal(browseRes.status, 401);

    // Re-login to get fresh admin session for remaining tests
    const reLogin = await reqPost('/api/auth/login', {
      username: 'securityAdmin',
      password: 'StrongAdminPassword!2026'
    });
    adminToken = reLogin.data.token;
    adminCookie = `ayush_auth_token=${adminToken}`;
  });

  test('6. Guest Session Creation', async () => {
    const guestRes = await reqPost('/api/auth/guest');
    assert.equal(guestRes.status, 200);
    assert.equal(guestRes.data.success, true);
    assert.equal(guestRes.data.user.role, 'guest');
    assert.ok(guestRes.data.token);

    guestToken = guestRes.data.token;
    guestCookie = `ayush_auth_token=${guestToken}`;

    const statusRes = await reqGet('/api/auth/status', guestCookie);
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.data.authenticated, true);
    assert.equal(statusRes.data.user.role, 'guest');
  });

  test('7. Bypass Attack: Guest user CANNOT browse phone storage via /api/browse (403)', async () => {
    const browseRes = await reqGet('/api/browse?dir=/sdcard', guestCookie);
    assert.equal(browseRes.status, 403);
    assert.equal(browseRes.data.success, false);
    assert.ok(browseRes.data.error.includes('restricted to Admin'));

    // Admin CAN browse phone storage
    const adminBrowse = await reqGet(`/api/browse?path=${encodeURIComponent(process.env.HOME || __dirname)}`, adminCookie);
    assert.equal(adminBrowse.status, 200);
  });

  test('8. Bypass Attack: Guest user CANNOT run jobs on local storage via /api/process-direct (403)', async () => {
    const processRes = await reqPost('/api/process-direct', {
      filePath: '/sdcard/Download/private_video.mp4',
      operation: 'convert',
      options: { format: 'mp4' }
    }, guestCookie);

    assert.equal(processRes.status, 403);
    assert.equal(processRes.data.success, false);
    assert.ok(processRes.data.error.includes('Guests cannot process files from local server storage'));
  });

  test('9. Bypass Attack: Guest user CANNOT stream files from local storage via /api/stream-file (403)', async () => {
    const streamRes = await reqGet('/api/stream-file?path=/sdcard/DCIM/Camera/private.mp4', guestCookie);
    assert.equal(streamRes.status, 403);
  });

  test('10. Bypass Attack: Guest user CANNOT access administrative APIs (403)', async () => {
    const backupRes = await reqGet('/api/backup/list', guestCookie);
    assert.equal(backupRes.status, 403);

    const cleanupRes = await reqPost('/api/cleanup/run', {}, guestCookie);
    assert.equal(cleanupRes.status, 403);

    const concurrencyRes = await reqPost('/api/queue/concurrency', { limit: 2 }, guestCookie);
    assert.equal(concurrencyRes.status, 403);

    const clearErrorsRes = await reqPost('/api/analytics/clear-errors', {}, guestCookie);
    assert.equal(clearErrorsRes.status, 403);
  });

  test('11. Forged / Tampered Tokens: Arbitrary and SQL-injected tokens are rejected (401)', async () => {
    const forgedRes1 = await reqGet('/api/browse?dir=/sdcard', 'ayush_auth_token=forged_token_evil');
    assert.equal(forgedRes1.status, 401);

    const forgedRes2 = await reqGet('/api/browse?dir=/sdcard', "ayush_auth_token=' OR '1'='1");
    assert.equal(forgedRes2.status, 401);
  });

  test('12. Logout: Invalidates session in database and clears cookie', async () => {
    const logoutRes = await reqPost('/api/auth/logout', {}, adminCookie);
    assert.equal(logoutRes.status, 200);
    assert.equal(logoutRes.data.success, true);

    // Verify session is deleted from database
    const sessionInDb = databaseManager.getAuthSession(adminToken);
    assert.equal(sessionInDb, null);

    // Subsequent call with the logged-out token is rejected
    const browseRes = await reqGet('/api/browse?dir=/sdcard', adminCookie);
    assert.equal(browseRes.status, 401);
  });

  test('13. Bypass Attack: Guest user CANNOT inspect or process local storage images (403)', async () => {
    // Re-obtain guest token
    const guestRes = await reqPost('/api/auth/guest');
    const gCookie = `ayush_auth_token=${guestRes.data.token}`;

    const inspectRes = await reqPost('/api/image/inspect', {
      paths: ['/sdcard/DCIM/Camera/secret.jpg']
    }, gCookie);
    assert.equal(inspectRes.status, 403);
    assert.ok(inspectRes.data.error.includes('Guests cannot access or process images from local server storage'));

    const processRes = await reqPost('/api/image/process', {
      operation: 'compress-auto',
      inputPaths: ['/sdcard/DCIM/Camera/secret.jpg']
    }, gCookie);
    assert.equal(processRes.status, 403);
  });

  test('14. Bypass Attack: Guest user CANNOT process local storage PDFs (403)', async () => {
    const guestRes = await reqPost('/api/auth/guest');
    const gCookie = `ayush_auth_token=${guestRes.data.token}`;

    const pdfRes = await reqPost('/api/pdf/split', {
      sourcePath: '/sdcard/Documents/confidential.pdf',
      pageRanges: '1-2'
    }, gCookie);
    assert.equal(pdfRes.status, 403);
    assert.ok(pdfRes.data.error.includes('Guests cannot access or process PDF files from local server storage'));
  });

  test('15. Legitimate Guest Remote Upload: Guest CAN process files inside uploads sandbox', async () => {
    const guestRes = await reqPost('/api/auth/guest');
    const gCookie = `ayush_auth_token=${guestRes.data.token}`;

    // Probe uploaded file in uploads/
    const probeRes = await reqPost('/api/probe-file', {
      filePath: testUploadFile
    }, gCookie);
    // Should NOT be rejected with 403 Forbidden!
    assert.notEqual(probeRes.status, 403);
  });
});
