// 回归：状态文件按 profile 分区（P2-19）。
// 同一个 DSH_HOME 下 desktop / 其它 profile 各有各的签到记录，避免跨 profile 互相顶掉当日快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { plugin, makeCtx, testConfig, settle, statusRoute, callStatus, setFetch, homeDir, statePath } from './harness.mjs';

const jwt = [
  'header',
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString('base64url'),
  'signature',
].join('.');
await mkdir(join(homeDir, '.trae-cn'), { recursive: true });
await writeFile(join(homeDir, '.trae-cn', 'trae-jwt-token'), jwt, 'utf8');

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

// profile 在 apply 之前设置：stateFile 在调用时读环境变量。
process.env.DSH_PROFILE = 'work';
const { ctx, routes } = makeCtx();
plugin.apply(ctx, testConfig({ retryTimes: 0, retryDelayMs: 0 }));
await settle();

const SECRET_KEYS = new Set([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'jobtoken', 'pat', 'personaltoken',
  'authorization', 'cookie', 'password', 'secret', 'clientsecret', 'apikey', 'credential', 'credentials',
]);
function collectKeys(value, out = []) {
  if (Array.isArray(value)) { for (const item of value) collectKeys(item, out); return out; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { out.push(key); collectKeys(item, out); }
  }
  return out;
}

test('签到快照写在带 profile 后缀的文件里', async () => {
  const scoped = statePath('trae', 'work');
  const doc = JSON.parse(await readFile(scoped, 'utf8'));
  assert.equal(doc.day, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()));
  assert.equal(doc.ok, true);
  assert.equal(doc.gained, 100);
  assert.equal(doc.schemaVersion, 1);
  await assert.rejects(readFile(statePath('trae'), 'utf8'), /ENOENT/u, '不该再写到无 profile 的全局文件名');
});

test('落盘快照里没有任何凭据形状的键（含嵌套）', async () => {
  const doc = JSON.parse(await readFile(statePath('trae', 'work'), 'utf8'));
  const hit = collectKeys(doc).filter((key) => SECRET_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/gu, '')));
  assert.deepEqual(hit, []);
});

test('状态路由同样按 profile 读到自己的快照', async () => {
  const handler = statusRoute(routes).handler;
  const result = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(result.status, 200);
  assert.equal(result.body.trae.gained, 100);
  assert.equal(result.body.trae.schemaVersion, 1);
});