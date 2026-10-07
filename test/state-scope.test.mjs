// 回归：状态文件的两个新约束。
//   * 落盘 / 读取都过 stripSecrets：磁盘上的历史文件（v1.3.7 写的、被手工改过的）
//     不能因为「不是本次写入」就把凭据字段回给面板。
//   * 快照带 schemaVersion，读取时补齐，供后续版本迁移判断。
// 这里刻意不放置任何凭据 fixture：启动签到拿不到凭据就不会发网络请求、不覆盖状态文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { plugin, makeCtx, testConfig, settle, statusRoute, callStatus, setFetch, fetchCalls, statePath } from './harness.mjs';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const legacy = statePath('trae');
const scoped = statePath('trae', 'work');

// 模拟「v1.3.7 写下的、且夹带了凭据字段」的历史快照。
const legacyDoc = {
  day: today,
  checkedAt: new Date().toISOString(),
  platform: 'trae',
  ok: true,
  checkedIn: true,
  gained: 150,
  credits: { remaining: 700, used: 300, expiring: 0 },
  creditsBefore: 400,
  creditsAfter: 700,
  accessToken: 'LEAKED-ACCESS-TOKEN',
  pat: 'LEAKED-PAT',
  nested: { personal_token: 'LEAKED-NESTED' },
};
await writeFile(legacy, JSON.stringify(legacyDoc), 'utf8');
process.env.DSH_PROFILE = 'work';
setFetch(() => { throw new Error('本用例不该发起任何网络请求'); });

const { ctx, routes } = makeCtx();
plugin.apply(ctx, testConfig({ retryTimes: 0, retryDelayMs: 0 }));
await settle();
const handler = statusRoute(routes).handler;

test('无 profile 后缀的历史快照仍被读取（升级后不会因读不到状态而重复签到）', async () => {
  const before = fetchCalls.length;
  const result = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(result.status, 200);
  assert.equal(result.body.trae.ok, true);
  assert.equal(result.body.trae.gained, 150, '应直接复用历史快照的当日结果');
  assert.equal(result.body.trae.checkedIn, true);
  assert.equal(fetchCalls.length, before, 'TTL 内读取不得触发上游请求');
});

test('磁盘快照的凭据字段在回给面板前被剥掉（含嵌套键）', async () => {
  const result = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(result.body.trae.accessToken, undefined);
  assert.equal(result.body.trae.pat, undefined);
  assert.equal(result.body.trae.nested.personal_token, undefined, '递归剥键');
  assert.equal(typeof result.body.trae.schemaVersion, 'number');
});

test('快照带 schemaVersion，读取旧文件时补齐', async () => {
  const result = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(result.body.trae.schemaVersion, 1);
});

test('旧状态文件不会被就地改写（只读回退）', async () => {
  assert.deepEqual(JSON.parse(await readFile(legacy, 'utf8')), legacyDoc);
  await assert.rejects(readFile(scoped, 'utf8'), /ENOENT/u, 'Trae 当日快照命中时不应写 profile 目录下的新文件');
});