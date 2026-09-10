export type RunningHubTargetKind = "workflow" | "app";
export type RunningHubCapability = "image" | "video";
export type RunningHubFieldSource = "prompt" | "image" | "video" | "audio" | "duration" | "ratio" | "resolution" | "generateAudio" | "watermark" | "constant";
export type RunningHubFieldType = "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT" | "IMAGE" | "VIDEO" | "AUDIO";

export type RunningHubField = {
    nodeId: string;
    fieldName: string;
    fieldType: RunningHubFieldType;
    label: string;
    defaultValue: string;
    source: RunningHubFieldSource;
    sourceIndex?: number;
    required: boolean;
    options?: string[];
};

export type RunningHubTarget = {
    kind: RunningHubTargetKind;
    targetId: string;
    fields: RunningHubField[];
};

export type RunningHubGenerationInputs = {
    prompt: string;
    images?: string[];
    videos?: string[];
    audios?: string[];
    duration?: string;
    ratio?: string;
    resolution?: string;
    generateAudio?: boolean;
    watermark?: boolean;
};

export type RunningHubNodeInfo = { nodeId: string; fieldName: string; fieldValue: string | number | boolean };
export type RunningHubTaskState = { status: "pending" } | { status: "completed"; urls: string[] } | { status: "failed"; error: string };

type UnknownRecord = Record<string, unknown>;

export function parseRunningHubTargetInput(input: string, explicitKind?: RunningHubTargetKind) {
    const value = input.trim();
    if (/^\d+$/.test(value)) {
        if (!explicitKind) throw new Error("请选择工作流或 AI 应用类型");
        return { kind: explicitKind, targetId: value };
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("请输入有效的 RunningHub 链接或数字 ID");
    }
    if (url.hostname !== "runninghub.cn" && url.hostname !== "www.runninghub.cn") throw new Error("只支持 RunningHub 官方链接");
    const match = url.pathname.match(/^\/(workflow|ai-detail)\/(\d+)(?:\/|$)/);
    if (!match) throw new Error("无法识别 RunningHub 链接中的目标 ID");
    return { kind: match[1] === "workflow" ? ("workflow" as const) : ("app" as const), targetId: match[2] };
}

export function normalizeRunningHubFields(payload: unknown): RunningHubField[] {
    const data = unwrapPayload(payload);
    const appFields = Array.isArray(data.nodeInfoList) ? data.nodeInfoList : null;
    const rawFields = appFields || workflowFields(data.prompt);
    const sourceCounts = new Map<RunningHubFieldSource, number>();
    return rawFields.flatMap((raw) => {
        if (!isRecord(raw)) return [];
        const nodeId = stringValue(raw.nodeId);
        const fieldName = stringValue(raw.fieldName);
        if (!nodeId || !fieldName) return [];
        const options = fieldOptions(raw.fieldData);
        const fieldType = normalizeFieldType(stringValue(raw.fieldType), fieldName, options);
        const source = defaultFieldSource(fieldName, fieldType);
        const index = source === "image" || source === "video" || source === "audio" ? sourceCounts.get(source) || 0 : undefined;
        if (index !== undefined) sourceCounts.set(source, index + 1);
        return [
            {
                nodeId,
                fieldName,
                fieldType,
                label: stringValue(raw.description) || stringValue(raw.label) || fieldName,
                defaultValue: scalarString(raw.fieldValue),
                source,
                ...(index !== undefined ? { sourceIndex: index } : {}),
                required: raw.required === true,
                ...(options.length ? { options } : {}),
            },
        ];
    });
}

export function buildRunningHubNodeInfoList(fields: RunningHubField[], inputs: RunningHubGenerationInputs): RunningHubNodeInfo[] {
    return fields.flatMap((field) => {
        const value = fieldValue(field, inputs);
        if (value === undefined || value === "") {
            if (field.required) throw new Error(`缺少必填字段：${field.label}`);
            return [];
        }
        return [{ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue: typedFieldValue(field.fieldType, value) }];
    });
}

