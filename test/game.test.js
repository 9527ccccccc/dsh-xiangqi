import test from 'node:test';
import assert from 'node:assert/strict';

import { RED, BLACK, idx, emptyPosition, startPosition, toFen } from '../src/board.js';
import {
  newGame, applyMove, applyNotation, undoRound, setHint, setMode, placePiece, removePiece,
  outcome, resultText, movesFrom, gameReport, serializeGame, deserializeGame,
  HALFMOVE_LIMIT, HUMAN,
} from '../lib/game.js';

function build(turn, list) {
  const position = emptyPosition(turn);
  for (const [col, row, color, type] of list) position.cells[idx(col, row)] = { color, type };
  return position;
}

test('新开一局：标准开局、红先', () => {
  const game = newGame();
  assert.equal(game.position.turn, RED);
  assert.equal(HUMAN, RED);
  assert.equal(game.history.length, 0);
  assert.equal(game.result, null);
  assert.equal(game.mode, 'game');
});

test('按记谱走一步：历史、轮次、FEN 都跟着变', () => {
  const before = newGame();
  const fenBefore = toFen(before.position);
  const { game, move } = applyNotation(before, '炮二平五');
  assert.equal(move.notation, '炮二平五');
  assert.equal(move.captured, null);
  assert.equal(game.position.turn, BLACK);
  assert.equal(game.history.length, 1);
  assert.equal(game.history[0].notation, '炮二平五');
  assert.equal(game.history[0].fenBefore, fenBefore, '要留下走之前的 FEN，悔棋靠它');
  assert.equal(before.position.turn, RED, '原局面不能被改动');
  assert.equal(before.history.length, 0);
});

test('按坐标走一步，结果与记谱一致', () => {
  const byCoord = applyMove(newGame(), idx(7, 7), idx(4, 7));
  assert.equal(byCoord.move.notation, '炮二平五');
  const byText = applyNotation(newGame(), '炮二平五');
  assert.equal(toFen(byCoord.game.position), toFen(byText.game.position));
});

test('非法着法抛错，并把「这枚子能走到哪」讲清楚', () => {
  const game = newGame();
  // 走记谱这条路：先在记谱层就拦住，报错里附上当前全部合法着法
  assert.throws(() => applyNotation(game, '帅五进三'), /不是当前局面下红方的合法着法.*合法着法有/);
  assert.throws(() => applyNotation(game, '车五平四'), /合法着法有/);
  // 直接给坐标这条路：由 applyMove 拦住，报出这枚子实际能走到哪里
  assert.throws(() => applyMove(game, idx(4, 9), idx(4, 6)), /帅在 \(4,9\)，走不到 \(4,6\)。它能走/);
  assert.throws(() => applyMove(game, idx(4, 9), idx(3, 9)), /它能走/);
});

test('还没轮到的一方不能走', () => {
  const { game } = applyNotation(newGame(), '炮二平五');
  assert.equal(game.position.turn, BLACK);
  // 现在轮到黑方，红方的子动不了
  assert.throws(() => applyMove(game, idx(0, 9), idx(0, 8)), /还没轮到红方走/);
});

test('起点没有棋子时报错', () => {
  assert.throws(() => applyMove(newGame(), idx(4, 5), idx(4, 4)), /没有棋子/);
});

test('悔棋：轮到人走时退一轮，轮到会话走时退一步', () => {
  // 只走了红方一步 → 轮到黑方 → 悔一步就回到红方
  const one = applyNotation(newGame(), '炮二平五').game;
  const back1 = undoRound(one, HUMAN);
  assert.equal(back1.undone, 1);
  assert.equal(back1.turn, RED);
  assert.equal(back1.game.history.length, 0);
  assert.equal(toFen(back1.game.position), toFen(startPosition()));

  // 双方各走一步 → 又轮到红方 → 悔两个半回合
  const two = applyNotation(one, '马8进7').game;
  assert.equal(two.position.turn, RED);
  const back2 = undoRound(two, HUMAN);
  assert.equal(back2.undone, 2);
  assert.equal(back2.turn, RED);
  assert.equal(back2.game.history.length, 0);
});

test('没走过棋时悔棋报错', () => {
  assert.throws(() => undoRound(newGame(), HUMAN), /没什么可悔/);
});

test('悔棋之后局面回到走之前，可以继续走', () => {
  const played = applyNotation(newGame(), '炮二平五').game;
  const back = undoRound(played, HUMAN).game;
  assert.equal(toFen(back.position), toFen(startPosition()));
  const again = applyNotation(back, '马八进七');
  assert.equal(again.move.notation, '马八进七');
});

test('支招：设置、清除，以及走棋后自动失效', () => {
  const game = newGame();
  const { game: hinted, hint } = setHint(game, '炮二平五');
  assert.equal(hint.notation, '炮二平五');
  assert.equal(hinted.hint.notation, '炮二平五');
  assert.equal(toFen(hinted.position), toFen(game.position), '支招不改局面');

  const cleared = setHint(hinted, null).game;
  assert.equal(cleared.hint, null);

  const moved = applyNotation(hinted, '炮二平五').game;
  assert.equal(moved.hint, null, '走过棋之后旧支招应当失效');
});

test('支招给一条非法着法要报错', () => {
  assert.throws(() => setHint(newGame(), '帅五进三'), /.+/);
});

