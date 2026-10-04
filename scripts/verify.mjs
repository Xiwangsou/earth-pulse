/**
 * verify.mjs — 逻辑自检
 *
 * 目的：手写数学最容易错在边界上（极点、日期变更线、晨昏线求解）。
 * 这些错误在浏览器里表现为"看起来差不多但就是不对"，很难靠肉眼发现，
 * 所以用断言把它们钉死。
 *
 * 运行：node scripts/verify.mjs
 */

import {
  OrthographicProjection,
  EquirectangularProjection,
  solarPosition,
  isSunlit,
  wrapLon,
  clampLat,
} from '../src/core/projection.js';
import { haversineKm, lerpAngleDeg, magnitudeToRadius, damp } from '../src/core/math.js';
import { Timeline, RingBuffer } from '../src/core/timeline.js';
import { LAND } from '../data/land.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function near(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg || ''} 期望 ${b}±${tol}，实际 ${a}`);
}

console.log('\n【经纬度工具】');

check('wrapLon 把 190 归一到 -170', () => near(wrapLon(190), -170, 1e-9));
check('wrapLon 保持 -170 不动', () => near(wrapLon(-170), -170, 1e-9));
check('wrapLon 处理 540', () => near(wrapLon(540), 180 - 360 + 0, 1e-9, '540→-180'));
check('clampLat 截断超范围纬度', () => {
  near(clampLat(95), 90, 1e-9);
  near(clampLat(-95), -90, 1e-9);
});

console.log('\n【正射投影】');

const ortho = new OrthographicProjection();
ortho.attach(800, 600);
ortho.setView({ lat: 0, lon: 0, scale: 280 });

check('视点中心落在画布正中', () => {
  const p = ortho.project(0, 0);
  near(p.x, 400, 0.01, 'x');
  near(p.y, 300, 0.01, 'y');
  assert(p.visible, '视点应可见');
});

check('正对面的点深度为 1（最正）', () => {
  const p = ortho.project(0, 0);
  near(p.depth, 1, 1e-6);
});

check('背面点不可见（背面剔除生效）', () => {
  const p = ortho.project(0, 180);
  assert(!p.visible, '地球背面应被剔除');
  assert(p.depth < 0, `背面深度应为负，实际 ${p.depth}`);
});

check('90度边缘处可见性为临界', () => {
  const p = ortho.project(0, 90);
  near(p.depth, 0, 1e-6, '边缘深度应≈0');
});

check('北纬 90 在北半球视点下可见', () => {
  ortho.setView({ lat: 60, lon: 0 });
  assert(ortho.project(90, 0).visible, '北极点在北半球视点应可见');
  assert(!ortho.project(-90, 0).visible, '南极点在北半球视点应不可见');
  ortho.setView({ lat: 0, lon: 0 });
});

check('对称性：东西同距离投影结果对称', () => {
  const east = ortho.project(0, 30);
  const west = ortho.project(0, -30);
  near(east.x, 800 - west.x, 0.01, '关于中轴对称');
  near(east.y, west.y, 0.01);
});

check('比例尺：赤道 1 度≈111 km', () => {
  const kmPerPx = ortho.kmPerPixel();
  const p1 = ortho.project(0, 0);
  const p2 = ortho.project(0, 1);
  const pxPerDeg = Math.abs(p2.x - p1.x);
  const kmPerDeg = pxPerDeg * kmPerPx;
  near(kmPerDeg, 111.19, 1.5, '赤道 1 度的公里数');
});

/**
 * 逆变换往返一致性 —— 本项目最核心的数学正确性防线。
 *
 * 晨昏线靠逐像素逆变换绘制，一旦逆变换有误，
 * 夜面分界线就会整体偏移，而且偏移得很"像那么回事"，肉眼极难发现。
 * 这里用 project → unproject 的往返误差把它钉死。
 */
console.log('\n【投影逆变换往返一致性】');

