/**
 * Gemini Knowledge Graph — Force-Directed Graph (Canvas, zero dependencies)
 *
 * 力导向图可视化引擎，纯 Canvas 渲染，不依赖 D3。
 * 支持：缩放 / 平移 / 拖拽 / 点击选中 / 最新对话高亮 / 自动聚焦
 */
'use strict';

/* ══════════════════════════════════════
   Color palette
   ══════════════════════════════════════ */
const COLORS = {
  concept:   { fill: '#3b82f6', glow: '#3b82f680' },
  entity:    { fill: '#10b981', glow: '#10b98180' },
  technical: { fill: '#a78bfa', glow: '#a78bfa80' },
  latest:    { ring: '#f59e0b', glow: '#f59e0b60' },
  link:      '#334155',
  linkLatest:'#f59e0b50',
  text:      '#e2e8f0',
  textDim:   '#94a3b8',
  bg:        '#0f1117',
  selected:  '#ffffff',
};

/* ══════════════════════════════════════
   Force Simulation
   ══════════════════════════════════════ */
class ForceGraph {
  constructor(canvasEl) {
    this.canvas  = canvasEl;
    this.ctx     = canvasEl.getContext('2d');
    this.dpr     = window.devicePixelRatio || 1;

    // Data
    this.nodes   = [];
    this.links   = [];
    this.nodeMap  = new Map();

    // Simulation
    this.alpha      = 1;
    this.alphaMin   = 0.005;
    this.alphaDecay = 0.018;
    this.velocityDecay = 0.55;

    // View transform
    this.tx = 0; this.ty = 0; this.scale = 1;

    // Interaction state
    this.pointer     = { x: 0, y: 0 };
    this.hovered     = null;
    this.selected    = null;
    this.dragging    = null;
    this.isPanning   = false;
    this.panStart    = null;

    this._raf = null;
    this._tick = 0;

    this.resize();
    this._bindEvents();
    this._loop();
  }

  /* ── Canvas sizing ── */
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

  /* ══════════════════════════════════
     Data ingestion
     ══════════════════════════════════ */
  setData(graphData) {
    if (!graphData || !graphData.nodes.length) {
      this.nodes = [];
      this.links = [];
      this.nodeMap.clear();
      return;
    }

    const oldPositions = new Map();
    this.nodes.forEach(n => oldPositions.set(n.id, { x: n.x, y: n.y }));

    // Build node objects
    this.nodeMap.clear();
    this.nodes = graphData.nodes.map(n => {
      const old = oldPositions.get(n.id);
      const radius = Math.max(6, Math.min(22, 4 + n.weight * 1.5));
      const node = {
        ...n,
        x:  old ? old.x : (Math.random() - 0.5) * this.W * 0.6,
        y:  old ? old.y : (Math.random() - 0.5) * this.H * 0.6,
        vx: 0,
        vy: 0,
        r:  radius,
      };
      this.nodeMap.set(n.id, node);
      return node;
    });

    // Build link objects with node references
    this.links = graphData.links.map(l => ({
      ...l,
      sourceNode: this.nodeMap.get(l.source),
      targetNode: this.nodeMap.get(l.target),
    })).filter(l => l.sourceNode && l.targetNode);

    // Restart simulation
    this.alpha = 0.8;
  }

