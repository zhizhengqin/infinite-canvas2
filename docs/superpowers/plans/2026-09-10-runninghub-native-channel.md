# RunningHub Native Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在新版无限画布中原生配置并调用 RunningHub 工作流和 AI 应用，把图片或视频结果写回现有生成链路。

**Architecture:** 使用 `runninghub` 渠道协议和每个模型条目的 `runningHub` 目标元数据。独立协议模块负责链接解析、元数据归一化、素材上传、任务提交与轮询；图片和视频服务只在选中该协议时转交。

**Tech Stack:** React 19, TypeScript 5, Ant Design 6, Zustand 5, Axios, Bun test, Vite 7

**Spec:** `docs/superpowers/specs/2026-09-10-runninghub-native-channel-design.md`

## Global Constraints

- 支持消费级会员 Key、ComfyUI 工作流和 AI 应用。
- 首版只接收图片和视频结果。
- 查询间隔 5 秒，单任务最长等待 30 分钟。
- 查询失败只重查同一 `taskId`，不自动重新提交付费任务。
- API Key 只存在现有浏览器本地配置，不写入仓库、日志、Docker 层或电影项目。
- 元数据导入与连接测试不创建任务；只有用户点击生成才提交付费请求。
- 不关闭或复用用户已打开的浏览器标签，验收使用独立页面。

---

### Task 1: RunningHub 配置类型与纯协议逻辑

**Files:**
- Create: `web/src/services/api/runninghub.ts`
- Create: `web/src/services/api/runninghub.test.ts`
- Modify: `web/src/stores/use-config-store.ts`

**Interfaces:**
- Produces: `parseRunningHubTargetInput(input, explicitKind?)`, `normalizeRunningHubFields(payload)`, `buildRunningHubNodeInfoList(fields, inputs)`, `normalizeRunningHubTaskResponse(payload, capability)`.
- Produces: `RunningHubTarget`, `RunningHubField`, `RunningHubGenerationInputs`, `ApiCallFormat = "openai" | "gemini" | "runninghub"`.

- [ ] **Step 1: Write failing parser and field-normalization tests**

```ts
expect(parseRunningHubTargetInput("https://www.runninghub.cn/workflow/1904136902449209346")).toEqual({ kind: "workflow", targetId: "1904136902449209346" });
expect(parseRunningHubTargetInput("https://www.runninghub.cn/ai-detail/1877265245566922753")).toEqual({ kind: "app", targetId: "1877265245566922753" });
expect(() => parseRunningHubTargetInput("https://example.com/workflow/1")).toThrow();
expect(() => parseRunningHubTargetInput("1904136902449209346")).toThrow();
expect(parseRunningHubTargetInput("1904136902449209346", "workflow")).toEqual({ kind: "workflow", targetId: "1904136902449209346" });
```

Use an official-shaped metadata fixture with `nodeId`, `fieldName`, `fieldValue`, `fieldData`, `fieldType`, `description`, and assert that `STRING` becomes `TEXT`, select options are parsed from `fieldData`, and prompt/image/ratio fields receive the correct default source.

- [ ] **Step 2: Run tests and confirm RED**

Run: `cd web && bun test src/services/api/runninghub.test.ts`
Expected: FAIL because `runninghub.ts` and its exports do not exist.

- [ ] **Step 3: Implement minimal types, parser, normalizer, node builder, and result classifier**

```ts
export type RunningHubFieldSource = "prompt" | "image" | "video" | "audio" | "duration" | "ratio" | "resolution" | "generateAudio" | "watermark" | "constant";
export type RunningHubTarget = { kind: "workflow" | "app"; targetId: string; fields: RunningHubField[] };
export type RunningHubGenerationInputs = { prompt: string; images?: string[]; videos?: File[]; audios?: File[]; duration?: string; ratio?: string; resolution?: string; generateAudio?: boolean; watermark?: boolean };
```

Store `runningHub?: RunningHubTarget` on `ChannelModel`; preserve it in `normalizeChannelModels`; return `https://www.runninghub.cn` from `defaultBaseUrlForApiFormat("runninghub")`; preserve `runninghub` in format normalization; export `resolveRunningHubTarget(config, value)`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd web && bun test src/services/api/runninghub.test.ts && bun run typecheck`
Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/services/api/runninghub.ts web/src/services/api/runninghub.test.ts web/src/stores/use-config-store.ts
git commit -m "feat: add RunningHub channel protocol model"
```