for (const view of [
  { lat: 0, lon: 0, name: '赤道视点' },
  { lat: 20, lon: 0, name: '北半球视点' },
  { lat: 45, lon: 90, name: '斜视点' },
  { lat: -30, lon: 200, name: '南半球视点' },
  { lat: -60, lon: 30, name: '南高纬视点' },
  { lat: 89, lon: 0, name: '近极点视点' },
]) {
  check(`${view.name} (${view.lat}, ${view.lon}) 往返误差 < 0.001°`, () => {
    const p = new OrthographicProjection();
    p.attach(1000, 800);
    p.setView({ lat: view.lat, lon: view.lon, scale: 300 });
    let worst = 0;
    for (let lat = -85; lat <= 85; lat += 5) {
      for (let lon = -180; lon < 180; lon += 5) {
        const f = p.project(lat, lon);
        // 判据必须与实现一致：可见性用 depth > 0.02 留出浮点余量。
        // 边界附近 depth 在 0 附近抖动，若用 visible 判定会把
        // 刚好可见的点纳入测试，而逆变换因严格判据返回 null，
        // 造成"测试失败但实现无bug"的假阳性。
        if (f.depth <= 0.02) continue;
        const b = p.unproject(f.x, f.y);
        assert(b, `(${lat},${lon}) depth=${f.depth.toFixed(4)} 应有逆变换结果`);
        const eLat = Math.abs(b.lat - lat);
        let eLon = Math.abs(b.lon - lon);
        if (eLon > 180) eLon = 360 - eLon;
        worst = Math.max(worst, eLat, eLon);
      }
    }
    assert(worst < 0.001, `最大往返误差 ${worst}°，应 < 0.001°`);
  });
}

check('逆变换在球面外返回 null', () => {
  const p = new OrthographicProjection();
  p.attach(1000, 800);
  p.setView({ lat: 0, lon: 0, scale: 300 });
  // 地球半径 300，球心 (500,400)。
  // 这条防线至关重要：渲染器逐像素绘制晨昏线时，
  // 完全靠它圈定「需要计算的像素范围」。一旦失效，
  // 球外的夜空区域会被当作球面参与计算，夜面范围就会溢出到画面之外。
  assert(p.unproject(500 + 400, 400) === null, '右侧 400px 处应返回 null');
  assert(p.unproject(500 - 400, 400) === null, '左侧 400px 处应返回 null');
  assert(p.unproject(500, 400 + 400) === null, '下方 400px 处应返回 null');
  assert(p.unproject(500, 400 - 400) === null, '上方 400px 处应返回 null');
  assert(p.unproject(0, 0) === null, '左上角应返回 null');
  assert(p.unproject(999, 799) === null, '右下角应返回 null');

  assert(p.unproject(500, 400) !== null, '中心点应有结果');
  assert(p.unproject(500 + 299, 400) !== null, '球内近边缘点应有结果');
  assert(p.unproject(500 + 200, 400) !== null, '球内点应有结果');
});

check('球外判定对所有视点与缩放都成立', () => {
  for (const scale of [100, 300, 800]) {
    for (const view of [[0, 0], [45, 90], [-60, 30]]) {
      const p = new OrthographicProjection();
      p.attach(1200, 900);
      p.setView({ lat: view[0], lon: view[1], scale });
      const cx = 600;
      const cy = 450;
      // 沿 8 个方向扫到球外
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        const far = scale * 1.3;
        const px = cx + Math.cos(ang) * far;
        const py = cy + Math.sin(ang) * far;
        assert(
          p.unproject(px, py) === null,
          `视点(${view}) scale=${scale} 方向${a} 球外1.3R处应返回 null`
        );
      }
    }
  }
});

check('等距圆柱逆变换往返一致', () => {
  const p = new EquirectangularProjection();
  p.attach(720, 360);
  p.setView({ lat: 10, lon: 30, scale: 300 });
  for (const [lat, lon] of [[0, 0], [45, 90], [-45, -170], [80, 179], [-80, -179]]) {
    const f = p.project(lat, lon);
    const b = p.unproject(f.x, f.y);
    near(b.lat, lat, 1e-9, `纬度 (${lat},${lon})`);
    let dLon = Math.abs(b.lon - lon);
    if (dLon > 180) dLon = 360 - dLon;
    near(dLon, 0, 1e-9, `经度 (${lat},${lon})`);
  }
});

