// 回归：插件卸载（dispose / 热重载）真正中止在飞请求（O-4）。
// 旧实现只在 cleanup 里置一个 disposed 标志，请求会继续跑完并写状态文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { plugin, makeCtx, testConfig, settle, statusRoute, callStatus, setFetch, homeDir } from './harness.mjs';

const jwt = [
  'header',
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url'),
  'signature',
].join('.');
await mkdir(join(homeDir, '.trae-cn'), { recursive: true });
await writeFile(join(homeDir, '.trae-cn', 'trae-jwt-token'), jwt, 'utf8');

// 永不主动返回的响应：只有 signal 中止才会结束。
const signals = [];
setFetch((url, init) => new Promise((resolve, reject) => {
  signals.push(init.signal);
  const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (init.signal.aborted) { fail(); return; }
  init.signal.addEventListener('abort', fail);
}));

const { ctx, routes, cleanups } = makeCtx();
plugin.apply(ctx, testConfig({ retryTimes: 0, retryDelayMs: 0 }));
await settle();
const handler = statusRoute(routes).handler;

test('启动签到确实留下了在飞请求（用例前提）', () => {
  assert.equal(signals.length, 1, 'Trae 有凭据，应恰好发出一个请求');
  assert.equal(signals[0].aborted, false);
});

test('cleanup 中止在飞请求', async () => {
  for (const dispose of cleanups) dispose();
  assert.equal(signals[0].aborted, true, 'dispose 后原请求的 signal 必须处于中止态');
});

test('cleanup 是幂等的（重复卸载不抛）', () => {
  assert.doesNotThrow(() => { for (const dispose of cleanups) dispose(); });
});

test('中止后状态路由立即返回（不挂起、不等待超时）', async () => {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('状态路由挂起')), 2000); });
  try {
    const result = await Promise.race([callStatus(handler, { host: 'localhost:19387' }), timeout]);
    assert.equal(result.status, 200);
    assert.equal(typeof result.body.trae.ok, 'boolean');
  } finally {
    clearTimeout(timer);
  }
});