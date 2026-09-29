# DSH 插件 API 侦察报告（象棋插件可行性）

> **这是一份侦察笔记，不是当前设计。** 写于 DSH `0.1.5-rc.2`，对着当时本机安装的包只读翻出来的，
> 每条结论都带版本与路径前提。DSH 迭代很快，请把它当线索而不是当契约——真要用某个 API，
> 以你自己那份安装为准。
>
> 本仓库当前采用的架构见 [`../adr/0004-chess-as-dsh-plugin.md`](../adr/0004-chess-as-dsh-plugin.md)。

- **侦察对象**：本机已安装的 DSH 0.1.5-rc.2 插件包
- **一手材料根目录**：`%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\`
  （该目录下的包都是 **junction**，真实目标是 `%USERPROFILE%\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`，所以顶层与嵌套两份副本内容相同）
- **只读**：本次未修改 profile 下任何文件，未安装任何东西
- **标注约定**：`【已确认】` = 从文件直接读到；`【推测】` = 我的推断，未经运行验证

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 工具注册 API | `ctx.tools.register(defineTool({name, description, parameters, output, execute}))`，`inject` 需声明 `'tools'`。**没有** `readOnly` 声明字段，只有 `isConcurrencySafe?()`（opt-in 并行）【已确认】 |
| 阻塞式工具 | `ctx.userQuestions.ask()` 走 Cordis waterfall，返回 Promise 挂起直到有人作答；**无超时**，只靠 `exec.signal` 取消【已确认】 |
| 象棋能否照搬 ask_user | **形状完全对，但词汇不匹配**。棋盘画不出来（seam 词汇只有「选项 + 自定义文本」）。有三条可行路线，见 §4 |
| 插件持有的进程内状态 | 可以，闭包/模块级即可；官方先例用 `WeakMap` 挂 `exec`【已确认】 |
| 插件挂 HTTP 路由 | **可以，且有三条官方通道**，其中 `ctx.connection.rpc.handle('/chan', handler)` + 客户端 `ctx.connection.rpc.call(...)` 是通用认证 RPC，最贴合象棋需要【已确认】 |
| 插件加自己的 WebSocket 消息类型 | **不能**。`ctx.remote.$on` 的合法键是 `dsh-api-remotes` 里一份硬编码白名单；连第一方 `cordis-host-runner` 都要先被写进白名单【已确认】 |
| 会话注入（唤醒运行中的会话） | **有官方机制**：`ctx.agents.get(sessionId).followup(createUserMessage({...}))`，官方先例是 `dsh-schedule`【已确认】 |
| `dsh plugin --profile web add` 做了什么 | 转发给 pnpm + **按「已安装状态」对账 `dsh.profile.bundles`**（只有声明了 `dsh.bundle.patch` 的包才会变成 profile layer）。它**不**写 `cordis.patch.yml`【已确认】 |

**给象棋插件的最短可行路径（我的推荐，属【推测】，见 §8）**：
Host 半注册一个 `xiangqi_wait_move` 工具（阻塞在进程内 deferred 上）+ 一个 `ctx.connection.rpc.handle('/xiangqi', …)` 通道；Client 半在右侧栏 seat 里画棋盘，落子后 RPC 回 Host，Host 解 deferred，工具返回，会话继续。全程不碰任何随包发布的文件。

---

## 1. 工具注册的确切 API

### 1.1 插件模块的形状

插件就是一个 ES 模块，导出 `name` / `inject` / `apply`：

`dsh-tool-ask-user/lib/index.js:11-14,116`
```js
const name = "tool-ask-user";
const inject = ["tools", "userQuestions"];
const description = "Ask the user a concise question ...";
function apply(ctx) { ... }
export { apply, inject, name };
```

也可以 `export default { name, apply }`（`@local/dsh-build-plan-mode-v2/lib/index.js:458` 就是这个形式）。
带配置的插件声明 `Config`（schemastery）并让 `apply(ctx, config)` 收第二个参数：

`dsh-tool-todo/lib/index.js:11-12,20,78-79,196`
```js
const name = "tool-todo";
const inject = ["tools", "sessionProjections"];
const Config = z.object({ allowParallelInProgress: z.boolean().required() });
function apply(ctx, config) {
  const allowParallel = config.allowParallelInProgress;
  ...
}
export { Config, apply, inject, name };
```
`@deepseek-ai/schemastery` 是配置 schema 库（`import z from "@deepseek-ai/schemastery"`）；`zod` 另有使用（投影 wire schema 用 `zod`）。

### 1.2 `defineTool` 的真实签名

`dsh-tools/lib/types/schema.d.ts:178-239`【已确认，逐字】
```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    /** Tool name (must be unique). */
    readonly name: string;
    /** Human-readable description sent to the model. */
    readonly description: string;
    /** Per-property parameter schema compiled to an implicit open object root. */
    readonly parameters: S;
    /** Canonical output schema plus pure Native and presentation projections. */
    readonly output: {
        readonly schema: O;
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    /** Optional positive cooperative timeout budget in milliseconds. */
    readonly timeoutMs?: number;
    isConcurrencySafe?(args: InferArgs<S>): boolean;
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    presentCall?(args: InferArgs<S>): ToolCallView | undefined;
    presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined;
}

export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
```

注册入口（`dsh-tools/lib/types/index.d.ts:601`）：
```ts
register(definition: ToolDefinition): () => void;   // 返回 disposer
```
README 明确：**注册即让模型可见，schema 自动进系统提示词**（`dsh-tools/README.zh.md:28`）。

### 1.3 参数 schema 用什么

**不是** schemastery，是 dsh-tools 自带的统一 schema DSL。`dsh-tools/README.zh.md:60`：
> 统一 schema DSL 支持 `string`、`number`、`integer`、`boolean`、`null`、`array`、`object`、仅供作者使用的 `json` 与恰好匹配一个分支的 `oneOf`；`InferValue` 在 16 层容器内保留精确类型，之后加宽为 `JsonValue`。

`parameters` 是「按属性名的隐式开放对象根」——每个属性写自己的 schema 节点，`required: true` 表示必填；嵌套对象用 `additionalProperties: false` 收紧。真实片段（`dsh-tool-todo/lib/index.js:98-119`）：
```js
parameters: { todos: {
    type: "array",
    required: true,
    description: "The COMPLETE task list, replacing any previous list.",
    items: {
        type: "object",
        additionalProperties: false,
        properties: {
            content: { type: "string", required: true, description: "..." },
            status:  { type: "string", required: true, enum: [...STATUSES], description: "..." }
        }
    }
} },
```

### 1.4 返回什么

`execute` **只返回 `output.schema` 声明的那个规范 JSON 值**；模型看到的内容由 `output.render` 投影：

`dsh-tool-ask-user/lib/index.js:66-95`
```js
output: {
    schema: { type: "object", additionalProperties: false, properties: { answers: { ... } } },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
},
```

### 1.5 怎么声明只读 / 副作用 —— **没有这个字段**

【已确认】`ToolDefinition` / `DefineToolOptions` 里**不存在** `readOnly` / `mutating` / `sideEffects` 之类的声明。可用的只有：

- `isConcurrencySafe?(args) => boolean`：**只有返回 `true` 才 opt-in 并行**；省略、抛异常、返回非 `true`、参数非法一律视为独占。（`dsh-tools/lib/types/index.d.ts:140-153`）
- `ctx.tools.guard(guard)`：单调守卫，返回字符串即拒绝调用；`@local/dsh-build-plan-mode-v2` 就是靠它实现「Plan 模式只读」——**只读是外部策略，不是工具自报的元数据**（`dsh-tool-*` 的 `ToolDefinition` 里没有任何对应字段）。
- `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result` 四个 waterfall 事件。

### 1.6 超时

`timeoutMs` 只是**声明**，注册表从不强制；强制执行者是 `@deepseek-ai/dsh-tool-call-timeout-policy`（`tools/execute` 包装层），它读 `ctx.tools.get(exec.name, exec.agent)?.timeoutMs`（`dsh-tools/README.zh.md:226`、`dsh-tool-call-timeout-policy/README.zh.md:63`）。不声明就永远没有截止时间。

### 1.7 `exec` 里有什么

`dsh-tools/lib/types/index.d.ts:197-221,261`
```ts
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    readonly arguments: unknown;      // 不可改写（pre-execute 有意禁止）
    readonly agent?: Agent;           // 代理本次调用的 agent
    readonly parent?: ToolExecutionToken;
    readonly signal: AbortSignal;     // 必有，协作式取消
}
export interface ToolExecution extends ToolExecutionInput { ... }
```
`exec.agent.session` 是会话对象，`exec.agent.session.append(type, data)` 可以写会话事件（`dsh-tool-todo/lib/index.js:173`）。

---

## 2. `ask_user_question` 阻塞链路完整时序

### 2.1 参与方与源码位置

| 角色 | 包 | 关键文件 |
|---|---|---|
| 模型侧工具 | `dsh-tool-ask-user` | `lib/index.js` |
| Host 侧服务（seam） | `dsh-user-questions` | `lib/index.js`（`UserQuestionService.ask`） |
| Host→Client 事件转发 | `dsh-api-remotes` | `lib/types/remote-events.d.ts`、`lib/index.js` |
| 传输 | `dsh-api-gateway` + `dsh-client-connection` | `/api` HTTP 一元 + `/api/remote.mux` WebSocket |
| 浏览器作答 UI | `dsh-client-ui-user-questions` | `lib/client.js` |
| 挂载点 | `dsh-agent-presets` | `presets/standard/agent.cordis.yml:238-239`（`tool-ask-user` 行） |

### 2.2 时序

```
模型
 │ 1. 发工具调用 ask_user_question({questions:[...]})
 ▼
