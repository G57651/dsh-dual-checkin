// dsh-trae-checkin — Trae (TRAE SOLO CN) 一键自动签到
//
// 身份校验：复用本机「已登录的 Trae 桌面 App / CLI」持久化登录数据，
//   * 不读取、不写人任何环境变量（不用 TRAE_TOKEN）；
//   * 不把解密出的 JWT 落盘或持久化到 DSH settings —— 只在进程内内存中使用。
//
// 凭据来源（按序探测，命中第一个即可）：
//   1) 桌面 App：~/Library/Application Support/{Trae CN | Trae | TRAE SOLO CN | TRAE SOLO}/User/globalStorage/storage.json
//   2) CLI dotfile：~/.trae-cn/trae-jwt-token 或 ~/.trae/trae-jwt-token
//
// 解密算法与 dsh-connect-trae 的 decrypt.ts 完全一致（盐表 XOR + SHA512 派生 + AES-128-CBC），
// 因此能在不依赖、不修改该插件的前提下，独立复用同一份本机登录数据。
import { createHash, createDecipheriv } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';

const API = 'https://api.trae.cn';

const ENDPOINTS = {
  claim: '/trae/api/v2/ug/checkin_credits/claim',
  status: '/trae/api/v2/ug/checkin_credits/status',
  usage: '/trae/api/v2/pay/web_user_ent_usage',
};

const RETRY_TIMES = 2;
const RETRY_DELAY_MS = 5000;
const REQ_TIMEOUT_MS = 20000;
const EXPIRING_WINDOW_MS = 3 * 86400000;
// 运行时可调项：缺省等于上面的常量，由 index.mjs 的 Config 覆盖（不再改动硬编码常量）。
function tunables(options = {}) {
  return {
    retryTimes: Number.isInteger(options.retryTimes) && options.retryTimes >= 0 ? options.retryTimes : RETRY_TIMES,
    retryDelayMs: Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : RETRY_DELAY_MS,
    reqTimeoutMs: Number.isFinite(options.reqTimeoutMs) && options.reqTimeoutMs > 0 ? options.reqTimeoutMs : REQ_TIMEOUT_MS,
    expiringWindowMs: Number.isFinite(options.expiringWindowMs) && options.expiringWindowMs > 0 ? options.expiringWindowMs : EXPIRING_WINDOW_MS,
  };
}
export const defaults = { retryTimes: RETRY_TIMES, retryDelayMs: RETRY_DELAY_MS, reqTimeoutMs: REQ_TIMEOUT_MS, expiringWindowMs: EXPIRING_WINDOW_MS };

// ---------------------------------------------------------------------------
// 1) 本机凭据发现（与 dsh-connect-trae 同源，但独立实现、只读）
// ---------------------------------------------------------------------------
const APP_NAMES = {
  cn: 'Trae CN',
  sg: 'Trae',
  solo: 'TRAE SOLO CN',
  'solo-sg': 'TRAE SOLO',
};

// 桌面版 storage.json 候选（按 edition 优先级：solo → cn → sg）
function desktopCandidates(platform = process.platform, home = homedir(), env = process.env) {
  const editionOrder = ['solo', 'cn', 'sg', 'solo-sg'];
  if (platform === 'darwin') {
    const root = join(home, 'Library', 'Application Support');
    return editionOrder.map((edition) => ({
      edition,
      source: 'desktop',
      path: join(root, APP_NAMES[edition], 'User', 'globalStorage', 'storage.json'),
    }));
  }
  if (platform === 'win32') {
    const roots = [env.APPDATA, join(home, 'AppData', 'Roaming')].filter((v, i, a) => typeof v === 'string' && v !== '' && a.indexOf(v) === i);
    return editionOrder.flatMap((edition) => roots.map((root) => ({
      edition,
      source: 'desktop',
      path: join(root, APP_NAMES[edition], 'User', 'globalStorage', 'storage.json'),
    })));
  }
  const roots = [env.XDG_CONFIG_HOME || join(home, '.config')];
  return editionOrder.flatMap((edition) => roots.map((root) => ({
    edition,
    source: 'desktop',
    path: join(root, APP_NAMES[edition], 'User', 'globalStorage', 'storage.json'),
  })));
}

// CLI dotfile 候选
const CLI_HOME_NAMES = ['.trae-cn', '.trae'];
function cliCandidates(home = homedir()) {
  return CLI_HOME_NAMES.map((name) => ({
    edition: name === '.trae-cn' ? 'solo' : 'sg',
    source: 'cli',
    path: join(home, name, 'trae-jwt-token'),
  }));
}

// ---------------------------------------------------------------------------
// 2) storage.json 里的加密信封解密（忠实复刻 dsh-connect-trae 的 decrypt.ts）
// ---------------------------------------------------------------------------
const TRAE_AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide';

