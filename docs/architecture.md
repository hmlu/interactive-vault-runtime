# Interactive Vault Runtime 架构

## 目标与非目标

本插件为 Obsidian Vault 中的可信互动应用包提供最小运行层：从 Markdown 找到包、读取和验证入口、挂载嵌入界面或独立标签页、管理清理生命周期，并提供与业务无关的 JSON 存储。

插件刻意不负责：游戏业务、应用依赖管理、应用源码编译、应用商店/注册表、存档结构解释、跨设备同步和不可信代码沙箱。示例内容仓库是同级独立项目 `../obs-game/`。

## 模块地图

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 注册代码块处理器和 ItemView，组织加载、上下文创建与打开独立视图 |
| `src/runtime/directive.ts` | 解析 bare ID、类 YAML 或 JSON 指令并校验字段 |
| `src/runtime/project-loader.ts` | 解析 manifest 路径、校验 schema、限制包内路径、读取文件、执行 CommonJS bundle |
| `src/runtime/project-render-child.ts` | 注入项目样式、创建项目根节点、调用 `mount()`、统一清理 |
| `src/runtime/project-view.ts` | 保存/恢复独立标签页状态，防止异步旧渲染覆盖新状态 |
| `src/platform/vault-storage.ts` | 将通用存储接口适配到 Obsidian Vault adapter |
| `src/runtime/types.ts` | 运行时内部及对应用暴露的协议类型 |
| `styles.css` | 插件宿主层的加载、错误、嵌入和独立视图样式变量 |

## 启动与注册

`InteractiveVaultRuntimePlugin.onload()` 完成三项注册：

1. 创建单个 `VaultProjectLoader`。
2. 注册 `interactive-vault-project` ItemView。
3. 为规范语言名 `interactive-vault` 与兼容别名 `obs-game` 注册 Markdown 代码块处理器。

卸载插件时，所有该类型的独立视图都会被关闭。Markdown 嵌入实例由 Obsidian 的 `MarkdownRenderChild` 生命周期管理。

## 嵌入渲染路径

```text
Markdown code block
  -> parseProjectDirective(source)
  -> resolveManifestPath(directive, sourcePath)
  -> loader.load(manifestPath, expectedId)
  -> ProjectRenderChild.onload()
  -> mountProject(container, loadedProject, context)
  -> application mount(projectRoot, context)
```

指令的 `mode: view` 是例外：Markdown 中只创建启动按钮，点击后新建独立标签页。默认或 `embedded` 模式才直接挂载应用。

## 独立视图路径

`openProject()` 先执行一次加载验证，失败时用 Obsidian Notice 报错；成功后在新 leaf 设置 view state：

```ts
{ manifestPath, expectedId }
```

`ProjectView` 可从 workspace state 恢复这两个字段，再次加载应用并用 `displayMode: "view"` 挂载。每次渲染递增 `renderVersion`，异步加载完成时若版本已过期就放弃结果，避免快速切换或关闭后的旧结果写回 UI。

关闭或重渲染前会先调用上一个应用的卸载函数，然后清空容器。

## 加载器与信任模型

加载器按以下顺序工作：

1. 通过 Vault adapter 读取 manifest。
2. 校验协议 v1 的必需字段和可选字段类型。
3. 若指令给出 ID，确认它与 manifest ID 相同。
4. 以 manifest 所在目录为包根目录解析 `entry` 与 `styles`。
5. 拒绝绝对路径、反斜杠、冒号、逃出项目目录的路径和错误扩展名。
6. 并行读取 JavaScript 与 CSS。
7. 用 `new Function("module", "exports", source)` 执行 CommonJS bundle，并验证 `mount` 导出。

路径限制用于防止配置错误跨出应用包，但不是安全沙箱。bundle 在插件上下文执行，可以获得与插件相当的 JavaScript 权限，因此只能加载用户信任的 Vault 内容。详细协议见 [应用包协议](application-package-protocol.md)。

## 挂载与样式生命周期

`mountProject()` 把每份 CSS 放入宿主容器内的 `<style>`，再创建 `.ivr-project-root`，最后调用应用 `mount()`。CSS 不是 Shadow DOM 隔离：应用应使用项目级类名前缀，并可消费插件在宿主定义的 `--ogr-*` 主题变量。

卸载函数先调用应用返回的同步 cleanup，再清空宿主容器，从而同时移除 UI 和注入样式。协议当前不支持异步 cleanup。

## 上下文与存储

每次挂载都会创建新的 `ProjectContext`：

- `displayMode` 反映当前是嵌入还是独立标签页。
- `sourcePath` 只在 Markdown 嵌入路径传入；独立视图当前为 `undefined`。
- `openInView()` 捕获当前 manifest 路径与 ID，并打开新标签页。
- `storage` 是按 manifest ID 创建的 `VaultProjectStorage`。

存储路径固定为 `data/saves/<id>.json`。`load()` 对不存在、读取失败或 JSON 解析失败统一返回 `null`，并把读取错误写入 console。`save()` 和 `clear()` 在实例内通过 Promise 队列串行执行；首次保存会逐级创建 `data/` 和 `data/saves/`。插件不校验业务数据，也不做 schema 迁移、原子临时文件替换、跨实例锁或冲突合并。

这意味着同一应用的多个挂载实例共享文件但不共享写队列。应用应减少无意义写入，自己版本化/校验存档，并谨慎处理多窗口或多设备并发。

## 构建、安装与发布

`esbuild.config.mjs` 将 `src/main.ts` 打成 Obsidian 所需的 CommonJS `main.js`：生产构建压缩且不带 sourcemap，开发模式监听并内联 sourcemap；`obsidian`、Electron、CodeMirror 和 Lezer 保持 external。

```bash
npm run check
npm run install:vault -- ../obs-game
```

`check` 依次执行类型检查、Vitest 和生产构建。安装脚本复制 `main.js`、`manifest.json`、`styles.css` 到目标 Vault 的插件目录。

GitHub Actions 在推送版本标签时再次运行 `check`，验证标签与 `manifest.json` 版本相同，并发布这三个插件文件。发版时还要同步维护 `package.json` 和 `versions.json`。

## 变更检查表

- 指令变化：更新 `directive.ts` 测试、README 和应用包协议。
- manifest 或 Context 变化：考虑 schema 兼容性，并同步内容仓库的 `games/shared/runtime.ts`。
- 加载器变化：复查路径逃逸、扩展名、错误信息和可信代码说明。
- 生命周期变化：复查嵌入卸载、标签页恢复、快速重渲染与插件卸载。
- 存储变化：复查写入排序、失败后的队列行为、多实例并发和移动端 adapter。
- 样式变化：在桌面/移动、深色/浅色、嵌入/独立视图中手工检查。
