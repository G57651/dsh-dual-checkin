// 回归：状态路由的访问守卫。
// 覆盖三类此前被绕过 / 缺失的判定：
//   S-02 Host 前缀绕过（`localhost:80.evil.com` 曾判为回环）
//   S-05 完全没有对端来源校验（宿主 webserver 允许绑 0.0.0.0）
//   S-07 响应缺安全头
import test from 'node:test';
import assert from 'node:assert/strict';
import { plugin, makeCtx, testConfig, settle, statusRoute, callStatus, fetchCalls } from './harness.mjs';

const { ctx, routes } = makeCtx();
plugin.apply(ctx, testConfig({ retryTimes: 0, retryDelayMs: 0 }));
await settle();

test('注册且仅注册一条 exact 状态路由', () => {
  const route = statusRoute(routes);
  assert.equal(routes.length, 1);
  assert.equal(route.kind, 'exact');
});

const handler = statusRoute(routes).handler;

const CASES = [
  // [说明, 请求, 期望状态码]
  ['正常：回环 Host + 回环对端', { host: 'localhost:19387', remoteAddress: '127.0.0.1' }, 200],
  ['正常：IPv4 回环', { host: '127.0.0.1:19387', remoteAddress: '127.0.0.1' }, 200],
  ['正常：IPv6 回环 Host + IPv6 回环对端', { host: '[::1]:19387', remoteAddress: '::1' }, 200],
  ['正常：IPv4-mapped 对端', { host: '127.0.0.1:19387', remoteAddress: '::ffff:127.0.0.1' }, 200],
  ['S-02 回归：localhost:<port>.evil.com 曾是 200', { host: 'localhost:80.evil.com' }, 403],
  ['S-02 回归：127.0.0.1:<port>.evil.com 曾是 200', { host: '127.0.0.1:80.evil.com' }, 403],
  ['S-02 回归：[::1]:<port>.evil.com 曾是 200', { host: '[::1]:80.evil.com' }, 403],
  ['非法 authority：含 @ 一律拒绝', { host: 'localhost:19387@evil.com' }, 403],
  ['非法 authority：含 / 一律拒绝', { host: 'localhost:19387/evil' }, 403],
  ['DNS 重绑定域名（解析到回环也不是回环字面量）', { host: '127.0.0.1.nip.io:19387' }, 403],
  ['非回环 Host', { host: 'attacker.example:19387' }, 403],
  ['缺 Host 头', { host: undefined }, 403],
  ['S-05 回归：非回环对端即使 Host 是回环也拒绝', { host: 'localhost:19387', remoteAddress: '192.168.1.5' }, 403],
  ['S-05 回归：对端地址不可解析时失败关闭', { host: 'localhost:19387', remoteAddress: null }, 403],
  ['Origin 为回环但端口不同：不约束端口（与服务同机即可）', { host: 'localhost:19387', remoteAddress: '127.0.0.1', origin: 'http://127.0.0.1:9999' }, 200],
  ['Origin 为桌面壳协议：放行', { host: 'localhost:19387', remoteAddress: '127.0.0.1', origin: 'dsh-app://x' }, 200],
  ['Origin 跨站：拒绝', { host: 'localhost:19387', remoteAddress: '127.0.0.1', origin: 'https://evil.example' }, 403],
  ['Origin: null：拒绝', { host: 'localhost:19387', remoteAddress: '127.0.0.1', origin: 'null' }, 403],
  ['Origin: file://：拒绝', { host: 'localhost:19387', remoteAddress: '127.0.0.1', origin: 'file:///etc/passwd' }, 403],
];

for (const [label, request, want] of CASES) {
  test(`守卫：${label} → ${want}`, async () => {
    const result = await callStatus(handler, request);
    assert.equal(result.status, want);
  });
}

test('方法白名单：GET/POST 放行，其余 405', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
    const result = await callStatus(handler, { host: 'localhost:19387', method });
    assert.equal(result.status, 405, `${method} 应 405`);
  }
  const post = await callStatus(handler, { host: 'localhost:19387', method: 'POST' });
  assert.equal(post.status, 200);
});

test('S-07 响应安全头：no-store / nosniff / no-referrer 齐全', async () => {
  const result = await callStatus(handler, { host: 'localhost:19387' });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'application/json');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
});

test('无凭据环境不发起任何网络请求，且返回三平台键', async () => {
  fetchCalls.length = 0;
  const result = await callStatus(handler, { host: 'localhost:19387', method: 'POST' });
  assert.deepEqual(Object.keys(result.body).sort(), ['qoder', 'trae', 'workbuddy']);
  assert.equal(fetchCalls.length, 0);
});

test('note 已清洗控制字符（S-09）', async () => {
  const result = await callStatus(handler, { host: 'localhost:19387' });
  for (const value of Object.values(result.body)) {
    if (value && typeof value.note === 'string') {
      assert.equal(/[\r\n\u0000-\u001f\u007f]/u.test(value.note), false, `note 含控制字符: ${JSON.stringify(value.note)}`);
    }
  }
});