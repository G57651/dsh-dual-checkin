// 回归：Qoder PAT 的 refs 解析（S-01 / P0-5）与凭据文件权限校验（S-04）。
// 旧实现把 refName 直接拼进 `new RegExp('^  ' + refName + ': (\\S+)$', 'm')`：
// `.*` / `(A|B)` / `[` 之类的配置值会改变匹配语义，从别的 ref 里读出无关密钥，
// 非法正则还会把原始错误字符串经 note 上屏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import './harness.mjs';
import { resolvePatFromFile } from '../lib/qoder.mjs';
import { dshHomeDir } from './harness.mjs';

const FILE = join(dshHomeDir, '.credentials.yaml');
const CONTENT = [
  '  QODER_MANAGED_CREDENTIAL: REAL_QODER_PAT',
  '  OTHER_API_KEY: UNRELATED_SECRET',
  '',
].join('\n');

await writeFile(FILE, CONTENT, { mode: 0o600 });
await chmod(FILE, 0o600);

test('正常 ref：按字符串前缀取出对应值', async () => {
  assert.equal(await resolvePatFromFile('QODER_MANAGED_CREDENTIAL'), 'REAL_QODER_PAT');
  assert.equal(await resolvePatFromFile('OTHER_API_KEY'), 'UNRELATED_SECRET');
});

test('未知 ref 返回空串', async () => {
  assert.equal(await resolvePatFromFile('NOT_THERE'), '');
  assert.equal(await resolvePatFromFile(''), '');
});

test('S-01 回归：正则元字符不再改变匹配语义', async () => {
  const injections = [
    '.*',
    'QODER_MANAGED_CREDENTIAL: \\S+\n  OTHER_API_KEY',
    '(QODER_MANAGED_CREDENTIAL|OTHER_API_KEY)',
    'QODER_MANAGED_CREDENTIAL|OTHER_API_KEY',
    '[',
    '(',
    'QODER_MANAGED_CREDENTIAL|.*',
  ];
  for (const ref of injections) {
    assert.equal(await resolvePatFromFile(ref), '', `ref=${JSON.stringify(ref)} 不应读到任何值`);
  }
});

test('S-01 回归：非法 ref 不抛异常（此前会抛 Unterminated character class）', async () => {
  await assert.doesNotReject(() => resolvePatFromFile('['));
  await assert.doesNotReject(() => resolvePatFromFile('(a+)+b'));
});

test('S-04：凭据文件权限过宽时拒绝读取并给出可操作提示', async () => {
  await chmod(FILE, 0o644);
  await assert.rejects(
    () => resolvePatFromFile('QODER_MANAGED_CREDENTIAL'),
    /权限过宽|chmod 600/u,
  );
  await chmod(FILE, 0o600);
});

test('文件不存在时返回空串，不抛异常', async () => {
  const missing = join(dshHomeDir, 'nope', '.credentials.yaml');
  await mkdir(join(dshHomeDir, 'nope'), { recursive: true });
  assert.equal(await resolvePatFromFile('QODER_MANAGED_CREDENTIAL', { home: dshHomeDir, env: {} }), '');
  assert.ok(missing.includes('nope'));
});