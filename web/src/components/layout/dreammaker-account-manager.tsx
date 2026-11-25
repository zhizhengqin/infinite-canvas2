import { Button, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { dreamMakerAccountAction, type DreamMakerAccountStatus } from '@/services/api/dreammaker';

export function DreamMakerAccountManager() {
    const [status, setStatus] = useState<DreamMakerAccountStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => { let active = true; dreamMakerAccountAction('status').then(value => { if (active) setStatus(value); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
    const act = async (action: 'login' | 'refresh' | 'disconnect') => {
        setBusy(true); setError('');
        try { setStatus(await dreamMakerAccountAction(action)); }
        catch (e) { setError(e instanceof Error ? e.message : '账号操作失败'); }
        finally { setBusy(false); }
    };
    return <div className="space-y-3">
        <Typography.Paragraph type="secondary">在官方窗口输入账号密码并完成验证。登录后自动续期，密码不会保存到画布；账号会话只保存在本机代理中，不随渠道配置导出。</Typography.Paragraph>
        <div>{status?.connected ? `已连接账号 ${status.account} · 自动续期` : '尚未连接账号'}</div>
        {busy ? <Typography.Text type="secondary">正在处理；如已打开官方登录窗口，请在那里完成登录。</Typography.Text> : null}
        <Space wrap>
            <Button loading={busy} onClick={() => act('login')}>{status?.connected ? '重新登录账号' : '登录DreamMaker账号'}</Button>
            {status?.connected ? <>
                <Button disabled={busy} onClick={() => act('refresh')}>验证自动续期</Button>
                <Button type="text" disabled={busy} onClick={() => act('disconnect')}>断开连接</Button>
            </> : null}
        </Space>
        {error ? <Typography.Paragraph type="danger">{error}</Typography.Paragraph> : null}
    </div>;
}
