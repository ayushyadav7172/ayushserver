'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_DIR = path.join(__dirname);
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'ayushserver.db');

class DatabaseManager {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    this.db = null;
    this._initialized = false;
    this._restoring = false;
  }

  _assertNotRestoring() {
    if (this._restoring) {
      const err = new Error('Database restore is currently in progress. Please retry momentarily.');
      err.status = 503;
      throw err;
    }
  }

  init() {
    this._assertNotRestoring();
    if (this._initialized && this.db) {
      return this;
    }

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);

    // Performance and safety pragmas
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    this._runMigrations();
    this._prepareStatements();
    this._initialized = true;

    return this;
  }

  _runMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const appliedRows = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
    const appliedVersions = new Set(appliedRows.map(r => r.version));

    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) return;

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    for (const file of files) {
      const migrationPath = path.join(migrationsDir, file);
      const migration = require(migrationPath);

      if (!appliedVersions.has(migration.version)) {
        console.log(`[Database] Applying migration ${migration.version}: ${migration.name}`);
        this.db.exec('BEGIN IMMEDIATE;');
        try {
          migration.up(this.db);
          const insertStmt = this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
          insertStmt.run(migration.version, migration.name, Date.now());
          this.db.exec('COMMIT;');
        } catch (err) {
          this.db.exec('ROLLBACK;');
          console.error(`[Database] Migration ${migration.version} failed:`, err);
          throw err;
        }
      }
    }
  }

  _prepareStatements() {
    // Jobs statements
    this.stmtInsertJob = this.db.prepare(`
      INSERT INTO jobs (
        id, session_id, name, type, operation, status, progress,
        current_time, total_duration, total_duration_sec, speed,
        input_path, output_path, command_string, options_json, meta_json,
        output_file_json, error, exit_code, created_at, started_at, completed_at,
        duration_ms, is_remote_upload
      ) VALUES (
        @id, @session_id, @name, @type, @operation, @status, @progress,
        @current_time, @total_duration, @total_duration_sec, @speed,
        @input_path, @output_path, @command_string, @options_json, @meta_json,
        @output_file_json, @error, @exit_code, @created_at, @started_at, @completed_at,
        @duration_ms, @is_remote_upload
      )
    `);

    this.stmtUpdateJob = this.db.prepare(`
      UPDATE jobs SET
        session_id = @session_id,
        name = @name,
        type = @type,
        operation = @operation,
        status = @status,
        progress = @progress,
        current_time = @current_time,
        total_duration = @total_duration,
        total_duration_sec = @total_duration_sec,
        speed = @speed,
        input_path = @input_path,
        output_path = @output_path,
        command_string = @command_string,
        options_json = @options_json,
        meta_json = @meta_json,
        output_file_json = @output_file_json,
        error = @error,
        exit_code = @exit_code,
        created_at = @created_at,
        started_at = @started_at,
        completed_at = @completed_at,
        duration_ms = @duration_ms,
        is_remote_upload = @is_remote_upload
      WHERE id = @id
    `);

    this.stmtGetJob = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    this.stmtDeleteJob = this.db.prepare('DELETE FROM jobs WHERE id = ?');

    // Logs statements
    this.stmtInsertLog = this.db.prepare('INSERT INTO job_logs (job_id, log_chunk, created_at) VALUES (?, ?, ?)');
    this.stmtGetLogs = this.db.prepare('SELECT log_chunk FROM job_logs WHERE job_id = ? ORDER BY id ASC');
    this.stmtDeleteLogs = this.db.prepare('DELETE FROM job_logs WHERE job_id = ?');

    // Settings statements
    this.stmtGetSetting = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    this.stmtSetSetting = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    this.stmtGetAllSettings = this.db.prepare('SELECT key, value, updated_at FROM settings');

    // Analytics statements
    this.stmtInsertAnalytics = this.db.prepare(`
      INSERT INTO analytics_events (job_id, type, operation, status, bytes_processed, duration_ms, created_at)
      VALUES (@job_id, @type, @operation, @status, @bytes_processed, @duration_ms, @created_at)
    `);

    // Backups statements
    this.stmtInsertBackup = this.db.prepare(`
      INSERT INTO backups_metadata (id, filename, filepath, size_bytes, checksum_sha256, status, created_at)
      VALUES (@id, @filename, @filepath, @size_bytes, @checksum_sha256, @status, @created_at)
    `);
    this.stmtGetBackups = this.db.prepare('SELECT * FROM backups_metadata ORDER BY created_at DESC');
    this.stmtGetBackupById = this.db.prepare('SELECT * FROM backups_metadata WHERE id = ?');
    this.stmtDeleteBackup = this.db.prepare('DELETE FROM backups_metadata WHERE id = ?');

    // Auth & Users statements
    this.stmtHasAdmin = this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'");
    this.stmtInsertUser = this.db.prepare(`
      INSERT INTO users (id, username, password_hash, salt, role, created_at, last_login)
      VALUES (@id, @username, @password_hash, @salt, @role, @created_at, @last_login)
    `);
    this.stmtGetUserByUsername = this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
    this.stmtGetUserById = this.db.prepare('SELECT * FROM users WHERE id = ?');
    this.stmtUpdateUserLastLogin = this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?');

    // Sessions statements
    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO auth_sessions (token, user_id, username, role, created_at, expires_at, last_active)
      VALUES (@token, @user_id, @username, @role, @created_at, @expires_at, @last_active)
    `);
    this.stmtGetSession = this.db.prepare('SELECT * FROM auth_sessions WHERE token = ?');
    this.stmtTouchSession = this.db.prepare('UPDATE auth_sessions SET last_active = ?, expires_at = ? WHERE token = ?');
    this.stmtDeleteSession = this.db.prepare('DELETE FROM auth_sessions WHERE token = ?');
    this.stmtDeleteExpiredSessions = this.db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?');
  }

  // ==================== JOBS API ====================
  saveJob(job) {
    if (!this.db) this.init();

    const record = {
      id: String(job.id || job.jobId),
      session_id: job.sessionId ? String(job.sessionId) : null,
      name: job.name ? String(job.name) : null,
      type: job.type ? String(job.type) : 'media',
      operation: job.operation ? String(job.operation) : null,
      status: String(job.status || 'queued'),
      progress: typeof job.progress === 'number'
        ? job.progress
        : (job.progress && typeof job.progress.percent === 'number' ? job.progress.percent : 0),
      current_time: job.currentTime || (job.progress && job.progress.time) || '00:00:00',
      total_duration: job.totalDuration || '00:00:00',
      total_duration_sec: job.totalDurationSec || job.expectedDuration || 0,
      speed: job.speed || (job.progress && job.progress.speed) || 'N/A',
      input_path: job.filePath || (Array.isArray(job.inputPaths) ? job.inputPaths[0] : null) || null,
      output_path: job.outputPath || null,
      command_string: job.commandString || null,
      options_json: job.options ? JSON.stringify(job.options) : null,
      meta_json: job.meta ? JSON.stringify(job.meta) : null,
      output_file_json: job.outputFile ? JSON.stringify(job.outputFile) : null,
      error: job.error ? String(job.error) : null,
      exit_code: typeof job.exitCode === 'number' ? job.exitCode : null,
      created_at: job.createdAt || Date.now(),
      started_at: job.startedAt || null,
      completed_at: job.completedAt || null,
      duration_ms: job.durationMs || (job.completedAt && job.startedAt ? job.completedAt - job.startedAt : null),
      is_remote_upload: job.isRemoteUpload ? 1 : 0
    };

    const existing = this.stmtGetJob.get(record.id);
    if (!existing) {
      this.stmtInsertJob.run(record);
    } else {
      this.stmtUpdateJob.run(record);
    }

    return record;
  }

  getJob(id) {
    if (!this.db) this.init();
    const row = this.stmtGetJob.get(String(id));
    if (!row) return null;
    return this._formatJobRow(row);
  }

  getJobs(options = {}) {
    if (!this.db) this.init();
    const { sessionId, status, type, limit = 50, offset = 0 } = options;
    const conditions = [];
    const params = [];

    if (sessionId) {
      conditions.push('session_id = ?');
      params.push(sessionId);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    let sql = 'SELECT * FROM jobs';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => this._formatJobRow(r));
  }

  deleteJob(id) {
    if (!this.db) this.init();
    const strId = String(id);
    this.stmtDeleteLogs.run(strId);
    this.stmtDeleteJob.run(strId);
    return true;
  }

  clearJobs(sessionId = null, options = {}) {
    if (!this.db) this.init();
    if (sessionId) {
      const rows = this.db.prepare('SELECT id FROM jobs WHERE session_id = ?').all(sessionId);
      for (const row of rows) {
        this.deleteJob(row.id);
      }
      return rows.length;
    }
    if (options.onlyUnscoped) {
      const rows = this.db.prepare('SELECT id FROM jobs WHERE session_id IS NULL').all();
      for (const row of rows) {
        this.deleteJob(row.id);
      }
      return rows.length;
    }
    this.db.exec('DELETE FROM job_logs;');
    this.db.exec('DELETE FROM jobs;');
    return true;
  }

  appendJobLog(jobId, logChunk) {
    if (!this.db) this.init();
    if (!logChunk) return;
    this.stmtInsertLog.run(String(jobId), String(logChunk), Date.now());
  }

  getJobLogs(jobId) {
    if (!this.db) this.init();
    const rows = this.stmtGetLogs.all(String(jobId));
    return rows.map(r => r.log_chunk).join('');
  }

  getUnfinishedJobs() {
    if (!this.db) this.init();
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'processing') ORDER BY created_at ASC").all();
    return rows.map(r => this._formatJobRow(r));
  }

  markInterruptedJobs() {
    if (!this.db) this.init();
    const unfinished = this.getUnfinishedJobs();
    const now = Date.now();
    const updated = [];

    for (const job of unfinished) {
      // Check if output file exists and is valid
      let status = 'interrupted';
      let error = 'Process interrupted by server restart or shutdown';

      if (job.outputPath && fs.existsSync(job.outputPath)) {
        try {
          const stat = fs.statSync(job.outputPath);
          // If output has size 0, clean it up
          if (stat.size === 0) {
            fs.unlinkSync(job.outputPath);
          }
        } catch (e) {}
      }

      this.db.prepare(`
        UPDATE jobs
        SET status = ?, error = ?, completed_at = ?
        WHERE id = ?
      `).run(status, error, now, job.id);

      updated.push({ ...job, status, error, completedAt: now });
    }

    return updated;
  }

  _formatJobRow(row) {
    let options = null;
    let meta = null;
    let outputFile = null;

    try { if (row.options_json) options = JSON.parse(row.options_json); } catch (e) {}
    try { if (row.meta_json) meta = JSON.parse(row.meta_json); } catch (e) {}
    try { if (row.output_file_json) outputFile = JSON.parse(row.output_file_json); } catch (e) {}

    return {
      id: row.id,
      jobId: row.id,
      sessionId: row.session_id,
      name: row.name,
      type: row.type,
      operation: row.operation,
      status: row.status,
      progress: row.progress,
      currentTime: row.current_time,
      totalDuration: row.total_duration,
      totalDurationSec: row.total_duration_sec,
      speed: row.speed,
      filePath: row.input_path,
      inputPaths: row.input_path ? [row.input_path] : [],
      outputPath: row.output_path,
      commandString: row.command_string,
      options,
      meta,
      outputFile,
      error: row.error,
      exitCode: row.exit_code,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      isRemoteUpload: Boolean(row.is_remote_upload)
    };
  }

  // ==================== SETTINGS API ====================
  getSetting(key, defaultValue = null) {
    if (!this.db) this.init();
    const row = this.stmtGetSetting.get(String(key));
    if (!row) return defaultValue;
    try {
      return JSON.parse(row.value);
    } catch (e) {
      return row.value;
    }
  }

  setSetting(key, value) {
    if (!this.db) this.init();
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    this.stmtSetSetting.run(String(key), strVal, Date.now());
    return true;
  }

  getAllSettings() {
    if (!this.db) this.init();
    const rows = this.stmtGetAllSettings.all();
    const result = {};
    for (const r of rows) {
      try {
        result[r.key] = JSON.parse(r.value);
      } catch (e) {
        result[r.key] = r.value;
      }
    }
    return result;
  }

  // ==================== ANALYTICS API ====================
  recordAnalyticsEvent(event) {
    if (!this.db) this.init();
    const record = {
      job_id: event.jobId ? String(event.jobId) : null,
      type: String(event.type || 'media'),
      operation: event.operation ? String(event.operation) : 'unknown',
      status: String(event.status || 'completed'),
      bytes_processed: Number(event.bytesProcessed || 0),
      duration_ms: Number(event.durationMs || 0),
      created_at: event.createdAt || Date.now()
    };
    this.stmtInsertAnalytics.run(record);
  }

  getAnalyticsSummary() {
    if (!this.db) this.init();

    const jobCounts = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) as interrupted,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        AVG(CASE WHEN status = 'completed' AND duration_ms > 0 THEN duration_ms ELSE NULL END) as avgDurationMs
      FROM jobs
    `).get();

    const mediaBytes = this.db.prepare(`
      SELECT SUM(bytes_processed) as totalBytes
      FROM analytics_events
      WHERE status = 'completed' AND (type = 'media' OR type IS NULL)
    `).get();

    const imageCounts = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'completed' THEN bytes_processed ELSE 0 END) as totalBytes,
        AVG(CASE WHEN status = 'completed' AND duration_ms > 0 THEN duration_ms ELSE NULL END) as avgDurationMs
      FROM analytics_events
      WHERE type = 'image'
    `).get() || {};

    const pdfCounts = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'completed' THEN bytes_processed ELSE 0 END) as totalBytes,
        AVG(CASE WHEN status = 'completed' AND duration_ms > 0 THEN duration_ms ELSE NULL END) as avgDurationMs
      FROM analytics_events
      WHERE type = 'pdf'
    `).get() || {};

    const clearedAt = parseInt(this.getSetting('errors_cleared_at') || '0', 10);
    const recentErrors = this.db.prepare(`
      SELECT id, name, operation, error, completed_at
      FROM jobs
      WHERE status IN ('failed', 'interrupted') 
        AND error IS NOT NULL 
        AND (completed_at IS NULL OR completed_at > ?)
      ORDER BY completed_at DESC
      LIMIT 10
    `).all(clearedAt);

    return {
      jobs: {
        total: jobCounts.total || 0,
        completed: jobCounts.completed || 0,
        failed: jobCounts.failed || 0,
        cancelled: jobCounts.cancelled || 0,
        interrupted: jobCounts.interrupted || 0,
        processing: jobCounts.processing || 0,
        queued: jobCounts.queued || 0,
        avgDurationMs: Math.round(jobCounts.avgDurationMs || 0)
      },
      totalBytesProcessed: mediaBytes?.totalBytes || 0,
      image: {
        total: imageCounts.total || 0,
        completed: imageCounts.completed || 0,
        failed: imageCounts.failed || 0,
        totalBytes: imageCounts.totalBytes || 0,
        avgDurationMs: Math.round(imageCounts.avgDurationMs || 0)
      },
      pdf: {
        total: pdfCounts.total || 0,
        completed: pdfCounts.completed || 0,
        failed: pdfCounts.failed || 0,
        totalBytes: pdfCounts.totalBytes || 0,
        avgDurationMs: Math.round(pdfCounts.avgDurationMs || 0)
      },
      recentErrors: recentErrors.map(r => ({
        id: r.id,
        name: r.name,
        operation: r.operation,
        error: r.error,
        completedAt: r.completed_at
      }))
    };
  }

  clearRecentErrors() {
    if (!this.db) this.init();
    const now = Date.now();
    this.setSetting('errors_cleared_at', now);
    this.db.prepare(`
      UPDATE jobs
      SET error = NULL
      WHERE status IN ('failed', 'interrupted')
    `).run();
    return { success: true, clearedAt: now };
  }

  // ==================== BACKUPS API ====================
  recordBackup(metadata) {
    if (!this.db) this.init();
    const record = {
      id: String(metadata.id),
      filename: String(metadata.filename),
      filepath: String(metadata.filepath),
      size_bytes: Number(metadata.sizeBytes || 0),
      checksum_sha256: String(metadata.checksumSha256),
      status: String(metadata.status || 'valid'),
      created_at: metadata.createdAt || Date.now()
    };
    this.stmtInsertBackup.run(record);
    return record;
  }

  getBackups() {
    if (!this.db) this.init();
    return this.stmtGetBackups.all();
  }

  getBackupById(id) {
    if (!this.db) this.init();
    return this.stmtGetBackupById.get(String(id));
  }

  deleteBackup(id) {
    if (!this.db) this.init();
    return this.stmtDeleteBackup.run(String(id));
  }

  // ==================== AUTH & USER API ====================
  hasAnyAdmin() {
    if (!this.db) this.init();
    const row = this.stmtHasAdmin.get();
    return Boolean(row && row.count > 0);
  }

  createUser(userData) {
    if (!this.db) this.init();
    const record = {
      id: userData.id || `usr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      username: String(userData.username).trim(),
      password_hash: userData.passwordHash,
      salt: userData.salt,
      role: userData.role || 'admin',
      created_at: userData.createdAt || Date.now(),
      last_login: userData.lastLogin || null
    };
    this.stmtInsertUser.run(record);
    return record;
  }

  getUserByUsername(username) {
    if (!this.db) this.init();
    if (!username) return null;
    return this.stmtGetUserByUsername.get(String(username).trim()) || null;
  }

  getUserById(id) {
    if (!this.db) this.init();
    if (!id) return null;
    return this.stmtGetUserById.get(String(id)) || null;
  }

  updateUserLastLogin(id) {
    if (!this.db) this.init();
    const now = Date.now();
    this.stmtUpdateUserLastLogin.run(now, String(id));
    return now;
  }

  createAuthSession(sessionData = {}) {
    if (!this.db) this.init();
    const now = Date.now();
    const maxAgeMs = typeof sessionData.maxAgeMs === 'number' ? sessionData.maxAgeMs : 3600000; // 1 hour default
    const userExists = sessionData.userId ? this.getUserById(sessionData.userId) : null;
    const record = {
      token: sessionData.token || crypto.randomBytes(32).toString('hex'),
      user_id: userExists ? String(sessionData.userId) : null,
      username: sessionData.username || 'guest',
      role: sessionData.role || 'guest',
      created_at: now,
      expires_at: now + maxAgeMs,
      last_active: now
    };
    this.stmtInsertSession.run(record);
    return record;
  }

  getAuthSession(token) {
    if (!this.db) this.init();
    if (!token) return null;
    const session = this.stmtGetSession.get(String(token));
    if (!session) return null;

    const now = Date.now();
    if (session.expires_at < now) {
      this.stmtDeleteSession.run(session.token);
      return null;
    }
    return session;
  }

  touchAuthSession(token, maxAgeMs = 3600000) {
    if (!this.db) this.init();
    if (!token) return false;
    const now = Date.now();
    const newExpiresAt = now + maxAgeMs;
    const res = this.stmtTouchSession.run(now, newExpiresAt, String(token));
    return res.changes > 0;
  }

  deleteAuthSession(token) {
    if (!this.db) this.init();
    if (!token) return false;
    const res = this.stmtDeleteSession.run(String(token));
    return res.changes > 0;
  }

  cleanupExpiredSessions() {
    if (!this.db) this.init();
    const now = Date.now();
    const res = this.stmtDeleteExpiredSessions.run(now);
    return res.changes || 0;
  }

  getAllAdmins() {
    if (!this.db) this.init();
    return this.db.prepare("SELECT id, username, created_at, last_login FROM users WHERE role = 'admin'").all();
  }

  resetAdminPassword(username, newPassword) {
    if (!this.db) this.init();
    const user = this.getUserByUsername(username);
    if (!user) return false;
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
    this.db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
      .run(passwordHash, salt, user.id);
    this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
    return true;
  }

  updateAdminCredentials(oldUsername, newUsername, newPassword) {
    if (!this.db) this.init();
    const user = this.getUserByUsername(oldUsername);
    if (!user) return false;
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
    this.db.prepare('UPDATE users SET username = ?, password_hash = ?, salt = ? WHERE id = ?')
      .run(newUsername.trim(), passwordHash, salt, user.id);
    this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
    return true;
  }

  clearAllAdmins() {
    if (!this.db) this.init();
    this.db.exec('DELETE FROM auth_sessions;');
    const res = this.db.prepare("DELETE FROM users WHERE role = 'admin'").run();
    return res.changes || 0;
  }

  close() {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        this.db.close();
      } catch (e) {
        console.warn('[Database] Error during close:', e.message);
      }
      this.db = null;
      this._initialized = false;
    }
  }
}

// Singleton instance for application
const defaultManager = new DatabaseManager();

module.exports = {
  DatabaseManager,
  databaseManager: defaultManager
};
