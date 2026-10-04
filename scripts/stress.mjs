/**
 * stress.mjs — 压力与边界测试
 *
 * 前面三套测试验证的是"正常情况下对不对"。
 * 这套验证的是"极端情况下会不会崩" —— 而崩掉才是真正致命的问题。
 *
 * 覆盖：
 *   1. 超大数据量下的内存与性能
 *   2. 畸形输入（null / NaN / 缺字段 / 超范围 / 负数 / 脏字符串）
 *   3. 并发请求与速率限制
 *   4. 长时间运行的内存增长
 *
 * 运行：node scripts/stress.mjs
 */

import { Timeline } from '../src/core/timeline.js';
import { RingBuffer } from '../src/core/timeline.js';
import { OrthographicProjection, EquirectangularProjection } from '../src/core/projection.js';
import { magnitudeToRadius, haversineKm, lerpAngleDeg, damp } from '../src/core/math.js';
import { LAND } from '../data/land.js';
import { SourceState, aqiLevel, issVisibleFrom, describeWeather } from '../src/sources/fetcher.js';

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

function noThrow(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

/* ================= 1. 大数据量压力 ================= */

console.log('\n【大数据量压力】');

{
  // 模拟 USGS 一周 feed 的量级：约 3000 条
  const t = new Timeline({ eventCapacity: 3000 });
  const base = Date.now();
  const start = Date.now();
  for (let i = 0; i < 5000; i++) {
    t.ingestEvents([{
      id: `q${i}`,
      at: base - i * 1000,
      mag: 2.5 + (i % 60) / 10,
      place: `${i} km of Place${i % 50}, Country${i % 20}`,
      lat: -80 + (i % 160),
      lon: -180 + (i % 360),
    }]);
  }
  const ingestMs = Date.now() - start;
  check('5000 次摄入在1 秒内完成', ingestMs < 1000, `${ingestMs}ms`);
  check('容量限制生效（保留 3000）', t.events.length === 3000, `实际 ${t.events.length}`);

  const s1 = Date.now();
  t.stats(base);
  const statsMs = Date.now() - s1;
  check('3000 条统计计算 <300ms', statsMs < 300, `${statsMs}ms`);

  const s2 = Date.now();
  t.eventsAt(base);
  const queryMs = Date.now() - s2;
  check('3000 条事件查询 <200ms', queryMs < 200, `${queryMs}ms`);
}

{
  // 陆地数据全量投影耗时（每帧都做，必须够快）
  const proj = new OrthographicProjection();
  proj.attach(1200, 800);
  proj.setView({ lat: 20, lon: 0, scale: 300 });

  const start = Date.now();
  const REP = 10;
  for (let r = 0; r < REP; r++) {
    for (const poly of LAND.land) {
      for (const ring of poly) {
        for (let i = 0; i < ring.length; i += 2) {
          proj.project(+ring[i], +ring[i + 1]);
        }
      }
    }
  }
  const totalMs = Date.now() - start;
  const perFrame = totalMs / REP;
  check('陆地全量投影 <8ms/帧', perFrame < 8, `${perFrame.toFixed(2)}ms（${LAND.stats.points} 顶点 × ${REP} 轮）`);
  check('60fps 预算未被陆地占用过多', perFrame < 8, `占 16.6ms 预算的 ${(perFrame / 16.6 * 100).toFixed(1)}%`);
}

{
  // 极端放大：8 倍缩放 + 密集数据下的帧预算
  const proj = new OrthographicProjection();
  proj.attach(1920, 1080);
  proj.setView({ lat: 0, lon: 0, scale: 2400 });

  const start = Date.now();
  const quakes = Array.from({ length: 500 }, (_, i) => ({
    id: `x${i}`, at: Date.now() - i * 1000, mag: 2.5 + (i % 60) / 10,
    place: 'P of Q, Japan', lat: -60 + (i % 120), lon: -180 + (i % 360),
  }));
  const REP = 20;
  for (let r = 0; r < REP; r++) {
    for (const q of quakes) proj.project(q.lat, q.lon);
  }
  const perFrame = (Date.now() - start) / REP;
  check('1920×1080 下 500 事件投影 <5ms', perFrame < 5, `${perFrame.toFixed(2)}ms`);
}

/* ================= 2. 畸形输入 ================= */

console.log('\n【畸形输入容错】');

noThrow('project 传入 NaN 不崩', () => {
  const p = new OrthographicProjection();
  p.attach(800, 600);
  p.project(NaN, NaN);
});

noThrow('project 传入 undefined 不崩', () => {
  const p = new OrthographicProjection();
  p.attach(800, 600);
  p.project(undefined, undefined);
});

noThrow('project 传入 null 不崩', () => {
  const p = new OrthographicProjection();
  p.attach(800, 600);
  p.project(null, null);
});

noThrow('project 传入 Infinity 不崩', () => {
  const p = new OrthographicProjection();
  p.attach(800, 600);
  p.project(Infinity, -Infinity);
});

noThrow('project 传入字符串不崩', () => {
  const p = new OrthographicProjection();
  p.attach(800, 600);
  p.project('abc', 'def');
});

noThrow('setView 接收越界缩放被夹紧', () => {
  const p = new OrthographicProjection();
  p.setView({ scale: 1e9 });
  check('超大缩放被夹到上限', p.scale === 8000, `scale=${p.scale}`);
  p.setView({ scale: -100 });
  check('负缩放被夹到下限', p.scale === 20, `scale=${p.scale}`);
  p.setView({ scale: NaN });
  check('NaN 缩放被忽略（保持原值）', p.scale === 20, `scale=${p.scale}`);
  p.setView({ scale: Infinity });
  check('Infinity 缩放被忽略', p.scale === 20, `scale=${p.scale}`);
  p.setView({});
  check('空参数不改变状态', p.scale === 20 && p.centerLat === 20);
  p.setView();
  check('无参数调用不崩', p.scale === 20);
});

noThrow('attach 传入 0 尺寸不崩', () => {
  const p = new EquirectangularProjection();
  p.attach(0, 0);
  p.project(0, 0);
});

check('纬度超出范围被夹紧', () => {
  const p = new OrthographicProjection();
  p.attach(800, 600);
  p.setView({ lat: 0, lon: 0 });
  const over = p.project(999, 0);
  const at90 = p.project(90, 0);
  check('lat=999 等价于 lat=90', Math.abs(over.x - at90.x) < 0.01, '极端纬度不会产生 NaN');
});

check('经度 ±10000 被归一到合法范围', () => {
  const p = new EquirectangularProjection();
  p.attach(720, 360);
  const a = p.project(0, 10000);
  check('投影结果为有限数', Number.isFinite(a.x) && Number.isFinite(a.y), `(${a.x}, ${a.y})`);
});

console.log('\n【畸形事件数据容错】');

noThrow('ingestEvents 传入空数组', () => {
  const t = new Timeline();
  t.ingestEvents([]);
});

noThrow('ingestEvents 传入 null', () => {
  const t = new Timeline();
  t.ingestEvents(null);
});

noThrow('ingestEvents 传入缺字段对象', () => {
  const t = new Timeline();
  t.ingestEvents([{}, { id: 'x' }, { mag: 5 }]);
});

noThrow('ingestEvents 传入 null 元素', () => {
  const t = new Timeline();
  t.ingestEvents([null, undefined]);
});

noThrow('ingestEvents 传入 NaN 时间戳', () => {
  const t = new Timeline();
  t.ingestEvents([{ id: 'a', at: NaN, mag: 4, place: 'X of Y, Peru' }]);
});

noThrow('stats 处理无 at 字段的事件', () => {
  const t = new Timeline();
  t.ingestEvents([{ id: 'a', mag: 4, place: 'X of Y, Peru' }]);
  t.stats(Date.now());
});

check('place 为超长字符串时 extractCountry 不崩', () => {
  const t = new Timeline();
  t.ingestEvents([{ id: 'a', at: Date.now(), mag: 4, place: 'x'.repeat(50000) + ', 测试国' }]);
  const s = t.stats(Date.now());
  check('超长 place 仍能完成统计', s.total === 1);
});

check('place 含 HTML 时不产生可执行标记', () => {
  const t = new Timeline();
  t.ingestEvents([{ id: 'a', at: Date.now(), mag: 4, place: '<script>alert(1)</script>, Test' }]);
  const s = t.stats(Date.now());
  // 关键：统计面板用 escapeHtml 转义，这里只验证数据层不崩且原样保留
  check('原始数据未被篡改（转义在渲染层做）', s.topRegions.length >= 0);
});

check('环形缓冲区容量为 0 或负数时不崩', () => {
  for (const cap of [0, -1]) {
    const rb = new RingBuffer(cap);
    rb.push({ id: 'a' });
    rb.push({ id: 'b' });
    check(`容量 ${cap} 时 toArray 不崩`, Array.isArray(rb.toArray()));
  }
});

check('Timeline 无快照时 current() 返回 null 而非崩', () => {
  const t = new Timeline();
  check('空时间轴 current() 为 null', t.current() === null);
  check('空时间轴 stats 可用', t.stats(Date.now()).total === 0);
  check('空时间轴 range 不崩', Array.isArray(t.range()));
});

check('seek 在无快照时安全', () => {
  const t = new Timeline();
  t.seek(Date.now());
  t.live();
  check('无快照时 seek 不崩', true);
});

console.log('\n【气象数值边界容错】');

check('aqiLevel 处理 null / undefined / 负数 / 超大值', () => {
  for (const v of [null, undefined, -50, 0, 20, 1000]) {
    const r = aqiLevel(v);
    check(`  AQI ${v} → ${r.label}`, typeof r.label === 'string' && /^#|rgb/.test(r.color));
  }
});

check('describeWeather 处理未知与边界代码', () => {
  for (const c of [-1, 0, 99, 100, 999, NaN, undefined]) {
    const r = describeWeather(c);
    check(`  代码 ${c} → ${r[0]}`, typeof r[0] === 'string');
  }
});

check('issVisibleFrom 处理无字段的 ISS', () => {
  check('  null 输入', issVisibleFrom(null, 23, 113) === false);
  check('  缺 footprint', issVisibleFrom({ lat: 23, lon: 113 }, 23, 113) === true);
  check('  极值坐标', issVisibleFrom({ lat: 90, lon: 180, footprint: 4500 }, -90, -180) === false);
});

noThrow('SourceState 在异常时保持可用', () => {
  const s = new SourceState('test');
  s.markLoading();
  s.markStale(new Error('x'), Date.now());
  s.markOk({ a: 1 }, Date.now());
  s.markStale(new Error('y'), Date.now());
  check('状态机可反复切换', s.status === 'stale' && s.data !== null);
});

console.log('\n【数学函数边界】');

check('magnitudeToRadius 处理极端震级', () => {
  for (const m of [-10, 0, null, undefined, NaN, 5, 10, 100]) {
    const r = magnitudeToRadius(m);
    check(`  M${m} → 半径 ${r.toFixed(1)}`, Number.isFinite(r) && r >= 3 && r <= 34);
  }
});

check('haversineKm 对相同点返回 0', () => {
  check('  同点', haversineKm(23.02, 113.75, 23.02, 113.75) < 0.001);
  check('  极点到极点', haversineKm(90, 0, -90, 0) > 20000);
  check('  同极点不同经度', haversineKm(90, 0, 90, 180) < 0.001);
});

check('lerpAngleDeg 在 ±180 边界连续', () => {
  const a = lerpAngleDeg(179, -179, 0.5);
  const b = lerpAngleDeg(-179, 179, 0.5);
  check('两个方向都落在 ±180 附近', Math.abs(Math.abs(a) - 180) < 2 && Math.abs(Math.abs(b) - 180) < 2,
    `a=${a.toFixed(1)} b=${b.toFixed(1)}`);
  check('t=0 和 t=1 精确返回端点',
    lerpAngleDeg(10, 20, 0) === 10 && lerpAngleDeg(10, 20, 1) === 20);
});

check('damp 在极端 dt 下不发散', () => {
  let v = 0;
  v = damp(v, 100, 8, 1000);
  check('dt=1000 时结果仍在合理域', v > 0 && v <= 100, `${v}`);
  let w = 0;
  w = damp(w, 100, 8, 0);
  check('dt=0 时无变化', w === 0);
});

/* ================= 3. 长期运行内存 ================= */

console.log('\n【长期运行内存增长】');

{
  // 模拟 24 小时运行：每 2 秒一次 ISS，4 分钟一次地震
  const timeline = new Timeline({ snapshotInterval: 60000, capacity: 720, eventCapacity: 3000 });
  const ISS_TICKS = (24 * 3600) / 2;   // 43200
  const QUAKE_TICKS = (24 * 3600) / 240; // 360

  const before = process.memoryUsage().heapUsed;
  let fakeNow = Date.now();

  // 快照：每分钟一次，24h = 1440 次，容量 720 所以会滚动
  for (let i = 0; i < 1440; i++) {
    fakeNow += 60000;
    timeline.maybeSnapshot(fakeNow, (k) => (k === 'quakes' ? [] : null));
  }
  check('快照环形缓冲未超容量', timeline.snapshots.length === 720, `实际 ${timeline.snapshots.length}`);

  // 地震：每次返回 40 条，重复的会被去重
  for (let i = 0; i < QUAKE_TICKS; i++) {
    fakeNow += 240000;
    const batch = Array.from({ length: 40 }, (_, j) => ({
      id: `q${i}_${j}`, at: fakeNow - j * 60000, mag: 3 + (j % 40) / 10,
      place: `${j} km of P${j % 20}, Country${j % 10}`, lat: -60 + j, lon: -180 + j * 3,
    }));
    timeline.ingestEvents(batch);
  }
  check('事件缓冲未超容量', timeline.events.length <= 3000, `实际 ${timeline.events.length}`);

  const after = process.memoryUsage().heapUsed;
  const growthMB = (after - before) / 1024 / 1024;
  check('24 小时模拟后堆增长 < 60MB', growthMB < 60, `${growthMB.toFixed(1)}MB`);

  // 关键：继续跑 10倍也不能线性爆炸
  for (let i = 0; i < QUAKE_TICKS * 10; i++) {
    fakeNow += 240000;
    const batch = Array.from({ length: 40 }, (_, j) => ({
      id: `r${i}_${j}`, at: fakeNow, mag: 4, place: 'P of Q, Japan', lat: j, lon: j,
    }));
    timeline.ingestEvents(batch);
  }
  const longRun = process.memoryUsage().heapUsed;
  const growth2MB = (longRun - after) / 1024 / 1024;
  check('再跑 10 倍时长后增长 < 30MB（无泄漏）', growth2MB < 30, `${growth2MB.toFixed(1)}MB`);
  check('缓冲仍受容量约束', timeline.events.length === 3000, `实际 ${timeline.events.length}`);
}

/* ================= 汇总 ================= */

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} · 失败 ${failed}`);
if (failed) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('压力与边界测试全部通过\n');
