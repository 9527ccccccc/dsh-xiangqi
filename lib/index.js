// 插件的服务端半边（host）：持有棋局，并把棋局变成会话可调用的工具。
//
// 分工：真相在这里，浏览器半边只负责画和点。规则与记谱直接复用 src/ 里
// 那套已经被 perft 验证过的纯函数——注册成插件不需要改动它们一行。
//
// 工具契约照抄随包的 dsh-tool-todo：defineTool 编译参数与输出 schema，
// 并且会在 execute 之前先按 schema 校验入参。

import { defineTool } from '@deepseek-ai/dsh-tools';

import { RED, BLACK, toFen } from '../src/board.js';
import { isInCheck } from '../src/rules.js';
import { legalNotations } from '../src/notation.js';
import {
  newGame, applyNotation, undoRound, setHint, gameReport, resultText, movesFrom, HUMAN,
} from './game.js';

export const name = 'dsh-xiangqi';
export const inject = ['tools'];

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
}
