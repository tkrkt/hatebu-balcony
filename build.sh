#!/bin/bash

# ビルドスクリプト - Chrome拡張機能のzipファイルを生成

# エラーが発生したら停止
set -e

# 出力ファイル名
VERSION=$(grep '"version"' manifest.json | sed 's/.*"version": "\(.*\)".*/\1/')
OUTPUT_FILE="hatebu-balcony-v${VERSION}.zip"

echo "Building Hatebu Balcony v${VERSION}..."

# 既存のzipファイルを削除
if [ -f "$OUTPUT_FILE" ]; then
  echo "Removing existing $OUTPUT_FILE..."
  rm "$OUTPUT_FILE"
fi

# zipファイルを作成（必要なファイルのみ含める）
echo "Creating zip file..."
zip -r "$OUTPUT_FILE" \
  manifest.json \
  background.js \
  icons/ \
  sidepanel/ \
  README.md \
  -x "*.DS_Store" \
  -x "__MACOSX/*" \
  -x ".git/*" \
  -x ".gitignore" \
  -x "*.sh" \
  -x "exmaple.js" \
  -x ".vscode/*"

echo "✓ Build complete: $OUTPUT_FILE"
echo "File size: $(du -h "$OUTPUT_FILE" | cut -f1)"
