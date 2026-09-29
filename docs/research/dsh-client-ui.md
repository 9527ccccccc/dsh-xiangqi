# DSH Web GUI 自定义侧边栏面板插件 — 技术侦察报告

> **这是一份侦察笔记，不是当前设计。** 结论全部对着 DSH `0.1.5-rc.2` 的安装只读翻出来，
> 带版本前提；文末 §7 已记下当时就发现的过期 API。DSH 迭代很快，请当线索而不是当契约。
>
> 本仓库当前采用的架构见 [`../adr/0004-chess-as-dsh-plugin.md`](../adr/0004-chess-as-dsh-plugin.md)。

> 侦察范围：本机已安装的 DSH 插件包（只读）。
> 侦察日期基准：本机 DSH 版本 `0.1.5-rc.2`。
> 全部结论均标注来源文件路径与行号；推测项集中列在文末对照表。
>
> **一句话结论**：本报告写作时，本机运行中的 GUI 是 `0.1.5-rc.2`。**profile 里现存的 `@local/dsh-hello-right-panel`「右侧栏 Hello World」范例已失效** —— 它注册的 `details` 槽位与调用的 `ctx.layout.openDetails()` 在 0.1.5-rc.2 中都不存在（见 §7 勘误）。本报告给出的骨架基于**实测存在**的槽位。

---

## 0. 环境事实（已确认）

