# dsh 扩展版 — 电子书阅读与知识管理工具插件集

设计文档**第二部分**的实现：基于 deepseek-harness 的工具插件，目标平台 macOS、Windows。

## 设计约束的实现（设计文档 2.1）

| 约束 | 实现方式 |
|---|---|
| **上游零修改** | 全部通过 `profiles/ebook-profile/cordis.patch.yml` 的 `insert` 挂载，不改 dsh 仓库任何文件 |
| **界面隔离** | 阅读器是独立 SPA（`apps/ebook-reader`），工具只返回 `{ action: 'open_url', url }` |
| **快速同步** | dsh 上游 `git pull` 即可，本仓库无任何 dsh 内部依赖 |

## 目录

```
dsh-extension/
├── packages/
│   ├── dsh-tool-ebook/       # open_ebook / convert_and_open
│   ├── dsh-tool-library/     # open_library / sync_library / import_from_remote / add_remote_source
│   │   └── src/remote.ts     # WebDAV + 百度网盘适配器（设计文档 2.5）
│   ├── dsh-tool-convert/     # convert_markdown_to_docx / convert_djvu_to_pdf
│   ├── dsh-tool-translate/   # translate_text（复用 dsh 模型配置）
│   ├── dsh-tool-wiki/        # wiki_create_page / wiki_search / wiki_graph / open_wiki
│   └── dsh-tool-password/    # open_password_vault（cube-password 入口）
├── apps/
│   └── ebook-reader/         # Vite + React + TypeScript 阅读器 SPA
│       ├── src/engines/      # EPUB(foliate-js) / PDF(PDF.js) / Markdown(markdown-it) / TXT(自研分页器)
│       ├── src/pages/        # 图书馆 / 阅读器 / 录课 / Wiki
│       └── src/store.ts      # library.json 状态管理 + 悬空引用检测
├── profiles/
│   └── ebook-profile/        # dsh profile：package.json + cordis.patch.yml
└── services/                 # （预留）wiki-mcp 独立服务
```

## 快速开始

```bash
pnpm install
pnpm -r --filter './packages/**' run build      # 构建 6 个插件
pnpm -r --filter './packages/**' run typecheck  # 类型检查
pnpm --filter dsh-tool-ebook exec vitest run    # 14 个激活测试
pnpm --filter ebook-reader run build            # 构建阅读器前端
```

### 装进真实的 dsh profile

```bash
# 1. 从 web 模板创建 profile
DSH_HOME=/path/to/dsh-home dsh --profile ebook --from-default-profile web

# 2. 应用本仓库的 patch 层
cp dsh-extension/profiles/ebook-profile/cordis.patch.yml \
   /path/to/dsh-home/profiles/ebook/cordis.patch.yml

# 3. 安装插件
cd /path/to/dsh-home/profiles/ebook
pnpm add ./dsh-extension/packages/dsh-tool-ebook \
       ./dsh-extension/packages/dsh-tool-library \
       ./dsh-extension/packages/dsh-tool-convert \
       ./dsh-extension/packages/dsh-tool-translate \
       ./dsh-extension/packages/dsh-tool-wiki \
       ./dsh-extension/packages/dsh-tool-password

# 4. 启动
MYLIBRARY_ROOT=/path/to/MyLibrary DSH_HOME=/path/to/dsh-home dsh --profile ebook
```

启动后用 `dsh --profile ebook --dump-config` 可以看到六个插件都在组合树里。

## 工具清单（设计文档 2.3）

| 插件包 | 注册的工具 |
|---|---|
| `dsh-tool-ebook` | `open_ebook(bookPath)`、`convert_and_open(bookPath)` |
| `dsh-tool-library` | `open_library()`、`sync_library(remoteRoot, dryRun)`、`import_from_remote(sourceId, path)`、`add_remote_source(type, config)` |
| `dsh-tool-convert` | `convert_markdown_to_docx(input, output)`、`convert_djvu_to_pdf(input, output)` |
| `dsh-tool-translate` | `translate_text(text, targetLang, sourceLang, context)` |
| `dsh-tool-wiki` | `wiki_create_page`、`wiki_search`、`wiki_graph`、`open_wiki`、`wiki_mcp_status` |
| `dsh-tool-password` | `open_password_vault()` |

所有工具都**不注册** `ConversationNodeDefinition`，因此不出现在 Chat 消息流中（设计文档 2.3）。

## 外部工具依赖（用户自备，软件不安装）

`dsh-tool-convert` 依赖两个命令行工具完成格式转换。**本软件不负责安装它们**
——插件只做探测、调用、以及在缺失时给出安装指引。

| 工具 | 用途 | 安装方式 |
|---|---|---|
| `pandoc` | Markdown → DOCX | macOS `brew install pandoc`；Windows `winget install --id JohnMacFarlane.Pandoc`；Linux 见 [pandoc.org/installing](https://pandoc.org/installing.html) |
| `ddjvu` | DjVu → PDF | macOS `brew install djvulibre`；Windows 从 [djvu.sourceforge.net](http://djvu.sourceforge.net/) 下载；Linux `apt install djvulibre-bin` |

### 关于 PATH 的坑

dsh 若由 GUI（Finder / 桌面 App）启动，其进程 PATH 通常只有 `/usr/bin:/bin`，
**不包含 `/opt/homebrew/bin`**——于是 `pandoc` 明明装了却探测不到。

插件因此实现了多级探测（`resolveCommand`）：

1. 绝对路径 → 直接检查可执行权限
2. `PATH` 里的 `which` / `where`
3. 各平台常见目录：`/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`、`~/.local/bin`

所以即使 PATH 不完整也能找到。若装在非常规位置，可在插件配置里写绝对路径：

```yaml
- id: dsh-tool-convert
  config:
    pandocCommand: '/custom/path/to/pandoc'
    ddjvuCommand: '/custom/path/to/ddjvu'
```

工具缺失时不会抛错，而是返回 `executed: false` 并附带安装提示，前端可据此引导用户。

## 已验证

- 六个插件 `pnpm build` 全部通过，`tsc --noEmit` 零错误
- 六个插件模块可被真实 dsh 运行时加载（peer 依赖从 dsh 宿主解析）
- 真实 `dsh --profile ebook` 启动成功，`--dump-config` 确认六个插件进入组合树
- **36 个测试**：14 个激活测试 + 9 个百度分片上传 + 13 个真实格式转换
- 格式转换是**真跑 pandoc / ddjvu**：Markdown→DOCX 产物是合法 ZIP（PK 头），
  DjVu→PDF 产物通过 `pdfinfo` 校验出 1 页
- `apps/ebook-reader` `vite build` 成功，foliate-js 与 PDF.js 正确分包

## 阅读器渲染引擎（设计文档 2.4）

| 格式 | 方案 | 状态 |
|---|---|---|
| EPUB | foliate-js（首选） | 引擎 + 动态 import 已接 |
| PDF | PDF.js + AnnotationEditorLayer | 引擎已接，`saveDocument()` 写回路径已留 |
| Markdown | markdown-it | 完整可用（含批注边车读写） |
| TXT | 自研分页器 | 完整可用（含批注边车读写） |

PDF 笔记通过 `pdfDocument.saveDocument()` 序列化回文件，生成**原生 PDF 注释对象**，
与 Flutter 版（PDFium 注释 API）互通（设计文档 4.2「跨端批注」）。
