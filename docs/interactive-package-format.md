# `.ivpkg` 发行包格式 v1

`.ivpkg` 是 Interactive Vault Runtime 的通用安装包格式。它是使用 `.ivpkg` 扩展名的 ZIP 文件，用于把一个或多个符合[应用包协议](application-package-protocol.md)的项目安装到当前 Vault 的指定目录。

发行包协议只描述文件分发，不包含应用商店、软件源或业务分类。Runtime 不内置任何发行者、产品或下载地址。

## 安装入口

Runtime 当前支持：

- 在插件设置中选择本地 `.ivpkg` 文件。
- 在插件设置中输入直接指向 `.ivpkg` 文件的 HTTPS URL。
- 通过命令面板调用对应的两个安装命令。

安装前会显示包名、发布者、版本、文件数量、解压后大小和目标目录。目标必须是当前 Vault 内的专用目录，不能位于 Vault 配置目录或回收站。首次安装不会覆盖已有的非受管目录；同一包 ID 的后续安装会更新原目录，旧版本移入 Vault 回收站。安装后 Runtime 会在目标根目录写入一份 `iv-package.json` 管理标记，内容文件不能占用这个保留路径。

## ZIP 结构

```text
example.ivpkg
├── iv-package.json
└── content/
    ├── index.md
    └── apps/example/
        ├── project.json
        └── dist/
            ├── main.js
            └── styles.css
```

归档根目录只允许包含 `iv-package.json` 和清单声明的 `content/<path>` 文件。目录项可以存在但会被忽略。Runtime 会拒绝未声明文件、缺失文件、重复路径、绝对路径、反斜杠、冒号及 `.`/`..` 路径段。

## `iv-package.json`

```json
{
  "schemaVersion": 1,
  "id": "example.interactive-pack",
  "title": "Example interactive pack",
  "version": "1.0.0",
  "publisher": {
    "id": "example",
    "name": "Example publisher"
  },
  "kind": "collection",
  "entryNote": "index.md",
  "projects": [
    {
      "id": "sample-app",
      "title": "Sample app",
      "kind": "app",
      "version": "1.0.0",
      "manifest": "apps/example/project.json",
      "entryNote": "index.md"
    }
  ],
  "files": [
    {
      "path": "index.md",
      "size": 128,
      "sha256": "...64 lowercase hexadecimal characters..."
    }
  ]
}
```

| 字段 | 必需 | 规则 |
| --- | --- | --- |
| `schemaVersion` | 是 | 当前只能是数字 `1` |
| `id` | 是 | 小写字母、数字、点和连字符组成的稳定包 ID |
| `title` | 是 | 非空显示名称 |
| `version` | 是 | 语义化版本 |
| `publisher` | 是 | 包含稳定 `id` 和显示 `name` |
| `kind` | 否 | 通用分类字符串；Runtime 不解释业务含义 |
| `entryNote` | 否 | 安装后可打开的包级入口笔记，必须在 `files` 中 |
| `projects` | 是 | 非空项目列表；每项指向一个已打包的 `project.json` |
| `files` | 是 | 非空文件列表，包含相对路径、字节数和 SHA-256 |

Runtime 还会读取每个项目 manifest，确认项目 ID 相同，并确认它引用的 `.js` 入口和 `.css` 样式都包含在发行包内。

为了能够安装到任意 Vault 子目录，包内笔记、目录应用和 `openProject()` 调用应使用以 `./` 或 `../` 开头的相对路径，不应假定包位于 Vault 根目录。

## 完整性与限制

安装前会校验所有文件的大小和 SHA-256。校验值用于发现损坏或与清单不一致的内容，但 schema v1 尚不包含发布者数字签名，因此不能在下载来源已被控制时证明发布者身份。用户仍然必须只安装来自可信来源的包。

当前限制：

- 压缩包最大 128 MiB。
- 单个内容文件最大 64 MiB。
- 解压后内容最大 256 MiB。
- 最多 4096 个内容文件。
- `iv-package.json` 最大 1 MiB。
- 远程安装只接受 HTTPS。

`.ivpkg` 可以包含可执行 JavaScript，并会以插件权限运行；它不是安全沙箱。Runtime 会限制写入路径和验证包结构，但这些措施不能让恶意应用代码变得安全。
