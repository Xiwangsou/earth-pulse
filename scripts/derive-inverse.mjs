/**
 * 推导验证：正射投影的逆变换
 *
 * 背景：晨昏线绘制需要逐像素「屏幕坐标 → 经纬度」，
 * 原来的采样点做法会产生条纹伪影（赤纬接近 0 时 tan 发散）。
 * 改用逐像素逆变换后，逆变换公式的正确性就成了关键。
 *
 * 我先试了网上常见的「c = acos(rho)」写法，实测误差 90°~180°，
 * 说明那个公式的前提不成立。这里用代数推导 + 数值验证来确定正确形式。
 *
 * 正向定义（视点纬度 φ0，经度 λ0，Δλ = λ − λ0）：
 *   x = cosφ· sinΔλ
 *   y = cosφ0· sinφ − sinφ0· cosφ· cosΔλ
 *   z = sinφ0· sinφ + cosφ0· cosφ· cosΔλ      （z = cos夹角，>0 可见）
 *
 * 逆推：设 s = sinφ, c1 = cosφ·cosΔλ
 *   由第二式：y = cosφ0·s − sinφ0·c1  →  c1 = (cosφ0·s − y) / sinφ0
 *   由第一式：x = cosφ·sinΔλ，且 x² + c1² = cos²φ = 1 − s²
 *   代入消元：
 *     sin²φ0·(x² + c1²) = sin²φ0·(1 − s²)
 *     sin²φ0·x² + (cosφ0·s − y)² = sin²φ0 − sin²φ0·s²
 *     sin²φ0·x² + cos²φ0·s² − 2cosφ0·s·y + y² = sin²φ0 − sin²φ0·s²
 *     s² − 2cosφ0·y·s + (y² + sin²φ0·x² − sin²φ0) = 0
 *   解这个一元二次方程，取使 z > 0 的根。
 *
 * 特殊情况 sinφ0 = 0（视点在赤道）时上式除零，需单独处理：
 *   此时 y = sinφ 直接可得 φ = asin(y)。
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 参考实现：由正向公式直接算出未归一化的 x, y, z */
function forwardRaw(phi0, lam0, lat, lon) {
  const vR = phi0 * DEG;
  const laR = lat * DEG;
  const loR = (lon - lam0) * DEG;
  const c = Math.cos(laR);
  const s = Math.sin(laR);
  const cv = Math.cos(vR);
  const sv = Math.sin(vR);
  return {
    x: c * Math.sin(loR),
    y: cv * s - sv * c * Math.cos(loR),
    z: sv * s + cv * c * Math.cos(loR),
  };
}

/** 候选逆变换：解一元二次方程 */
function unproject(phi0, lam0, X, Y) {
  const vR = phi0 * DEG;
  const cv = Math.cos(vR);
  const sv = Math.sin(vR);

  // 视点在赤道：sv = 0 时正向式退化为 y = sinφ，c1 项消失
  if (Math.abs(sv) < 1e-12) {
    const lat = Math.asin(Math.max(-1, Math.min(1, Y)));
    const c = Math.cos(lat);
    if (c < 1e-12) return { lat: phi0, lon: lam0 };
    // x = cosφ·sinΔλ 且 cosΔλ ≥ 0（因为 z = cosφ·cosΔλ > 0）
    const sinDLon = X / c;
    const cosDLon = Math.sqrt(Math.max(0, 1 - sinDLon * sinDLon));
    const dLon = Math.atan2(sinDLon, cosDLon) * RAD;
    const lon = ((lam0 + dLon + 540) % 360) - 180;
    return { lat: lat * RAD, lon };
  }

  // s² − 2·cv·Y·s + (Y² + sv²X² − sv²) = 0
  const B = -2 * cv * Y;
  const C = Y * Y + sv * sv * X * X - sv * sv;
  const disc = B * B - 4 * C;
  if (disc < 0) return null;

  const sq = Math.sqrt(disc);
  const candidates = [(-B + sq) / 2, (-B - sq) / 2];

  for (const s of candidates) {
    if (!Number.isFinite(s) || Math.abs(s) > 1) continue;
    const c = Math.sqrt(Math.max(0, 1 - s * s));

    // c1 = cosφ·cosΔλ 由第二式解出（对极点也成立，此时 c1→0）
    const c1 = (cv * s - Y) / sv;

    // 可见性判定：z = sv·s + cv·cosφ·cosΔλ = sv·s + cv·c1
    // 这一步必须在「极点特判」之前做 ——
    // 否则当第一个候选根恰好是极点（cosφ=0）时会误判为可见并提前返回，
    // 导致错过真正的解。这是本次调试中最隐蔽的一个坑。
    const z = sv * s + cv * c1;
    if (z <= 1e-9) continue; // 背面，换另一个根

    const lat = Math.asin(s) * RAD;

    if (c < 1e-12) {
      // 正对视点或极点的退化情形：经度无定义，取视点经度
      return { lat, lon: lam0 };
    }

    // x = cosφ·sinΔλ ⇒ sinΔλ = x / cosφ
    const sinDLon = X / c;
    // cosΔλ = c1 / cosφ
    const cosDLon = c1 / c;
    // 校验两者构成合法单位向量
    if (Math.abs(sinDLon * sinDLon + cosDLon * cosDLon - 1) > 1e-6) continue;

    const dLon = Math.atan2(sinDLon, cosDLon) * RAD;
    const lon = ((lam0 + dLon + 540) % 360) - 180;
    return { lat, lon };
  }
  return null;
}

