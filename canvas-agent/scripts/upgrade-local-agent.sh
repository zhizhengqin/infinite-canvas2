#!/bin/bash
# 升级本机 launchd 托管的 Canvas Agent：打包当前源码 → 安装到运行目录 → 重启服务并健康检查。
set -euo pipefail

LABEL="com.basketikun.canvas-agent"
RUNTIME_DIR="${CANVAS_AGENT_RUNTIME_DIR:-$HOME/.local/share/infinite-canvas-agent}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

cd "$(dirname "$0")/.."

echo "==> 构建并打包（经 prepack 自动执行 npm run build）"
TGZ=$(npm pack --silent | tail -1)
mkdir -p "$RUNTIME_DIR"
mv "$TGZ" "$RUNTIME_DIR/.canvas-agent-local.tgz"

echo "==> 安装到 $RUNTIME_DIR"
(cd "$RUNTIME_DIR" && npm install --silent .canvas-agent-local.tgz)
VERSION=$(node -p "require('$RUNTIME_DIR/node_modules/@basketikun/canvas-agent/package.json').version")
echo "==> 已安装 @basketikun/canvas-agent@$VERSION"

UID_NUM="$(id -u)"
if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
    echo "==> 重启 LaunchAgent $LABEL"
    launchctl kickstart -k "gui/$UID_NUM/$LABEL"
elif [ -f "$PLIST" ]; then
    echo "==> 注册并启动 LaunchAgent $LABEL"
    launchctl bootstrap "gui/$UID_NUM" "$PLIST"
else
    echo "==> 未找到 $PLIST，跳过服务重启（未使用 launchd 托管）"
fi

sleep 2
if curl -sf http://127.0.0.1:17371/health >/dev/null; then
    echo "==> 服务正常：http://127.0.0.1:17371"
else
    echo "==> 健康检查未通过，日志见 ~/.infinite-canvas/canvas-agent.log" >&2
    exit 1
fi
