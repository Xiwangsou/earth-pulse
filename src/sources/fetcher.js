/**
 * fetcher.js — 统一数据获取层
 *
 * 设计要点：
 *  1. 超时控制：所有请求 12s 硬超时，避免一个源挂住整条流水线。
 *  2. 失败降级：单个源失败只标记该源为 stale，不影响其他源渲染。
 *  3. 缓存：带 TTL 的内存缓存，减少对公开 API 的礼貌性请求。
 *     USGS feed 本身给的是 24 小时窗口，轮询过于频繁没有意义。
 *  4. 重试：网络抖动时指数退避重试两次。
 *
 * 已实测（2026-10-04，Python 直连验证）：
 *   USGS              Access-Control-Allow-Origin: *
 *   Open-Meteo 预报    Access-Control-Allow-Origin: *
 *   Open-Meteo 空气质量 Access-Control-Allow-Origin: *
 *   wheretheiss.at    Access-Control-Allow-Origin: *
 *   OpenSky           Access-Control-Allow-Origin: https://opensky-network.org  ← 浏览器不可用，已弃用
 */

const DEFAULT_TIMEOUT = 12000;

export class SourceState {
  constructor(name) {
    this.name = name;
    this.status = 'idle'; // idle | loading | ok | stale | error
    this.lastOkAt = null;
    this.lastError = null;
    this.data = null;
  }

  markLoading() {
    this.status = 'loading';
  }

  markOk(data, now) {
    this.status = 'ok';
    this.data = data;
    this.lastOkAt = now;
    this.lastError = null;
  }

  /** 拉取失败但手里还有旧数据 —— 降级为 stale，比显示空白好 */
  markStale(error, now) {
    this.status = this.data != null ? 'stale' : 'error';
    this.lastError = error;
    this.staleSince = this.lastOkAt ? now - this.lastOkAt : null;
  }
}

const cache = new Map();

