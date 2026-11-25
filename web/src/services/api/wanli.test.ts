import { afterAll, describe, expect, test } from "bun:test";

import type { AiConfig, ApiCallFormat } from "@/stores/use-config-store";

if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
}
if (typeof globalThis.FileReader === "undefined") {
    Object.defineProperty(globalThis, "FileReader", {
        configurable: true,
        value: class {
            result = "";
            onload: (() => void) | null = null;
            async readAsDataURL(file: Blob) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                this.result = `data:${file.type};base64,${btoa(String.fromCharCode(...bytes))}`;
                this.onload?.();
            }
        },
    });
}

const { defaultBaseUrlForApiFormat, defaultConfig } = await import("@/stores/use-config-store");
const { fetchImageModels, requestGeneration } = await import("./image");
const { createVideoGenerationTask, pollVideoGenerationTask } = await import("./video");

const imageModel = "ft-image-v1-186289ba9d3263010c69372f8939dd94";
const videoModel = "ft-video-v1-b8a797753dd4c6bf8e5a69820b293848";
const imageModels = [
    imageModel,
    "ft-image-v1-eb47192eb578f340043911005a06fb6e",
    "ft-image-v1-3432bdee1a22da4ce8ff2bbfc6ef4c1d",
    "ft-image-v1-5643c00d4116f22d1abb7d480dee4f68",
    "ft-image-v1-3ef14ea5c90d0554999403af6e68485e",
    "ft-image-v1-c8f0a7251222ba36c556bbbb1f84a6a8",
];
const videoModels = [
    videoModel,
    "ft-video-v1-99d13a482c1f6f0e71db1e36c4154b70",
    "fnko_32426c8b51857008933b1e2e85839dc5",
    "ft-video-v1-756e0feb4b3e1f893726314109762123",
    "ft-video-v1-451adae35b0c4a3d275c2c46394abc98",
];
let videoSubmissions = 0;
let submittedVideoBody: Record<string, unknown> | undefined;
let videoIdempotencyKey = "";
let imageSubmissions = 0;
let submittedImageBody: Record<string, unknown> | undefined;
let imageIdempotencyKey = "";
let resultAuthorization = "";

