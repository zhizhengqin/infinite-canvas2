# Real Media Provider Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在隔离媒体服务中接入现有生图、生视频、超分渠道，使真实渠道通过同一 MCP 任务契约工作，并在用户逐次授权后完成三类主渠道的真实验收。

**Architecture:** 保留第一阶段 MediaService/MediaStore/AssetStore/MCP。新增服务端渠道目录、秘密引用解析和 Provider 适配器；Provider 通过受控上下文读取输入资产，真实供应商任务 ID 继续持久化。优先移植现有 `web/src/services/api/` 的请求/响应与测试契约，不引入另一套媒体服务。

**Tech Stack:** TypeScript、Node.js 24、原生 fetch/FormData/Blob/File、Zod、现有 MCP SDK、node:test、Docker Compose；DreamMaker 复用项目已有 `playwright-core` 会话实现。

**Spec:** `/Users/qinzz/Desktop/infinite-canvas2/docs/superpowers/specs/2026-11-06-yoko-bs-integration-design.md`

## Global Constraints

- 所有改动仅在 `/Users/qinzz/Desktop/REA/yoko-bs-validation/infinite-canvas`；原源码、现有浏览器项目和本机 Canvas Agent 保持不变。
- 覆盖现有 OpenAI 兼容、Gemini、RunningHub、Wanli、DreamMaker 和用户自定义脚本渠道；不得为了缩减实现而把其中一类静默删除。
- 真实生成验收只要求生图、生视频、超分各选一个主渠道执行一次；其他渠道先做配置、模型发现和受控接口验证。
- 真实调用前必须展示渠道、模型、参数、参考资产和数量，并取得当次确认；失败、超时或鉴权中断不得自动重提或换渠道。
- 不读取、复制或输出真实 API Key、Cookie、OAuth 会话；渠道文件只保存秘密引用，秘密由运行环境提供。
- 不新增或修改渠道现有超时、轮询间隔、重试次数、大小限制和并发上限。
- 继续使用独立 Compose 项目和 `yoko-bs-canvas-media-data`；不动其他容器和数据卷。
- 所有新行为先写失败测试并观察 RED，再实现到 GREEN；每项任务运行完整相关套件。
- 不执行 git commit、push、reset 或 rebase；用计划 ledger 和测试日志记录。

## Review Focus

- 参考图、参考视频和超分输入必须按原字节读取且只提交一次；由 Task 1、Task 2 和 Task 4 的资产上下文与请求测试覆盖。
- 重复 MCP 请求、服务重启和暂时性查询失败不得创建第二个供应商任务；由 Task 2、Task 4 和 Task 7 的原任务恢复测试覆盖。
- 渠道配置、MCP 响应、HTTP 错误和日志不得包含真实秘密；由 Task 1、Task 6 和 Task 7 的脱敏测试覆盖。
- 超分必须读取已有视频并生成新的视频资产，不能误走生图或生成新视频提示词任务；由 Task 4 的 RunningHub VOSR2 测试覆盖。
- 自定义脚本只能由单用户管理员显式配置，不能在公共 MCP 输入中提交脚本执行；由 Task 3 的边界测试覆盖。
- 用户当前短视频项目不得因构建、测试或渠道配置被修改；每个 Docker 阶段复核原容器 ID 和 Agent PID。

---

### Task 1: 建立服务端渠道目录与资产读取上下文

**Files:**
- Create: `canvas-agent/src/media/channels.ts`
- Create: `canvas-agent/src/media/channels.test.ts`
- Create: `canvas-agent/src/media/secrets.ts`
- Create: `canvas-agent/src/media/secrets.test.ts`
- Modify: `canvas-agent/src/media/providers/types.ts`
- Modify: `canvas-agent/src/media/service.ts`
- Modify: `canvas-agent/src/media/providers/fake.ts`
- Modify: 相关现有媒体测试
- Modify: `canvas-agent/package.json`（加入新测试）

**Interfaces:**
- Produces:

```ts
type ServerChannelModel = {
  name: string;
  capability: "image" | "video" | "upscale";
  label?: string;
  script?: string;
  runningHub?: unknown;
};
type ServerChannel = {
  id: string;
  name: string;
  baseUrl: string;
  apiFormat: "openai" | "gemini" | "runninghub" | "wanli";
  authMode?: "dreammaker-account";
  credentialRef?: string;
  models: ServerChannelModel[];
};
type SecretResolver = (reference: string) => string;
type MediaProviderContext = {
  signal?: AbortSignal;
  readAsset(id: string): Promise<{ asset: MediaAsset; data: Buffer }>;
};
```

