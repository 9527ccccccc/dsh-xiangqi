import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RED, BLACK, START_FEN, NAMES, idx, colOf, rowOf, onBoard, other,
  parseFen, toFen, startPosition, positionKey, findKing, formatBoard, charToPiece,
} from '../src/board.js';

test('FEN 往返：标准开局的棋盘部分一字不差', () => {
  const pos = startPosition();
  assert.equal(toFen(pos), START_FEN);
});

test('FEN 往返：任意局面 parse -> toFen -> parse 得到同一个局面', () => {
  const fen = '4k4/3P1P3/9/9/9/4R4/9/9/9/3K5 b - - 0 1';
  const a = parseFen(fen);
  const b = parseFen(toFen(a));
  assert.deepEqual(b, a);
});

test('开局双方各 16 枚棋子，红方在下、黑方在上', () => {
  const pos = startPosition();
  const reds = pos.cells.filter((p) => p && p.color === RED);
  const blacks = pos.cells.filter((p) => p && p.color === BLACK);
  assert.equal(reds.length, 16);
  assert.equal(blacks.length, 16);
  assert.equal(pos.turn, RED);
  assert.equal(pos.cells[idx(4, 9)].type, 'K');
  assert.equal(pos.cells[idx(4, 0)].type, 'K');
});

test('红方使用「帅仕相」，黑方使用「将士象」', () => {
  assert.equal(NAMES.red.K, '帅');
  assert.equal(NAMES.black.K, '将');
  assert.equal(NAMES.red.C, '炮');
  assert.equal(NAMES.black.P, '卒');
});

test('findKing 能找到双方将帅', () => {
  const pos = startPosition();
  assert.equal(findKing(pos, RED), idx(4, 9));
  assert.equal(findKing(pos, BLACK), idx(4, 0));
});

test('FEN 大小写决定阵营：大写为红、小写为黑', () => {
  assert.deepEqual(charToPiece('R'), { color: RED, type: 'R' });
  assert.deepEqual(charToPiece('r'), { color: BLACK, type: 'R' });
  assert.equal(charToPiece('X'), null);
});

test('parseFen 拒绝行数不对的 FEN', () => {
  assert.throws(() => parseFen('rnbakabnr/9/9/9/9/9/9/9/9 w'), /行数/);
});

test('parseFen 拒绝一行宽度不对的 FEN', () => {
  assert.throws(() => parseFen('rnbakabnr/8/9/9/9/9/9/9/9/RNBAKABNR w - - 0 1'), /宽度/);
});

test('parseFen 拒绝无法识别的字符', () => {
  assert.throws(() => parseFen('xnbakabnr/9/9/9/9/9/9/9/9/RNBAKABNR w - - 0 1'), /无法识别/);
});

test('局面指纹同盘不同轮次算两个局面', () => {
  const red = startPosition();
  const black = { ...red, turn: BLACK };
  assert.notEqual(positionKey(red), positionKey(black));
  assert.equal(positionKey(red), positionKey(startPosition()));
});

test('坐标换算自洽，且越界能被识别', () => {
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 9; col++) {
      assert.equal(colOf(idx(col, row)), col);
      assert.equal(rowOf(idx(col, row)), row);
      assert.ok(onBoard(col, row));
    }
  }
  assert.equal(onBoard(9, 0), false);
  assert.equal(onBoard(0, 10), false);
  assert.equal(onBoard(-1, 0), false);
});

test('other 在两方之间来回切', () => {
  assert.equal(other(RED), BLACK);
  assert.equal(other(BLACK), RED);
});

test('文本棋盘能打印出来且含全部 90 个位置', () => {
  const text = formatBoard(startPosition());
  assert.ok(text.includes('帅') && text.includes('将'));
  assert.equal((text.match(/·/g) || []).length, 90 - 32);
});
