# Media Service Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在完全隔离的源码副本和 Docker 环境中，交付可持久化、可通过鉴权 MCP 调用的无限画布媒体任务服务基础，并用不产生费用的测试 Provider 验证完整任务生命周期。

**Architecture:** 在 Canvas Agent 现有 TypeScript、Express、Zod 和官方 MCP SDK 上新增独立 `media-server` 入口，不改变现有本机 Agent。任务与资产存入新的专用数据卷；Provider 通过明确接口接入，本计划只实现确定性的 FakeProvider，真实渠道在后续计划接入。

**Tech Stack:** TypeScript、Node.js、Express 5、Zod 3、@modelcontextprotocol/sdk 1.12.x、node:test、Docker Compose。

**Spec:** `/Users/qinzz/Desktop/infinite-canvas2/docs/superpowers/specs/2026-11-06-yoko-bs-integration-design.md`

## Global Constraints

- 原源码目录 `/Users/qinzz/Desktop/infinite-canvas2` 只用于读取和复制；实施代码位于 `/Users/qinzz/Desktop/REA/yoko-bs-validation/infinite-canvas`。
- 复制包含用户未提交源码，但排除 `.git`、`node_modules`、`dist`、`output`、`tmp`、日志、Docker 数据和所有 `.env*`/秘密文件。
- 不停止、重启、替换或重建用户现有 `infinite-canvas-kimi` 及其他容器；不执行本机 Canvas Agent 升级脚本。
- 不关闭、刷新或自动操作用户当前浏览器项目；不读取或清除原浏览器数据。
- 新 Docker Compose 项目名为 `yoko-bs-validation`；新数据卷不得复用现有卷。
- 本计划不调用真实生图、生视频或超分 API，不产生渠道费用。
- 不新增或修改超时、轮询间隔、重试次数、大小限制和并发上限。
- 不在代码、镜像、日志或 MCP 响应中写入真实 API Key、OAuth 会话或连接 Token。
- 遵循现有项目测试与文档结构；项目已有测试必须保留，不能用删除测试消除失败。
- 不执行 git commit、push、reset 或 rebase；每个任务以文件清单和测试结果作为检查点。
- 后续计划依次为真实渠道适配、洋子 DMG 服务端可行性验证、完整流程集成与全量数据迁移；本计划不是对最终范围的缩减。

## Review Focus

- 客户端因超时重复提交同一 `idempotencyKey`：必须返回原任务，不能生成第二个供应商任务；由 Task 5 的并发与重放测试覆盖。
- 服务在供应商任务尚未完成时重启：必须保留 `providerTaskId` 并恢复原任务，不能重新创建；由 Task 5 的恢复测试覆盖。
- 输入或渠道配置含 `apiKey`、`token`、`authorization`：持久化、错误和 MCP 输出不得泄露；由 Task 2 和 Task 6 的脱敏测试覆盖。
- 非法资产 ID、路径穿越、错误 MCP 凭据和匿名资产请求：必须被拒绝且不能读取文件；由 Task 3 和 Task 6 覆盖。
- 用户正在进行的短视频项目：原容器 ID、原端口、原数据卷和原 Canvas Agent 进程必须保持不变；由 Task 1 和 Task 7 的前后检查覆盖。
- 取消仅表示平台侧停止等待时：返回结果必须明确 `providerCancelled=false`，不能伪报供应商已取消；由 Task 5 覆盖。

---

### Task 1: 建立隔离源码副本与基线

**Files:**
- Create: `/Users/qinzz/Desktop/REA/yoko-bs-validation/infinite-canvas/`（完整隔离副本）
- Create: `/Users/qinzz/Desktop/REA/yoko-bs-validation/runtime-baseline.json`
- No writes in: `/Users/qinzz/Desktop/infinite-canvas2` 的业务源码、数据或容器配置

**Interfaces:**
- Consumes: 当前源码和 Docker 状态，只读。
- Produces: 后续所有任务使用的隔离源码根目录和原运行环境基线。

- [ ] **Step 1: 记录原运行环境**

Run:

```bash
docker ps --format '{{.Names}}|{{.ID}}|{{.Image}}|{{.Ports}}'
lsof -nP -iTCP:17371 -sTCP:LISTEN
```

将不含环境变量和秘密的上述结果写入 `runtime-baseline.json`，记录当前容器名称、ID、镜像、端口和 Canvas Agent PID。

