# dsh-dual-checkin

DeepSeek Harness 签到插件：一个插件同时完成 **Trae**、**WorkBuddy** 与 **Qoder** 的每日签到，并在主页侧边栏提供签到状态与积分面板。登录态**只读本机文件**——不读取青龙环境变量里的 token / uid / 账号列表，也不把解出的 token 写入 settings 或状态文件。

> 包名与 entry id 沿用 `dsh-dual-checkin`：entry id 是加载层的稳定身份，状态文件也按旧名落盘，改名会让「当日已签」记忆失效、同日重复触发。三平台能力以 1.3.0 为准。

## 功能

- **三平台状态卡**：主页侧边栏新增「签到」图标入口（`sidebar.panellist`），点击打开全宽面板——Trae、WorkBuddy 与 Qoder 各一张状态卡（已签到 / 未签到徽标 + 24 小时制签到时间 + 最近备注）。
- **积分与到期跟踪**：常驻积分行（剩余 / 已使用 / 三天内到期，三列跨卡对齐）；三天内有积分到期时卡片内出现醒目提醒；签到前 / 签到后 / 本次获得对比默认直接显示。积分快照按 TTL（默认 5 分钟，可用 `creditsTtlSeconds` 调整）自动重新查询，签到每天只发生一次。
- **启动自动签到**：仅随 DSH 启动自动执行，幂等——当日已签自动跳过，无手动签到入口。
- **PAT 首次启用录入与到期提醒**：在插件配置（或 cordis.yml）里填 `qoderPat`（令牌）与 `qoderPatExpiresAt`（到期时间）即可启用；剩余 ≤ `qoderPatExpiringDays` 天（默认 7）时面板 Qoder 卡片显示黄色提醒、日志同步 warn，过期显示红色提醒。不填令牌时回退读取 `qoderCredentialRef` 指向的凭据。
- **互不阻塞**：`Promise.allSettled` 并行跑三个平台，一边失败 / 超时 / 未登录，另一边照常完成。
- **状态面板可刷新**：数据来自宿主路由 `GET /plugins/dsh-dual-checkin/status`，页内可手动刷新。

## 安装

**CLI 从 GitHub 安装（推荐）**

```sh
dsh plugin --profile desktop add github:G57651/dsh-dual-checkin
```

**Web UI**：Plugins 页 → Git 填 `github:G57651/dsh-dual-checkin`；或下载 Release / `pnpm pack` 产出的 tarball 后：

```sh
dsh plugin --profile desktop add dsh-dual-checkin-1.3.6.tgz
```

**克隆后本地安装**

```sh
git clone https://github.com/G57651/dsh-dual-checkin.git
dsh plugin --profile desktop add ./dsh-dual-checkin
```

## 本机数据源

| 平台 | 登录态来源 |
|------|-----------|
| Trae | `~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json`（以及 Trae CN / Trae / TRAE SOLO、CLI 的 `trae-jwt-token`） |
| WorkBuddy | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |
| Qoder | **DSH 凭据服务里的 Qoder PAT**：首次启用可在插件配置直接填 `qoderPat` + `qoderPatExpiresAt`（到期时间，用于临期提醒）；不填则读取 `qoderCredentialRef`（默认 `QODER_MANAGED_CREDENTIAL`，与 dsh-provider-qoder 同一份凭据）；区域用 `qoderRegion` 切换 `cn` / `intl` |

WorkBuddy 的明文 JWT 直接使用；`$wbEncrypted` 信封按 dsh-buddy-checkin v0.2.0 的方式，拉起本机 `WorkBuddy.app` 的 Electron 取 at-rest key，再用 AES-256-GCM 解开。

Qoder **不读取任何本机登录文件、不访问系统钥匙串、零解密代码、零子进程**：直接复用你已在
DSH 配置好的 Qoder PAT，`POST /api/v1/jobToken/exchange` 换取短期 jobToken（进程内缓存、临期
5 分钟自动重换、401 自动重换一次再重试且不消耗重试次数）后调用签到接口。PAT 与 jobToken 只在
内存中使用，状态文件只存 uid / 昵称 / edition 与积分快照。未配置 PAT 时报可操作提示，不影响
Trae / WorkBuddy。

