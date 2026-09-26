# dsh-dual-checkin

一个 DeepSeek Harness 插件同时完成 Trae 与 WorkBuddy 签到。

登录态只读本机文件，不读取青龙环境变量里的 token、uid 或账号列表，也不把解出的 token 写入 settings 或状态文件。

## 本机数据

- Trae：`~/Library/Application Support/TRAE SOLO CN/User/globalStorage/storage.json`（以及 Trae CN / Trae / TRAE SOLO、CLI 的 `trae-jwt-token`）
- WorkBuddy：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
  明文 JWT 直接使用；`$wbEncrypted` 信封按 dsh-buddy-checkin v0.2.0 的方式，拉起本机 `WorkBuddy.app` 的 Electron 取 at-rest key，再用 AES-256-GCM 解开。

## 主页侧边栏入口

安装后 DSH 主页左侧边栏新增「签到」图标入口（`sidebar.panellist`，order 15），点击打开全宽签到面板（`main` keyed slot）：

- Trae 与 WorkBuddy 各一张状态卡：徽标（已签到 / 未签到）+ 签到时间（24 小时制）+ 最近备注
- 常驻积分行：剩余积分 / 已使用 / 3天内到期（三列跨卡片纵向对齐）；三天内有积分到期时卡片内出现醒目提醒
- 积分对比（签到前 / 签到后 / 本次获得）默认直接显示，无需手动展开
- 数据来自宿主路由 `GET /plugins/dsh-dual-checkin/status`，页内可手动刷新
- 签到仅随 DSH 启动自动执行（幂等，当日已签自动跳过）；无手动签到入口

不再注册任何设置页条目（无 settings.section）。

## 积分与到期数据来源

- Trae：余额取 `usage_summary`（`total_amount` − `consumed_amount`，权威口径）；三天内到期按积分包 `expire_time` 逐包累加（`credits_limit − credits_amount`）。每日奖励额 = status 的 `credits + extra_credits`。
- WorkBuddy：`get-user-resource` 聚合——月度包（`CapacityType===4`）看 `Cycle*` 字段，一次性包看 `Capacity*` 字段并剔除已过期/已用尽的（聚合规则与 dsh-connect-workbuddy 一致）；月度包周期结束即重置，其剩余同样计入三天内到期提醒。
- 签到状态检测：WorkBuddy 先查 `checkin-activity-status` 的 `today_checked_in`（无副作用），只在未签时调 `daily-checkin`；Trae 的 `checked_in` 为账号级状态，claim 按北京日幂等。

## 互不阻塞

启动时 `Promise.allSettled` 并行跑两个平台。一边失败、超时或未登录，另一边照常完成。状态分别写到：

- `~/.dsh/.dsh-dual-checkin-trae.json`
- `~/.dsh/.dsh-dual-checkin-workbuddy.json`

路由 `/plugins/dsh-dual-checkin/status`：

- `GET`：看本次结果（读最新状态文件，当日已完成时无网络请求）
- `POST`：重跑一次两个平台，当日已成功的平台会跳过（幂等）；无单平台强制签到入口

本插件的 entry id、路由和状态文件都不同于 `dsh-connect-trae`、`dsh-connect-workbuddy`、`dsh-buddy-checkin`。不要把本目录直接安装进正在运行的 profile。
