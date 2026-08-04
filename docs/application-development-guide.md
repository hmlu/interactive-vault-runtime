# 互动应用开发指南

本文面向使用 Interactive Vault Runtime 开发 Vault 互动应用的作者。读完后，你可以从零创建一个应用包，将它嵌入 Obsidian 笔记，在沉浸模式中打开，并使用 Vault 文件保存状态。

如果你只需要查询字段、路径和兼容性规则，请直接查看[应用包协议 v1](application-package-protocol.md)。如果你要修改 Runtime 本身，请查看[架构与源码导览](architecture.md)。

## 1. 运行模型

Interactive Vault Runtime 是 Obsidian 插件，也是应用包的宿主。应用不是 Obsidian 插件，而是存放在 Vault 内的浏览器 bundle：

```text
Markdown 中的 interactive-vault 代码块
  -> Runtime 读取 project.json
  -> Runtime 读取并执行 JavaScript bundle、注入 CSS
  -> Runtime 调用 mount(container, context)
  -> 应用创建 UI，并在卸载时执行 cleanup
```

这种分工意味着：

- Runtime 负责 Obsidian 注册、应用加载、视图生命周期和通用 JSON 存储。
- 应用负责业务逻辑、界面、存档结构、运行时数据校验和资源清理。
- 应用只依赖公开的 `mount()` 与 `ProjectContext` 协议，不应导入 Runtime 源码或 Obsidian API。
- 应用代码会以插件权限执行，不是安全沙箱；只能加载自己信任的应用包。

## 2. 开发前准备

你需要：

- 一个已启用 Interactive Vault Runtime 的 Obsidian Vault。
- Node.js 和 npm，用于在开发电脑上构建应用 bundle。
- 一个可以将依赖打入 CommonJS 浏览器 bundle 的构建工具。下文使用 esbuild。

移动设备只需要安装 Runtime 并取得构建产物，不需要安装 Node.js。

下面的示例假设在 Vault 根目录创建一个内容开发项目。实际应用可以放在 Vault 的任意子目录。

## 3. 创建最小项目

### 3.1 目录结构

创建以下文件：

```text
my-vault/
├── package.json
├── tsconfig.json
├── shared/
│   └── interactive-vault-runtime.ts
└── apps/
    └── counter/
        ├── index.md
        ├── project.json
        ├── src/
        │   ├── index.ts
        │   └── styles.css
        └── dist/
            └── main.js       # 构建生成
```

`dist/main.js` 是 Runtime 实际执行的文件。TypeScript 源码和 `node_modules` 不需要同步到只负责运行应用的设备；manifest 直接引用的 CSS 等文件仍然需要同步。

### 3.2 安装构建工具

在 Vault 根目录创建 `package.json`：

```json
{
  "name": "my-interactive-vault-apps",
  "private": true,
  "type": "module",
  "scripts": {
    "build:counter": "esbuild apps/counter/src/index.ts --bundle --format=cjs --platform=browser --target=es2018 --outfile=apps/counter/dist/main.js",
    "dev:counter": "esbuild apps/counter/src/index.ts --bundle --format=cjs --platform=browser --target=es2018 --sourcemap=inline --watch --outfile=apps/counter/dist/main.js",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm run build:counter"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "typescript": "^5.8.0"
  }
}
```

然后安装依赖：

```bash
npm install
```

关键构建选项是：

- `bundle: true`：把应用的运行依赖打进一个文件。
- `format: cjs`：生成 Runtime 支持的 CommonJS 入口。
- `platform: browser`：应用以浏览器 DOM 环境为目标。
- `target: es2018`：兼顾当前桌面端和移动端运行环境。

可以使用 Rollup、Vite 或其他工具，但最终产物必须满足同样的约束。Runtime 不提供 `require()`，因此不能把 Preact、React 或其他运行依赖留在 bundle 外部。

### 3.3 配置 TypeScript

创建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "lib": ["DOM", "ES2022"]
  },
  "include": ["apps/**/*.ts", "shared/**/*.ts"]
}
```

Runtime 当前不发布 npm SDK。为保持应用仓库与插件仓库解耦，在应用项目中保存一份公开协议类型。创建 `shared/interactive-vault-runtime.ts`：

```ts
export type DisplayMode = "embedded" | "view";

export interface ProjectStorage<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  clear(): Promise<void>;
}

