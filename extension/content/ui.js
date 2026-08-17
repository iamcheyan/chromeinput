(function (global) {
  'use strict';
  /**
   * chromeinput 候选条 UI (原 content.js renderUI/positionUI/drag/toast/notepad 移植).
   * Shadow DOM 隔离; 样式 content/style.css (#ci-ime-root).
   */
  const CI = (global.CIContent = global.CIContent || {});
  const PAGE_SIZE = 6;
  const DEFAULT_ROWS = 1;
  const EXPANDED_ROWS = 3;
  const labels = ['1', '2', '3', '4', '5', '6'];

  CI.PAGE_SIZE = PAGE_SIZE;
  CI.DEFAULT_VISIBLE_CANDIDATE_ROWS = DEFAULT_ROWS;
  CI.EXPANDED_VISIBLE_CANDIDATE_ROWS = EXPANDED_ROWS;
  CI.pageIndex = 0;
  CI.selectedCandidateIndex = 0;
  CI.visibleCandidateRows = DEFAULT_ROWS;
  CI.uiVisible = false;
  CI.fontSize = 13;
  CI.manualPosition = null;
  CI.punctuationMode = 'cn';
  CI.widthMode = 'half';
  let draggingUI = false;
  let dragOffset = { x: 0, y: 0 };
  let modeToastTimer = null;
  let notepadVisible = false;
  let notepadTextarea = null;
  let notepadHasFocus = false;
  let notepadCard = null;
  let notepadPos = null;
  let notepadDragging = false;
  let notepadDragOffset = { x: 0, y: 0 };
  let uiRoot = null;
  let modeToast = null;

  const CN_PUNCTUATION_MAP = {
    ',': '，',
    '.': '。',
    '?': '？',
    '!': '！',
    ':': '：',
    ';': '；',
    '(': '（',
    ')': '）',
    '[': '【',
    ']': '】',
    '<': '《',
    '>': '》',
    '"': '“',
    "'": '‘',
    '\\': '、'
  };

  function attachShadowStyles(shadowRoot) {
    if (!chrome.runtime || !chrome.runtime.id) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content/style.css');
    shadowRoot.appendChild(link);
  }

  function injectUI() {
    if (!document.body) {
      setTimeout(injectUI, 100);
      return;
    }
    if (window.innerWidth < 100 || window.innerHeight < 100) return;
    if (document.getElementById('ci-ime-container')) return;

    const uiContainer = document.createElement('div');
    uiContainer.id = 'ci-ime-container';
    const shadow = uiContainer.attachShadow({ mode: 'open' });
    attachShadowStyles(shadow);
    uiRoot = document.createElement('div');
    uiRoot.id = 'ci-ime-root';
    shadow.appendChild(uiRoot);
    modeToast = document.createElement('div');
    modeToast.id = 'ci-mode-toast';
    shadow.appendChild(modeToast);
    document.body.appendChild(uiContainer);
    updateUIMode();
  }

  function isPrintableAsciiKey(key) {
    return typeof key === 'string' && key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) <= 0x7e;
  }

  function toFullWidthChar(char) {
    if (char === ' ') return '\u3000';
    const code = char.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return char;
    return String.fromCharCode(code + 0xfee0);
  }

  function mapDirectInputChar(key) {
    if (!isPrintableAsciiKey(key)) return '';
    if (/^[a-z]$/.test(key)) return '';
    if (CI.punctuationMode === 'cn' && CN_PUNCTUATION_MAP[key]) {
      return CN_PUNCTUATION_MAP[key];
    }
    if (CI.widthMode === 'full') {
      return toFullWidthChar(key);
    }
    return '';
  }

  function togglePunctuationMode() {
    CI.punctuationMode = CI.punctuationMode === 'cn' ? 'en' : 'cn';
    try {
      if (chrome.runtime && chrome.runtime.id) {
        const Shared = global.CIShared;
        chrome.storage.local.set({ [Shared.KEYS.PUNCTUATION_MODE]: CI.punctuationMode });
      }
    } catch (e) {
      console.log('CI: Punctuation mode save failed (context invalidated).');
    }
    if (CI.uiVisible) renderUI();
  }

  function toggleWidthMode() {
    CI.widthMode = CI.widthMode === 'full' ? 'half' : 'full';
    try {
      if (chrome.runtime && chrome.runtime.id) {
        const Shared = global.CIShared;
        chrome.storage.local.set({ [Shared.KEYS.WIDTH_MODE]: CI.widthMode });
      }
    } catch (e) {
      console.log('CI: Width mode save failed (context invalidated).');
    }
    if (CI.uiVisible) renderUI();
  }

  function showToast(text) {
    if (!modeToast) return;
    if (modeToastTimer) clearTimeout(modeToastTimer);
    modeToast.textContent = text;
    modeToast.style.display = 'block';
    modeToast.style.opacity = '1';
    modeToastTimer = setTimeout(() => {
      modeToast.style.opacity = '0';
      setTimeout(() => { modeToast.style.display = 'none'; }, 300);
    }, 1000);
  }

  function createImeButton(content, title, onClick, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ime-btn${className ? ` ${className}` : ''}`;
    if (title) {
      button.title = title;
      button.setAttribute('aria-label', title);
    }
    if (typeof content === 'string') {
      button.textContent = content;
    } else if (content instanceof Node) {
      button.appendChild(content);
    }
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void onClick(e);
    });
    return button;
  }

  function openExtensionEditor() {
    if (!chrome.runtime || !chrome.runtime.id) return;
    window.open(chrome.runtime.getURL('editor/index.html'), '_blank', 'noopener,noreferrer');
  }

  // ------------------------------------------------------------ 翻页/选区
  function getVisibleCandidateCount() {
    return PAGE_SIZE * CI.visibleCandidateRows;
  }

  function getVisibleStartIndex() {
    return CI.pageIndex * PAGE_SIZE;
  }

  function getCurrentAbsoluteSelectedIndex() {
    return getVisibleStartIndex() + CI.selectedCandidateIndex;
  }

  function getCurrentRowStartIndex() {
    return getVisibleStartIndex() + (Math.floor(CI.selectedCandidateIndex / PAGE_SIZE) * PAGE_SIZE);
  }

  function setSelectionByAbsoluteIndex(absIndex) {
    const candidates = global.CIEngine.state.candidates;
    if (candidates.length === 0) {
      CI.pageIndex = 0;
      CI.selectedCandidateIndex = 0;
      return;
    }
    const clamped = Math.max(0, Math.min(absIndex, candidates.length - 1));
    const visibleCount = getVisibleCandidateCount();
    let startIndex = getVisibleStartIndex();
    if (clamped < startIndex) {
      startIndex = Math.floor(clamped / PAGE_SIZE) * PAGE_SIZE;
    } else if (clamped >= startIndex + visibleCount) {
      startIndex = (Math.floor(clamped / PAGE_SIZE) - CI.visibleCandidateRows + 1) * PAGE_SIZE;
    }
    startIndex = Math.max(0, startIndex);
    CI.pageIndex = Math.floor(startIndex / PAGE_SIZE);
    CI.selectedCandidateIndex = clamped - startIndex;
  }

  function expandCandidateRows() {
    if (CI.visibleCandidateRows === EXPANDED_ROWS) return;
    CI.visibleCandidateRows = EXPANDED_ROWS;
    setSelectionByAbsoluteIndex(getCurrentAbsoluteSelectedIndex());
  }

  function collapseCandidateRows() {
    if (CI.visibleCandidateRows === DEFAULT_ROWS) return;
    const currentAbsIndex = getCurrentAbsoluteSelectedIndex();
    CI.visibleCandidateRows = DEFAULT_ROWS;
    setSelectionByAbsoluteIndex(currentAbsIndex);
  }

  function selectCandidate(relIndex) {
    const candidates = global.CIEngine.state.candidates;
    const absIndex = getVisibleStartIndex() + relIndex;
    if (candidates[absIndex]) {
      CI.commit(candidates[absIndex], true);
    }
  }

  function selectCandidateByAbsoluteIndex(absIndex) {
    const candidates = global.CIEngine.state.candidates;
    if (candidates[absIndex]) {
      CI.commit(candidates[absIndex], true);
    }
  }

  // ------------------------------------------------------------ 定位/拖拽
  function showUI() {
    CI.uiVisible = true;
    if (uiRoot) uiRoot.style.display = 'flex';
    positionUI();
  }

  function hideUI() {
    CI.uiVisible = false;
    CI.visibleCandidateRows = DEFAULT_ROWS;
    if (uiRoot) uiRoot.style.display = 'none';
  }

  function positionUI() {
    if (!uiRoot) return;
    const focusedElement = CI.focusedElement;
    if (!focusedElement) {
      uiRoot.style.left = '16px';
      uiRoot.style.top = '16px';
      return;
    }
    if (draggingUI) return;
    if (applyManualPosition()) return;
    const rect = focusedElement.getBoundingClientRect();
    let top = rect.bottom + 10;
    let left = rect.left;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left + 320 > vw) left = vw - 340;
    if (top + 200 > vh) top = rect.top - 180;
    uiRoot.style.left = `${Math.max(10, left)}px`;
    uiRoot.style.top = `${Math.max(10, top)}px`;
  }

  function applyManualPosition() {
    if (!CI.manualPosition || !uiRoot) return false;
    const rect = uiRoot.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxLeft = Math.max(10, vw - rect.width - 10);
    const maxTop = Math.max(10, vh - rect.height - 10);
    const left = Math.min(Math.max(10, CI.manualPosition.left), maxLeft);
    const top = Math.min(Math.max(10, CI.manualPosition.top), maxTop);
    uiRoot.style.left = `${left}px`;
    uiRoot.style.top = `${top}px`;
    return true;
  }

  function saveManualPosition() {
    if (!CI.manualPosition) return;
    try {
      if (chrome.runtime && chrome.runtime.id) {
        const Shared = global.CIShared;
        chrome.storage.local.set({ [Shared.KEYS.UI_POS]: CI.manualPosition });
      }
    } catch (e) {
      console.log('CI: Manual position save failed (context invalidated).');
    }
  }

  function startDrag(e) {
    if (e.button !== 0 || !uiRoot) return;
    draggingUI = true;
    const rect = uiRoot.getBoundingClientRect();
    dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    CI.manualPosition = { left: rect.left, top: rect.top };
    uiRoot.classList.add('dragging');
    e.preventDefault();
    e.stopPropagation();
  }

  function onDragMove(e) {
    if (!draggingUI) return;
    CI.manualPosition = { left: e.clientX - dragOffset.x, top: e.clientY - dragOffset.y };
    applyManualPosition();
    e.preventDefault();
  }

  function endDrag() {
    if (!draggingUI) return;
    draggingUI = false;
    if (uiRoot) uiRoot.classList.remove('dragging');
    saveManualPosition();
  }

  function updateUIMode() {
    if (!uiRoot) return;
    uiRoot.style.fontSize = `${CI.fontSize}px`;
    uiRoot.style.transform = '';
    uiRoot.style.transformOrigin = '';
  }

  // ------------------------------------------------------------ 渲染
  function renderUI() {
    if (!uiRoot) return;
    const engine = global.CIEngine;
    const candidates = engine.state.candidates;
    const buffer = engine.state.buffer;
    const displayBuffer = engine.state.displayBuffer;
    uiRoot.textContent = '';

    const header = document.createElement('div');
    header.className = 'ime-header';
    header.addEventListener('mousedown', startDrag);
    const hint = document.createElement('div');
    hint.className = 'ime-hint';
    hint.textContent = displayBuffer || buffer;
    header.appendChild(hint);

    const headerActions = document.createElement('div');
    headerActions.className = 'ime-header-actions';

    const punctuationButton = createImeButton(
      CI.punctuationMode === 'cn' ? '，。' : ',.',
      CI.punctuationMode === 'cn' ? 'Chinese punctuation' : 'English punctuation',
      async () => { togglePunctuationMode(); }
    );
    if (CI.punctuationMode === 'cn') punctuationButton.classList.add('is-active');
    headerActions.appendChild(punctuationButton);

    const widthButton = createImeButton(
      CI.widthMode === 'full' ? 'Full' : 'Half',
      CI.widthMode === 'full' ? 'Full width' : 'Half width',
      async () => { toggleWidthMode(); }
    );
    if (CI.widthMode === 'full') widthButton.classList.add('is-active');
    headerActions.appendChild(widthButton);

    header.appendChild(headerActions);
    uiRoot.appendChild(header);

    const listDiv = document.createElement('div');
    listDiv.className = 'candidate-list';
    if (CI.visibleCandidateRows > DEFAULT_ROWS) {
      listDiv.classList.add('expanded');
    }

    const visibleStartIndex = getVisibleStartIndex();
    const batch = candidates.slice(visibleStartIndex, visibleStartIndex + getVisibleCandidateCount());
    const activeRowIndex = Math.floor(CI.selectedCandidateIndex / PAGE_SIZE);

    if (batch.length === 0 && buffer.length > 0) {
      const dot = document.createElement('div');
      dot.textContent = '...';
      dot.style.color = '#7a7a7a';
      listDiv.appendChild(dot);
    } else {
      batch.forEach((c, i) => {
        const cDiv = document.createElement('div');
        cDiv.className = `candidate ${i === CI.selectedCandidateIndex ? 'active' : ''}`;
        const lSpan = document.createElement('span');
        lSpan.className = 'candidate-label';
        const candidateRowIndex = Math.floor(i / PAGE_SIZE);
        const showRowLabels = CI.visibleCandidateRows === DEFAULT_ROWS || candidateRowIndex === activeRowIndex;
        lSpan.textContent = showRowLabels ? (labels[i % PAGE_SIZE] || '') : '';
        if (!showRowLabels) lSpan.classList.add('is-hidden');
        cDiv.appendChild(lSpan);

        const tSpan = document.createElement('span');
        tSpan.className = 'candidate-text';
        tSpan.textContent = c;
        cDiv.appendChild(tSpan);

        cDiv.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectCandidate(i);
        });
        listDiv.appendChild(cDiv);
      });
    }
    uiRoot.appendChild(listDiv);

    positionUI();
  }

  // ------------------------------------------------------------ 记事本 (Alt+F)
  function fallbackCopyNotepad() {
    if (!notepadTextarea) return;
    const prevStart = notepadTextarea.selectionStart;
    const prevEnd = notepadTextarea.selectionEnd;
    const prevScroll = notepadTextarea.scrollTop;
    notepadTextarea.focus();
    notepadTextarea.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      // Ignore if copy fails.
    }
    notepadTextarea.setSelectionRange(prevStart, prevEnd);
    notepadTextarea.scrollTop = prevScroll;
  }

  async function copyNotepadText() {
    if (!notepadTextarea) return;
    const text = notepadTextarea.value || '';
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      fallbackCopyNotepad();
    }
  }

  function injectNotepad() {
    if (!document.body) {
      setTimeout(injectNotepad, 100);
      return;
    }
    if (document.getElementById('ci-notepad-container')) return;

    const container = document.createElement('div');
    container.id = 'ci-notepad-container';
    const npShadow = container.attachShadow({ mode: 'open' });
    attachShadowStyles(npShadow);

    const root = document.createElement('div');
    root.id = 'ci-notepad';

    const card = document.createElement('div');
    card.className = 'notepad-card';

    const header = document.createElement('div');
    header.className = 'notepad-header';

    const title = document.createElement('div');
    title.className = 'notepad-title';
    title.textContent = 'Notepad (Esc to copy & close)';

    const actions = document.createElement('div');
    actions.className = 'notepad-actions';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'notepad-btn';
    clearBtn.title = 'Clear';
    clearBtn.textContent = 'C';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'notepad-btn';
    closeBtn.title = 'Close';
    closeBtn.textContent = 'X';

    actions.appendChild(clearBtn);
    actions.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(actions);

    const textarea = document.createElement('textarea');
    textarea.className = 'notepad-input';
    textarea.setAttribute('placeholder', 'Type here...');

    textarea.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        await copyNotepadText();
        hideNotepad();
      }
    });
    textarea.addEventListener('focus', () => {
      notepadHasFocus = true;
      CI.focusedElement = textarea;
    });
    textarea.addEventListener('blur', () => {
      notepadHasFocus = false;
    });

    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      textarea.value = '';
      textarea.focus();
    });
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      hideNotepad();
    });

    card.appendChild(header);
    card.appendChild(textarea);
    root.appendChild(card);
    npShadow.appendChild(root);

    document.body.appendChild(container);
    notepadTextarea = textarea;
    notepadCard = card;

    const onDragMove = (e) => {
      if (!notepadDragging || !notepadCard) return;
      const rect = notepadCard.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      let nextLeft = e.clientX - notepadDragOffset.x;
      let nextTop = e.clientY - notepadDragOffset.y;
      if (nextLeft < 0) nextLeft = 0;
      if (nextTop < 0) nextTop = 0;
      if (nextLeft > maxLeft) nextLeft = maxLeft;
      if (nextTop > maxTop) nextTop = maxTop;
      notepadCard.style.left = `${nextLeft}px`;
      notepadCard.style.top = `${nextTop}px`;
      notepadCard.style.transform = 'none';
      notepadPos = { x: nextLeft, y: nextTop };
    };

    const onDragEnd = () => {
      if (!notepadDragging) return;
      notepadDragging = false;
    };

    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (!notepadCard) return;
      const rect = notepadCard.getBoundingClientRect();
      notepadCard.style.left = `${rect.left}px`;
      notepadCard.style.top = `${rect.top}px`;
      notepadCard.style.transform = 'none';
      notepadDragging = true;
      notepadDragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });

    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  }

  function showNotepad() {
    injectNotepad();
    const container = document.getElementById('ci-notepad-container');
    if (!container) return;
    const root = container.shadowRoot ? container.shadowRoot.getElementById('ci-notepad') : null;
    if (!root) return;
    root.style.display = 'flex';
    notepadVisible = true;
    if (notepadCard) {
      if (notepadPos) {
        notepadCard.style.left = `${notepadPos.x}px`;
        notepadCard.style.top = `${notepadPos.y}px`;
        notepadCard.style.transform = 'none';
      } else {
        notepadCard.style.left = '50%';
        notepadCard.style.top = '50%';
        notepadCard.style.transform = 'translate(-50%, -50%)';
      }
    }
    setTimeout(() => {
      if (notepadTextarea) notepadTextarea.focus();
    }, 0);
  }

  function hideNotepad() {
    const container = document.getElementById('ci-notepad-container');
    if (!container) return;
    const root = container.shadowRoot ? container.shadowRoot.getElementById('ci-notepad') : null;
    if (!root) return;
    root.style.display = 'none';
    notepadVisible = false;
  }

  function toggleNotepad() {
    if (notepadVisible) {
      hideNotepad();
    } else {
      showNotepad();
    }
  }

  CI.ui = {
    injectUI,
    renderUI,
    showUI,
    hideUI,
    positionUI,
    updateUIMode,
    showToast,
    togglePunctuationMode,
    toggleWidthMode,
    mapDirectInputChar,
    selectCandidate,
    onDragMoveProxy: onDragMove,
    endDragProxy: endDrag,
    selectCandidateByAbsoluteIndex,
    setSelectionByAbsoluteIndex,
    getCurrentAbsoluteSelectedIndex,
    getCurrentRowStartIndex,
    expandCandidateRows,
    collapseCandidateRows,
    openExtensionEditor,
    showNotepad,
    hideNotepad,
    toggleNotepad,
    get notepadTextarea() { return notepadTextarea; },
    get notepadHasFocus() { return notepadHasFocus; },
    get notepadVisible() { return notepadVisible; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
