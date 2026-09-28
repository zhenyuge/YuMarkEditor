# YuMarkEditor

轻量化的 Markdown 文本编辑器（macOS）。

一个纯粹的 Markdown 编辑器，像记事本一样用：双击一个 `.md`，改，保存，关掉。
没有笔记库，没有 AI，没有后台进程。

- 原生 Swift/AppKit 外壳 + 系统自带的 WKWebView（不是 Electron），App 约 9 MB，启动到可输入约 0.25 秒
- 关掉窗口即退出，不常驻；不建索引、不留版本历史、不申请任何设备权限

## 构建与安装

需要：Xcode Command Line Tools、Node.js、`brew install webp`（WebP 编码器，静态链接进 App）。

```bash
cd web && npm install && cd ..
./build.sh                 # 产物：build/YuMarkEditor.app
cp -R build/YuMarkEditor.app /Applications/
```

首次打开后，在菜单「YuMarkEditor → 设为 .md 文件的默认编辑器」，之后双击 `.md` 就用它打开。
也可以在终端里 `build/YuMarkEditor.app/Contents/MacOS/YuMarkEditor 文件.md 文件夹/`。

## 功能

**富文本与源码双模，保存时不改你的文件** — ⌘E 切换。富文本模式保存时，没改过的块直接写回文件里的原文：
表格的对齐填充、列表用 `*` 还是 `-`、Setext 标题、CRLF、BOM、GBK 编码、文件末尾有没有换行都不动；
`my_var` 不会变成 `my\_var`；`[[双向链接]]`、`![[嵌入]]`、`#标签` 不解析，但逐字节写回。
改过的块才会重新生成 Markdown，而且转义尽量少：每个改过的段落都会被重新解析一遍，确认与编辑器里的内容一致才落盘。

**Markdown 语法** — 标题、列表、任务列表、表格、代码高亮、引用、链接、图片、脚注、`> [!NOTE]` 提示块、`[TOC]`、
属性（frontmatter）卡片、KaTeX 公式、Mermaid 流程图、SVG / HTML。
行首输入 `/`（中文输入法下是 `、`）打开插入菜单；选中文字弹出格式气泡；⌥↑ / ⌥↓ 整块移动。
粘贴或拖入的图片自动压缩成 WebP，存进文档旁的 `assets/`（未命名文档先暂存，保存时再移过去）。

**和记事本一样的规矩** — 永远有一篇文档开着，没有欢迎页；自动保存默认关闭（「文件 → 自动保存」可开）；
未命名文档不会被悄悄建成文件；没保存的内容重启后还在（退出时不弹"是否保存"）。
文件在外部被修改时：没改动就静默重新载入，有改动就在顶部提示你选。

**导出** — ⌘P 选个位置直接生成分页的 A4 PDF（不弹打印面板，图片、表格、公式不跨页）；
单文件 HTML（图片和公式字体全部内联）；Word（.docx，公式是可编辑的 Word 公式，脚注是真脚注）；
长图（1500 像素宽，很长的文档自动分成几张，切在段落边界上）。

**标签页与文件夹** — ⌘W、⇧⌘T 重开、⌃Tab / ⌃⇧Tab、⌘1～⌘9、拖动排序、右键批量关闭，重启后恢复。
⇧⌘O 打开文件夹，侧边栏是一棵朴素的文件树：新建、重命名、创建副本、移到废纸篓，不建索引。

## 快捷键

| 操作 | 快捷键 | 操作 | 快捷键 |
|---|---|---|---|
| 源码 / 富文本 | ⌘E | 查找 / 替换 | ⌘F / ⌥⌘F |
| 新建 / 打开 / 打开文件夹 | ⌘N / ⌘O / ⇧⌘O | 下一个 / 上一个匹配 | ⌘G / ⇧⌘G |
| 保存 / 另存为 | ⌘S / ⇧⌘S | 侧边栏 | ⌘\ |
| 关闭 / 重开标签页 | ⌘W / ⇧⌘T | 字号 | ⌘+ / ⌘- / ⌘0 |
| 导出 PDF | ⌘P | 整块上移 / 下移 | ⌥↑ / ⌥↓ |
| 加粗 / 斜体 / 删除线 | ⌘B / ⌘I / ⇧⌘X | 标题 1–6 / 正文 | ⌥⌘1–6 / ⌥⌘0 |
| 行内代码 / 行内公式 | ⌃\` / ⌃M | 链接 | ⌘K |
| 引用 / 无序 / 有序 / 任务 | ⌥⌘Q / ⌥⌘U / ⌥⌘O / ⌥⌘X | 代码块 / 公式块 / 表格 | ⌥⌘C / ⌥⌘M / ⌥⌘T |
| 跳出当前块 | ⌘↩ | 硬换行 | ⇧↩ |

## 图标

`design/icon/yumark.svg` 是图标源文件：把 Markdown 官方标志的 `[M↓]` 改写成 `[Yu↓]`，深海军蓝底、白色线框与字母、金色下箭头。
改完 SVG 后运行 `scripts/make-icon.sh` 重新生成 `native/AppIcon.icns`（用无头 Chrome 渲染，iconutil 打包）。
`design/icon/explore/` 里是设计过程中的其他方案。

## 代码结构

```
native/Sources/        Swift 外壳（约 1300 行）
  MainWindow.swift       窗口、标题栏拖动、红绿灯位置
  Bridge.swift           JS ↔ 原生：文件、对话框、菜单、导出
  SchemeHandler.swift    yumark://app/ 提供界面资源，/@fs/ 提供本地图片
  Files.swift            按原编码读写（UTF-8 / BOM / UTF-16 / GB18030），替换写入保留元数据
  ImageSaver.swift       图片 → WebP（libwebp）
  Exporter.swift         离屏 WebView：分页 PDF、长图
web/src/
  md/markdown.ts         markdown-it + 扩展（脚注、公式、提示块、TOC、frontmatter、原样保留的链接定义）
  md/parse.ts            Markdown → ProseMirror 文档，并记录每个顶层块的原文切片
  md/serialize.ts        ProseMirror → Markdown（最少转义 + 回读校验）
  md/compose.ts          保存：没改过的块写原文，改过的块才序列化（LCS 对齐）
  rich/                  富文本编辑器（节点视图、输入规则、斜杠菜单、格式气泡）
  source/                源码模式（CodeMirror 6，按需加载）
  export/                HTML / Word 导出
  app/                   标签页、侧边栏、查找栏、会话
```

## 测试

```bash
scripts/test.sh
```

包括：CommonMark 规范 652 个用例在 LF / CRLF / 无末尾换行三种形态下的逐字节往返、强制重新序列化后的语义一致性、
Word 导出结构检查、无头 Chrome 里的交互测试（输入规则、斜杠菜单、保存、模式切换、查找替换、粘贴），
以及在真实 WKWebView 里的冒烟测试（`scripts/apptest.sh`，会短暂弹出一个窗口，用独立的数据目录）。

## 已知限制

- 同类强调直接嵌套（如 `*_foo_*`、`****foo****`）在富文本模型里会合并，若编辑了所在的块，保存时会写成简化形式。
- 改过的段落里，引用式链接 `[文字][ref]` 会被写成行内链接 `[文字](url)`（没改过的段落保持原样）。
- 混用换行符（同一文件里既有 CRLF 又有 LF）的文件，在源码模式里编辑后会统一成占多数的那种。
