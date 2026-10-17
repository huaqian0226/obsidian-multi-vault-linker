import { Plugin, PluginSettingTab, Setting, Modal, Notice } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/* ---------------------------------------------------------------------------
 * 多仓库同步器 (multi-vault-linker)
 *
 * Runs inside the dotfiles MASTER vault. It links shared config items
 * (app.json, hotkeys.json, themes, snippets, shared plugin bodies...) from the
 * master's own .obsidian/ into every selected target vault via SYMLINKS, so an
 * edit in any vault writes through to the master and all vaults stay identical.
 *
 * Also: backup management (auto-clean >30d + manual pick) and drift check
 * (find items an installer turned from symlink into real files/dirs).
 *
 * Target vault discovery is deliberately multi-source, because vaults nest
 * arbitrarily deep and move between machines:
 *   1. Obsidian's own vault registry (authoritative for opened vaults)
 *   2. recursive filesystem scan of configured roots (finds brand-new vaults)
 *   3. manually typed paths (this session only)
 * ------------------------------------------------------------------------- */

/** Plugins that live only in the master vault and must never be linked out. */
const EXCLUDED_PLUGINS = new Set(["config-sync", "multi-vault-linker"]);
/** Per-vault uniques — never shared, never touched. */
const NEVER_SHARE = new Set(["workspace.json", "community-plugins.json", "plugins"]);
/** Backup file suffix created by this plugin: <name>.bak-YYYYMMDD-HHMMSS */
const BAK_RE = /\.bak-(\d{8})-(\d{6})$/;
const BACKUP_KEEP_DAYS = 30;
/** Directory names never worth descending into while hunting for vaults. */
const SKIP_DIRS = new Set([
	"node_modules", ".git", ".obsidian", "Library", ".Trash", ".venv", "venv",
	"__pycache__", ".cache", ".npm", ".cargo", ".rustup",
	".claude", ".agents", ".codex", ".pi", ".gemini", ".config",
	".workbuddy-ai", ".workbuddy", ".dotfiles", ".skills-manager",
]);

interface MvlSettings {
	scanRoots: string[];
	maxDepth: number;
	autoCleanBackups: boolean;
	autoDriftOnLoad: boolean;
}

const DEFAULT_SETTINGS: MvlSettings = {
	scanRoots: [path.join(os.homedir(), "Desktop", "AI Workspace")],
	maxDepth: 4,
	autoCleanBackups: true,
	autoDriftOnLoad: true,
};

interface VaultInfo {
	name: string;
	root: string;
	obs: string;
	source: "registered" | "scanned" | "manual";
}

interface ItemInfo {
	name: string;
	abs: string;
	isPlugin: boolean;
}

interface BackupEntry {
	vault: string;
	path: string;
	date: Date;
	ageDays: number;
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseStamp(name: string): Date | null {
	const m = name.match(BAK_RE);
	if (!m) return null;
	const [d, t] = [m[1], m[2]];
	return new Date(
		+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8),
		+t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)
	);
}

export default class MultiVaultLinkerPlugin extends Plugin {
	settings: MvlSettings;
	masterDir = "";
	masterRoot = "";
	/** Vaults added by hand during this session (brand-new, not yet a real vault). */
	sessionVaults: VaultInfo[] = [];
	private statusBar: HTMLElement;