async function request(url, { timeout = DEFAULT_TIMEOUT, retries = 2, json = true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: json ? 'application/json' : '*/*' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === 'AbortError' ? new Error('请求超时') : err;
      if (attempt < retries) {
        // 指数退避 + 抖动，避免多个源同时重试撞在一起
        await sleep(600 * 2 ** attempt + Math.random() * 300);
      }
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带缓存的拉取。ttl 内直接返回缓存，不打网络。
 */
export async function fetchCached(key, url, ttl, opts = {}) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return hit.value;
  const value = await request(url, opts);
  cache.set(key, { at: now, value });
  return value;
}

export function clearCache() {
  cache.clear();
}

/* ==================================================================
 *  地震 — USGS（美国地质调查局，公有领域）
 *  文档：https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
 * ================================================================== */

export const QUAKE_SOURCE = {
  id: 'usgs',
  label: 'USGS 地震',
  attribution: 'U.S. Geological Survey',
  license: '美国公有领域',
  // all_day = 过去 24 天所有地震；all_hour = 过去一小时
  feeds: {
    day: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    week: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson',
    hour: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_hour.geojson',
  },
  intervalMs: 4 * 60 * 1000,
};

export async function fetchQuakes(state, { feed = 'week', minMag = 2.5 } = {}) {
  state.markLoading();
  const url = QUAKE_SOURCE.feeds[feed];
  try {
    const raw = await fetchCached(`quakes:${feed}`, url, 3 * 60 * 1000);
    const quakes = (raw.features || [])
      .map((f) => ({
        id: f.id,
        mag: f.properties.mag,
        place: f.properties.place,
        at: f.properties.time,
        lat: f.geometry?.coordinates?.[1],
        lon: f.geometry?.coordinates?.[0],
        depth: f.geometry?.coordinates?.[2],
        url: f.properties.url,
        tsunami: f.properties.tsunami === 1,
        country: null,
      }))
      .filter((q) => q.lat != null && q.mag != null && q.mag >= minMag);

    quakes.sort((a, b) => b.at - a.at);
    state.markOk(quakes, Date.now());
    return quakes;
  } catch (err) {
    state.markStale(err, Date.now());
    return state.data || [];
  }
}

/* ==================================================================
 *  天气 + 空气质量 — Open-Meteo（CC BY 4.0，公开免 key）
 *  这是本项目对所选观测城市的实时观测，城市列表见 ui/sites.js
 * ================================================================== */

export const WEATHER_SOURCE = {
  id: 'open-meteo',
  label: 'Open-Meteo 气象',
  attribution: 'Weather data by Open-Meteo.com',
  license: 'CC BY 4.0',
  url: 'https://api.open-meteo.com/v1/forecast',
  airUrl: 'https://air-quality-api.open-meteo.com/v1/air-quality',
  intervalMs: 10 * 60 * 1000,
};

/** WMO 天气代码 -> 中文描述 + 图标字符（用几何图形，不依赖 emoji） */
const WMO = {
  0: ['晴', 'clear'],
  1: ['大部晴朗', 'clear'],
  2: ['局部多云', 'partly'],
  3: ['阴', 'cloud'],
  45: ['雾', 'fog'],
  48: ['雾凇', 'fog'],
  51: ['毛毛雨', 'drizzle'],
  53: ['小雨', 'drizzle'],
  55: ['中雨', 'rain'],
  61: ['小雨', 'rain'],
  63: ['中雨', 'rain'],
  65: ['大雨', 'rain'],
  71: ['小雪', 'snow'],
  73: ['中雪', 'snow'],
  75: ['大雪', 'snow'],
  80: ['阵雨', 'rain'],
  81: ['强阵雨', 'rain'],
  82: ['暴雨', 'rain'],
  95: ['雷阵雨', 'storm'],
  96: ['雷阵雨伴冰雹', 'storm'],
  99: ['强雷暴伴冰雹', 'storm'],
};

export function describeWeather(code) {
  return WMO[code] || ['未知', 'clear'];
}

export async function fetchWeather(state, { lat, lon }) {
  state.markLoading();
  const url =
    `${WEATHER_SOURCE.url}?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,' +
    'wind_speed_10m,wind_direction_10m,surface_pressure,weather_code,is_day' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=3';
  try {
    const raw = await fetchCached(`weather:${lat},${lon}`, url, 8 * 60 * 1000);
    const cur = raw.current;
    const data = {
      lat,
      lon,
      at: Date.now(),
      temp: cur.temperature_2m,
      feels: cur.apparent_temperature,
      humidity: cur.relative_humidity_2m,
      precipitation: cur.precipitation,
      windSpeed: cur.wind_speed_10m,
      windDir: cur.wind_direction_10m,
      pressure: cur.surface_pressure,
      code: cur.weather_code,
      isDay: cur.is_day === 1,
      desc: describeWeather(cur.weather_code),
      daily: raw.daily || null,
    };
    state.markOk(data, Date.now());
    return data;
  } catch (err) {
    state.markStale(err, Date.now());
    return state.data;
  }
}

export async function fetchAirQuality(state, { lat, lon }) {
  state.markLoading();
  const url =
    `${WEATHER_SOURCE.airUrl}?latitude=${lat}&longitude=${lon}` +
    '&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,european_aqi,us_aqi';
  try {
    const raw = await fetchCached(`air:${lat},${lon}`, url, 15 * 60 * 1000);
    const cur = raw.current;
    const data = {
      at: Date.now(),
      pm25: cur.pm2_5,
      pm10: cur.pm10,
      co: cur.carbon_monoxide,
      no2: cur.nitrogen_dioxide,
      so2: cur.sulphur_dioxide,
      o3: cur.ozone,
      aqi: cur.european_aqi,
      usAqi: cur.us_aqi,
    };
    state.markOk(data, Date.now());
    return data;
  } catch (err) {
    state.markStale(err, Date.now());
    return state.data;
  }
}

/** 欧洲 AQI 等级划分 —— 决定 UI 上显示什么颜色 */
export function aqiLevel(aqi) {
  if (aqi == null) return { label: '无数据', color: '#64748b', grade: 0 };
  if (aqi <= 20) return { label: '优', color: '#4ade80', grade: 1 };
  if (aqi <= 40) return { label: '良', color: '#a3e635', grade: 2 };
  if (aqi <= 60) return { label: '中等', color: '#facc15', grade: 3 };
  if (aqi <= 80) return { label: '较差', color: '#fb923c', grade: 4 };
  return { label: '极差', color: '#f87171', grade: 5 };
}

/** 蒲福风级 —— 把风速数值变成人话 */
export function windLevel(speedKmh) {
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

/* ==================================================================
 *  国际空间站 — wheretheiss.at（公开接口，无需 key）
 *  卫星位置每 2 秒更新一次，是本项目"动起来"的关键
 * ================================================================== */

export const ISS_SOURCE = {
  id: 'wheretheiss',
  label: 'ISS 位置',
  attribution: 'wheretheiss.at',
  license: '公开接口',
  url: 'https://api.wheretheiss.at/v1/satellites/25544',
  intervalMs: 2000,
};

export async function fetchIss(state) {
  state.markLoading();
  try {
    // 位置变化快，缓存时间给到 1.5s，避免拖影
    const raw = await fetchCached('iss', ISS_SOURCE.url, 1500, { retries: 1 });
    const data = {
      id: raw.id,
      lat: raw.latitude,
      lon: raw.longitude,
      altitude: raw.altitude,
      velocity: raw.velocity,
      footprint: raw.footprint,
      visibility: raw.visibility,
      solarLat: raw.solar_lat,
      solarLon: raw.solar_lon,
      at: Date.now(),
    };
    state.markOk(data, Date.now());
    return data;
  } catch (err) {
    state.markStale(err, Date.now());
    return state.data;
  }
}

/** 接地可见性：纬度差 < 足迹半径时能直接看到 */
export function issVisibleFrom(iss, lat, lon) {
  if (!iss) return false;
  const R = 6371;
  const dLat = (iss.lat - lat) * (Math.PI / 180);
  const dLon = (iss.lon - lon) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat * (Math.PI / 180)) * Math.cos(iss.lat * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
  const dist = 2 * R * Math.asin(Math.sqrt(a));
  return dist < (iss.footprint || 4500) / 2;
}