dsh-tool-ask-user  execute(args, exec)                        [lib/index.js:96-112]
 │   把 args 映射成 AskUserQuestionRequest，
 │   带上 exec.agent（若有）与 exec.signal，调用 ctx.userQuestions.ask(...)
 ▼
UserQuestionService.ask(request)                              [dsh-user-questions/lib/index.js:52-79]
 │   2. signal 已 abort → ASK_ABORTED
 │   3. questions 为空  → EMPTY_QUESTIONS
 │   4. 有 agent 时：
 │        agents.get(agent.id) !== agent → CALLER_NOT_LIVE
 │        !agents.roots().includes(agent) → DELEGATED_CALLER
 │   5. 逐个校验 intent（approve 标签必须命中本题某个 option；必须带 detail）→ BAD_INTENT
 │   6. return ctx.waterfall(scopeTarget(agent, agent), "user-questions/request",
 │                           {...request, agent}, noAnswerer)
 │        └ 返回的 Promise 只在某个 listener 返回答案或 reject 时结算
 ▼
dsh-api-remotes 的 waterfall listener                          [dsh-api-remotes/lib/index.js:115-125]
 │   7. 用 carrierKeyOf(this) 取事件携带的 agent；
 │      请求的 request.agent 必须 === 该 agent，否则 TypeError
 │   8. forwardWaterfall(...) 造一个 {event, request, context, resolve, reject}
 │      推进 RemoteEventQueue，返回 settled.promise
 ▼
RemoteEventQueue.iterate → Gateway 的 $events 逻辑流                [同文件:133-172]
 │   9. 浏览器经 WebSocket /api/remote.mux 收到该事件
 ▼
浏览器：dsh-client-ui-user-questions client half                 [lib/client.js:880-882]
 │  10. ctx.remote.$on("user-questions/request", function (request, next) {
 │          return answerQuestion(ctx, this, request, next, registerPendingInteraction)
 │      })
 │  11. answerQuestion:                                      [lib/client.js:840-860]
 │        sessionId = ctx.sessions.scopeOf(this)   // this 是被 scope 化的 ctx
 │        pending = new PendingQuestion(sessionId, request.questions, request.signal)
 │        registerPendingInteraction(pending, onDelegate)  // 排序权重 plan-review=2，其余=1
 │        return await pending.result                      ← 挂在这里
 │  12. ctx.slots.inject("conversation.composer", () => ctx.slots.register(
 │        { name: "conversation.composer",
 │          select: ({pendingInteraction}) => pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,
 │          locale: "question", store: questionDraftStore }, QuestionComposer))
 │        —— 编辑器被提问界面接管
 ▼
人在 GUI 上作答 / 跳过 / 关闭
 │  13. pending.answer(answerBatch) → #resolve(answer)       [lib/client.js:113-119]
 │      或 pending.cancel() → #reject(ASK_CANCELLED)         [lib/client.js:136-142]
 │      或 pending.delegate() → #reject(私有哨兵) → 上层 next()  [lib/client.js:121-126, 850-855]
 ▼
14. listener 的 Promise 结算 → Gateway 经**已有的 HTTP 一元载体**把结果回送
    （"Agent-scoped waterfall 允许 listener 返回结果、调用 next() 或拒绝，
      Gateway 再通过现有 HTTP 一元载体回送该结果" —— dsh-api-gateway/README.zh.md:52）
 ▼
15. forwardWaterfall 里 settled.resolve(outcome.value)
 ▼
16. Host waterfall 返回 → UserQuestionService.ask() 返回 AskUserQuestionAnswer
 ▼
17. dsh-tool-ask-user 的 execute 映射成 {answers:[{id, selected:[...], custom?}]}
    → render 投影成紧凑 JSON 文本 → 普通工具结果 → agent loop 继续
```

### 2.3 超时 / 取消 / 并发

**超时：无。**【已确认】`dsh-tool-ask-user/README.zh.md:141`：
> **待处理问题会阻塞工具调用，直至用户作答**：该工具未声明 `timeout-policy` 预算；取消仅沿用当前轮次的 `exec.signal`。

其 `defineTool` 调用里也确实没有 `timeoutMs`（`lib/index.js:15-113` 全文无此字段）。

**取消**：三条路径
- `request.signal` abort → 客户端 `PendingQuestion` 的 abort 监听触发 → `pending.abort(ASK_ABORTED)`（`lib/client.js:102-107,147-152`）
- 用户点关闭 → `ASK_CANCELLED`
- 用户/系统让出 → `delegate()` 走下一个 waterfall listener（TUI 等），此路径**不是错误**

错误码全集（`dsh-user-questions/lib/types/index.d.ts` / `lib/index.js`）：`EMPTY_QUESTIONS`、`BAD_INTENT`、`NO_PROVIDER`、`ASK_ABORTED`、`CALLER_NOT_LIVE`、`DELEGATED_CALLER`，外加 UI 侧的 `ASK_CANCELLED`。

**并发**：`dsh-client-ui-user-questions/README.zh.md:93`
> **每次只有一个请求拥有编辑器**：后续待处理请求仍留在会话快照中，并在较早请求落定后显示。

**断线重连**：`dsh-api-gateway/README.zh.md:74`
> Connection generation 会重开内部 `$events`；单向通知不会重放，**仍处于 pending 的 scoped waterfall 则沿用同一个 event id 重放**。

这条对象棋很关键：等待期间刷新页面/断网重连，pending 请求会重投，但草稿只在页面内保留（`dsh-client-ui-user-questions/README.zh.md:92`）。

### 2.4 只能由「运行时根 agent」提问

`DELEGATED_CALLER` 意味着**子 agent 不能提问**，必须在最终结果里回报未决问题（`dsh-tool-ask-user/README.zh.md:60,142`）。象棋若在 subagent 里调用会直接失败——主会话（根）没问题。【已确认】

---

## 3. 象棋能否照搬这条链路？

**形状完全一致**：工具阻塞 → 人在 GUI 操作 → 工具拿到结果返回 → 会话继续。「等对方走一步」与「等人回答一个问题」在协议层是同一件事。取消、断线重连、单编辑器占用这些语义也正好是象棋想要的。

**但 seam 的词汇装不下棋盘。**【已确认】`dsh-user-questions/lib/types/types.d.ts:29-44`
```ts
export interface AskUserQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: AskUserQuestionOption[];   // { label, description? }
    multiSelect?: boolean;
    intent?: AskUserQuestionIntent;      // { kind: 'plan-review', approve: string }
}
```
`dsh-user-questions/README.zh.md:66` 直说：
> **词汇仅包含问题表单形态**：可供选择的选项加可选的自定义文本；更丰富的交互形态（文件选择器、diff 预览确认）尚无 seam 词汇。

### 三条候选路线

**路线 A：退化成选项列表（零新协议）**
把「所有合法着法」做成 `options`，人点一个。能用，但那是按钮列表不是棋盘，体验很差。

**路线 B：复用 `intent` 标签 + 自写工具与自写客户端 answerer（推荐用于「阻塞式」）**
【已确认的关键事实】`ask()` 对 `intent` 的校验**不检查 `kind` 白名单**，只检查两件事（`dsh-user-questions/lib/index.js:61-66`）：
1. `intent.approve` 必须命中该问题自己的某个 option 标签；
2. 该问题必须带 `detail`。

而类型注释把 `intent` 定义为**可扩展标签**（`types.d.ts:11-27`）：
> Tagged so further intents can be added; a UI that does not know a tag renders the generic flow, and the answer encoding is identical either way — an intent changes presentation only, never the protocol.

所以象棋插件可以：
- 自写工具（`inject: ['tools','userQuestions']`），调用公开的 `ctx.userQuestions.ask({ questions: [{ id, question, detail: 盘面JSON, options: 合法着法, intent: { kind: 'xiangqi-board', approve: '落子' } }], agent: exec.agent, signal: exec.signal })`——注意**不能用随包的 `ask_user_question` 工具**，因为它的参数 schema 不含 `detail`/`intent`（`dsh-tool-ask-user/lib/index.js:18-65`，且 `execute` 也不转发这两个字段）。
- 自写客户端 answerer：`ctx.remote.$on('user-questions/request', fn)`，只认自己的 `intent.kind`，画棋盘，落子后 `pending.answer(...)`。
- 不认识的 UI 会退化成通用列表——**优雅降级**。

⚠️【推测，需实测】瀑布顺序问题：随包的 `answerQuestion` **不检查 intent**，它claim 每一个请求并渲染通用流程。所以象棋 listener 必须注册在它**之前**（`$on` 监听器按注册顺序）。`ctx.remote.$on` 的类型里没有 `priority` 参数，能否稳定抢在前面我没有验证。

**路线 C：不走 ask-user，走「工具阻塞在进程内 deferred + 自建 RPC 通道」**
Host 工具 `await` 一个挂在会话上的 deferred；Client 棋盘通过自建 RPC 通道回传落子，Host 解 deferred，工具返回。缺点是「pending 请求重投」这类 ask-user 已经帮你做好的健壮性要自己写。优点是完全不依赖 ask-user 的词汇、不与随包 UI 抢 composer。

详细对比见 §8。

---

## 4. 插件自己的服务端状态 / HTTP 路由 / 客户端如何读

### 4.1 进程内状态：可以

【已确认】官方先例：
- `dsh-tool-present/lib/index.js:22` — `const pending = new WeakMap()`，以 `exec` 为键跨 `execute` 与 `tools/result` 存状态。
- `@local/dsh-build-plan-mode-v2/lib/index.js:203` — `const chains = new WeakMap()`，按 session 串行化。

插件就是一个模块，闭包 + 模块级变量都是进程内的。`ctx.effect(fn, label)` 注册随插件卸载而释放的副作用。

### 4.2 挂 HTTP 路由：三条官方通道，任选

**(i) 通用认证 RPC 通道（推荐）**
`dsh-client-connection/lib/types/rpc.d.ts:103-120`【已确认，逐字】
```ts
export interface HostConnectionRpc {
    /**
     * Register one authenticated absolute channel prefix.
     * @param channel - absolute logical channel such as `/rpc`.
     * @param handler - decoded endpoint handler returning the existing RPC result shape.
     * @returns asynchronous disposer removing the channel and its physical route.
     */
    handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>;
    intercept(channel: '/api', matches: ConnectionRpcEndpointMatcher, handler: ConnectionRpcHandler): () => Promise<void>;
}

