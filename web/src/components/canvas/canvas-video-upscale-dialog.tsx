import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Modal, Select } from "antd";
import { Settings2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RUNNINGHUB_VOSR2_MODEL_NAME, RUNNINGHUB_VOSR2_WORKFLOW_ID, type RunningHubTarget } from "@/services/api/runninghub";
import { encodeChannelModel, modelOptionLabel, useConfigStore, type ModelChannel } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

function isReadyVosr2Target(target: RunningHubTarget) {
    const fields = target.fields;
    return (
        fields.some((field) => field.nodeId === "18" && field.fieldName === "video" && field.source === "video") &&
        fields.some((field) => field.nodeId === "22" && field.fieldName === "size" && field.source === "constant" && field.defaultValue === "960") &&
        fields.some((field) => field.nodeId === "8" && field.fieldName === "upscale" && field.source === "constant" && field.defaultValue === "2")
    );
}

export function runningHubVosr2ModelValues(channels: ModelChannel[]) {
    return channels.flatMap((channel) =>
        channel.apiFormat === "runninghub"
            ? channel.models.filter((model) => model.capability === "video" && model.runningHub?.targetId === RUNNINGHUB_VOSR2_WORKFLOW_ID && isReadyVosr2Target(model.runningHub)).map((model) => encodeChannelModel(channel.id, model.name))
            : [],
    );
}

export function CanvasVideoUpscaleDialog({ node, open, onClose, onConfirm }: { node: CanvasNodeData | null; open: boolean; onClose: () => void; onConfirm: (model: string) => void }) {
    const { t } = useTranslation();
    const config = useConfigStore((state) => state.config);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const models = useMemo(() => runningHubVosr2ModelValues(config.channels), [config.channels]);
    const [model, setModel] = useState("");
    const ready = Boolean(model && isAiConfigReady(config, model));
    const width = node?.metadata?.naturalWidth;
    const height = node?.metadata?.naturalHeight;

    useEffect(() => {
        if (!open) return;
        setModel(models.find((value) => value.endsWith(`::${RUNNINGHUB_VOSR2_MODEL_NAME}`)) || models[0] || "");
    }, [models, open]);

    const configure = () => {
        onClose();
        openConfigDialog(true);
    };

    return (
        <Modal title={t("canvas.videoUpscale.title")} open={open && Boolean(node)} onCancel={onClose} centered footer={null} destroyOnHidden>
            <div className="space-y-5 py-2">
                <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg border px-3 py-3">
                        <div className="mb-1 text-xs opacity-55">{t("canvas.videoUpscale.source")}</div>
                        <div className="font-medium">{width && height ? `${width} × ${height}` : t("canvas.editors.unknown")}</div>
                    </div>
                    <div className="rounded-lg border px-3 py-3">
                        <div className="mb-1 text-xs opacity-55">{t("canvas.videoUpscale.output")}</div>
                        <div className="font-medium">{t("canvas.videoUpscale.outputValue")}</div>
                        <div className="mt-1 text-xs opacity-55">{t("canvas.videoUpscale.outputHint")}</div>
                    </div>
                </div>
                {models.length ? (
                    <Select
                        className="w-full"
                        value={model || undefined}
                        placeholder={t("canvas.videoUpscale.modelPlaceholder")}
                        options={models.map((value) => ({ value, label: modelOptionLabel(config, value) }))}
                        onChange={setModel}
                    />
                ) : (
                    <Alert type="info" showIcon message={t("canvas.videoUpscale.missingPreset")} description={t("canvas.videoUpscale.missingPresetHint")} />
                )}
                <div className="text-xs leading-5 opacity-55">{t("canvas.videoUpscale.flickerHint")}</div>
                <div className="flex justify-end">
                    {models.length ? (
                        <Button
                            type="primary"
                            icon={ready ? <Sparkles className="size-4" /> : <Settings2 className="size-4" />}
                            disabled={!model}
                            onClick={() => {
                                if (!ready) {
                                    configure();
                                    return;
                                }
                                onConfirm(model);
                            }}
                        >
                            {t(ready ? "canvas.videoUpscale.confirm" : "canvas.videoUpscale.configure")}
                        </Button>
                    ) : (
                        <Button type="primary" icon={<Settings2 className="size-4" />} onClick={configure}>
                            {t("canvas.videoUpscale.configure")}
                        </Button>
                    )}
                </div>
            </div>
        </Modal>
    );
}
