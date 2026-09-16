import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import { createAgentLogWriter } from "../utils/agent-runtime.js";
import { VERSION } from "../config.js";
import { logger } from "../utils/logger.js";
import { errorMessage, field, type JsonRecord } from "../utils/value.js";
import { canvasAgentMcpCommand } from "./codex-client.js";
import type { AgentEmit, AgentPermissionMode } from "./types.js";

type AgentEvent = JsonRecord & { type: string };
type EventScope = { threadId: string; turnId: string };
type PendingDelta = { delta: string; itemType: string; itemId: string; timer: ReturnType<typeof setTimeout> };
type PendingPermission = { resolve: (response: acp.RequestPermissionResponse) => void; params: acp.RequestPermissionRequest; decision?: string };
type HistoryEntry = { key: string; role: "user" | "assistant"; text: string };
export type KimiModelOption = { id: string; name: string; description?: string };

const STREAM_UPDATE_INTERVAL_MS = 40;

/** 封装 Kimi Code CLI（kimi acp）的 ACP 通信与事件转换。 */
export class KimiAcpClient {
    private connection!: acp.ClientConnection;
    private currentSessionId = "";
    private currentTurnId = "";
    private turnPermissionMode: AgentPermissionMode = "request";
    private failing = false;
    private failureMessage = "";
    private sessionCwds = new Map<string, string>();
    private turnCountBySession = new Map<string, number>();
    private modelOptions: { current: string; data: KimiModelOption[] } = { current: "", data: [] };
    private loadingSessions = new Set<string>();
    private historyBySession = new Map<string, HistoryEntry[]>();
    private historyOpenKey = new Map<string, string>();
    private pendingDeltas = new Map<string, PendingDelta>();
    private textByItem = new Map<string, { itemType: string; text: string }>();
    private startedTools = new Map<string, JsonRecord>();
    private pendingPermissions = new Map<string, PendingPermission>();

    private constructor(private child: ChildProcess, private emit: AgentEmit) {}

