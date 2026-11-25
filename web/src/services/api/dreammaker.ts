import { DEFAULT_LOCAL_PROXY_URL, useConfigStore, type AiConfig } from '@/stores/use-config-store';

export type DreamMakerAccountStatus = { connected: boolean; loggingIn: boolean; account?: string; expiresAt?: number; error?: string };
export function dreamMakerAuthHeaders(config: Pick<AiConfig, 'authMode' | 'baseUrl'>, path: string): Record<string, string> | null {
    if (config.authMode !== 'dreammaker-account') return null;
    const target = new URL(path, config.baseUrl);
    if (target.origin !== 'https://dreammaker.vobilemax.cn' || !target.pathname.startsWith('/api/')) throw new Error('账号登录仅用于DreamMaker官方API');
    return { 'X-Canvas-DreamMaker-Session': 'default' };
}
export async function dreamMakerAccountAction(action: 'status' | 'login' | 'refresh' | 'disconnect'): Promise<DreamMakerAccountStatus> {
    const config = useConfigStore.getState().config;
    if (!config.proxyEnabled) throw new Error('请先开启本地代理，再使用DreamMaker账号登录');
    const base = (config.proxyUrl || DEFAULT_LOCAL_PROXY_URL).replace(/\/+$/, '');
    const host = new URL(base).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('账号会话仅支持本机代理');
    const response = await fetch(`${base}/dreammaker/auth/${action}`, { method: action === 'status' ? 'GET' : 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'DreamMaker账号操作失败');
    return result;
}
