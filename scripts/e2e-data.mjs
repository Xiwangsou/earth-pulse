/**
 * e2e-data.mjs — 数据层端到端验证
 *
 * verify.mjs 验证的是「我们的数学对不对」，
 * 这个脚本验证的是「我们的解析逻辑能不能吃下真实的线上数据」。
 *
 * 后者更重要：数学正确但字段名猜错，页面上就是一片空白，
 * 而这种错误只有拿真数据跑一遍才能发现。
 *
 * 运行：node scripts/e2e-data.mjs
 */

import {
  fetchQuakes,
  fetchWeather,
  fetchAirQuality,
  fetchIss,
  SourceState,
  aqiLevel,
  issVisibleFrom,
  describeWeather,
} from '../src/sources/fetcher.js';
import { SITES, DEFAULT_SITE } from '../src/ui/sites.js';

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

console.log('\n【USGS 地震 · 真实请求】');
{
  const state = new SourceState('usgs');
  const quakes = await fetchQuakes(state, { feed: 'day', minMag: 2.5 });

  check('拉取成功', state.status === 'ok', `status=${state.status}`);
  check('返回非空列表', quakes.length > 0, `${quakes.length} 条`);

  if (quakes.length) {
    const q = quakes[0];
    check('字段完整（id/mag/place/at/lat/lon）',
      q.id && q.mag != null && q.place && q.at && q.lat != null && q.lon != null);
    check('经纬度在合法范围内', quakes.every(x =>
      Math.abs(x.lat) <= 90 && Math.abs(x.lon) <= 180));
    check('震级均为正数', quakes.every(x => x.mag > 0));
    check('时间戳合理（近 24 小时内）',
      Date.now() - q.at < 24 * 3600_000, `最新事件 ${Math.round((Date.now() - q.at) / 3600000)} 小时前`);
    check('按时间倒序排列',
      quakes.every((x, i) => i === 0 || quakes[i - 1].at >= x.at));
    check('无重复 id', new Set(quakes.map(x => x.id)).size === quakes.length);

    const withM6 = quakes.filter(x => x.mag >= 6);
    console.log(`    · 震级范围 ${Math.min(...quakes.map(x => x.mag)).toFixed(1)} – ${Math.max(...quakes.map(x => x.mag)).toFixed(1)}`);
    console.log(`    · M6+ 事件 ${withM6.length} 条`);
    console.log(`    · 最新：M${q.mag?.toFixed(1)} ${q.place}`);
  }
}

