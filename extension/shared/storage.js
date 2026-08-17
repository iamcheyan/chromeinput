(function (global) {
  'use strict';
  /**
   * chromeinput 存储层 (原 sbzr-core.js 的存储部分瘦身移植).
   *
   * 键名统一 ci_ 前缀; 词库 overrides 沿用原扩展机制:
   * 打包文件为基底, 编辑结果以 override 存 chrome.storage.local.
   */
  const KEYS = {
    ENABLED: 'ci_enabled',
    SITE_RULES: 'ci_site_rules',
    PUNCTUATION_MODE: 'ci_punctuation_mode',
    WIDTH_MODE: 'ci_width_mode',
    FONT_SIZE: 'ci_font_size',
    UI_POS: 'ci_ui_pos',
    USER_HISTORY: 'ci_user_history',
    DICT_PATHS: 'ci_dict_paths',
    DICT_OVERRIDES: 'ci_dict_overrides',
    DICT_CACHE: 'ci_dict_cache'
  };

  const NATIVE_SYNC_ENABLED = false; // 接口保留, 默认关闭 (GOAL §一)
  const NATIVE_HOST_NAME = 'com.ci.filehost';

  function storage() {
    return (global.chrome && chrome.storage && chrome.storage.local) || null;
  }

  async function get(keys) {
    const s = storage();
    if (!s) return {};
    return await s.get(Array.isArray(keys) ? keys : [keys]);
  }

  async function set(items) {
    const s = storage();
    if (!s) return;
    await s.set(items);
  }

  function onChanged(listener) {
    const s = storage();
    if (!s || !s.onChanged) return false;
    s.onChanged.addListener(listener);
    return true;
  }

  function offChanged(listener) {
    const s = storage();
    if (!s || !s.onChanged) return;
    try { s.onChanged.removeListener(listener); } catch (e) { /* context invalidated */ }
  }

  // ------------------------------------------------------------ 词库 override
  async function getDictOverrides() {
    const result = await get(KEYS.DICT_OVERRIDES);
    return result[KEYS.DICT_OVERRIDES] || {};
  }

  async function readDictResource(path, { runtime = global.chrome && chrome.runtime } = {}) {
    const overrides = await getDictOverrides();
    if (Object.prototype.hasOwnProperty.call(overrides, path)) {
      return `${overrides[path] || ''}`;
    }
    if (!runtime || !runtime.id) {
      throw new Error(`Extension context unavailable for ${path}`);
    }
    const response = await fetch(runtime.getURL(path), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load ${path}: HTTP ${response.status}`);
    }
    return await response.text();
  }

  async function saveDictOverride(path, text) {
    const overrides = await getDictOverrides();
    const next = { ...overrides, [path]: `${text || ''}` };
    await set({ [KEYS.DICT_OVERRIDES]: next });
    return next[path];
  }

  async function clearDictOverride(path) {
    const overrides = await getDictOverrides();
    if (!Object.prototype.hasOwnProperty.call(overrides, path)) return;
    const next = { ...overrides };
    delete next[path];
    await set({ [KEYS.DICT_OVERRIDES]: next });
  }

  // ------------------------------------------------------------ 用户词库条目
  const USER_DICT_PATH = 'dicts/user.json';
  const USER_ENTRY_WEIGHT = 999999;
  const SHORTCUT_BASE_WEIGHT = 2000;

  function parseEntries(text) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return null;
      const out = [];
      for (const row of parsed) {
        if (Array.isArray(row) && row.length >= 2) {
          out.push([String(row[0]), String(row[1]), Number(row[2]) || USER_ENTRY_WEIGHT]);
        }
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  function renderEntries(entries) {
    return JSON.stringify(entries, null, 0);
  }

  async function getUserEntries() {
    const text = await readDictResource(USER_DICT_PATH);
    return parseEntries(text) || [];
  }

  async function upsertUserEntry(word, code, weight = USER_ENTRY_WEIGHT) {
    const entries = await getUserEntries();
    const next = [];
    let replaced = false;
    for (const entry of entries) {
      if (entry[0] === word && entry[1] === code) {
        next.push([word, code, Math.max(entry[2], weight)]);
        replaced = true;
      } else {
        next.push(entry);
      }
    }
    if (!replaced) next.push([word, code, weight]);
    const text = renderEntries(next);
    await saveDictOverride(USER_DICT_PATH, text);
    return { text, entries: next };
  }

  function getNextShortcutWeight(entries, code) {
    let maxWeight = SHORTCUT_BASE_WEIGHT - 1;
    for (const entry of entries) {
      if (entry[1] === code) maxWeight = Math.max(maxWeight, entry[2] || SHORTCUT_BASE_WEIGHT);
    }
    return maxWeight + 1;
  }

  // ------------------------------------------------------------ 选中文字
  function getActiveSelectedText(doc = global.document) {
    if (!doc) return '';
    let active = doc.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    if (
      active &&
      typeof active.value === 'string' &&
      typeof active.selectionStart === 'number' &&
      typeof active.selectionEnd === 'number' &&
      active.selectionStart !== active.selectionEnd
    ) {
      return active.value.slice(active.selectionStart, active.selectionEnd);
    }
    const selection = doc.getSelection ? doc.getSelection() : null;
    return selection ? selection.toString() : '';
  }

  // ------------------------------------------------------------ Tab 拖拽
  function installTabDragging(container, {
    onOrderChange,
    tabSelector = '.tab',
    draggingClass = 'is-dragging'
  } = {}) {
    let draggedElement = null;

    function getMouseTab(event) {
      const el = event.target.closest(tabSelector);
      if (el && container.contains(el)) return el;
      return null;
    }

    function onDragStart(event) {
      const tab = getMouseTab(event);
      if (!tab) return;
      draggedElement = tab;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', '');
      requestAnimationFrame(() => { tab.classList.add(draggingClass); });
    }

    function onDragOver(event) {
      if (!draggedElement) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const target = getMouseTab(event);
      if (target && target !== draggedElement) {
        const rect = target.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        if (event.clientX < midpoint) {
          container.insertBefore(draggedElement, target);
        } else {
          container.insertBefore(draggedElement, target.nextSibling);
        }
      }
    }

    function onDragEnd() {
      if (draggedElement) {
        draggedElement.classList.remove(draggingClass);
        draggedElement = null;
      }
      if (typeof onOrderChange === 'function') {
        onOrderChange(Array.from(container.querySelectorAll(tabSelector)));
      }
    }

    container.addEventListener('dragstart', onDragStart);
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragend', onDragEnd);

    return () => {
      container.removeEventListener('dragstart', onDragStart);
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('dragend', onDragEnd);
    };
  }

  // ------------------------------------------------------------ native sync 接口
  async function syncUserHistoryToRime() {
    if (!NATIVE_SYNC_ENABLED) {
      return { ok: false, error: 'Native sync disabled by default (GOAL.md §一).' };
    }
    return { ok: false, error: 'Native host not installed.' };
  }

  global.CIShared = Object.assign(global.CIShared || {}, {
    KEYS,
    NATIVE_SYNC_ENABLED,
    NATIVE_HOST_NAME,
    USER_DICT_PATH,
    USER_ENTRY_WEIGHT,
    SHORTCUT_BASE_WEIGHT,
    get,
    set,
    onChanged,
    offChanged,
    getDictOverrides,
    readDictResource,
    saveDictOverride,
    clearDictOverride,
    parseEntries,
    renderEntries,
    getUserEntries,
    upsertUserEntry,
    getNextShortcutWeight,
    getActiveSelectedText,
    installTabDragging,
    syncUserHistoryToRime
  });
})(typeof window !== 'undefined' ? window : globalThis);
