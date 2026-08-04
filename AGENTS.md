# interactive-vault-runtime 维护指南

## 项目定位

这是一个桌面端和移动端通用的 Obsidian 插件，只负责运行可信的 Vault 应用包。具体游戏和内容位于同级独立仓库 `../obs-game/`。禁止在插件中添加扫雷或其他应用业务，也禁止从内容仓库引用代码。

## 事实来源

- 插件入口与 Obsidian 注册：`src/main.ts`
- 应用包加载、校验与执行：`src/runtime/project-loader.ts`
- Markdown 指令语法：`src/runtime/directive.ts`
- 嵌入/沉浸模式生命周期：`src/runtime/project-render-child.ts`、`src/runtime/project-view.ts`
- Vault JSON 存储：`src/platform/vault-storage.ts`
- 协议类型：`src/runtime/types.ts`
- 完整架构：`docs/architecture.md`
- 对外应用包协议：`docs/application-package-protocol.md`

文档与实现冲突时，以源码为当前行为依据，并在同一改动中修正文档。

## 稳定边界

- 只接受 `schemaVersion: 1`，入口是项目目录内 `.js` CommonJS bundle，样式是项目目录内 `.css` 文件。
- bundle 必须导出 `mount(container, context)`，可以返回同步清理函数。
- `ProjectContext` 当前只有 `displayMode`、可选 `sourcePath`、`storage`、`openInView()`。
- 存档固定写入 `data/saves/<manifest.id>.json`。插件不解释、不迁移应用数据。
- 应用代码通过 `new Function` 以插件权限执行，不是安全沙箱。不要把“路径限制”描述为对恶意 bundle 的隔离。
- Markdown 代码块语言名称只有 `interactive-vault`，目前没有兼容别名。

公共协议变化时，要同步检查同级内容仓库的 `games/shared/runtime.ts`、应用实现和两边文档。除非明确设计并迁移 schema，否则不要悄悄改变已发布 v1 行为。

## 开发与验证

```bash
npm run check
```

该命令执行类型检查、Vitest 测试和生产构建，生成根目录 `main.js`。`main.js` 被 Git 忽略，是本地安装和 Release 所需产物，不要手工编辑。

安装到测试 Vault：

```bash
npm run install:vault -- ../obs-game
```

安装脚本复制 `main.js`、`manifest.json`、`styles.css` 到目标 Vault 的 `.obsidian/plugins/interactive-vault-runtime/`。随后需要在 Obsidian 中重新加载插件。不要提交目标 Vault 内的插件副本。

发布时保持 `package.json`、`manifest.json`、`versions.json` 和 Git tag 版本一致，并确认 GitHub Actions 的 Release 校验通过。

## 修改原则

- 所有 Obsidian 注册资源应由 Plugin/Component 生命周期管理；异步渲染要防止过期结果覆盖新状态。
- 加载器必须继续限制入口和样式位于项目目录内，并保持扩展名校验。
- 新增运行时能力时优先扩展显式 `ProjectContext`，避免让应用直接依赖 Obsidian API。
- 存储变更要考虑串行写、错误恢复、多视图同时写和移动端文件系统行为。
- 添加协议或路径行为时补单元测试；涉及 ItemView、生命周期或真实 Vault 的行为还需在 Obsidian 中手工验证。
