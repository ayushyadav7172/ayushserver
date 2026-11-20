'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app, isOriginAllowed, getLocalIP, getNetworkInterfacesSummary } = require('../../server');

describe('Network & CORS Validation: Cellular (ccmni), Hotspot (ap0), LAN & IPv6', () => {
  let server;
  let baseUrl;

  before(async () => {
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
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(r => server.close(r));
    }
  });

  test('isOriginAllowed permits localhost and loopback variants', () => {
    assert.equal(isOriginAllowed('http://localhost:3000'), true);
    assert.equal(isOriginAllowed('http://127.0.0.1:3000'), true);
    assert.equal(isOriginAllowed('http://0.0.0.0:3000'), true);
    assert.equal(isOriginAllowed('http://[::1]:3000'), true);
    assert.equal(isOriginAllowed(null), true);
    assert.equal(isOriginAllowed(''), true);
  });

  test('isOriginAllowed permits private Wi-Fi and Hotspot (ap0) IPs', () => {
    assert.equal(isOriginAllowed('http://10.150.44.36:3000'), true); // ap0
    assert.equal(isOriginAllowed('http://192.168.1.150:3000'), true); // wlan0
    assert.equal(isOriginAllowed('http://172.20.10.2:3000'), true);
  });

  test('isOriginAllowed permits Android Cellular Data (ccmni / rmnet) IPv4 & IPv6', () => {
    // MediaTek ccmni1 Carrier-Grade NAT IPv4
    assert.equal(isOriginAllowed('http://100.88.83.158:3000'), true);
    // Dynamic public cellular IPv4
    assert.equal(isOriginAllowed('http://27.56.12.98:3000'), true);
    assert.equal(isOriginAllowed('http://49.36.120.45:3000'), true);
    // MediaTek ccmni1 & ccmni4 IPv6 mobile addresses
    assert.equal(isOriginAllowed('http://[2402:3a80:313:d8fc::6278:d412]:3000'), true);
    assert.equal(isOriginAllowed('http://[2409:4123:208f:823d:8000::]:3000'), true);
    assert.equal(isOriginAllowed('http://[fe80::6278:d412]:3000'), true);
  });

  test('isOriginAllowed permits authorized tunnels and local mDNS hostnames', () => {
    assert.equal(isOriginAllowed('https://test-subdomain.trycloudflare.com'), true);
    assert.equal(isOriginAllowed('https://my-app.loca.lt'), true);
    assert.equal(isOriginAllowed('https://random.ngrok-free.app'), true);
    assert.equal(isOriginAllowed('http://termux.local:3000'), true);
    assert.equal(isOriginAllowed('http://phone.lan:3000'), true);
  });

  test('isOriginAllowed safely rejects unauthorized external websites', () => {
    assert.equal(isOriginAllowed('https://malicious-website.com'), false);
    assert.equal(isOriginAllowed('https://phishing-domain.xyz'), false);
    assert.equal(isOriginAllowed('http://attacker.org:8080'), false);
  });

  test('HTTP requests with ccmni Cellular IPv4 Origin succeed across all core endpoints', async () => {
    const ccmniOrigin = 'http://100.88.83.158:3000';
    const endpoints = [
      '/api/health',
      '/api/analytics/stats',
      '/api/queue/status',
      '/api/jobs',
      '/api/cleanup/stats',
      '/api/backup/list'
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep}`, {
        headers: {
          'Origin': ccmniOrigin,
          'Connection': 'close'
        }
      });
      assert.equal(res.status, 200, `Endpoint ${ep} should return 200 for ccmni origin`);
      assert.equal(res.headers.get('access-control-allow-origin'), ccmniOrigin);
      assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    }
  });

  test('HTTP requests with ccmni Cellular IPv6 Origin succeed', async () => {
    const ccmniIPv6Origin = 'http://[2402:3a80:313:d8fc::6278:d412]:3000';
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: {
        'Origin': ccmniIPv6Origin,
        'Connection': 'close'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ccmniIPv6Origin);
  });

  test('OPTIONS preflight requests handle video Range and custom headers for ccmni', async () => {
    const ccmniOrigin = 'http://100.88.83.158:3000';
    const res = await fetch(`${baseUrl}/api/process-direct`, {
      method: 'OPTIONS',
      headers: {
        'Origin': ccmniOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, X-Session-ID, Range',
        'Connection': 'close'
      }
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ccmniOrigin);
    const allowHeaders = res.headers.get('access-control-allow-headers') || '';
    assert.ok(allowHeaders.toLowerCase().includes('content-type'));
    assert.ok(allowHeaders.toLowerCase().includes('range'));
  });

  test('getNetworkInterfacesSummary detects interfaces and categorizes ccmni as mobile cellular', () => {
    const summary = getNetworkInterfacesSummary();
    assert.ok(Array.isArray(summary));
    assert.ok(summary.length > 0);

    // Verify properties
    for (const item of summary) {
      assert.ok(item.interface);
      assert.ok(item.type);
      assert.ok(item.address);
      assert.ok(item.url.startsWith('http://'));
    }

    // Verify localIP detector returns non-empty string
    const localIP = getLocalIP();
    assert.ok(typeof localIP === 'string');
    assert.ok(localIP.length > 0);
  });
});
