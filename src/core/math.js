/**
 * math.js — 数值工具
 */

/** 线性插值 */
export const lerp = (a, b, t) => a + (b - a) * t;

/** 限制在区间内 */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 角度差最短路径插值。
 * 关键：经度跨越 180° 时不能直接 lerp，否则会「绕地球一圈」。
 * 比如 179° → -179°，实际只差 2°，但线性插值会走过 358°。
 */
export function lerpAngleDeg(a, b, t) {
  let diff = ((b - a + 540) % 360) - 180;
  return a + diff * t;
}

/** 缓动函数：easeOutCubic，收尾平滑 */
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** 帧率无关的指数平滑：无论 30fps 还是 144fps，收敛速度一致 */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** 把值从一个区间映射到另一个区间 */
export const mapRange = (v, inLo, inHi, outLo, outHi) =>
  outLo + ((v - inLo) / (inHi - inLo)) * (outHi - outLo);

/**
 * 大圆距离（公里）
 * 用于地震「这次事件和刚才那次相隔多远」这类空间分析。
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 确定性伪随机：同一个 seed 永远给同一个数，保证地图纹理不闪烁 */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 地震震级 → 视觉半径的对数映射（震级差一级能量差约 31.6 倍，必须用对数） */
export function magnitudeToRadius(mag, base = 3, min = 3, max = 34) {
  const m = Math.max(0, mag || 0);
  return clamp(min + (m - base) * (max - min) / 6, min, max);
}
