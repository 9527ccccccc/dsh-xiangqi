// 插件的服务端半边（host）：持有棋局，并把棋局变成会话可调用的工具。
//
// 分工：真相在这里，浏览器半边只负责画和点。规则与记谱直接复用 src/ 里
// 那套已经被 perft 验证过的纯函数——注册成插件不需要改动它们一行。
//
// 工具契约照抄随包的 dsh-tool-todo：defineTool 编译参数与输出 schema，
// 并且会在 execute 之前先按 schema 校验入参。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { RED, BLACK, toFen, formatBoard } from '../src/board.js';
import { isInCheck } from '../src/rules.js';
import { legalNotations } from '../src/notation.js';
import {
  newGame, applyMove, applyNotation, undoRound, setHint, gameReport, gameView, resultText,
  movesFrom, serializeGame, deserializeGame, HUMAN,
} from './game.js';

export const name = 'dsh-xiangqi';
// 两个硬依赖，缺一不可，而且都是踩过坑才知道的：
//   connection —— 它的 apply 是 async 的（要 await BrowserAuth.create），不声明就会
//                 在服务注册之前跑，RPC 通道永远挂不上，面板一直显示「连不上棋局」。
//   webServer  —— rpc.handle() 内部要在 web server 上挂物理路由，它会检查调用方的
//                 fiber 有没有 inject webServer；漏了会在**整个插件树加载**时抛错，
//                 不是单个插件失败，是整个 GUI 起不来。
// 随包的 dsh-host-frontend-static 声明的正是 ["webServer", "connection"]。
export const inject = ['tools', 'connection', 'webServer'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 本插件注册的全部工具名，只用于启动信标与自检。 */
const TOOL_NAMES = ['xiangqi_board', 'xiangqi_move', 'xiangqi_undo', 'xiangqi_hint'];

/**
 * 启动信标：挂载时把一份极小的状态写到 state/host.json。
 *
 * 存在的理由是可观测性——服务端半边不像浏览器半边那样有热重载，也没有日志
 * 通道能让我从外面看见它到底加载没有。这个文件让我（和以后的维护者）能一眼
 * 确认「插件在这个进程里活着，注册了哪几个工具」。
 * 它纯粹是诊断用途，写失败绝不能影响插件本身。
 */
function beacon(payload) {
  try {
    const dir = path.join(ROOT, 'state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'host.json'), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // 诊断失败就失败，插件的功能不该受它牵连
  }
}

const sideOf = (color) => (color === RED ? '红方' : '黑方');

/** 解析 "列,行" 形式的交叉点。 */
function parsePoint(text) {
  const match = /^\s*(\d)\s*,\s*(\d)\s*$/.exec(String(text));
  if (!match) throw new Error(`交叉点应写成「列,行」，比如 7,7；收到「${text}」`);
  const col = Number(match[1]);
  const row = Number(match[2]);
  if (col > 8 || row > 9) throw new Error(`交叉点越界：列 0-8、行 0-9，收到 ${col},${row}`);
  return { col, row, index: row * 9 + col };
}

export function apply(ctx) {
  /**
   * 棋局按会话分开。
   *
   * 一开始我把它挂在插件实例上，等于整个 DSH 只有一盘棋——换个对话看到的还是
   * 同一盘。但 DSH 的右栏本来就是**每个会话一个**停靠面，面板是会话作用域的，
   * 唤醒也是往某个具体会话里塞消息。所以棋局必须跟着会话走，否则「我在跟谁下」
   * 这件事在界面上就是错的。
   *
   * 没有会话 id 时（比如子代理调的、或直接调工具）落到一个公共兜底盘上。
   */
  const games = new Map();
  const FALLBACK_KEY = 'default';
  const keyOf = (sessionId) => (
    sessionId === undefined || sessionId === null || sessionId === '' ? FALLBACK_KEY : String(sessionId)
  );

  // 落盘：重启 dsh web 不该把正在下的棋弄丢。一个会话一条记录。
  // 状态目录可以用 DSH_XIANGQI_STATE_DIR 改掉（测试用，免得往仓库里写）。
  const stateDir = process.env.DSH_XIANGQI_STATE_DIR || path.join(ROOT, 'state');
  const gamesFile = path.join(stateDir, 'games.json');
  const stored = (() => {
    try { return JSON.parse(readFileSync(gamesFile, 'utf8')) || {}; } catch { return {}; }
  })();
  const persist = () => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(gamesFile, `${JSON.stringify(stored, null, 2)}\n`);
    } catch {
      // 存盘失败不该影响下棋
    }
  };

  const gameFor = (key) => {
    let game = games.get(key);
    if (game) return game;
    if (stored[key]) {
      try { game = deserializeGame(stored[key]); } catch { game = undefined; }
    }
    if (!game) game = newGame('game');
    games.set(key, game);
    return game;
  };
  const saveGame = (key, game) => {
    games.set(key, game);
    stored[key] = serializeGame(game);
    persist();
  };
  /** 工具那边拿会话 id 的路子：exec.agent.session.id。 */
  const keyFromExec = (exec) => {
    const session = exec && exec.agent && exec.agent.session;
    return keyOf(session ? session.id : undefined);
  };

  const register = (definition) => ctx.effect(
    () => ctx.tools.register(definition),
    `dsh-xiangqi: ${definition.name}`,
  );

  /** 把一次失败的调用包成 Connection 认的失败形状，而不是让异常穿出去。 */
  const failure = (error) => ({
    ok: false,
    error: {
      code: 'xiangqi',
      message: error && error.message ? error.message : String(error),
      details: {},
    },
  });

  /**
   * 塞进唤醒提示里的局面。
   *
   * 为什么直接把棋盘写进提示、而不是让模型自己去调 xiangqi_board：
   * 每一步都让它「先看盘再落子」，等于每一步都要一次额外的工具往返加一轮
   * 重新理解局面。一盘棋几十步，那就是几十次白跑。局面是宿主手里现成的，
   * 顺手带上，模型多半就不用再问了。
   *
   * 着法历史只带尾巴几手——它是给模型定位用的，不是给它做长复盘用的。
   */
  function promptContext(game) {
    const lines = [];
    lines.push(`轮到：${sideOf(game.position.turn)}`);
    if (game.mode === 'game') {
      lines.push(`将军：${isInCheck(game.position, game.position.turn) ? '是（必须应将）' : '否'}`);
    }
    lines.push('');
    lines.push(formatBoard(game.position));
    const history = game.history.map((entry, i) => `${i + 1}.${entry.notation}`);
    if (history.length) {
      const tail = history.slice(-6);
      lines.push('');
      lines.push(`着法：${history.length > tail.length ? '… ' : ''}${tail.join(' ')}`);
    }
    return lines.join('\n');
  }

  /**
   * 有些变故不需要会话**行动**，只需要它**知道**——比如人悔棋、人重开一局。
   *
   * 这两种情况用 inject 而不是 followup：inject 把消息排进下一次 pre-step 的
   * 上下文，但不唤醒驱动。会话下次真被叫起来时（人走下一步）就已经知道局面变过，
   * 不会拿着过期认知说话；而当下不必为「哦，知道了」白烧一个完整回合。
   *
   * 区别就是一句话：要它动手的用 followup，只要它知道的用 inject。
   */
  function notifyAgent(sessionId, headline, key) {
    if (!sessionId) return { notified: false, reason: '面板没有带上会话 id' };
    const agents = ctx.get('agents');
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    if (!agent || typeof agent.inject !== 'function') {
      return { notified: false, reason: `没找到会话 ${sessionId}，通知不到` };
    }
    try {
      agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: `${headline}\n\n———— 当前局面 ————\n${promptContext(gameFor(key))}`,
        }],
        source: {
          kind: 'plugin',
          plugin: 'xiangqi',
          form: 'notice',
          summary: headline.slice(0, 60),
        },
      }));
      return { notified: true, reason: '' };
    } catch (error) {
      return { notified: false, reason: `通知失败：${error && error.message ? error.message : error}` };
    }
  }

  /**
   * 人走完一步之后，把会话叫醒。
   *
   * 只有这条路径（面板经 HTTP 落子）会唤醒。会话自己用 xiangqi_move 工具落子时
   * 绝不唤醒——否则它会把自己叫醒，陷入自己跟自己下棋的循环。
   */
  function wakeAgent(sessionId, move, key) {
    if (!sessionId) return { woken: false, reason: '面板没有带上会话 id' };
    const game = gameFor(key);
    const finished = game.result !== null;

    // 终局也必须唤醒。
    //
    // 这里原来写的是「已经终局，不用接招了」，理由是没子可走了、叫醒会话干嘛。
    // 那个判断是错的，而且错得很难看：被将死的是会话，可它不知道，
    // 于是人跑来告诉它「我赢了」，它还将信将疑地让人自己去查。
    // 赢棋的人不该跟一个不承认输的对手掰扯——终局是最该被送达的消息。
    if (!finished && game.position.turn === HUMAN) {
      return { woken: false, reason: '还没轮到会话走' };
    }

    const agents = ctx.get('agents');
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    if (!agent || typeof agent.followup !== 'function') {
      return { woken: false, reason: `没找到会话 ${sessionId}，接不了招` };
    }

    // 提示词是给「一个正在跟人下棋的对手」写的，不是给「一个正在处理工程任务的
    // 助手」写的。不明说的话，模型会按后者的习惯来：反复读盘、长篇分析、把一步
    // 棋当成一次设计评审。一盘棋几十步，那样永远下不完。
    const head = finished
      ? `人在棋盘上走了「${move.notation}」，这盘到此结束：${resultText(game)}。`
      : `人在棋盘上走了「${move.notation}」。现在轮到你走。`;
    const body = finished
      ? '这盘已经结束了，你不用再走子：如实向人确认结果，两三句话复盘即可。'
        + '不要质疑这个结果——终局是规则判出来的，不是人自封的。'
      : '你是坐在对面跟人下棋的对手，不是在处理工程任务：想清楚这一步就落子，别长考、别反复确认。';
    const howto = finished
      ? '想再看一眼最后局面可以用 xiangqi_board，但那不是必须的。'
      : '局面已经给你了，不用再调 xiangqi_board——除非你想知道某枚子具体能走到哪，'
        + '那就把它的交叉点传给 from（形如 "7,7"）。落子用 xiangqi_move。'
        + '落子之后用一两句话说明思路就行，不要写长篇复盘。';

    try {
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `${head}\n\n${body}\n\n${howto}\n\n———— 当前局面 ————\n${promptContext(game)}`,
        }],
        source: {
          kind: 'plugin',
          plugin: 'xiangqi',
          form: 'notice',
          summary: finished
            ? `棋盘：人走了 ${move.notation}，${resultText(game)}`
            : `棋盘：人走了 ${move.notation}`,
        },
      }));
      // 标记：这个会话的**下一次**模型调用走轻档推理，用完即弃。
      // 只压这一步棋，不碰用户选的模型设置，也不影响他同一会话里做别的事。
      pendingLightTurn.add(key);
      return { woken: true, reason: '', finished };
    } catch (error) {
      return { woken: false, reason: `唤醒失败：${error && error.message ? error.message : error}` };
    }
  }
  /**
   * 浏览器半边调的几个接口。它只读局面，以及把人的着法送进来。
   *
   * 每个接口都按 payload.sessionId 找自己那一盘棋——面板是会话作用域的，
   * 所以它每次都会把自己的会话 id 带上。
   *
   * 之所以让浏览器轮询 view 而不是服务端推送：轮询让两边永远收敛——
   * 无论着法是会话用工具走的、还是人在面板上点的，下一次轮询都会对齐。
   * 省掉一整套推送与断线重连的状态机，代价是几百毫秒的延迟。
   */
  const endpoints = {
    view: (payload) => gameView(gameFor(keyOf(payload && payload.sessionId))),
    moves(payload) {
      const game = gameFor(keyOf(payload && payload.sessionId));
      const point = parsePoint(payload && payload.from);
      return {
        from: point.index,
        targets: movesFrom(game, point.index).map((move) => ({ to: move.to, notation: move.notation })),
      };
    },
    move(payload) {
      const request = payload || {};
      const key = keyOf(request.sessionId);
      const game = gameFor(key);
      const played = request.from !== undefined
        ? applyMove(game, request.from, request.to) // 面板上点两下走的是坐标
        : applyNotation(game, request.move);
      saveGame(key, played.game);
      return {
        ...gameView(played.game),
        notation: played.move.notation,
        wake: wakeAgent(request.sessionId, played.move, key),
      };
    },
    undo(payload) {
      const key = keyOf(payload && payload.sessionId);
      const before = gameFor(key);
      const undone = before.history.length ? before.history[before.history.length - 1].notation : '';
      const game = undoRound(before, HUMAN).game;
      saveGame(key, game);
      // 悔棋会推翻会话已有的认知（它以为自己走过的那步还在），必须让它知道；
      // 但此刻轮到人走，不需要它行动，所以用 inject 而不是 followup。
      const note = notifyAgent(
        payload && payload.sessionId,
        `人悔棋了：${undone ? `撤销了「${undone}」，` : ''}现在共 ${game.history.length} 手，轮到${sideOf(game.position.turn)}走。`
          + '你不必回应、也不用走子，知道局面变成这样就行。',
        key,
      );
      return { ...gameView(game), note };
    },
    /** 重开一局：把这个会话的棋局换成全新的标准开局。 */
    reset(payload) {
      const key = keyOf(payload && payload.sessionId);
      const fresh = newGame('game');
      saveGame(key, fresh);
      const note = notifyAgent(
        payload && payload.sessionId,
        '人把棋局重开了：现在是全新的标准开局，之前那盘作废，别再引用它。'
          + '你执黑，等红方先走；不必回应，也不用走子。',
        key,
      );
      return { ...gameView(fresh), reset: true, note };
    },
    hint(payload) {
      const key = keyOf(payload && payload.sessionId);
      const game = setHint(gameFor(key), payload && payload.move !== undefined ? payload.move : null).game;
      saveGame(key, game);
      return gameView(game);
    },
  };

  // 在宿主自己的 web server 上挂一条前缀路由，浏览器半边直接 fetch 它。
  //
  // 为什么不用更"正统"的 ctx.connection.rpc.handle()：它内部是
  //   const owner = this.ctx;  owner.effect(() => owner.webServer.register(route))
  // 而那个 owner 并不是调用方的上下文——我这边实测它永远报
  // 「cannot get property "webServer" without inject」，即使我的 inject 里
  // 已经声明了 webServer。绕不过去，就自己挂。
  //
  // 自己挂的代价是认证要自己做，而这正好有现成的：connection.requestRejection()
  // 会跑 Host/Origin 栅栏 + 浏览器会话认证，和内置 /api 通道用的是同一套。
  //
  // 外面套 try 是因为 apply 里抛错不是「这个插件挂了」，而是**整棵插件树加载失败**、
  // 整个 GUI 起不来。路由挂不上顶多让面板显示「连不上棋局」，绝不该拖垮宿主。
  const ROUTE_PATH = '/xiangqi';
  const MAX_BODY_BYTES = 1 << 20;

  function handleHttp(req, res) {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const endpoint = url.pathname.slice(ROUTE_PATH.length).replace(/^\//, '') || 'view';

    let raw = '';
    let overflowed = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) { overflowed = true; req.destroy(); }
    });
    req.on('end', () => {
      if (overflowed) return;
      let payload = {};
      if (raw.trim()) {
        try { payload = JSON.parse(raw); } catch { payload = {}; }
      }
      const handler = endpoints[endpoint];
      let result;
      if (!handler) result = failure(new Error(`未知的接口：${endpoint}`));
      else {
        try { result = { ok: true, value: handler(payload) }; } catch (error) { result = failure(error); }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    });
  }

  let channelReady = Boolean(ctx.webServer && ctx.webServer.register && ctx.connection && ctx.connection.requestRejection);
  let channelError = '';
  if (channelReady) {
    try {
      ctx.effect(
        () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: handleHttp }),
        'dsh-xiangqi: http route',
      );
    } catch (error) {
      channelReady = false;
      channelError = error && error.message ? error.message : String(error);
    }
  } else {
    channelError = 'webServer 或 connection 不可用';
  }

  // ------------------------------------------------------------ 给这一步棋压推理档位
  //
  // 用户的原话是「慢主要是思考太久了」。光靠提示词劝不住模型，得动真格：
  // 'agent/request' 是个 waterfall，它给出的正是这一次模型调用的冻结配置，
  // 里面就有 reasoningEffort。所以可以在**人走完棋之后那一次调用**上把推理
  // 档位压到最轻，其余时候不动——不碰用户选的模型设置，也不影响同一个会话里
  // 他做别的事。
  //
  // 档位 id 是 provider 自己定义的，写死会报「不支持的档位」，所以现问现取：
  // ctx.llm.resolveModelInfo(provider, model) 会给出这条路由支持的档位清单。
  // 取到就缓存，免得每一步都问一次（那是异步的，会自己增加延迟）。
  const pendingLightTurn = new Set();
  const lightestByRoute = new Map();

  function lightestEffortFor(provider, model, signal) {
    const route = `${provider}/${model}`;
    if (lightestByRoute.has(route)) return Promise.resolve(lightestByRoute.get(route));
    const llm = ctx.get('llm');
    if (!llm || typeof llm.resolveModelInfo !== 'function') return Promise.resolve(null);
    return Promise.resolve()
      .then(() => llm.resolveModelInfo(provider, model, signal))
      .then((info) => {
        const efforts = (info && info.reasoning && info.reasoning.efforts) || [];
        if (!efforts.length) {
          lightestByRoute.set(route, null);
          return null;
        }
        // 清单是 adapter 的展示顺序，未必从轻到重；先按名字挑最轻的，挑不到用第一项。
        const named = efforts.find((e) => /low|min|off|fast|light|quick/i.test(`${e.id} ${e.name}`));
        const picked = (named || efforts[0]).id;
        lightestByRoute.set(route, picked);
        return picked;
      })
      .catch(() => {
        lightestByRoute.set(route, null);
        return null;
      });
  }

  // ctx.on 缺席时功能降级（不压档位），绝不让插件挂不上。
  if (typeof ctx.on === 'function') {
    ctx.on('agent/request', async (payload, next) => {
      const session = payload && payload.agent && payload.agent.session;
      const key = keyOf(session ? session.id : undefined);
      if (!pendingLightTurn.has(key)) return next(); // 绝大多数请求走这条早退
      // 先消费再 await：万一 next() 抛了，不至于留下一个脏标记影响后面的调用。
      pendingLightTurn.delete(key);
      const config = await next();
      try {
        const effort = await lightestEffortFor(config.provider, config.model, payload && payload.signal);
        if (!effort) return config;
        return { ...config, reasoningEffort: effort };
      } catch {
        return config; // 压不了就算了，绝不能把这一次调用弄挂
      }
    });
  }

  // ---------------------------------------------------------------- 读局面
  register(defineTool({
    name: 'xiangqi_board',
    description:
      '读当前这盘中国象棋的局面：棋盘图、轮到谁走、是否被将军、已走过的着法、以及结果。' +
      '想知道某一枚子能走到哪里，把它的交叉点传给 from（形如 "7,7"）。' +
      '轮到自己走棋前先用它看清局面。',
    parameters: {
      from: {
        type: 'string',
        description: '可选。形如 "7,7" 的交叉点（列,行），列 0-8 从左到右，行 0-9 从上到下。给了就列出这枚子的全部合法着法。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', required: true },
          fen: { type: 'string', required: true },
          turn: { type: 'string', required: true, enum: [RED, BLACK] },
          inCheck: { type: 'boolean', required: true },
          resultText: { type: 'string', required: true },
          legal: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute(args, exec) {
      const game = gameFor(keyFromExec(exec));
      let report = gameReport(game);
      if (args.from !== undefined) {
        const point = parsePoint(args.from);
        const options = movesFrom(game, point.index);
        report += options.length
          ? `\n\n(${point.col},${point.row}) 这枚子能走：${options.map((m) => `${m.notation}${m.target}`).join('、')}`
          : `\n\n(${point.col},${point.row}) 这枚子无处可走。`;
      }
      return Promise.resolve({
        report,
        fen: toFen(game.position),
        turn: game.position.turn,
        inCheck: isInCheck(game.position, game.position.turn),
        resultText: resultText(game),
        legal: game.mode === 'game' && !game.result
          ? legalNotations(game.position).map((entry) => entry.notation)
          : [],
      });
    },
  }));

  // ---------------------------------------------------------------- 落子
  register(defineTool({
    name: 'xiangqi_move',
    description:
      '走一步棋。着法用中文记谱（如「炮二平五」）或坐标（如「h7-e7」「7,7-4,7」）都行。' +
      '非法着法不会让工具失败，而是返回 ok:false 并说明这枚子到底能走到哪里，照着改即可。',
    parameters: {
      move: { type: 'string', required: true, description: '要走的着法。中文记谱如「炮二平五」，或坐标如「h7-e7」。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          notation: { type: 'string', required: true },
          report: { type: 'string', required: true },
          turn: { type: 'string', required: true, enum: [RED, BLACK] },
          resultText: { type: 'string', required: true },
        },
      },
      // 返回刻意只有一句话。
      //
      // 原来这里回的是整张棋盘 + 全部着法历史，看着"贴心"，其实是在往对话里
      // 灌垃圾：每一步都塞一份棋盘，历史还随步数增长，而这些都会**永久留在
      // 对话里**被反复重读。实测每步 460~580 字符，一盘棋累积两三千 token 的
      // 冗余。模型刚走完这一步，它不需要再看一遍棋盘。
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? value.report : `这一步走不了：${value.report}`,
      }],
    },
    execute(args, exec) {
      const key = keyFromExec(exec);
      const game = gameFor(key);
      try {
        const played = applyNotation(game, args.move);
        saveGame(key, played.game);
        const next = played.game.position.turn;
        return Promise.resolve({
          ok: true,
          notation: played.move.notation,
          report: played.game.result
            ? `已走：${played.move.notation}。${resultText(played.game)}`
            : `已走：${played.move.notation}。轮到${sideOf(next)}走。`,
          turn: next,
          resultText: resultText(played.game),
        });
      } catch (error) {
        return Promise.resolve({
          ok: false,
          notation: '',
          report: error.message,
          turn: game.position.turn,
          resultText: resultText(game),
        });
      }
    },
  }));

  // ---------------------------------------------------------------- 悔棋
  register(defineTool({
    name: 'xiangqi_undo',
    description: '悔棋，退回到该人走的状态（人一步 + 会话一步算一轮）。轮到会话走时只退人的那一步。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          undone: { type: 'integer', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute(_args, exec) {
      const key = keyFromExec(exec);
      try {
        const reverted = undoRound(gameFor(key), HUMAN);
        saveGame(key, reverted.game);
        return Promise.resolve({
          ok: true,
          undone: reverted.undone,
          report: `已悔 ${reverted.undone} 步，现在轮到${sideOf(reverted.game.position.turn)}走。`,
        });
      } catch (error) {
        return Promise.resolve({ ok: false, undone: 0, report: `悔不了：${error.message}` });
      }
    },
  }));

  // ---------------------------------------------------------------- 支招
  register(defineTool({
    name: 'xiangqi_hint',
    description:
      '给人支一招：把这条建议着法送到棋盘上高亮出来。不传 move 就清除已有的支招。' +
      '支招不改变局面，只是让人看得见。',
    parameters: {
      move: { type: 'string', description: '建议的着法，中文记谱或坐标。留空表示清除支招。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          hint: { type: 'string', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute(args, exec) {
      const key = keyFromExec(exec);
      try {
        const hinted = setHint(gameFor(key), args.move === undefined ? null : args.move);
        saveGame(key, hinted.game);
        return Promise.resolve({
          ok: true,
          hint: hinted.hint ? hinted.hint.notation : '',
          report: hinted.hint ? `已在棋盘上高亮支招：${hinted.hint.notation}` : '已清除支招。',
        });
      } catch (error) {
        return Promise.resolve({ ok: false, hint: '', report: `支不了这一招：${error.message}` });
      }
    },
  }));

  beacon({
    loadedAt: new Date().toISOString(),
    pid: process.pid,
    tools: TOOL_NAMES,
    http: channelReady,
    note: channelReady ? `路由已挂在 ${ROUTE_PATH}` : (channelError || '未挂路由'),
    root: ROOT,
  });
}
