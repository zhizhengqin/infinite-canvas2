import { expect, test } from "bun:test";

import { createRunningHubVosr2Target, RUNNINGHUB_VOSR2_MODEL_NAME } from "@/services/api/runninghub";
import type { ModelChannel } from "@/stores/use-config-store";

test("lists only video VOSR2 targets from RunningHub channels", async () => {
    installBrowserStorage();
    const { runningHubVosr2ModelValues } = await import("./canvas-video-upscale-dialog");
    const channels: ModelChannel[] = [
        {
            id: "rh",
            name: "RunningHub",
            baseUrl: "https://www.runninghub.ai",
            apiKey: "key",
            apiFormat: "runninghub",
            models: [
                { name: RUNNINGHUB_VOSR2_MODEL_NAME, capability: "video", runningHub: createRunningHubVosr2Target() },
                { name: "VOSR2 image", capability: "image", runningHub: createRunningHubVosr2Target() },
                {
                    name: "Unadjusted VOSR2",
                    capability: "video",
                    runningHub: { ...createRunningHubVosr2Target(), fields: createRunningHubVosr2Target().fields.map((field) => (field.nodeId === "22" ? { ...field, defaultValue: "640" } : field)) },
                },
                { name: "Other video", capability: "video", runningHub: { kind: "workflow", targetId: "123", fields: [] } },
            ],
        },
        {
            id: "openai",
            name: "OpenAI",
            baseUrl: "https://api.openai.com",
            apiKey: "key",
            apiFormat: "openai",
            models: [{ name: "Copied target", capability: "video", runningHub: createRunningHubVosr2Target() }],
        },
    ];

    expect(runningHubVosr2ModelValues(channels)).toEqual([`rh::${RUNNINGHUB_VOSR2_MODEL_NAME}`]);
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
