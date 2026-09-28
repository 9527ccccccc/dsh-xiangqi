import test from 'node:test';
import assert from 'node:assert/strict';

import { RED, BLACK, idx, colOf, rowOf, emptyPosition, startPosition } from '../src/board.js';
import {
  legalMoves, legalMovesFrom, pseudoMoves, pseudoMovesFrom, isInCheck,
  kingsFace, makeMove, gameStatus, inPalace, ownHalf,
} from '../src/rules.js';

/** 用稀疏列表拼一个局面，比写 FEN 好读。 */
function build(turn, list) {
  const pos = emptyPosition(turn);
  for (const [col, row, color, type] of list) pos.cells[idx(col, row)] = { color, type };
  return pos;
}
/** 把着法列表转成 "c,r" 字符串集合，便于断言。 */
const targets = (moves) => new Set(moves.map((m) => `${colOf(m.to)},${rowOf(m.to)}`));

// ---------------------------------------------------------------- 基础着法

test('标准开局：红方共有 44 种合法着法', () => {
  const pos = startPosition();
  const moves = legalMoves(pos);
  // 手工点数：车 4 + 马 4 + 相 4 + 仕 2 + 帅 1 + 炮 24 + 兵 5 = 44
  // 炮 12×2：向上 4 个空位 + 隔黑炮打 (1,0) 的马 + 向下 1 + 向左 1 + 向右 5
  // 与公开的中国象棋 perft 深度 1 = 44 一致。perft 见 perft.test.js。
  assert.equal(moves.length, 44);
});

test('车的走法：直线滑行，遇到己方棋子停住，遇到敌子可吃', () => {
  const pos = startPosition();
  const t = targets(pseudoMovesFrom(pos, idx(0, 9)));
  // (0,9) 的车向上能走到 (0,8) 和 (0,7)，再往前是己方兵 (0,6)
  assert.deepEqual([...t].sort(), ['0,7', '0,8']);
});

test('炮的走法：空格可停，吃子必须隔且只隔一个', () => {
  const pos = startPosition();
  const t = targets(pseudoMovesFrom(pos, idx(1, 7)));
  // 第 1 列从上往下：黑马(0) 空(1) 黑炮(2) 空(3) 空(4) 空(5) 空(6) 红炮(7) 空(8) 红马(9)
  assert.ok(t.has('1,6') && t.has('1,5') && t.has('1,4') && t.has('1,3'), '炮架之前的空位都能停');
  assert.ok(t.has('1,0'), '隔着黑炮 (1,2) 打掉黑马 (1,0)');
  assert.ok(!t.has('1,1'), '炮架之后的空位不能停');
  assert.ok(!t.has('1,2'), '炮架本身不能吃');
  assert.ok(t.has('1,8'), '正下方的空位可以停');
  assert.ok(t.has('6,7'), '向右的空位可以停');
  assert.ok(!t.has('8,7'), '隔着红炮 (7,7) 之后是空位，不能走');
});

test('炮没有炮架时，隔着的东西吃不掉', () => {
  const pos = build(RED, [
    [3, 9, RED, 'K'], [4, 0, BLACK, 'K'],
    [4, 5, RED, 'C'], [4, 1, BLACK, 'R'],
  ]);
  const t = targets(pseudoMovesFrom(pos, idx(4, 5)));
  assert.ok(t.has('4,4') && t.has('4,3') && t.has('4,2'), '空位可停');
  assert.ok(!t.has('4,1'), '中间没有炮架，吃不到黑车');
});

test('马：马腿被占时那两个方向就走不了', () => {
  const blocked = build(RED, [
    [3, 9, RED, 'K'], [4, 0, BLACK, 'K'],
    [1, 9, RED, 'N'], [1, 8, RED, 'P'],
  ]);
  const t = targets(pseudoMovesFrom(blocked, idx(1, 9)));
  assert.ok(!t.has('0,7') && !t.has('2,7'), '(1,8) 是马腿，左右两个日字都被蹩住');
  assert.ok(t.has('3,8'), '另一个方向不受影响');

  const free = build(RED, [[3, 9, RED, 'K'], [4, 0, BLACK, 'K'], [1, 9, RED, 'N']]);
  const t2 = targets(pseudoMovesFrom(free, idx(1, 9)));
  assert.ok(t2.has('0,7') && t2.has('2,7'), '马腿空出来之后两个方向都能走');
});