## 数据文件

- `~/.dsh/.dsh-dual-checkin-trae.json` — Trae 最近一次签到结果
- `~/.dsh/.dsh-dual-checkin-workbuddy.json` — WorkBuddy 最近一次签到结果
- `~/.dsh/.dsh-dual-checkin-qoder.json` — Qoder 最近一次签到结果

状态路由 `/plugins/dsh-dual-checkin/status`：`GET` 查看本次结果（当日已完成且快照在 TTL 内时无网络请求，超过 TTL 只重查积分、不重复签到）；`POST` 强制重查积分与状态（当日已签到的平台仍然跳过 claim，幂等）。

## 实现说明与已知限制

- **积分口径**：Trae 余额取 `usage_summary`（`total_amount` − `consumed_amount`，权威口径），三天内到期按积分包 `expire_time` 逐包累加；WorkBuddy 走 `get-user-resource` 聚合——月度包看 `Cycle*` 字段（周期结束即重置），一次性包看 `Capacity*` 字段并剔除已过期 / 已用尽的（聚合规则与 dsh-connect-workbuddy 一致）；Qoder 走 `/sash/api/v2/me/usage`，聚合响应里的配额桶与资源包，字段缺失时对应项为 `null`。
- **签到状态检测**：WorkBuddy 先查 `checkin-activity-status` 的 `today_checked_in`（无副作用），只在未签时调 `daily-checkin`；Trae 的 `checked_in` 为账号级状态，claim 按北京日幂等；Qoder 先读 `me/campaigns` 里 `actionType=CLAIM_BENEFIT` 且时间窗开启的那一轮（`startAt/endAt` 为秒级时间戳），`claimStatus=CLAIMED` 视为已签，否则 POST `/claim`（上游幂等，重复领取返回 `replayed=true` 不再发币）。
- **Qoder 凭据失效**：PAT 无效 / 被撤销时 exchange 报错，备注明确提示「请在 DSH 设置 → 模型 → Qoder 凭据 更新 PAT」；接口 401 时先自动重换一次 jobToken 再试（不消耗重试次数），重换后仍 401 才判定登录失效。
- **Qoder 当前没有活动**：活动轮次约每日 00:40（UTC+8）滚动发放，窗口未开启时按「未完成」处理，DSH 下次启动自动重试，不会误标当日已签。
- **无设置页**：不注册 `settings.section`，无手动签到入口。
- **与同类插件不冲突**：entry id、路由和状态文件均独立于 `dsh-connect-trae`、`dsh-connect-workbuddy`、`dsh-connect-qoder`、`dsh-buddy-checkin`，可并存。
- 请通过标准渠道（GitHub / tarball）安装，不要把解包目录直接装进正在运行的 profile。

## 变更记录

### 1.3.6

- **面板重设计**：总览头（今日 N/3 已签 · 共得积分）+ 三张票据卡（平台 · 状态 · 时间 · 主数字「本次获得」· 剩余/已用/临期虚线账目行 · 撕票锯齿收尾）；PAT 临期/过期内嵌 Qoder 票据账目行（黄/红）；未签到平台的失败原因显示在票内注释行。纵向高度约为旧三卡布局的一半，数字全部等宽对齐。

### 1.3.5

- **「今日已签到，跳过」时也显示本次获得积分**：当轮时间窗内 `CLAIMED`（含 claim 返回 `replayed: true`）意味着本轮奖励今天已经到账——无论由 Qoder 客户端还是本插件领取——把本轮宣传金额（100 Credits）填入 `gained`，与 WorkBuddy already 分支行为一致；此前该场景 `gained` 为 null，卡片「本次获得」显示「—」。

### 1.3.4

