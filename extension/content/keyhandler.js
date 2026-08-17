(function (global) {
  'use strict';
  /**
   * chromeinput 按键拦截 (原 content.js handleDocumentKeyDown/KeyUp 照抄,
   * 双拼 3/4 码顶功规则不适用于全拼, 已移除 -- 见 docs/REFACTOR_NOTES.md).
   */
  const CI = (global.CIContent || {});

  let shiftPressedOnly = false;
  let managedTarget = null;
  let suppressionCheck = null;

  function isInput(el) {
    if (!el) return false;
    if (managedTarget) return el === managedTarget;
    if (CI.ui && CI.ui.notepadTextarea && el === CI.ui.notepadTextarea) return true;
    const isStandard = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    const isRoleTextbox = el.getAttribute && el.getAttribute('role') === 'textbox';
    const isAriaEditable = el.getAttribute &&
      (el.getAttribute('aria-multiline') === 'true' || el.classList.contains('docs-textextras-normal'));
    return isStandard || isRoleTextbox || isAriaEditable;
  }

  function resolveActiveElement(e) {
    if (managedTarget) {
      const path = typeof (e && e.composedPath) === 'function' ? e.composedPath() : [];
      if (path.includes(managedTarget)) return managedTarget;
      if (document.activeElement === managedTarget) return managedTarget;
    }

    let activeEl = document.activeElement;
    if (activeEl && activeEl.shadowRoot && activeEl.shadowRoot.activeElement) {
      activeEl = activeEl.shadowRoot.activeElement;
    }

    const path = typeof (e && e.composedPath) === 'function' ? e.composedPath() : [];
    for (const node of path) {
      if (node instanceof HTMLElement && isInput(node)) {
        return node;
      }
    }

    if (CI.ui && CI.ui.notepadTextarea) {
      if (CI.ui.notepadHasFocus) return CI.ui.notepadTextarea;
      if (path.includes(CI.ui.notepadTextarea)) return CI.ui.notepadTextarea;
    }

    return activeEl;
  }

  function isManagedTargetFocused() {
    if (!managedTarget) return false;
    return document.activeElement === managedTarget;
  }

  function isImeSuppressed() {
    return !!(suppressionCheck && suppressionCheck());
  }

  function startBuffer(newBuffer) {
    const engine = global.CIEngine;
    engine.state.buffer = newBuffer;
    CI.pageIndex = 0;
    CI.selectedCandidateIndex = 0;
    CI.visibleCandidateRows = CI.DEFAULT_VISIBLE_CANDIDATE_ROWS;
    engine.updateCandidates();
    CI.ui.renderUI();
    if (newBuffer.length > 0) {
      CI.ui.showUI();
    } else {
      CI.ui.hideUI();
    }
  }

  function handleDocumentKeyDown(e) {
    const engine = global.CIEngine;
    const activeEl = resolveActiveElement(e);

    if (CI.runtimeMode === 'page' && e.key === 'f' && e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      CI.ui.toggleNotepad();
      if (CI.ui.notepadVisible) {
        CI.enableIme();
        void CI.ensurePageImeReady();
      }
      return;
    }

    // Shift 单击切换中英 (keyup 判定)
    if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      return;
    }

    if (!isInput(activeEl)) {
      if (CI.uiVisible) {
        engine.state.buffer = '';
        CI.ui.hideUI();
      }
      return;
    }
    CI.focusedElement = activeEl;

    if (!CI.isImeActive() || isImeSuppressed()) return;

    if (!engine.state.ready) {
      void CI.ensurePageImeReady();
      return;
    }

    const key = e.key;
    const lowerKey = key.toLowerCase();

    // Ctrl/Alt/Meta 组合键直通
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const mappedDirectChar = CI.ui.mapDirectInputChar(key);
    if (mappedDirectChar) {
      if (CI.uiVisible && engine.state.buffer) {
        if (engine.state.candidates.length > 0) {
          CI.ui.selectCandidate(CI.selectedCandidateIndex);
        } else {
          CI.commit(engine.state.buffer, false);
        }
      }
      CI.commit(mappedDirectChar, false);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.shiftKey && /^[A-Z]$/.test(key)) {
      CI.commit(key, false);
      e.preventDefault();
      e.stopPropagation();
    } else if (/^[a-z]$/.test(lowerKey)) {
      startBuffer(engine.state.buffer + lowerKey);
      e.preventDefault();
      e.stopPropagation();
    } else if (/^[1-6]$/.test(key)) {
      if (CI.uiVisible) {
        const relIndex = parseInt(key, 10) - 1;
        const absIndex = CI.ui.getCurrentRowStartIndex() + relIndex;
        if (engine.state.candidates.length > absIndex) {
          CI.ui.selectCandidateByAbsoluteIndex(absIndex);
          e.preventDefault();
          e.stopPropagation();
        }
      }
    } else if (key === ' ') {
      if (CI.uiVisible) {
        if (engine.state.candidates.length > 0) {
          CI.ui.selectCandidate(CI.selectedCandidateIndex);
        } else {
          CI.commit(engine.state.buffer, false);
        }
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (key === 'Backspace') {
      if (CI.uiVisible) {
        engine.state.buffer = engine.state.buffer.slice(0, -1);
        if (engine.state.buffer === '') {
          CI.ui.hideUI();
        } else {
          CI.pageIndex = 0;
          engine.updateCandidates();
          CI.ui.renderUI();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (key === 'Escape') {
      if (CI.uiVisible) {
        CI.ui.hideUI();
        engine.state.buffer = '';
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (key === 'ArrowRight') {
      if (CI.uiVisible) {
        const nextAbsIndex = CI.ui.getCurrentAbsoluteSelectedIndex() + 1;
        if (nextAbsIndex < engine.state.candidates.length) {
          CI.ui.setSelectionByAbsoluteIndex(nextAbsIndex);
          CI.ui.renderUI();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (key === 'ArrowLeft') {
      if (CI.uiVisible) {
        const nextAbsIndex = CI.ui.getCurrentAbsoluteSelectedIndex() - 1;
        if (nextAbsIndex >= 0) {
          CI.ui.setSelectionByAbsoluteIndex(nextAbsIndex);
          CI.ui.renderUI();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (['ArrowDown', ']', '=', '.', '>'].includes(key)) {
      if (CI.uiVisible) {
        e.preventDefault();
        e.stopPropagation();
        if (key === 'ArrowDown') {
          if (CI.visibleCandidateRows === CI.DEFAULT_VISIBLE_CANDIDATE_ROWS &&
              engine.state.candidates.length > CI.PAGE_SIZE) {
            CI.ui.expandCandidateRows();
            CI.ui.renderUI();
          } else {
            const nextAbsIndex = CI.ui.getCurrentAbsoluteSelectedIndex() + CI.PAGE_SIZE;
            if (nextAbsIndex < engine.state.candidates.length) {
              CI.ui.setSelectionByAbsoluteIndex(nextAbsIndex);
              CI.ui.renderUI();
            }
          }
        } else if ((CI.pageIndex + 1) * CI.PAGE_SIZE < engine.state.candidates.length) {
          CI.pageIndex++;
          CI.selectedCandidateIndex = Math.min(
            CI.selectedCandidateIndex,
            CI.PAGE_SIZE * CI.visibleCandidateRows - 1
          );
          CI.ui.renderUI();
        }
      }
    } else if (['ArrowUp', '[', '-', ',', '<'].includes(key)) {
      if (CI.uiVisible) {
        e.preventDefault();
        e.stopPropagation();
        if (key === 'ArrowUp') {
          const nextAbsIndex = CI.ui.getCurrentAbsoluteSelectedIndex() - CI.PAGE_SIZE;
          if (CI.visibleCandidateRows > CI.DEFAULT_VISIBLE_CANDIDATE_ROWS && nextAbsIndex >= 0) {
            CI.ui.setSelectionByAbsoluteIndex(nextAbsIndex);
            CI.ui.renderUI();
          } else if (CI.visibleCandidateRows > CI.DEFAULT_VISIBLE_CANDIDATE_ROWS) {
            CI.ui.collapseCandidateRows();
            CI.ui.renderUI();
          }
        } else if (CI.pageIndex > 0) {
          CI.pageIndex--;
          CI.selectedCandidateIndex = Math.min(
            CI.selectedCandidateIndex,
            CI.PAGE_SIZE * CI.visibleCandidateRows - 1
          );
          CI.ui.renderUI();
        }
      }
    } else if (key === 'PageDown') {
      if (CI.uiVisible) {
        const maxPage = Math.floor((engine.state.candidates.length - 1) / CI.PAGE_SIZE);
        if (CI.pageIndex < maxPage) {
          CI.pageIndex = Math.min(maxPage, CI.pageIndex + 3);
          CI.ui.renderUI();
          e.preventDefault();
          e.stopPropagation();
        }
      }
    } else if (key === 'PageUp') {
      if (CI.uiVisible) {
        if (CI.pageIndex > 0) {
          CI.pageIndex = Math.max(0, CI.pageIndex - 3);
          CI.ui.renderUI();
          e.preventDefault();
          e.stopPropagation();
        }
      }
    } else if (key === 'Enter') {
      if (CI.uiVisible) {
        CI.commit(engine.state.buffer, false);
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (key === 'Tab') {
      if (CI.uiVisible) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          const nextAbsIndex = CI.ui.getCurrentAbsoluteSelectedIndex() - 1;
          if (nextAbsIndex >= 0) CI.ui.setSelectionByAbsoluteIndex(nextAbsIndex);
        } else {
          const nextAbsIndex = CI.ui.getCurrentAbsoluteSelectedIndex() + 1;
          if (nextAbsIndex < engine.state.candidates.length) {
            CI.ui.setSelectionByAbsoluteIndex(nextAbsIndex);
          }
        }
        CI.ui.renderUI();
      }
    }
  }

  function handleDocumentKeyUp(e) {
    if (managedTarget && !isManagedTargetFocused()) {
      shiftPressedOnly = false;
      return;
    }
    if (e.key === 'Shift') {
      if (shiftPressedOnly) {
        CI.toggleMode();
      }
      shiftPressedOnly = false;
    }
  }

  function handleShiftTrackingKeyDown(e) {
    if (managedTarget && !isManagedTargetFocused()) {
      shiftPressedOnly = false;
      return;
    }
    if (e.key === 'Shift') {
      shiftPressedOnly = true;
    } else {
      shiftPressedOnly = false;
    }
  }

  CI.keys = {
    handleDocumentKeyDown,
    handleDocumentKeyUp,
    handleShiftTrackingKeyDown,
    isInput,
    resolveActiveElement,
    setManagedTarget(target) { managedTarget = target; },
    setSuppressionCheck(fn) { suppressionCheck = fn; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
