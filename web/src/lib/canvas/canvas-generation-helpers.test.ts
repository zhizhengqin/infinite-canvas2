import { expect, test } from "bun:test";

test("keeps RunningHub as the provider when a canvas video task is resumed", async () => {
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 },
    });
    const helpers = (await import("./canvas-generation-helpers")) as typeof import("./canvas-generation-helpers") & {
        resumableVideoTask: (id: string, provider: "openai" | "gemini" | "runninghub", model: string) => { id: string; provider: string; model: string };
    };

    expect(typeof helpers.resumableVideoTask).toBe("function");
    expect(helpers.resumableVideoTask("rh-task-1", "runninghub", "minimax-h3")).toEqual({ id: "rh-task-1", provider: "runninghub", model: "minimax-h3" });
});
