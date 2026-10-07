// 回归：WorkBuddy 的边界收紧。
//   * S-03 上游主机必须锚定官方域，且必须是纯主机名（auth.domain 来自本机文件）；
//   * S-12 子进程只继承白名单环境，不透传插件进程里的 token/PAT 类变量；
//   * resolveElectronPath 拒绝目录 / 断裂路径 / 不可执行文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAccounts, childEnv, resolveElectronPath } from '../lib/workbuddy.mjs';

const dir = await mkdtemp(join(tmpdir(), 'dcc-wb-'));
await mkdir(dir, { recursive: true });

async function put(domain, uid = 'U1') {
  await writeFile(join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid, nickname: 'nick' },
    auth: { domain, accessToken: 'WB.FAKE.TOKEN' },
  }), 'utf8');
}

test('S-03：非官方域 / 非纯主机名一律拒绝（返回 0 个账号）', async () => {
  const bad = [
    'evil.example',
    'evil.example:8443',
    'evil.example/path',
    'user@evil.example',
    'workbuddy.cn.evil.com',
    'evil-workbuddy.cn',
    'www.workbuddy.cn.evil.example',
    '',
  ];
  for (const domain of bad) {
    await put(domain);
    const found = await discoverAccounts({ dirs: [dir] });
    assert.equal(found.length, 0, '不该接受域名：' + JSON.stringify(domain));
  }
});

test('S-03：官方域（含子域）正常取到账号', async () => {
  for (const domain of ['www.workbuddy.cn', 'workbuddy.cn', 'codebuddy.cn', 'a.codebuddy.cn']) {
    await put(domain);
    const found = await discoverAccounts({ dirs: [dir] });
    assert.equal(found.length, 1, '应接受域名：' + domain);
    assert.equal(found[0].domain, domain);
    assert.equal(found[0].accessToken, 'WB.FAKE.TOKEN');
  }
});

test('S-12：子进程环境只保留白名单键', () => {
  const source = {
    PATH: '/usr/bin', HOME: '/Users/x', TMPDIR: '/tmp', LANG: 'zh_CN.UTF-8',
    WORKBUDDY_ELECTRON_BIN: '/evil', QODER_PAT: 'secret-pat', DSH_DUAL_CHECKIN_TOKEN: 't',
    AWS_SECRET_ACCESS_KEY: 'k', RANDOM_UNRELATED: '1',
  };
  const env = childEnv(source);
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/x');
  for (const leaked of ['WORKBUDDY_ELECTRON_BIN', 'QODER_PAT', 'DSH_DUAL_CHECKIN_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'RANDOM_UNRELATED']) {
    assert.equal(leaked in env, false, '不该透传 ' + leaked);
  }
  assert.deepEqual(Object.keys(childEnv({})), ['ELECTRON_RUN_AS_NODE'], '空环境下只剩必要变量');
});

test('resolveElectronPath 只接受可执行的常规文件', async () => {
  await assert.rejects(async () => resolveElectronPath({ WORKBUDDY_ELECTRON_BIN: dir }, 'darwin'), /不是常规文件/u);
  await assert.rejects(
    async () => resolveElectronPath({ WORKBUDDY_ELECTRON_BIN: join(dir, 'missing') }, 'darwin'),
    /不可解析|不存在/u,
  );
  const plain = join(dir, 'not-exec');
  await writeFile(plain, '#!/bin/sh\n', 'utf8');
  await chmod(plain, 0o644);
  await assert.rejects(async () => resolveElectronPath({ WORKBUDDY_ELECTRON_BIN: plain }, 'darwin'), /不可执行/u);

  const runner = join(dir, 'run-me');
  await writeFile(runner, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(runner, 0o755);
  assert.equal(resolveElectronPath({ WORKBUDDY_ELECTRON_BIN: runner }, 'darwin'), await realpath(runner));

  await assert.rejects(async () => resolveElectronPath({}, 'linux'), /没有默认 WorkBuddy Electron 路径/u);
});