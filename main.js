var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => MultiVaultLinkerPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var os = __toESM(require("os"));
var EXCLUDED_PLUGINS = /* @__PURE__ */ new Set(["config-sync", "multi-vault-linker"]);
var NEVER_SHARE = /* @__PURE__ */ new Set(["workspace.json", "community-plugins.json", "plugins"]);
var BAK_RE = /\.bak-(\d{8})-(\d{6})$/;
var BACKUP_KEEP_DAYS = 30;
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".obsidian",
  "Library",
  ".Trash",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".npm",
  ".cargo",
  ".rustup",
  ".claude",
  ".agents",
  ".codex",
  ".pi",
  ".gemini",
  ".config",
  ".workbuddy-ai",
  ".workbuddy",
  ".dotfiles",
  ".skills-manager"
]);
var DEFAULT_SETTINGS = {
  scanRoots: [path.join(os.homedir(), "Desktop", "AI Workspace")],
  maxDepth: 4,
  autoCleanBackups: true,
  autoDriftOnLoad: true
};
function expandHome(p) {
  if (p === "~")
    return os.homedir();
  if (p.startsWith("~/"))
    return path.join(os.homedir(), p.slice(2));
  return p;
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function parseStamp(name) {
  const m = name.match(BAK_RE);
  if (!m)
    return null;
  const [d, t] = [m[1], m[2]];
  return new Date(
    +d.slice(0, 4),
    +d.slice(4, 6) - 1,
    +d.slice(6, 8),
    +t.slice(0, 2),
    +t.slice(2, 4),
    +t.slice(4, 6)
  );
}
var MultiVaultLinkerPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.masterDir = "";
    this.masterRoot = "";
    /** Vaults added by hand during this session (brand-new, not yet a real vault). */
    this.sessionVaults = [];
  }
  async onload() {
    await this.loadSettings();
    try {
      this.masterDir = path.resolve(
        this.app.vault.adapter.getBasePath(),
        this.app.vault.configDir
      );
      this.masterRoot = fs.realpathSync(path.dirname(this.masterDir));
    } catch (e) {
      new import_obsidian.Notice("\u591A\u4ED3\u5E93\u540C\u6B65\u5668\uFF1A\u65E0\u6CD5\u786E\u5B9A\u4E3B\u5E93\u914D\u7F6E\u76EE\u5F55\uFF0C\u8BF7\u5728\u771F\u673A Obsidian \u4E2D\u4F7F\u7528");
      return;
    }
    this.addRibbonIcon("link", "\u591A\u4ED3\u5E93\u540C\u6B65\u5668", () => this.openLinker());
    this.addCommand({ id: "open-multi-vault-linker", name: "\u6253\u5F00\u591A\u4ED3\u5E93\u540C\u6B65\u5668", callback: () => this.openLinker() });
    this.addCommand({
      id: "debug-scan",
      name: "\u8C03\u8BD5\uFF1A\u8F93\u51FA\u626B\u63CF\u7ED3\u679C",
      callback: () => {
        const found = this.scanVaults().map((v) => ({ name: v.name, path: v.root, source: v.source }));
        console.log("MVL-SCAN " + JSON.stringify(found));
        new import_obsidian.Notice(`\u626B\u63CF\u5230 ${found.length} \u4E2A\u76EE\u6807\u5E93\uFF08\u8BE6\u89C1\u5F00\u53D1\u8005\u63A7\u5236\u53F0 MVL-SCAN\uFF09`);
      }
    });
    this.addSettingTab(new MvlSettingTab(this.app, this));
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText("\u94FE\u63A5\u5668: \u5C31\u7EEA");
    if (this.settings.autoCleanBackups) {
      const removed = this.cleanOldBackups(true);
      if (removed > 0)
        new import_obsidian.Notice(`\u591A\u4ED3\u5E93\u540C\u6B65\u5668\uFF1A\u81EA\u52A8\u6E05\u7406\u4E86 ${removed} \u4E2A 30 \u5929\u524D\u7684\u5907\u4EFD`);
    }
    if (this.settings.autoDriftOnLoad) {
      const drift = this.scanDrift();
      this.updateStatus(drift.length);
      console.log(`multi-vault-linker: drift entries = ${drift.length}`);
    }
  }
  onunload() {
  }
  async loadSettings() {
    const data = await this.loadData() || {};
    if (data.scanRoot && !data.scanRoots)
      data.scanRoots = [data.scanRoot];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!Array.isArray(this.settings.scanRoots) || this.settings.scanRoots.length === 0) {
      this.settings.scanRoots = DEFAULT_SETTINGS.scanRoots;
    }
    this.settings.scanRoots = this.settings.scanRoots.map((r) => expandHome(String(r))).filter((r) => r.length > 0);
    if (!(this.settings.maxDepth >= 1))
      this.settings.maxDepth = DEFAULT_SETTINGS.maxDepth;
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  openLinker() {
    new LinkerModal(this.app, this).open();
  }
  /* ---------------- master items ---------------- */
  shareableItems() {
    const items = [];
    for (const e of fs.readdirSync(this.masterDir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || NEVER_SHARE.has(e.name))
        continue;
      items.push({ name: e.name, abs: path.join(this.masterDir, e.name), isPlugin: false });
    }
    const pdir = path.join(this.masterDir, "plugins");
    if (fs.existsSync(pdir)) {
      for (const e of fs.readdirSync(pdir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || EXCLUDED_PLUGINS.has(e.name))
          continue;
        items.push({ name: e.name, abs: path.join(pdir, e.name), isPlugin: true });
      }
    }
    return items.sort((a, b) => a.isPlugin === b.isPlugin ? a.name.localeCompare(b.name) : a.isPlugin ? 1 : -1);
  }
  /* ---------------- target vault discovery ---------------- */
  /** Vaults Obsidian itself has on record (works no matter where they live). */
  registryVaults() {
    const base = process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "obsidian") : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "obsidian") : path.join(os.homedir(), ".config", "obsidian");
    const out = [];
    try {
      const data = JSON.parse(fs.readFileSync(path.join(base, "obsidian.json"), "utf8"));
      const vaults = data && data.vaults || {};
      for (const [k, v] of Object.entries(vaults)) {
        const p = typeof v === "string" ? v : v && v.path ? v.path : k.startsWith("/") || /^[A-Za-z]:[\\/]/.test(k) ? k : null;
        if (!p || !fs.existsSync(p))
          continue;
        const obs = path.join(p, ".obsidian");
        if (!fs.existsSync(obs))
          continue;
        out.push({ name: path.basename(p), root: p, obs, source: "registered" });
      }
    } catch (e) {
    }
    return out;
  }
  /** Depth-first hunt for folders containing .obsidian; prunes heavy/irrelevant dirs. */
  walkForVaults(dir, depth, byReal) {
    if (depth > this.settings.maxDepth)
      return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory())
        continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, ".obsidian"))) {
        try {
          const rp = fs.realpathSync(p);
          if (rp !== this.masterRoot && !byReal.has(rp)) {
            byReal.set(rp, { name: e.name, root: p, obs: path.join(p, ".obsidian"), source: "scanned" });
          }
        } catch (e2) {
        }
        continue;
      }
      if (SKIP_DIRS.has(e.name))
        continue;
      this.walkForVaults(p, depth + 1, byReal);
    }
  }
  scanVaults() {
    const byReal = /* @__PURE__ */ new Map();
    for (const v of this.registryVaults()) {
      try {
        byReal.set(fs.realpathSync(v.root), v);
      } catch (e) {
      }
    }
    for (const r of this.settings.scanRoots) {
      const root = expandHome(r);
      if (fs.existsSync(root))
        this.walkForVaults(root, 0, byReal);
    }
    for (const v of this.sessionVaults) {
      try {
        byReal.set(fs.realpathSync(v.root), v);
      } catch (e) {
      }
    }
    byReal.delete(this.masterRoot);
    return [...byReal.values()].sort((a, b) => a.root.localeCompare(b.root));
  }
  targetFor(v, item) {
    return path.join(v.obs, item.isPlugin ? "plugins" : "", item.name);
  }
  /* ---------------- classification & apply ---------------- */
  /** ok | create | backup-replace | relink | skip */
  classify(target, masterAbs) {
    let stat = null;
    try {
      stat = fs.lstatSync(target);
    } catch (e) {
      return "create";
    }
    if (stat.isSymbolicLink()) {
      try {
        if (fs.realpathSync(target) === fs.realpathSync(masterAbs))
          return "ok";
      } catch (e) {
        return "relink";
      }
      return "skip";
    }
    return "backup-replace";
  }
  /** Apply one item into one vault. Returns the action taken. */
  applyItem(v, item) {
    const target = this.targetFor(v, item);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const action = this.classify(target, item.abs);
    if (action === "ok" || action === "skip")
      return action;
    if (action === "backup-replace") {
      fs.renameSync(target, `${target}.bak-${stamp()}`);
    } else if (action === "relink") {
      fs.unlinkSync(target);
    }
    fs.symlinkSync(item.abs, target);
    if (item.isPlugin)
      this.mergeCommunityPlugin(v.obs, item.name);
    return action;
  }
  mergeCommunityPlugin(obs, pluginId) {
    const file = path.join(obs, "community-plugins.json");
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      list = [];
    }
    if (!list.includes(pluginId)) {
      list.push(pluginId);
      fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
    }
  }
  /* ---------------- drift ---------------- */
  scanDrift() {
    const out = [];
    const items = this.shareableItems();
    for (const v of this.scanVaults()) {
      for (const it of items) {
        const t = this.targetFor(v, it);
        try {
          if (!fs.lstatSync(t).isSymbolicLink())
            out.push({ vault: v.root, item: it.name });
        } catch (e) {
        }
      }
    }
    return out;
  }
  updateStatus(n) {
    this.statusBar.setText(n === 0 ? "\u94FE\u63A5\u5668: \u65E0\u6F02\u79FB" : `\u94FE\u63A5\u5668: ${n} \u5904\u6F02\u79FB`);
  }
  /* ---------------- backups ---------------- */
  listBackups() {
    const out = [];
    for (const v of this.scanVaults()) {
      const walk = (dir, depth) => {
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (depth < 2)
              walk(p, depth + 1);
            continue;
          }
          if (!BAK_RE.test(e.name))
            continue;
          const d = parseStamp(e.name);
          if (!d)
            continue;
          out.push({ vault: v.name, path: p, date: d, ageDays: (Date.now() - d.getTime()) / 864e5 });
        }
      };
      walk(v.obs, 0);
    }
    return out.sort((a, b) => b.ageDays - a.ageDays);
  }
  cleanOldBackups(silent = false) {
    const all = this.listBackups();
    const stale = all.filter((b) => b.ageDays > BACKUP_KEEP_DAYS);
    for (const b of stale) {
      try {
        fs.rmSync(b.path, { recursive: true, force: true });
      } catch (e) {
      }
    }
    if (!silent && stale.length > 0)
      new import_obsidian.Notice(`\u5DF2\u6E05\u7406 ${stale.length} \u4E2A ${BACKUP_KEEP_DAYS} \u5929\u524D\u7684\u5907\u4EFD`);
    return stale.length;
  }
};
var MvlSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "\u591A\u4ED3\u5E93\u540C\u6B65\u5668" });
    new import_obsidian.Setting(containerEl).setName("\u626B\u63CF\u6839\u76EE\u5F55\uFF08\u6BCF\u884C\u4E00\u4E2A\uFF09").setDesc("\u5728\u8FD9\u4E9B\u76EE\u5F55\u4E0B\u9012\u5F52\u5BFB\u627E\u542B .obsidian \u7684\u5E93\uFF1BObsidian \u5DF2\u6CE8\u518C\u7684\u5E93\u65E0\u8BBA\u5728\u54EA\u90FD\u4F1A\u5217\u51FA\u3002\u652F\u6301 ~ \u5F00\u5934\u3002").addTextArea((t) => t.setValue(this.plugin.settings.scanRoots.join("\n")).onChange(async (v) => {
      this.plugin.settings.scanRoots = v.split("\n").map((s) => expandHome(s.trim())).filter(Boolean);
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u9012\u5F52\u6DF1\u5EA6").setDesc("\u5728\u6BCF\u4E2A\u6839\u76EE\u5F55\u4E0B\u5411\u4E0B\u627E\u51E0\u5C42\uFF08\u9ED8\u8BA4 4\uFF09\u3002\u8D8A\u6DF1\u8D8A\u6162\u3002").addText((t) => t.setValue(String(this.plugin.settings.maxDepth)).onChange(async (v) => {
      const n = parseInt(v, 10);
      if (n >= 1) {
        this.plugin.settings.maxDepth = n;
        await this.plugin.saveSettings();
      }
    }));
    new import_obsidian.Setting(containerEl).setName("\u81EA\u52A8\u6E05\u7406 30 \u5929\u524D\u7684\u5907\u4EFD").setDesc("\u63D2\u4EF6\u52A0\u8F7D\u65F6\u81EA\u52A8\u5220\u9664\u8D85\u8FC7 30 \u5929\u7684 .bak-* \u5907\u4EFD").addToggle((tg) => tg.setValue(this.plugin.settings.autoCleanBackups).onChange(async (v) => {
      this.plugin.settings.autoCleanBackups = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u52A0\u8F7D\u65F6\u81EA\u52A8\u6F02\u79FB\u68C0\u67E5").setDesc("\u68C0\u67E5\u76EE\u6807\u5E93\u4E2D\u672C\u5E94\u662F symlink \u5374\u88AB\u5B89\u88C5\u5668\u6362\u6210\u5B9E\u4F53\u7684\u9879").addToggle((tg) => tg.setValue(this.plugin.settings.autoDriftOnLoad).onChange(async (v) => {
      this.plugin.settings.autoDriftOnLoad = v;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("p", {
      text: `\u4E3B\u5E93\u914D\u7F6E\u76EE\u5F55\uFF1A${this.plugin.masterDir}
\u5F53\u524D\u76EE\u6807\u5E93\u6570\uFF1A${this.plugin.scanVaults().length}`,
      cls: "mvl-summary"
    });
  }
};
var ACTION_TEXT = {
  "ok": "\u5DF2\u5C31\u7EEA\uFF0C\u8DF3\u8FC7",
  "create": "\u5C06\u521B\u5EFA\u94FE\u63A5",
  "backup-replace": "\u771F\u5B9E\u6587\u4EF6\u5C06\u5907\u4EFD\u540E\u66FF\u6362\u4E3A\u94FE\u63A5",
  "relink": "\u6B7B\u94FE\u5C06\u6E05\u7406\u540E\u91CD\u6307",
  "skip": "\u5DF2\u6307\u5411\u522B\u5904\uFF0C\u8DF3\u8FC7"
};
function shorten(p) {
  return p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p;
}
var LinkerModal = class extends import_obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.pickedVaults = /* @__PURE__ */ new Set();
    // keyed by vault root path
    this.pickedItems = /* @__PURE__ */ new Set();
    this.planEl = null;
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mvl-modal");
    contentEl.createEl("h2", { text: "\u591A\u4ED3\u5E93\u540C\u6B65\u5668" });
    contentEl.createEl("div", {
      text: `\u4E3B\u914D\u7F6E\u6E90\uFF1A${this.plugin.masterDir}\uFF08\u5199\u7A7F\u900F\uFF1A\u4EFB\u4F55\u5E93\u91CC\u7684\u4FEE\u6539\u90FD\u4F1A\u843D\u5728\u8FD9\u91CC\uFF09`,
      cls: "mvl-summary"
    });
    const vaults = this.plugin.scanVaults();
    const items = this.plugin.shareableItems();
    if (vaults.length === 0) {
      contentEl.createEl("p", {
        text: "\u6CA1\u6709\u627E\u5230\u76EE\u6807\u5E93\u3002\u53EF\u5728\u4E0B\u65B9\u6DFB\u52A0\u626B\u63CF\u6839\u76EE\u5F55\uFF0C\u6216\u76F4\u63A5\u8F93\u5165\u4E00\u4E2A\u5E93\u6587\u4EF6\u5939\u8DEF\u5F84\u3002"
      });
    }
    contentEl.createEl("h4", { text: "\u2460 \u76EE\u6807\u5E93\uFF08\u591A\u9009\uFF1B\u9ED8\u8BA4\u5168\u9009\uFF09" });
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
      const src = v.source === "registered" ? "\u5DF2\u6CE8\u518C" : v.source === "manual" ? "\u624B\u52A8" : "\u626B\u63CF\u53D1\u73B0";
      badge.setText(`${shorten(v.root)} \xB7 ${src} \xB7 \u6F02\u79FB ${nDrift} \xB7 \u5907\u4EFD ${nBak}`);
    }
    const addRow = contentEl.createEl("div", { cls: "mvl-actions" });
    const rootInput = addRow.createEl("input", {
      attr: { type: "text", placeholder: "\u6DFB\u52A0\u626B\u63CF\u6839\u76EE\u5F55\uFF0C\u5982 ~/Desktop\uFF08\u56DE\u8F66\u8DEF\u5F84\u7528 ~ \u5F00\u5934\uFF09" }
    });
    addRow.createEl("button", { text: "\u52A0\u6839\u76EE\u5F55" }, (b) => b.addEventListener("click", async () => {
      const val = rootInput.value.trim();
      if (!val)
        return;
      if (!this.plugin.settings.scanRoots.includes(val)) {
        this.plugin.settings.scanRoots.push(val);
        await this.plugin.saveSettings();
        rootInput.value = "";
        this.refresh();
      }
    }));
    const manualInput = addRow.createEl("input", {
      attr: { type: "text", placeholder: "\u6216\u76F4\u63A5\u8F93\u5165\u4E00\u4E2A\u5E93\u6587\u4EF6\u5939\u7684\u8DEF\u5F84" }
    });
    addRow.createEl("button", { text: "\u52A0\u5165\u8BE5\u5E93" }, (b) => b.addEventListener("click", () => {
      const val = expandHome(manualInput.value.trim());
      if (!val)
        return;
      if (!fs.existsSync(val)) {
        new import_obsidian.Notice("\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF1A" + val);
        return;
      }
      if (!fs.existsSync(path.join(val, ".obsidian"))) {
        new import_obsidian.Notice("\u8BE5\u6587\u4EF6\u5939\u8FD8\u6CA1\u6709 .obsidian\u2014\u2014\u6267\u884C\u540C\u6B65\u65F6\u4F1A\u81EA\u52A8\u521B\u5EFA\uFF08\u9002\u5408\u5168\u65B0\u7A7A\u5E93\uFF09");
      }
      if (!this.plugin.sessionVaults.some((x) => x.root === val)) {
        this.plugin.sessionVaults.push({
          name: path.basename(val),
          root: val,
          obs: path.join(val, ".obsidian"),
          source: "manual"
        });
      }
      manualInput.value = "";
      this.refresh();
    }));
    contentEl.createEl("h4", { text: "\u2461 \u5171\u4EAB\u9879\uFF08\u9ED8\u8BA4\u5168\u9009\uFF1B\u4E3B\u5E93\u4E13\u5C5E\u9879\u5DF2\u6392\u9664\uFF09" });
    const ilist = contentEl.createEl("div", { cls: "mvl-list" });
    for (const it of items) {
      const row = ilist.createEl("label", { cls: "mvl-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = true;
      this.pickedItems.add(it.name);
      cb.addEventListener("change", () => {
        cb.checked ? this.pickedItems.add(it.name) : this.pickedItems.delete(it.name);
      });
      row.createEl("span", { text: it.isPlugin ? `\u{1F9E9} ${it.name}` : `\u{1F4C4} ${it.name}`, cls: "mvl-name" });
    }
    const actions = contentEl.createEl("div", { cls: "mvl-actions" });
    actions.createEl("button", { text: "\u9884\u89C8\u8BA1\u5212" }, (b) => b.addEventListener("click", () => this.preview()));
    actions.createEl("button", { text: "\u6267\u884C\u540C\u6B65", cls: "mod-cta" }, (b) => b.addEventListener("click", () => this.execute()));
    actions.createEl("button", { text: "\u6F02\u79FB\u68C0\u67E5" }, (b) => b.addEventListener("click", () => this.showDrift()));
    actions.createEl("button", { text: "\u5907\u4EFD\u7BA1\u7406" }, (b) => b.addEventListener("click", () => this.showBackups()));
    this.planEl = contentEl.createEl("pre", { cls: "mvl-plan" });
    this.planEl.setText("\u70B9\u51FB\u300C\u9884\u89C8\u8BA1\u5212\u300D\u67E5\u770B\u6BCF\u4E2A\u5E93\u5C06\u53D1\u751F\u4EC0\u4E48\u3002");
  }
  onClose() {
    this.contentEl.empty();
  }
  /** Re-render the modal (after adding a root or a manual vault). */
  refresh() {
    this.contentEl.empty();
    this.onOpen();
  }
  selectedVaults() {
    return this.plugin.scanVaults().filter((v) => this.pickedVaults.has(v.root));
  }
  selectedItems() {
    return this.plugin.shareableItems().filter((i) => this.pickedItems.has(i.name));
  }
  preview() {
    const lines = [];
    let nCreate = 0, nBackup = 0, nRelink = 0, nOk = 0, nSkip = 0;
    for (const v of this.selectedVaults()) {
      lines.push(`\u3010${v.name}\u3011 ${shorten(v.root)}`);
      for (const it of this.selectedItems()) {
        const action = this.plugin.classify(this.plugin.targetFor(v, it), it.abs);
        if (action === "create")
          nCreate++;
        else if (action === "backup-replace")
          nBackup++;
        else if (action === "relink")
          nRelink++;
        else if (action === "ok")
          nOk++;
        else
          nSkip++;
        lines.push(`  ${it.name}\uFF1A${ACTION_TEXT[action]}`);
      }
    }
    lines.unshift(`\u5408\u8BA1\uFF1A\u65B0\u5EFA ${nCreate} \xB7 \u5907\u4EFD\u66FF\u6362 ${nBackup} \xB7 \u6B7B\u94FE\u91CD\u6307 ${nRelink} \xB7 \u5DF2\u5C31\u7EEA ${nOk} \xB7 \u8DF3\u8FC7 ${nSkip}`);
    if (this.planEl)
      this.planEl.setText(lines.join("\n"));
  }
  execute() {
    const counts = {};
    const touched = /* @__PURE__ */ new Set();
    for (const v of this.selectedVaults()) {
      for (const it of this.selectedItems()) {
        const a = this.plugin.applyItem(v, it);
        counts[a] = (counts[a] || 0) + 1;
        if (a !== "ok" && a !== "skip")
          touched.add(v.name);
      }
    }
    const summary = Object.entries(counts).map(([k, n]) => `${ACTION_TEXT[k]} ${n}`).join("\uFF1B");
    new import_obsidian.Notice(`\u540C\u6B65\u5B8C\u6210\uFF1A${summary || "\u65E0\u52A8\u4F5C"}`);
    if (this.planEl)
      this.planEl.setText(`\u6267\u884C\u7ED3\u679C\uFF1A${summary}

\u53D7\u5F71\u54CD\u7684\u65B0\u5E93\u9700\u8981\u5728 Obsidian \u91CC\u91CD\u65B0\u6253\u5F00\uFF08\u6216\u91CD\u542F Obsidian\uFF09\u540E\u751F\u6548\u3002`);
    const drift = this.plugin.scanDrift();
    this.plugin.updateStatus(drift.length);
    console.log("multi-vault-linker executed:", counts, "touched:", [...touched]);
  }
  showDrift() {
    const drift = this.plugin.scanDrift();
    this.plugin.updateStatus(drift.length);
    if (this.planEl) {
      this.planEl.setText(drift.length === 0 ? "\u6F02\u79FB\u68C0\u67E5\uFF1A\u5168\u90E8\u5C31\u7EEA\uFF0C\u6CA1\u6709\u53D1\u73B0\u88AB\u6362\u6210\u5B9E\u4F53\u7684\u5171\u4EAB\u9879\u3002" : `\u6F02\u79FB ${drift.length} \u5904\uFF08\u672C\u5E94\u662F symlink \u7684\u5B9E\u9645\u662F\u6587\u4EF6/\u76EE\u5F55\uFF09\uFF1A
` + drift.map((d) => `  ${path.basename(d.vault)} \u2192 ${d.item}`).join("\n") + "\n\n\u4FEE\u590D\uFF1A\u91CD\u65B0\u52FE\u9009\u5BF9\u5E94\u5E93\u4E0E\u9879\uFF0C\u9884\u89C8\u540E\u6267\u884C\u540C\u6B65\u5373\u53EF\uFF08\u539F\u6587\u4EF6\u4F1A\u81EA\u52A8\u5907\u4EFD\uFF09\u3002");
    }
  }
  showBackups() {
    const all = this.plugin.listBackups();
    if (all.length === 0) {
      if (this.planEl)
        this.planEl.setText("\u5907\u4EFD\u7BA1\u7406\uFF1A\u8FD8\u6CA1\u6709\u4EFB\u4F55 .bak-* \u5907\u4EFD\u3002");
      return;
    }
    const lines = [`\u5907\u4EFD\u7BA1\u7406\uFF08\u5171 ${all.length} \u4E2A\uFF0C\u8D85\u8FC7 ${BACKUP_KEEP_DAYS} \u5929\u7684\u4F1A\u5728\u52A0\u8F7D\u65F6\u81EA\u52A8\u6E05\u7406\uFF09\uFF1A`];
    for (const b of all)
      lines.push(`  ${b.vault} \u2192 ${path.basename(b.path)}\uFF08${Math.floor(b.ageDays)} \u5929\u524D\uFF09`);
    lines.push("", "\u624B\u52A8\u5220\u9664\u8BF7\u76F4\u63A5\u5230\u5BF9\u5E94 vault \u7684 .obsidian \u91CC\u64CD\u4F5C\uFF1B\u6216\u70B9\u300C\u9884\u89C8\u8BA1\u5212\u2192\u6267\u884C\u540C\u6B65\u300D\u8BA9\u65E7\u6587\u4EF6\u518D\u6B21\u88AB\u5907\u4EFD\u66FF\u6362\u3002");
    if (this.planEl)
      this.planEl.setText(lines.join("\n"));
  }
};