	async onload() {
		await this.loadSettings();
		try {
			this.masterDir = path.resolve(
				(this.app.vault.adapter as any).getBasePath(),
				this.app.vault.configDir
			);
			this.masterRoot = fs.realpathSync(path.dirname(this.masterDir));
		} catch {
			new Notice("多仓库同步器：无法确定主库配置目录，请在真机 Obsidian 中使用");
			return;
		}

		this.addRibbonIcon("link", "多仓库同步器", () => this.openLinker());
		this.addCommand({ id: "open-multi-vault-linker", name: "打开多仓库同步器", callback: () => this.openLinker() });
		this.addCommand({
			id: "debug-scan", name: "调试：输出扫描结果",
			callback: () => {
				const found = this.scanVaults().map((v) => ({ name: v.name, path: v.root, source: v.source }));
				console.log("MVL-SCAN " + JSON.stringify(found));
				new Notice(`扫描到 ${found.length} 个目标库（详见开发者控制台 MVL-SCAN）`);
			},
		});
		this.addSettingTab(new MvlSettingTab(this.app, this));

		this.statusBar = this.addStatusBarItem();
		this.statusBar.setText("链接器: 就绪");

		if (this.settings.autoCleanBackups) {
			const removed = this.cleanOldBackups(true);
			if (removed > 0) new Notice(`多仓库同步器：自动清理了 ${removed} 个 30 天前的备份`);
		}
		if (this.settings.autoDriftOnLoad) {
			const drift = this.scanDrift();
			this.updateStatus(drift.length);
			console.log(`multi-vault-linker: drift entries = ${drift.length}`);
		}
	}

	onunload() {}

	async loadSettings() {
		const data: any = (await this.loadData()) || {};
		// migration: v1.0.0 had a single scanRoot string
		if (data.scanRoot && !data.scanRoots) data.scanRoots = [data.scanRoot];
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		if (!Array.isArray(this.settings.scanRoots) || this.settings.scanRoots.length === 0) {
			this.settings.scanRoots = DEFAULT_SETTINGS.scanRoots;
		}
		this.settings.scanRoots = this.settings.scanRoots
			.map((r: string) => expandHome(String(r)))
			.filter((r: string) => r.length > 0);
		if (!(this.settings.maxDepth >= 1)) this.settings.maxDepth = DEFAULT_SETTINGS.maxDepth;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	openLinker() {
		new LinkerModal(this.app, this).open();
	}

	/* ---------------- master items ---------------- */

	shareableItems(): ItemInfo[] {
		const items: ItemInfo[] = [];
		for (const e of fs.readdirSync(this.masterDir, { withFileTypes: true })) {
			if (e.name.startsWith(".") || NEVER_SHARE.has(e.name)) continue;
			items.push({ name: e.name, abs: path.join(this.masterDir, e.name), isPlugin: false });
		}
		const pdir = path.join(this.masterDir, "plugins");
		if (fs.existsSync(pdir)) {
			for (const e of fs.readdirSync(pdir, { withFileTypes: true })) {
				if (e.name.startsWith(".") || EXCLUDED_PLUGINS.has(e.name)) continue;
				items.push({ name: e.name, abs: path.join(pdir, e.name), isPlugin: true });
			}
		}
		return items.sort((a, b) => (a.isPlugin === b.isPlugin ? a.name.localeCompare(b.name) : a.isPlugin ? 1 : -1));
	}

	/* ---------------- target vault discovery ---------------- */

	/** Vaults Obsidian itself has on record (works no matter where they live). */
	registryVaults(): VaultInfo[] {
		const base = process.platform === "win32"
			? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "obsidian")
			: process.platform === "darwin"
				? path.join(os.homedir(), "Library", "Application Support", "obsidian")
				: path.join(os.homedir(), ".config", "obsidian");
		const out: VaultInfo[] = [];
		try {
			const data = JSON.parse(fs.readFileSync(path.join(base, "obsidian.json"), "utf8"));
			const vaults = (data && data.vaults) || {};
			for (const [k, v] of Object.entries<any>(vaults)) {
				// old format: key was the path; new format: {path, ts, open}
				const p = typeof v === "string" ? v
					: v && v.path ? v.path
						: (k.startsWith("/") || /^[A-Za-z]:[\\/]/.test(k)) ? k : null;
				if (!p || !fs.existsSync(p)) continue;
				const obs = path.join(p, ".obsidian");
				if (!fs.existsSync(obs)) continue;
				out.push({ name: path.basename(p), root: p, obs, source: "registered" });
			}
		} catch { /* registry unreadable — the scan still works */ }
		return out;
	}

