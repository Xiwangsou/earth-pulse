/**
 * panels.js — 侧栏数据面板
 *
 * 布局刻意做成「飞行器仪表」风格：等宽数字、单位后置、
 * 不用花哨的图表库。信息密度优先 —— 观测工具首先要能一眼读数。
 */

import { SITES, DEFAULT_SITE } from './sites.js';

export { SITES };

export class SidePanel {
  constructor(root) {
    this.root = root;
    this.root.className = 'panel';
    this.activeSite = DEFAULT_SITE;
  }

  setSite(site) {
    this.activeSite = site;
  }

  update({ weather, air, iss, states, issVisible }) {
    const w = weather;
    const a = air;
    const issData = iss;

    const wDesc = w ? w.desc[0] : '无数据';
    const wind = w ? require_wind(w.windSpeed) : ['无数据', 0];
    const aqi = a ? aqiInfo(a.aqi) : { label: '无数据', color: '#64748b' };

    this.root.innerHTML = `
      <section class="pnl">
        <div class="pnl-head">
          <h3>观测城市</h3>
          <span class="site-current">${this.activeSite.label}</span>
        </div>
        <div class="site-grid">
          ${SITES.map((s) => `<button type="button" data-site="${s.id}" title="${s.region}"
            class="${s.id === this.activeSite.id ? 'on' : ''}">${s.label}</button>`).join('')}
        </div>
      </section>

      <section class="pnl">
        <div class="pnl-head">
          <h3>${this.activeSite.label} 实况</h3>
          <span class="site-coord">${this.activeSite.lat.toFixed(1)}°N ${this.activeSite.lon.toFixed(1)}°E</span>
        </div>
        <div class="pnl-grid">
          <div class="metric metric-lg">
            <b>${w ? w.temp.toFixed(1) : '--'}</b><span>气温 °C</span>
          </div>
          <div class="metric">
            <b>${w ? w.feels.toFixed(1) : '--'}</b><span>体感 °C</span>
          </div>
          <div class="metric">
            <b>${wDesc}</b><span>天气</span>
          </div>
          <div class="metric">
            <b>${wind[0]}</b><span>风力 ${w ? w.windSpeed.toFixed(0) : '--'} km/h</span>
          </div>
          <div class="metric">
            <b>${w ? w.humidity.toFixed(0) : '--'}</b><span>湿度 %</span>
          </div>
          <div class="metric">
            <b>${w ? w.pressure.toFixed(0) : '--'}</b><span>气压 hPa</span>
          </div>
        </div>
      </section>

      <section class="pnl">
        <h3>空气质量</h3>
        <div class="aqi-row">
          <div class="aqi-badge" style="--c:${aqi.color}">
            <b>${a ? Math.round(a.aqi) : '--'}</b><span>欧洲 AQI</span>
          </div>
          <div class="aqi-level" style="color:${aqi.color}">${aqi.label}</div>
        </div>
        <div class="pnl-grid pnl-grid-3">
          <div class="metric"><b>${a ? a.pm25.toFixed(0) : '--'}</b><span>PM2.5</span></div>
          <div class="metric"><b>${a ? a.pm10.toFixed(0) : '--'}</b><span>PM10</span></div>
          <div class="metric"><b>${a ? a.o3.toFixed(0) : '--'}</b><span>O₃</span></div>
        </div>
      </section>

      <section class="pnl">
        <div class="pnl-head">
          <h3>国际空间站</h3>
          <span class="badge ${issVisible ? 'badge-live' : ''}">${issVisible ? '头顶可见' : '不可见'}</span>
        </div>
        <div class="pnl-grid">
          <div class="metric metric-lg">
            <b>${issData ? Math.round(issData.altitude) : '--'}</b><span>高度 km</span>
          </div>
          <div class="metric">
            <b>${issData ? (issData.velocity / 36000).toFixed(2) : '--'}</b><span>速度 km/s</span>
          </div>
        </div>
        <div class="pnl-coords">
          <span>${issData ? `${fmtDeg(issData.lat)} ${fmtDeg(issData.lon)}` : '--'}</span>
          <span class="dim">足迹 ${issData ? Math.round(issData.footprint) : '--'} km</span>
        </div>
      </section>

      <section class="pnl">
        <h3>数据源状态</h3>
        <ul class="src-list">
          ${Object.entries(states).map(([k, s]) => `
            <li class="src-${s.status}">
              <span class="src-dot"></span>
              <span class="src-name">${srcLabel(k)}</span>
              <span class="src-state">${statusText(s)}</span>
            </li>`).join('')}
        </ul>
      </section>
    `;

    // 站点切换
    this.root.querySelectorAll('[data-site]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const site = SITES.find((s) => s.id === btn.dataset.site);
        if (site) this.onSiteChange?.(site);
      });
    });
  }
}

// 避免顶部 import 冲突：小工具函数集中在这里
function require_wind(speedKmh) {
  const s = speedKmh ?? 0;
  if (s < 1) return ['静风', 0];
  if (s < 6) return ['软风', 1];
  if (s < 12) return ['轻风', 2];
  if (s < 20) return ['微风', 3];
  if (s < 29) return ['和风', 4];
  if (s < 39) return ['清劲风', 5];
  if (s < 50) return ['强风', 6];
  if (s < 62) return ['疾风', 7];
  return ['大风', 8];
}

function aqiInfo(aqi) {
  if (aqi == null) return { label: '无数据', color: '#64748b' };
  if (aqi <= 20) return { label: '优', color: '#4ade80' };
  if (aqi <= 40) return { label: '良', color: '#a3e635' };
  if (aqi <= 60) return { label: '中等', color: '#facc15' };
  if (aqi <= 80) return { label: '较差', color: '#fb923c' };
  return { label: '极差', color: '#f87171' };
}

const fmtDeg = (v) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`;

const SRC_LABELS = {
  usgs: 'USGS 地震',
  weather: 'Open-Meteo 气象',
  air: 'Open-Meteo 空气',
  iss: 'ISS 位置',
};
const srcLabel = (k) => SRC_LABELS[k] || k;

function statusText(s) {
  switch (s.status) {
    case 'ok':
      return s.lastOkAt ? `${Math.round((Date.now() - s.lastOkAt) / 1000)}s 前` : '正常';
    case 'loading':
      return '拉取中';
    case 'stale':
      return s.staleSince != null ? `缓存 ${Math.round(s.staleSince / 60000)} 分钟` : '降级中';
    case 'error':
      return '失败';
    default:
      return '待命';
  }
}
