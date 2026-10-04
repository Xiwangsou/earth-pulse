/**
 * sites.js — 可选观测城市
 *
 * 为什么独立成文件：站点列表是用户可见的功能配置，不该混在 UI 组件里。
 * 增删城市只改这一处，侧栏、验证脚本都能自动跟上。
 *
 * 坐标说明：均为城市中心点（WGS84 近似值，精度到城市级足够）。
 * 数据源是按坐标就近取数的网格数据，几十公里误差对城市观测无影响。
 *
 * 挑选逻辑：覆盖四大地理区 + 气候带差异明显的城市，
 * 这样切换站点时能直观看到数据是真的在变，而不是同一份东西换个名字。
 */

export const SITES = [
  // 华南
  { id: 'sz', label: '深圳', region: '华南', lat: 22.5431, lon: 114.0579, color: '#34d399' },
  { id: 'gz', label: '广州', region: '华南', lat: 23.1291, lon: 113.2644, color: '#4ade80' },
  // 华东
  { id: 'sh', label: '上海', region: '华东', lat: 31.2304, lon: 121.4737, color: '#60a5fa' },
  { id: 'hz', label: '杭州', region: '华东', lat: 30.2741, lon: 120.1551, color: '#38bdf8' },
  { id: 'nj', label: '南京', region: '华东', lat: 32.0603, lon: 118.7969, color: '#818cf8' },
  // 华北
  { id: 'bj', label: '北京', region: '华北', lat: 39.9042, lon: 116.4074, color: '#a78bfa' },
  // 华中 / 西南 / 西北
  { id: 'wh', label: '武汉', region: '华中', lat: 30.5928, lon: 114.3055, color: '#f472b6' },
  { id: 'cd', label: '成都', region: '西南', lat: 30.5728, lon: 104.0668, color: '#fbbf24' },
  { id: 'xa', label: '西安', region: '西北', lat: 34.3416, lon: 108.9398, color: '#fb923c' },
  // 高原（海拔差异显著，气压与紫外线数据明显不同）
  { id: 'ls', label: '拉萨', region: '高原', lat: 29.6520, lon: 91.1721, color: '#c084fc' },
];

/** 默认站点。选深圳是因为它在最东南，能让地球自转时较快看到数据变化。 */
export const DEFAULT_SITE_ID = 'sz';

export const DEFAULT_SITE = SITES.find((s) => s.id === DEFAULT_SITE_ID) || SITES[0];

export function getSite(id) {
  return SITES.find((s) => s.id === id) || DEFAULT_SITE;
}
