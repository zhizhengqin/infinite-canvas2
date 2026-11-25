import { expect, test } from "bun:test";
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
const { buildNodeGenerationContext } = await import("./canvas-node-generation");
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata });

test("submits actual text with all three image attachments instead of resource labels", () => {
    const prompt = "30秒，小猫起身伸懒腰，再走向窗边。\n保持参考图中的毛色。";
    const composer = "@[node:text]\n@[node:image1]\n@[node:image2]\n@[node:image3]";
    const nodes = [node("config", CanvasNodeType.Config, { composerContent: composer }), node("text", CanvasNodeType.Text, { content: prompt }), ...[1, 2, 3].map((i) => node(`image${i}`, CanvasNodeType.Image, { content: `blob:reference-${i}`, storageKey: `image:reference-${i}` }))];
    const context = buildNodeGenerationContext("config", nodes, nodes.filter((item) => item.id !== "config").map((item) => ({ id: `edge-${item.id}`, fromNodeId: item.id, toNodeId: "config" })), composer);
    expect(context.prompt).toBe(prompt);
    expect(context.referenceImages.map((image) => image.storageKey)).toEqual(["image:reference-1", "image:reference-2", "image:reference-3"]);
    expect(context.imageCount).toBe(3);
});

test("still expands a standalone text reference without labels", () => {
    const composer = "@[node:text]";
    const nodes = [node("config", CanvasNodeType.Config, { composerContent: composer }), node("text", CanvasNodeType.Text, { content: "小猫回头。" })];
    expect(buildNodeGenerationContext("config", nodes, nodes.filter((item) => item.id !== "config").map((item) => ({ id: `edge-${item.id}`, fromNodeId: item.id, toNodeId: "config" })), composer).prompt).toBe("小猫回头。");
});
