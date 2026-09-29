# 装进 DSH

这个仓库本身就是一个 DSH 插件包：`lib/index.js` 是 host 半边，`lib/client.js` 是浏览器半边。
装进 `web` profile 分三步。

下面的命令用的是 PowerShell，`$repo` 指你把这个仓库放在哪：

```powershell
$repo = "D:\code\xiangqi"                                  # ← 改成你的实际路径
$prof = "$env:USERPROFILE\.dsh\profiles\web"               # ← web profile 的位置
```

## 为什么不用 `dsh plugin add`

`dsh plugin --profile web add <包>` 是个纯转发器：它把参数原样交给 profile 目录里的 `pnpm`。
没装 `pnpm` 就走不通（`corepack` 里有一个，但启用它会全局装一个 shim，动的是你的工具链）。
装上 `pnpm` 之后这条路可用；不想动工具链的话，用下面的目录联接。

## 安装

```powershell
# 1) 让 profile 能解析到这个包（活链接：改仓库源码即时生效）
New-Item -ItemType Junction `
  -Path   "$prof\node_modules\dsh-xiangqi" `
  -Target $repo

# 2) 让仓库里的 host 半边能 bare import 宿主包
#    Node 解析目录联接时会取**真实路径**，然后从 $repo 往上找 node_modules，
#    找不到 @deepseek-ai/*；所以在仓库里放一条指回 profile 依赖的联接。
New-Item -ItemType Junction `
  -Path   "$repo\node_modules" `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules"

# 3) 在 profile 的 patch 层里挂上这一行
#    文件：$prof\cordis.patch.yml
#    - insert:
#        - id: xiangqi
#          name: 'dsh-xiangqi'

# 4) 重启 dsh web（见下方「生效时机」）
```

第 2 步不做的话，`lib/index.js` 里任何 `import ... from '@deepseek-ai/...'` 都会以
`ERR_MODULE_NOT_FOUND` 失败——而且报错看上去像「包没装」，很容易查错方向。

建议顺手在 profile 的 `package.json` 里记一条 `"dsh-xiangqi": "link:<仓库路径>"`，
说明这个依赖是链接进来的，不是从 registry 装的。

## host 半边为什么自己挂 HTTP 路由

面板要读局面、要落子，就得有一条从浏览器到宿主的通道。试过两条路：

1. **`ctx.connection.rpc.handle(channel, handler)`**（随包文档推荐的那条）——**走不通**。
   它内部是 `const owner = this.ctx; owner.effect(() => owner.webServer.register(route))`，
   而那个 `owner` 并不是调用方的上下文：实测它永远报
   `cannot get property "webServer" without inject`，即使 `inject` 里已经声明了 `webServer`。
2. **`ctx.webServer.register({kind: 'prefix', path, handler})`** —— 走通了。
   代价是认证要自己做，而这正好有现成的：`ctx.connection.requestRejection(req)`
   跑的是和内置 `/api` 通道同一套 Host/Origin 栅栏 + 浏览器会话认证。

所以本插件声明了三个硬依赖：

```js
export const inject = ['tools', 'connection', 'webServer'];
```

- **`connection` 的 `apply` 是 async 的**（里面 `await BrowserAuth.create(...)` 之后才
  `new HostConnectionService(...)`）。不声明它，自己的 `apply` 就会在服务注册之前跑，
  `ctx.connection` 是 `undefined`。
- **`webServer` 不声明的话，连注册路由的资格都没有**（Cordis 的 guard 会拦）。

## 装配失败会拖垮整个 GUI —— 所以 apply 里要套 try

踩过一次：漏声明 `webServer` 时，报错不是「这个插件挂了」，而是

```
dsh: plugin tree failed to load: failed to apply loader entry xiangqi (dsh-xiangqi)
```

**整个 Web 界面起不来。** 插件在 `apply` 阶段抛出的任何错都是这个后果。
所以挂路由这类操作一律套 `try`：挂不上顶多让面板显示「连不上棋局」，不该拖垮宿主。

## 生效时机：改了 host 半边必须重启 `dsh web`

- **浏览器半边是热的。** `dsh-client-hmr` 每 500ms `stat()` 一次每个 `lib/client.js`，
  改了自动重载，刷新都不用。
- **host 半边不是。** `cordis-plugin-hmr` 只监视**配置文件**（`cordis.yml` / patch 层），
  不监视插件源码。把 patch 里的 `insert` 摘掉再插回来**也不会**重新加载它——模块已经进了
  ESM 缓存。

所以改 `lib/index.js`、`lib/game.js` 或 `src/` 之后，**要重启 `dsh web`**。
棋局是落盘的，重启后能接着下。

## 验证

```powershell
# 1) 配置层挂上了没有
dsh --profile web --dump-config | Select-String -Pattern 'xiangqi' -Context 1,1
```

合成出来的插件树里应当出现 `- id: xiangqi` / `name: dsh-xiangqi`。这只证明**配置层**挂上了。

```powershell
# 2) 进程里真的活了吗（启动信标）
Get-Content "$repo\state\host.json"
```

`pid` 应当是 `dsh web` 那个进程的；`tools` 应当列出四个工具名。文件不存在说明 host 半边
没被加载——回去看第 3 步的 patch 行。

```powershell
# 3) 路由挂上了没有（未认证时 401 = 挂上了，404 = 没挂上）
Invoke-WebRequest http://127.0.0.1:3080/xiangqi/view -SkipHttpErrorCheck |
  Select-Object StatusCode
```

最后看 Web GUI：右侧栏的 tab 条上会多出一个「中国象棋」页。

## 回滚

把 `cordis.patch.yml` 里那段 `insert` 删掉（热生效），再删掉两个联接：

```powershell
Remove-Item "$prof\node_modules\dsh-xiangqi" -Force
Remove-Item "$repo\node_modules" -Force
```

`state/` 里存着棋局与信标，删不删随你——它不在版本库里。

## 常见坑

- **`dsh.client.platform` 必须是 `'web'`，且包必须导出 `./client`**。缺了 `./client`
  会让激活**大声失败**，错误信息里带着包名和它找的路径。
- **浏览器半边只能 `require` 基座模块表里的东西**（React、Cordis、静态 UI 库）。
  要额外的模块得在 `dsh.client.external` 里声明。这个基座表是冻结的。
- **`lib/client.js` 必须是已构建的形态**——也就是 `window.__ModuleLoader__.load({id, factory})`。
  手写完全没问题（本仓库就是手写的），只要形态对。
- **tab 类型注册是两阶段的**：先 `ctx.sidebarRightTabs.register({id, kind, title, guide})`，
  再用 `id` 当 key 注册 `sidebar.right.pane.tab` 的正文。两处都要包在 `ctx.effect` 里，
  插件停用才会被撤干净。