console.log('\n【Open-Meteo 气象 · 多城市真实请求】');
{
  // 逐个站点拉一遍，确认所有配置的城市坐标都有效、接口都通。
  // 以前这里只测了东莞一个点，坐标写错的城市根本不会被发现。
  const results = [];
  for (const site of SITES) {
    const state = new SourceState(`weather-${site.id}`);
    const w = await fetchWeather(state, { lat: site.lat, lon: site.lon });
    const ok = state.status === 'ok' && w && w.temp > -60 && w.temp < 60;
    results.push({ site, w, ok });
    check(
      `${site.label}（${site.region}）气象可取`,
      ok,
      w ? `${w.temp.toFixed(1)}°C ${w.desc[0]}` : state.lastError?.message || '无数据'
    );
  }

  // 拉尔数据彼此差异性检查：若所有城市返回同一温度，说明坐标没生效
  const temps = results.map((r) => r.w?.temp).filter((t) => t != null);
  const spread = Math.max(...temps) - Math.min(...temps);
  check('各城市温度存在合理差异（坐标确实生效）', spread > 0.5,
    `温差 ${spread.toFixed(1)}°C`);
  check('每个城市的湿度均在 0-100',
    results.every((r) => r.w && r.w.humidity >= 0 && r.w.humidity <= 100));
  check('每个城市气压均在合理区间',
    results.every((r) => r.w && r.w.pressure > 500 && r.w.pressure < 1100));
  // 气压与海拔必须负相关：这是对"坐标是否真的生效"最强的交叉验证。
  // 若坐标写错，沿海与高原的气压会趋同。
  const ELEV = { ls: 3650, cd: 500, xa: 400, bj: 44, wh: 37, nj: 20, sh: 4, hz: 10, sz: 4, gz: 21 };
  const byElev = [...results].sort((a, b) => (ELEV[b.site.id] ?? 0) - (ELEV[a.site.id] ?? 0));
  check('气压随海拔升高而降低（物理一致性）',
    byElev[0].w.pressure < byElev[byElev.length - 1].w.pressure,
    `${byElev[0].site.label}(${ELEV[byElev[0].site.id]}m) ${byElev[0].w.pressure.toFixed(0)}hPa < ` +
    `${byElev[byElev.length - 1].site.label}(${ELEV[byElev[byElev.length - 1].site.id]}m) ${byElev[byElev.length - 1].w.pressure.toFixed(0)}hPa`);
  check('每个城市天气代码均已翻译',
    results.every((r) => r.w && typeof r.w.desc[0] === 'string' && r.w.desc[0].length > 0));
  check('每个城市均有三日预报',
    results.every((r) => r.w?.daily?.time?.length === 3));

  // 极值校验：拉萨海拔 3650m，气压应显著低于沿海城市
  const lhasa = results.find((r) => r.site.id === 'ls');
  const coastal = results.find((r) => r.site.id === 'sz');
  if (lhasa?.w && coastal?.w) {
    check('高原气压低于沿海（海拔效应正确）', lhasa.w.pressure < coastal.w.pressure,
      `拉萨 ${lhasa.w.pressure.toFixed(0)}hPa < 深圳 ${coastal.w.pressure.toFixed(0)}hPa`);
  }
}

console.log('\n【Open-Meteo 空气质量 · 多城市真实请求】');
{
  const results = [];
  for (const site of SITES) {
    const state = new SourceState(`air-${site.id}`);
    const a = await fetchAirQuality(state, { lat: site.lat, lon: site.lon });
    const ok = state.status === 'ok' && a && a.aqi >= 0 && a.aqi <= 500;
    results.push({ site, a, ok });
    check(`${site.label}空气质量可取`, ok, a ? `AQI ${Math.round(a.aqi)}` : state.lastError?.message || '无数据');
  }
  check('AQI 等级映射对所有城市均有效',
    results.every((r) => typeof aqiLevel(r.a.aqi).label === 'string'));
  check('PM2.5 均为非负合理值',
    results.every((r) => r.a.pm25 >= 0 && r.a.pm25 <= 1000));
}

console.log('\n【ISS 位置 · 真实请求】');
{
  const state = new SourceState('iss');
  const iss = await fetchIss(state);

  check('拉取成功', state.status === 'ok', `status=${state.status}`);
  check('经纬度合法', iss && Math.abs(iss.lat) <= 90 && Math.abs(iss.lon) <= 180,
    iss ? `${iss.lat.toFixed(3)}, ${iss.lon.toFixed(3)}` : '');
  check('轨道高度在合理范围 300-450 km', iss && iss.altitude > 300 && iss.altitude < 450,
    iss ? `${iss.altitude.toFixed(1)} km` : '');
  check('速度约 27600 km/h', iss && iss.velocity > 27000 && iss.velocity < 28200,
    iss ? `${iss.velocity.toFixed(0)} km/h` : '');
  check('地面足迹为正数', iss && iss.footprint > 1000,
    iss ? `${iss.footprint.toFixed(0)} km` : '');

  // 可见性判定：站点应在足迹内或外，两种都要能算出来
  if (iss) {
    const vis = issVisibleFrom(iss, DEFAULT_SITE.lat, DEFAULT_SITE.lon);
    check('可见性判定可用', typeof vis === 'boolean', `${DEFAULT_SITE.label}可见=${vis}`);

    // 逐城市扫一遍，确认没有城市会算出非法结果
    const verdicts = SITES.map((s) => issVisibleFrom(iss, s.lat, s.lon));
    check('所有城市可见性判定均为布尔值', verdicts.every((v) => typeof v === 'boolean'));
    console.log(`    · 当前过顶城市：${SITES.filter((s, i) => verdicts[i]).map((s) => s.label).join('、') || '无（足迹未覆盖任何配置城市）'}`);

    const near = issVisibleFrom(iss, iss.lat, iss.lon);
    check('正下方站点必然可见', near === true);
    const antipode = issVisibleFrom(iss, -iss.lat, iss.lon + 180);
    check('对跖点必然不可见', antipode === false);
  }
}

