#!/usr/bin/env node
/**
 * serve.mjs — 零依赖静态服务器
 *
 * 为什么不用 vite / http-server：
 *   本项目没有任何构建步骤，也不需要打包压缩。
 *   ES 模块在浏览器里原生支持，唯一的硬性要求是「用 http 而不是 file 打开」
 *   ——因为 file:// 协议下浏览器会拒绝跨源加载 ES 模块，这是安全策略。
 *
 *   所以这个文件只做一件事：正确地把文件按 MIME 类型吐出去。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const port = Number(process.env.PORT || 8848);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // 防目录穿越：规范化后必须仍在 root 之内
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(root, rel === '/' ? 'index.html' : rel);

    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('403 Forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = join(filePath, 'index.html');

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`\n  地球脉冲 Earth Pulse`);
  console.log(`  → http://127.0.0.1:${port}\n`);
  console.log(`  按 Ctrl+C 停止\n`);
});
