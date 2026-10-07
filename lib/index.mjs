// 统一签到入口：Trae、WorkBuddy 与 Qoder 各自读本机登录数据，并行执行，互不阻塞。
// 不读取青龙环境变量里的 token / uid / 账号配置。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { runCheckin as runTrae, queryCredits as queryTraeCredits, discoverCredential as discoverTraeCredential, defaults as traeDefaults } from './trae.mjs';
import { runWorkbuddyCheckin as runWorkbuddy, queryCredits as queryWorkbuddyCredits, discoverAccounts as discoverWorkbuddyAccounts } from './workbuddy.mjs';
import { runQoderCheckin as runQoder, queryUsage as queryQoderUsage, discoverAccounts as discoverQoderAccounts, resolvePatFromFile, patExpiryStatus } from './qoder.mjs';

export const name = 'dsh-dual-checkin';
export const inject = ['webServer'];

// 状态路由：GET 查看 / POST 强制重查积分（三个平台仍然幂等，不重复签到）。
const STATUS_ROUTE = '/plugins/dsh-dual-checkin/status';

// 积分快照短 TTL（秒）：当日已签到时不再跑 claim，但积分仍需按此间隔重新查询，
// 否则面板整天显示的是 DSH 启动那一刻的旧值。
const creditsTtlMs = (config) => config.creditsTtlSeconds * 1000;

