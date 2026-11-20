'use strict';

/**
 * Migration 001: Initial Schema
 * Creates tables for jobs, settings, analytics events, and backups metadata.
 */
module.exports = {
  version: 1,
  name: '001_initial_schema',
  up: (db) => {
    db.exec(`
      -- Jobs persistence table
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        name TEXT,
        type TEXT DEFAULT 'media',
        operation TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        progress REAL DEFAULT 0,
        current_time TEXT DEFAULT '00:00:00',
        total_duration TEXT DEFAULT '00:00:00',
        total_duration_sec REAL DEFAULT 0,
        speed TEXT DEFAULT 'N/A',
        input_path TEXT,
        output_path TEXT,
        command_string TEXT,
        options_json TEXT,
        meta_json TEXT,
        output_file_json TEXT,
        error TEXT,
        exit_code INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        is_remote_upload INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);

      -- Job logs table for persistent log output
      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        log_chunk TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);

      -- Application settings
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Analytics events
      CREATE TABLE IF NOT EXISTS analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        type TEXT NOT NULL,
        operation TEXT,
        status TEXT NOT NULL,
        bytes_processed INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(type);
      CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);

      -- Backups metadata
      CREATE TABLE IF NOT EXISTS backups_metadata (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'valid',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_backups_created ON backups_metadata(created_at);
    `);
  },
  down: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS job_logs;
      DROP TABLE IF EXISTS backups_metadata;
      DROP TABLE IF EXISTS analytics_events;
      DROP TABLE IF EXISTS settings;
      DROP TABLE IF EXISTS jobs;
    `);
  }
};