test('象：塞象眼走不了，且不过河', () => {
  const blocked = build(RED, [
    [3, 9, RED, 'K'], [4, 0, BLACK, 'K'],
    [2, 9, RED, 'B'], [3, 8, RED, 'P'],
  ]);
  const t = targets(pseudoMovesFrom(blocked, idx(2, 9)));
  assert.ok(t.has('0,7'), '左边象眼 (1,8) 是空的');
  assert.ok(!t.has('4,7'), '右边象眼 (3,8) 被占，塞住了');

  // 象在河界附近时，只有回己方半场的方向可走
  const nearRiver = build(RED, [[3, 9, RED, 'K'], [4, 0, BLACK, 'K'], [2, 5, RED, 'B']]);
  const t2 = targets(pseudoMovesFrom(nearRiver, idx(2, 5)));
  assert.deepEqual([...t2].sort(), ['0,7', '4,7'], '过河的两个方向被 rule 挡掉');
});

test('士只在九宫内斜走一步，将帅只在九宫内直走一步', () => {
  const pos = build(RED, [
    [3, 9, RED, 'K'], [4, 0, BLACK, 'K'],
    [5, 9, RED, 'A'], [3, 7, RED, 'A'],
  ]);
  assert.deepEqual([...targets(pseudoMovesFrom(pos, idx(5, 9)))].sort(), ['4,8']);
  assert.deepEqual([...targets(pseudoMovesFrom(pos, idx(3, 9)))].sort(), ['3,8', '4,9']);

  assert.ok(inPalace(RED, 4, 8) && !inPalace(RED, 4, 6));
  assert.ok(inPalace(BLACK, 4, 1) && !inPalace(BLACK, 4, 3));
  assert.ok(!inPalace(RED, 2, 9) && !inPalace(RED, 6, 9));
});

test('兵：没过河只能向前，过了河可以左右但永不后退', () => {
  const before = build(RED, [[3, 9, RED, 'K'], [4, 0, BLACK, 'K'], [0, 6, RED, 'P']]);
  assert.deepEqual([...targets(pseudoMovesFrom(before, idx(0, 6)))], ['0,5']);

  const after = build(RED, [[3, 9, RED, 'K'], [4, 0, BLACK, 'K'], [0, 4, RED, 'P']]);
  const t = targets(pseudoMovesFrom(after, idx(0, 4)));
  assert.deepEqual([...t].sort(), ['0,3', '1,4']);
  assert.ok(!t.has('0,5'), '兵不能后退');
});

test('卒的方向与兵相反：黑卒向前是行号变大', () => {
  // (8,6) 已经在红方半场，所以这个卒过了河，可以横走
  const crossed = build(BLACK, [[3, 9, RED, 'K'], [4, 0, BLACK, 'K'], [8, 6, BLACK, 'P']]);
  assert.deepEqual([...targets(pseudoMovesFrom(crossed, idx(8, 6)))].sort(), ['7,6', '8,7']);

  // 还在黑方半场时只能向前
  const home = build(BLACK, [[3, 9, RED, 'K'], [4, 0, BLACK, 'K'], [8, 3, BLACK, 'P']]);
  assert.deepEqual([...targets(pseudoMovesFrom(home, idx(8, 3)))], ['8,4']);
});

test('ownHalf 判定河界两侧', () => {
  assert.ok(ownHalf(RED, 5) && ownHalf(RED, 9) && !ownHalf(RED, 4));
  assert.ok(ownHalf(BLACK, 4) && ownHalf(BLACK, 0) && !ownHalf(BLACK, 5));
});

// ---------------------------------------------------------------- 合法性

test('将帅照面：把挡在中间的棋子挪开是非法的', () => {
  // 用炮当挡子：炮没有炮架就打不到对面的将，所以这个局面里黑将并未被将军
  const pos = build(RED, [
    [4, 9, RED, 'K'], [4, 0, BLACK, 'K'], [4, 5, RED, 'C'],
  ]);
  assert.equal(kingsFace(pos), false, '中间有炮挡着，不算照面');
  assert.equal(isInCheck(pos, BLACK), false, '炮没有炮架，打不到黑将');

  const moves = legalMovesFrom(pos, idx(4, 5));
  const sideways = moves.filter((m) => colOf(m.to) !== 4);
  assert.equal(sideways.length, 0, '炮横走会露出将帅照面');
  assert.deepEqual([...targets(moves)].sort(), ['4,1', '4,2', '4,3', '4,4', '4,6', '4,7', '4,8']);

  const exposed = makeMove(pos, idx(4, 5), idx(3, 5)).position;
  assert.equal(kingsFace(exposed), true);
  assert.equal(isInCheck(exposed, RED), true, '照面按被将军处理');
  assert.equal(isInCheck(exposed, BLACK), true, '照面对双方都成立');
});

