/**
 * Gemini Knowledge Graph — Force-Directed Graph (Canvas, zero dependencies)
 *
 * 重构版：每个节点 = 一轮对话，标签 = 用户提问
 * 边 = 对话内容关联度（TF-IDF 余弦相似度）
 * 点击节点 → 定位 Gemini 页面对应位置
 */
'use strict';

/* ══════════════════════════════════════
   Color palette
   ══════════════════════════════════════ */
const COLORS = {
  node:       '#3b82f6',
  nodeHover:  '#2563eb',
  latest:     { fill: '#f59e0b', glow: '#f59e0b30', ring: '#f59e0b' },
  selected:   '#1e293b',
  linkWeak:   '#cbd5e1',
  linkMed:    '#94a3b8',
  linkStrong: '#3b82f6',
  linkAdj:    '#94a3b8',
  text:       '#1e293b',
  textDim:    '#64748b',
  turnBadge:  '#ffffff',
  turnText:   '#64748b',
};

/* ══════════════════════════════════════
   Utility: 渐变色插值
   ══════════════════════════════════════ */
function lerpColor(w) {
  // w: 0~1 → 浅色主题：从浅灰蓝到鲜明蓝色
  const r = Math.round(148 - w * 89);   // 148→59  (#94→#3b)
  const g = Math.round(163 - w * 33);   // 163→130 (#a3→#82)
  const b = Math.round(184 + w * 62);   // 184→246 (#b8→#f6)
  return `rgb(${r},${g},${b})`;
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const s = String(text || '').trim();
  if (!s) return [];

  const lines = [];
  let line = '';

  const pushLine = (l) => {
    if (l) lines.push(l);
  };

  const tokens = s.includes(' ') ? s.split(/(\s+)/) : [...s];

  for (const tok of tokens) {
    const candidate = line ? (line + tok) : tok;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) {
      pushLine(line.trimEnd());
      line = tok.trimStart();
    } else {
      let cut = tok.length;
      while (cut > 1 && ctx.measureText(tok.slice(0, cut) + '…').width > maxWidth) cut--;
      pushLine(tok.slice(0, cut) + '…');
      line = '';
    }

    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && line) pushLine(line.trim());

  if (lines.length > maxLines) lines.length = maxLines;
  if (lines.length === maxLines) {
    const joined = lines.join(' ');
    if (joined.length < s.length) {
      let last = lines[lines.length - 1];
      if (!last.endsWith('…')) {
        while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
        lines[lines.length - 1] = last + '…';
      }
    }
  }

  return lines;
}

/* ══════════════════════════════════════
   ForceGraph
   ══════════════════════════════════════ */
class ForceGraph {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx    = canvasEl.getContext('2d');
    this.dpr    = window.devicePixelRatio || 1;

    this.nodes   = [];
    this.links   = [];
    this.nodeMap = new Map();

    // Simulation params
    this.alpha        = 1;
    this.alphaMin     = 0.004;
    this.alphaDecay   = 0.015;
    this.velocityDecay = 0.5;

    // View transform
    this.tx = 0; this.ty = 0; this.scale = 1;

    // Interaction
    this.hovered  = null;
    this.selected = null;
    this.dragging = null;
    this.dragMoved = false;
    this.isPanning = false;
    this.panStart  = null;

    this._tick = 0;
    this.onSelect   = null;   // callback(node|null)
    this.onNavigate = null;   // callback(turnIndex)

    this.resize();
    this._bindEvents();
    this._loop();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.W = rect.width;
    this.H = rect.height;
    this.canvas.width  = this.W * this.dpr;
    this.canvas.height = this.H * this.dpr;
    this.canvas.style.width  = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /* ═══════════════ Data ═══════════════ */
  setData(graphData) {
    if (!graphData || !graphData.nodes.length) {
      this.nodes = []; this.links = []; this.nodeMap.clear();
      return;
    }

    const oldPos = new Map();
    this.nodes.forEach(n => oldPos.set(n.id, { x: n.x, y: n.y }));

    this.nodeMap.clear();
    const N = graphData.nodes.length;
    const baseW = Number.isFinite(this.W) && this.W > 0 ? this.W : 360;
    const baseH = Number.isFinite(this.H) && this.H > 0 ? this.H : 520;

    this.nodes = graphData.nodes.map((n, i) => {
      const old = oldPos.get(n.id);
      // 圆环初始布局，按对话顺序排列
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      const spread = Math.max(140, Math.min(baseW, baseH) * 0.35);
      const r = Math.max(16, Math.min(28, 14 + (n.wordCount || 100) / 200));
      const hasOld = old && Number.isFinite(old.x) && Number.isFinite(old.y);
      const jitter = 10;

      const node = {
        ...n,
        x:  hasOld ? old.x : (Math.cos(angle) * spread + (Math.random() - 0.5) * jitter),
        y:  hasOld ? old.y : (Math.sin(angle) * spread + (Math.random() - 0.5) * jitter),
        vx: 0, vy: 0,
        r,
      };
      this.nodeMap.set(n.id, node);
      return node;
    });

    this.links = graphData.links.map(l => ({
      ...l,
      sourceNode: this.nodeMap.get(l.source),
      targetNode: this.nodeMap.get(l.target),
    })).filter(l => l.sourceNode && l.targetNode);

    this.alpha = 0.85;
  }

