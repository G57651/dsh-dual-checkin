// 统一签到入口：Trae 与 WorkBuddy 各自读本机登录数据，并行执行，互不阻塞。
// 不读取青龙环境变量里的 token / uid / 账号配置。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { runCheckin as runTrae, queryCredits as queryTraeCredits, discoverCredential as discoverTraeCredential, defaults as traeDefaults } from './trae.mjs';
import { runWorkbuddyCheckin as runWorkbuddy, queryCredits as queryWorkbuddyCredits, discoverAccounts as discoverWorkbuddyAccounts } from './workbuddy.mjs';

export const name = 'dsh-dual-checkin';
export const inject = ['webServer'];

// 状态路由：GET 查看 / POST 强制重查积分（两个平台仍然幂等，不重复签到）。
const STATUS_ROUTE = '/plugins/dsh-dual-checkin/status';

// 积分快照短 TTL（秒）：当日已签到时不再跑 claim，但积分仍需按此间隔重新查询，
// 否则面板整天显示的是 DSH 启动那一刻的旧值。
const creditsTtlMs = (config) => config.creditsTtlSeconds * 1000;

// 与插件同名的运行时 Schema。config 为空时所有 default 生效，apply 始终收到完整配置。
export const Config = Schema.object({
  creditsTtlSeconds: Schema.number().default(300).min(0)
    .description('积分快照最长复用时长（秒）；超过后 GET 会重新查询积分而不重复签到。'),
  retryTimes: Schema.number().default(traeDefaults.retryTimes).min(0)
    .description('Trae 请求失败后的额外重试次数。'),
  retryDelayMs: Schema.number().default(traeDefaults.retryDelayMs).min(0)
    .description('Trae 重试间隔（毫秒）。'),
  reqTimeoutMs: Schema.number().default(traeDefaults.reqTimeoutMs).min(1)
    .description('单个请求的超时上限（毫秒）。'),
  expiringWindowMs: Schema.number().default(traeDefaults.expiringWindowMs).min(1)
    .description('「即将到期」的判定窗口（毫秒），默认 3 天。'),
});

// 交给 trae/workbuddy 的运行时可调项。
function tunablesOf(config) {
  return {
    retryTimes: config.retryTimes,
    retryDelayMs: config.retryDelayMs,
    reqTimeoutMs: config.reqTimeoutMs,
    expiringWindowMs: config.expiringWindowMs,
  };
}

// ---------------------------------------------------------------------------
// 日志：ctx.logger 是服务形态，以插件名调用返回具名 logger（开发文档 §10.1）；
// 兼容仅提供 { warn, info } 对象的宿主。两种形态都不可用时返回 null，
// log() 的所有调用点都安全降级为空操作。
// ---------------------------------------------------------------------------
function resolveLogger(ctx) {
  const raw = ctx?.logger;
  if (typeof raw === 'function') {
    try {
      const named = raw(name);
      if (named && typeof named.warn === 'function') return named;
    } catch { /* fall through to the object-shape fallback */ }
  }
  if (raw && (typeof raw.warn === 'function' || typeof raw.info === 'function')) return raw;
  return null;
}

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}
function stateFile(platform) {
  return join(homeDir(), '.dsh-dual-checkin-' + platform + '.json');
}

