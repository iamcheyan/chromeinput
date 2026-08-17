#!/usr/bin/env node
/**
 * chromeinput 光标跟随专项验证.
 * 场景: input/textarea/contenteditable, 光标在长文本中间时候选条应贴近光标而非元素左缘.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';

const EXT_DIR = path.resolve('extension');
const TEST_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:40px">
<input id="ti" style="width:600px" value="">
<textarea id="ta" rows="4" style="width:600px"></textarea>
<div id="ce" contenteditable="true" style="border:1px solid #888;min-height:40px;padding:4px;width:600px"></div>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(TEST_PAGE);
});
await new Promise((r) => server.listen(8932, '127.0.0.1', r));

const results = [];
function record(id, ok, detail = '') {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  -- ' + detail : ''}`);
}

const browser = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-caret-')), {
  headless: false,
  executablePath: process.env.CHROME_BIN || `${os.homedir()}/.local/bin/google-chrome`,
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--disable-gpu']
});

const page = browser.pages()[0] || await browser.newPage();
await page.goto('http://127.0.0.1:8932/');
await page.waitForTimeout(1500);

async function imeRect() {
  return page.evaluate(() => {
    const root = document.querySelector('#ci-ime-container');
    const r = root && root.shadowRoot && root.shadowRoot.getElementById('ci-ime-root');
    if (!r || r.style.display === 'none') return null;
    const b = r.getBoundingClientRect();
    return { left: Math.round(b.left), top: Math.round(b.top) };
  });
}

// 用 CDP 隔离世界确认引擎活跃
const session = await page.context().newCDPSession(page);
let engineReady = false;
session.on('Runtime.executionContextCreated', (ev) => {
  if (String(ev.context.origin || '').startsWith('chrome-extension://')) engineReady = true;
});
await page.waitForTimeout(800);

// ---- 场景1: input 长文本, 光标在末尾(文本宽 ~300px) ----
await page.evaluate(() => {
  const ti = document.getElementById('ti');
  ti.value = '这是一段很长的前缀文本这是 一段很长的前缀文本abcdefg';
  ti.focus();
  ti.setSelectionRange(ti.value.length, ti.value.length);
});
await page.keyboard.type('nihao', { delay: 20 });
await page.waitForTimeout(300);
const r1 = await imeRect();
const caretX1 = await page.evaluate(() => {
  const ti = document.getElementById('ti');
  // 光标 x 估算: 元素left + 文本宽度(用镜像粗测同式) —— 直接取扩展实测: 用 canvas
  const cs = getComputedStyle(ti);
  const cv = document.createElement('canvas').getContext('2d');
  cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return Math.round(ti.getBoundingClientRect().left + cv.measureText(ti.value).width);
});
record('F1 input 候选条跟随光标(左缘贴近光标x)', r1 && Math.abs(r1.left - caretX1) < 60,
  `ime.left=${r1 && r1.left} caretX≈${caretX1}`);
await page.keyboard.press('Escape');

// ---- 场景2: 光标移到文本开头, 候选条应回到左侧 ----
await page.evaluate(() => {
  const ti = document.getElementById('ti');
  ti.setSelectionRange(0, 0);
});
await page.keyboard.type('nh', { delay: 20 });
await page.waitForTimeout(300);
const r2 = await imeRect();
record('F2 光标移回首部后候选条左移', r2 && r2.left < (r1 ? r1.left : 9999),
  `ime.left=${r2 && r2.left} (场景1=${r1 && r1.left})`);
await page.keyboard.press('Escape');

// ---- 场景3: textarea 多行, 光标在第3行 ----
await page.evaluate(() => {
  const ta = document.getElementById('ta');
  ta.value = '第一行\n第二行\n第三行\n第四行';
  ta.focus();
  ta.setSelectionRange(ta.value.indexOf('第三行') + 3, ta.value.indexOf('第三行') + 3);
});
await page.keyboard.type('nh', { delay: 20 });
await page.waitForTimeout(300);
const r3 = await imeRect();
const taTop = await page.evaluate(() => Math.round(document.getElementById('ta').getBoundingClientRect().top));
record('F3 textarea 第3行光标 y 跟随(不在元素顶)', r3 && r3.top > taTop + 40,
  `ime.top=${r3 && r3.top} ta.top=${taTop}`);
await page.keyboard.press('Escape');

// ---- 场景4: contenteditable 光标在文本中段 ----
await page.evaluate(() => {
  const ce = document.getElementById('ce');
  ce.textContent = '段落文本段落文本段落文本段落文本段落文本';
  ce.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  const node = ce.firstChild;
  range.setStart(node, 16);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
});
await page.keyboard.type('nh', { delay: 20 });
await page.waitForTimeout(300);
const r4 = await imeRect();
const ceLeft = await page.evaluate(() => Math.round(document.getElementById('ce').getBoundingClientRect().left));
record('F4 contenteditable 候选条贴光标(明显右于元素左缘)', r4 && r4.left > ceLeft + 100,
  `ime.left=${r4 && r4.left} ce.left=${ceLeft}`);
await page.keyboard.press('Escape');

// ---- 场景5: 视口右缘不溢出 ----
await page.evaluate(() => {
  const ti = document.getElementById('ti');
  ti.value = 'x'.repeat(120);
  ti.setSelectionRange(120, 120);
  ti.focus();
});
await page.keyboard.type('nh', { delay: 20 });
await page.waitForTimeout(300);
const r5 = await imeRect();
record('F5 长文本右缘候选条仍收在视口内', r5 && r5.left + 340 <= 1280,
  `ime.left=${r5 && r5.left} (视口1280)`);
await page.keyboard.press('Escape');

const passed = results.filter((r) => r.ok).length;
console.log(`\n==== ${passed}/${results.length} passed ====`);
await browser.close();
server.close();
process.exit(passed === results.length ? 0 : 1);