| 事实 | 值 | 来源 |
|---|---|---|
| DSH 版本 | `0.1.5-rc.2` | `%USERPROFILE%\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\package.json` |
| Web profile 目录 | `%USERPROFILE%\.dsh\profiles\web\` | `profiles/web/cordis.yml` |
| profile 组成 | bundles = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`，`patchReload: "live"` | `profiles/web/package.json` |
| 正在运行的服务 | `dsh web`（PID 3088），监听 `127.0.0.1:3080` | `Win32_Process` 查询 |
| 运行中的 dsh 安装位置 | `%USERPROFILE%\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\` | 同上命令行 |
| profile 的 `node_modules/@deepseek-ai` | **244 个全部是 junction（符号链接），0 个实体目录** | `Get-ChildItem -Force` 属性检查 |
| 其中**断链**的 junction | 4 个：`dsh-client-runtime`、`dsh-host-apiproxy`、`dsh-tool-subagent-report`、`node-addon-landlock-run` | 逐个 `Test-Path` 验证 |

**重要推论（已确认）**：`profiles/node_modules/@deepseek-ai/*` 只是指向全局 dsh 安装的链接。因此"已安装的插件包"与"CLI 安装自带的包"是同一份内容，不存在版本漂移。

**盘外发现（已确认）**：`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-dockkit`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-shell` **在磁盘上不存在任何包目录**，但被大量包的 `.d.ts` 引用，并且在浏览器里以**静态模块表**形式存在（见 §4.3）。它们是 shell 内建的 platform modules，不是可安装的包。

---

## 1. 一个客户端 UI 插件包的最小文件结构

### 1.1 目录结构

照抄 `@local/dsh-hello-right-panel` 和 `@deepseek-ai/dsh-client-ui-sidebar-files` 的共同形状：

```
<你的插件包>/
├── package.json          # 必需
├── lib/
│   ├── index.js          # 服务端（Node）半边入口 —— 可空壳
│   └── client.js         # 浏览器半边入口 —— 真正的 UI 代码
└── lib/types/            # 可选，仅供类型检查（本机 0.1.5-rc.2 下无运行时用途）
```

**已确认**：`dsh-client-ui-sidebar-files` 与 `@local/dsh-hello-right-panel` 都是这个形状。DSh 只消费**已构建的** `lib/client.js`。

> 出处：`profiles/node_modules/@deepseek-ai/dsh-client-modules/README.zh.md` 第 45-46 行「构建要求」——
> 「宿主提供的是已构建的客户端 bundle，因此启动前 `pnpm run build` 必须已产出每个 `lib/client.js`；缺失 bundle 会以一条构建说明加包／路径列表的方式让激活大声失败。」

### 1.2 `package.json` 骨架（可直接抄）

取自 `@local/dsh-hello-right-panel/package.json`（最精简的活样本）：

```json
{
  "name": "@local/dsh-my-chess-panel",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"]
    }
  }
}
```

**字段逐一解释**（来源：`profiles/node_modules/@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts` 第 38-52 行 `DshClientManifest`）：

| 字段 | 必要性 | 含义（原始 JSDoc） |
|---|---|---|
| `exports["./client"]` | **必需** | 「导出 `./client` bundle」。浏览器按 `<包名>/client` 或裸包名解析到同一份导出（`stripClientSuffix`） |
| `exports["."]` | 必需（主入口） | Node 半边。可以是空壳 |
| `dsh.client.platform` | **必需** | 「Client platform identifier; the Web consumer selects `web`」 |
| `dsh.client.inject` | 可选 | 「**Informational package-name dependencies, not Cordis service injection**」—— 仅用于**加载顺序**，不是依赖校验 |
| `dsh.client.immediately` | 可选 | 「Boot phase-one registration barrier; absent means the shared application batch」 |
| `dsh.client.external` | 可选 | 「Exact module-table requests beyond the implicit client baseline」—— 见 §4.3，**只需要为不在 platform 表里的模块写** |

> **实测澄清（已确认）**：`dsh.client.inject` 不是依赖校验。`dsh-client-modules/lib/client.js` 第 265-268 行：
> ```js
> for (const packageName of row.inject) {
>     const dependency = this.graphRows.get(packageName);
>     if (dependency !== void 0) await this.arriveGraphRow(dependency, [], visited);
> }
> ```
> 目标不在启动图里就**静默跳过**。这就是为什么 `@local/dsh-hello-right-panel` 声明了断链的 `@deepseek-ai/dsh-client-runtime` 却不会报错。

### 1.3 服务端半边（`lib/index.js`）

来自 `@local/dsh-hello-right-panel/lib/index.js` 全文（5 行）：

```js
export const name = 'hello-right-panel'

export function apply() {
  console.log('[hello-right-panel] node half loaded')
}
```

**已确认**：一个纯 UI 插件的 Node 半边可以是空壳。`dsh-client-ui-sidebar-right/lib/index.js` 也是同样形态（`lib/types/index.d.ts` 注释：「Pure host half; the whole Sidebar lives in the browser export.」）。

### 1.4 浏览器半边（`lib/client.js`）的**文件级包装**

DSh 用**惰性 CJS**：执行 bundle 只是注册 factory，模块副作用在物化时才跑。

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-my-chess-panel',        // 必须等于 package.json 的 name
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')          // 从静态模块表解析
    const jsx = require('react/jsx-runtime').jsx

    module.exports.inject = ['slots']       // Cordis 服务注入（与 dsh.client.inject 不同！）
    module.exports.apply = apply
    return module.exports
  },
})
```

**已确认来源**：`@local/dsh-hello-right-panel/lib/client.js` 第 1-3、71-74 行；`@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js` 第 1-9、714-716 行。

**必须导出的东西（已确认）**：

| 导出 | 必需 | 说明 |
|---|---|---|
| `apply(ctx)` | **是** | 插件体。同步函数 |
| `inject` | 否（但几乎总是要） | **Cordis 服务名数组**，字符串字面量。与 `dsh.client.inject` **完全不同**，后者是包名 |

**易混淆点（已确认，实测对比）**：

| | 内容 | 作用 |
|---|---|---|
| `package.json` 的 `dsh.client.inject` | **包名**，如 `"@deepseek-ai/dsh-client-ui-sidebar-right"` | 浏览器 bundle 的**到达顺序** |
| `lib/client.js` 导出的 `inject` | **Cordis 服务名**，如 `"slots"`、`"layout"` | 定义 `ctx.get(...)` 前必须就绪的**服务** |

---

## 2. 插槽（slot）系统全貌

### 2.1 注册 API 的真实签名

**权威实现**：静态模块 `@deepseek-ai/dsh-client-ui-slots` 的 `SlotCore.register`。
本机**没有**该包的磁盘文件，但完整源码内联在 web 前端产物里：
`%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\index-BKQ_L1z6.js`，偏移约 `203048`。

抠出的真实代码（压缩产物，我加了换行以便阅读）：

```js
register(t, r) {   // t = options, r = React 组件
  const i = this.records.get(t.name);
  if (!i?.spec)
    throw new Error(`slot "${t.name}" is not declared (a parent entry's children table must declare it)`);

  const s = i.spec;
  const a = t.priority ?? 0;
  const c = (m) => `at priority ${a}${m.registrant !== void 0 ? ` (registered by ${m.registrant})` : ""}`
                 + ` — register at a different priority to shadow it (lowest renders)`;

  switch (s.kind) {
    case "single": {
      const m = i.entries.find(g => (g.options.priority ?? 0) === a);
      if (m) throw new Error(`single slot "${t.name}" already has a registration ${c(m)}`);
      break
    }
    case "keyed": {
      if (t.key === void 0) throw new Error(`keyed slot "${t.name}" requires options.key`);
      const m = i.entries.find(g => g.options.key === t.key && (g.options.priority ?? 0) === a);
      if (m) throw new Error(`keyed slot "${t.name}" already has an entry for key "${t.key}" ${c(m)}`);
      break
    }
    case "list": {
      if (t.id === void 0) throw new Error(`list slot "${t.name}" requires options.id`);
      const m = i.entries.find(g => g.options.id === t.id && (g.options.priority ?? 0) === a);
      if (m) throw new Error(`list slot "${t.name}" already has an entry with id "${t.id}" ${c(m)}`);
      break
    }
    case "chain":
      if (t.select === void 0) throw new Error(`chain slot "${t.name}" requires options.select`);
      break
  }

  // children 声明：只能声明尚未被声明的槽位
  if (t.children) for (const m of Object.keys(t.children)) {
    const g = this.records.get(m);
    if (g?.spec) throw new Error(`slot "${m}" is already declared (by ${g.declaredBy ?? "an unknown entry"})`);
  }

  // store handle：一个 handle 只能挂在一个 scope 下
  if (t.store !== void 0 && typeof t.store != "function") { /* ... scope 冲突检查 ... */ }

  const h = {
    component: r,
    options: {
      ...t.key !== void 0 ? { key: t.key } : {},
      ...t.id !== void 0 ? { id: t.id } : {},
      ...t.order !== void 0 ? { order: t.order } : {},
      ...t.label !== void 0 ? { label: t.label } : {},
      ...t.priority !== void 0 ? { priority: t.priority } : {},
    },
    ...t.select !== void 0 ? { select: t.select } : {},
    ...t.inject !== void 0 ? { inject: t.inject } : {},
    ...t.children !== void 0 ? { children: t.children } : {},
    ...t.store !== void 0 ? { store: t.store } : {},
    ...t.locale !== void 0 ? { locale: t.locale } : {},
    ...t.registrant !== void 0 ? { registrant: t.registrant } : {},
  };

  // 排序：list 用 (priority, order)，其余只用 priority
  const p = [...i.entries, h];
  p.sort(s.kind === "list"
    ? (m, g) => (m.options.priority ?? 0) - (g.options.priority ?? 0)
             || (m.options.order ?? 0) - (g.options.order ?? 0)
    : (m, g) => (m.options.priority ?? 0) - (g.options.priority ?? 0));
  i.entries = p;
  this.markDirty(t.name, i);
  /* ... children 声明与通知 ... */

  return () => {   // 幂等 disposer
    i.entries.includes(h) && (i.entries = i.entries.filter(m => m !== h), this.markDirty(t.name, i), this.releaseEntry(h))
  }
}
```

`entriesOfSlot`（决定谁真正渲染）——同文件偏移约 `203048` 之后：

```js
entriesOfSlot(t) {
  const r = this.records.get(t);
  if (!r?.spec) return no;
  const i = r.spec.kind;
  if (i === "chain") return r.entries;         // chain 全量返回
  const s = [], a = new Set;
  for (const c of r.entries) {
    if (this.abdicated.has(c)) continue;        // 崩溃退位的条目跳过
    const h = i === "keyed" ? c.options.key
            : i === "list"  ? c.options.id
            : void 0;
    a.has(h) || (a.add(h), s.push(c));          // 每个 cell 只取第一个（= 最低 priority）
  }
  return s
}
```

### 2.2 注册选项（options）完整清单

| 选项 | 类型 | 必需条件 | 语义 |
|---|---|---|---|
| `name` | `string` | **总是** | 目标槽位名（`SlotMap` 的 key） |
| `key` | `string` | `kind:'keyed'` **必需** | cell 标识；同 key 同 priority 重复注册会 throw |
| `id` | `string` | `kind:'list'` **必需** | 条目标识；同 id 同 priority 重复注册会 throw |
| `select` | 函数 | `kind:'chain'` **必需** | 选择器 |
| `priority` | `number`，默认 `0` | 否 | **数字最低者渲染**（"lowest renders"）。同 cell 同 priority 会 throw |
| `order` | `number` | 否 | **仅 `list` 参与排序** |
| `label` | `string \| () => string` | 否 | 侧边栏用它当面板行标题（经 `resolveSlotLabel`） |
| `inject` | `(sessionId, actions) => props` | 否 | 注册时注入的私有 props 工厂 |
| `children` | `Record<name, {kind, scope}>` | 否 | **声明子槽位**（声明 = 排他渲染权） |
| `store` | store handle | 否 | 挂载一个 store；一个 handle 只能属于一个 scope |
| `locale` | `string` | 否 | 语言命名空间 |
| `registrant` | `string` | 否 | 诊断用标识（出现在报错里） |

**已确认的 `inject` 实参形态**：
- 来自 `@local/dsh-build-plan-mode-v2/lib/client.js` 第 311 行：
  `inject: (sessionId) => ({ sessionId, selectMode: selectForSession(sessionId) })`
- 来自 `@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js` 第 80-81 行：
  `function filesFace(list) { return (sessionId, actions) => { ... } }`

### 2.3 返回值与 `inject()` 等待语义

`register()` 返回**幂等 disposer**。但**标准用法不直接用返回值**，而是包在 `ctx.slots.inject(key, callback)` 里：

```js
inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
```

**权威 JSDoc**（`@deepseek-ai/dsh-client-ui-renderer/lib/types/client/registry.d.ts` 第 85-99 行）：

> Install an effect for each declaration lifetime of a slot. The callback runs synchronously when the declaration already exists; otherwise it runs inside the declaring `register()` call after the declaration is committed. Collapse disposes the effect and a later declaration runs it again. Callback effects are synchronous disposers; iterable effects install transactionally and dispose in reverse order. The controller belongs to the caller's fiber, so plugin unload cancels a pending wait and removes any active contribution.

**这条至关重要**：`inject` 是"等槽位被声明好了再注册"的唯一正确姿势。因为 `register` 对未声明槽位**会 throw**。

`SlotRegistry` 的其余公开面（同文件）：

| 方法 | 签名 |
|---|---|
| `register` | `SlotCore['register']`（原型方法，绑定调用方 ctx，用于 fiber 卸载级联） |
| `inject` | `(key, callback) => () => void` |
| `entries` | `(key) => readonly StoredEntry[]` |
| `entriesOfSlot` | `(key) => readonly StoredEntry[]`（按 cell 取 winner） |
| `subscribe` | `(key, fn) => () => void`（微任务批处理） |
| `getVersion` | `(key) => number` |
| `spec` | `(key) => SlotSpec \| undefined` |
| `snapshot` | `(root?) => LiveSlotNode[]` |
| `onEntryError` | `(fn) => () => void` |
| `provideRoot` | `(contribution) => () => void` |
| `install` / `installLocale` / `installScope` | 框架内部用，插件不要碰 |
| `renderSlot` | `(key, owner) => ReactNode`（**只有 'root' 允许从 ctx 级调用**，其余在组件 props 里） |

### 2.4 已定义的槽位全表（从已安装包的 `declare module ... SlotMap` 与 bundle 注册点汇总）

#### 布局根（`dsh-client-ui-layout`）

| 槽位 | kind | scope | 说明 |
|---|---|---|---|
| `root` | single | root | 渲染树根洞。**警告：不要在 'root' 注册**（`registry.d.ts` 第 18-31 行明确 DO NOT） |
| `sidebar` | single | root | **整个左栏**。被 ui-sidebar 的 SidebarRoot 占据；在这里注册 = 整体替换导航栏 |
| `main` | keyed | root | 中央面板，按 id 选。`conversation` 是保留 key |
| `rightbar` | single | root | **整个右栏**。被 ui-sidebar-right 占据 |
| `shell.overlay` | list | root | 全框架浮层，**加法式**，click-through。官方推荐的自建浮层落点 |

出处：`dsh-client-ui-layout/lib/types/client/index.d.ts` 第 28-84 行 + `lib/client.js` 第 524-546 行（真实 register 调用）。

#### 左栏座位（`dsh-client-ui-sidebar`）

| 槽位 | kind | scope | 说明 |
|---|---|---|---|
| `sidebar.brand.mark` | single | root | 品牌图标 |
| `sidebar.brand.name` | single | root | 品牌名 |
| **`sidebar.panellist`** | **list** | **root** | **全局面板图标行**。`options.id` 对应 `main` 的 key |
| `sidebar.workspaces` | single | root | 工作区/会话浏览区 |
| `sidebar.settings` | single | root | 设置座位 |
| `sidebar.footer.action` | list | root | 设置旁的可选动作（cordis 面板就用这个） |

出处：`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts` 第 14-74 行。

#### 右栏座位（`dsh-client-ui-sidebar-right`）

| 槽位 | kind | scope | 说明 |
|---|---|---|---|
| `rightbar.session` | single | session | 会话绑定的右栏内容 |
| **`sidebar.right.pane.tab`** | **keyed** | **session** | **一个 tab 的正文**。tab 类型按自己的 `id` 注册 |
| `sidebar.right.pane.tab.title` | keyed | session | tab 的标题（可选） |
| `sidebar.right.tab.guide` | chain | session | 替换引导页正文 |
| `sidebar.right.tab.menu.item` | list | session | tab 菜单追加项 |

出处：`dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts` 第 12-71 行。

#### 会话区（部分，`dsh-client-ui-conversation`）

`conversation.session`、`conversation.view`、`conversation.composer`、`conversation.input.*`、`conversation.chat.node`(keyed)、`conversation.session.header.actions`(list)、`conversation.session.header.corner`、`conversation.composer.dock`(list) 等。全部可在 `dsh-client-ui-conversation/lib/client.js` 的 8 处 `slots.register` 里读到。

#### 设置区

`settings.section`(list)、`settings.general.item`(list)、`settings.plugins.tab`(list)、`settings.plugin.item`(keyed)、`settings.onboarding`(list)、`settings.trigger`/`settings.header`/`settings.close`(single)、`settings.action`(list)。

#### 工具卡片

`tool.call.toolview`（keyed，key = 工具名，如 `bash`/`edit`/`cordis_run`）；`cordis` 包另外声明 `tool.view.cordis`（keyed，session）。

### 2.5 「侧边栏 / 右侧面板」分别对应哪个槽位 —— 划重点

| 你想做的 | 注册到 | 类型 | 备注 |
|---|---|---|---|
| **右栏加一个面板**（最贴近"侧边栏面板"） | ① `ctx.sidebarRightTabs.register({...})` 声明类型<br>② `sidebar.right.pane.tab`（keyed，key = 类型的 `id`） | 两阶段 | **推荐**。见 §4 真实范例 |
| 右栏整体替换 | `rightbar`（single） | 单占 | 会顶掉整个右栏，风险高 |
| 左栏加一个"全局面板" | ① `sidebar.panellist`（list，`id` + `order` + `label`）<br>② `main`（keyed，key = 同一个 `id`） | **两件套，两个都要注册** | 图标在左栏，内容在中央列 |
| 左栏底部加个按钮 | `sidebar.footer.action`（list） | 加法 | 最简单，cordis 面板就这么做的 |
| 全局浮层 | `shell.overlay`（list） | 加法，click-through | 官方推荐的自建浮层落点 |
| 设置里加一页 | `settings.section`(list) + `settings.general.item`(list) | 加法 | 语义上不算侧边栏 |

**`sidebar.panellist` 需要两件套 —— 实测证据**（`dsh-client-ui-sidebar/lib/client.js`）：

```js
// 第 344-360 行：侧边栏从 panellist 读取行元数据
const panels = createSnapshotStore([]);
const syncPanels = () => {
  const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => {
    const id = options.id;
    return { id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id }
  }).sort((a, b) => a.order - b.order);
  /* ... */
};
```

```js
// 第 106-126 行：点击行 -> selectPanel(id)，图标从 panellist 渲染
function PanelRow({ id, label, wide, usePanelInfo, selectPanel, renderSlot }) {
  const active = usePanelInfo((info) => info.activePanelId === id);
  /* ... onClick: () => { selectPanel(id); } ... */
  children: renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })
}
```

而 `ctx.layout.selectPanel(id)` 的定义（`dsh-client-ui-layout/lib/types/client/service.d.ts` 第 25-30 行）：

> Select a global central panel without changing the current Session.
> @param panelId - **registered `main` key**, or null to show the Conversation.
> **@throws if the selected `main` key is not registered**; preserves the current selection.

**所以：只注册 `sidebar.panellist` 而不注册 `main`，点击图标会 throw。两个都必须注册。**

---

## 3. 插件能拿到什么运行时能力

### 3.1 宿主 RPC（`ctx.remote`）—— "能不能发 HTTP 请求"

**精确答案（已确认）**：插件**没有通用的任意 HTTP 请求能力**。它有的是**类型化的 host RPC 命名空间**。

`ctx.remote` 的类型是 `ClientRemote`（`dsh-api-gateway/lib/types/client/index.d.ts` 第 17-31 行）：

```ts
export interface ClientRemote extends TypertClientRemote {
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>;
  readonly $host: RemoteHostFacts;   // { home: string | undefined; isLoopback: boolean }
}
```

`TypertClientRemote` 的实际成员（`dsh-typert-protocol/lib/types/types.d.ts` 第 230-247 行）：

```ts
export interface TypertClientRemote extends TypertRemoteNamespaceMap {
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>;
  $on<Event extends TypertRemoteEvent>(event: Event, listener: TypertClientEventListener<Event>): () => void;
}
```

| 能力 | 成员 | 说明 |
|---|---|---|
| 调用宿主方法 | `ctx.remote.<namespace>.<method>(...)` | 位置在**宿主**执行。既有命名空间实例：`ctx.remote.workspaceFiles.list(sessionId, path, signal)`、`ctx.remote.commands.execute(sessionId, line, [])` |
| 订阅宿主事件 | `ctx.remote.$on(event, listener)` | 返回 disposer |
| 宿主事实 | `ctx.remote.$host.home` / `.isLoopback` | 只读 |
| 逻辑流 | `ctx.remote.$stream({...})` | 可取消/重连 |
| **任意 HTTP** | **无** | 我在已安装包的类型定义里**没有找到**通用 fetch/HTTP RPC 成员 |

**可订阅的宿主事件白名单**（唯一真源：`dsh-api-remotes/lib/types/remote-events.js` 第 12-32 行，全部 19 条）：

```
agent-preset/selected (emit)        approval/request (waterfall)
api-session/activity (emit)         api-session/added (emit)
api-session/error (emit)            api-session/removed (emit)
api-session/status (emit)           commands/change (emit)
credentials/reference-updated (emit) goal/activation-changed (emit)
cordis/request-run (emit)           cordis/request-run-resolved (emit)
cordis/dynamic-package (emit)       cordis/dynamic-retract (emit)
cordis/inspect-query (emit)         cordis/inspect-query-resolved (emit)
llm/adapters-updated (emit)         settings/document-updated (emit)
user-questions/request (waterfall)
```

**只有这 19 个能通过 `ctx.remote.$on` 订阅。** 插件之间没有直接的事件总线机制（除了标准 Cordis `ctx.on` / `ctx.emit`，那是进程内的）。

### 3.2 本地发布/订阅

- `ctx.slots.subscribe(key, fn)` — 订阅某个槽位的注册变化（微任务批处理）。
- `ctx.slots.onEntryError(fn)` — 观察条目渲染崩溃。
- 标准 Cordis：`ctx.on(...)`、`ctx.emit(...)`、`ctx.effect(fn, label)`、`ctx.get(name)`、`ctx.reflect.provide(...)`。
- 官方定义的可用事件之一：`slots/changed(key: string)`（`dsh-client-ui-renderer/lib/types/client/index.d.ts` 第 15-23 行）。

### 3.3 会话状态 / 当前会话 id

**拿得到，但方式取决于槽位作用域**（已确认，来自 `dsh-client-ui-session/lib/types/client/index.d.ts` 第 34-56 行）：

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {          // root 作用域槽位自动获得
    useSessions: UseSessions;              // 会话列表 + 当前选中
    useSessionPendingInteraction: UseSessionPendingInteraction;
  }
  interface SessionStandardProps {         // session 作用域槽位自动获得
    useSession: SessionSnapshotSelector;   // 当前会话生命周期/控制状态
    sessionId: SessionId;                  // ← 当前会话 id
    useProjection: UseProjection;          // 宿主计算的投影值
  }
  interface SessionMaybeStandardProps {    // session-maybe 作用域
    useSession: MaybeSnapshotSelectorHook<SessionSnapshot>;
    sessionId: SessionId | undefined;
    useProjection: UseProjection;
  }
}
```

