/**
 * Client half of dsh-skill-groups.
 *
 * Three surfaces, one shared store:
 *   1. `conversation.input.left`        — the composer chip (id `skill-groups-chip`)
 *   2. `sidebar.panellist` + `main`     — the management page (id/key `skill-groups`)
 *   3. `conversation.session.header.actions` — a header button (id `skill-groups-header`)
 *
 * Every surface reads the same module-level store, so one mutation (POST) plus
 * one `GET /state` re-renders all three at once. All HTTP goes through
 * `/api/skill-groups/*` with the session id in `x-dsh-skill-groups-session`;
 * every call is guarded, because the Host half may be absent or disabled and a
 * missing service must degrade to a quiet inline message, never a crash.
 *
 * Styling rule: this file never paints a literal colour. Text uses `inherit`,
 * `currentColor`, or the shipped `--dsw-*` theme tokens, which carry both light
 * and dark values, so the UI stays legible in either theme.
 */

window.__ModuleLoader__.load({
	id: "dsh-skill-groups",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const ReactModule = require("react");
		const React = ReactModule && typeof ReactModule.createElement === "function" ? ReactModule : ReactModule.default;
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const h = React.createElement;

		//#region locale
		/** Locale namespace for every string this plugin renders. */
		const NS = "skillGroups";

		/**
		 * Simplified Chinese dictionary.
		 *
		 * Keys follow CONTRACT.md §9 exactly. The handful of keys not listed in
		 * §9 are marked `EXTRA` — they exist because the contract's key set has no
		 * wording for a count, a confirm/cancel pair, icon-only affordances, or
		 * the panel's empty detail pane.
		 */
		const zh = {
			"meta.title": "技能组",
			"meta.description": "把技能分成互斥或附加的组，一键切换，只影响模型能发现的技能目录，不删除技能、不改文件。",
			"chip.label": "技能组",
			"chip.none": "全部技能",
			"chip.skills": "{count} 个技能",
			"panel.title": "技能组",
			"panel.current": "当前生效",
			"panel.groups": "技能组",
			"panel.members": "成员",
			"panel.cost": "目录成本",
			"panel.costHint": "该组会让模型目录包含约 {chars} 字符，≈{tokens} tokens。",
			"panel.masked": "已隐藏 {count} 个技能",
			"panel.reasonActive": "当前组激活",
			"panel.reasonUngrouped": "未归组，按默认策略保留",
			"panel.reasonInactive": "属于「{group}」，该组未激活",
			"panel.reasonPolicy": "未归组，且默认策略为不加载",
			"panel.defaultPolicy": "未归组技能",
			"panel.defaultAll": "保持可见",
			"panel.defaultNone": "隐藏",
			"panel.newGroup": "新建组",
			"panel.apply": "启用此组",
			"panel.clear": "关闭全部",
			"panel.undo": "撤销上一次切换",
			"panel.save": "保存",
			"panel.delete": "删除",
			"panel.export": "导出",
			"panel.import": "导入",
			"panel.search": "搜索技能",
			"panel.empty": "还没有技能组。新建一个，然后把技能拖进来。",
			"panel.autoRules": "自动激活规则",
			"panel.ruleAdd": "添加规则",
			"panel.ruleWorkspace": "工作区路径包含",
			"panel.rulePreset": "Agent 预设",
			"panel.ruleKeywords": "关键词",
			"panel.forTurn": "只对下一轮生效",
			"panel.noSelection": "选择一个技能组查看详情",
			"panel.note": "备注",
			"panel.ioHint": "把上面的 JSON 改好后点「导入」覆盖现有分组。",
			"action.add": "加入",
			"action.remove": "移出",
			"action.rename": "重命名",
			"action.confirm": "确认",
			"action.cancel": "取消",
			"action.refresh": "刷新",
			"action.move": "拖动排序",
			"action.manage": "管理技能组",
		};

		/** English dictionary, same key set as {@link zh}. */
		const en = {
			"meta.title": "Skill Groups",
			"meta.description": "Group skills and toggle any combination of them. Only the model-visible catalog changes — no skill is deleted and no file is rewritten.",
			"chip.label": "Skill group",
			"chip.none": "All skills",
			"chip.skills": "{count} skills",
			"panel.title": "Skill Groups",
			"panel.current": "Active now",
			"panel.groups": "Groups",
			"panel.members": "Members",
			"panel.cost": "Catalog cost",
			"panel.costHint": "This group puts about {chars} characters (≈{tokens} tokens) into the model catalog.",
			"panel.masked": "{count} skills hidden",
			"panel.reasonActive": "Active group",
			"panel.reasonUngrouped": "Ungrouped — kept by the default policy",
			"panel.reasonInactive": "Belongs to \"{group}\", which is inactive",
			"panel.reasonPolicy": "Ungrouped, and the default policy hides those",
			"panel.defaultPolicy": "Ungrouped skills",
			"panel.defaultAll": "Stay visible",
			"panel.defaultNone": "Hide",
			"panel.newGroup": "New group",
			"panel.apply": "Enable this group",
			"panel.clear": "Turn all off",
			"panel.undo": "Undo last switch",
			"panel.save": "Save",
			"panel.delete": "Delete",
			"panel.export": "Export",
			"panel.import": "Import",
			"panel.search": "Search skills",
			"panel.empty": "No skill groups yet. Create one, then add skills to it.",
			"panel.autoRules": "Auto-activation rules",
			"panel.ruleAdd": "Add rule",
			"panel.ruleWorkspace": "Workspace path contains",
			"panel.rulePreset": "Agent preset",
			"panel.ruleKeywords": "Keywords",
			"panel.forTurn": "Next turn only",
			"panel.noSelection": "Select a group to see its details",
			"panel.note": "Note",
			"panel.ioHint": "Edit the JSON above, then press Import to replace the stored groups.",
			"action.add": "Add",
			"action.remove": "Remove",
			"action.rename": "Rename",
			"action.confirm": "Confirm",
			"action.cancel": "Cancel",
			"action.refresh": "Refresh",
			"action.move": "Drag to reorder",
			"action.manage": "Manage groups",
		};
		//#endregion

		//#region constants
		/** HTTP prefix served by the Host half (CONTRACT.md §5). */
		const API_PREFIX = "/api/skill-groups";
		/** Entry id shared by the sidebar row and the `main` key it dispatches. */
		const PANEL_ID = "skill-groups";
		/** Description cap used by the catalog projection (CONTRACT.md §4). */
		const DESCRIPTION_MAX_LENGTH = 500;
		/** Seperator width accounted for by the catalog cost formula. */
		const NAME_SEPARATOR_CHARS = 4;
		//#endregion

		//#region primitives access
		/**
		 * Read one export from the primitives namespace.
		 *
		 * The loader may hand this file the ES-module face (named exports) or a
		 * CommonJS namespace whose values sit under `default`, so both are probed.
		 * A missing export is not an error: every icon call site degrades to
		 * rendering nothing rather than crashing the surface.
		 */
		function primitive(name) {
			if (primitives === undefined || primitives === null) return undefined;
			const direct = primitives[name];
			if (typeof direct === "function") return direct;
			const fallback = primitives.default;
			if (fallback !== undefined && fallback !== null && typeof fallback[name] === "function") return fallback[name];
			return undefined;
		}

		const IconSkill = primitive("IconSkillOutlineRegular");
		const IconCheck = primitive("IconCheckOutlineRegular");
		const IconClose = primitive("IconCloseOutlineRegular");
		const IconSearch = primitive("IconSearchOutlineRegular");
		const IconTrash = primitive("IconTrashOutlineRegular");
		const IconPlus = primitive("IconPlusOutlineRegular");
		const IconUp = primitive("IconChevronUpOutlineRegular");
		const IconDown = primitive("IconChevronDownOutlineRegular");
		const IconRefresh = primitive("IconRefreshOutlineRegular");
		const IconDownload = primitive("IconDownloadOutlineRegular");
		const IconWarning = primitive("IconWarningOutlineRegular");
		const IconSliders = primitive("IconSlidersTwoOutlineRegular");

		/**
		 * Render one icon export, or nothing.
		 * @param icon - a primitives icon component, possibly absent.
		 * @param size - square edge in pixels.
		 */
		function icon(icon, size) {
			return typeof icon === "function" ? h(icon, { size: size === undefined ? 14 : size }) : null;
		}
		//#endregion

		//#region stylesheet
		/**
		 * One stylesheet for all three surfaces.
		 *
		 * Every colour is a `--dsw-*` theme token (defined with a light AND a dark
		 * value by the theme plugin) or the inherited text colour. No literal hex,
		 * rgb, or named colour appears here, so the surfaces follow the active
		 * theme instead of hard-coding one.
		 */
		const STYLE = [
			".dsh-sg-root{display:flex;flex-direction:column;gap:12px;min-width:0;font-size:13px;line-height:1.5}",
			".dsh-sg-chip{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:250px;padding:0 10px;",
			"border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;color:inherit;",
			"font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden}",
			".dsh-sg-chip:hover{border-color:var(--dsw-alias-border-l3)}",
			".dsh-sg-chip[aria-expanded=\"true\"]{border-color:var(--dsw-alias-border-l3)}",
			".dsh-sg-chip-text{overflow:hidden;text-overflow:ellipsis}",
			".dsh-sg-chip-count{opacity:.62;font-variant-numeric:tabular-nums}",
			".dsh-sg-pop{position:fixed;z-index:80;min-width:220px;max-width:330px;max-height:min(60vh,420px);overflow:auto;",
			"padding:8px;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;",
			"background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);",
			"box-shadow:var(--dsw-elevation-panel);display:flex;flex-direction:column;gap:2px}",
			".dsh-sg-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;",
			"padding:2px 6px 6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-sg-pop-sep{height:0;margin:6px 0;border-top:1px solid var(--dsw-alias-border-l2)}",
			".dsh-sg-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:1px solid transparent;",
			"border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}",
			".dsh-sg-row:hover{border-color:var(--dsw-alias-border-l2)}",
			".dsh-sg-row[aria-checked=\"true\"],.dsh-sg-row[data-selected=\"true\"]{border-color:var(--dsw-alias-border-l3)}",
			".dsh-sg-row-main{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-sg-row-kind{font-size:11px;opacity:.7;flex:0 0 auto}",
			".dsh-sg-grip{flex:0 0 auto;width:14px;display:inline-flex;justify-content:center;opacity:.5;cursor:grab}",
			".dsh-sg-grip:active{cursor:grabbing}",
			".dsh-sg-mark{flex:0 0 auto;width:14px;display:inline-flex;justify-content:center;opacity:.85}",
			".dsh-sg-hint{padding:4px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-sg-page{display:flex;flex-direction:column;gap:14px;padding:18px 20px;min-height:100%;box-sizing:border-box;overflow:auto}",
			".dsh-sg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}",
			".dsh-sg-title{margin:0;font-size:16px;font-weight:600;color:inherit}",
			".dsh-sg-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-sg-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
			".dsh-sg-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:7px;",
			"border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font:inherit;font-size:12px;",
			"cursor:pointer;white-space:nowrap}",
			".dsh-sg-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
			".dsh-sg-btn:disabled{opacity:.45;cursor:not-allowed}",
			".dsh-sg-btn[data-danger=\"true\"]{border-color:var(--dsw-alias-state-error-secondary)}",
			".dsh-sg-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;",
			"border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:inherit;cursor:pointer}",
			".dsh-sg-icon-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
			".dsh-sg-icon-btn:disabled{opacity:.4;cursor:not-allowed}",
			".dsh-sg-body{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}",
			".dsh-sg-col{display:flex;flex-direction:column;gap:8px;min-width:0}",
			".dsh-sg-col-groups{flex:0 1 260px;min-width:220px}",
			".dsh-sg-col-detail{flex:1 1 380px;min-width:280px}",
			".dsh-sg-card{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}",
			".dsh-sg-label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}",
			".dsh-sg-value{font-size:13px}",
			".dsh-sg-input{width:100%;box-sizing:border-box;height:26px;padding:0 8px;border-radius:7px;",
			"border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font:inherit;font-size:12px}",
			".dsh-sg-input:focus-visible{outline:none;border-color:var(--dsw-alias-border-l3)}",
			".dsh-sg-textarea{width:100%;box-sizing:border-box;min-height:96px;padding:6px 8px;border-radius:7px;",
			"border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;",
			"font:inherit;font-size:12px;font-family:var(--dsw-font-family);resize:vertical}",
			".dsh-sg-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".dsh-sg-inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
			".dsh-sg-spacer{flex:1 1 auto}",
			".dsh-sg-list{display:flex;flex-direction:column;gap:2px;max-height:340px;overflow:auto}",
			".dsh-sg-skill{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:7px;border:1px solid transparent}",
			".dsh-sg-skill:hover{border-color:var(--dsw-alias-border-l2)}",
			".dsh-sg-skill-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-sg-skill-meta{font-size:11px;opacity:.66;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-sg-note{display:flex;align-items:flex-start;gap:6px;padding:8px 10px;border-radius:8px;",
			"border:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dsh-sg-note[data-tone=\"error\"]{border-color:var(--dsw-alias-state-error-secondary)}",
			".dsh-sg-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;overflow:hidden}",
			".dsh-sg-seg>button{height:24px;padding:0 9px;border:0;border-radius:0;background:transparent;color:inherit;",
			"font:inherit;font-size:12px;cursor:pointer}",
			".dsh-sg-seg>button+button{border-left:1px solid var(--dsw-alias-border-l2)}",
			".dsh-sg-seg>button[aria-pressed=\"true\"]{font-weight:600}",
			".dsh-sg-seg>button[aria-pressed=\"true\"]::before{content:\"\"}",
			".dsh-sg-tag{display:inline-flex;align-items:center;gap:4px;padding:0 6px;height:18px;border-radius:5px;",
			"border:1px solid var(--dsw-alias-border-l2);font-size:11px;opacity:.9}",
			".dsh-sg-mono{font-family:var(--dsw-font-family);font-size:11px;opacity:.75}",
			".dsh-sg-empty{padding:14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;",
			"font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center}",
		].join("");

		/**
		 * Inject the plugin stylesheet once per page.
		 * @returns disposer removing exactly this tag.
		 */
		function installStyles() {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-skill-groups";
			tag.dataset.pluginCss = "dsh-skill-groups/client.css";
			tag.textContent = STYLE;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		//#endregion

		//#region transport
		/**
		 * Session id contributed by the most recent session-scoped mount.
		 *
		 * The chip and the header action both receive `sessionId` as a standard
		 * prop. The management page lives in the root-scoped `main` slot and gets
		 * none, so it reads this hint; when no session surface has ever mounted it
		 * falls back to `?session=` and finally to the empty string, which the Host
		 * documents as "the global default session".
		 */
		let sessionHint = "";

		function setSessionHint(value) {
			if (typeof value === "string" && value !== "") sessionHint = value;
		}

		function currentSessionId() {
			if (sessionHint !== "") return sessionHint;
			try {
				const params = new URLSearchParams(window.location.search);
				return params.get("session") ?? "";
			} catch {
				return "";
			}
		}

		/**
		 * Call one Host route.
		 * @param path - path below `/api/skill-groups`.
		 * @param body - JSON body; anything other than `undefined` makes it a POST.
		 * @param sessionId - explicit session override.
		 * @returns the parsed `{ ok: true, ... }` payload.
		 * @throws when the transport, the status code, or the envelope fails.
		 */
		async function call(path, body, sessionId) {
			const headers = {};
			const scope = typeof sessionId === "string" ? sessionId : currentSessionId();
			if (scope !== "") headers["x-dsh-skill-groups-session"] = scope;
			const init = { headers, credentials: "same-origin" };
			if (body !== undefined) {
				headers["content-type"] = "application/json";
				init.method = "POST";
				init.body = JSON.stringify(body);
			}
			const response = await fetch(API_PREFIX + path, init);
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			if (!response.ok) {
				const detail = payload !== undefined && payload !== null ? payload.error ?? payload.code : undefined;
				throw new Error(typeof detail === "string" && detail !== "" ? detail : "HTTP " + String(response.status));
			}
			if (payload === undefined || payload === null) throw new Error("empty response");
			if (payload.ok === false) throw new Error(payload.error ?? payload.code ?? "request rejected");
			return payload;
		}

		function messageOf(error) {
			if (error === undefined || error === null) return "unknown error";
			if (typeof error.message === "string" && error.message !== "") return error.message;
			return String(error);
		}
		//#endregion

		//#region store
		/**
		 * The one shared client store.
		 *
		 * Reads and writes are serialized through a promise chain so a burst of
		 * clicks cannot interleave a POST with the `GET /state` that follows it.
		 */
		function createStore() {
			let snapshot = {
				status: "idle",
				error: null,
				data: null,
				sessionId: "",
				busy: false,
				actionError: null,
			};
			const listeners = new Set();
			let chain = Promise.resolve();

			const emit = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (error) {
						console.error("skill-groups: a store listener crashed", error);
					}
				}
			};

			const patch = (next) => {
				snapshot = { ...snapshot, ...next };
				emit();
			};

			const read = () => snapshot;

			const subscribe = (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			};

			/** Fetch `/state` and publish it. */
			const refresh = () => {
				const scope = currentSessionId();
				patch({ status: snapshot.data === null ? "loading" : snapshot.status, sessionId: scope });
				chain = chain.then(async () => {
					try {
						const payload = await call("/state", undefined, scope);
						patch({ status: "ready", error: null, data: payload });
					} catch (error) {
						patch({ status: "error", error: messageOf(error) });
					}
				});
				return chain;
			};

			/** POST a mutation, then re-read `/state` so every surface updates. */
			const mutate = (path, body) => {
				const scope = currentSessionId();
				patch({ busy: true, actionError: null, sessionId: scope });
				chain = chain.then(async () => {
					try {
						await call(path, body === undefined ? {} : body, scope);
					} catch (error) {
						patch({ busy: false, actionError: messageOf(error) });
						return;
					}
					try {
						const payload = await call("/state", undefined, scope);
						patch({ status: "ready", error: null, data: payload, busy: false });
					} catch (error) {
						patch({ busy: false, error: messageOf(error) });
					}
				});
				return chain;
			};

			/** Load once; a later call is a no-op while data is present. */
			const ensure = () => {
				if (snapshot.status === "idle") return refresh();
				return chain;
			};

			const clearActionError = () => patch({ actionError: null });

			return { read, subscribe, refresh, mutate, ensure, clearActionError };
		}

		const store = createStore();

		/**
		 * Subscribe one component to the store.
		 * @returns the current snapshot, re-rendering on every change.
		 */
		function useSnapshot() {
			const [snapshot, setSnapshot] = React.useState(() => store.read());
			React.useEffect(() => store.subscribe(() => setSnapshot(store.read())), []);
			return snapshot;
		}

		/**
		 * Bind a surface to one session and make sure data is loaded.
		 * @param sessionId - the standard `sessionId` prop, when the slot provides it.
		 */
		function useSurface(sessionId) {
			React.useEffect(() => {
				setSessionHint(sessionId);
			}, [sessionId]);
			React.useEffect(() => {
				store.ensure();
			}, []);
			return useSnapshot();
		}
		//#endregion

		//#region projections
		/** Groups from the latest payload, always an array. */
		function groupsOf(data) {
			const groups = data !== null && data !== undefined && data.state !== undefined && data.state !== null ? data.state.groups : undefined;
			return Array.isArray(groups) ? groups : [];
		}

		/** Auto-activation rules from the latest payload, always an array. */
		function rulesOf(data) {
			const rules = data !== null && data !== undefined && data.state !== undefined && data.state !== null ? data.state.rules : undefined;
			return Array.isArray(rules) ? rules : [];
		}

		/** The session's effective selection of active group ids, falling back to the global one. */
		function selectionOf(data) {
			if (data === null || data === undefined) return [];
			const source = data.selection ?? (data.state !== undefined && data.state !== null ? data.state.active : undefined);
			if (source === null || source === undefined || typeof source !== "object") return [];
			if (Array.isArray(source.activeIds)) return source.activeIds.filter((id) => typeof id === "string");
			// Legacy fallbacks for a host that predates activeIds.
			const ids = [];
			if (Array.isArray(source.additive)) for (const id of source.additive) if (typeof id === "string") ids.push(id);
			if (typeof source.exclusive === "string" && source.exclusive !== "") ids.push(source.exclusive);
			return ids;
		}

		/** Ids of every currently effective group (same shape as selectionOf). */
		function activeIdsOf(data) {
			return new Set(selectionOf(data));
		}

		/** Skill summaries reported by the Host. */
		function skillsOf(data) {
			const skills = data !== null && data !== undefined ? data.skills : undefined;
			return Array.isArray(skills) ? skills.filter((skill) => skill !== null && typeof skill === "object" && typeof skill.name === "string") : [];
		}

		/** Per-skill visibility rows from the Host. */
		function effectiveOf(data) {
			const effective = data !== null && data !== undefined ? data.effective : undefined;
			return Array.isArray(effective) ? effective : [];
		}

		/** Un-grouped skill policy: `all` or `none`. */
		function policyOf(data) {
			const policy = data !== null && data !== undefined && data.state !== undefined && data.state !== null ? data.state.defaultPolicy : undefined;
			return policy === "none" ? "none" : "all";
		}

		/** Count of hidden (model-invisible) skills in the latest payload. */
		function maskedOf(data) {
			if (data === null || data === undefined) return 0;
			return typeof data.maskedCount === "number" ? data.maskedCount : 0;
		}

		/** Catalog size in characters reported by the Host. */
		function charsOf(data) {
			if (data === null || data === undefined) return 0;
			return typeof data.catalogChars === "number" ? data.catalogChars : 0;
		}

		/** Catalog size in tokens reported by the Host. */
		function tokensOf(data) {
			if (data === null || data === undefined) return 0;
			return typeof data.catalogTokens === "number" ? data.catalogTokens : 0;
		}

		/** Name of a group id, or the id itself when it is gone. */
		function groupName(data, id) {
			const found = groupsOf(data).find((group) => group.id === id);
			return found !== undefined ? found.name : id;
		}

		/** Count of model-visible skills in the latest payload. */
		function visibleCount(data) {
			const effective = effectiveOf(data);
			if (effective.length > 0) return effective.filter((row) => row.visible === true).length;
			const skills = skillsOf(data);
			return Math.max(0, skills.length - maskedOf(data));
		}

		/**
		 * Build the grouping index the cost preview needs.
		 * @param data - latest `/state` payload.
		 */
		function buildContext(data) {
			const skills = skillsOf(data);
			const groups = groupsOf(data);
			const grouped = new Map();
			for (const group of groups) {
				const members = Array.isArray(group.members) ? group.members : [];
				for (const member of members) {
					const list = grouped.get(member);
					if (list === undefined) grouped.set(member, [group]);
					else list.push(group);
				}
			}
			return { skills, groups, grouped, defaultPolicy: policyOf(data) };
		}

		/**
		 * Cost preview for one group without applying it.
		 *
		 * Mirrors CONTRACT.md §4 exactly: a skill is counted when the group lists
		 * it, or when it is in no group at all and the default policy keeps
		 * ungrouped skills visible.
		 * @param context - result of {@link buildContext}.
		 * @param group - the group to preview.
		 */
		function previewCost(context, group) {
			const members = new Set(Array.isArray(group.members) ? group.members : []);
			let chars = 0;
			for (const skill of context.skills) {
				const inGroup = members.has(skill.name);
				const inAny = (context.grouped.get(skill.name) ?? []).length > 0;
				const visible = inGroup || (!inAny && context.defaultPolicy === "all");
				if (!visible) continue;
				const description = typeof skill.description === "string" ? skill.description.slice(0, DESCRIPTION_MAX_LENGTH) : "";
				chars += skill.name.length + description.length + NAME_SEPARATOR_CHARS;
			}
			return { chars, tokens: Math.ceil(chars / 4) };
		}

		/** Translated explanation for one `reason` value. */
		function reasonText(t, row) {
			if (row === undefined || row === null) return "";
			switch (row.reason) {
				case "active":
					return t("panel.reasonActive");
				case "ungrouped":
					return t("panel.reasonUngrouped");
				case "inactive-group":
					return t("panel.reasonInactive", { group: row.group ?? "" });
				case "policy-none":
					return t("panel.reasonPolicy");
				default:
					return "";
			}
		}
		//#endregion

		//#region shared chrome
		/** One inline error / hint strip. */
		function Notice({ tone, children }) {
			return h("div", { className: "dsh-sg-note", "data-tone": tone === "error" ? "error" : undefined }, icon(IconWarning, 14), h("span", null, children));
		}

		/** A labelled text input. */
		function Field({ label, value, placeholder, onChange, onEnter }) {
			return h(
				"label",
				{ className: "dsh-sg-field" },
				h("span", { className: "dsh-sg-label" }, label),
				h("input", {
					className: "dsh-sg-input",
					value: value,
					placeholder: placeholder === undefined ? "" : placeholder,
					onChange: (event) => onChange(event.currentTarget.value),
					onKeyDown: (event) => {
						if (event.key === "Enter" && typeof onEnter === "function") {
							event.preventDefault();
							onEnter();
						}
					},
				}),
			);
		}

		/** A two-state segmented control built from plain buttons. */
		function Segmented({ label, value, options, onChange }) {
			return h(
				"div",
				{ className: "dsh-sg-seg", role: "group", "aria-label": label },
				options.map((option) =>
					h(
						"button",
						{
							key: option.value,
							type: "button",
							"aria-pressed": option.value === value,
							title: option.label,
							onClick: () => onChange(option.value),
						},
						option.label,
					),
				),
			);
		}

		/** A destructive action that asks inline before it commits. */
		function ConfirmButton({ label, confirmLabel, cancelLabel, disabled, onConfirm }) {
			const [armed, setArmed] = React.useState(false);
			React.useEffect(() => {
				if (!armed) return undefined;
				const timer = window.setTimeout(() => setArmed(false), 6000);
				return () => window.clearTimeout(timer);
			}, [armed]);
			if (!armed) {
				return h(
					"button",
					{
						type: "button",
						className: "dsh-sg-btn",
						"data-danger": "true",
						disabled: disabled === true,
						onClick: () => setArmed(true),
					},
					icon(IconTrash, 13),
					h("span", null, label),
				);
			}
			return h(
				"span",
				{ className: "dsh-sg-inline" },
				h(
					"button",
					{
						type: "button",
						className: "dsh-sg-btn",
						"data-danger": "true",
						disabled: disabled === true,
						onClick: () => {
							setArmed(false);
							onConfirm();
						},
					},
					h("span", null, confirmLabel),
				),
				h(
					"button",
					{ type: "button", className: "dsh-sg-btn", onClick: () => setArmed(false) },
					h("span", null, cancelLabel),
				),
			);
		}
		//#endregion

		//#region composer chip
		/**
		 * The composer pill: active group name, a popover to switch, and counts.
		 *
		 * The popover is anchored with a fixed position taken from the pill's own
		 * rectangle, so it escapes the composer's overflow without a portal.
		 */
		function SkillGroupChip(props) {
			const { t, sessionId, openPanel } = props;
			const snapshot = useSurface(sessionId);
			const [open, setOpen] = React.useState(false);
			const [placement, setPlacement] = React.useState(null);
			const anchorRef = React.useRef(null);
			const popRef = React.useRef(null);

			const data = snapshot.data;
			const groups = groupsOf(data);
			const activeIds = activeIdsOf(data);
			const visible = visibleCount(data);
			const masked = maskedOf(data);

			const label = (() => {
				if (activeIds.size === 1) return groupName(data, [...activeIds][0]);
				if (activeIds.size > 1) return t("chip.label") + " · " + activeIds.size;
				return t("chip.none");
			})();

			React.useLayoutEffect(() => {
				if (!open) {
					setPlacement(null);
					return undefined;
				}
				const place = () => {
					const rect = anchorRef.current === null ? null : anchorRef.current.getBoundingClientRect();
					if (rect === null) return;
					setPlacement({
						left: Math.max(12, Math.min(rect.left, window.innerWidth - 340)),
						bottom: Math.max(12, window.innerHeight - rect.top + 8),
					});
				};
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [open]);

			React.useEffect(() => {
				if (!open) return undefined;
				const dismiss = (event) => {
					const target = event.target;
					if (anchorRef.current !== null && anchorRef.current.contains(target)) return;
					if (popRef.current !== null && popRef.current.contains(target)) return;
					setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", dismiss, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("pointerdown", dismiss, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [open]);

			const toggle = (group) => {
				const on = activeIds.has(group.id);
				store.mutate("/toggle", { group: group.id, enabled: !on });
			};

			const clear = () => {
				store.mutate("/clear", {});
			};

			const rows = groups.filter((group) => group.enabled !== false);

			const popover = open
				? h(
						"div",
						{
							ref: popRef,
							className: "dsh-sg-pop",
							role: "menu",
							"aria-label": t("chip.label"),
							"data-skill-groups-popover": "",
							style: placement === null ? { visibility: "hidden", left: 12, bottom: 12 } : { left: placement.left, bottom: placement.bottom },
						},
						h(
							"div",
							{ className: "dsh-sg-pop-head" },
							h("span", null, t("chip.label")),
							h("span", { className: "dsh-sg-skill-meta" }, t("panel.masked", { count: masked })),
						),
						snapshot.status === "error"
							? h(Notice, { tone: "error" }, t("chip.label") + ": " + String(snapshot.error ?? ""))
							: null,
						groups.length === 0 ? h("div", { className: "dsh-sg-empty" }, t("panel.empty")) : null,
						rows.map((group) =>
							h(
								"button",
								{
									key: group.id,
									type: "button",
									role: "menuitemcheckbox",
									"aria-checked": activeIds.has(group.id),
									className: "dsh-sg-row",
									onClick: () => toggle(group),
								},
								h("span", { className: "dsh-sg-mark" }, activeIds.has(group.id) ? icon(IconCheck, 13) : null),
								h("span", { className: "dsh-sg-row-main" }, group.name),
								h("span", { className: "dsh-sg-row-kind" }, String((group.members ?? []).length)),
							),
						),
						h("div", { className: "dsh-sg-pop-sep" }),
						h(
							"button",
							{
								type: "button",
								role: "menuitem",
								className: "dsh-sg-row",
								disabled: snapshot.busy,
								onClick: () => clear(),
							},
							h("span", { className: "dsh-sg-mark" }, icon(IconClose, 13)),
							h("span", { className: "dsh-sg-row-main" }, t("panel.clear")),
						),
						h(
							"button",
							{
								type: "button",
								role: "menuitem",
								className: "dsh-sg-row",
								onClick: () => {
									setOpen(false);
									if (typeof openPanel === "function") openPanel();
								},
							},
							h("span", { className: "dsh-sg-mark" }, icon(IconSliders, 13)),
							h("span", { className: "dsh-sg-row-main" }, t("action.manage")),
						),
						h(
							"div",
							{ className: "dsh-sg-hint" },
							t("chip.skills", { count: visible }),
							" · ",
							t("panel.cost"),
							": ",
							h("span", { className: "dsh-sg-mono" }, String(tokensOf(data))),
						),
						snapshot.actionError !== null
							? h(Notice, { tone: "error" }, String(snapshot.actionError))
							: null,
					)
				: null;

			return h(
				"span",
				{ className: "dsh-sg-root", "data-skill-groups-chip": "" },
				h(
					"button",
					{
						ref: anchorRef,
						type: "button",
						className: "dsh-sg-chip",
						title: t("chip.label"),
						"aria-haspopup": "menu",
						"aria-expanded": open,
						onClick: () => setOpen((current) => !current),
					},
					icon(IconSkill, 13),
					h("span", { className: "dsh-sg-chip-text" }, label),
					h("span", { className: "dsh-sg-chip-count" }, String(visible)),
				),
				popover,
			);
		}
		//#endregion

		//#region header action
		/** Session header button that opens the management panel. */
		function SkillGroupsHeaderAction(props) {
			const { t, sessionId, openPanel } = props;
			const snapshot = useSurface(sessionId);
			const active = activeIdsOf(snapshot.data).size > 0;
			return h(
				"button",
				{
					type: "button",
					className: "dsh-sg-icon-btn",
					title: t("panel.title"),
					"aria-label": t("panel.title"),
					"aria-pressed": active,
					"data-skill-groups-header": "",
					onClick: () => {
						if (typeof openPanel === "function") openPanel();
					},
				},
				icon(IconSkill, 15),
			);
		}
		//#endregion

		//#region management page
		/** One row in the group list: drag handle + checkbox + delete. */
		function GroupRow({ t, group, active, selected, busy, onSelect, onToggle, onDragStart, onDragOver, onDrop, onDelete }) {
			return h(
				"div",
				{
					className: "dsh-sg-skill",
					"data-selected": selected ? "true" : undefined,
					draggable: !busy,
					onDragStart: (event) => onDragStart(event, group.id),
					onDragOver: (event) => onDragOver(event),
					onDrop: (event) => onDrop(event, group.id),
				},
				h(
					"button",
					{
						type: "button",
						className: "dsh-sg-row",
						"data-selected": selected ? "true" : undefined,
						onClick: () => onSelect(group.id),
					},
					h(
						"span",
						{ className: "dsh-sg-grip", title: t("action.move"), "aria-label": t("action.move") },
						icon(IconSliders, 13),
					),
					h("span", { className: "dsh-sg-row-main" }, group.name),
					h("span", { className: "dsh-sg-row-kind" }, String((group.members ?? []).length)),
				),
				h(
					"button",
					{
						type: "button",
						role: "checkbox",
						"aria-checked": active,
						className: "dsh-sg-icon-btn",
						title: t("panel.apply"),
						"aria-label": t("panel.apply"),
						disabled: busy,
						onClick: () => onToggle(group),
					},
					active ? icon(IconCheck, 13) : null,
				),
				h(ConfirmButton, {
					label: t("panel.delete"),
					confirmLabel: t("action.confirm"),
					cancelLabel: t("action.cancel"),
					disabled: busy,
					onConfirm: () => onDelete(group),
				}),
			);
		}

		/** Create-a-group form. */
		function NewGroupForm({ t, busy, onCreate }) {
			const [name, setName] = React.useState("");
			const submit = () => {
				const trimmed = name.trim();
				if (trimmed === "") return;
				onCreate({ name: trimmed, members: [], note: "" });
				setName("");
			};
			return h(
				"div",
				{ className: "dsh-sg-card" },
				h("span", { className: "dsh-sg-label" }, t("panel.newGroup")),
				h(Field, { label: t("panel.newGroup"), value: name, onChange: setName, onEnter: submit }),
				h(
					"div",
					{ className: "dsh-sg-inline" },
					h("span", { className: "dsh-sg-spacer" }),
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", disabled: busy || name.trim() === "", onClick: submit },
						icon(IconPlus, 13),
						h("span", null, t("panel.save")),
					),
				),
			);
		}

		/** One auto-rule row, editable in place. */
		function RuleRow({ t, rule, busy, onSave, onDelete }) {
			const [workspace, setWorkspace] = React.useState(rule.match?.workspace ?? "");
			const [preset, setPreset] = React.useState(rule.match?.preset ?? "");
			const [keywords, setKeywords] = React.useState((rule.match?.keywords ?? []).join(", "));
			React.useEffect(() => {
				setWorkspace(rule.match?.workspace ?? "");
				setPreset(rule.match?.preset ?? "");
				setKeywords((rule.match?.keywords ?? []).join(", "));
			}, [rule.id, rule.match?.workspace, rule.match?.preset, (rule.match?.keywords ?? []).join(",")]);
			const save = () => {
				onSave({
					id: rule.id,
					group: rule.group,
					match: {
						workspace: workspace.trim(),
						preset: preset.trim(),
						keywords: keywords
							.split(",")
							.map((item) => item.trim())
							.filter((item) => item !== ""),
					},
				});
			};
			return h(
				"div",
				{ className: "dsh-sg-card" },
				h(Field, { label: t("panel.ruleWorkspace"), value: workspace, onChange: setWorkspace }),
				h(Field, { label: t("panel.rulePreset"), value: preset, onChange: setPreset }),
				h(Field, { label: t("panel.ruleKeywords"), value: keywords, onChange: setKeywords, placeholder: "," }),
				h(
					"div",
					{ className: "dsh-sg-inline" },
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", disabled: busy, onClick: save },
						icon(IconCheck, 13),
						h("span", null, t("panel.save")),
					),
					h("span", { className: "dsh-sg-spacer" }),
					h(ConfirmButton, {
						label: t("action.remove"),
						confirmLabel: t("action.confirm"),
						cancelLabel: t("action.cancel"),
						disabled: busy,
						onConfirm: () => onDelete(rule),
					}),
				),
			);
		}

		/** Member picker for the selected group. */
		function MemberPicker({ t, context, group, effectiveByName, busy, onToggleMember }) {
			const [search, setSearch] = React.useState("");
			const members = new Set(Array.isArray(group.members) ? group.members : []);
			const query = search.trim().toLowerCase();
			const rows = context.skills.filter((skill) => {
				if (query === "") return true;
				const name = skill.name.toLowerCase();
				const description = typeof skill.description === "string" ? skill.description.toLowerCase() : "";
				return name.includes(query) || description.includes(query);
			});
			return h(
				"div",
				{ className: "dsh-sg-card" },
				h(
					"div",
					{ className: "dsh-sg-inline" },
					h("span", { className: "dsh-sg-label" }, t("panel.members")),
					h("span", { className: "dsh-sg-skill-meta" }, String(members.size)),
					h("span", { className: "dsh-sg-spacer" }),
					icon(IconSearch, 13),
					h("input", {
						className: "dsh-sg-input",
						style: { width: "160px" },
						value: search,
						placeholder: t("panel.search"),
						"aria-label": t("panel.search"),
						onChange: (event) => setSearch(event.currentTarget.value),
					}),
				),
				context.skills.length === 0
					? h("div", { className: "dsh-sg-empty" }, t("panel.search"))
					: h(
							"div",
							{ className: "dsh-sg-list" },
							rows.length === 0 ? h("div", { className: "dsh-sg-empty" }, t("panel.search")) : null,
							rows.map((skill) => {
								const isMember = members.has(skill.name);
								const row = effectiveByName.get(skill.name);
								const reason = isMember ? "" : reasonText(t, row);
								return h(
									"div",
									{ key: skill.name, className: "dsh-sg-skill" },
									h(
										"span",
										{ className: "dsh-sg-col", style: { flex: "1 1 auto", gap: "0" } },
										h("span", { className: "dsh-sg-skill-name" }, skill.name),
										h(
											"span",
											{ className: "dsh-sg-skill-meta" },
											typeof skill.source === "string" ? skill.source : "",
											reason === "" ? "" : " · " + reason,
										),
									),
									h(
										"button",
										{
											type: "button",
											className: "dsh-sg-btn",
											disabled: busy,
											"aria-pressed": isMember,
											onClick: () => onToggleMember(skill.name, !isMember),
										},
										icon(isMember ? IconClose : IconPlus, 13),
										h("span", null, isMember ? t("action.remove") : t("action.add")),
									),
								);
							}),
						),
			);
		}

		/** The management page behind the sidebar row. */
		function SkillGroupsPage(props) {
			const { t } = props;
			const snapshot = useSurface(undefined);
			const data = snapshot.data;
			const context = React.useMemo(() => buildContext(data), [data]);
			const groups = context.groups;
			const activeIds = activeIdsOf(data);
			const policy = policyOf(data);
			const masked = maskedOf(data);
			const totalTokens = tokensOf(data);
			const totalChars = charsOf(data);

			const [selectedId, setSelectedId] = React.useState(null);
			const [ioText, setIoText] = React.useState("");
			const [ioError, setIoError] = React.useState(null);
			const [dragId, setDragId] = React.useState(null);

			React.useEffect(() => {
				if (groups.length === 0) {
					if (selectedId !== null) setSelectedId(null);
					return;
				}
				if (selectedId === null || groups.every((group) => group.id !== selectedId)) setSelectedId(groups[0].id);
			}, [groups, selectedId]);

			const selected = groups.find((group) => group.id === selectedId) ?? null;

			const effectiveByName = React.useMemo(() => {
				const map = new Map();
				for (const row of effectiveOf(data)) if (typeof row.name === "string") map.set(row.name, row);
				return map;
			}, [data]);

			const busy = snapshot.busy === true;

			const mutate = store.mutate;

			const createGroup = (group) => mutate("/group/save", { group });
			const deleteGroup = (group) => mutate("/group/delete", { id: group.id });
			const toggleMember = (name, add) => {
				if (selected === null) return;
				mutate("/group/member", { id: selected.id, skill: name, add });
			};
			const saveRule = (rule) => mutate("/rule/save", { rule });
			const deleteRule = (rule) => mutate("/rule/delete", { id: rule.id });

			/**
			 * Persist a full group order after a drag-and-drop reorder.
			 *
			 * The API has a dedicated `/group/reorder` route that takes the complete
			 * ordered id list, which is exactly what a drag drop produces.
			 */
			const moveGroup = (dragId, dropId) => {
				const from = groups.findIndex((item) => item.id === dragId);
				const to = groups.findIndex((item) => item.id === dropId);
				if (from < 0 || to < 0 || from === to) return;
				const next = groups.slice();
				const [moved] = next.splice(from, 1);
				next.splice(to, 0, moved);
				mutate("/group/reorder", { ids: next.map((item) => item.id) });
			};

			const doExport = async () => {
				setIoError(null);
				try {
					const payload = await call("/export", undefined, currentSessionId());
					setIoText(JSON.stringify({ groups: payload.groups ?? [], rules: payload.rules ?? [] }, null, 2));
				} catch (error) {
					setIoError(messageOf(error));
				}
			};

			const doImport = () => {
				setIoError(null);
				let parsed;
				try {
					parsed = JSON.parse(ioText);
				} catch (error) {
					setIoError(messageOf(error));
					return;
				}
				if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.groups)) {
					setIoError("groups[] expected");
					return;
				}
				const body = { groups: parsed.groups };
				if (Array.isArray(parsed.rules)) body.rules = parsed.rules;
				mutate("/import", body);
			};

			const cost = selected === null ? null : previewCost(context, selected);
			const selectedRules = selected === null ? [] : rulesOf(data).filter((rule) => rule.group === selected.id);

			const header = h(
				"div",
				{ className: "dsh-sg-head" },
				h(
					"div",
					null,
					h("h2", { className: "dsh-sg-title" }, t("panel.title")),
					h(
						"p",
						{ className: "dsh-sg-sub" },
						t("panel.current"),
						": ",
						activeIds.size === 0
							? t("chip.none")
							: [...activeIds].map((id) => groupName(data, id)).join(" + "),
						" · ",
						t("chip.skills", { count: visibleCount(data) }),
						" · ",
						t("panel.masked", { count: masked }),
					),
				),
				h(
					"div",
					{ className: "dsh-sg-actions" },
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", disabled: busy, onClick: () => store.refresh() },
						icon(IconRefresh, 13),
						h("span", null, t("action.refresh")),
					),
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", disabled: busy, onClick: () => mutate("/undo", {}) },
						h("span", null, t("panel.undo")),
					),
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", disabled: busy, onClick: () => mutate("/clear", {}) },
						h("span", null, t("panel.clear")),
					),
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", onClick: doExport },
						icon(IconDownload, 13),
						h("span", null, t("panel.export")),
					),
				),
			);

			const groupColumn = h(
				"aside",
				{ className: "dsh-sg-col dsh-sg-col-groups" },
				h(
					"div",
					{ className: "dsh-sg-inline" },
					h("span", { className: "dsh-sg-label" }, t("panel.groups")),
					h("span", { className: "dsh-sg-skill-meta" }, String(groups.length)),
				),
				groups.length === 0
					? h("div", { className: "dsh-sg-empty" }, t("panel.empty"))
					: h(
							"div",
							{ className: "dsh-sg-list" },
							groups.map((group) =>
								h(GroupRow, {
									key: group.id,
									t,
									group,
									active: activeIds.has(group.id),
									selected: group.id === selectedId,
									busy,
									onSelect: setSelectedId,
									onToggle: (item) => mutate("/toggle", { group: item.id, enabled: !activeIds.has(item.id) }),
									onDragStart: (event, id) => {
										setDragId(id);
										if (event.dataTransfer !== null && typeof event.dataTransfer.setData === "function") {
											event.dataTransfer.setData("text/plain", id);
											event.dataTransfer.effectAllowed = "move";
										}
									},
									onDragOver: (event) => {
										event.preventDefault();
										if (event.dataTransfer !== null && typeof event.dataTransfer.dropEffect === "string") {
											event.dataTransfer.dropEffect = "move";
										}
									},
									onDrop: (event, id) => {
										event.preventDefault();
										const sourceId = dragId
											?? (event.dataTransfer !== null && typeof event.dataTransfer.getData === "function"
												? event.dataTransfer.getData("text/plain")
												: null);
										setDragId(null);
										if (typeof sourceId === "string" && sourceId !== "") moveGroup(sourceId, id);
									},
									onDelete: deleteGroup,
								}),
							),
						),
				h(NewGroupForm, { t, busy, onCreate: createGroup }),
			);

			const detail = h(
				"div",
				{ className: "dsh-sg-col dsh-sg-col-detail" },
				selected === null
					? h("div", { className: "dsh-sg-empty" }, t("panel.noSelection"))
					: h(
							React.Fragment,
							null,
							h(GroupIdentity, {
								t,
								group: selected,
								busy,
								cost,
								active: activeIds.has(selected.id),
								onRename: (group) => mutate("/group/save", { group }),
								onApply: () => mutate("/apply", { group: selected.id }),
							}),
							h(MemberPicker, {
								t,
								context,
								group: selected,
								effectiveByName,
								busy,
								onToggleMember: toggleMember,
							}),
							h(
								"div",
								{ className: "dsh-sg-card" },
								h(
									"div",
									{ className: "dsh-sg-inline" },
									h("span", { className: "dsh-sg-label" }, t("panel.autoRules")),
									h("span", { className: "dsh-sg-spacer" }),
									h(
										"button",
										{
											type: "button",
											className: "dsh-sg-btn",
											disabled: busy,
											onClick: () => saveRule({ group: selected.id, match: { workspace: "", preset: "", keywords: [] } }),
										},
										icon(IconPlus, 13),
										h("span", null, t("panel.ruleAdd")),
									),
								),
								selectedRules.length === 0 ? null : h(
									"div",
									{ className: "dsh-sg-list" },
									selectedRules.map((rule) =>
										h(RuleRow, {
											key: rule.id,
											t,
											rule,
											busy,
											onSave: saveRule,
											onDelete: deleteRule,
										}),
									),
								),
							),
						),
			);

			const footer = h(
				"div",
				{ className: "dsh-sg-card" },
				h(
					"div",
					{ className: "dsh-sg-inline" },
					h("span", { className: "dsh-sg-label" }, t("panel.defaultPolicy")),
					h(Segmented, {
						label: t("panel.defaultPolicy"),
						value: policy,
						options: [
							{ value: "all", label: t("panel.defaultAll") },
							{ value: "none", label: t("panel.defaultNone") },
						],
						onChange: (next) => mutate("/policy", { defaultPolicy: next }),
					}),
					h("span", { className: "dsh-sg-spacer" }),
					h("span", { className: "dsh-sg-skill-meta" }, t("panel.cost") + ": " + String(totalTokens)),
				),
				h("span", { className: "dsh-sg-hint" }, t("panel.costHint", { chars: totalChars, tokens: totalTokens })),
				h("div", { className: "dsh-sg-inline" }, h("span", { className: "dsh-sg-mono" }, "/skillset " + "…" + " --for-turn"), h("span", { className: "dsh-sg-skill-meta" }, t("panel.forTurn"))),
				h("span", { className: "dsh-sg-hint" }, t("panel.ioHint")),
				h("textarea", {
					className: "dsh-sg-textarea",
					value: ioText,
					"aria-label": t("panel.import"),
					placeholder: t("panel.export") + " / " + t("panel.import"),
					onChange: (event) => setIoText(event.currentTarget.value),
				}),
				h(
					"div",
					{ className: "dsh-sg-inline" },
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", onClick: doExport },
						icon(IconDownload, 13),
						h("span", null, t("panel.export")),
					),
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", disabled: busy || ioText.trim() === "", onClick: doImport },
						h("span", null, t("panel.import")),
					),
				),
				ioError === null ? null : h(Notice, { tone: "error" }, ioError),
			);

			return h(
				"section",
				{ className: "dsh-sg-page", "aria-label": t("panel.title"), "data-skill-groups-page": "" },
				header,
				snapshot.status === "error"
					? h(Notice, { tone: "error" }, String(snapshot.error ?? ""))
					: null,
				snapshot.actionError !== null ? h(Notice, { tone: "error" }, String(snapshot.actionError)) : null,
				h("div", { className: "dsh-sg-body" }, groupColumn, detail),
				footer,
			);
		}

		/** Name / kind / cost / apply block for the selected group. */
		function GroupIdentity({ t, group, busy, cost, active, onRename, onApply }) {
			const [name, setName] = React.useState(group.name);
			const [note, setNote] = React.useState(group.note ?? "");
			React.useEffect(() => {
				setName(group.name);
				setNote(group.note ?? "");
			}, [group.id, group.name, group.note]);
			const save = () => {
				const trimmed = name.trim();
				if (trimmed === "") return;
				onRename({
					id: group.id,
					name: trimmed,
					members: group.members ?? [],
					note: note,
				});
			};
			return h(
				"div",
				{ className: "dsh-sg-card" },
				h(
					"div",
					{ className: "dsh-sg-inline" },
					h("span", { className: "dsh-sg-label" }, t("action.rename")),
					h("span", { className: "dsh-sg-spacer" }),
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", disabled: busy || active, onClick: onApply },
						icon(IconCheck, 13),
						h("span", null, t("panel.apply")),
					),
				),
				h(Field, { label: t("action.rename"), value: name, onChange: setName, onEnter: save }),
				h(Field, { label: t("panel.note"), value: note, onChange: setNote, onEnter: save }),
				h(
					"div",
					{ className: "dsh-sg-inline" },
					h("span", { className: "dsh-sg-spacer" }),
					h(
						"button",
						{ type: "button", className: "dsh-sg-btn", disabled: busy, onClick: save },
						h("span", null, t("panel.save")),
					),
				),
				cost === null
					? null
					: h("span", { className: "dsh-sg-hint" }, t("panel.costHint", { chars: cost.chars, tokens: cost.tokens })),
			);
		}
		//#endregion

		//#region registration
		const inject = ["slots", "locale"];

		/**
		 * Open the management panel through the layout service.
		 *
		 * `layout` is read defensively instead of being injected: a missing layout
		 * service should hide nothing else this plugin does.
		 * @param ctx - client context.
		 * @returns whether the panel was requested.
		 */
		function openPanel(ctx) {
			let layout;
			try {
				layout = typeof ctx.get === "function" ? ctx.get("layout") : ctx.layout;
			} catch {
				layout = ctx.layout;
			}
			if (layout === undefined || layout === null || typeof layout.selectPanel !== "function") return false;
			try {
				layout.selectPanel(PANEL_ID);
				return true;
			} catch (error) {
				console.error("skill-groups: could not open the panel", error);
				return false;
			}
		}

		/**
		 * Register every client surface and the shared stylesheet.
		 * @param ctx - browser Cordis context with `slots` and `locale`.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skill-groups: dictionaries");
			ctx.effect(() => installStyles(), "skill-groups: stylesheet");

			const t = ctx.locale.bind(NS);
			const hooks = () => ({ openPanel: () => openPanel(ctx) });

			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: "skill-groups-chip",
						order: 60,
						locale: NS,
						label: () => t("chip.label"),
						inject: hooks,
					},
					SkillGroupChip,
				),
			);

			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.actions",
						id: "skill-groups-header",
						order: 30,
						locale: NS,
						inject: hooks,
					},
					SkillGroupsHeaderAction,
				),
			);

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 40,
						locale: NS,
						label: () => t("panel.title"),
					},
					SidebarPanelIcon,
				),
			);

			ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
						locale: NS,
						inject: hooks,
					},
					SkillGroupsPage,
				),
			);
		}

		/** The sidebar row's glyph; the sidebar owns the button and its label. */
		function SidebarPanelIcon(props) {
			const size = typeof props.size === "number" ? props.size : 18;
			return icon(IconSkill, size);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
