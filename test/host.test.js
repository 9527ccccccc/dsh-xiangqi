// 服务端半边（host）的装配与工具测试。
//
// 用假 ctx 把插件挂起来，然后直接驱动工具的 execute——这正是 DSH 调用工具的
// 那条路径（defineTool 编译出的 schema 会先校验入参，再进 execute）。
// 所以这一层测到的不是「我的函数对不对」，而是「工具契约对不对」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply, name, inject } from '../lib/index.js';
import { RED, idx, emptyPosition } from '../src/board.js';
import { newGame, serializeGame } from '../lib/game.js';

/**
 * 驱动宿主那条 HTTP 路由一次。
 *
 * 宿主用的是 ctx.webServer.register 挂的裸 node:http 路由，所以这里造一对最小
 * 的 req/res：req 是事件发射器（路由会 req.on('data'/'end')），res 只要
 * writeHead/end 并把响应收下来。
 */
function hitRoute(route, endpoint, payload) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = `/xiangqi/${endpoint}`;
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
      end(body) {
        this.body = body || '';
        let parsed = null;
        try { parsed = JSON.parse(this.body); } catch { /* 非 JSON 响应保持 null */ }
        resolve({ status: this.statusCode, body: this.body, json: parsed });
      },
    };
    try {
      route.handler(req, res);
    } catch (error) {
      reject(error);
      return;
    }
    req.emit('data', Buffer.from(JSON.stringify(payload === undefined ? {} : payload)));
    req.emit('end');
  });
}

/** 挂一份全新的插件实例：棋局状态挂在插件实例上，所以每个用例都要新挂一次。 */
function mount(stateDir) {
  // 每个实例一个独立的状态目录，免得用例之间通过存盘文件互相串。
  const dir = stateDir || mkdtempSync(path.join(tmpdir(), 'xq-test-'));
  process.env.DSH_XIANGQI_STATE_DIR = dir;
  const tools = new Map();
  const routes = new Map();
  const effects = [];
  /** 假的 Agent：只记下被喂了什么，不真的驱动回合。 */
  const agent = {
    followups: [],
    followup(message) { this.followups.push(message); },
  };
  const ctx = {
    effect(fn, label) { effects.push(label); return fn(); },
    get(serviceName) {
      if (serviceName === 'agents') {
        // 默认任何 id 都能找到（真实注册表就是这样，找不到才返回 undefined）。
        // 要模拟「查无此会话」的用例自己覆盖 ctx.get。
        return { get() { return agent; } };
      }
      return undefined;
    },
    webServer: {
      register(route) { routes.set(route.path, route); return () => {}; },
    },
    connection: {
      // 假装的认证栅栏：放行
      requestRejection() { return undefined; },
    },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => {}; },
    },
  };
  apply(ctx);
  return {
    tools,
    effects,
    routes,
    agent,
    ctx,
    stateDir: dir,
    /** 走浏览器半边的那条路：同一个 handler，同一个返回形状。 */
    call: (endpoint, payload) => hitRoute(routes.get('/xiangqi'), endpoint, payload).then((r) => r.json),
    /** 走会话工具那条路。exec 里的 agent.session.id 决定动哪一盘棋。 */
    run: (toolName, args = {}, sessionId) => tools.get(toolName).execute(
      args,
      sessionId ? { agent: { session: { id: sessionId } } } : {},
    ),
    text: async (toolName, args, sessionId) => {
      const tool = tools.get(toolName);
      const exec = sessionId ? { agent: { session: { id: sessionId } } } : {};
      const value = await tool.execute(args, exec);
      return tool.output.render(args, value).map((block) => block.text).join('\n');
    },
  };
}

test('插件声明了名字，以及 tools / connection / webServer 三个硬依赖', () => {
  assert.equal(name, 'dsh-xiangqi');
  // 三个都是踩过坑才知道的：
  //   connection 的 apply 是 async 的，不声明它就会在服务注册之前跑；
  //   webServer 是挂路由用的，不声明的话连注册路由的资格都没有。
  assert.deepEqual(inject, ['tools', 'connection', 'webServer']);
});