| 槽位 scope | 你自动拿到 | 会话 id |
|---|---|---|
| `root` | `useSessions`、全局标准 props | 无（要从 `useSessions` 自己挑） |
| `session` | `sessionId`、`useSession`、`useProjection` | **有，直接注入** |
| `session-maybe` | `sessionId: SessionId \| undefined` | 可能有 |
| 通过 `inject` | `inject: (sessionId, actions) => props` | **有，作为第一个实参** |

**写会话状态的唯一途径**：`ctx.remote` 的 RPC（例如 `ctx.remote.commands.execute(sessionId, '/plan off', [])`，见 `dsh-client-ui-plan` 与 `@local/dsh-build-plan-mode-v2`）。插件**没有**对会话状态的直接可写引用。

---

## 4. 可照抄的最小范例

### 4.1 什么不能抄 —— `@local/dsh-hello-right-panel`（**已失效**）

`profiles/web/node_modules/@local/dsh-hello-right-panel/lib/client.js` 第 41、53、66-67 行：

```js
react.useEffect(() => { ctx.layout.openDetails() }, [])
// ...
onClick: () => ctx.layout.closeDetails(),
// ...
ctx.slots.inject('details', () =>
  ctx.slots.register({ name: 'details', priority: -1 }, HelloRightPanel),
)
```

