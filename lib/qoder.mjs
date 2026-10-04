// Qoder 一键签到。登录信息复用 DSH 凭据服务里已配置的 Qoder PAT（与 dsh-provider-qoder
// 是同一份凭据，在 设置 → 模型 → Qoder 凭据 卡片维护），不读取 Qoder 的任何本机文件、
// 不访问系统钥匙串、无任何解密代码：
//   PAT → POST /api/v1/jobToken/exchange → 短期 jobToken → campaigns / claim / usage
// PAT 与 jobToken 只在进程内存中使用，不落盘；状态文件只存 uid / 昵称 / edition 与积分快照。
//
// 签到协议（对齐 Qoder 桌面端「用量面板」自己的活动领取链路）：
//   GET  {openApi}/sash/api/v1/me/campaigns          每日一轮 CLAIM_BENEFIT 活动
//   POST {openApi}/sash/api/v1/me/campaigns/{id}/claim  幂等，重复领取返回 replayed=true 且不再发币
//   GET  {openApi}/sash/api/v2/me/usage              积分快照（尽力而为）
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAIM_BENEFIT_ACTION = 'CLAIM_BENEFIT';
const CLAIMED_STATUS = 'CLAIMED';

const RETRY_TIMES = 2;
const RETRY_DELAY_MS = 5000;
const REQ_TIMEOUT_MS = 20000;
const EXPIRING_WINDOW_MS = 3 * 86400000;
// 运行时可调项：缺省等于上面的常量，由 index.mjs 的 Config 覆盖。
function tunables(options = {}) {
  return {
    retryTimes: Number.isInteger(options.retryTimes) && options.retryTimes >= 0 ? options.retryTimes : RETRY_TIMES,
    retryDelayMs: Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : RETRY_DELAY_MS,
    reqTimeoutMs: Number.isFinite(options.reqTimeoutMs) && options.reqTimeoutMs > 0 ? options.reqTimeoutMs : REQ_TIMEOUT_MS,
    expiringWindowMs: Number.isFinite(options.expiringWindowMs) && options.expiringWindowMs > 0 ? options.expiringWindowMs : EXPIRING_WINDOW_MS,
  };
}
export const defaults = { retryTimes: RETRY_TIMES, retryDelayMs: RETRY_DELAY_MS, reqTimeoutMs: REQ_TIMEOUT_MS, expiringWindowMs: EXPIRING_WINDOW_MS };

// 国际版与国内版是两套并行的 openapi；PAT 按区域签发，region 由 Config 指定。
export const REGIONS = {
  cn: { id: 'cn', edition: 'cn', displayName: 'Qoder CN', openApiUrl: 'https://openapi.qoder.com.cn' },
  intl: { id: 'intl', edition: 'intl', displayName: 'Qoder', openApiUrl: 'https://openapi.qoder.sh' },
};

// ---------------------------------------------------------------------------
// ① PAT 解析：resolveCredential 由 index.mjs 注入（ctx.credentials.resolve 优先，
//    服务缺失时回退直读 ~/.dsh/.credentials.yaml 的同名 refs 项）。
// ---------------------------------------------------------------------------
export async function resolvePatFromFile(refName, { home = homedir(), env = process.env } = {}) {
  const dshHome = env.DSH_HOME || join(home, '.dsh');
  let text;
  try {
    text = await readFile(join(dshHome, '.credentials.yaml'), 'utf8');
  } catch {
    return '';
  }
  // refs 项是两格缩进的 `  <NAME>: <value>`；这里只认这个稳定形态，不引入 YAML 依赖。
  const match = text.match(new RegExp('^  ' + refName + ': (\\S+)$', 'm'));
  return match ? match[1] : '';
}

// ---------------------------------------------------------------------------
// ② PAT → jobToken：exchange 结果按 PAT+区域在进程内缓存，临期前 5 分钟自动重换。
// ---------------------------------------------------------------------------
const EXCHANGE_MARGIN_MS = 5 * 60000;
let jobTokenCache;

