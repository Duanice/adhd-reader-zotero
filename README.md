# ADHD Reader for Zotero

[中文](#中文) · [English](#english) · [Download XPI](https://github.com/julyseaweed/adhd-reader-zotero/releases/latest/download/ADHD-Reader-Zotero.xpi) · [Chrome version](https://github.com/julyseaweed/adhd-reader-chrome)

## 中文

ADHD Reader 在 **Zotero 原生 PDF 阅读器**中突出当前阅读行，淡化周围内容。点击正文或使用键盘逐行阅读；文献管理、高亮、下划线、评论和翻译插件继续使用 Zotero 的现有工具。

### 安装与更新

1. 下载 [ADHD-Reader-Zotero.xpi](https://github.com/julyseaweed/adhd-reader-zotero/releases/latest/download/ADHD-Reader-Zotero.xpi)。需要历史版本时打开 [Releases](https://github.com/julyseaweed/adhd-reader-zotero/releases)。
2. 在 Zotero 中打开 **工具 → 插件**，点击齿轮，选择 **从文件安装插件**，然后选中下载的 XPI。此步骤也可参考 [Zotero 官方安装说明](https://www.zotero.org/support/plugins)。
3. 打开一篇 PDF，点击顶部工具栏的 **行读**。若安装时已打开的阅读器没有显示按钮，关闭该 PDF 标签再打开。

更新时用相同步骤安装新版 XPI；插件 ID 保持一致，Zotero 会替换旧版本。**0.1.16 使用手动更新**。不需要把 PDF 转换或复制到另一个阅读器。

### 操作

| 操作 | 效果 |
| --- | --- |
| 点击「行读」 | 开启或关闭聚焦 |
| 点击正文某一行 | 将该行设为阅读位置 |
| `↓` / `Enter` | 下一阅读单元；到页末自动继续 |
| `↑` | 上一阅读单元；支持反向跨页 |
| 滚轮、触摸板或滚动条 | 自由浏览，保留原阅读位置 |
| 「⋯」 | 调整淡化程度、切换日夜模式、导出带标注的 PDF |

快捷键只在没有文字选区、没有编辑输入且原生选择工具可用时接管。默认日间模式。菜单也可以用 `Esc` 关闭。

阅读行在中部舒适区内时页面保持稳定，偏离后平滑移动；连续按键会接续滚动，不会把每一行固定在同一高度。系统的减少动态效果设置会被遵从。

**手动浏览不会另选一行。** 即使滚到别页，原行也继续保留；当前视野只显示淡化蒙版。滚回后仍突出原行，再按逐行键会从原行继续并将它带回视野。缩放和旋转更新同一原文锚点；原行已离屏时不会把视野拉回。

多栏内容按阅读区域先读完一栏，再进入下一栏，并处理跨栏标题和局部分栏。公式按阅读单元合并。图表内部的标签、数据单元格和空白区域不进入逐行路径；图注、表题和表注保留。点图表内部不会改变阅读位置，原始文字仍可选择。

### 标注、翻译与工作流

高亮、下划线、便笺和评论使用 **Zotero 原生标注工具**。本插件没有另外实现一套编辑器。通过「⋯」中的导出或 Zotero 的 PDF 导出功能，把标注写入导出 PDF；其他支持标准 PDF 标注的阅读器也能读取它们。Zotero 内部标注与导出的 PDF 是不同的保存步骤。

Zotero 版不内置翻译、词典或翻译请求。选中文字后的 `Enter`、方向键及相关交互留给 Zotero 和已安装的翻译插件。浏览器里的独立 PDF 工作流可使用姊妹项目 [ADHD Reader for Chrome](https://github.com/julyseaweed/adhd-reader-chrome)。

### 兼容范围

- **实际运行验证：Windows 上的 Zotero 10.0.7。** 0.1.16 的原生验证包含鼠标和键盘、跨页、图表排除、原生标注导出及生命周期检查。
- 清单允许 Zotero **7.0–10.0.x** 安装；这些版本及 macOS/Linux 尚未全部实机验证。
- PDF 需要可提取文字层；扫描件应先做 OCR。本插件不自带 OCR。
- 分屏时聚焦作用于主阅读区。复杂排版的区域识别可能需要继续改进。
- 仅处理 PDF，不提供 EPUB 或网页阅读模式。

### 开发与构建

需要 Node.js 20 或更新版本和 npm。在仓库根目录执行：

```sh
npm ci
npm test
npm run build
npm run verify:release
npm run package
```

安装产物是 `dist/ADHD-Reader-Zotero.xpi`。构建不需要 Zotero 配置、文献库或本地 PDF，也不会安装插件。

`addon/` 中的三个文件对应已验证的 0.1.16 发行内容。`src/` 是生成 `glyph-metrics.js` 所需的共享源码闭包；锁定版本的 esbuild 负责打包。`release-checksums.json` 及 `verify:release` 校验三个文件的逐字节一致性。修改产品或升级依赖后，应在验证新版本时更新校验值。

测试输入全部为合成文字、几何或阅读器模拟对象，说明见 [tests/README.md](tests/README.md)。仓库不包含用户 PDF、阅读状态、截图、运行日志或 Zotero 配置。

项目源码尚未指定许可；依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。开发接口参考 [Zotero 插件文档](https://www.zotero.org/support/dev/zotero_7_for_developers)。

## English

ADHD Reader highlights the current reading line and dims surrounding content **inside Zotero's native PDF reader**. Click text or use the keyboard to read one unit at a time, while keeping Zotero's library, annotations, comments, and translation plugins.

### Install and update

1. Download [ADHD-Reader-Zotero.xpi](https://github.com/julyseaweed/adhd-reader-zotero/releases/latest/download/ADHD-Reader-Zotero.xpi). Previous versions are listed under [Releases](https://github.com/julyseaweed/adhd-reader-zotero/releases).
2. In Zotero, open **Tools → Plugins**, click the gear, choose **Install Plugin From File**, and select the XPI. See the [official Zotero installation instructions](https://www.zotero.org/support/plugins).
3. Open a PDF and click **行读** (line guide) in its toolbar. If a reader that was already open does not show the button, close and reopen that PDF tab.

Install a newer XPI in the same way to update. The stable add-on ID lets Zotero replace the previous version. **Version 0.1.16 uses manual updates.** PDFs stay in the native reader.

### Controls

| Action | Result |
| --- | --- |
| **行读** | Toggle the reading guide |
| Click a body-text line | Set the reading position |
| `↓` / `Enter` | Next reading unit, continuing across pages |
| `↑` | Previous reading unit, including the preceding page |
| Wheel, touchpad, or scrollbar | Browse freely while retaining the reading position |
| **⋯** | Adjust dimming, switch day/night mode, or export an annotated PDF |

Reading keys are handled only when there is no text selection or editing input and the native selection tool is available. Day mode is the default. `Esc` closes the settings menu.

The page stays still while the line is within a central comfort band, then moves smoothly when needed. Repeated keys continue the motion without pinning every line to one height. The system's reduced-motion preference is respected.

**Manual browsing never selects a substitute line.** The original line remains anchored even on another page. An offscreen anchor leaves the visible area dimmed; returning reveals the original line, and a reading key resumes from it and brings it into view. Zoom and rotation update the same source anchor without pulling an offscreen reading position back into view.

Multi-column content is read down one column before moving to the next, including spanning headings and locally split sections. Mathematical expressions are grouped into reading units. Figure interiors and table data are skipped, while figure captions, table titles, and notes remain in the path. Clicking inside an excluded figure or table does not move the reading anchor. Its original text remains selectable.

### Annotations, translation, and workflow

Use **Zotero's native tools** for highlights, underlines, notes, and comments. This add-on does not implement a separate editor. Export through the **⋯** menu or Zotero's PDF export to embed annotations in an exported PDF for other readers that support standard PDF annotations. Saving a Zotero annotation and exporting it into a PDF are separate operations.

The Zotero add-on includes no translator, dictionary, or translation service requests. Selected-text `Enter`, arrow keys, and related interactions remain available to Zotero and installed translation plugins. For independent PDF reading in the browser, see [ADHD Reader for Chrome](https://github.com/julyseaweed/adhd-reader-chrome).

### Compatibility

- **Runtime tested: Zotero 10.0.7 on Windows.** Native 0.1.16 validation covers mouse/keyboard interaction, page transitions, figure/table exclusions, native annotation export, and lifecycle behavior.
- The manifest permits **Zotero 7.0–10.0.x**; not every version or macOS/Linux installation has been tested.
- PDFs need an extractable text layer. OCR scanned documents before use; OCR is not bundled.
- In split view, the guide operates on the primary reading pane. Complex layout recognition may need further improvements.
- PDF only; EPUB and web-page reading are not included.

### Development

Use Node.js 20 or newer and npm. From the repository root:

```sh
npm ci
npm test
npm run build
npm run verify:release
npm run package
```

The installable output is `dist/ADHD-Reader-Zotero.xpi`. Building requires no Zotero profile, library, or local PDF and does not install the add-on.

The three `addon/` files match the tested 0.1.16 release. `src/` contains the shared source dependency closure needed to produce `glyph-metrics.js`, bundled with the pinned esbuild version. `release-checksums.json` and `verify:release` check the exact bytes of those three files. Update the checksums only after validating an intentional new product or dependency version.

All public tests use synthetic text, geometry, or reader mocks; see [tests/README.md](tests/README.md). No user PDFs, reading state, screenshots, runtime logs, or Zotero profiles are included.

The project source has no assigned license yet. Dependency licenses are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). See the [Zotero developer documentation](https://www.zotero.org/support/dev/zotero_7_for_developers) for the plugin lifecycle.