	/** Depth-first hunt for folders containing .obsidian; prunes heavy/irrelevant dirs. */
	private walkForVaults(dir: string, depth: number, byReal: Map<string, VaultInfo>) {
		if (depth > this.settings.maxDepth) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const p = path.join(dir, e.name);
			if (fs.existsSync(path.join(p, ".obsidian"))) {
				try {
					const rp = fs.realpathSync(p);
					if (rp !== this.masterRoot && !byReal.has(rp)) {
						byReal.set(rp, { name: e.name, root: p, obs: path.join(p, ".obsidian"), source: "scanned" });
					}
				} catch { /* ignore unreadable */ }
				continue; // never descend into a vault looking for more vaults
			}
			if (SKIP_DIRS.has(e.name)) continue;
			this.walkForVaults(p, depth + 1, byReal);
		}
	}

	scanVaults(): VaultInfo[] {
		const byReal = new Map<string, VaultInfo>();
		for (const v of this.registryVaults()) {
			try { byReal.set(fs.realpathSync(v.root), v); } catch { /* skip */ }
		}
		for (const r of this.settings.scanRoots) {
			const root = expandHome(r);
			if (fs.existsSync(root)) this.walkForVaults(root, 0, byReal);
		}
		for (const v of this.sessionVaults) {
			try { byReal.set(fs.realpathSync(v.root), v); } catch { /* skip */ }
		}
		byReal.delete(this.masterRoot); // never link the master into itself
		return [...byReal.values()].sort((a, b) => a.root.localeCompare(b.root));
	}

	targetFor(v: VaultInfo, item: ItemInfo): string {
		return path.join(v.obs, item.isPlugin ? "plugins" : "", item.name);
	}

	/* ---------------- classification & apply ---------------- */

	/** ok | create | backup-replace | relink | skip */
	classify(target: string, masterAbs: string): string {
		let stat: fs.Stats | null = null;
		try { stat = fs.lstatSync(target); } catch { return "create"; }
		if (stat.isSymbolicLink()) {
			try {
				if (fs.realpathSync(target) === fs.realpathSync(masterAbs)) return "ok";
			} catch { return "relink"; } // dead link
			return "skip"; // linked somewhere else — leave alone
		}
		return "backup-replace"; // real file/dir in the way
	}

	/** Apply one item into one vault. Returns the action taken. */
	applyItem(v: VaultInfo, item: ItemInfo): string {
		const target = this.targetFor(v, item);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const action = this.classify(target, item.abs);
		if (action === "ok" || action === "skip") return action;
		if (action === "backup-replace") {
			fs.renameSync(target, `${target}.bak-${stamp()}`);
		} else if (action === "relink") {
			fs.unlinkSync(target);
		}
		fs.symlinkSync(item.abs, target);
		if (item.isPlugin) this.mergeCommunityPlugin(v.obs, item.name);
		return action;
	}

	private mergeCommunityPlugin(obs: string, pluginId: string) {
		const file = path.join(obs, "community-plugins.json");
		let list: string[] = [];
		try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch { list = []; }
		if (!list.includes(pluginId)) {
			list.push(pluginId);
			fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
		}
	}

	/* ---------------- drift ---------------- */

	scanDrift(): { vault: string; item: string }[] {
		const out: { vault: string; item: string }[] = [];
		const items = this.shareableItems();
		for (const v of this.scanVaults()) {
			for (const it of items) {
				const t = this.targetFor(v, it);
				try {
					if (!fs.lstatSync(t).isSymbolicLink()) out.push({ vault: v.root, item: it.name });
				} catch { /* missing = simply not linked */ }
			}
		}
		return out;
	}

	updateStatus(n: number) {
		this.statusBar.setText(n === 0 ? "链接器: 无漂移" : `链接器: ${n} 处漂移`);
	}

	/* ---------------- backups ---------------- */

	listBackups(): BackupEntry[] {
		const out: BackupEntry[] = [];
		for (const v of this.scanVaults()) {
			const walk = (dir: string, depth: number) => {
				let entries: fs.Dirent[];
				try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
				for (const e of entries) {
					const p = path.join(dir, e.name);
					if (e.isDirectory()) { if (depth < 2) walk(p, depth + 1); continue; }
					if (!BAK_RE.test(e.name)) continue;
					const d = parseStamp(e.name);
					if (!d) continue;
					out.push({ vault: v.name, path: p, date: d, ageDays: (Date.now() - d.getTime()) / 86400000 });
				}
			};
			walk(v.obs, 0);
		}
		return out.sort((a, b) => b.ageDays - a.ageDays);
	}

	cleanOldBackups(silent = false): number {
		const all = this.listBackups();
		const stale = all.filter((b) => b.ageDays > BACKUP_KEEP_DAYS);
		for (const b of stale) { try { fs.rmSync(b.path, { recursive: true, force: true }); } catch { /* ignore */ } }
		if (!silent && stale.length > 0) new Notice(`已清理 ${stale.length} 个 ${BACKUP_KEEP_DAYS} 天前的备份`);
		return stale.length;
	}

	/** Manually delete the given backup paths (backup manager). Returns count removed. */
	deleteBackups(paths: string[]): number {
		let n = 0;
		for (const p of paths) {
			try { fs.rmSync(p, { recursive: true, force: true }); n++; } catch { /* ignore */ }
		}
		return n;
	}
}