**这三个符号在 0.1.5-rc.2 全部不存在**（详见 §7）。**不要抄这个包。**

### 4.2 什么可以抄 —— `@deepseek-ai/dsh-client-ui-sidebar-files`（**在跑的官方包**）

这是**完整、真实、在跑的**右栏 tab 插件。骨架抽出来：

#### (a) 类型定义（第一阶段）

`lib/client.js` 第 12-42 行：

```js
/** The tab kind this package owns. */
const FILES_KIND = "files";
/** This implementation's identity in the tab system, and the key its body registers under. */
const FILES_ID = "@deepseek-ai/dsh-client-ui-sidebar-files";

function filesDefinition(t) {
  return {
    id: FILES_ID,
    kind: FILES_KIND,
    priority: "builtin",
    title: () => t("type.label"),
    guide: [{
      order: 10,
      title: () => t("guide.title"),
      description: () => t("guide.description"),
      icon: FolderSheetGlyph
    }]
  };
}
```

#### (b) 插件体（第 674-712 行）—— **这就是那个可以照抄的 15 行**

```js
/** This package's copy namespace. */
const NS = "sidebarFiles";
/** Required browser services: the tab registry, the keyed seat, the Remote carrier and its namespace, and copy. */
const inject = [
  "slots",
  "locale",
  "sidebarRightTabs",
  "remote",
  "remote.workspaceFiles"
];

function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), "ui-sidebar-files: files type");
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-sidebar-files: dictionaries");

  const store = createFilesStore();
  const inject = filesFace(createList(ctx.remote));

  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: FILES_ID,
    locale: NS,
    store,
    inject
  }, FilesBody)), "ui-sidebar-files: files tab body");

  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
    name: "sidebar.right.pane.tab.title",
    key: FILES_ID
  }, FilesTitle)), "ui-sidebar-files: files tab title");
}
```