test('将死：终结这一局并给出胜者', () => {
  // 红车 (0,5) 走到 (0,0) 即成绝杀：黑将被自己的士堵住，两个落点都被车看着
  const position = build(RED, [
    [4, 9, RED, 'K'], [4, 5, RED, 'R'], [0, 5, RED, 'R'],
    [4, 0, BLACK, 'K'], [4, 1, BLACK, 'A'],
  ]);
  const game = newGame('game', position);
  const { game: done, move } = applyMove(game, idx(0, 5), idx(0, 0));
  assert.equal(move.notation, '车九进五');
  assert.ok(done.result, '应当已经终局');
  assert.equal(done.result.winner, RED);
  assert.equal(done.result.reason, '将死');
  assert.match(resultText(done), /红方胜/);
});

test('困毙也判负，不是和棋', () => {
  const position = build(BLACK, [
    [4, 0, BLACK, 'K'], [3, 1, RED, 'P'], [5, 1, RED, 'P'], [3, 9, RED, 'K'],
  ]);
  const game = newGame('game', position);
  assert.equal(outcome(game).winner, RED);
  assert.equal(outcome(game).reason, '困毙');
});

test('终局之后不能再走', () => {
  const position = build(RED, [
    [4, 9, RED, 'K'], [4, 5, RED, 'R'], [0, 5, RED, 'R'],
    [4, 0, BLACK, 'K'], [4, 1, BLACK, 'A'],
  ]);
  const { game: done } = applyMove(newGame('game', position), idx(0, 5), idx(0, 0));
  assert.throws(() => applyMove(done, idx(4, 5), idx(4, 4)), /已经结束/);
});

test('三次重复局面判和', () => {
  // 双方各自把车来回挪：四个半回合之后回到起点，重复三次即和
  const shuffle = ['车九进一', '车1进1', '车九退一', '车1退1'];
  let game = newGame();
  for (let round = 0; round < 2; round++) {
    for (const notation of shuffle) {
      game = applyNotation(game, notation).game;
    }
  }
  assert.equal(game.position.turn, RED);
  assert.equal(game.history.length, 8);
  assert.ok(game.result, '走了两轮往返之后应当判和');
  assert.match(game.result.reason, /重复/);
  assert.equal(game.result.winner, null);
});

test('60 回合无吃子判和', () => {
  const game = newGame();
  game.halfmoveClock = HALFMOVE_LIMIT;
  const verdict = outcome(game);
  assert.equal(verdict.winner, null);
  assert.match(verdict.reason, /无吃子/);
});

test('吃子会清零无吃子计数', () => {
  let game = newGame();
  game = applyNotation(game, '炮二平五').game;
  game = applyNotation(game, '马8进7').game;
  game = applyNotation(game, '炮五进四').game; // 吃掉黑卒 (4,3)
  assert.equal(game.history[2].captured.type, 'P');
  assert.equal(game.halfmoveClock, 0);
});

test('gameReport 里带棋盘、轮次、FEN 与着法', () => {
  const game = applyNotation(newGame(), '炮二平五').game;
  const report = gameReport(game);
  assert.match(report, /模式：对局/);
  assert.match(report, /轮到：黑方/);
  assert.match(report, /FEN：rnbakabnr/);
  assert.match(report, /着法：1\.炮二平五/);
});

test('movesFrom 给出这枚子的合法着法，含中文记谱', () => {
  const game = newGame();
  const options = movesFrom(game, idx(7, 7));
  const notations = options.map((m) => m.notation);
  assert.ok(notations.includes('炮二平五'));
  assert.ok(notations.includes('炮二进四'));
  assert.ok(options.every((m) => m.target.startsWith('(')));
});

test('movesFrom 对空点或越界返回空', () => {
  const game = newGame();
  assert.deepEqual(movesFrom(game, idx(4, 5)), []);
  assert.deepEqual(movesFrom(game, 999), []);
  assert.deepEqual(movesFrom(game, -1), []);
});

test('摆棋模式：放子、拿子、切模式', () => {
  const setup = setMode(newGame(), 'setup');
  assert.equal(setup.mode, 'setup');

  const placed = placePiece(setup, RED, 'R', 4, 4);
  assert.equal(placed.position.cells[idx(4, 4)].type, 'R');
  assert.equal(setup.position.cells[idx(4, 4)], null, '原局面不能被改动');

  const removed = removePiece(placed, 4, 4);
  assert.equal(removed.position.cells[idx(4, 4)], null);

  assert.throws(() => placePiece(newGame(), RED, 'R', 4, 4), /setup 模式/);
  assert.throws(() => placePiece(setup, RED, 'Z', 4, 4), /不认识这枚棋子/);
  assert.throws(() => setMode(newGame(), '乱写'), /模式只能是/);
});

test('摆棋模式下不能走子', () => {
  const setup = setMode(newGame(), 'setup');
  assert.throws(() => applyNotation(setup, '炮二平五'), /摆棋模式/);
});

test('存盘往返：序列化再反序列化得到同一盘棋，且还能接着下', () => {
  let game = newGame();
  game = applyNotation(game, '炮二平五').game;
  game = applyNotation(game, '马8进7').game;
  game = setHint(game, '车九进一').game;

  const revived = deserializeGame(JSON.parse(JSON.stringify(serializeGame(game))));
  assert.equal(toFen(revived.position), toFen(game.position));
  assert.deepEqual(revived.history, game.history);
  assert.deepEqual(revived.keys, game.keys);
  assert.equal(revived.halfmoveClock, game.halfmoveClock);
  assert.equal(revived.hint.notation, '车九进一');
  assert.equal(revived.mode, game.mode);

  const next = applyNotation(revived, '车九进一');
  assert.equal(next.move.notation, '车九进一');
});

test('存盘数据坏了要抛错，而不是悄悄给个空局', () => {
  assert.throws(() => deserializeGame(null), /缺 FEN/);
  assert.throws(() => deserializeGame({}), /缺 FEN/);
});
