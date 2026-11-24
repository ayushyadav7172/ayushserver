'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { databaseManager } = require('../database/database');

const DEFAULT_BACKUPS_DIR = path.resolve(__dirname, '..', 'backups');
const DEFAULT_RETENTION_COUNT = 7;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

class BackupManager {
  constructor(options = {}) {
    this.backupsDir = options.backupsDir || DEFAULT_BACKUPS_DIR;
    this.retentionCount = options.retentionCount || DEFAULT_RETENTION_COUNT;
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.db = options.db || databaseManager;
    this.timer = null;
    this.lastBackup = null;
  }

  init() {
    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }

    // Load persisted retention setting if any
    try {
      const persistedRetention = this.db.getSetting('backup_retention_count');
      if (persistedRetention && typeof persistedRetention === 'number' && persistedRetention >= 1) {
        this.retentionCount = persistedRetention;
      }
    } catch (e) {}

    this.startScheduler();
    console.log(`[BackupManager] Initialized. Storing backups in ${this.backupsDir} (retention: ${this.retentionCount})`);
    return this;
  }

  startScheduler() {
    this.stopScheduler();
    this.timer = setInterval(() => {
      this.createBackup().catch(err => {
        console.error('[BackupManager] Scheduled backup error:', err.message);
      });
    }, this.intervalMs);
    if (this.timer && this.timer.unref) {
      this.timer.unref();
    }
  }

  stopScheduler() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setRetentionCount(count) {
    const n = parseInt(count, 10);
    if (isNaN(n) || n < 1 || n > 100) {
      throw new Error('Retention count must be an integer between 1 and 100');
    }
    this.retentionCount = n;
    this.db.setSetting('backup_retention_count', n);
    this.pruneOldBackups();
    return this.retentionCount;
  }

  computeChecksum(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  verifyDatabaseIntegrity(filePath) {
    try {
      const testDb = new DatabaseSync(filePath);
      const row = testDb.prepare('PRAGMA integrity_check;').get();
      testDb.close();
      const integrityResult = row ? Object.values(row)[0] : '';
      return integrityResult === 'ok';
    } catch (e) {
      console.warn(`[BackupManager] Integrity check failed for ${filePath}:`, e.message);
      return false;
    }
  }

  async createBackup() {
    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ayushserver-backup-${timestamp}.db`;
    const targetPath = path.join(this.backupsDir, filename);

    console.log(`[BackupManager] Starting atomic backup to ${filename}...`);

    try {
      // Use VACUUM INTO for consistent WAL snapshot
      const rawDb = this.db.db;
      if (!rawDb) {
        throw new Error('Database is not initialized');
      }

      const safeTargetPath = String(targetPath).replace(/'/g, "''");
      rawDb.exec(`VACUUM INTO '${safeTargetPath}';`);

      const stat = fs.statSync(targetPath);
      const checksum = await this.computeChecksum(targetPath);
      const isIntegrityOk = this.verifyDatabaseIntegrity(targetPath);

      if (!isIntegrityOk) {
        throw new Error('Database integrity check failed on generated backup file');
      }

      const id = `backup_${Date.now()}`;
      const metadata = {
        id,
        filename,
        filepath: targetPath,
        sizeBytes: stat.size,
        checksumSha256: checksum,
        status: 'valid',
        createdAt: Date.now()
      };

      this.db.recordBackup(metadata);
      this.lastBackup = metadata;

      console.log(`[BackupManager] Backup created successfully: ${filename} (${stat.size} bytes, sha256: ${checksum.slice(0, 10)}...)`);

      // Prune older backups
      this.pruneOldBackups();

      return metadata;
    } catch (err) {
      console.error('[BackupManager] Backup failed:', err.message);
      if (fs.existsSync(targetPath)) {
        try { fs.unlinkSync(targetPath); } catch (e) {}
      }
      throw err;
    }
  }

  pruneOldBackups() {
    try {
      const records = this.db.getBackups();
      if (records.length <= this.retentionCount) return;

      const toPrune = records.slice(this.retentionCount);
      for (const b of toPrune) {
        console.log(`[BackupManager] Pruning old backup: ${b.filename}`);
        if (fs.existsSync(b.filepath)) {
          try { fs.unlinkSync(b.filepath); } catch (e) {}
        }
        this.db.deleteBackup(b.id);
      }
    } catch (err) {
      console.warn('[BackupManager] Error during backup pruning:', err.message);
    }
  }

  getBackupsList() {
    const list = this.db.getBackups();
    return list.map(b => ({
      id: b.id,
      filename: b.filename,
      sizeBytes: b.size_bytes,
      checksum: b.checksum_sha256,
      status: b.status,
      createdAt: b.created_at,
      existsOnDisk: fs.existsSync(b.filepath)
    }));
  }

  async restoreBackup(backupId, confirm = false) {
    if (!confirm) {
      throw new Error('Explicit confirmation is required to restore a backup (set confirm: true)');
    }

    const backup = this.db.getBackupById(backupId);
    if (!backup) {
      throw new Error(`Backup with ID ${backupId} not found`);
    }

    if (!fs.existsSync(backup.filepath)) {
      throw new Error(`Backup file does not exist on disk: ${backup.filepath}`);
    }

    // 1. Verify checksum
    const currentChecksum = await this.computeChecksum(backup.filepath);
    if (currentChecksum !== backup.checksum_sha256) {
      throw new Error('Backup integrity validation failed: checksum mismatch');
    }

    // 2. Verify SQLite integrity
    const isOk = this.verifyDatabaseIntegrity(backup.filepath);
    if (!isOk) {
      throw new Error('Backup integrity check failed: file is corrupt');
    }

    // 3. Create pre-restore safety snapshot of active database
    const safetySnapshotPath = path.join(this.backupsDir, `pre-restore-safety-${Date.now()}.db`);
    try {
      const safeSnapshotPath = String(safetySnapshotPath).replace(/'/g, "''");
      this.db.db.exec(`VACUUM INTO '${safeSnapshotPath}';`);
    } catch (e) {
      console.warn('[BackupManager] Could not create pre-restore snapshot:', e.message);
    }

    // 4. Safely swap database
    const activeDbPath = this.db.dbPath;
    this.db.close();

    try {
      // Remove WAL and SHM if present
      const walPath = activeDbPath + '-wal';
      const shmPath = activeDbPath + '-shm';
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

      // Copy backup file over active database
      fs.copyFileSync(backup.filepath, activeDbPath);

      // Re-initialize database
      this.db.init();

      console.log(`[BackupManager] Database successfully restored from ${backup.filename}`);
      return {
        success: true,
        message: `Database restored successfully from backup ${backup.filename}`,
        safetySnapshot: fs.existsSync(safetySnapshotPath) ? path.basename(safetySnapshotPath) : null
      };
    } catch (restoreErr) {
      console.error('[BackupManager] Fatal error during restore, attempting rollback:', restoreErr);
      if (fs.existsSync(safetySnapshotPath)) {
        try {
          fs.copyFileSync(safetySnapshotPath, activeDbPath);
          this.db.init();
        } catch (e) {}
      }
      throw restoreErr;
    }
  }
}

const defaultBackupManager = new BackupManager();

module.exports = {
  BackupManager,
  backupManager: defaultBackupManager
};
