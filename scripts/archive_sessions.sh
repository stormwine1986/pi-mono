#!/usr/bin/env bash
set -euo pipefail

# 归档 7 天前的对话 sessions 到 Garage (S3)
# 执行环境: agent 容器

SESSIONS_DIR="/home/pi-mono/.pi/agent/sessions"
ARCHIVE_BUCKET="sessions"
ARCHIVE_PATH="garage:${ARCHIVE_BUCKET}/archives"

if [ ! -d "$SESSIONS_DIR" ]; then
    echo "❌ Sessions directory not found: $SESSIONS_DIR"
    exit 1
fi

echo "📦 Archiving sessions older than 7 days from $SESSIONS_DIR to $ARCHIVE_PATH ..."

# 配置 rclone 临时环境变量
export RCLONE_CONFIG_GARAGE_TYPE=s3
export RCLONE_CONFIG_GARAGE_PROVIDER=Other
export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID}"
export RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY}"
export RCLONE_CONFIG_GARAGE_ENDPOINT="${S3_ENDPOINT}"
export RCLONE_CONFIG_GARAGE_REGION="${S3_REGION}"

# 使用 rclone move 归档并删除
# --min-age 7d: 仅处理 7 天前的文件
# --include "*.jsonl": 仅处理 jsonl 文件
rclone move "$SESSIONS_DIR" "$ARCHIVE_PATH" \
    --min-age 7d \
    --include "*.jsonl" \
    --progress \
    --create-empty-src-dirs

echo "✅ Sessions archival completed."