- [ ] **Step 2: 创建隔离副本**

先确认 `rsync` 可用且目标目录不存在，再执行：

```bash
rsync -a \
  --exclude='.git' --exclude='node_modules' --exclude='dist' \
  --exclude='output' --exclude='tmp' --exclude='*.log' \
  --exclude='.env' --exclude='.env.*' \
  /Users/qinzz/Desktop/infinite-canvas2/ \
  /Users/qinzz/Desktop/REA/yoko-bs-validation/infinite-canvas/
```

Expected: 新目录包含 `web/`、`canvas-agent/` 和本设计文档；不包含 `.git`、`.env*` 或依赖构建产物。

- [ ] **Step 3: 安装隔离副本依赖并运行现有测试**

Run:

```bash
cd /Users/qinzz/Desktop/REA/yoko-bs-validation/infinite-canvas/web && bun install --frozen-lockfile && bun test
cd /Users/qinzz/Desktop/REA/yoko-bs-validation/infinite-canvas/canvas-agent && npm ci && npm test
```

Expected: 记录真实通过/失败结果。若存在失败，先区分原副本已有失败与隔离过程引入的问题；不修改无关业务测试。

- [ ] **Step 4: 核对隔离边界**

Run: 再次执行 Step 1 的命令并与 `runtime-baseline.json` 比较。

Expected: 原容器 ID、端口和 Canvas Agent PID 完全不变。

- [ ] **Step 5: 检查点**

记录隔离副本路径、基线测试结果及原环境对比结果；不提交 Git。

### Task 2: 定义媒体任务模型与持久化 Store

**Files:**
- Create: `canvas-agent/src/media/types.ts`
- Create: `canvas-agent/src/media/store.ts`
- Test: `canvas-agent/src/media/store.test.ts`
- Modify: `canvas-agent/package.json`（仅将新测试加入现有 `test` 脚本）

**Interfaces:**
- Produces:

```ts
type MediaCapability = "image" | "video" | "upscale";
type MediaTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
type MediaTaskInput = {
  projectId: string;
  capability: MediaCapability;
  channelId: string;
  model: string;
  prompt: string;
  params?: Record<string, unknown>;
  assetIds?: string[];
  idempotencyKey: string;
};
type MediaTask = MediaTaskInput & {
  id: string;
  providerTaskId?: string;
  status: MediaTaskStatus;
  resultAssetIds: string[];
  error?: string;
  providerCancelled?: boolean;
  createdAt: string;
  updatedAt: string;
};
class MediaStore {
  constructor(rootDir: string);
  createTask(input: MediaTaskInput): Promise<{ task: MediaTask; created: boolean }>;
  getTask(id: string): Promise<MediaTask>;
  getTaskByIdempotencyKey(projectId: string, key: string): Promise<MediaTask | null>;
  listTasks(projectId?: string): Promise<MediaTask[]>;
  updateTask(id: string, patch: Partial<MediaTask>): Promise<MediaTask>;
}
```

- [ ] **Step 1: 写失败测试**

用 `node:test` 和临时目录覆盖：创建后重读、相同项目与幂等键只返回原任务、不同项目可使用相同键、重启 Store 后任务仍在、损坏 JSON 明确报错。加入秘密字段测试：

```ts
const input = { ...validInput, params: { apiKey: "must-not-persist", size: "16:9" } };
const { task } = await store.createTask(input);
assert.equal(JSON.stringify(task).includes("must-not-persist"), false);
```

- [ ] **Step 2: 验证测试失败**

Run: `cd canvas-agent && npx tsx --test src/media/store.test.ts`

Expected: FAIL，原因是媒体模块尚不存在。

- [ ] **Step 3: 实现模型和 Store**

在 `types.ts` 用 Zod 定义输入校验和上述导出类型；在 `store.ts` 使用 `node:fs/promises` 将每个任务存为独立 JSON，写临时文件后原子重命名。递归移除名为 `apiKey`、`token`、`accessToken`、`refreshToken`、`password`、`secret`、`authorization` 的输入字段，大小写不敏感。缺任务时抛出带 `code="MEDIA_TASK_NOT_FOUND"` 的错误。

- [ ] **Step 4: 验证测试通过**

Run: `npx tsx --test src/media/store.test.ts`

