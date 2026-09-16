import fs from "node:fs";
import path from "node:path";

import * as acp from "@agentclientprotocol/sdk";

import { logger } from "../utils/logger.js";
import { errorMessage } from "../utils/value.js";
import { KimiAcpClient } from "./kimi-client.js";
import { messageMetadataStore } from "./message-metadata.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "./types.js";

type KimiRunOptions = { threadId?: string; cwd?: string; permissionMode?: AgentPermissionMode; model?: string; onStart?: () => void; onThread?: (threadId: string) => void; onTurn?: (turnId: string) => void; onFinish?: () => void };

let kimiQueue: Promise<unknown> = Promise.resolve();
let kimiApp: KimiAcpClient | null = null;
let kimiAppStart: Promise<KimiAcpClient> | null = null;
/** 仅表示最近主动加载/选择的 Kimi 会话；运行中的 turn 身份由 KimiAcpClient 自己维护。 */
let loadedSessionId = "";

/** 将 Kimi turn 加入串行队列并等待执行完成。 */
export async function runKimiTurn(prompt: string, lifecycleEmit: AgentEmit, attachments: AgentAttachment[] = [], options: KimiRunOptions = {}) {
    if (!prompt.trim() && !attachments.length) return;
    kimiQueue = kimiQueue.catch(() => undefined).then(() => runKimiTurnNow(prompt, lifecycleEmit, attachments, options));
    await kimiQueue;
}

/** 中断当前会话正在执行的 Kimi turn。 */
export async function interruptKimiTurn(threadId?: string) {
    if (!kimiApp) return false;
    return await kimiApp.interruptCurrentTurn(threadId);
}

/** 回复当前 ACP 进程的待处理权限请求。 */
export async function resolveKimiApproval(requestId: string, decision: string) {
    return Boolean(kimiApp?.resolveApproval(requestId, decision));
}

/** 创建新的 Kimi 会话并记录当前会话 ID。 */
export async function startKimiThread(emit: AgentEmit, cwd: string, _permissionMode: AgentPermissionMode = "request") {
    const app = await getKimiApp(emit);
    const session = await app.startSession(cwd);
    loadedSessionId = session.id;
    return session;
}

/** 恢复指定 Kimi 会话并返回聊天历史。 */
export async function resumeKimiThread(emit: AgentEmit, threadId: string, cwd: string, _permissionMode: AgentPermissionMode = "request") {
    const app = await getKimiApp(emit);
    const result = await app.loadSession(threadId, cwd);
    loadedSessionId = threadId;
    return { ...result, messages: await mergeMessageMetadata(threadId, result.messages), historyReady: true };
}

/** 查询当前工作空间中的 Kimi 会话。 */
export async function listKimiThreads(emit: AgentEmit, options: { cwd: string }) {
    const app = await getKimiApp(emit);
    return await app.listSessions(options.cwd);
}

/** 查询最近一次 Kimi 会话报告的可用模型。 */
export async function listKimiModels(emit: AgentEmit) {
    return (await getKimiApp(emit)).listModels();
}

/** 删除指定 Kimi 会话并清理本地元数据。 */
export async function deleteKimiThread(emit: AgentEmit, threadId: string) {
    const app = await getKimiApp(emit);
    await app.deleteSession(threadId);
    await messageMetadataStore.removeThread(threadId).catch((error) => logger.warn("Failed to remove deleted thread message metadata", { threadId, error }));
    if (loadedSessionId === threadId) loadedSessionId = "";
}

/** 检测本机 Kimi Code CLI 是否可用。 */
export function kimiAgentStatus(): { available: boolean; reason?: string } {
    const override = process.env.CANVAS_AGENT_KIMI_BIN;
    if (override) return executableFile(override) ? { available: true } : { available: false, reason: `CANVAS_AGENT_KIMI_BIN 指向的 Kimi Code CLI 不可执行：${override}` };
    const names = process.platform === "win32" ? ["kimi.exe", "kimi.cmd", "kimi.bat", "kimi"] : ["kimi"];
    const found = (process.env.PATH || "").split(path.delimiter).some((dir) => names.some((name) => executableFile(path.join(dir, name))));
    return found ? { available: true } : { available: false, reason: "未检测到 Kimi Code CLI，请先安装并登录（kimi login），或将 CANVAS_AGENT_KIMI_BIN 指向 kimi 可执行文件" };
}

async function mergeMessageMetadata<T extends { role: string; threadId: string; turnId: string }>(threadId: string, messages: T[]) {
    try {
        return await messageMetadataStore.mergeThread(threadId, messages);
    } catch (error) {
        logger.warn("Failed to read thread message metadata", { threadId, error });
        return messages;
    }
}

/** 执行一次 Kimi turn，并负责会话恢复与模型切换。 */
async function runKimiTurnNow(prompt: string, lifecycleEmit: AgentEmit, attachments: AgentAttachment[], options: KimiRunOptions) {
    try {
        options.onStart?.();
        const app = await getKimiApp(lifecycleEmit);
        const sessionId = await ensureKimiSession(app, options, lifecycleEmit);
        options.onThread?.(sessionId);
        if (options.model) await app.setModel(sessionId, options.model).catch((error) => lifecycleEmit("agent_log", { text: `Kimi 模型切换失败：${errorMessage(error)}` }));
        await app.startTurn(sessionId, kimiInput(prompt, attachments), options.permissionMode || "request", options.onTurn);
    } catch (error) {
        logger.error("Kimi turn failed", error);
        lifecycleEmit("agent_error", { message: errorMessage(error) });
    } finally {
        options.onFinish?.();
    }
}

/** 恢复请求会话或创建新的 Kimi 会话。 */
async function ensureKimiSession(app: KimiAcpClient, options: KimiRunOptions, emit: AgentEmit) {
    if (options.threadId) {
        if (options.threadId === loadedSessionId) return loadedSessionId;
        try {
            await app.loadSession(options.threadId, options.cwd || "");
            loadedSessionId = options.threadId;
            return loadedSessionId;
        } catch (error) {
            emit("agent_log", { text: `Kimi session unavailable, starting a new session: ${errorMessage(error)}` });
            loadedSessionId = "";
        }
    }
    if (!loadedSessionId) {
        const session = await app.startSession(options.cwd || process.cwd());
        loadedSessionId = session.id;
    }
    return loadedSessionId;
}

/** 获取已启动的 Kimi ACP 客户端。 */
async function getKimiApp(emit: AgentEmit) {
    if (kimiApp) return kimiApp;
    const status = kimiAgentStatus();
    if (!status.available) throw new Error(status.reason || "Kimi Code CLI 不可用");
    kimiAppStart ||= KimiAcpClient.start(emit, () => {
        kimiApp = null;
        loadedSessionId = "";
    });
    try {
        kimiApp = await kimiAppStart;
        return kimiApp;
    } finally {
        kimiAppStart = null;
    }
}

/** 将文本和 Data URL 图片附件转换为 ACP content blocks。 */
function kimiInput(prompt: string, attachments: AgentAttachment[]): acp.ContentBlock[] {
    return [
        ...(prompt.trim() ? [{ type: "text" as const, text: prompt }] : []),
        ...attachments.flatMap((item) => {
            const [, mimeType = "", data = ""] = item.dataUrl?.match(/^data:([^;]+);base64,(.+)$/) || [];
            return data ? [{ type: "image" as const, data, mimeType: mimeType || "image/png" }] : [];
        }),
    ];
}

/** 判断可执行文件是否存在。 */
function executableFile(file: string) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
