// 回归测试夹具。
// 两条硬约束：
//   1) 在 import 插件之前把 HOME / DSH_HOME 重定向到临时目录，保证测试既不读真实凭据，
//      也不写真实状态文件（lib/*.mjs 都在调用时经 homedir() / process.env 取值）；
//   2) 把 globalThis.fetch 换成离线桩，默认直接抛错，任何测试都不可能发出真实请求。
// 需要网络形态的测试请自行覆盖 globalThis.fetch（见 setFetch）。
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dcc-home-'));
const dshHome = join(home, '.dsh');
await mkdir(dshHome, { recursive: true, mode: 0o700 });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = dshHome;
delete process.env.WORKBUDDY_ELECTRON_BIN;

export const homeDir = home;
export const dshHomeDir = dshHome;

export const fetchCalls = [];

export function setFetch(impl) {
  fetchCalls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), init });
    return impl(String(url), init);
  };
}

setFetch(() => {
  throw new Error('offline test harness: 网络已禁用');
});

export const plugin = await import('../lib/index.mjs');

// 覆盖 Config schema 的全部默认值；apply 直接接收完整配置。
export function testConfig(overrides = {}) {
  return {
    creditsTtlSeconds: 300,
    retryTimes: 2,
    retryDelayMs: 5000,
    reqTimeoutMs: 20000,
    expiringWindowMs: 3 * 86400000,
    qoderCredentialRef: 'QODER_MANAGED_CREDENTIAL',
    qoderRegion: 'cn',
    qoderPat: '',
    qoderPatExpiresAt: '',
    qoderPatExpiringDays: 7,
    ...overrides,
  };
}

export function makeCtx() {
  const routes = [];
  const cleanups = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return dispose;
    },
    get() { return undefined; },
    webServer: {
      register(route) { routes.push(route); return () => {}; },
    },
  };
  return { ctx, routes, cleanups };
}

// 启动签到与路由注册都在 ctx.effect 里：apply 之后必须让出事件循环，
// 否则「启动签到」的在飞请求会污染后续断言的 fetch 计数。
export const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeReq({ host, origin, method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
  const headers = {};
  if (host !== undefined) headers.host = host;
  if (origin !== undefined) headers.origin = origin;
  return { headers, method, socket: { remoteAddress } };
}

export function fakeRes() {
  const res = { statusCode: 0, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (payload) => { res.body = payload ?? ''; };
  return res;
}

export function statusRoute(routes) {
  const route = routes.find((item) => item.path === '/plugins/dsh-dual-checkin/status');
  if (!route) throw new Error('状态路由未注册');
  return route;
}

export async function callStatus(handler, options) {
  const res = fakeRes();
  await handler(fakeReq(options), res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body || 'null') };
}