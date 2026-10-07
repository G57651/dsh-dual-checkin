// 回归：跨文件的单一来源（P1-6 / P2-16 / O-1）。
// 三平台适配器此前各自复制了一份 tunables / sleep / 常量，形状四次漂移
// （WorkBuddy 的 defaults 只有 2 个键）。这里用「函数同一性」而不是「值相等」来钉死单一来源。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as http from '../lib/http.mjs';
import * as trae from '../lib/trae.mjs';
import * as qoder from '../lib/qoder.mjs';
import * as workbuddy from '../lib/workbuddy.mjs';

const adapters = { trae, qoder, workbuddy };

test('O-1：三平台共用同一份 tunables / defaults（含 WorkBuddy 的形状漂移）', () => {
  for (const [name, adapter] of Object.entries(adapters)) {
    assert.equal(adapter.tunables, http.tunables, name + ' 的 tunables 必须是 http.mjs 的同一个函数');
    assert.equal(adapter.defaults, http.defaults, name + ' 的 defaults 必须是 http.mjs 的同一个对象');
  }
  assert.deepEqual(Object.keys(http.defaults).sort(), ['expiringWindowMs', 'reqTimeoutMs', 'retryDelayMs', 'retryTimes']);
});

test('O-1：适配器不再各自复制 sleep / tunables / 重试常量', async () => {
  for (const file of ['trae', 'qoder', 'workbuddy']) {
    const source = await readFile(new URL(`../lib/${file}.mjs`, import.meta.url), 'utf8');
    assert.match(source, /from '\.\/http\.mjs'/u, file + '.mjs 应直接从 http.mjs 取用');
    assert.equal(/function sleep\s*\(/u.test(source), false, file + '.mjs 不应再自带 sleep');
    assert.equal(/function tunables\s*\(/u.test(source), false, file + '.mjs 不应再自带 tunables');
    assert.equal(/const RETRY_TIMES\s*=/u.test(source), false, file + '.mjs 不应再自带重试常量');
    assert.equal(/redirect:\s*['"]follow['"]/u.test(source), false);
  }
});

test('S-08：三平台都不允许跟随跳转（统一由 http.mjs 保证）', async () => {
  const source = await readFile(new URL('../lib/http.mjs', import.meta.url), 'utf8');
  assert.match(source, /redirect: 'error'/u);
  assert.equal(/redirect:\s*['"]follow['"]/u.test(source), false);
});

test('P2-16：客户端请求的状态路由与 host 注册的路由字面量一致', async () => {
  const host = await readFile(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const hostRoute = /const STATUS_ROUTE = '([^']+)'/u.exec(host)?.[1];
  const clientRoute = /fetch\("(\/plugins\/[^"]+)"/u.exec(client)?.[1];
  assert.equal(hostRoute, '/plugins/dsh-dual-checkin/status');
  assert.equal(clientRoute, hostRoute, '两处路由字面量漂移会导致面板 404');
});

test('P1-9：客户端不再引用已删除的死键 intro', async () => {
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.equal(/^\s+intro:/mu.test(client), false, '字典不该再有 intro 条目');
  assert.equal(/t\("intro"\)/u.test(client), false);
  for (const key of ['accounts', 'creditsBeforeAfter', 'expiringAlert']) {
    assert.equal(new RegExp(`\\n\\s+${key}:`).test(client), true, '字典缺少 ' + key);
  }
});