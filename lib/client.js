// 插件的浏览器半边（client）。
//
// 这一版只做一件事：在右侧栏注册一个「象棋」页，把棋盘的画面画出来。
// 它刻意不碰规则——棋局的唯一真相在 host 半边，这里只负责画和点。
//
// 形状照着在跑的随包插件（dsh-client-ui-sidebar-files）抄：
// 用 window.__ModuleLoader__.load 注册，导出 apply 与 inject；
// 每一个注册都包在 ctx.effect 里，这样插件停用/更新时会被自动撤掉。
//
// 右栏的 tab 类型分两阶段注册：先注册「类型」，再用类型的 id 当 key 注册「正文」。

window.__ModuleLoader__.load({
  id: 'dsh-xiangqi',
  factory: (require) => {
    const module = { exports: {} };
    const react = require('react');
    const jsx = require('react/jsx-runtime').jsx;

    const PACKAGE_NAME = 'dsh-xiangqi';
    /** tab 类型的身份，同时也是正文与标题注册时的 key。 */
    const TAB_ID = PACKAGE_NAME;
    const TAB_KIND = 'xiangqi';

    const COLS = 9;
    const ROWS = 10;

    // 棋盘画面先用标准开局占位；真正的局面稍后由 host 半边经 RPC 推过来。
    const PLACEHOLDER_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR';

    const NAMES = {
      red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
      black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
    };

    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

    /** 把 FEN 的棋盘部分拆成 90 格。只认到棋盘，别的字段这里不关心。 */
    function parseBoard(fen) {
      const cells = new Array(COLS * ROWS).fill(null);
      const ranks = String(fen).split(' ')[0].split('/');
      for (let row = 0; row < ROWS; row++) {
        let col = 0;
        for (const ch of ranks[row] || '') {
          if (ch >= '1' && ch <= '9') { col += Number(ch); continue; }
          const upper = ch.toUpperCase();
          if (col < COLS) {
            cells[row * COLS + col] = { color: ch === upper ? 'red' : 'black', type: upper };
          }
          col++;
        }
      }
      return cells;
    }

    function drawPiece(g, cx, cy, cell, piece) {
      const r = cell * 0.435;
      g.save();
      g.beginPath();
      g.arc(cx, cy + r * 0.12, r, 0, Math.PI * 2);
      g.fillStyle = 'rgba(58,34,8,.30)';
      g.fill();

      const body = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.06);
      body.addColorStop(0, '#fffdf6');
      body.addColorStop(0.6, '#f7e9cd');
      body.addColorStop(1, '#dcc094');
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fillStyle = body;
      g.fill();

      const tint = piece.color === 'red' ? '#c0392b' : '#26231f';
      g.strokeStyle = tint;
      g.lineWidth = Math.max(1, r * 0.11);
      g.beginPath();
      g.arc(cx, cy, r * 0.93, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.55;
      g.lineWidth = Math.max(0.7, r * 0.06);
      g.beginPath();
      g.arc(cx, cy, r * 0.76, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;

      g.fillStyle = tint;
      g.font = '700 ' + (r * 1.16) + 'px "KaiTi","STKaiti",serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(NAMES[piece.color][piece.type], cx, cy + r * 0.06);
      g.restore();
    }

    function drawBoard(g, cell, cells) {
      const m = cell * 0.62;
      const width = 8 * cell + m * 2;
      const height = 9 * cell + m * 2;
      const X = (c) => m + c * cell;
      const Y = (r) => m + r * cell;

      const bg = g.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, '#f7e6c8');
      bg.addColorStop(0.5, '#f0d8b2');
      bg.addColorStop(1, '#e3c79b');
      g.fillStyle = bg;
      g.fillRect(0, 0, width, height);

      g.lineCap = 'round';
      g.strokeStyle = '#7b5228';
      const line = (x1, y1, x2, y2) => {
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
      };

      g.lineWidth = Math.max(1.2, cell * 0.036);
      g.strokeRect(X(0), Y(0), 8 * cell, 9 * cell);
      g.lineWidth = Math.max(0.7, cell * 0.019);

      for (let r = 0; r < ROWS; r++) line(X(0), Y(r), X(8), Y(r));
      for (let c = 0; c < COLS; c++) {
        if (c === 0 || c === 8) line(X(c), Y(0), X(c), Y(9));
        else { line(X(c), Y(0), X(c), Y(4)); line(X(c), Y(5), X(c), Y(9)); }
      }
      line(X(3), Y(0), X(5), Y(2)); line(X(5), Y(0), X(3), Y(2));
      line(X(3), Y(7), X(5), Y(9)); line(X(5), Y(7), X(3), Y(9));

      const mark = (cc, rr) => {
        const cx = X(cc);
        const cy = Y(rr);
        const d = cell * 0.085;
        const len = cell * 0.155;
        const sides = [];
        if (cc > 0) sides.push([-1, -1], [-1, 1]);
        if (cc < 8) sides.push([1, -1], [1, 1]);
        g.lineWidth = Math.max(0.7, cell * 0.02);
        for (const [sx, sy] of sides) {
          g.beginPath();
          g.moveTo(cx + sx * d, cy + sy * (d + len));
          g.lineTo(cx + sx * d, cy + sy * d);
          g.lineTo(cx + sx * (d + len), cy + sy * d);
          g.stroke();
        }
      };
      for (const [cc, rr] of [[1, 2], [7, 2], [1, 7], [7, 7],
        [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
        [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]]) mark(cc, rr);

      g.save();
      g.fillStyle = 'rgba(120,80,38,.78)';
      g.font = '600 ' + (cell * 0.6) + 'px "KaiTi","STKaiti",serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('楚  河', X(2), Y(4.5));
      g.fillText('漢  界', X(6), Y(4.5));
      g.restore();

      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const piece = cells[row * COLS + col];
          if (piece) drawPiece(g, X(col), Y(row), cell, piece);
        }
      }
    }

    /** 右栏里那块面板的正文。 */
    function BoardPanel() {
      const hostRef = react.useRef(null);
      const canvasRef = react.useRef(null);

      react.useEffect(() => {
        const host = hostRef.current;
        const canvas = canvasRef.current;
        if (!host || !canvas) return undefined;

        const render = () => {
          const available = Math.max(200, host.clientWidth || 320);
          const cell = Math.max(20, Math.min(Math.floor((available - 8) / 9.24), 44));
          const margin = cell * 0.62;
          const width = Math.round(8 * cell + margin * 2);
          const height = Math.round(9 * cell + margin * 2);
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.round(width * ratio);
          canvas.height = Math.round(height * ratio);
          canvas.style.width = width + 'px';
          canvas.style.height = height + 'px';
          const g = canvas.getContext('2d');
          g.setTransform(ratio, 0, 0, ratio, 0, 0);
          drawBoard(g, cell, parseBoard(PLACEHOLDER_FEN));
        };

        render();
        if (!window.ResizeObserver) return undefined;
        const observer = new ResizeObserver(render);
        observer.observe(host);
        return () => observer.disconnect();
      }, []);

      const panelStyle = {
        height: '100%',
        boxSizing: 'border-box',
        padding: '12px',
        overflow: 'auto',
        fontFamily: 'system-ui, sans-serif',
      };
      const headStyle = {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: '8px',
      };
      const hintStyle = { fontSize: '11px', opacity: 0.55, marginTop: '10px', lineHeight: 1.7 };

      return jsx('div', {
        style: panelStyle,
        children: [
          jsx('div', {
            key: 'head',
            style: headStyle,
            children: [
              jsx('span', { key: 'title', style: { fontWeight: 600, fontSize: '13px' }, children: '中国象棋' }),
              jsx('span', { key: 'note', style: { fontSize: '11px', opacity: 0.5 }, children: '画面通了 · 交互待接' }),
            ],
          }),
          jsx('div', { key: 'host', ref: hostRef, children: jsx('canvas', { ref: canvasRef, style: { display: 'block', borderRadius: '8px' } }) }),
          jsx('div', {
            key: 'hint',
            style: hintStyle,
            children: '这一版只验证装载与渲染：棋盘画出来了，棋子还是标准开局的占位。下一步接工具与双向通讯。',
          }),
        ],
      });
    }

    function apply(ctx) {
      // 第一步：声明 tab 类型。没有运行时钩子，只是一份静态声明。
      ctx.effect(
        () => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => '中国象棋',
          guide: [{ kind: TAB_KIND, title: () => '中国象棋' }],
        }),
        'dsh-xiangqi: tab type',
      );

      // 第二步：用类型的 id 当 key 注册正文。key 必须等于 definition.id。
      ctx.effect(
        () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, BoardPanel)),
        'dsh-xiangqi: tab body',
      );

      // 面板默认是收起的，得主动把它打开，否则用户看不见。
      // 没有活跃会话时这个调用会抛，属于预期情况——吞掉，等用户开了会话再点开。
      ctx.effect(() => {
        try {
          ctx.sidebarRight.openTab(TAB_KIND);
        } catch (error) {
          console.warn('[dsh-xiangqi] 右栏暂时打不开（多半是当前没有活跃会话）：', error && error.message);
        }
      }, 'dsh-xiangqi: open tab');
    }

    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
