# RunningHub 原生渠道设计规格

状态：待用户审阅
目标版本：新版无限画布 `v0.18.0` 之后的本地分支
目标部署：`http://localhost:3000`

## 1. 目标

在新版无限画布中新增原生 `RunningHub` 渠道，使用户可以：

1. 使用消费级会员 API Key 调用 RunningHub 工作流和 AI 应用。
2. 粘贴 RunningHub 工作流或 AI 应用链接并导入为画布中的图片或视频生成项。
3. 把画布上游的图片、视频、音频和提示词映射到 RunningHub 节点字段。
4. 提交异步任务、查看状态和失败原因，并把生成结果自动放回当前工作台或画布。

本功能不修改电影项目、剧本、参考图或 CINEDANCE 提示词。

## 2. 采用方案

采用“原生渠道 + 目标条目”的方案，不使用每个模型一段不可见的硬编码脚本。

- `ModelChannel.apiFormat` 新增 `runninghub`。
- 一个 RunningHub 渠道保存一个会员 Key 和若干“目标条目”。
- 每个目标条目仍作为现有模型选择器中的一个选项出现，并声明图片或视频能力。
- 目标条目内部保存 `workflow` 或 `app` 类型、目标 ID、字段定义和字段映射。
- 图片与视频生成服务识别 RunningHub 条目后，调用专用服务模块完成上传、提交、轮询和结果归一化。

这样可以复用现有渠道选择器、工作台和画布生成链路，同时避免把 RunningHub 协议混进 OpenAI/Gemini 的通用请求代码。

## 3. 不采用的方案

### 3.1 为每个工作流粘贴自定义模型脚本

优点是改动少。缺点是工作流 ID、节点 ID、上传和轮询逻辑都被复制到脚本中，难以检查、迁移和统一修复。仅保留为高级用户的现有逃生口，不作为本次正式实现。

### 3.2 在新版画布中增加本地 Python 后端

旧版画布采用后端代理，功能完整，但新版架构明确由浏览器前端直连。为 RunningHub 单独恢复后端会引入第二套部署和状态持久化，不采用。

## 4. 支持范围

### 4.1 首版支持

- RunningHub 消费级会员 Key。
- ComfyUI 工作流：`workflowId`。
- AI 应用：`webappId`。
- 图片、视频生成能力。
- 文本、数字、布尔、选项、图片、视频、音频字段。
- 本地参考素材上传。
- 单个任务的提交、轮询、成功、失败和超时。
- 一个任务返回多个图片时全部接收；视频任务选择第一个视频结果。

### 4.2 首版不支持

- RunningHub 标准模型 API 和企业共享 Key。
- LLM、语音合成或纯文本输出。
- 工作流编辑、复制、发布或删除。
- 自动取消 RunningHub 云端任务。
- 自动重试付费任务。
- 批量队列、并发调度和费用预算系统。
- 把 API Key 写入仓库、Docker 镜像、日志或电影项目文件。

## 5. 数据模型

在现有渠道结构上增加可选的 RunningHub 元数据：

```ts
type ApiCallFormat = "openai" | "gemini" | "runninghub";

type RunningHubTargetKind = "workflow" | "app";

type RunningHubFieldSource =
    | "prompt"
    | "image"
    | "video"
    | "audio"
    | "duration"
    | "ratio"
    | "resolution"
    | "generateAudio"
    | "watermark"
    | "constant";

type RunningHubField = {
    nodeId: string;
    fieldName: string;
    fieldType: "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT" | "IMAGE" | "VIDEO" | "AUDIO";
    label: string;
    defaultValue: string;
    source: RunningHubFieldSource;
    sourceIndex?: number;
    required: boolean;
    options?: string[];
};

type RunningHubTarget = {
    kind: RunningHubTargetKind;
    targetId: string;
    fields: RunningHubField[];
};

type ChannelModel = {
    name: string;
    capability: "image" | "video" | "text" | "audio";
    script?: string;
    runningHub?: RunningHubTarget;
};
```

旧渠道没有 `runningHub` 字段，保持原行为。

## 6. 配置界面

### 6.1 渠道编辑

协议下拉框新增 `RunningHub`。选中后：

- 默认地址为 `https://www.runninghub.cn`。
- 显示“会员 API Key”输入框。
- 隐藏“拉取模型”按钮，因为工作流和 AI 应用不是模型列表。
- 显示“导入 RunningHub 链接”区域。

### 6.2 导入目标

用户粘贴以下任一格式：

- `https://www.runninghub.cn/workflow/<workflowId>`
- `https://www.runninghub.cn/ai-detail/<webappId>`
- 纯数字 ID，并手动选择“工作流”或“AI 应用”。

导入流程：

1. 解析目标类型和 ID。
2. 使用当前 Key 读取工作流 JSON 或 AI 应用调用示例。
3. 把可修改节点转换为统一字段列表。
4. 用户选择该条目的图片/视频能力并检查自动字段映射。
5. 保存到当前 RunningHub 渠道。

导入和连接测试只读取元数据，不提交生成任务，不产生生成费用。

### 6.3 字段映射

根据字段名和类型给出默认映射：

- `prompt`、`text`、`positive` 优先映射到提示词。
- `image` 映射到按顺序排列的参考图。
- `video` 映射到参考视频。
- `audio` 映射到参考音频。
- `duration`、`seconds` 映射到时长。
- `ratio`、`aspect_ratio` 映射到画幅。
- `resolution` 映射到分辨率。
- `generateAudio` 和 `watermark` 映射到对应开关。
- 其余字段保留工作流默认值，用户可以改为常量或其他来源。

