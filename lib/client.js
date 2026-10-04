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

		const css = ".dcc-page{display:flex;flex-direction:column;gap:14px;padding:24px 28px;max-width:760px;margin:0 auto;font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary);overflow-y:auto;height:100%}"
			+ ".dcc-head{display:flex;justify-content:space-between;align-items:baseline}"
			+ ".dcc-head .t{font-size:15px;font-weight:600}"
			+ ".dcc-head .d{color:var(--dsw-alias-label-secondary);font-size:12px}"
			+ ".dcc-shell{border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:14px;background:var(--dsw-alias-settings-card-fill);overflow:hidden}"
			+ ".dcc-hero{display:flex;align-items:center;gap:13px;padding:15px 18px 13px}"
			+ ".dcc-frac{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:23px;font-weight:700;font-variant-numeric:tabular-nums}"
			+ ".dcc-frac i{font-style:normal;font-size:13px;color:var(--dsw-alias-label-secondary);font-weight:400}"
			+ ".dcc-hero-lbl{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}"
			+ ".dcc-hero-tot{margin-left:auto;text-align:right}"
			+ ".dcc-hero-tot .n{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px;font-weight:700;color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}"
			+ ".dcc-hero-tot .lbl{display:block;color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:1px}"
			+ ".dcc-tickets{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;padding:0 16px 14px}"
			+ ".dcc-ticket{border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:11px;padding:12px 13px 0;background:var(--dsw-alias-settings-card-fill)}"
			+ ".dcc-tk-head{display:flex;justify-content:space-between;align-items:center}"
			+ ".dcc-tk-name{font-weight:600;font-size:13.5px}"
			+ ".dcc-tk-time{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:6px}"
			+ ".dcc-tk-gain{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:24px;font-weight:700;margin:2px 0 7px;font-variant-numeric:tabular-nums}"
			+ ".dcc-tk-gain.got{color:var(--dsw-alias-state-success-primary)}"
			+ ".dcc-tk-gain.zero{color:var(--dsw-alias-label-secondary);opacity:.75}"
			+ ".dcc-tk-kv{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:5px 0;border-top:1px dashed var(--dsw-alias-settings-card-stroke)}"
			+ ".dcc-tk-kv b{color:var(--dsw-alias-label-primary);font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}"
			+ ".dcc-tk-kv.warn b{color:var(--dsw-alias-state-warn-primary,#f59e0b)}"
			+ ".dcc-tk-kv.err b{color:var(--dsw-alias-state-error-primary)}"
			+ ".dcc-tk-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.55;padding:6px 0;border-top:1px dashed var(--dsw-alias-settings-card-stroke)}"
			+ ".dcc-tk-foot{height:9px;margin:10px -13px 0;background:radial-gradient(circle at 6px -3px,transparent 6px,var(--dsw-alias-settings-card-fill,#20242b) 6.5px) repeat-x;background-size:12px 9px}"
			+ ".dcc-foot{display:flex;justify-content:space-between;align-items:center;color:var(--dsw-alias-label-secondary);font-size:11.5px;padding:10px 16px;border-top:1px solid var(--dsw-alias-settings-card-stroke)}"
			+ ".dcc-linkbtn{appearance:none;font:inherit;cursor:pointer;background:transparent;border:0;color:var(--dsw-alias-brand-primary);padding:0;font-size:12px}"
			+ ".dcc-err{color:var(--dsw-alias-state-error-primary)}"
			+ ".dcc-pill{display:inline-flex;align-items:center;gap:5px;padding:1px 9px;border-radius:999px;font-size:11.5px;line-height:20px}"
			+ ".dcc-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}"
			+ ".dcc-bad{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}"
			+ ".dcc-dot{width:6px;height:6px;border-radius:50%;display:inline-block;background:currentColor}";

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
		function signedCount(data) {
			if (!data) return null;
			return ["trae", "workbuddy", "qoder"].filter((k) => isSignedIn(data[k])).length;
		}
		function gainedTotal(data) {
			if (!data) return null;
			return ["trae", "workbuddy", "qoder"].reduce((sum, k) => {
				const g = data[k] && data[k].gained;
				return sum + (typeof g === "number" && g > 0 ? g : 0);
			}, 0);
		}
		function Pill({ ok }) {
			return react.createElement("span", { className: "dcc-pill " + (ok ? "dcc-ok" : "dcc-bad") },
				react.createElement("i", { className: "dcc-dot" }),
				ok ? "已签到" : "未签到");
		}
		function gainedCell(gained) {
			const got = typeof gained === "number" && gained > 0;
			return react.createElement("div", { className: "dcc-tk-gain " + (got ? "got" : "zero") },
				got ? "+" + fmtNum(gained) : "—");
		}
		function kvRow(label, value, tone) {
			return react.createElement("div", { className: "dcc-tk-kv" + (tone ? " " + tone : "") },
				react.createElement("span", null, label), react.createElement("b", null, value));
		}
		function Ticket({ name, data, t, pat }) {
			const checked = isSignedIn(data);
			const credits = data && data.credits;
			const gained = data && (typeof data.gained === "number" ? data.gained
				: (data.results && data.results[0] && data.results[0].gained) ?? null);
			const children = [
				react.createElement("div", { className: "dcc-tk-head", key: "head" },
					react.createElement("span", { className: "dcc-tk-name" }, name),
					react.createElement(Pill, { ok: checked })),
				react.createElement("div", { className: "dcc-tk-time", key: "time" }, checked ? fmtTime24(data.checkedAt) : "—"),
				react.createElement("div", { key: "gain" }, gainedCell(gained)),
			];
			if (credits) {
				children.push(kvRow(t("creditsRemaining"),
					fmtNum(credits.remaining) + (credits.total != null ? " / " + fmtNum(credits.total) : "")));
				children.push(kvRow(t("creditsUsed"), fmtNum(credits.used)));
				children.push(kvRow(t("creditsExpiring"), fmtNum(credits.expiring),
					credits.expiring > 0 ? "warn" : undefined));
			}
			if (pat && pat.patExpired) children.push(kvRow("PAT 到期", "已过期", "err"));
			else if (pat && pat.patExpiringSoon) children.push(kvRow("PAT 到期", "剩约 " + pat.patDaysLeft + " 天", "warn"));
			if (data && data.note && !checked) children.push(react.createElement("div", { className: "dcc-tk-note", key: "note" }, data.note));
			children.push(react.createElement("div", { className: "dcc-tk-foot", key: "foot" }));
			return react.createElement("div", { className: "dcc-ticket" }, children);
		}
		function patNoteOf(q) {
			if (!q) return null;
			if (q.patExpired) return "已过期";
			if (q.patExpiringSoon) return "剩约 " + q.patDaysLeft + " 天";
			return null;
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
			const signed = signedCount(data);
			const total = gainedTotal(data);
			const q = data && data.qoder;
			const pat = q && (q.patExpired || q.patExpiringSoon) ? q : null;
			return react.createElement("div", { className: "dcc-page" },
				react.createElement("div", { className: "dcc-head" },
					react.createElement("span", { className: "t" }, t("title")),
					react.createElement("span", { className: "d" }, t("autoRun"))),
				failed && react.createElement("div", { className: "dcc-err" }, t("loadFailed")),
				react.createElement("div", { className: "dcc-shell" },
					react.createElement("div", { className: "dcc-hero" },
						react.createElement("span", { className: "dcc-frac" },
							signed == null ? "—" : String(signed),
							react.createElement("i", null, "/3")),
						react.createElement("span", { className: "dcc-hero-lbl" }, "今日已签"),
						react.createElement("span", { className: "dcc-hero-tot" },
							react.createElement("span", { className: "n" }, total == null ? "—" : "+" + fmtNum(total)),
							react.createElement("span", { className: "lbl" }, "今日共得积分"))),
					react.createElement("div", { className: "dcc-tickets" },
						react.createElement(Ticket, { name: "Trae", data: data && data.trae, t }),
						react.createElement(Ticket, { name: "WorkBuddy", data: data && data.workbuddy, t }),
						react.createElement(Ticket, { name: "Qoder", data: q, t, pat })),
					react.createElement("div", { className: "dcc-foot" },
						react.createElement("span", null, "幂等：当日已签自动跳过"),
						react.createElement("button", { className: "dcc-linkbtn", type: "button", onClick: load }, t("refresh")))));
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
			intro: "Trae、WorkBuddy 与 Qoder 每日自动签到状态",
			refresh: "刷新状态",
			autoRun: "随 DSH 启动自动执行，幂等不重复",
			loadFailed: "加载失败，请稍后重试",
			creditsRemaining: "剩余",
			creditsUsed: "已使用",
			creditsExpiring: "3天内到期",
			expiringAlert: "提醒：{n} 积分将在 3 天内到期，请尽快使用"
		};
		const en = {
			panel: "Check-in",
			title: "Daily Check-in",
			intro: "Trae, WorkBuddy and Qoder daily check-in status",
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
