import test from 'node:test';
import assert from 'node:assert/strict';

import { RED, BLACK, idx, emptyPosition, startPosition } from '../src/board.js';
import { legalMoves, makeMove } from '../src/rules.js';
import {
  formatMove, parseMove, parseAnyMove, parseCoords, dissect,
  legalNotations, positionalPrefix, colOfFile, fileOfCol,
} from '../src/notation.js';

function build(turn, list) {
  const pos = emptyPosition(turn);
  for (const [col, row, color, type] of list) pos.cells[idx(col, row)] = { color, type };
  return pos;
}
const note = (pos, from, to) => formatMove(pos, from, to);
const move = (pos, from, to) => parseMove(pos, note(pos, from, to));

// ---------------------------------------------------------------- 纵线编号

test('纵线编号：红方从右往左用汉字，黑方从左往右用阿拉伯数字', () => {
  assert.equal(fileOfCol(RED, 8), 1);
  assert.equal(fileOfCol(RED, 0), 9);
  assert.equal(fileOfCol(BLACK, 0), 1);
  assert.equal(fileOfCol(BLACK, 8), 9);
  for (let col = 0; col < 9; col++) {
    assert.equal(colOfFile(RED, fileOfCol(RED, col)), col);
    assert.equal(colOfFile(BLACK, fileOfCol(BLACK, col)), col);
  }
});

// ---------------------------------------------------------------- 开局记谱

test('开局红方的记谱与棋谱写法一致', () => {
  const pos = startPosition();
  assert.equal(note(pos, idx(7, 7), idx(4, 7)), '炮二平五');
  assert.equal(note(pos, idx(1, 7), idx(4, 7)), '炮八平五');
  assert.equal(note(pos, idx(7, 7), idx(4, 2)), '炮二进五', '红方过河吃卒是「进」');
  assert.equal(note(pos, idx(1, 9), idx(2, 7)), '马八进七');
  assert.equal(note(pos, idx(7, 9), idx(6, 7)), '马二进三');
  assert.equal(note(pos, idx(0, 9), idx(0, 8)), '车九进一');
  assert.equal(note(pos, idx(8, 9), idx(8, 7)), '车一进二');
  assert.equal(note(pos, idx(2, 6), idx(2, 5)), '兵七进一');
  assert.equal(note(pos, idx(0, 6), idx(0, 5)), '兵九进一');
  assert.equal(note(pos, idx(4, 9), idx(4, 8)), '帅五进一');
  assert.equal(note(pos, idx(3, 9), idx(4, 8)), '仕六进五', '士走斜线，进退后面跟目标纵线');
  assert.equal(note(pos, idx(2, 9), idx(0, 7)), '相七进九');
  assert.equal(note(pos, idx(2, 9), idx(4, 7)), '相七进五');
});

test('开局黑方的记谱用阿拉伯数字', () => {
  const pos = { ...startPosition(), turn: BLACK };
  assert.equal(note(pos, idx(1, 2), idx(4, 2)), '炮2平5');
  assert.equal(note(pos, idx(1, 0), idx(2, 2)), '马2进3');
  assert.equal(note(pos, idx(2, 3), idx(2, 4)), '卒3进1');
  assert.equal(note(pos, idx(8, 0), idx(8, 1)), '车9进1');
  assert.equal(note(pos, idx(4, 0), idx(4, 1)), '将5进1');
});

test('「进」的方向是相对各方的：红方进 = 行号变小，黑方进 = 行号变大', () => {
  const red = build(RED, [[4, 9, RED, 'K'], [3, 0, BLACK, 'K'], [0, 4, RED, 'P']]);
  assert.equal(note(red, idx(0, 4), idx(0, 3)), '兵九进一');
  assert.equal(note(red, idx(0, 4), idx(0, 5)), '兵九退一');

  const black = build(BLACK, [[4, 9, RED, 'K'], [3, 0, BLACK, 'K'], [0, 5, BLACK, 'P']]);
  assert.equal(note(black, idx(0, 5), idx(0, 6)), '卒1进1');
  assert.equal(note(black, idx(0, 5), idx(0, 4)), '卒1退1');
});

test('平着走：同一行横移，后面跟目标纵线', () => {
  const pos = build(RED, [[4, 9, RED, 'K'], [3, 0, BLACK, 'K'], [0, 4, RED, 'P']]);
  assert.equal(note(pos, idx(0, 4), idx(1, 4)), '兵九平八');
});

// ---------------------------------------------------------------- 同列重子