async function exchangePat(pat, region, t) {
  const response = await fetch(region.openApiUrl + '/api/v1/jobToken/exchange', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'cosy-clienttype': '5',
      'cosy-version': '1.0.1',
      'user-agent': 'Qoder',
    },
    body: JSON.stringify({ personal_token: pat }),
    signal: AbortSignal.timeout(t.reqTimeoutMs),
  });
  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* 非 JSON 按失败处理 */ }
  if (!response.ok || !json.token) {
    const code = json.code ?? response.status;
    const err = new Error('Qoder PAT 无效或已过期（exchange ' + code + '）——请在 DSH 设置 → 模型 → Qoder 凭据 卡片更新 PAT');
    err.loginExpired = true;
    throw err;
  }
  const expiresAtMs = json.expires_at != null && !Number.isNaN(Date.parse(json.expires_at))
    ? Date.parse(json.expires_at)
    : typeof json.expires_in === 'number' && json.expires_in > 0 ? Date.now() + json.expires_in : 0;
  return { token: json.token, expiresAt: expiresAtMs };
}

async function jobTokenFor(pat, region, t) {
  const hit = jobTokenCache;
  if (hit && hit.regionId === region.id && hit.pat === pat && hit.expiresAt - Date.now() > EXCHANGE_MARGIN_MS) {
    return hit;
  }
  const fresh = await exchangePat(pat, region, t);
  jobTokenCache = { regionId: region.id, pat, ...fresh };
  return jobTokenCache;
}

// ---------------------------------------------------------------------------
// ③ 账号发现：PAT 换取 jobToken → userinfo 取身份。PAT 缺失/失效给出可操作提示。
// ---------------------------------------------------------------------------
export async function discoverAccounts(opts = {}) {
  const region = REGIONS[opts.region] ?? REGIONS.cn;
  const t = tunables(opts);
  const resolveCredential = opts.resolveCredential ?? ((ref) => resolvePatFromFile(ref));
  const refName = opts.credentialRef ?? 'QODER_MANAGED_CREDENTIAL';
  // 令牌来源优先级：显式配置的 qoderPat（首次启用由用户输入）→ 凭据服务引用 → 文件兜底。
  const pat = String(opts.pat ?? '').trim() || String(await resolveCredential(refName) ?? '').trim();
  if (pat === '') {
    throw new Error('未找到 Qoder PAT（凭据引用 ' + refName + '）——请在 DSH 设置 → 模型 → Qoder 凭据 卡片配置，或把 qoderCredentialRef 指向已有凭据');
  }
  const { token, expiresAt } = await jobTokenFor(pat, region, t);
  let identity = {};
  try {
    identity = await fetch(region.openApiUrl + '/api/v1/userinfo', {
      headers: { accept: 'application/json', authorization: 'Bearer ' + token, 'user-agent': 'Qoder' },
      signal: AbortSignal.timeout(t.reqTimeoutMs),
    }).then((response) => response.json());
  } catch { /* 身份仅用于展示，失败不阻断签到 */ }
  return [{
    region,
    userID: String(identity?.id ?? identity?.user_id ?? identity?.uid ?? ''),
    name: typeof identity?.name === 'string' ? identity.name : '',
    email: typeof identity?.email === 'string' ? identity.email : '',
    token,
    expiresAt,
    // 401 重换时需要用同一 PAT 重新 exchange；只驻留内存，不落盘。
    pat,
  }];
}