test('四个工具都注册上了，且每个都包在 ctx.effect 里', () => {
  const { tools, effects } = mount();
  assert.deepEqual([...tools.keys()].sort(), [
    'xiangqi_board', 'xiangqi_hint', 'xiangqi_move', 'xiangqi_undo',
  ]);
  // 四个工具 + 一条 HTTP 路由
  assert.equal(effects.length, 5);
  assert.ok(effects.includes('dsh-xiangqi: http route'));
  for (const label of effects.filter((l) => l.includes('xiangqi_') || l.includes('tools'))) {
    assert.match(label, /^dsh-xiangqi: /);
  }
});

test('HTTP 路由挂在 /xiangqi 上，并且是前缀匹配', () => {
  const { routes } = mount();
  assert.deepEqual([...routes.keys()], ['/xiangqi']);
  assert.equal(routes.get('/xiangqi').kind, 'prefix');
  assert.equal(typeof routes.get('/xiangqi').handler, 'function');
});

test('没有通过认证栅栏的请求被挡在外面', async () => {
  const { routes, ctx } = mount();
  ctx.connection.requestRejection = () => 401;
  const response = await hitRoute(routes.get('/xiangqi'), 'view', {});
  assert.equal(response.status, 401);
  assert.equal(response.body, 'unauthorized');
});

test('非 POST 的请求被拒', async () => {
  const { routes } = mount();
  const route = routes.get('/xiangqi');
  const response = await new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = '/xiangqi/view';
    const res = {
      statusCode: 0,
      body: '',
      writeHead(code) { this.statusCode = code; return this; },
      end(body) { this.body = body || ''; resolve({ status: this.statusCode, body: this.body }); },
    };
    route.handler(req, res);
  });
  assert.equal(response.status, 405);
});

test('webServer 不可用时不硬挂路由，也不抛错', async () => {
  const tools = new Map();
  const ctx = {
    effect(fn) { return fn(); },
    get() { return undefined; },
    webServer: undefined, // Cordis 不该让这种情况发生，但真发生了也不能炸
    connection: undefined,
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
  };

  assert.doesNotThrow(() => apply(ctx));
  assert.equal(tools.size, 4, '工具照样要注册好');
  const result = await tools.get('xiangqi_board').execute({}, {});
  assert.equal(result.turn, 'red', '棋局能力不依赖 webServer');
});

