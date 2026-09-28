// 走子规则：着法生成、合法性、将军与终局判定。
//
// 分两层：
//   pseudoMoves —— 只按各子力的走法生成，不管走完之后自己的将安不安全；
//   legalMoves  —— 在 pseudo 的基础上滤掉「自将」和「将帅照面」。
// 终局判定只看 legalMoves 是否为空，以及是否正被将军。

import {
  RED, BLACK, COLS, ROWS, idx, colOf, rowOf, onBoard, other,
  clonePosition, findKing,
} from './board.js';

const ORTHO = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

// 马的八个方向，后两位是「马腿」相对位置
const KNIGHT = [
  [-1, -2, 0, -1], [1, -2, 0, -1],
  [-1, 2, 0, 1], [1, 2, 0, 1],
  [-2, -1, -1, 0], [-2, 1, -1, 0],
  [2, -1, 1, 0], [2, 1, 1, 0],
];

/** 九宫：红在下方（row 7..9），黑在上方（row 0..2）。 */
export function inPalace(color, col, row) {
  if (col < 3 || col > 5) return false;
  return color === RED ? row >= 7 && row <= 9 : row >= 0 && row <= 2;
}

/** 是否在己方半场。象不过河靠这个判定。 */
export function ownHalf(color, row) {
  return color === RED ? row >= 5 : row <= 4;
}

const enemyAt = (pos, color, col, row) => {
  const t = pos.cells[idx(col, row)];
  return t && t.color !== color ? t : null;
};
const emptyAt = (pos, col, row) => !pos.cells[idx(col, row)];
const freeAt = (pos, color, col, row) => {
  const t = pos.cells[idx(col, row)];
  return !t || t.color !== color;
};

/** 单车/单炮/单兵这类直线走子的着法，供车与炮共用。 */
function slideMoves(pos, from, color, type, out) {
  const col0 = colOf(from);
  const row0 = rowOf(from);
  for (const [dc, dr] of ORTHO) {
    let col = col0 + dc;
    let row = row0 + dr;
    let screened = false; // 炮是否已经找到炮架
    while (onBoard(col, row)) {
      const target = pos.cells[idx(col, row)];
      if (type === 'R') {
        if (!target) {
          out.push({ from, to: idx(col, row) });
        } else {
          if (target.color !== color) out.push({ from, to: idx(col, row) });
          break;
        }
      } else { // 炮
        if (!screened) {
          if (!target) out.push({ from, to: idx(col, row) });
          else screened = true; // 这一枚是炮架，不能吃也不能停
        } else if (target) {
          if (target.color !== color) out.push({ from, to: idx(col, row) });
          break;
        }
      }
      col += dc;
      row += dr;
    }
  }
}

export function pseudoMovesFrom(pos, from) {
  const p = pos.cells[from];
  if (!p) return [];
  const out = [];
  const col = colOf(from);
  const row = rowOf(from);
  const color = p.color;

  switch (p.type) {
    case 'R':
    case 'C':
      slideMoves(pos, from, color, p.type, out);
      break;

    case 'N':
      for (const [dc, dr, lc, lr] of KNIGHT) {
        const c = col + dc;
        const r = row + dr;
        if (!onBoard(c, r)) continue;
        if (pos.cells[idx(col + lc, row + lr)]) continue; // 蹩马腿
        if (freeAt(pos, color, c, r)) out.push({ from, to: idx(c, r) });
      }
      break;

    case 'B':
      for (const [dc, dr] of DIAG) {
        const c = col + dc * 2;
        const r = row + dr * 2;
        if (!onBoard(c, r)) continue;
        if (!ownHalf(color, r)) continue;                 // 象不过河
        if (pos.cells[idx(col + dc, row + dr)]) continue; // 塞象眼
        if (freeAt(pos, color, c, r)) out.push({ from, to: idx(c, r) });
      }
      break;

    case 'A':
      for (const [dc, dr] of DIAG) {
        const c = col + dc;
        const r = row + dr;
        if (!inPalace(color, c, r)) continue;
        if (freeAt(pos, color, c, r)) out.push({ from, to: idx(c, r) });
      }
      break;

    case 'K':
      for (const [dc, dr] of ORTHO) {
        const c = col + dc;
        const r = row + dr;
        if (!inPalace(color, c, r)) continue;
        if (freeAt(pos, color, c, r)) out.push({ from, to: idx(c, r) });
      }
      break;

    case 'P': {
      const forward = color === RED ? -1 : 1;
      const r = row + forward;
      if (onBoard(col, r) && freeAt(pos, color, col, r)) out.push({ from, to: idx(col, r) });
      const crossedRiver = color === RED ? row <= 4 : row >= 5;
      if (crossedRiver) {
        for (const dc of [-1, 1]) {
          const c = col + dc;
          if (onBoard(c, row) && freeAt(pos, color, c, row)) out.push({ from, to: idx(c, row) });
        }
      }
      break;
    }
  }
  return out;
}

