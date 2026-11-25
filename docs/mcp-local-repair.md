# 本机 MCP 调用恢复说明

## 诊断与处理

canvas-agent 常驻服务正常监听 `127.0.0.1:17371`，网页与服务通信正常。通过鉴权 HTTP 工具接口和 MCP stdio 的 `canvas_get_state` 实际读到原画布。问题位于外部 Agent 的注册配置：Codex 的全局配置没有 `infinite-canvas` MCP 条目。画布内置 Agent 在创建会话时自行注入 MCP，因此网页显示已连接不代表外部 Codex 已注册工具。

已在 `/Users/qinzz/.codex/config.toml` 恢复全局 MCP 注册。Kimi Code 实际读取 `/Users/qinzz/.kimi-code/mcp.json`，其中原有注册使用 `npx @basketikun/canvas-agent@latest`；已改为与常驻服务相同的本地安装入口，保留其他 MCP 配置。没有证据表明 Kimi 原注册必然失败，这项调整用于消除下载和版本漂移。

两者的入口相同：

```text
command: /opt/homebrew/bin/node
args:
  /Users/qinzz/.local/share/infinite-canvas-agent/node_modules/@basketikun/canvas-agent/dist/index.js
  mcp
```

修改前配置备份：

- `/Users/qinzz/.codex/config.toml.before-canvas-mcp-20261006`
- `/Users/qinzz/.kimi-code/mcp.json.before-canvas-local-20261006.bak`

未修改常驻 canvas-agent 源码，未重启常驻服务、Docker 或当前 Agent 对话；未创建或删除画布节点，未提交生成任务。

## 验证与使用

按 Codex 和 Kimi Code 各自配置中的真实 command/args 启动 stdio MCP，均完成初始化、列出 34 个工具、成功调用 `canvas_get_state`。返回原项目 `pwKcIzUTwiRed0EplGP5h` 且 `hasCanvas=true`。浏览器原页面显示「Codex 已连接」「网页连接 已连接」。Kimi doctor 配置检查通过。

保持目标画布页面打开并连接，点击目标页面使其成为当前画布。外部 Agent 如果已经运行，重新加载 MCP，或重新启动该客户端/新会话以读取配置；本次正在运行的 Codex 对话不会自动获得新的工具清单。无需重启 Docker。可以向 Agent 提出：

> 使用 infinite-canvas MCP 调用 canvas_get_state，读取当前画布；先不要修改节点。

实际通过 MCP 读状态已验证；外部客户端现有对话重新加载后的交互需用户确认。不以网页「已连接」代替外部客户端工具加载结果。