#### (c) 正文组件拿到什么

`dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts` 第 95-134 行：

```ts
export interface SidebarRightTabInfo {
  readonly sidebar: { readonly expanded: boolean; readonly fullscreen: boolean; };
  readonly panel:  { readonly id: PaneId; };
  readonly tab: TabRecord & {
    readonly visible: boolean;                        // 停靠正文需展开+活跃
    readonly navigation: SidebarRightTabNavigation;   // { address, params, revision }
    readonly signal: AbortSignal;                     // 记录消失或插件卸载才 abort
    readonly actions: SidebarRightTabActions;         // openResource / openTab / close
  };
}
export type UseSidebarRightTabInfo = () => SidebarRightTabInfo;
```

通过框架注入的 `useTabInfo()` 读取。**注意（README.zh.md 第 78 行）**：「这些字段不再作为平铺 owner props 传入」。

#### (d) 打开这个 tab

`ctx.sidebarRight.openTab(kind, options?)` / `ctx.sidebarRight.openResource(address, options?)`。
官方在 `dsh-client-ui-sidebar-right/README.zh.md` 第 87-89 行有完整说明。

### 4.3 `@deepseek-ai/dsh-client-ui-cordis` —— 是不是好范例？

**不是理想范例，但有两处值得抄**（已确认）：

1. 它把面板注册到 **`sidebar.footer.action`**（`lib/client.js`，`{ name: "sidebar.footer.action", id: "cordis-panel", locale: NS, inject: ... }`）——这是**左栏加东西最省事的路径**。
2. 它有**唯一**一个自己声明的槽位 `tool.view.cordis`（`lib/types/client/slots.d.ts` 第 15-29 行），展示了"注册者同时声明子槽位"的写法：

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'tool.view.cordis': {
      kind: 'keyed';
      scope: 'session';
      owner: CordisToolViewOwnerProps;
    };
  }
}
```

它的数据获取方式（`lib/types/client/slots.d.ts` 第 47-61 行）是 `HostObservable<T>` + `ctx.remote` / `dynamicCordisRunner` 服务，加上 `ctx.remote.$on` 订阅 `cordis/*` 事件。这个模式**很值得抄**：把宿主数据包装成 `HostObservable`，通过 slot 的 `inject` 以 `{ hooks: {...} }` 传给组件。

---

## 5. 开发循环

### 5.1 `dsh plugin --profile web add <包>` 的语义（已确认）

**权威来源**：`%USERPROFILE%\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\plugin-Ddi42qoW.js`（全文 130 行）。

文档注释（第 7-17 行）：

> `dsh plugin --profile <name> <args...>` — profile plugin management as a **thin pnpm forwarder**: initialize the profile on first use, run `pnpm <args...>` in the profile directory, then **reconcile the `dsh.profile.bundles` layer list against the installed state** (a dependency resolving to a package that declares `dsh.bundle` joins the layer stack; a removed or bundle-less dependency leaves it).

`runPlugin` 的实际行为（第 101-128 行）：

```js
function runPlugin(profile, args) {
  const dir = resolveProfileDir(profile);
  if (!existsSync(join(dir, "package.json"))) { /* 首次使用则从模板初始化 */ }
  const before = readProfileManifest(NAME, dir);
  const result = spawnSync("pnpm", args.map(a => anchorPathSpec(a, process.cwd())), {
    cwd: dir, stdio: "inherit", shell: process.platform === "win32"
  });
  if (result.status === 0) reconcilePlugins(before, dir);
  /* ... */
}
```

**精确定义**：
- 它**就是 pnpm 转发器**。`add` 就是 `pnpm add`，在 `%USERPROFILE%\.dsh\profiles\web\` 里跑。
- 跑完后 `reconcilePlugins` 把 `%USERPROFILE%\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 与**实际安装状态**对账。
- **你的包只有声明了 `dsh.bundle.patch` 才会被自动加进 `dsh.profile.bundles`**。一个纯客户端 UI 插件**不需要** `dsh.bundle`（它不贡献任何 Cordis 插件行），所以它会被当成"普通依赖"，并打印一条 warning：
  > `dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer（a later update that gains one activates it automatically）`
