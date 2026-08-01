# Interactive Vault Runtime

一个面向 Obsidian 桌面端和移动端的通用互动应用运行插件。插件本身不内置游戏或业务应用，只负责从 Vault 加载可信的应用包、挂载界面、管理独立视图，并提供存档能力。

## 应用包协议

每个应用位于 Vault 中自己的目录，至少包含：

```text
project.json
dist/main.js
dist/styles.css
```

`project.json` 使用 `schemaVersion: 1`，通过 `entry` 和 `styles` 指向目录内的构建产物。入口是无外部依赖的 CommonJS bundle，并导出：

```ts
export function mount(container: HTMLElement, context: ProjectContext): void | (() => void);
```

插件通过应用所在笔记旁的 manifest 加载项目：

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

旧的 `obs-game` 代码块名称暂时作为兼容别名保留。应用包中的 JavaScript 会以插件权限运行，只应加载自己信任的内容。

## 开发与本地安装

```bash
npm install
npm run check
npm run install:vault -- ../obs-game
```

然后重新加载 Obsidian，并在“设置 → 第三方插件”中启用 `Interactive Vault Runtime`。

## GitHub Release

Release 标签、名称和 `manifest.json` 版本必须一致，例如 `0.1.0`。推送版本标签后，GitHub Actions 会检查并发布 `main.js`、`manifest.json` 和 `styles.css`。
