/**
 * main.js — 应用入口
 *
 * 装配顺序：
 *   1. 建渲染器、挂 canvas、开始 60fps 循环
 *   2. 并行拉四个数据源（互不阻塞，单源失败不影响其他）
 *   3. 数据进 Timeline（去重 + 快照）
 *   4. 每帧从 Timeline 读「当前该显示什么」交给渲染器
 *
 * 这里有个关键设计：**渲染器不直接持有数据源的数据**。
 * 它只认识 Timeline 给的快照。回溯时不需要重新请求网络，
 * 也不需要暂停任何东西 —— 时间轴改变的是「读哪一份数据」，不是「系统状态」。
 * 这是让回溯实现得干净的关键。
 */

import { GlobeRenderer } from './core/renderer.js';
import { Timeline } from './core/timeline.js';
import { issVisibleFrom } from './sources/fetcher.js';
import {
  SourceState,
  fetchQuakes,
  fetchWeather,
  fetchAirQuality,
  fetchIss,
  QUAKE_SOURCE,
  WEATHER_SOURCE,
  ISS_SOURCE,
} from './sources/fetcher.js';
import { TimelineBar, StatsPanel } from './ui/timeline-ui.js';
import { SidePanel } from './ui/panels.js';
import { SITES, DEFAULT_SITE } from './ui/sites.js';
import { AiBrief } from './ui/ai-brief.js';

/* ---------------- 状态 ---------------- */

const states = {
  usgs: new SourceState('usgs'),
  weather: new SourceState('weather'),
  air: new SourceState('air'),
  iss: new SourceState('iss'),
};

const timeline = new Timeline({ snapshotInterval: 60_000, capacity: 720, eventCapacity: 3000 });

let renderer = null;
let timelineBar = null;
let statsPanel = null;
let sidePanel = null;
let aiBrief = null;
let activeSite = DEFAULT_SITE;
let quakeFeed = 'week';

/** 地图上要标出全部城市：当前站点高亮，其余淡化 */
function siteObservations() {
  return SITES.map((s) => ({
    lat: s.lat,
    lon: s.lon,
    label: s.label,
    color: s.color,
    primary: s.id === activeSite.id,
  }));
}

/* ---------------- 启动 ---------------- */

function boot() {
  const canvas = document.getElementById('globe');
  renderer = new GlobeRenderer(canvas);
  renderer.start();

  statsPanel = new StatsPanel(document.getElementById('stats'));
  sidePanel = new SidePanel(document.getElementById('panel'));
  aiBrief = new AiBrief(document.getElementById('ai'));

  sidePanel.onSiteChange = (site) => {
    activeSite = site;
    refreshWeather();
    renderer.setObservations(siteObservations());
  };

  timelineBar = new TimelineBar(document.getElementById('timeline'), timeline, {
    onSeek: () => refreshPanels(),
  });

  renderer.setObservations(siteObservations());

  bindControls();
  bindKeys();

  // 首屏：并行拉取，互不阻塞
  refreshQuakes();
  refreshWeather();
  refreshIss();

  // 定时轮询：三个不同节奏，避免同时打同一个源
  setInterval(refreshQuakes, QUAKE_SOURCE.intervalMs);
  setInterval(refreshWeather, WEATHER_SOURCE.intervalMs);
  setInterval(refreshIss, ISS_SOURCE.intervalMs);

  // 页面隐藏时停掉高频 ISS 轮询和渲染，省电
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      renderer.stop();
    } else {
      renderer.start();
      refreshIss();
    }
  });

  window.addEventListener('resize', () => {
    renderer.resize();
    refreshPanels();
  });

  refreshPanels();
  document.getElementById('boot-hint')?.classList.add('is-hidden');
}

/* ---------------- 数据刷新 ---------------- */

async function refreshQuakes() {
  const quakes = await fetchQuakes(states.usgs, { feed: quakeFeed, minMag: 2.5 });
  const added = timeline.ingestEvents(quakes);
  if (added) {
    // 新事件进来才更新图层，避免无变化时反复重绘
    renderer.setQuakes(timeline.eventsAt(timeline.cursor ?? Date.now()));
  }
  refreshPanels();
}

async function refreshWeather() {
  const { lat, lon } = activeSite;
  const [w, a] = await Promise.all([
    fetchWeather(states.weather, { lat, lon }),
    fetchAirQuality(states.air, { lat, lon }),
  ]);
  refreshPanels();
  return { w, a };
}

async function refreshIss() {
  const iss = await fetchIss(states.iss);
  if (iss) renderer.setIss(iss);
  refreshPanels();
}

/* ---------------- 面板刷新 ---------------- */

function refreshPanels() {
  const at = timeline.cursor ?? Date.now();
  const snapshot = timeline.current();
  const events = timeline.eventsAt(at);

  // 渲染器显示的是「回溯时刻已发生」的事件
  renderer.setQuakes(events);

  const stats = timeline.stats(at);
  statsPanel.minMag = 2.5;
  statsPanel.update(stats, timeline, at);

  const weather = snapshot?.weather ?? states.weather.data;
  const air = snapshot?.air ?? states.air.data;
  const iss = snapshot?.iss ?? states.iss.data;

  sidePanel.setSite(activeSite);
  sidePanel.update({
    weather,
    air,
    iss,
    states,
    issVisible: issVisibleFrom(iss, activeSite.lat, activeSite.lon),
  });

  if (aiBrief?.enabled) {
    aiBrief.setContext(stats, {
      weather,
      air,
      iss,
      issVisible: issVisibleFrom(iss, activeSite.lat, activeSite.lon),
      windowLabel: timeline.isLive
        ? '实时（近 24 小时）'
        : `回溯至 ${new Date(at).toLocaleString('zh-CN')}`,
    });
  }
}

/* ---------------- 控件 ---------------- */

function bindControls() {
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b === btn));
      renderer.setMode(mode);
    });
  });

  document.querySelectorAll('[data-feed]').forEach((btn) => {
    btn.addEventListener('click', () => {
      quakeFeed = btn.dataset.feed;
      document.querySelectorAll('[data-feed]').forEach((b) => b.classList.toggle('on', b === btn));
      refreshQuakes();
    });
  });

  const toggle = (id, key) => {
    const el = document.getElementById(id);
    el?.addEventListener('click', () => {
      renderer[key] = !renderer[key];
      el.classList.toggle('on', renderer[key]);
    });
  };
  toggle('t-grid', 'showGrid');
  toggle('t-night', 'showNight');
  toggle('t-trail', 'showTrail');
}

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key.toLowerCase()) {
      case 'l':
        timeline.live();
        break;
      case 'g':
        renderer.showGrid = !renderer.showGrid;
        document.getElementById('t-grid')?.classList.toggle('on', renderer.showGrid);
        break;
      case 'n':
        renderer.showNight = !renderer.showNight;
        document.getElementById('t-night')?.classList.toggle('on', renderer.showNight);
        break;
      case 'm':
        renderer.setMode(renderer.mode === 'orthographic' ? 'equirectangular' : 'orthographic');
        document.querySelectorAll('[data-mode]').forEach((b) =>
          b.classList.toggle('on', b.dataset.mode === renderer.mode)
        );
        break;
      case 'r':
        renderer.autoRotate = !renderer.autoRotate;
        break;
      case 'i':
        document.getElementById('side')?.classList.toggle('is-open');
        break;
      default:
        return;
    }
  });
}

/* ---------------- 起飞 ---------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