- 相对路径规格会被锚定到**你的调用目录**（`anchorPathSpec`），避免 `add .` 在 profile 里自链接。

### 5.2 `cordis.patch.yml` 要写什么（已确认）

`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 是**顶层 YAML 数组**，每个元素是一条 loader patch：
- `insert:` — 插入新插件行 `{ id, name }`
- `id: <x>` + `disabled: true` — 禁用某行
- id 定向的 config 覆盖

现存的真实内容（该文件 28 行）：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
# ...
- insert:
    - id: build-plan-mode
      name: '@local/dsh-build-plan-mode-v2'

- id: ui-plan
  disabled: true

- insert:
    - id: hello-right-panel
      name: '@local/dsh-hello-right-panel'
```

**关键点**：`- insert` 的 `name` 是**包名**（Node 半边入口）。你的客户端插件如果有 Node 半边（哪怕是空壳），这条就让它被 loader 加载，然后 loader 才会去启动它的浏览器半边。

profile 根 `cordis.yml` **是空的 `[]`**，其注释明确写：

> dsh profile root — an empty entry list. The tree is composed as patches: each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays. **Edit cordis.patch.yml, not this file.**

层叠顺序（`dsh/README.md` 第 40-42 行）：bundle 各自的 patch（按 `dsh.profile.bundles` 顺序）→ profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖。

### 5.3 热更新怎么触发（已确认）

**答：`dsh-client-hmr` 用 `stat` 轮询每个 bundle 的 `lib/client.js`。任何进程改写那个文件就会触发重建帧。**

`dsh-client-hmr/README.zh.md` 关键段落：

- 第 12 行：「如果没有重建 watcher，整条链路保持空闲：**只有 `pnpm run dev:web` 之类的进程重写客户端 bundle 时才会产生它所响应的重建**。」
- 第 32 行：「对同一个宿主运行 `pnpm run dev:web`（或**任何写入插件 `lib/client.js` 的 tsdown watch 进程**）；重建后的插件随后会被自动逐个替换进运行中的浏览器。」
- 第 42 行：「`pollIntervalMs` 默认 `500` — bundle stat 轮询间隔，单位为毫秒」
- 第 62 行：「node 半侧运行一个 interval，从 module host 读取文件前的基线开始 **stat 轮询每个图 bundle**。」
- 第 48 行：「被重载插件内的 React 状态会丢失，而会话、工作区与连接状态会保留。」

**这条系统提示的确切机制**：HMR 不"构建"任何东西——它只是 `stat()` 文件。所以：

> **对 `@local/*` 这类手写 `lib/client.js` 的插件（没有 tsdown），你只要直接覆写 `lib/client.js`，HMR 就会在 ≤500ms 后自动重载进浏览器，无需刷新页面。**

这也解释了为什么 `@local/dsh-hello-right-panel` 和 `@local/dsh-build-plan-mode-v2` 的 `package.json` 里都**没有** `build` 脚本却能工作——它们是手写的产物。

`patchReload: "live"`（`profiles/web/package.json`）则管 **`cordis.patch.yml` 本身的改动**：live = profile 活跃时热应用。headless profile 是 `startup`。

**已知限制**（HMR README 第 116-118 行）：
- 重载是粗粒度的：全新 fiber + 全新组件，React 状态丢失。**react-refresh 级状态保留被有意排除。**
- 失败不回滚：失败的 entry 保持 FAILED。
- 重建帧不替换启动图；只有页面重载才接收重新组合的启动图。

### 5.4 推荐的动手流程（综合上述已确认事实）

```
1. 在 <某处> 建插件包：package.json + lib/index.js(空壳) + lib/client.js(手写)
2. dsh plugin --profile web add <绝对路径>        # = pnpm add，会装进 profile
3. 编辑 profiles/web/cordis.patch.yml，加：
     - insert:
         - id: my-chess-panel
           name: '@local/dsh-my-chess-panel'
4. 改 lib/client.js 保存 → HMR（≤500ms）自动重载进浏览器，免刷新
   （前提：dsh-client-hmr 在跑，它随 web 组合激活；不需要 pnpm run dev:web
     因为你是手写 client.js，不是 tsdown 产物）
5. 改了 cordis.patch.yml → patchReload: "live" 热应用
```

---

## 6. 「已确认 / 属于推测」对照表

### 6.1 已确认（有一手材料，附出处）

