import { expect, test } from "bun:test";

test("rehydrates Wanli channels with friendly labels instead of falling back to defaults", async () => {
    const channel = {
        id: "wanli",
        name: "Wanli AIGC",
        baseUrl: "https://wanliaigc.com",
        apiKey: "",
        apiFormat: "wanli",
        models: [{ name: "ft-image-v1-186289ba9d3263010c69372f8939dd94", capability: "image" }],
    };
    const persisted = {
        state: {
            config: {
                channels: [channel],
                imageModel: "wanli::ft-image-v1-186289ba9d3263010c69372f8939dd94",
            },
        },
        version: 0,
    };
    const storage = {
        getItem: () => JSON.stringify(persisted),
        setItem: () => undefined,
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });

    const { useConfigStore } = await import("./use-config-store");
    const config = useConfigStore.getState().config;
    expect(config.channels[0].name).toBe("Wanli AIGC");
    expect(config.channels[0].models[0].label).toBe("GPT-image-2.5｜0.5 积分｜1K/2K/4K｜10 图");
    expect(config.imageModel).toBe("wanli::ft-image-v1-186289ba9d3263010c69372f8939dd94");
});
