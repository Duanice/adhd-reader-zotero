# Synthetic tests / 合成测试

All test inputs in this repository are authored strings, generated rectangles, simulated PDF operators, or mocked reader objects. No test requires a personal library, local PDF, network request, screenshot, or Zotero profile.

仓库测试仅使用编写的字符串、生成的矩形、模拟 PDF 操作及阅读器对象；不依赖个人文献库、本地 PDF、网络、截图或 Zotero 配置。

- `native.test.mjs`: toolbar lifecycle, exact-source reading anchors, click/key ownership, column order, page transitions, scrolling, zoom/rotation races, excluded-table migration, and native selection yielding.
- `tables.test.mjs`: ruled/borderless tables, protected captions/notes, wrapped cells, and mathematical/prose negative cases.
- `reading-scroll.test.mjs`: central comfort band, retargeting, cancellation, reduced motion, and delayed frames.
- `glyph-metrics.test.mjs`: generated font/path metrics.
- `visible-reading-line.test.mjs`: visible-flow selection used when initially enabling an unpositioned reader; manual browsing does not replace an existing anchor.