/* ---------------- 验证 ---------------- */

const VIEWS = [
  { lat: 0, lon: 0 },
  { lat: 20, lon: 0 },
  { lat: 45, lon: 90 },
  { lat: -30, lon: 200 },
  { lat: 70, lon: -45 },
  { lat: -60, lon: 30 },
  { lat: 89, lon: 0 },
];

console.log('正射投影逆变换验证（代数解法）\n');

let globalWorst = 0;
let globalWorstAt = '';
let totalTested = 0;
let totalFailed = 0;

for (const view of VIEWS) {
  let worst = 0;
  let worstAt = '';
  let tested = 0;
  let failed = 0;

  for (let lat = -89; lat <= 89; lat += 1) {
    for (let lon = -180; lon < 180; lon += 1) {
      const f = forwardRaw(view.lat, view.lon, lat, lon);
      if (f.z <= 0.01) continue; // 排除边缘退化区
      tested++;
      const back = unproject(view.lat, view.lon, f.x, f.y);
      if (!back) {
        failed++;
        continue;
      }
      const eLat = Math.abs(back.lat - lat);
      let eLon = Math.abs(back.lon - lon);
      if (eLon > 180) eLon = 360 - eLon;
      const e = Math.max(eLat, eLon);
      if (e > worst) {
        worst = e;
        worstAt = `(${lat},${lon})`;
      }
    }
  }

  totalTested += tested;
  totalFailed += failed;
  if (worst > globalWorst) {
    globalWorst = worst;
    globalWorstAt = `视点(${view.lat},${view.lon}) 点${worstAt}`;
  }

  const status = worst < 1e-6 ? '✓' : worst < 0.01 ? '△' : '✗';
  console.log(
    `  ${status} 视点(${String(view.lat).padStart(3)},${String(view.lon).padStart(4)})  ` +
      `测试 ${String(tested).padStart(5)} 点  最大误差 ${worst.toExponential(2)}°  无解 ${failed}`
  );
}

console.log(`\n全局最大误差: ${globalWorst.toExponential(3)}°`);
console.log(`发生位置: ${globalWorstAt}`);
console.log(`总计测试 ${totalTested} 点，无解 ${totalFailed} 点`);

if (globalWorst < 1e-6 && totalFailed === 0) {
  console.log('\n✓ 逆变换正确，可用于逐像素晨昏线判定');
  process.exit(0);
} else if (globalWorst < 0.01) {
  console.log('\n△ 误差在亚角分量级（0.01°≈1.1km），可视化完全可接受');
  process.exit(0);
} else {
  console.log('\n✗ 逆变换仍不正确，不能用于逐像素判定');
  process.exit(1);
}
