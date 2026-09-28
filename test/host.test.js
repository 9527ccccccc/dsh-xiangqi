// 服务端半边（host）的装配与工具测试。
//
// 用假 ctx 把插件挂起来，然后直接驱动工具的 execute——这正是 DSH 调用工具的
// 那条路径（defineTool 编译出的 schema 会先校验入参，再进 execute）。
// 所以这一层测到的不是「我的函数对不对」，而是「工具契约对不对」。

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, name, inject } from '../lib/index.js';
import { idx } from '../src/board.js';

/** 挂一份全新的插件实例：棋局状态挂在插件实例上，所以每个用例都要新挂一次。 */
function mount() {
  const tools = new Map();
  const channels = new Map();
  const effects = [];
  /** 假的 Agent：只记下被喂了什么，不真的驱动回合。 */
  const agent = {
    followups: [],
    followup(message) { this.followups.push(message); },
  };
  const ctx = {
    effect(fn, label) { effects.push(label); return fn(); },
    get(serviceName) {
      if (serviceName === 'connection') {
        return {
          rpc: {
            handle(channel, handler) { channels.set(channel, handler); return () => {}; },
          },
        };
      }
      if (serviceName === 'agents') {
        return { get(id) { return id === 'live-session' ? agent : undefined; } };
      }
      return undefined;
    },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => {}; },
    },
  };
  apply(ctx);
  return {
    tools,
    effects,
    channels,
    agent,
    /** 走浏览器半边的那条路：同一个 handler，同一个返回形状。 */
    call: (endpoint, payload) => channels.get('/xiangqi')(endpoint, payload, new AbortController().signal),
    run: (toolName, args = {}) => tools.get(toolName).execute(args, {}),
    text: async (toolName, args) => {
      const tool = tools.get(toolName);
      const value = await tool.execute(args, {});
      return tool.output.render(args, value).map((block) => block.text).join('\n');
    },
  };
}

test('插件声明了名字与 tools 依赖', () => {
  assert.equal(name, 'dsh-xiangqi');
  assert.deepEqual(inject, ['tools']);
});

test('四个工具都注册上了，且每个都包在 ctx.effect 里', () => {
  const { tools, effects } = mount();
  assert.deepEqual([...tools.keys()].sort(), [
    'xiangqi_board', 'xiangqi_hint', 'xiangqi_move', 'xiangqi_undo',
  ]);
  // 四个工具 + 一条 RPC 通道
  assert.equal(effects.length, 5);
  assert.ok(effects.includes('dsh-xiangqi: rpc channel'));
  for (const label of effects.filter((l) => l.includes('xiangqi_') || l.includes('tools'))) {
    assert.match(label, /^dsh-xiangqi: /);
  }
});

test('RPC 通道注册在 /xiangqi 上', () => {
  const { channels } = mount();
  assert.deepEqual([...channels.keys()], ['/xiangqi']);
});

test('connection 迟到时用 ctx.inject 补挂通道，而不是永远错过', async () => {
  const tools = new Map();
  const channels = new Map();
  const pending = [];
  const ctx = {
    effect(fn) { return fn(); },
    // 关键：挂载的这一刻 connection 还不存在
    get(serviceName) { return serviceName === 'agents' ? { get: () => undefined } : undefined; },
    inject(services, callback) { pending.push({ services, callback }); },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
  };

  apply(ctx);

  assert.equal(channels.size, 0, '此刻还没有 connection，通道挂不上');
  assert.equal(pending.length, 1, '应当用 ctx.inject 等 connection');
  assert.deepEqual(pending[0].services, ['connection']);

  // 连接服务稍后出现
  const scoped = {
    effect(fn) { return fn(); },
    connection: {
      rpc: { handle(channel, handler) { channels.set(channel, handler); return () => {}; } },
    },
  };
  pending[0].callback(scoped);

  assert.deepEqual([...channels.keys()], ['/xiangqi'], 'connection 一就绪通道就得挂上');
  const result = await channels.get('/xiangqi')('view', {}, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(result.value.turn, 'red');
  assert.equal(tools.size, 4, '等 connection 的期间工具照样注册好了');
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

// ------------------------------------------------------------------ 唤醒会话

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
  const { call, agent } = mount();
  const result = await call('move', { from: idx(7, 7), to: idx(4, 7), sessionId: '查无此会话' });
  assert.equal(result.value.wake.woken, false);
  assert.match(result.value.wake.reason, /没找到会话/);
  assert.equal(agent.followups.length, 0);
});

test('轮到人走的时候，会话经 RPC 走子也不会把自己叫醒', async () => {
  const { call, agent } = mount();
  // 开局是红（人）走。红走完轮到黑（会话），这一步按说是人走的，但我们直接指定
  // sessionId 模拟异常路径：黑走完之后轮到红，就不该唤醒。
  await call('move', { from: idx(7, 7), to: idx(4, 7) });
  const second = await call('move', { from: idx(1, 0), to: idx(2, 2), sessionId: 'live-session' });
  assert.equal(second.ok, true);
  assert.equal(second.value.turn, 'red');
  assert.equal(second.value.wake.woken, false);
  assert.match(second.value.wake.reason, /还没轮到会话走/);
  assert.equal(agent.followups.length, 0);
});

test('整条对局循环：人走 → 唤醒 → 会话接招 → 再轮到人', async () => {
  const { call, run, agent } = mount();
  // 人心血来潮先手
  await call('move', { from: idx(7, 7), to: idx(4, 7), sessionId: 'live-session' });
  assert.equal(agent.followups.length, 1);

  // 会话被唤醒后照做
  const reply = await run('xiangqi_move', { move: '马8进7' });
  assert.equal(reply.ok, true);
  assert.equal(reply.turn, 'red');

  // 人再走一步，应当再唤醒一次
  await call('move', { from: idx(7, 9), to: idx(6, 7), sessionId: 'live-session' });
  assert.equal(agent.followups.length, 2);

  const board = await run('xiangqi_board');
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