export interface ClientConnectionRpc {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>;
    readonly open?: (...);   // 浏览器载体省略 open；一元 call 在浏览器可用
}
```
注意 `HostConnectionRpc.handle` 的 disposer「removing the channel **and its physical route**」——所以客户端可以直接 `ctx.connection.rpc.call('/xiangqi', 'move', {...})`，不需要自己拼 HTTP。`dsh-client-connection` 是双面插件，Client 侧也挂 `ctx.connection`（README:12）。

**(ii) `/api` 下的精确 Fetch 路由**
`dsh-client-connection/lib/types/rpc.d.ts:80-102`【已确认】
```ts
export interface ConnectionFetchRoute {
    readonly path: string;                                  // Absolute path below `/api`
    readonly methods: readonly ('GET'|'HEAD'|'POST')[];
    readonly requestBody: 'buffered' | 'streaming';
    readonly fetch: (request: Request) => Promise<Response>;
}
export interface HostConnectionFetch {
    register(route: ConnectionFetchRoute): () => Promise<void>;
}
```
「Handle one request **after the physical carrier has applied its trust and authentication policy**」——认证已由 Connection 做好。客户端用普通 `fetch('/api/xiangqi/...')` 即可（同源 cookie）。先例：`dsh-client-file-upload` 就是这么干的（README:35 提到「原始路由请求」+ 页面自有 Fetch 载体）。

**(iii) 裸 `node:http` 路由**
`dsh-host-webserver/lib/types/index.d.ts:33-106`【已确认】
```ts
export interface WebRoute {
    kind: 'exact' | 'prefix';
    path: string;                    // 绝对路径，无尾斜杠
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
register(route: WebRoute): () => void;
registerUpgrade(route: WebUpgradeRoute): () => void;
registerFallback(handler): () => void;
tapIndex(transform: (html: string) => string): () => void;
```
⚠️ 这条路**不做任何认证**——README:113 明说「不提供服务器级 TLS、认证或来源策略：`dsh-client-connection` 等 route owner 会实施自己的请求策略」。用这条就得自己调 `ctx.connection.requestRejection(request)`（`rpc-host.d.ts:29`）。匹配顺序：精确 → 最长前缀 → fallback；重复路径**抛错**。

### 4.3 客户端怎么读到这份状态

**首选：Session Projection（Host 注册，Client 自动收到）**
`dsh-session-projection/README.zh.md:36-65`【已确认】
```ts
const definition = {
  key: 'xiangqi',
  stateSchema, stateVersion: 1,
  init: (header, inheritedEventCount) => ({ ... }),
  apply: (state, event) => event.type === 'xiangqi/move' ? next : state,   // 必须同步；无关事件返回同一引用
  wire: { viewSchema, view: state => ({ ... }) },                          // 有 wire 才暴露给客户端
}
const dispose = ctx.sessionProjections.register(definition)
const { asOfSeq, values } = ctx.sessionProjections.snapshot(session)
```
- 状态由**已提交的会话事件**折叠派生，所以棋盘状态天然持久、可回放、fork 不继承父会话（`dsh-schedule/README.zh.md:101`）。
- 客户端用 `useProjection(key)` 读——`@local/dsh-build-plan-mode-v2/lib/client.js:121` 就是 `const projection = useProjection(MODE_PROJECTION_KEY)`。
- 没有 `wire` 块 = host-only 单元。
- 注册是挂在调用方 fiber 上的 effect。

**客户端动作 → Host**：两条
- 自建 RPC 通道（见 4.2(i)）
- 注册 slash command，客户端调 `session.command('/xiangqi-move h2e2')`

`ctx.commands.register` 定义（`dsh-commands/README.zh.md:34-46`）：
```ts
ctx.commands.register({
  name: 'plan',
  description: 'Enter plan mode',
  input: { hint: '<message>' },
  handler: ({ agent, rawInput }) => ({ kind: 'success', text: 'plan mode selected' }),
})
```
`CommandResult` = `{kind:'success', text?, sourceEventSeq?}` | `{kind:'error', text}`（`dsh-commands/lib/types/types.d.ts:33-41`）。每次准入的执行都会写 `command/run` / `command/done` 到会话日志（`recordInput: false` 可关掉前半的入参记录）。

客户端侧的调用面（`dsh-api-session-controller/lib/types/client/contract/session.d.ts:134-142`）：
```ts
/** Execute one slash-command line against this session's agent. */
command(line: string): Promise<RemoteResult<{ matched: boolean }>>;
```
同一个 `ISession` 还有 `prompt(content, mode:'queue'|'steer', signal?, requestId?)`、`cancel()`、`rename()`、`readAttachment()`、`updateQueue()`。**`useSession` 是 session 作用域 slot 的标准 props**（shipped skill `cordis-plugin-development/SKILL.md:275`：「A session-scoped Slot may provide `useSession`, `useSessions`, `useWorkspaces`, `useProjection`, input state, or actions through standard props」；`dsh-client-ui-conversation/README.zh.md:41` 说明 `ctx.uiSession.provide()` 从同一个 Session binding 物化 Conversation 与 input source 并公开稳定标准 props）。
⚠️【推测】具体某个 slot 是否真给 `useSession`，必须用 `cordis_inspect_query` 查该 slot 的 live 契约才能确定（shipped skill 反复强调不要从 slot 名字猜 props）。

### 4.4 插件**不能**做什么：加自己的 Web 事件类型

【已确认，硬结论】`ctx.remote.$on(key)` 的合法键**恰好**等于一份硬编码白名单：

`dsh-api-remotes/lib/types/remote-events.d.ts:12-69`（19 条）
```ts
export declare const API_REMOTE_FORWARDED_EVENTS: readonly [
  { readonly event: "agent-preset/selected"; readonly mode: "emit"; },
  { readonly event: "approval/request"; readonly mode: "waterfall"; },
  ... 
  { readonly event: "user-questions/request"; readonly mode: "waterfall"; }
];
```
而且 Host 只有**一个**事件源槽位：`ctx.typertGateway.registerRemoteEvents(source, {home})`，README 写的是「注册**唯一的**应用事件 source」（`dsh-api-gateway/README.zh.md:37`）。

第一方证据：连 `dsh-cordis-host-runner` 自己的四个事件，也是**先被写进白名单**才能投递——
`dsh-cordis-host-runner/README.zh.md:84`：
> 四条转发事件（`cordis/request-run`、`cordis/request-run-resolved`、`cordis/dynamic-package`、`cordis/dynamic-retract`）声明在 client 安全的 `./types` 子路径上，**并由 `@deepseek-ai/dsh-api-remotes` 的白名单准许投递**——正是这一点让浏览器能经 `ctx.remote.$on` 收到它们。

**推论【推测】**：想在 0.1.5-rc.2 上加一条全新的 Host→Client 事件，只能改/替换随包的 `dsh-api-remotes`——例如在 `cordis.patch.yml` 里 `disabled: true` 掉 `api-remotes` 那一行（`dsh-web-app/cordis.patch.yml:195` 是 `- id: api-remotes`），再 `insert` 一个自带补丁白名单的本地包。可行性我没验证，且属于对随包发布物的侵入式改动。

**对比：`harness.handle` / `host.call` 是存在的，但只给「动态 Cordis 包」**
`dsh-cordis-host-runner/lib/types/guard.d.ts:29-40` + `dsh-cordis-client-runner/lib/client.js:181,5072-5079`【已确认】
```js
// 客户端沙箱里：
call: (method, args = null) => env.invoke(method, args)
// → 实际走 ctx.remote.dynamicCordisRunner.invoke(pluginId, pluginRunId, method, args)
```
这是**包私有 Client→Host JSON RPC**，句柄表按 `(pluginId, pluginRunId, method)` 键控，通道是 shipped 的 `dynamicCordisRunner` Remote namespace，所以**不需要改白名单**。但 `harness` 只是 `code.host` 沙箱里的 builtin（`SKILL.md:323-348`），**文件式插件（cordis.patch.yml 里的一行）拿不到 `harness`**。它只对 `cordis_define` + `cordis_run` 定义的动态包可用。

**另一条**：自建 Typert Remote namespace。`dsh-typert-registry/README.zh.md:44` 说生成产物「在 Loader 组合中通过 loader 注册」，包要导出 `./typert`（Host face）与 `./remote`（Client face）——先例是 `dsh-cordis-host-runner/package.json:25-31`：
```json
"./typert":  { "types": "./lib/typert.host.d.ts",        "default": "./lib/typert.host.js" },
"./remote":  { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" }
```
这些是**生成产物**，需要 Typert 生成器。本机装了 `dsh-typert-loader` / `dsh-typert-protocol` / `dsh-typert-registry`，**没装生成器**。【推测】手写这条路不现实。→ 所以通用 RPC 通道（4.2(i)）才是象棋的正确选择。

---

## 5. 会话注入：有没有官方途径唤醒一个正在运行的会话？

### 5.1 有。原语在 `Agent` 上

`dsh-agent/lib/types/runtime-types.d.ts:175-209`【已确认，逐字】
```ts
/**
 * Route identified input to an inbox boundary and optionally wake the driver.
 * ...
 */
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;

/**
 * Queue an ordinary follow-up turn and wake the driver. The item becomes the
 * sole ordinary message of its own turn.
 */
followup(message: UserMessage): void;

/**
 * Submit steering for the nearest step. An idle driver starts a turn;
 * a running driver consumes it at its next step boundary.
 * ...
 */
steer(message: UserMessage): void;

/**
 * Queue model-facing context for the next pre-step without waking the
 * driver. ...
 */
inject(message: UserMessage): void;
```

拿 agent 句柄（`dsh-agent/lib/types/index.d.ts:336-362`）：
```ts
get(id: SessionId): Agent | undefined;   // 查活着的 agent
list(): Agent[];
roots(): Agent[];                        // 全新的数组
```

构造消息（`dsh-llm/lib/types/message.d.ts:161-183`）：
```ts
export declare function createUserMessage<T extends NewUserMessage>(input: T & {
  readonly id?: never; readonly role?: never;
}): T & Pick<UserMessage, 'id' | 'role'>;
```

### 5.2 消息来源类型可合并扩展

`dsh-llm/lib/types/message.d.ts:90-104`【已确认】
```ts
/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
export interface MessageSourceMap {
    user:   { kind: 'user' };
    plugin: { kind: 'plugin'; plugin: string } & ContextFormed;
    model:  ModelMessageSource;
    tool:   ToolMessageSource;
}
```
官方先例（`dsh-webhook/lib/types/types.d.ts:60-73`）：
```ts
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        webhook: { readonly kind: 'webhook'; readonly provider: string; readonly source: WebhookSourceId;
                   readonly deliveryId: WebhookDeliveryId; readonly ruleId: WebhookRuleId;
                   readonly form: 'notice'; readonly summary: string; };
    }
}
```
不合并也能用现成的 `{ kind: 'plugin', plugin: 'xiangqi' }`。

### 5.3 官方先例：`dsh-schedule`（最贴合象棋需求）

`dsh-schedule/README.zh.md:121-123`
> owner 把长等待拆分为有界的 timer 段……到期工作**认领 idle maintenance phase**、采样一个决策时点、在 `followup()` 之前构造完整的转义 framing、只在同步入队返回后追加 dispatch、释放 maintenance，然后等待持久化。
> 逾期提醒……通过 `runMaintenance()` 认领 agent 的 idle maintenance phase；如果某个轮次或另一项 maintenance task 已占用 agent，认领会失败，记录保持活动，owner 在 `whenIdle()` 后重试。

它的 inject 是 `['agents','sessions','tools','sessionPersistence']`，**只观察加载后发布的 `agent/created` 事件**，然后在那些根 agent 上 `agent.ctx` 里注册工具（README:70）。这正是象棋插件「每会话一份棋局状态」可以照抄的骨架。

`runMaintenance` / `whenIdle` 的签名在 `dsh-agent/lib/types/runtime-types.d.ts:158-174`：
```ts
whenIdle(): Promise<void>;
runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
```

### 5.4 官方先例：`dsh-webhook` —— 但它只能开**新**会话

`dsh-webhook/README.zh.md:12`
> 它既是受信任程序化 webhook 规则的注册表，也**拥有唯一内置动作——在 Web Workspace 中创建普通根 Session**。

`lib/index.js:99-134`：`ctx.agents.create({...})` → `workspace.attachSession` → `handle.agent.followup(createUserMessage({...source:{kind:'webhook',...}}))`。
它**不会**注入到已有会话，也不等 idle、不检查回复（README:41,71-73）。
→ 所以「webhook 能不能把落子事件塞进正在跑的会话」的答案是：**内置动作不能；但 webhook 规则回调是任意受信任代码，它完全可以自己 `ctx.agents.get(id).followup(...)`**。【推测，但依据是 README 明说回调可执行任意受信任代码（README:28）】

### 5.5 `session/prompt` Remote：也能唤醒（包括冷会话）

`dsh-api-session-controller/lib/index.js:217-240`（`resolve`）：先找活的 `liveAgent(sessionId)`；找不到就 **resume 持久化会话**（带 single-flight 去重）。
`:736-790`（`prompt`）：校验内容非空 → `resolveAgent` → 组装 `source = { kind: 'user', rpcId, clientTimeZone? }` → `createUserMessage` → `request.mode === 'steer' ? agent.steer(message) : agent.followup(message)`。

注意：这条路径**强制 `source.kind = 'user'`**，插件身份会丢。所以插件自己唤醒会话应该直接用 `agent.followup(...)` + 自定义 source，而不是走 `session/prompt`。

### 5.6 结论

> **有官方途径。`ctx.agents.get(sessionId)?.followup(createUserMessage({ content, source }))` 就是「往一个会话里塞一条消息并唤醒它」的正式机制**，`dsh-schedule` 是随包发布的活样本。「人一落子会话自动醒」在会话空闲（或能被 steer 打断）时**技术上成立**。

---

## 6. 安装与生效

### 6.1 `dsh plugin --profile web add <pkg>` 到底做了什么

`dsh/lib/plugin-Ddi42qoW.js:101-128`【已确认】
```js
function runPlugin(profile, args) {
  const dir = resolveProfileDir(profile);
  if (!existsSync(join(dir, "package.json"))) {
    const template = PROFILE_TEMPLATES[profile];
    initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES, template?.patchReload);
    process.stderr.write(`dsh: initialized profile ${profile} at ${dir}\n`);
  }
  const before = readProfileManifest(NAME, dir);
  const result = spawnSync("pnpm", args.map(a => anchorPathSpec(a, process.cwd())), {
    cwd: dir, stdio: "inherit", shell: process.platform === "win32"
  });
  ...
  if (exitCode === 0) reconcilePlugins(before, dir);
}
```
关键点：
1. profile 不存在就先按模板 init（`web` 的模板 bundles = `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']`，见本机 `profiles/web/package.json`）。
2. **转发给 pnpm**，`cwd` = profile 目录。相对路径（`.`、`../x`、`file:`、`link:`）会被**重新锚定到用户调用 dsh 时的目录**，避免 `add .` 自链接 profile（`anchorPathSpec`, :90-94）。
3. **对账**：`reconcilePlugins(before, dir)`（:46-78）