- **PAT 首次启用录入**：新增配置 `qoderPat`（令牌，显式填写时优先于凭据引用）与 `qoderPatExpiresAt`（到期时间，`YYYY-MM-DD` 或 ISO）。
- **临期到期提醒**：剩余 ≤ `qoderPatExpiringDays`（默认 7 天）时面板 Qoder 卡片黄条提醒 + 日志 warn；过期红条提醒；到期状态在每次面板刷新时按当前配置实时重算，改配置立即生效。

### 1.3.3

- **Qoder 凭据收敛为纯 PAT 模式**（用户决策）：移除本机登录文件（`auth.v1.dat`）读取路径与全部钥匙串 / 解密代码（`security` 子进程、PBKDF2、AES 全部删除，`node:crypto` 依赖归零），唯一凭据来源是 DSH 凭据服务里已配置的 Qoder PAT。
- 模块从 577 行减到 394 行；真机复测：无任何弹窗、单次签到全流程 0.6 秒（原文件路径因钥匙串交互最长可阻塞 60 秒）。

### 1.3.2

- **Qoder 凭据改为「本机登录文件优先 + PAT 兜底」**（用户决策）：优先复用桌面 App 的 `auth.v1.dat`（与桌面端同一份会话，token 由 Qoder 自己续期）；文件不可用（未安装 / 未登录 / 钥匙串未授权 / 解密失败）时自动回退 DSH 已配置的 Qoder PAT，双源都失败时报合并的可操作错误。
- **401 自愈按来源区分**：PAT 来源 401 自动重换一次 jobToken（不消耗重试次数）；本地文件来源的 token 由 Qoder App 续期，401 直接判定登录失效。
- 文件解密链与 1.3.0 相同（钥匙串 → PBKDF2(1003) → AES-128-CBC/GCM 回退），钥匙串超时提升到 60s（授权框等待用户点击，点击后当次即成功）。

### 1.3.1

- **Qoder 凭据改为直接复用 DSH 已配置的 Qoder PAT**（用户决策）：移除整条钥匙串解密链（`security` + PBKDF2 + AES-CBC/GCM），不再读取 `auth.v1.dat`。PAT 与 dsh-provider-qoder 同源（`ctx.credentials.resolve`，服务缺失时回退直读 `~/.dsh/.credentials.yaml` 的同名 refs 项），经 `/api/v1/jobToken/exchange` 换短期 jobToken 后调用签到接口。
- **新增配置**：`qoderCredentialRef`（默认 `QODER_MANAGED_CREDENTIAL`）、`qoderRegion`（`cn` / `intl`，默认 `cn`）。
- **401 自愈**：jobToken 短期失效时自动重换一次再试（不消耗重试次数），重换后仍 401 才报「请更新 PAT」；exchange 结果进程内缓存，临期 5 分钟自动重换。
- **修复**：campaigns 的 `startAt/endAt` 是秒级时间戳，此前被按毫秒判定导致活动窗口永远视为已关闭（真机发现并修复）。

### 1.3.0

- **新增 Qoder 平台**：读取 `com.qodercn.app.stable/auth.v1.dat`（Chromium OSCrypt 信封），macOS 经钥匙串 `Qoder CN App Safe Storage` + PBKDF2(1003) + AES-CBC/GCM 回退链解密；签到走 `me/campaigns` + `campaigns/{id}/claim`（幂等）。国际版（`openapi.qoder.sh`）为尽力探测——其活动列表需要客户端 umid 设备头，本插件不伪造，缺失时明确报错。
- **钥匙串授权 UX**：`security find-generic-password` 的各类退出码映射为可操作提示（未登录 / 授权被拒 / 需要交互）；首次读取弹一次授权框，点「始终允许」后静默。
- **重试机制落地到 Qoder**：网络异常与 5xx/429 按 `retryTimes` / `retryDelayMs` 重试，4xx 快速失败；401/403 判定为登录过期，不重试。
- **状态路由三平台化**：`GET/POST /plugins/dsh-dual-checkin/status` 增加同名 `qoder` 键；GET/POST 共用 `runAll` 执行器；`syncCredits` 支持按本机重新解密刷新 Qoder 积分快照。
- **面板**：新增 Qoder 状态卡与双语文案。

