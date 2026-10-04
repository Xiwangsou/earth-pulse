/**
 * timeline.js — 时间轴回溯引擎（核心原创功能）
 *
 * 原项目的数据是「实时流」：看一眼就没了，没法回溯。
 * 我们把它做成一台时间机器：
 *
 *   1. 每隔一段时间抓一次数据快照（snapshot）
 *   2. 用户拖动时间条，重放任意时刻的事件分布
 *   3. 地震波纹按「当时距事件发生过去了多久」重新扩散
 *      —— 拖回3 小时前，能看到当时的波纹正在扩散，而不是现在的
 *
 * 设计取舍：
 *   - 快照存内存，不落盘。刷新即清空。理由：这是个观测工具，
 *     持久化的历史反而会让人误以为是权威存档。数据源自己的历史才是权威的。
 *   - 用环形缓冲，固定容量，避免长时间运行内存无限增长。
 *   - 波纹重放靠「逆推时间」，不需要额外记录 —— 只存事件发生时刻就够了。
 */

/** 环形缓冲区：固定容量，写满就覆盖最旧的 */
export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = [];
  }

  push(item) {
    // 容量为 0 表示显式禁用缓存，短路返回避免无意义的 push+shift 循环
    if (this.capacity <= 0) return item;
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
    return item;
  }

  /** 按时间升序。非有限时间戳排到末尾，避免污染排序结果 */
  toArray() {
    return [...this.items].sort((a, b) => {
      const ta = Number.isFinite(a?.at) ? a.at : Infinity;
      const tb = Number.isFinite(b?.at) ? b.at : Infinity;
      return ta - tb;
    });
  }

  get length() {
    return this.items.length;
  }

  clear() {
    this.items = [];
  }
}

export class Timeline {
  /**
   * @param {object} opts
   * @param {number} opts.snapshotInterval 快照间隔（ms），默认 10 分钟
   * @param {number} opts.capacity 保留多少个快照，默认 144（24 小时）
   */
  constructor({ snapshotInterval = 10 * 60 * 1000, capacity = 144, eventCapacity = 2000 } = {}) {
    this.snapshotInterval = snapshotInterval;
    this.snapshots = new RingBuffer(capacity);
    // 事件缓冲要独立限容：USGS 一天 feed 能有上千条，
    // 若不设上限，长时间运行会把内存吃满，且旧事件早该被裁掉。
    this.events = new RingBuffer(eventCapacity);

    /** 当前回溯位置：null = 跟随实时 */
    this.cursor = null;
    this.listeners = new Set();
    this._lastSnapshotAt = 0;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  /**
   * 记录一批新事件。会自动去重：
   * USGS 的 feed 会返回 24 小时内所有事件，每次轮询大量重复。
   * 用事件 id 去重，这样时间轴回溯时同一次地震不会被画 24 遍。
   */
  ingestEvents(list) {
    // 防御性校验：这一层是数据进入应用的唯一入口，
    // 任何结构性异常都在这里被拦住，绝不让它冒到渲染层。
    // 背景：外部接口改字段、或网络返回截断的 JSON，都不该让整个页面崩掉。
    if (!Array.isArray(list)) {
      this._emit();
      return 0;
    }

    const seen = new Set(this.events.items.map((e) => e.id));
    let added = 0;
    for (const event of list) {
      if (!event || typeof event !== 'object') continue;
      // 必须有可用 id 和时间戳，否则无法去重、也无法回溯，丢弃
      if (event.id == null) continue;
      if (!Number.isFinite(event.at)) continue;
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      this.events.push(event);
      added++;
    }
    if (added) this._emit();
    return added;
  }

  /** 到点就抓一个新快照 */
  maybeSnapshot(now, collect) {
    if (now - this._lastSnapshotAt < this.snapshotInterval) return null;
    this._lastSnapshotAt = now;
    const snapshot = {
      at: now,
      quakes: collect('quakes'),
      iss: collect('iss'),
      weather: collect('weather'),
      air: collect('air'),
    };
    this.snapshots.push(snapshot);
    this._emit();
    return snapshot;
  }

  /**
   * 取「当前时刻」应该显示的数据。
   * cursor 为 null → 返回最新快照；否则返回最接近该时刻的快照。
   */
  current() {
    const all = this.snapshots.toArray();
    if (all.length === 0) return null;
    if (this.cursor === null) return all[all.length - 1];

    // 二分找最近快照
    let lo = 0;
    let hi = all.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].at < this.cursor) lo = mid + 1;
      else hi = mid;
    }
    // 在 lo 和 lo-1 之间选时间更近的那个
    const candidates = [all[lo]];
    if (lo > 0) candidates.push(all[lo - 1]);
    candidates.sort(
      (a, b) => Math.abs(a.at - this.cursor) - Math.abs(b.at - this.cursor)
    );
    return candidates[0];
  }

  /** 拖动时间条 */
  seek(at) {
    const range = this.range();
    this.cursor = at === null ? null : Math.max(range[0], Math.min(range[1], at));
    this._emit();
  }

  /** 回到实时 */
  live() {
    this.cursor = null;
    this._emit();
  }

  get isLive() {
    return this.cursor === null;
  }

  range() {
    const all = this.snapshots.toArray();
    if (all.length < 2) return [Date.now() - 3600_000, Date.now()];
    return [all[0].at, all[all.length - 1].at];
  }

  /**
   * 取某时刻「已经发生」的事件。
   * 这是回溯正确性的关键：拖回3 小时前，只能看到 3 小时前已经发生的地震，
   * 未来发生的绝不能出现——否则回溯就没有意义了。
   */
  eventsAt(at, { withinMs = 24 * 3600 * 1000 } = {}) {
    return this.events
      .toArray()
      .filter((e) => e.at <= at && e.at >= at - withinMs);
  }

  stats(at) {
    const events = this.eventsAt(at);
    const byDay = new Map();
    let maxMag = 0;
    let sumMag = 0;
    const regions = new Map();

    for (const e of events) {
      const day = new Date(e.at).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      if (e.mag != null) {
        maxMag = Math.max(maxMag, e.mag);
        sumMag += e.mag;
      }
      // 用地点字符串做粗粒度区域统计（USGS place 形如 "295 km S of Burica, Panama"）
      const country = e.country || extractCountry(e.place);
      if (country) regions.set(country, (regions.get(country) || 0) + 1);
    }

    return {
      total: events.length,
      maxMag,
      avgMag: events.length ? sumMag / events.length : 0,
      byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      topRegions: [...regions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    };
  }
}

/** 从 USGS place 字段里抠出国家名 —— "295 km S of Burica, Panama" -> "Panama" */
function extractCountry(place) {
  if (!place) return null;
  const parts = String(place).split(',');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].trim();
  // 过滤掉明显不是国家名的（长度过短或是数字）
  if (last.length < 3 || /^\d/.test(last)) return null;
  return last;
}
