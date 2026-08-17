(function (global) {
  'use strict';
  /**
   * chromeinput 全拼输入引擎 (GOAL §三, 全新实现).
   *
   * 索引:
   *   full  = Map<去空格全拼键, [[word, weight], ...]>   完全匹配用
   *   short = Map<首字母简拼键, [[word, weight], ...]>   简拼用 (nh -> 你好)
   *   keys  = 排序后的全拼键数组, 二分定位前缀区间
   *
   * 候选排序: 完全匹配 > (权重 desc > 字数短优先 > 稳定序), 用户历史置顶;
   *           全拼候选之后追加简拼候选 (GOAL §三.1/2/4).
   */

  const MAX_CANDIDATES = 60;      // 单次查询候选上限 (10 页 x 6)
  const MAX_USER_HISTORY = 12;    // 同码历史词条数 (沿用原版上限)

  const state = {
    full: new Map(),
    short: new Map(),
    keys: [],
    ready: false,
    buffer: '',
    displayBuffer: '',
    candidates: [],
    userHistory: {},
    perf: { maxKeyMs: 0, lastKeyMs: 0, keyCount: 0 }
  };

  // ------------------------------------------------------------ 索引构建
  function sortBucket(bucket) {
    // 权重 desc > 字数短优先 > 字典序 (稳定)
    bucket.sort((a, b) => (
      b[1] - a[1] ||
      a[0].length - b[0].length ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    ));
  }

  function buildIndex(entries) {
    const full = new Map();
    const short = new Map();

    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const word = String(entry[0]);
      const pinyin = String(entry[1]);
      const weight = Number(entry[2]) || 0;
      if (!word || !pinyin) continue;

      const syllables = pinyin.split(/\s+/).filter(Boolean);
      const fullKey = syllables.join('');

      let bucket = full.get(fullKey);
      if (!bucket) {
        bucket = [];
        full.set(fullKey, bucket);
      }
      bucket.push([word, weight]);

      if (syllables.length >= 2) {
        const shortKey = syllables.map((syl) => syl[0]).join('');
        let shortBucket = short.get(shortKey);
        if (!shortBucket) {
          shortBucket = [];
          short.set(shortKey, shortBucket);
        }
        shortBucket.push([word, weight]);
      }
    }

    for (const bucket of full.values()) sortBucket(bucket);
    for (const bucket of short.values()) sortBucket(bucket);

    state.full = full;
    state.short = short;
    state.keys = [...full.keys()].sort();
    shortKeys = [...short.keys()].sort();
    state.ready = full.size > 0;
    return full.size;
  }
  // ------------------------------------------------------------ 查询
  function lowerBound(arr, prefix) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function collectPrefix(prefix, out, seen, cap) {
    const keys = state.keys;
    for (let i = lowerBound(keys, prefix); i < keys.length; i++) {
      const key = keys[i];
      if (!key.startsWith(prefix)) break;
      for (const [word, weight] of state.full.get(key)) {
        if (seen.has(word)) continue;
        seen.add(word);
        out.push([word, weight]);
        if (out.length >= cap) return;
      }
    }
  }

  function query(buffer) {
    const result = [];
    const seen = new Set();

    const exact = state.full.get(buffer);
    if (exact) {
      for (const [word, weight] of exact) {
        if (seen.has(word)) continue;
        seen.add(word);
        result.push([word, weight]);
      }
    }

    if (result.length < MAX_CANDIDATES) {
      collectPrefix(buffer, result, seen, MAX_CANDIDATES);
    }

    // 简拼: 键长 >= 2 且与全拼结果互补 (排全拼之后, GOAL §三.2)
    if (buffer.length >= 2) {
      const shortSeen = seen;
      const shortExact = state.short.get(buffer);
      if (shortExact) {
        for (const [word, weight] of shortExact) {
          if (shortSeen.has(word)) continue;
          shortSeen.add(word);
          result.push([word, weight]);
        }
      }
      if (result.length < MAX_CANDIDATES) {
        collectShortPrefix(buffer, result, shortSeen, MAX_CANDIDATES);
      }
    }

    sortBucket(result);
    return result.map((entry) => entry[0]);
  }
  let shortKeys = [];

  function collectShortPrefix(prefix, out, seen, cap) {
    if (prefix.length < 2) return;
    for (let i = lowerBound(shortKeys, prefix); i < shortKeys.length; i++) {
      const key = shortKeys[i];
      if (!key.startsWith(prefix)) break;
      for (const [word, weight] of state.short.get(key)) {
        if (seen.has(word)) continue;
        seen.add(word);
        out.push([word, weight]);
        if (out.length >= cap) return;
      }
    }
  }

  // ------------------------------------------------------------ 用户词频
  function applyUserHistory(list, key) {
    const preferred = state.userHistory[key];
    if (!preferred || !preferred.length || list.length <= 1) return list;
    const historyWords = [];
    const historySet = new Set();
    for (const word of preferred) {
      if (!word || historySet.has(word) || !list.includes(word)) continue;
      historySet.add(word);
      historyWords.push(word);
    }
    if (!historyWords.length) return list;
    return [...historyWords, ...list.filter((word) => !historySet.has(word))];
  }

  function recordUserHistorySelection(code, word, maxEntries = MAX_USER_HISTORY) {
    if (!code || !word) return;
    const existing = Array.isArray(state.userHistory[code]) ? state.userHistory[code] : [];
    state.userHistory[code] = [word, ...existing.filter((item) => item !== word)].slice(0, maxEntries);
  }

  // ------------------------------------------------------------ 会话状态
  function updateCandidates() {
    const started = performance.now();
    state.candidates = applyUserHistory(query(state.buffer), state.buffer);
    state.displayBuffer = state.buffer;
    const elapsed = performance.now() - started;
    state.perf.lastKeyMs = elapsed;
    state.perf.keyCount += 1;
    if (elapsed > state.perf.maxKeyMs) state.perf.maxKeyMs = elapsed;
    if (elapsed > 5) {
      console.warn(`CI: slow key ${state.buffer} ${elapsed.toFixed(1)}ms`);
    }
    return state.candidates;
  }

  function hasAnyMatch(buffer) {
    if (state.full.has(buffer) || state.short.has(buffer)) return true;
    const idx = lowerBound(state.keys, buffer);
    if (idx < state.keys.length && state.keys[idx].startsWith(buffer)) return true;
    if (buffer.length >= 2) {
      const sIdx = lowerBound(shortKeys, buffer);
      if (sIdx < shortKeys.length && shortKeys[sIdx].startsWith(buffer)) return true;
    }
    return false;
  }

  global.CIEngine = {
    state,
    buildIndex,
    query,
    updateCandidates,
    hasAnyMatch,
    applyUserHistory,
    recordUserHistorySelection,
    MAX_CANDIDATES
  };
})(typeof window !== 'undefined' ? window : globalThis);
