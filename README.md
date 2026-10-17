# 多仓库同步器 (multi-vault-linker)

Obsidian 插件：在 **dotfiles 主库**里选择共享项与目标库，一键把主配置源
（主库自己的 `.obsidian/`）以 **symlink** 形式链接进各目标库——编辑任意库即写穿透到
主源，所有库保持一致。附带备份管理与漂移检查。

## 功能

- **目标库多选**：扫描根目录（默认 `~/Desktop/AI Workspace`）下所有含 `.obsidian` 的
  文件夹，自动排除主库自身；每库显示漂移数与备份数。
- **共享项清单**：主库 `.obsidian/` 下的配置文件 + `plugins/` 下的共享插件
  （`workspace.json`、`community-plugins.json` 等每库独特项与主库专属插件自动排除）。
- **人话预览**：执行前逐项列出将发生什么——新建链接 / 已就绪 / 真实文件备份后替换 /
  死链清理重指 / 已指向别处跳过。
- **一键执行**：被替换的真实文件自动备份为 `<name>.bak-YYYYMMDD-HHMMSS`；
  插件项自动合并进目标库的 `community-plugins.json`。
- **备份管理**：加载时自动清理 30 天前的备份；模态框内可按库查看全部备份。
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

## 开发

```bash
npm install
npm run build     # 产出 main.js（tsc 检查 + esbuild 生产构建）
```

源码即仓库本体；主库中的 `.obsidian/plugins/multi-vault-linker` 以 symlink
指向本仓库目录，改动 `npm run build` 后重载 Obsidian 即可生效。

## License

MIT
