// 回归：客户端 bundle（lib/client.js）。
// 覆盖 O-11（刷新按钮必须真的发 POST——host 侧以 req.method === "POST" 判定强制重查）、
// P1-12（CSS 注入 effect 必须 return cleanup，否则热重载会堆积 <style>）、
// P1-10（可见文案走 locale 字典，不在 JSX 里硬编码中文）、P0-4（超时不得短于 host 侧最坏耗时）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const react = {
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useCallback(fn) { return fn; },
  useEffect(fn) { fn(); },
};

let bundle;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      bundle = spec.factory((id) => {
        if (id === 'react') return react;
        throw new Error('unexpected require: ' + id);
      });
    },
  },
};

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
new Function(source)();

const fetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), method: init.method, signal: init.signal });
  return { ok: true, status: 200, json: async () => ({}) };
};

let styleRemoved = 0;
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove() { styleRemoved += 1; } }),
  head: { appendChild() {} },
};

const cleanups = [];
const registered = [];
const ctx = {
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); return dispose; },
  locale: { register() {}, bind: () => (key) => key },
  slots: { inject(_name, fn) { fn(); }, register(meta, component) { registered.push({ meta, component }); } },
};
bundle.apply(ctx);

function findByType(node, type) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  return findByType(node.children, type);
}

test('bundle 导出 apply / inject / name', () => {
  assert.equal(bundle.name, 'dsh-dual-checkin-client');
  assert.deepEqual(bundle.inject, ['slots', 'locale']);
});

test('P1-12 回归：CSS 注入 effect 返回可用 cleanup', () => {
  assert.equal(cleanups.length, 1, '应当有一个带 cleanup 的 effect（locale.register 的返回值是 undefined，不入列）');
  cleanups.forEach((dispose) => dispose());
  assert.equal(styleRemoved, 1, 'cleanup 应移除注入的 <style>');
});

test('主面板与侧栏入口都已注册', () => {
  assert.ok(registered.some((item) => item.meta.name === 'main'));
  assert.ok(registered.some((item) => item.meta.name === 'sidebar.panellist'));
});

test('O-11 回归：首屏 GET，点刷新发 POST', async () => {
  const main = registered.find((item) => item.meta.name === 'main').component;
  const tree = main({ t: (key) => key });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/plugins/dsh-dual-checkin/status');
  assert.equal(fetchCalls[0].method, 'GET');

  const button = findByType(tree, 'button');
  assert.ok(button, '页脚应有刷新按钮');
  assert.equal(typeof button.props.onClick, 'function');
  button.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[1].method, 'POST', '刷新必须走 POST，否则 host 侧会当作 GET 复用快照');
});

test('P0-4 回归：客户端超时不短于 host 侧最坏耗时', () => {
  const match = source.match(/AbortSignal\.timeout\((\d+)\)/u);
  assert.ok(match, '未找到超时设置');
  assert.ok(Number(match[1]) >= 300000, `超时 ${match[1]}ms 仍可能早于 host 侧最坏耗时`);
});

test('P1-10 回归：平台清单单一来源，分母不写死', () => {
  const codeOnly = source.split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');
  assert.match(codeOnly, /const PLATFORM_KEYS = \["trae", "workbuddy", "qoder"\]/u);
  assert.equal(codeOnly.includes('"/3"'), false, '分母不得写死为 "/3"');
});

test('P1-10 回归：PAT 与状态徽标文案走字典', () => {
  for (const key of ['patExpiry', 'patExpired', 'patDaysLeft', 'signedIn', 'notSignedIn']) {
    assert.equal(new RegExp(`t\\("${key}"`).test(source), true, `缺少 t("${key}") 调用`);
    assert.equal(new RegExp(`\\n\\s+${key}:`).test(source), true, `字典缺少 ${key} 条目`);
  }
});

test('P1-9 回归：死代码已清除', () => {
  assert.equal(source.includes('patNoteOf'), false);
  assert.equal(/data\.note && !checked/u.test(source), false, 'note 不得因 checked 被整条丢弃');
});