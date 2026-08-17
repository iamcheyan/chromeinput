(function (global) {
  'use strict';
  /**
   * chromeinput 应用级提示 (源仓铁律: 禁止 alert/confirm/prompt).
   * 由旧版核心脚本移植: showAppToast / showAppConfirm / showCodeInputDialog.
   * 样式沿用 content/style.css 的 .ci-ui-* 类.
   */

  function ensureUIOverlayLayer(doc = global.document) {
    if (!doc || !doc.body) return null;
    let layer = doc.getElementById('ci-ui-layer');
    if (!layer) {
      layer = doc.createElement('div');
      layer.id = 'ci-ui-layer';
      layer.className = 'ci-ui-layer';
      doc.body.appendChild(layer);
    }
    let toastStack = layer.querySelector('.ci-ui-toast-stack');
    if (!toastStack) {
      toastStack = doc.createElement('div');
      toastStack.className = 'ci-ui-toast-stack';
      layer.appendChild(toastStack);
    }
    return { layer, toastStack };
  }

  function injectOverlayStyles(doc = global.document) {
    if (!doc || doc.getElementById('ci-ui-layer-styles')) return;
    const link = doc.createElement('link');
    link.id = 'ci-ui-layer-styles';
    link.rel = 'stylesheet';
    if (global.chrome && chrome.runtime && chrome.runtime.id) {
      link.href = chrome.runtime.getURL('content/style.css');
      doc.head.appendChild(link);
    }
  }

  function showAppToast(message, {
    document: doc = global.document,
    tone = 'info',
    duration = 2200
  } = {}) {
    injectOverlayStyles(doc);
    const ui = ensureUIOverlayLayer(doc);
    if (!ui || !message) return null;

    const toast = doc.createElement('div');
    toast.className = `ci-ui-toast is-${tone}`;
    toast.textContent = `${message}`;
    ui.toastStack.appendChild(toast);

    requestAnimationFrame(() => { toast.classList.add('is-visible'); });

    const removeToast = () => {
      toast.classList.remove('is-visible');
      global.setTimeout(() => { toast.remove(); }, 180);
    };
    global.setTimeout(removeToast, duration);
    return removeToast;
  }

  function buildModalSkeleton(doc, titleText) {
    const overlay = doc.createElement('div');
    overlay.className = 'ci-ui-modal-backdrop';

    const panel = doc.createElement('div');
    panel.className = 'ci-ui-modal';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', titleText);

    const header = doc.createElement('div');
    header.className = 'ci-ui-modal-header';
    const title = doc.createElement('h2');
    title.textContent = titleText;
    const closeButton = doc.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'ci-ui-modal-close';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.textContent = '×';
    header.appendChild(title);
    header.appendChild(closeButton);

    const body = doc.createElement('div');
    body.className = 'ci-ui-modal-body';

    const footer = doc.createElement('div');
    footer.className = 'ci-ui-modal-footer';

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    overlay.appendChild(panel);

    return { overlay, panel, header, body, footer, closeButton };
  }

  function makeButton(doc, text, variant) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `ci-ui-button${variant ? ` is-${variant}` : ''}`;
    button.textContent = text;
    return button;
  }

  function showAppConfirm(titleText, messageText, {
    document: doc = global.document
  } = {}) {
    injectOverlayStyles(doc);
    const ui = ensureUIOverlayLayer(doc);
    if (!ui) return Promise.resolve(false);

    return new Promise((resolve) => {
      const { overlay, body, footer, closeButton } = buildModalSkeleton(doc, titleText);
      body.style.fontSize = '13px';
      body.style.lineHeight = '1.6';
      body.style.color = '#deddda';
      body.textContent = messageText;

      const cancelButton = makeButton(doc, 'Cancel', 'secondary');
      const confirmButton = makeButton(doc, 'Confirm', 'primary');
      footer.appendChild(cancelButton);
      footer.appendChild(confirmButton);

      ui.layer.appendChild(overlay);

      const close = (value) => {
        doc.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (!overlay.isConnected) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          close(false);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          close(true);
        }
      };

      closeButton.addEventListener('click', () => close(false));
      cancelButton.addEventListener('click', () => close(false));
      confirmButton.addEventListener('click', () => close(true));
      overlay.addEventListener('mousedown', (event) => {
        if (event.target === overlay) close(false);
      });
      doc.addEventListener('keydown', onKeyDown, true);
      global.requestAnimationFrame(() => { confirmButton.focus(); });
    });
  }

  function showCodeInputDialog(word, {
    document: doc = global.document
  } = {}) {
    injectOverlayStyles(doc);
    const ui = ensureUIOverlayLayer(doc);
    if (!ui) return Promise.resolve(null);

    return new Promise((resolve) => {
      const { overlay, body, footer, closeButton } = buildModalSkeleton(doc, 'Add To Dictionary');

      const label = doc.createElement('label');
      label.className = 'ci-ui-field';

      const labelTitle = doc.createElement('span');
      labelTitle.className = 'ci-ui-field-label';
      labelTitle.textContent = 'Selected text';

      const selectionPreview = doc.createElement('div');
      selectionPreview.className = 'ci-ui-selection-preview';
      selectionPreview.textContent = `${word}`;

      const codeLabel = doc.createElement('span');
      codeLabel.className = 'ci-ui-field-label';
      codeLabel.textContent = 'Code';

      const input = doc.createElement('input');
      input.type = 'text';
      input.className = 'ci-ui-input';
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.placeholder = 'a-z';
      input.maxLength = 64;

      const hint = doc.createElement('div');
      hint.className = 'ci-ui-field-hint';
      hint.textContent = 'Only lowercase letters a-z are allowed.';

      const error = doc.createElement('div');
      error.className = 'ci-ui-field-error';
      error.setAttribute('aria-live', 'polite');

      label.appendChild(labelTitle);
      label.appendChild(selectionPreview);
      label.appendChild(codeLabel);
      label.appendChild(input);
      label.appendChild(hint);
      label.appendChild(error);
      body.appendChild(label);

      const cancelButton = makeButton(doc, 'Cancel', 'secondary');
      const submitButton = makeButton(doc, 'Add', 'primary');
      footer.appendChild(cancelButton);
      footer.appendChild(submitButton);

      ui.layer.appendChild(overlay);

      const close = (value) => {
        doc.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        resolve(value);
      };
      const submit = () => {
        const value = input.value.trim().toLowerCase();
        if (!/^[a-z]+$/.test(value)) {
          error.textContent = 'Code must use lowercase letters a-z.';
          input.focus();
          input.select();
          return;
        }
        close(value);
      };
      const onKeyDown = (event) => {
        if (!overlay.isConnected) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          close(null);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      };

      closeButton.addEventListener('click', () => close(null));
      cancelButton.addEventListener('click', () => close(null));
      submitButton.addEventListener('click', submit);
      overlay.addEventListener('mousedown', (event) => {
        if (event.target === overlay) close(null);
      });
      input.addEventListener('input', () => {
        const normalized = input.value.toLowerCase().replace(/[^a-z]/g, '');
        if (normalized !== input.value) input.value = normalized;
        error.textContent = '';
      });

      doc.addEventListener('keydown', onKeyDown, true);
      global.requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  /**
   * 快捷词入库: 弹码输入框 -> user.json 追加 [word, code, weight].
   * 对标原版 promptAndSaveFixedEntry (native host 落盘改为 storage override).
   */
  async function promptAndSaveShortcutEntry(selectedText, {
    afterSave,
    document: doc = global.document
  } = {}) {
    const Shared = global.CIShared;
    const word = `${selectedText || ''}`.trim();
    if (!word) {
      showAppToast('No text selected for addition.', { document: doc, tone: 'warning' });
      return { ok: false, reason: 'empty_selection' };
    }

    const input = await showCodeInputDialog(word, { document: doc });
    if (input === null || input === undefined) {
      return { ok: false, reason: 'cancelled' };
    }
    const code = `${input}`.trim().toLowerCase();

    try {
      const entries = await Shared.getUserEntries();
      if (entries.some((entry) => entry[0] === word && entry[1] === code)) {
        showAppToast(`Already exists: ${word} -> ${code}`, { document: doc, tone: 'warning' });
        return { ok: false, reason: 'duplicate', word, code };
      }
      const weight = Shared.getNextShortcutWeight(entries, code);
      const { text } = await Shared.upsertUserEntry(word, code, Shared.USER_ENTRY_WEIGHT);
      if (typeof afterSave === 'function') {
        await afterSave({
          path: Shared.USER_DICT_PATH,
          localPath: Shared.USER_DICT_PATH.split('/').pop(),
          text,
          word,
          code,
          weight
        });
      }
      showAppToast(`Added: ${word} -> ${code}`, { document: doc, tone: 'success' });
      return { ok: true, word, code, weight, text };
    } catch (error) {
      showAppToast(`Failed to add: ${error.message}`, { document: doc, tone: 'error', duration: 3200 });
      return { ok: false, reason: 'error', error };
    }
  }

  global.CIShared = Object.assign(global.CIShared || {}, {
    showAppToast,
    showAppConfirm,
    showCodeInputDialog,
    promptAndSaveShortcutEntry
  });
})(typeof window !== 'undefined' ? window : globalThis);
