#!/data/data/com.termux/files/usr/bin/bash
# ========================================================
# AyushServer - 1-Click Fast Updater
# Usage: update ayushserver  OR  ./update.sh
# ========================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================================"
echo "   🚀 AyushServer — Fetching Latest Update from GitHub"
echo "========================================================"

# 1. Fetch latest changes from GitHub
echo "[1/4] Pulling latest updates from GitHub..."
git pull origin main

# 2. Update npm dependencies
echo "[2/4] Updating package dependencies..."
npm install --no-audit --no-fund

# 3. Verify SQLite DB and migrations
echo "[3/4] Verifying database integrity..."
node -e "
const { databaseManager } = require('./database/database');
console.log('[+] Database status: Online (Admin registered:', databaseManager.hasAnyAdmin() + ')');
"

# 4. Ensure permissions and refresh global shortcuts
echo "[4/4] Finalizing shortcuts and permissions..."
chmod +x start.sh setup.sh update.sh
if [ -f "setup.sh" ]; then
    ./setup.sh >/dev/null 2>&1 || true
fi

echo ""
echo "========================================================"
echo "  ✅ AyushServer successfully updated to latest version!"
echo "  🚀 Server start karne ke liye type karein: 'studio'"
echo "  🔄 Agli baar update ke liye: 'update ayushserver'"
echo "========================================================"
