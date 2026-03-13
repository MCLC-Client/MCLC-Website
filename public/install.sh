#!/bin/bash

# MCLC Installer Script
# Works on Linux and macOS

set -e

REPO="Lux-Client/LuxClient"
BASE_URL="https://github.com/$REPO/releases/latest/download"

OS="$(uname -s)"
ARCH="$(uname -m)"

echo "--- Lux Installer ---"
echo "Detected OS: $OS ($ARCH)"

case "$OS" in
    Linux)
        FILENAME="Lux-setup.AppImage"
        DOWNLOAD_URL="$BASE_URL/$FILENAME"
        TARGET_DIR="$HOME/.local/bin"
        mkdir -p "$TARGET_DIR"
        TARGET_PATH="$TARGET_DIR/lux"
        
        echo "Downloading $FILENAME..."
        curl -L "$DOWNLOAD_URL" -o "$TARGET_PATH"
        chmod +x "$TARGET_PATH"
        
        echo ""
        echo "Successfully installed Lux to $TARGET_PATH"
        echo "You can now run 'lux' if $TARGET_DIR is in your PATH."
        ;;
    Darwin)
        FILENAME="Lux-setup.zip"
        DOWNLOAD_URL="$BASE_URL/$FILENAME"
        
        echo "Downloading $FILENAME..."
        curl -L "$DOWNLOAD_URL" -o "Lux-setup.zip"
        
        echo "Unpacking..."
        unzip -q "Lux-setup.zip" -d "Lux-App"
        
        echo ""
        echo "Successfully downloaded Lux."
        echo "You can find it in the 'Lux-App' folder."
        ;;
    *)
        echo "Unsupported OS: $OS"
        exit 1
        ;;
esac

echo "----------------------"