check('视点移动后，原背面点转到正面变为可见', () => {
  // (0,0) 在视点(0,0)时是正面；转到 (0,170) 后它应落到背面
  ortho.setView({ lat: 0, lon: 0 });
  assert(ortho.project(0, 0).visible, '正对时可见');
  ortho.setView({ lat: 0, lon: 170 });
  assert(!ortho.project(0, 0).visible, '转过后应被背面剔除');
  // 转回正对并换一个此前不可见的点（对跖点 0,180）验证同一件事
  ortho.setView({ lat: 0, lon: 180 });
  assert(ortho.project(0, 180).visible, '转到对跖点后正对');
  ortho.setView({ lat: 0, lon: 0 });
});

console.log('\n【等距圆柱投影】');

const rect = new EquirectangularProjection();
rect.attach(720, 360);

check('全图可见（无背面剔除）', () => {
  for (const [lat, lon] of [[0, 0], [0, 179], [0, -179], [89, 0], [-89, 0]]) {
    assert(rect.project(lat, lon).visible, `(${lat},${lon}) 应可见`);
  }
});

check('经度 ±180 归一为同一条经线（同一 x）', () => {
  // 180°E 与 180°W 是同一条经线，投影后必须重合，
  // 否则海岸线会在日期变更线处裂开一道缝。
  const a = rect.project(0, 180);
  const b = rect.project(0, -180);
  near(a.x, b.x, 0.01, '±180 应投影到同一位置');
  near(a.y, b.y, 0.01);
});

check('赤道在垂直中线上', () => near(rect.project(0, 0).y, 180, 0.01));

console.log('\n【太阳位置与晨昏线】');

const noonUTC = new Date('2026-10-04T12:00:00Z');
const sun = solarPosition(noonUTC);

check('太阳赤纬：夏至近北、冬至近南', () => {
  // 用两个确定的节气做锚点，比用某个具体日期更稳健
  const june = solarPosition(new Date('2026-06-21T12:00:00Z'));
  const dec = solarPosition(new Date('2026-12-21T12:00:00Z'));
  assert(june.subsolarLat > 22, `夏至赤纬应接近北回归线 23.44，实际 ${june.subsolarLat}`);
  assert(dec.subsolarLat < -22, `冬至赤纬应接近南回归线，实际 ${dec.subsolarLat}`);
});

check('太阳赤纬始终在黄赤交角 ±23.44 内', () => {
  for (const month of [0, 3, 6, 9]) {
    const s = solarPosition(new Date(`2026-${String(month + 1).padStart(2, '0')}-15T12:00:00Z`));
    assert(
      Math.abs(s.subsolarLat) <= 23.5,
      `${month + 1} 月赤纬越界: ${s.subsolarLat}`
    );
  }
});

check('10 月初太阳赤纬为负（已过秋分向南）', () => {
  const oct = solarPosition(new Date('2026-10-04T12:00:00Z'));
  assert(oct.subsolarLat < 0, `10/4 应已越过赤道向南，实际 ${oct.subsolarLat}`);
  near(oct.subsolarLat, -4.5, 1.5, '接近 -4.5 度');
});

check('UTC 正午时直射点在东半球', () => {
  assert(sun.subsolarLon > 0 && sun.subsolarLon < 180, `直射经度应偏东，实际 ${sun.subsolarLon}`);
});

check('直射点本身一定是白天', () => {
  assert(isSunlit(sun.subsolarLat, sun.subsolarLon, sun), '直射点应判定为白昼');
});

check('直射点对跖点是黑夜', () => {
  const antiLat = -sun.subsolarLat;
  const antiLon = sun.subsolarLon >= 0 ? sun.subsularLon - 180 : sun.subsolarLon + 180;
  assert(!isSunlit(antiLat, antiLon, sun), '对跖点应判定为黑夜');
});

