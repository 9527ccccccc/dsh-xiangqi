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
