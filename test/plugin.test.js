// 插件装配测试。
//
// 浏览器半边是 `window.__ModuleLoader__.load({...})` 形式的 bundle，本来只能在页面里跑。
// 这里伪造 __ModuleLoader__、React、canvas 2D context 与 DOM 元素，把它在 Node 里真跑一遍：
// 注册接线对不对、面板组件渲染会不会抛、棋盘和棋子有没有真画出来、
// 以及轮询有没有真的打到宿主那条 RPC 通道上。
//
// 这样在没有浏览器的情况下也能验证插件，而不是靠读代码猜。

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CLIENT_PATH = path.join(here, '..', 'lib', 'client.js');

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
const view = (over = {}) => ({
  mode: 'game',
  fen: START_FEN,
  turn: 'red',
  inCheck: false,
  legalCount: 44,
  history: [],
  lastMove: null,
  hint: null,
  result: null,
  resultText: '',
  ...over,
});

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
    const context = fakeCanvasCtx();
    return {
      kind, style: {}, width: 0, height: 0, __ctx: context,
      getContext: () => context,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 340, height: 380 }),
    };
  }
  return { kind, style: {}, clientWidth: 320 };
}

/** client.js 是模块顶层副作用（调用 __ModuleLoader__.load），同一进程只会执行一次。 */
let captured = null;
let loadPromise = null;

function ensureLoaded() {
  if (!loadPromise) {
    globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition; } }, devicePixelRatio: 2 };
    loadPromise = import(pathToFileURL(CLIENT_PATH).href);
  }
  return loadPromise;
}

/** 一份可用的假 React：state 是固定值，effect 排队等着显式放行。 */
function makeReact(effects) {
  const jsx = (type, props) => {
    const node = { type, props: props || {} };
    if (props && props.ref) props.ref.current = fakeElement(type);
    return node;
  };
  return {
    jsx,
    react: {
      useRef: (initial) => ({ current: initial === undefined ? null : initial }),
      useState: (initial) => [initial, () => {}],
      useEffect: (fn) => { effects.push(fn); },
    },
  };
}

async function loadPlugin() {
  await ensureLoaded();
  assert.ok(captured, 'client.js 没有调用 window.__ModuleLoader__.load');
  const effects = [];
  const { jsx, react } = makeReact(effects);
  const fakeRequire = (name) => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx };
    throw new Error(`未预期的 require('${name}')`);
  };
  const exports = captured.factory(fakeRequire);
  return { definition: captured, exports, effects, jsx };
}

/** 假的 Cordis 上下文，记录所有注册，并给出一条假的 RPC 通道。 */
function fakeHostCtx(reply = () => ({ ok: true, value: view() })) {
  const log = { tabs: [], injected: [], registered: [], opened: [], effects: [], calls: [] };
  const ctx = {
    log,
    effect(fn, label) { log.effects.push(label); return fn(); },
    get() { return undefined; },
    sidebarRightTabs: {
      register(definition) { log.tabs.push(definition); return () => {}; },
    },
    slots: {
      inject(name, fn) { log.injected.push(name); return fn(); },
      register(options, Component) { log.registered.push({ options, Component }); return () => {}; },
    },
    sidebarRight: {
      openTab(kind) { log.opened.push(kind); return 'tab-1'; },
    },
    connection: {
      rpc: {
        call(channel, endpoint, payload) {
          log.calls.push({ channel, endpoint, payload });
          return Promise.resolve(reply(endpoint, payload));
        },
      },
    },
  };
  return ctx;
}

test('client.js 用包名注册进模块加载器，并导出 apply 与 inject', async () => {
  const { definition, exports } = await loadPlugin();
  assert.equal(definition.id, 'dsh-xiangqi');
  assert.equal(typeof exports.apply, 'function');
  // 不再需要 connection：面板是同源页面，直接 fetch 宿主的 /xiangqi 路由
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
  assert.equal(ctx.log.registered[0].options.key, type.id, '正文的 key 必须等于类型的 id');

  assert.deepEqual(ctx.log.opened, ['xiangqi'], '面板默认收起，必须主动打开');
  assert.equal(ctx.log.effects.length, 3, '三处注册都要包在 ctx.effect 里才能被撤掉');
});