export interface ProjectContext {
  displayMode: DisplayMode;
  sourcePath?: string;
  storage: ProjectStorage<unknown>;
  openInView(): Promise<void>;
}
```

公共协议升级时，应对照[应用包协议](application-package-protocol.md)更新这份本地声明，不要从 Runtime 仓库直接编译导入 `src/runtime/types.ts`。

### 3.4 编写 manifest

创建 `apps/counter/project.json`：

```json
{
  "schemaVersion": 1,
  "id": "counter",
  "title": "计数器",
  "description": "Interactive Vault Runtime 示例应用",
  "icon": "plus-circle",
  "entry": "dist/main.js",
  "styles": ["src/styles.css"]
}
```

`id` 必须由小写字母、数字和连字符组成，并且应在整个 Vault 内保持唯一和稳定。它同时决定存档路径：

```text
data/saves/counter.json
```

`entry` 和 `styles` 都相对 `project.json` 所在目录解析，而且不能逃出该目录。CSS 可以像示例一样直接使用源码文件，也可以在构建时复制到 `dist/` 后修改 manifest 路径。

### 3.5 实现 mount()

创建 `apps/counter/src/index.ts`：

```ts
import type {
  ProjectContext,
  ProjectStorage,
} from "../../../shared/interactive-vault-runtime";

interface CounterSave {
  version: 1;
  count: number;
}

function isCounterSave(value: unknown): value is CounterSave {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CounterSave>;
  return (
    candidate.version === 1 &&
    typeof candidate.count === "number" &&
    Number.isFinite(candidate.count)
  );
}

export function mount(
  container: HTMLElement,
  context: ProjectContext,
): () => void {
  let disposed = false;
  let count = 0;
  const storage = context.storage as ProjectStorage<CounterSave>;

  const root = document.createElement("section");
  root.className = "counter-app";

  const value = document.createElement("output");
  value.className = "counter-app__value";

  const increment = document.createElement("button");
  increment.type = "button";
  increment.textContent = "加一";

  const openView = document.createElement("button");
  openView.type = "button";
  openView.textContent = "进入沉浸模式";
  openView.hidden = context.displayMode === "view";

  const render = (): void => {
    value.value = String(count);
  };

  const handleIncrement = (): void => {
    count += 1;
    render();
    void storage.save({ version: 1, count }).catch(console.error);
  };

  const handleOpenView = (): void => {
    void context.openInView().catch(console.error);
  };

  increment.addEventListener("click", handleIncrement);
  openView.addEventListener("click", handleOpenView);
  root.append(value, increment, openView);
  container.append(root);
  render();

  void storage
    .load()
    .then((saved) => {
      if (disposed || !isCounterSave(saved)) return;
      count = saved.count;
      render();
    })
    .catch(console.error);

  return () => {
    disposed = true;
    increment.removeEventListener("click", handleIncrement);
    openView.removeEventListener("click", handleOpenView);
    root.remove();
  };
}
```

入口也可以把 `mount` 放在 default 导出对象中，但推荐直接命名导出。`mount()` 必须同步返回 cleanup；协议不等待异步 cleanup。

示例中的 `disposed` 检查很重要：`storage.load()` 尚未完成时，用户可能已经关闭笔记或标签页。异步结果不应继续修改已卸载的界面。

### 3.6 添加样式

创建 `apps/counter/src/styles.css`：

```css
.counter-app {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--ogr-border);
  border-radius: var(--radius-m);
  background: var(--ogr-surface);
}

