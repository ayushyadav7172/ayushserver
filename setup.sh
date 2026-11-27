#!/data/data/com.termux/files/usr/bin/bash
# ========================================================
# AyushServer - Environment & Shortcut Setup
# ========================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Setting up AyushServer shortcuts..."

chmod +x start.sh setup.sh update.sh

# 1. Install global binaries in Termux $PREFIX/bin (works from any directory)
if [ -d "$PREFIX/bin" ] && [ -w "$PREFIX/bin" ]; then
    # Global 'studio' command
    cat << EOF > "$PREFIX/bin/studio"
#!/data/data/com.termux/files/usr/bin/bash
exec bash "$SCRIPT_DIR/start.sh" "\$@"
EOF
    chmod +x "$PREFIX/bin/studio"

    # Global 'update-ayushserver' command
    cat << EOF > "$PREFIX/bin/update-ayushserver"
#!/data/data/com.termux/files/usr/bin/bash
exec bash "$SCRIPT_DIR/update.sh" "\$@"
EOF
    chmod +x "$PREFIX/bin/update-ayushserver"

    # Global 'update' command (supports 'update ayushserver')
    cat << 'EOF' > "$PREFIX/bin/update"
#!/data/data/com.termux/files/usr/bin/bash
TARGET_DIR="${AYUSHSERVER_DIR:-$HOME/ayushserver}"
if [ "$1" = "ayushserver" ] || [ -z "$1" ]; then
    if [ -f "$TARGET_DIR/update.sh" ]; then
        exec bash "$TARGET_DIR/update.sh"
    elif [ -f "./update.sh" ]; then
        exec bash "./update.sh"
    else
        echo "❌ AyushServer directory not found at $TARGET_DIR"
        exit 1
    fi
else
    exec pkg update "$@"
fi
EOF
    chmod +x "$PREFIX/bin/update"
fi

# 2. Configure ~/.bashrc for interactive shells
BASHRC="$HOME/.bashrc"
touch "$BASHRC"

# Clean old entries
if [ -f "$BASHRC" ]; then
    grep -v "studio" "$BASHRC" | grep -v "update-ayushserver" | grep -v "update ayushserver" | grep -v "AyushServer Shortcuts" > "${BASHRC}.tmp" || true
    mv "${BASHRC}.tmp" "$BASHRC"
fi

cat << EOF >> "$BASHRC"

# --- AyushServer Shortcuts ---
alias studio='cd "$SCRIPT_DIR" && ./start.sh'
alias update-ayushserver='cd "$SCRIPT_DIR" && ./update.sh'

update() {
    if [ "\$1" = "ayushserver" ] || [ -z "\$1" ]; then
        (cd "$SCRIPT_DIR" && ./update.sh)
    else
        command pkg update "\$@"
    fi
}
EOF

echo ""
echo "========================================================"
echo "  ✅ Setup complete!"
echo "  🚀 App chalu karne ke liye:      'studio'"
echo "  🔄 Latest update lene ke liye:   'update ayushserver'"
echo "========================================================"
