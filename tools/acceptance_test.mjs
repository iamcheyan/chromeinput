#!/usr/bin/env node
/**
 * chromeinput 浏览器验收 harness (GOAL §五 A/B).
 *
 * 真实 Chrome (Xvfb headed) + --load-extension; content script 运行于隔离世界,
 * 故状态/存储断言走 CDP Runtime.evaluate(contextId), 控制台走 CDP consoleAPICalled.
 * 用法: xvfb-run -a node tools/acceptance_test.mjs [--ext extension]
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';

const EXT_DIR = path.resolve(process.argv.includes('--ext')
  ? process.argv[process.argv.indexOf('--ext') + 1]
  : 'extension');

const TEST_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ci-test</title></head><body>
<h3>chromeinput acceptance page</h3>
<input id="ti" placeholder="input here">
<textarea id="ta" rows="4"></textarea>
<div id="ce" contenteditable="true" style="border:1px solid #888;min-height:40px;padding:4px"></div>
<script>
const ti=document.getElementById('ti'),ta=document.getElementById('ta'),ce=document.getElementById('ce');
<\/script></body></html>`;

const results = [];
function record(id, ok, detail = '') {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  -- ' + detail : ''}`);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(TEST_PAGE);
});
await new Promise((r) => server.listen(8931, '127.0.0.1', r));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-profile-'));
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

/** 每页绑定: 隔离世界求值 + 全世界 console 捕获 */
async function bindPage(page) {
  const session = await page.context().newCDPSession(page);
  const consoleMsgs = [];
  const contexts = new Map();
  session.on('Runtime.executionContextDestroyed', (ev) => {
    contexts.delete(ev.executionContextId);
  });
  session.on('Runtime.executionContextsCleared', () => {
    contexts.clear();
  });
  session.on('Runtime.executionContextCreated', (ev) => {
    const ctx = ev.context;
    const isolated = (ctx.auxData && ctx.auxData.type === 'isolated') ||
      String(ctx.origin || '').startsWith('chrome-extension://');
    if (isolated) contexts.set(ctx.id, ctx);
  });
  session.on('Runtime.consoleAPICalled', (ev) => {
    const text = ev.args.map((a) => (a.value !== undefined ? String(a.value) : a.type)).join(' ');
    consoleMsgs.push({ type: ev.type, text });
  });
  session.on('Runtime.exceptionThrown', (ev) => {
    const d = ev.exceptionDetails;
    consoleMsgs.push({ type: 'error', text: (d.exception && d.exception.description) || d.text || 'exception' });
  });
  await session.send('Runtime.enable');
  await session.send('Page.enable').catch(() => {});

  let engineContextId = null;

  async function isoEval(expression) {
    let lastErr = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (engineContextId === null) {
        // 逐个探测: 找到定义了 CIEngine 的那个隔离世界
        for (const id of [...contexts.keys()]) {
          try {
            const probe = await session.send('Runtime.evaluate', {
              expression: 'typeof window.CIEngine',
              contextId: id,
              returnByValue: true
            });
            if (probe.result.value === 'object') {
              engineContextId = id;
              break;
            }
          } catch (e) {
            contexts.delete(id);
          }
        }
      }
      if (engineContextId === null) {
        await page.waitForTimeout(250);
        continue;
      }
      try {
        const res = await session.send('Runtime.evaluate', {
          expression,
          contextId: engineContextId,
          returnByValue: true,
          awaitPromise: true
        });
        if (res.exceptionDetails) {
          throw new Error('isoEval failed: ' + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
        }
        return res.result.value;
      } catch (e) {
        lastErr = e;
        engineContextId = null;
        await page.waitForTimeout(250);
      }
    }
    throw lastErr || new Error('no engine isolated context found');
  }

  return { session, consoleMsgs, isoEval };
}

function errorsOf(consoleMsgs) {
  return consoleMsgs
    .filter((m) => m.type === 'error')
    .map((m) => m.text)
    .filter((t) => !t.includes('net::ERR') && !t.includes('favicon'));
}