### 1.2.2（重构版，对外行为与接口不变）

- **修复日志静默丢失**（对照开发文档 §10.1「`ctx.logger(name)` 返回具名 logger」）：旧代码把 `ctx.logger` 当普通 `{ warn, info }` 对象读，宿主为可调用服务形态时 `logger.error` / `logger.info` 均为 undefined，所有日志一行不打。现在按可调用形态优先（`ctx.logger('dsh-dual-checkin')`），对象形态回退，与 dsh-session-manager 0.1.2 的修法一致。
- **去除冗余双重等待**：插件级 `inject = ['webServer']` 已保证 `apply` 运行前服务就绪（§2.1），apply 内不再二次 `ctx.inject(['webServer'])`，路由直接经 `ctx.effect` 注册；webServer 服务消失时插件随依赖整体卸载、恢复后重载（§5.4），行为等价。
- **消除重复与死代码**：GET/POST 两个 handler 分支合并为 `handleStatus`（仅 `refreshCredits` 标志不同）；`syncCredits` 签名里从未使用的 `runner` 参数移除；`once` 更名为语义明确的 `singleFlight`；移除未使用的 `workbuddyDefaults` import。
- **状态文件写入加固**：临时文件由固定 `.tmp` 名改为唯一随机名 + 原子改名，并发/崩溃不再可能留下可读到的半截 JSON。
- **trae.mjs 内部整理**：`EXPIRING_WINDOW_MS` 常量归位到常量区、`defaults` 直接引用它；`postJson` 重试参数名 `retries` → `retryTimes` 与 tunables 统一（模块内私有 API）。签到流程、请求端点与解密逻辑零变化。
- **package.json**：按开发文档 §7.3 双声明要求补齐 `devDependencies`（与 peerDependencies 同范围）。

### 1.2.1

- **Trae 余额查询修复**：`ide_user_ent_usage` → `web_user_ent_usage`，请求体去掉 `req_source: 2`（与 dsh-connect-trae 的已验证只读端点一致）。
- **积分快照不再整天冻结**：当日已签到时不再短路返回磁盘快照，而是按 `creditsTtlSeconds`（默认 300 秒）重新查询积分；面板刷新按钮改为强制重查（不重复签到）。
- **WorkBuddy 备注统一**：金额优先取 claim 响应的 `credit`，缺失时用签到状态响应的 `daily_credit` / `today_credit` 兜底，备注统一为「签到成功，获得 +N 积分」。
- **WorkBuddy 资源查询补时间窗**：`get-user-resource` 请求体新增 `PackageEndTimeRangeBegin` / `PackageEndTimeRangeEnd`。
- **到期口径**：月度包不再计入「三天内到期」（月度包周期结束即重置）；`parseDateMs` 只把 > 1e12 的数字当毫秒时间戳。
- **规范符合性**：新增同名 `Config` schema（`creditsTtlSeconds` / `retryTimes` / `retryDelayMs` / `reqTimeoutMs` / `expiringWindowMs`），可调值从硬编码移入配置；入口只导出 `name` / `inject` / `Config` / `apply`；`dsh.client.inject` 改为真实客户端包名并补齐 peerDependencies。
- **面板配色修复**：警示色令牌改为 `--dsw-alias-state-warn-primary`（兜底 `#f59e0b`）；「三天内到期」标签恢复为二级灰，仅在确有到期积分时整句提示。

### 1.2.0

- **package.json**：`@deepseek-ai/dsh-host-webserver` peer 范围放宽为 `^0.1.5-rc.1 || ^0.1.7-rc.1 || ^0.2.0-rc.1`——0.2.0-rc.1 起宿主对 `@deepseek-ai/dsh-*` 命名空间的 peerDependencies 做兼容性预检（`semver.satisfies` 含 prerelease），旧范围在 0.2.0-rc.1 上会被预检禁用（stderr 报 "disabling profile plugin"）。宿主 webServer 的 `register(WebRoute{kind,path,handler})` API 实际未变，此改动仅为通过预检，宿主侧代码零改动。