Expected: 所有 Store 测试 PASS，临时文件不会残留为正式任务。

- [ ] **Step 5: 检查点**

运行 `npm test`，记录新增文件、测试结果和脱敏字段清单。

### Task 3: 实现服务端媒体资产 Store

**Files:**
- Create: `canvas-agent/src/media/assets.ts`
- Test: `canvas-agent/src/media/assets.test.ts`
- Modify: `canvas-agent/package.json`（加入该测试）

**Interfaces:**
- Consumes: 独立媒体数据根目录。
- Produces:

```ts
type MediaAsset = {
  id: string;
  kind: "image" | "video";
  mimeType: string;
  fileName: string;
  bytes: number;
  sha256: string;
  createdAt: string;
};
class MediaAssetStore {
  constructor(rootDir: string);
  put(input: { data: Buffer; kind: "image" | "video"; mimeType: string; fileName?: string }): Promise<MediaAsset>;
  metadata(id: string): Promise<MediaAsset>;
  read(id: string): Promise<{ asset: MediaAsset; data: Buffer }>;
  remove(id: string): Promise<void>;
}
```

- [ ] **Step 1: 写失败测试**

覆盖图片与视频写入/读取、SHA-256、重启后 metadata、删除，以及 `../../secret`、斜杠、空 ID 和未知 ID 被拒绝。测试只使用临时目录中的虚构数据。

- [ ] **Step 2: 验证测试失败**

Run: `npx tsx --test src/media/assets.test.ts`

Expected: FAIL，原因是 `assets.ts` 不存在。

- [ ] **Step 3: 实现 Asset Store**

资产 ID 使用 `crypto.randomUUID()`，文件保存在 Store 根目录的 `assets/` 下，元数据保存在独立 JSON 中。ID 仅接受实际生成的 UUID，路径通过解析后必须仍位于资产根目录；内容哈希使用 Node `crypto`，不引入新依赖。

- [ ] **Step 4: 验证测试通过**

Run: `npx tsx --test src/media/assets.test.ts && npm test`

Expected: 新测试与已有测试 PASS。

- [ ] **Step 5: 检查点**

记录资产目录结构、测试结果和路径穿越测试证据。

### Task 4: 定义 Provider 接口与确定性 FakeProvider

**Files:**
- Create: `canvas-agent/src/media/providers/types.ts`
- Create: `canvas-agent/src/media/providers/fake.ts`
- Create: `canvas-agent/src/media/providers/registry.ts`
- Test: `canvas-agent/src/media/providers/fake.test.ts`
- Modify: `canvas-agent/package.json`（加入该测试）

**Interfaces:**
- Consumes: `MediaCapability`、`MediaTaskInput`。
- Produces:

```ts
type ProviderTaskState =
  | { status: "pending" | "running" }
  | { status: "completed"; assets: Array<{ data: Buffer; kind: "image" | "video"; mimeType: string; fileName: string }> }
  | { status: "failed"; error: string };
interface MediaProvider {
  listCapabilities(): Array<{ capability: MediaCapability; models: string[] }>;
  createTask(input: MediaTaskInput): Promise<{ providerTaskId: string }>;
  getTask(providerTaskId: string): Promise<ProviderTaskState>;
  cancelTask?(providerTaskId: string): Promise<boolean>;
}
class ProviderRegistry {
  register(channelId: string, provider: MediaProvider): void;
  get(channelId: string): MediaProvider;
  listCapabilities(): Array<{ channelId: string; capability: MediaCapability; models: string[] }>;
}
```

- [ ] **Step 1: 写失败测试**

FakeProvider 必须支持 `image`、`video`、`upscale` 三种能力和 `fake-image-v1`、`fake-video-v1`、`fake-upscale-v1` 三个模型。测试创建后按预设从 pending 到 completed、重复查询不创建新任务、失败分支、注册表未知渠道报错和取消返回值。

- [ ] **Step 2: 验证测试失败**

Run: `npx tsx --test src/media/providers/fake.test.ts`

Expected: FAIL，原因是 Provider 模块不存在。

- [ ] **Step 3: 实现接口、注册表和 FakeProvider**

FakeProvider 仅在内存中保存任务，不访问网络；输出使用固定小 Buffer，并明确标注 MIME 为测试内容。不得把它注册成任何真实渠道名称。

