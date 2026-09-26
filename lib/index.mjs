// 统一签到入口：Trae 与 WorkBuddy 各自读本机登录数据，并行执行，互不阻塞。
// 不读取青龙环境变量里的 token / uid / 账号配置。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCheckin as runTrae } from './trae.mjs';
import { runWorkbuddyCheckin as runWorkbuddy } from './workbuddy.mjs';

const name = 'dsh-dual-checkin';
const inject = ['webServer'];

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
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
  await rename(tmp, file);
}

async function runOnce(platform, runner, log) {
  const day = today();
  const previous = await loadState(platform);
  if (previous && previous.day === day && previous.ok === true) {
    return previous.checkedAt ? previous : { ...previous, checkedAt: new Date().toISOString() };
  }
  try {
    const result = await runner({ log });
    const saved = { day, checkedAt: new Date().toISOString(), ...result };
    await saveState(platform, saved);
    return saved;
  } catch (error) {
    const failed = { day, checkedAt: new Date().toISOString(), platform, ok: false, note: error instanceof Error ? error.message : String(error), results: [] };
    await saveState(platform, failed).catch(() => {});
    return failed;
  }
}

// 同平台并发调用共享同一个 promise：防启动跑与 GET 竞态重复执行。
const running = new Map();
function once(platform, runner, log) {
  if (running.has(platform)) return running.get(platform);
  const p = runOnce(platform, runner, log).finally(() => running.delete(platform));
  running.set(platform, p);
  return p;
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

function apply(ctx) {
  const log = (level, message) => {
    const logger = ctx.logger;
    if (!logger) return;
    if (level === 'error' && logger.error) logger.error(message);
    else if (level === 'warn' && logger.warn) logger.warn(message);
    else if (logger.info) logger.info(message);
  };
  const runners = {
    trae: (opts) => runTrae(opts),
    workbuddy: (opts) => runWorkbuddy(opts),
  };
  const startup = Promise.allSettled([
    once('trae', runners.trae, log),
    once('workbuddy', runners.workbuddy, log),
  ]).then((settled) => ({
    trae: settled[0].status === 'fulfilled' ? settled[0].value : { ok: false, note: String(settled[0].reason) },
    workbuddy: settled[1].status === 'fulfilled' ? settled[1].value : { ok: false, note: String(settled[1].reason) },
  }));

  ctx.inject(['webServer'], (web) => web.effect(() => {
    const dispose = web.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-dual-checkin/status',
      handler: async (req, res) => {
        if (!trusted(req)) { json(res, 403, { error: 'forbidden' }); return; }
        if (req.method === 'GET') {
          // 非强制 once()：当日已完成时只读状态文件（无网络请求），保证返回最新磁盘状态。
          const [trae, workbuddy] = await Promise.allSettled([
            once('trae', runners.trae, log),
            once('workbuddy', runners.workbuddy, log),
          ]);
          json(res, 200, {
            trae: trae.status === 'fulfilled' ? trae.value : { ok: false, note: String(trae.reason) },
            workbuddy: workbuddy.status === 'fulfilled' ? workbuddy.value : { ok: false, note: String(workbuddy.reason) },
          });
          return;
        }
        if (req.method === 'POST') {
          // 仅重跑一次两个平台（当日已签到的平台短路跳过）；无手动单平台强制签到。
          const [trae, workbuddy] = await Promise.allSettled([
            once('trae', runners.trae, log),
            once('workbuddy', runners.workbuddy, log),
          ]);
          json(res, 200, {
            trae: trae.status === 'fulfilled' ? trae.value : { ok: false, note: String(trae.reason) },
            workbuddy: workbuddy.status === 'fulfilled' ? workbuddy.value : { ok: false, note: String(workbuddy.reason) },
          });
          return;
        }
        json(res, 405, { error: 'method not allowed' });
      },
    });
    return () => dispose();
  }, 'dsh-dual-checkin: status'));
}

export { apply, inject, name, once, stateFile, today };