`MediaProvider.createTask(input, context)` 和 `getTask(providerTaskId, context)` 使用该上下文；`MediaService` 注入 `readAsset`。`ChannelStore.listChannels()` 返回的渠道永远不含 `apiKey` 或实际秘密。

- [ ] **Step 1: 写失败测试**

覆盖：合法渠道元数据读写；秘密引用通过 resolver 在调用时解析；渠道 JSON 不含秘密；缺失引用安全失败；FakeProvider 通过 context 读取参考资产且字节一致；非法/跨任务资产 ID 由 AssetStore 边界拒绝。

- [ ] **Step 2: 验证 RED**

Run: `npx tsx --test src/media/channels.test.ts src/media/secrets.test.ts src/media/providers/fake.test.ts src/media/service.test.ts`

Expected: 新模块/接口缺失导致失败。

- [ ] **Step 3: 实现渠道、秘密与上下文接口**

使用 Zod 校验渠道；秘密只保存环境变量或 Docker Secret 引用名称。修改 Provider 签名并由 MediaService 传递真实 `readAsset`，不在任务 JSON 中保存秘密。

- [ ] **Step 4: 验证 GREEN 与回归**

Run: 上述测试及 `npm test && npm run build`

Expected: 新行为与既有测试全部通过。

- [ ] **Step 5: 检查点**

记录接口变更、参考资产字节验证和无秘密持久化证据。

### Task 2: 接入 OpenAI 兼容与 Gemini 生图/视频

**Files:**
- Create: `canvas-agent/src/media/providers/openai.ts`
- Create: `canvas-agent/src/media/providers/gemini.ts`
- Create: `canvas-agent/src/media/providers/http.ts`
- Test: `canvas-agent/src/media/providers/openai.test.ts`
- Test: `canvas-agent/src/media/providers/gemini.test.ts`
- Reference: `web/src/services/api/image.ts`、`video.ts` 及现有测试
- Modify: `canvas-agent/package.json`

**Interfaces:**
- Consumes: Task 1 `ServerChannel`、`SecretResolver`、`MediaProviderContext`。
- Produces: `OpenAIProvider`、`GeminiProvider`，均实现 `MediaProvider`，支持渠道声明的 image/video 模型和原供应商任务查询。

- [ ] **Step 1: 写失败契约测试**

用本地受控 HTTP 服务验证 OpenAI `/images/generations`、`/images/edits`、`/videos`、`/videos/:id`、`/content` 的请求字段和文件字节；Gemini 验证 `generateContent`、`predictLongRunning` 和 operation 查询。覆盖 URL/base64 结果、供应商失败、查询异常不终结任务及秘密脱敏。

- [ ] **Step 2: 验证 RED**

Run: `npx tsx --test src/media/providers/openai.test.ts src/media/providers/gemini.test.ts`

Expected: Provider 模块不存在。

- [ ] **Step 3: 移植协议实现**

以现有前端实现为行为依据，使用 Node 原生 fetch/FormData 和 Task 1 资产上下文。共享 HTTP 助手负责 URL、鉴权、结果读取和错误脱敏；不复制浏览器 store、IndexedDB 或 UI 代码。同步生图结果必须在 Provider 侧持久化到本计划数据目录，测试重启后仍能读取，不能因结果已在 HTTP 响应中返回就省略恢复验证。

- [ ] **Step 4: 验证 GREEN**

Run: 两个 Provider 测试、`npm test && npm run build`

Expected: 请求契约、任务恢复和错误处理通过。

- [ ] **Step 5: 检查点**

记录实际覆盖的 OpenAI/Gemini 图像与视频路径。

### Task 3: 服务端运行现有自定义渠道脚本

**Files:**
- Create: `canvas-agent/src/media/providers/script.ts`
- Create: `canvas-agent/src/media/providers/script-worker.ts`
- Test: `canvas-agent/src/media/providers/script.test.ts`
- Reference: `web/src/services/api/model-plugin.ts` 与 `model-plugin.test.ts`
- Modify: `canvas-agent/package.json`

**Interfaces:**
- Consumes: 渠道中已保存的 `ServerChannelModel.script`、Task 1 上下文。
- Produces: `ScriptProvider implements MediaProvider`，支持脚本已有的 image/video 能力及自定义超分模型；不提供通过 MCP 写入脚本的工具。

- [ ] **Step 1: 写失败测试**

移植现有关键模板测试，并验证脚本收到 prompt、模型、参数和原参考资产；返回 URL/data URL/Blob 能转成媒体资产。脚本来自其他输入字段时不得执行；worker 不接收无关环境变量、Docker Socket 或宿主目录。

