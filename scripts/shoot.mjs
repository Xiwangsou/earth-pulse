/**
 * shoot.mjs — 用 CDP 直接驱动 Edge 截图
 *
 * 为什么不用 --screenshot 命令行参数：
 *   那个参数会启用「虚拟时间」，等页面时钟推进到 budget 为止。
 *   而本项目有永不停止的 requestAnimationFrame 循环，
 *   虚拟时间因此永远推进不到头，命令会一直挂着（实测 2 分钟不出图）。
 *
 * 正确做法：用 DevTools 协议连上浏览器，等页面就绪后直接抓帧。
 * 这样不依赖虚拟时间，几秒就能拿到。
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = process.argv[3] || 'screenshot.png';
const WIDTH = Number(process.argv[4] || 1600);
const HEIGHT = Number(process.argv[5] || 1000);
const WAIT_MS = Number(process.argv[6] || 6000);

const userDir = mkdtempSync(join(tmpdir(), 'shoot-'));
const PORT = 9222 + Math.floor(Math.random() * 500);

const proc = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    `--user-data-dir=${userDir}`,
    `--remote-debugging-port=${PORT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const json = await res.json();
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('无法连接到 Edge 调试端口');
}

function cdp(ws, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30000);
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

try {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });

  // 新建标签页并附加
  const { targetId } = await cdp(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp(ws, 'Target.attachToTarget', { targetId, flatten: true });

  await cdp(ws, 'Page.enable', {}, sessionId);
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  }, sessionId);

  await cdp(ws, 'Page.navigate', { url: URL_TARGET }, sessionId);

  // 等待数据加载与首帧绘制
  await sleep(WAIT_MS);

  const { data } = await cdp(ws, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  }, sessionId);

  writeFileSync(OUT, Buffer.from(data, 'base64'));
  console.log(`✓ 已保存 ${OUT}`);

  ws.close();
} catch (err) {
  console.error('截图失败:', err.message);
  process.exitCode = 1;
} finally {
  try {
    proc.kill();
  } catch {
    /* 已退出 */
  }
}
