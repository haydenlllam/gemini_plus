/**
 * Gemini Knowledge Graph — Content Script
 * 从 Gemini 页面 DOM 中提取多轮对话内容，并通过 MutationObserver 实时监听增量更新
 */
(() => {
  'use strict';

  /* ── Gemini DOM 选择器（多级 fallback） ── */
  const SEL = {
    container:    '.conversation-container, infinite-scroller, #chat-history',
    userQuery:    'user-query, USER-QUERY',
    userText:     '.query-text-line, .query-text p, .query-text',
    modelResp:    'model-response, MODEL-RESPONSE',
    modelContent: '.model-response-text .markdown, .response-container-content .markdown, message-content .markdown',
    modelThought: 'model-thoughts .thoughts-body, model-thoughts .thoughts-content',
    scroller:     '.chat-scrollable-container, .chat-history-scroll-container, infinite-scroller, main',
  };

  /** 查找第一个匹配的元素（支持逗号分隔的多选择器） */
  function q(parent, selectors) {
    for (const s of selectors.split(',')) {
      const el = parent.querySelector(s.trim());
      if (el) return el;
    }
    return null;
  }

  /** 提取单个元素的纯文本，限制长度 */
  function textOf(el, maxLen = 5000) {
    if (!el) return '';
    const t = el.innerText || el.textContent || '';
    return t.trim().slice(0, maxLen);
  }

  /* ── 核心：提取全部对话轮次 ── */
  function extractConversation() {
    const root = q(document, SEL.container) || document.body;
    const userEls  = root.querySelectorAll(SEL.userQuery);
    const modelEls = root.querySelectorAll(SEL.modelResp);
    const len = Math.max(userEls.length, modelEls.length);
    const turns = [];

    for (let i = 0; i < len; i++) {
      const turn = { index: i, user: '', model: '', thought: '' };

      if (i < userEls.length) {
        turn.user = textOf(q(userEls[i], SEL.userText) || userEls[i]);
      }
      if (i < modelEls.length) {
        turn.model   = textOf(q(modelEls[i], SEL.modelContent) || modelEls[i]);
        turn.thought = textOf(q(modelEls[i], SEL.modelThought));
      }
      if (turn.user || turn.model) turns.push(turn);
    }
    return turns;
  }

  /* ── 发送到 Service Worker ── */
  let lastHash = '';

  function pushUpdate() {
    const turns = extractConversation();
    // 简单哈希防止重复推送
    const hash = turns.map(t => t.user.slice(0, 40) + t.model.slice(0, 40)).join('|');
    if (hash === lastHash) return;
    lastHash = hash;

    chrome.runtime.sendMessage({
      type: 'CONVERSATION_UPDATE',
      data: { turns, url: location.href, timestamp: Date.now() },
    }).catch(() => {});
  }

  /* ── MutationObserver：增量监听 ── */
  let debounceTimer = null;

  function startObserver() {
    const target = q(document, SEL.scroller) || document.body;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(pushUpdate, 800);
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  /* ── 响应来自 Service Worker / Side Panel 的请求 ── */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTRACT_CONVERSATION') {
      sendResponse({ turns: extractConversation() });
    }
    return true;
  });

  /* ── 初始化 ── */
  setTimeout(() => {
    pushUpdate();
    startObserver();
  }, 1500);
})();
