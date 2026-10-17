# 多仓库同步器 (multi-vault-linker)

Obsidian 插件：在 **dotfiles 主库**里选择共享项与目标库，一键把主配置源
（主库自己的 `.obsidian/`）以 **symlink** 形式链接进各目标库——编辑任意库即写穿透到
主源，所有库保持一致。附带备份管理与漂移检查。

## 目标库是怎么找到的（三通道，按此顺序合并去重）

1. **Obsidian 注册表**：读取 Obsidian 自己的 vault 注册表（macOS:
   `~/Library/Application Support/obsidian/obsidian.json`，Win/Linux 同理）——
   你在 Obsidian 里打开过的库一定在里面，无论在磁盘哪个位置。
2. **递归 filesystem 扫描**：对每个「扫描根目录」（默认 `~/Desktop/AI Workspace`）
   向下递归最多 N 层（默认 4），凡是含 `.obsidian` 的文件夹都算；自动修剪
   `node_modules`、`.git`、`Library` 等噪音目录，发现一个库后不再往里钻。
   ——这一步专门捞注册表里还没有的**全新库**。
3. **手动输入路径**：模态框里直接贴一个文件夹路径（本会话有效）；哪怕它还没有
   `.obsidian`（全新空库），执行同步时会自动创建。

主库自身永远排除。想换扫描范围：模态框里「加根目录」，或去插件设置里改
（扫描根目录支持多行、支持 `~`，递归深度可调）。

## 功能

- **目标库多选**：每行显示库名、完整路径、来源（已注册/扫描发现/手动）、
  漂移数与备份数；默认全选；「全选 / 全不选」一键切换。
- **共享项清单**：主库 `.obsidian/` 下的配置文件 + `plugins/` 下的共享插件
  （`workspace.json`、`community-plugins.json` 等每库独特项与主库专属插件
  `multi-vault-linker` 自动排除）；同样带「全选 / 全不选」。
- **人话预览**：执行前逐项列出将发生什么——新建链接 / 已就绪 / 真实文件备份后替换 /
  死链清理重指 / 已指向别处跳过。
- **一键执行**：被替换的真实文件自动备份为 `<name>.bak-YYYYMMDD-HHMMSS`；
  插件项自动合并进目标库的 `community-plugins.json`。
- **备份管理**：加载时自动清理 30 天前的备份；模态框「备份管理」里逐条列出
  全部备份（库名 / 文件名 / 天数），勾选（含全选/全不选）后「删除选中」直接清。
- **漂移检查**：加载时自动扫描 + 手动触发，找出被安装器从 symlink 换成实体的项，
  重新执行同步即可修复（同样先备份）。
- 新库从零开始也能用：目标文件夹甚至不需要先有 `.obsidian`，插件会创建。

## 安装（BRAT）

1. 安装 BRAT 插件（社区插件市场搜 `BRAT`，或 obsidian42-brat）。
2. BRAT → `Add Beta plugin` → 填 `huaqian0226/obsidian-multi-vault-linker` →
   `Add Plugin` → 启用「多仓库同步器」。
3. 仅在 **dotfiles 主库** 中启用它；目标库不需要安装本插件。

## 使用

左侧 Ribbon 图标或命令面板「打开多仓库同步器」→ 勾选目标库与共享项 →
预览计划 → 执行同步。新库随后在 Obsidian 里打开即可。

## 已知边界（诚实清单）

- 插件只能操作**磁盘上的**目标库；链接建完后那个库要重载/重启 Obsidian 才生效，
  插件无法替另一个 vault 窗口重载。
- Obsidian 自带的插件更新可能把 symlink 替换成实体目录（已知漂移）——
  「漂移检查」因此是常驻功能，不是一次性工具。
- 插件管「链接」，不管「内容」——内容照旧写穿透，在任何一个库里改都落主源。

## 开发

```bash
npm install
npm run build     # 产出 main.js（tsc 检查 + esbuild 生产构建）
```

源码即仓库本体；主库中的 `.obsidian/plugins/multi-vault-linker` 以 symlink
指向本仓库目录，改动 `npm run build` 后重载 Obsidian 即可生效。

## License

MIT