/* ------------------------------- settings tab ------------------------------- */

class MvlSettingTab extends PluginSettingTab {
	plugin: MultiVaultLinkerPlugin;
	constructor(app: any, plugin: MultiVaultLinkerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h3", { text: "多仓库同步器" });
		new Setting(containerEl)
			.setName("扫描根目录（每行一个）")
			.setDesc("在这些目录下递归寻找含 .obsidian 的库；Obsidian 已注册的库无论在哪都会列出。支持 ~ 开头。")
			.addTextArea((t) => t.setValue(this.plugin.settings.scanRoots.join("\n")).onChange(async (v) => {
				this.plugin.settings.scanRoots = v.split("\n").map((s) => expandHome(s.trim())).filter(Boolean);
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("递归深度")
			.setDesc("在每个根目录下向下找几层（默认 4）。越深越慢。")
			.addText((t) => t.setValue(String(this.plugin.settings.maxDepth)).onChange(async (v) => {
				const n = parseInt(v, 10);
				if (n >= 1) { this.plugin.settings.maxDepth = n; await this.plugin.saveSettings(); }
			}));
		new Setting(containerEl)
			.setName("自动清理 30 天前的备份")
			.setDesc("插件加载时自动删除超过 30 天的 .bak-* 备份")
			.addToggle((tg) => tg.setValue(this.plugin.settings.autoCleanBackups).onChange(async (v) => {
				this.plugin.settings.autoCleanBackups = v;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("加载时自动漂移检查")
			.setDesc("检查目标库中本应是 symlink 却被安装器换成实体的项")
			.addToggle((tg) => tg.setValue(this.plugin.settings.autoDriftOnLoad).onChange(async (v) => {
				this.plugin.settings.autoDriftOnLoad = v;
				await this.plugin.saveSettings();
			}));
		containerEl.createEl("p", {
			text: `主库配置目录：${this.plugin.masterDir}\n当前目标库数：${this.plugin.scanVaults().length}`,
			cls: "mvl-summary",
		});
	}
}

/* --------------------------------- modal --------------------------------- */

type PlanAction = "ok" | "create" | "backup-replace" | "relink" | "skip";

const ACTION_TEXT: Record<PlanAction, string> = {
	"ok": "已就绪，跳过",
	"create": "将创建链接",
	"backup-replace": "真实文件将备份后替换为链接",
	"relink": "死链将清理后重指",
	"skip": "已指向别处，跳过",
};

function shorten(p: string): string {
	return p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p;
}

class LinkerModal extends Modal {
	plugin: MultiVaultLinkerPlugin;
	private pickedVaults = new Set<string>(); // keyed by vault root path
	private pickedItems = new Set<string>();
	private planEl: HTMLElement | null = null;
	private backupEl: HTMLElement | null = null;

	constructor(app: any, plugin: MultiVaultLinkerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mvl-modal");
		contentEl.createEl("h2", { text: "多仓库同步器" });
		contentEl.createEl("div", {
			text: `主配置源：${this.plugin.masterDir}（写穿透：任何库里的修改都会落在这里）`,
			cls: "mvl-summary",
		});

		const vaults = this.plugin.scanVaults();
		const items = this.plugin.shareableItems();
		if (vaults.length === 0) {
			contentEl.createEl("p", {
				text: "没有找到目标库。可在下方添加扫描根目录，或直接输入一个库文件夹路径。",
			});
		}

		/* --- target vaults --- */
		const vHead = contentEl.createEl("div", { cls: "mvl-section-head" });
		vHead.createEl("h4", { text: "① 目标库（多选；默认全选）" });
		const vBtns = vHead.createEl("span", { cls: "mvl-inline-btns" });
		vBtns.createEl("button", { text: "全选" }, (b) => b.addEventListener("click", () => {
			this.toggleAll(vlist, true, vaults.map((v) => v.root), this.pickedVaults);
		}));
		vBtns.createEl("button", { text: "全不选" }, (b) => b.addEventListener("click", () => {
			this.toggleAll(vlist, false, vaults.map((v) => v.root), this.pickedVaults);
		}));
		const vlist = contentEl.createEl("div", { cls: "mvl-list" });
		const drift = this.plugin.scanDrift();
		const backups = this.plugin.listBackups();
		for (const v of vaults) {
			const row = vlist.createEl("label", { cls: "mvl-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = true;
			this.pickedVaults.add(v.root);
			cb.addEventListener("change", () => {
				cb.checked ? this.pickedVaults.add(v.root) : this.pickedVaults.delete(v.root);
			});
			row.createEl("span", { text: v.name, cls: "mvl-name" });
			const nDrift = drift.filter((d) => d.vault === v.root).length;
			const nBak = backups.filter((b) => b.vault === v.name).length;
			const badge = row.createEl("span", { cls: `mvl-badge ${nDrift ? "is-warn" : "is-ok"}` });
			const src = v.source === "registered" ? "已注册" : v.source === "manual" ? "手动" : "扫描发现";
			badge.setText(`${shorten(v.root)} · ${src} · 漂移 ${nDrift} · 备份 ${nBak}`);
		}

		/* --- add roots / manual path --- */
		const addRow = contentEl.createEl("div", { cls: "mvl-actions" });
		const rootInput = addRow.createEl("input", {
			attr: { type: "text", placeholder: "添加扫描根目录，如 ~/Desktop（回车路径用 ~ 开头）" },
		});
		addRow.createEl("button", { text: "加根目录" }, (b) => b.addEventListener("click", async () => {
			const val = rootInput.value.trim();
			if (!val) return;
			if (!this.plugin.settings.scanRoots.includes(val)) {
				this.plugin.settings.scanRoots.push(val);
				await this.plugin.saveSettings();
				rootInput.value = "";
				this.refresh();
			}
		}));
		const manualInput = addRow.createEl("input", {
			attr: { type: "text", placeholder: "或直接输入一个库文件夹的路径" },
		});
		addRow.createEl("button", { text: "加入该库" }, (b) => b.addEventListener("click", () => {
			const val = expandHome(manualInput.value.trim());
			if (!val) return;
			if (!fs.existsSync(val)) { new Notice("路径不存在：" + val); return; }
			if (!fs.existsSync(path.join(val, ".obsidian"))) {
				new Notice("该文件夹还没有 .obsidian——执行同步时会自动创建（适合全新空库）");
			}
			if (!this.plugin.sessionVaults.some((x) => x.root === val)) {
				this.plugin.sessionVaults.push({
					name: path.basename(val), root: val,
					obs: path.join(val, ".obsidian"), source: "manual",
				});
			}
			manualInput.value = "";
			this.refresh();
		}));

		/* --- shareable items --- */
		const iHead = contentEl.createEl("div", { cls: "mvl-section-head" });
		iHead.createEl("h4", { text: "② 共享项（默认全选；主库专属项已排除）" });
		const iBtns = iHead.createEl("span", { cls: "mvl-inline-btns" });
		iBtns.createEl("button", { text: "全选" }, (b) => b.addEventListener("click", () => {
			this.toggleAll(ilist, true, items.map((i) => i.name), this.pickedItems);
		}));
		iBtns.createEl("button", { text: "全不选" }, (b) => b.addEventListener("click", () => {
			this.toggleAll(ilist, false, items.map((i) => i.name), this.pickedItems);
		}));
		const ilist = contentEl.createEl("div", { cls: "mvl-list" });
		for (const it of items) {
			const row = ilist.createEl("label", { cls: "mvl-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = true;
			this.pickedItems.add(it.name);
			cb.addEventListener("change", () => {
				cb.checked ? this.pickedItems.add(it.name) : this.pickedItems.delete(it.name);
			});
			row.createEl("span", { text: it.isPlugin ? `🧩 ${it.name}` : `📄 ${it.name}`, cls: "mvl-name" });
		}

		/* --- actions --- */
		const actions = contentEl.createEl("div", { cls: "mvl-actions" });
		actions.createEl("button", { text: "预览计划" }, (b) => b.addEventListener("click", () => this.preview()));
		actions.createEl("button", { text: "执行同步", cls: "mod-cta" }, (b) => b.addEventListener("click", () => this.execute()));
		actions.createEl("button", { text: "漂移检查" }, (b) => b.addEventListener("click", () => this.showDrift()));
		actions.createEl("button", { text: "备份管理" }, (b) => b.addEventListener("click", () => this.showBackups()));

		this.planEl = contentEl.createEl("pre", { cls: "mvl-plan" });
		this.planEl.setText("点击「预览计划」查看每个库将发生什么。");
		this.backupEl = contentEl.createEl("div");
	}

	onClose() { this.contentEl.empty(); }

	/** Re-render the modal (after adding a root or a manual vault). */
	private refresh() {
		this.contentEl.empty();
		this.onOpen();
	}

	/** Set every checkbox inside `container` to `on` and sync the picked set. */
	private toggleAll(container: HTMLElement, on: boolean, keys: string[], picked: Set<string>) {
		container.querySelectorAll("input[type=checkbox]").forEach((el) => {
			(el as HTMLInputElement).checked = on;
		});
		for (const k of keys) {
			if (on) picked.add(k); else picked.delete(k);
		}
	}

	private selectedVaults(): VaultInfo[] {
		return this.plugin.scanVaults().filter((v) => this.pickedVaults.has(v.root));
	}
	private selectedItems(): ItemInfo[] {
		return this.plugin.shareableItems().filter((i) => this.pickedItems.has(i.name));
	}

	private preview() {
		const lines: string[] = [];
		let nCreate = 0, nBackup = 0, nRelink = 0, nOk = 0, nSkip = 0;
		for (const v of this.selectedVaults()) {
			lines.push(`【${v.name}】 ${shorten(v.root)}`);
			for (const it of this.selectedItems()) {
				const action = this.plugin.classify(this.plugin.targetFor(v, it), it.abs) as PlanAction;
				if (action === "create") nCreate++;
				else if (action === "backup-replace") nBackup++;
				else if (action === "relink") nRelink++;
				else if (action === "ok") nOk++;
				else nSkip++;
				lines.push(`  ${it.name}：${ACTION_TEXT[action]}`);
			}
		}
		lines.unshift(`合计：新建 ${nCreate} · 备份替换 ${nBackup} · 死链重指 ${nRelink} · 已就绪 ${nOk} · 跳过 ${nSkip}`);
		if (this.planEl) this.planEl.setText(lines.join("\n"));
	}

	private execute() {
		const counts: Record<string, number> = {};
		const touched = new Set<string>();
		for (const v of this.selectedVaults()) {
			for (const it of this.selectedItems()) {
				const a = this.plugin.applyItem(v, it);
				counts[a] = (counts[a] || 0) + 1;
				if (a !== "ok" && a !== "skip") touched.add(v.name);
			}
		}
		const summary = Object.entries(counts).map(([k, n]) => `${ACTION_TEXT[k as PlanAction]} ${n}`).join("；");
		new Notice(`同步完成：${summary || "无动作"}`);
		if (this.planEl) this.planEl.setText(`执行结果：${summary}\n\n受影响的新库需要在 Obsidian 里重新打开（或重启 Obsidian）后生效。`);
		const drift = this.plugin.scanDrift();
		this.plugin.updateStatus(drift.length);
		console.log("multi-vault-linker executed:", counts, "touched:", [...touched]);
	}

	private showDrift() {
		const drift = this.plugin.scanDrift();
		this.plugin.updateStatus(drift.length);
		if (this.planEl) {
			this.planEl.setText(drift.length === 0
				? "漂移检查：全部就绪，没有发现被换成实体的共享项。"
				: `漂移 ${drift.length} 处（本应是 symlink 的实际是文件/目录）：\n` +
				drift.map((d) => `  ${path.basename(d.vault)} → ${d.item}`).join("\n") +
				"\n\n修复：重新勾选对应库与项，预览后执行同步即可（原文件会自动备份）。");
		}
	}

	private showBackups() {
		const all = this.plugin.listBackups();
		const el = this.backupEl;
		if (!el) return;
		el.empty();
		el.createEl("h4", { text: "🗑 备份管理" });
		if (all.length === 0) {
			el.createEl("p", { text: "还没有任何 .bak-* 备份。执行同步产生备份后会出现在这里。" });
			return;
		}
		el.createEl("div", {
			text: `共 ${all.length} 个备份（超过 ${BACKUP_KEEP_DAYS} 天的在插件加载时会自动清理）；勾选后点「删除选中」。`,
			cls: "mvl-summary",
		});
		const list = el.createEl("div", { cls: "mvl-list" });
		const picked = new Set<string>();
		for (const b of all) {
			const row = list.createEl("label", { cls: "mvl-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.addEventListener("change", () => {
				cb.checked ? picked.add(b.path) : picked.delete(b.path);
			});
			row.createEl("span", {
				text: `${b.vault} → ${path.basename(b.path)}（${Math.floor(b.ageDays)} 天前）`,
				cls: "mvl-name",
			});
		}
		const bar = el.createEl("div", { cls: "mvl-actions" });
		const pathsOf = () => all.map((b) => b.path);
		const setAll = (on: boolean) => {
			list.querySelectorAll("input[type=checkbox]").forEach((c) => { (c as HTMLInputElement).checked = on; });
			for (const p of pathsOf()) { if (on) picked.add(p); else picked.delete(p); }
		};
		bar.createEl("button", { text: "全选" }, (b) => b.addEventListener("click", () => setAll(true)));
		bar.createEl("button", { text: "全不选" }, (b) => b.addEventListener("click", () => setAll(false)));
		bar.createEl("button", { text: "删除选中", cls: "mod-warning" }, (b) => b.addEventListener("click", () => {
			const n = this.plugin.deleteBackups([...picked]);
			picked.clear();
			new Notice(n > 0 ? `已删除 ${n} 个备份` : "没有选中任何备份");
			this.showBackups(); // re-render with the survivors
		}));
	}
}
