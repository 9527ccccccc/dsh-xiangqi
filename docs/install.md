# 装进 DSH

这个仓库本身就是一个 DSH 插件包。装进 `web` profile 分两步，都不需要重启——profile 的 `patchReload` 是 `live`。

## 为什么不用 `dsh plugin add`

`dsh plugin --profile web add <包>` 是个纯转发器，它把参数交给 profile 目录里的 `pnpm`。本机没装 `pnpm`（`corepack` 有，但启用它会全局装一个 shim，动的是工具链），所以这条路走不通。

替代做法与本 profile 里已有的 `@local/*` 包一致：在 profile 的 `node_modules` 下放一个目录联接。联接给的是**活链接**——改仓库里的源码，DSH 那边直接生效；`lib/client.js` 的改动还会被 500ms 的 stat 轮询抓到，免刷新热重载。

## 安装

```powershell
# 1) 让 profile 能解析到这个包（活链接，改源码即时生效）
New-Item -ItemType Junction `
  -Path  "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-xiangqi" `
  -Target "<repo>"

# 2) 让仓库里的服务端半边能 bare import 宿主包
#    Node 解析联接时会取真实路径，然后从 <repo> 往上找 node_modules，
#    找不到 @deepseek-ai/*；所以要在仓库里放一条指回 profile 依赖的联接。
New-Item -ItemType Junction `
  -Path  "<repo>\node_modules" `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules"

# 3) 在 profile 的 patch 层里挂上这一行
#    $env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml
#    - insert:
#        - id: xiangqi
#          name: 'dsh-xiangqi'
```

第 2 步不做的话，`lib/index.js` 里任何 `import ... from '@deepseek-ai/...'` 都会以 `ERR_MODULE_NOT_FOUND` 失败——而且报错看上去像包没装，很容易查错方向。

profile 的 `package.json` 里记一条 `"dsh-xiangqi": "link:<repo>"`，说明这个依赖是链接进来的。

## 服务端半边为什么自己挂 HTTP 路由

面板要读局面、要落子，就得有一条从浏览器到宿主的通道。试过两条路：

1. **`ctx.connection.rpc.handle(channel, handler)`**（随包文档推荐的那条）——**走不通**。
   它内部是 `const owner = this.ctx; owner.effect(() => owner.webServer.register(route))`，
   而那个 `owner` 并不是调用方的上下文：实测它永远报
   `cannot get property "webServer" without inject`，即使我的 `inject` 里已经声明了 `webServer`。
2. **`ctx.webServer.register({kind: 'prefix', path, handler})`** —— 走通了。
   代价是认证要自己做，而这正好有现成的：`ctx.connection.requestRejection(req)`
   跑的是和内置 `/api` 通道同一套 Host/Origin 栅栏 + 浏览器会话认证。

所以本插件声明了三个硬依赖：

```js
export const inject = ['tools', 'connection', 'webServer'];
```

- **`connection` 的 `apply` 是 async 的**（里面 `await BrowserAuth.create(...)` 之后才
  `new HostConnectionService(...)`）。不声明它，自己的 `apply` 就会在服务注册之前跑，
  `ctx.connection` 是 undefined。
- **`webServer` 不声明的话，连注册路由的资格都没有**（Cordis 的 guard 会拦）。

## 装配失败会拖垮整个 GUI —— 所以 apply 里要套 try

踩过一次：漏声明 `webServer` 时，报错不是「这个插件挂了」，而是

```
dsh: plugin tree failed to load: failed to apply loader entry xiangqi (dsh-xiangqi)
```

**整个 Web 界面起不来。** 插件里任何在 `apply` 阶段抛出的错都是这个后果。
所以挂路由这类操作一律套 `try`：挂不上顶多让面板显示「连不上棋局」，不该拖垮宿主。

## 生效时机：**改了服务端半边必须重启 `dsh web`**

这是踩过的坑，记下来省得再踩：

- **浏览器半边是热的**。`dsh-client-hmr` 每 500ms `stat()` 一次每个 `lib/client.js`，改了自动重载，刷新都不用。
- **服务端半边不是**。`cordis-plugin-hmr` 只监视**配置文件**（`cordis.yml` / patch 层），不监视插件源码。把 patch 里的 `insert` 摘掉再插回来**也不会**重新加载它——模块已经进了 ESM 缓存。

所以改 `lib/index.js`、`lib/game.js` 或 `src/` 之后，**要重启 `dsh web`**。会话是落盘的，重启后能接着聊。

装好之后可以用启动信标确认它到底活没活：

```powershell
Get-Content <repo>\state\host.json
```

里面的 `pid` 应当是 `dsh web` 那个进程的。`rpc` 字段说明它有没有拿到 `connection` 服务——如果是 `false`，说明 RPC 通道没挂上，浏览器半边会连不上局面。

## 验证

```powershell
dsh --profile web --dump-config | Select-String -Pattern 'xiangqi' -Context 1,1
```

合成出来的插件树里应当出现：

```yaml
- id: xiangqi
  name: dsh-xiangqi
```

这一步只证明**配置层**挂上了。它是否真的画出来，要看 Web GUI：右侧栏的 tab 条上会多出一个「中国象棋」页，面板会自动展开。

## 回滚

把 `cordis.patch.yml` 里那段 `insert` 删掉即可（热生效），再删掉那个联接目录：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-xiangqi" -Force
```

`cordis.patch.yml.bak-before-xiangqi` 是这次改动前的备份。

## 常见坑

- **`dsh.client.platform` 必须是 `'web'`，且包必须导出 `./client`**。缺了 `./client` 会让激活**大声失败**，错误信息里带着包名和它找的路径。
- **浏览器半边只能 `require` 基座模块表里的东西**（React、Cordis、静态 UI 库）。要额外的模块得在 `dsh.client.external` 里声明。这个基座表是冻结的。
- **`lib/client.js` 必须是已构建的形态**——也就是 `window.__ModuleLoader__.load({id, factory})`。手写完全没问题（本仓库就是手写的，`@local/*` 也是），只要形态对。
- **tab 类型注册两阶段**：先 `ctx.sidebarRightTabs.register({id, kind, title, guide})`，再用 `id` 当 key 注册 `sidebar.right.pane.tab` 的正文。两处都要包在 `ctx.effect` 里，插件停用才会被撤干净。
