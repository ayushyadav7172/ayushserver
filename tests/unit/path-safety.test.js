'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// We test canonicalizeTarget and assertPathAllowed logic
function isPathAllowed(targetPath, allowedRoots) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  try {
    let clean = targetPath.trim();
    for (let i = 0; i < 5; i++) {
      if (!clean.includes('%')) break;
      const next = decodeURIComponent(clean);
      if (next === clean) break;
      clean = next;
    }
    const resolved = path.resolve(clean);
    return allowedRoots.some(root => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    });
  } catch (e) {
    return false;
  }
}

describe('Path Safety & Allowlist Validation', () => {
  const allowedRoots = [
    '/data/data/com.termux/files/home',
    '/sdcard',
    '/storage'
  ];

  test('allows safe paths inside home and /sdcard', () => {
    assert.equal(isPathAllowed('/sdcard/Download/video.mp4', allowedRoots), true);
    assert.equal(isPathAllowed('/data/data/com.termux/files/home/test.mp4', allowedRoots), true);
    assert.equal(isPathAllowed('/storage/emulated/0/DCIM/Camera/photo.jpg', ['/storage']), true);
  });

  test('blocks directory traversal attempts (../)', () => {
    assert.equal(isPathAllowed('/sdcard/../../etc/passwd', allowedRoots), false);
    assert.equal(isPathAllowed('/data/data/com.termux/files/home/../../../../etc/shadow', allowedRoots), false);
  });

  test('blocks double-encoded directory traversal (%252e%252e)', () => {
    assert.equal(isPathAllowed('/sdcard/%252e%252e/etc/passwd', allowedRoots), false);
    assert.equal(isPathAllowed('/sdcard/%2e%2e/system/bin', allowedRoots), false);
  });

  test('blocks root filesystem access outside allowed directories', () => {
    assert.equal(isPathAllowed('/etc/passwd', allowedRoots), false);
    assert.equal(isPathAllowed('/proc/cpuinfo', allowedRoots), false);
    assert.equal(isPathAllowed('/sys/class', allowedRoots), false);
  });

  test('handles null, undefined, and non-string inputs safely without crashing', () => {
    assert.equal(isPathAllowed(null, allowedRoots), false);
    assert.equal(isPathAllowed(undefined, allowedRoots), false);
    assert.equal(isPathAllowed(12345, allowedRoots), false);
    assert.equal(isPathAllowed({}, allowedRoots), false);
  });
});
