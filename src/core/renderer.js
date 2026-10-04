/**
 * renderer.js — Canvas 2D 渲染器
 *
 * 渲染顺序（从下到上）：
 *   1. 星空背景
 *   2. 球体本体（海洋）
 *   3. 陆地填充 + 海岸线描边
 *   4. 夜面遮罩（晨昏线）
 *   5. 经纬网格
 *   6. 数据图层：地震波纹 / ISS 地面轨迹 / 观测点
 *   7. HUD 叠加（十字准星、比例尺、坐标读数）
 *
 * 性能考量：
 *   - 陆地数据只投影一次并缓存 Path2D，视图没变就不重建
 *   - 60fps 循环里不做字符串拼接、不做数组分配
 *   - 页面不可见时暂停 rAF
 */

import { LAND } from '../../data/land.js';
import { OrthographicProjection, EquirectangularProjection, solarPosition } from './projection.js';
import { magnitudeToRadius, clamp, seededRandom } from './math.js';

export class GlobeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.mode = 'orthographic';
    this.projection = new OrthographicProjection();
    this.autoRotate = true;
    this.rotationSpeed = 1.6; // 度/秒

    this.landCache = null;
    this.landCacheKey = '';

    // 数据状态
    this.quakes = [];
    this.iss = null;
    this.issTrail = [];
    this.observations = [];

    // 交互状态
    this.hover = null;
    this.selected = null;
    this.showGrid = true;
    this.showNight = true;
    this.showTrail = true;

    this._time = Date.now();
    this._sun = solarPosition(new Date());
    this._raf = null;
    this._lastFrame = 0;
    this._onRender = new Set();

    this._bindEvents();
    this.resize();
  }

  onRender(fn) {
    this._onRender.add(fn);
    return () => this._onRender.delete(fn);
  }

  /* ---------------- 尺寸与 DPR ---------------- */

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.width = w;
    this.height = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // 缩放自适应：让地球在窄屏也能完整显示
    const base = this.mode === 'orthographic' ? Math.min(w, h) * 0.42 : Math.min(w / 360, h / 180);
    this.baseScale = base;
    this.projection.attach(w, h);
    this._fitScale();
    this.landCache = null;
  }

  _fitScale() {
    this.projection.scale = this.zoom * this.baseScale;
  }

  /* ---------------- 交互 ---------------- */

  _bindEvents() {
    const canvas = this.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.autoRotate = false;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      if (dragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        const lonDelta = (dx / this.projection.scale) * (180 / Math.PI);
        this.projection.centerLon -= lonDelta;
        const latDelta = (dy / this.projection.scale) * (180 / Math.PI);
        this.projection.centerLat = clamp(this.projection.centerLat + latDelta, -89, 89);
        this.landCache = null;
      }
      this.hover = this._pick(e.clientX - rect.left, e.clientY - rect.top);
      // 提示框要用到鼠标屏幕坐标，一并挂上
      if (this.hover) {
        this.hover.x = e.clientX - rect.left;
        this.hover.y = e.clientY - rect.top;
      }
      canvas.style.cursor = this.hover ? 'pointer' : 'grab';
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* 指针已释放 */
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      endDrag({ pointerId: -1 });
    });

    canvas.addEventListener('click', () => {
      this.selected = this.hover ? this.hover.ref : null;
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 0.92 : 1.087), 0.5, 8);
        this._fitScale();
        this.landCache = null;
      },
      { passive: false }
    );

    // 键盘：无障碍 + 演示友好
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const step = e.shiftKey ? 15 : 5;
      switch (e.key) {
        case 'ArrowLeft':
          this.projection.centerLon -= step;
          this.landCache = null;
          break;
        case 'ArrowRight':
          this.projection.centerLon += step;
          this.landCache = null;
          break;
        case 'ArrowUp':
          this.projection.centerLat = clamp(this.projection.centerLat + step, -89, 89);
          this.landCache = null;
          break;
        case 'ArrowDown':
          this.projection.centerLat = clamp(this.projection.centerLat - step, -89, 89);
          this.landCache = null;
          break;
        case ' ':
          e.preventDefault();
          this.autoRotate = !this.autoRotate;
          break;
        default:
          return;
      }
    });
  }

  /** 命中检测：找出鼠标下的地震或观测点 */
  _pick(px, py) {
    for (const q of this.quakes) {
      const p = this.projection.project(q.lat, q.lon);
      if (!p.visible) continue;
      const r = magnitudeToRadius(q.mag);
      if (Math.hypot(p.x - px, p.y - py) <= r + 4) {
        return { kind: 'quake', ref: q };
      }
    }
    if (this.iss) {
      const p = this.projection.project(this.iss.lat, this.iss.lon);
      if (p.visible && Math.hypot(p.x - px, p.y - py) <= 12) {
        return { kind: 'iss', ref: this.iss };
      }
    }
    return null;
  }

  /* ---------------- 数据注入 ---------------- */

  setQuakes(quakes) {
    this.quakes = quakes;
  }

  setIss(iss) {
    if (iss) {
      this.iss = iss;
      // 维护地面轨迹：只保留最近 N 个点，超过地球周长的部分剪掉
      this.issTrail.push({ lat: iss.lat, lon: iss.lon, at: Date.now() });
      const maxTrail = 240;
      if (this.issTrail.length > maxTrail) this.issTrail.shift();
    } else {
      this.iss = null;
    }
  }

  setObservations(list) {
    this.observations = list;
  }

  setMode(mode) {
    this.mode = mode;
    this.projection =
      mode === 'orthographic' ? new OrthographicProjection() : new EquirectangularProjection();
    this.projection.setView({ lat: this.projection.centerLat, lon: this.projection.centerLon });
    this.resize();
  }

  /* ---------------- 陆地 Path2D 缓存 ---------------- */

  _landPath() {
    const key = `${this.mode}|${this.width}x${this.height}|${this.zoom.toFixed(3)}|${this.projection.centerLat.toFixed(2)}|${(((this.projection.centerLon % 360) + 360) % 360).toFixed(2)}`;
    if (this.landCache && this.landCacheKey === key) return this.landCache;

    const path = new Path2D();
    for (const polygon of LAND.land) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i += 2) {
          const lat = +ring[i];
          const lon = +ring[i + 1];
          const p = this.projection.project(lat, lon);
          if (i === 0) {
            if (p.visible) path.moveTo(p.x, p.y);
            else path.moveTo(-9999, -9999);
          } else if (p.visible) {
            path.lineTo(p.x, p.y);
          }
        }
        path.closePath();
      }
    }
    this.landCache = path;
    this.landCacheKey = key;
    return path;
  }

  /* ---------------- 主渲染 ---------------- */

  start() {
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const dt = this._lastFrame ? (now - this._lastFrame) / 1000 : 0.016;
      this._lastFrame = now;
      this.update(dt);
      this.draw();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  update(dt) {
    this._time = Date.now();
    // 太阳位置每 30 秒重算一次即可，没必要每帧算
    if (!this._lastSunCalc || this._time - this._lastSunCalc > 30000) {
      this._sun = solarPosition(new Date(this._time));
      this._lastSunCalc = this._time;
    }
    if (this.autoRotate && !this.hover) {
      this.projection.centerLon += this.rotationSpeed * dt;
      this.landCache = null;
    }
  }

  draw() {
    const { ctx, width, height } = this;
    this._drawStars();

    if (this.mode === 'orthographic') {
      this._drawSphere();
      this._drawLand();
      if (this.showNight) this._drawNight();
    } else {
      this._drawFlatLand();
    }

    if (this.showGrid) this._drawGrid();
    if (this.showTrail) this._drawIssTrail();
    this._drawQuakes();
    this._drawObservations();
    this._drawIss();
    this._drawOverlay();
    this._drawTooltip();

    for (const fn of this._onRender) fn(this);
  }

  /* ---------- 背景 ---------- */

  _drawStars() {
    const { ctx, width, height } = this;
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#05070f');
    grad.addColorStop(0.5, '#080b16');
    grad.addColorStop(1, '#04060c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // 用固定 seed 的伪随机，保证星星位置每帧一致（不会闪烁）
    const rand = seededRandom(20261004);
    const count = Math.floor((width * height) / 9000);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < count; i++) {
      const x = rand() * width;
      const y = rand() * height;
      const r = rand() * 1.1 + 0.2;
      ctx.globalAlpha = 0.2 + rand() * 0.6;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- 正射：球体 ---------- */

  _drawSphere() {
    const { ctx, width, height } = this;
    const cx = width / 2;
    const cy = height / 2;
    const r = this.projection.scale;

    // 边缘光晕
    const glow = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.14);
    glow.addColorStop(0, 'rgba(56,189,248,0)');
    glow.addColorStop(0.55, 'rgba(56,189,248,0.16)');
    glow.addColorStop(1, 'rgba(56,189,248,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.14, 0, Math.PI * 2);
    ctx.fill();

    // 海洋：深蓝径向渐变，边缘稍亮制造球感
    const ocean = ctx.createRadialGradient(
      cx - r * 0.25, cy - r * 0.3, r * 0.08,
      cx, cy, r
    );
    ocean.addColorStop(0, '#0d2740');
    ocean.addColorStop(0.62, '#0a1c30');
    ocean.addColorStop(0.92, '#071524');
    ocean.addColorStop(1, '#04101c');
    ctx.fillStyle = ocean;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---------- 陆地 ---------- */

  _drawLand() {
    const { ctx } = this;
    const path = this._landPath();
    // evenodd 让洞（湖泊）正确镂空
    ctx.fillStyle = '#16324a';
    ctx.fill(path, 'evenodd');
    ctx.strokeStyle = 'rgba(94,234,212,0.45)';
    ctx.lineWidth = 0.7;
    ctx.stroke(path);
  }

  /** 等距圆柱模式：陆地直接铺满，无球体 */
  _drawFlatLand() {
    const { ctx, width, height } = this;
    ctx.fillStyle = '#081726';
    ctx.fillRect(0, 0, width, height);
    const path = this._landPath();
    ctx.fillStyle = '#16324a';
    ctx.fill(path, 'evenodd');
    ctx.strokeStyle = 'rgba(94,234,212,0.4)';
    ctx.lineWidth = 0.6;
    ctx.stroke(path);
  }

  /* ---------- 夜面遮罩（晨昏线） ---------- */

  _drawNight() {
    const { ctx, width, height } = this;
    const R = this.projection.scale;
    const cx = width / 2;
    const cy = height / 2;
    const sun = this._sun;

    // 做法：铺满半透明黑，再用「日照区」destination-out 擦出亮面。
    // 边界用 shadowBlur 做柔化，得到柔和的晨昏线（不是硬边）。
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(0,4,12,0.62)';
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    ctx.globalCompositeOperation = 'destination-out';
    // 沿晨昏线采样 180 个点，用小圆擦出亮面，圆越大过渡越柔
    const step = 2;
    ctx.fillStyle = '#000';
    for (let t = 0; t <= 360; t += step) {
      // 求晨昏线上纬度(lat)对应的点：解球面三角
      const decl = sun.subsolarLat * (Math.PI / 180);
      const h = t * (Math.PI / 180);
      const lat = Math.atan(-Math.cos(h) / Math.tan(decl || 1e-6)) * (180 / Math.PI);
      const lon = sun.subsolarLon + t;
      const p = this.projection.project(lat, lon);
      if (!p.visible) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 太阳直射点标记
    const sp = this.projection.project(sun.subsolarLat, sun.subsolarLon);
    if (sp.visible) {
      ctx.save();
      ctx.strokeStyle = 'rgba(251,191,36,0.8)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
      ctx.moveTo(sp.x - 12, sp.y);
      ctx.lineTo(sp.x - 9, sp.y);
      ctx.moveTo(sp.x + 9, sp.y);
      ctx.lineTo(sp.x + 12, sp.y);
      ctx.moveTo(sp.x, sp.y - 12);
      ctx.lineTo(sp.x, sp.y - 9);
      ctx.moveTo(sp.x, sp.y + 9);
      ctx.lineTo(sp.x, sp.y + 12);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------- 经纬网格 ---------- */

  _drawGrid() {
    const { ctx, width, height } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(148,197,255,0.1)';
    ctx.lineWidth = 0.5;

    // 正射模式只画可见半球的网格，否则线条会溢出球外
    const isOrtho = this.mode === 'orthographic';
    const R = this.projection.scale;

    for (let lat = -80; lat <= 80; lat += 20) {
      ctx.beginPath();
      let started = false;
      for (let lon = -180; lon <= 180; lon += 4) {
        const p = this.projection.project(lat, lon);
        if (isOrtho && (!p.visible || Math.hypot(p.x - width / 2, p.y - height / 2) > R + 1)) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    for (let lon = -180; lon < 180; lon += 20) {
      ctx.beginPath();
      let started = false;
      for (let lat = -90; lat <= 90; lat += 4) {
        const p = this.projection.project(lat, lon);
        if (isOrtho && (!p.visible || Math.hypot(p.x - width / 2, p.y - height / 2) > R + 1)) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- 地震波纹 ---------- */

  _drawQuakes() {
    const { ctx } = this;
    const now = this._time;

    for (const q of this.quakes) {
      const p = this.projection.project(q.lat, q.lon);
      if (!p.visible) continue;

      const age = now - q.at;
      const isNew = age < 3600_000;
      // 波纹：1 小时内的新事件持续扩散，之后保留一个静态标记
      if (isNew) {
        const t = age / 3600_000;
        const rings = 2;
        for (let i = 0; i < rings; i++) {
          const rt = (t + i / rings) % 1;
          const r = magnitudeToRadius(q.mag) + rt * 46;
          const alpha = 0.5 * (1 - rt);
          if (alpha <= 0.01) continue;
          ctx.strokeStyle = `rgba(248,113,113,${alpha.toFixed(3)})`;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      const r = magnitudeToRadius(q.mag);
      const isSel = this.selected && this.selected.id === q.id;
      const isHov = this.hover && this.hover.kind === 'quake' && this.hover.ref.id === q.id;

      // 震级越大越红越大
      const hue = q.mag >= 6 ? 0 : q.mag >= 5 ? 18 : q.mag >= 4 ? 32 : 45;
      ctx.fillStyle = `hsla(${hue}, 92%, ${isSel || isHov ? 68 : 58}%, ${0.9})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = isSel || isHov
        ? 'rgba(255,255,255,0.95)'
        : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = isSel || isHov ? 1.8 : 0.8;
      ctx.stroke();

      if (isSel || isHov) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(`${q.mag.toFixed(1)} · ${q.place || ''}`.slice(0, 46), p.x + r + 6, p.y + 4);
      }
    }
  }

  /* ---------- ISS 地面轨迹 ---------- */

  _drawIssTrail() {
    if (this.issTrail.length < 2) return;
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = 1.2;
    let started = false;
    ctx.beginPath();
    for (const pt of this.issTrail) {
      const p = this.projection.project(pt.lat, pt.lon);
      if (!p.visible) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else ctx.lineTo(p.x, p.y);
    }
    const grad = ctx.createLinearGradient(0, 0, this.width, 0);
    grad.addColorStop(0, 'rgba(56,189,248,0.05)');
    grad.addColorStop(1, 'rgba(56,189,248,0.6)');
    ctx.strokeStyle = grad;
    ctx.stroke();
    ctx.restore();
  }

  _drawIss() {
    if (!this.iss) return;
    const { ctx } = this;
    const p = this.projection.project(this.iss.lat, this.iss.lon);
    if (!p.visible) return;

    // 地面足迹
    const fpKm = this.iss.footprint || 4496;
    const footR = (fpKm / this.projection.kmPerPixel()) * 0.5;
    if (footR > 4 && footR < this.width) {
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, footR);
      g.addColorStop(0, 'rgba(56,189,248,0.22)');
      g.addColorStop(1, 'rgba(56,189,248,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, footR, 0, Math.PI * 2);
      ctx.fill();
    }

    const isHov = this.hover && this.hover.kind === 'iss';
    ctx.fillStyle = isHov ? '#e0f2fe' : '#7dd3fc';
    ctx.beginPath();
    ctx.arc(p.x, p.y, isHov ? 5.5 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 十字丝
    ctx.strokeStyle = 'rgba(125,211,252,0.5)';
    ctx.beginPath();
    ctx.moveTo(p.x - 10, p.y);
    ctx.lineTo(p.x - 6, p.y);
    ctx.moveTo(p.x + 6, p.y);
    ctx.lineTo(p.x + 10, p.y);
    ctx.moveTo(p.x, p.y - 10);
    ctx.lineTo(p.x, p.y - 6);
    ctx.moveTo(p.x, p.y + 6);
    ctx.lineTo(p.x, p.y + 10);
    ctx.stroke();

    ctx.fillStyle = 'rgba(186,230,253,0.85)';
    ctx.font = '500 10px ui-monospace, monospace';
    ctx.fillText('ISS', p.x + 12, p.y - 8);
  }

  /* ---------- 本地观测点 ---------- */

  _drawObservations() {
    const { ctx } = this;
    // 先画非主站点（暗淡），再画主站点（突出），保证主站点不被压住
    const ordered = [
      ...this.observations.filter((o) => !o.primary),
      ...this.observations.filter((o) => o.primary),
    ];

    for (const obs of ordered) {
      const p = this.projection.project(obs.lat, obs.lon);
      if (!p.visible) continue;

      const isPrimary = Boolean(obs.primary);
      const color = obs.color || '#34d399';

      if (isPrimary) {
        // 主站点：实心 + 外环 + 十字丝，一眼锁定当前位置
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - 15, p.y);
        ctx.lineTo(p.x - 6, p.y);
        ctx.moveTo(p.x + 6, p.y);
        ctx.lineTo(p.x + 15, p.y);
        ctx.moveTo(p.x, p.y - 15);
        ctx.lineTo(p.x, p.y - 6);
        ctx.moveTo(p.x, p.y + 6);
        ctx.lineTo(p.x, p.y + 15);
        ctx.stroke();
      }

      ctx.globalAlpha = isPrimary ? 1 : 0.45;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isPrimary ? 3.8 : 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = isPrimary ? color : 'rgba(226,232,240,0.7)';
      ctx.font = isPrimary ? '500 11px ui-sans-serif, system-ui, sans-serif' : '400 9.5px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(obs.label, p.x + (isPrimary ? 18 : 5), p.y + 3);
      ctx.globalAlpha = 1;
    }
  }

  /* ---------- HUD 叠加 ---------- */

  _drawOverlay() {
    const { ctx, width, height } = this;
    ctx.save();

    // 比例尺：动态换算公里数，取整到好看的数
    const kmPerPx = this.projection.kmPerPixel();
    const targetPx = 110;
    const rawKm = kmPerPx * targetPx;
    const pow = Math.pow(10, Math.floor(Math.log10(rawKm)));
    const niceKm = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= rawKm) || pow * 10;
    const barPx = niceKm / kmPerPx;

    const x0 = 18;
    const y0 = height - 22;
    ctx.strokeStyle = 'rgba(226,232,240,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 4);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + barPx, y0);
    ctx.lineTo(x0 + barPx, y0 - 4);
    ctx.stroke();
    ctx.fillStyle = 'rgba(226,232,240,0.8)';
    ctx.font = '400 10px ui-monospace, monospace';
    ctx.fillText(`${niceKm >= 1000 ? (niceKm / 1000).toFixed(0) + ',000' : niceKm} km`, x0, y0 - 7);

    // 视点读数
    ctx.fillStyle = 'rgba(148,197,255,0.75)';
    ctx.font = '400 11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    const lon = ((this.projection.centerLon % 360) + 540) % 360 - 180;
    ctx.fillText(
      `${Math.abs(this.projection.centerLat).toFixed(1)}°${this.projection.centerLat >= 0 ? 'N' : 'S'}  ` +
        `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}  ·  z${this.zoom.toFixed(1)}`,
      width - 18,
      22
    );
    ctx.fillText(
      `直射点 ${Math.abs(this._sun.subsolarLat).toFixed(1)}°${this._sun.subsolarLat >= 0 ? 'N' : 'S'}  ` +
        `${Math.abs(this._sun.subsolarLon).toFixed(1)}°${this._sun.subsolarLon >= 0 ? 'E' : 'W'}`,
      width - 18,
      38
    );
    ctx.textAlign = 'left';
    ctx.restore();
  }

  _drawTooltip() {
    if (!this.hover) return;
    const { ctx } = this;
    const text = this.hover.kind === 'quake'
      ? `M ${this.hover.ref.mag?.toFixed(1)} · ${this.hover.ref.place || '未知区域'}`
      : `ISS · 高度 ${Math.round(this.hover.ref.altitude || 0)} km`;

    ctx.save();
    ctx.font = '400 12px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(text).width;
    const x = clamp(this.hover.x + 14, 8, this.width - w - 24);
    const y = clamp(this.hover.y - 30, 8, this.height - 34);
    ctx.fillStyle = 'rgba(8,12,20,0.92)';
    ctx.strokeStyle = 'rgba(148,197,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w + 16, 24, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(text, x + 8, y + 16);
    ctx.restore();
  }
}

// 挂在 prototype 上供命中检测用
GlobeRenderer.prototype.zoom = 1;