check('子夜（UTC 0 点）直射点在西半球', () => {
  const midnight = solarPosition(new Date('2026-10-04T00:00:00Z'));
  assert(midnight.subsolarLon < 0, `应偏西，实际 ${midnight.subsolarLon}`);
});

check('赤道上永远有且仅有约一半是白天', () => {
  let dayCount = 0;
  for (let lon = -180; lon < 180; lon += 1) {
    if (isSunlit(0, lon, sun)) dayCount++;
  }
  // 6° 曙暮光带会略微放宽这个区间，留足余量
  assert(dayCount > 165 && dayCount < 195, `白昼占比应约一半，实际 ${dayCount}/360`);
});

check('南极点冬至前后为黑夜（10月）', () => {
  // 10月初南半球刚进入春季，南极仍处于极夜
  assert(!isSunlit(-89, 0, sun), '10 月南极点应为极夜');
});

console.log('\n【数学工具】');

check('haversine 已知距离：北京到上海≈1064 km', () => {
  const d = haversineKm(39.9042, 116.4074, 31.2304, 121.4737);
  near(d, 1064, 25, '实际');
});

check('haversine 同一坐标为 0', () => near(haversineKm(30, 120, 30, 120), 0, 1e-9));

check('haversine 跨日期变更线不绕远', () => {
  // 179°E 与 179°W 实际只隔 2°
  const d = haversineKm(0, 179, 0, -179);
  near(d, 222, 5, '实际');
});

check('经度插值走最短路径（179 → -179 不绕地球）', () => {
  const mid = lerpAngleDeg(179, -179, 0.5);
  const delta = Math.abs(Math.abs(mid) - 180);
  assert(delta < 1.5, `应接近 ±180 而非 0，实际 ${mid}`);
});

check('震级到半径是单调递增的对数映射', () => {
  const r2 = magnitudeToRadius(2.5);
  const r5 = magnitudeToRadius(5.0);
  const r7 = magnitudeToRadius(7.0);
  assert(r2 < r5 && r5 < r7, '半径应随震级递增');
  assert(r7 - r5 < r5 - r2 + 12, '高震级不应过度膨胀');
});

check('指数平滑收敛且与帧率无关', () => {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 60; i++) a = damp(a, 100, 8, 1 / 60);
  for (let i = 0; i < 120; i++) b = damp(b, 100, 8, 1 / 120);
  near(a, b, 1.0, '不同帧率下收敛值应接近');
  assert(a > 95, `60 帧后应接近目标，实际 ${a}`);
});

console.log('\n【时间轴回溯】');

check('事件去重：重复摄入不增加总数', () => {
  const t = new Timeline();
  const batch = [
    { id: 'a', at: Date.now() - 3600_000, mag: 4.1, place: 'X of Y, Japan' },
    { id: 'b', at: Date.now() - 7200_000, mag: 5.2, place: 'Z of W, Chile' },
  ];
  t.ingestEvents(batch);
  t.ingestEvents(batch);
  t.ingestEvents(batch);
  assert(t.events.toArray().length === 2, `去重后应为 2，实际 ${t.events.toArray().length}`);
});

check('回溯只返回该时刻之前的事件（未来不可见）', () => {
  const t = new Timeline();
  const now = Date.now();
  t.ingestEvents([
    { id: 'old', at: now - 7200_000, mag: 4.0, place: 'A of B, Peru' },
    { id: 'new', at: now - 60_000, mag: 3.0, place: 'C of D, Chile' },
  ]);
  const past = t.eventsAt(now - 3600_000);
  assert(past.length === 1, `一小时前应只见 1 条，实际 ${past.length}`);
  assert(past[0].id === 'old', '应只看到旧事件');
});

