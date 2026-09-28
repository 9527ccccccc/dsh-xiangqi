// 插件装配测试。
//
// 浏览器半边是 `window.__ModuleLoader__.load({...})` 形式的 bundle，本来只能在页面里跑。
// 这里伪造 __ModuleLoader__、React、canvas 2D context 与 DOM 元素，把它在 Node 里真跑一遍：
// 注册接线对不对、面板组件渲染会不会抛、棋盘和 32 枚棋子有没有真画出来。
//
// 这样在没有浏览器的情况下也能验证插件，而不是靠读代码猜。

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CLIENT_PATH = path.join(here, '..', 'lib', 'client.js');

/** 记录所有调用与赋值的假 2D context。 */
function fakeCanvasCtx() {
  const calls = [];
  const base = {
    calls,
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => { calls.push([prop, args]); };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

function fakeElement(kind) {
  if (kind === 'canvas') {
    const ctx = fakeCanvasCtx();
    return {
      kind, style: {}, width: 0, height: 0, __ctx: ctx,
      getContext: () => ctx,
    };
  }
  return { kind, style: {}, clientWidth: 320 };
}

/** client.js 是模块顶层副作用（调用 __ModuleLoader__.load），同一进程只会执行一次。 */
let captured = null;
let loadPromise = null;

function ensureLoaded() {
  if (!loadPromise) {
    globalThis.window = {
      __ModuleLoader__: { load: (definition) => { captured = definition; } },
      devicePixelRatio: 2,
      ResizeObserver: undefined,
    };
    loadPromise = import(pathToFileURL(CLIENT_PATH).href);
  }
  return loadPromise;
}

/** 把 jsx 出来的树里的 ref 挂上假元素，好让 useEffect 里的绘制真的跑起来。 */
async function loadPlugin() {
  await ensureLoaded();
  assert.ok(captured, 'client.js 没有调用 window.__ModuleLoader__.load');

  const jsx = (type, props) => {
    const node = { type, props: props || {} };
    if (props && props.ref) props.ref.current = fakeElement(type);
    return node;
  };
  // 真 React 在渲染提交之后才跑 effect，那时 ref 已经挂上了。
  // 所以这里先把 effect 排队，等组件函数返回、jsx 树建好之后再放。
  const pending = [];
  const react = {
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    useEffect: (fn) => { pending.push(fn); },
  };
  const fakeRequire = (name) => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx };
    throw new Error(`未预期的 require('${name}')`);
  };
  const flush = () => {
    const running = pending.splice(0, pending.length);
    for (const fn of running) fn();
  };
  return { definition: captured, exports: captured.factory(fakeRequire), flush };
}

/** 假的 Cordis 上下文，记录所有注册。 */
function fakeHostCtx() {
  const log = { tabs: [], injected: [], registered: [], opened: [], effects: [] };
  return {
    log,
    effect(fn, label) {
      log.effects.push(label);
      return fn();
    },
    sidebarRightTabs: {
      register(definition) { log.tabs.push(definition); return () => {}; },
    },
    slots: {
      inject(name, fn) { log.injected.push(name); return fn(); },
      register(options, Component) {
        log.registered.push({ options, Component });
        return () => {};
      },
    },
    sidebarRight: {
      openTab(kind) { log.opened.push(kind); return 'tab-1'; },
    },
  };
}

test('client.js 用包名注册进模块加载器，并导出 apply 与 inject', async () => {
  const { definition, exports } = await loadPlugin();
  assert.equal(definition.id, 'dsh-xiangqi');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots', 'sidebarRightTabs', 'sidebarRight']);
});

