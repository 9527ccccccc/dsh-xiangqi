// 一局棋的全部真相。
//
// 纯逻辑：不碰 Cordis、不碰 HTTP、不碰浏览器。所以它可以被直接单测，
// 也可以被将来的任何前端复用——棋子怎么走这件事只有一个出处。
//
// 这里在做的事情是把「局面」（src/board + src/rules）包成「一局棋」：
// 加上着法历史（为了悔棋与重复局面判定）、支招、胜负结果。

import {
  RED, BLACK, NAMES, colOf, rowOf, startPosition, parseFen, toFen,
  positionKey, formatBoard,
} from '../src/board.js';
import { legalMoves, legalMovesFrom, makeMove, gameStatus, isInCheck } from '../src/rules.js';
import { formatMove, parseAnyMove } from '../src/notation.js';

/** 人执红先行。 */
export const HUMAN = RED;
/** 60 回合（120 个半回合）无吃子判和。 */
export const HALFMOVE_LIMIT = 120;

export const MODES = ['game', 'setup'];

const sideName = (color) => (color === RED ? '红方' : '黑方');
const at = (index) => `(${colOf(index)},${rowOf(index)})`;

export function newGame(mode = 'game', position = startPosition()) {
  return {
    mode,
    position,
    /** 每一项都带着走这一步「之前」的 FEN，悔棋就是照着它回退。 */
    history: [],
    /** 每一步之后的局面指纹，用来数重复局面。 */
    keys: [positionKey(position)],
    hint: null,
    result: null,
    halfmoveClock: 0,
  };
}

export function cloneGame(game) {
  return {
    mode: game.mode,
    position: { cells: game.position.cells.slice(), turn: game.position.turn },
    history: game.history.slice(),
    keys: game.keys.slice(),
    hint: game.hint,
    result: game.result,
    halfmoveClock: game.halfmoveClock,
  };
}

export function isOver(game) {
  return game.result !== null;
}

/** 数出末尾连续多少个半回合没有吃子。 */
function tailQuietPlies(history) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].captured) break;
    count++;
  }
  return count;
}

/**
 * 这一局是不是已经结束了。顺序有意义：将死/困毙优先于和棋规则。
 * 注意困毙也判负——中国象棋与西洋棋在这一点上不同。
 */
export function outcome(game) {
  const status = gameStatus(game.position);
  if (status.state === 'checkmate') return { winner: status.winner, reason: '将死' };
  if (status.state === 'stalemate') return { winner: status.winner, reason: '困毙' };

  const current = game.keys[game.keys.length - 1];
  if (game.keys.filter((key) => key === current).length >= 3) {
    return { winner: null, reason: '三次重复局面，和棋' };
  }
  if (game.halfmoveClock >= HALFMOVE_LIMIT) {
    return { winner: null, reason: '60 回合无吃子，和棋' };
  }
  return null;
}

export function resultText(game) {
  if (!game.result) return '';
  const { winner, reason } = game.result;
  return winner ? `${sideName(winner)}胜（${reason}）` : `和棋（${reason}）`;
}

/** 某个交叉点上这枚子的全部合法着法，附中文记谱。 */
export function movesFrom(game, from) {
  if (!Number.isInteger(from) || from < 0 || from >= game.position.cells.length) return [];
  return legalMovesFrom(game.position, from).map((move) => ({
    from: move.from,
    to: move.to,
    notation: formatMove(game.position, move.from, move.to),
    target: at(move.to),
  }));
}

function requirePlayable(game) {
  if (game.mode !== 'game') throw new Error('现在是摆棋模式，不受走子规则约束；要下棋请先切回对局模式');
  if (game.result) throw new Error(`这一局已经结束了：${resultText(game)}`);
}

/**
 * 走一步。from/to 是内部坐标。
 * 非法着法一律抛错，并把「这枚子能走到哪」一起说清楚——对象是模型，报错要能直接照着改。
 */
export function applyMove(game, from, to) {
  requirePlayable(game);
  const { cells } = game.position;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= cells.length || to < 0 || to >= cells.length) {
    throw new Error(`坐标越界：from=${from} to=${to}`);
  }
  const piece = cells[from];
  if (!piece) throw new Error(`起点 ${at(from)} 上没有棋子`);
  if (piece.color !== game.position.turn) {
    throw new Error(`还没轮到${sideName(piece.color)}走，现在该${sideName(game.position.turn)}走`);
  }

  const options = movesFrom(game, from);
  if (!options.some((move) => move.to === to)) {
    throw new Error(
      `${sideName(piece.color)}的${NAMES[piece.color][piece.type]}在 ${at(from)}，走不到 ${at(to)}。` +
      (options.length ? `它能走：${options.map((m) => `${m.notation}${m.target}`).join('、')}` : '它无处可走'),
    );
  }

  const notation = formatMove(game.position, from, to);
  const fenBefore = toFen(game.position);
  const { position, captured } = makeMove(game.position, from, to);

  const next = cloneGame(game);
  next.position = position;
  next.history = game.history.concat([{
    notation, from, to, piece, captured: captured || null, fenBefore,
  }]);
  next.keys = game.keys.concat([positionKey(position)]);
  next.halfmoveClock = captured ? 0 : game.halfmoveClock + 1;
  next.hint = null;
  next.result = outcome(next);
  return { game: next, move: { notation, from, to, captured: captured || null } };
}

