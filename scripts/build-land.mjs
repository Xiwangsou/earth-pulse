#!/usr/bin/env node
/**
 * build-land.mjs — 把 Natural Earth 110m 陆地 GeoJSON 转成紧凑的 JS 模块。
 *
 * 为什么这么做：
 *   1. 原始 GeoJSON 138 KB，含大量重复的 properties 和 crs 字段，浏览器运行时不需要。
 *   2. 坐标保留 2 位小数（约 1.1 km 精度），在 2D 投影下肉眼无差，体积可减半。
 *   3. 输出为「环的环」结构 —— land[ri][0] 是外环，land[ri][1..] 是洞（湖泊），
 *      渲染时用 canvas evenodd 规则一次性填充，比逐环 stroke 快得多。
 *
 * 原始数据不入库（见 .gitignore），缺失时自动从上游下载，
 * 保证任何人克隆后都能重新生成。
 *
 * 数据来源：Natural Earth (public domain) - naturalearthdata.com
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const outFile = join(dataDir, 'land.js');
const rawFile = join(dataDir, 'land110.json');

const UPSTREAM =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson';

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

if (!existsSync(rawFile)) {
  console.log('未找到原始数据，正在从 Natural Earth 下载…');
  const res = await fetch(UPSTREAM);
  if (!res.ok) {
    console.error(`下载失败：HTTP ${res.status}`);
    console.error(`请手动下载 ${UPSTREAM} 并保存为 data/land110.json 后重试。`);
    process.exit(1);
  }
  writeFileSync(rawFile, Buffer.from(await res.arrayBuffer()));
  console.log('  下载完成');
}

const raw = JSON.parse(readFileSync(rawFile, 'utf8'));

/** 保留 2 位小数并去掉尾随 0，进一步压体积 */
const pack = (n) => {
  const r = Math.round(n * 100) / 100;
  return r === (r | 0) ? String(r | 0) : String(r);
};

/**
 * 坐标保留策略：
 *   - 精度 2 位小数
 *   - 去掉相邻重复点（简化后仍保留形状）
 *   - 环内点数 < 4 的直接丢弃（GeoJSON 规范要求 >= 4）
 */
const packRing = (ring) => {
  const out = [];
  let lastLat = null;
  let lastLon = null;
  for (const [lon, lat] of ring) {
    const clampedLon = Math.max(-180, Math.min(180, lon));
    const clampedLat = Math.max(-90, Math.min(90, lat));
    if (clampedLat === lastLat && clampedLon === lastLon) continue;
    out.push(pack(clampedLat), pack(clampedLon));
    lastLat = clampedLat;
    lastLon = clampedLon;
  }
  return out.length >= 8 ? out : null;
};

const features = [];
for (const feature of raw.features) {
  const g = feature.geometry;
  if (!g) continue;

  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polygons) {
    const rings = [];
    for (const ring of poly) {
      const packed = packRing(ring);
      if (packed) rings.push(packed);
    }
    if (rings.length) features.push(rings);
  }
}

// 预计算外包框，渲染时用来做视野裁剪，避免遍历所有环
let minLat = 90;
let maxLat = -90;
let minLon = 180;
let maxLon = -180;
let pointCount = 0;
for (const rings of features) {
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const lat = +ring[i];
      const lon = +ring[i + 1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      pointCount++;
    }
  }
}

const payload = {
  source: 'Natural Earth 110m Land (public domain)',
  bbox: [minLat, minLon, maxLat, maxLon],
  stats: { polygons: features.length, points: pointCount },
  land: features,
};

const banner = `/**
 * land.js — 由 scripts/build-land.mjs 自动生成，请勿手工编辑。
 * 数据来源：Natural Earth 110m Land（公有领域，naturalearthdata.com）
 * 结构：land[polygonIndex][ringIndex] = [lat, lon, lat, lon, ...] 扁平数组
 *        ringIndex 0 = 外环，>0 = 洞（湖泊）
 * 重新生成：node scripts/build-land.mjs
 */
`;

writeFileSync(outFile, `${banner}export const LAND = ${JSON.stringify(payload)};\n`, 'utf8');

const sizeKB = (readFileSync(outFile).length / 1024).toFixed(1);
console.log(`✓ 生成 ${outFile}`);
console.log(`  多边形 ${features.length} 个 · 顶点 ${pointCount} 个`);
console.log(`  体积138 KB → ${sizeKB} KB`);
console.log(`  范围 lat[${minLat.toFixed(1)}, ${maxLat.toFixed(1)}] lon[${minLon.toFixed(1)}, ${maxLon.toFixed(1)}]`);
