import { App, Button, Input, InputNumber, Segmented, Select } from "antd";
import { Download, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchRunningHubTarget, validateRunningHubImportInput, type RunningHubField, type RunningHubFieldSource, type RunningHubTargetKind } from "@/services/api/runninghub";
import { useConfigStore, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

export function RunningHubTargetManager({ channel, onModelsChange }: { channel: ModelChannel; onModelsChange: (models: ChannelModel[]) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const proxyEnabled = useConfigStore((state) => state.config.proxyEnabled);
    const proxyUrl = useConfigStore((state) => state.config.proxyUrl);
    const [input, setInput] = useState("");
    const [name, setName] = useState("");
    const [kind, setKind] = useState<RunningHubTargetKind>("workflow");
    const [capability, setCapability] = useState<"image" | "video">("image");
    const [loading, setLoading] = useState(false);

    const importTarget = async () => {
        try {
            const validated = validateRunningHubImportInput({ apiKey: channel.apiKey, input, explicitKind: kind, name, existingNames: channel.models.map((model) => model.name) });
            setLoading(true);
            const imported = await fetchRunningHubTarget({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, proxyEnabled, proxyUrl }, validated.kind, validated.targetId);
            onModelsChange([...channel.models, { name: validated.name || imported.name, capability, runningHub: imported.target }]);
            setInput("");
            setName("");
            message.success(t("config.channelEditor.runningHub.imported", { count: imported.target.fields.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.channelEditor.runningHub.importFailed"));
        } finally {
            setLoading(false);
        }
    };

    const updateModel = (index: number, patch: Partial<ChannelModel>) => onModelsChange(channel.models.map((model, itemIndex) => (index === itemIndex ? { ...model, ...patch } : model)));
    const updateField = (modelIndex: number, fieldIndex: number, patch: Partial<RunningHubField>) => {
        const model = channel.models[modelIndex];
        if (!model.runningHub) return;
        updateModel(modelIndex, { runningHub: { ...model.runningHub, fields: model.runningHub.fields.map((field, itemIndex) => (fieldIndex === itemIndex ? { ...field, ...patch } : field)) } });
    };

    return (
        <div className="mt-6 space-y-4">
            <div>
                <div className="text-sm font-semibold">{t("config.channelEditor.runningHub.title")}</div>
                <div className="mt-1 text-xs text-stone-500">{t("config.channelEditor.runningHub.description")}</div>
            </div>

            <div className="grid gap-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800 md:grid-cols-2">
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-xs text-stone-500">{t("config.channelEditor.runningHub.link")}</span>
                    <Input value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("config.channelEditor.runningHub.linkPlaceholder")} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-xs text-stone-500">{t("config.channelEditor.runningHub.itemName")}</span>
                    <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("config.channelEditor.runningHub.itemNamePlaceholder")} />
                </label>
                <div>
                    <span className="mb-1 block text-xs text-stone-500">{t("config.channelEditor.runningHub.kind")}</span>
                    <Segmented
                        block
                        value={kind}
                        options={[
                            { label: t("config.channelEditor.runningHub.workflow"), value: "workflow" },
                            { label: t("config.channelEditor.runningHub.app"), value: "app" },
                        ]}
                        onChange={(value) => setKind(value as RunningHubTargetKind)}
                    />
                </div>
                <div>
                    <span className="mb-1 block text-xs text-stone-500">{t("config.channelEditor.runningHub.capability")}</span>
                    <Segmented
                        block
                        value={capability}
                        options={[
                            { label: t("config.channelEditor.capabilities.image"), value: "image" },
                            { label: t("config.channelEditor.capabilities.video"), value: "video" },
                        ]}
                        onChange={(value) => setCapability(value as "image" | "video")}
                    />
                </div>
                <div className="flex items-end">
                    <Button className="w-full" type="primary" icon={<Download className="size-4" />} loading={loading} onClick={() => void importTarget()}>
                        {t("config.channelEditor.runningHub.import")}
                    </Button>
                </div>
            </div>

            {channel.models.length ? (
                <div className="space-y-3">
                    {channel.models.map((model, modelIndex) => (
                        <div key={`${model.runningHub?.kind}-${model.runningHub?.targetId}-${modelIndex}`} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="flex flex-wrap items-center gap-2">
                                <Input className="min-w-48 flex-1" value={model.name} onChange={(event) => updateModel(modelIndex, { name: event.target.value })} />
                                <Segmented
                                    size="small"
                                    value={model.capability}
                                    options={[
                                        { label: t("config.channelEditor.capabilities.image"), value: "image" },
                                        { label: t("config.channelEditor.capabilities.video"), value: "video" },
                                    ]}
                                    onChange={(value) => updateModel(modelIndex, { capability: value as "image" | "video" })}
                                />
                                <span className="text-xs text-stone-500">
                                    {model.runningHub?.kind === "workflow" ? t("config.channelEditor.runningHub.workflow") : t("config.channelEditor.runningHub.app")} · {model.runningHub?.targetId}
                                </span>
                                {model.runningHub?.kind === "workflow" && (
                                    <Select
                                        size="small"
                                        value={model.runningHub.instanceType || "default"}
                                        options={[
                                            { label: t("config.channelEditor.runningHub.instanceDefault"), value: "default" },
                                            { label: t("config.channelEditor.runningHub.instancePlus"), value: "plus" },
                                            { label: t("config.channelEditor.runningHub.instanceUltra"), value: "ultra" },
                                        ]}
                                        onChange={(instanceType) => updateModel(modelIndex, { runningHub: { ...model.runningHub!, instanceType: instanceType as "default" | "plus" | "ultra" } })}
                                    />
                                )}
                                <Button danger type="text" icon={<Trash2 className="size-4" />} onClick={() => onModelsChange(channel.models.filter((_, index) => index !== modelIndex))} />
                            </div>
                            <div className="mt-3 space-y-2">
                                {model.runningHub?.fields.map((field, fieldIndex) => (
                                    <div key={`${field.nodeId}-${field.fieldName}`} className="grid items-center gap-2 rounded-md bg-stone-50/70 px-2 py-2 dark:bg-stone-900/40 md:grid-cols-[minmax(150px,1fr)_150px_minmax(120px,1fr)]">
                                        <div className="min-w-0">
                                            <div className="truncate text-xs font-medium" title={field.label}>
                                                {field.label}
                                            </div>
                                            <div className="truncate text-[11px] text-stone-500">
                                                {field.nodeId}.{field.fieldName} · {field.fieldType}
                                            </div>
                                        </div>
                                        <Select
                                            size="small"
                                            value={field.source}
                                            options={fieldSourceOptions(t)}
                                            onChange={(source) => updateField(modelIndex, fieldIndex, { source, ...(isMediaSource(source) ? { sourceIndex: field.sourceIndex || 0 } : {}) })}
                                        />
                                        {field.source === "constant" ? (
                                            field.options?.length ? (
                                                <Select
                                                    size="small"
                                                    value={field.defaultValue || undefined}
                                                    options={field.options.map((value) => ({ label: value, value }))}
                                                    onChange={(defaultValue) => updateField(modelIndex, fieldIndex, { defaultValue })}
                                                />
                                            ) : (
                                                <Input size="small" value={field.defaultValue} onChange={(event) => updateField(modelIndex, fieldIndex, { defaultValue: event.target.value })} />
                                            )
                                        ) : isMediaSource(field.source) ? (
                                            <InputNumber
                                                size="small"
                                                className="w-full"
                                                min={1}
                                                precision={0}
                                                value={(field.sourceIndex || 0) + 1}
                                                addonBefore={t("config.channelEditor.runningHub.mediaIndex")}
                                                onChange={(value) => updateField(modelIndex, fieldIndex, { sourceIndex: Math.max(0, Number(value || 1) - 1) })}
                                            />
                                        ) : (
                                            <span className="text-xs text-stone-500">{t("config.channelEditor.runningHub.runtimeValue")}</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="rounded-lg border border-dashed border-stone-300 px-3 py-8 text-center text-sm text-stone-500 dark:border-stone-700">{t("config.channelEditor.runningHub.empty")}</div>
            )}
        </div>
    );
}

function isMediaSource(source: RunningHubFieldSource) {
    return source === "image" || source === "video" || source === "audio";
}

function fieldSourceOptions(t: ReturnType<typeof useTranslation>["t"]): Array<{ label: string; value: RunningHubFieldSource }> {
    return (["prompt", "image", "video", "audio", "duration", "ratio", "resolution", "generateAudio", "watermark", "constant"] as RunningHubFieldSource[]).map((value) => ({
        label: t(`config.channelEditor.runningHub.sources.${value}`),
        value,
    }));
}
