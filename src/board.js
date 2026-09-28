// 局面表示与 FEN 互转。
//
// 坐标约定：col 0..8 从左到右，row 0..9 从上到下。
// row 0 是黑方底线，row 9 是红方底线——所以「红方向上走」是 row 变小。
// 棋盘扁平存成一个长度 90 的数组，index = row * 9 + col。
//
// 棋子是 { color, type }，type 取 K A B N R C P（将/士/象/马/车/炮/兵）。
// FEN 里红方用大写、黑方用小写，与我们内部的 color 字段对应。

export const RED = 'red';
export const BLACK = 'black';

export const COLS = 9;
export const ROWS = 10;
export const CELLS = COLS * ROWS;

export const TYPES = ['K', 'A', 'B', 'N', 'R', 'C', 'P'];

/** 各棋子的中文名，红黑分开，只用于展示。 */
export const NAMES = {
  red:   { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
};

export const idx = (col, row) => row * COLS + col;
export const colOf = (i) => i % COLS;
export const rowOf = (i) => (i - (i % COLS)) / COLS;
export const onBoard = (col, row) => col >= 0 && col < COLS && row >= 0 && row < ROWS;
export const other = (color) => (color === RED ? BLACK : RED);

export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

export function emptyPosition(turn = RED) {
  return { cells: new Array(CELLS).fill(null), turn };
}

export function clonePosition(pos) {
  return { cells: pos.cells.slice(), turn: pos.turn };
}

export function pieceAt(pos, col, row) {
  return onBoard(col, row) ? pos.cells[idx(col, row)] : null;
}

export function findKing(pos, color) {
  for (let i = 0; i < CELLS; i++) {
    const p = pos.cells[i];
    if (p && p.type === 'K' && p.color === color) return i;
  }
  return -1;
}

export function pieceToChar(p) {
  return p.color === RED ? p.type : p.type.toLowerCase();
}

export function charToPiece(ch) {
  const type = ch.toUpperCase();
  if (!TYPES.includes(type)) return null;
  return { color: ch === type ? RED : BLACK, type };
}

/** 只序列化棋盘与轮次——这两样才决定局面本身。 */
export function toFen(pos, halfmove = 0, fullmove = 1) {
  const ranks = [];
  for (let row = 0; row < ROWS; row++) {
    let rank = '';
    let gap = 0;
    for (let col = 0; col < COLS; col++) {
      const p = pos.cells[idx(col, row)];
      if (!p) { gap++; continue; }
      if (gap) { rank += gap; gap = 0; }
      rank += pieceToChar(p);
    }
    if (gap) rank += gap;
    ranks.push(rank);
  }
  const side = pos.turn === RED ? 'w' : 'b';
  return `${ranks.join('/')} ${side} - - ${halfmove} ${fullmove}`;
}

/** 局面指纹：用于重复局面判定。同一子力分布 + 同一轮次才算同一个局面。 */
export function positionKey(pos) {
  return toFen(pos).split(' ').slice(0, 2).join(' ');
}

export function parseFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  const [board, side] = parts;
  const ranks = board.split('/');
  if (ranks.length !== ROWS) {
    throw new Error(`FEN 行数应为 ${ROWS}，实际是 ${ranks.length}：${fen}`);
  }
  const pos = emptyPosition(side === 'b' ? BLACK : RED);
  for (let row = 0; row < ROWS; row++) {
    let col = 0;
    for (const ch of ranks[row]) {
      if (ch >= '1' && ch <= '9') { col += Number(ch); continue; }
      const p = charToPiece(ch);
      if (!p) throw new Error(`FEN 里有无法识别的字符 "${ch}"：${fen}`);
      if (col >= COLS) throw new Error(`FEN 第 ${row} 行超出一行的宽度：${fen}`);
      pos.cells[idx(col, row)] = p;
      col++;
    }
    if (col !== COLS) throw new Error(`FEN 第 ${row} 行宽度应为 ${COLS}，实际 ${col}：${fen}`);
  }
  return pos;
}

export function startPosition() {
  return parseFen(START_FEN);
}

/** 给人看的文本棋盘。默认红方在下，与网页和实体棋盘一致。 */
export function formatBoard(pos) {
  const lines = [];
  lines.push('   ' + [...'012345678'].join('  '));
  for (let row = 0; row < ROWS; row++) {
    let line = String(row).padStart(2) + ' ';
    for (let col = 0; col < COLS; col++) {
      const p = pos.cells[idx(col, row)];
      line += (p ? NAMES[p.color][p.type] : '·');
      line += col === COLS - 1 ? '' : '  ';
    }
    lines.push(line);
    if (row === 4) lines.push('   ------- 楚 河   汉 界 -------');
  }
  return lines.join('\n');
}