// 与插件同名的运行时 Schema。config 为空时所有 default 生效，apply 始终收到完整配置。
export const Config = Schema.object({
  creditsTtlSeconds: Schema.number().default(300).min(0)
    .description('积分快照最长复用时长（秒）；超过后 GET 会重新查询积分而不重复签到。'),
  retryTimes: Schema.number().default(traeDefaults.retryTimes).min(0)
    .description('请求失败后的额外重试次数（三个平台一致；仅对网络故障与 5xx/429 生效）。'),
  retryDelayMs: Schema.number().default(traeDefaults.retryDelayMs).min(0)
    .description('重试间隔（毫秒）。'),
  reqTimeoutMs: Schema.number().default(traeDefaults.reqTimeoutMs).min(1)
    .description('单个请求的超时上限（毫秒）。'),
  expiringWindowMs: Schema.number().default(traeDefaults.expiringWindowMs).min(1)
    .description('「即将到期」的判定窗口（毫秒），默认 3 天。'),
  qoderCredentialRef: Schema.string().default('QODER_MANAGED_CREDENTIAL')
    .description('Qoder PAT 在 DSH 凭据服务里的引用名（与 dsh-provider-qoder 同一份凭据）；填写 qoderPat 时本项被跳过。'),
  qoderRegion: Schema.union(['cn', 'intl']).default('cn')
    .description('Qoder PAT 的签发区域：cn=国内版（openapi.qoder.com.cn），intl=国际版（openapi.qoder.sh）。'),
  qoderPat: Schema.string().default('')
    .description('首次启用：在此输入 Qoder 个人令牌（PAT）。留空则回退读取 qoderCredentialRef 指向的凭据。'),
  qoderPatExpiresAt: Schema.string().default('')
    .description('首次启用：该 PAT 的到期时间（如 2026-11-01 或完整 ISO 时间）。临近到期时面板与日志会提醒更新；留空则不提醒。'),
  qoderPatExpiringDays: Schema.number().default(7).min(0)
    .description('PAT 「临近到期」提醒阈值（剩余天数），默认 7 天。'),
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
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
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

async function syncCredits(platform, doc, log, config, extras = {}) {
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
  } else if (platform === 'qoder') {
    // Qoder 与 Trae 同理：落盘快照不含 token，刷新时用同一 PAT 重新换取 jobToken。
    // PAT 缺失 / exchange 失败时保留上一次快照，只记日志。
    try {
      const discovered = await discoverQoderAccounts({
        resolveCredential: extras.resolveCredential,
        credentialRef: extras.credentialRef ?? config.qoderCredentialRef,
        region: extras.region ?? config.qoderRegion,
        pat: extras.pat,
      });
      if (discovered.length > 0) {
        targets = accounts
          ? discovered.filter((item) => accounts.some((saved) => saved && saved.uid === item.userID))
          : discovered;
        if (targets.length === 0) targets = discovered;
      } else {
        targets = accounts ? (single ? [single] : accounts) : [null];
      }
    } catch (error) {
      log('warn', 'Qoder 积分刷新失败: ' + (error instanceof Error ? error.message : String(error)));
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
      const value = platform === 'trae'
        ? await queryTraeCredits(account, tunablesOf(config))
        : platform === 'qoder'
          ? (account && account.token ? await queryQoderUsage(account, tunablesOf(config)) : null)
          : await queryWorkbuddyCredits(account, tunablesOf(config));
      fetched.push(value);
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
    // creditsBefore 是签到时的「签到前」基线，积分刷新不得覆盖它（否则前后对比数据自毁）。
    const creditsBefore = typeof doc.creditsBefore === 'number' ? doc.creditsBefore : remaining;
    return { ...doc, credits, creditsBefore, creditsAfter: remaining, creditsAt };
  }
  if (platform === 'qoder') {
    const credits = fetched[0] || null;
    return { ...doc, credits, creditsAt };
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

// 失败态的负缓存窗口：一次网络故障不该让面板的每次轮询都重打一遍上游。
const FAILURE_RETRY_MS = 60000;

// note 会同时落盘、进日志、上屏，且内容常来自上游响应片段：先剥掉控制字符与换行，
// 避免把不可见字符（或伪造的日志行）带进状态文件与面板。
function sanitizeNote(value) {
  return typeof value === 'string' ? value.replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ') : value;
}

async function runOnce(platform, runner, log, config, { refreshCredits = false, extras = {} } = {}) {
  const day = today();
  const previous = await loadState(platform);
  if (previous && previous.day === day && previous.ok === true) {
    if (!refreshCredits && !isCreditsStale(previous, Date.now(), config)) return previous;
    const refreshed = await syncCredits(platform, previous, log, config, extras);
    await saveState(platform, refreshed).catch(() => {});
    return refreshed;
  }
  if (previous && previous.day === day && previous.ok === false && !refreshCredits) {
    // 当日已失败过：退避窗口内直接复用失败快照，窗口外才允许再试一次。
    const at = Date.parse(previous.checkedAt || '');
    if (!Number.isNaN(at) && Date.now() - at < FAILURE_RETRY_MS) return previous;
  }
  let result;
  try {
    result = await runner({ log, ...tunablesOf(config), ...extras });
  } catch (error) {
    const failed = {
      day,
      checkedAt: new Date().toISOString(),
      platform,
      ok: false,
      note: sanitizeNote(error instanceof Error ? error.message : String(error)),
      results: [],
    };
    await saveState(platform, failed).catch(() => {});
    return failed;
  }
  // 成功分支必须晚于 runner 返回：签到已经真实发生，落盘失败不能把结果改写成「签到失败」，
  // 否则状态文件不更新，下次启动会再签一次。
  const saved = { day, checkedAt: new Date().toISOString(), creditsAt: new Date().toISOString(), platform, ...result };
  if (typeof saved.note === 'string') saved.note = sanitizeNote(saved.note);
  try {
    await saveState(platform, saved);
  } catch (error) {
    saved.persistError = sanitizeNote(error instanceof Error ? error.message : String(error));
    log('warn', platform + ' 状态写入失败（签到结果已保留）: ' + saved.persistError);
  }
  return saved;
}

// 同平台并发调用共享同一个 promise：防启动跑与 GET 竞态重复执行。
const inFlight = new Map();
function singleFlight(platform, runner, log, config, { refreshCredits = false, extras = {} } = {}) {
  if (inFlight.has(platform)) return inFlight.get(platform);
  const pending = runOnce(platform, runner, log, config, { refreshCredits, extras }).finally(() => inFlight.delete(platform));
  inFlight.set(platform, pending);
  return pending;
}

// 回环主机判定：先剥端口，再逐字比对回环名，最后用 127.0.0.0/8 覆盖整个回环网段。
// 不能用 startsWith 前缀判断：`localhost:80.evil.com`、`127.0.0.1:19387.attacker.tld`
// 都会被误判成回环。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function hostnameOfHost(value) {
  const host = String(value || '').trim().toLowerCase();
  // '@' 与 '/' 不可能出现在合法的 authority 里：`localhost:19387@evil.com`、
  // `evil.example/path` 这类值一律判为非法，而不是被截断成回环名。
  if (host === '' || host.includes('@') || host.includes('/')) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return host;
    const rest = host.slice(end + 1);
    // IPv6 字面量之后只允许 `:端口`（纯数字），否则整个值非法。
    return rest === '' || /^:[0-9]+$/u.test(rest) ? host.slice(0, end + 1) : '';
  }
  const colon = host.indexOf(':');
  if (colon === -1) return host;
  // 端口必须是纯数字：`localhost:80.evil.com` 的「端口」不是数字，必须整体拒绝，
  // 不能截断成 `localhost`（这正是 S-02 的前缀绕过）。
  return /^[0-9]+$/u.test(host.slice(colon + 1)) ? host.slice(0, colon) : '';
}
function isLoopbackHost(value) {
  const host = hostnameOfHost(value);
  if (LOOPBACK_HOSTS.has(host)) return true;
  return isIP(host) === 4 && host.startsWith('127.');
}
// 请求对端必须是回环：宿主允许把 webserver 绑到 0.0.0.0，只靠 Host 头挡不住局域网请求。
function isLoopbackPeer(address) {
  if (typeof address !== 'string' || address === '') return false;
  const value = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (value === '::1') return true;
  return isIP(value) === 4 && value.startsWith('127.');
}
// 守卫：回环对端 + 回环 Host + 无 Origin / 回环 Origin 放行；
// 桌面 webview 的自定义协议来源（dsh-app:）视同本机。
// 说明：这与 dsh-connect-trae 是「同目的、不同实现」——那边用 LOOPBACK_HOSTS + hostnameOfHost
// 精确匹配；本插件此前用 startsWith 前缀判断，会放过 `localhost:19387.attacker.tld`。
function trusted(req) {
  if (!isLoopbackPeer(req.socket && req.socket.remoteAddress)) return false;
  if (!isLoopbackHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin == null || String(origin).trim() === '') return true;
  try {
    const url = new URL(origin);
    if (url.protocol === 'dsh-app:') return true;
    return isLoopbackHost(url.hostname);
  } catch { return false; }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // 响应体含账号 uid / 昵称 / 域名与积分（个人信息）：禁止浏览器与任何中间层缓存。
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

function unwrapSettled(settled) {
  const value = settled.status === 'fulfilled'
    ? settled.value
    : { ok: false, note: String(settled.reason), results: [] };
  if (!value || typeof value !== 'object') return value;
  return typeof value.note === 'string' ? { ...value, note: sanitizeNote(value.note) } : value;
}

// GET：TTL 内直接返回磁盘状态（无网络请求），超过 TTL 由 syncCredits 重查积分不重复签到；
// POST：手动刷新，跳过快照 TTL 强制重查积分（仍不重复签到）。
async function handleStatus(req, res, { log, config, runners, qoderExtras, patStatus }) {
  if (!trusted(req)) { json(res, 403, { error: 'forbidden' }); return; }
  if (req.method !== 'GET' && req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return; }
  const refreshCredits = req.method === 'POST';
  const [trae, workbuddy, qoder] = await Promise.allSettled([
    singleFlight('trae', runners.trae, log, config, { refreshCredits }),
    singleFlight('workbuddy', runners.workbuddy, log, config, { refreshCredits }),
    singleFlight('qoder', runners.qoder, log, config, { refreshCredits, extras: qoderExtras }),
  ]);
  json(res, 200, {
    trae: unwrapSettled(trae),
    workbuddy: unwrapSettled(workbuddy),
    // PAT 到期状态按当前配置实时重算：改配置无需等下一次签到即可反映到面板。
    qoder: { ...unwrapSettled(qoder), ...patStatus },
  });
}

export function apply(ctx, config) {
  const logger = resolveLogger(ctx);
  const log = (level, message) => {
    if (!logger) return;
    if (level === 'error' && typeof logger.error === 'function') logger.error(message);
    else if (level === 'warn' && typeof logger.warn === 'function') logger.warn(message);
    else if (typeof logger.info === 'function') logger.info(message);
  };
  // Qoder 凭据：优先走宿主凭据服务（与 dsh-provider-qoder 同一 resolve 通道），
  // 服务未挂载时回退直读 ~/.dsh/.credentials.yaml 的同名 refs 项。credentials 是
  // 可选依赖：不进 inject，避免无凭据服务的 profile 拖累 Trae / WorkBuddy 一起 PENDING。
  const resolveCredential = async (refName) => {
    const credentials = ctx.get ? ctx.get('credentials') : undefined;
    if (credentials && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(refName);
      if (typeof hit === 'string') return hit;
      return hit && typeof hit.value === 'string' ? hit.value : '';
    }
    return resolvePatFromFile(refName);
  };
  const qoderExtras = {
    resolveCredential,
    credentialRef: config.qoderCredentialRef,
    region: config.qoderRegion,
    pat: config.qoderPat,
    patExpiresAt: config.qoderPatExpiresAt,
    patExpiringDays: config.qoderPatExpiringDays,
  };
  // PAT 到期状态按当前配置实时重算（空配置返回空对象，不影响卡片其余字段）。
  const patStatus = () => patExpiryStatus(config.qoderPatExpiresAt, config.qoderPatExpiringDays) ?? {};
  const runners = {
    trae: (opts) => runTrae(opts),
    workbuddy: (opts) => runWorkbuddy(opts),
    qoder: (opts) => runQoder({ ...opts, ...qoderExtras }),
  };
  // 启动即签到：交给 ctx.effect 托管，插件卸载 / 热重载时随 fiber 一起，失败只记日志。
  ctx.effect(() => {
    let disposed = false;
    void Promise.allSettled([
      singleFlight('trae', runners.trae, log, config),
      singleFlight('workbuddy', runners.workbuddy, log, config),
      singleFlight('qoder', runners.qoder, log, config, { extras: qoderExtras }),
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
      handler: (req, res) => handleStatus(req, res, { log, config, runners, qoderExtras, patStatus: patStatus() }),
    });
    return () => dispose();
  }, 'dsh-dual-checkin: status route');
}
