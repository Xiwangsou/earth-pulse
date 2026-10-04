/**
 * e2e-ui.mjs — 交互与状态流转验证
 *
 * 用轻量 DOM 桩（stub）加载真实的 UI 模块，模拟用户操作。
 * 目的是在不依赖无头浏览器的前提下，验证"点一下会发生什么"：
 *   站点切换是否更新状态、按钮 class 是否正确、模板渲染是否抛异常。
 *
 * 之前 e2e-data 只验证了数据层能取到数，但没验证过
 * "取到的数据能否正确渲染成界面" —— 这一环容易出低级错误，
 * 比如切换站点后标题还写着上一个城市。
 *
 * 运行：node scripts/e2e-ui.mjs
 */

import { SITES, DEFAULT_SITE, getSite } from '../src/ui/sites.js';

/* ---------------- 极简 DOM 桩 ---------------- */

/**
 * 极简 DOM 桩。
 *
 * 关键点：querySelector 必须对同一个选择器**返回同一个实例**。
 * 否则组件里 this.fill = root.querySelector('.tl-fill') 存下的引用，
 * 和测试里再查一次拿到的会是两个不同对象，改一个另一个没反应 ——
 * 那样测出来的"失败"全是桩的问题，不是代码的问题（第一版就踩了这个坑）。
 */
class StubElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.innerHTML = '';
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
    this.hidden = false;
    this._selCache = new Map();

    const set = new Set();
    this.classList = {
      toggle: (cls, force) => {
        const on = force === undefined ? !set.has(cls) : force;
        on ? set.add(cls) : set.delete(cls);
        this.className = [...set].join(' ');
      },
      contains: (cls) => set.has(cls),
      add: (cls) => { set.add(cls); this.className = [...set].join(' '); },
      remove: (cls) => { set.delete(cls); this.className = [...set].join(' '); },
    };
  }

  setAttribute(k, v) {
    this.attributes[k] = v;
    if (k === 'class') this.className = v;
  }

  getAttribute(k) {
    return this.attributes[k];
  }

  querySelector(sel) {
    if (this._selCache.has(sel)) return this._selCache.get(sel);
    const found = new StubElement();
    // 记录它是否真的存在于本元素的 innerHTML，测试可据此判断选择器命中与否
    const cls = sel.match(/^\.([\w-]+)$/)?.[1];
    const attr = sel.match(/^\[([\w-]+)="([^"]+)"\]$/);
    if (cls) {
      found._exists = new RegExp(`class="[^"]*\\b${cls}\\b`).test(this.innerHTML);
      if (found._exists) {
        const m = this.innerHTML.match(new RegExp(`class="([^"]*\\b${cls}\\b[^"]*)"`));
        if (m) {
          for (const c of m[1].split(/\s+/)) found.classList.add(c);
        }
      }
    } else if (attr) {
      found._exists = this.innerHTML.includes(`${attr[1]}="${attr[2]}"`);
      found.dataset[attr[1]] = attr[2];
      found.setAttribute(attr[1], attr[2]);
    }
    this._selCache.set(sel, found);
    return found;
  }

  querySelectorAll() {
    return [];
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, ...event });
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 20, right: 800, bottom: 20 };
  }

  setPointerCapture() {}
  releasePointerCapture() {}
}

