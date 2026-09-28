// 随机对局模糊测试：用固定种子随机走棋，把走出来的每一个局面都拿来压记谱系统。
//
// 为什么需要它：标准开局里同一条纵线上不会有重复的同类棋子，
// 「前车/后车」「前中后兵」这些分支在上面根本走不到。只有真的下起来，
// 才会撞出同列重子、兵过河五子同线的局面。
//
// 每一层都检查两件事：
//   1. 同一局面下，所有合法着法的记谱必须互不相同（否则记谱有歧义，没法回读）
//   2. 每一条记谱都能原样解析回同一个着法（往返一致）
// 另外抽查记谱的形状：恒为四个字、拆得开、能对上棋子类型。

import test from 'node:test';
import assert from 'node:assert/strict';

import { RED, startPosition } from '../src/board.js';
import { legalMoves, makeMove, gameStatus } from '../src/rules.js';
import { formatMove, parseMove, dissect, legalNotations, positionalPrefix } from '../src/notation.js';

/** 固定种子的线性同余发生器，保证每次跑的是同一批棋。 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function playRandomGames({ games, maxPlies, seed }) {
  const random = rng(seed);
  const stats = {
    positions: 0, notations: 0, roundTrips: 0,
    duplicates: 0, prefixes: 0, multiFileGroups: 0,
  };

  for (let g = 0; g < games; g++) {
    let pos = startPosition();
    for (let ply = 0; ply < maxPlies; ply++) {
      const status = gameStatus(pos);
      if (status.state === 'checkmate' || status.state === 'stalemate') break;

      const all = legalNotations(pos);
      const seen = new Map();

      for (const entry of all) {
        // 1) 记谱唯一
        if (seen.has(entry.notation)) {
          stats.duplicates++;
          assert.fail(`局面出现歧义记谱「${entry.notation}」：\n${JSON.stringify(pos.cells.map((p) => p && p.type))}`);
        }
        seen.set(entry.notation, entry);

        // 2) 形状恒为四个字，且拆得开、类型对得上
        const d = dissect(entry.notation);
        assert.equal(d.text.length, 4);
        assert.equal(d.type, pos.cells[entry.from].type, `「${entry.notation}」的棋子类型对不上`);

        // 3) 往返一致
        const back = parseMove(pos, entry.notation);
        assert.equal(back.from, entry.from, `「${entry.notation}」起点对不上`);
        assert.equal(back.to, entry.to, `「${entry.notation}」终点对不上`);
        stats.roundTrips++;

        if (d.prefix) stats.prefixes++;
      }

      // 统计同列重子局面，确认测试真的覆盖到了那个分支
      for (let i = 0; i < pos.cells.length; i++) {
        if (pos.cells[i] && positionalPrefix(pos, i) !== null) { stats.multiFileGroups++; break; }
      }

      stats.positions++;
      stats.notations += all.length;
      pos = makeMove(pos, ...(() => {
        const m = all[Math.floor(random() * all.length)];
        return [m.from, m.to];
      })()).position;
    }
  }
  return stats;
}

test('随机对局 60 局 × 80 手：记谱全程无歧义、可往返', () => {
  const stats = playRandomGames({ games: 60, maxPlies: 80, seed: 20240607 });
  assert.ok(stats.positions > 3000, `覆盖率太低，只走到 ${stats.positions} 个局面`);
  assert.equal(stats.duplicates, 0);
  assert.ok(stats.roundTrips > 100000, `往返次数偏少：${stats.roundTrips}`);
  // 这两个分支必须被真的走到，否则这条测试是假绿
  assert.ok(stats.prefixes > 0, '一次「前/后」前缀都没走到，说明没覆盖同列重子');
  assert.ok(stats.multiFileGroups > 0, '一次同列重子局面都没撞到');
});

test('随机对局能走到分出胜负，且终局判定稳定', () => {
  const random = rng(99001);
  let finished = 0;
  for (let g = 0; g < 30; g++) {
    let pos = startPosition();
    for (let ply = 0; ply < 400; ply++) {
      const status = gameStatus(pos);
      if (status.state === 'checkmate' || status.state === 'stalemate') { finished++; break; }
      const moves = legalMoves(pos);
      const m = moves[Math.floor(random() * moves.length)];
      pos = makeMove(pos, m.from, m.to).position;
    }
  }
  assert.ok(finished > 0, '30 局随机棋一局都没下完，终局判定可能有问题');
});