自动映射只是初值；保存前用户可以更改。必填字段没有来源时禁止运行并给出字段名称。

## 7. 运行数据流

```text
画布/工作台点击生成
  -> 解析所选 RunningHub 渠道和目标条目
  -> 校验 Key、目标 ID 和必填映射
  -> 上传本地图片/视频/音频
  -> 生成 nodeInfoList
  -> 提交 workflow 或 app 任务
  -> 获得 taskId
  -> 每 5 秒查询一次
  -> 成功：归一化 results 并写回工作台/画布
  -> 失败：显示 RunningHub 原始失败原因的安全摘要
```

接口：

- 素材上传：`POST /openapi/v2/media/upload/binary`
- 工作流元数据：`POST /api/openapi/getJsonApiFormat`
- 工作流提交：`POST /task/openapi/create`
- AI 应用元数据：`GET /api/webapp/apiCallDemo`
- AI 应用提交：`POST /task/openapi/ai-app/run`
- 结果查询：`POST /openapi/v2/query`

请求统一复用新版画布的本地转发代理，避免浏览器 CORS 限制。代理仅转发，不持久化 Key 或请求体。

## 8. 超时、重试和费用边界

- 查询间隔固定为 5 秒。
- 单任务最长等待 30 分钟。
- 网络查询失败不自动重新提交任务；只允许继续查询同一个 `taskId`。
- 生成任务失败或超时后不自动重试，避免重复扣费。
- 用户主动点击“生成”才提交付费任务。
- 批量生成不属于首版；后续实施前必须展示预计消耗并获得明确授权。

## 9. 安全与隐私

- API Key 继续使用现有浏览器本地配置存储。
- 密钥输入框默认隐藏内容。
- 日志、报错、任务记录和导出结果不得包含完整 Key 或 Authorization 请求头。
- 参考素材只在用户点击生成时上传到 RunningHub。
- 配置导出沿用现有“包含凭据”的显著警告，不增加静默同步。
- 不把 RunningHub Key 写入仓库、环境变量、Docker 层或电影项目目录。

## 10. 错误处理

- HTTP 非成功状态：显示状态码和 RunningHub 返回的安全错误信息。
- `code != 0`：显示 `msg`，不继续轮询。
- 没有 `taskId`：视为提交失败。
- `status == FAILED`：显示 `errorMessage` 或 `failedReason`。
- `status == SUCCESS` 但没有匹配能力的结果：显示“任务成功但没有返回图片/视频”。
- 轮询超时：保留 `taskId`，允许用户继续查询，但不重新提交。
- 用户取消本地等待：停止轮询，明确提示云端任务可能仍在运行。

## 11. 文件职责

预计新增：

- `web/src/services/api/runninghub.ts`：URL 解析、元数据获取、上传、提交、查询和结果归一化。
- `web/src/components/layout/runninghub-target-manager.tsx`：目标导入、字段映射和条目管理。
- `web/src/services/api/runninghub.test.ts`：协议解析和数据转换测试。

预计修改：

- `web/src/stores/use-config-store.ts`：协议类型、目标结构、默认地址和请求配置解析。
- `web/src/components/layout/channel-editor-drawer.tsx`：RunningHub 渠道表单入口。
- `web/src/services/api/image.ts`：RunningHub 图片生成分支。
- `web/src/services/api/video.ts`：RunningHub 视频生成分支。
- `web/src/i18n/locales/zh-CN.ts`、`en-US.ts`：界面文案。
- `docs/content/docs/progress/pending-test.mdx`：待用户验证记录。
- `CHANGELOG.md`：`Unreleased` 功能归纳。

如果实现时现有组件边界允许更少文件，以更少改动为准，但不得把协议细节堆进 UI 组件。

## 12. 测试与验收

### 12.1 自动测试

使用 Bun 测试纯协议逻辑：

- 解析工作流链接、AI 应用链接和纯 ID。
- 拒绝非法域名、非法 ID 和不明确的纯 ID。
- 把工作流 JSON 和 AI 应用示例转换为字段列表。
- 自动映射提示词、媒体、时长、画幅和分辨率字段。
- 生成正确的 `nodeInfoList`。
- 归一化 RunningHub 成功、运行中和失败响应。
- 从多个结果中过滤图片或视频。
- 错误信息不包含 API Key。

### 12.2 静态验证

- `bun test`
- `bun run typecheck`
- `bun run build`
- `bun run format:check` 只检查本次修改文件；项目全量历史格式问题不作为本功能完成条件。

### 12.3 本地验收

1. 重建并启动 `localhost:3000` Docker。
2. 确认旧渠道仍可编辑和选择。
3. 新建 RunningHub 渠道并在本地页面填写会员 Key。
4. 导入一个工作流和一个 AI 应用，确认字段列表可编辑。
5. 运行只读连接测试，确认不产生任务。
6. 在用户明确同意实际扣费后，提交一个短测试任务。
7. 确认生成结果作为图片或视频出现在工作台及画布中。

## 13. 完成标准

以下条件全部满足才算完成：

- 新版 `localhost:3000` 可原生保存 RunningHub 渠道。
- 可以导入并保存工作流和 AI 应用。
- 图片和视频生成链路都能识别 RunningHub 条目。
- 本地素材可以上传并正确写入 `nodeInfoList`。
- 任务状态、失败和超时行为符合本规格。
- 自动测试、类型检查和构建通过。
- Docker 中的新版页面通过只读连接验收。
- 未经用户确认没有提交任何付费生成任务。
