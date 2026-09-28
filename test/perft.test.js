// perft：从标准开局逐层穷举合法着法，把总叶子数与公开数值比对。
//
// 这是对着法生成器最硬的一层验证——它同时压到每一种子力的走法、
// 蹩马腿/塞象眼/炮翻山/兵过河、自将过滤和将帅照面。数字对不上就是引擎有 bug。
//
// 公开的中国象棋 perft 数值：深度 1 = 44，2 = 1920，3 = 79666，4 = 3290240。

import test from 'node:test';
import assert from 'node:assert/strict';

import { startPosition } from '../src/board.js';
import { legalMoves, makeMove } from '../src/rules.js';

function perft(pos, depth) {
  const moves = legalMoves(pos);
  if (depth <= 1) return moves.length;
  let nodes = 0;
  for (const m of moves) {
    nodes += perft(makeMove(pos, m.from, m.to).position, depth - 1);
  }
  return nodes;
}

test('perft 深度 1 = 44', () => {
  assert.equal(perft(startPosition(), 1), 44);
});

test('perft 深度 2 = 1920', () => {
  assert.equal(perft(startPosition(), 2), 1920);
});

test('perft 深度 3 = 79666', () => {
  assert.equal(perft(startPosition(), 3), 79666);
});

// 深度 4 要跑几千万次攻击判定，单独慢跑：node --test --test-name-pattern=3290240
test('perft 深度 4 = 3290240', { timeout: 300000 }, () => {
  assert.equal(perft(startPosition(), 4), 3290240);
});
