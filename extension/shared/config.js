(function (global) {
  'use strict';
  /**
   * chromeinput 词库配置 (对标原 shared/dicts.js)
   *
   * path: 相对扩展根目录; JSON 数组格式 [[word, code, weight], ...]
   * defaultEnabled: IME 默认挂载
   * editorEnabled: 是否出现在 Nova Editor 可编辑列表 (base.json ~1.7MB 单行,
   *                与原仓 base.dict.yaml 同理排除)
   */
  const TABLES = [
    { path: 'dicts/base.json', defaultEnabled: true, editorEnabled: false },
    { path: 'dicts/user.json', defaultEnabled: true, editorEnabled: true, reloadable: true }
  ];
  const DEFAULT_TABLES = TABLES.filter((table) => table.defaultEnabled !== false);

  const DICTS = {
    TABLES,
    DEFAULT_PATHS: DEFAULT_TABLES.map((table) => table.path),
    EDITOR_PATHS: TABLES.filter((table) => table.editorEnabled !== false).map((table) => table.path),
    RELOADABLE_PATHS: TABLES.filter((table) => table.reloadable).map((table) => table.path)
  };

  global.CI_DICTS = DICTS;
})(typeof window !== 'undefined' ? window : globalThis);
