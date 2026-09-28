// 把一串着法回放进某个会话的棋局，写进 state/games.json。
//
// 用途：给一个会话预置局面。最实际的场景是「重启 dsh web 之前，先把正在下的棋
// 存下来」——因为棋局是会话各自持有的，重启会丢内存里的那份。
//
// 用法：
//   node scripts/seed-game.mjs <会话id> "兵三进一,炮2平5"
//   node scripts/seed-game.mjs <会话id> --show     只打印回放结果，不写盘

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { newGame, applyNotation, serializeGame, gameReport } from '../lib/game.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = process.env.DSH_XIANGQI_STATE_DIR || path.join(ROOT, 'state');
const gamesFile = path.join(stateDir, 'games.json');

const [sessionId, movesArg] = process.argv.slice(2);
if (!sessionId || !movesArg) {
  console.error('用法：node scripts/seed-game.mjs <会话id> "兵三进一,炮2平5"');
  process.exit(1);
}

let game = newGame('game');
const moves = movesArg.split(/[,，\s]+/).filter(Boolean);
for (const move of moves) {
  const played = applyNotation(game, move);
  game = played.game;
  console.log(`✓ ${played.move.notation}`);
}

console.log(`\n${gameReport(game)}\n`);

if (movesArg === '--show') process.exit(0);

let store = {};
try { store = JSON.parse(readFileSync(gamesFile, 'utf8')) || {}; } catch { /* 还没有存盘文件 */ }
store[sessionId] = serializeGame(game);
mkdirSync(stateDir, { recursive: true });
writeFileSync(gamesFile, `${JSON.stringify(store, null, 2)}\n`);
console.log(`已写入 ${gamesFile}，会话 ${sessionId}`);
console.log(`里面现在有 ${Object.keys(store).length} 盘棋。`);