### Task 2: RunningHub 网络客户端与异步任务

**Files:**
- Modify: `web/src/services/api/runninghub.ts`
- Modify: `web/src/services/api/runninghub.test.ts`

**Interfaces:**
- Consumes: `RunningHubTarget`, `RunningHubGenerationInputs`, `withLocalProxy(url)`.
- Produces: `fetchRunningHubTarget(config, kind, targetId, signal?)`, `runRunningHubImage(config, target, inputs, signal?)`, `createRunningHubTask(...)`, `queryRunningHubTask(...)`.

- [ ] **Step 1: Write failing request-boundary tests**

Inject a `fetch` implementation into exported request functions and assert observable requests:

```ts
expect(request.url).toBe("https://www.runninghub.cn/task/openapi/create");
expect(request.init.headers).toMatchObject({ Authorization: "Bearer member-key" });
expect(JSON.parse(String(request.init.body))).toMatchObject({ workflowId: "1904136902449209346", apiKey: "member-key", nodeInfoList: [{ nodeId: "6", fieldName: "prompt", fieldValue: "test" }] });
```

Cover AI app submission to `/task/openapi/ai-app/run`, workflow metadata POST, AI-app metadata GET query parameters, multipart upload field `file`, V2 query, RUNNING/SUCCESS/FAILED, image/video filtering, missing task ID, missing media result, and error redaction so `member-key` never appears in the thrown message.

- [ ] **Step 2: Run tests and confirm RED**

Run: `cd web && bun test src/services/api/runninghub.test.ts`
Expected: FAIL because request functions are absent.

- [ ] **Step 3: Implement the official HTTP contract**

Use these exact endpoints:

```ts
const paths = {
  workflowMeta: "/api/openapi/getJsonApiFormat",
  appMeta: "/api/webapp/apiCallDemo",
  upload: "/openapi/v2/media/upload/binary",
  workflowRun: "/task/openapi/create",
  appRun: "/task/openapi/ai-app/run",
  query: "/openapi/v2/query",
};
```

Upload media only when a mapped media field is consumed, replace that field with returned `data.fileName`, submit once, and query the returned `taskId` every 5 seconds until success/failure/abort/30-minute deadline. Apply `withLocalProxy` to every RunningHub URL. Keep the original `taskId` on timeout errors.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd web && bun test src/services/api/runninghub.test.ts && bun run typecheck`
Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/services/api/runninghub.ts web/src/services/api/runninghub.test.ts
git commit -m "feat: implement RunningHub task client"
```

### Task 3: 接入现有图片和视频生成链路

**Files:**
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/services/api/video.ts`
- Modify: `web/src/services/api/runninghub.test.ts`

**Interfaces:**
- Consumes: `resolveRunningHubTarget`, `runRunningHubImage`, `createRunningHubTask`, `queryRunningHubTask`.
- Preserves: `requestGeneration`, `requestEdit`, `createVideoGenerationTask`, `pollVideoGenerationTask`, `waitForVideoGenerationTask` public APIs.

- [ ] **Step 1: Write failing integration-branch tests against exported dispatch helpers**

Extract small pure dispatch predicates only where needed. Assert that a selected `runninghub` image entry routes to the image client with prompt/references/size inputs, and a video entry returns `{ provider: "runninghub", id: taskId, model }`; polling the same task must query rather than resubmit.

- [ ] **Step 2: Run tests and confirm RED**

Run: `cd web && bun test src/services/api/runninghub.test.ts`
Expected: FAIL because image/video dispatch has no RunningHub branch.

- [ ] **Step 3: Add minimal image and video branches**

For `requestGeneration` and `requestEdit`, resolve the target before OpenAI/Gemini dispatch and convert returned image URLs to existing `{ id: nanoid(), dataUrl }` items. For video, extend provider to `"runninghub"`; create uploads/references during task creation, query by the original ID during polling, and return existing `VideoGenerationResult` without changing canvas consumers.

- [ ] **Step 4: Run focused tests, typecheck, and build**

Run: `cd web && bun test src/services/api/runninghub.test.ts && bun run typecheck && bun run build`
Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/services/api/image.ts web/src/services/api/video.ts web/src/services/api/runninghub.test.ts
git commit -m "feat: route image and video generation through RunningHub"
```

