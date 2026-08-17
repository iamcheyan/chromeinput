'use strict';
/**
 * chromeinput popup (重写: 站点管理/词库选择/字号/开关, GOAL §四).
 */
const Shared = window.CIShared;
const KEYS = Shared.KEYS;

const globalEnabledInput = document.getElementById('global-enabled');
const currentUrlEl = document.getElementById('current-url');
const currentStatusEl = document.getElementById('current-status');
const regexInput = document.getElementById('regex-input');
const messageEl = document.getElementById('message');
const rulesListEl = document.getElementById('rules-list');
const openEditorButton = document.getElementById('open-editor');
const openShortcutsButton = document.getElementById('open-shortcuts');
const candidateFontSizeInput = document.getElementById('candidate-font-size');
const candidateFontSizeValueEl = document.getElementById('candidate-font-size-value');
const addDictShortcutEl = document.getElementById('add-dict-shortcut');
const shortcutHintEl = document.getElementById('shortcut-hint');
const dictListEl = document.getElementById('dict-list');
const reloadDictsButton = document.getElementById('reload-dicts');
const syncToRimeButton = document.getElementById('sync-to-rime');

const DICT_TABLES = window.CI_DICTS.TABLES;
const DEFAULT_DICT_PATHS = window.CI_DICTS.DEFAULT_PATHS;
const ADD_TO_DICT_COMMAND = 'add-selection-to-dict';

let currentTabUrl = '';
let currentTabId = null;
let siteRules = [];
let candidateFontSize = 13;
let dictPaths = [];