// ---------------------------------------------------------------------------
// ④ 请求层：Bearer + Cosy-ClientType:10；网络异常与 5xx/429 重试，4xx 快速失败；
//    401 时先重换一次 jobToken 再试一轮（PAT 常效、jobToken 短期），重换不消耗重试次数。
// ---------------------------------------------------------------------------
function openApiHeaders(account) {
  return {
    accept: 'application/json',
    authorization: 'Bearer ' + account.token,
    'cosy-clienttype': '10',
    'user-agent': 'Qoder',
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function requestJson(account, method, urlPath, body, options = {}) {
  const t = tunables(options);
  const url = account.region.openApiUrl + urlPath;
  let lastError = '';
  let refreshed = false;
  for (let attempt = 0; attempt <= t.retryTimes; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method,
        // 每次尝试都重取 headers：401 重换 jobToken 后必须带上新 token。
        headers: { ...openApiHeaders(account), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(t.reqTimeoutMs),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < t.retryTimes) { await sleep(t.retryDelayMs); continue; }
      throw new Error('请求 ' + urlPath + ' 失败: ' + lastError);
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      // jobToken 短期：先重换一次再试；重换后仍 401 才判定 PAT 失效（登录过期）。
      if (!refreshed && typeof options.refreshToken === 'function') {
        refreshed = true;
        await options.refreshToken();
        attempt -= 1;
        continue;
      }
      const err = new Error('登录信息无效或已过期（HTTP ' + response.status + '），请检查 DSH 设置 → 模型 → Qoder 凭据');
      err.loginExpired = true;
      throw err;
    }
    // 5xx 与 429 视为瞬时故障重试；其余 4xx 是请求本身的问题，重试无意义。
    if (response.status >= 500 || response.status === 429) {
      lastError = 'HTTP ' + response.status + ': ' + text.slice(0, 200);
      if (attempt < t.retryTimes) { await sleep(t.retryDelayMs); continue; }
      throw new Error('请求 ' + urlPath + ' 失败: ' + lastError);
    }
    if (response.status >= 400) {
      throw new Error('请求 ' + urlPath + ' 失败: HTTP ' + response.status + ': ' + text.slice(0, 200));
    }
    try { return JSON.parse(text); } catch {
      throw new Error(urlPath + ' 返回的不是 JSON: ' + text.slice(0, 200));
    }
  }
  throw new Error('请求 ' + urlPath + ' 失败: ' + lastError);
}

// ---------------------------------------------------------------------------
// ⑤ 活动判定：actionType=CLAIM_BENEFIT 且时间窗开启的那一轮才发币；
//    claimStatus=CLAIMED 表示本轮已领。未知状态按可领取处理（上游幂等，乐观无代价）。
// ---------------------------------------------------------------------------
// campaigns 的窗口字段是秒级整数（10 位），claim/usage 侧是 RFC3339 字符串或毫秒；
// 与 dsh-connect-qoder time.js 同一语义：秒级整数 ×1000，字符串直接 parse。
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function windowOpenAt(campaign, nowMs) {
  const startAt = toEpochMs(campaign?.startAt ?? campaign?.beginAt);
  const endAt = toEpochMs(campaign?.endAt);
  if (startAt !== undefined && nowMs < startAt) return false;
  if (endAt !== undefined && nowMs > endAt) return false;
  return true;
}

export function claimableCampaignOf(payload, nowMs = Date.now()) {
  const list = payload?.campaigns;
  if (!Array.isArray(list)) return undefined;
  for (const campaign of list) {
    if (!campaign || typeof campaign !== 'object') continue;
    if (campaign.actionType !== CLAIM_BENEFIT_ACTION) continue;
    if (!windowOpenAt(campaign, nowMs)) continue;
    return campaign;
  }
  return undefined;
}

function benefitAmountOf(campaign, payload) {
  const fromClaim = Number(payload?.data?.benefit?.amount ?? payload?.benefit?.amount);
  if (Number.isFinite(fromClaim) && fromClaim > 0) return fromClaim;
  const fromCampaign = Number(campaign?.benefit?.amount);
  if (Number.isFinite(fromCampaign) && fromCampaign > 0) return fromCampaign;
  return null;
}

// ---------------------------------------------------------------------------
// ⑥ 积分快照（尽力而为）：/sash/api/v2/me/usage 的配额桶 + 资源包聚合出 剩余/已用/即将到期。
//    字段缺失时对应项为 null，不影响签到本身。
// ---------------------------------------------------------------------------
function bucketOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const total = Number(value.total);
  const used = Number(value.used);
  const remainingRaw = Number(value.remaining);
  const remaining = Number.isFinite(remainingRaw) ? Math.max(remainingRaw, 0)
    : Number.isFinite(total) && Number.isFinite(used) ? Math.max(total - used, 0) : null;
  if (remaining === null) return null;
  return { remaining, used: Number.isFinite(used) ? Math.max(used, 0) : 0, total: Number.isFinite(total) ? total : null };
}

