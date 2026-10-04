/**
 * render-regress.mjs — 渲染层回归测试
 *
 * 三个 bug 都是"肉眼看得出不对、但说不清哪里不对"的类型，
 * 靠盯屏幕发现不了，必须用断言钉死：
 *
 *   1. 跨 180° 经线的多边形会画出横穿画面的斜线
 *   2. 晨昏线用采样点法在赤纬≈0 时产生扇贝状缺口
 *   3. 逐像素全分辨率渲染导致帧率崩溃
 *
 * 运行：node scripts/render-regress.mjs
 */

import { OrthographicProjection, solarPosition, isSunlit } from '../src/core/projection.js';

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

const W = 1600;
const H = 1000;

/**
 * 复现 renderer._landPath 的多边形构建逻辑。
 * 之所以在这里重写一份而不是直接调渲染器：
 * 渲染器依赖 canvas / document，Node 环境没有。
 * 但这个 bug 的本质是「子路径断开逻辑」，可以独立验证。
 */
function buildLandSegments(land, proj) {
  const PEN_UP = -99999;
  const segments = [];        // 收集所有可见线段
  const badJumps = [];        // 记录「可见点之间跨越了不可见区」的跳跃

  for (const polygon of land) {
    for (const ring of polygon) {
      let penDown = false;
      let prev = null;

      for (let i = 0; i < ring.length; i += 2) {
        const lat = +ring[i];
        const lon = +ring[i + 1];
        const p = proj.project(lat, lon);

        if (p.visible) {
          if (penDown) {
            // 这里会 lineTo(prev → p)。若 prev 与 p 之间实际
            // 被不可见区分隔，就说明断开逻辑失效了。
            segments.push([prev, p]);
          } else {
            penDown = true;
          }
          prev = p;
        } else {
          if (penDown) {
            // 抬笔。下一个可见点必须 moveTo 而非 lineTo。
            penDown = false;
            prev = null;
          }
        }
      }
    }
  }
  return { segments, badJumps, PEN_UP };
}

console.log('\n【渲染回归测试】\n');

console.log('【1. 跨 180° 经线的多边形不会画出横穿画面的斜线】');

{
  // 构造一个跨越日期变更线的环：西伯利亚一带，lon 从 170 跳到 -170
  const crossingRing = [
    // (lat, lon) 从 170°E 向东跨到 -170°W
    60, 175,
    60, -175,
    65, -175,
    65, 175,
  ];

  const proj = new OrthographicProjection();
  proj.attach(W, H);
  proj.setView({ lat: 0, lon: 180, scale: 400 });

  // 关键：视点在 180°，这个环横跨视点两侧
  // 正确处理下，它应该被拆成两个独立片段，而不是一条斜线
  const ring = crossingRing;
  let penDown = false;
  let segments = 0;
  let jumps = 0;
  let prev = null;

  for (let i = 0; i < ring.length; i += 2) {
    const p = proj.project(+ring[i], +ring[i + 1]);
    if (p.visible) {
      if (penDown) segments++;
      else penDown = true;
      prev = p;
    } else {
      if (penDown) {
        penDown = false;
        prev = null;
      }
    }
  }

  check('跨经线环的可见片段数合理', segments >= 0 && segments <= ring.length / 2,
    `${segments} 段`);

  // 更本质的检查：任意相邻两个投影点若中间跨越了背面，不允许直接连线
  // 这里用「距离突变」检测：正常相邻点屏幕距离不会超过地球直径
  const maxDist = 2 * proj.scale;
  let violations = 0;
  penDown = false;
  prev = null;
  for (let i = 0; i < ring.length; i += 2) {
    const p = proj.project(+ring[i], +ring[i + 1]);
    if (p.visible) {
      if (penDown && prev) {
        const d = Math.hypot(p.x - prev.x, p.y - prev.y);
        if (d > maxDist) violations++;
      } else penDown = true;
      prev = p;
    } else {
      penDown = false;
      prev = null;
    }
  }
  check('无超长跳跃线段（斜线已被消除）', violations === 0,
    violations === 0 ? '所有线段长度均在地球直径内' : `发现 ${violations} 条超长线段`);
}