test('同列两枚：用前/后区分并省略起始纵线', () => {
  const pos = build(RED, [
    [4, 9, RED, 'K'], [3, 0, BLACK, 'K'],
    [0, 9, RED, 'R'], [0, 7, RED, 'R'], [0, 3, BLACK, 'P'],
  ]);
  assert.equal(positionalPrefix(pos, idx(0, 7)), '前', '红方的「前」是行号小的那枚');
  assert.equal(positionalPrefix(pos, idx(0, 9)), '后');
  assert.equal(note(pos, idx(0, 7), idx(0, 6)), '前车进一');
  assert.equal(note(pos, idx(0, 9), idx(0, 8)), '后车进一');
  assert.equal(note(pos, idx(0, 7), idx(0, 8)), '前车退一', '红方往回走是退');
  assert.equal(note(pos, idx(0, 7), idx(0, 3)), '前车进四');
  assert.equal(note(pos, idx(0, 7), idx(4, 7)), '前车平五');
});

test('黑方的「前」与红方相反：行号大的那枚在前', () => {
  const pos = build(BLACK, [
    [4, 9, RED, 'K'], [3, 0, BLACK, 'K'],
    [0, 0, BLACK, 'R'], [0, 2, BLACK, 'R'],
  ]);
  assert.equal(positionalPrefix(pos, idx(0, 2)), '前');
  assert.equal(positionalPrefix(pos, idx(0, 0)), '后');
  assert.equal(note(pos, idx(0, 2), idx(0, 3)), '前车进1');
});

test('同列三枚用前/中/后', () => {
  const pos = build(RED, [
    [4, 9, RED, 'K'], [3, 0, BLACK, 'K'],
    [0, 9, RED, 'P'], [0, 7, RED, 'P'], [0, 5, RED, 'P'],
  ]);
  assert.equal(positionalPrefix(pos, idx(0, 5)), '前');
  assert.equal(positionalPrefix(pos, idx(0, 7)), '中');
  assert.equal(positionalPrefix(pos, idx(0, 9)), '后');
});

test('同列只有一枚时不加前缀', () => {
  const pos = startPosition();
  assert.equal(positionalPrefix(pos, idx(1, 7)), null);
  assert.equal(positionalPrefix(pos, idx(0, 9)), null);
});

test('同列四枚用「前/二/三/后」（东萍派事实标准；官规对四枚以上是空白）', () => {
  const pos = build(RED, [
    [4, 9, RED, 'K'], [3, 0, BLACK, 'K'],
    [0, 1, RED, 'P'], [0, 3, RED, 'P'], [0, 5, RED, 'P'], [0, 7, RED, 'P'],
  ]);
  assert.equal(positionalPrefix(pos, idx(0, 1)), '前');
  assert.equal(positionalPrefix(pos, idx(0, 3)), '二');
  assert.equal(positionalPrefix(pos, idx(0, 5)), '三');
  assert.equal(positionalPrefix(pos, idx(0, 7)), '后', '最后一枚仍叫「后」，不是「四」');
});

test('同列五枚用「前/二/三/四/后」', () => {
  const pos = build(RED, [
    [4, 9, RED, 'K'], [3, 0, BLACK, 'K'],
    [0, 1, RED, 'P'], [0, 2, RED, 'P'], [0, 4, RED, 'P'], [0, 6, RED, 'P'], [0, 8, RED, 'P'],
  ]);
  assert.deepEqual(
    [idx(0, 1), idx(0, 2), idx(0, 4), idx(0, 6), idx(0, 8)].map((i) => positionalPrefix(pos, i)),
    ['前', '二', '三', '四', '后'],
  );
});

test('四枚以上同线的记谱照样唯一且能往返', () => {
  const pos = build(RED, [
    [4, 9, RED, 'K'], [3, 0, BLACK, 'K'],
    [0, 1, RED, 'P'], [0, 2, RED, 'P'], [0, 4, RED, 'P'], [0, 6, RED, 'P'], [0, 8, RED, 'P'],
  ]);
  const all = legalNotations(pos);
  const seen = new Set();
  for (const entry of all) {
    assert.ok(!seen.has(entry.notation), `「${entry.notation}」重复`);
    seen.add(entry.notation);
    const back = parseMove(pos, entry.notation);
    assert.equal(back.from, entry.from, `「${entry.notation}」起点对不上`);
    assert.equal(back.to, entry.to, `「${entry.notation}」终点对不上`);
  }
  const prefixes = all.map((e) => e.notation.slice(0, 1));
  for (const p of ['前', '二', '三', '四', '后']) {
    assert.ok(prefixes.includes(p), `没有生成以「${p}」开头的记谱`);
  }
});

// ---------------------------------------------------------------- 往返一致

test('逐着往返：开局的每一步都能原样解析回来', () => {
  const pos = startPosition();
  for (const m of legalMoves(pos)) {
    const text = formatMove(pos, m.from, m.to);
    const back = parseMove(pos, text);
    assert.equal(back.from, m.from, `${text} 的起点对不上`);
    assert.equal(back.to, m.to, `${text} 的终点对不上`);
    assert.equal(back.notation, text);
  }
});

