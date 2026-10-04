/**
 * timeline-ui.js — 时间轴回溯控件（核心原创交互）
 *
 * 界面构成：
 *   [时间刻度条=====================|]  ← 可拖动的滑块
 *   LIVE  ← 回到实时
 *
 * 与原项目的根本差异：
 *   原项目的数据是单向实时流，无法回看。
 *   这里把时间变成了一根可拖动的轴 —— 拖到 3 小时前，
 *   地图上显示的地震波纹会「重新扩散」一遍（因为波纹状态是由
 *   「当前回溯时刻 - 事件发生时刻」实时算出来的，不是录下来的）。
 *
 * 视觉上刻意做成音频设备的走带样式，暗示「你可以反复回放」。
 */

import { Timeline } from '../core/timeline.js';

export class TimelineBar {
  constructor(root, timeline, { onSeek } = {}) {
    this.timeline = timeline;
    this.onSeek = onSeek;
    this.root = root;
    this.dragging = false;
    this._build();
    timeline.onChange(() => this.sync());
  }

  _build() {
    this.root.className = 'timeline';
    this.root.innerHTML = `
      <button class="tl-live" type="button" title="回到实时（快捷键 L）">
        <span class="tl-live-dot"></span>LIVE
      </button>
      <div class="tl-track" role="slider" tabindex="0"
           aria-label="时间轴" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
        <div class="tl-fill"></div>
        <div class="tl-head"></div>
      </div>
      <div class="tl-readout">
        <span class="tl-date"></span>
        <span class="tl-delta"></span>
      </div>
    `;
    this.liveBtn = this.root.querySelector('.tl-live');
    this.track = this.root.querySelector('.tl-track');
    this.fill = this.root.querySelector('.tl-fill');
    this.head = this.root.querySelector('.tl-head');
    this.dateEl = this.root.querySelector('.tl-date');
    this.deltaEl = this.root.querySelector('.tl-delta');

    this.liveBtn.addEventListener('click', () => {
      this.timeline.live();
      this._emit();
    });

    // 拖动
    const posToTime = (clientX) => {
      const rect = this.track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const [from, to] = this.timeline.range();
      return from + ratio * (to - from);
    };

    this.track.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.track.setPointerCapture(e.pointerId);
      this.timeline.seek(posToTime(e.clientX));
      this._emit();
    });
    this.track.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.timeline.seek(posToTime(e.clientX));
      this._emit();
    });
    const stop = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      try {
        this.track.releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放 */
      }
    };
    this.track.addEventListener('pointerup', stop);
    this.track.addEventListener('pointercancel', stop);

    // 键盘可达性
    this.track.addEventListener('keydown', (e) => {
      const [from, to] = this.timeline.range();
      const span = to - from;
      const cur = this.timeline.cursor ?? to;
      const step = span / 40;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.timeline.seek(Math.max(from, cur - step));
        this._emit();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.timeline.seek(Math.min(to, cur + step));
        this._emit();
      } else if (e.key === 'Home') {
        this.timeline.seek(from);
        this._emit();
      } else if (e.key === 'End') {
        this.timeline.live();
        this._emit();
      }
    });
  }

  _emit() {
    this.sync();
    this.onSeek?.(this.timeline.cursor);
  }

  sync() {
    const [from, to] = this.timeline.range();
    const span = Math.max(1, to - from);
    const cur = this.timeline.cursor ?? to;
    const ratio = Math.max(0, Math.min(1, (cur - from) / span));

    this.fill.style.width = `${ratio * 100}%`;
    this.head.style.left = `${ratio * 100}%`;

    const isLive = this.timeline.isLive;
    this.liveBtn.classList.toggle('is-active', isLive);
    this.root.classList.toggle('is-replay', !isLive);
    this.track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));

    const d = new Date(cur);
    const pad = (n) => String(n).padStart(2, '0');
    this.dateEl.textContent =
      `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    if (isLive) {
      this.deltaEl.textContent = '';
    } else {
      const mins = Math.round((Date.now() - cur) / 60000);
      this.deltaEl.textContent = mins >= 60 ? `回溯 ${(mins / 60).toFixed(1)} 小时` : `回溯 ${mins} 分钟`;
    }
  }
}

/**
 * StatsPanel — 事件统计面板
 *
 * 这个面板让项目从「实时看板」变成「可分析的工具」：
 * 不是告诉你现在发生了什么，而是让你看到一段时间内的分布规律。
 * 数据全部来自快照缓存，实时计算。
 */
export class StatsPanel {
  constructor(root) {
    this.root = root;
    this.root.className = 'stats';
  }

  update(stats, timeline, now) {
    if (!stats || stats.total === 0) {
      this.root.innerHTML = `
        <div class="stats-empty">窗口内暂无 M${this.minMag || 2.5}+ 事件</div>`;
      return;
    }

    const maxDayCount = Math.max(...stats.byDay.map((d) => d[1]), 1);
    const dayRows = stats.byDay
      .map(([day, count]) => {
        const pct = (count / maxDayCount) * 100;
        return `<div class="stats-bar-row">
          <span class="stats-bar-label">${day.slice(5)}</span>
          <div class="stats-bar"><div class="stats-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <span class="stats-bar-value">${count}</span>
        </div>`;
      })
      .join('');

    const regionRows = stats.topRegions
      .map(([name, count]) => `<li><span>${escapeHtml(name)}</span><b>${count}</b></li>`)
      .join('');

    this.root.innerHTML = `
      <div class="stats-head">
        <h3>事件回溯统计</h3>
        <span class="stats-window">${timeline.isLive ? '实时窗口' : '回溯窗口'}</span>
      </div>
      <div class="stats-kpis">
        <div class="kpi"><b>${stats.total}</b><span>总事件</span></div>
        <div class="kpi"><b>${stats.maxMag.toFixed(1)}</b><span>最大震级</span></div>
        <div class="kpi"><b>${stats.avgMag.toFixed(2)}</b><span>平均震级</span></div>
      </div>
      <div class="stats-section">
        <h4>每日分布</h4>
        ${dayRows}
      </div>
      <div class="stats-section">
        <h4>高发区域 Top ${stats.topRegions.length}</h4>
        <ul class="stats-regions">${regionRows}</ul>
      </div>
    `;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export { Timeline };
