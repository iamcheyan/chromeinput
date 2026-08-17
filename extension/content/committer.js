(function (global) {
  'use strict';
  /**
   * chromeinput 上屏模块 (原 content.js commit() 行为照抄).
   * input/textarea 走 value 改写; contenteditable 走 execCommand + Range 兜底.
   */
  const CI = (global.CIContent = global.CIContent || {});

  function commit(text, isSelection = false) {
    const focusedElement = CI.focusedElement;
    if (!focusedElement) return;

    const engine = global.CIEngine;
    if (isSelection && engine.state.buffer.length > 0) {
      engine.recordUserHistorySelection(engine.state.buffer, text);
      const Shared = global.CIShared;
      Shared.set({ [Shared.KEYS.USER_HISTORY]: engine.state.userHistory });
    }

    if (focusedElement.isContentEditable) {
      focusedElement.focus();
      const execOk = document.execCommand && document.execCommand('insertText', false, text);
      if (!execOk) {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        focusedElement.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      }
    } else {
      const start = focusedElement.selectionStart || 0;
      const end = focusedElement.selectionEnd || 0;
      const val = focusedElement.value || '';
      focusedElement.value = val.slice(0, start) + text + val.slice(end);
      focusedElement.selectionStart = focusedElement.selectionEnd = start + text.length;
      focusedElement.dispatchEvent(new Event('input', { bubbles: true }));
      focusedElement.dispatchEvent(new Event('change', { bubbles: true }));
    }

    engine.state.buffer = '';
    CI.visibleCandidateRows = CI.DEFAULT_VISIBLE_CANDIDATE_ROWS;
    CI.ui.hideUI();
  }

  CI.commit = commit;
})(typeof window !== 'undefined' ? window : globalThis);
