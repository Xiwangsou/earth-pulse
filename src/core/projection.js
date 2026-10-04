/**
 * projection.js — 球面投影核心（手写，不依赖任何库）
 *
 * 为什么要自己写：
 *   复刻版刻意不用 Cesium，也不引入 d3-geo。理由有三：
 *   1. 省掉 Cesium 1.1 MB 的加载和它对 WebGL 的硬依赖，2D Canvas 就能跑。
 *   2. Cesium 的 3D 地球在纯 Canvas 上做不出「卫星过境时地面亮起」这种效果，
 *      而这恰恰是我们原创交互的基础 —— 我们要的是「正对着观察者的球面」，
 *      背后是同一套球面几何，自己算反而更可控。
 *   3. 手写投影能精确控制「背面剔除」的边界，这是原创功能的基础。
 *
 * 两种投影：
 *   orthographic（正射）—— 模拟从无穷远看地球，中心点对着你，只有近半球可见。
 *       这是「卫星视角」的正确模型，也是原项目 3D 地球想营造的感觉。
 *   equirectangular（等距圆柱）—— 展开成平面，全球无变形，适合看全球事件分布。
 *
 * 两者共用一个接口 project(lat, lon) -> {x, y, visible}，上层不用关心差异。
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 缩放上下限。倍率下界保证地球不会被缩成一个点，上界防止投影溢出画布。 */
const MIN_SCALE = 20;
const MAX_SCALE = 8000;

/** 经度归一到 [-180, 180) */
export function wrapLon(lon) {
  let v = lon % 360;
  if (v >= 180) v -= 360;
  if (v < -180) v += 360;
  return v;
}

/** 纬度夹到 [-90, 90]，防止极端数据把投影矩阵拉爆 */
export function clampLat(lat) {
  return Math.max(-90, Math.min(90, lat));
}

/**
 * 球面直角坐标 -> 屏幕坐标的基类。
 * 子类只需实现 _project，返回 {x, y}，z 是可见性（用于背面剔除）。
 */
class BaseProjection {
  constructor() {
    this.centerLat = 20;
    this.centerLon = 0;
    this.scale = 200;
  }

  setView({ lat, lon, scale } = {}) {
    // 注意：typeof NaN === 'number'，光判断类型会让 NaN 漏进来。
    // 用 Number.isFinite 同时挡掉 NaN 和 ±Infinity。
    if (Number.isFinite(lat)) this.centerLat = clampLat(lat);
    if (Number.isFinite(lon)) this.centerLon = wrapLon(lon);
    // 缩放必须夹紧：一旦被设成极大值，投影结果会溢出到画布外，
    // 表现是"地图突然消失"，且不会有任何报错，排查起来很费时间。
    if (Number.isFinite(scale)) this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    return this;
  }

  /** 视点是否落在可见半球内（背面剔除，原创功能依赖这个） */
  isVisible(lat, lon) {
    const latR = clampLat(lat) * DEG;
    const lonR = wrapLon(lon - this.centerLon) * DEG;
    const latC = this.centerLat * DEG;
    // 球面点 P 与视点 C 的夹角余弦
    const cosAngle =
      Math.cos(latR) * Math.cos(latC) * Math.cos(lonR) + Math.sin(latR) * Math.sin(latC);
    return cosAngle > 0;
  }

  /** 屏幕坐标：投影 + 平移。canvas 尺寸在 attach 时注入 */
  project(lat, lon) {
    const { x, y, z } = this._project(clampLat(lat), wrapLon(lon - this.centerLon));
    return {
      x: x * this.scale + this.viewportW / 2,
      y: this.viewportH / 2 - y * this.scale,
      visible: z > 0,
      /** 深度 0..1，1 = 正对视线。用于按远近排序和调整亮度 */
      depth: z,
    };
  }

  attach(width, height) {
    this.viewportW = width;
    this.viewportH = height;
  }
}