export function normalizeRunningHubTaskResponse(payload: unknown, capability: RunningHubCapability): RunningHubTaskState {
    const record = unwrapQueryPayload(payload);
    const status = stringValue(record.status || record.taskStatus).toUpperCase();
    if (["FAILED", "FAIL", "CANCELLED", "CANCELED"].includes(status)) {
        return { status: "failed", error: stringValue(record.errorMessage || record.failedReason || record.msg) || "RunningHub 任务失败" };
    }
    if (!["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status)) return { status: "pending" };
    const urls = (Array.isArray(record.results) ? record.results : [])
        .flatMap((item) => {
            if (!isRecord(item)) return [];
            const url = stringValue(item.url || item.fileUrl || item.download_url);
            const outputType = stringValue(item.outputType || item.fileType || item.type).toLowerCase();
            return url && mediaMatches(url, outputType, capability) ? [url] : [];
        });
    if (!urls.length) return { status: "failed", error: `任务成功但没有返回${capability === "image" ? "图片" : "视频"}` };
    return { status: "completed", urls: capability === "video" ? urls.slice(0, 1) : urls };
}

function unwrapPayload(payload: unknown): UnknownRecord {
    if (!isRecord(payload)) throw new Error("RunningHub 元数据格式无效");
    if (payload.code !== undefined && payload.code !== 0 && payload.code !== "0") throw new Error(stringValue(payload.msg || payload.message) || "RunningHub 请求失败");
    return isRecord(payload.data) ? payload.data : payload;
}

function unwrapQueryPayload(payload: unknown): UnknownRecord {
    if (!isRecord(payload)) return {};
    if (payload.code !== undefined && payload.code !== 0 && payload.code !== "0") return { status: "FAILED", errorMessage: stringValue(payload.msg || payload.message) };
    return isRecord(payload.data) ? payload.data : payload;
}

function workflowFields(value: unknown): UnknownRecord[] {
    let prompt: unknown = value;
    if (typeof prompt === "string") {
        try {
            prompt = JSON.parse(prompt);
        } catch {
            throw new Error("RunningHub 工作流 JSON 格式无效");
        }
    }
    if (!isRecord(prompt)) return [];
    return Object.entries(prompt).flatMap(([nodeId, node]) => {
        if (!isRecord(node) || !isRecord(node.inputs)) return [];
        const title = isRecord(node._meta) ? stringValue(node._meta.title) : "";
        const classType = stringValue(node.class_type);
        return Object.entries(node.inputs).flatMap(([fieldName, fieldValue]) => {
            if (!isPrimitive(fieldValue)) return [];
            return [{ nodeId, fieldName, fieldValue, fieldType: primitiveType(fieldValue), description: title ? `${title} · ${fieldName}` : `${classType || nodeId} · ${fieldName}` }];
        });
    });
}

function fieldOptions(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return [];
        return Array.from(new Set(parsed.flatMap((item) => (isRecord(item) ? [stringValue(item.index || item.name)] : [])).filter(Boolean)));
    } catch {
        return [];
    }
}

function normalizeFieldType(rawType: string, fieldName: string, options: string[]): RunningHubFieldType {
    const type = rawType.toUpperCase();
    const name = fieldName.toLowerCase();
    if (options.length > 1) return "SELECT";
    if (type.includes("IMAGE") || /image|photo|frame|mask/.test(name)) return "IMAGE";
    if (type.includes("VIDEO") || /video/.test(name)) return "VIDEO";
    if (type.includes("AUDIO") || /audio|voice|sound/.test(name)) return "AUDIO";
    if (type.includes("BOOL")) return "BOOLEAN";
    if (/INT|FLOAT|DOUBLE|NUMBER/.test(type)) return "NUMBER";
    return "TEXT";
}

function defaultFieldSource(fieldName: string, fieldType: RunningHubFieldType): RunningHubFieldSource {
    const name = fieldName.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (fieldType === "IMAGE") return "image";
    if (fieldType === "VIDEO") return "video";
    if (fieldType === "AUDIO") return "audio";
    if (/^(prompt|text|positive|positiveprompt)$/.test(name)) return "prompt";
    if (/duration|seconds/.test(name)) return "duration";
    if (/aspectratio|ratio/.test(name)) return "ratio";
    if (/resolution|quality/.test(name)) return "resolution";
    if (/generateaudio|withaudio/.test(name)) return "generateAudio";
    if (/watermark/.test(name)) return "watermark";
    return "constant";
}

function fieldValue(field: RunningHubField, inputs: RunningHubGenerationInputs) {
    if (field.source === "constant") return field.defaultValue;
    if (field.source === "prompt") return inputs.prompt;
    if (field.source === "image") return inputs.images?.[field.sourceIndex || 0];
    if (field.source === "video") return inputs.videos?.[field.sourceIndex || 0];
    if (field.source === "audio") return inputs.audios?.[field.sourceIndex || 0];
    if (field.source === "duration") return inputs.duration;
    if (field.source === "ratio") return inputs.ratio;
    if (field.source === "resolution") return inputs.resolution;
    if (field.source === "generateAudio") return inputs.generateAudio;
    return inputs.watermark;
}

function typedFieldValue(type: RunningHubFieldType, value: string | boolean) {
    if (type === "NUMBER") {
        const number = Number(value);
        return Number.isFinite(number) ? number : value;
    }
    if (type === "BOOLEAN") return typeof value === "boolean" ? value : value === "true";
    return value;
}

function mediaMatches(url: string, outputType: string, capability: RunningHubCapability) {
    const value = `${outputType} ${url.split(/[?#]/)[0]}`.toLowerCase();
    return capability === "video" ? /(?:mp4|mov|webm|mkv)/.test(value) : /(?:png|jpe?g|webp|gif|bmp)/.test(value);
}

function primitiveType(value: string | number | boolean) {
    if (typeof value === "number") return "NUMBER";
    if (typeof value === "boolean") return "BOOLEAN";
    return "STRING";
}

function isPrimitive(value: unknown): value is string | number | boolean {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function scalarString(value: unknown) {
    return isPrimitive(value) ? String(value) : "";
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is UnknownRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