const server: Bun.Server<undefined> = Bun.serve({
    port: 0,
    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
            return Response.json({
                data: [
                    ...imageModels.map((id) => ({ id, name: "GPT-image-2.5 系列", type: "image" })),
                    ...videoModels.map((id) => ({ id, name: "Seedance 2.5 系列", type: "video" })),
                    { id: "ft-image-v1-211f28f47b0355abb1798f72eb65f22d", name: "GPT-image-2", type: "image" },
                    { id: "ft-image-v1-80fa79934b03dcdc7a54dacdb1ad7f82", name: "nano-banana-2", type: "image" },
                    { id: "ft-video-v1-ccb254d851f883fc306ed146ad240662", name: "Seedance 2.0 满血 480-720p", type: "video" },
                    { id: "fnko_4e36114ed3dc2a255cdd863110f7cb2b", name: "特价渠道 MiniMax H3 480p-1080p", type: "video" },
                    { id: "text-model", name: "text-model", type: "text" },
                ],
            });
        }
        if (url.pathname === "/v1/images/generations" && request.method === "POST") {
            return Response.json({ data: [{ url: `${server.url.origin}/v1/jobs/image-job/content?index=0` }] });
        }
        if (url.pathname === "/api/open/v1/models") {
            return Response.json({ data: [
                {
                    id: videoModel,
                    modelVersion: 25,
                    pricingVersion: 0,
                    tokenPricingVersion: 0,
                    capabilities: { ratios: ["16:9"], resolutions: ["480p"], durations: [4], durationByResolution: { "480p": [4] }, maxImages: 9, maxVideos: 3, maxAudios: 3 },
                    pricing: { mode: "per_second", resolutionPointsPerSecond: { "480p": 4 }, videoReferenceTokenPricing: null },
                },
                {
                    id: imageModel,
                    modelVersion: 10,
                    pricingVersion: 0,
                    tokenPricingVersion: 0,
                    capabilities: { ratios: ["16:9"], resolutions: ["4K"], maxImages: 10 },
                },
            ] });
        }
        if (url.pathname === "/api/open/v1/assets" && request.method === "POST") {
            return Response.json({ id: "image-asset", name: "ref.png", mime: "image/png", size: 4 }, { status: 201 });
        }
        if (url.pathname === "/api/open/v1/video/generate" && request.method === "POST") {
            videoSubmissions += 1;
            submittedVideoBody = await request.json() as Record<string, unknown>;
            videoIdempotencyKey = request.headers.get("Idempotency-Key") || "";
            return Response.json({ jobId: "video-job", type: "video", status: "preparing", resultUrls: [] }, { status: 202 });
        }
        if (url.pathname === "/api/open/v1/image/generate" && request.method === "POST") {
            imageSubmissions += 1;
            submittedImageBody = await request.json() as Record<string, unknown>;
            imageIdempotencyKey = request.headers.get("Idempotency-Key") || "";
            return Response.json({ jobId: "image-job", type: "image", status: "preparing", resultUrls: [] }, { status: 202 });
        }
        if (url.pathname === "/api/open/v1/jobs/video-job" && request.method === "GET") {
            return Response.json({ jobId: "video-job", status: "succeeded", resultUrls: [`${server.url.origin}/api/open/v1/jobs/video-job/content?download=1`] });
        }
        if (url.pathname === "/api/open/v1/jobs/image-job" && request.method === "GET") {
            return Response.json({ jobId: "image-job", status: "succeeded", resultUrls: [`${server.url.origin}/api/open/v1/jobs/image-job/content?download=1`] });
        }
        if ((url.pathname === "/v1/jobs/image-job/content" || url.pathname === "/v1/jobs/video-job/content" || url.pathname === "/api/open/v1/jobs/video-job/content" || url.pathname === "/api/open/v1/jobs/image-job/content") && request.method === "GET") {
            resultAuthorization = request.headers.get("Authorization") || "";
            if (resultAuthorization !== "Bearer wanli-test-key") return Response.json({ error: "unauthorized" }, { status: 401 });
            const image = url.pathname.includes("image-job");
            return new Response(image ? new Uint8Array([1, 2, 3, 4]) : "video bytes", { headers: { "Content-Type": image ? "image/png" : "video/mp4" } });
        }
        return new Response("missing route", { status: 404 });
    },
});

afterAll(() => server.stop(true));

function wanliConfig(model: string): AiConfig {
    return {
        ...defaultConfig,
        baseUrl: server.url.origin,
        apiKey: "wanli-test-key",
        apiFormat: "wanli" as ApiCallFormat,
        model: `wanli::${model}`,
        channels: [
            {
                id: "wanli",
                name: "Wanli AIGC",
                baseUrl: server.url.origin,
                apiKey: "wanli-test-key",
                apiFormat: "wanli" as ApiCallFormat,
                models: [
                    { name: imageModel, capability: "image" },
                    { name: videoModel, capability: "video" },
                ],
            },
        ],
        count: "1",
        quality: "high",
        videoSeconds: "4",
        vquality: "480",
        size: "3840x2160",
    };
}

