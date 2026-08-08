# 应用包协议 v1

本文面向为 Interactive Vault Runtime 编写应用的内容仓库维护者，记录当前代码实际支持的协议。

第一次开发应用时，建议先按照[互动应用开发指南](application-development-guide.md)完成可运行示例，再把本文作为 API 和兼容性参考。

## 目录与 manifest

一个包由 Vault 内的 `project.json` 及其同目录子树组成：

```text
sample-app/
├── project.json
└── dist/
    ├── main.js
    └── styles.css
```

最小 manifest：

```json
{
  "schemaVersion": 1,
  "id": "sample-app",
  "title": "示例应用",
  "entry": "dist/main.js"
}
```

完整的运行时字段：

| 字段 | 必需 | 规则 |
| --- | --- | --- |
| `schemaVersion` | 是 | 当前只能是数字 `1` |
| `id` | 是 | `/^[a-z0-9][a-z0-9-]*$/`，同时作为存档文件名 |
| `title` | 是 | 非空字符串，用于按钮和标签页标题 |
| `description` | 否 | 字符串；当前加载但不展示 |
| `icon` | 否 | 字符串；作为 Obsidian 图标名，沉浸模式默认 `blocks` |
| `entry` | 是 | 项目目录内的相对 `.js` 路径 |
| `styles` | 否 | 项目目录内相对 `.css` 路径数组 |

JSON 可以带运行时未知的目录元数据；当前校验器会忽略并从加载结果中剔除这些字段，不应依赖它们传递给应用。

入口和样式路径不能是绝对路径，不能含反斜杠或冒号，规范化后不能逃出 manifest 所在目录，并必须使用对应扩展名。

## Markdown 指令

推荐的同目录写法：

````markdown
```interactive-vault
id: sample-app
mode: embedded
```
````

因为没有指定 `manifest`，插件读取该 Markdown 文件旁的 `project.json`，并确认 ID 一致。ID 不是全局查找键。

显式路径写法：

````markdown
```interactive-vault
manifest: tools/sample-app/project.json
mode: view
```
````

`manifest` 以 `./` 或 `../` 开头时相对来源笔记目录解析；其他路径相对 Vault 根目录解析。`mode` 只能是：

- `embedded`：直接在 Markdown 中挂载；也是省略时的默认值。
- `view`：Markdown 中显示按钮，点击后进入沉浸模式。该字符串是协议 v1 的兼容值。

解析器也接受裸 ID（内容只有 `sample-app`）和 JSON 对象。代码块语言名称固定为 `interactive-vault`。

## JavaScript 入口

入口必须是能通过 CommonJS `module`/`exports` 执行的自包含浏览器 bundle。插件不提供运行时 `require`，应用需要把 Preact 等依赖打进自身 bundle。

支持直接导出 `mount`，也支持 default 对象中的 `mount`：

```ts
interface InteractiveProjectModule {
  mount(
    container: HTMLElement,
    context: ProjectContext,
  ): void | (() => void);
}
```

`container` 是插件为本次实例创建的空根元素。若应用建立了 UI、计时器、DOM/全局监听器、动画、音频或订阅，应返回同步 cleanup 并全部释放。不要假设同一包只会挂载一次。

bundle 会以插件权限执行，不受 iframe、Worker 或 ShadowRealm 隔离。只分发和加载可信代码。

## ProjectContext

```ts
type DisplayMode = "embedded" | "view";

interface ProjectStorage<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  clear(): Promise<void>;
}

interface ProjectContext {
  displayMode: DisplayMode;
  sourcePath?: string;
  storage: ProjectStorage<unknown>;
  openInView(): Promise<void>;
  multiplayer?: ProjectMultiplayer;
}
```

- `sourcePath` 在 Markdown 嵌入实例中是来源笔记的 Vault 路径；沉浸模式当前不保证提供。
- `openInView()` 可以从嵌入应用进入同一 manifest 的沉浸模式。
- 应用通常在内部把 `storage` 收窄为自己的版本化存档类型，但加载后仍须做运行时校验。
- `multiplayer` 是可选能力。旧版 Runtime 或不支持联机的平台可以不提供；应用必须先做能力检测。

### ProjectMultiplayer

联机能力分为持续存在的“联机小队”和只属于当前项目的“对局”。`createParty()`、`joinParty()`、审批与退出用于首页等大厅应用；游戏通常只订阅快照、向在线成员发起 `challenge()`，并在对局建立后使用 `send()`/`onMessage()`。

`subscribe()` 和 `onMessage()` 返回的清理函数必须在应用卸载时调用。调用清理函数不会断开小队；只有 `leaveParty()` 或插件卸载才关闭连接。游戏 payload 必须是 JSON 值，并应自行做版本化和运行时校验。

桌面端可以创建小队；当前移动端实现支持扫码加入桌面房主。连接建立后使用 WebRTC DataChannel，切换笔记或游戏不会中断小队。

## 存储约定

每个 manifest ID 映射到一个 Vault 文件：

```text
data/saves/<id>.json
```

`save()` 以格式化 JSON 覆盖整个文件，`clear()` 删除它，`load()` 在文件不存在、不可读或不是合法 JSON 时返回 `null`。协议没有局部更新、事务、容量配额、跨挂载锁和跨设备合并。

建议存档顶层包含应用自己的 `version`，加载时验证完整结构，并能忽略或迁移旧版本。不要在存档中保存密钥，因为它是普通 Vault 文件。

## 浏览器与样式约束

- 构建目标至少兼容当前项目采用的 ES2018 browser bundle。
- 不要使用 Node.js、Electron 或插件私有模块。
- 文件能力应通过 `context.storage` 或未来显式增加的 Context 能力获取。
- 应用 CSS 注入普通 DOM，不是 Shadow DOM；使用应用专属类名前缀避免污染 Obsidian。
- 宿主提供 `--ogr-border`、`--ogr-muted`、`--ogr-surface`、`--ogr-surface-alt`、`--ogr-accent`，也可以使用 Obsidian 标准 CSS 变量。
- 同时验证桌面和移动端、触控和键盘、深浅主题、窄屏安全区及 reduced motion。

## 兼容性规则

`schemaVersion: 1` 是已发布包格式。新增可选 manifest 字段或 Context 能力通常可以保持兼容；改变字段含义、存档路径、入口格式或生命周期约定则需要明确的迁移方案，必要时提升 schemaVersion。内容仓库应保存一份本地协议类型，避免直接编译依赖插件源码。