test('不能自杀：被牵住的子只能沿牵制线走', () => {
  const pos = build(RED, [
    [4, 9, RED, 'K'], [4, 5, RED, 'R'],
    [4, 0, BLACK, 'R'], [3, 0, BLACK, 'K'],
  ]);
  const moves = legalMovesFrom(pos, idx(4, 5));
  assert.ok(moves.length > 0);
  assert.ok(moves.every((m) => colOf(m.to) === 4), '红车被黑车牵住，横走就等于送将');
  assert.deepEqual([...targets(moves)].sort(), ['4,0', '4,1', '4,2', '4,3', '4,4', '4,6', '4,7', '4,8']);
});

// ---------------------------------------------------------------- 将军与终局

test('开局不是将军，状态为 playing', () => {
  const pos = startPosition();
  assert.equal(isInCheck(pos, RED), false);
  assert.equal(gameStatus(pos).state, 'playing');
});

test('将军能识别出来', () => {
  const pos = build(RED, [
    [4, 9, RED, 'K'], [4, 0, BLACK, 'K'], [3, 5, BLACK, 'R'],
  ]);
  assert.equal(isInCheck(pos, RED), true);
  assert.equal(gameStatus(pos).state, 'check');
});

test('将死：无子可走且正被将军，走投无路的一方判负', () => {
  const pos = build(BLACK, [
    [4, 0, BLACK, 'K'], [4, 1, BLACK, 'A'],
    [4, 5, RED, 'R'], [0, 0, RED, 'R'], [4, 9, RED, 'K'],
  ]);
  assert.equal(legalMoves(pos).length, 0);
  const status = gameStatus(pos);
  assert.equal(status.state, 'checkmate');
  assert.equal(status.winner, RED);
  assert.equal(status.loser, BLACK);
});

test('困毙：无子可走但没被将军，同样判负而不是和棋', () => {
  const pos = build(BLACK, [
    [4, 0, BLACK, 'K'],
    [3, 1, RED, 'P'], [5, 1, RED, 'P'],
    [3, 9, RED, 'K'],
  ]);
  assert.equal(isInCheck(pos, BLACK), false, '黑将本身没被攻击');
  assert.equal(legalMoves(pos).length, 0, '三个落点全被兵封死');
  const status = gameStatus(pos);
  assert.equal(status.state, 'stalemate');
  assert.equal(status.winner, RED, '中国象棋里困毙是判负，不是和棋');
  assert.equal(status.reason, '困毙');
});

// ---------------------------------------------------------------- 走子

test('makeMove 不改原局面，只返回新局面', () => {
  const pos = startPosition();
  const before = pos.cells.slice();
  const { position, piece, captured } = makeMove(pos, idx(1, 7), idx(4, 7));
  assert.deepEqual(pos.cells, before, '原局面必须纹丝不动');
  assert.equal(piece.type, 'C');
  assert.equal(captured, null);
  assert.equal(position.cells[idx(4, 7)].type, 'C');
  assert.equal(position.cells[idx(1, 7)], null);
  assert.equal(position.turn, BLACK, '走完轮到黑方');
});

test('makeMove 会报告吃掉的子', () => {
  const pos = build(RED, [[4, 9, RED, 'K'], [4, 0, BLACK, 'K'], [4, 5, RED, 'R'], [4, 2, BLACK, 'P']]);
  const { position, captured } = makeMove(pos, idx(4, 5), idx(4, 2));
  assert.equal(captured.type, 'P');
  assert.equal(position.cells[idx(4, 2)].type, 'R');
});

test('pseudoMoves 只生成该颜色的着法', () => {
  const pos = startPosition();
  assert.ok(pseudoMoves(pos, RED).every((m) => pos.cells[m.from].color === RED));
  assert.ok(pseudoMoves(pos, BLACK).every((m) => pos.cells[m.from].color === BLACK));
});
