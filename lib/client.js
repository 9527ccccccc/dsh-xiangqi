// 插件的浏览器半边（client）：右栏里的那块棋盘。
//
// 它自己不持有任何权威状态——棋局真相全在服务端半边。这里只做三件事：
//   1. 定期向宿主要一份局面视图（轮询，不是推送，见 lib/index.js 里的说明）
//   2. 按视图把棋盘画出来
//   3. 把人点出来的着法送回宿主
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
    /** tab 类型的身份，同时也是正文注册时的 key。 */
    const TAB_ID = PACKAGE_NAME;
    const TAB_KIND = 'xiangqi';
    /** 宿主挂 HTTP 路由的路径前缀。 */
    const CHANNEL = '/xiangqi';
    /** 轮询间隔。够快看不出延迟，又不至于让宿主忙起来。 */
    const POLL_MS = 800;

    const COLS = 9;
    const ROWS = 10;

    const NAMES = {
      red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
      black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
    };

    // 面板是同源页面，直接用 fetch 打宿主的 /xiangqi 路由即可——
    // 浏览器会带上自己的会话 cookie，宿主那边用 connection.requestRejection 验。
    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

    /** 调宿主的一个接口。失败也返回结果对象，不抛。 */
    function callHost(endpoint, payload) {
      return fetch(`${CHANNEL}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }).then((response) => {
        if (!response.ok) {
          return { ok: false, error: { code: `http-${response.status}`, message: `宿主返回 HTTP ${response.status}`, details: {} } };
        }
        return response.json();
      }).catch((error) => ({
        ok: false,
        error: { code: 'network', message: `连不上宿主：${error && error.message ? error.message : error}`, details: {} },
      }));
    }

    /** 把 FEN 的棋盘部分拆成 90 格。 */
    function parseBoard(fen) {
      const cells = new Array(COLS * ROWS).fill(null);
      const ranks = String(fen || '').split(' ')[0].split('/');
      for (let row = 0; row < ROWS; row++) {
        let col = 0;
        for (const ch of ranks[row] || '') {
          if (ch >= '1' && ch <= '9') { col += Number(ch); continue; }
          const upper = ch.toUpperCase();
          if (col < COLS) cells[row * COLS + col] = { color: ch === upper ? 'red' : 'black', type: upper };
          col++;
        }
      }
      return cells;
    }

    const colOf = (index) => index % COLS;
    const rowOf = (index) => Math.floor(index / COLS);

    // ------------------------------------------------------------ 绘制

    function drawBase(g, cell) {
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

    /** 一步棋的落点圈：垫在棋子下面，所以先画。 */
    function drawTrail(g, cell, indices) {
      const m = cell * 0.62;
      g.save();
      g.strokeStyle = 'rgba(201,162,39,.95)';
      g.lineWidth = Math.max(1.5, cell * 0.045);
      for (const index of indices) {
        if (index === null || index === undefined) continue;
        g.beginPath();
        g.arc(m + colOf(index) * cell, m + rowOf(index) * cell, cell * 0.46, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    }

    /** 支招：从起点到落点画一支箭头。 */
    function drawArrow(g, cell, from, to) {
      const m = cell * 0.62;
      const x1 = m + colOf(from) * cell;
      const y1 = m + rowOf(from) * cell;
      const x2 = m + colOf(to) * cell;
      const y2 = m + rowOf(to) * cell;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = cell * 0.3;
      const tipX = x2 - Math.cos(angle) * cell * 0.34;
      const tipY = y2 - Math.sin(angle) * cell * 0.34;

      g.save();
      g.strokeStyle = 'rgba(46,125,50,.95)';
      g.fillStyle = 'rgba(46,125,50,.95)';
      g.lineWidth = Math.max(2, cell * 0.075);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x1 + Math.cos(angle) * cell * 0.3, y1 + Math.sin(angle) * cell * 0.3);
      g.lineTo(tipX, tipY);
      g.stroke();
      g.beginPath();
      g.moveTo(tipX + Math.cos(angle) * head, tipY + Math.sin(angle) * head);
      g.lineTo(tipX + Math.cos(angle + 2.5) * head, tipY + Math.sin(angle + 2.5) * head);
      g.lineTo(tipX + Math.cos(angle - 2.5) * head, tipY + Math.sin(angle - 2.5) * head);
      g.closePath();
      g.fill();
      g.restore();
    }

    /** 选中的子与它全部的落点。 */
    function drawSelection(g, cell, from, targets) {
      const m = cell * 0.62;
      const cx = m + colOf(from) * cell;
      const cy = m + rowOf(from) * cell;
      g.save();
      g.strokeStyle = 'rgba(33,110,180,.95)';
      g.lineWidth = Math.max(2, cell * 0.06);
      g.beginPath();
      g.arc(cx, cy, cell * 0.46, 0, Math.PI * 2);
      g.stroke();

      for (const to of targets) {
        const tx = m + colOf(to) * cell;
        const ty = m + rowOf(to) * cell;
        g.beginPath();
        g.arc(tx, ty, cell * 0.14, 0, Math.PI * 2);
        g.fillStyle = 'rgba(33,110,180,.55)';
        g.fill();
      }
      g.restore();
    }

    /**
     * 一帧的完整构图：底、走过的落点、棋子、选中与落点、支招箭头。
     * 提成纯函数是为了能被单测直接驱动——不必为了验证绘制去跑一个迷你 React。
     */
    function drawScene(g, cell, fen, view, selection) {
      const m = cell * 0.62;
      const cells = parseBoard(fen);
      drawBase(g, cell);
      if (view && view.lastMove) drawTrail(g, cell, [view.lastMove.from, view.lastMove.to]);
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const piece = cells[row * COLS + col];
          if (piece) drawPiece(g, m + col * cell, m + row * cell, cell, piece);
        }
      }
      if (selection) drawSelection(g, cell, selection.from, selection.targets);
      if (view && view.hint) drawArrow(g, cell, view.hint.from, view.hint.to);
    }

    // ------------------------------------------------------------ 面板

    /**
     * 造一块面板组件。
     *
     * 之所以是工厂而不是直接写组件：组件要用 ctx 去调宿主，而 ctx 只在 apply 的
     * 作用域里存在。让工厂把它闭进来，比把 ctx 挂到模块级变量上干净——
     * 后者在插件被停用再启用时会指向过期的上下文。
     */
    function makeBoardPanel(ctx) {
      return function BoardPanel(props) {
      /** 面板是会话作用域的，槽位会把会话 id 注进来——唤醒靠它。 */
      const sessionId = props && props.sessionId;
      const wrapRef = react.useRef(null);
      const canvasRef = react.useRef(null);
      const layoutRef = react.useRef({ cell: 40, margin: 25, width: 0, height: 0 });
      const [view, setView] = react.useState(null);
      const [selection, setSelection] = react.useState(null);
      const [notice, setNotice] = react.useState('');
      const [offline, setOffline] = react.useState(false);

      // 每次调用都带上本会话的 id：棋局按会话分开，不带就会落到公共兜底盘上，
      // 于是换个对话看到的还是同一盘棋。
      const call = (endpoint, payload) => callHost(endpoint, { ...(payload || {}), sessionId });

      // 轮询局面。宿主是唯一真相，所以无论着法来自会话还是来自这块面板，
      // 下一次轮询都会把两边对齐。
      react.useEffect(() => {
        let alive = true;
        const tick = () => {
          call('view')
            .then((result) => {
              if (!alive) return;
              if (result.ok) {
                setView(result.value);
                setOffline(false);
              } else {
                setOffline(true);
              }
            })
            .catch(() => { if (alive) setOffline(true); });
        };
        tick();
        const handle = setInterval(tick, POLL_MS);
        return () => { alive = false; clearInterval(handle); };
      }, []);

      // 重绘：视图或选中状态一变就重画，容器尺寸变了也重画。
      react.useEffect(() => {
        const wrap = wrapRef.current;
        const canvas = canvasRef.current;
        if (!wrap || !canvas) return undefined;

        const draw = () => {
          const available = Math.max(200, wrap.clientWidth || 320);
          const cell = Math.max(20, Math.min(Math.floor((available - 10) / 9.24), 44));
          const margin = cell * 0.62;
          const width = Math.round(8 * cell + margin * 2);
          const height = Math.round(9 * cell + margin * 2);
          const ratio = window.devicePixelRatio || 1;

          canvas.width = Math.round(width * ratio);
          canvas.height = Math.round(height * ratio);
          canvas.style.width = width + 'px';
          canvas.style.height = height + 'px';
          layoutRef.current = { cell, margin, width, height };

          const g = canvas.getContext('2d');
          g.setTransform(ratio, 0, 0, ratio, 0, 0);
          g.clearRect(0, 0, width, height);
          drawScene(g, cell, view ? view.fen : '', view, selection);
        };

        draw();
        if (!window.ResizeObserver) return undefined;
        const observer = new ResizeObserver(draw);
        observer.observe(wrap);
        return () => observer.disconnect();
      }, [view, selection]);

      /** 屏幕坐标 → 最近的交叉点；离得太远或出了棋盘就返回 null。 */
      const locate = (event) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const { cell, margin, width } = layoutRef.current;
        if (!rect.width || !width) return null;
        const scale = width / rect.width;
        const x = (event.clientX - rect.left) * scale;
        const y = (event.clientY - rect.top) * scale;
        const col = Math.round((x - margin) / cell);
        const row = Math.round((y - margin) / cell);
        if (col < 0 || col > 8 || row < 0 || row > 9) return null;
        if (Math.hypot(x - (margin + col * cell), y - (margin + row * cell)) > cell * 0.8) return null;
        return row * COLS + col;
      };

      const onClick = (event) => {
        if (!view || selection === null && false) return;
        const index = locate(event);
        if (index === null || index === undefined) return;
        setNotice('');

        // 已经选中了一枚子，点的又是它的落点 → 走
        if (selection && selection.targets.includes(index)) {
          call('move', { from: selection.from, to: index, sessionId }).then((result) => {
            if (!result.ok) {
              setNotice(result.error.message);
              return;
            }
            setSelection(null);
            setView(result.value);
            const wake = result.value.wake;
            if (wake && wake.woken) setNotice('已通知会话接招');
            else if (wake && wake.reason) setNotice(`这一步走好了，但没能叫醒会话：${wake.reason}`);
          }).catch(() => setNotice('这一步没能送到宿主'));
          return;
        }

        // 否则：点自己这边的子就选中它，点别处就取消
        const cells = parseBoard(view.fen);
        const piece = cells[index];
        const mine = view.mode === 'setup' || (piece && piece.color === view.turn);
        if (!piece || !mine) {
          setSelection(null);
          return;
        }
        call('moves', { from: `${colOf(index)},${rowOf(index)}` }).then((result) => {
          if (!result.ok) { setNotice(result.error.message); return; }
          if (!result.value.targets.length) { setNotice('这枚子无处可走'); return; }
          setSelection({ from: index, targets: result.value.targets.map((t) => t.to) });
        }).catch(() => setNotice('拿不到这枚子的走法'));
      };

      /** 把宿主回执里的通知结果翻成一句人话。 */
      const noteText = (note, okText) => {
        if (!note) return okText;
        return note.notified ? `${okText}，会话已知晓` : `${okText}。但没能通知会话：${note.reason || '原因不明'}`;
      };

      const undo = () => {
        setSelection(null);
        setNotice('');
        call('undo').then((result) => {
          if (!result.ok) { setNotice(result.error.message); return; }
          setView(result.value);
          setNotice(noteText(result.value.note, '已悔棋'));
        }).catch(() => setNotice('悔棋没能送到宿主'));
      };

      // 重开一局会把这盘棋丢掉，所以要点两下：第一下只是把意图摆出来。
      const [resetArmed, setResetArmed] = react.useState(false);
      const reset = () => {
        if (!resetArmed) {
          setResetArmed(true);
          setNotice('再点一次「确认重开」就开新的一局——现在这盘会没掉。');
          return;
        }
        setResetArmed(false);
        setSelection(null);
        setNotice('');
        call('reset').then((result) => {
          if (!result.ok) { setNotice(result.error.message); return; }
          setView(result.value);
          setNotice(noteText(result.value.note, '已重开一局，你执红先行'));
        }).catch(() => setNotice('重开没能送到宿主'));
      };

      const sideText = view ? (view.turn === 'red' ? '红方' : '黑方') : '';
      const statusText = !view
        ? '正在连接棋局…'
        : offline
          ? '连不上棋局（宿主那半边没在跑？）'
          : view.resultText
            ? view.resultText
            : `${sideText}走${view.inCheck ? ' · 被将军' : ''}`;

      const panelStyle = {
        height: '100%',
        boxSizing: 'border-box',
        padding: '10px 12px 14px',
        overflow: 'auto',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
      };
      const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' };
      const buttonStyle = {
        border: '1px solid rgba(127,127,127,.35)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        padding: '3px 9px',
        fontSize: '11px',
        cursor: 'pointer',
      };
      const dimStyle = { opacity: 0.6, fontSize: '11px', lineHeight: 1.7 };

      return jsx('div', {
        style: panelStyle,
        children: [
          jsx('div', {
            key: 'head',
            style: rowStyle,
            children: [
              jsx('span', { key: 'status', style: { fontWeight: 600 }, children: statusText }),
              jsx('span', {
                key: 'actions',
                style: { display: 'flex', gap: '6px', flex: 'none' },
                children: [
                  jsx('button', { key: 'undo', style: buttonStyle, onClick: undo, children: '悔棋' }),
                  jsx('button', {
                    key: 'reset',
                    style: resetArmed
                      ? { ...buttonStyle, borderColor: '#c0392b', color: '#c0392b' }
                      : buttonStyle,
                    onClick: reset,
                    title: '开新的一局',
                    children: resetArmed ? '确认重开' : '重开',
                  }),
                ],
              }),
            ],
          }),
          jsx('div', {
            key: 'board',
            ref: wrapRef,
            style: { margin: '8px 0' },
            children: jsx('canvas', {
              ref: canvasRef,
              onClick,
              style: { display: 'block', borderRadius: '8px', cursor: 'pointer', maxWidth: '100%' },
            }),
          }),
          notice ? jsx('div', { key: 'notice', style: { color: '#c0392b', marginBottom: '6px' }, children: notice }) : null,
          jsx('div', {
            key: 'hint',
            style: dimStyle,
            children: view && view.hint ? `支招：${view.hint.notation}` : '点自己的子，再点落点。',
          }),
          jsx('div', {
            key: 'history',
            style: { ...dimStyle, marginTop: '6px', maxHeight: '90px', overflow: 'auto' },
            children: view && view.history.length
              ? view.history.map((notation, i) => `${i + 1}.${notation}`).join('  ')
              : '还没有走过棋。',
          }),
        ],
      });
      };
    }

    function apply(ctx) {
      // 第一步：声明 tab 类型。
      ctx.effect(
        () => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => '中国象棋',
          guide: [{ kind: TAB_KIND, title: () => '中国象棋' }],
        }),
        'dsh-xiangqi: tab type',
      );

      // 第二步：用类型的 id 当 key 注册正文。
      // inject 把会话 id 注进来——人落子之后要靠它把会话叫醒。
      ctx.effect(
        () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          inject: (sessionId) => ({ sessionId }),
        }, makeBoardPanel(ctx))),
        'dsh-xiangqi: tab body',
      );

      // 面板默认收起，主动打开；没有活跃会话时会抛，属于预期情况。
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
    // 测试接缝：DSH 的模块加载器只认 apply / inject，多带一个字段不影响它。
    // 有了它，绘制与解析这些纯逻辑就能被单测直接驱动，不必跑迷你 React。
    module.exports.__test__ = { parseBoard, drawScene, colOf, rowOf, TAB_ID, TAB_KIND, CHANNEL, POLL_MS };
    return module.exports;
  },
});
