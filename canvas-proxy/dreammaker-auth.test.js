import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DreamMakerSession, isDreamMakerApiTarget } from './dreammaker-auth.js';

const jwt = (exp, sub = 'account') => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp, sub })).toString('base64url')}.signature`;
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-dm-auth-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test('expired access token is refreshed once for concurrent requests, rotated session survives restart', () => fixture(async directory => {
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(url, 'https://auth.vobilemax.cn/api/auth/oauth/token');
    assert.deepEqual(JSON.parse(options.body), { grant_type: 'refresh_token', refresh_token: 'refresh-old', client_id: 'dreamstudio', token_format: 'v2' });
    return new Response(JSON.stringify({ access_token: jwt(200), refresh_token: 'refresh-new' }));
  };
  const session = new DreamMakerSession({ directory, request, now: () => 100000 });
  await session.saveSession({ access_token: jwt(99), refresh_token: 'refresh-old' });
  assert.deepEqual(await Promise.all([session.accessToken(), session.accessToken()]), [jwt(200), jwt(200)]);
  assert.equal(calls, 1);
  const restarted = new DreamMakerSession({ directory, now: () => 100000, request: () => { throw Error('must not refresh valid token'); } });
  assert.equal(await restarted.accessToken(), jwt(200));
  const disk = await readFile(join(directory, 'session.enc'), 'utf8');
  assert.ok(!disk.includes('refresh-new'));
  assert.ok(!JSON.stringify(await session.status()).includes('refresh-new'));
}));
test('valid token makes no refresh request', () => fixture(async directory => {
  const s = new DreamMakerSession({ directory, now: () => 1000, request: () => { throw Error('unexpected refresh'); } });
  await s.saveSession({ access_token: jwt(200), refresh_token: 'refresh' });
  assert.equal(await s.accessToken(), jwt(200));
}));
test('rejected refresh requires login and does not retry or recreate video tasks', () => fixture(async directory => {
  let calls = 0;
  const s = new DreamMakerSession({ directory, now: () => 100000, request: async () => { calls++; return new Response('{}', { status: 400 }); } });
  await s.saveSession({ access_token: jwt(99), refresh_token: 'refresh' });
  await assert.rejects(s.accessToken(), /重新登录/);
  assert.equal(calls, 1);
  assert.equal((await s.status()).connected, false);
}));
test('refresh cannot silently switch account', () => fixture(async directory => {
  const s = new DreamMakerSession({ directory, now: () => 100000, request: async () => new Response(JSON.stringify({ access_token: jwt(200, 'other'), refresh_token: 'other-refresh' })) });
  await s.saveSession({ access_token: jwt(99), refresh_token: 'refresh' });
  await assert.rejects(s.accessToken(), /账号/);
}));
test('only the exact DreamMaker HTTPS API receives account authorization', () => {
  assert.equal(isDreamMakerApiTarget('https://dreammaker.vobilemax.cn/api/canvas/tasks/batch'), true);
  for (const url of ['http://dreammaker.vobilemax.cn/api/a', 'https://dreammaker.vobilemax.cn.evil.test/api/a', 'https://other.test/api/a', 'https://dreammaker.vobilemax.cn/show']) assert.equal(isDreamMakerApiTarget(url), false);
});
test('existing canvas credential selects only the same connected account, without trusting another account', () => fixture(async directory => {
  const s = new DreamMakerSession({ directory });
  await s.saveSession({ access_token: jwt(1), refresh_token: 'refresh' });
  assert.equal(await s.matchesAuthorization('Bearer ' + jwt(0)), true);
  assert.equal(await s.matchesAuthorization('Bearer ' + jwt(0, 'other')), false);
  assert.equal(await s.matchesAuthorization('Bearer malformed'), false);
}));
test('manual official login captures a renewable session and closes only its dedicated browser', () => fixture(async directory => {
  const { EventEmitter } = await import('node:events');
  const browser = new EventEmitter();
  let closed = false;
  browser.close = async () => { closed = true; browser.emit('close'); };
  browser.pages = () => [{ goto: async url => {
    assert.equal(url, 'https://dreammaker.vobilemax.cn/project');
    browser.emit('response', { url: () => 'https://auth.vobilemax.cn/api/auth/oauth/token', ok: () => true, json: async () => ({ access_token: jwt(200), refresh_token: 'manual-refresh' }) });
  } }];
  const s = new DreamMakerSession({ directory, now: () => 1000, launchBrowser: async path => { assert.ok(path.startsWith(directory)); return browser; }, request: async url => { assert.equal(url, 'https://dreammaker.vobilemax.cn/api/account/status'); return new Response('{}'); } });
  assert.equal((await s.login()).connected, true);
  assert.equal(closed, true);
  assert.equal(await s.accessToken(), jwt(200));
}));
test('disconnect during renewal cannot resurrect the account session', () => fixture(async directory => {
  let deliver;
  const s = new DreamMakerSession({ directory, now: () => 100000, request: () => new Promise(resolve => { deliver = resolve; }) });
  await s.saveSession({ access_token: jwt(99), refresh_token: 'refresh' });
  const pending = s.accessToken();
  while (!deliver) await new Promise(resolve => setImmediate(resolve));
  await s.clear();
  deliver(new Response(JSON.stringify({ access_token: jwt(200), refresh_token: 'new' })));
  await assert.rejects(pending, /未连接/);
  assert.equal((await s.status()).connected, false);
}));
test('renewal carries the official HttpOnly central-session cookie required by browser v2 sessions', () => fixture(async directory => {
  let seen;
  const s = new DreamMakerSession({ directory, now: () => 100000, request: async (_url, options) => { seen = options.headers.Cookie; return new Response(JSON.stringify({ access_token: jwt(200), refresh_token: 'rotated' })); } });
  await s.saveSession({ access_token: jwt(99), refresh_token: 'refresh', auth_cookie: 'central-session' });
  await s.accessToken();
  assert.equal(seen, '__Host-auth_session=central-session');
}));
test('reconnect reuses its own logged-in profile and captures the HttpOnly cookie without re-entering a password', () => fixture(async directory => {
  const { EventEmitter } = await import('node:events');
  const browser = new EventEmitter();
  browser.pages = () => [{ goto: async () => {} }];
  browser.close = async () => browser.emit('close');
  browser.storageState = async () => ({ origins: [{ origin: 'https://dreammaker.vobilemax.cn', localStorage: [{ name: 'auth_tokens_v2', value: JSON.stringify({ accessToken: jwt(200), refreshToken: 'cached-refresh' }) }] }] });
  browser.cookies = async () => [{ name: '__Host-auth_session', value: 'cached-cookie' }];
  let cookie;
  const s = new DreamMakerSession({ directory, now: () => 1000, launchBrowser: async () => browser, request: async (url, options) => {
    if (url.endsWith('/api/account/status')) return new Response('{}');
    cookie = options.headers.Cookie;
    return new Response(JSON.stringify({ access_token: jwt(300), refresh_token: 'rotated' }));
  } });
  assert.equal((await s.login()).connected, true);
  await s.accessToken(true);
  assert.equal(cookie, '__Host-auth_session=cached-cookie');
}));
