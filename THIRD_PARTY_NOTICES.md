# Third-party notices / 第三方许可说明

The packaged add-on contains this project's JavaScript. It uses Zotero's own PDF reader and does not redistribute Zotero, PDF.js, dictionaries, or a translation service client.

发行插件包含本项目的 JavaScript，使用 Zotero 自带的 PDF 阅读器，不再分发 Zotero、PDF.js、词典或翻译服务客户端。

| Dependency / 依赖 | Use / 用途 | License / 许可 |
| --- | --- | --- |
| [esbuild 0.27.3](https://github.com/evanw/esbuild) and its platform packages | Development-time bundling / 开发时打包 | MIT, [full text / 全文](licenses/esbuild-MIT.txt) |

esbuild is a development dependency; its executable and JavaScript API are not included in the XPI. The Node.js standard library supplies packaging and tests.

esbuild 仅为开发依赖，其可执行文件和 JavaScript API 不进入 XPI。打包和测试另外使用 Node.js 标准库。

This repository does not assign a new license to the project source. Third-party licenses apply to their respective dependencies.

本仓库尚未为项目源码指定许可。第三方许可适用于各自的依赖。
