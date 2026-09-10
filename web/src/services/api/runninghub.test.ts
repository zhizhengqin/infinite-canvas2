import { describe, expect, test } from "bun:test";

import {
    buildRunningHubNodeInfoList,
    createRunningHubTask,
    fetchRunningHubTarget,
    normalizeRunningHubFields,
    normalizeRunningHubTaskResponse,
    parseRunningHubTargetInput,
    queryRunningHubTask,
    uploadRunningHubMedia,
    waitForRunningHubTask,
    type RunningHubField,
} from "./runninghub";

const client = { baseUrl: "https://www.runninghub.cn", apiKey: "member-key" };

function jsonResponse(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("parseRunningHubTargetInput", () => {
    test("parses official workflow and AI app links", () => {
        expect(parseRunningHubTargetInput("https://www.runninghub.cn/workflow/1904136902449209346")).toEqual({ kind: "workflow", targetId: "1904136902449209346" });
        expect(parseRunningHubTargetInput("https://www.runninghub.cn/ai-detail/1877265245566922753?inviteCode=test")).toEqual({ kind: "app", targetId: "1877265245566922753" });
    });

    test("requires an explicit kind for a bare ID", () => {
        expect(() => parseRunningHubTargetInput("1904136902449209346")).toThrow("请选择");
        expect(parseRunningHubTargetInput("1904136902449209346", "workflow")).toEqual({ kind: "workflow", targetId: "1904136902449209346" });
    });

    test("rejects foreign domains and malformed IDs", () => {
        expect(() => parseRunningHubTargetInput("https://example.com/workflow/1904136902449209346")).toThrow("RunningHub");
        expect(() => parseRunningHubTargetInput("https://www.runninghub.cn/workflow/not-a-number")).toThrow("链接");
    });
});

describe("normalizeRunningHubFields", () => {
    test("normalizes an official AI app nodeInfoList", () => {
        const fields = normalizeRunningHubFields({
            code: 0,
            msg: "success",
            data: {
                webappName: "Flux Kontext 单图",
                nodeInfoList: [
                    { nodeId: "39", nodeName: "LoadImage", fieldName: "image", fieldValue: "sample.png", fieldData: "[]", fieldType: "IMAGE", description: "上传图像" },
                    {
                        nodeId: "37",
                        nodeName: "Model",
                        fieldName: "aspect_ratio",
                        fieldValue: "1:1",
                        fieldData: '[{"name":"1:1","index":"1:1"},{"name":"16:9","index":"16:9"},{"default":"1:1"}]',
                        fieldType: "STRING",
                        description: "输出比例",
                    },
                    { nodeId: "52", nodeName: "Prompt", fieldName: "prompt", fieldValue: "默认提示词", fieldData: '["STRING",{"multiline":true}]', fieldType: "STRING", description: "提示词" },
                ],
            },
        });

        expect(fields).toEqual([
            { nodeId: "39", fieldName: "image", fieldType: "IMAGE", label: "上传图像", defaultValue: "sample.png", source: "image", sourceIndex: 0, required: false },
            { nodeId: "37", fieldName: "aspect_ratio", fieldType: "SELECT", label: "输出比例", defaultValue: "1:1", source: "ratio", required: false, options: ["1:1", "16:9"] },
            { nodeId: "52", fieldName: "prompt", fieldType: "TEXT", label: "提示词", defaultValue: "默认提示词", source: "prompt", required: false },
        ]);
    });

    test("expands primitive ComfyUI workflow inputs and ignores node links", () => {
        const fields = normalizeRunningHubFields({
            code: 0,
            msg: "SUCCESS",
            data: {
                prompt: JSON.stringify({
                    "3": { class_type: "KSampler", inputs: { seed: 42, steps: 20, model: ["4", 0] }, _meta: { title: "采样器" } },
                    "6": { class_type: "CLIPTextEncode", inputs: { text: "a panda", clip: ["4", 1] }, _meta: { title: "正向提示词" } },
                    "10": { class_type: "LoadImage", inputs: { image: "sample.png" }, _meta: { title: "参考图" } },
                }),
            },
        });

        expect(fields.map(({ nodeId, fieldName, fieldType, source }) => ({ nodeId, fieldName, fieldType, source }))).toEqual([
            { nodeId: "3", fieldName: "seed", fieldType: "NUMBER", source: "constant" },
            { nodeId: "3", fieldName: "steps", fieldType: "NUMBER", source: "constant" },
            { nodeId: "6", fieldName: "text", fieldType: "TEXT", source: "prompt" },
            { nodeId: "10", fieldName: "image", fieldType: "IMAGE", source: "image" },
        ]);
    });
});

describe("buildRunningHubNodeInfoList", () => {
    test("maps prompt, indexed media, runtime controls, and constants", () => {
        const fields: RunningHubField[] = [
            { nodeId: "1", fieldName: "prompt", fieldType: "TEXT", label: "Prompt", defaultValue: "", source: "prompt", required: true },
            { nodeId: "2", fieldName: "image", fieldType: "IMAGE", label: "Image", defaultValue: "", source: "image", sourceIndex: 1, required: true },
            { nodeId: "3", fieldName: "seconds", fieldType: "NUMBER", label: "Seconds", defaultValue: "5", source: "duration", required: false },
            { nodeId: "4", fieldName: "mode", fieldType: "SELECT", label: "Mode", defaultValue: "fast", source: "constant", required: true, options: ["fast", "quality"] },
        ];

        expect(buildRunningHubNodeInfoList(fields, { prompt: "cinematic", images: ["first.png", "second.png"], duration: "8" })).toEqual([
            { nodeId: "1", fieldName: "prompt", fieldValue: "cinematic" },
            { nodeId: "2", fieldName: "image", fieldValue: "second.png" },
            { nodeId: "3", fieldName: "seconds", fieldValue: 8 },
            { nodeId: "4", fieldName: "mode", fieldValue: "fast" },
        ]);
    });

    test("names an unmapped required field", () => {
        const fields: RunningHubField[] = [{ nodeId: "9", fieldName: "image", fieldType: "IMAGE", label: "首帧", defaultValue: "", source: "image", sourceIndex: 0, required: true }];
        expect(() => buildRunningHubNodeInfoList(fields, { prompt: "test" })).toThrow("首帧");
    });
});

describe("normalizeRunningHubTaskResponse", () => {
    test("classifies running, failed, and capability-matching results", () => {
        expect(normalizeRunningHubTaskResponse({ taskId: "t1", status: "RUNNING", results: null }, "image")).toEqual({ status: "pending" });
        expect(normalizeRunningHubTaskResponse({ taskId: "t1", status: "FAILED", errorMessage: "node failed", results: null }, "image")).toEqual({ status: "failed", error: "node failed" });
        expect(
            normalizeRunningHubTaskResponse(
                { taskId: "t1", status: "SUCCESS", results: [{ url: "https://cdn.example/result.mp4", outputType: "mp4" }, { url: "https://cdn.example/a.jpg", outputType: "jpg" }, { url: "https://cdn.example/b.png", outputType: "png" }] },
                "image",
            ),
        ).toEqual({ status: "completed", urls: ["https://cdn.example/a.jpg", "https://cdn.example/b.png"] });
    });

    test("fails when success contains no requested media type", () => {
        expect(normalizeRunningHubTaskResponse({ taskId: "t1", status: "SUCCESS", results: [{ url: "https://cdn.example/result.mp4", outputType: "mp4" }] }, "image")).toEqual({
            status: "failed",
            error: "任务成功但没有返回图片",
        });
    });
});

describe("RunningHub HTTP client", () => {
    test("loads AI app metadata with official query parameters and bearer auth", async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const result = await fetchRunningHubTarget(client, "app", "1877265245566922753", {
            fetchImpl: async (input, init) => {
                requests.push({ url: String(input), init });
                return jsonResponse({ code: 0, msg: "success", data: { webappName: "我的应用", nodeInfoList: [{ nodeId: "1", fieldName: "prompt", fieldValue: "", fieldData: "", fieldType: "STRING", description: "提示词" }] } });
            },
        });

        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe("https://www.runninghub.cn/api/webapp/apiCallDemo?apiKey=member-key&webappId=1877265245566922753");
        expect(requests[0].init?.headers).toEqual({ Authorization: "Bearer member-key" });
        expect(result.name).toBe("我的应用");
        expect(result.target.kind).toBe("app");
        expect(result.target.fields[0].source).toBe("prompt");
    });

    test("loads workflow JSON with the official POST body", async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const result = await fetchRunningHubTarget(client, "workflow", "1904136902449209346", {
            fetchImpl: async (input, init) => {
                requests.push({ url: String(input), init });
                return jsonResponse({ code: 0, msg: "SUCCESS", data: { prompt: JSON.stringify({ "6": { class_type: "CLIPTextEncode", inputs: { text: "panda" }, _meta: { title: "Prompt" } } }) } });
            },
        });

        expect(requests[0].url).toBe("https://www.runninghub.cn/api/openapi/getJsonApiFormat");
        expect(requests[0].init?.method).toBe("POST");
        expect(JSON.parse(String(requests[0].init?.body))).toEqual({ apiKey: "member-key", workflowId: "1904136902449209346" });
        expect(result.name).toBe("workflow-1904136902449209346");
        expect(result.target.fields[0].fieldName).toBe("text");
    });

    test("uploads binary media and returns the node fileName", async () => {
        let request: { url: string; init?: RequestInit } | undefined;
        const file = new File(["image"], "frame.png", { type: "image/png" });
        const fileName = await uploadRunningHubMedia(client, file, {
            fetchImpl: async (input, init) => {
                request = { url: String(input), init };
                return jsonResponse({ code: 0, message: "success", data: { type: "image", download_url: "https://cdn.example/frame.png", fileName: "openapi/frame.png", size: "5" } });
            },
        });

        expect(request?.url).toBe("https://www.runninghub.cn/openapi/v2/media/upload/binary");
        expect(request?.init?.method).toBe("POST");
        expect(request?.init?.headers).toEqual({ Authorization: "Bearer member-key" });
        const uploaded = (request?.init?.body as FormData).get("file") as File;
        expect({ name: uploaded.name, type: uploaded.type, text: await uploaded.text() }).toEqual({ name: "frame.png", type: "image/png", text: "image" });
        expect(fileName).toBe("openapi/frame.png");
    });

    test("submits workflow and app tasks exactly once with nodeInfoList", async () => {
        const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
        const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
            requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            return jsonResponse({ code: 0, msg: "success", data: { taskId: `task-${requests.length}`, taskStatus: "QUEUED" } });
        };
        const nodeInfoList = [{ nodeId: "6", fieldName: "prompt", fieldValue: "test" }];

        expect(await createRunningHubTask(client, { kind: "workflow", targetId: "1904136902449209346", fields: [] }, nodeInfoList, { fetchImpl })).toBe("task-1");
        expect(await createRunningHubTask(client, { kind: "app", targetId: "1877265245566922753", fields: [] }, nodeInfoList, { fetchImpl })).toBe("task-2");
        expect(requests).toEqual([
            { url: "https://www.runninghub.cn/task/openapi/create", body: { apiKey: "member-key", workflowId: "1904136902449209346", nodeInfoList } },
            { url: "https://www.runninghub.cn/task/openapi/ai-app/run", body: { apiKey: "member-key", webappId: "1877265245566922753", nodeInfoList } },
        ]);
    });

    test("queries V2 using the original task ID", async () => {
        let body: unknown;
        const state = await queryRunningHubTask(client, "task-original", "video", {
            fetchImpl: async (_input, init) => {
                body = JSON.parse(String(init?.body));
                return jsonResponse({ taskId: "task-original", status: "SUCCESS", errorCode: "", errorMessage: "", results: [{ url: "https://cdn.example/result.mp4", outputType: "mp4" }] });
            },
        });
        expect(body).toEqual({ taskId: "task-original" });
        expect(state).toEqual({ status: "completed", urls: ["https://cdn.example/result.mp4"] });
    });

    test("polls one task without resubmitting and stops on success", async () => {
        let queryCount = 0;
        const state = await waitForRunningHubTask(client, "task-one", "image", {
            fetchImpl: async () => {
                queryCount += 1;
                return jsonResponse(
                    queryCount === 1
                        ? { taskId: "task-one", status: "RUNNING", results: null }
                        : { taskId: "task-one", status: "SUCCESS", results: [{ url: "https://cdn.example/result.png", outputType: "png" }] },
                );
            },
            delayImpl: async () => undefined,
        });
        expect(queryCount).toBe(2);
        expect(state).toEqual(["https://cdn.example/result.png"]);
    });

    test("redacts the API key from HTTP and API errors", async () => {
        await expect(
            createRunningHubTask(client, { kind: "workflow", targetId: "1", fields: [] }, [], {
                fetchImpl: async () => jsonResponse({ code: 401, msg: "invalid member-key" }, 401),
            }),
        ).rejects.toThrow("invalid [REDACTED]");
    });
});

