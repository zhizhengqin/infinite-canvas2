import { Form, Radio } from "antd";
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { discoverAgentConfig, type AgentAvailability } from "@/services/api/canvas-agent";
import { useAgentStore, type AgentType } from "@/stores/use-agent-store";

const AGENT_TYPES: AgentType[] = ["codex", "kimi"];

export function ConfigAgent() {
    const { t } = useTranslation();
    const agentType = useAgentStore((state) => state.agentType);
    const setAgentType = useAgentStore((state) => state.setAgentType);
    const connected = useAgentStore((state) => state.connected);
    const url = useAgentStore((state) => state.url);
    const [agents, setAgents] = useState<AgentAvailability[]>([]);
    useEffect(() => {
        let disposed = false;
        void discoverAgentConfig(url).then((config) => {
            if (!disposed) setAgents(config?.agents || []);
        });
        return () => {
            disposed = true;
        };
    }, [url]);

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <Bot className="size-4" />
                    {t("config.agent.title")}
                </div>
                <div className="mt-1 text-xs text-stone-500">{t("config.agent.description")}</div>
                <Radio.Group className="mt-3 flex flex-col gap-2" value={agentType} onChange={(event) => setAgentType(event.target.value as AgentType)}>
                    {AGENT_TYPES.map((type) => {
                        const availability = agents.find((item) => item.type === type);
                        const disabled = Boolean(availability && !availability.available);
                        return (
                            <Radio key={type} value={type} disabled={disabled}>
                                <span>{t(`agent.types.${type}`)}</span>
                                <span className="ml-2 text-xs text-stone-500">{disabled && availability?.reason ? availability.reason : t(`config.agent.hint.${type}`)}</span>
                            </Radio>
                        );
                    })}
                </Radio.Group>
                <div className="mt-3 text-xs text-stone-500">{t("config.agent.connection", { status: t(connected ? "agent.status.connected" : "agent.status.disconnected"), url })}</div>
            </section>
        </Form>
    );
}
