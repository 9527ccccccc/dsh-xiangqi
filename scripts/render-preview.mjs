// 重新生成 README 里的两张棋盘预览图。
//
//   node scripts/render-preview.mjs
//
// 为什么要有这个脚本：README 顶上那张图如果不说明来历、又没人能重新生成，它迟早会
// 和代码画出来的东西对不上（这个仓库就发生过一次——README 放的是独立摆棋页的截图，
// 而「对局模式」其实长在 DSH 右栏里，两者不是一回事）。
//
// 两张图都是**真跑代码**出来的，不是手画的：
//   docs/board-panel.jpg       把 lib/client.js 的 drawScene 喂给真 canvas 渲出来
//   docs/board-standalone.jpg  直接打开 chinese-chess-board.html 截的
//
// Playwright 不在 package.json 的依赖里（仓库零运行时依赖），只在出图时需要：
//   - 先试 `import('playwright')`
//   - 不行就用环境变量 PLAYWRIGHT_PATH 指一个（可以是 playwright 包的目录）

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startPosition, toFen, idx } from '../src/board.js';
import { makeMove } from '../src/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** 把一串着法走到某个局面，并回报最后一步的起讫点（绘制落点圈要用）。 */
function playNotation(moves) {
  let position = startPosition();
  let last = null;
  for (const [from, to] of moves) {
    const next = makeMove(position, from, to);
    if (!next) throw new Error(`着法走不通：${from} → ${to}`);
    position = next.position;
    last = { from, to };
  }
  return { fen: toFen(position), last };
}

function loadPlaywright() {
  // playwright 是 CJS 包，用 require 取最稳（import 进来拿到的是 { default: ... }）。
  try {
    return require('playwright');
  } catch {
    const hint = process.env.PLAYWRIGHT_PATH;
    if (!hint) {
      console.error(
        '找不到 playwright。二选一：\n' +
        '  1) 装一份：npm i -D playwright && npx playwright install chromium\n' +
        '  2) 指到已有的一份：$env:PLAYWRIGHT_PATH="C:/path/to/node_modules/playwright"',
      );
      process.exit(1);
    }
    return require(hint);
  }
}

/**
 * 出「对局模式」那张：真拿 client.js 的 drawScene 画。
 *
 * 走两步棋再落一张图，是因为这样才能同时看到走过的落点圈和支招箭头——
 * 那两样正是面板相对独立摆棋页多出来的东西。
 */
async function renderPanel(chromium) {
  // 炮二平五、马8进7，然后给红方支一招马二进三
  const { fen, last } = playNotation([[idx(7, 7), idx(4, 7)], [idx(1, 0), idx(2, 2)]]);
  const hint = { from: idx(7, 9), to: idx(6, 7) };

  const dir = mkdtempSync(path.join(tmpdir(), 'xq-preview-'));
  const clientJs = pathToFileURL(path.join(ROOT, 'lib', 'client.js')).href;
  const harness = path.join(dir, 'harness.html');

  try {
    writeFileSync(harness, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>html,body{margin:0;background:#1b1a19}#wrap{padding:14px;display:inline-block}
canvas{display:block;border-radius:8px;box-shadow:0 8px 22px rgba(0,0,0,.38)}</style></head>
<body><div id="wrap"><canvas id="c"></canvas></div>
<script>window.__ModuleLoader__={load(d){window.__def=d}}<\/script>
<script src="${clientJs}"><\/script>
<script>
  // 冒充宿主那份冻结的模块表。只在模块顶层被取一次，而 drawScene 根本不碰它们。
  const fakeRequire = (id) => {
    if (id === 'react') return { useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
    throw new Error('预览脚本没准备这个模块：' + id);
  };
  const mod = window.__def.factory(fakeRequire);
  const cell = 52, m = cell * 0.62;
  const canvas = document.getElementById('c');
  const w = 8 * cell + m * 2, h = 9 * cell + m * 2;
  const dpr = 2;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  mod.__test__.drawScene(g, cell, ${JSON.stringify(fen)},
    { lastMove: ${JSON.stringify(last)}, hint: ${JSON.stringify(hint)}, history: [], result: null }, null);
  window.__ready = true;
<\/script></body></html>`);

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
      /** 页面里抛的错不能咽掉：一张「画了一半」的图混进 README 比没有图更糟。 */
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(pathToFileURL(harness).href);
      await page.waitForFunction(() => window.__ready === true);
      if (errors.length) throw new Error(`预览页里报错了：\n${errors.join('\n')}`);
      await page.locator('#wrap').screenshot({
        path: path.join(ROOT, 'docs', 'board-panel.jpg'),
        type: 'jpeg',
        quality: 90,
      });
    } finally {
      await browser.close();
    }
  } finally {
    // 临时目录的清理要在最外层：chromium.launch() 自己失败时也得删掉，
    // 否则每崩一次就在系统临时目录里留一个壳（这仓库刚因为同一类疏忽清过 1239 个）。
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('docs/board-panel.jpg');
}

/** 出「独立摆棋页」那张。 */
async function renderStandalone(chromium) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 840 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(path.join(ROOT, 'chinese-chess-board.html')).href);
    await page.waitForTimeout(1000);
    // 页脚那行说明不属于界面本体
    await page.addStyleTag({ content: '.tip{display:none}' });
    await page.screenshot({
      path: path.join(ROOT, 'docs', 'board-standalone.jpg'),
      type: 'jpeg',
      quality: 90,
      scale: 'css',
    });
  } finally {
    await browser.close();
  }
  console.log('docs/board-standalone.jpg');
}

const { chromium } = loadPlaywright();
await renderPanel(chromium);
await renderStandalone(chromium);
