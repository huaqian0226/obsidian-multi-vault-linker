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
 * ------------------------------------------------------------------------- */

/** Plugins that live only in the master vault and must never be linked out. */
const EXCLUDED_PLUGINS = new Set(["config-sync", "multi-vault-linker"]);
/** Per-vault uniques — never shared, never touched. */
const NEVER_SHARE = new Set(["workspace.json", "community-plugins.json", "plugins"]);
/** Backup file suffix created by this plugin: <name>.bak-YYYYMMDD-HHMMSS */
const BAK_RE = /\.bak-(\d{8})-(\d{6})$/;
const BACKUP_KEEP_DAYS = 30;

interface MvlSettings {
	scanRoot: string;
	autoCleanBackups: boolean;
	autoDriftOnLoad: boolean;
}

const DEFAULT_SETTINGS: MvlSettings = {
	scanRoot: path.join(os.homedir(), "Desktop", "AI Workspace"),
	autoCleanBackups: true,
	autoDriftOnLoad: true,
};

interface VaultInfo {
	name: string;
	root: string;
	obs: string;
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

function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseStamp(name: string): Date | null {
	const m = name.match(BAK_RE);
	if (!m) return null;
	const [d, t] = [m[1], m[2]];
	return new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
}

export default class MultiVaultLinkerPlugin extends Plugin {
	settings: MvlSettings;
	masterDir = "";
	private statusBar: HTMLElement;

	async onload() {
		await this.loadSettings();
		try {
			this.masterDir = path.resolve(
				(this.app.vault.adapter as any).getBasePath(),
				this.app.vault.configDir
			);
		} catch {
			new Notice("多仓库同步器：无法确定主库配置目录，请在真机 Obsidian 中使用");
			return;
		}

		this.addRibbonIcon("link", "多仓库同步器", () => this.openLinker());
		this.addCommand({ id: "open-multi-vault-linker", name: "打开多仓库同步器", callback: () => this.openLinker() });
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}

	openLinker() {
		new LinkerModal(this.app, this).open();
	}

	/* ---------------- master items & vaults ---------------- */

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

	scanVaults(): VaultInfo[] {
		const root = this.settings.scanRoot;
		if (!fs.existsSync(root)) return [];
		const out: VaultInfo[] = [];
		for (const e of fs.readdirSync(root, { withFileTypes: true })) {
			if (!e.isDirectory() || e.name.startsWith(".")) continue;
			const obs = path.join(root, e.name, ".obsidian");
			if (!fs.existsSync(obs)) continue;
			if (path.resolve(obs) === path.resolve(this.masterDir)) continue;
			out.push({ name: e.name, root: path.join(root, e.name), obs });
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
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
					if (!fs.lstatSync(t).isSymbolicLink()) out.push({ vault: v.name, item: it.name });
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
			.setName("扫描根目录")
			.setDesc("在此目录下寻找含 .obsidian 的目标库（默认：桌面 AI Workspace）")
			.addText((t) => t.setValue(this.plugin.settings.scanRoot).onChange(async (v) => {
				this.plugin.settings.scanRoot = v.trim();
				await this.plugin.saveSettings();
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
			text: `主库配置目录：${this.plugin.masterDir}`,
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

class LinkerModal extends Modal {
	plugin: MultiVaultLinkerPlugin;
	private pickedVaults = new Set<string>();
	private pickedItems = new Set<string>();
	private planEl: HTMLElement | null = null;

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
			text: `主配置源：${this.plugin.masterDir}`,
			cls: "mvl-summary",
		});

		const vaults = this.plugin.scanVaults();
		const items = this.plugin.shareableItems();
		if (vaults.length === 0) {
			contentEl.createEl("p", { text: `在扫描根目录 ${this.plugin.settings.scanRoot} 下没有找到目标库（含 .obsidian 的文件夹）。可在设置里改根目录。` });
		}

		/* --- target vaults --- */
		contentEl.createEl("h4", { text: "① 目标库（多选）" });
		const vlist = contentEl.createEl("div", { cls: "mvl-list" });
		const drift = this.plugin.scanDrift();
		const backups = this.plugin.listBackups();
		for (const v of vaults) {
			const row = vlist.createEl("label", { cls: "mvl-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = true;
			this.pickedVaults.add(v.name);
			cb.addEventListener("change", () => {
				cb.checked ? this.pickedVaults.add(v.name) : this.pickedVaults.delete(v.name);
			});
			row.createEl("span", { text: v.name, cls: "mvl-name" });
			const nDrift = drift.filter((d) => d.vault === v.name).length;
			const nBak = backups.filter((b) => b.vault === v.name).length;
			const badge = row.createEl("span", { cls: `mvl-badge ${nDrift ? "is-warn" : "is-ok"}` });
			badge.setText(`漂移 ${nDrift} · 备份 ${nBak}`);
		}

		/* --- shareable items --- */
		contentEl.createEl("h4", { text: "② 共享项（默认全选；主库专属项已排除）" });
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
	}

	onClose() { this.contentEl.empty(); }

	private selectedVaults(): VaultInfo[] {
		return this.plugin.scanVaults().filter((v) => this.pickedVaults.has(v.name));
	}
	private selectedItems(): ItemInfo[] {
		return this.plugin.shareableItems().filter((i) => this.pickedItems.has(i.name));
	}

	private preview() {
		const lines: string[] = [];
		let nCreate = 0, nBackup = 0, nRelink = 0, nOk = 0, nSkip = 0;
		for (const v of this.selectedVaults()) {
			lines.push(`【${v.name}】`);
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
				drift.map((d) => `  ${d.vault} → ${d.item}`).join("\n") +
				"\n\n修复：重新勾选对应库与项，预览后执行同步即可（原文件会自动备份）。");
		}
	}

	private showBackups() {
		const all = this.plugin.listBackups();
		if (all.length === 0) {
			if (this.planEl) this.planEl.setText("备份管理：还没有任何 .bak-* 备份。");
			return;
		}
		const lines = [`备份管理（共 ${all.length} 个，超过 ${BACKUP_KEEP_DAYS} 天的会在加载时自动清理）：`];
		for (const b of all) lines.push(`  ${b.vault} → ${path.basename(b.path)}（${Math.floor(b.ageDays)} 天前）`);
		lines.push("", "手动删除请直接到对应 vault 的 .obsidian 里操作；或点「预览计划→执行同步」让旧文件再次被备份替换。");
		if (this.planEl) this.planEl.setText(lines.join("\n"));
	}
}
