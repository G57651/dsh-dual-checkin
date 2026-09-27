// WorkBuddy 一键签到。凭据只读本机 workbuddy-desktop.info，
// 解密方式对齐 dsh-buddy-checkin v0.2.0：明文 JWT 直接用，
// $wbEncrypted 信封则拉起本机 WorkBuddy Electron 取 at-rest key 后 AES-256-GCM 解开。
// 不读取 WORKBUDDY / WORKBUDDY_ACCESS_TOKEN / WORKBUDDY_UID，也不把 token 落盘。
import { execFile } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
const RESOURCE_PATH = '/v2/billing/meter/get-user-resource';
const RESOURCE_BODY = { PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3] };
const EXPIRING_WINDOW_MS = 3 * 86400000;
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
    if (!executable(configured)) throw new Error('WORKBUDDY_ELECTRON_BIN 指定的 Electron 不可执行：' + configured);
    return configured;
  }
  if (platform !== 'darwin') throw new Error('此平台没有默认 WorkBuddy Electron 路径，请设置 WORKBUDDY_ELECTRON_BIN');
  if (!executable(MACOS_ELECTRON)) throw new Error('未找到 WorkBuddy Electron：' + MACOS_ELECTRON);
  return MACOS_ELECTRON;
}

function spawnPayload(electronPath) {
  return new Promise((resolve, reject) => {
    execFile(electronPath, ['-e', HELPER], {
      timeout: 10000,
      maxBuffer: 1048576,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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

function candidateOf(name, raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const account = raw.account || {};
  const auth = raw.auth || {};
  const uid = text(account.uid);
  const domain = text(auth.domain);
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
  for (const list of grouped) {
    const credential = resolveUid(list, key);
    if (credential && !seen.has(credential.uid)) {
      seen.add(credential.uid);
      found.push(credential);
    }
  }
  return found;
}

async function postJson(account, urlPath, body) {
  const response = await fetch('https://' + account.domain + urlPath, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + account.accessToken,
      'content-type': 'application/json',
      'x-user-id': account.uid,
      'x-domain': account.domain,
      'user-agent': 'WorkBuddyCheckin/local',
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20000),
  });
  const textBody = await response.text();
  let json = {};
  try { json = JSON.parse(textBody); } catch { json = { raw: textBody.slice(0, 300) }; }
  return { status: response.status, json, text: textBody };
}

function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseDateMs(raw) {
  if (typeof raw === 'number' && raw > 0) return raw;
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
async function queryCredits(account) {
  const { status, json } = await postJson(account, RESOURCE_PATH, RESOURCE_BODY);
  const accounts = json?.data?.Response?.Data?.Accounts;
  if (status !== 200 || !Array.isArray(accounts)) return null;
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
    const expiryMs = monthly ? cycleEndMs : expiresAtMs;
    if (expiryMs !== undefined && expiryMs > now && expiryMs - now <= EXPIRING_WINDOW_MS) {
      expiring += remain;
    }
  }
  return { remaining: Math.round(remaining * 1e4) / 1e4, used: Math.round(used * 1e4) / 1e4, expiring: Math.round(expiring * 1e4) / 1e4 };
}

export { queryCredits };

export async function runWorkbuddyCheckin(opts = {}) {
  const log = opts.log || (() => {});
  const accounts = await discoverAccounts(opts);
  if (accounts.length === 0) {
    return { ok: false, checkedIn: false, note: '未找到本机 WorkBuddy 登录数据', results: [] };
  }
  const results = [];
  for (const account of accounts) {
    const label = account.nickname || account.uid;
    log('info', 'WorkBuddy[' + label + '] uid=' + account.uid + ' domain=' + account.domain);
    try {
      const before = await queryCredits(account).catch(() => null);

      // 先查活动状态（无副作用）：today_checked_in 是权威签到状态，
      // 避免直接 claim 撞上 HTTP 400 code=10001（今天已签到）。
      let already = false;
      let statusNote = '';
      try {
        const statusResp = await postJson(account, CHECKIN_STATUS_PATH, {});
        const data = statusResp.json && typeof statusResp.json.data === 'object' && statusResp.json.data !== null ? statusResp.json.data : null;
        already = data?.today_checked_in === true;
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
        const claim = await postJson(account, CHECKIN_PATH, {});
        const message = String(claim.json?.msg || claim.json?.message || '');
        const code = claim.json?.code;
        if (claim.status === 200 && code === 0) {
          ok = true;
          gained = typeof claim.json?.data?.credit === 'number' ? claim.json.data.credit : null;
        } else if (message.includes('已签到') || claim.text.toLowerCase().includes('already') || code === 10001) {
          // 与状态查询竞态的兜底：上游按天幂等，视为已签到。
          ok = true;
          alreadyFlag = true;
        } else {
          note = '签到失败 ' + claim.status + ' ' + message + (statusNote ? '；' + statusNote : '');
        }
      }
      const after = await queryCredits(account).catch(() => null);
      if (note === undefined) {
        note = alreadyFlag ? '今日已签到，跳过' : (ok ? (gained == null ? '签到成功' : '签到成功，获得 +' + gained + ' 积分') : '签到失败');
      }
      log(ok ? 'info' : 'error', 'WorkBuddy[' + label + '] ' + note);
      results.push({ uid: account.uid, nickname: account.nickname || '', ok, checkedIn: ok, already: alreadyFlag, note, before: before ? before.remaining : null, after: after ? after.remaining : null, gained, credits: after });
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      log('error', 'WorkBuddy[' + label + '] ' + note);
      results.push({ uid: account.uid, nickname: account.nickname || '', ok: false, checkedIn: false, already: false, note, before: null, after: null, gained: null, credits: null });
    }
  }
  const head = results[0];
  const allOk = results.length > 0 && results.every((item) => item.ok);
  const allSkipped = allOk && results.every((item) => item.already);
  // 备注与 Trae 一致：全部已签到 → 「今日已签到，跳过」；单账号直接用其备注；
  // 多账号聚合时把各账号本次获得的积分求和后随备注带上。
  const gainedTotal = results.reduce((sum, item) => sum + (item.gained ?? 0), 0);
  const anyGained = results.some((item) => item.gained != null);
  const note = allSkipped ? '今日已签到，跳过'
    : results.length === 1 ? results[0].note
      : 'WorkBuddy ' + results.filter((item) => item.ok).length + '/' + results.length + (anyGained ? '，获得 +' + gainedTotal + ' 积分' : '');
  return { ok: allOk, checkedIn: allOk, note, results, credits: head ? head.credits : null, creditsBefore: head ? head.before : null, creditsAfter: head ? head.after : null, gained: head ? head.gained : null };
}
