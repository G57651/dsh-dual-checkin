# dsh-dual-checkin

DeepSeek Harness 签到插件：一个插件同时完成 **Trae** 与 **WorkBuddy** 的每日签到，并在主页侧边栏提供签到状态与积分面板。登录态**只读本机文件**——不读取青龙环境变量里的 token / uid / 账号列表，也不把解出的 token 写入 settings 或状态文件。

## 功能

- **双平台状态卡**：主页侧边栏新增「签到」图标入口（`sidebar.panellist`），点击打开全宽面板——Trae 与 WorkBuddy 各一张状态卡（已签到 / 未签到徽标 + 24 小时制签到时间 + 最近备注）。
- **积分与到期跟踪**：常驻积分行（剩余 / 已使用 / 三天内到期，三列跨卡对齐）；三天内有积分到期时卡片内出现醒目提醒；签到前 / 签到后 / 本次获得对比默认直接显示。积分快照按 TTL（默认 5 分钟，可用 `creditsTtlSeconds` 调整）自动重新查询，签到每天只发生一次。
- **启动自动签到**：仅随 DSH 启动自动执行，幂等——当日已签自动跳过，无手动签到入口。
- **互不阻塞**：`Promise.allSettled` 并行跑两个平台，一边失败 / 超时 / 未登录，另一边照常完成。
- **状态面板可刷新**：数据来自宿主路由 `GET /plugins/dsh-dual-checkin/status`，页内可手动刷新。

## 安装

**CLI 从 GitHub 安装（推荐）**

```sh
dsh plugin --profile desktop add github:G57651/dsh-dual-checkin
```

**Web UI**：Plugins 页 → Git 填 `github:G57651/dsh-dual-checkin`；或下载 Release / `pnpm pack` 产出的 tarball 后：

```sh
dsh plugin --profile desktop add dsh-dual-checkin-1.2.0.tgz
```

**克隆后本地安装**

```sh
git clone https://github.com/G57651/dsh-dual-checkin.git
dsh plugin --profile desktop add ./dsh-dual-checkin
```

## 本机数据源

| 平台 | 登录态文件 |
|------|-----------|
| Trae | `~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json`（以及 Trae CN / Trae / TRAE SOLO、CLI 的 `trae-jwt-token`） |
| WorkBuddy | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |

WorkBuddy 的明文 JWT 直接使用；`$wbEncrypted` 信封按 dsh-buddy-checkin v0.2.0 的方式，拉起本机 `WorkBuddy.app` 的 Electron 取 at-rest key，再用 AES-256-GCM 解开。

## 数据文件

- `~/.dsh/.dsh-dual-checkin-trae.json` — Trae 最近一次签到结果
- `~/.dsh/.dsh-dual-checkin-workbuddy.json` — WorkBuddy 最近一次签到结果

状态路由 `/plugins/dsh-dual-checkin/status`：`GET` 查看本次结果（当日已完成且快照在 TTL 内时无网络请求，超过 TTL 只重查积分、不重复签到）；`POST` 强制重查积分与状态（当日已签到的平台仍然跳过 claim，幂等）。

## 实现说明与已知限制

- **积分口径**：Trae 余额取 `usage_summary`（`total_amount` − `consumed_amount`，权威口径），三天内到期按积分包 `expire_time` 逐包累加；WorkBuddy 走 `get-user-resource` 聚合——月度包看 `Cycle*` 字段（周期结束即重置），一次性包看 `Capacity*` 字段并剔除已过期 / 已用尽的（聚合规则与 dsh-connect-workbuddy 一致）。
- **签到状态检测**：WorkBuddy 先查 `checkin-activity-status` 的 `today_checked_in`（无副作用），只在未签时调 `daily-checkin`；Trae 的 `checked_in` 为账号级状态，claim 按北京日幂等。
- **无设置页**：不注册 `settings.section`，无手动签到入口。
- **与同类插件不冲突**：entry id、路由和状态文件均独立于 `dsh-connect-trae`、`dsh-connect-workbuddy`、`dsh-buddy-checkin`，可并存。
- 请通过标准渠道（GitHub / tarball）安装，不要把解包目录直接装进正在运行的 profile。

## 变更记录

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
