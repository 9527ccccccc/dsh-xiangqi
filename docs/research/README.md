# 调研与侦察笔记

这个目录放的是**过程材料**，不是当前设计。设计在 [`../adr/`](../adr/) 和
[`../../CONTEXT.md`](../../CONTEXT.md)。

| 文档 | 是什么 | 现在还有用吗 |
|------|--------|-------------|
| [`dsh-plugin-api.md`](dsh-plugin-api.md) | DSH 插件 API 侦察：一个插件包有哪些半边、能拿到哪些服务、`cordis.patch.yml` 怎么写 | 有用。这是本仓库唯一成体系的 DSH 插件 API 笔记，但写于 `0.1.5-rc.2`，以你本机安装为准 |
| [`dsh-client-ui.md`](dsh-client-ui.md) | DSH Web GUI 侧边栏面板侦察：槽位、tab 两阶段注册、浏览器半边能 `require` 什么 | 有用，同上。文末 §7 记了当时就发现的过期 API |
| [`file-protocol-live-control.md`](file-protocol-live-control.md) | 实测：`file://` 页面能不能被外部 CLI 实时驱动 | 结论与版本无关，仍然成立。是 ADR-0003 否决「纯 HTML 变通」的依据 |
| [`session-bridge-spec.md`](session-bridge-spec.md) | 早期规格：自建本地常驻服务 + `xq` CLI | **已被 ADR-0004 取代**。通道设计与失败模式分析仍可参考 |

## 读法

这几份文档的结论都带前提——版本号、路径、「本机当时是这样」。DSH 迭代很快，
**别把它们当契约**：要确认某个 API 还在不在，去翻你本机那份安装。
文档里保留「本机」这个说法是有意的，它提醒你每条结论的适用范围。
