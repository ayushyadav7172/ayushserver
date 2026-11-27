#!/data/data/com.termux/files/usr/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================="
echo "   AyushServer — 1-Click Updater"
echo "============================================="

echo "[1/4] Fetching latest code from GitHub..."
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git pull origin "$CURRENT_BRANCH"

echo "[2/4] Updating package dependencies..."
npm install

echo "[3/4] Verifying database and migrations..."
node -e "
const { databaseManager } = require('./database/database');
console.log('[+] SQLite Database verified. Admin exists:', databaseManager.hasAnyAdmin());
"

echo "[4/4] Running quick sanity check..."
node -c server.js
node -c pdf-routes.js

echo "============================================="
echo "   ✔ AyushServer successfully updated!"
echo "   Run 'npm start' or './start.sh' to launch."
echo "============================================="
