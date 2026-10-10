// 回归：WorkBuddy 的 Windows 默认路径识别（1.3.10）。
//   * 注册表输出解析：DisplayIcon 剥引号与图标索引、只接受 WorkBuddy.exe；
//     InstallLocation 拼上主程序名；带引号里的裸字符不被截断。
//   * 候选顺序：卸载表三视图命中在前（自定义盘符只有这里找得到），默认目录兜底；
//     单个视图查询失败按无候选处理，不阻塞后续来源。
//   * resolveElectronPath(win32)：候选走与显式配置一致的三重校验（realpath + 常规文件 + X_OK），
//     全部落空才报错，报错保留 WORKBUDDY_ELECTRON_BIN 指引。
// 注册表一律经 queryRegistry 注入桩：测试永不读本机注册表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  registryExecutableFrom,
  registryInstallLocationFrom,
  windowsElectronCandidates,
  resolveElectronPath,
} from '../lib/workbuddy.mjs';

const WIN_ROOTS = [
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

const regLine = (name, value) => `    ${name}    REG_SZ    ${value}`;

test('registryExecutableFrom：剥图标索引、剥引号，只接受 WorkBuddy.exe', () => {
  assert.equal(
    registryExecutableFrom(regLine('DisplayIcon', 'D:\\Program Files\\WorkBuddy\\WorkBuddy.exe,0')),
    'D:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
  );
  assert.equal(
    registryExecutableFrom(regLine('DisplayIcon', '"D:\\My Apps\\WorkBuddy.exe",0')),
    'D:\\My Apps\\WorkBuddy.exe',
  );
  // 引号形式里 `,0` 在引号外、随引号一起剥掉；再补一个裸索引形式确认正则不重复剥。
  assert.equal(
    registryExecutableFrom(regLine('DisplayIcon', '"D:\\My Apps\\WorkBuddy.exe"')),
    'D:\\My Apps\\WorkBuddy.exe',
  );
  // 指向卸载器 / 图标 / 其它产品的值一律拒绝；未闭合引号也不产出候选。
  assert.equal(registryExecutableFrom(regLine('DisplayIcon', '"D:\\dir\\unins000.exe",0')), undefined);
  assert.equal(registryExecutableFrom(regLine('DisplayIcon', '"D:\\dir\\WorkBuddy.ico",0')), undefined);
  assert.equal(registryExecutableFrom(regLine('DisplayIcon', '"D:\\dir\\WorkBuddy.exe')), undefined);
  // 多行输出取第一条能用的 DisplayIcon；键路径行不是取值行。
  const multi = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}',
    regLine('DisplayIcon', 'D:\\old\\WorkBuddy\\uninstall.exe'),
    regLine('DisplayIcon', '"D:\\Program Files\\WorkBuddy\\WorkBuddy.exe",0'),
  ].join('\r\n');
  assert.equal(registryExecutableFrom(multi), 'D:\\Program Files\\WorkBuddy\\WorkBuddy.exe');
});

test('registryInstallLocationFrom：目录值拼上主程序名，用 win32 分隔符', () => {
  assert.equal(
    registryInstallLocationFrom(regLine('InstallLocation', 'D:\\Program Files\\WorkBuddy\\')),
    win32.join('D:\\Program Files\\WorkBuddy\\', 'WorkBuddy.exe'),
  );
  assert.equal(registryInstallLocationFrom(regLine('InstallLocation', '"C:\\apps\\wb"')), win32.join('C:\\apps\\wb', 'WorkBuddy.exe'));
  assert.equal(registryInstallLocationFrom('    DisplayName    REG_SZ    WorkBuddy'), undefined);
});

test('windowsElectronCandidates：注册表命中在前、默认目录兜底、失败视图跳过', () => {
  const env = { LOCALAPPDATA: 'C:\\u\\lapp', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  const listings = new Map([
    [WIN_ROOTS[0], null], // 查询抛错：策略禁用 / reg 缺失 → 该视图无候选
    [WIN_ROOTS[1], [regLine('DisplayIcon', '"D:\\Program Files\\WorkBuddy\\WorkBuddy.exe",0')].join('\r\n')],
    [WIN_ROOTS[2], [regLine('InstallLocation', 'E:\\wb')].join('\r\n')],
  ]);
  const candidates = windowsElectronCandidates(env, (root) => {
    const listing = listings.get(root);
    if (listing === null) throw new Error('reg unavailable');
    return listing;
  });
  assert.deepEqual(candidates, [
    'D:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    win32.join('E:\\wb', 'WorkBuddy.exe'),
    win32.join(join(env.LOCALAPPDATA, 'Programs'), 'WorkBuddy', 'WorkBuddy.exe'),
    win32.join(env.LOCALAPPDATA, 'WorkBuddy', 'WorkBuddy.exe'),
    win32.join(env.ProgramFiles, 'WorkBuddy', 'WorkBuddy.exe'),
    win32.join(env['ProgramFiles(x86)'], 'WorkBuddy', 'WorkBuddy.exe'),
  ]);
  // env 缺项时对应候选整体缺席，不产出 undefined / 空。
  assert.deepEqual(
    windowsElectronCandidates({}, () => { throw new Error('no reg'); }),
    [],
  );
});

test('resolveElectronPath(win32)：注册表命中经三重校验，目录候选被跳过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dcc-winpath-'));
  // 第一个视图指向同名**目录**：isFile 校验必须跳过它，落到第二个视图的真实文件。
  const fakeDir = join(dir, 'WorkBuddy.exe');
  await mkdir(fakeDir, { recursive: true });
  const realFile = join(dir, 'real', 'WorkBuddy.exe');
  await mkdir(join(dir, 'real'), { recursive: true });
  await writeFile(realFile, 'MZ', 'utf8');
  await chmod(realFile, 0o755);
  const listings = new Map([
    [WIN_ROOTS[0], [regLine('DisplayIcon', fakeDir)].join('\r\n')],
    [WIN_ROOTS[1], [regLine('DisplayIcon', realFile)].join('\r\n')],
  ]);
  const resolved = resolveElectronPath({}, 'win32', (root) => {
    const listing = listings.get(root);
    if (listing === undefined) throw new Error('reg unavailable');
    return listing;
  });
  assert.equal(resolved, await realpath(realFile));
});

test('resolveElectronPath(win32)：全部落空时报错并保留 WORKBUDDY_ELECTRON_BIN 指引', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dcc-winpath-'));
  // resolveElectronPath 是同步函数：必须经 async 包装把同步抛错变成 rejected promise，
  // 否则 assert.rejects 会跳过正则校验直接透传原始错误。
  await assert.rejects(
    async () => resolveElectronPath(
      { LOCALAPPDATA: join(dir, 'nope'), ProgramFiles: join(dir, 'nope2') },
      'win32',
      () => { throw new Error('reg unavailable'); },
    ),
    /WORKBUDDY_ELECTRON_BIN/u,
  );
});

test('resolveElectronPath(win32)：显式 WORKBUDDY_ELECTRON_BIN 优先级不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dcc-winpath-'));
  const runner = join(dir, 'WorkBuddy.exe');
  await writeFile(runner, 'MZ', 'utf8');
  await chmod(runner, 0o755);
  assert.equal(resolveElectronPath({ WORKBUDDY_ELECTRON_BIN: runner }, 'win32'), await realpath(runner));
});