describe("image and video service dispatch", () => {
    test("routes the selected RunningHub image target through create and query", async () => {
        installBrowserStorage();
        const originalFetch = globalThis.fetch;
        const requests: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            requests.push(url);
            if (url.endsWith("/task/openapi/create")) return jsonResponse({ code: 0, msg: "success", data: { taskId: "image-task", taskStatus: "QUEUED" } });
            return jsonResponse({ taskId: "image-task", status: "SUCCESS", errorCode: "", errorMessage: "", results: [{ url: "https://cdn.example/a.png", outputType: "png" }, { url: "https://cdn.example/b.jpg", outputType: "jpg" }] });
        }) as typeof fetch;
        try {
            const { requestGeneration } = await import("./image");
            const config = await runningHubConfig("image");
            expect(await requestGeneration(config, "cinematic portrait")).toEqual([
                { id: expect.any(String), dataUrl: "https://cdn.example/a.png" },
                { id: expect.any(String), dataUrl: "https://cdn.example/b.jpg" },
            ]);
            expect(requests.filter((url) => url.endsWith("/task/openapi/create"))).toHaveLength(1);
            expect(requests.filter((url) => url.endsWith("/openapi/v2/query"))).toHaveLength(1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("creates one RunningHub video task and polls the same task", async () => {
        installBrowserStorage();
        const originalFetch = globalThis.fetch;
        const bodies: unknown[] = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
            if (url.endsWith("/task/openapi/ai-app/run")) return jsonResponse({ code: 0, msg: "success", data: { taskId: "video-task", taskStatus: "QUEUED" } });
            return jsonResponse({ taskId: "video-task", status: "SUCCESS", errorCode: "", errorMessage: "", results: [{ url: "https://cdn.example/result.mp4", outputType: "mp4" }] });
        }) as typeof fetch;
        try {
            const { createVideoGenerationTask, pollVideoGenerationTask } = await import("./video");
            const config = await runningHubConfig("video", "app");
            const task = await createVideoGenerationTask(config, "slow camera move");
            expect(task).toEqual({ id: "video-task", provider: "runninghub", model: config.model });
            expect(await pollVideoGenerationTask(config, task)).toEqual({ status: "completed", result: { url: "https://cdn.example/result.mp4", mimeType: "video/mp4" } });
            expect(bodies).toEqual([
                { apiKey: "member-key", webappId: "1877265245566922753", nodeInfoList: [{ nodeId: "1", fieldName: "prompt", fieldValue: "slow camera move" }] },
                { taskId: "video-task" },
            ]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

function installBrowserStorage() {
    if (globalThis.localStorage) return;
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
            clear: () => values.clear(),
            key: (index: number) => Array.from(values.keys())[index] ?? null,
            get length() {
                return values.size;
            },
        },
    });
}

async function runningHubConfig(capability: "image" | "video", kind: "workflow" | "app" = "workflow") {
    const { createModelChannel, defaultConfig, encodeChannelModel } = await import("@/stores/use-config-store");
    const name = capability === "image" ? "RunningHub image" : "RunningHub video";
    const channel = createModelChannel({
        id: "runninghub",
        name: "RunningHub",
        baseUrl: "https://www.runninghub.cn",
        apiKey: "member-key",
        apiFormat: "runninghub",
        models: [
            {
                name,
                capability,
                runningHub: {
                    kind,
                    targetId: kind === "workflow" ? "1904136902449209346" : "1877265245566922753",
                    fields: [{ nodeId: "1", fieldName: "prompt", fieldType: "TEXT", label: "Prompt", defaultValue: "", source: "prompt", required: true }],
                },
            },
        ],
    });
    const selected = encodeChannelModel(channel.id, name);
    return { ...defaultConfig, channels: [channel], models: [selected], model: selected, imageModel: selected, videoModel: selected };
}
