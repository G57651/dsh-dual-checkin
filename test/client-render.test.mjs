// 回归：客户端渲染结果（1.3.9 接线）。
// 覆盖此前「只产出数据、从未上屏」的三块：多账号明细、签到前后对比、到期提醒；
// 以及 P1-11（侧栏图标用官方 usePanelInfo 读自己的选中态）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// useState 换成「按 hook 序号持久化」的版本：首屏 effect 里 setData 之后重渲染才能看到真实数据。
let cells = [];
let cursor = 0;
const react = {
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
  useState(init) {
    const index = cursor += 1;
    if (!(index - 1 in cells)) cells[index - 1] = typeof init === 'function' ? init() : init;
    return [cells[index - 1], (next) => { cells[index - 1] = typeof next === 'function' ? next(cells[index - 1]) : next; }];
  },
  useCallback(fn) { return fn; },
  useEffect(fn) { fn(); },
};

let bundle;
globalThis.window = {
  __ModuleLoader__: { load(spec) { bundle = spec.factory((id) => {
    if (id === 'react') return react;
    throw new Error('unexpected require: ' + id);
  }); } },
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove() {} }),
  head: { appendChild() {} },
};

const payloads = [];
let nextPayload = {};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => nextPayload });

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
new Function(source)();

const registered = [];
bundle.apply({
  effect(fn) { const dispose = fn(); return dispose; },
  locale: { register() {}, bind: () => (key) => key },
  slots: { inject(_name, fn) { fn(); }, register(meta, component) { registered.push({ meta, component }); } },
});

const main = registered.find((item) => item.meta.name === 'main').component;
const icon = registered.find((item) => item.meta.name === 'sidebar.panellist').component;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// 把元素树摊平成文本（函数组件就地展开；Ticket / Pill 都不含 hook）。
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { for (const item of node) texts(item, out); return out; }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (typeof node !== 'object') return out;
  if (typeof node.type === 'function') return texts(node.type(node.props), out);
  return texts(node.children, out);
}
function all(node, pred, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { for (const item of node) all(item, pred, out); return out; }
  if (typeof node !== 'object') return out;
  if (typeof node.type === 'function') return all(node.type(node.props), pred, out);
  if (pred(node)) out.push(node);
  return all(node.children, pred, out);
}

let tree;
// 每次渲染前重置 hook 游标。
const render = () => { cursor = 0; return main({ t: (key) => key }); };

async function renderWith(payload) {
  nextPayload = payload;
  cells = [];
  tree = render();
  await tick();
  tree = render(); // setData 之后重渲染
  payloads.push(payload);
  return tree;
}

test('多账号：逐账号明细上屏（此前只显示首个账号）', async () => {
  await renderWith({
    workbuddy: {
      ok: false,
      note: 'WorkBuddy 1/2',
      results: [
        { uid: 'U1', nickname: '账号甲', ok: true, gained: 30 },
        { uid: 'U2', nickname: '', ok: false, gained: null },
      ],
    },
  });
  const body = texts(tree).join(' | ');
  assert.match(body, /accounts/u, '应出现账号明细标题');
  assert.match(body, /账号甲/u);
  assert.match(body, /\+30/u);
  assert.match(body, /U2/u, '昵称缺失时退回 uid');
  assert.match(body, /notSignedIn/u);
});

test('单账号不渲染账号明细（避免与汇总行重复）', async () => {
  await renderWith({ workbuddy: { ok: true, results: [{ uid: 'U1', nickname: '甲', ok: true, gained: 30 }] } });
  assert.equal(texts(tree).includes('accounts'), false);
});

test('签到前后对比上屏（且仅在真的发生变化时显示）', async () => {
  await renderWith({ trae: { ok: true, checkedIn: true, gained: 300, credits: { remaining: 900, used: 100, expiring: 0 }, creditsBefore: 600, creditsAfter: 900 } });
  const body = texts(tree).join(' | ');
  assert.match(body, /creditsBeforeAfter/u);
  assert.match(body, /600 → 900/u);

  await renderWith({ trae: { ok: true, checkedIn: true, gained: 0, credits: { remaining: 600, used: 100, expiring: 0 }, creditsBefore: 600, creditsAfter: 600 } });
  assert.equal(texts(tree).includes('creditsBeforeAfter'), false, '前后相同就没有对比可看');
});

test('积分到期提醒上屏（expiringAlert 此前零引用）', async () => {
  await renderWith({ trae: { ok: true, credits: { remaining: 900, used: 100, expiring: 250 } } });
  const alerts = all(tree, (node) => String(node.props.className || '').includes('dcc-tk-alert'));
  assert.equal(alerts.length, 1);
  assert.match(texts(alerts[0]).join(''), /expiringAlert/u);

  await renderWith({ trae: { ok: true, credits: { remaining: 900, used: 100, expiring: 0 } } });
  assert.equal(all(tree, (node) => String(node.props.className || '').includes('dcc-tk-alert')).length, 0);
});

test('P1-11：侧栏图标用 usePanelInfo 读自己的选中态', () => {
  const active = icon({ size: 18, usePanelInfo: (select) => select({ activePanelId: 'dual-checkin' }) });
  assert.equal(active.props.className, 'dcc-icon on');
  assert.equal(active.props['aria-current'], 'page');

  const other = icon({ size: 18, usePanelInfo: (select) => select({ activePanelId: 'something-else' }) });
  assert.equal(other.props.className, 'dcc-icon');
  assert.equal(other.props['aria-current'], undefined);

  // 框架没注入该 prop 时退回未选中，不得抛错。
  const missing = icon({ size: 18 });
  assert.equal(missing.props.className, 'dcc-icon');
  assert.equal(missing.props['aria-current'], undefined);
});