// 回归：状态路由端到端（Trae 全流程 + 积分刷新语义）。
// 覆盖 P0-3：creditsBefore 是「签到前」基线，积分刷新不得把它覆写成当前值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  plugin, makeCtx, testConfig, settle, statusRoute, callStatus, setFetch, homeDir,
} from './harness.mjs';

// 假 JWT：三段式（parseCliToken 只校验段数与首段非空），payload 放远期 exp。
const jwt = [
  'header',
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url'),
  'signature',
].join('.');
await mkdir(join(homeDir, '.trae-cn'), { recursive: true });
await writeFile(join(homeDir, '.trae-cn', 'trae-jwt-token'), jwt, 'utf8');

let usageTotal = 1000;
const ok = (json) => ({ status: 200, ok: true, json: async () => json, text: async () => JSON.stringify(json) });
setFetch((url) => {
  if (url.includes('/trae/api/v2/ug/checkin_credits/status')) {
    return ok({ code: 0, checked_in: false, did_checked_in: false, credits: 100, extra_credits: 0 });
  }
  if (url.includes('/trae/api/v2/ug/checkin_credits/claim')) return ok({ code: 0 });
  if (url.includes('/trae/api/v2/pay/web_user_ent_usage')) {
    return ok({ usage_summary: { total_amount: usageTotal, consumed_amount: 400 }, user_entitlement_pack_list: [] });
  }
  throw new Error('unexpected url: ' + url);
});

const { ctx, routes } = makeCtx();
plugin.apply(ctx, testConfig({ retryTimes: 0, retryDelayMs: 0 }));
await settle();
const handler = statusRoute(routes).handler;

test('Trae 签到成功：gained / creditsBefore / creditsAfter 齐备', async () => {
  const result = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(result.status, 200);
  assert.equal(result.body.trae.ok, true);
  assert.equal(result.body.trae.gained, 100);
  assert.equal(result.body.trae.creditsBefore, 600);
  assert.equal(result.body.trae.creditsAfter, 600);
  assert.equal(result.body.trae.credits.remaining, 600);
  assert.equal(result.body.trae.credits.used, 400);
});

test('P0-3 回归：POST 刷新积分后 creditsBefore 仍是签到前基线', async () => {
  usageTotal = 1300; // 剩余 600 → 900
  const result = await callStatus(handler, { host: 'localhost:19387', method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal(result.body.trae.credits.remaining, 900, '积分快照应已刷新');
  assert.equal(result.body.trae.creditsAfter, 900);
  assert.equal(result.body.trae.creditsBefore, 600, 'creditsBefore 不得被刷新覆写');
  assert.equal(result.body.trae.ok, true, '刷新积分不应把当日功绩误报为失败');
});

test('POST 不重复签到（当日已签到的平台跳过 claim）', async () => {
  const result = await callStatus(handler, { host: 'localhost:19387', method: 'POST' });
  assert.equal(result.body.trae.ok, true);
  assert.equal(result.body.trae.checkedIn, true);
  assert.equal(result.body.trae.gained, 100, 'gained 仍应是当日获得值');
});