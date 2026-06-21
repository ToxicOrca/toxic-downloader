#!/bin/bash
echo "=== Toxic Downloader - Native FFmpeg Host Installer ==="
echo

HOST_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$HOST_DIR/toxic_ffmpeg_host.py"

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed."
    echo "Install Python from https://python.org"
    exit 1
fi
echo "[OK] Python found"

# Check for FFmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "[WARN] FFmpeg not found."
    echo "Install: brew install ffmpeg (Mac) or sudo apt install ffmpeg (Linux)"
    echo
else
    echo "[OK] FFmpeg found"
fi

# Ask for extension ID
echo
echo "To find your extension ID:"
echo "  1. Go to chrome://extensions"
echo "  2. Find 'Toxic Downloader'"
echo "  3. Copy the ID shown under the extension name"
echo
read -p "Enter your extension ID: " EXT_ID

if [ -z "$EXT_ID" ]; then
    echo "ERROR: Extension ID is required."
    exit 1
fi

# Make host executable
chmod +x "$HOST_PATH"

# Determine manifest directory
if [[ "$OSTYPE" == "darwin"* ]]; then
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
    MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi

mkdir -p "$MANIFEST_DIR"

# Create manifest
cat > "$MANIFEST_DIR/com.toxicdownloader.ffmpeg.json" << EOF
{
  "name": "com.toxicdownloader.ffmpeg",
  "description": "Toxic Downloader FFmpeg Native Host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo
echo "=== Installation complete! ==="
echo "Extension ID: $EXT_ID"
echo "Native host: $HOST_PATH"
echo "Manifest: $MANIFEST_DIR/com.toxicdownloader.ffmpeg.json"
echo
echo "Restart Chrome, then select 'System FFmpeg' in Toxic Downloader settings."