  /* ═══════════════ Simulation ═══════════════ */
  _simulate() {
    if (this.alpha < this.alphaMin) return;

    const nodes = this.nodes;
    const links = this.links;
    const N = nodes.length;

    // 1. Repulsion
    const repStr = 1200;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let d2 = dx * dx + dy * dy;
        if (!Number.isFinite(d2)) {
          dx = (Math.random() - 0.5) * 0.01;
          dy = (Math.random() - 0.5) * 0.01;
          d2 = dx * dx + dy * dy;
        }
        if (d2 < 1e-6) {
          dx = (Math.random() - 0.5) * 0.01;
          dy = (Math.random() - 0.5) * 0.01;
          d2 = dx * dx + dy * dy;
        }
        if (d2 < 1) d2 = 1;
        const f = repStr * this.alpha / d2;
        nodes[i].vx -= dx * f;
        nodes[i].vy -= dy * f;
        nodes[j].vx += dx * f;
        nodes[j].vy += dy * f;
      }
    }

    const pad = 10;
    const labelExtra = 18;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (!Number.isFinite(d)) continue;
        const minD = (nodes[i].r + labelExtra) + (nodes[j].r + labelExtra) + pad;
        if (d < 1e-6) {
          dx = (Math.random() - 0.5) * 0.5;
          dy = (Math.random() - 0.5) * 0.5;
          d = Math.sqrt(dx * dx + dy * dy) || 1;
        }
        if (d < minD) {
          const push = ((minD - d) / d) * 0.5 * this.alpha;
          const px = dx * push;
          const py = dy * push;
          nodes[i].vx -= px; nodes[i].vy -= py;
          nodes[j].vx += px; nodes[j].vy += py;
        }
      }
    }

    // 2. Attraction — 弹簧长度与相似度成反比（越相似越近）
    for (const l of links) {
      const s = l.sourceNode, t = l.targetNode;
      let dx = t.x - s.x, dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const targetLen = l.isAdjacent ? 120 : (200 - l.weight * 150);  // 高相似度 → 短弹簧
      const str = l.isAdjacent ? 0.08 : (0.03 + l.weight * 0.05);
      const f = (d - targetLen) * str * this.alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      s.vx += fx; s.vy += fy;
      t.vx -= fx; t.vy -= fy;
    }

    // 3. Center gravity
    for (const n of nodes) {
      n.vx += -n.x * 0.015 * this.alpha;
      n.vy += -n.y * 0.015 * this.alpha;
    }

    // 4. Integrate
    for (const n of nodes) {
      if (n === this.dragging) continue;
      n.vx *= this.velocityDecay;
      n.vy *= this.velocityDecay;
      n.x += n.vx;
      n.y += n.vy;
    }

    this.alpha *= (1 - this.alphaDecay);
  }

  /* ═══════════════ Render ═══════════════ */
  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.save();
    ctx.translate(this.W / 2 + this.tx, this.H / 2 + this.ty);
    ctx.scale(this.scale, this.scale);

    const pulse = 0.5 + 0.5 * Math.sin(this._tick * 0.04);

    // ── Links ──
    for (const l of this.links) {
      const s = l.sourceNode, t = l.targetNode;
      const isHL = this.selected && (s.id === this.selected.id || t.id === this.selected.id);
      const w = l.weight;

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);

      if (isHL) {
        ctx.strokeStyle = lerpColor(Math.min(w * 2, 1));
        ctx.lineWidth = 1.5 + w * 3;
        ctx.globalAlpha = 0.9;
      } else {
        ctx.strokeStyle = l.isAdjacent ? COLORS.linkAdj : lerpColor(w);
        ctx.lineWidth = l.isAdjacent ? 1 : (0.8 + w * 3);
        ctx.globalAlpha = l.isAdjacent ? 0.5 : (0.4 + w * 0.5);
      }
      if (l.isAdjacent && !isHL) ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    // ── Nodes ──
    for (const n of this.nodes) {
      const isHov = this.hovered === n;
      const isSel = this.selected === n;

      // Latest glow
      if (n.isLatest) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 6 + pulse * 4, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.latest.glow;
        ctx.fill();
      }

      // Selection ring
      if (isSel) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.selected;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Main circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.isLatest ? COLORS.latest.fill : (isHov ? COLORS.nodeHover : COLORS.node);
      ctx.fill();

      if (n.isLatest) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 1, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.latest.ring;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Turn number badge inside circle
      ctx.font = `700 ${Math.max(9, n.r * 0.65)}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${n.turnIndex + 1}`, n.x, n.y);

      // Label below: user question preview
      const fontSize = 11;
      const lineGap = 3;
      ctx.font = `500 ${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.fillStyle = n.isLatest || isSel || isHov ? COLORS.text : COLORS.textDim;

      const maxLabelWidth = 160;
      const lines = wrapText(ctx, n.label, maxLabelWidth, 2);
      const baseY = n.y + n.r + fontSize + 4;
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], n.x, baseY + li * (fontSize + lineGap));
      }
    }

    ctx.restore();
    this._tick++;
  }

  _loop() {
    this._simulate();
    this._render();
    requestAnimationFrame(() => this._loop());
  }

  /* ═══════════════ Interaction ═══════════════ */
  _screenToWorld(sx, sy) {
    return {
      x: (sx - this.W / 2 - this.tx) / this.scale,
      y: (sy - this.H / 2 - this.ty) / this.scale,
    };
  }

  _hitTest(wx, wy) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = n.x - wx, dy = n.y - wy;
      if (dx * dx + dy * dy <= (n.r + 5) ** 2) return n;
    }
    return null;
  }

  _bindEvents() {
    const c = this.canvas;
    new ResizeObserver(() => this.resize()).observe(c.parentElement);

    // Zoom
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.scale = Math.max(0.15, Math.min(1, this.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
    }, { passive: false });

    // Pointer down
    c.addEventListener('pointerdown', e => {
      const rect = c.getBoundingClientRect();
      const { x, y } = this._screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const hit = this._hitTest(x, y);

      this.dragMoved = false;
      if (hit) {
        this.dragging = hit;
        this.alpha = Math.max(this.alpha, 0.3);
      } else {
        this.isPanning = true;
        this.panStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      }
      c.setPointerCapture(e.pointerId);
    });

    // Pointer move
    c.addEventListener('pointermove', e => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

      if (this.dragging) {
        const { x, y } = this._screenToWorld(sx, sy);
        this.dragging.x = x; this.dragging.y = y;
        this.dragging.vx = 0; this.dragging.vy = 0;
        this.alpha = Math.max(this.alpha, 0.15);
        this.dragMoved = true;
      } else if (this.isPanning && this.panStart) {
        this.tx = this.panStart.tx + (e.clientX - this.panStart.x);
        this.ty = this.panStart.ty + (e.clientY - this.panStart.y);
      } else {
        const { x, y } = this._screenToWorld(sx, sy);
        this.hovered = this._hitTest(x, y);
        c.style.cursor = this.hovered ? 'pointer' : 'grab';
      }
    });

    // Pointer up
    c.addEventListener('pointerup', () => {
      this.dragging = null;
      this.isPanning = false;
      this.panStart = null;
    });

    // Click → select + navigate
    c.addEventListener('click', e => {
      const rect = c.getBoundingClientRect();
      const { x, y } = this._screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const hit = this._hitTest(x, y);

      if (hit && !this.dragMoved) {
        this.selected = hit;
        if (this.onSelect) this.onSelect(hit);
        // 触发导航：定位到 Gemini 对话
        if (this.onNavigate) this.onNavigate(hit.turnIndex);
      } else if (!hit) {
        this.selected = null;
        if (this.onSelect) this.onSelect(null);
      }
    });

    // Double click → focus node
    c.addEventListener('dblclick', e => {
      const rect = c.getBoundingClientRect();
      const { x, y } = this._screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const hit = this._hitTest(x, y);
      if (hit) this.focusNodes(new Set([hit.id]));
    });
  }

  /* ═══════════════ Public ═══════════════ */

  focusNodes(ids) {
    const targets = this.nodes.filter(n => ids.has(n.id));
    if (!targets.length) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of targets) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY, 100);
    const ts = Math.max(0.4, Math.min(1, Math.min(this.W, this.H) / (span + 200)));

    const s0 = { tx: this.tx, ty: this.ty, s: this.scale };
    const s1 = { tx: -cx * ts, ty: -cy * ts, s: ts };
    const dur = 500, t0 = performance.now();

    const anim = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = t < 0.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2;
      this.tx = s0.tx + (s1.tx - s0.tx) * e;
      this.ty = s0.ty + (s1.ty - s0.ty) * e;
      this.scale = s0.s + (s1.s - s0.s) * e;
      if (t < 1) requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
  }

  focusLatest() {
    const latest = this.nodes.filter(n => n.isLatest);
    if (latest.length) this.focusNodes(new Set(latest.map(n => n.id)));
  }

  resetView() {
    this.focusNodes(new Set(this.nodes.map(n => n.id)));
  }

  getConnected(nodeId) {
    return this.links
      .filter(l => l.source === nodeId || l.target === nodeId)
      .map(l => ({
        node: this.nodeMap.get(l.source === nodeId ? l.target : l.source),
        weight: l.weight,
      }))
      .filter(c => c.node)
      .sort((a, b) => b.weight - a.weight);
  }
}

/* ══════════════════════════════════════
   Side Panel Controller
   ══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const canvas      = document.getElementById('graph-canvas');
  const emptyEl     = document.getElementById('empty-state');
  const statsEl     = document.getElementById('stats');
  const drawerEl    = document.getElementById('detail-drawer');
  const drawerTitle = document.getElementById('drawer-title');
  const drawerBody  = document.getElementById('drawer-body');

  const graph = new ForceGraph(canvas);
  let currentData = null;

  /* ── Navigate to Gemini turn ── */
  function navigateToTurn(turnIndex) {
    // 判断是否在扩展环境中
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_TURN', turnIndex });
    }
  }

  graph.onNavigate = navigateToTurn;

  /* ── Update graph ── */
  function updateGraph(data) {
    if (!data || !data.nodes.length) {
      emptyEl.classList.remove('hidden');
      statsEl.textContent = '等待提取对话...';
      return;
    }
    emptyEl.classList.add('hidden');
    currentData = data;
    graph.setData(data);

    const platform = data.platform === 'qianwen' ? '千问' : (data.platform === 'gemini' ? 'Gemini' : '对话');
    statsEl.textContent = `${platform} · ${data.totalTurns} 轮对话 · ${data.links.length} 条关联`;
    setTimeout(() => graph.focusLatest(), 600);
  }

  /* ── Detail drawer ── */
  graph.onSelect = (node) => {
    if (!node) { drawerEl.classList.remove('open'); return; }

    drawerTitle.textContent = `Turn ${node.turnIndex + 1}`;

    const connected = graph.getConnected(node.id);
    const connHTML = connected.slice(0, 8).map(c => {
      const pct = Math.round(c.weight * 100);
      return `<span class="tag tag-connected" data-id="${c.node.id}" data-turn="${c.node.turnIndex}">
        Turn ${c.node.turnIndex + 1} <small style="opacity:.6">${pct}%</small>
      </span>`;
    }).join('');

    const kwHTML = (node.keywords || []).map(k => `<span class="tag">${k}</span>`).join('');

    drawerBody.innerHTML = `
      <div class="drawer-section">
        <div class="drawer-label">用户提问</div>
        <div class="drawer-text">${escHtml(node.fullUser || node.label)}</div>
      </div>
      ${node.fullModel ? `<div class="drawer-section">
        <div class="drawer-label">模型回复摘要</div>
        <div class="drawer-text">${escHtml(node.fullModel)}</div>
      </div>` : ''}
      ${kwHTML ? `<div class="drawer-section">
        <div class="drawer-label">关键词</div>
        <div class="drawer-tags">${kwHTML}</div>
      </div>` : ''}
      ${connHTML ? `<div class="drawer-section">
        <div class="drawer-label">关联对话 (按相似度排序)</div>
        <div class="drawer-tags">${connHTML}</div>
      </div>` : ''}
      <div class="drawer-section" style="margin-top:8px">
        <button class="nav-btn" id="btn-nav-turn">定位到原文 ↗</button>
      </div>
    `;

    drawerEl.classList.add('open');

    // 定位按钮
    document.getElementById('btn-nav-turn')?.addEventListener('click', () => {
      navigateToTurn(node.turnIndex);
    });

    // 关联节点可点击
    drawerBody.querySelectorAll('.tag-connected').forEach(el => {
      el.addEventListener('click', () => {
        const n = graph.nodeMap.get(el.dataset.id);
        if (n) {
          graph.selected = n;
          graph.focusNodes(new Set([n.id]));
          graph.onSelect(n);
          navigateToTurn(n.turnIndex);
        }
      });
    });
  };

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* ── Buttons ── */
  document.getElementById('btn-refresh').addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'REQUEST_EXTRACT' });
    }
  });
  document.getElementById('btn-center').addEventListener('click', () => graph.resetView());
  document.getElementById('btn-latest').addEventListener('click', () => graph.focusLatest());
  document.getElementById('btn-close-drawer').addEventListener('click', () => {
    drawerEl.classList.remove('open');
    graph.selected = null;
  });

  /* ── Chrome message listeners ── */
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'GRAPH_UPDATE') updateGraph(msg.data);
    });
    chrome.runtime.sendMessage({ type: 'GET_GRAPH_DATA' }, resp => {
      if (resp?.data) updateGraph(resp.data);
    });
    setTimeout(() => chrome.runtime.sendMessage({ type: 'REQUEST_EXTRACT' }), 500);
  }
});
