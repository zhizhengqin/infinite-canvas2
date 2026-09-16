import assert from "node:assert/strict";
import test from "node:test";

import type * as acp from "@agentclientprotocol/sdk";

import { kimiHistoryMessages, normalizeKimiToolCall, normalizeKimiUpdate, permissionResponse } from "./kimi-client.js";

const scope = { threadId: "session-1", turnId: "turn-1" };

test("执行类 tool_call 归一化为 command_execution 的 item.started", () => {
    const update = {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "npm test",
        kind: "execute",
        status: "in_progress",
    } as acp.SessionUpdate;
    assert.deepEqual(normalizeKimiUpdate(update, scope), {
        type: "item.started",
        item: { id: "call-1", type: "command_execution", status: "in_progress", command: "npm test" },
        thread_id: "session-1",
        turn_id: "turn-1",
    });
});

test("其他 tool_call 归一化为 mcp_tool_call 并保留参数和结果", () => {
    const item = normalizeKimiToolCall({
        toolCallId: "call-2",
        title: "创建文本节点",
        name: "canvas_create_text_node",
        kind: "other",
        status: "pending",
        rawInput: { text: "hello" },
        rawOutput: { ok: true },
    } as acp.ToolCall);
    assert.deepEqual(item, {
        id: "call-2",
        type: "mcp_tool_call",
        status: "in_progress",
        name: "canvas_create_text_node",
        title: "创建文本节点",
        arguments: { text: "hello" },
        result: { ok: true },
    });
});

test("tool_call_update 只在终态时生成 item.completed", () => {
    const running = { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" } as acp.SessionUpdate;
    assert.equal(normalizeKimiUpdate(running, scope), null);

    const completed = {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        kind: "execute",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "全部通过" } }],
    } as acp.SessionUpdate;
    assert.deepEqual(normalizeKimiUpdate(completed, scope), {
        type: "item.completed",
        item: { id: "call-1", type: "command_execution", status: "completed", aggregatedOutput: "全部通过" },
        thread_id: "session-1",
        turn_id: "turn-1",
    });
});

test("plan 更新映射为前端计划格式", () => {
    const update = {
        sessionUpdate: "plan",
        entries: [
            { content: "读取画布", priority: "high", status: "completed" },
            { content: "创建节点", priority: "medium", status: "in_progress" },
        ],
    } as acp.SessionUpdate;
    assert.deepEqual(normalizeKimiUpdate(update, scope), {
        type: "plan.updated",
        plan: [
            { step: "读取画布", status: "completed" },
            { step: "创建节点", status: "inProgress" },
        ],
        thread_id: "session-1",
        turn_id: "turn-1",
    });
});

test("消息增量走客户端 delta 通道，归一化函数不直接产出事件", () => {
    const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } } as acp.SessionUpdate;
    assert.equal(normalizeKimiUpdate(update, scope), null);
});

test("权限响应按审批决定选择 allow 或 reject 选项", () => {
    const options = [
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
        { optionId: "allow", name: "允许一次", kind: "allow_once" },
        { optionId: "always", name: "总是允许", kind: "allow_always" },
    ] as acp.PermissionOption[];
    assert.deepEqual(permissionResponse(options, "accept"), { outcome: { outcome: "selected", optionId: "allow" } });
    assert.deepEqual(permissionResponse(options, "acceptForSession"), { outcome: { outcome: "selected", optionId: "always" } });
    assert.deepEqual(permissionResponse(options, "decline"), { outcome: { outcome: "selected", optionId: "reject" } });
    assert.deepEqual(permissionResponse(options, "cancel"), { outcome: { outcome: "cancelled" } });
    assert.deepEqual(permissionResponse([], "accept"), { outcome: { outcome: "cancelled" } });
});

test("session/load 回放历史按用户消息顺序分配 turnId", () => {
    const messages = kimiHistoryMessages("session-1", [
        { key: "user-1", role: "user", text: "第一个问题" },
        { key: "assistant-1", role: "assistant", text: "第一个回答" },
        { key: "user-2", role: "user", text: "第二个问题" },
        { key: "assistant-2", role: "assistant", text: "第二个回答" },
    ]);
    assert.deepEqual(messages.map((message) => [message.role, message.turnId, message.text]), [
        ["user", "turn-1", "第一个问题"],
        ["assistant", "turn-1", "第一个回答"],
        ["user", "turn-2", "第二个问题"],
        ["assistant", "turn-2", "第二个回答"],
    ]);
    assert.equal(messages[0].threadId, "session-1");
});
