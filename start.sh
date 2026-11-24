#!/data/data/com.termux/files/usr/bin/bash
# ========================================================
# Termux Utility Studio - Launcher Script
# ========================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==================================================="
echo "  Starting Termux Utility Studio..."
echo "==================================================="

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "[-] Node.js is not installed. Installing nodejs..."
    pkg update -y && pkg install -y nodejs
fi

# Check FFmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "[-] FFmpeg is not installed. Installing ffmpeg..."
    pkg install -y ffmpeg
fi

# Install dependencies if missing
if [ ! -d "node_modules" ]; then
    echo "[+] Installing npm dependencies..."
    npm install
fi

# Check PDF tooling
for tool in qpdf pdftoppm; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "[!] $tool not found. PDF tools need: pkg install qpdf poppler"
    fi
done
if ! command -v gs >/dev/null 2>&1; then
    echo "[!] Ghostscript not found. PDF compression will use qpdf only. Optional: pkg install ghostscript"
fi

# Find local IP address for easy mobile, hotspot (ap0), cellular (ccmni/rmnet), or LAN access
LOCAL_IP=$(ip -4 addr show wlan0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' || true)
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP=$(ip -4 addr show ap0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' || true)
fi
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP=$(ip -4 addr show 2>/dev/null | grep -v '127.0.0.1' | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n 1 || echo "")
fi

echo ""
echo "[✓] Environment ready."
echo "[+] Opening Utility Studio at:"
echo "    Home:    http://localhost:3000"
echo "    Media:   http://localhost:3000/media"
echo "    PDF:     http://localhost:3000/pdf"
if [ -n "$LOCAL_IP" ]; then
    echo "    Network: http://${LOCAL_IP}:3000"
fi
echo ""
echo "Press Ctrl+C to stop the server."
echo "==================================================="

exec node server.js
