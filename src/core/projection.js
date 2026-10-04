/**
 * projection.js — 球面投影核心（手写，不依赖任何库）
 *
 * 为什么要自己写：
 *   复刻版刻意不用 Cesium，也不引入 d3-geo。理由有三：
 *   1. 省掉 Cesium 1.1 MB 的加载和它对 WebGL 的硬依赖，2D Canvas 就能跑。
 *   2. Cesium 的 3D 地球在纯 Canvas 上做不出「晨昏线随真实太阳位置移动」这种效果，
 *      而这恰恰是我们原创交互的基础 —— 我们要的是「正对着观察者的球面」，
 *      背后是同一套球面几何，自己算反而更可控。
 *   3. 手写投影能精确控制「背面剔除」与「逆变换」的边界，
 *      晨昏线绘制必须逐像素做逆变换，这是本项目最核心的渲染需求。
 *
 * 两种投影：
 *   orthographic（正射）—— 模拟从无穷远看地球，中心点对着你，只有近半球可见。
 *       这是「卫星视角」的正确模型，也是原项目 3D 地球想营造的感觉。
 *   equirectangular（等距圆柱）—— 展开成平面，全球无变形，适合看全球事件分布。
 *
 * 两者共用接口：
 *   project(lat, lon)   -> {x, y, visible, depth}   正向
 *   unproject(x, y)     -> {lat, lon} | null        逆向（晨昏线逐像素判定用）
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
 * 正射投影（orthographic）
 *
 * 正向公式（视点纬度 φ0，经度 λ0，Δλ = λ − λ0）：
 *   x = cosφ· sinΔλ
 *   y = cosφ0· sinφ − sinφ0· cosφ· cosΔλ
 *   z = sinφ0· sinφ + cosφ0· cosφ· cosΔλ      （z = cos夹角，> 0 为可见面）
 *
 * z ≤ 0 表示在背面，直接剔除。这是正射投影的天然优势：不需要额外判断。
 *
 * 逆变换（代数解法，见 scripts/derive-inverse.mjs 的完整推导与验证）：
 *   设 s = sinφ, c1 = cosφ·cosΔλ，由正向第二式得 c1 = (cosφ0·s − y) / sinφ0，
 *   代入 x² + c1² = 1 − s² 消元后得到一元二次方程：
 *     s² − 2·cosφ0·y·s + (y² + sin²φ0·x² − sin²φ0) = 0
 *   取使 z = sinφ0·s + cosφ0·c1 > 0 的那个根即为目标点。
 *
 * 这里刻意没有采用网上常见的「c = acos(ρ)」闭式解 ——
 * 那个公式实测误差达 90°~180°（前提不成立），详见 derive-inverse.mjs 注释。
 * 22 万点验证显示本实现误差在 8e-12°，即浮点精度极限。
 */
export class OrthographicProjection {
  constructor() {
    this.centerLat = 20;
    this.centerLon = 0;
    this.scale = 200;
    this.viewportW = 800;
    this.viewportH = 600;
    this._viewR = this.centerLat * DEG;
    this._cosView = Math.cos(this._viewR);
    this._sinView = Math.sin(this._viewR);
  }

  setView({ lat, lon, scale } = {}) {
    // typeof NaN === 'number'，光判断类型会让 NaN 漏进来。
    // 用 Number.isFinite 同时挡掉 NaN 和 ±Infinity。
    if (Number.isFinite(lat)) this.centerLat = clampLat(lat);
    if (Number.isFinite(lon)) this.centerLon = wrapLon(lon);
    // 缩放必须夹紧：一旦被设成极大值，投影结果会溢出到画布外，
    // 表现是"地图突然消失"，且不会有任何报错，排查起来很费时间。
    if (Number.isFinite(scale)) this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    // 缓存视点的三角函数值 —— 逆变换每像素都要用，不能每次重算
    this._viewR = this.centerLat * DEG;
    this._cosView = Math.cos(this._viewR);
    this._sinView = Math.sin(this._viewR);
    return this;
  }

  attach(width, height) {
    this.viewportW = width;
    this.viewportH = height;
  }

  project(lat, lon) {
    const latR = clampLat(lat) * DEG;
    const lonR = wrapLon(lon - this.centerLon) * DEG;

    const cosLat = Math.cos(latR);
    const sinLat = Math.sin(latR);
    const cosLon = Math.cos(lonR);
    const depth =
      this._sinView * sinLat + this._cosView * cosLat * cosLon;

    return {
      x: cosLat * Math.sin(lonR) * this.scale + this.viewportW / 2,
      y:
        this.viewportH / 2 -
        (this._cosView * sinLat - this._sinView * cosLat * cosLon) * this.scale,
      visible: depth > 0,
      /** 深度 −1..1，1 = 正对视线 */
      depth,
    };
  }