  /* ══════════════════════════════════
     Force simulation tick
     ══════════════════════════════════ */
  _simulate() {
    if (this.alpha < this.alphaMin) return;

    const nodes = this.nodes;
    const links = this.links;
    const N = nodes.length;

    // ── 1. Repulsion (Barnes-Hut simplified: pairwise for small N)
    const repStr = 800;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        const f = repStr * this.alpha / d2;
        const fx = dx * f;
        const fy = dy * f;
        nodes[i].vx -= fx;
        nodes[i].vy -= fy;
        nodes[j].vx += fx;
        nodes[j].vy += fy;
      }
    }

    // ── 2. Attraction along links (spring)
    const springLen = 100;
    const springStr = 0.06;
    for (const l of links) {
      const s = l.sourceNode, t = l.targetNode;
      let dx = t.x - s.x;
      let dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - springLen) * springStr * this.alpha;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      s.vx += fx;
      s.vy += fy;
      t.vx -= fx;
      t.vy -= fy;
    }

    // ── 3. Center gravity
    const cx = 0, cy = 0, grav = 0.02;
    for (const n of nodes) {
      n.vx += (cx - n.x) * grav * this.alpha;
      n.vy += (cy - n.y) * grav * this.alpha;
    }

    // ── 4. Integrate & dampen
    for (const n of nodes) {
      if (n === this.dragging) continue;
      n.vx *= this.velocityDecay;
      n.vy *= this.velocityDecay;
      n.x  += n.vx;
      n.y  += n.vy;
    }

    this.alpha *= (1 - this.alphaDecay);
  }

  /* ══════════════════════════════════
     Render
     ══════════════════════════════════ */
  _render() {
    const ctx = this.ctx;
    const W = this.W, H = this.H;

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2 + this.tx, H / 2 + this.ty);
    ctx.scale(this.scale, this.scale);

    const pulse = 0.5 + 0.5 * Math.sin(this._tick * 0.04);

    // ── Links
    for (const l of this.links) {
      const s = l.sourceNode, t = l.targetNode;
      const isHL = (this.selected && (s.id === this.selected.id || t.id === this.selected.id));
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = l.isLatest ? COLORS.linkLatest : COLORS.link;
      ctx.lineWidth   = isHL ? Math.min(l.weight, 4) + 1 : Math.min(l.weight, 3) * 0.6;
      ctx.globalAlpha = isHL ? 0.9 : (l.isLatest ? 0.5 : 0.2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // ── Nodes
    for (const n of this.nodes) {
      const c = COLORS[n.type] || COLORS.concept;
      const isHov = this.hovered === n;
      const isSel = this.selected === n;

      // Latest glow ring (pulsing)
      if (n.isLatest) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 5 + pulse * 3, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.latest.glow;
        ctx.fill();
      }

      // Selection ring
      if (isSel) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.selected;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = isHov ? '#ffffff' : c.fill;
      ctx.fill();

      // Latest inner ring
      if (n.isLatest) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 1, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.latest.ring;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Label
      const fontSize = Math.max(9, Math.min(13, n.r * 0.85));
      ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = n.isLatest || isSel || isHov ? COLORS.text : COLORS.textDim;
      ctx.fillText(n.label, n.x, n.y + n.r + fontSize + 2);
    }

    ctx.restore();
    this._tick++;
  }

  /* ── Animation loop ── */
  _loop() {
    this._simulate();
    this._render();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  /* ══════════════════════════════════
     Interaction
     ══════════════════════════════════ */
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
      if (dx * dx + dy * dy <= (n.r + 4) ** 2) return n;
    }
    return null;
  }

  _bindEvents() {
    const c = this.canvas;

    /* Resize */
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(c.parentElement);

    /* Wheel → zoom */
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      this.scale = Math.max(0.15, Math.min(6, this.scale * factor));
    }, { passive: false });

    /* Pointer down */
    c.addEventListener('pointerdown', e => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x: wx, y: wy } = this._screenToWorld(sx, sy);
      const hit = this._hitTest(wx, wy);

      if (hit) {
        this.dragging = hit;
        this.alpha = Math.max(this.alpha, 0.3);  // reheat
        c.setPointerCapture(e.pointerId);
      } else {
        this.isPanning = true;
        this.panStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
        c.setPointerCapture(e.pointerId);
      }
    });

    /* Pointer move */
    c.addEventListener('pointermove', e => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this.dragging) {
        const { x, y } = this._screenToWorld(sx, sy);
        this.dragging.x = x;
        this.dragging.y = y;
        this.dragging.vx = 0;
        this.dragging.vy = 0;
        this.alpha = Math.max(this.alpha, 0.15);
      } else if (this.isPanning && this.panStart) {
        this.tx = this.panStart.tx + (e.clientX - this.panStart.x);
        this.ty = this.panStart.ty + (e.clientY - this.panStart.y);
      } else {
        // Hover detection
        const { x: wx, y: wy } = this._screenToWorld(sx, sy);
        this.hovered = this._hitTest(wx, wy);
        c.style.cursor = this.hovered ? 'pointer' : 'grab';
      }
    });

    /* Pointer up */
    c.addEventListener('pointerup', e => {
      if (this.dragging) {
        // If barely moved → treat as click (select)
        this.dragging = null;
      }
      if (this.isPanning) {
        this.isPanning = false;
        this.panStart = null;
      }
    });

    /* Click → select node */
    c.addEventListener('click', e => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x: wx, y: wy } = this._screenToWorld(sx, sy);
      const hit = this._hitTest(wx, wy);
      this.selected = hit;
      if (this.onSelect) this.onSelect(hit);
    });
  }

  /* ══════════════════════════════════
     Public helpers
     ══════════════════════════════════ */

  /** 平滑聚焦到一组节点 */
  focusNodes(nodeIds) {
    const targets = this.nodes.filter(n => nodeIds.has(n.id));
    if (!targets.length) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of targets) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY, 100);
    const targetScale = Math.min(this.W, this.H) / (span + 160);
    const clampedScale = Math.max(0.4, Math.min(3, targetScale));

    // Animate
    const startTx = this.tx, startTy = this.ty, startS = this.scale;
    const endTx = -cx * clampedScale, endTy = -cy * clampedScale, endS = clampedScale;
    const dur = 500;
    const t0 = performance.now();

    const animate = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      this.tx    = startTx + (endTx - startTx) * ease;
      this.ty    = startTy + (endTy - startTy) * ease;
      this.scale = startS  + (endS  - startS)  * ease;
      if (t < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  /** 聚焦到最新对话节点 */
  focusLatest() {
    const ids = new Set(this.nodes.filter(n => n.isLatest).map(n => n.id));
    if (ids.size) this.focusNodes(ids);
  }

  /** 居中视图 */
  resetView() {
    const ids = new Set(this.nodes.map(n => n.id));
    this.focusNodes(ids);
  }

  /** 获取某节点的连接节点 */
  getConnected(nodeId) {
    const connected = [];
    for (const l of this.links) {
      if (l.source === nodeId) connected.push(this.nodeMap.get(l.target));
      else if (l.target === nodeId) connected.push(this.nodeMap.get(l.source));
    }
    return connected.filter(Boolean);
  }
}

