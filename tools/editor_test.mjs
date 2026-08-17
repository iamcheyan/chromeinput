#!/usr/bin/env node
/**
 * chromeinput Nova Editor 验收 (GOAL §五 A8).
 * 打开词库文件 -> 1 万行虚拟滚动 -> 编辑保存生效 -> vim hjkl/dd/yy/p.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';

const EXT_DIR = path.resolve('extension');
const results = [];
function record(id, ok, detail = '') {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  -- ' + detail : ''}`);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-ed-'));
const browser = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  executablePath: '~/.local/bin/google-chrome',
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu'
  ]
});

try {
  // 取扩展 id: 借助任一 http 页的 content script 隔离世界
  const probePage = await browser.newPage();
  await probePage.goto('about:blank');
  // chrome://extensions 内部页可直接读
  await probePage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
  const extId = await probePage.evaluate(async () => {
    const items = await chrome.developerPrivate.getExtensionsInfo();
    const ext = items.find((i) => i.name === 'chromeinput');
    return ext && ext.id;
  });
  record('ED0 扩展已加载', !!extId, extId || 'not found');
  await probePage.close();
  if (!extId) throw new Error('extension id unavailable');

  const page = await browser.newPage();
  await page.bringToFront();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`chrome-extension://${extId}/editor/index.html`, { waitUntil: 'domcontentloaded' });

  // feature-ime 默认关 (模块化设计), 先在设置中启用
  await page.click('#settings-button');
  await page.waitForSelector('#settings-dialog[open]', { timeout: 3000 });
  await page.evaluate(() => {
    const cb = document.getElementById('setting-feature-ime');
    if (!cb.checked) cb.click();
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.waitForTimeout(600);

  // --- 打开词库文件 user.json
  await page.click('#open-dict-button');
  await page.waitForSelector('#open-dict-dialog[open]', { timeout: 5000 });
  const dictButtons = await page.$$eval('#dict-file-list button', (bs) => bs.map((b) => b.textContent));
  record('ED1 Open 列出 user.json', dictButtons.some((t) => t.includes('user.json')), JSON.stringify(dictButtons));
  await page.evaluate(() => {
    const btn = document.querySelector('#dict-file-list button');
    if (btn) btn.click();
  });
  await page.waitForTimeout(500);
  const editorVal = await page.$eval('#editor', (el) => el.value);
  record('ED2 词库载入编辑器', editorVal.includes('[') && editorVal.length > 10, `len=${editorVal.length}`);
  const fileInfo = await page.$eval('#file-info', (el) => el.textContent);
  record('ED3 标签为 user.json', fileInfo.includes('user.json'), fileInfo);

  // --- 1 万行大文档虚拟滚动
  await page.evaluate(() => { window.__ED_PERF = []; });
  const t0 = Date.now();
  await page.evaluate(() => {
    const editor = document.getElementById('editor');
    const lines = [];
    for (let i = 1; i <= 10000; i++) lines.push(`line-${i} 词库测试行 ${i}`);
    editor.value = lines.join('\n');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const loadMs = Date.now() - t0;
  record('ED4 载入 1 万行', loadMs < 2000, `${loadMs}ms`);

  // 滚动流畅性: 量化 scroll 事件到渲染帧延迟
  const scrollStats = await page.evaluate(async () => {
    const editor = document.getElementById('editor');
    let maxGap = 0;
    let events = 0;
    const t0 = performance.now();
    await new Promise((resolve) => {
      const onScroll = () => {
        events++;
        const now = performance.now();
        // rAF 渲染延迟
        requestAnimationFrame(() => {
          maxGap = Math.max(maxGap, performance.now() - now);
        });
      };
      editor.addEventListener('scroll', onScroll, { passive: true });
      const step = () => {
        editor.scrollTop += 900;
        if (editor.scrollTop + editor.clientHeight >= editor.scrollHeight || performance.now() - t0 > 3000) {
          editor.removeEventListener('scroll', onScroll);
          setTimeout(resolve, 300);
        } else {
          setTimeout(step, 16);
        }
      };
      step();
    });
    return { events, maxGap: Math.round(maxGap * 100) / 100 };
  });
  record('ED5 滚动渲染帧延迟<=50ms', scrollStats.maxGap <= 50,
    `events=${scrollStats.events} maxFrameGap=${scrollStats.maxGap}ms`);

  // 行号正确性 (虚拟渲染下)
  await page.evaluate(() => { document.getElementById('editor').scrollTop = 0; });
  await page.waitForTimeout(200);
  const lineCount = await page.$eval('#line-numbers', (el) => el.textContent.trim().split('\n').length);
  const rendered = await page.evaluate(() => ({
    displayed: document.querySelectorAll('#line-numbers .line-number-viewport > div').length
  }));
  record('ED6 行号虚拟渲染 (10-60 行)', rendered.displayed >= 10 && rendered.displayed < 60, `displayed=${rendered.displayed}`);

  // --- vim 模式 hjkl / dd / yy / p
  await page.click('#settings-button');
  await page.waitForSelector('#settings-dialog[open]', { timeout: 3000 });
  await page.evaluate(() => {
    const cb = document.getElementById('setting-feature-vim');
    if (!cb.checked) cb.click();
  });
  await page.keyboard.press('Escape'); // 关设置对话框
  await page.waitForTimeout(400);
  await page.click('#vim-mode-button');
  await page.waitForTimeout(300);
  await page.click('#editor');
  await page.keyboard.press('Escape'); // Esc 进入 Normal
  await page.waitForTimeout(300);
  const vimStatus = await page.$eval('#vim-status', (el) => el.textContent);
  record('ED7 vim Normal 模式', vimStatus === 'NORMAL', vimStatus);

  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.value = ['第一行', '第二行', '第三行', '第四行'].join('\n');
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.setSelectionRange(0, 0);
    ed.focus();
  });
  await page.keyboard.press('j'); // 下移
  await page.waitForTimeout(80);
  const afterJ = await page.evaluate(() => {
    const ed = document.getElementById('editor');
    const pos = ed.selectionStart;
    return { line: ed.value.slice(0, pos).split('\n').length, col: pos - (ed.value.lastIndexOf('\n', pos - 1) + 1) };
  });
  record('ED8 vim j 下移一行', afterJ.line === 2, JSON.stringify(afterJ));

  await page.keyboard.press('l');
  await page.waitForTimeout(80);
  const afterL = await page.evaluate(() => document.getElementById('editor').selectionStart);
  record('ED9 vim l 右移一列', afterL === 5, `pos=${afterL} (期望行2列2=索引5)`);

  await page.keyboard.press('d'); await page.waitForTimeout(60); await page.keyboard.press('d');
  await page.waitForTimeout(120);
  const afterDd = await page.evaluate(() => document.getElementById('editor').value);
  record('ED10 vim dd 删行', afterDd === '第一行\n第三行\n第四行', JSON.stringify(afterDd));

  await page.keyboard.press('y'); await page.waitForTimeout(60); await page.keyboard.press('y');
  await page.waitForTimeout(60);
  await page.keyboard.press('p');
  await page.waitForTimeout(150);
  const afterP = await page.evaluate(() => document.getElementById('editor').value);
  record('ED11 vim yy+p 粘贴行', afterP === '第一行\n第三行\n第三行\n第四行', JSON.stringify(afterP));

  // --- 编辑 user.json 并保存生效
  await page.click('#vim-mode-button'); // 退回 INSERT
  await page.waitForTimeout(200);
  const tabBtns = await page.$$eval('#tabs .tab', (ts) => ts.map((t) => t.textContent));
  record('ED12 多标签共存', tabBtns.length >= 2, JSON.stringify(tabBtns));

  // 切回 user.json 标签
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#tabs .tab')];
    const target = tabs.find((t) => t.textContent.includes('user.json'));
    if (target) target.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.value = JSON.stringify([["自动化测试词", "zidonghua", 999999],
      ["你好", "ni hao", 21493]], null, 0);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#save-button');
  await page.waitForTimeout(600);
  const saved = await page.evaluate(async () => {
    const got = await new Promise((res) => chrome.storage.local.get(['ci_dict_overrides'], res));
    return got.ci_dict_overrides && got.ci_dict_overrides['dicts/user.json'];
  });
  record('ED13 保存写入 override', !!(saved && saved.includes('自动化测试词')), (saved || '').slice(0, 80));

  // IME 在编辑器内可用 (feature-ime 开启 + 打字)
  await page.click('#settings-button');
  await page.waitForSelector('#settings-dialog[open]', { timeout: 3000 });
  await page.evaluate(() => {
    const cb = document.getElementById('setting-feature-ime');
    if (!cb.checked) cb.click();
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.click('#editor');
  await page.keyboard.type('nihao', { delay: 40 });
  await page.waitForTimeout(300);
  const imeCandidates = await page.evaluate(() => {
    const root = document.querySelector('#ci-ime-container');
    const s = root && root.shadowRoot;
    return s ? [...s.querySelectorAll('.candidate-text')].map((e) => e.textContent).slice(0, 3) : [];
  });
  record('ED14 编辑器内 IME 候选', imeCandidates.length > 0, JSON.stringify(imeCandidates));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // popup 页无错
  const popup = await browser.newPage();
  const popupErrors = [];
  popup.on('pageerror', (e) => popupErrors.push(String(e)));
  popup.on('console', (m) => { if (m.type() === 'error') popupErrors.push(m.text()); });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'domcontentloaded' });
  await popup.waitForTimeout(800);
  const popupHtml = await popup.evaluate(() => document.body.innerText.slice(0, 120));
  record('ED15 popup 加载无错', popupErrors.filter((e) => !e.includes('favicon')).length === 0, popupHtml.replace(/\n/g, ' '));
  await popup.close();

  const relevantErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('net::ERR'));
  record('ED16 editor console 零报错', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