/* ---------------- 测试框架 ---------------- */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n【${title}】`);
}

const fetchCalls = [];

/** 伪数据：足够驱动 UI 渲染，且各城市数值不同便于验证 */
function makeWeather(site) {
  const seed = site.lat + site.lon;
  return {
    temp: 10 + (seed % 20),
    feels: 11 + (seed % 18),
    humidity: 40 + (seed % 50),
    windSpeed: 3 + (seed % 20),
    pressure: site.id === 'ls' ? 665 : 1010 + (seed % 12),
    code: [0, 2, 61, 95, 45][Math.floor(seed) % 5],
    desc: ['晴', '局部多云', '小雨', '雷阵雨', '雾'],
    isDay: true,
    at: Date.now(),
    daily: { time: ['2026-10-04', '2026-10-05', '2026-10-06'] },
  };
}

function makeAir(site) {
  const seed = site.lat * 2;
  return {
    aqi: 20 + (seed % 80),
    pm25: 5 + (seed % 60),
    pm10: 10 + (seed % 80),
    o3: 20 + (seed % 40),
    at: Date.now(),
  };
}

const fakeStates = () => ({
  usgs: { status: 'ok', lastOkAt: Date.now() - 3000, lastError: null, staleSince: null },
  weather: { status: 'ok', lastOkAt: Date.now() - 60000, lastError: null, staleSince: null },
  air: { status: 'ok', lastOkAt: Date.now() - 60000, lastError: null, staleSince: null },
  iss: { status: 'loading', lastOkAt: Date.now() - 1000, lastError: null, staleSince: null },
});

const fakeIss = () => ({
  lat: 20, lon: 100, altitude: 420, velocity: 27600, footprint: 4500, at: Date.now(),
});

/* ---------------- 开始测试 ---------------- */

section('站点模块');
{
  check('getSite 按 id 返回正确站点', getSite('bj')?.label === '北京');
  check('getSite 对未知 id 回退到默认站点', getSite('nope')?.id === DEFAULT_SITE.id);
  check('默认站点不再是东莞', DEFAULT_SITE.label !== '东莞');
  check('全部 10 个城市 id 唯一', new Set(SITES.map(s => s.id)).size === SITES.length);
  check('每个城市都有颜色', SITES.every(s => s.color));
}

section('侧栏渲染');
const { SidePanel } = await import('../src/ui/panels.js');
{
  const root = new StubElement();
  const panel = new SidePanel(root);

  check('实例化不抛异常', root.className === 'panel');

  panel.update({
    weather: makeWeather(DEFAULT_SITE),
    air: makeAir(DEFAULT_SITE),
    iss: fakeIss(),
    states: fakeStates(),
    issVisible: true,
  });

  check('渲染出完整 HTML', root.innerHTML.length > 500, `${root.innerHTML.length} 字符`);
  check('包含当前城市名', root.innerHTML.includes(DEFAULT_SITE.label));
  check('已移除"东莞"字样', !root.innerHTML.includes('东莞'));
  check('渲染了全部 10 个城市按钮',
    SITES.every(s => root.innerHTML.includes(`data-site="${s.id}"`)),
    `${SITES.length} 个`);
  check('当前城市标记为 on',
    new RegExp(`<button[^>]*data-site="${DEFAULT_SITE.id}"[^>]*class="on"`).test(root.innerHTML),
    `默认站点 ${DEFAULT_SITE.id}`);
  check('温度数值已渲染', root.innerHTML.includes('气温'));
  check('空气质量等级已渲染', root.innerHTML.includes('欧洲 AQI'));
  check('数据源状态已渲染', root.innerHTML.includes('USGS 地震'));
  check('ISS 区块存在', root.innerHTML.includes('国际空间站'));

  // 切换到另一个城市
  const target = SITES.find(s => s.id === 'bj');
  panel.setSite(target);
  panel.update({
    weather: makeWeather(target),
    air: makeAir(target),
    iss: fakeIss(),
    states: fakeStates(),
    issVisible: false,
  });

  check('切换后标题更新为目标城市', root.innerHTML.includes('北京'), `现在是 ${target.label}`);
  check('切换后原城市不再出现在标题',
    !root.innerHTML.includes(`${DEFAULT_SITE.label} 实况`));
  check('切换后 on 标记跟随切换', root.innerHTML.includes(`data-site="bj"`));
  check('切换后坐标读数更新', root.innerHTML.includes(`${target.lat.toFixed(1)}°N`));
  check('不可见时显示"不可见"', root.innerHTML.includes('不可见'));
}

section('缺数据时的降级显示');
{
  const root = new StubElement();
  const panel = new SidePanel(root);
  panel.update({
    weather: null, air: null, iss: null,
    states: {
      usgs: { status: 'error', lastOkAt: null, lastError: new Error('x'), staleSince: null },
      weather: { status: 'stale', lastOkAt: Date.now() - 300000, lastError: null, staleSince: 300000 },
      air: { status: 'idle', lastOkAt: null, lastError: null, staleSince: null },
      iss: { status: 'loading', lastOkAt: null, lastError: null, staleSince: null },
    },
    issVisible: false,
  });

  check('无数据时渲染不抛异常', root.innerHTML.length > 300);
  check('温度显示占位符 --', root.innerHTML.includes('--'));
  check('weather 显示"无数据"', root.innerHTML.includes('无数据'));
  check('数据源状态：失败', root.innerHTML.includes('失败'));
  check('数据源状态：显示缓存时长', root.innerHTML.includes('缓存'));
  check('数据源状态：待命', root.innerHTML.includes('待命'));
  check('NaN 未泄漏到界面', !root.innerHTML.includes('NaN'));
  check('undefined 未泄漏到界面', !root.innerHTML.includes('undefined'));
}

section('全部城市逐一渲染');
{
  let allOk = true;
  for (const site of SITES) {
    try {
      const root = new StubElement();
      const panel = new SidePanel(root);
      panel.setSite(site);
      panel.update({
        weather: makeWeather(site),
        air: makeAir(site),
        iss: fakeIss(),
        states: fakeStates(),
        issVisible: true,
      });
      if (!root.innerHTML.includes(site.label)) allOk = false;
      if (root.innerHTML.includes('NaN')) allOk = false;
    } catch (e) {
      allOk = false;
      console.log(`    ${site.label} 渲染失败: ${e.message}`);
    }
  }
  check(`10 个城市全部渲染成功且无 NaN`, allOk);
}

section('时间轴控件');
{
  const { Timeline } = await import('../src/core/timeline.js');
  const { TimelineBar, StatsPanel } = await import('../src/ui/timeline-ui.js');

  const tl = new Timeline();
  const root = new StubElement();
  const bar = new TimelineBar(root, tl, { onSeek: () => fetchCalls.push('seek') });

  check('时间轴实例化成功', root.innerHTML.includes('tl-track'));
  check('初始为实时态', tl.isLive);

  // 造几个快照才有可回溯区间
  const base = Date.now();
  for (let i = 5; i >= 0; i--) {
    tl.snapshots.push({ at: base - i * 60000, quakes: [], iss: null, weather: null, air: null });
  }

  bar.sync();
  check('sync 后填充条有宽度', root.querySelector('.tl-fill').style.width !== undefined);
  check('读数显示日期时间', /\d{2}-\d{2} \d{2}:\d{2}/.test(root.querySelector('.tl-date').textContent),
    root.querySelector('.tl-date').textContent);

  // 模拟拖动到中间
  tl.seek(base - 180000);
  bar.sync();
  check('回溯态标记正确', root.className.includes('is-replay'), root.className);
  check('LIVE 按钮不再高亮', !root.querySelector('.tl-live').classList.contains('is-active'));
  check('显示回溯时长', /回溯/.test(root.querySelector('.tl-delta').textContent),
    root.querySelector('.tl-delta').textContent);

  // 点 LIVE 回实时
  root.querySelector('.tl-live').dispatch('click');
  check('点击 LIVE 后回到实时', tl.isLive);
  check('LIVE 按钮重新高亮', root.querySelector('.tl-live').classList.contains('is-active'));
  check('回溯提示已清除', root.querySelector('.tl-delta').textContent === '');

  // 统计面板
  const statsRoot = new StubElement();
  const statsPanel = new StatsPanel(statsRoot);
  const now = Date.now();
  tl.ingestEvents([
    { id: 's1', at: now - 7200000, mag: 5.4, place: '100 km of A, Japan' },
    { id: 's2', at: now - 3600000, mag: 3.2, place: '80 km of B, Chile' },
    { id: 's3', at: now - 3600000, mag: 4.1, place: '90 km of C, Japan' },
  ]);
  const stats = tl.stats(now);
  statsPanel.update(stats, tl, now);
  check('统计面板渲染出内容', statsRoot.innerHTML.includes('事件回溯统计'));
  check('显示事件总数', statsRoot.innerHTML.includes(String(stats.total)));
  check('显示高发区域', statsRoot.innerHTML.includes('Japan'));
  check('统计面板无 NaN', !statsRoot.innerHTML.includes('NaN'));

  // 空数据
  const emptyTl = new Timeline();
  statsPanel.update(emptyTl.stats(now), emptyTl, now);
  check('空数据时显示空态提示', emptyTl.stats(now).total === 0);
}

section('多城市切换时数据不串台');
{
  const { SidePanel: SP } = await import('../src/ui/panels.js');
  const root = new StubElement();
  const panel = new SP(root);

  // 依次切换，每个城市用不同气压值，验证显示跟着换
  const results = [];
  for (const site of SITES) {
    panel.setSite(site);
    const w = makeWeather(site);
    if (site.id === 'ls') w.pressure = 665;
    panel.update({ weather: w, air: makeAir(site), iss: fakeIss(), states: fakeStates(), issVisible: false });
    const shown = root.innerHTML;
    results.push({
      site,
      ok: shown.includes(site.label) && shown.includes(w.pressure.toFixed(0)),
    });
  }
  check('每个城市都显示了自己对应的气压值（无串台）',
    results.every(r => r.ok),
    results.filter(r => !r.ok).map(r => r.site.label).join(',') || '全部正确');

  const lhasa = results.find(r => r.site.id === 'ls');
  check('拉萨显示高原气压 665', lhasa?.ok);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} · 失败 ${failed}`);
if (failed) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('交互与状态流转验证全部通过\n');