/* ══════════════════════════════════════
   Side Panel Controller
   ══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const canvas    = document.getElementById('graph-canvas');
  const emptyEl   = document.getElementById('empty-state');
  const statsEl   = document.getElementById('stats');
  const drawerEl  = document.getElementById('detail-drawer');
  const drawerTitle = document.getElementById('drawer-title');
  const drawerBody  = document.getElementById('drawer-body');

  const graph = new ForceGraph(canvas);

  let currentData = null;

  /* ── Update graph with new data ── */
  function updateGraph(data) {
    if (!data || !data.nodes.length) {
      emptyEl.classList.remove('hidden');
      statsEl.textContent = '等待提取对话...';
      return;
    }
    emptyEl.classList.add('hidden');
    currentData = data;
    graph.setData(data);

    const latestCount = data.nodes.filter(n => n.isLatest).length;
    statsEl.textContent =
      `${data.nodes.length} 节点 · ${data.links.length} 关系 · ${data.totalTurns} 轮对话 · 最新 ${latestCount} 实体`;

    // Auto-focus latest on first load
    setTimeout(() => graph.focusLatest(), 600);
  }

  /* ── Detail drawer ── */
  graph.onSelect = (node) => {
    if (!node) {
      drawerEl.classList.remove('open');
      return;
    }
    drawerTitle.textContent = node.label;

    const connected = graph.getConnected(node.id);
    const turnTags  = node.turns.map(t => {
      const isLast = currentData && t === currentData.latestTurnIndex;
      return `<span class="tag ${isLast ? 'tag-latest' : 'tag-turn'}">Turn ${t + 1}${isLast ? ' (最新)' : ''}</span>`;
    }).join('');

    const connTags = connected.map(c =>
      `<span class="tag tag-connected" data-id="${c.id}">${c.label}</span>`
    ).join('');

    drawerBody.innerHTML = `
      <div class="drawer-section">
        <div class="drawer-label">类型</div>
        <span class="tag">${node.type}</span>
        ${node.isLatest ? '<span class="tag tag-latest">最新对话</span>' : ''}
        <span class="tag">出现 ${node.weight} 次</span>
      </div>
      <div class="drawer-section">
        <div class="drawer-label">出现轮次</div>
        <div class="drawer-tags">${turnTags}</div>
      </div>
      ${connTags ? `
      <div class="drawer-section">
        <div class="drawer-label">关联实体 (${connected.length})</div>
        <div class="drawer-tags">${connTags}</div>
      </div>` : ''}
    `;

    drawerEl.classList.add('open');

    // Click connected tag → select that node
    drawerBody.querySelectorAll('.tag-connected').forEach(el => {
      el.addEventListener('click', () => {
        const n = graph.nodeMap.get(el.dataset.id);
        if (n) {
          graph.selected = n;
          graph.focusNodes(new Set([n.id]));
          graph.onSelect(n);
        }
      });
    });
  };

  /* ── Buttons ── */
  document.getElementById('btn-refresh').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REQUEST_EXTRACT' });
  });

  document.getElementById('btn-center').addEventListener('click', () => {
    graph.resetView();
  });

  document.getElementById('btn-latest').addEventListener('click', () => {
    graph.focusLatest();
  });

  document.getElementById('btn-close-drawer').addEventListener('click', () => {
    drawerEl.classList.remove('open');
    graph.selected = null;
  });

  /* ── Message listeners ── */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'GRAPH_UPDATE') {
      updateGraph(msg.data);
    }
  });

  // Request initial data
  chrome.runtime.sendMessage({ type: 'GET_GRAPH_DATA' }, resp => {
    if (resp?.data) updateGraph(resp.data);
  });

  // Also request fresh extraction
  setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'REQUEST_EXTRACT' });
  }, 500);
});
