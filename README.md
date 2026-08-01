# Interactive Vault Runtime

一个面向 Obsidian 桌面端和移动端的互动游戏运行插件。插件识别 Markdown 中的 `obs-game` 代码块，并以内嵌界面或独立标签页运行已注册的游戏。

当前内置项目：

- 扫雷：三档难度、首击保护、鼠标与触控操作、自动存档。

## 开发

```bash
npm install
npm run check
```

## 安装到本地 Vault

先构建，再将三个插件文件复制到目标 Vault：

```bash
npm run build
npm run install:vault -- ../obs-game
```

然后在 Obsidian 的“设置 → 第三方插件”中启用 `Interactive Vault Runtime`。

## Markdown 用法

````markdown
```obs-game
id: minesweeper
mode: embedded
```
````

`mode: view` 会显示一个用于打开独立应用标签页的按钮。

## GitHub Release

Release 的标签、名称和 `manifest.json` 版本必须一致，例如 `0.1.0`。发布附件必须包含：

- `main.js`
- `manifest.json`
- `styles.css`

推送版本标签后，仓库内的 GitHub Actions 工作流会执行检查并创建 Release。
