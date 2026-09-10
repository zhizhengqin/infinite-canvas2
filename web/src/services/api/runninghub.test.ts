import { describe, expect, test } from "bun:test";

import {
    buildRunningHubNodeInfoList,
    normalizeRunningHubFields,
    normalizeRunningHubTaskResponse,
    parseRunningHubTargetInput,
    type RunningHubField,
} from "./runninghub";

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
