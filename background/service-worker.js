/**
 * Conversation Knowledge Graph — Service Worker
 * Multi-platform: Gemini + Qianwen (通义千问)
 * Message routing + TF-IDF cosine similarity for conversation turn analysis
 *
 * Nodes = conversation turns, Edges = content similarity
 */
'use strict';

/* ══════════════════════════════════════════
   NLP Engine — TF-IDF + 余弦相似度
   ══════════════════════════════════════════ */
class NLPEngine {
  constructor() {
    this.stopZH = new Set(
      '的了在是我有和就不人都一一个上也很到说要去你会着没有看好自己这他她么那被把以而等但对又还能可以这个那个什么如果因为所以但是或者以及通过进行可能需要已经其中关于之间这些那些它们我们他们比较然后或及与为中从用来个里面虽然只是更多所有使用当然还是下面上面更加比如按照想要无法根据其实一下一些怎么正在不是了解表示目前提供支持那么如何现在成为主要包括进入也是以后具有方面同时已更例如由于出现里作为起来用于出来就是大家之后然而此外另外同样类似总之最后首先还有这样那样如此这么那么而且不过一种可能会相关特别尤其很多非常没什么怎样为何到底究竟而言方式情况问题方法结果部分方向系统内容实现功能操作处理数据信息开发技术设计模型用户帮我介绍一下请问能否怎样才能'.match(/.{1,4}/g) ?? [],
    );
    this.stopEN = new Set(
      'the a an is are was were be been being have has had do does did will would could should may might can shall to of in for on with at by from as into about through between after before it its this that these those i you he she we they me him her us them my your his our their and or but not if then so than too very just also more some any each every all both few most other new old what which who when where why how there here no yes up out one two first last next only own same such like get got make made know think want see look use used using please help me tell explain describe compare what'.split(' '),
    );
  }

  normalizeUserText(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    return s
      .replace(/^\s*我说[\s:：-]*/u, '')
      .replace(/^\s*“我说”[\s:：-]*/u, '')
      .replace(/^\s*你说[\s:：-]*/u, '')
      .replace(/^\s*“你说”[\s:：-]*/u, '')
      .trim();
  }