- [ ] **Step 2: 验证 RED**

Run: `npx tsx --test src/media/providers/script.test.ts`

Expected: ScriptProvider 不存在。

- [ ] **Step 3: 实现受控脚本 Provider**

复用现有脚本变量和 HTTP/poll 契约，在独立 worker 中执行管理员已保存脚本，注入明确 helper 和空的无关键环境。保留现有脚本轮询语义，不增加新限制。脚本任务状态与结果必须在数据目录持久化；测试服务重启后读取原任务，不得为恢复而重新执行脚本。

- [ ] **Step 4: 验证 GREEN**

Run: 脚本测试及 `npm test && npm run build`

Expected: 现有模板与服务器资产边界通过。

- [ ] **Step 5: 检查点**

记录脚本来源边界和模板兼容结果。

### Task 4: 接入 RunningHub 图片、视频与 VOSR2 超分

**Files:**
- Create: `canvas-agent/src/media/providers/runninghub.ts`
- Test: `canvas-agent/src/media/providers/runninghub.test.ts`
- Reference: `web/src/services/api/runninghub.ts`、`runninghub.test.ts`
- Modify: `canvas-agent/package.json`

**Interfaces:**
- Consumes: Task 1 上下文、渠道模型中的 RunningHub target 配置。
- Produces: `RunningHubProvider implements MediaProvider`；upscale 任务复用 VOSR2 target 和原视频资产。

- [ ] **Step 1: 写失败测试**

复用现有 RunningHub fixtures，验证元数据、媒体上传、任务创建和查询。VOSR2 测试必须断言读取原视频字节、使用既有工作流目标、只创建一个任务、返回新视频资产；枚举错误与暂时性查询错误不得触发重新提交。

- [ ] **Step 2: 验证 RED**

Run: `npx tsx --test src/media/providers/runninghub.test.ts`

Expected: Provider 不存在。

- [ ] **Step 3: 移植 RunningHub 协议与任务适配**

复用现有字段映射、目标解析、上传、创建和查询逻辑，以服务器 Buffer/File 替换浏览器存储；保留原 task ID 与渠道已学习的枚举选项。

- [ ] **Step 4: 验证 GREEN**

Run: RunningHub 测试及完整套件/构建。

Expected: 图片、视频、超分契约通过，秘密不出现在错误中。

- [ ] **Step 5: 检查点**

记录 RunningHub 与 VOSR2 的已验证输入输出。

### Task 5: 接入 Wanli 原生图片与视频渠道

**Files:**
- Create: `canvas-agent/src/media/providers/wanli.ts`
- Test: `canvas-agent/src/media/providers/wanli.test.ts`
- Reference: `web/src/services/api/wanli.ts`、`wanli.test.ts`
- Modify: `canvas-agent/package.json`

**Interfaces:**
- Produces: `WanliProvider implements MediaProvider`，支持现有目录模型、原生参考图上传、视频任务查询和鉴权结果下载。

- [ ] **Step 1: 写失败测试**

移植现有 Wanli 契约，验证图片参考使用原生接口、视频目录版本/参数、原任务查询、受保护结果带渠道凭据下载，以及秘密不进入响应或持久化错误。

- [ ] **Step 2: 验证 RED**

Run: `npx tsx --test src/media/providers/wanli.test.ts`

Expected: WanliProvider 不存在。

- [ ] **Step 3: 实现 WanliProvider**

复用现有目录、报价/规格读取和原生任务协议；通过上下文获取参考文件。

- [ ] **Step 4: 验证 GREEN**

Run: Wanli 测试及 `npm test && npm run build`

Expected: 所有现有 Wanli 契约与服务器任务接口通过。

- [ ] **Step 5: 检查点**

记录 Wanli 图片、视频及鉴权下载覆盖情况。

### Task 6: 接入 DreamMaker 官方账号会话渠道

**Files:**
- Create: `canvas-agent/src/media/providers/dreammaker.ts`
- Test: `canvas-agent/src/media/providers/dreammaker.test.ts`
- Modify: `canvas-agent/package.json`（仅复用项目现有 `playwright-core` 版本）
- Modify: `canvas-agent/Dockerfile.media`（安装会话所需浏览器运行依赖）
- Reference: `canvas-proxy/dreammaker-auth.js`、`canvas-proxy/dreammaker-auth.test.js`、`web/src/services/api/dreammaker.ts`

**Interfaces:**
- Produces: `DreamMakerProvider implements MediaProvider` 和显式的服务器账号状态/官方登录入口适配；媒体执行仍走 ScriptProvider 的已保存渠道脚本。