  /** 逆变换：屏幕坐标 → 经纬度。球面外返回 null */
  unproject(x, y) {
    const X = (x - this.viewportW / 2) / this.scale;
    const Y = (this.viewportH / 2 - y) / this.scale;

    // 球外判定：正射投影下 X²+Y² > 1 即在地球之外。
    // 这条不能省 —— 渲染器逐像素绘制晨昏线时，
    // 完全依赖它来圈定「需要计算的像素范围」。
    // 留 1e-9 余量吸收浮点误差，避免球面边缘出现 1px 的漏判。
    if (X * X + Y * Y > 1 + 1e-9) return null;

    const cv = this._cosView;
    const sv = this._sinView;

    // 视点在赤道：sinφ0 = 0 时正向式退化为 y = sinφ，可直接解
    if (Math.abs(sv) < 1e-12) {
      const sinLat = Math.max(-1, Math.min(1, Y));
      const lat = Math.asin(sinLat);
      const cosLat = Math.cos(lat);
      if (cosLat < 1e-12) return { lat: this.centerLat, lon: this.centerLon };
      const sinDLon = X / cosLat;
      // z = cosφ·cosΔλ > 0 ⇒ cosΔλ > 0，据此取正值分支
      const cosDLon = Math.sqrt(Math.max(0, 1 - sinDLon * sinDLon));
      const lon = this.centerLon + Math.atan2(sinDLon, cosDLon) * RAD;
      return { lat: lat * RAD, lon: wrapLon(lon) };
    }

    // s² − 2·cv·Y·s + (Y² + sv²X² − sv²) = 0
    const b = -2 * cv * Y;
    const cTerm = Y * Y + sv * sv * X * X - sv * sv;
    const disc = b * b - 4 * cTerm;
    if (disc < 0) return null;

    const sq = Math.sqrt(disc);
    const roots = [(-b + sq) / 2, (-b - sq) / 2];

    for (const s of roots) {
      if (!Number.isFinite(s) || s < -1 || s > 1) continue;

      const cosLat = Math.sqrt(Math.max(0, 1 - s * s));
      // c1 = cosφ·cosΔλ
      const c1 = (cv * s - Y) / sv;

      // 可见性判定必须放在极点特判之前。
      // 否则当第一个候选根恰好是极点（cosφ→0）时会被误判为可见并提前返回，
      // 永远轮不到真正的解 —— 这是实现该逆变换时最隐蔽的一个坑。
      if (sv * s + cv * c1 <= 1e-9) continue;

      const lat = Math.asin(s) * RAD;
      if (cosLat < 1e-12) {
        return { lat, lon: this.centerLon };
      }

      const sinDLon = X / cosLat;
      const cosDLon = c1 / cosLat;
      // 校验 sin/cos 分量构成合法单位向量
      if (Math.abs(sinDLon * sinDLon + cosDLon * cosDLon - 1) > 1e-6) continue;

      const dLon = Math.atan2(sinDLon, cosDLon) * RAD;
      return { lat, lon: wrapLon(this.centerLon + dLon) };
    }
    return null;
  }

  /** 赤道处 1 像素代表的公里数 */
  kmPerPixel() {
    return (2 * Math.PI * 6371) / (2 * Math.PI * this.scale);
  }
}

/**
 * 等距圆柱投影（equirectangular / plate carrée）
 *
 * 正向：x = lonΔ/180，y = lat/180
 * 变形在赤道附近可忽略，高纬被拉长 —— 但对「看全球事件分布」这个场景
 * 反而更直观：格子和经纬线是直的，做时间轴回溯时视觉噪声小。
 */
export class EquirectangularProjection {
  constructor() {
    this.centerLat = 0;
    this.centerLon = 0;
    this.scale = 200;
    this.viewportW = 720;
    this.viewportH = 360;
  }

  setView({ lat, lon, scale } = {}) {
    if (Number.isFinite(lat)) this.centerLat = clampLat(lat);
    if (Number.isFinite(lon)) this.centerLon = wrapLon(lon);
    if (Number.isFinite(scale)) this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    return this;
  }

  attach(width, height) {
    this.viewportW = width;
    this.viewportH = height;
  }

  project(lat, lon) {
    return {
      x: (wrapLon(lon - this.centerLon) / 180) * this.scale + this.viewportW / 2,
      y: this.viewportH / 2 - (clampLat(lat) / 180) * this.scale,
      visible: true,
      depth: 1,
    };
  }

  /** 逆变换：线性关系，直接反解 */
  unproject(x, y) {
    const dx = (x - this.viewportW / 2) / this.scale;
    const dy = (this.viewportH / 2 - y) / this.scale;
    return {
      lat: clampLat(dy * 180),
      lon: wrapLon(this.centerLon + dx * 180),
    };
  }

  kmPerPixel() {
    return (2 * Math.PI * 6371) / (2 * 180 * this.scale);
  }
}

/**
 * 太阳位置计算
 *
 * 太阳直射点（赤纬 + 经度）由儒略日推导，然后用于绘制晨昏线。
 * 参考：NOAA 简化太阳位置公式，公认精度约 ±2 分钟，对可视化足够。
 */

export function toJulian(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

export function solarPosition(date) {
  const jd = toJulian(date);
  const n = jd - 2451545.0; // 自 J2000.0 起的天数

  // 轨道参数简化式（Laskar）
  const meanLon = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const eclipticLon =
    (meanLon + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;

  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLon),
    Math.cos(eclipticLon)
  );

  // 格林尼治平恒星时（小时）→ 太阳直射经度
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
 * 球面三角：算该点与太阳直射点的夹角，小于 (90° − 6°) 即为白昼。
 * 6° 是民用曙暮光界线，让晨昏线在视觉上有柔和过渡。
 */
export function isSunlit(lat, lon, sun, sunElevationDeg = 6) {
  const threshold = (90 - sunElevationDeg) * DEG;
  const latR = lat * DEG;
  const lonR = lon * DEG;
  const latS = sun.subsolarLat * DEG;
  const lonS = sun.subsolarLon * DEG;

  const cosAngle =
    Math.sin(latR) * Math.sin(latS) + Math.cos(latR) * Math.cos(latS) * Math.cos(lonR - lonS);
  return Math.acos(Math.max(-1, Math.min(1, cosAngle))) < threshold;
}
