# Interactive Vault Runtime

一个面向 Obsidian 桌面端和移动端的通用互动应用运行插件。插件本身不内置游戏或业务应用，只负责安装和加载可信的应用包、挂载界面、管理沉浸模式，并提供存档与可选的局域网联机能力。

- [互动应用开发指南](docs/application-development-guide.md)：从零创建、构建、调试和分发应用
- [应用包协议 v1](docs/application-package-protocol.md)：manifest、入口、Context 与兼容性参考
- [`.ivpkg` 发行包格式 v1](docs/interactive-package-format.md)：本地/URL 安装、归档清单与完整性校验
- [架构与源码导览](docs/architecture.md)
- [局域网联机架构](docs/local-multiplayer.md)

如果你是应用作者，请从开发指南开始；如果你在维护 Runtime 插件本身，请阅读架构文档。

## 应用包协议

下面是最小概览。可运行示例和完整工作流见[互动应用开发指南](docs/application-development-guide.md)，精确规则见[应用包协议 v1](docs/application-package-protocol.md)。

每个应用位于 Vault 中自己的目录，至少包含 manifest 和 JavaScript 入口；样式文件可选：

```text
project.json
dist/main.js
dist/styles.css  # 可选
```

`project.json` 使用 `schemaVersion: 1`，通过 `entry` 和 `styles` 指向目录内的构建产物。入口是自包含依赖的 CommonJS 浏览器 bundle，并导出：

```ts
export function mount(container: HTMLElement, context: ProjectContext): void | (() => void);
```

插件通过应用所在笔记旁的 manifest 加载项目。这里的 `id` 用于一致性校验，不会触发全 Vault 搜索：

````markdown
```interactive-vault
id: sample-app
mode: embedded
```
````

也可以显式指定 Vault 路径：

````markdown
```interactive-vault
manifest: tools/sample-app/project.json
mode: view
```
````

`mode: view` 是为兼容协议 v1 保留的技术值；面向用户时，该模式称为“沉浸模式”，会让应用覆盖当前 Obsidian 窗口并提供退出控件。

应用包中的 JavaScript 会以插件权限运行，只应加载自己信任的内容。

通过包管理器安装的应用按包 ID 和 manifest ID 写入 Vault 的 `data/saves/<package-id>/<project-id>.json`；独立项目写入 `data/saves/standalone/<project-id>.json`。应用负责自己的数据格式、版本和迁移，插件只提供 JSON 整体读写。

## 安装互动应用包

`.ivpkg` 是包含一个或多个互动项目的 ZIP 发行包。Runtime 的插件设置和命令面板支持从本地文件或直接 HTTPS URL 安装；安装前会验证清单、文件大小和 SHA-256，并让用户选择当前 Vault 内的专用目标目录。Runtime 不内置软件源或具体产品地址。

详细结构和安全边界见 [`.ivpkg` 发行包格式 v1](docs/interactive-package-format.md)。

## 开发与本地安装

```bash
npm install
npm run check
npm run install:vault -- /path/to/test-vault
```

然后重新加载 Obsidian，并在“设置 → 第三方插件”中启用 `Interactive Vault Runtime`。

## GitHub Release

Release 标签、名称和 `manifest.json` 版本必须一致，例如 `0.1.0`。推送版本标签后，GitHub Actions 会检查并发布 `main.js`、`manifest.json` 和 `styles.css`。
