'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { DatabaseManager } = require('../../database/database');
const { BackupManager } = require('../../services/backup-manager');

describe('Automatic SQLite Backup Manager', () => {
  let db;
  let bm;
  let testDir;

  before(() => {
    testDir = path.join(os.tmpdir(), `test_backup_dir_${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    const dbPath = path.join(testDir, 'app.db');
    db = new DatabaseManager(dbPath);
    db.init();
    db.setSetting('site_name', 'Termux Studio');

    bm = new BackupManager({
      backupsDir: path.join(testDir, 'backups'),
      retentionCount: 3,
      db
    });
    bm.init();
  });

  after(() => {
    if (bm) bm.stopScheduler();
    if (db) db.close();
    if (testDir && fs.existsSync(testDir)) {
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('creates consistent atomic SQLite backup with VACUUM INTO and SHA-256', async () => {
    const backup = await bm.createBackup();
    assert.ok(backup.id);
    assert.ok(backup.filename.endsWith('.db'));
    assert.ok(backup.sizeBytes > 0);
    assert.ok(backup.checksumSha256);
    assert.equal(backup.status, 'valid');

    // Verify backup file exists
    assert.equal(fs.existsSync(backup.filepath), true);

    // Verify integrity of created SQLite backup
    const isIntegrityOk = bm.verifyDatabaseIntegrity(backup.filepath);
    assert.equal(isIntegrityOk, true);
  });

  test('prunes old backups according to retention limit', async () => {
    // Current retention is 3. We already have 1. Let's create 4 more.
    await bm.createBackup();
    await bm.createBackup();
    await bm.createBackup();
    await bm.createBackup();

    const list = bm.getBackupsList();
    assert.equal(list.length, 3);
  });

  test('safely restores database with pre-restore safety snapshot', async () => {
    // 1. Create a baseline backup
    db.setSetting('important_state', 'original_version');
    const backupToRestore = await bm.createBackup();

    // 2. Mutate active database
    db.setSetting('important_state', 'corrupted_state');
    assert.equal(db.getSetting('important_state'), 'corrupted_state');

    // 3. Restore from backup
    const result = await bm.restoreBackup(backupToRestore.id, true);
    assert.equal(result.success, true);
    assert.ok(result.safetySnapshot);

    // 4. Verify original state was restored
    assert.equal(db.getSetting('important_state'), 'original_version');
  });

  test('rejects restore attempt when confirmation is false', async () => {
    const list = bm.getBackupsList();
    await assert.rejects(async () => {
      await bm.restoreBackup(list[0].id, false);
    }, /confirmation is required/);
  });
});
