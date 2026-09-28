// 中文记谱（「炮二平五」）与内部着法的互转。
//
// 记谱的结构固定是四个字：
//   [前/中/后/序号] <棋子名> [起始纵线] <进/退/平> <目标>
// 用了前/中/后这类位置前缀时，起始纵线省略；否则起始纵线必须在。
// 所以字符串长度恒为 4 个字，第一个字是不是棋子名就决定了有没有前缀。
//
// 纵线编号是两方各自从自己的右边往左数：
//   红方在下（row 9），面朝上，右手边是屏幕右侧 → col 8 记作「一」、col 0 记作「九」
//   黑方在上（row 0），面朝下，右手边是屏幕左侧 → col 0 记作「1」、col 8 记作「9」
// 因此红方用汉字数字、黑方用阿拉伯数字。
//
// 一个反直觉之处：记谱里的「进」是「朝对方底线走」，所以红方的进是行号变小。
//
// 棋子名不携带颜色信息——「车」两方都用。颜色由「轮到谁走」唯一决定，
// 所以解析时不必也从字面上判断颜色。

import { RED, BLACK, ROWS, colOf, rowOf, idx, NAMES } from './board.js';
import { legalMoves } from './rules.js';

const CN_DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const AR_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** 直线走子：进/退后面跟步数；其余（马象士）跟目标纵线。 */
const LINEAR = new Set(['R', 'C', 'P', 'K']);

/** 棋子名（含繁体与常见异体）→ 类型。只判类型，不判颜色。 */
const NAME_TO_TYPE = (() => {
  const table = new Map();
  for (const color of [RED, BLACK]) {
    for (const [type, name] of Object.entries(NAMES[color])) table.set(name, type);
  }
  // 繁体：红方作「帥仕相傌俥炮兵」，黑方作「將士象馬車砲卒」
  const variants = {
    俥: 'R', 車: 'R', 傌: 'N', 馬: 'N', 砲: 'C', 包: 'C', 礮: 'C',
    帥: 'K', 將: 'K',
  };
  for (const [variant, type] of Object.entries(variants)) table.set(variant, type);
  return table;
})();

const FULLWIDTH = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' };

function normalize(text) {
  return String(text)
    .replace(/\s+/g, '')
    .replace(/[０-９]/g, (c) => FULLWIDTH[c] || c)
    .replace(/進/g, '进')
    .replace(/後/g, '后');
}

function digitValue(ch) {
  const cn = CN_DIGITS.indexOf(ch);
  if (cn >= 0) return cn + 1;
  const ar = AR_DIGITS.indexOf(ch);
  return ar >= 0 ? ar + 1 : null;
}

/** 纵线号（1..9）→ 列号（0..8）。 */
export function colOfFile(color, file) {
  return color === RED ? 9 - file : file - 1;
}

/** 列号（0..8）→ 纵线号（1..9）。 */
export function fileOfCol(color, col) {
  return color === RED ? 9 - col : col + 1;
}

function fileChar(color, file) {
  return color === RED ? CN_DIGITS[file - 1] : AR_DIGITS[file - 1];
}

function numChar(color, n) {
  return color === RED ? CN_DIGITS[n - 1] : AR_DIGITS[n - 1];
}

/** 同一纵线上同色同种的棋子，按「前 → 后」排序（前 = 靠近对方底线）。 */
function fileGroup(pos, from) {
  const piece = pos.cells[from];
  const col = colOf(from);
  const group = [];
  for (let row = 0; row < ROWS; row++) {
    const p = pos.cells[idx(col, row)];
    if (p && p.color === piece.color && p.type === piece.type) group.push(idx(col, row));
  }
  // 红方的「前」是行号小的（靠近 row 0），黑方反之
  group.sort((a, b) => (piece.color === RED ? rowOf(a) - rowOf(b) : rowOf(b) - rowOf(a)));
  return group;
}

/**
 * 位置前缀。同列只有这一枚时返回 null——此时记谱必须写出起始纵线。
 *
 * 两枚用「前/后」，三枚用「前/中/后」，这两条有官方规则背书。
 *
 * 四枚及以上在官方规则里是空白：《象棋竞赛规则》2011/2020 版第 7 条、
 * WXF《世界象棋规则》2018 版 7.5、亚洲象棋联合会 2017 规例都只写到三枚。
 * 市面存在两套互相冲突的写法，这里采用事实标准（东萍 DhtmlXQ、皮卡鱼）：
 * 最前与最后仍叫「前/后」，中间从前往后依次编号——
 * 4 枚是「前、二、三、后」，5 枚是「前、二、三、四、后」。
 * 另一套（象棋百科全书 xqbase）是「一、二、三、四」，采用面窄，未采用。
 * 详见 docs/notation-conventions.md。
 *
 * 「前」的判定：靠近对方底线的一枚为前。本项目行号自黑方底线起算，
 * 所以红方的「前」是行号小的那枚、黑方是行号大的那枚。
 */
export function positionalPrefix(pos, from) {
  const group = fileGroup(pos, from);
  if (group.length < 2) return null;
  const index = group.indexOf(from);
  if (group.length === 2) return index === 0 ? '前' : '后';
  if (group.length === 3) return ['前', '中', '后'][index];
  if (index === 0) return '前';
  if (index === group.length - 1) return '后';
  return numChar(pos.cells[from].color, index + 1);
}

