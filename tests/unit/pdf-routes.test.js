'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { createPdfRouter } = require('../../pdf-routes');

describe('PDF Studio & Routes Validation', () => {
  let server;
  let baseUrl;
  const tempDir = path.join(__dirname, '..', '..', 'temp_pdf_uploads');

  before(async () => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const testApp = express();
    testApp.use(express.json());

    const assertPathAllowed = (p, label = 'Path') => {
      if (!p) throw new Error(`${label} is required`);
      const resolved = path.resolve(p);
      const allowedRoots = [
        path.resolve(process.env.HOME || '/data/data/com.termux/files/home'),
        '/sdcard'
      ];
      const isAllowed = allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
      if (!isAllowed) {
        const err = new Error(`${label} is outside allowed directory`);
        err.status = 403;
        throw err;
      }
      return resolved;
    };

    const formatBytes = (bytes) => `${bytes} B`;
    const createHttpError = (status, msg) => {
      const err = new Error(msg);
      err.status = status;
      return err;
    };

    const pdfRouter = createPdfRouter({
      assertPathAllowed,
      formatBytes,
      createHttpError,
      concurrencyLock: null,
      TEMP_UPLOADS_DIR: tempDir,
      PROCESSED_DIR: tempDir
    });

    testApp.use('/api/pdf', pdfRouter);

    server = http.createServer(testApp);
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

  test('GET /api/pdf/capabilities returns available PDF processing tools', async () => {
    const res = await fetch(`${baseUrl}/api/pdf/capabilities`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.tools);
    assert.equal(typeof data.tools.qpdf, 'boolean');
    assert.equal(typeof data.tools.ghostscript, 'boolean');
    assert.equal(typeof data.tools.poppler, 'boolean');
  });

  test('POST /api/pdf/unlock rejects missing files with 400 or 404', async () => {
    const res = await fetch(`${baseUrl}/api/pdf/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: path.join(tempDir, 'non_existent.pdf') })
    });
    assert.equal(res.status >= 400, true);
  });

  test('GET /api/pdf/download blocks traversal outside allowed directories', async () => {
    const res = await fetch(`${baseUrl}/api/pdf/download?path=/etc/passwd`);
    assert.equal(res.status, 403);
  });
});
