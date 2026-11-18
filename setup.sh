#!/bin/bash
echo "🚀 Setting up Termux Studio..."
chmod +x start.sh
CURRENT_DIR=$(pwd)
ALIAS_CMD="alias studio='cd $CURRENT_DIR && ./start.sh'"
echo "$ALIAS_CMD" >> ~/.bashrc
echo "✅ Setup complete! Ab tum 'studio' likh kar app chala sakte ho."
