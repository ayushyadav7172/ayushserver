'use strict';

/**
 * Migration 002: Authentication and RBAC Schema
 * Creates tables for users (admin accounts) and auth_sessions (session tokens).
 */
module.exports = {
  version: 2,
  name: '002_auth_schema',
  up: (db) => {
    db.exec(`
      -- Users table for admin credentials
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at INTEGER NOT NULL,
        last_login INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

      -- Authentication sessions table (1-hour sliding / absolute sessions)
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
    `);
  },
  down: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS auth_sessions;
      DROP TABLE IF EXISTS users;
    `);
  }
};