describe("Wanli AIGC channel", () => {
    test("provides the public compatible API base URL", () => {
        expect(defaultBaseUrlForApiFormat("wanli" as ApiCallFormat)).toBe("https://wanliaigc.com");
    });

    test("shows friendly names, prices and specifications for all Wanli models", async () => {
        const { normalizeChannelModels, modelOptionLabel } = await import("@/stores/use-config-store");
        const models = normalizeChannelModels([
            ...imageModels.map((name) => ({ name, capability: "image" as const })),
            ...videoModels.map((name) => ({ name, capability: "video" as const })),
        ]);
        expect(models.map((model) => model.label)).toEqual([
            "GPT-image-2.5｜0.5 积分｜1K/2K/4K｜10 图",
            "GPT-image-2.5 Flare｜3.5 积分｜1K/2K/4K｜10 图",
            "GPT-image-2.5 Sunburst｜3.5 积分｜1K/2K/4K｜10 图",
            "gpt-image-2.5｜1.5 积分｜固定规格｜8 图",
            "gpt-image-2.5 Flare｜3.5 积分｜1K/2K/4K｜8 图",
            "gpt-image-2.5 Sunburst｜3.5 积分｜1K/2K/4K｜8 图",
            "Seedance 2.5 满血｜480p 4 / 720p 4.8 积分/秒｜4–30 秒",
            "Seedance 2.5 满血 720p 特价｜43.8 积分/次｜15/30 秒",
            "Seedance 2.5 满血 1080p 全能参考｜70 积分/次｜4–30 秒",
            "XN2 Seedance 2.5 满血｜480p 4 / 720p 4.8 积分/秒｜4–30 秒",
            "官方 Seedance 2.5 满血 720p｜9.9 积分/秒｜4–30 秒",
        ]);
        const config = { ...wanliConfig(imageModel), channels: [{ ...wanliConfig(imageModel).channels[0], models }] };
        expect(modelOptionLabel(config, `wanli::${imageModel}`)).toBe("GPT-image-2.5｜0.5 积分｜1K/2K/4K｜10 图（Wanli AIGC）");
    });

    test("lists only the GPT-image-2.5 and Seedance 2.5 series", async () => {
        const models = await fetchImageModels({ baseUrl: server.url.origin, apiKey: "wanli-test-key", apiFormat: "wanli" as ApiCallFormat });
        expect(models).toEqual([...imageModels, ...videoModels].sort((a, b) => a.localeCompare(b)));
    });

    test("classifies the fnko Seedance 1080p model as video", async () => {
        const { guessCapability } = await import("@/stores/use-config-store");
        expect(guessCapability("fnko_32426c8b51857008933b1e2e85839dc5")).toBe("video");
    });

    test("downloads protected image results with the channel credential", async () => {
        const [image] = await requestGeneration(wanliConfig(imageModel), "测试生图");
        expect(resultAuthorization).toBe("Bearer wanli-test-key");
        expect(image.dataUrl).toStartWith("data:image/png;base64,");
    });

    test("uses native image generation for references instead of the compatible edits route", async () => {
        const { requestEdit } = await import("./image");
        const before = imageSubmissions;
        const [image] = await requestEdit(wanliConfig(imageModel), "测试多图参考", [{ id: "ref", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AQIDBA==" }]);
        expect(imageSubmissions).toBe(before + 1);
        expect(submittedImageBody).toEqual({
            model: imageModel,
            modelVersion: 10,
            pricingVersion: 0,
            prompt: "参考图片编号：图片1。请按这些编号理解提示词中的图片引用。\n\n测试多图参考",
            ratio: "16:9",
            resolution: "4K",
            assetIds: ["image-asset"],
        });
        expect(imageIdempotencyKey.length).toBeGreaterThanOrEqual(8);
        expect(resultAuthorization).toBe("Bearer wanli-test-key");
        expect(image.dataUrl).toStartWith("data:image/png;base64,");
    });

    test("creates one native video task with catalog versions, supported parameters and uploaded references", async () => {
        const before = videoSubmissions;
        const task = await createVideoGenerationTask(wanliConfig(videoModel), "测试视频", [{ id: "ref", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AQIDBA==" }]);
        expect(task).toEqual({ id: "video-job", provider: "wanli", model: `wanli::${videoModel}` });
        expect(videoSubmissions).toBe(before + 1);
        expect(submittedVideoBody).toEqual({
            model: videoModel,
            modelVersion: 25,
            pricingVersion: 0,
            tokenPricingVersion: 0,
            prompt: "测试视频",
            ratio: "16:9",
            resolution: "480p",
            duration: 4,
            assetIds: ["image-asset"],
            videoAssetIds: [],
            audioAssetIds: [],
        });
        expect(videoIdempotencyKey.length).toBeGreaterThanOrEqual(8);
    });

    test("polls the original video task and downloads its protected result without resubmitting", async () => {
        const before = videoSubmissions;
        const task = await createVideoGenerationTask(wanliConfig(videoModel), "测试视频");
        const submissionsAfterCreate = videoSubmissions;
        const state = await pollVideoGenerationTask(wanliConfig(videoModel), task);
        expect(resultAuthorization).toBe("Bearer wanli-test-key");
        expect(state.status).toBe("completed");
        if (state.status !== "completed") throw new Error("video task did not complete");
        expect(await state.result.blob?.text()).toBe("video bytes");
        expect(videoSubmissions).toBe(submissionsAfterCreate);
        expect(videoSubmissions).toBe(before + 1);
    });
});