### Task 4: RunningHub 目标导入与字段映射界面

**Files:**
- Create: `web/src/components/layout/runninghub-target-manager.tsx`
- Modify: `web/src/components/layout/channel-editor-drawer.tsx`
- Modify: `web/src/i18n/locales/zh-CN.ts`
- Modify: `web/src/i18n/locales/en-US.ts`

**Interfaces:**
- Consumes: `fetchRunningHubTarget`, `parseRunningHubTargetInput`, `RunningHubField`.
- Produces: `RunningHubTargetManager({ channel, onModelsChange })`.

- [ ] **Step 1: Write a failing pure UI-state test where practical**

Move import form validation into `runninghub.ts` and test that missing Key, invalid URL, duplicate target name, and required field without a source return explicit validation errors. Do not snapshot Ant Design internals.

- [ ] **Step 2: Run the test and confirm RED**

Run: `cd web && bun test src/services/api/runninghub.test.ts`
Expected: FAIL because validation behavior is absent.

- [ ] **Step 3: Implement the channel editor flow**

Add `RunningHub` to protocol options. When selected, default the base URL, hide generic model selection/script controls, label the key as a member API Key, and render the target manager. The manager accepts URL or pure ID + explicit type, performs metadata-only import, lets the user choose image/video capability, edit display name, map each field source, set constants, and remove targets. Disable save/import when required values are missing; show Chinese `message` errors without the Key.

- [ ] **Step 4: Run focused tests and static checks**

Run: `cd web && bun test src/services/api/runninghub.test.ts && bun run typecheck && bun run build`
Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/layout/runninghub-target-manager.tsx web/src/components/layout/channel-editor-drawer.tsx web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts web/src/services/api/runninghub.ts web/src/services/api/runninghub.test.ts
git commit -m "feat: add RunningHub target configuration UI"
```

### Task 5: 文档、全量验证与 Docker 本地验收

**Files:**
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Modify: `docs/content/docs/progress/pending-test.zh-CN.mdx`
- Modify: `docs/content/docs/progress/todo.mdx` if a matching item exists
- Modify: `docs/content/docs/progress/todo.zh-CN.mdx` if a matching item exists
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a reproducible local build and read-only UI acceptance record.

- [ ] **Step 1: Update user-visible change records**

Add one `Unreleased` line beginning with `[new]`/`[新增]` in the repository's established language and add a pending-test item covering provider creation, workflow/app import, field mapping, proxy use, image/video routing, timeout, and no automatic paid retry. Move a matching todo item rather than duplicating it.

- [ ] **Step 2: Run the full verification suite**

Run:

```bash
cd web
bun test
bun run typecheck
bun run build
bunx prettier --check src/services/api/runninghub.ts src/services/api/runninghub.test.ts src/services/api/image.ts src/services/api/video.ts src/components/layout/runninghub-target-manager.tsx src/components/layout/channel-editor-drawer.tsx src/stores/use-config-store.ts src/i18n/locales/zh-CN.ts src/i18n/locales/en-US.ts
```

Expected: tests report 0 failures and every later command exits 0.

- [ ] **Step 3: Rebuild the local Docker deployment from this worktree**

Run: `docker compose -f docker-compose.local.yml up -d --build`
Expected: the app container becomes healthy/reachable at `http://localhost:3000`.

- [ ] **Step 4: Perform isolated browser acceptance without paid submission**

Open a separate test page at `http://localhost:3000`; verify existing OpenAI/Gemini channel editing still works, RunningHub can be selected, base URL defaults correctly, Key remains masked, link/type/capability/field-mapping controls render, and invalid input gives safe Chinese errors. Use metadata import only if a locally saved Key is already present; do not request or expose the Key and do not click the final generation action.

- [ ] **Step 5: Inspect diff and commit documentation**

```bash
git diff --check
git status --short
git add CHANGELOG.md docs/content/docs/progress
git commit -m "docs: add RunningHub channel acceptance steps"
```

- [ ] **Step 6: Run fresh post-commit verification**

Run: `cd web && bun test && bun run typecheck && bun run build`
Expected: 0 test failures and both static commands exit 0.