  /** 分词：返回词频 Map */
  tokenize(text) {
    const freq = new Map();
    const add = (w) => { freq.set(w, (freq.get(w) || 0) + 1); };

    // 中文 2~6 字
    for (const m of text.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,6}/g)) {
      if (!this.stopZH.has(m[0])) add(m[0]);
    }
    // 英文
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.-]{1,30}/g)) {
      const w = m[0].toLowerCase();
      if (w.length >= 2 && !this.stopEN.has(w)) add(w);
    }
    return freq;
  }

  /** 提取一段文本的 top 关键词（用于节点标签显示） */
  topKeywords(text, n = 5) {
    const freq = this.tokenize(text);
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(e => e[0]);
  }

  /** 计算 TF-IDF 向量 */
  computeTFIDF(docs) {
    const N = docs.length;
    // docs: [ Map(word→count), ... ]

    // DF: 多少文档包含该词
    const df = new Map();
    for (const d of docs) {
      for (const w of d.keys()) {
        df.set(w, (df.get(w) || 0) + 1);
      }
    }

    // TF-IDF for each doc
    return docs.map(d => {
      const vec = new Map();
      const total = [...d.values()].reduce((a, b) => a + b, 0) || 1;
      for (const [w, c] of d) {
        const tf  = c / total;
        const idf = Math.log(N / (1 + (df.get(w) || 0)));
        vec.set(w, tf * idf);
      }
      return vec;
    });
  }

  /** 余弦相似度 */
  cosine(vecA, vecB) {
    let dot = 0, magA = 0, magB = 0;
    for (const [w, a] of vecA) {
      magA += a * a;
      const b = vecB.get(w);
      if (b !== undefined) dot += a * b;
    }
    for (const b of vecB.values()) magB += b * b;
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  /* ══════════════════════════════════
     核心：构建对话轮次图
     每个节点 = 一轮对话
     边权重   = TF-IDF 余弦相似度
     ══════════════════════════════════ */
  buildGraph(turns) {
    if (!turns.length) return { nodes: [], links: [], totalTurns: 0 };

    // 1. 为每轮对话合并文本并分词
    const cleanedTurns = turns.map(t => ({
      ...t,
      user: this.normalizeUserText(t.user),
    }));
    const docs = cleanedTurns.map(t => this.tokenize([t.user, t.model, t.thought || ''].join(' ')));

    // 2. 计算 TF-IDF
    const tfidf = this.computeTFIDF(docs);

    // 3. 构建节点：每轮对话一个节点
    const latestIdx = turns.length - 1;
    const nodes = cleanedTurns.map((t, i) => {
      // 用户消息截取作为标签
      const userText = t.user.trim();
      const label = userText.length > 20 ? userText.slice(0, 18) + '…' : (userText || `Turn ${i + 1}`);
      const keywords = this.topKeywords([t.user, t.model].join(' '), 5);
      const wordCount = (t.user.length || 0) + (t.model.length || 0);

      return {
        id:        `turn-${i}`,
        turnIndex: i,
        label,
        fullUser:  t.user,
        fullModel: t.model.slice(0, 300),
        keywords,
        wordCount,
        isLatest:  i === latestIdx,
      };
    });

    // 4. 计算所有对话对之间的相似度，保留有意义的边
    const links = [];
    const SIM_THRESHOLD = 0.05;  // 最低关联阈值

    for (let i = 0; i < turns.length; i++) {
      for (let j = i + 1; j < turns.length; j++) {
        const sim = this.cosine(tfidf[i], tfidf[j]);
        if (sim > SIM_THRESHOLD) {
          links.push({
            source: `turn-${i}`,
            target: `turn-${j}`,
            weight: sim,       // 0~1, 越大越相关
            isAdjacent: j === i + 1,
          });
        }
      }
    }

    // 5. 确保相邻轮次至少有一条弱连接（对话连续性）
    for (let i = 0; i < turns.length - 1; i++) {
      const sid = `turn-${i}`, tid = `turn-${i + 1}`;
      if (!links.find(l => l.source === sid && l.target === tid)) {
        links.push({ source: sid, target: tid, weight: 0.03, isAdjacent: true });
      }
    }

    return { nodes, links, totalTurns: turns.length };
  }
}

/* ══════════════════════════════════════
   消息路由
   ══════════════════════════════════════ */
const nlp = new NLPEngine();
let cachedGraph = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CONVERSATION_UPDATE') {
    const graphData = nlp.buildGraph(msg.data.turns);
    graphData.platform = msg.data.platform || 'gemini';
    graphData.url = msg.data.url || '';
    cachedGraph = graphData;
    chrome.runtime.sendMessage({ type: 'GRAPH_UPDATE', data: cachedGraph }).catch(() => {});
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_GRAPH_DATA') {
    sendResponse({ data: cachedGraph });
  }

  if (msg.type === 'REQUEST_EXTRACT') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab) {
        cachedGraph = { nodes: [], links: [], totalTurns: 0, platform: 'unknown', url: '' };
        chrome.runtime.sendMessage({ type: 'GRAPH_UPDATE', data: cachedGraph }).catch(() => {});
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CONVERSATION' }, resp => {
        if (chrome.runtime.lastError || !resp?.turns) {
          cachedGraph = { nodes: [], links: [], totalTurns: 0, platform: 'unknown', url: tab.url || '' };
          chrome.runtime.sendMessage({ type: 'GRAPH_UPDATE', data: cachedGraph }).catch(() => {});
          return;
        }
        const graphData = nlp.buildGraph(resp.turns);
        graphData.platform = resp.platform || 'gemini';
        graphData.url = resp.url || tab.url || '';
        cachedGraph = graphData;
        chrome.runtime.sendMessage({ type: 'GRAPH_UPDATE', data: cachedGraph }).catch(() => {});
      });
    });
    sendResponse({ ok: true });
  }

  /* Side Panel 请求滚动到某轮对话 → 转发给 Content Script */
  if (msg.type === 'NAVIGATE_TO_TURN') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'SCROLL_TO_TURN', turnIndex: msg.turnIndex });
    });
    sendResponse({ ok: true });
  }

  return true;
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
