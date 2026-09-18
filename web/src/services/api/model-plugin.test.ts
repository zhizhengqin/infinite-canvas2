import axios from "axios";
import { describe, expect, spyOn, test } from "bun:test";

if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
}

describe("Gemini image plugin template", () => {
    test("converts a resolved 16:9 pixel size into Gemini aspectRatio", async () => {
        const { getPluginTemplates } = await import("./model-plugin");
        const script = getPluginTemplates().image.find((template) => template.label.includes("Gemini"))?.script;
        expect(script).toBeTruthy();

        let requestBody: Record<string, any> | undefined;
        const runner = new Function(
            "prompt",
            "images",
            "params",
            "model",
            "baseUrl",
            "apiKey",
            "request",
            `return (async () => { ${script} })();`,
        ) as (...args: unknown[]) => Promise<unknown>;

        await runner("cinematic frame", [], { size: "3840x2160", quality: "high", count: 1 }, "gemini-3-pro-image-preview", "https://example.com", "test-key", async (config: Record<string, any>) => {
            requestBody = config.data;
            return { candidates: [] };
        });

        expect(requestBody?.generationConfig?.imageConfig).toEqual({ aspectRatio: "16:9", imageSize: "4K" });
    });

    test("keeps a ratio value for an existing Gemini channel script", async () => {
        const [{ requestGeneration }, { defaultConfig }] = await Promise.all([import("./image"), import("@/stores/use-config-store")]);
        const model = "apiyi::gemini-3-pro-image-preview";
        const result = await requestGeneration(
            {
                ...defaultConfig,
                model,
                imageModel: model,
                size: "16:9",
                quality: "high",
                count: "1",
                channels: [
                    {
                        id: "apiyi",
                        name: "apiyi",
                        baseUrl: "https://example.com",
                        apiKey: "test-key",
                        apiFormat: "openai",
                        models: [{ name: "gemini-3-pro-image-preview", capability: "image", script: 'return [`data:text/plain,${params.size}`];' }],
                    },
                ],
            },
            "cinematic frame",
        );

        expect(result[0]?.dataUrl).toBe("data:text/plain,16:9");
    });

    test("routes an APIYI Gemini image model through native generateContent", async () => {
        const [{ requestGeneration }, { defaultConfig }] = await Promise.all([import("./image"), import("@/stores/use-config-store")]);
        const post = spyOn(axios, "post").mockResolvedValue({
            data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] } }] },
        });
        const model = "apiyi::gemini-3-pro-image-preview";

        try {
            await requestGeneration(
                {
                    ...defaultConfig,
                    model,
                    imageModel: model,
                    size: "16:9",
                    quality: "high",
                    count: "1",
                    channels: [
                        {
                            id: "apiyi",
                            name: "apiyi",
                            baseUrl: "https://api.apiyi.com/v1",
                            apiKey: "test-key",
                            apiFormat: "openai",
                            models: [{ name: "gemini-3-pro-image-preview", capability: "image" }],
                        },
                    ],
                },
                "cinematic frame",
            );

            expect(post.mock.calls[0]?.[0]).toBe("https://api.apiyi.com/v1beta/models/gemini-3-pro-image-preview:generateContent");
            expect((post.mock.calls[0]?.[1] as any)?.generationConfig).toEqual({
                responseModalities: ["TEXT", "IMAGE"],
                imageConfig: { aspectRatio: "16:9", imageSize: "4K" },
            });
            expect((post.mock.calls[0]?.[2] as any)?.headers).toEqual({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
        } finally {
            post.mockRestore();
        }
    });

    test("sends APIYI Gemini reference images as native inlineData", async () => {
        const [{ requestEdit }, { defaultConfig }] = await Promise.all([import("./image"), import("@/stores/use-config-store")]);
        const post = spyOn(axios, "post").mockResolvedValue({
            data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "cmVzdWx0" } }] } }] },
        });
        const model = "apiyi::gemini-3-pro-image-preview";

        try {
            await requestEdit(
                {
                    ...defaultConfig,
                    model,
                    imageModel: model,
                    size: "16:9",
                    quality: "high",
                    count: "1",
                    channels: [
                        {
                            id: "apiyi",
                            name: "apiyi",
                            baseUrl: "https://api.apiyi.com/v1",
                            apiKey: "test-key",
                            apiFormat: "openai",
                            models: [{ name: "gemini-3-pro-image-preview", capability: "image" }],
                        },
                    ],
                },
                "keep the subject",
                [{ id: "ref-1", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }],
            );

            expect(post.mock.calls[0]?.[0]).toBe("https://api.apiyi.com/v1beta/models/gemini-3-pro-image-preview:generateContent");
            expect((post.mock.calls[0]?.[1] as any)?.contents?.[0]?.parts?.[1]).toEqual({ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } });
            expect((post.mock.calls[0]?.[1] as any)?.generationConfig?.imageConfig).toEqual({ aspectRatio: "16:9", imageSize: "4K" });
        } finally {
            post.mockRestore();
        }
    });
});