const SALT_A = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const SALT_B = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const SALT_C = Uint8Array.from([191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209]);
const SALT_D = Uint8Array.from([246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170]);

function xor(a, b) {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)));
}

function encryptionType(header) {
  if (header.equals(Buffer.from([116, 99, 5, 16, 0, 0]))) return 'aes';
  if (header.equals(Buffer.from([18, 57, 32, 32, 2, 3]))) return 'aes-private';
  throw new Error('unsupported Trae auth encryption header');
}

function decryptTraeStorageValue(encoded) {
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length <= 102) throw new Error('Trae auth ciphertext is too short');
  const type = encryptionType(buffer.subarray(0, 6));
  const random = buffer.subarray(6, 38);
  const encrypted = buffer.subarray(38);
  const salt = type === 'aes-private' ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B);
  const first = createHash('sha512').update(random).digest();
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest();
  const decipher = createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (decrypted.length < 64) throw new Error('Trae auth plaintext is too short');
  const expected = decrypted.subarray(0, 64);
  const plaintext = decrypted.subarray(64);
  const actual = createHash('sha512').update(plaintext).digest();
  if (!expected.equals(actual)) throw new Error('Trae auth integrity check failed');
  return plaintext.toString('utf8');
}

function parseTraeAuthValue(value) {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error('Trae auth value is empty');
  const plaintext = trimmed.startsWith('{') ? trimmed : decryptTraeStorageValue(trimmed);
  return JSON.parse(plaintext);
}

// ---------------------------------------------------------------------------
// 3) 从候选路径里解析出可用凭据（token / userId / deviceId）
// ---------------------------------------------------------------------------
function optionalString(v) { return typeof v === 'string' && v !== '' ? v : undefined; }

function deviceCenterId(storage) {
  const prefix = 'iCubeAuthInfo://icube-dc:';
  const ids = Object.keys(storage)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .filter(Boolean);
  return ids.length === 1 ? ids[0] : undefined;
}

async function readDesktopCredential(candidate) {
  const storage = JSON.parse(await readFile(candidate.path, 'utf8'));
  const value = storage[TRAE_AUTH_STORAGE_KEY];
  if (typeof value !== 'string') throw new Error('storage document has no ' + TRAE_AUTH_STORAGE_KEY);
  const auth = parseTraeAuthValue(value);
  const token = optionalString(auth.token) ?? optionalString(auth.accessToken);
  if (!token) throw new Error('Trae auth has no access token');

  // device-id：优先 deviceCenterId，其次 telemetry.devDeviceId / telemetry.machineId 的 sha256 前 32 位
  let deviceId = optionalString(deviceCenterId(storage));
  if (!deviceId) deviceId = optionalString(storage['telemetry.devDeviceId']);
  if (!deviceId) {
    const machineId = optionalString(storage['telemetry.machineId']);
    if (machineId) {
      deviceId = createHash('sha256').update(machineId).digest('hex').slice(0, 32);
    }
  }

  const userRegion = (auth.userRegion && typeof auth.userRegion === 'object') ? auth.userRegion.region : auth.userRegion;
  return {
    token,
    userId: optionalString(auth.userId) ?? '',
    userRegion: optionalString(userRegion) ?? 'CN',
    deviceId: deviceId ?? '',
    edition: candidate.edition,
    source: candidate.source,
    accountName: optionalString((auth.account && typeof auth.account === 'object') ? auth.account.username : undefined) ?? '',
  };
}

function parseCliToken(text) {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('Trae CLI token file is empty');
  let token = trimmed;
  if (trimmed.startsWith('{')) {
    const envelope = JSON.parse(trimmed);
    const candidate = envelope.token ?? envelope.accessToken ?? envelope.jwt;
    if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error('Trae CLI token document has no token field');
    token = candidate.trim();
  }
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((s) => s === '')) throw new Error('Trae CLI token is not a three-part JWT');
  return { token };
}

async function readCliCredential(candidate) {
  const { token } = parseCliToken(await readFile(candidate.path, 'utf8'));
  return {
    token,
    userId: '',
    userRegion: 'CN',
    deviceId: '',
    edition: candidate.edition,
    source: candidate.source,
    accountName: '',
  };
}