/** 把一步棋写成中文记谱。pos 必须是走这一步「之前」的局面。 */
export function formatMove(pos, from, to) {
  const piece = pos.cells[from];
  if (!piece) throw new Error('起点没有棋子，无法记谱');
  const { color, type } = piece;
  const fromRow = rowOf(from);
  const toRow = rowOf(to);

  const prefix = positionalPrefix(pos, from);
  const filePart = prefix ? '' : fileChar(color, fileOfCol(color, colOf(from)));

  let action;
  let target;
  if (toRow === fromRow) {
    action = '平';
    target = fileChar(color, fileOfCol(color, colOf(to)));
  } else {
    const advancing = color === RED ? toRow < fromRow : toRow > fromRow;
    action = advancing ? '进' : '退';
    target = LINEAR.has(type)
      ? numChar(color, Math.abs(toRow - fromRow))
      : fileChar(color, fileOfCol(color, colOf(to)));
  }
  return `${prefix || ''}${NAMES[color][type]}${filePart}${action}${target}`;
}

/** 把一条记谱拆成棋子类型、可选前缀、动作与目标。格式不对就抛错。 */
export function dissect(notation) {
  const text = normalize(notation);
  if (text.length !== 4) {
    throw new Error(`记谱应为四个字（如「炮二平五」），收到「${notation}」`);
  }
  // 两种形式的动作与目标都落在第 3、4 个字上，区别只在开头：
  //   有前缀 → [前缀][棋子名][动作][目标]
  //   无前缀 → [棋子名][起始纵线][动作][目标]
  let prefix = null;
  let nameChar = text[0];
  let startFile = text[1];
  if (!NAME_TO_TYPE.has(nameChar)) {
    prefix = text[0];
    nameChar = text[1];
    startFile = null;
  }
  const type = NAME_TO_TYPE.get(nameChar);
  if (!type) throw new Error(`记谱里的「${nameChar}」不是棋子名：「${notation}」`);
  if (!prefix && digitValue(startFile) === null) {
    throw new Error(`记谱里的「${startFile}」应为起始纵线：「${notation}」`);
  }
  const action = text[2];
  const target = text[3];
  if (!['进', '退', '平'].includes(action)) {
    throw new Error(`记谱里的「${action}」应为进/退/平：「${notation}」`);
  }
  if (digitValue(target) === null) {
    throw new Error(`记谱的目标「${target}」不是数字：「${notation}」`);
  }
  return { type, prefix, startFile, action, target, text };
}

/** 当前局面下全部合法着法及其记谱。 */
export function legalNotations(pos) {
  return legalMoves(pos).map((m) => ({
    notation: formatMove(pos, m.from, m.to),
    from: m.from,
    to: m.to,
  }));
}

/** 记谱的结构指纹，用来比对而不受异体字写法影响。 */
function shapeOf(d) {
  return [d.type, d.prefix || '', d.startFile || '', d.action, d.target].join('|');
}

/**
 * 解析一条中文记谱。
 *
 * 做法不是反向推导，而是把当前全部合法着法都记谱化再比对——这样
 * 「格式化 → 解析」的往返一致性由构造保证，不依赖两套反向逻辑互相对齐。
 * 比对走结构指纹而不是字符串，于是「車/车」「馬/马」这类异体字照样认得。
 * 代价是非法记谱只能报「对不上」，所以错误信息里会附上合法着法。
 */
export function parseMove(pos, notation) {
  const wanted = shapeOf(dissect(notation)); // 先做格式体检，好给出比「对不上」更具体的错
  const all = legalNotations(pos);
  const hits = all.filter((entry) => shapeOf(dissect(entry.notation)) === wanted);
  if (hits.length === 1) return { from: hits[0].from, to: hits[0].to, notation: hits[0].notation };
  if (hits.length > 1) {
    throw new Error(`记谱「${notation}」在当前局面下对应多个着法，记谱本身有歧义`);
  }
  const sample = all.slice(0, 20).map((e) => e.notation).join(' ');
  const more = all.length > 20 ? ' …' : '';
  const whose = pos.turn === RED ? '红方' : '黑方';
  throw new Error(`「${notation}」不是当前局面下${whose}的合法着法。合法着法有：${sample}${more}`);
}

/** 解析坐标写法：h2-e2 / h2e2 / 7,2-4,2 / 7,2 4,2。列用 a-i 或 0-8，行用 0-9。 */
export function parseCoords(text) {
  const s = normalize(String(text).toLowerCase());
  const m = /^([a-i]|\d),?(\d)-([a-i]|\d),?(\d)$/.exec(s)
    || /^([a-i]|\d),?(\d)([a-i]|\d),?(\d)$/.exec(s);
  if (!m) throw new Error(`坐标写法应形如 h2-e2 或 7,2-4,2，收到「${text}」`);
  const col = (v) => (/[a-i]/.test(v) ? v.charCodeAt(0) - 97 : Number(v));
  return { from: idx(col(m[1]), Number(m[2])), to: idx(col(m[3]), Number(m[4])) };
}

/** 统一入口：中文记谱或坐标都收。 */
export function parseAnyMove(pos, text) {
  const raw = String(text).trim();
  const looksLikeCoords = /^[a-i0-8][,]?\d\s*[- ]?\s*[a-i0-8][,]?\d$/i.test(raw);
  if (looksLikeCoords) {
    const { from, to } = parseCoords(raw);
    const legal = legalMoves(pos).some((m) => m.from === from && m.to === to);
    if (!legal) throw new Error(`坐标着法「${text}」不是合法着法`);
    return { from, to, notation: formatMove(pos, from, to) };
  }
  return parseMove(pos, raw);
}

export { CN_DIGITS, AR_DIGITS, LINEAR, NAME_TO_TYPE };