```js
for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir);   // 读 package.json 的 dsh.bundle.patch
    if (isBundle && !plugins.includes(packageName)) { plugins.push(packageName); changed = true; }
    else if (!isBundle && !beforeDeps.has(packageName)) process.stderr.write(
      `dsh: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer ...`);
}
```
即：**依赖 resolved 出来的包如果在自己的 package.json 里声明了 `dsh.bundle.patch`，它的包名会被追加进 `dsh.profile.bundles`（变成一个 profile 层）；没声明就只当普通依赖并打一行警告。** 按已安装状态对账而不是按依赖 diff，所以 `update` 带来的新 `dsh.bundle` 声明也会自动生效。
4. **它完全不碰 `cordis.patch.yml`。**

### 6.2 本机 web profile 的现状

`%USERPROFILE%\.dsh\profiles\web\package.json`【已确认】
```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], "patchReload": "live" } }
}
```
`%USERPROFILE%\.dsh\profiles\web\cordis.yml`【已确认】是空列表 `[]`（每次启动会被重写，注释明确说「Edit cordis.patch.yml, not this file」）。

`cordis.patch.yml` 现有内容（用户已经手挂过两个本地插件）：
```yaml
- insert:
    - id: build-plan-mode
      name: '@local/dsh-build-plan-mode-v2'

- id: ui-plan
  disabled: true

- insert:
    - id: hello-right-panel
      name: '@local/dsh-hello-right-panel'
```
本地包在 `%USERPROFILE%\.dsh\profiles\web\node_modules\@local\`（**真实目录**，不是 junction），由另一个本地仓库的 `npm run deploy:user-profile` 脚本拷进来。**这说明本机已经有「不上 npm、直接手挂本地包」的成熟做法。**

### 6.3 `cordis.patch.yml` 的正确写法（不破坏现有配置）

**格式**：顶层 YAML 数组，元素是 `PatchOptions`（`cordis-plugin-include/lib/types/index.d.ts:28-39`）：
```ts
export interface PatchOptions {
    id?: string;
    insert?: EntryOptions[];
    name?: string;
    config?: any;
    group?: boolean | null;
    disabled?: boolean | null;
    inject?: any;
    intercept?: any;
    isolate?: any;
    [key: string]: any;
}
```

**语义**（`cordis-plugin-include/lib/index.js:51-88`）【已确认】：
- 带 `id` 的 patch 改写该行；带 `insert` 且**无** `id` 时追加到顶层；带 `insert` **且** `id` 时 `target.config.push(...insert)`（插进那个 group）。
- **匹配不到任何行的 patch 只 warn 然后跳过**（`:74,88`）——所以打错 id 会静默无效，不会报错。这是最容易踩的坑。
- 插入的行在同一次 patch 里对后续 patch 立即可见（`buildMap(insert)`）。
- `insert` 时若 `id` 指向的不是 group，warn「is not a group」。

**⚠️ 最大的破坏性陷阱**：`dsh-web-app/cordis.patch.yml:5-6` 明说
> A patch replaces the targeted row's whole `config`, so each row below restates every key it owns.

也就是说 `- id: tool-web` + `config: {...}` 会**整体替换**该行 config，漏掉的字段会丢。想安全改配置必须把原 row 的所有 key 都重述一遍，或者干脆不动它、只 `insert` 新行。

**层序（后者覆盖前者）**：`dsh/lib/profile-boot-Dk-7KqJc.js:213-256`【已确认】
```
bundle 层（按 dsh.profile.bundles 顺序）
  → profile 的 cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml        ← home 层，优先级高于 profile 层
  → --patch <file> overlay（可重复，按 argv 顺序）
  → telemetry 开关（DSH_TELEMETRY_DISABLED）