export function pseudoMoves(pos, color = pos.turn) {
  const out = [];
  for (let i = 0; i < pos.cells.length; i++) {
    const p = pos.cells[i];
    if (p && p.color === color) out.push(...pseudoMovesFrom(pos, i));
  }
  return out;
}

/**
 * 将帅照面（白脸将）：两将同列且中间没有任何棋子。
 * 这种局面非法——造成它的一方等于把将送给了对方。
 */
export function kingsFace(pos) {
  const red = findKing(pos, RED);
  const black = findKing(pos, BLACK);
  if (red < 0 || black < 0) return false;
  if (colOf(red) !== colOf(black)) return false;
  const col = colOf(red);
  const from = Math.min(rowOf(red), rowOf(black)) + 1;
  const to = Math.max(rowOf(red), rowOf(black));
  for (let row = from; row < to; row++) {
    if (pos.cells[idx(col, row)]) return false;
  }
  return true;
}

/** color 一方的将是否正被攻击（含被对方将照面）。 */
export function isInCheck(pos, color) {
  const king = findKing(pos, color);
  if (king < 0) return false;
  const foe = other(color);
  for (const m of pseudoMoves(pos, foe)) {
    if (m.to === king) return true;
  }
  return kingsFace(pos);
}

export function makeMove(pos, from, to) {
  const piece = pos.cells[from];
  const captured = pos.cells[to];
  const next = clonePosition(pos);
  next.cells[to] = piece;
  next.cells[from] = null;
  next.turn = other(pos.turn);
  return { position: next, piece, captured };
}

export function legalMovesFrom(pos, from) {
  const color = pos.turn;
  const p = pos.cells[from];
  if (!p || p.color !== color) return [];
  return pseudoMovesFrom(pos, from).filter((m) => {
    const { position } = makeMove(pos, m.from, m.to);
    return !isInCheck(position, color);
  });
}

export function legalMoves(pos, color = pos.turn) {
  if (color !== pos.turn) {
    throw new Error('legalMoves 只对当前该走的一方有意义；要问别的颜色请先构造该颜色的局面');
  }
  const out = [];
  for (let i = 0; i < pos.cells.length; i++) {
    const p = pos.cells[i];
    if (p && p.color === color) out.push(...legalMovesFrom(pos, i));
  }
  return out;
}

/**
 * 终局判定。注意：无子可走在中国象棋里一律判负——
 * 被将军时是将死，没被将军时是困毙，两者都是走不了的一方输。
 */
export function gameStatus(pos) {
  const moves = legalMoves(pos);
  if (moves.length === 0) {
    return isInCheck(pos, pos.turn)
      ? { state: 'checkmate', loser: pos.turn, winner: other(pos.turn), reason: '将死' }
      : { state: 'stalemate', loser: pos.turn, winner: other(pos.turn), reason: '困毙' };
  }
  if (isInCheck(pos, pos.turn)) return { state: 'check', moves };
  return { state: 'playing', moves };
}

/** 供展示：某个交叉点上的棋子能走到哪里。 */
export { enemyAt, emptyAt, freeAt };