- [ ] **Step 4: 验证测试通过**

Run: `npx tsx --test src/media/providers/fake.test.ts && npm test`

Expected: PASS，且无网络请求。

- [ ] **Step 5: 检查点**

记录 Provider 接口和 Fake 模型清单。

### Task 5: 实现幂等媒体任务服务与恢复

**Files:**
- Create: `canvas-agent/src/media/service.ts`
- Test: `canvas-agent/src/media/service.test.ts`
- Modify: `canvas-agent/package.json`（加入该测试）

**Interfaces:**
- Consumes: Task 2 `MediaStore`、Task 3 `MediaAssetStore`、Task 4 `ProviderRegistry` 和 `MediaProvider`。
- Produces:

```ts
class MediaService {
  constructor(store: MediaStore, assets: MediaAssetStore, providers: ProviderRegistry);
  listCapabilities(): ReturnType<ProviderRegistry["listCapabilities"]>;
  createTask(input: MediaTaskInput): Promise<{ task: MediaTask; created: boolean }>;
  getTask(taskId: string): Promise<MediaTask>;
  pollTask(taskId: string): Promise<MediaTask>;
  cancelTask(taskId: string): Promise<MediaTask>;
  recoverTasks(): Promise<MediaTask[]>;
}
```

- [ ] **Step 1: 写失败测试**

至少覆盖：

```ts
const [a, b] = await Promise.all([service.createTask(input), service.createTask(input)]);
assert.equal(a.task.id, b.task.id);
assert.equal(Number(a.created) + Number(b.created), 1);
```

另测 completed 结果写入资产、failed 错误保存、相同幂等键并发只调用一次 Provider、重启后 `recoverTasks()` 使用原 `providerTaskId` 查询且不再次调用 `createTask`。无 Provider 取消能力的任务取消后应满足 `task.status === "cancelled" && task.providerCancelled === false`。

- [ ] **Step 2: 验证测试失败**

Run: `npx tsx --test src/media/service.test.ts`

Expected: FAIL，原因是 `service.ts` 不存在。

- [ ] **Step 3: 实现 MediaService**

以项目 ID + 幂等键作为唯一边界，复用同一进行中的 Promise；完成时将 Provider 输出写入 AssetStore，再保存 `resultAssetIds`。恢复只查询已有供应商任务。取消时仅当 Provider 明确实现并返回 `true` 才设置 `providerCancelled=true`，不得自动重新提交。

- [ ] **Step 4: 验证测试通过**

Run: `npx tsx --test src/media/service.test.ts && npm test`

Expected: 所有任务生命周期与恢复测试 PASS。

- [ ] **Step 5: 检查点**

记录幂等、恢复、取消和秘密脱敏测试证据。

### Task 6: 增加独立鉴权媒体 MCP 服务

**Files:**
- Create: `canvas-agent/src/server/media-mcp.ts`
- Create: `canvas-agent/src/server/media-http.ts`
- Create: `canvas-agent/src/server/media-schemas.ts`
- Test: `canvas-agent/src/server/media-http.test.ts`
- Modify: `canvas-agent/src/index.ts`
- Modify: `canvas-agent/package.json`（加入该测试）

**Interfaces:**
- Consumes: Task 5 `MediaService` 及现有官方 MCP SDK。
- Produces:

```ts
function createMediaMcpServer(service: MediaService): McpServer;
function startMediaServer(options: {
  service: MediaService;
  host: string;
  port: number;
  token: string;
}): Promise<{ close(): Promise<void> }>;
```

MCP 工具固定为：`media_list_capabilities`、`media_create_task`、`media_get_task`、`media_list_tasks`、`media_poll_task`、`media_cancel_task`、`media_asset_metadata`。资产内容通过鉴权的 `GET /media/assets/:id` 读取，不在 MCP 中返回大段 base64。

- [ ] **Step 1: 写失败测试**

启动随机空闲端口的测试服务器，用官方 MCP Client 覆盖：无 Bearer Token 和错误 Token 返回 401；正确 Token 可列出三个 Fake 能力；创建、轮询、读取任务和资产元数据；非法输入返回结构化错误；匿名资产 HTTP 请求返回 401；响应 JSON 不包含测试秘密。

- [ ] **Step 2: 验证测试失败**

Run: `npx tsx --test src/server/media-http.test.ts`