async function discoverCredential({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const candidates = [...desktopCandidates(platform, home, env), ...cliCandidates(home)];
  let lastError;
  let anyPresent = false;
  for (const candidate of candidates) {
    try {
      if (candidate.source === 'desktop') return await readDesktopCredential(candidate);
      return await readCliCredential(candidate);
    } catch (error) {
      lastError = error;
      if (!(error && error.code === 'ENOENT')) anyPresent = true;
    }
  }
  const tried = candidates.map((c) => c.path).join(' 或 ');
  if (!anyPresent) throw new Error('未找到本机 Trae 登录数据（请先在 Trae 桌面 App / CLI 登录一次）：' + tried);
  throw lastError instanceof Error ? lastError : new Error('Trae 登录数据解析失败：' + tried);
}

// ---------------------------------------------------------------------------
// 4) 请求（等价原脚本 _headers / post_json，device-id 复用本机身份而非抓包手动填）
// ---------------------------------------------------------------------------
function randomHex() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
  let out = '';
  for (let k = 0; k < 32; k++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

function buildHeaders(cred) {
  const h = {
    authorization: 'Cloud-IDE-JWT ' + cred.token,
    'content-type': 'application/json',
    'user-agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    'x-user-region': cred.userRegion || 'CN',
    'package-type': 'stable_cn',
    'x-lscbd-aid': '787976',
    'x-lscbd-platform': 'windows',
    'app-version': '0.1.51',
    accept: '*/*',
    'x-request-id': randomHex(),
    'x-device-brand': 'To be filled by O.E.M.',
    'x-device-type': 'windows',
    'x-lgw-req-sdk-type': '3',
  };
  if (cred.deviceId) h['x-device-id'] = cred.deviceId;
  return h;
}

async function postJson(cred, urlPath, body, { retryTimes, retryDelayMs, reqTimeoutMs } = {}) {
  const url = API + urlPath;
  const attempts = retryTimes == null ? RETRY_TIMES : retryTimes;
  const delayMs = retryDelayMs == null ? RETRY_DELAY_MS : retryDelayMs;
  const timeoutMs = reqTimeoutMs == null ? REQ_TIMEOUT_MS : reqTimeoutMs;
  let last = null;
  for (let i = 0; i <= attempts; i++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(cred),
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      last = String(e && e.message ? e.message : e);
      if (i < attempts) { await sleep(delayMs); continue; }
      break;
    }
    if (resp.status >= 400) {
      last = 'HTTP ' + resp.status + ': ' + (await resp.text().catch(() => '')).slice(0, 300);
      if (i < attempts) { await sleep(delayMs); continue; }
      break;
    }
    try { return [await resp.json(), null]; }
    catch { return [{ raw: (await resp.text().catch(() => '')).slice(0, 2000) }, null]; }
  }
  return [null, last];
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

export function decodeExp(token) {
  try {
    let part = token.split('.')[1];
    part += '='.repeat((-part.length % 4 + 4) % 4);
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return payload.exp;
  } catch { return null; }
}

function packCredits(p) {
  const base = p.entitlement_base_info || {};
  const packageQuota = ((base.product_extra || {}).package_extra || {}).quota || {};
  const quotaLimit = base.quota || {};
  const limit = typeof packageQuota.credits_limit === 'number' ? packageQuota.credits_limit
    : typeof quotaLimit.credits_limit === 'number' ? quotaLimit.credits_limit : undefined;
  if (typeof limit !== 'number') return null;
  const used = typeof (p.usage || {}).credits_amount === 'number' ? p.usage.credits_amount : 0;
  const remain = Math.max(limit - used, 0);
  const expireRaw = typeof p.expire_time === 'number' && p.expire_time > 0 ? p.expire_time
    : typeof base.end_time === 'number' && base.end_time > 0 ? base.end_time : undefined;
  return { remain, expireMs: expireRaw != null ? expireRaw * 1000 : undefined };
}

// 权威余额取 usage_summary（总额/已消耗），到期积分按积分包 expire_time 逐包累加。
async function queryCredits(cred, options = {}) {
  const t = tunables(options);
  const [data, err] = await postJson(cred, ENDPOINTS.usage, { require_usage: true }, { reqTimeoutMs: t.reqTimeoutMs, retryDelayMs: t.retryDelayMs });
  if (err || data == null) return null;
  const summary = data.usage_summary || {};
  const total = typeof summary.total_amount === 'number' ? summary.total_amount : null;
  const used = typeof summary.consumed_amount === 'number' ? summary.consumed_amount : null;
  let remaining = total != null && used != null ? Math.max(total - used, 0) : null;
  let expiring = 0;
  let packSum = 0;
  let anyPack = false;
  const now = Date.now();
  for (const p of data.user_entitlement_pack_list || []) {
    const pack = packCredits(p);
    if (!pack) continue;
    anyPack = true;
    packSum += pack.remain;
    if (pack.expireMs != null && pack.expireMs > now && pack.expireMs - now <= t.expiringWindowMs) {
      expiring += pack.remain;
    }
  }
  if (remaining == null && anyPack) remaining = packSum;
  return { remaining, used, total, expiring: Math.round(expiring * 1e4) / 1e4 };
}
// ---------------------------------------------------------------------------
// 5) 一键签到（等价 get_checkin_status / do_claim，幂等）
// ---------------------------------------------------------------------------
async function getCheckinStatus(cred, options) {
  const [data, err] = await postJson(cred, ENDPOINTS.status, {}, options);
  if (err) return [null, err];
  if (data == null) return [null, 'status 无返回'];
  if (data.code && data.code !== 0) return [null, 'status code=' + data.code + ': ' + (data.message || '')];
  return [data, null];
}

async function doClaim(cred, options) {
  const [data, err] = await postJson(cred, ENDPOINTS.claim, {}, options);
  if (err) return [null, err];
  if (data == null) return [null, 'claim 无返回'];
  return [data, null];
}

// 一键签到主流程：发现凭据 → 查状态（幂等）→ 必要时 claim；始终回带积分快照。
export async function runCheckin(opts = {}) {
  const log = opts.log || (() => {});
  const t = tunables(opts);
  const calls = { retryTimes: t.retryTimes, retryDelayMs: t.retryDelayMs, reqTimeoutMs: t.reqTimeoutMs };
  const cred = await discoverCredential(opts);
  log('info', '复用本机 Trae 登录数据: edition=' + cred.edition + ' source=' + cred.source + ' userId=' + (cred.userId || '(未知)'));

  // JWT 过期检测（等价 decode_exp）
  const exp = decodeExp(cred.token);
  if (exp) {
    const days = Math.floor((exp * 1000 - Date.now()) / 86400000);
    log('info', days < 0 ? '令牌已过期，请重新登录 Trae' : '令牌剩余约 ' + days + ' 天');
  }

  const [status, statusErr] = await getCheckinStatus(cred, calls);
  if (statusErr) {
    const msg = String(statusErr).toLowerCase();
    let note = '查询状态失败: ' + statusErr;
    if (msg.includes('authenticate') || msg.includes('1001')) note += '（令牌可能已过期，请重新登录 Trae）';
    return { ok: false, note, checkedIn: false, gained: null, accountName: cred.accountName, edition: cred.edition };
  }

  const checkedIn = status.checked_in === true;
  // checked_in 是账号级状态；did_checked_in 才是本设备判定（参照 dsh-connect-trae）。
  // 两者不一致说明本设备今天并未真的签过，只记录日志，不改变账号级判定。
  if (checkedIn && status.did_checked_in === false) {
    log('warn', '账号级 checked_in=true 但本设备 did_checked_in=false（可能缺 x-device-id）');
  }
  // 每日奖励 = credits + extra_credits（claim 响应不带金额，参照 dsh-connect-trae）
  const dailyReward = (typeof status.credits === 'number' ? status.credits : 0)
    + (typeof status.extra_credits === 'number' ? status.extra_credits : 0);

  if (checkedIn) {
    log('info', '今天已经签过啦，跳过');
    const credits = await queryCredits(cred, opts).catch(() => null);
    const remaining = credits ? credits.remaining : null;
    return { ok: true, note: '今日已签到，跳过', checkedIn: true, gained: null, credits, creditsBefore: remaining, creditsAfter: remaining, accountName: cred.accountName, edition: cred.edition };
  }

  const before = await queryCredits(cred, opts).catch(() => null);
  const creditsBefore = before ? before.remaining : null;
  log('info', '执行签到 claim ...');
  const [claim, claimErr] = await doClaim(cred, calls);
  if (claimErr) {
    return { ok: false, note: '签到失败: ' + claimErr, checkedIn: false, gained: null, credits: before, creditsBefore, creditsAfter: creditsBefore, accountName: cred.accountName, edition: cred.edition };
  }
  if (claim.code === 0) {
    const after = await queryCredits(cred, opts).catch(() => null);
    const creditsAfter = after ? after.remaining : null;
    const delta = creditsBefore != null && creditsAfter != null ? Math.round((creditsAfter - creditsBefore) * 1e4) / 1e4 : null;
    const gained = delta != null && delta > 0 ? delta : (dailyReward || null);
    log('info', '签到成功，获得 +' + gained + ' 积分');
    return { ok: true, note: '签到成功，获得 +' + gained + ' 积分', checkedIn: true, gained, credits: after, creditsBefore, creditsAfter, accountName: cred.accountName, edition: cred.edition };
  }
  return { ok: false, note: '签到返回异常 code=' + claim.code, checkedIn: false, gained: null, credits: before, creditsBefore, creditsAfter: creditsBefore, accountName: cred.accountName, edition: cred.edition };
}

export {
  API, ENDPOINTS, desktopCandidates, cliCandidates,
  decryptTraeStorageValue, parseTraeAuthValue, discoverCredential, queryCredits,
};
