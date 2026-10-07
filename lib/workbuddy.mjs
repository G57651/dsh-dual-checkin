// WorkBuddy 一键签到。凭据只读本机 workbuddy-desktop.info，
// 解密方式对齐 dsh-buddy-checkin v0.2.0：明文 JWT 直接用，
// $wbEncrypted 信封则拉起本机 WorkBuddy Electron 取 at-rest key 后 AES-256-GCM 解开。
// 不读取 WORKBUDDY / WORKBUDDY_ACCESS_TOKEN / WORKBUDDY_UID，也不把 token 落盘。
import { execFile } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requestText, tunables } from './http.mjs';

const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
const RESOURCE_PATH = '/v2/billing/meter/get-user-resource';
// 时间窗上限与 dsh-connect-workbuddy 一致：now + 3185136e6 ms（约 36.86 天）。
const PACKAGE_END_TIME_RANGE_MS = 3185136e6;
function formatResourceTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear().toString().padStart(4, '0') + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}
function resourceBody(now = new Date()) {
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatResourceTime(now),
    PackageEndTimeRangeEnd: formatResourceTime(new Date(now.getTime() + PACKAGE_END_TIME_RANGE_MS)),
  };
}
// 超时/重试/退避契约统一在 http.mjs（此前三个适配器各写一份，语义漂移过四次）。
export { tunables };
export { defaults } from './http.mjs';
const ELECTRON_ENV = 'WORKBUDDY_ELECTRON_BIN';
const MACOS_ELECTRON = '/Applications/WorkBuddy.app/Contents/MacOS/Electron';
const HELPER = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