/** 用中文记谱或坐标走一步。 */
export function applyNotation(game, text) {
  const { from, to } = parseAnyMove(game.position, text);
  return applyMove(game, from, to);
}

/**
 * 悔棋：退回到该人走的状态。
 * 轮到人走时退两个半回合（人一步 + 会话一步），轮到会话走时退一个。
 */
export function undoRound(game, human = HUMAN) {
  if (game.history.length === 0) throw new Error('还没有走过棋，没什么可悔的');
  const next = cloneGame(game);
  let undone = 0;
  while (next.history.length > 0) {
    const last = next.history.pop();
    next.keys.pop();
    next.position = parseFen(last.fenBefore);
    undone++;
    if (next.position.turn === human) break;
  }
  next.halfmoveClock = tailQuietPlies(next.history);
  next.result = outcome(next);
  next.hint = null;
  return { game: next, undone, turn: next.position.turn };
}

/** 支招：记下一条建议着法，供棋盘高亮；传 null 清除。 */
export function setHint(game, text) {
  const next = cloneGame(game);
  if (text === null || text === undefined || String(text).trim() === '') {
    next.hint = null;
    return { game: next, hint: null };
  }
  const { from, to } = parseAnyMove(game.position, text);
  const hint = { from, to, notation: formatMove(game.position, from, to) };
  next.hint = hint;
  return { game: next, hint };
}

// ------------------------------------------------------------------ 摆棋模式

export function setMode(game, mode) {
  if (!MODES.includes(mode)) throw new Error(`模式只能是 ${MODES.join(' 或 ')}，收到「${mode}」`);
  const next = cloneGame(game);
  next.mode = mode;
  next.hint = null;
  next.result = null;
  return next;
}

export function placePiece(game, color, type, col, row) {
  if (game.mode !== 'setup') throw new Error('摆棋要先切到 setup 模式');
  if (!NAMES[color] || !NAMES[color][type]) throw new Error(`不认识这枚棋子：${color}/${type}`);
  const index = row * 9 + col;
  const next = cloneGame(game);
  next.position.cells[index] = { color, type };
  return next;
}

export function removePiece(game, col, row) {
  if (game.mode !== 'setup') throw new Error('摆棋要先切到 setup 模式');
  const next = cloneGame(game);
  next.position.cells[row * 9 + col] = null;
  return next;
}

// ------------------------------------------------------------------ 对外视图

/** 给浏览器半边的 JSON。宿主是唯一真相，这里只导出它需要画的东西。 */
export function gameView(game) {
  const last = game.history.length ? game.history[game.history.length - 1] : null;
  return {
    mode: game.mode,
    fen: toFen(game.position),
    turn: game.position.turn,
    inCheck: isInCheck(game.position, game.position.turn),
    legalCount: game.mode === 'game' && !game.result ? legalMoves(game.position).length : 0,
    history: game.history.map((entry) => entry.notation),
    lastMove: last ? { from: last.from, to: last.to } : null,
    hint: game.hint,
    result: game.result,
    resultText: resultText(game),
  };
}

/** 给模型看的文字报告。 */
export function gameReport(game) {
  const lines = [];
  lines.push(`模式：${game.mode === 'game' ? '对局' : '摆棋'}`);
  lines.push(`轮到：${sideName(game.position.turn)}`);
  if (game.mode === 'game') {
    lines.push(`将军：${isInCheck(game.position, game.position.turn) ? '是' : '否'}`);
  }
  if (game.result) lines.push(`结果：${resultText(game)}`);
  lines.push('');
  lines.push(formatBoard(game.position));
  lines.push('');
  lines.push(`FEN：${toFen(game.position)}`);
  if (game.history.length) {
    lines.push(`着法：${game.history.map((entry, i) => `${i + 1}.${entry.notation}`).join(' ')}`);
  }
  if (game.hint) lines.push(`支招：${game.hint.notation}（已在棋盘上高亮）`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ 存盘

/** 局面转成 FEN，其余字段本来就是纯 JSON 数据，直接带走。 */
export function serializeGame(game) {
  return {
    mode: game.mode,
    fen: toFen(game.position),
    history: game.history,
    keys: game.keys,
    hint: game.hint,
    result: game.result,
    halfmoveClock: game.halfmoveClock,
  };
}

/** 存下来的东西坏了就抛，让调用方决定退回新局还是别的。 */
export function deserializeGame(data) {
  if (!data || typeof data.fen !== 'string') throw new Error('存下来的对局缺 FEN');
  const position = parseFen(data.fen);
  return {
    mode: data.mode === 'setup' ? 'setup' : 'game',
    position,
    history: Array.isArray(data.history) ? data.history : [],
    keys: Array.isArray(data.keys) && data.keys.length ? data.keys : [positionKey(position)],
    hint: data.hint || null,
    result: data.result || null,
    halfmoveClock: Number.isInteger(data.halfmoveClock) ? data.halfmoveClock : 0,
  };
}