test('apply 注册 tab 类型、正文，并主动打开右栏', async () => {
  const { exports } = await loadPlugin();
  const ctx = fakeHostCtx();
  exports.apply(ctx);

  assert.equal(ctx.log.tabs.length, 1, '应当只注册一个 tab 类型');
  const type = ctx.log.tabs[0];
  assert.equal(type.id, 'dsh-xiangqi', '类型 id 必须唯一且非空');
  assert.equal(type.kind, 'xiangqi');
  assert.equal(type.title(), '中国象棋');
  assert.ok(Array.isArray(type.guide) && type.guide.length >= 1, '要给出引导页入口，否则用户找不到它');

  assert.deepEqual(ctx.log.injected, ['sidebar.right.pane.tab']);
  assert.equal(ctx.log.registered.length, 1);
  assert.equal(ctx.log.registered[0].options.name, 'sidebar.right.pane.tab');
  assert.equal(
    ctx.log.registered[0].options.key,
    type.id,
    '正文的 key 必须等于类型的 id，否则席位渲染不出来',
  );

  assert.deepEqual(ctx.log.opened, ['xiangqi'], '面板默认收起，必须主动打开');
  assert.equal(ctx.log.effects.length, 3, '三处注册都要包在 ctx.effect 里才能被撤掉');
});

test('右栏打不开时不抛错，只警告（没有活跃会话就是这种情况）', async () => {
  const { exports } = await loadPlugin();
  const ctx = fakeHostCtx();
  ctx.sidebarRight.openTab = () => { throw new Error('no active session'); };
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.doesNotThrow(() => exports.apply(ctx));
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no active session/);
});

test('面板组件渲染时把棋盘与 32 枚棋子真画出来', async () => {
  const { exports, flush } = await loadPlugin();
  const ctx = fakeHostCtx();
  exports.apply(ctx);

  const Panel = ctx.log.registered[0].Component;
  const tree = Panel();
  assert.ok(tree, '面板组件必须返回节点');
  flush();

  // 从渲染树里找到那个 canvas 的假 context，检查它收到了什么
  const findCanvas = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'canvas') return node.props.ref.current;
    const children = node.props && node.props.children;
    for (const child of Array.isArray(children) ? children : [children]) {
      const hit = findCanvas(child);
      if (hit) return hit;
    }
    return null;
  };
  const canvas = findCanvas(tree);
  assert.ok(canvas, '渲染树里没有 canvas');
  assert.ok(canvas.width > 0 && canvas.height > 0, 'canvas 没有按尺寸初始化');

  const calls = canvas.__ctx.calls;
  const texts = calls.filter(([name]) => name === 'fillText').map(([, args]) => args[0]);
  assert.ok(texts.includes('楚  河') && texts.includes('漢  界'), '棋盘上的楚河汉界没画出来');

  const pieceNames = ['帅', '将', '仕', '士', '相', '象', '马', '车', '炮', '兵', '卒'];
  const pieces = texts.filter((t) => pieceNames.includes(t));
  assert.equal(pieces.length, 32, `应当画出 32 枚棋子，实际 ${pieces.length} 枚`);
  assert.equal(pieces.filter((t) => t === '车').length, 4, '开局四枚车');
  assert.equal(pieces.filter((t) => t === '兵').length, 5, '红方五个兵');
  assert.equal(pieces.filter((t) => t === '卒').length, 5, '黑方五个卒');

  // devicePixelRatio = 2，所以画布物理像素应是逻辑尺寸的两倍
  const transform = calls.filter(([name]) => name === 'setTransform').pop();
  assert.deepEqual(transform[1].slice(0, 4), [2, 0, 0, 2], '要按 devicePixelRatio 缩放');
});

test('host 半边是合法模块且能被挂载', async () => {
  const mod = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href);
  assert.equal(mod.name, 'dsh-xiangqi');
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['tools']);

  // 用一个最小的假 ctx 挂一遍：真正驱动四个工具的测试在 host.test.js
  const registered = [];
  const ctx = {
    effect(fn) { return fn(); },
    tools: { register(definition) { registered.push(definition.name); return () => {}; } },
  };
  assert.doesNotThrow(() => mod.apply(ctx));
  assert.equal(registered.length, 4);
});