.counter-app__value {
  min-width: 3ch;
  color: var(--text-normal);
  font-size: 2rem;
  font-variant-numeric: tabular-nums;
}
```

应用 CSS 注入普通 DOM，不使用 Shadow DOM。所有选择器都应带应用专属前缀，避免影响 Obsidian 和其他应用。

Runtime 提供以下主题变量：

| 变量 | 用途 |
| --- | --- |
| `--ogr-border` | 边框颜色 |
| `--ogr-muted` | 次要文字 |
| `--ogr-surface` | 主表面背景 |
| `--ogr-surface-alt` | 次级表面背景 |
| `--ogr-accent` | 交互强调色 |

也可以使用 Obsidian 标准 CSS 变量，例如 `--text-normal`、`--radius-m`。应用应在桌面和移动端、深色和浅色主题、窄屏与 reduced motion 设置下验证。

### 3.7 构建应用

执行：

```bash
npm run build:counter
```

确认生成 `apps/counter/dist/main.js`。不要在运行时从 CDN、`node_modules`、Node.js 或 Electron 加载代码。

### 3.8 创建入口笔记

创建 `apps/counter/index.md`：

````markdown
# 计数器

```interactive-vault
id: counter
mode: embedded
```
````

因为入口笔记和 `project.json` 在同一个目录，Runtime 会自动读取旁边的 manifest，并确认其 ID 是 `counter`。

当 Obsidian 渲染这段代码块时，计数器会直接嵌入笔记。

## 4. 在笔记中引用应用

### 同目录嵌入

````markdown
```interactive-vault
id: counter
mode: embedded
```
````

省略 `mode` 时默认也是 `embedded`。

### 显式指定 Vault 路径

````markdown
```interactive-vault
manifest: apps/counter/project.json
mode: embedded
```
````

不以 `./` 或 `../` 开头的 `manifest` 从 Vault 根目录解析。

### 使用相对路径

````markdown
```interactive-vault
manifest: ../apps/counter/project.json
mode: embedded
```
````

以 `./` 或 `../` 开头的路径相对当前笔记目录解析。

### 显示沉浸模式启动按钮

````markdown
```interactive-vault
manifest: apps/counter/project.json
mode: view
```
````

`mode: view` 不会在笔记内挂载应用，而是显示一个启动按钮。点击后，Runtime 在新的 Obsidian leaf 中进入沉浸模式。`view` 是协议 v1 保留的技术值，用户界面统一使用“沉浸模式”。

解析器还接受一行裸 ID 和 JSON 对象，但建议项目文档统一使用上面的类 YAML 格式。完整语法见[应用包协议](application-package-protocol.md#markdown-指令)。

## 5. ProjectContext API

```ts
interface ProjectContext {
  displayMode: "embedded" | "view";
  sourcePath?: string;
  storage: ProjectStorage<unknown>;
  openInView(): Promise<void>;
}
```

### displayMode

当前挂载位置：

- `embedded`：应用直接嵌入 Markdown。
- `view`：应用位于沉浸模式；该值为兼容协议保留。

应用可以据此调整布局，但不应假设固定宽度。沉浸模式会覆盖当前窗口，仍需适配手机窄屏、安全区和横竖屏。

### sourcePath

Markdown 嵌入时通常是来源笔记的 Vault 路径。沉浸模式当前不提供此字段，因此应用必须处理 `undefined`。

不要根据 `sourcePath` 直接读取 Vault 文件；当前公开协议没有通用文件读取能力。

### storage

```ts
interface ProjectStorage<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  clear(): Promise<void>;
}
```

- `load()`：读取 `data/saves/<manifest.id>.json`；文件不存在、不可读或 JSON 无效时返回 `null`。
- `save(value)`：把整个值格式化为 JSON 并覆盖存档文件。
- `clear()`：删除对应存档文件；文件不存在时也正常完成。

存档值必须可以被 `JSON.stringify()`。不要保存函数、循环引用、`BigInt` 或密钥。

应用应为存档增加自己的 `version`，并在加载后进行运行时结构校验。TypeScript 类型断言不能验证从磁盘读取的数据。

同一应用的多个挂载共享一个存档文件，但当前没有跨实例锁、事务、冲突合并或跨设备同步。不要依赖高频并发写入，也不要让两台设备同时修改同一个存档。

### openInView()

从当前应用进入同一 manifest 的沉浸模式。调用会重新加载并挂载应用，因此不能假设页面只有一个实例。

## 6. 生命周期要求

Runtime 可能在以下情况卸载应用：

- 用户关闭笔记、标签页或 Obsidian。
- Markdown 重新渲染。
- 沉浸模式改变状态或恢复 workspace。
- Runtime 插件被禁用或重新加载。

cleanup 应同步释放所有由本次挂载创建的资源，包括：

- DOM 与框架根节点。
- DOM、window 和 document 事件监听器。
- `setTimeout`、`setInterval` 和 animation frame。
- 音频、媒体流、Observer、订阅与网络请求。
- 可取消或可忽略的异步任务。

应用必须支持同时挂载多个实例。不要把单个 DOM 容器、计时器或当前界面状态保存在无保护的模块级全局变量中。

使用 Preact 或 React 时，cleanup 中应显式卸载框架根节点。例如 Preact 可以执行 `render(null, container)`。

## 7. manifest 字段

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 是 | 当前只能是数字 `1` |
| `id` | 是 | 小写字母、数字和连字符；也是存档文件名 |
| `title` | 是 | 非空标题，用于按钮和标签页 |
| `entry` | 是 | 包目录内相对 `.js` 路径 |
| `styles` | 否 | 包目录内相对 `.css` 路径数组 |
| `description` | 否 | 当前加载但不展示 |
| `icon` | 否 | Obsidian 图标名；沉浸模式默认使用 `blocks` |

Runtime 会忽略未知 manifest 字段，应用不应依赖它们被传入 `mount()`。字段的精确校验和路径规则见[应用包协议](application-package-protocol.md#目录与-manifest)。

## 8. 调试与常见问题

开发时可以运行 watch 构建：

```bash
npm run dev:counter
```

构建完成后，让 Obsidian 重新渲染入口笔记，或者退出并重新进入沉浸模式。Runtime 每次加载都会重新读取 bundle 和 CSS。

桌面端可以使用 Obsidian 开发者工具查看 console。Runtime 为入口脚本设置了类似下面的 source URL，便于定位 bundle：

```text
interactive-vault://apps/counter/dist/main.js
```

常见问题：

| 现象或错误 | 检查项 |
| --- | --- |
| 代码块保持原样 | Runtime 是否已安装并启用；语言名是否恰好为 `interactive-vault` |
| `项目 manifest 不存在` | `manifest` 是 Vault 路径，不是操作系统绝对路径；检查相对路径基准 |
| `项目 id 不匹配` | 代码块中的 `id` 必须与 `project.json` 一致 |
| `项目入口不存在` | 是否已经构建；`entry` 是否相对 manifest 目录 |
| `项目入口必须导出 mount()` | bundle 是否为 CommonJS，最终导出是否包含 `mount` |
| `require is not defined` | 依赖没有打入 bundle；检查 `bundle` 与 external 配置 |
| 样式影响其他页面 | 为所有 CSS 选择器增加应用专属前缀 |
| 关闭页面后仍在运行 | cleanup 未移除计时器、监听器或订阅 |
| 存档无法恢复 | 检查 ID 是否改变、数据是否可 JSON 序列化、校验器是否接受当前版本 |
| 多窗口状态互相覆盖 | 多实例共享存档，应用需要降低写入频率或设计冲突策略 |

## 9. 测试建议

将业务规则和存档校验从 UI 中拆出，使用 Vitest 等工具做单元测试。至少覆盖：

- 新状态、正常操作和边界条件。
- 存档序列化、合法恢复、损坏数据和旧版本迁移。
- 重复 mount/cleanup 不遗留 DOM、监听器和计时器。
- `storage.load()` 较晚完成时，已卸载界面不会被修改。

交付前还应在真实 Obsidian 中手工验证：

- 嵌入模式和沉浸模式，并确认退出后 Obsidian 界面恢复。
- 桌面端和移动端。
- 鼠标、键盘与触控。
- 深色和浅色主题。
- 窄屏、安全区和 reduced motion。
- 关闭后重新打开的存档恢复。

## 10. 分发与兼容性

本示例需要把以下文件放入目标 Vault：

```text
apps/counter/project.json
apps/counter/index.md
apps/counter/dist/main.js
apps/counter/src/styles.css
```

一般来说，应用包必须包含 `project.json`、入口 bundle，以及 manifest 引用的所有 CSS；还需要至少一篇包含 `interactive-vault` 指令的笔记来启动它。如果 manifest 或应用引用其他资源，也要一并分发。目标设备还必须单独安装并启用 Interactive Vault Runtime。

建议将构建产物提交到内容仓库或纳入 Vault 同步，因为手机通常不会现场构建应用。插件安装目录、应用源码和应用包可以采用不同的同步策略。

发布后不要随意修改应用 ID：ID 是存档键。改变 manifest 字段含义、入口格式、存档路径或生命周期约定可能需要新的 Runtime schema；新增可选字段或 Context 能力通常可以保持向后兼容。

## 11. 安全边界

Runtime 通过 `new Function` 执行 bundle。路径校验只能避免配置错误访问应用包之外的入口或样式，不能隔离恶意 JavaScript。

- 只安装和同步可信来源的应用包。
- 不要把用户提供的任意字符串拼成可执行代码。
- 不要在存档里保存访问令牌、密码或其他秘密。
- 不要把应用描述成运行在 iframe、Worker 或其他安全沙箱中。

## 12. 发布前检查清单

- [ ] `project.json` 使用 `schemaVersion: 1`，ID 唯一且稳定。
- [ ] CommonJS browser bundle 自包含全部运行依赖。
- [ ] 入口导出 `mount(container, context)`。
- [ ] `mount()` 返回同步 cleanup，并支持多实例。
- [ ] 异步加载在卸载后不会更新 UI。
- [ ] 存档有版本号、运行时校验和必要的迁移策略。
- [ ] CSS 使用应用专属前缀，不污染 Obsidian。
- [ ] manifest 引用的所有文件都已进入 Vault 和同步范围。
- [ ] 已验证嵌入、沉浸模式、退出恢复、桌面、移动、深浅主题和输入方式。
- [ ] 已确认应用包来自可信来源，不把 Runtime 当作安全沙箱。