Expected: FAIL，原因是新媒体入口不存在。

- [ ] **Step 3: 实现独立媒体入口**

`media-schemas.ts` 用 Zod 限定工具输入；`media-mcp.ts` 使用现有 `@modelcontextprotocol/sdk` 注册工具；`media-http.ts` 使用 Streamable HTTP transport 和 Express 暴露 `/mcp`、`/health`、`/media/assets/:id`。除 `/health` 外均要求 `Authorization: Bearer <token>`。Token 仅通过启动参数注入，空 Token 必须拒绝启动。

`src/index.ts` 只在 `process.argv[2] === "media-server"` 时启动新服务，原无参数和 `mcp` 分支保持原行为。新服务不导入或启动 Codex/Kimi 会话，不调用 `loadConfig()` 修改原 `~/.infinite-canvas/canvas-agent.json`。

- [ ] **Step 4: 验证测试通过**

Run: `npx tsx --test src/server/media-http.test.ts && npm test && npm run build`

Expected: 新媒体测试、原测试和 TypeScript 构建 PASS。

- [ ] **Step 5: 检查点**

记录工具清单、鉴权测试、原入口未改行为的测试证据。

### Task 7: 构建并验收独立 Docker 环境

**Files:**
- Create: `canvas-agent/Dockerfile.media`
- Create: `deploy/media-foundation.compose.yml`
- Create: `deploy/README.md`
- Modify: `CHANGELOG.md`（在现有 `Unreleased` 追加一条 `[新增]`，不回写用户其他条目）
- Modify: `docs/content/docs/progress/todo.mdx` 与 `docs/content/docs/progress/pending-test.mdx`（按实际完成项更新，不覆盖已有内容）
- Modify: 对应 `*.zh-CN.mdx`（仅当隔离副本中的现有结构要求同步）

**Interfaces:**
- Consumes: Task 6 的 `media-server` 入口。
- Produces: 可用 `docker compose -f deploy/media-foundation.compose.yml up -d --build` 启动的独立媒体服务，以及后续真实渠道计划使用的容器、网络和持久化卷。

- [ ] **Step 1: 写容器验收脚本或测试检查**

在 `deploy/README.md` 写明一次性验收命令，要求覆盖 MCP 初始化、工具列表、Fake 图片任务、任务完成后资产读取、容器重启后的任务恢复，以及匿名请求 401。本地测试 Token 在启动命令中通过 `CANVAS_MEDIA_TOKEN` 环境变量注入，使用当场生成的随机值；不创建或读取 `.env` 文件，不在文档和日志中记录 Token。

- [ ] **Step 2: 先验证新环境不存在且原环境未变**

Run: `docker ps -a --filter name=yoko-bs-validation --format '{{.Names}}|{{.ID}}'`

Expected: 无新环境容器；再次核对 Task 1 原环境基线不变。

- [ ] **Step 3: 实现镜像和 Compose**

`Dockerfile.media` 安装并构建 Canvas Agent，只运行 `node dist/index.js media-server`。Compose 使用唯一项目名 `yoko-bs-validation`、独立 `canvas-media-data` 卷和私有网络。默认只将 Agent 映射到 `127.0.0.1:31771:17371`；启动前检查端口，如已占用则记录并选择另一个空闲本机端口。FakeProvider 是默认且唯一的 Provider，不包含任何真实渠道凭据。

- [ ] **Step 4: 构建并运行完整验收**

Run:

```bash
docker compose -p yoko-bs-validation -f deploy/media-foundation.compose.yml up -d --build
# 执行 deploy/README.md 中的 MCP、任务、资产和重启验收命令
```

Expected: 容器健康；三项 Fake 能力可列出；创建并完成任务后可读取资产；重启后任务与资产仍在；匿名请求为 401。构建若消耗较多资源，不在用户当前真实媒体任务运行期间并行执行，先等待其完成。

- [ ] **Step 5: 核对原环境并记录结果**

Run: 再次执行 Task 1 的 Docker/lsof 命令，并运行隔离副本的 `web` 与 `canvas-agent` 全量相关测试。

Expected: 原容器 ID、端口、Canvas Agent PID 不变；新环境测试全部通过。只停止或删除 `yoko-bs-validation` 自己创建的临时验收容器（若需清理），不得影响其他服务；不提交 Git。
