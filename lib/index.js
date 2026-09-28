// 插件的服务端半边（host）：持有棋局，并把棋局变成会话可调用的工具。
//
// 分工：真相在这里，浏览器半边只负责画和点。规则与记谱直接复用 src/ 里
// 那套已经被 perft 验证过的纯函数——注册成插件不需要改动它们一行。
//
// 工具契约照抄随包的 dsh-tool-todo：defineTool 编译参数与输出 schema，
// 并且会在 execute 之前先按 schema 校验入参。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { RED, BLACK, toFen } from '../src/board.js';
import { isInCheck } from '../src/rules.js';
import { legalNotations } from '../src/notation.js';
import {
  newGame, applyMove, applyNotation, undoRound, setHint, gameReport, gameView, resultText, movesFrom, HUMAN,
} from './game.js';

export const name = 'dsh-xiangqi';
export const inject = ['tools'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 启动信标：挂载时把一份极小的状态写到 state/host.json。
 *
 * 存在的理由是可观测性——服务端半边不像浏览器半边那样有热重载，也没有日志
 * 通道能让我从外面看见它到底加载没有。这个文件让我（和以后的维护者）能一眼
 * 确认「插件在这个进程里活着，注册了哪几个工具」。
 * 它纯粹是诊断用途，写失败绝不能影响插件本身。
 */
function beacon(payload) {
  try {
    const dir = path.join(ROOT, 'state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'host.json'), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // 诊断失败就失败，插件的功能不该受它牵连
  }
}

const sideOf = (color) => (color === RED ? '红方' : '黑方');

/** 解析 "列,行" 形式的交叉点。 */
function parsePoint(text) {
  const match = /^\s*(\d)\s*,\s*(\d)\s*$/.exec(String(text));
  if (!match) throw new Error(`交叉点应写成「列,行」，比如 7,7；收到「${text}」`);
  const col = Number(match[1]);
  const row = Number(match[2]);
  if (col > 8 || row > 9) throw new Error(`交叉点越界：列 0-8、行 0-9，收到 ${col},${row}`);
  return { col, row, index: row * 9 + col };
}

export function apply(ctx) {
  // 这一局棋。状态挂在插件实例上——同一个 DSH 进程里只有一块棋盘。
  let game = newGame('game');

  const register = (definition) => ctx.effect(
    () => ctx.tools.register(definition),
    `dsh-xiangqi: ${definition.name}`,
  );

  /** 把一次失败的调用包成 Connection 认的失败形状，而不是让异常穿出去。 */
  const failure = (error) => ({
    ok: false,
    error: {
      code: 'xiangqi',
      message: error && error.message ? error.message : String(error),
      details: {},
    },
  });

  /**
   * 人走完一步之后，把会话叫醒接招。
   *
   * 只有这条路径（面板经 RPC 落子）会唤醒。会话自己用 xiangqi_move 工具落子时
   * 绝不唤醒——否则它会把自己叫醒，陷入自己跟自己下棋的循环。
   */
  function wakeAgent(sessionId, move) {
    if (!sessionId) return { woken: false, reason: '面板没有带上会话 id' };
    if (game.result) return { woken: false, reason: '已经终局，不用接招了' };
    if (game.position.turn === HUMAN) return { woken: false, reason: '还没轮到会话走' };

    const agents = ctx.get('agents');
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    if (!agent || typeof agent.followup !== 'function') {
      return { woken: false, reason: `没找到会话 ${sessionId}，接不了招` };
    }
    try {
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `人在棋盘上走了「${move.notation}」。现在轮到你走：先用 xiangqi_board 看清局面，再用 xiangqi_move 落子。`,
        }],
        source: {
          kind: 'plugin',
          plugin: 'xiangqi',
          form: 'notice',
          summary: `棋盘：人走了 ${move.notation}`,
        },
      }));
      return { woken: true, reason: '' };
    } catch (error) {
      return { woken: false, reason: `唤醒失败：${error && error.message ? error.message : error}` };
    }
  }

  /**
   * 浏览器半边调的几个接口。它只读局面，以及把人的着法送进来。
   *
   * 之所以让浏览器轮询 view 而不是服务端推送：轮询让两边永远收敛——
   * 无论着法是会话用工具走的、还是人在面板上点的，下一次轮询都会对齐。
   * 省掉一整套推送与断线重连的状态机，代价是几百毫秒的延迟。
   */
  const endpoints = {
    view: () => gameView(game),
    moves(payload) {
      const point = parsePoint(payload && payload.from);
      return {
        from: point.index,
        targets: movesFrom(game, point.index).map((move) => ({ to: move.to, notation: move.notation })),
      };
    },
    move(payload) {
      const request = payload || {};
      const played = request.from !== undefined
        ? applyMove(game, request.from, request.to) // 面板上点两下走的是坐标
        : applyNotation(game, request.move);
      game = played.game;
      return { ...gameView(game), notation: played.move.notation, wake: wakeAgent(request.sessionId, played.move) };
    },
    undo() {
      game = undoRound(game, HUMAN).game;
      return gameView(game);
    },
    hint(payload) {
      game = setHint(game, payload && payload.move !== undefined ? payload.move : null).game;
      return gameView(game);
    },
  };

  const connection = ctx.get('connection');
  if (connection && connection.rpc) {
    ctx.effect(
      () => connection.rpc.handle('/xiangqi', async (endpoint, payload) => {
        const handler = endpoints[endpoint];
        if (!handler) return failure(new Error(`未知的接口：${endpoint}`));
        try {
          return { ok: true, value: handler(payload || {}) };
        } catch (error) {
          return failure(error);
        }
      }),
      'dsh-xiangqi: rpc channel',
    );
  }

  // ---------------------------------------------------------------- 读局面
  register(defineTool({
    name: 'xiangqi_board',
    description:
      '读当前这盘中国象棋的局面：棋盘图、轮到谁走、是否被将军、已走过的着法、以及结果。' +
      '想知道某一枚子能走到哪里，把它的交叉点传给 from（形如 "7,7"）。' +
      '轮到自己走棋前先用它看清局面。',
    parameters: {
      from: {
        type: 'string',
        description: '可选。形如 "7,7" 的交叉点（列,行），列 0-8 从左到右，行 0-9 从上到下。给了就列出这枚子的全部合法着法。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', required: true },
          fen: { type: 'string', required: true },
          turn: { type: 'string', required: true, enum: [RED, BLACK] },
          inCheck: { type: 'boolean', required: true },
          resultText: { type: 'string', required: true },
          legal: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute(args) {
      let report = gameReport(game);
      if (args.from !== undefined) {
        const point = parsePoint(args.from);
        const options = movesFrom(game, point.index);
        report += options.length
          ? `\n\n(${point.col},${point.row}) 这枚子能走：${options.map((m) => `${m.notation}${m.target}`).join('、')}`
          : `\n\n(${point.col},${point.row}) 这枚子无处可走。`;
      }
      return Promise.resolve({
        report,
        fen: toFen(game.position),
        turn: game.position.turn,
        inCheck: isInCheck(game.position, game.position.turn),
        resultText: resultText(game),
        legal: game.mode === 'game' && !game.result
          ? legalNotations(game.position).map((entry) => entry.notation)
          : [],
      });
    },
  }));

  // ---------------------------------------------------------------- 落子
  register(defineTool({
    name: 'xiangqi_move',
    description:
      '走一步棋。着法用中文记谱（如「炮二平五」）或坐标（如「h7-e7」「7,7-4,7」）都行。' +
      '非法着法不会让工具失败，而是返回 ok:false 并说明这枚子到底能走到哪里，照着改即可。',
    parameters: {
      move: { type: 'string', required: true, description: '要走的着法。中文记谱如「炮二平五」，或坐标如「h7-e7」。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          notation: { type: 'string', required: true },
          report: { type: 'string', required: true },
          turn: { type: 'string', required: true, enum: [RED, BLACK] },
          resultText: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `已走：${value.notation}\n\n${value.report}` : value.report,
      }],
    },
    execute(args) {
      try {
        const played = applyNotation(game, args.move);
        game = played.game;
        return Promise.resolve({
          ok: true,
          notation: played.move.notation,
          report: gameReport(game),
          turn: game.position.turn,
          resultText: resultText(game),
        });
      } catch (error) {
        return Promise.resolve({
          ok: false,
          notation: '',
          report: `这一步走不了：${error.message}\n\n${gameReport(game)}`,
          turn: game.position.turn,
          resultText: resultText(game),
        });
      }
    },
  }));

  // ---------------------------------------------------------------- 悔棋
  register(defineTool({
    name: 'xiangqi_undo',
    description: '悔棋，退回到该人走的状态（人一步 + 会话一步算一轮）。轮到会话走时只退人的那一步。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          undone: { type: 'integer', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute() {
      try {
        const reverted = undoRound(game, HUMAN);
        game = reverted.game;
        return Promise.resolve({
          ok: true,
          undone: reverted.undone,
          report: `已悔 ${reverted.undone} 步，现在轮到${sideOf(game.position.turn)}走。\n\n${gameReport(game)}`,
        });
      } catch (error) {
        return Promise.resolve({ ok: false, undone: 0, report: `悔不了：${error.message}` });
      }
    },
  }));

  // ---------------------------------------------------------------- 支招
  register(defineTool({
    name: 'xiangqi_hint',
    description:
      '给人支一招：把这条建议着法送到棋盘上高亮出来。不传 move 就清除已有的支招。' +
      '支招不改变局面，只是让人看得见。',
    parameters: {
      move: { type: 'string', description: '建议的着法，中文记谱或坐标。留空表示清除支招。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          hint: { type: 'string', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute(args) {
      try {
        const hinted = setHint(game, args.move === undefined ? null : args.move);
        game = hinted.game;
        return Promise.resolve({
          ok: true,
          hint: hinted.hint ? hinted.hint.notation : '',
          report: hinted.hint ? `已在棋盘上高亮支招：${hinted.hint.notation}` : '已清除支招。',
        });
      } catch (error) {
        return Promise.resolve({ ok: false, hint: '', report: `支不了这一招：${error.message}` });
      }
    },
  }));

  beacon({
    loadedAt: new Date().toISOString(),
    pid: process.pid,
    tools: ['xiangqi_board', 'xiangqi_move', 'xiangqi_undo', 'xiangqi_hint'],
    rpc: Boolean(connection && connection.rpc),
    root: ROOT,
  });
}