    /** 启动并初始化 Kimi Code ACP 进程。 */
    static async start(emit: AgentEmit, onExit: () => void) {
        logger.info("Starting Kimi Code ACP", { bin: kimiBin() });
        const child = spawn(kimiBin(), ["acp"], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
        const client = new KimiAcpClient(child, emit);
        let stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            onExit();
        };
        const stderr = createAgentLogWriter((text) => {
            logger.warn("Kimi ACP stderr", { text });
            emit("agent_log", { text });
        });
        child.stderr?.on("data", (chunk) => stderr.write(chunk.toString()));
        child.on("error", (error) => {
            stderr.flush();
            logger.error("Kimi ACP process error", error);
            emit("agent_error", { message: error.message });
            client.failAll(error.message);
            stop();
        });
        child.on("exit", (code) => {
            stderr.flush();
            logger.warn("Kimi ACP exited", { code });
            client.failAll(`Kimi ACP exited: ${code ?? 0}`);
            stop();
            emit("agent_log", { text: `Kimi ACP exited: ${code ?? 0}` });
        });
        const stream = acp.ndJsonStream(
            Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        );
        client.connection = acp.client({ name: "canvas-agent" })
            .onRequest(acp.methods.client.session.requestPermission, (ctx) => client.handlePermission(ctx.params))
            .onNotification(acp.methods.client.session.update, (ctx) => client.handleUpdate(ctx.params))
            .connect(stream);
        void client.connection.closed.then(() => {
            client.failAll("Kimi ACP connection closed");
            stop();
        });
        await client.connection.agent.request("initialize", {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "canvas-agent", title: "Infinite Canvas Agent", version: VERSION },
        });
        return client;
    }

    /** 创建新的 Kimi 会话并注入 infinite-canvas MCP。 */
    async startSession(cwd: string) {
        const result = await this.request("session/new", { cwd, mcpServers: [canvasMcpServer()] });
        this.sessionCwds.set(result.sessionId, cwd);
        this.turnCountBySession.set(result.sessionId, 0);
        this.cacheConfigOptions(result.configOptions);
        return { id: result.sessionId };
    }

    /** 恢复 Kimi 会话并从回放的通知中整理聊天历史。 */
    async loadSession(sessionId: string, cwd: string) {
        this.loadingSessions.add(sessionId);
        this.historyBySession.set(sessionId, []);
        this.historyOpenKey.delete(sessionId);
        try {
            const result = await this.request("session/load", { sessionId, cwd, mcpServers: [canvasMcpServer()] });
            this.sessionCwds.set(sessionId, cwd);
            this.cacheConfigOptions(result.configOptions);
            const messages = kimiHistoryMessages(sessionId, this.historyBySession.get(sessionId) || []);
            const userTurns = messages.filter((message) => message.role === "user").length;
            this.turnCountBySession.set(sessionId, userTurns);
            return { id: sessionId, messages, settledTurnIds: [...new Set(messages.map((message) => message.turnId).filter(Boolean))] };
        } finally {
            this.loadingSessions.delete(sessionId);
            this.historyBySession.delete(sessionId);
            this.historyOpenKey.delete(sessionId);
        }
    }

    /** 查询指定工作目录下的 Kimi 会话列表。 */
    async listSessions(cwd: string) {
        const result = await this.request("session/list", { cwd });
        return {
            data: (result.sessions || []).map((item) => ({
                id: item.sessionId,
                preview: String(item.title || ""),
                name: item.title || null,
                cwd: item.cwd,
                updatedAt: Date.parse(String(item.updatedAt || "")) || 0,
            })),
            nextCursor: result.nextCursor || null,
        };
    }

    /** 删除指定 Kimi 会话；不支持删除能力时仅断开本地引用。 */
    async deleteSession(sessionId: string) {
        try {
            await this.request("session/delete", { sessionId });
        } catch (error) {
            logger.warn("Kimi session delete failed", { sessionId, error });
        }
        this.sessionCwds.delete(sessionId);
        this.turnCountBySession.delete(sessionId);
    }

    /** 返回最近一次 session/new 或 session/load 报告的模型列表。 */
    listModels() {
        return { data: this.modelOptions.data, current: this.modelOptions.current };
    }

    /** 通过 session/set_config_option 切换会话模型。 */
    async setModel(sessionId: string, model: string) {
        const result = await this.request("session/set_config_option", { sessionId, configId: "model", value: model });
        this.cacheConfigOptions(result.configOptions);
    }

    /** 执行一次 Kimi turn 并等待 stopReason。 */
    async startTurn(sessionId: string, blocks: acp.ContentBlock[], permissionMode: AgentPermissionMode, onTurn?: (turnId: string) => void) {
        const turnId = `turn-${(this.turnCountBySession.get(sessionId) || 0) + 1}`;
        this.turnCountBySession.set(sessionId, (this.turnCountBySession.get(sessionId) || 0) + 1);
        this.currentSessionId = sessionId;
        this.currentTurnId = turnId;
        this.turnPermissionMode = permissionMode;
        onTurn?.(turnId);
        this.emit("agent_event", { agent: "kimi", type: "turn.started", thread_id: sessionId, turn_id: turnId });
        try {
            const result = await this.request("session/prompt", { sessionId, prompt: blocks });
            this.finishTurn(sessionId, turnId, result.stopReason === "cancelled" ? "interrupted" : "completed");
            return result;
        } catch (error) {
            this.finishTurn(sessionId, turnId, "failed", errorMessage(error));
            throw error;
        } finally {
            if (this.currentTurnId === turnId) {
                this.currentSessionId = "";
                this.currentTurnId = "";
            }
        }
    }

    /** 中断当前会话正在执行的 Kimi turn。 */
    async interruptCurrentTurn(requestedSessionId?: string) {
        const sessionId = this.currentSessionId;
        if (!sessionId || !this.currentTurnId || (requestedSessionId && requestedSessionId !== sessionId)) return false;
        try {
            logger.warn("Interrupting active Kimi turn", { sessionId, turnId: this.currentTurnId });
            await this.connection.agent.notify("session/cancel", { sessionId });
        } catch (error) {
            logger.warn("Failed to interrupt Kimi turn", { error, sessionId });
        }
        return true;
    }

    /** 回复网页端已经确认的 Kimi 权限请求。 */
    resolveApproval(requestId: string, decision: string) {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return false;
        if (pending.decision) return true;
        pending.decision = decision;
        this.pendingPermissions.delete(requestId);
        pending.resolve(permissionResponse(pending.params.options, decision));
        this.emit("agent_approval_resolved", { agent: "kimi", requestId, threadId: this.currentSessionId, turnId: this.currentTurnId, decision });
        return true;
    }

    /** 发送 ACP 请求并在进程失败后统一报错。 */
    private request<Method extends acp.AgentRequestMethod>(method: Method, params: acp.AgentRequestParamsByMethod[Method]): Promise<acp.AgentRequestResponsesByMethod[Method]> {
        if (this.failing) return Promise.reject(new Error(this.failureMessage || "Kimi ACP 已停止")) as Promise<acp.AgentRequestResponsesByMethod[Method]>;
        logger.debug(`Kimi ${method}`, { sessionId: field(params, "sessionId") });
        return this.connection.agent.request(method, params);
    }

    /** 转换并广播 ACP session/update 通知；session/load 期间只累积历史。 */
    private handleUpdate(params: acp.SessionNotification) {
        const sessionId = params.sessionId;
        if (this.loadingSessions.has(sessionId)) return this.accumulateHistory(sessionId, params.update);
        if (sessionId !== this.currentSessionId || !this.currentTurnId) return;
        const scope = { threadId: sessionId, turnId: this.currentTurnId };
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
            if (update.content.type !== "text") return;
            const itemType = update.sessionUpdate === "agent_message_chunk" ? "agent_message" : "reasoning";
            this.emitDelta(itemType, update.messageId || itemType, update.content.text, scope);
            return;
        }
        const event = normalizeKimiUpdate(update, scope);
        if (!event) return;
        if (event.type === "item.started") {
            const item = field(event, "item") as JsonRecord;
            this.startedTools.set(String(item.id || ""), item);
        }
        if (event.type === "item.completed") {
            const item = field(event, "item") as JsonRecord;
            const started = this.startedTools.get(String(item.id || ""));
            if (started) event.item = { ...started, ...item };
            this.startedTools.delete(String(item.id || ""));
        }
        this.emit("agent_event", { agent: "kimi", ...event });
    }

    /** session/load 回放期间按 messageId 累积用户和助手文本。 */
    private accumulateHistory(sessionId: string, update: acp.SessionUpdate) {
        if (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") return;
        if (update.content.type !== "text") return;
        const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
        const key = update.messageId || `${role}-chunk`;
        const history = this.historyBySession.get(sessionId);
        if (!history) return;
        let entry = history.find((item) => item.key === key);
        if (!entry) {
            // ACP 回放时同一条消息的 chunk 共享 messageId；没有 messageId 时同角色连续 chunk 视为一条消息。
            const openKey = this.historyOpenKey.get(sessionId);
            if (!update.messageId && openKey === key) entry = history[history.length - 1];
        }
        if (!entry) {
            entry = { key, role, text: "" };
            history.push(entry);
        }
        this.historyOpenKey.set(sessionId, key);
        entry.text += update.content.text;
    }

    /** 处理 Kimi 发起的权限请求；request 模式挂起等待网页审批，其余模式自动放行。 */
    private handlePermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
        if (this.turnPermissionMode !== "request") {
            return Promise.resolve(permissionResponse(params.options, this.turnPermissionMode === "full" ? "acceptForSession" : "accept"));
        }
        const requestId = crypto.randomUUID();
        this.emit("agent_approval", {
            agent: "kimi",
            requestId,
            threadId: this.currentSessionId,
            turnId: this.currentTurnId,
            toolCall: params.toolCall,
            options: params.options,
        });
        return new Promise((resolve) => this.pendingPermissions.set(requestId, { resolve, params }));
    }

    /** 合并并广播 Kimi 文本增量。 */
    private emitDelta(itemType: string, itemId: string, delta: string, scope: EventScope) {
        const key = `${scope.threadId}\0${scope.turnId}\0${itemId}`;
        const entry = this.textByItem.get(key) || { itemType, text: "" };
        entry.text += delta;
        this.textByItem.set(key, entry);
        const pending = this.pendingDeltas.get(key);
        if (pending) {
            pending.delta += delta;
            return;
        }
        this.pendingDeltas.set(key, { delta, itemType, itemId, timer: setTimeout(() => this.flushDelta(key, scope), STREAM_UPDATE_INTERVAL_MS) });
    }

    /** 合并短时间内的文本增量，减少 SSE 传输和前端渲染次数。 */
    private flushDelta(key: string, scope: EventScope) {
        const pending = this.pendingDeltas.get(key);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingDeltas.delete(key);
        if (pending.delta) this.emit("agent_event", { agent: "kimi", type: "item.updated", item: { id: pending.itemId, type: pending.itemType, delta: pending.delta }, thread_id: scope.threadId, turn_id: scope.turnId });
    }

    /** turn 结束时发送剩余增量、补齐 item.completed 并广播终态。 */
    private finishTurn(sessionId: string, turnId: string, status: string, message = "") {
        const prefix = `${sessionId}\0${turnId}\0`;
        [...this.pendingDeltas.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => this.flushDelta(key, { threadId: sessionId, turnId }));
        [...this.textByItem.entries()].filter(([key]) => key.startsWith(prefix)).forEach(([key, entry]) => {
            this.textByItem.delete(key);
            if (entry.text.trim()) this.emit("agent_event", { agent: "kimi", type: "item.completed", item: { id: key.slice(prefix.length), type: entry.itemType, text: entry.text }, thread_id: sessionId, turn_id: turnId });
        });
        [...this.startedTools.entries()].forEach(([id, item]) => {
            this.startedTools.delete(id);
            this.emit("agent_event", { agent: "kimi", type: "item.completed", item: { ...item, status: status === "interrupted" ? "failed" : item.status || "completed" }, thread_id: sessionId, turn_id: turnId });
        });
        this.emit("agent_event", { agent: "kimi", type: "turn.completed", status, ...(message ? { error: { message } } : {}), thread_id: sessionId, turn_id: turnId });
        this.emit("agent_done", { agent: "kimi", thread_id: sessionId, turn_id: turnId, status });
    }

    /** 进程退出时取消挂起的权限请求并终结当前 turn。 */
    private failAll(message: string) {
        if (this.failing) return;
        this.failing = true;
        this.failureMessage = message;
        this.pendingPermissions.forEach((pending, requestId) => {
            this.pendingPermissions.delete(requestId);
            pending.resolve({ outcome: { outcome: "cancelled" } });
            this.emit("agent_approval_resolved", { agent: "kimi", requestId, threadId: this.currentSessionId, turnId: this.currentTurnId, decision: pending.decision || "cancel" });
        });
        this.pendingDeltas.forEach((item) => clearTimeout(item.timer));
        this.pendingDeltas.clear();
        this.textByItem.clear();
        this.startedTools.clear();
        if (this.currentSessionId && this.currentTurnId) {
            const { currentSessionId, currentTurnId } = this;
            this.currentSessionId = "";
            this.currentTurnId = "";
            this.emit("agent_event", { agent: "kimi", type: "turn.completed", status: "failed", error: { message }, thread_id: currentSessionId, turn_id: currentTurnId });
            this.emit("agent_done", { agent: "kimi", thread_id: currentSessionId, turn_id: currentTurnId, status: "failed", error: { message } });
        }
    }

    /** 从 session/new 或 session/load 的 configOptions 中缓存模型列表。 */
    private cacheConfigOptions(configOptions?: acp.SessionConfigOption[] | null) {
        const model = (configOptions || []).find((option) => option.id === "model" && option.type === "select");
        if (!model || model.type !== "select") return;
        const options = (Array.isArray(model.options) ? model.options : []).flatMap((item) => "value" in item ? [item] : item.options || []);
        this.modelOptions = {
            current: String(model.currentValue || ""),
            data: options.map((item) => ({ id: String(item.value), name: String(item.name || item.value), ...(item.description ? { description: String(item.description) } : {}) })),
        };
    }
}