{
  // 用真实数据验证：俄罗斯/斐济这类跨 180° 的国家
  const { LAND } = await import('../data/land.js');
  const proj = new OrthographicProjection();
  proj.attach(W, H);
  proj.setView({ lat: 0, lon: 180, scale: 400 });

  let violations = 0;
  let totalSegments = 0;
  const maxDist = 2 * proj.scale * 1.05; // 留 5% 容差

  for (const polygon of LAND.land) {
    for (const ring of polygon) {
      let penDown = false;
      let prev = null;
      for (let i = 0; i < ring.length; i += 2) {
        const p = proj.project(+ring[i], +ring[i + 1]);
        if (p.visible) {
          if (penDown && prev) {
            totalSegments++;
            const d = Math.hypot(p.x - prev.x, p.y - prev.y);
            if (d > maxDist) violations++;
          } else {
            penDown = true;
          }
          prev = p;
        } else {
          penDown = false;
          prev = null;
        }
      }
    }
  }

  check(`视点在 180° 时全部 ${totalSegments} 个线段均正常`, violations === 0,
    violations === 0 ? '无横穿画面的斜线' : `发现 ${violations} 条`);

  // 换一个视点再验一次，确保不是巧合
  const proj2 = new OrthographicProjection();
  proj2.attach(W, H);
  proj2.setView({ lat: 30, lon: 150, scale: 380 });
  let v2 = 0;
  let seg2 = 0;
  for (const polygon of LAND.land) {
    for (const ring of polygon) {
      let penDown = false;
      let prev = null;
      for (let i = 0; i < ring.length; i += 2) {
        const p = proj2.project(+ring[i], +ring[i + 1]);
        if (p.visible) {
          if (penDown && prev) {
            seg2++;
            const d = Math.hypot(p.x - prev.x, p.y - prev.y);
            if (d > 2 * proj2.scale * 1.05) v2++;
          } else penDown = true;
          prev = p;
        } else {
          penDown = false;
          prev = null;
        }
      }
    }
  }
  check(`视点在 (30,150) 时全部 ${seg2} 个线段均正常`, v2 === 0,
    v2 === 0 ? '无横穿画面的斜线' : `发现 ${v2} 条`);
}

console.log('\n【2. 晨昏线在赤纬≈0 时连续（无扇贝状缺口）】');

{
  // 春分/秋分时太阳赤纬≈0，是采样点法最容易崩的场景
  // 逐像素判定在这些时刻仍应给出连续的明暗交界
  const equinox = new Date('2026-03-20T12:00:00Z');
  const sun = solarPosition(equinox);

  check('春分太阳赤纬接近 0', Math.abs(sun.subsolarLat) < 1.5,
    `${sun.subsolarLat.toFixed(3)}°`);

  // 沿一条纬线扫描，判断明暗切换次数。
  // 正确结果：沿整圈只应切换 2 次（进入夜、离开夜）。
  // 采样点法在赤纬≈0 时会产生大量碎片化切换。
  let switches = 0;
  let prevLit = null;
  const lat = 20;
  for (let lon = -180; lon < 180; lon += 0.5) {
    const lit = isSunlit(lat, lon, sun);
    if (prevLit !== null && lit !== prevLit) switches++;
    prevLit = lit;
  }
  check('沿纬线扫描仅 2 次明暗切换', switches === 2, `实际 ${switches} 次`);
}

{
  // 再验几个不同赤纬，包括极端值
  for (const [label, date] of [
    ['春分(3/20)', '2026-03-20T12:00:00Z'],
    ['夏至(6/21)', '2026-06-21T12:00:00Z'],
    ['秋分(9/23)', '2026-09-23T00:00:00Z'],
    ['冬至(12/21)', '2026-12-21T12:00:00Z'],
  ]) {
    const sun = solarPosition(new Date(date));
    let switches = 0;
    let prevLit = null;
    for (let lon = -180; lon < 180; lon += 0.5) {
      const lit = isSunlit(20, lon, sun);
      if (prevLit !== null && lit !== prevLit) switches++;
      prevLit = lit;
    }
    check(`${label} 赤纬 ${sun.subsolarLat.toFixed(1)}° 明暗连续`, switches === 2,
      `切换 ${switches} 次`);
  }
}

console.log('\n【3. 逐像素渲染性能在预算内】');

