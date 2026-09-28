# 网页与 CLI 之间用 file:// + 动态 `<script src>` 通信，不起本地服务

网页棋盘必须能被仓库外的 `xq` CLI 实时驱动（会话走一步，页面不刷新就看到）。默认浏览器把 `file://` 页面关在 origin `null` 里：`fetch`、`XMLHttpRequest`、`<script type="module">`、`<iframe>` 读 DOM 全部被 CORS 拦死，加 `--allow-file-access-from-files` 也救不了 `fetch`。唯一在默认设置下能用的通道是**动态插入 classic `<script src="./state/board-state.js">`**：每次重新读盘、无缓存陈旧问题，且用户双击打开就成立。`_probe/` 保留了实测脚本与原始输出。

## Considered Options

- **本地 http 服务**（`127.0.0.1` + `fetch`/SSE）：协议正常、天然双向，但用户必须放弃双击打开、改为访问一个 URL，且要管端口占用与常驻进程。否决。
- **CLI 写 CSS，页面读 `getComputedStyle`**：实测可行，但数据必须伪装成 CSS 形态，格式受限且极难调试。否决。
- **CLI 只改状态文件、页面手动刷新**：实现最省，但与「会话直接操控棋子」正面冲突。否决。

## Consequences

页面被限定为**只读显示端**：`file://` 页面没有任何写盘能力，所以人的着法不可能从页面回流给 CLI，只能经对话进入（见 ADR-0002）。这个限制是浏览器安全模型给的，不是设计选择，换 http 服务才能解除。
