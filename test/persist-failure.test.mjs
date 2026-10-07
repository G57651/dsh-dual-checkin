// 回归：P0-2 —— 落盘失败不得把「已经签到成功」误报为失败。
// 旧实现里 `await saveState(platform, saved)` 与 runner 共用同一个 try/catch：
// 状态文件写不进去（例如路径被占成目录 → EISDIR）时，claim 其实已经发出、积分已经到账，
// 面板却显示 ok=false 且 results=[]，状态文件也没更新 → 下次启动会再签一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  plugin, makeCtx, testConfig, settle, statusRoute, callStatus, setFetch, homeDir, dshHomeDir,
} from './harness.mjs';

const jwt = [
  'header',
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url'),
  'signature',
].join('.');
await mkdir(join(homeDir, '.trae-cn'), { recursive: true });
await writeFile(join(homeDir, '.trae-cn', 'trae-jwt-token'), jwt, 'utf8');

// 把状态文件路径占成目录：writeFile 到临时文件没问题，原子 rename 到目录必然 EISDIR。
const STATE_FILE = join(dshHomeDir, '.dsh-dual-checkin-trae.json');
await mkdir(STATE_FILE, { recursive: true });

const ok = (json) => ({ status: 200, ok: true, json: async () => json, text: async () => JSON.stringify(json) });
setFetch((url) => {
  if (url.includes('/trae/api/v2/ug/checkin_credits/status')) {
    return ok({ code: 0, checked_in: false, did_checked_in: false, credits: 100, extra_credits: 0 });
  }
  if (url.includes('/trae/api/v2/ug/checkin_credits/claim')) return ok({ code: 0 });
  if (url.includes('/trae/api/v2/pay/web_user_ent_usage')) {
    return ok({ usage_summary: { total_amount: 1000, consumed_amount: 400 }, user_entitlement_pack_list: [] });
  }
  throw new Error('unexpected url: ' + url);
});

const { ctx, routes } = makeCtx();
plugin.apply(ctx, testConfig({ retryTimes: 0, retryDelayMs: 0 }));
await settle();
const handler = statusRoute(routes).handler;

test('落盘失败时仍上报签到成功，并带 persistError', async () => {
  const result = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(result.status, 200);
  assert.equal(result.body.trae.ok, true, 'claim 已成功，不得因落盘失败改判为 ok=false');
  assert.equal(result.body.trae.gained, 100);
  assert.equal(result.body.trae.checkedIn, true);
  assert.equal(result.body.trae.note, '签到成功，获得 +100 积分', '原 note 不得被 EISDIR 覆盖');
  assert.equal(typeof result.body.trae.persistError, 'string');
  assert.match(result.body.trae.persistError, /EISDIR|illegal operation/u);
});

test('落盘失败是可见的，且状态文件路径未被执行破坏（仍是目录）', async () => {
  const info = await stat(STATE_FILE);
  assert.equal(info.isDirectory(), true);
});

test('落盘失败不触发控制字符注入', async () => {
  const result = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(/[\r\n]/u.test(result.body.trae.persistError), false);
});