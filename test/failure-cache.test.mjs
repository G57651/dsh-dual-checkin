// 回归：P0-1 —— 失败态负缓存。
// 旧实现只对 `ok === true` 的快照做短路，故障日里面板每次轮询（15 秒一次）都会重打上游，
// 且 checkedAt 每次刷新。现在失败态也有 60 秒退避窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  plugin, makeCtx, testConfig, settle, statusRoute, callStatus, setFetch, homeDir, fetchCalls,
} from './harness.mjs';

const jwt = [
  'header',
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url'),
  'signature',
].join('.');
await mkdir(join(homeDir, '.trae-cn'), { recursive: true });
await writeFile(join(homeDir, '.trae-cn', 'trae-jwt-token'), jwt, 'utf8');

// 上游持续 5xx：retryTimes=0，一次调用一个请求，便于精确计数。
setFetch(() => ({ status: 503, ok: false, json: async () => ({}), text: async () => 'upstream down' }));

const { ctx, routes } = makeCtx();
plugin.apply(ctx, testConfig({ retryTimes: 0, retryDelayMs: 0 }));
await settle();
const handler = statusRoute(routes).handler;

test('故障日：连续两次 GET 只有第一次打上游', async () => {
  const first = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(first.body.trae.ok, false);
  const afterFirst = fetchCalls.filter((call) => call.url.includes('api.trae.cn')).length;
  assert.ok(afterFirst >= 1, '第一次应真的访问了上游');

  const second = await callStatus(handler, { host: 'localhost:19387' });
  const afterSecond = fetchCalls.filter((call) => call.url.includes('api.trae.cn')).length;
  assert.equal(afterSecond, afterFirst, '退避窗口内不得重打上游');
  assert.equal(second.body.trae.ok, false);
  assert.equal(second.body.trae.checkedAt, first.body.trae.checkedAt, '应复用同一份失败快照');
});

test('失败快照的 note 不含控制字符', async () => {
  const result = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(/[\r\n\u0000-\u001f\u007f]/u.test(result.body.trae.note), false);
});