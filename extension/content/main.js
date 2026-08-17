(function (global) {
  'use strict';
  /**
   * chromeinput content 装配 (原 content.js 的 installPageIme/installTextareaIME/
   * installStorageSync/handleRuntimeMessage 移植; <200 行).
   */
  const Shared = global.CIShared;
  const CI = (global.CIContent = global.CIContent || {});

  CI.runtimeMode = 'detached';
  CI.extensionEnabled = true;
  CI.focusedElement = null;
  let listenersInstalled = false;
  let storageSyncInstalled = false;
  let messageListenerInstalled = false;
  let pagePreparationPromise = null;
  let storageReadyPromise = null;
  let dictLoadPromise = null;

  // ------------------------------------------------------------ 中英开关
  function toggleMode() {
    CI.extensionEnabled = !CI.extensionEnabled;
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.storage.local.set({ [Shared.KEYS.ENABLED]: CI.extensionEnabled });
      }
    } catch (e) {
      console.log('CI: Extension context invalidated, state not saved.');
    }
    if (!CI.extensionEnabled && CI.uiVisible) {
      CI.ui.hideUI();
      global.CIEngine.state.buffer = '';
    }
  }

  function enableIme() {
    if (CI.extensionEnabled) return;
    CI.extensionEnabled = true;
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.storage.local.set({ [Shared.KEYS.ENABLED]: true });
      }
    } catch (e) {
      console.log('CI: Extension context invalidated, state not saved.');
    }
  }

  CI.toggleMode = toggleMode;
  CI.enableIme = enableIme;

  CI.isImeActive = function () {
    return CI.extensionEnabled && CI.siteRules.isCurrentPageEnabled();
  };

  // ------------------------------------------------------------ storage 同步
  function handleStorageChanged(changes) {
    if (changes[Shared.KEYS.ENABLED]) {
      CI.extensionEnabled = changes[Shared.KEYS.ENABLED].newValue !== false;
      if (!CI.extensionEnabled && CI.uiVisible) {
        CI.ui.hideUI();
        global.CIEngine.state.buffer = '';
      }
    }
    if (changes[Shared.KEYS.SITE_RULES]) {
      void CI.siteRules.loadSiteRules().then(() => {
        if (CI.uiVisible) CI.ui.renderUI();
      });
    }
    if (changes[Shared.KEYS.PUNCTUATION_MODE]) {
      CI.punctuationMode = changes[Shared.KEYS.PUNCTUATION_MODE].newValue === 'en' ? 'en' : 'cn';
      if (CI.uiVisible) CI.ui.renderUI();
    }
    if (changes[Shared.KEYS.WIDTH_MODE]) {
      CI.widthMode = changes[Shared.KEYS.WIDTH_MODE].newValue === 'full' ? 'full' : 'half';
      if (CI.uiVisible) CI.ui.renderUI();
    }
    if (changes[Shared.KEYS.FONT_SIZE]) {
      CI.fontSize = changes[Shared.KEYS.FONT_SIZE].newValue;
      CI.ui.updateUIMode();
    }
    if (changes[Shared.KEYS.USER_HISTORY]) {
      global.CIEngine.state.userHistory = changes[Shared.KEYS.USER_HISTORY].newValue || {};
    }
    if (changes[Shared.KEYS.UI_POS]) {
      CI.manualPosition = changes[Shared.KEYS.UI_POS].newValue || null;
    }
    if (changes[Shared.KEYS.DICT_OVERRIDES] || changes[Shared.KEYS.DICT_PATHS]) {
      // 未加载索引的页面首载时直接读最新数据
      if (global.CIEngine.state.ready) void reloadDict();
    }
  }

  function installStorageSync() {
    if (storageSyncInstalled) return;
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      storageReadyPromise = new Promise((resolve) => {
        chrome.storage.local.get([
          Shared.KEYS.ENABLED,
          Shared.KEYS.FONT_SIZE,
          Shared.KEYS.UI_POS,
          Shared.KEYS.SITE_RULES,
          Shared.KEYS.PUNCTUATION_MODE,
          Shared.KEYS.WIDTH_MODE,
          Shared.KEYS.USER_HISTORY
        ], (result) => {
          CI.extensionEnabled = result[Shared.KEYS.ENABLED] !== false;
          if (result[Shared.KEYS.FONT_SIZE]) CI.fontSize = result[Shared.KEYS.FONT_SIZE];
          if (result[Shared.KEYS.UI_POS]) CI.manualPosition = result[Shared.KEYS.UI_POS];
          if (result[Shared.KEYS.PUNCTUATION_MODE] === 'en') CI.punctuationMode = 'en';
          if (result[Shared.KEYS.WIDTH_MODE] === 'full') CI.widthMode = 'full';
          global.CIEngine.state.userHistory = result[Shared.KEYS.USER_HISTORY] || {};
          CI.siteRules.evaluateCurrentPageEnabled();
          CI.ui.updateUIMode();
          resolve();
        });
      });
      chrome.storage.onChanged.addListener(handleStorageChanged);
      storageSyncInstalled = true;
    } catch (e) {
      console.log('CI: Initial storage sync failed (context invalidated).');
    }
  }

  // ------------------------------------------------------------ 词库加载
  async function loadDict() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      if (global.CIEngine.state.ready) return;
      if (dictLoadPromise) {
        await dictLoadPromise;
        return;
      }
      dictLoadPromise = global.CIDictLoad.loadEffectiveDict();
      await dictLoadPromise;
    } catch (e) {
      console.error('CI: Dictionary load failed', e);
    } finally {
      dictLoadPromise = null;
    }
  }

  async function reloadDict() {
    try {
      await global.CIDictLoad.reloadEffectiveDict();
    } catch (e) {
      console.error('CI: Dictionary reload failed', e);
    }
  }

  function ensurePageImeReady() {
    if (CI.runtimeMode !== 'page') return Promise.resolve();
    if (pagePreparationPromise) return pagePreparationPromise;
    pagePreparationPromise = (async () => {
      // 普通页面保持轻量: UI 创建与词库解析都推迟到首次聚焦编辑器.
      await (storageReadyPromise || Promise.resolve());
      if (!CI.isImeActive()) return;
      CI.ui.injectUI();
      await loadDict();
    })().finally(() => {
      pagePreparationPromise = null;
    });
    return pagePreparationPromise;
  }

  CI.ensurePageImeReady = ensurePageImeReady;

  // ------------------------------------------------------------ runtime 消息
  function handleRuntimeMessage(msg) {
    if (msg && msg.type === 'ci_toggle_notepad') {
      CI.ui.toggleNotepad();
      return;
    }
    if (msg && msg.type === 'ci_add_selected_to_dict') {
      void promptAndSaveCustomEntry(msg.text || '');
      return;
    }
    if (msg && msg.type === 'ci_add_current_selection_to_fixed_dict') {
      void promptAndSaveCustomEntry(Shared.getActiveSelectedText());
      return;
    }
    if (msg && msg.type === 'ci_reload_effective_dict') {
      void reloadDict();
    }
  }

  async function promptAndSaveCustomEntry(selectedText) {
    const word = (selectedText || '').trim();
    if (!word) {
      Shared.showAppToast('No text selected for addition.', { tone: 'warning' });
      return;
    }
    await Shared.promptAndSaveShortcutEntry(word, {
      afterSave: async () => {
        if (global.CIEngine.state.ready) await reloadDict();
      }
    });
  }

  function installRuntimeMessageListener() {
    if (messageListenerInstalled) return;
    try {
      if (!chrome.runtime || !chrome.runtime.onMessage) return;
      chrome.runtime.onMessage.addListener(handleRuntimeMessage);
      messageListenerInstalled = true;
    } catch (e) {
      console.log('CI: Editor message listener failed (context invalidated).');
    }
  }

  // ------------------------------------------------------------ 监听器装配
  function installRuntimeListeners() {
    if (listenersInstalled) return;
    document.addEventListener('keydown', CI.keys.handleDocumentKeyDown, true);
    document.addEventListener('keyup', CI.keys.handleDocumentKeyUp, true);
    document.addEventListener('keydown', CI.keys.handleShiftTrackingKeyDown, true);
    document.addEventListener('mousemove', CI.ui.onDragMoveProxy, true);
    document.addEventListener('mouseup', CI.ui.endDragProxy, true);
    document.addEventListener('focusin', handleDocumentFocusIn, true);
    listenersInstalled = true;
  }

  function handleDocumentFocusIn(event) {
    if (CI.runtimeMode !== 'page' || !CI.keys.isInput(event.target) || !CI.isImeActive()) return;
    void ensurePageImeReady();
  }

  function uninstallRuntimeListeners() {
    if (!listenersInstalled) return;
    document.removeEventListener('keydown', CI.keys.handleDocumentKeyDown, true);
    document.removeEventListener('keyup', CI.keys.handleDocumentKeyUp, true);
    document.removeEventListener('keydown', CI.keys.handleShiftTrackingKeyDown, true);
    document.removeEventListener('mousemove', CI.ui.onDragMoveProxy, true);
    document.removeEventListener('mouseup', CI.ui.endDragProxy, true);
    document.removeEventListener('focusin', handleDocumentFocusIn, true);
    listenersInstalled = false;
  }

  // ------------------------------------------------------------ 模式入口
  function installPageIme() {
    CI.runtimeMode = 'page';
    CI.keys.setManagedTarget(null);
    CI.keys.setSuppressionCheck(null);
    installStorageSync();
    installRuntimeMessageListener();
    installRuntimeListeners();
  }

  function installTextareaIME(options = {}) {
    if (!options.target) {
      throw new Error('installTextareaIME requires a target.');
    }
    CI.runtimeMode = 'target';
    CI.keys.setManagedTarget(options.target);
    CI.keys.setSuppressionCheck(typeof options.isSuppressed === 'function' ? options.isSuppressed : null);
    installStorageSync();
    installRuntimeListeners();
    CI.ui.injectUI();
    void loadDict();
    return {
      destroy() {
        global.CIEngine.state.buffer = '';
        global.CIEngine.state.candidates = [];
        CI.pageIndex = 0;
        CI.selectedCandidateIndex = 0;
        CI.visibleCandidateRows = CI.DEFAULT_VISIBLE_CANDIDATE_ROWS;
        CI.focusedElement = null;
        CI.ui.hideUI();
        uninstallRuntimeListeners();
        CI.keys.setManagedTarget(null);
        CI.keys.setSuppressionCheck(null);
        CI.runtimeMode = 'detached';
      }
    };
  }

  global.CIContentIME = { installTextareaIME };

  const CONTENT_AUTO_INIT = global.__CI_CONTENT_AUTO_INIT__ !== false;
  if (CONTENT_AUTO_INIT) {
    installPageIme();
  }
})(typeof window !== 'undefined' ? window : globalThis);
