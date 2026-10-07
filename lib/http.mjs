// 三个平台共用的 HTTP 契约。
//
// 抽出来的原因：Trae / Qoder / WorkBuddy 此前各自复制了一份 postJson / requestJson，
// 重试判定、返回形状、超时与跳转策略四次漂移（4xx 盲重试、单次 fetch 无重试、
// 401 重换额度记账不一致）。这里只保留一条实现，适配器各自把自己那份返回形状映射出去。
//
// 统一保证：
//   * redirect: 'error' —— 跨源 3xx 不得带着凭据头 / 请求体转到新源；
//   * 只重试瞬时故障（网络异常、5xx、429），其余 4xx 立即返回给调用方；
//   * 退避 = retryDelayMs 的 ±20% 抖动，响应带 Retry-After 时改用该值（上限 60s）；
//   * 每次尝试都能重新生成 headers（401 重换短期令牌后必须带新 token）；
//   * 外部 AbortSignal（插件卸载）与超时信号合并，dispose 后在飞请求立即中止。
export const RETRY_TIMES = 2;
export const RETRY_DELAY_MS = 5000;
export const REQ_TIMEOUT_MS = 20000;
export const EXPIRING_WINDOW_MS = 3 * 86400000;

// 退避抖动比例与 Retry-After 上限：避免多平台同时失败时整齐重试打崩上游。
const JITTER_RATIO = 0.2;
const MAX_RETRY_AFTER_MS = 60000;

export const defaults = {
  retryTimes: RETRY_TIMES,
  retryDelayMs: RETRY_DELAY_MS,
  reqTimeoutMs: REQ_TIMEOUT_MS,
  expiringWindowMs: EXPIRING_WINDOW_MS,
};

// 运行时可调项：缺省等于上面的常量，由 index.mjs 的 Config 覆盖。
// signal 由 apply 注入（插件卸载时中止在飞请求），不属于用户配置。
export function tunables(options = {}) {
  return {
    retryTimes: Number.isInteger(options.retryTimes) && options.retryTimes >= 0 ? options.retryTimes : RETRY_TIMES,
    retryDelayMs: Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : RETRY_DELAY_MS,
    reqTimeoutMs: Number.isFinite(options.reqTimeoutMs) && options.reqTimeoutMs > 0 ? options.reqTimeoutMs : REQ_TIMEOUT_MS,
    expiringWindowMs: Number.isFinite(options.expiringWindowMs) && options.expiringWindowMs > 0 ? options.expiringWindowMs : EXPIRING_WINDOW_MS,
    signal: options.signal,
  };
}

export function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientStatus(status) {
  return status >= 500 || status === 429;
}

// Retry-After 支持秒数与 HTTP 日期两种写法（RFC 9110）。解析不出来返回 0。
export function retryAfterMs(response) {
  const headers = response && response.headers;
  if (!headers || typeof headers.get !== 'function') return 0;
  const raw = headers.get('retry-after');
  if (typeof raw !== 'string' || raw.trim() === '') return 0;
  const value = raw.trim();
  if (/^[0-9]+$/u.test(value)) return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return 0;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

// 退避时长：优先 Retry-After，否则 retryDelayMs 加 ±20% 抖动。
export function backoffMs(retryDelayMs, attempt, retryAfter, random = Math.random) {
  if (retryAfter > 0) return retryAfter;
  const base = Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : RETRY_DELAY_MS;
  if (base === 0) return 0;
  const factor = 1 - JITTER_RATIO + random() * JITTER_RATIO * 2;
  return Math.round(base * factor);
}

function messageOf(error) {
  if (error instanceof Error) return error.name === 'TimeoutError' || error.name === 'AbortError' ? '请求超时或已中止（' + error.name + '）' : error.message;
  return String(error);
}

// 超时信号与外部信号合并：Node 22.19+ 提供 AbortSignal.any。
function signalFor(timeoutMs, external) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external || typeof AbortSignal.any !== 'function') return timeout;
  return AbortSignal.any([external, timeout]);
}

/**
 * 发一次带重试的请求，返回统一形状。
 *
 * @param {string} url
 * @param {() => object} init 每次尝试都会调用，用于生成 headers / body。
 * @param {object} [options] tunables 全字段，外加：
 *   refresh?: () => Promise<void>  401/403 时调用一次（重换短期令牌），成功后重试且只重换一次
 *   random?: () => number          抖动随机源（测试注入）
 * @returns {Promise<{status:number,text:string,error:string|null}>}
 *   status=0 表示网络层失败且重试预算耗尽；error 非空表示本次尝试已彻底失败。
 */
export async function requestText(url, init, options = {}) {
  const t = tunables(options);
  const random = typeof options.random === 'function' ? options.random : Math.random;
  let attempt = 0;
  let refreshed = false;
  let lastError = '';
  for (;;) {
    let response;
    try {
      response = await fetch(url, {
        ...init(),
        // 不跟随跳转：跨源 3xx 会带着凭据头与请求体一起转到新源。
        redirect: 'error',
        signal: signalFor(t.reqTimeoutMs, t.signal),
      });
    } catch (error) {
      lastError = messageOf(error);
      if (attempt < t.retryTimes) {
        attempt += 1;
        await sleep(backoffMs(t.retryDelayMs, attempt, 0, random));
        continue;
      }
      return { status: 0, text: '', error: lastError };
    }

    // 短期令牌过期：重换一次再试。重换只允许发生一次，且占用一次尝试额度——
    // 旧实现里 401 分支不记账，预算足够时能多跑一轮（已修正）。
    if ((response.status === 401 || response.status === 403) && typeof options.refresh === 'function' && !refreshed) {
      refreshed = true;
      attempt += 1;
      try {
        await options.refresh();
      } catch (error) {
        lastError = messageOf(error);
      }
      continue;
    }

    if (isTransientStatus(response.status)) {
      const text = await response.text().catch(() => '');
      lastError = 'HTTP ' + response.status + (text === '' ? '' : ': ' + text.slice(0, 200));
      if (attempt < t.retryTimes) {
        const retryAfter = retryAfterMs(response);
        attempt += 1;
        await sleep(backoffMs(t.retryDelayMs, attempt, retryAfter, random));
        continue;
      }
      return { status: response.status, text, error: lastError };
    }

    const text = await response.text().catch(() => '');
    return { status: response.status, text, error: null };
  }
}