test('浏览器半边读局面：view 返回的就是 gameView', async () => {
  const result = await mount().call('view', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.turn, 'red');
  assert.equal(result.value.legalCount, 44);
  assert.equal(result.value.mode, 'game');
  assert.match(result.value.fen, /^rnbakabnr\//);
  assert.deepEqual(result.value.history, []);
});

test('浏览器半边落子：move 返回新局面与这一步的记谱', async () => {
  const { call } = mount();
  const result = await call('move', { move: '炮二平五' });
  assert.equal(result.ok, true);
  assert.equal(result.value.notation, '炮二平五');
  assert.equal(result.value.turn, 'black');
  assert.deepEqual(result.value.history, ['炮二平五']);

  const after = await call('view', {});
  assert.equal(after.value.turn, 'black', '轮询要能看到变化');
});

test('浏览器半边走非法着法：返回 ok:false 并带上原因', async () => {
  const result = await mount().call('move', { move: '帅五进三' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /合法着法有/);
});

test('未知接口返回 ok:false，而不是把异常穿出去', async () => {
  const result = await mount().call('乱写的接口', {});
  assert.equal(result.ok, false);
  assert.match(result.error.message, /未知的接口/);
});

test('浏览器半边的 moves：给一个交叉点，列出落点', async () => {
  const result = await mount().call('moves', { from: '7,7' });
  assert.equal(result.ok, true);
  const notations = result.value.targets.map((t) => t.notation);
  assert.ok(notations.includes('炮二平五'));
  assert.ok(result.value.targets.every((t) => Number.isInteger(t.to)));
});

test('浏览器半边的 hint 与 undo', async () => {
  const { call } = mount();
  await call('hint', { move: '炮二平五' });
  const hinted = await call('view', {});
  assert.equal(hinted.value.hint.notation, '炮二平五');

  await call('move', { move: '炮二平五' });
  const undone = await call('undo', {});
  assert.equal(undone.ok, true);
  assert.equal(undone.value.turn, 'red');
  assert.deepEqual(undone.value.history, []);
});

test('工具与浏览器半边共用同一盘棋', async () => {
  const { run, call } = mount();
  await run('xiangqi_move', { move: '炮二平五' });   // 会话走
  const seen = await call('view', {});
  assert.equal(seen.value.turn, 'black', '会话走的子，面板要能看见');
  await call('move', { move: '马8进7' });             // 人走
  const board = await run('xiangqi_board');
  assert.match(board.report, /着法：1\.炮二平五 2\.马8进7/);
});

// ------------------------------------------------------------------ 按会话分开

test('棋局跟着会话走：两个会话各有各的一盘棋', async () => {
  const { call } = mount();
  await call('move', { move: '炮二平五', sessionId: '会话甲' });

  const a = await call('view', { sessionId: '会话甲' });
  assert.equal(a.value.turn, 'black');
  assert.deepEqual(a.value.history, ['炮二平五']);

  const b = await call('view', { sessionId: '会话乙' });
  assert.equal(b.value.turn, 'red', '换个对话应当是另一盘棋，还在开局');
  assert.deepEqual(b.value.history, []);
});

test('会话工具动的是调用它的那个会话的棋局', async () => {
  const { call, run } = mount();
  await call('move', { move: '炮二平五', sessionId: '甲' });

  const board甲 = await run('xiangqi_board', {}, '甲');
  assert.match(board甲.report, /着法：1\.炮二平五/);

  const board乙 = await run('xiangqi_board', {}, '乙');
  assert.deepEqual(board乙.legal.length, 44, '乙会话应当还在开局');

  // 乙会话走自己的
  await run('xiangqi_move', { move: '马八进七' }, '乙');
  const b2 = await call('view', { sessionId: '乙' });
  assert.deepEqual(b2.value.history, ['马八进七']);
  const a2 = await call('view', { sessionId: '甲' });
  assert.deepEqual(a2.value.history, ['炮二平五'], '甲会话不该被乙会话影响');
});

test('悔棋也只退自己会话的那一盘', async () => {
  const { call, run } = mount();
  await call('move', { move: '炮二平五', sessionId: '甲' });
  await call('move', { move: '马八进七', sessionId: '乙' });

  await run('xiangqi_undo', {}, '甲');
  const a = await call('view', { sessionId: '甲' });
  assert.deepEqual(a.value.history, [], '甲悔干净了');
  const b = await call('view', { sessionId: '乙' });
  assert.deepEqual(b.value.history, ['马八进七'], '乙没被牵连');
});

test('重开一局：该会话回到全新开局，别的会话不受影响', async () => {
  const { call } = mount();
  await call('move', { move: '炮二平五', sessionId: '甲' });
  await call('move', { move: '马8进7', sessionId: '甲' });
  await call('move', { move: '马八进七', sessionId: '乙' });

  const fresh = await call('reset', { sessionId: '甲' });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.value.reset, true);
  assert.deepEqual(fresh.value.history, []);
  assert.equal(fresh.value.turn, 'red');
  assert.equal(fresh.value.legalCount, 44, '应当回到标准开局的 44 个合法着法');
  assert.match(fresh.value.fen, /^rnbakabnr\//);
  assert.equal(fresh.value.resultText, '');

  const still = await call('view', { sessionId: '甲' });
  assert.deepEqual(still.value.history, [], '轮询看到的也是新开的一局');

  const b = await call('view', { sessionId: '乙' });
  assert.deepEqual(b.value.history, ['马八进七'], '乙那盘不该被动');
});

test('重开的局面也会落盘，重启后还是新开那一局', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xq-reset-'));
  try {
    const before = mount(dir);
    await before.call('move', { move: '炮二平五', sessionId: '甲' });
    await before.call('reset', { sessionId: '甲' });

    const after = mount(dir);
    const restored = await after.call('view', { sessionId: '甲' });
    assert.deepEqual(restored.value.history, [], '重开之后即使重启也还是新开的一局');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有会话 id 时落到公共兜底盘（子代理或直接调工具的情况）', async () => {
  const { call, run } = mount();
  await run('xiangqi_move', { move: '炮二平五' });       // 无 exec.agent
  const fallback = await call('view', {});                 // 面板也没带 id
  assert.deepEqual(fallback.value.history, ['炮二平五']);

  // 而带了 id 的面板看的是它自己那盘
  const withId = await call('view', { sessionId: '某个会话' });
  assert.deepEqual(withId.value.history, []);
});

test('重启之后棋局还在：新挂载的实例从同一份存盘里读回来', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xq-persist-'));
  try {
    const before = mount(dir);
    await before.call('move', { move: '炮二平五', sessionId: '甲' });
    await before.call('move', { move: '马8进7', sessionId: '甲' });

    // 模拟 dsh web 重启：全新实例、同一份状态目录
    const after = mount(dir);
    const restored = await after.call('view', { sessionId: '甲' });
    assert.deepEqual(restored.value.history, ['炮二平五', '马8进7'], '重启不该把正在下的棋弄丢');
    assert.equal(restored.value.turn, 'red');

    // 别的会话不受影响
    const other = await after.call('view', { sessionId: '乙' });
    assert.deepEqual(other.value.history, []);

    // 接着下也没问题
    const board = await after.run('xiangqi_board', {}, '甲');
    assert.match(board.report, /着法：1\.炮二平五 2\.马8进7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 唤醒会话

test('人将死会话时，会话照样被唤醒，而且被告知结果', async () => {
  // 这一条是补出来的：原来终局时我故意不唤醒，理由是「没子可走了」。
  // 结果是人将死我之后我根本不知道，人还得跟一个不承认输的对手掰扯。
  const dir = mkdtempSync(path.join(tmpdir(), 'xq-mate-'));
  try {
    // 预置一个红方一步将死的局面：红车 (0,5) 走到 (0,0) 即成绝杀
    const position = emptyPosition(RED);
    for (const [col, row, color, type] of [
      [4, 9, 'red', 'K'], [4, 5, 'red', 'R'], [0, 5, 'red', 'R'],
      [4, 0, 'black', 'K'], [4, 1, 'black', 'A'],
    ]) position.cells[idx(col, row)] = { color, type };
    writeFileSync(
      path.join(dir, 'games.json'),
      JSON.stringify({ mate: serializeGame(newGame('game', position)) }),
    );

    const { call, agent } = mount(dir);
    const result = await call('move', { from: idx(0, 5), to: idx(0, 0), sessionId: 'mate' });

    assert.equal(result.ok, true);
    assert.equal(result.value.resultText, '红方胜（将死）');
    assert.equal(result.value.wake.woken, true, '终局也必须唤醒会话');
    assert.equal(result.value.wake.finished, true);
    assert.equal(agent.followups.length, 1);

    const text = agent.followups[0].content[0].text;
    assert.match(text, /这盘到此结束/);
    assert.match(text, /红方胜（将死）/);
    assert.match(text, /不要质疑这个结果/, '要明确告诉会话这是规则判的，不许含糊');
    assert.match(agent.followups[0].source.summary, /红方胜（将死）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('人在面板上落子会唤醒会话接招', async () => {
  const { call, agent } = mount();
  const result = await call('move', { from: idx(7, 7), to: idx(4, 7), sessionId: 'live-session' });

  assert.equal(result.ok, true);
  assert.equal(result.value.notation, '炮二平五');
  assert.equal(result.value.wake.woken, true);
  assert.equal(agent.followups.length, 1, '应当正好唤醒一次');
  const message = agent.followups[0];
  assert.equal(message.role, 'user');
  assert.match(message.content[0].text, /炮二平五/);
  assert.match(message.content[0].text, /轮到你走/);
  assert.equal(message.source.kind, 'plugin');
  assert.equal(message.source.plugin, 'xiangqi');
});

test('会话自己用工具落子绝不唤醒自己（否则会自己跟自己下棋）', async () => {
  const { run, agent } = mount();
  await run('xiangqi_move', { move: '炮二平五' });
  assert.equal(agent.followups.length, 0, '工具路径不许唤醒');
  await run('xiangqi_move', { move: '马8进7' });
  assert.equal(agent.followups.length, 0);
});

test('面板没带会话 id 时不唤醒，并说清楚原因', async () => {
  const { call, agent } = mount();
  const result = await call('move', { from: idx(7, 7), to: idx(4, 7) });
  assert.equal(result.value.wake.woken, false);
  assert.match(result.value.wake.reason, /会话 id/);
  assert.equal(agent.followups.length, 0);
});

test('会话 id 对不上时不唤醒，并说清楚原因', async () => {
  const { call, agent, ctx } = mount();
  // 让注册表认不出这个会话
  ctx.get = (serviceName) => (serviceName === 'agents' ? { get: () => undefined } : undefined);
  const result = await call('move', { from: idx(7, 7), to: idx(4, 7), sessionId: '查无此会话' });
  assert.equal(result.value.wake.woken, false);
  assert.match(result.value.wake.reason, /没找到会话/);
  assert.equal(agent.followups.length, 0);
});

test('轮到人走的时候，会话经 HTTP 走子也不会把自己叫醒', async () => {
  const { call, agent } = mount();
  // 开局是红（人）走。红走完轮到黑（会话），这一步按说是人走的，但我们直接指定
  // sessionId 模拟异常路径：黑走完之后轮到红，就不该唤醒。
  await call('move', { from: idx(7, 7), to: idx(4, 7), sessionId: 'live-session' });
  assert.equal(agent.followups.length, 1, '人走完轮到会话，这一下该唤醒');

  const second = await call('move', { from: idx(1, 0), to: idx(2, 2), sessionId: 'live-session' });
  assert.equal(second.ok, true);
  assert.equal(second.value.turn, 'red');
  assert.equal(second.value.wake.woken, false);
  assert.match(second.value.wake.reason, /还没轮到会话走/);
  assert.equal(agent.followups.length, 1, '轮到人走的时候不该再唤醒');
});

test('整条对局循环：人走 → 唤醒 → 会话接招 → 再轮到人', async () => {
  const { call, run, agent } = mount();
  // 人心血来潮先手
  await call('move', { from: idx(7, 7), to: idx(4, 7), sessionId: 'live-session' });
  assert.equal(agent.followups.length, 1);

  // 会话被唤醒后照做
  const reply = await run('xiangqi_move', { move: '马8进7' }, 'live-session');
  assert.equal(reply.ok, true);
  assert.equal(reply.turn, 'red');

  // 人再走一步，应当再唤醒一次
  await call('move', { from: idx(7, 9), to: idx(6, 7), sessionId: 'live-session' });
  assert.equal(agent.followups.length, 2);

  const board = await run('xiangqi_board', {}, 'live-session');
  assert.match(board.report, /着法：1\.炮二平五 2\.马8进7 3\.马二进三/);
});

test('工具的参数与输出 schema 编译成了 JSON Schema', () => {
  const { tools } = mount();
  const move = tools.get('xiangqi_move');
  assert.equal(move.parameters.type, 'object');
  assert.equal(move.parameters.properties.move.type, 'string');
  assert.ok(move.parameters.required.includes('move'));
  assert.equal(move.output.schema.type, 'object');
  assert.equal(move.output.schema.additionalProperties, false);
  assert.deepEqual(move.output.schema.properties.turn.enum, ['red', 'black']);
});

test('传入非法参数类型时，在进 execute 之前就被 schema 拦下', async () => {
  const { run } = mount();
  await assert.rejects(() => run('xiangqi_move', { move: 123 }), /move|string/);
  await assert.rejects(() => run('xiangqi_move', {}), /move/);
});

test('读局面：开局是红先、44 个合法着法、未被将军', async () => {
  const value = await mount().run('xiangqi_board');
  assert.equal(value.turn, 'red');
  assert.equal(value.inCheck, false);
  assert.equal(value.resultText, '');
  assert.equal(value.legal.length, 44);
  assert.match(value.fen, /^rnbakabnr\//);
  assert.match(value.report, /轮到：红方/);
  assert.match(value.report, /帅/);
});

test('读局面时给一个交叉点，会列出这枚子的合法着法', async () => {
  const value = await mount().run('xiangqi_board', { from: '7,7' });
  assert.match(value.report, /\(7,7\) 这枚子能走：/);
  assert.match(value.report, /炮二平五/);
});

test('坐标写错时报错，而不是悄悄当成别的点', async () => {
  await assert.rejects(() => mount().run('xiangqi_board', { from: '7;7' }), /交叉点应写成/);
  await assert.rejects(() => mount().run('xiangqi_board', { from: '9,9' }), /越界/);
});

test('走一步：ok、记谱、轮次都对，棋盘也跟着变', async () => {
  const { run, text } = mount();
  const value = await run('xiangqi_move', { move: '炮二平五' });
  assert.equal(value.ok, true);
  assert.equal(value.notation, '炮二平五');
  assert.equal(value.turn, 'black');
  assert.match(value.report, /轮到：黑方/);
  assert.match(await text('xiangqi_move', { move: '马8进7' }), /已走：马8进7/);
});

test('走坐标同样收', async () => {
  const value = await mount().run('xiangqi_move', { move: 'h7-e7' });
  assert.equal(value.ok, true);
  assert.equal(value.notation, '炮二平五');
});

test('非法着法不让工具失败，而是 ok:false 并说明能走到哪', async () => {
  const value = await mount().run('xiangqi_move', { move: '帅五进三' });
  assert.equal(value.ok, false);
  assert.equal(value.notation, '');
  assert.match(value.report, /这一步走不了/);
  assert.match(value.report, /合法着法有/);
  assert.equal(value.turn, 'red', '局面不该被动过');
});

test('悔棋：走一步后能悔回来', async () => {
  const { run } = mount();
  await run('xiangqi_move', { move: '炮二平五' });
  const value = await run('xiangqi_undo');
  assert.equal(value.ok, true);
  assert.equal(value.undone, 1);
  assert.match(value.report, /现在轮到红方走/);

  const board = await run('xiangqi_board');
  assert.equal(board.legal.length, 44, '悔完应当回到开局');
});

test('没走过棋时悔棋返回 ok:false 而不是抛错', async () => {
  const value = await mount().run('xiangqi_undo');
  assert.equal(value.ok, false);
  assert.match(value.report, /没什么可悔/);
});

test('支招：设上、清除，并在棋盘视图里能读到', async () => {
  const { run } = mount();
  const set = await run('xiangqi_hint', { move: '炮二平五' });
  assert.equal(set.ok, true);
  assert.equal(set.hint, '炮二平五');
  assert.match(set.report, /高亮支招/);

  const clear = await run('xiangqi_hint', {});
  assert.equal(clear.ok, true);
  assert.equal(clear.hint, '');
  assert.match(clear.report, /已清除/);
});

test('支招给非法着法返回 ok:false', async () => {
  const value = await mount().run('xiangqi_hint', { move: '帅五进三' });
  assert.equal(value.ok, false);
  assert.match(value.report, /支不了这一招/);
});

test('两副插件实例之间互不干扰（状态挂在实例上）', async () => {
  const a = mount();
  const b = mount();
  await a.run('xiangqi_move', { move: '炮二平五' });
  const boardB = await b.run('xiangqi_board');
  assert.equal(boardB.legal.length, 44, 'B 不该被 A 的落子影响');
  assert.match(boardB.report, /轮到：红方/);
});

test('整局对下：红炮平中、黑马跳出、红炮吃卒，读得到吃子与结果字段', async () => {
  const { run } = mount();
  await run('xiangqi_move', { move: '炮二平五' });
  await run('xiangqi_move', { move: '马8进7' });
  const value = await run('xiangqi_move', { move: '炮五进四' });
  assert.equal(value.ok, true);
  assert.equal(value.notation, '炮五进四');
  const board = await run('xiangqi_board');
  assert.match(board.report, /着法：1\.炮二平五 2\.马8进7 3\.炮五进四/);
  assert.equal(board.turn, 'black');
});
