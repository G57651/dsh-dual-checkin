// 回归：三平台共用的 HTTP 契约（lib/http.mjs）。
// 覆盖 O-1/O-2/S-08/S-10：重试判定、跳转策略、Retry-After、退避抖动、401 重换的额度记账。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setFetch } from './harness.mjs';
import {
  RETRY_TIMES, RETRY_DELAY_MS, REQ_TIMEOUT_MS, defaults, tunables,
  isTransientStatus, retryAfterMs, backoffMs, requestText,
} from '../lib/http.mjs';

const headersOf = (map = {}) => ({ get: (key) => (key in map ? map[key] : null) });
const resp = (status, body = '', map = {}) => ({ status, headers: headersOf(map), text: async () => body });

test('tunables 缺省等于常量（单一来源）', () => {
  assert.deepEqual(tunables(), {
    retryTimes: RETRY_TIMES,
    retryDelayMs: RETRY_DELAY_MS,
    reqTimeoutMs: REQ_TIMEOUT_MS,
    expiringWindowMs: defaults.expiringWindowMs,
    signal: undefined,
  });
  assert.deepEqual(defaults, {
    retryTimes: RETRY_TIMES,
    retryDelayMs: RETRY_DELAY_MS,
    reqTimeoutMs: REQ_TIMEOUT_MS,
    expiringWindowMs: defaults.expiringWindowMs,
  });
});

test('tunables 拒绝非法取值，不透传 NaN/负数走坏重试循环', () => {
  assert.equal(tunables({ retryTimes: -1 }).retryTimes, RETRY_TIMES);
  assert.equal(tunables({ retryTimes: 1.5 }).retryTimes, RETRY_TIMES);
  assert.equal(tunables({ retryTimes: NaN }).retryTimes, RETRY_TIMES);
  assert.equal(tunables({ retryTimes: 0 }).retryTimes, 0, '0 是合法值：表示不重试');
  assert.equal(tunables({ retryDelayMs: 0 }).retryDelayMs, 0);
  assert.equal(tunables({ retryDelayMs: -1 }).retryDelayMs, RETRY_DELAY_MS);
  assert.equal(tunables({ reqTimeoutMs: 0 }).reqTimeoutMs, REQ_TIMEOUT_MS, '0 超时会让请求立刻中止，必须回退');
  assert.equal(tunables({ expiringWindowMs: -5 }).expiringWindowMs, defaults.expiringWindowMs);
});

test('tunables 透传 signal（外部中止通道）', () => {
  const controller = new AbortController();
  assert.equal(tunables({ signal: controller.signal }).signal, controller.signal);
});

test('isTransientStatus 只认 5xx 与 429，4xx 一律不该重试', () => {
  for (const status of [500, 502, 503, 429]) assert.equal(isTransientStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 409, 499]) assert.equal(isTransientStatus(status), false, String(status));
});

test('retryAfterMs 解析秒数 / HTTP 日期 / 非法值，并封顶 60s', () => {
  assert.equal(retryAfterMs(resp(503)), 0, '没有该头返回 0');
  assert.equal(retryAfterMs(resp(503, '', { 'retry-after': '5' })), 5000);
  assert.equal(retryAfterMs(resp(503, '', { 'retry-after': '0' })), 0);
  assert.equal(retryAfterMs(resp(503, '', { 'retry-after': '9999' })), 60000, '必须封顶');
  assert.equal(retryAfterMs(resp(503, '', { 'retry-after': 'come back later' })), 0);
  const future = new Date(Date.now() + 4000).toUTCString();
  const parsed = retryAfterMs(resp(503, '', { 'retry-after': future }));
  assert.ok(parsed > 0 && parsed <= 60000, String(parsed));
});

test('backoffMs：Retry-After 优先，否则 retryDelayMs 加 ±20% 抖动', () => {
  assert.equal(backoffMs(5000, 1, 12345, () => 0), 12345, 'Retry-After 优先且不再抖动');
  assert.equal(backoffMs(5000, 1, 0, () => 0), 4000);
  assert.equal(backoffMs(5000, 1, 0, () => 1), 6000);
  assert.equal(backoffMs(0, 1, 0, () => 0.5), 0, 'retryDelayMs=0 表示立即重试，不得回退成默认 5s');
  assert.equal(backoffMs(NaN, 1, 0, () => 0.5), RETRY_DELAY_MS);
});

test('requestText：成功路径恒带 redirect:error 与超时 signal，且每次尝试重建 init', async () => {
  const seen = [];
  setFetch(async (url, init) => {
    seen.push(init);
    return resp(200, '{"ok":true}');
  });
  const result = await requestText('https://example.test/x', () => ({ method: 'POST', headers: { 'x-n': String(seen.length) } }));
  assert.deepEqual(result, { status: 200, text: '{"ok":true}', error: null });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].redirect, 'error', '跨源 3xx 不得跟随（S-08）');
  assert.ok(seen[0].signal && typeof seen[0].signal.aborted === 'boolean');
});

test('requestText：5xx 重试到成功，4xx 立即返回不重试', async () => {
  let calls = 0;
  setFetch(async () => (++calls === 1 ? resp(503, 'busy') : resp(200, 'ok')));
  const retried = await requestText('https://example.test/x', () => ({}), { retryTimes: 2, retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(retried.status, 200);

  calls = 0;
  setFetch(async () => { calls += 1; return resp(400, 'bad'); });
  const quick = await requestText('https://example.test/x', () => ({}), { retryTimes: 2, retryDelayMs: 0 });
  assert.equal(calls, 1, '4xx 盲重试是旧实现的漂移点，必须只剩一次');
  assert.equal(quick.status, 400);
  assert.equal(quick.text, 'bad');
});

test('requestText：网络异常按预算重试，预算耗尽返回 status=0 且 error 非空', async () => {
  let calls = 0;
  setFetch(async () => { calls += 1; throw new Error('ECONNRESET'); });
  const failed = await requestText('https://example.test/x', () => ({}), { retryTimes: 1, retryDelayMs: 0 });
  assert.equal(calls, 2, 'retryTimes=1 表示总共 2 次尝试');
  assert.equal(failed.status, 0);
  assert.match(failed.error, /ECONNRESET/u);

  calls = 0;
  const noRetry = await requestText('https://example.test/x', () => ({}), { retryTimes: 0, retryDelayMs: 0 });
  assert.equal(calls, 1);
  assert.equal(noRetry.status, 0);
});

test('requestText：401 只重换一次令牌，且重换占用重试额度（S-11/旧漂移点）', async () => {
  let calls = 0;
  let refreshes = 0;
  setFetch(async () => { calls += 1; return resp(401, 'token expired'); });
  const result = await requestText('https://example.test/x', () => ({}), {
    retryTimes: 2, retryDelayMs: 0, refresh: async () => { refreshes += 1; },
  });
  assert.equal(refreshes, 1, 'refresh 必须只调用一次');
  assert.equal(calls, 2, '重换占用一次额度：1 次原始 + 1 次重换后重试，不得再多跑');
  assert.equal(result.status, 401);
});

test('requestText：外部 signal 中止后在飞请求立即结束（dispose 路径）', async () => {
  const controller = new AbortController();
  setFetch(async (url, init) => await new Promise((resolve, reject) => {
    const signal = init.signal;
    if (signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const pending = requestText('https://example.test/x', () => ({}), {
    retryTimes: 5, retryDelayMs: 0, signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 0);
  assert.match(result.error, /中止|超时/u);
});