| # | 结论 | 出处 |
|---|---|---|
| 1 | 本机 DSH = 0.1.5-rc.2，profile=web，bundles=[dsh-base, dsh-web-app]，patchReload=live | `profiles/web/package.json`；`dsh/package.json` |
| 2 | 运行中的是 `dsh web`（PID 3088，127.0.0.1:3080） | `Win32_Process` 命令行 |
| 3 | profile 的 `node_modules/@deepseek-ai` 244 个全是 junction 指向全局安装，4 个断链 | 属性扫描 + 逐个 `Test-Path` |
| 4 | 最小包 = package.json + lib/index.js + lib/client.js | `@local/dsh-hello-right-panel`、`dsh-client-ui-sidebar-files` |
| 5 | `dsh.client` 字段集与语义（platform/inject/immediately/external） | `dsh-package-manifest/lib/types/types.d.ts` 第 38-52 行 |
| 6 | `dsh.client.inject` 是包名、仅加载排序、缺失静默跳过 | `dsh-client-modules/lib/client.js` 第 265-268 行 |
| 7 | 浏览器半边必须 `window.__ModuleLoader__.load({id, factory})` + 导出 `apply`/`inject` | `dsh-client-ui-sidebar-files/lib/client.js` 第 1-9、714-716 行 |
| 8 | `SlotCore.register(options, Component)` 的完整选项集与校验规则 | web 前端 `index-BKQ_L1z6.js` 偏移 ~203048 |
| 9 | 4 种 kind（single/keyed/list/chain）各自的必需选项与重复注册 throw 规则 | 同上 |
| 10 | **priority 数字最低者渲染**（"lowest renders"） | 同上，报错文案 |
| 11 | `order` 仅 list 参与排序 | 同上，sort 分支 |
| 12 | 未声明槽位注册会 throw（"is not declared"） | 同上，register 首行校验 |
| 13 | `children` 只能声明尚未声明的槽位，重复声明 throw | 同上 |
| 14 | `ctx.slots.inject(key, cb)` 的等待/ dispose 语义 | `dsh-client-ui-renderer/lib/types/client/registry.d.ts` 第 85-99 行 |
| 15 | 布局只声明 4 个子槽位：`sidebar`/`main`/`rightbar`/`shell.overlay` | `dsh-client-ui-layout/lib/client.js` 第 524-546 行 + `index.d.ts` 第 28-84 行 |
| 16 | `sidebar.panellist` 是 list，`id` 对应 `main` 的 key；点击走 `ctx.layout.selectPanel(id)` | `dsh-client-ui-sidebar/lib/client.js` 第 106-126、344-362 行 |
| 17 | `selectPanel` 对未注册的 main key 会 throw | `dsh-client-ui-layout/lib/types/client/service.d.ts` 第 25-30 行 |
| 18 | 右栏 tab 两阶段注册（`sidebarRightTabs.register` + `sidebar.right.pane.tab`） | `dsh-client-ui-sidebar-files/lib/client.js` 第 674-712 行；`sidebar-right/README.zh.md` 第 77-78 行 |
| 19 | `SidebarRightTabDefinition` 全字段 | `dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts` 第 68-109 行 |
| 20 | `SidebarRightTabInfo` 字段（sidebar/panel/tab.visible/navigation/signal/actions） | `sidebar-right/lib/types/client/contract/slots.d.ts` 第 117-139 行 |
| 21 | 静态模块表共 8 项，含 `@deepseek-ai/dsh-client-ui-slots` | web 前端 `index-BKQ_L1z6.js`，`function by()` 偏移 ~553121 |
| 22 | `ctx.remote` = 类型化 Host RPC；**没有**通用 HTTP | `dsh-api-gateway/lib/types/client/index.d.ts`；`dsh-typert-protocol/lib/types/types.d.ts` 第 230-247 行 |
| 23 | 宿主事件白名单 19 条（逐条列出） | `dsh-api-remotes/lib/types/remote-events.js` 第 12-32 行 |
| 24 | session 作用域槽位自动获得 `sessionId`；root 作用域获得 `useSessions` | `dsh-client-ui-session/lib/types/client/index.d.ts` 第 34-56 行 |
| 25 | `inject: (sessionId, actions) => props` 的实参形态 | `dsh-client-ui-sidebar-files/lib/client.js` 第 80-81 行；`@local/dsh-build-plan-mode-v2/lib/client.js` 第 311 行 |
| 26 | `dsh plugin` = pnpm 转发器 + bundles 对账；无 `dsh.bundle` 会 warning 且不入 bundles | `dsh/lib/plugin-Ddi42qoW.js` 第 7-17、101-128 行 |
| 27 | `cordis.patch.yml` 是顶层数组，用 `insert:`/`disabled:`；profile `cordis.yml` 是空 `[]` | `profiles/web/cordis.patch.yml`；`cordis.yml` |
| 28 | HMR = stat 轮询 `lib/client.js`，任何写入该文件的进程都会触发；`pollIntervalMs` 默认 500 | `dsh-client-hmr/README.zh.md` 第 12、32、42、62 行 |
| 29 | `@local/dsh-hello-right-panel` 用的 `details` 槽位 + `ctx.layout.openDetails()` 不存在 | 见 §7 |
| 30 | `@deepseek-ai/dsh-client-ui-cordis` 注册到 `sidebar.footer.action`，并自声明 `tool.view.cordis` | `dsh-client-ui-cordis/lib/client.js`；`lib/types/client/slots.d.ts` 第 15-29 行 |
| 31 | `locale.register`/`bind` 有"合并表之外的命名空间"非类型化重载 | `dsh-client-locale/lib/types/client/index.d.ts` 第 198、215 行 |

### 6.2 属于推测（**没有**一手材料直接支撑，请自行验证）

| # | 推测 | 依据 / 为何是推测 |
|---|---|---|
| P1 | 在 0.1.5-rc.2 下把 `hello-right-panel` 换成 `rightbar` 槽位 + `openRightbar(true,false)`，可以恢复"右栏 Hello World" | 槽位与 API 都确认存在，但**我没有实际运行验证过**。且 `rightbar` 已被 ui-sidebar-right 占据，注册会与它冲突（single + priority 0） |
| P2 | 插件若只在 `inject` 回调里注册，槽位声明失败时插件会**静默无产出**而非报 FAILED | 从 `assertEntriesActive` 只检查 fiber 状态推断；`inject` 是 pending 等待，不抛错。**未实测** |
| P3 | 手写 `lib/client.js` 直接覆写即可触发热更，无需 tsdown | HMR README 说"任何写入 `lib/client.js` 的进程"，但**没有明说手写文件也算**；不过 `@local/*` 包没有 build 脚本却是这个形状，间接支持 |
| P4 | 象棋面板的棋局状态可以在插件闭包内保存，`sidebar.right.pane.tab` 的 `store` 选项能提供跨渲染持久化 | `store` 选项确认存在（register 选项表），但 store handle 的**创建 API**（`createXxxStore`）属于 `@deepseek-ai/dsh-client-store`，**该包磁盘上不存在**，我无法读到其接口 |
| P5 | 插件之间可以用标准 Cordis `ctx.emit`/`ctx.on` 通信 | Cordis 是标准服务容器，但**我没有找到 DSH 客户端插件之间事件约定的文档** |
| P6 | `main` 槽位的 `MainPanelId` 是 branded string，注册 key 直接传字符串即可 | 类型上是 `Branded<'MainPanelId'>`，但运行时是字符串（`options.key` 直接比对）。**未实测 brand 的运行时形态** |
| P7 | 想让右栏 tab 默认打开，需要在插件 `apply` 里主动调 `ctx.sidebarRight.openTab(...)` | README 说明 openTab 是导航控制器；但**没有找到"插件启动时自动开 tab"的官方先例** |

---

## 7. 勘误：profile 里的 `hello-right-panel` 已失效（已确认）

这是本次侦察最重要的发现之一，因为它是一个**会误导人的现成范例**。

`profiles/web/cordis.patch.yml` 第 26-28 行确实插入了它：

```yaml
- insert:
    - id: hello-right-panel
      name: '@local/dsh-hello-right-panel'
```

但它的代码引用了三个不存在的符号：

