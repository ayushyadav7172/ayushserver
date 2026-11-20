'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { HealthMonitor } = require('../../services/health-monitor');

describe('Server Health Monitor & Diagnostics', () => {
  const hm = new HealthMonitor();

  test('formats byte sizes accurately', () => {
    assert.equal(hm.formatBytes(0), '0 B');
    assert.equal(hm.formatBytes(1024), '1 KB');
    assert.equal(hm.formatBytes(1048576), '1 MB');
    assert.equal(hm.formatBytes(1073741824), '1 GB');
  });

  test('formats durations into readable units', () => {
    assert.equal(hm.formatDuration(45), '45s');
    assert.equal(hm.formatDuration(125), '2m 5s');
    assert.equal(hm.formatDuration(3665), '1h 1m 5s');
  });

  test('returns valid memory diagnostic metrics', () => {
    const mem = hm.getMemoryInfo();
    assert.ok(mem.process);
    assert.ok(mem.process.rss > 0);
    assert.ok(mem.system);
    assert.ok(mem.system.totalBytes > 0);
    assert.ok(mem.system.freeBytes > 0);
  });

  test('returns liveness and readiness statuses', () => {
    const live = hm.getLiveness();
    assert.equal(live.status, 'ok');

    const ready = hm.getReadiness();
    assert.equal(typeof ready.ready, 'boolean');
  });

  test('generates comprehensive health summary without exposing sensitive credentials', () => {
    const summary = hm.getHealthSummary();
    assert.ok(summary.status);
    assert.ok(summary.uptime);
    assert.ok(summary.platform);
    assert.ok(summary.storage);
    assert.equal(summary.platform.nodeVersion, process.version);
    // Ensure no secrets leaked
    assert.equal(summary.env, undefined);
    assert.equal(summary.token, undefined);
  });
});