function collectBuckets(node, out, depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectBuckets(item, out, depth + 1);
    return;
  }
  const bucket = bucketOf(node);
  if (bucket) {
    out.push({ ...bucket, expiresAt: toEpochMs(node.expiresAt ?? node.endTime) });
    return; // 配额桶不再下钻
  }
  for (const value of Object.values(node)) collectBuckets(value, out, depth + 1);
}

export async function queryUsage(account, options = {}) {
  const t = tunables(options);
  const payload = await requestJson(account, 'GET', '/sash/api/v2/me/usage', undefined, t);
  const buckets = [];
  collectBuckets(payload?.data ?? payload, buckets);
  if (buckets.length === 0) return null;
  let remaining = 0;
  let used = 0;
  let expiring = 0;
  let hasTotal = false;
  let total = 0;
  const now = Date.now();
  for (const bucket of buckets) {
    remaining += bucket.remaining;
    used += bucket.used;
    if (bucket.total !== null) { hasTotal = true; total += bucket.total; }
    if (bucket.expiresAt !== undefined && bucket.expiresAt > now && bucket.expiresAt - now <= t.expiringWindowMs) {
      expiring += bucket.remaining;
    }
  }
  const round = (value) => Math.round(value * 1e4) / 1e4;
  return { remaining: round(remaining), used: round(used), total: hasTotal ? round(total) : null, expiring: round(expiring) };
}

// ---------------------------------------------------------------------------
// ⑦ 一键签到主流程：PAT 复用 → 查活动（幂等）→ 必要时 claim → 回带积分快照。
//    401 时经 refreshToken 闭包重换 jobToken 再试，不把短期凭据过期误报成登录失效。
// ---------------------------------------------------------------------------
async function checkinOne(account, opts) {
  const log = opts.log || (() => {});
  const t = tunables(opts);
  const label = account.name || account.userID || 'Qoder';
  const head = { uid: account.userID, name: account.name, edition: account.region.edition };
  // 401 重换闭包：清缓存并用同一 PAT 重新 exchange，把新 token 写回账号对象。
  const refresh = async () => {
    jobTokenCache = undefined;
    const fresh = await jobTokenFor(account.pat, account.region, t);
    account.token = fresh.token;
  };

  try {
    // 积分快照失败只记日志，不改变签到结果。
    let before = null;
    try { before = await queryUsage(account, t); }
    catch (error) { log('warn', 'Qoder[' + label + '] 签到前积分查询失败: ' + (error instanceof Error ? error.message : String(error))); }

    const payload = await requestJson(account, 'GET', '/sash/api/v1/me/campaigns', undefined, { ...t, refreshToken: refresh });
    const campaign = claimableCampaignOf(payload);
    if (campaign === undefined) {
      const note = '当前没有可领取的签到活动（活动每日滚动发放，DSH 下次启动会重试）';
      log('warn', 'Qoder[' + label + '] ' + note);
      return { ...head, ok: false, checkedIn: false, already: false, note, gained: null, credits: before };
    }

    let result;
    if (campaign.claimStatus === CLAIMED_STATUS) {
      // 当轮时间窗内 CLAIMED ⇒ 奖励今天已经到账（无论由客户端还是本插件领取），
      // 把本轮宣传金额作为 gained 展示，与 WorkBuddy 的 already 分支行为一致。
      result = { ok: true, already: true, gained: benefitAmountOf(campaign), note: '今日已签到，跳过' };
    } else {
      const claim = await requestJson(account, 'POST', '/sash/api/v1/me/campaigns/' + encodeURIComponent(campaign.campaignId) + '/claim', {}, { ...t, refreshToken: refresh });
      const body = claim?.data !== null && typeof claim?.data === 'object' ? claim.data : claim;
      const replayed = body?.replayed === true;
      const granted = body?.status === CLAIMED_STATUS || replayed || body?.success === true;
      if (!granted) {
        const note = '签到返回异常: ' + JSON.stringify(claim).slice(0, 200);
        log('error', 'Qoder[' + label + '] ' + note);
        return { ...head, ok: false, checkedIn: false, already: false, note, gained: null, credits: before };
      }
      const amount = replayed ? null : benefitAmountOf(campaign, claim);
      result = replayed
        ? { ok: true, already: true, gained: benefitAmountOf(campaign, claim), note: '今日已签到，跳过' }
        : { ok: true, already: false, gained: amount, note: amount == null ? '签到成功' : '签到成功，获得 +' + amount + ' 积分' };
    }

    let after = null;
    try { after = await queryUsage(account, t); }
    catch (error) { log('warn', 'Qoder[' + label + '] 签到后积分查询失败: ' + (error instanceof Error ? error.message : String(error))); }

    log('info', 'Qoder[' + label + '] ' + result.note);
    return {
      ...head,
      ok: result.ok,
      checkedIn: true,
      already: result.already,
      note: result.note,
      gained: result.gained,
      credits: after,
      creditsBefore: before ? before.remaining : null,
      creditsAfter: after ? after.remaining : null,
    };
  } catch (error) {
    const loginExpired = error && error.loginExpired === true;
    const note = error instanceof Error ? error.message : String(error);
    log('error', 'Qoder[' + label + '] 签到失败: ' + note);
    return { ...head, ok: false, checkedIn: false, already: false, note, loginExpired, gained: null, credits: null };
  }
}

