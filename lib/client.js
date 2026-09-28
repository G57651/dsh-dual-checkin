window.__ModuleLoader__.load({
	id: "dsh-dual-checkin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		//#region src/client/CheckinPage.tsx
		const { useEffect, useState, useCallback } = react;

		const inject = ["slots", "locale"];
		const name = "dsh-dual-checkin-client";
		const PANEL_ID = "dual-checkin";
		const NS = "settings.dualCheckin";

		const css = ".dcc-page{display:flex;flex-direction:column;gap:16px;padding:24px 28px;max-width:720px;margin:0 auto;font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary);overflow-y:auto;height:100%}"
			+ ".dcc-title{font-size:20px;font-weight:600;line-height:30px}"
			+ ".dcc-sub{color:var(--dsw-alias-label-secondary);margin-top:2px}"
			+ ".dcc-card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);padding:14px 18px;display:flex;flex-direction:column;gap:10px}"
			+ ".dcc-row{display:flex;justify-content:space-between;align-items:center;gap:16px}"
			+ ".dcc-label{color:var(--dsw-alias-label-secondary)}"
			+ ".dcc-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;line-height:20px}"
			+ ".dcc-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}"
			+ ".dcc-bad{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}"
			+ ".dcc-dot{width:7px;height:7px;border-radius:50%;display:inline-block}"
			+ ".dcc-plat-head{display:flex;align-items:center;justify-content:space-between;gap:10px}"
			+ ".dcc-plat-name{font-weight:600;font-size:14px}"
			+ ".dcc-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}"
			+ ".dcc-cell{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}"
			+ ".dcc-cell-k{font-size:12px;color:var(--dsw-alias-label-secondary)}"
			+ ".dcc-cell-v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}"
			+ ".dcc-gain{color:var(--dsw-alias-state-success-primary)}"
			+ ".dcc-time{font-variant-numeric:tabular-nums}"
			+ ".dcc-detail{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-settings-card-stroke);padding-top:12px}"
			+ ".dcc-footer{display:flex;justify-content:space-between;align-items:center;color:var(--dsw-alias-label-secondary);font-size:12px}"
			+ ".dcc-linkbtn{appearance:none;font:inherit;cursor:pointer;background:transparent;border:0;color:var(--dsw-alias-brand-primary);padding:0;font-size:12px}"
			+ ".dcc-err{color:var(--dsw-alias-state-error-primary)}"
			+ ".dcc-credits{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}"
			+ ".dcc-credits b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}"
			+ ".dcc-warn,.dcc-warn b{color:var(--dsw-alias-state-warn-primary,#f59e0b)}";

		function fmtTime24(iso) {
			if (!iso) return "—";
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return "—";
			return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
		}
		function fmtNum(v) {
			return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString() : "—";
		}
		function isSignedIn(data) {
			if (!data || data.ok !== true) return false;
			if (data.checkedIn === true) return true;
			if (data.note && /签到成功|已签到|跳过|already/i.test(data.note)) return true;
			const results = data.results;
			return Array.isArray(results) && results.length > 0 && results.every((item) => item && item.ok === true);
		}
		function Pill({ ok }) {
			return react.createElement("span", { className: "dcc-pill " + (ok ? "dcc-ok" : "dcc-bad") },
				react.createElement("i", { className: "dcc-dot", style: { background: "currentColor" } }),
				ok ? "已签到" : "未签到");
		}
		function PlatformCard({ title, subtitle, data, t }) {
			const checked = isSignedIn(data);
			const credits = data && data.credits;
			const before = data && (data.creditsBefore ?? (data.results && data.results[0] && data.results[0].before));
			const after = data && (data.creditsAfter ?? (data.results && data.results[0] && data.results[0].after));
			const gained = data && (typeof data.gained === "number" ? data.gained : (data.results && data.results[0] && data.results[0].gained) ?? null);
			return react.createElement("div", { className: "dcc-card" },
				react.createElement("div", { className: "dcc-plat-head" },
					react.createElement("span", { className: "dcc-plat-name" }, title),
					react.createElement(Pill, { ok: checked })),
				react.createElement("div", { className: "dcc-row" },
					react.createElement("span", { className: "dcc-label" }, subtitle),
					react.createElement("span", { className: "dcc-time" }, checked ? fmtTime24(data.checkedAt) : "—")),
				react.createElement("div", { className: "dcc-row" },
					react.createElement("span", { className: "dcc-label" }, "备注"),
					react.createElement("span", null, (data && data.note) || "—")),
				react.createElement("div", { className: "dcc-credits" },
					creditCell(t, "creditsRemaining", credits ? credits.remaining : null, false),
					creditCell(t, "creditsUsed", credits ? credits.used : null, false),
					creditCell(t, "creditsExpiring", credits ? credits.expiring : null, false)),
				credits && credits.expiring > 0 && react.createElement("div", { className: "dcc-warn", style: { fontSize: 12 } },
					t("expiringAlert").replace("{n}", fmtNum(credits.expiring))),
				react.createElement("div", { className: "dcc-detail" },
					react.createElement("div", { className: "dcc-grid" },
						react.createElement("div", { className: "dcc-cell" },
							react.createElement("span", { className: "dcc-cell-k" }, "签到前积分"),
							react.createElement("span", { className: "dcc-cell-v" }, fmtNum(before))),
						react.createElement("div", { className: "dcc-cell" },
							react.createElement("span", { className: "dcc-cell-k" }, "签到后积分"),
							react.createElement("span", { className: "dcc-cell-v" }, fmtNum(after))),
						react.createElement("div", { className: "dcc-cell" },
							react.createElement("span", { className: "dcc-cell-k" }, "本次获得"),
							react.createElement("span", { className: "dcc-cell-v dcc-gain" }, typeof gained === "number" ? "+" + fmtNum(gained) : "—")))));
		}

		function creditCell(t, key, value, warn) {
			return react.createElement("span", { className: warn ? "dcc-warn" : undefined },
				t(key) + " ",
				react.createElement("b", null, fmtNum(value)));
		}

		function CheckinPage({ t }) {
			const [data, setData] = useState(null);
			const [failed, setFailed] = useState(false);
			const load = useCallback(async () => {
				try {
					const r = await fetch("/plugins/dsh-dual-checkin/status", { signal: AbortSignal.timeout(15000) });
					if (!r.ok) throw new Error("HTTP " + r.status);
					setData(await r.json());
					setFailed(false);
				} catch {
					setFailed(true);
				}
			}, []);
			useEffect(() => { load(); }, [load]);
			return react.createElement("div", { className: "dcc-page" },
				react.createElement("div", null,
					react.createElement("div", { className: "dcc-title" }, t("title")),
					react.createElement("div", { className: "dcc-sub" }, t("intro"))),
				failed && react.createElement("div", { className: "dcc-err" }, t("loadFailed")),
				react.createElement(PlatformCard, { title: "Trae", subtitle: "TRAE SOLO CN · 签到时间（24 小时制）", data: data && data.trae, t }),
				react.createElement(PlatformCard, { title: "WorkBuddy", subtitle: "CodeBuddy CN · 签到时间（24 小时制）", data: data && data.workbuddy, t }),
				react.createElement("div", { className: "dcc-footer" },
					react.createElement("span", null, t("autoRun")),
					react.createElement("button", { className: "dcc-linkbtn", type: "button", onClick: load }, t("refresh"))));
		}
		//#endregion
		//#region src/client/CheckinIcon.tsx
		function CheckinIcon({ size }) {
			return react.createElement("span", { style: { display: "inline-flex", width: size, height: size, alignItems: "center", justifyContent: "center", fontSize: size * 0.8, lineHeight: 1 } }, "✓");
		}
		//#endregion
		//#region src/client/index.tsx
		const zh = {
			panel: "签到",
			title: "每日签到",
			intro: "Trae 与 WorkBuddy 每日自动签到状态",
			refresh: "刷新状态",
			autoRun: "随 DSH 启动自动执行，幂等不重复",
			loadFailed: "加载失败，请稍后重试",
			creditsRemaining: "剩余积分",
			creditsUsed: "已使用",
			creditsExpiring: "3天内到期",
			expiringAlert: "提醒：{n} 积分将在 3 天内到期，请尽快使用"
		};
		const en = {
			panel: "Check-in",
			title: "Daily Check-in",
			intro: "Trae and WorkBuddy daily check-in status",
			refresh: "Refresh",
			autoRun: "Runs on DSH startup, idempotent",
			loadFailed: "Failed to load, try again",
			creditsRemaining: "Remaining",
			creditsUsed: "Used",
			creditsExpiring: "Expiring in 3d",
			expiringAlert: "Reminder: {n} credits expire within 3 days"
		};
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-dual-checkin: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.effect(() => {
				if (typeof document !== "undefined" && !document.getElementById("dsh-dual-checkin-css")) {
					const style = document.createElement("style");
					style.id = "dsh-dual-checkin-css";
					style.textContent = css;
					document.head.appendChild(style);
				}
			}, "dsh-dual-checkin: css");
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({ t })
			}, CheckinPage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 15,
				label: () => t("panel"),
				locale: NS
			}, CheckinIcon));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
