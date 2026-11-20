'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { QueueManager } = require('../../services/queue-manager');
const { JobManager, calculateEtaSeconds } = require('../../services/job-manager');
const { DatabaseManager } = require('../../database/database');

describe('FFmpeg Queue Manager & Background Execution', () => {
  let db;
  let jm;
  let qm;
  let testDbPath;

  before(() => {
    testDbPath = path.join(os.tmpdir(), `test_qm_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseManager(testDbPath);
    db.init();
    jm = new JobManager(db);
    qm = new QueueManager({ maxConcurrency: 1, maxQueueSize: 5, db, jobManager: jm });
  });

  after(() => {
    if (qm) qm.shutdown();
    if (db) db.close();
    if (testDbPath && fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  test('enforces concurrency limit and queues extra jobs', (t, done) => {
    let executedJobs = [];

    // Mock executor
    qm.setExecutor((job) => {
      executedJobs.push(job.id);
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: true });
        }, 80);
      });
    });

    const job1 = qm.enqueue({ id: 'q_job_1', name: 'Task 1' });
    const job2 = qm.enqueue({ id: 'q_job_2', name: 'Task 2' });

    assert.equal(qm.queue.length, 1); // job2 is queued
    assert.equal(qm.queue[0], 'q_job_2');

    setTimeout(() => {
      // After job1 finishes, job2 should be picked up
      assert.ok(executedJobs.includes('q_job_1'));
      setTimeout(() => {
        assert.ok(executedJobs.includes('q_job_2'));
        done();
      }, 120);
    }, 100);
  });

  test('rejects job submission with 429 when queue limit is reached', () => {
    const tinyQm = new QueueManager({ maxConcurrency: 1, maxQueueSize: 2, db, jobManager: jm });
    tinyQm.setExecutor(() => new Promise(() => {})); // hung

    tinyQm.enqueue({ id: 'tiny_1', name: 'Running' });
    tinyQm.enqueue({ id: 'tiny_2', name: 'Queued 1' });
    tinyQm.enqueue({ id: 'tiny_3', name: 'Queued 2' });

    assert.throws(() => {
      tinyQm.enqueue({ id: 'tiny_4', name: 'Overflow' });
    }, (err) => {
      return err.status === 429 && err.message.includes('Queue is full');
    });

    tinyQm.shutdown();
  });

  test('cancels queued jobs immediately before execution', () => {
    const testQm = new QueueManager({ maxConcurrency: 1, maxQueueSize: 5, db, jobManager: jm });
    testQm.setExecutor(() => new Promise(() => {})); // hung mock

    testQm.enqueue({ id: 'cancel_1', name: 'Active' });
    const queuedJob = testQm.enqueue({ id: 'cancel_2', name: 'To Cancel' });

    assert.equal(testQm.queue.includes('cancel_2'), true);

    const cancelResult = testQm.cancelJob('cancel_2');
    assert.equal(cancelResult.success, true);
    assert.equal(testQm.queue.includes('cancel_2'), false);
    assert.equal(queuedJob.status, 'cancelled');

    testQm.shutdown();
  });

  test('calculates accurate ETA based on speed and percentage rate', () => {
    // 100 seconds total, currently at 50s with 2.0x speed -> 25s remaining
    const eta1 = calculateEtaSeconds(100, 50, '2.0x', 50, 25);
    assert.equal(eta1, 25);

    // 100s total, at 20s with 1.0x speed -> 80s remaining
    const eta2 = calculateEtaSeconds(100, 20, '1.0x', 20, 20);
    assert.equal(eta2, 80);

    // Fallback using percent and elapsed seconds (50% in 10s -> remaining 50% takes 10s)
    const eta3 = calculateEtaSeconds(100, 50, 'N/A', 50, 10);
    assert.equal(eta3, 10);
  });
});