/** 将 ACP session/update 转换为前端使用的统一 Agent 事件。 */
export function normalizeKimiUpdate(update: acp.SessionUpdate, scope: EventScope): AgentEvent | null {
    const threadScope = { thread_id: scope.threadId, turn_id: scope.turnId };
    if (update.sessionUpdate === "tool_call") return { type: "item.started", item: normalizeKimiToolCall(update), ...threadScope };
    if (update.sessionUpdate === "tool_call_update") {
        const status = mapKimiToolStatus(update.status);
        if (status !== "completed" && status !== "failed") return null;
        return { type: "item.completed", item: { ...normalizeKimiToolUpdate(update), status }, ...threadScope };
    }
    if (update.sessionUpdate === "plan") {
        return { type: "plan.updated", plan: (update.entries || []).map((entry) => ({ step: entry.content, status: mapKimiPlanStatus(entry.status) })), ...threadScope };
    }
    return null;
}

/** 将 ACP tool_call 转换为前端认识的 snake_case item。 */
export function normalizeKimiToolCall(toolCall: acp.ToolCall): JsonRecord {
    const item: JsonRecord = {
        id: toolCall.toolCallId,
        type: toolCall.kind === "execute" ? "command_execution" : "mcp_tool_call",
        status: mapKimiToolStatus(toolCall.status),
    };
    if (item.type === "command_execution") {
        item.command = toolCall.title;
        const output = toolCallContentText(toolCall.content) || rawText(toolCall.rawOutput);
        if (output) item.aggregatedOutput = output;
    } else {
        item.name = toolCall.name || toolCall.title;
        item.title = toolCall.title;
        if (toolCall.rawInput !== undefined) item.arguments = toolCall.rawInput;
        if (toolCall.rawOutput !== undefined) item.result = toolCall.rawOutput;
        const output = toolCallContentText(toolCall.content);
        if (output) item.output = output;
    }
    return item;
}