/**
 * 正射投影（orthographic）
 *
 * 公式（球心为原点，视线沿 -z 方向看向观察者）：
 *   旋转经度差到以本初子午线为轴，再按观察者纬度倾斜。
 *   x = cos(lat) * sin(lonDelta)
 *   y = cos(viewLat) * sin(lat) - sin(viewLat) * cos(lat) * cos(lonDelta)
 *   z = sin(viewLat) * sin(lat) + cos(viewLat) * cos(lat) * cos(lonDelta)  → 即 cos(夹角)
 *
 * z <= 0 表示在背面，直接剔除。这是正射投影的天然优势：不需要额外判断。
 */
export class OrthographicProjection extends BaseProjection {
  _project(lat, lonDelta) {
    const latR = lat * DEG;
    const lonR = lonDelta * DEG;
    const viewR = this.centerLat * DEG;

    const cosLat = Math.cos(latR);
    const sinLat = Math.sin(latR);
    const cosView = Math.cos(viewR);
    const sinView = Math.sin(viewR);
    const cosLon = Math.cos(lonR);
    const sinLon = Math.sin(lonR);

    return {
      x: cosLat * sinLon,
      y: cosView * sinLat - sinView * cosLat * cosLon,
      z: sinView * sinLat + cosView * cosLat * cosLon,
    };
  }

  /** 可见球面上任意一点对应的「比例尺公里数」：用于画比例尺条 */
  kmPerPixel() {
    return (2 * Math.PI * 6371) / (2 * Math.PI * this.scale);
  }
}

/**
 * 等距圆柱投影（equirectangular / plate carrée）
 *
 * x = lonDelta (度)
 * y = lat (度)
 *
 * 变形在赤道附近可忽略，高纬被拉长 —— 但对「看全球事件分布」这个场景
 * 反而更直观：格子和经纬线是直的，做时间轴回溯时视觉噪声小。
 */
export class EquirectangularProjection extends BaseProjection {
  constructor() {
    super();
    this.centerLat = 0;
  }

  _project(lat, lonDelta) {
    return {
      x: lonDelta / 180,
      y: lat / 180,
      // 等距圆柱没有背面概念，全部可见
      z: 1,
    };
  }

  kmPerPixel() {
    // 赤道处 1 像素代表的公里数
    return (2 * Math.PI * 6371) / (2 * 180 * this.scale);
  }
}

/**
 * 晨昏线计算
 *
 * 太阳直射点（太阳赤纬 + 太阳经度）由儒略日推导，然后用它画明暗分界线。
 * 这是我们相对原项目的原创视觉点之一：把「现在几点、哪边是白天」直接
 * 编码到底图上，不需要任何卫星图或光照贴图，纯数学。
 *
 * 参考：NOAA 简化太阳位置公式，公认精度约 ±2 分钟，对可视化足够。
 */

export function toJulian(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/** 太阳位置：返回 {declination(度), rightAscension(度), subsolarLon(度), subsolarLat(度) } */
export function solarPosition(date) {
  const jd = toJulian(date);
  const n = jd - 2451545.0; // 自 J2000.0 起的天数

  // 轨道参数简化式（Laskar）
  const meanLon = (280.460 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const eclipticLon =
    (meanLon + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;

  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLon),
    Math.cos(eclipticLon)
  );

  // 太阳直射经度 = 春分点赤经 - 太阳赤经
  const gmstHours = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
  const subsolarLon = ((gmstHours * 15 - rightAscension * RAD) % 360 + 540) % 360 - 180;

  return {
    declination: declination * RAD,
    subsolarLat: declination * RAD,
    subsolarLon,
  };
}

/**
 * 判断某点是否处于白昼。
 * 做法：算该点与太阳直射点的球面夹角，小于 90° 即为白昼。
 * 边界处（夹角≈90°）就是晨昏线。
 */
export function isSunlit(lat, lon, sun, sunElevationDeg = 6) {
  // 6° 是民用曙暮光界线 —— 这样晨昏线在视觉上有个柔和的过渡带
  const threshold = (90 - sunElevationDeg) * DEG;
  const latR = lat * DEG;
  const lonR = lon * DEG;
  const latS = sun.subsolarLat * DEG;
  const lonS = sun.subsolarLon * DEG;

  const cosAngle =
    Math.sin(latR) * Math.sin(latS) + Math.cos(latR) * Math.cos(latS) * Math.cos(lonR - lonS);
  return Math.acos(Math.max(-1, Math.min(1, cosAngle))) < threshold;
}
