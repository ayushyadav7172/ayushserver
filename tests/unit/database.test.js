'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { DatabaseManager } = require('../../database/database');

describe('SQLite Database Layer & Migrations', () => {
  let db;
  let testDbPath;

  before(() => {
    testDbPath = path.join(os.tmpdir(), `test_db_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseManager(testDbPath);
    db.init();
  });

  after(() => {
    if (db) db.close();
    if (testDbPath && fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  test('executes migrations and enables WAL mode', () => {
    const pragmaRow = db.db.prepare('PRAGMA journal_mode;').get();
    assert.equal(pragmaRow.journal_mode.toLowerCase(), 'wal');

    const migrations = db.db.prepare('SELECT * FROM schema_migrations;').all();
    assert.ok(migrations.length >= 1);
    assert.equal(migrations[0].version, 1);
  });

  test('saves and retrieves job records', () => {
    const job = {
      id: 'job_test_db_1',
      sessionId: 'session_xyz',
      name: 'Test Transcode',
      type: 'media',
      operation: 'convert',
      status: 'queued',
      progress: 0,
      createdAt: Date.now()
    };

    db.saveJob(job);
    const retrieved = db.getJob('job_test_db_1');
    assert.ok(retrieved);
    assert.equal(retrieved.id, 'job_test_db_1');
    assert.equal(retrieved.name, 'Test Transcode');
    assert.equal(retrieved.status, 'queued');

    // Update status and progress
    job.status = 'processing';
    job.progress = 55;
    db.saveJob(job);
    const updated = db.getJob('job_test_db_1');
    assert.equal(updated.status, 'processing');
    assert.equal(updated.progress, 55);
  });

  test('appends and retrieves job logs', () => {
    db.appendJobLog('job_test_db_1', 'frame=10 fps=30\n');
    db.appendJobLog('job_test_db_1', 'frame=20 fps=30\n');
    const logs = db.getJobLogs('job_test_db_1');
    assert.ok(logs.includes('frame=10'));
    assert.ok(logs.includes('frame=20'));
  });

  test('persists and retrieves application settings', () => {
    db.setSetting('max_concurrency', 3);
    assert.equal(db.getSetting('max_concurrency'), 3);

    db.setSetting('custom_config', { mode: 'fast', crf: 22 });
    const conf = db.getSetting('custom_config');
    assert.equal(conf.mode, 'fast');
    assert.equal(conf.crf, 22);
  });

  test('records analytics events and aggregates summary', () => {
    db.recordAnalyticsEvent({
      jobId: 'job_test_db_1',
      type: 'media',
      operation: 'convert',
      status: 'completed',
      bytesProcessed: 5242880,
      durationMs: 4000
    });

    const summary = db.getAnalyticsSummary();
    assert.ok(summary.jobs);
    assert.ok(summary.totalBytesProcessed >= 5242880);
  });

  test('detects and marks unfinished jobs as interrupted on restart', () => {
    db.saveJob({
      id: 'job_interrupted_test',
      name: 'Unfinished Task',
      status: 'processing',
      createdAt: Date.now()
    });

    const marked = db.markInterruptedJobs();
    assert.ok(marked.some(j => j.id === 'job_interrupted_test'));
    const job = db.getJob('job_interrupted_test');
    assert.equal(job.status, 'interrupted');
    assert.ok(job.error.includes('interrupted'));
  });
});
