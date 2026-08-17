(function (global) {
  'use strict';
  /**
   * chromeinput content 存储同步 (由旧版核心 installStorageSync 移植):
   * 启动读取 ci_* 键 + chrome.storage.onChanged 增量同步到引擎/UI.
   */
  const Shared = global.CIShared;
  const CI = (global.CIContent = global.CIContent || {});

  let installed = false;
  let storageReadyPromise = null;

  // main.js 注入: 词库来源 (override/paths) 变化时的重载回调
  CI.sync = {
    onDictSourcesChanged: null,
    get ready() {
      return storageReadyPromise;
    }
  };

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
      if (global.CIEngine.state.ready && typeof CI.sync.onDictSourcesChanged === 'function') {
        void CI.sync.onDictSourcesChanged();
      }
    }
  }

  function installStorageSync() {
    if (installed) return;
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
      installed = true;
    } catch (e) {
      console.log('CI: Initial storage sync failed (context invalidated).');
    }
  }

  CI.sync.installStorageSync = installStorageSync;
})(typeof window !== 'undefined' ? window : globalThis);