function escapeRegexLiteral(text) {
  return `${text || ''}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSiteRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => ({
      pattern: `${rule && rule.pattern || ''}`.trim(),
      enabled: rule ? rule.enabled !== false : true
    }))
    .filter((rule) => rule.pattern);
}

function getMatchedSiteRule(url) {
  let matched = null;
  for (const rule of siteRules) {
    try {
      if (new RegExp(rule.pattern).test(url)) matched = rule;
    } catch (e) {
      // 非法正则忽略
    }
  }
  return matched;
}

function setMessage(text) {
  messageEl.textContent = text || '';
}

function clampCandidateFontSize(value) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed)) return 13;
  return Math.min(28, Math.max(12, parsed));
}

function describeDict(path) {
  const table = DICT_TABLES.find((item) => item.path === path);
  if (!table) return path;
  if (path.endsWith('base.json')) return 'base.json - 朙月拼音+essay 基础词库 (~112k 条)';
  if (path.endsWith('user.json')) return 'user.json - 用户词/快捷词 (可编辑)';
  return path;
}

function renderDictOptions() {
  dictListEl.textContent = '';
  const selected = new Set(dictPaths);
  for (const table of DICT_TABLES) {
    const row = document.createElement('label');
    row.className = 'dict-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(table.path);
    checkbox.dataset.path = table.path;

    const label = document.createElement('span');
    label.textContent = describeDict(table.path);

    row.appendChild(checkbox);
    row.appendChild(label);
    dictListEl.appendChild(row);
  }
}

function setActionButtonState(button, state, text) {
  button.dataset.state = state;
  if (typeof text === 'string') button.textContent = text;
}

async function broadcastDictionaryReload() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'ci_reload_effective_dict' }))
  );
}

function renderCandidateFontSize() {
  candidateFontSizeInput.value = String(candidateFontSize);
  candidateFontSizeValueEl.textContent = `${candidateFontSize}px`;
}

async function readCommands() {
  if (!chrome.commands || !chrome.commands.getAll) return [];
  try {
    return await chrome.commands.getAll();
  } catch (e) {
    return [];
  }
}

async function readCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab && tab.url ? tab.url : '';
  currentTabId = tab && Number.isInteger(tab.id) ? tab.id : null;
}

async function readStorage() {
  const result = await Shared.get([
    KEYS.ENABLED,
    KEYS.FONT_SIZE,
    KEYS.SITE_RULES,
    KEYS.DICT_PATHS
  ]);
  globalEnabledInput.checked = result[KEYS.ENABLED] !== false;
  candidateFontSize = clampCandidateFontSize(result[KEYS.FONT_SIZE] || 13);
  siteRules = normalizeSiteRules(result[KEYS.SITE_RULES]);
  const rawPaths = result[KEYS.DICT_PATHS];
  dictPaths = Array.isArray(rawPaths) && rawPaths.length ? rawPaths : [...DEFAULT_DICT_PATHS];
}

function renderStatus() {
  currentUrlEl.textContent = currentTabUrl || '(unknown)';
  let status = 'default enabled';
  if (currentTabUrl.startsWith(chrome.runtime.getURL(''))) {
    status = 'extension page - IME managed by page';
  } else {
    const matched = getMatchedSiteRule(currentTabUrl);
    if (matched) {
      status = `${matched.enabled ? 'Enabled' : 'Disabled'} / ${matched.pattern}`;
    }
  }
  currentStatusEl.textContent = `Current rule: ${status}`;
}

function renderRules() {
  rulesListEl.textContent = '';
  if (!siteRules.length) {
    const empty = document.createElement('div');
    empty.className = 'status-text';
    empty.textContent = 'No saved rules.';
    rulesListEl.appendChild(empty);
    return;
  }
  siteRules.forEach((rule, index) => {
    const row = document.createElement('div');
    row.className = 'rule-row';

    const text = document.createElement('div');
    text.className = 'rule-text';
    text.textContent = `${rule.enabled ? 'ALLOW' : 'BLOCK'}  ${rule.pattern}`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove rule';
    remove.addEventListener('click', async () => {
      siteRules = siteRules.filter((_, i) => i !== index);
      await Shared.set({ [KEYS.SITE_RULES]: siteRules });
      renderRules();
      renderStatus();
    });

    row.appendChild(text);
    row.appendChild(remove);
    rulesListEl.appendChild(row);
  });
}

async function saveRule(pattern, enabled) {
  const trimmed = `${pattern || ''}`.trim();
  if (!trimmed) {
    setMessage('Regex is empty.');
    return;
  }
  try {
    new RegExp(trimmed);
  } catch (e) {
    setMessage('Invalid regex.');
    return;
  }
  siteRules = [...siteRules, { pattern: trimmed, enabled }];
  await Shared.set({ [KEYS.SITE_RULES]: siteRules });
  setMessage('Rule saved.');
  renderRules();
  renderStatus();
}

document.getElementById('enable-here').addEventListener('click', async () => {
  if (!currentTabUrl) return;
  await saveRule(`^${escapeRegexLiteral(new URL(currentTabUrl).origin)}`, true);
});

document.getElementById('disable-here').addEventListener('click', async () => {
  if (!currentTabUrl) return;
  await saveRule(`^${escapeRegexLiteral(new URL(currentTabUrl).origin)}`, false);
});

document.getElementById('save-enabled').addEventListener('click', async () => {
  await saveRule(regexInput.value, true);
});

document.getElementById('save-disabled').addEventListener('click', async () => {
  await saveRule(regexInput.value, false);
});

globalEnabledInput.addEventListener('change', async () => {
  await Shared.set({ [KEYS.ENABLED]: globalEnabledInput.checked });
});

candidateFontSizeInput.addEventListener('input', async () => {
  candidateFontSize = clampCandidateFontSize(candidateFontSizeInput.value);
  renderCandidateFontSize();
  await Shared.set({ [KEYS.FONT_SIZE]: candidateFontSize });
});

dictListEl.addEventListener('change', async () => {
  const selected = [];
  dictListEl.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    if (checkbox.checked) selected.push(checkbox.dataset.path);
  });
  dictPaths = selected.length ? selected : [...DEFAULT_DICT_PATHS];
  renderDictOptions();
  await Shared.set({ [KEYS.DICT_PATHS]: dictPaths });
  setMessage('Dictionary selection saved.');
});

reloadDictsButton.addEventListener('click', async () => {
  setActionButtonState(reloadDictsButton, 'busy', 'Reloading...');
  try {
    await Shared.set({ [KEYS.DICT_CACHE]: null });
    await broadcastDictionaryReload();
    setMessage('Dictionaries reloaded.');
  } catch (error) {
    setMessage(error.message || String(error));
  } finally {
    setActionButtonState(reloadDictsButton, '', 'Reload Dictionaries');
  }
});

syncToRimeButton.addEventListener('click', async () => {
  const result = await Shared.syncUserHistoryToRime();
  setMessage(result.ok ? 'Synced to Rime.' : result.error);
});

openEditorButton.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('editor/index.html') });
});

openShortcutsButton.addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

async function init() {
  await Promise.all([readCurrentTab(), readStorage()]);
  renderCandidateFontSize();

  const commands = await readCommands();
  const command = commands.find((item) => item.name === ADD_TO_DICT_COMMAND);
  addDictShortcutEl.textContent = (command && command.shortcut) || 'Not set';
  shortcutHintEl.textContent = 'Use it with text selected to add a shortcut word.';

  renderStatus();
  renderRules();
  renderDictOptions();
}

init().catch((error) => {
  setMessage(error.message || String(error));
});
