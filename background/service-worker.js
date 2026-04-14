/**
 * Gemini Knowledge Graph — Service Worker
 * 消息路由 + 轻量 NLP 实体抽取 + 知识图谱数据构建
 */
'use strict';

/* ══════════════════════════════════════════
   NLP Engine — 客户端轻量实体 / 关系抽取
   ══════════════════════════════════════════ */
class NLPEngine {
  constructor() {
    this.stopZH = new Set(
      '的了在是我有和就不人都一一个上也很到说要去你会着没有看好自己这他她么那被把以而等但对又还能可以这个那个什么如果因为所以但是或者以及通过进行可能需要已经其中关于之间这些那些它们我们他们比较然后或及与为中从用来个里面虽然只是更多所有使用当然还是下面上面更加比如按照想要无法根据其实一下一些怎么正在不是了解表示目前提供支持那么如何现在成为主要包括进入也是以后具有方面同时已更例如由于出现里作为作为起来用于出来就是大家之后然而此外另外同样类似总之最后首先另外还有这样那样如此这么那么而且不过一种可能会相关特别尤其很多非常没什么怎样为何到底究竟而言方式情况问题方法结果部分方向系统内容实现功能操作处理数据信息开发技术设计模型用户'
        .match(/.{1,4}/g) ?? [],
    );
    this.stopEN = new Set(
      'the a an is are was were be been being have has had do does did will would could should may might can shall to of in for on with at by from as into about through between after before it its this that these those i you he she we they me him her us them my your his our their and or but not if then so than too very just also more some any each every all both few most other new old what which who when where why how there here no yes up out one two first last next only own same such like get got make made know think want see look use used using'.split(
        ' ',
      ),
    );
  }

  /* ── 分词 + 关键词提取 ── */
  tokenize(text) {
    const tokens = [];

    // 1) 提取中文 2~6 字词
    for (const m of text.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,6}/g)) {
      const w = m[0];
      if (!this.stopZH.has(w)) tokens.push({ word: w, lang: 'zh' });
    }

    // 2) 提取英文有意义词
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.-]{1,30}/g)) {
      const w = m[0];
      if (w.length < 2 || this.stopEN.has(w.toLowerCase())) continue;
      tokens.push({ word: w, lang: 'en' });
    }

    return tokens;
  }

  /* ── 从单段文本中提取实体 (top-N) ── */
  extractEntities(text, topN = 20) {
    const freq = new Map();
    for (const { word } of this.tokenize(text)) {
      const key = word.toLowerCase();
      if (!freq.has(key)) freq.set(key, { label: word, count: 0 });
      freq.get(key).count++;
    }

    return [...freq.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topN)
      .map(([key, v]) => ({ key, label: v.label, count: v.count }));
  }

  /* ── 对实体进行分类 ── */
  classifyEntity(label) {
    if (/^[A-Z][a-z]+[A-Z]/.test(label) || /^[A-Z_]{2,}$/.test(label) || /[.\-\/]/.test(label))
      return 'technical';
    if (/^[A-Z]/.test(label)) return 'entity';
    return 'concept';
  }

  /* ══════════════════════════════════
     核心：从多轮对话构建图数据
     ══════════════════════════════════ */
  buildGraph(turns) {
    const nodeMap  = new Map();   // key → node
    const linkMap  = new Map();   // 'a::b' → link
    const latestIdx = turns.length - 1;

    turns.forEach((turn, ti) => {
      const combined = [turn.user, turn.model, turn.thought || ''].join(' ');
      const entities = this.extractEntities(combined, 18);
      const keys = [];

      for (const { key, label, count } of entities) {
        keys.push(key);
        if (!nodeMap.has(key)) {
          nodeMap.set(key, {
            id: key,
            label,
            type: this.classifyEntity(label),
            weight: 0,
            turns: [],
            isLatest: false,
          });
        }
        const n = nodeMap.get(key);
        n.weight += count;
        if (!n.turns.includes(ti)) n.turns.push(ti);
        if (ti === latestIdx) n.isLatest = true;
      }

      // 同一轮次实体之间建立共现关系
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const lid = [keys[i], keys[j]].sort().join('::');
          if (!linkMap.has(lid)) {
            linkMap.set(lid, {
              source: keys[i],
              target: keys[j],
              weight: 0,
              turns: [],
              isLatest: false,
            });
          }
          const l = linkMap.get(lid);
          l.weight++;
          if (!l.turns.includes(ti)) l.turns.push(ti);
          if (ti === latestIdx) l.isLatest = true;
        }
      }
    });

    const nodes = [...nodeMap.values()];
    const nodeIds = new Set(nodes.map(n => n.id));
    const links = [...linkMap.values()].filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));

    return { nodes, links, totalTurns: turns.length, latestTurnIndex: latestIdx };
  }
}

/* ══════════════════════════════════════
   消息路由
   ══════════════════════════════════════ */
const nlp = new NLPEngine();
let cachedGraph = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  /* 来自 Content Script 的对话更新 */
  if (msg.type === 'CONVERSATION_UPDATE') {
    cachedGraph = nlp.buildGraph(msg.data.turns);
    // 转发给 Side Panel
    chrome.runtime.sendMessage({ type: 'GRAPH_UPDATE', data: cachedGraph }).catch(() => {});
    sendResponse({ ok: true });
  }

  /* Side Panel 请求当前图数据 */
  if (msg.type === 'GET_GRAPH_DATA') {
    sendResponse({ data: cachedGraph });
  }

  /* Side Panel 请求重新提取 */
  if (msg.type === 'REQUEST_EXTRACT') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'EXTRACT_CONVERSATION' }, resp => {
        if (chrome.runtime.lastError || !resp?.turns) return;
        cachedGraph = nlp.buildGraph(resp.turns);
        chrome.runtime.sendMessage({ type: 'GRAPH_UPDATE', data: cachedGraph }).catch(() => {});
      });
    });
    sendResponse({ ok: true });
  }

  return true; // keep channel open for async
});

/* 点击扩展图标打开 Side Panel */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