test('正文注册带了 inject，把会话 id 注进组件——唤醒会话靠它', async () => {
  const { exports } = await loadPlugin();
  const ctx = fakeHostCtx();
  exports.apply(ctx);

  const options = ctx.log.registered[0].options;
  assert.equal(typeof options.inject, 'function', '要声明 inject，否则组件拿不到会话 id');
  assert.deepEqual(options.inject('session-abc'), { sessionId: 'session-abc' });
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

test('parseBoard 把 FEN 拆成 90 格', async () => {
  const { exports } = await loadPlugin();
  const { parseBoard } = exports.__test__;
  const cells = parseBoard(START_FEN);
  assert.equal(cells.length, 90);
  assert.equal(cells.filter(Boolean).length, 32);
  assert.deepEqual(cells[9 * 9 + 4], { color: 'red', type: 'K' });
  assert.deepEqual(cells[0 * 9 + 4], { color: 'black', type: 'K' });
  assert.equal(cells[5 * 9 + 4], null);
  assert.equal(parseBoard('').filter(Boolean).length, 0, '空 FEN 不该炸');
});

test('drawScene 把棋盘、32 枚棋子、楚河汉界都画出来', async () => {
  const { exports } = await loadPlugin();
  const { drawScene } = exports.__test__;
  const g = fakeCanvasCtx();
  drawScene(g, 38, START_FEN, view(), null);

  const texts = g.calls.filter(([name]) => name === 'fillText').map(([, args]) => args[0]);
  assert.ok(texts.includes('楚  河') && texts.includes('漢  界'));
  const pieceNames = ['帅', '将', '仕', '士', '相', '象', '马', '车', '炮', '兵', '卒'];
  const pieces = texts.filter((t) => pieceNames.includes(t));
  assert.equal(pieces.length, 32, `应当画出 32 枚棋子，实际 ${pieces.length} 枚`);
  assert.equal(pieces.filter((t) => t === '车').length, 4);
  assert.equal(pieces.filter((t) => t === '兵').length, 5);
  assert.equal(pieces.filter((t) => t === '卒').length, 5);
});

test('drawScene 会画出走过的落点圈', async () => {
  const { exports } = await loadPlugin();
  const { drawScene } = exports.__test__;
  const g = fakeCanvasCtx();
  drawScene(g, 38, START_FEN, view({ lastMove: { from: 79, to: 77 } }), null);
  // 落点圈是 stroke 出来的圆；没有 lastMove 时不该有这些圈
  const bare = fakeCanvasCtx();
  drawScene(bare, 38, START_FEN, view(), null);
  const arcs = (ctx) => ctx.calls.filter(([name]) => name === 'arc').length;
  assert.ok(arcs(g) > arcs(bare), '有 lastMove 时应当多画出落点圈');
});

test('drawScene 会画出支招箭头', async () => {
  const { exports } = await loadPlugin();
  const { drawScene } = exports.__test__;
  const withHint = fakeCanvasCtx();
  drawScene(withHint, 38, START_FEN, view({ hint: { from: 77, to: 47, notation: '炮二平五' } }), null);
  const without = fakeCanvasCtx();
  drawScene(without, 38, START_FEN, view(), null);
  // 箭头是实心三角：多出一次 closePath
  const closes = (ctx) => ctx.calls.filter(([name]) => name === 'closePath').length;
  assert.ok(closes(withHint) > closes(without), '有支招时应当多画出箭头');
});

test('drawScene 会画出选中圈与落点提示', async () => {
  const { exports } = await loadPlugin();
  const { drawScene } = exports.__test__;
  const g = fakeCanvasCtx();
  drawScene(g, 38, START_FEN, view(), { from: 77, targets: [47, 67] });
  const dots = g.calls.filter(([name, args]) => name === 'arc' && Math.abs(args[2] - 38 * 0.14) < 0.01);
  assert.equal(dots.length, 2, '两个落点应当各画一个提示点');
});

test('面板组件能渲染，且渲染时会向宿主轮询局面', async () => {
  const { exports, effects } = await loadPlugin();
  const ctx = fakeHostCtx();
  exports.apply(ctx);

  const Panel = ctx.log.registered[0].Component;
  const tree = Panel();
  assert.ok(tree, '面板组件必须返回节点');

  // 拦下 setInterval，别让轮询真的跑起来；同时伪造 fetch
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const realFetch = globalThis.fetch;
  const timers = [];
  const fetched = [];
  globalThis.setInterval = (fn) => { timers.push(fn); return timers.length; };
  globalThis.clearInterval = () => {};
  globalThis.fetch = (url, options) => {
    fetched.push({ url, options });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, value: view() }),
    });
  };
  try {
    for (const effect of effects) effect();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    globalThis.fetch = realFetch;
  }

  assert.equal(fetched.length, 1, '挂载时应当立刻拉一次局面');
  assert.equal(fetched[0].url, '/xiangqi/view');
  assert.equal(fetched[0].options.method, 'POST');
  assert.equal(timers.length, 1, '并且挂上一个定时器继续轮询');

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
  assert.ok(findCanvas(tree), '渲染树里应当有 canvas');
});

test('host 半边是合法模块且能被挂载', async () => {
  const mod = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href);
  assert.equal(mod.name, 'dsh-xiangqi');
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['tools', 'connection', 'webServer']);

  const registered = [];
  const ctx = {
    effect(fn) { return fn(); },
    get() { return undefined; },
    connection: { rpc: { handle() { return () => {}; } } },
    tools: { register(definition) { registered.push(definition.name); return () => {}; } },
  };
  assert.doesNotThrow(() => mod.apply(ctx));
  assert.equal(registered.length, 4);
});
