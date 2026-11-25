import axios from "axios";
import { nanoid } from "nanoid";

import { withLocalProxy, type AiConfig } from "@/stores/use-config-store";

type WanliModel = {
    id: string;
    modelVersion: number;
    pricingVersion?: number;
    tokenPricingVersion?: number;
    capabilities?: {
        ratios?: string[];
        resolutions?: string[];
        durations?: number[];
        durationByResolution?: Record<string, number[]>;
    };
    pricing?: {
        videoReferenceTokenPricing?: unknown;
    };
};

export type WanliJob = {
    jobId: string;
    status: string;
    resultUrls?: string[];
    error?: string | { message?: string };
};

type WanliVideoInput = {
    prompt: string;
    ratio: string;
    resolution: string;
    duration: number;
    images: File[];
    videos: File[];
    audios: File[];
    signal?: AbortSignal;
};

function endpoint(config: AiConfig, path: string) {
    return withLocalProxy(`${config.baseUrl.trim().replace(/\/+$/, "")}/api/open/v1${path}`);
}

function headers(config: AiConfig, json = false) {
    return { Authorization: `Bearer ${config.apiKey}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}

function errorMessage(error: unknown) {
    if (axios.isAxiosError(error)) {
        const body = error.response?.data as { error?: string | { message?: string }; message?: string } | undefined;
        if (typeof body?.error === "string") return body.error;
        if (typeof body?.error?.message === "string") return body.error.message;
        if (body?.message) return body.message;
        if (error.response?.status) return `Wanli 请求失败（HTTP ${error.response.status}）`;
    }
    return error instanceof Error ? error.message : "Wanli 请求失败";
}

async function request<T>(config: AiConfig, path: string, method: "GET" | "POST", data?: unknown, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<T> {
    try {
        const response = await axios.request<T>({
            url: endpoint(config, path),
            method,
            data,
            headers: { ...headers(config, data !== undefined && !(data instanceof FormData)), ...extraHeaders },
            signal,
        });
        return response.data;
    } catch (error) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        throw new Error(errorMessage(error));
    }
}

async function uploadAssets(config: AiConfig, files: File[], signal?: AbortSignal) {
    return Promise.all(files.map(async (file) => {
        const form = new FormData();
        form.append("file", file, file.name);
        const asset = await request<{ id: string }>(config, "/assets", "POST", form, signal);
        return asset.id;
    }));
}

export async function createWanliVideo(config: AiConfig, input: WanliVideoInput) {
    const catalog = await request<{ data?: WanliModel[] }>(config, "/models", "GET", undefined, input.signal);
    const model = catalog.data?.find((item) => item.id === config.model);
    if (!model) throw new Error("当前 Wanli 模型目录中没有该视频模型，请重新拉取模型");
    const capabilities = model.capabilities;
    if (capabilities?.ratios?.length && !capabilities.ratios.includes(input.ratio)) throw new Error(`该模型支持的画幅：${capabilities.ratios.join("、")}`);
    if (capabilities?.resolutions?.length && !capabilities.resolutions.includes(input.resolution)) throw new Error(`该模型支持的清晰度：${capabilities.resolutions.join("、")}`);
    const durations = capabilities?.durationByResolution?.[input.resolution] || capabilities?.durations;
    if (durations?.length && !durations.includes(input.duration)) throw new Error(`该模型在当前清晰度下支持 ${durations.join("、")} 秒`);

    const [assetIds, videoAssetIds, audioAssetIds] = await Promise.all([
        uploadAssets(config, input.images, input.signal),
        uploadAssets(config, input.videos, input.signal),
        uploadAssets(config, input.audios, input.signal),
    ]);
    const versions = {
        model: model.id,
        modelVersion: model.modelVersion,
        pricingVersion: model.pricingVersion ?? 0,
        tokenPricingVersion: model.tokenPricingVersion ?? 0,
    };
    if (videoAssetIds.length && model.pricing?.videoReferenceTokenPricing) {
        await request(config, "/video/quote", "POST", {
            ...versions,
            ratio: input.ratio,
            resolution: input.resolution,
            duration: input.duration,
            videoAssetIds,
        }, input.signal);
    }
    const created = await request<WanliJob>(config, "/video/generate", "POST", {
        ...versions,
        prompt: input.prompt,
        ratio: input.ratio,
        resolution: input.resolution,
        duration: input.duration,
        assetIds,
        videoAssetIds,
        audioAssetIds,
    }, input.signal, { "Idempotency-Key": nanoid() });
    if (!created.jobId) throw new Error("Wanli 未返回视频任务 ID");
    return created.jobId;
}

export async function requestWanliImage(config: AiConfig, input: { prompt: string; ratio: string; resolution: string; images: File[]; signal?: AbortSignal }) {
    console.debug("Wanli image request parameters", { model: config.model, ratio: input.ratio, resolution: input.resolution, referenceCount: input.images.length });
    const catalog = await request<{ data?: WanliModel[] }>(config, "/models", "GET", undefined, input.signal);
    const model = catalog.data?.find((item) => item.id === config.model);
    console.debug("Wanli image model matched", model);
    if (!model) throw new Error("当前 Wanli 模型目录中没有该图片模型，请重新拉取模型");
    const capabilities = model.capabilities;
    if (capabilities?.ratios?.length && !capabilities.ratios.includes(input.ratio)) throw new Error(`该模型支持的画幅：${capabilities.ratios.join("、")}`);
    if (capabilities?.resolutions?.length && !capabilities.resolutions.includes(input.resolution)) throw new Error(`该模型支持的清晰度：${capabilities.resolutions.join("、")}`);
    let assetIds: string[];
    try {
        console.debug("Wanli image reference upload start", input.images.map((file) => ({ name: file.name, size: file.size, type: file.type })));
        assetIds = await uploadAssets(config, input.images, input.signal);
        console.debug("Wanli image reference upload complete", assetIds);
    } catch (error) {
        console.error("Wanli image reference upload failed", error);
        throw error;
    }
    const created = await request<WanliJob>(config, "/image/generate", "POST", {
        model: model.id,
        modelVersion: model.modelVersion,
        pricingVersion: model.pricingVersion ?? 0,
        prompt: input.prompt,
        ratio: input.ratio,
        resolution: input.resolution,
        assetIds,
    }, input.signal, { "Idempotency-Key": nanoid() });
    if (!created.jobId) throw new Error("Wanli 未返回图片任务 ID");
    while (true) {
        const state = await queryWanliVideo(config, created.jobId, input.signal);
        if (state.status === "failed") throw new Error(typeof state.error === "string" ? state.error : state.error?.message || "Wanli 图片生成失败");
        if (state.status === "succeeded") return downloadWanliVideo(config, state, input.signal);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 30000);
            input.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
        });
    }
}

export const queryWanliVideo = (config: AiConfig, id: string, signal?: AbortSignal) => request<WanliJob>(config, `/jobs/${encodeURIComponent(id)}`, "GET", undefined, signal);

export async function downloadWanliVideo(config: AiConfig, job: WanliJob, signal?: AbortSignal) {
    const source = job.resultUrls?.[0] || `/jobs/${encodeURIComponent(job.jobId)}/content?download=1`;
    const url = withLocalProxy(new URL(source, `${config.baseUrl.trim().replace(/\/+$/, "")}/`).toString());
    try {
        const response = await axios.get<ArrayBuffer>(url, { headers: headers(config), responseType: "arraybuffer", signal });
        const contentType = response.headers["content-type"];
        return new Blob([response.data], { type: typeof contentType === "string" ? contentType : "video/mp4" });
    } catch (error) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        throw new Error(errorMessage(error));
    }
}