check('统计：最大震级与高发区域正确', () => {
  const t = new Timeline();
  const now = Date.now();
  t.ingestEvents([
    { id: 'e1', at: now - 3600_000, mag: 6.4, place: '100 km of Foo, Japan' },
    { id: 'e2', at: now - 3600_000, mag: 3.1, place: '50 km of Bar, Japan' },
    { id: 'e3', at: now - 3600_000, mag: 4.2, place: '80 km of Baz, Chile' },
  ]);
  const s = t.stats(now);
  assert(s.total === 3, `总数应为 3，实际 ${s.total}`);
  near(s.maxMag, 6.4, 1e-9);
  near(s.avgMag, (6.4 + 3.1 + 4.2) / 3, 1e-6);
  assert(s.topRegions[0][0] === 'Japan', `高发应为 Japan，实际 ${s.topRegions[0]?.[0]}`);
  assert(s.topRegions[0][1] === 2, 'Japan 应计 2 次');
});

check('事件环形缓冲区超出容量时丢弃最旧', () => {
  // 直接测 RingBuffer 的容量语义：这是防止内存无限增长的关键
  const rb = new RingBuffer(5);
  for (let i = 0; i < 12; i++) rb.push({ id: `x${i}` });
  const all = rb.toArray();
  assert(all.length === 5, `容量 5 应只留 5 条，实际 ${all.length}`);
  assert(all[0].id === 'x7', `最旧应被丢弃，实际最早为 ${all[0].id}`);
  assert(all[4].id === 'x11', '最新应保留');
});

check('Timeline 的事件缓冲容量可配置且生效', () => {
  const t = new Timeline({ eventCapacity: 3 });
  assert(t.events.capacity === 3, '容量应正确传入事件缓冲');
  const base = Date.now();
  for (let i = 0; i < 10; i++) {
    t.ingestEvents([{ id: `e${i}`, at: base - (10 - i) * 1000, mag: 4, place: 'P of Q, Peru' }]);
  }
  const all = t.events.toArray();
  assert(all.length <= 3, `实际保留 ${all.length} 条，应不超过 3`);
  assert(all[all.length - 1].id === 'e9', '最新事件必须保留');
});

check('seek 超出范围时被夹紧', () => {
  const t = new Timeline();
  const base = Date.now();
  t.snapshots.push({ at: base - 3600_000, quakes: [] });
  t.snapshots.push({ at: base, quakes: [] });
  t.seek(base + 999999);
  assert(t.cursor <= base, `应夹紧到上界，实际 ${t.cursor}`);
  t.seek(base - 9999999);
  assert(t.cursor >= base - 3600_000, '应夹紧到下界');
});

check('live() 清除回溯游标', () => {
  const t = new Timeline();
  const base = Date.now();
  t.snapshots.push({ at: base, quakes: [] });
  t.seek(base - 1000);
  assert(!t.isLive, 'seek 后应非实时');
  t.live();
  assert(t.isLive, 'live 后应回到实时');
});

console.log('\n【陆地矢量数据】');

check('多边形数量合理', () => {
  assert(LAND.land.length > 100, `应至少 100 个多边形，实际 ${LAND.land.length}`);
});

check('所有环点数为偶数且不少于 4 点', () => {
  for (const poly of LAND.land) {
    for (const ring of poly) {
      assert(ring.length % 2 === 0, '环应为扁平 lat/lon 对');
      assert(ring.length >= 8, `环至少 4 个点，实际 ${ring.length / 2}`);
    }
  }
});

check('坐标全部在合法经纬度范围内', () => {
  for (const poly of LAND.land) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i += 2) {
        const lat = +ring[i];
        const lon = +ring[i + 1];
        assert(lat >= -90 && lat <= 90, `纬度越界: ${lat}`);
        assert(lon >= -180 && lon <= 180, `经度越界: ${lon}`);
      }
    }
  }
});

check('数据体积控制在合理范围', () => {
  assert(LAND.stats.points > 4000, '顶点不应过少，否则大陆会明显失真');
  assert(LAND.stats.points < 12000, '顶点过多会拖慢投影');
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} · 失败 ${failed}`);
if (failed) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过\n');