try {
  const page = browser.pages()[0] || await browser.newPage();
  const mainErrors = [];
  page.on('pageerror', (err) => mainErrors.push(String(err)));
  const { consoleMsgs, isoEval } = await bindPage(page);

  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'domcontentloaded' });
  // 触发懒加载: 聚焦输入框
  await page.click('#ti');
  for (let i = 0; i < 60; i++) {
    const ready = await isoEval('window.CIEngine && window.CIEngine.state.ready === true').catch(() => false);
    if (ready) break;
    await page.waitForTimeout(250);
  }
  const isReady = await isoEval('window.CIEngine && window.CIEngine.state.ready === true');
  record('A1a 安装零报错+词库就绪', !!isReady,
    isReady ? await isoEval('window.CIEngine.state.full.size + " keys"') : 'not ready');

  // --- A1 nihao -> 你好
  await page.keyboard.type('nihao', { delay: 25 });
  await page.waitForFunction(() => {
    const root = document.querySelector('#ci-ime-container');
    return root && root.shadowRoot && root.shadowRoot.querySelector('.candidate');
  }, null, { timeout: 5000 });
  const candText = await page.evaluate(() =>
    [...document.querySelector('#ci-ime-container').shadowRoot.querySelectorAll('.candidate-text')]
      .map((el) => el.textContent));
  record('A1b nihao 候选含你好', candText.includes('你好'), JSON.stringify(candText.slice(0, 6)));

  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('ti').value.includes('你好'), null, { timeout: 3000 });
  const tiVal = await page.evaluate(() => document.getElementById('ti').value);
  record('A1c 空格上屏你好', tiVal.includes('你好'), tiVal);

  // --- A2 zhongguo + nh
  await page.evaluate(() => { document.getElementById('ti').value = ''; });
  await page.keyboard.type('zhongguo', { delay: 18 });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('ti').value.includes('中国'), null, { timeout: 3000 });
  record('A2a zhongguo->中国', true);

  await page.evaluate(() => { document.getElementById('ti').value = ''; });
  await page.keyboard.type('nh', { delay: 30 });
  await page.waitForFunction(() => {
    const root = document.querySelector('#ci-ime-container');
    return root && root.shadowRoot && [...root.shadowRoot.querySelectorAll('.candidate-text')]
      .some((el) => el.textContent === '你好');
  }, null, { timeout: 5000 });
  const candSeq = await page.evaluate(() =>
    [...document.querySelector('#ci-ime-container').shadowRoot.querySelectorAll('.candidate-text')]
      .map((el) => el.textContent).slice(0, 6));
  record('A2b nh 简拼出你好', candSeq.includes('你好'), JSON.stringify(candSeq));
  await page.keyboard.press('Escape');

  // --- A3 直通/Esc/Backspace
  await page.evaluate(() => { document.getElementById('ti').value = ''; });
  await page.keyboard.type('zxqj', { delay: 15 });
  const hasDots = await page.evaluate(() => {
    const root = document.querySelector('#ci-ime-container');
    const s = root && root.shadowRoot;
    return !!(s && s.querySelector('.candidate-list') && s.querySelector('.candidate-list').textContent.includes('...'));
  });
  record('A3a 无匹配显示...', !!hasDots);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('ti').value.includes('zxqj'), null, { timeout: 3000 });
  record('A3b 无匹配字母直通上屏', true);

  await page.evaluate(() => { document.getElementById('ti').value = ''; });
  await page.keyboard.type('niha', { delay: 15 });
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
  const bufferAfterBs = await isoEval('window.CIEngine.state.buffer');
  const uiHidden = await page.evaluate(() => {
    const root = document.querySelector('#ci-ime-container');
    const r = root && root.shadowRoot && root.shadowRoot.getElementById('ci-ime-root');
    return !r || r.style.display === 'none';
  });
  record('A3c Backspace 逐字删至隐藏', bufferAfterBs === '' && uiHidden, `buffer="${bufferAfterBs}"`);

  await page.keyboard.type('nihao', { delay: 15 });
  await page.keyboard.press('Escape');
  const escOk = await isoEval('window.CIEngine.state.buffer === ""');
  record('A3d Esc 清空 buffer', escOk === true);

  // --- A4 用户词频
  await page.evaluate(() => { document.getElementById('ti').value = ''; });
  await page.keyboard.type('nihao', { delay: 15 });
  await page.keyboard.press('2'); // 选第 2 候选 (非默认首选)
  await page.waitForFunction(() => document.getElementById('ti').value.length > 0, null, { timeout: 3000 });
  const histSaved = await isoEval(`(async () => {
    const got = await new Promise((res) => chrome.storage.local.get(['ci_user_history'], res));
    return !!(got.ci_user_history && Array.isArray(got.ci_user_history.nihao) && got.ci_user_history.nihao.length);
  })()`);
  record('A4a 选中记录历史', histSaved === true);

  // --- A5 标点/全半角
  await page.evaluate(() => { document.getElementById('ti').value = ''; });
  await page.keyboard.type(',', { delay: 10 });
  const cnPunct = await page.evaluate(() => document.getElementById('ti').value.slice(-1));
  record('A5a 中文标点 ,', cnPunct === '，', cnPunct);

  // 点按钮须每次重查 (renderUI 重建 DOM, 旧引用已脱挂; 隐藏态标签不刷新, 用索引定位)
  const clickBtnAt = async (index) => {
    const clicked = await page.evaluate((i) => {
      const root = document.querySelector('#ci-ime-container');
      const btns = root && root.shadowRoot ? [...root.shadowRoot.querySelectorAll('.ime-btn')] : [];
      if (!btns[i]) return null;
      btns[i].click();
      return btns[i].textContent;
    }, index);
    await isoEval('window.CIContent.ui.renderUI()').catch(() => {});
    await page.waitForTimeout(100);
    return clicked;
  };

  await clickBtnAt(1); // 宽度按钮: half -> full
  await page.evaluate(() => { document.getElementById('ti').value = ''; });
  await page.keyboard.type('12', { delay: 10 });
  const fullWidth = await page.evaluate(() => document.getElementById('ti').value);
  record('A5b 全角数字', fullWidth === '１２', fullWidth);

  await clickBtnAt(1); // full -> half
  await clickBtnAt(0); // 标点: cn -> en
  await page.evaluate(() => { document.getElementById('ti').value = ''; });
  await page.keyboard.type(',', { delay: 10 });
  const enPunct = await page.evaluate(() => document.getElementById('ti').value);
  record('A5c 切回半角英文标点', enPunct === ',', JSON.stringify(enPunct));
  await clickBtnAt(0); // 还原 cn 标点

  // --- A6 快捷词: 经扩展页 (popup) 的 chrome.tabs.sendMessage 触发真实消息链路
  const extId = await isoEval('chrome.runtime.id');
  await page.evaluate(() => {
    const ti = document.getElementById('ti');
    ti.value = '测试快捷词';
    ti.focus();
    ti.select();
  });
  const popupPage = await browser.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'domcontentloaded' });
  await popupPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:8931/*' });
    const tab = tabs.find((t) => t.active) || tabs[0];
    await chrome.tabs.sendMessage(tab.id, { type: 'ci_add_current_selection_to_fixed_dict' });
  });
  await popupPage.close();
  await page.waitForFunction(() => {
    const layer = document.getElementById('ci-ui-layer');
    return layer && layer.querySelector('.ci-ui-input');
  }, null, { timeout: 5000 });
  await page.keyboard.type('cikuai', { delay: 12 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !(document.getElementById('ci-ui-layer') && document.getElementById('ci-ui-layer').querySelector('.ci-ui-input')), null, { timeout: 5000 });
  for (let i = 0; i < 40; i++) {
    const hit = await isoEval(`(async () => {
      const got = await new Promise((res) => chrome.storage.local.get(['ci_dict_overrides'], res));
      const text = got.ci_dict_overrides && got.ci_dict_overrides['dicts/user.json'];
      if (!text || !text.includes('测试快捷词')) return false;
      const entries = window.CIShared.parseEntries(text) || [];
      return entries.some(([w, c]) => w === '测试快捷词' && c === 'cikuai');
    })()`).catch(() => false);
    if (hit) { record('A6a 快捷词写入 override', true); break; }
    if (i === 39) record('A6a 快捷词写入 override', false);
    await page.waitForTimeout(250);
  }
  // 等待 content 侧 override 变更触发重载后立即可打
  for (let i = 0; i < 40; i++) {
    const hit = await isoEval(`(() => {
      const b = window.CIEngine.state.full.get('cikuai');
      return !!(b && b.some((e) => e[0] === '测试快捷词'));
    })()`).catch(() => false);
    if (hit) { record('A6b 快捷词立即可打', true); break; }
    if (i === 39) record('A6b 快捷词立即可打', false);
    await page.waitForTimeout(250);
  }

  // --- A7 站点开关
  await isoEval(`new Promise((res) => chrome.storage.local.set({
    ci_site_rules: [{ pattern: '^http://127\\\\.0\\\\.0\\\\.1:8931/', enabled: false }]
  }, res))`);
  await page.waitForFunction(() => {
    const root = document.querySelector('#ci-ime-container');
    return !root || !root.shadowRoot || root.shadowRoot.getElementById('ci-ime-root').style.display === 'none';
  }, null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => { document.getElementById('ti').value = ''; });
  await page.click('#ti');
  await page.keyboard.type('nihao', { delay: 15 });
  const passthrough = await page.evaluate(() => document.getElementById('ti').value);
  record('A7 禁用站点直通', passthrough === 'nihao', JSON.stringify(passthrough));
  await isoEval(`new Promise((res) => chrome.storage.local.set({ ci_site_rules: [] }, res))`);
  await page.waitForTimeout(300);

  // --- A9 contenteditable / textarea
  await page.click('#ce');
  await page.keyboard.type('zhongguo', { delay: 15 });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('ce').textContent.includes('中国'), null, { timeout: 3000 });
  record('A9a contenteditable 上屏', true);

  await page.click('#ta');
  await page.keyboard.type('shijie', { delay: 15 });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('ta').value.includes('世界'), null, { timeout: 3000 });
  record('A9b textarea 上屏', true);
  record('A9c input 上屏', true, '(A1/A2 已覆盖 input)');

  // --- B11 单键性能
  const perf = await isoEval('({...window.CIEngine.state.perf})');
  record('B11 单键最大耗时<=5ms', perf.maxKeyMs <= 5,
    `last=${perf.lastKeyMs.toFixed(2)}ms max=${perf.maxKeyMs.toFixed(2)}ms keys=${perf.keyCount}`);

  // --- B10 冷启动 (清缓存重载)
  await isoEval(`new Promise((res) => chrome.storage.local.remove(['ci_dict_cache'], res))`);
  const page3 = await browser.newPage();
  const p3bind = await bindPage(page3);
  const coldLogs = () => p3bind.consoleMsgs.filter((m) => m.text.includes('CI:cold-start')).map((m) => m.text);
  await page3.goto('http://127.0.0.1:8931/', { waitUntil: 'domcontentloaded' });
  await page3.click('#ta');
  for (let i = 0; i < 60; i++) {
    const ready = await p3bind.isoEval('window.CIEngine && window.CIEngine.state.ready === true').catch(() => false);
    if (ready && coldLogs().some((t) => t.includes('CI:cold-start:'))) break;
  }
  const logs = coldLogs();
  const ms = parseFloat((logs.find((l) => l.includes('CI:cold-start:')) || '').match(/([\d.]+)\s*ms/)?.[1] || '0');
  record('B10 冷启动打点+<=800ms', logs.length >= 1 && ms > 0 && ms <= 800, logs.join(' ; ') || 'no logs');
  await page3.close();

  // --- C15 console 零报错 (content + page)
  const relevantErrors = [...errorsOf(consoleMsgs), ...mainErrors]
    .filter((e) => !e.includes('net::ERR') && !e.includes('favicon'));
  record('C15 console 零报错', relevantErrors.length === 0, relevantErrors.slice(0, 5).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