function parseBase64(value, length) {
  if (typeof value !== 'string' || value === '') return undefined;
  let decoded;
  try { decoded = Buffer.from(value, 'base64'); } catch { return undefined; }
  if (decoded.length === 0) return undefined;
  if (decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined;
  return length === undefined || decoded.length === length ? decoded : undefined;
}

function parseEnvelope(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (value.$wbEncrypted !== 1 || typeof value.envelope !== 'string') return undefined;
  let inner;
  try { inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8')); }
  catch { return undefined; }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined;
  const nonce = parseBase64(inner.nonce, 12);
  const authTag = parseBase64(inner.authTag, 16);
  const ciphertext = parseBase64(inner.ciphertext);
  if (!nonce || !authTag || !ciphertext) return undefined;
  if (inner.suite !== 1 || typeof inner.keyId !== 'string' || !/^[0-9a-f]{16}$/u.test(inner.keyId)) return undefined;
  return { suite: 1, keyId: inner.keyId, nonce, authTag, ciphertext };
}

function buildAuthenticatedContextAad(keyId, suite) {
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

function openAuthField(key, envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 });
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

function parseAtRestPayload(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (parsed.version !== 1 || typeof parsed.atRestSecretKey !== 'string' || parsed.atRestSecretKey === '') return undefined;
  let decoded;
  try { decoded = Buffer.from(parsed.atRestSecretKey, 'base64'); } catch { return undefined; }
  if (decoded.length !== 32 || decoded.toString('base64') !== parsed.atRestSecretKey) return undefined;
  if (decoded.every((byte) => byte === 0)) return undefined;
  return parsed.atRestSecretKey;
}

function deriveProtectorKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest();
}
function keyIdOf(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function executable(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

export function resolveElectronPath(env = process.env, platform = process.platform) {
  const configured = env[ELECTRON_ENV];
  if (configured) {
    // 解析成真实路径并要求是常规文件：拒绝指向目录 / 设备 / 断裂软链的取值。
    let real = configured;
    try { real = realpathSync(configured); } catch { throw new Error('WORKBUDDY_ELECTRON_BIN 指定的路径不可解析：' + configured); }
    let info;
    try { info = statSync(real); } catch { throw new Error('WORKBUDDY_ELECTRON_BIN 指定的路径不存在：' + configured); }
    if (!info.isFile()) throw new Error('WORKBUDDY_ELECTRON_BIN 不是常规文件：' + configured);
    if (!executable(real)) throw new Error('WORKBUDDY_ELECTRON_BIN 指定的 Electron 不可执行：' + configured);
    return real;
  }
  if (platform !== 'darwin') throw new Error('此平台没有默认 WorkBuddy Electron 路径，请设置 WORKBUDDY_ELECTRON_BIN');
  if (!executable(MACOS_ELECTRON)) throw new Error('未找到 WorkBuddy Electron：' + MACOS_ELECTRON);
  return MACOS_ELECTRON;
}

// 子进程只继承白名单环境：不把插件进程里可能存在的 token / PAT 之类变量递给 Electron
// 这种需要执行 native binding 的第三方程序（旧实现整份 ...process.env 透传）。
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME', 'SHELL',
  'SystemRoot', 'SystemDrive', 'windir', 'PATHEXT', 'ComSpec', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'NUMBER_OF_PROCESSORS',
];

export function childEnv(source = process.env) {
  const out = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of SAFE_ENV_KEYS) {
    if (typeof source[key] === 'string') out[key] = source[key];
  }
  return out;
}

function spawnPayload(electronPath) {
  return new Promise((resolve, reject) => {
    execFile(electronPath, ['-e', HELPER], {
      timeout: 10000,
      maxBuffer: 1048576,
      windowsHide: true,
      env: childEnv(),
    }, (error, stdout) => {
      if (error) {
        reject(new Error('获取 WorkBuddy 解密密钥失败：' + (error.killed ? '超时' : (error.code ?? error.message))));
        return;
      }
      const output = String(stdout || '').trim();
      if (!output) reject(new Error('WorkBuddy Electron 没有返回解密密钥'));
      else resolve(output);
    });
  });
}

let cachedKey;

// 插件卸载时调用：丢掉缓存的解密密钥，避免旧闭包继续解本机凭据。keyId 失配时
// discoverAccounts 也会自行清缓存重取一次（见那里）。
export function resetProtectorKey() {
  cachedKey = undefined;
}

export async function protectorKey() {
  if (cachedKey) return cachedKey;
  const secret = parseAtRestPayload(await spawnPayload(resolveElectronPath()));
  if (!secret) throw new Error('WorkBuddy at-rest payload 不合法');
  const key = deriveProtectorKey(secret);
  cachedKey = { key, keyId: keyIdOf(key) };
  return cachedKey;
}

export function authDirs(platform = process.platform, env = process.env, home = homedir()) {
  const bases = platform === 'win32'
    ? [env.LOCALAPPDATA || join(home, 'AppData', 'Local'), env.APPDATA || join(home, 'AppData', 'Roaming')]
    : [platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config')];
  return [...new Set(bases.map((base) => join(base, 'CodeBuddyExtension', 'Data', 'Public', 'auth')))];
}

function text(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// 上游主机名必须锚定到官方域，且必须是「纯主机名」：auth.domain 来自本机文件，
// 直接拼进 URL 等于让该文件决定 bearer token / uid 的收件人（`evil.example`、
// `evil.example:8443`、`evil.example/path`、`user@evil.example` 都能改掉真实收件方）。
const OFFICIAL_DOMAIN = /(^|\.)(workbuddy|codebuddy)\.cn$/u;
function officialDomain(value) {
  const host = text(value);
  if (!host) return undefined;
  let url;
  try { url = new URL('https://' + host); } catch { return undefined; }
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
  return OFFICIAL_DOMAIN.test(url.hostname) ? url.hostname : undefined;
}

function candidateOf(name, raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const account = raw.account || {};
  const auth = raw.auth || {};
  const uid = text(account.uid);
  const domain = officialDomain(auth.domain);
  if (!uid || !domain) return undefined;
  const token = text(auth.accessToken);
  const tokenEnvelope = token ? undefined : parseEnvelope(auth.accessToken);
  const nickname = text(account.nickname);
  const nicknameEnvelope = nickname ? undefined : parseEnvelope(account.nickname);
  return { name, uid, domain, token, tokenEnvelope, nickname, nicknameEnvelope };
}

function resolveUid(files, key) {
  for (const file of files) {
    if (file.token) return { uid: file.uid, domain: file.domain, accessToken: file.token, nickname: file.nickname };
    if (file.tokenEnvelope && key && key.keyId === file.tokenEnvelope.keyId) {
      const token = openAuthField(key.key, file.tokenEnvelope);
      if (!token) continue;
      const nickname = file.nicknameEnvelope ? openAuthField(key.key, file.nicknameEnvelope) : undefined;
      return { uid: file.uid, domain: file.domain, accessToken: token, nickname };
    }
  }
  return undefined;
}

export async function discoverAccounts(opts = {}) {
  const dirs = opts.dirs || authDirs(opts.platform, opts.env, opts.home);
  const found = [];
  let needsKey = false;
  const grouped = [];
  for (const dir of dirs) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    const groups = new Map();
    for (const name of names) {
      if (!(name === 'workbuddy-desktop.info' || /^workbuddy-desktop\.\d{4}-/u.test(name))) continue;
      let raw = null;
      try { raw = JSON.parse(await readFile(join(dir, name), 'utf8')); } catch { continue; }
      const item = candidateOf(name, raw);
      if (!item) continue;
      if (item.tokenEnvelope) needsKey = true;
      const list = groups.get(item.uid) || [];
      list.push(item);
      groups.set(item.uid, list);
    }
    for (const list of groups.values()) list.sort((a, b) => b.name < a.name ? -1 : 1);
    grouped.push(...groups.values());
  }
  let key;
  if (needsKey) key = await (opts.keySource || protectorKey)();
  const seen = new Set();
  const collect = () => {
    for (const list of grouped) {
      const credential = resolveUid(list, key);
      if (credential && !seen.has(credential.uid)) {
        seen.add(credential.uid);
        found.push(credential);
      }
    }
  };
  collect();
  // 信封 keyId 与缓存密钥全部失配（用户重新登录过 / WorkBuddy 轮换过 at-rest 密钥）时，
  // 旧实现会一直返回 0 个账号直到进程重启；这里清缓存重取一次。
  if (needsKey && found.length === 0 && !opts.keySource) {
    resetProtectorKey();
    key = await protectorKey();
    seen.clear();
    found.length = 0;
    collect();
  }
  return found;
}

async function postJson(account, urlPath, body, options = {}) {
  const result = await requestText(`https://${account.domain}${urlPath}`, () => ({
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + account.accessToken,
      'content-type': 'application/json',
      'x-user-id': account.uid,
      'x-domain': account.domain,
      'user-agent': 'WorkBuddyCheckin/local',
    },
    body: JSON.stringify(body ?? {}),
  }), options);
  // 网络层失败、或瞬时故障（5xx/429）重试预算耗尽：按失败抛给调用方。
  if (result.status === 0 || result.error) throw new Error('请求 ' + urlPath + ' 失败: ' + (result.error || 'HTTP ' + result.status));
  // 其余 4xx 仍然把响应交回调用方解析，保持原有语义。
  let json = {};
  try { json = JSON.parse(result.text); } catch { json = { raw: result.text.slice(0, 300) }; }
  return { status: result.status, json, text: result.text };
}

function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// 只有大于 0xe8d4a51000（≈1e12，2016 年起的毫秒）的数字才当毫秒；
// 更小的正数是秒级时间戳，交给下面按字符串解析（与 dsh-connect-workbuddy 一致）。
function parseDateMs(raw) {
  if (typeof raw === 'number' && raw > 0xe8d4a51000) return raw;
  if (typeof raw === 'string' && raw !== '') {
    let parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) parsed = Date.parse(raw.replace(' ', 'T'));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

// 聚合规则对齐 dsh-connect-workbuddy：月度包（CapacityType 4）看 Cycle* 字段，
// 一次性包看 Capacity* 字段并剔除已过期/已用尽的；剩余、已用随之累加，
// 三天内到期只统计一次性包（月度包到期会刷新，不计入）。
async function queryCredits(account, options = {}) {
  const t = tunables(options);
  const { status, json } = await postJson(account, RESOURCE_PATH, resourceBody(), options);
  const accounts = json?.data?.Response?.Data?.Accounts;
  if (status !== 200) throw new Error('积分查询失败 HTTP ' + status + ': ' + String(json?.msg || json?.message || '').slice(0, 200));
  if (json?.code !== 0) throw new Error('积分查询失败 code=' + String(json?.code) + ': ' + String(json?.msg || json?.message || '').slice(0, 200));
  if (!Array.isArray(accounts)) throw new Error('积分查询响应缺少 data.Response.Data.Accounts');
  let remaining = 0;
  let used = 0;
  let expiring = 0;
  const now = Date.now();
  for (const item of accounts) {
    if (!item || typeof item !== 'object') continue;
    const monthly = numberOf(item.CapacityType) === 4;
    const remain = Math.max(monthly ? numberOf(item.CycleCapacityRemain) : numberOf(item.CapacityRemain), 0);
    const cycleEndMs = parseDateMs(item.CycleEndTime);
    const expiresAtMs = monthly ? undefined : parseDateMs(item.ExpiredTime) ?? cycleEndMs;
    if (!monthly && (remain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= now))) continue;
    remaining += remain;
    used += monthly ? numberOf(item.CycleCapacityUsed) : numberOf(item.CapacityUsed);
    const expiryMs = expiresAtMs;
    if (expiryMs !== undefined && expiryMs > now && expiryMs - now <= t.expiringWindowMs) {
      expiring += remain;
    }
  }
  return { remaining: Math.round(remaining * 1e4) / 1e4, used: Math.round(used * 1e4) / 1e4, expiring: Math.round(expiring * 1e4) / 1e4 };
}

export { queryCredits };

export async function runWorkbuddyCheckin(opts = {}) {
  const log = opts.log || (() => {});
  const t = tunables(opts);
  // 签到链路（status/claim/usage）共用同一份可调项，含 signal：插件卸载时中止在飞请求。
  const calls = t;
  const accounts = await discoverAccounts(opts);
  if (accounts.length === 0) {
    return { ok: false, checkedIn: false, note: '未找到本机 WorkBuddy 登录数据', results: [] };
  }
  // 脱敏账号快照（仅 uid/nickname/domain 与积分，不含 token）：供 TTL 到期时逐账号重查积分。
  // 多账号并行处理：每个账号各自 try/catch，互不影响；结果按下标回填，顺序稳定。
  const checkOne = async (account) => {
    const label = account.nickname || account.uid;
    // queryCredits 现在在接口异常时抛错；before 只是展示值，失败不影响签到本身。
    let before = null;
    try { before = await queryCredits(account, calls); }
    catch (error) { log('warn', 'WorkBuddy[' + label + '] 签到前积分查询失败: ' + (error instanceof Error ? error.message : String(error))); }
    log('info', 'WorkBuddy[' + label + '] uid=' + account.uid + ' domain=' + account.domain);
    try {
      // 先查活动状态（无副作用）：today_checked_in 是权威签到状态，
      // 避免直接 claim 撞上 HTTP 400 code=10001（今天已签到）。
      let already = false;
      let statusNote = '';
      // daily_credit / today_credit 是状态接口给出的当日奖励金额，用作 claim 响应缺 credit 时的兜底。
      let statusCredit = null;
      try {
        const statusResp = await postJson(account, CHECKIN_STATUS_PATH, {}, calls);
        const data = statusResp.json && typeof statusResp.json.data === 'object' && statusResp.json.data !== null ? statusResp.json.data : null;
        already = data?.today_checked_in === true;
        if (typeof data?.daily_credit === 'number') statusCredit = data.daily_credit;
        else if (typeof data?.today_credit === 'number') statusCredit = data.today_credit;
        if (statusResp.status !== 200 || statusResp.json?.code !== 0) {
          statusNote = '状态查询 ' + statusResp.status + ' ' + String(statusResp.json?.msg || '');
        }
      } catch (error) {
        statusNote = '状态查询失败: ' + (error instanceof Error ? error.message : String(error));
      }

      let ok = false;
      let alreadyFlag = already;
      let gained = null;
      let note;
      if (already) {
        ok = true;
      } else {
        const claim = await postJson(account, CHECKIN_PATH, {}, calls);
        const message = String(claim.json?.msg || claim.json?.message || '');
        const code = claim.json?.code;
        if (claim.status === 200 && code === 0) {
          ok = true;
          const claimCredit = typeof claim.json?.data?.credit === 'number' ? claim.json.data.credit : null;
          gained = claimCredit ?? statusCredit;
        } else if (message.includes('已签到') || claim.text.toLowerCase().includes('already') || code === 10001) {
          // 与状态查询竞态的兜底：上游按天幂等，视为已签到。
          ok = true;
          alreadyFlag = true;
        } else {
          note = '签到失败 ' + claim.status + ' ' + message + (statusNote ? '；' + statusNote : '');
        }
      }
      // 同上：积分快照失败只记日志，不改变签到结果。
      let after = null;
      try { after = await queryCredits(account, calls); }
      catch (error) { log('warn', 'WorkBuddy[' + label + '] 签到后积分查询失败: ' + (error instanceof Error ? error.message : String(error))); }
      if (note === undefined) {
        // 与 Trae 同一句式；仅在完全没有金额（claim 与状态接口都没有）时才省略金额。
        note = alreadyFlag ? '今日已签到，跳过'
          : ok ? (gained == null ? '签到成功' : '签到成功，获得 +' + gained + ' 积分')
            : '签到失败';
      }
      log(ok ? 'info' : 'error', 'WorkBuddy[' + label + '] ' + note);
      return {
        result: { uid: account.uid, nickname: account.nickname || '', ok, checkedIn: ok, already: alreadyFlag, note, before: before ? before.remaining : null, after: after ? after.remaining : null, gained, credits: after },
        snapshot: { uid: account.uid, nickname: account.nickname || '', domain: account.domain, credits: after },
      };
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      log('error', 'WorkBuddy[' + label + '] ' + note);
      return {
        result: { uid: account.uid, nickname: account.nickname || '', ok: false, checkedIn: false, already: false, note, before: null, after: null, gained: null, credits: null },
        snapshot: { uid: account.uid, nickname: account.nickname || '', domain: account.domain, credits: null },
      };
    }
  };
  const settled = await Promise.all(accounts.map((account) => checkOne(account)));
  const results = settled.map((slot) => slot.result);
  const accountsSnapshot = settled.map((slot) => slot.snapshot);
  const head = results[0];
  const allOk = results.length > 0 && results.every((item) => item.ok);
  const allSkipped = allOk && results.every((item) => item.already);
  // 备注与 Trae 一致：全部已签到 → 「今日已签到，跳过」；单账号直接用其备注；
  // 多账号聚合时把各账号本次获得的积分求和后随备注带上。
  const gainedTotal = results.reduce((sum, item) => sum + (item.gained ?? 0), 0);
  const anyGained = results.some((item) => item.gained != null);
  const note = allSkipped ? '今日已签到，跳过'
    : results.length === 1 ? results[0].note
      : 'WorkBuddy ' + results.filter((item) => item.ok).length + '/' + results.length
        + '，' + (anyGained ? '签到成功，获得 +' + gainedTotal + ' 积分' : '签到成功');
  const headGained = head ? head.gained : null;
  return { ok: allOk, checkedIn: allOk, note, results, accounts: accountsSnapshot, credits: head ? head.credits : null, creditsBefore: head ? head.before : null, creditsAfter: head ? head.after : null, gained: headGained };
}