```
`patchReload: 'live'` 时，launcher 通过 HMR 同时 watch profile patch 文件与 home patch 文件（`:321-341`）。本机是 `live`。

**最安全的三条实践**：
1. 只用 `insert` 加新行，不改任何现有 `id` 的 `config`；要禁用一个随包行时用 `- id: X` + `disabled: true` 而不是覆盖 config（本机对 `ui-plan` 就是这么做的）。
2. 改前 `dsh --profile web --dump-config` 看合成结果，确认自己插到了哪里、有没有 warn。
3. `--patch <临时文件>` 做试验，确认无误再写进 profile 层。

### 6.4 插件包的 package.json 约定

`dsh-package-manifest/lib/types/types.d.ts:7-52`【已确认】
```ts
export interface DshManifest {
    bundle?: DshBundleManifest;      // { patch: string }  ← 相对包根的 patch 文件路径
    profile?: DshProfileManifest;    // { bundles?: string[]; patchReload?: 'live'|'startup' }
    client?: DshClientManifest;
    configTrees?: DshConfigTreeDeclaration[];
    sessionFormatMigration?: DshSessionFormatMigrationManifest;
}
export interface DshClientManifest {
    platform: string;                // Web 消费者选 'web'
    inject?: string[];               // 仅信息性包名依赖，不是 Cordis 服务注入
    immediately?: boolean;           // 启动第一阶段的注册屏障
    external?: string[];             // 精确模块请求（基座之外），如 '<pkg>/client'；纯类型 import 被擦除
}
```
一个可用的最小双面插件（本机的 `@local/dsh-hello-right-panel/package.json`，**但见 §7 的警告**）：
```json
{
  "name": "@local/dsh-hello-right-panel",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime"] } }
}
```
- Host 半（`main` / `exports["."]`）= 普通 ESM 插件模块（`name`/`inject`/`apply`）。
- Client 半（`exports["./client"]`）必须是**已构建**的浏览器 bundle，包装成 `window.__ModuleLoader__.load({ id, factory })` 的 CJS factory 形式：
  ```js
  window.__ModuleLoader__.load({
    id: '@local/dsh-hello-right-panel',
    factory: (require) => {
      const module = { exports: {} }
      const react = require('react')
      const jsx = require('react/jsx-runtime').jsx
      const inject = ['slots']
      function apply(ctx) { ctx.slots.inject('details', () => ctx.slots.register({ name: 'details', priority: -1 }, HelloRightPanel)) }
      module.exports.apply = apply
      module.exports.inject = inject
      return module.exports
    },
  })
  ```
  bundle 的 `id` = 解析出的 manifest 包名。
- **构建要求**（`dsh-client-modules/README.zh.md:46`）：
  > 宿主提供的是**已构建**的客户端 bundle，因此启动前 `pnpm run build` 必须已产出每个 `lib/client.js`；**缺失 bundle 会以一条构建说明加包／路径列表的方式让激活大声失败**。
- 浏览器侧只有一份**冻结的共享模块表**（`PLATFORM_MODULES`：React、Cordis 与静态 UI 库）；基座之外的东西要靠 `dsh.client.external` 声明（`:42`）。
- `dsh.client` 行由 `dsh-client-modules` 扫描**已启用的 Loader 条目**、经 `/plugins/??...&rev=...` combo URL 提供（`:12,70-74`）。

### 6.5 工具该挂在哪：不要动随包 preset，另建用户 preset

`dsh-tool-ask-user` 不在任何 host bundle 里，它是 **agent preset 的一行**（`dsh-agent-presets/presets/standard/agent.cordis.yml:238-239`）。README 解释了归属（`dsh-client-ui-user-questions/README.zh.md:50`）：拥有工具是 agent 的能力，所以 `tool-ask-user` 行属于需要它的各个 preset。

随包的 `cordis` preset persona 给了权威的安装指导（`presets/cordis/agent.cordis.yml:28`）：
> Presets you author live one directory per preset under `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`；the roster reports each preset's real path, so take the one you edit from there. **NEVER edit or delete the shipped preset install** ... an upgrade overwrites it ... To change what a shipped preset does, **copy its composition into a new preset directory and edit the copy**.

用户 preset 目录约定（`dsh-agent-presets/README.zh.md:36,53-60,133`）：
- `<dshHome>/.agent-presets/<id>/`，含 `preset.yml`（`name` / `description` / `order`）+ `agent.cordis.yml`（组合）。
- `includeUserRoot` 默认 `true`，在全部已配置根目录**之后**追加该根；随包根前置，重复 id 时随包赢。
- 默认 preset 可在 settings 里层叠：`agent-presets: default: <id>`（README:64-71），会话创建时读取，只影响之后创建的会话。
- 本机 `%USERPROFILE%\.dsh\.agent-presets` **尚不存在**，也没有 `$DSH_HOME/cordis.patch.yml`——所以这条路是干净的、非破坏性的。

**另一种更轻的试验路径**：`dsh web --patch <file>`（overlay 层，优先级最高）。随包 README 里提到的 `apps/cli/config/examples/...` 那些示例**不在已安装的 npm 包里**（我确认过：`dsh` 包的 `files` 只发 `lib/*.js`，全盘搜不到 `config/examples`）；那些路径指源码仓库。

---

## 7. 给象棋插件的直接可用情报（含本机现状警告）

### 7.1 本机已有一个「右栏面板」插件，但它的 API 已经过期 ⚠️

`@local/dsh-hello-right-panel/lib/client.js` 调用：
```js
react.useEffect(() => { ctx.layout.openDetails() }, [])
...
onClick: () => ctx.layout.closeDetails(),
```
以及 `ctx.slots.inject('details', () => ctx.slots.register({ name: 'details', priority: -1 }, HelloRightPanel))`。

【已确认】在 0.1.5-rc.2 的**全部**已安装包里 grep 不到 `openDetails` / `closeDetails`（一次命中都没有）。本版本的 `ctx.layout` 是（`dsh-client-ui-layout/lib/types/client/service.d.ts:24-48`）：
```ts
export interface ILayout {
    selectPanel(panelId: MainPanelId | null): void;
    beginNavigation(): AbortSignal;
    toggleSidebar(): void;
    openRightbar(track: boolean, fullscreen: boolean): void;   // ← 不是 openDetails
    closeRightbar(): void;                                      // ← 不是 closeDetails
}
```
`dsh-client-ui-layout/README.zh.md:46` 也一致：席位通过 `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar()` 报告呈现。
→ **【推测】** 那个面板第一次 mount 时会在 `useEffect` 里抛 TypeError。要不要修/怎么用，建议父 agent 先跟用户确认。

`details` 这个 slot 名：shipped skill `cordis-plugin-development/SKILL.md:265` 把它列为已知的 root 级 slot（"Do not default to root-level `root`, `sidebar`, `conversation`, or `details` Slots"），但我在已安装包里没找到它的声明（shipped client bundle 被打包过，字符串搜索不可靠）。

**本版本右栏的正式扩展席位**（`dsh-client-ui-sidebar-right/README.zh.md:77-82`）：
```ts
ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide? })
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)   // 正文，用 useTabInfo()
ctx.sidebarRight.openResource(address, options?)     // dsh-resource://<type>/…
ctx.sidebarRight.openTab(kind, options?)             // 页类型
```
另有 `sidebar.right.tab.guide`（chain，替换引导页正文）与 `sidebar.right.tab.menu.item`（list，追加内容级动作）。
→ **象棋棋盘的右侧栏正确落点应该是 `sidebar.right.pane.tab`**（自注册一个 tab kind + 打开它），而不是 `details`。

### 7.2 一个可抄的现成骨架：`@local/dsh-build-plan-mode-v2`

它展示了两件象棋正要用的技术（`lib/client.js:279,291-301,357`）：
```js
// 客户端 → Host：走已有 Remote namespace 里的命令
commandExecute: (sessionId, line) => ctx.remote.commands.execute(sessionId, line, []),
const outcome = await runtime.commandExecute(sessionId, `/${BPLAN_CONTRACT.commands.interactive} ${mode}`)
// Host → 客户端：走 session projection
const projection = useProjection(MODE_PROJECTION_KEY)
module.exports.inject = ['slots', 'remote', 'remote.commands']
```
Host 半（`lib/index.js:265-267,289-291,319-336`）注册 projection、systemPrompt 段、**工具守卫**、命令，全部用 `ctx.inject([...], cb)` 按能力就绪挂载，并统一收集 disposer 做回滚。

### 7.3 「临时 composer 接管」的官方文档化写法

`dsh-client-ui-conversation/README.zh.md:72-101`【已确认，逐字】——这正是 `ui-user-questions` 用的形状，并且是**公开推荐给业务 package 的**：
```tsx
const select: ChainSelect<ComposerChainProps, Request> = owner =>
  owner.sessionId === request.sessionId ? request : null

const dispose = ctx.slots.register({ name: 'conversation.composer', select }, RequestComposer)
try { return await request.result } finally { dispose() }
```
`ComposerChainProps` 的 owner currency 是：
```ts
interface ComposerChainProps {
  sessionId: SessionId | undefined
  session: SessionSnapshot | undefined
  pendingInteraction: SessionPendingInteraction | undefined
}
```
`SessionPendingInteraction` 是**可合并扩展**的 map——`dsh-client-ui-user-questions` 就declare merge 了 `question: PendingQuestion`（`lib/types/client/contract/slots.d.ts:6-11`）。这意味着象棋也可以声明自己的 `xiangqi` pending interaction 类型并接管 composer。**但触发这个 pending 的那条 Remote waterfall 请求，仍然只能来自白名单里的事件。**【已确认】

---

## 8. 象棋三条路线的对比

| | A：选项列表 | B：intent 标签 + 自写 answerer | C：自建 RPC 通道 + 阻塞工具 |
|---|---|---|---|
| 画得出棋盘 | ❌（只能列着法按钮） | ✅ | ✅ |
| 会话被唤醒/继续的机制 | ask_user 工具返回 | ask_user 工具返回（同 A） | 工具 await 进程内 deferred |
| 需要改随包文件 | 否 | 否 | 否 |
| 依赖的官方接缝 | `ask_user_question` | `ctx.userQuestions.ask()` + `ctx.remote.$on('user-questions/request')` + intent 标签 | `ctx.connection.rpc.handle/call` + `ctx.tools.register` + `sessionProjections` |
| 断线重连健壮性 | ✅ 白送（pending waterfall 按 event id 重投） | ✅ 白送 | ❌ 要自己写 |
| 与随包 UI 抢 composer | 无（本来就是它） | ⚠️ 有，且排序机制未验证【推测】 | 无（棋盘在右栏，不碰 composer） |
| 主要风险 | 体验差 | 瀑布顺序 / 抢 composer 失败 | RPC 通道的真实行为未实测 |
| 我的判断 | 只适合当 PoC 第一步 | 语义最正统，风险在中段 | **工程上最可控** |

**我的推荐**【推测】：先做 C 的骨架（右栏 tab + 自建 RPC + 阻塞工具 + projection 广播状态），因为它每一环都有明确的类型文档，且不与其他插件争夺任何单一占位资源；如果实测 C 的 RPC 通道有问题，再退到 B。

---

## 9. 已确认 / 属于推测 对照表

| # | 结论 | 状态 | 依据 |
|---|---|---|---|
| 1 | `defineTool({name,description,parameters,output,execute})`，`ctx.tools.register()` 返回 disposer | 已确认 | `dsh-tools/lib/types/schema.d.ts:178-239`；`index.d.ts:601` |
| 2 | 参数 DSL 是 dsh-tools 自带（string/number/integer/boolean/null/array/object/json/oneOf），不是 schemastery | 已确认 | `dsh-tools/README.zh.md:60` |
| 3 | **没有** readOnly/副作用声明字段；只有 `isConcurrencySafe?()` | 已确认 | `dsh-tools/lib/types/schema.d.ts:196-201`、`index.d.ts:140-153` |
| 4 | `timeoutMs` 仅声明，由 `dsh-tool-call-timeout-policy` 经 `tools/execute` 强制 | 已确认 | `dsh-tools/README.zh.md:226`；`dsh-tool-call-timeout-policy/README.zh.md:63-69` |
| 5 | `ask_user_question` **没有**超时预算，只靠 `exec.signal` 取消 | 已确认 | `dsh-tool-ask-user/README.zh.md:141`；其 `defineTool` 无 `timeoutMs` |
| 6 | `ask()` 走 `ctx.waterfall(scopeTarget(agent,agent), 'user-questions/request', …)` | 已确认 | `dsh-user-questions/lib/index.js:69-72` |
| 7 | 只有运行时根 agent 能提问（子 agent → `DELEGATED_CALLER`） | 已确认 | `dsh-user-questions/lib/index.js:56-60`；README:142 |
| 8 | 客户端 answerer = `ctx.remote.$on('user-questions/request', …)` + `conversation.composer` 接管 | 已确认 | `dsh-client-ui-user-questions/lib/client.js:874-882` |
| 9 | 答案经**已有 HTTP 一元载体**回送（不新开通道） | 已确认 | `dsh-api-gateway/README.zh.md:52` |
| 10 | 每次只有一个 pending 请求拥有 composer 编辑器 | 已确认 | `dsh-client-ui-user-questions/README.zh.md:93` |
| 11 | pending 的 scoped waterfall 在重连后用同一 event id 重放 | 已确认 | `dsh-api-gateway/README.zh.md:74` |
| 12 | `ctx.remote.$on` 合法键 = `dsh-api-remotes` 里硬编码的 19 条白名单 | 已确认 | `dsh-api-remotes/lib/types/remote-events.d.ts:12-69` |
| 13 | Host 只有**一个** Remote 事件源槽位（`registerRemoteEvents`） | 已确认 | `dsh-api-gateway/README.zh.md:37` |
| 14 | 连第一方 cordis runner 的事件也需先写进该白名单 | 已确认 | `dsh-cordis-host-runner/README.zh.md:84` |
| 15 | 插件加自己的 Host→Client 事件类型**必须改随包的 `dsh-api-remotes`** | **推测** | 14 的直接推论；替换方案未验证 |
| 16 | ask_user 的 seam 词汇装不下棋盘（只有 options + custom 文本） | 已确认 | `dsh-user-questions/lib/types/types.d.ts:29-44`；README:66 |
| 17 | ask() 不校验 `intent.kind` 白名单，只校验 approve 命中 + detail 存在 | 已确认 | `dsh-user-questions/lib/index.js:61-66` |
| 18 | `intent` 被设计为可扩展标签，不认识的 UI 退化成通用流程 | 已确认 | `dsh-user-questions/lib/types/types.d.ts:11-27` |
| 19 | 随包的 `ask_user_question` 工具**不暴露** `detail`/`intent`，所以象棋要自写工具 | 已确认 | `dsh-tool-ask-user/lib/index.js:18-65,96-111` |
| 20 | 象棋的自定义 answerer 能否稳定注册在随包 UI **之前**（瀑布顺序） | **推测/未验证** | `ctx.remote.$on` 类型无 priority 参数 |
| 21 | `ctx.connection.rpc.handle(channel, handler)`（Host）+ `ctx.connection.rpc.call(...)`（Client）是通用认证 RPC | 已确认 | `dsh-client-connection/lib/types/rpc.d.ts:103-120,172-193` |
| 22 | `ctx.connection.fetch.register({path,methods,requestBody,fetch})` 挂 `/api` 下精确路由，认证已代劳 | 已确认 | 同上 `:80-102` |
| 23 | `ctx.webServer.register({kind,path,handler})` 可挂裸 HTTP 路由，但**不带认证** | 已确认 | `dsh-host-webserver/lib/types/index.d.ts:33-106`；README:113 |
| 24 | Host→Client 状态的正规通道是 `ctx.sessionProjections.register(def)` + 客户端 `useProjection(key)` | 已确认 | `dsh-session-projection/README.zh.md:36-65`；`@local/dsh-build-plan-mode-v2/lib/client.js:121,291` |
| 25 | 客户端→Host 可通过 `ctx.commands.register()` 注册的命令，客户端用 `session.command(line)` 或 `ctx.remote.commands.execute(...)` | 已确认 | `dsh-commands/README.zh.md:34-46`；`dsh-api-session-controller/lib/types/client/contract/session.d.ts:134-142`；build-plan-mode client.js:297 |
| 26 | `agent.followup(msg)` / `steer` / `inject` / `send` 是官方会话注入原语 | 已确认 | `dsh-agent/lib/types/runtime-types.d.ts:175-209` |
| 27 | `ctx.agents.get(sessionId)` 取活的 agent 句柄 | 已确认 | `dsh-agent/lib/types/index.d.ts:336-362` |
| 28 | 消息 source 是可合并扩展的（先例 `webhook`），也有现成 `{kind:'plugin', plugin}` | 已确认 | `dsh-llm/lib/types/message.d.ts:90-104`；`dsh-webhook/lib/types/types.d.ts:60-73` |
| 29 | `dsh-schedule` 用 `runMaintenance()` + `followup()` 唤醒运行中的根会话 | 已确认 | `dsh-schedule/README.zh.md:70,121-123` |
| 30 | `dsh-webhook` 的内置动作**只有**创建新会话，不注入已有会话 | 已确认 | `dsh-webhook/README.zh.md:12,71`；`lib/index.js:99-134` |
| 31 | webhook 规则回调可执行任意受信任代码，因此能自行 `agents.get(id).followup()` | **推测** | README:28「回调可以执行任意受信任代码」 |
| 32 | `session/prompt` Remote 能唤醒（甚至 resume 冷会话），但强制 `source.kind='user'` | 已确认 | `dsh-api-session-controller/lib/index.js:217-240,736-790` |
| 33 | `dsh plugin --profile web add` = 初始化 profile + pnpm add + 按已安装状态对账 `dsh.profile.bundles`；**不写 cordis.patch.yml** | 已确认 | `dsh/lib/plugin-Ddi42qoW.js:46-78,101-128` |
| 34 | 只有声明 `dsh.bundle.patch` 的依赖才会变成 profile layer；否则只打警告 | 已确认 | 同上 :25-33,46-59 |
| 35 | patch 语义：`insert` / `id` 改写 / **改 config 会整体替换** / 匹配不到只 warn | 已确认 | `cordis-plugin-include/lib/index.js:51-88`、`types/index.d.ts:28-39`；`dsh-web-app/cordis.patch.yml:5-6` |
| 36 | 层序：bundle → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` → telemetry | 已确认 | `dsh/lib/profile-boot-Dk-7KqJc.js:213-256` |
| 37 | 工具行应挂 agent preset；用户 preset 放 `<dshHome>/.agent-presets/<id>/` | 已确认 | `dsh-agent-presets/README.zh.md:36,53-60`；`presets/cordis/agent.cordis.yml:28` |
| 38 | client 半必须是**已构建**的 `window.__ModuleLoader__.load({id, factory})` bundle；缺了会大声失败 | 已确认 | `dsh-client-modules/README.zh.md:12,46`；`@local/dsh-hello-right-panel/lib/client.js:1-6` |
| 39 | `harness.handle`/`host.call` 是包私有 Client↔Host JSON RPC，但只给**动态 Cordis 包** | 已确认 | `dsh-cordis-client-runner/lib/client.js:181,5072-5079`；`SKILL.md:323-348` |
| 40 | 自建 Typert Remote namespace 需要生成器；本机未安装生成器 | 已确认（前半）/ **推测**（后半结论） | `dsh-typert-registry/README.zh.md:44`；`dsh-cordis-host-runner/package.json:25-31`；包清单里无 generator |
| 41 | `@local/dsh-hello-right-panel` 调用的 `ctx.layout.openDetails()`/`closeDetails()` 在 0.1.5-rc.2 **不存在** | 已确认 | 全盘 grep 零命中；`dsh-client-ui-layout/lib/types/client/service.d.ts:24-48` |
| 42 | 该面板大概率 mount 时抛 TypeError | **推测**（未实际加载） | 41 的直接推论 |
| 43 | 本版本右栏棋盘的正确落点是 `sidebar.right.pane.tab` + `ctx.sidebarRightTabs.register` + `ctx.sidebarRight.openTab` | 已确认 | `dsh-client-ui-sidebar-right/README.zh.md:77-89` |
| 44 | README 里提到的 `apps/cli/config/examples/*.yml` overlay **不在已安装的 npm 包里** | 已确认 | `dsh` 包 `files` 只含 `lib/*.js`；全盘无 `config/examples` 目录 |
| 45 | 象棋走「自建 RPC + 阻塞工具 + projection」是最可控路线 | **推测（我的判断）** | 综合以上 |

---

## 10. 我没能回答的问题（不编）

1. **`ctx.remote.$on` 的监听器顺序能否编程控制。** 类型里没有 priority。象棋若走路线 B，必须让自己的 answerer 抢在随包 `ui-user-questions` 之前，这一点**必须实测**，我无法从材料判定。
2. **`ctx.connection.rpc.handle` 注册的自定义通道，浏览器端 `ctx.connection.rpc.call` 是否真的通。** 类型和 disposer 描述（「removing the channel and its physical route」）强烈指向可以，但没有找到任何**已发布插件**使用这条路（file-upload 走的是 `fetch.register`，gateway 走的是 `registerInterceptor`）。需要跑一次才能确认 channel 的命名/路径规则与认证细节。
3. **客户端插件声明 `connection` 的 `inject` 写法是什么。** client `dsh.client.inject` 是「信息性包名依赖，不是 Cordis 服务注入」（`DshClientManifest.inject` 的注释），而 Cordis 的 `inject` 数组用的是服务名。两者关系我没查到。
4. **`details` slot 到底存不存在、由谁声明。** shipped skill 提到它是已知 root 级 slot，但我在已安装包里找不到声明；shipped client bundle 被打包过，字符串搜索不可靠。
5. **`@local/dsh-hello-right-panel` 的 client 半在 0.1.5-rc.2 下是否真的加载/渲染。** 我只确认了它调用的 API 不存在，没有实际启动 GUI 验证。
6. **用户经 `cordis.patch.yml` 手挂的本地包，其 `dsh.client` 半会不会被 `dsh-client-modules` 扫进 `window.__DSH_BOOT__`。** README 说它扫描「已启用的 Loader 条目」并「按 Loader specifier 与所属 tree base URL」解析 manifest，理论上覆盖，但那个包**没有** `dsh.bundle`（只有 `dsh.client`），两条扫描路径是否都认，我没有验证。
7. **pending user-question 请求有没有数量上限 / 并发上限。** 只确认了「编辑器一次只有一个」。
8. **`ask()` 对未知 `intent.kind` 真的完全不挡吗。** 代码路径（`dsh-user-questions/lib/index.js:61-66`）看起来是不挡，但那可能只是运行时；`AskUserQuestionIntent` 是闭合的 TS 联合（只有 `plan-review`），插件要加自己的 kind 得先 `declare module` 合并——**类型层面能不能合并这个联合，我没验证**。
9. **`ctx.webServer.register` 与 `ctx.connection.fetch.register` 的具体路径冲突规则**：README 说重复 `(kind,path)` 抛错，但 `/api/...` 这条前缀同时被 Connection 的共享 channel 占用，两者如何相处没写。
10. **Typert 生成器是否真的没装**、以及能否从源码仓库另取。我只据包清单判断（`dsh-typert-loader`/`-protocol`/`-registry` 在，generator 不在）。

---

## 附：本次读到的关键文件清单

```
dsh-tools/lib/types/schema.d.ts                                  defineTool 签名
dsh-tools/lib/types/index.d.ts                                   ToolDefinition / ToolRuntime / exec
dsh-tools/README.zh.md                                           工具作者约定、未声明 timeout
dsh-tool-ask-user/lib/index.js                                   ask_user_question 实现
dsh-tool-ask-user/README.zh.md                                   无超时、DELEGATED_CALLER
dsh-user-questions/lib/index.js                                  UserQuestionService.ask（waterfall + 校验）
dsh-user-questions/lib/types/types.d.ts                          AskUserQuestionItem/Option/Intent/Answer
dsh-user-questions/README.zh.md                                  词汇边界、错误码
dsh-client-ui-user-questions/lib/client.js                       $on 监听 + PendingQuestion + composer 接管
dsh-client-ui-user-questions/lib/types/client/contract/slots.d.ts PendingQuestion / planReviewOf
dsh-api-remotes/lib/types/remote-events.d.ts                     ★ 硬编码事件白名单
dsh-api-remotes/lib/index.js                                     转发循环 + RemoteEventQueue
dsh-api-gateway/README.zh.md                                     $on / $stream / 一元回送 / 唯一事件源
dsh-client-connection/lib/types/rpc.d.ts                         ★ HostConnectionRpc/Fetch、ClientConnectionRpc
dsh-client-connection/lib/types/rpc-host.d.ts                    HostConnectionService
dsh-client-connection/README.zh.md                               浏览器认证、/api 桥
dsh-host-webserver/lib/types/index.d.ts                          WebServer.register/registerUpgrade
dsh-host-webserver/README.zh.md                                  路由匹配顺序、无认证
dsh-client-modules/README.zh.md                                  client bundle 的构建与提供
dsh-agent/lib/types/runtime-types.d.ts                           ★ followup/steer/inject/send、runMaintenance
dsh-agent/lib/types/index.d.ts                                   AgentRegistry.get/list/roots
dsh-llm/lib/types/message.d.ts                                   createUserMessage、MessageSourceMap（可合并）
dsh-llm/lib/types/index.d.ts                                     followup/inject 的 Cordis 事件声明
dsh-schedule/README.zh.md                                        ★ 官方「唤醒运行中会话」先例
dsh-webhook/lib/index.js + README.zh.md                          只创建新会话 + followup 用法
dsh-webhook/lib/types/types.d.ts                                 MessageSourceMap 合并先例
dsh-session-projection/README.zh.md                              register/snapshot/wire/useProjection
dsh-api-session-controller/lib/index.js                          resolveAgent（含冷 resume）+ prompt
dsh-api-session-controller/lib/types/client/contract/session.d.ts ISession.command/prompt/cancel
dsh-commands/README.zh.md + lib/types/types.d.ts                 ctx.commands.register
dsh-cordis-host-runner/README.zh.md + lib/types/guard.d.ts       动态包沙箱、harness.handle 归一化
dsh-tool-call-timeout-policy/README.zh.md                        timeoutMs 如何被强制
dsh-cordis-client-runner/lib/client.js                           host.call → dynamicCordisRunner.invoke
dsh-tool-cordis/README.zh.md                                     cordis_* 工具集
dsh-typert-registry/README.zh.md                                 Typert 贡献注册
dsh-plugin-package-inventory-deepseek/README.zh.md               请求级包清单
dsh-host-plugin-inventory/README.zh.md                           pluginInventory/list（只读）
dsh/lib/bin.js                                                   dsh CLI 参数面（--profile/--patch/plugin）
dsh/lib/plugin-Ddi42qoW.js                                       ★ dsh plugin = pnpm 转发 + bundles 对账
dsh/lib/profile-boot-Dk-7KqJc.js                                 ★ patch 层序、live reload
dsh-app-boot/lib/types/profile.d.ts + index.d.ts                 Profile/PatchOptions 语义
dsh-package-manifest/lib/types/types.d.ts                        ★ DshManifest（bundle/client/profile）
cordis-plugin-include/lib/index.js + types/index.d.ts            ★ applyEntryPatches 真实语义
dsh-web-app/cordis.patch.yml                                     真实 entry id 清单（可 patch 目标）
dsh-agent-presets/presets/standard/agent.cordis.yml              tool-ask-user 行所在
dsh-agent-presets/presets/cordis/agent.cordis.yml                ★ 自修改 preset + 安装指导
dsh-agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md   ★ 平台/服务/slot 选择的官方指引
dsh-agent-presets/README.zh.md                                   用户 preset 根与默认值
dsh-client-ui-layout/lib/types/client/service.d.ts               ★ openRightbar/closeRightbar（无 openDetails）
dsh-client-ui-sidebar-right/README.zh.md                         ★ 右栏 tab 扩展席位
dsh-client-ui-conversation/README.zh.md                          ★ composer chain 接管范式
dsh-tool-present/lib/index.js                                    工具最小范例 + WeakMap 状态
dsh-tool-todo/lib/index.js                                       工具 + projection 范例
dsh-tool-call-timeout-policy/README.zh.md                        timeoutMs 如何被强制
%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml                    本机实际 patch 层
%USERPROFILE%\.dsh\profiles\web\package.json                        本机 profile 清单
%USERPROFILE%\.dsh\profiles\web\node_modules\@local\dsh-hello-right-panel\{package.json,lib\index.js,lib\client.js}   ★ 本机最小双面插件
%USERPROFILE%\.dsh\profiles\web\node_modules\@local\dsh-build-plan-mode-v2\{package.json,lib\index.js,lib\client.js}  ★ 本机完整双面插件
```