console.log('\n【站点配置静态校验】');
{
  check('站点数量充足（>=8）', SITES.length >= 8, `${SITES.length} 个`);

  const ids = SITES.map((s) => s.id);
  check('id 无重复', new Set(ids).size === ids.length);
  const labels = SITES.map((s) => s.label);
  check('城市名无重复', new Set(labels).size === labels.length);

  check('已移除东莞', !labels.includes('东莞') && !ids.includes('dg'));

  check('所有坐标在合法范围内', SITES.every((s) =>
    Number.isFinite(s.lat) && Number.isFinite(s.lon) &&
    Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180));

  check('所有颜色为合法 hex', SITES.every((s) => /^#[0-9a-f]{6}$/i.test(s.color)));

  check('每个站点都有地区标签', SITES.every((s) => s.region && s.region.length > 0));

  // 坐标合理性抽查：每个城市的经纬度必须落在它实际所在的大致区域。
  // 这类"写错数字"的错误（如把北京的经度写成上海的）光看数值范围是发现不了的。
  const REGION_BOUNDS = {
    华南: { lat: [18, 26], lon: [103, 117] },
    华东: { lat: [27, 35], lon: [115, 122] },
    华北: { lat: [36, 43], lon: [113, 120] },
    华中: { lat: [29, 33], lon: [110, 117] },
    西南: { lat: [26, 33], lon: [97, 110] },
    西北: { lat: [31, 38], lon: [103, 111] },
    高原: { lat: [27, 32], lon: [88, 94] },
  };
  for (const s of SITES) {
    const b = REGION_BOUNDS[s.region];
    check(`${s.label}坐标落在${s.region}合理范围内`,
      b && s.lat >= b.lat[0] && s.lat <= b.lat[1] && s.lon >= b.lon[0] && s.lon <= b.lon[1],
      `(${s.lat}, ${s.lon})`);
  }

  check('默认站点存在于列表中', SITES.some((s) => s.id === DEFAULT_SITE.id));
  check('地理区覆盖 >= 5 个', new Set(SITES.map((s) => s.region)).size >= 5,
    [...new Set(SITES.map((s) => s.region))].join('、'));
}

console.log('\n【WMO 天气代码翻译】');
for (const [code, expect] of [[0, '晴'], [95, '雷阵雨'], [71, '小雪'], [45, '雾']]) {
  const d = describeWeather(code);
  check(`代码 ${code} → ${expect}`, d[0] === expect, `得到「${d[0]}」`);
}
check('未知代码有兜底', describeWeather(999)[0] === '未知');

console.log('\n【故障降级】');
{
  const state = new SourceState('usgs');
  // 用一个必然失败的 URL 触发降级路径
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('模拟网络中断');
  };
  const { clearCache } = await import('../src/sources/fetcher.js');
  clearCache();
  const quakes = await fetchQuakes(state, { feed: 'day' });
  globalThis.fetch = originalFetch;
  clearCache();

  check('单源失败不抛异常', Array.isArray(quakes), '返回空数组而非崩溃');
  check('状态标记为 error', state.status === 'error', `status=${state.status}`);
  check('记录了错误信息', Boolean(state.lastError));
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${passed} · 失败 ${failed}`);
if (failed) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('数据层端到端验证全部通过\n');