async function loadState(platform) {
  try {
    const parsed = JSON.parse(await readFile(stateFile(platform), 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.day === 'string') return parsed;
  } catch { /* first run */ }
  return null;
}

async function saveState(platform, doc) {
  const file = stateFile(platform);
  await mkdir(dirname(file), { recursive: true });
  // 唯一临时名 + 原子改名：并发写或写一半崩溃都不会留下可被读到的坏 JSON。
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
  await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// 仅刷积分的重查通道（不签到、不写状态文件）。
// WorkBuddy 的 M/A 是单组聚合值，Trae 的 C 是调用方给定的时间戳。
// syncCredits 总是回传落盘的 checkedIn/gained/note，只把 credits 快照换成新的。
// ---------------------------------------------------------------------------
function workbuddyCreditSums(doc) {
  const values = Array.isArray(doc.creditsPerAccount) && doc.creditsPerAccount.length > 0
    ? doc.creditsPerAccount
    : [doc.credits];
  return values.reduce((acc, value) => ({
    remaining: acc.remaining + (value && typeof value.remaining === 'number' ? value.remaining : 0),
    used: acc.used + (value && typeof value.used === 'number' ? value.used : 0),
    expiring: acc.expiring + (value && typeof value.expiring === 'number' ? value.expiring : 0),
  }), { remaining: 0, used: 0, expiring: 0 });
}

function roundCredits(credits) {
  return {
    remaining: Math.round(credits.remaining * 1e4) / 1e4,
    used: Math.round(credits.used * 1e4) / 1e4,
    expiring: Math.round(credits.expiring * 1e4) / 1e4,
  };
}

function sumExpiring(list) {
  let total = 0;
  for (const item of list) if (item && typeof item.expiring === 'number') total += item.expiring;
  return Math.round(total * 1e4) / 1e4;
}

async function syncCredits(platform, doc, log, config) {
  const accounts = Array.isArray(doc.accounts) ? doc.accounts : null;
  const single = accounts && accounts.length === 1 ? accounts[0] : null;
  // Trae 没有 doc.accounts：积分查询需要重新发现本机凭据（与 runCheckin 同一来源），
  // 不能把 null 当作凭据传给它。
  let targets;
  if (platform === 'trae') {
    try {
      targets = [await discoverTraeCredential()];
    } catch (error) {
      log('warn', 'Trae 积分刷新失败: ' + (error instanceof Error ? error.message : String(error)));
      return doc;
    }
  } else {
    // WorkBuddy 的落盘快照不含 token，刷新时必须重新发现本机账号；
    // 找不到账号时退回单次查询（与无 accounts 的旧行为一致）。
    try {
      const discovered = await discoverWorkbuddyAccounts({});
      if (discovered.length > 0) {
        targets = accounts
          ? discovered.filter((item) => accounts.some((saved) => saved && saved.uid === item.uid))
          : discovered;
        if (targets.length === 0) targets = discovered;
      } else {
        targets = accounts ? (single ? [single] : accounts) : [null];
      }
    } catch (error) {
      log('warn', 'WorkBuddy 积分刷新失败: ' + (error instanceof Error ? error.message : String(error)));
      return doc;
    }
  }
  const fetched = [];
  for (const account of targets) {
    try {
      fetched.push(await (platform === 'trae'
        ? queryTraeCredits(account, tunablesOf(config))
        : queryWorkbuddyCredits(account, tunablesOf(config))));
    } catch (error) {
      // 积分查询失败不影响签到状态；保留上一次快照，只记日志。
      log('warn', platform + ' 积分刷新失败: ' + (error instanceof Error ? error.message : String(error)));
      return doc;
    }
  }
  const creditsAt = new Date().toISOString();
  if (platform === 'trae') {
    const credits = fetched[0] || null;
    const remaining = credits ? credits.remaining : null;
    return { ...doc, credits, creditsBefore: remaining, creditsAfter: remaining, creditsAt };
  }
  if (single) {
    const credits = fetched[0] || null;
    return { ...doc, credits, creditsAt };
  }
  if (!accounts) return { ...doc, creditsAt };
  const creditsPerAccount = fetched;
  return {
    ...doc,
    creditsPerAccount,
    credits: accounts.length > 0 ? { ...roundCredits(workbuddyCreditSums({ creditsPerAccount })), expiring: sumExpiring(creditsPerAccount) } : doc.credits,
    creditsAt,
  };
}

function isCreditsStale(doc, now, config) {
  const at = Date.parse(doc.creditsAt || doc.checkedAt || '');
  return Number.isNaN(at) || now - at >= creditsTtlMs(config);
}

async function runOnce(platform, runner, log, config, { refreshCredits = false } = {}) {
  const day = today();
  const previous = await loadState(platform);
  if (previous && previous.day === day && previous.ok === true) {
    if (!refreshCredits && !isCreditsStale(previous, Date.now(), config)) return previous;
    const refreshed = await syncCredits(platform, previous, log, config);
    await saveState(platform, refreshed).catch(() => {});
    return refreshed;
  }
  try {
    const result = await runner({ log, ...tunablesOf(config) });
    const saved = { day, checkedAt: new Date().toISOString(), creditsAt: new Date().toISOString(), ...result };
    await saveState(platform, saved);
    return saved;
  } catch (error) {
    const failed = { day, checkedAt: new Date().toISOString(), platform, ok: false, note: error instanceof Error ? error.message : String(error), results: [] };
    await saveState(platform, failed).catch(() => {});
    return failed;
  }
}

// 同平台并发调用共享同一个 promise：防启动跑与 GET 竞态重复执行。
const inFlight = new Map();
function singleFlight(platform, runner, log, config, { refreshCredits = false } = {}) {
  if (inFlight.has(platform)) return inFlight.get(platform);
  const pending = runOnce(platform, runner, log, config, { refreshCredits }).finally(() => inFlight.delete(platform));
  inFlight.set(platform, pending);
  return pending;
}

function localHost(value) {
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]'
    || (typeof value === 'string' && (value.startsWith('localhost:') || value.startsWith('127.0.0.1:') || value.startsWith('[::1]:')));
}
// 与 dsh-connect-trae 的路由守卫同语义：回环 Host + 无 Origin / 回环 Origin 放行；
// 桌面 webview 的自定义协议来源（dsh-app:）视同本机。
function trusted(req) {
  if (!localHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin == null || String(origin).trim() === '') return true;
  try {
    const url = new URL(origin);
    if (url.protocol === 'dsh-app:') return true;
    return localHost(url.hostname) || url.hostname === '::1';
  } catch { return false; }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function unwrapSettled(settled) {
  return settled.status === 'fulfilled' ? settled.value : { ok: false, note: String(settled.reason) };
}

// GET：TTL 内直接返回磁盘状态（无网络请求），超过 TTL 由 syncCredits 重查积分不重复签到；
// POST：手动刷新，跳过快照 TTL 强制重查积分（仍不重复签到）。
async function handleStatus(req, res, { log, config, runners }) {
  if (!trusted(req)) { json(res, 403, { error: 'forbidden' }); return; }
  if (req.method !== 'GET' && req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return; }
  const refreshCredits = req.method === 'POST';
  const [trae, workbuddy] = await Promise.allSettled([
    singleFlight('trae', runners.trae, log, config, { refreshCredits }),
    singleFlight('workbuddy', runners.workbuddy, log, config, { refreshCredits }),
  ]);
  json(res, 200, { trae: unwrapSettled(trae), workbuddy: unwrapSettled(workbuddy) });
}

export function apply(ctx, config) {
  const logger = resolveLogger(ctx);
  const log = (level, message) => {
    if (!logger) return;
    if (level === 'error' && typeof logger.error === 'function') logger.error(message);
    else if (level === 'warn' && typeof logger.warn === 'function') logger.warn(message);
    else if (typeof logger.info === 'function') logger.info(message);
  };
  const runners = {
    trae: (opts) => runTrae(opts),
    workbuddy: (opts) => runWorkbuddy(opts),
  };
  // 启动即签到：交给 ctx.effect 托管，插件卸载 / 热重载时随 fiber 一起，失败只记日志。
  ctx.effect(() => {
    let disposed = false;
    void Promise.allSettled([
      singleFlight('trae', runners.trae, log, config),
      singleFlight('workbuddy', runners.workbuddy, log, config),
    ]).then((settled) => {
      if (disposed) return;
      const failed = settled.filter((item) => item.status === 'rejected');
      if (failed.length > 0) log('warn', '启动签到失败: ' + failed.map((item) => String(item.reason)).join('; '));
    });
    return () => { disposed = true; };
  }, 'dsh-dual-checkin: startup check-in');

  // webServer 已在插件 inject 中声明：apply 运行前服务保证就绪（开发文档 §2.1），
  // 直接注册路由；服务消失时插件随依赖一起卸载、回来时重新加载（§5.4）。
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      handler: (req, res) => handleStatus(req, res, { log, config, runners }),
    });
    return () => dispose();
  }, 'dsh-dual-checkin: status route');
}
