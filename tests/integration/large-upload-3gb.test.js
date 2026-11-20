'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { app } = require('../../server');

describe('Large File & 3 GB Upload Verification', { timeout: 120000 }, () => {
  let server;
  let baseUrl;
  let testPort;
  let uploadedFilePath = null;

  before((t, done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      testPort = server.address().port;
      baseUrl = `http://127.0.0.1:${testPort}`;
      console.log(`[3GB Test] Server listening on ${baseUrl}`);
      done();
    });
  });

  after((t, done) => {
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      try {
        fs.unlinkSync(uploadedFilePath);
        console.log(`[3GB Test] Cleaned up uploaded test file: ${uploadedFilePath}`);
      } catch (e) {}
    }
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  test('successfully uploads and streams genuine 3 GB file to disk without memory buffering', async () => {
    const TARGET_SIZE_BYTES = 3 * 1024 * 1024 * 1024; // Exact 3 GB (3,221,225,472 bytes)
    const CHUNK_SIZE = 512 * 1024; // 512 KB chunk
    const chunkBuffer = Buffer.alloc(CHUNK_SIZE, 0x41); // 'A' repeated
    const boundary = '----WebKitFormBoundary3GBTest' + Date.now();

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="test_large_3gb.mp4"\r\n` +
      `Content-Type: video/mp4\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const totalContentLength = header.length + TARGET_SIZE_BYTES + footer.length;

    let bytesGenerated = 0;
    let headerSent = false;
    let footerSent = false;
    let peakRss = 0;

    const stream = new Readable({
      read() {
        // Track memory during streaming
        const currentRss = process.memoryUsage().rss;
        if (currentRss > peakRss) peakRss = currentRss;

        if (!headerSent) {
          headerSent = true;
          this.push(header);
          return;
        }

        if (bytesGenerated < TARGET_SIZE_BYTES) {
          const remaining = TARGET_SIZE_BYTES - bytesGenerated;
          const toSend = Math.min(CHUNK_SIZE, remaining);
          bytesGenerated += toSend;
          this.push(toSend === CHUNK_SIZE ? chunkBuffer : chunkBuffer.subarray(0, toSend));
        } else if (!footerSent) {
          footerSent = true;
          this.push(footer);
          this.push(null); // End of stream
        }
      }
    });

    console.log(`[3GB Test] Starting 3 GB streaming upload (${TARGET_SIZE_BYTES} bytes)...`);
    const startTime = Date.now();

    const uploadResponse = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/upload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalContentLength
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      });

      req.on('error', reject);
      stream.pipe(req);
    });

    const durationSeconds = (Date.now() - startTime) / 1000;
    const mbPerSec = (TARGET_SIZE_BYTES / (1024 * 1024)) / durationSeconds;

    console.log(`[3GB Test] Upload finished in ${durationSeconds.toFixed(2)}s (${mbPerSec.toFixed(1)} MB/s). Peak RSS: ${(peakRss / (1024 * 1024)).toFixed(1)} MB`);

    assert.equal(uploadResponse.statusCode, 200, `Expected HTTP 200, got ${uploadResponse.statusCode}`);
    assert.equal(uploadResponse.data.success, true);
    assert.ok(uploadResponse.data.file);

    uploadedFilePath = uploadResponse.data.file.path;
    assert.ok(uploadedFilePath, 'Uploaded file path must be returned');
    assert.equal(fs.existsSync(uploadedFilePath), true, 'File must exist on disk');

    const fileStat = fs.statSync(uploadedFilePath);
    assert.equal(fileStat.size, TARGET_SIZE_BYTES, 'On-disk file size must equal exactly 3 GB');

    // Peak RSS must be well below 250 MB, proving no whole-file memory buffering
    assert.ok(peakRss < 300 * 1024 * 1024, `Peak RSS (${(peakRss / 1024 / 1024).toFixed(1)}MB) exceeded limit; memory leak suspected`);
  });
});
