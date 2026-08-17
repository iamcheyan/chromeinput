'use strict';
/**
 * chromeinput background (原 background.js 移植, nativeMessaging 已移除).
 * 快捷词: 右键菜单 + Alt+Shift+A -> content script 弹码入 user.json.
 */
const ADD_TO_DICT_MENU_ID = 'ci-add-to-dict';
const ADD_TO_DICT_COMMAND = 'add-selection-to-dict';
const EDITOR_PAGE_URL = chrome.runtime.getURL('editor/index.html');

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: ADD_TO_DICT_MENU_ID,
      title: 'Add to chromeinput Dictionary',
      contexts: ['selection']
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

function sendToTab(tab, message) {
  if (tab && tab.url && tab.url.startsWith(EDITOR_PAGE_URL)) {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        // 编辑器页未就绪时忽略
      }
    });
    return;
  }
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, message, () => {
    if (chrome.runtime.lastError) {
      // 无 content script 的页面忽略
    }
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== ADD_TO_DICT_MENU_ID) return;
  if (!info.selectionText) return;
  sendToTab(tab, {
    type: 'ci_add_selected_to_dict',
    text: info.selectionText
  });
});

chrome.commands && chrome.commands.onCommand.addListener(async (command) => {
  if (command !== ADD_TO_DICT_COMMAND) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  sendToTab(tab, { type: 'ci_add_current_selection_to_fixed_dict' });
});