| 代码（`@local/dsh-hello-right-panel/lib/client.js`） | 0.1.5-rc.2 实际 | 证据 |
|---|---|---|
| `ctx.slots.register({ name: 'details', ... })`（第 67 行） | `details` 槽位**不存在**。ui-layout 只声明 `sidebar`/`main`/`rightbar`/`shell.overlay` | `dsh-client-ui-layout/lib/client.js` 第 527-544 行；`lib/types/client/index.d.ts` 第 28-84 行 |
| `ctx.layout.openDetails()`（第 41 行） | `ILayout` **无此方法**。只有 `selectPanel`/`beginNavigation`/`toggleSidebar`/`openRightbar`/`closeRightbar` | `dsh-client-ui-layout/lib/types/client/service.d.ts` 第 24-48 行 |
| `ctx.layout.closeDetails()`（第 53 行） | 同上 | 同上 |

**交叉验证**：全局 dsh 安装目录下的 `dsh-client-ui-layout/lib/client.js` 里搜 `details` **零命中**；只搜到 `renderSlot("main")`、`renderSlot("sidebar")`、`renderSlot("shell.overlay")`、`renderSlot("rightbar")`。且 `hello-right-panel` 的 `dsh.client.inject` 指向的 `@deepseek-ai/dsh-client-runtime` 是个**断链的 junction**。

**推测的行为（P2）**：由于 `details` 永不声明，`ctx.slots.inject('details', ...)` 的回调**永不执行**，插件保持"active 但无产出"，不报错。所以 GUI 里"什么也没发生"是符合代码预期的结果（**此行为未实测**）。

---

## 8. 我没能回答的问题（明确列出，不编）

1. **`@deepseek-ai/dsh-client-store` 的 store handle 创建 API。** 该包磁盘上不存在（只有断链引用）。我读不到 `createXxxStore()` 的签名、`BoundActions`、`ObservableSnapshot`、`PropsStore` 的定义。只知道 `register` 接受 `store` 选项、`inject` 里可拿到 `actions`。
   → 影响：**象棋面板若需要可复用的跨渲染状态容器，我不能确定写法。**

2. **`@deepseek-ai/dsh-client-ui-slots` 的完整 `.d.ts`。** 同样不存在于磁盘。我只有 web 前端产物里的压缩实现。以下类型我**只见到引用，未见到定义**：`PropsRuntime`、`PropsRenderSlots`、`InjectFace`、`PropsLocale`、`HostObservable`、`SlotHookFactory`、`SlotSpec`、`StoredEntry`、`GlobalStandardProps`、`SessionStandardProps`、`SlotRenderer`、`SnapshotSelectorHook`、`SlotScopeAdapter`。
   → 影响：**组件 props 的精确 TS 类型我写不出来**；只能给 JS 骨架。

3. **`@deepseek-ai/dsh-client-ui-dockkit` 的 `PaneId`/`TabId`/`TabRecord` 定义。** 不存在于磁盘。

4. **没有找到任何"在 `rightbar`/`sidebar`/`main` 里直接注册一个独立面板"的官方先例。** 所有官方 side-panel 功能要么占 `rightbar` 整体（ui-sidebar-right），要么走 tab 类型两阶段。**在无 tab 的前提下"加一块右栏面板"是否被官方支持，我无法从一手材料确认。**

5. **没有找到给插件用的通用 HTTP / fetch 能力。** `ctx.remote` 是类型化 RPC。如果你需要象棋面板访问任意网络（比如在线棋谱），**我不知道官方支持的路径**。可能要走 `dsh-host-apiproxy`（该 junction 也是断链的）。

6. **没有验证过这个骨架真的能跑。** 我按指令"不修改 profile 里的任何文件、不安装任何东西"，因此**没有实机验证**任何注册代码。§6.2 的 P1/P2/P3/P4 都因此未实测。

7. **`external` 字段对我这个场景是否需要，我不确定。** 我只确认了 platform 表里有 react / react-dom / jsx-runtime / cordis / client-store / ui-slots / ui-primitives / ui-dockkit。如果象棋面板只用 react + `ctx.slots`，**推测**不需要写 `external`；但 `dsh.client.external` 对"基座之外的精确请求"的具体判定时机（构建期还是运行期）我没有完全读透。

8. **`ctx.sidebarRight` / `ctx.sidebarRightTabs` 的完整接口**只在 README 里看到文字描述；`sidebar-right/lib/types/client/service.d.ts`（14798 字节）我**没有通读**。`ISidebarRight` 的逐方法签名未逐一核对。

---

## 9. 给"象棋面板插件"的落地建议（基于以上已确认事实）

**推荐路径：右栏 tab 类型（两阶段注册）**，因为它是唯一有完整官方先例（`ui-sidebar-files`）、有官方文档（`sidebar-right/README.zh.md` 第 77-78 行称其为"公开路径"）、且不会破坏现有 UI 的方式。

```
dsh-chess-panel/
├── package.json          # name/@local/dsh-chess-panel，dsh.client.platform=web
├── lib/
│   ├── index.js          # export const name; export function apply() {}  (空壳)
│   └── client.js         # window.__ModuleLoader__.load({...})
```

`lib/client.js` 的注册骨架（形态照抄 `ui-sidebar-files` 第 674-712 行）：

```js
const CHESS_ID = '@local/dsh-chess-panel'
const CHESS_KIND = 'chess'

function chessDefinition() {
  return {
    id: CHESS_ID,
    kind: CHESS_KIND,
    // 不给 patterns => 这是"页类型"，按 kind 打开，不认地址
    title: () => '象棋',
    guide: [{ order: 20, title: () => '象棋对局', description: () => '开一局象棋' }],
  }
}

function apply(ctx) {
  ctx.effect(() => ctx.sidebarRightTabs.register(chessDefinition()),
             'chess: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CHESS_ID,          // key 必须等于 definition.id
    inject: () => ({ useTabInfo }),
  }, ChessBody)), 'chess: tab body')
}
```

要点：
- `key` **必须**等于 `definition.id`（`tab-registry.d.ts` 第 74 行：「it is the key its body and title register under」）。
- 不写 `patterns` → 页类型，只能用 `ctx.sidebarRight.openTab('chess')` 打开。
- 棋局状态放组件内 `useState` 即可（**但注意 HMR 重载会丢状态**，HMR README 第 116 行）。
- 需要"打开棋盘"的入口：在 `apply` 里读 `ctx.sidebarRight.openTab(...)`，或注册 `sidebar.footer.action` / `conversation.session.header.actions` 做一个按钮。

**替代路径（更简单但不那么"侧边栏"）**：`sidebar.footer.action`（list，加法）——只需一次注册，不会与任何东西冲突。cordis 面板用的就是这条。
