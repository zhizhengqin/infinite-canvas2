import { mkdir, chmod, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const API_ORIGIN = 'https://dreammaker.vobilemax.cn';
const TOKEN_ENDPOINT = 'https://auth.vobilemax.cn/api/auth/oauth/token';
const decode = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
export function isDreamMakerApiTarget(target) {
  try { const url = new URL(target); return url.origin === API_ORIGIN && url.pathname.startsWith('/api/'); } catch { return false; }
}

export class DreamMakerSession {
  constructor({ directory = join(homedir(), '.infinite-canvas', 'dreammaker-account'), request = fetch, now = Date.now, launchBrowser } = {}) {
    this.directory = directory;
    this.request = request;
    this.now = now;
    this.launchBrowser = launchBrowser;
    this.pending = null;
    this.loginPending = null;
    this.session = undefined;
    this.error = '';
  }
  async key() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const path = join(this.directory, 'vault.key');
    try { return await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const key = randomBytes(32);
    try { await writeFile(path, key, { mode: 0o600, flag: 'wx' }); return key; }
    catch (error) { if (error.code === 'EEXIST') return readFile(path); throw error; }
  }
  async load() {
    if (this.session !== undefined) return this.session;
    let text;
    try { text = await readFile(join(this.directory, 'session.enc'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return this.session = null; throw error; }
    const record = JSON.parse(text);
    const cipher = createDecipheriv('aes-256-gcm', await this.key(), Buffer.from(record.iv, 'base64'));
    cipher.setAAD(Buffer.from('infinite-canvas-dreammaker-v1'));
    cipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    this.session = JSON.parse(Buffer.concat([cipher.update(Buffer.from(record.data, 'base64')), cipher.final()]).toString());
    return this.session;
  }
  async saveSession(payload, allowAccountSwitch = false) {
    if (typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string' || !payload.refresh_token) throw Error('登录响应缺少可续期会话，请重新登录');
    const claims = decode(payload.access_token);
    if (!claims.sub || !Number.isFinite(claims.exp)) throw Error('登录响应不完整，请重新登录');
    const old = await this.load();
    if (!allowAccountSwitch && old && old.sub !== claims.sub) throw Error('续期账号不一致，请重新登录');
    const next = { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: claims.exp * 1000, sub: claims.sub, authCookie: payload.auth_cookie || old?.authCookie };
    const iv = randomBytes(12);
    const encryption = createCipheriv('aes-256-gcm', await this.key(), iv);
    encryption.setAAD(Buffer.from('infinite-canvas-dreammaker-v1'));
    const data = Buffer.concat([encryption.update(JSON.stringify(next)), encryption.final()]);
    const path = join(this.directory, 'session.enc');
    await writeFile(path + '.tmp', JSON.stringify({ iv: iv.toString('base64'), tag: encryption.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
    await rename(path + '.tmp', path);
    this.session = next;
    this.error = '';
  }
  async matchesAuthorization(authorization) {
    const session = await this.load();
    if (!session || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
    try { return String(decode(authorization.slice(7)).sub) === String(session.sub); } catch { return false; }
  }
  async status() {
    const session = await this.load();
    return { connected: Boolean(session?.refreshToken), loggingIn: Boolean(this.loginPending), expiresAt: session?.expiresAt, account: session?.sub, error: this.error || undefined };
  }
  async clear() {
    this.session = null;
    try { await unlink(join(this.directory, 'session.enc')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async accessToken(force = false) {
    const session = await this.load();
    if (!session) throw Error('DreamMaker账号未连接，请在渠道配置中登录');
    if (!force && session.expiresAt > this.now()) return session.accessToken;
    if (!this.pending) this.pending = this.refresh(session).finally(() => { this.pending = null; });
    return this.pending;
  }
  async refresh(session) {
    const response = await this.request(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session.authCookie ? { Cookie: '__Host-auth_session=' + session.authCookie } : {}) }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: 'dreamstudio', token_format: 'v2' }) });
    if (!response.ok) {
      let failure;
      try { failure = await response.json(); } catch {}
      const code = (typeof failure?.error === 'string' ? failure.error : typeof failure?.detail?.code === 'string' ? failure.detail.code : 'authentication_error') + (typeof failure?.error_reason === 'string' ? ':' + failure.error_reason : '');
      if (response.status === 400 || response.status === 401) await this.clear();
      this.error = `DreamMaker会话续期失败（HTTP ${response.status}，${code}），请重新登录；已有视频任务不会重新提交`;
      throw Error(this.error);
    }
    if (await this.load() !== session) return this.accessToken();
    await this.saveSession(await response.json());
    return this.session.accessToken;
  }
  login() {
    if (this.loginPending) return this.loginPending;
    this.loginPending = this.openLogin().finally(() => { this.loginPending = null; });
    return this.loginPending;
  }
  async openLogin() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const launch = this.launchBrowser || (async directory => {
      const { chromium } = await import('playwright-core');
      return chromium.launchPersistentContext(directory, { channel: 'chrome', headless: false, chromiumSandbox: true, ignoreDefaultArgs: ["--disable-client-side-phishing-detection"] });
    });
    const browser = await launch(join(this.directory, 'login-browser'));
    this.browser = browser;
    try {
      let inspectStored;
      const authenticated = new Promise((resolve, reject) => {
        let accepting = false;
        browser.on('close', () => reject(Error('登录窗口已关闭，账号尚未连接')));
        const accept = async payload => {
          if (accepting || !payload.access_token || !payload.refresh_token) return;
          accepting = true;
          try {
            const check = await this.request(API_ORIGIN + '/api/account/status', { headers: { Authorization: 'Bearer ' + payload.access_token } });
            if (!check.ok) { accepting = false; return; }
            const cookies = browser.cookies ? await browser.cookies(TOKEN_ENDPOINT) : [];
            const authCookie = cookies.find(cookie => cookie.name === '__Host-auth_session')?.value;
            await this.saveSession({ ...payload, auth_cookie: authCookie }, true);
            resolve();
          } catch (error) { reject(error); }
        };
        inspectStored = async () => {
          if (accepting || !browser.storageState) return;
          try {
            const state = await browser.storageState();
            const entry = state.origins.find(origin => origin.origin === API_ORIGIN)?.localStorage.find(item => item.name === 'auth_tokens_v2');
            if (!entry) return;
            const tokens = JSON.parse(entry.value);
            await accept({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken });
          } catch { /* The official page may still be completing login. */ }
        };
        browser.on('response', async response => {
          if (response.url() !== TOKEN_ENDPOINT || !response.ok()) return;
          try { await accept(await response.json()); } catch { /* Ignore non-token responses. */ }
        });
      });
      const page = browser.pages()[0] || await browser.newPage();
      page.on?.('domcontentloaded', () => { void inspectStored(); });
      await page.goto(API_ORIGIN + '/project');
      await inspectStored();
      await authenticated;
      return await this.status();
    } finally {
      this.browser = null;
      await browser.close();
    }
  }
}
