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

  /* ══════════════════════════════════════
     Extract Conversation — Platform-aware
     ══════════════════════════════════════ */
  let turnElements = [];   // cached DOM element refs for scroll-to

  function extractConversation() {
    const root = q(document, SEL.container) || document.body;
    const turns = [];
    turnElements = [];

    if (PLATFORM === 'gemini') {
      // Gemini: use existing extraction
      const userEls  = root.querySelectorAll(SEL.userMsg);
      const modelEls = root.querySelectorAll(SEL.modelMsg);
      const len = Math.max(userEls.length, modelEls.length);

      for (let i = 0; i < len; i++) {
        const turn = { index: i, user: '', model: '', thought: '' };
        if (i < userEls.length) {
          turn.user = textOf(q(userEls[i], SEL.userText) || userEls[i]);
          turnElements[i] = userEls[i];
        } else if (i < modelEls.length) {
          turnElements[i] = modelEls[i];
        }
        if (i < modelEls.length) {
          turn.model   = textOf(q(modelEls[i], SEL.modelText) || modelEls[i]);
          turn.thought = textOf(q(modelEls[i], SEL.modelThought));
        }
        if (turn.user || turn.model) turns.push(turn);
      }
    } else if (PLATFORM === 'qianwen') {
      // Qianwen: detect by role order
      const userEls  = qAll(root, SEL.userMsg);
      const modelEls = qAll(root, SEL.modelMsg);

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

  function pushUpdate() {
    const turns = extractConversation();
    const hash = turns.map(t => t.user.slice(0, 40) + t.model.slice(0, 40)).join('|');
    if (hash === lastHash) return;
    lastHash = hash;

    chrome.runtime.sendMessage({
      type: 'CONVERSATION_UPDATE',
      data: { turns, platform: PLATFORM, url: location.href, timestamp: Date.now() },
    }).catch(() => {});
  }

  /* ══════════════════════════════════════
     MutationObserver
     ══════════════════════════════════════ */
  let debounceTimer = null;

  function startObserver() {
    const target = q(document, SEL.scroller) || document.body;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(pushUpdate, 800);
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  /* ══════════════════════════════════════
     Message Listeners
     ══════════════════════════════════════ */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTRACT_CONVERSATION') {
      sendResponse({ turns: extractConversation(), platform: PLATFORM });
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
    }, 1500);
  }
})();