/** 将 ACP tool_call_update 合并为终态 item。 */
function normalizeKimiToolUpdate(update: acp.ToolCallUpdate): JsonRecord {
    const item: JsonRecord = { id: update.toolCallId, type: update.kind === "execute" ? "command_execution" : "mcp_tool_call" };
    if (update.title) item.title = update.title;
    if (update.name) item.name = update.name;
    const output = toolCallContentText(update.content) || rawText(update.rawOutput);
    if (output) (item.type === "command_execution" ? item.aggregatedOutput = output : item.output = output);
    return item;
}

/** 将 session/load 回放累积的文本整理为聊天历史消息。 */
export function kimiHistoryMessages(threadId: string, history: HistoryEntry[]) {
    let turn = 0;
    return history.map((entry, index) => {
        if (entry.role === "user") turn += 1;
        const turnId = turn ? `turn-${turn}` : "";
        return { id: `${threadId}:${turnId || "intro"}:${entry.key || index}`, itemId: entry.key || `message-${index}`, threadId, turnId, role: entry.role, text: entry.text };
    });
}

/** 将网页审批决定转换为 ACP 权限响应。 */
export function permissionResponse(options: acp.PermissionOption[], decision: string): acp.RequestPermissionResponse {
    if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
    const kinds = decision === "acceptForSession" ? ["allow_always", "allow_once"] : decision === "accept" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    const option = kinds.flatMap((kind) => options.filter((item) => item.kind === kind))[0] || options[0];
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}

function mapKimiToolStatus(status?: acp.ToolCallStatus | null) {
    if (status === "completed" || status === "failed") return status;
    return "in_progress";
}

function mapKimiPlanStatus(status: acp.PlanEntryStatus) {
    return status === "in_progress" ? "inProgress" as const : status;
}

/** 提取 tool call 内容中的纯文本。 */
function toolCallContentText(content?: acp.ToolCallContent[] | null) {
    return (content || []).map((item) => {
        if (item.type === "content" && item.content.type === "text") return item.content.text;
        return "";
    }).filter(Boolean).join("\n");
}

function rawText(value: unknown) {
    return typeof value === "string" ? value : "";
}

/** 生成 Kimi 会话使用的 infinite-canvas MCP 配置。 */
function canvasMcpServer(): acp.McpServer {
    const command = canvasAgentMcpCommand();
    return { name: "infinite-canvas", command: command.command, args: command.args, env: [] };
}

/** 定位 Kimi Code CLI 可执行文件。 */
function kimiBin() {
    return process.env.CANVAS_AGENT_KIMI_BIN || "kimi";
}
