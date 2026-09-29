# `file://` 页面能不能被外部 CLI 实时驱动？

> **Status: 历史调研，结论仍有效。** 这份报告回答的是「能不能双击一个纯 HTML，让外面的进程把棋局
> 推进去」。答案是「能，但只有一条通道」。它直接决定了 [ADR-0003](../adr/0003-local-server-with-sse.md)
> 的取舍；ADR-0003 后来又被 [ADR-0004](../adr/0004-chess-as-dsh-plugin.md) 取代，但本文的通道结论
> 与版本无关，仍然成立。
>
> 原始实验脚本与逐轮输出没有随仓库保留（当时的 `_probe/` 目录已在整理时清掉）；下表是它们的结论。

环境：Windows，Node v24.14.0，Chromium **149.0.7827.3**（Playwright 自带的 `chromium-1224`）。
做法是真的跑：Playwright 打开页面 → 页面内执行 JS → Node 侧改写磁盘文件 → 再看页面读到了什么。

启动参数已逐字核验：**不含** `--allow-file-access-from-files`、`--disable-web-security`。

## 逐条结论

| # | 做法 | 默认 Chromium（`file://`） | 证据 |
|---|------|---------------------------|------|
| 1 | `fetch('./state.json')` | **不可行** | headless：`TypeError: Failed to fetch`；console：`Fetch API cannot load file:///.../state.json. URL scheme "file" is not supported.`；headed：`Access to fetch at 'file:///...' from origin 'null' has been blocked by CORS policy: Cross origin requests are only supported for protocol schemes: chrome, chrome-extension, chrome-untrusted, data, http, https, isolated-app.`。`mode:'no-cors'` 与 `cache:'no-store'` 同样 `Failed to fetch` |
| 2 | `XMLHttpRequest` | **不可行** | `xhr.onerror (readyState=4, status=0)`，body `null`；console 报同一条 CORS |
| 3 | `<script src="state.js">` 动态插入（classic script） | **可行** | `loadFired: true, errorFired: false`，页面读到的值与磁盘一致。换 `state.js?t=...` 重写后读到新值；**不带 query 的同一 URL 再插入也读到最新值**，即 `file://` 下 classic script 每次重新读盘、没有缓存陈旧问题 |
| 4 | `<script type="module" src="state.mjs">` | **不可行** | `errorFired: true`；`Access to script at 'file:///...' from origin 'null' has been blocked by CORS policy`（module 走 CORS 取回） |
| 4a | `<img src>` | **能加载，但读不到字节** | 真 PNG：`loaded: true, naturalWidth: 1`；但 `canvas.getImageData` → `SecurityError: The canvas has been tainted by cross-origin data.` |
| 4b | `<link rel=stylesheet>` + `sheet.cssRules` | **cssRules 不可读** | `SecurityError: Failed to read the 'cssRules' property from 'CSSStyleSheet'` |
| 4c | `<link rel=stylesheet>` + `getComputedStyle` | **需条件：可行，可读任意字符串** | 样式表确实被加载并生效。改写 CSS 后 `getComputedStyle(el,'::before').content` 依次读到 `"TOKEN-AAA"` / `"TOKEN-BBB"`，同 URL 重载读到 `"TOKEN-CCC"`。条件：CLI 必须把数据写成 CSS 形态——真实字节通道，但格式/带宽受限 |
| 4d | `<iframe src="secret.html">` | **不可行** | iframe 加载成功，但 `contentDocument` 为 `null`：`TypeError: Cannot read properties of null (reading 'body')` |
| — | 对照：`http://127.0.0.1:PORT` 下 `fetch('./state.json')` | **可行** | `ok:true, status:200, type:"basic"`；XHR 同样 200；`iframe.contentDocument.body.innerText` 可读、`sheet.cssRules` 可读。证明实验环境本身无问题 |
| — | 加了 `--allow-file-access-from-files` | 部分解锁 | `fetch` **仍然失败**（`URL scheme "file" is not supported`，与开关无关）；XHR `ok:true`、module script 加载成功、`sheet.cssRules` 可读、`iframe` DOM 可读 |

## 端到端实测：CLI 实时驱动页面（默认 Chromium，无开关，页面全程不刷新）

Node 进程每 700ms 重写 `state.js`，页面每 350ms 重新插入同一 URL 的 `<script src="./state.js">`，
页面读到的序列与写入序列一一对应，无丢帧、无陈旧值。headed 模式（最接近双击）结果相同。

## 一句话总回答

**不需要 http 服务**——默认 Chromium 双击打开的 `file://` 页面可以被外部 CLI 实时驱动，但
**唯一可用的通道是动态插入 `<script src="...">`**（每次插入都重新读盘，无缓存问题）；
`fetch` / `XHR` / `module` / `iframe` 全部被 CORS（origin `null`）拦死。若必须读纯数据文件，
退路是让 CLI 把数据写成 CSS 再由页面读计算样式（可读字符串，格式受限）。

## 为什么最后没走这条路

下行只有 `<script src>` 一条路，意味着「棋盘状态」得靠**让页面执行一段脚本**来交付；
上行（人在棋盘上点一下，要送到会话）在 `file://` 下**根本没有通道**，只能靠下载目录监听、
自定义协议或剪贴板中转——全都依赖浏览器策略与用户设置，脆且难查，而且仍然要额外起一个接收进程。
已经付出服务的代价，却没得到服务的可靠性。这条推理是 ADR-0003 否决 `file://` 变通的依据。