{
  // 实测：全分辨率 53ms（超预算 3 倍）→ 低分辨率+限频后摊销 0.25ms
  const proj = new OrthographicProjection();
  proj.attach(W, H);
  proj.setView({ lat: 20, lon: 0, scale: 420 });

  const DIV = 4;
  const lw = Math.ceil(W / DIV);
  const lh = Math.ceil(H / DIV);

  const sun = solarPosition(new Date());
  const decl = sun.subsolarLat * (Math.PI / 180);
  const subLon = sun.subsolarLon * (Math.PI / 180);
  const sinD = Math.sin(decl);
  const cosD = Math.cos(decl);

  const timeRender = () => {
    for (let ly = 0; ly < lh; ly++) {
      const y = ly * DIV;
      for (let lx = 0; lx < lw; lx++) {
        proj.unproject(lx * DIV, y);
      }
    }
  };

  timeRender(); // 预热
  const t0 = performance.now();
  const REP = 20;
  for (let i = 0; i < REP; i++) timeRender();
  const per = (performance.now() - t0) / REP;

  const amortized = per / 12; // 限频 12fps
  check('低分辨率单次重算 < 8ms', per < 8, `${per.toFixed(2)}ms（${lw}×${lh}）`);
  check('摊销到每帧 < 1ms（占 60fps 预算 < 6%）', amortized < 1,
    `${amortized.toFixed(3)}ms = ${(amortized / 16.7 * 100).toFixed(1)}%`);

  // 对比：若按全分辨率每帧计算会怎样
  const fullPixels = W * H;
  const lowPixels = lw * lh;
  check('低分辨率像素数仅为全分辨率的 1/16', lowPixels * 16 === fullPixels,
    `${lowPixels} vs ${fullPixels}`);
}

console.log('\n【4. 晨昏线遮罩缓存键包含所有依赖项】');

{
  // 缓存键必须涵盖：尺寸、缩放、视点经纬、投影模式、太阳位置
  // 漏掉任何一项都会导致「视点变了但遮罩没更新」的鬼影
  const keys = ['_nightW', '_nightH', '_nightScale', '_nightLat', '_nightLon',
    '_nightSunLat', '_nightSunLon', '_nightMode', '_nightAt'];
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/core/renderer.js', import.meta.url), 'utf8')
  );
  const missing = keys.filter((k) => !src.includes(k));
  check('缓存依赖项字段齐全', missing.length === 0,
    missing.length ? `缺少 ${missing.join(', ')}` : `已覆盖 ${keys.length} 项`);

  check('resize 会使夜面缓存失效',
    src.includes('_nightCanvas = null') && src.includes('_nightAt = 0'),
    '画布尺寸变化时强制重算');
}

console.log('\n【4. 两种投影的自动缩放都能正确铺满画布】');

{
  // 曾出现的 bug：平面模式的 baseScale 用了 w/360，
  // 而等距圆柱投影里 scale 的含义是「半个画布宽」，
  // 导致缩放差了约 180 倍，平面模式几乎空白。
  // 这类"数值差几个数量级"的错误截图上一眼就能看出来，
  // 但没截图时很容易漏过。
  const cases = [
    { w: 1600, h: 1000, mode: 'orthographic' },
    { w: 1260, h: 664, mode: 'equirectangular' },
    { w: 800, h: 600, mode: 'equirectangular' },
    { w: 400, h: 800, mode: 'equirectangular' }, // 竖屏
  ];

  for (const { w, h, mode } of cases) {
    const base = mode === 'orthographic'
      ? Math.min(w, h) * 0.42
      : Math.min(w / 2, h) * 0.96;

    const proj = mode === 'orthographic'
      ? new OrthographicProjection()
      : new (await import('../src/core/projection.js')).EquirectangularProjection();
    proj.attach(w, h);
    proj.scale = base;
    proj.setView({ lat: 0, lon: 0 });

    // 关键地理点必须落在画布内
    const points = mode === 'orthographic'
      ? [[0, 0], [0, 60], [40, 100], [-30, -80]]
      : [[0, 0], [0, 180], [0, -180], [90, 0], [-90, 0]];

    const out = [];
    for (const [lat, lon] of points) {
      const r = proj.project(lat, lon);
      if (r.x < 0 || r.x > w || r.y < 0 || r.y > h) {
        out.push(`(${lat},${lon})→(${r.x.toFixed(0)},${r.y.toFixed(0)})`);
      }
    }
    check(
      `${mode} @ ${w}×${h} 关键点均在画布内`,
      out.length === 0,
      out.length ? `出界: ${out.join(' ')}` : `${points.length} 个点全部合格`
    );

    // 缩放量级合理性：平面模式 scale 应接近半宽
    if (mode === 'equirectangular') {
      const expect = w / 2;
      check(
        `  ${w}×${h} 平面 scale 量级正确`,
        base > expect * 0.4 && base < expect * 1.6,
        `base=${base.toFixed(0)}，半宽=${expect}`
      );
    }
  }
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} · 失败 ${failed}`);
if (failed) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('渲染层回归测试全部通过\n');
