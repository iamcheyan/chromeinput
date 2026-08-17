(function (global) {
  'use strict';
  /**
   * chromeinput 词库加载 + 索引构建 (原 sbzr-core fetchPackaged* / content.js loadDict 移植).
   *
   * 数据流: 打包 JSON (或 storage override) -> 合并条目 -> CIEngine.buildIndex
   * 冷启动打点 console.time('CI:cold-start'); 条目缓存 chrome.storage.local,
   * 二次打开跳过 fetch+parse (GOAL §二.4).
   */

  const DICTS = () => global.CI_DICTS;

  function normalizePaths(paths) {
    const available = new Set(DICTS().DEFAULT_PATHS);
    const source = Array.isArray(paths) ? paths : DICTS().DEFAULT_PATHS;
    const normalized = source.filter((path, index) => (
      typeof path === 'string' && available.has(path) && source.indexOf(path) === index
    ));
    return normalized.length > 0 ? normalized : [...DICTS().DEFAULT_PATHS];
  }

  async function getStoredDictPaths() {
    const Shared = global.CIShared;
    const result = await Shared.get(Shared.KEYS.DICT_PATHS);
    const raw = result[Shared.KEYS.DICT_PATHS];
    const normalized = normalizePaths(raw);
    if (JSON.stringify(normalized) !== JSON.stringify(raw || null)) {
      await Shared.set({ [Shared.KEYS.DICT_PATHS]: normalized });
    }
    return normalized;
  }

  function mergeEntries(entryLists) {
    // 同 (word, code) 保留最大权重; 保留首次出现顺序 (先到词库优先).
    const merged = new Map();
    for (const entries of entryLists) {
      for (const [word, code, weight] of entries) {
        if (!word || !code) continue;
        const key = `${word}\u0000${code}`;
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, [word, code, weight || 0]);
        } else if ((weight || 0) > existing[2]) {
          existing[2] = weight || 0;
        }
      }
    }
    return [...merged.values()];
  }

  async function fetchEntries(paths) {
    const Shared = global.CIShared;
    const lists = [];
    for (const path of paths) {
      const text = await Shared.readDictResource(path);
      const entries = Shared.parseEntries(text);
      if (entries) lists.push(entries);
    }
    return mergeEntries(lists);
  }

  function cacheSignature(paths, overrides) {
    const overrideKeys = Object.keys(overrides || {})
      .filter((path) => paths.includes(path))
      .map((path) => `${path}:${(overrides[path] || '').length}`)
      .sort();
    return JSON.stringify([paths, overrideKeys]);
  }

  async function loadEntries(paths) {
    const Shared = global.CIShared;

    let cached = null;
    try {
      const result = await Shared.get(Shared.KEYS.DICT_CACHE);
      cached = result[Shared.KEYS.DICT_CACHE] || null;
    } catch (e) {
      cached = null;
    }

    const overrides = await Shared.getDictOverrides();
    const signature = cacheSignature(paths, overrides);
    if (cached && cached.signature === signature && Array.isArray(cached.entries)) {
      console.info('CI: dict cache hit', cached.entries.length, 'entries');
      return cached.entries;
    }

    const entries = await fetchEntries(paths);

    // 异步写缓存, 不阻塞首键; 失败(超限/上下文失效)静默降级为每次 fetch
    Promise.resolve(Shared.set({ [Shared.KEYS.DICT_CACHE]: { signature, entries } }))
      .catch(() => {});

    return entries;
  }

  /**
   * 加载生效词库并重建引擎索引. 返回条目数.
   */
  async function loadEffectiveDict() {
    const paths = await getStoredDictPaths();
    console.time('CI:cold-start');
    const entries = await loadEntries(paths);
    const engine = global.CIEngine;
    if (!engine) {
      console.timeEnd('CI:cold-start');
      throw new Error('CIEngine not loaded');
    }
    engine.buildIndex(entries);
    console.timeEnd('CI:cold-start');
    console.log(`CI: dictionary ready (${paths.length} tables, ${entries.length} entries)`);
    return entries.length;
  }

  async function reloadEffectiveDict() {
    const Shared = global.CIShared;
    // overrides 变更后作废缓存
    try {
      await Shared.set({ [Shared.KEYS.DICT_CACHE]: null });
    } catch (e) { /* ignore */ }
    return await loadEffectiveDict();
  }

  global.CIDictLoad = {
    normalizePaths,
    getStoredDictPaths,
    loadEffectiveDict,
    reloadEffectiveDict,
    mergeEntries
  };
})(typeof window !== 'undefined' ? window : globalThis);