test('记谱无歧义：同一局面下每一步的记谱互不相同', () => {
  const pos = startPosition();
  const all = legalNotations(pos);
  const seen = new Set();
  for (const { notation } of all) {
    assert.ok(!seen.has(notation), `开局里「${notation}」出现了两次`);
    seen.add(notation);
  }
  assert.equal(seen.size, all.length);
});

test('穷举往返：深度 2 可达的每个局面、每一步都往返一致且记谱唯一', () => {
  const start = startPosition();
  let positions = 0;
  let moves = 0;
  const walk = (pos, depth) => {
    const all = legalNotations(pos);
    const seen = new Set();
    for (const entry of all) {
      assert.ok(!seen.has(entry.notation), `局面 ${pos.turn} 里「${entry.notation}」重复`);
      seen.add(entry.notation);
      const back = parseMove(pos, entry.notation);
      assert.equal(back.from, entry.from);
      assert.equal(back.to, entry.to);
      moves++;
      if (depth > 1) walk(makeMove(pos, entry.from, entry.to).position, depth - 1);
    }
    positions++;
  };
  walk(start, 2);
  assert.equal(positions, 1 + 44, '深度 2 应覆盖 1 个根局面 + 44 个子局面');
  assert.equal(moves, 44 + 1920);
});

// ---------------------------------------------------------------- 坐标

test('坐标写法：字母行列与数字行列都能解析', () => {
  assert.deepEqual(parseCoords('h2-e2'), { from: idx(7, 2), to: idx(4, 2) });
  assert.deepEqual(parseCoords('h2e2'), { from: idx(7, 2), to: idx(4, 2) });
  assert.deepEqual(parseCoords('7,2-4,2'), { from: idx(7, 2), to: idx(4, 2) });
  assert.deepEqual(parseCoords('7,2 4,2'), { from: idx(7, 2), to: idx(4, 2) });
  assert.throws(() => parseCoords('乱写'), /坐标写法/);
});

test('parseAnyMove 同时收记谱和坐标，并统一回记为记谱', () => {
  const pos = startPosition();
  assert.equal(parseAnyMove(pos, '炮二平五').notation, '炮二平五');
  assert.equal(parseAnyMove(pos, 'h7-e7').notation, '炮二平五');
  assert.equal(parseAnyMove(pos, '7,7-4,7').notation, '炮二平五');
  assert.deepEqual(parseAnyMove(pos, 'h7-e7').to, idx(4, 7));
});

// ---------------------------------------------------------------- 容错与报错

test('繁体与异体字都认', () => {
  const pos = startPosition();
  assert.equal(parseMove(pos, '車九進一').notation, '车九进一');
  assert.equal(parseMove(pos, '馬八進七').notation, '马八进七');
  assert.equal(parseMove(pos, '帥五進一').notation, '帅五进一');
  assert.equal(parseMove(pos, '砲二平五').notation, '炮二平五');
  assert.equal(parseMove(pos, '俥一进一').notation, '车一进一');
});

test('全角数字与空格都能容忍', () => {
  const pos = { ...startPosition(), turn: BLACK };
  assert.equal(parseMove(pos, ' 炮 ２ 平 ５ ').notation, '炮2平5');
});

test('长度不对的记谱报错', () => {
  assert.throws(() => parseMove(startPosition(), '炮二平'), /四个字/);
});

test('不认识棋子名时报错', () => {
  assert.throws(() => parseMove(startPosition(), 'Ｘ二平五'), /不是棋子名/);
});

test('动作字不对时报错', () => {
  assert.throws(() => parseMove(startPosition(), '炮二飞五'), /进\/退\/平/);
});

test('合法局面里不存在的着法报错，并在信息里列出合法着法', () => {
  const pos = startPosition();
  assert.throws(() => parseMove(pos, '帅五进三'), /不是当前局面下红方的合法着法.*合法着法有/);
  assert.throws(() => parseMove(pos, '车五平四'), /合法着法有/);
});

test('dissect 拆得出棋子类型与三段动作', () => {
  assert.deepEqual(dissect('炮二平五'), { type: 'C', prefix: null, startFile: '二', action: '平', target: '五', text: '炮二平五' });
  assert.deepEqual(dissect('前车进一'), { type: 'R', prefix: '前', startFile: null, action: '进', target: '一', text: '前车进一' });
  assert.equal(dissect('马八进七').type, 'N');
  assert.equal(dissect('卒3进1').type, 'P');
  assert.equal(dissect('帥五進一').type, 'K', '异体字也要认出棋子类型');
  assert.equal(dissect('帥五進一').action, '进', '繁体「進」要归一成「进」');
});