- [ ] **Step 1: 写失败测试**

验证只有 `https://dreammaker.vobilemax.cn/api/*` 可使用账号会话；会话状态不含令牌；鉴权中断保留原任务并允许后续查询；不通过导出文件读取或复制本机会话。

- [ ] **Step 2: 验证 RED**

Run: `npx tsx --test src/media/providers/dreammaker.test.ts`

Expected: DreamMakerProvider 不存在。

- [ ] **Step 3: 复用官方会话实现**

复用 `DreamMakerSession` 的续期与官方窗口流程，服务器存储使用独立数据目录。人工登录必须由用户在官方页面完成；不得把本机 cookie/token 打包进镜像或普通迁移文件。

- [ ] **Step 4: 验证 GREEN**

Run: DreamMaker 测试、完整套件和 Docker 构建。

Expected: 目标限制、脱敏和原任务语义通过；未授权账号明确显示待接入，不伪装可用。

- [ ] **Step 5: 检查点**

记录官方登录依赖和服务器可用性边界。

### Task 7: 将真实渠道注册到媒体 MCP 与 Docker

**Files:**
- Create: `canvas-agent/src/media/runtime.ts`
- Create: `canvas-agent/src/media/import-channels.ts`
- Test: `canvas-agent/src/media/runtime.test.ts`
- Modify: `canvas-agent/src/index.ts`
- Modify: `canvas-agent/Dockerfile.media`
- Modify: `deploy/media-foundation.compose.yml`
- Modify: `deploy/verify-media-foundation.mjs`
- Modify: `deploy/README.md`
- Modify: `canvas-agent/package.json`

**Interfaces:**
- Consumes: Tasks 1–6 的渠道目录与 Provider。
- Produces:

```ts
function createMediaRuntime(options: {
  dataDir: string;
  resolveSecret: SecretResolver;
  fakeEnabled: boolean;
}): Promise<MediaService>;
```

`media-import-channels` 只导入渠道元数据并生成秘密引用；遇到未知渠道条目时跳过并报告数量，不发起连接。MCP 渠道列表来自真实注册结果，无秘密字段。

- [ ] **Step 1: 写失败测试**

覆盖各 apiFormat 到 Provider 的注册、模型/脚本选择、空渠道安全启动、未知渠道过滤、秘密引用解析、MCP 列表脱敏和重启后原任务恢复。

- [ ] **Step 2: 验证 RED**

Run: `npx tsx --test src/media/runtime.test.ts src/server/media-http.test.ts`

Expected: runtime/导入能力缺失。

- [ ] **Step 3: 实现运行时注册与导入**

按渠道格式和模型脚本创建对应 Provider；FakeProvider 仅在明确 `fakeEnabled=true` 时注册。Compose 继续只监听本机验证端口，真实秘密通过环境/Docker Secret 注入，不写镜像。

- [ ] **Step 4: 验证 GREEN 与 Docker 回归**

Run: `npm test && npm run build`，再重建隔离 Compose，重复进行中任务重启恢复和匿名 401 验收。

Expected: 所有自动化测试和 Docker 契约通过，原运行环境不变。

- [ ] **Step 5: 检查点**

记录实际注册渠道、过滤数量和 Docker 验证结果。

### Task 8: 主渠道真实验收与文档收尾

**Files:**
- Modify: `deploy/README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/content/docs/progress/todo.mdx`、`todo.zh-CN.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`、`pending-test.zh-CN.mdx`

**Interfaces:**
- Consumes: Task 7 可运行的真实渠道服务。
- Produces: 生图、生视频、超分各一个主渠道的可核对验收记录，以及其余渠道已验证/待接入的明确状态。

- [ ] **Step 1: 准备验收清单**

列出用户现有渠道，分别选择生图、生视频、超分主渠道。展示模型、参数、素材、数量和可能费用；没有凭据或官方登录的渠道标为待接入，不跳过记录。

- [ ] **Step 2: 取得当次授权**

分别等待用户明确批准三次真实调用。设计或计划批准不视为生成授权。

- [ ] **Step 3: 执行已授权任务**

每次只创建一个任务，保存任务 ID、模型和结果；失败或鉴权中断只查询原任务，不自动重试。

- [ ] **Step 4: 验证结果与持久化**

核对图片可解码、视频可播放、超分输出为新资产；重启隔离服务后任务与结果仍可读取。真实结果不得在公开日志中暴露凭据。

- [ ] **Step 5: 更新文档并做最终复核**

按实际结果更新进度文档和 CHANGELOG，运行全部测试/构建并复核原环境。只保留已验证声明，不将未测试渠道写成已成功。