// ---------------------------------------------------------------------------
// ⑦ PAT 到期状态：用户在首次启用时录入 qoderPatExpiresAt；临期 / 过期用于面板提醒与日志。
//    接受 ISO 字符串或 YYYY-MM-DD；无法解析时返回 null（面板不显示提醒）。
// ---------------------------------------------------------------------------
export function patExpiryStatus(raw, expiringDays = 7, nowMs = Date.now()) {
  const ms = typeof raw === 'number' && Number.isFinite(raw) ? raw : Date.parse(String(raw ?? ''));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const daysLeft = Math.ceil((ms - nowMs) / 86400000);
  const expired = ms <= nowMs;
  return {
    patExpiresAt: new Date(ms).toISOString(),
    patDaysLeft: daysLeft,
    patExpired: expired,
    patExpiringSoon: !expired && daysLeft <= Math.max(0, expiringDays),
  };
}

export async function runQoderCheckin(opts = {}) {
  const log = opts.log || (() => {});
  const accounts = await discoverAccounts(opts);
  const results = [];
  for (const account of accounts) {
    results.push(await checkinOne(account, opts));
  }
  const allOk = results.length > 0 && results.every((item) => item.ok);
  const allSkipped = allOk && results.every((item) => item.already);
  const head = results[0];
  const patStatus = patExpiryStatus(opts.patExpiresAt, opts.patExpiringDays);
  if (patStatus?.patExpired) log('error', 'Qoder PAT 已到期（' + patStatus.patExpiresAt + '），请更新令牌');
  else if (patStatus?.patExpiringSoon) log('warn', 'Qoder PAT 临近到期：剩约 ' + patStatus.patDaysLeft + ' 天（' + patStatus.patExpiresAt + '），请及时更新令牌');
  return {
    ok: allOk,
    checkedIn: allOk,
    already: allSkipped,
    loginExpired: results.some((item) => item.loginExpired === true),
    ...(patStatus ?? {}),
    note: results.length === 1 ? results[0].note
      : 'Qoder ' + results.filter((item) => item.ok).length + '/' + results.length + '：'
        + results.map((item) => (item.name || item.uid) + ' ' + item.note).join('；'),
    results,
    accounts: results.map(({ uid, name, edition }) => ({ uid, name, edition })),
    credits: head ? head.credits : null,
    creditsBefore: head ? head.creditsBefore : null,
    creditsAfter: head ? head.creditsAfter : null,
    gained: head ? head.gained : null,
    accountName: head ? head.name : '',
    edition: head ? head.edition : '',
  };
}
