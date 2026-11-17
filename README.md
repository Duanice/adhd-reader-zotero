# ADHD Sentence Reader for Zotero

[中文](#中文) · [English](#english) · [Download XPI](https://github.com/Duanice/adhd-reader-zotero/releases/latest/download/ADHD-Sentence-Reader-Zotero.xpi)

## 中文

在 Zotero 自带的 PDF 阅读器中突出当前句子，淡化周围内容。长句换行时，每行只突出属于当前句子的部分。基于 [ADHD Reader for Zotero](https://github.com/julyseaweed/adhd-reader-zotero) 的阅读顺序、滚动和交互实现。

1. 下载 [ADHD-Sentence-Reader-Zotero.xpi](https://github.com/Duanice/adhd-reader-zotero/releases/latest/download/ADHD-Sentence-Reader-Zotero.xpi)。
2. 在 Zotero 打开 **工具 → 插件 → 齿轮 → 从文件安装插件**，选中下载的文件。
3. 打开 PDF，点击顶部的 **句读**。已打开的 PDF 如未显示按钮，关闭标签后重新打开即可。更新时用同样的方法安装新版。

| 操作 | 效果 |
| --- | --- |
| 点击「句读」 | 开关聚焦 |
| 点击正文中的一句 | 从该句开始读 |
| `↓` / `Enter` | 下一句，到页末自动继续 |
| `↑` | 上一句，可返回前一页 |
| 滚轮、触控板、滚动条 | 自由浏览，保留上次聚焦的句子 |
| 「⋯」 | 调整淡化程度、切换日夜模式、导出带标注的 PDF |

句子接近屏幕边缘时才平滑滚动。缩放和旋转会追踪同一句。划重点、下划线、便笺、评论和导出仍使用 Zotero 原生功能，选中文字或编辑时，插件会把快捷键留给原本的操作。

适用于有可选中文字的 PDF。扫描件需要先做 OCR。句子在页边界处拆成两步，独立公式沿用上游的单步阅读逻辑。兼容清单允许在 Zotero 7.0–10.0.x 安装。

## English

Focus on the current sentence and dim its surroundings in Zotero's built-in PDF reader. Wrapped sentences reveal only their own text on each line. Reading order, scrolling and interactions come from [ADHD Reader for Zotero](https://github.com/julyseaweed/adhd-reader-zotero).

Download the [latest XPI](https://github.com/Duanice/adhd-reader-zotero/releases/latest/download/ADHD-Sentence-Reader-Zotero.xpi). In Zotero, choose **Tools → Plugins → gear → Install Plugin From File**, open a PDF, and click **句读** in its toolbar. Reopen the PDF tab if the button is missing. Use the same installation steps to update.

Click a sentence to start there. Use **↓** or **Enter** for the next sentence and **↑** for the previous one. Manual scrolling retains the last reading position. Use **⋯** to set dimming, switch light/dark mode, or export the annotated PDF. Zotero handles highlights, underlines, notes and comments directly, and keeps its shortcuts while selecting text or editing.

The add-on requires a selectable PDF text layer, permits Zotero 7.0–10.0.x, and treats a sentence split by a page break as two steps. Display equations retain the original one-step behavior.

## Build

Use Node.js 20 or later.

```sh
npm ci
npm test
npm run package
npm run verify:release
```

The installer is `dist/ADHD-Sentence-Reader-Zotero.xpi`. Test inputs are synthetic. See [Tests](tests/README.md).

The upstream project has no assigned source license. Dependency licenses are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
