/**
 * Conversation Knowledge Graph — Content Script
 * Multi-platform support: Gemini + Qianwen (通义千问)
 * Extract conversation turns from DOM, support MutationObserver incremental updates
 * and Side Panel initiated "scroll to specific turn"
 */
(() => {
  'use strict';

  /* ══════════════════════════════════════
     Platform Detection
     ══════════════════════════════════════ */
  function detectPlatform() {
    const host = location.hostname;
    if (host.includes('gemini.google.com')) return 'gemini';
    if (host.includes('qianwen.com') || host.includes('qwen.ai') || host.includes('tongyi.aliyun.com')) return 'qianwen';
    return 'unknown';
  }

  const PLATFORM = detectPlatform();

  /* ══════════════════════════════════════
     Platform-specific DOM Selectors
     ══════════════════════════════════════ */
  const SELECTORS = {
    gemini: {
      container:    '.conversation-container, infinite-scroller, #chat-history',
      userMsg:      'user-query, USER-QUERY',
      userText:     '.query-text-line, .query-text p, .query-text',
      modelMsg:     'model-response, MODEL-RESPONSE',
      modelText:    '.model-response-text .markdown, .response-container-content .markdown, message-content .markdown',
      modelThought: 'model-thoughts .thoughts-body, model-thoughts .thoughts-content',
      scroller:     '.chat-scrollable-container, .chat-history-scroll-container, infinite-scroller, main',
    },
    qianwen: {
      container:    '.conversation-list, .chat-container, .message-list, .dialogue-container, main',
      userMsg:      '.user-content, .message-user, .user-message, [class*="user-content"], [class*="userMessage"], [class*="message-user"]',
      userText:     '.user-content p, .message-user p, .user-message p, [class*="user-content"] p, .user-content, .message-user, .user-message',
      modelMsg:     '.ai-content, .message-assistant, .bot-message, .assistant-message, [class*="assistant-content"], [class*="message-assistant"], [class*="bot-message"]',
      modelText:    '.ai-content p, .message-assistant p, .bot-message p, .assistant-message p, [class*="assistant-content"] p, [class*="message-assistant"] p, .ai-content, .message-assistant, .bot-message, .assistant-message',
      modelThought: '',
      scroller:     '.chat-container, .message-list, main, .dialogue-scroll-container',
    },
  };

  const SEL = SELECTORS[PLATFORM] || SELECTORS.gemini;

  function q(parent, selectors) {
    for (const s of selectors.split(',')) {
      const trimmed = s.trim();
      if (!trimmed) continue;
      try {
        const el = parent.querySelector(trimmed);
        if (el) return el;
      } catch (e) { /* skip invalid selectors */ }
    }
    return null;
  }

  function qAll(parent, selectors) {
    const results = [];
    for (const s of selectors.split(',')) {
      const trimmed = s.trim();
      if (!trimmed) continue;
      try {
        parent.querySelectorAll(trimmed).forEach(el => results.push(el));
      } catch (e) { /* skip invalid selectors */ }
    }
    return results;
  }

  function textOf(el, maxLen = 5000) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim().slice(0, maxLen);
  }

  function splitSelectors(selectors) {
    return String(selectors || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  function matchesAny(el, selectorList) {
    for (const sel of selectorList) {
      try {
        if (el.matches(sel)) return true;
      } catch (e) { /* skip invalid selectors */ }
    }
    return false;
  }

  function traverseComposed(rootNode, onElement) {
    if (!rootNode) return;
    if (rootNode instanceof Element) {
      onElement(rootNode);
      if (rootNode.shadowRoot) traverseComposed(rootNode.shadowRoot, onElement);
    }
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      onElement(node);
      if (node.shadowRoot) traverseComposed(node.shadowRoot, onElement);
      node = walker.nextNode();
    }
  }

  function deepQuerySelector(rootNode, selectors) {
    const selectorList = splitSelectors(selectors);
    const visited = new Set();
    const stack = [rootNode];

    while (stack.length) {
      const node = stack.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);

      for (const sel of selectorList) {
        try {
          const found = node.querySelector(sel);
          if (found) return found;
        } catch (e) { /* skip invalid selectors */ }
      }

      if (node instanceof Element && node.shadowRoot) stack.push(node.shadowRoot);
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      let el = walker.nextNode();
      while (el) {
        if (el.shadowRoot) stack.push(el.shadowRoot);
        el = walker.nextNode();
      }
    }

    return null;
  }

  function closestAny(el, selectors) {
    if (!el) return null;
    const list = Array.isArray(selectors) ? selectors : splitSelectors(selectors);
    for (const sel of list) {
      try {
        const hit = el.closest(sel);
        if (hit) return hit;
      } catch (e) { /* skip invalid selectors */ }
    }
    return null;
  }

  function extractTextFromContainer(container, selectors, maxLen = 8000) {
    if (!container) return '';
    const selectorList = splitSelectors(selectors);
    const parts = [];
    const seen = new Set();

    traverseComposed(container, (el) => {
      if (seen.has(el)) return;
      if (!matchesAny(el, selectorList)) return;
      const t = textOf(el, maxLen);
      if (!t) return;
      seen.add(el);
      parts.push(t);
    });

    const combined = parts.join('\n').trim();
    if (combined) return combined.slice(0, maxLen);
    return textOf(container, maxLen);
  }

  function collectMessagesByText(rootNode) {
    const userTextList = splitSelectors(SEL.userText);
    const modelTextList = splitSelectors(SEL.modelText);
    const userMsgList = splitSelectors(SEL.userMsg);
    const modelMsgList = splitSelectors(SEL.modelMsg);
    const out = [];
    const seen = new Set();
    let order = 0;

    const add = (el, sourceType) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push({ el, sourceType, order: order++ });
    };

    traverseComposed(rootNode, (el) => {
      if (!el || !(el instanceof Element)) return;

      if (matchesAny(el, userTextList)) {
        const msgEl =
          closestAny(el, userMsgList) ||
          closestAny(el, ['.query-text', '.query-text-line']) ||
          el;
        add(msgEl, 'user');
        return;
      }

      if (matchesAny(el, modelTextList)) {
        const msgEl =
          closestAny(el, modelMsgList) ||
          closestAny(el, ['message-content', '.model-response-text', '.response-container-content', '.markdown']) ||
          el;
        add(msgEl, 'model');
      }
    });

    out.sort((a, b) => {
      const ao = getOffset(a.el);
      const bo = getOffset(b.el);
      if (ao !== bo) return ao - bo;
      return a.order - b.order;
    });
    return out;
  }

  function extractGeminiConversation(rootNode) {
    const allMessages =
      collectMessages(rootNode, SEL.userMsg, SEL.modelMsg).length > 1
        ? collectMessages(rootNode, SEL.userMsg, SEL.modelMsg)
        : collectMessagesByText(rootNode);

    const turns = [];
    let currentTurn = null;
    let turnIndex = 0;

    for (const msg of allMessages) {
      if (msg.sourceType === 'user') {
        if (currentTurn && (currentTurn.user || currentTurn.model)) {
          turns.push(currentTurn);
          turnIndex++;
        }
        currentTurn = { index: turnIndex, user: '', model: '', thought: '' };
        currentTurn.user = extractTextFromContainer(msg.el, SEL.userText, 8000);
        turnElements[turnIndex] = msg.el;
        continue;
      }

      if (msg.sourceType === 'model') {
        if (!currentTurn) currentTurn = { index: turnIndex, user: '', model: '', thought: '' };
        const modelText = extractTextFromContainer(msg.el, SEL.modelText, 16000);
        if (modelText) currentTurn.model = modelText;
        const thoughtText = SEL.modelThought ? extractTextFromContainer(msg.el, SEL.modelThought, 8000) : '';
        if (thoughtText) currentTurn.thought = thoughtText;
        if (!turnElements[currentTurn.index]) turnElements[currentTurn.index] = msg.el;
      }
    }

    if (currentTurn && (currentTurn.user || currentTurn.model)) turns.push(currentTurn);
    return turns;
  }

  function collectMessages(rootNode, userSelectors, modelSelectors) {
    const userList = splitSelectors(userSelectors);
    const modelList = splitSelectors(modelSelectors);
    const out = [];
    const seen = new Set();
    let order = 0;

    const add = (el, sourceType) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push({ el, sourceType, order: order++ });
    };

    const visit = (el) => {
      if (matchesAny(el, userList)) add(el, 'user');
      else if (matchesAny(el, modelList)) add(el, 'model');
    };

    traverseComposed(rootNode, visit);

    out.sort((a, b) => {
      const ao = getOffset(a.el);
      const bo = getOffset(b.el);
      if (ao !== bo) return ao - bo;
      return a.order - b.order;
    });
    return out;
  }

  /* ══════════════════════════════════════
     Extract Conversation — Platform-aware
     ══════════════════════════════════════ */
  let turnElements = [];   // cached DOM element refs for scroll-to
  let memoryTurns = [];
  let lastUrl = location.href;
  let extensionAlive = true;

  function extractConversation() {
    const primaryRoot = q(document, SEL.container) || document.body;
    const turns = [];
    turnElements = [];

    if (PLATFORM === 'gemini') {
      const roots = [];
      const mainEl = q(document, 'main');
      if (mainEl) roots.push(mainEl);
      if (primaryRoot) roots.push(primaryRoot);
      roots.push(document.body);

      let best = [];
      for (const r of roots) {
        const extracted = extractGeminiConversation(r);
        if (extracted.length > best.length) best = extracted;
        if (best.length >= 2) break;
      }
      for (const t of best) turns.push(t);
    } else if (PLATFORM === 'qianwen') {
      // Qianwen: detect by role order
      const userEls  = qAll(primaryRoot, SEL.userMsg);
      const modelEls = qAll(primaryRoot, SEL.modelMsg);

      // Merge by document order
      const allMessages = [...userEls, ...modelEls]
        .map(el => ({ el, sourceType: userEls.includes(el) ? 'user' : 'model', offset: getOffset(el) }))
        .sort((a, b) => a.offset - b.offset);

      // Group into turns: user + following model = one turn
      let currentTurn = null;
      let turnIndex = 0;

      for (const msg of allMessages) {
        if (msg.sourceType === 'user') {
          if (currentTurn) {
            if (currentTurn.user || currentTurn.model) {
              turns.push(currentTurn);
              turnIndex++;
            }
          }
          currentTurn = { index: turnIndex, user: '', model: '', thought: '' };
          currentTurn.user = textOf(q(msg.el, SEL.userText) || msg.el);
          turnElements[turnIndex] = msg.el;
        } else if (msg.sourceType === 'model' && currentTurn) {
          currentTurn.model = textOf(q(msg.el, SEL.modelText) || msg.el);
          // Prefer the model element for navigation
          if (!turnElements[currentTurn.index]) turnElements[currentTurn.index] = msg.el;
        }
      }
      if (currentTurn && (currentTurn.user || currentTurn.model)) {
        turns.push(currentTurn);
      }
    }

    return turns;
  }

  // Helper: get vertical offset for DOM ordering
  function getOffset(el) {
    try {
      return el.getBoundingClientRect().top;
    } catch (e) {
      return 0;
    }
  }

  /* ══════════════════════════════════════
     Scroll to Turn + Highlight
     ══════════════════════════════════════ */
  function scrollToTurn(turnIndex) {
    const el = turnElements[turnIndex];
    if (!el) return false;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    el.style.transition = 'outline 0.2s, outline-offset 0.2s';
    el.style.outline = '2px solid #f59e0b';
    el.style.outlineOffset = '4px';
    el.style.borderRadius = '8px';
    setTimeout(() => {
      el.style.outline = '2px solid transparent';
      setTimeout(() => {
        el.style.outline = '2px solid #f59e0b';
        setTimeout(() => {
          el.style.outline = '';
          el.style.outlineOffset = '';
          el.style.borderRadius = '';
          el.style.transition = '';
        }, 600);
      }, 300);
    }, 600);
    return true;
  }

  /* ══════════════════════════════════════
     Push Updates
     ══════════════════════════════════════ */
  let lastHash = '';

  function safeSendMessage(payload) {
    if (!extensionAlive) return;
    try {
      const p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      extensionAlive = false;
      stopPolling();
      stopObserver();
      stopInputCapture();
    }
  }

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function turnKey(t) {
    const u = normalizeText(t.user).slice(0, 120);
    const m = normalizeText(t.model).slice(0, 120);
    return `${u}|||${m}`;
  }

  function reindexTurns(turns) {
    for (let i = 0; i < turns.length; i++) turns[i].index = i;
    return turns;
  }

  function mergeTurns(extracted) {
    const cleaned = (extracted || []).filter(t => (t.user || t.model));
    if (!cleaned.length) return memoryTurns;
    if (!memoryTurns.length) {
      memoryTurns = reindexTurns(cleaned.map(t => ({ ...t })));
      return memoryTurns;
    }

    const memKeys = new Map();
    for (let i = 0; i < memoryTurns.length; i++) memKeys.set(turnKey(memoryTurns[i]), i);

    for (const t of cleaned) {
      const k = turnKey(t);
      const hit = memKeys.get(k);
      if (hit !== undefined) {
        const mt = memoryTurns[hit];
        if (!mt.user && t.user) mt.user = t.user;
        if ((!mt.model || mt.model.length < t.model.length) && t.model) mt.model = t.model;
        if ((!mt.thought || mt.thought.length < (t.thought || '').length) && t.thought) mt.thought = t.thought;
        continue;
      }

      const last = memoryTurns[memoryTurns.length - 1];
      if (last && normalizeText(last.user) === normalizeText(t.user) && (!last.model || last.model.length < t.model.length)) {
        if (t.model) last.model = t.model;
        if (t.thought) last.thought = t.thought;
        continue;
      }

      memoryTurns.push({ index: memoryTurns.length, user: t.user || '', model: t.model || '', thought: t.thought || '' });
      memKeys.set(k, memoryTurns.length - 1);
    }

    memoryTurns = reindexTurns(memoryTurns);
    return memoryTurns;
  }

  function pushUpdate() {
    if (!extensionAlive) return;
    try {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        memoryTurns = [];
        lastHash = '';
        lastCapturedUser = '';
      }

      const extracted = extractConversation();
      const turns = mergeTurns(extracted);
      const hash = turns.map(t => t.user.slice(0, 40) + t.model.slice(0, 40)).join('|');
      if (hash === lastHash) return;
      lastHash = hash;

      safeSendMessage({
        type: 'CONVERSATION_UPDATE',
        data: { turns, platform: PLATFORM, url: location.href, timestamp: Date.now() },
      });
    } catch (e) {
      if (String(e || '').includes('Extension context invalidated')) {
        extensionAlive = false;
        stopPolling();
        stopObserver();
        stopInputCapture();
      }
    }
  }

  /* ══════════════════════════════════════
     MutationObserver
     ══════════════════════════════════════ */
  let debounceTimer = null;
  let mutationObserver = null;

  function startObserver() {
    if (mutationObserver) return;
    const target = q(document, SEL.scroller) || document.body;
    mutationObserver = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(pushUpdate, 800);
    });
    mutationObserver.observe(target, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (!mutationObserver) return;
    try { mutationObserver.disconnect(); } catch (e) {}
    mutationObserver = null;
  }

  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pushUpdate, 2000);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  let inputCaptureBound = false;
  let lastCapturedUser = '';

  function addUserTurn(text) {
    const user = normalizeText(text);
    if (!user) return;
    if (user === lastCapturedUser) return;
    lastCapturedUser = user;
    const last = memoryTurns[memoryTurns.length - 1];
    if (last && normalizeText(last.user) === user && !last.model) return;
    memoryTurns.push({ index: memoryTurns.length, user, model: '', thought: '' });
    reindexTurns(memoryTurns);
    lastHash = '';
    pushUpdate();
  }

  function findPromptInput() {
    const candidates = [...document.querySelectorAll('textarea, input[type="text"]')];
    let best = null;
    let bestScore = -1;
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 20) continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      const score = (aria.includes('prompt') || aria.includes('message') || placeholder.includes('prompt') || placeholder.includes('message')) ? 2 : 0;
      const areaScore = Math.min(2, (rect.width * rect.height) / 200000);
      const s = score + areaScore;
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    return best;
  }

  function onKeyDownCapture(e) {
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.isComposing) return;
    const el = e.target;
    if (!el) return;
    if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) return;
    const v = el.value;
    if (!v || !v.trim()) return;
    addUserTurn(v);
  }

  function isSendClickTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const btn = target.closest('button, div[role="button"], span[role="button"]');
    if (!btn) return false;

    const type = (btn.getAttribute('type') || '').toLowerCase();
    if (type === 'submit') return true;

    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();
    const testId = (btn.getAttribute('data-test-id') || '').toLowerCase();
    const text = normalizeText(btn.innerText).toLowerCase();

    const hay = [aria, title, testId, text].join(' ');
    return (
      hay.includes('send') ||
      hay.includes('发送') ||
      hay.includes('提交') ||
      hay.includes('enter') ||
      hay.includes('run')
    );
  }

  function onClickCapture(e) {
    if (!isSendClickTarget(e.target)) return;
    const el = findPromptInput();
    if (!el) return;
    const v = el.value;
    if (!v || !v.trim()) return;
    addUserTurn(v);
  }

  function startInputCapture() {
    if (inputCaptureBound) return;
    inputCaptureBound = true;
    document.addEventListener('keydown', onKeyDownCapture, true);
    document.addEventListener('click', onClickCapture, true);
  }

  function stopInputCapture() {
    if (!inputCaptureBound) return;
    inputCaptureBound = false;
    document.removeEventListener('keydown', onKeyDownCapture, true);
    document.removeEventListener('click', onClickCapture, true);
  }

  /* ══════════════════════════════════════
     Message Listeners
     ══════════════════════════════════════ */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTRACT_CONVERSATION') {
      try {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          memoryTurns = [];
          lastHash = '';
          lastCapturedUser = '';
        }
        const extracted = extractConversation();
        const turns = mergeTurns(extracted);
        sendResponse({ turns, platform: PLATFORM, url: location.href });
      } catch (e) {
        if (String(e || '').includes('Extension context invalidated')) {
          extensionAlive = false;
          stopPolling();
          stopObserver();
          stopInputCapture();
        }
        sendResponse({ turns: [], platform: PLATFORM, url: location.href });
      }
    }
    if (msg.type === 'SCROLL_TO_TURN') {
      extractConversation();
      const ok = scrollToTurn(msg.turnIndex);
      sendResponse({ ok });
    }
    return true;
  });

  /* ══════════════════════════════════════
     Initialize
     ══════════════════════════════════════ */
  if (PLATFORM === 'unknown') {
    console.log('[ConvGraph] Unsupported platform:', location.hostname);
  } else {
    console.log('[ConvGraph] Platform detected:', PLATFORM);
    setTimeout(() => {
      pushUpdate();
      startObserver();
      if (PLATFORM === 'gemini') {
        startPolling();
        startInputCapture();
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) stopPolling();
          else {
            startPolling();
            pushUpdate();
          }
        });
      }
    }, 1500);
  }
})();
