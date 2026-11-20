# Backup & Restore Guide — Termux Utility Studio

Termux Utility Studio includes an automated and manual backup system for the internal SQLite database, settings, and job metadata.

---

## 1. Automated Backups

- **Default Interval:** Every 24 hours.
- **Backup Directory:** `/data/data/com.termux/files/home/ayushserver/backups/`
- **Mechanism:** Atomic SQLite snapshot using `VACUUM INTO '<filepath>'`.
- **Integrity:** SHA-256 cryptographic checksum calculation and `PRAGMA integrity_check` validation.
- **Retention:** By default, retains the 7 latest backups. Older backups are safely pruned.

---

## 2. Triggering Manual Backups

### Via Web Dashboard
Navigate to `http://localhost:3000/dashboard` and click the **Backup DB** button.

### Via REST API
```bash
curl -X POST http://localhost:3000/api/backup/run
```

**Response:**
```json
{
  "success": true,
  "backup": {
    "id": "backup_1795155400",
    "filename": "ayushserver-backup-2026-11-20T11-00-00-000Z.db",
    "filepath": "/data/data/com.termux/files/home/ayushserver/backups/ayushserver-backup-2026-11-20T11-00-00-000Z.db",
    "sizeBytes": 98304,
    "checksumSha256": "6c70f6c797...",
    "status": "valid",
    "createdAt": 1795155400000
  }
}
```

---

## 3. Listing Backups

```bash
curl http://localhost:3000/api/backup/list
```

---

## 4. Safe Restore Procedure

The restore system incorporates safety mechanisms to prevent data loss:
1. **Pre-Validation:** Calculates and verifies SHA-256 against stored checksum.
2. **Integrity Check:** Runs SQLite `PRAGMA integrity_check;` on the backup file before touching the live database.
3. **Safety Snapshot:** Creates an automatic pre-restore safety snapshot of the active database (`pre-restore-safety-<timestamp>.db`).
4. **Rollback Guard:** If an error occurs during replacement, automatically rolls back to the safety snapshot.
5. **Confirmation Guard:** Requires explicit confirmation (`confirm: true`).

### Restore via REST API
```bash
curl -X POST http://localhost:3000/api/backup/restore \
  -H "Content-Type: application/json" \
  -d '{
    "backupId": "backup_1795155400",
    "confirm": true
  }'
```

### Manual Command-Line Restore
If the server is stopped, you can restore manually:

```bash
# 1. Navigate to repository directory
cd /data/data/com.termux/files/home/ayushserver

# 2. Stop server if running
# Ctrl+C

# 3. Create a safety copy of current database
cp database/ayushserver.db database/ayushserver.db.safety

# 4. Remove temporary SQLite WAL/SHM files
rm -f database/ayushserver.db-wal database/ayushserver.db-shm

# 5. Copy the desired backup over the active database
cp backups/ayushserver-backup-2026-11-20T11-00-00-000Z.db database/ayushserver.db

# 6. Verify integrity with SQLite
sqlite3 database/ayushserver.db "PRAGMA integrity_check;"

# 7. Restart the server
npm start
```
