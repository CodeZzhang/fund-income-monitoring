// 通用工具：数字格式化、日期、校验
export function toNum(v) {
  if (v === null || v === undefined || v === '' || v === '--') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 金额：保留 2 位小数，可选带正负号 */
export function fmtMoney(n, withSign = false) {
  const v = toNum(n);
  if (v === null) return '--';
  const abs = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (!withSign) return abs;
  if (Math.abs(v) < 0.005) return abs;
  return (v > 0 ? '+' : '-') + abs;
}

/** 百分比：保留 2 位，带正负号 */
export function fmtPct(n) {
  const v = toNum(n);
  if (v === null) return '--';
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(2) + '%';
}

/** 净值：4 位小数 */
export function fmtNav(n) {
  const v = toNum(n);
  return v === null ? '--' : v.toFixed(4);
}

export function fmtAmount(n) {
  const v = toNum(n);
  return v === null ? '--' : v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 涨跌方向：1 涨 / -1 跌 / 0 平 或未知 */
export function trendOf(n) {
  const v = toNum(n);
  if (v === null || Math.abs(v) < 0.0001) return 0;
  return v > 0 ? 1 : -1;
}

export function trendClass(n) {
  const t = trendOf(n);
  return t > 0 ? 'up' : t < 0 ? 'down' : 'flat';
}

/** 本地日期 YYYY-MM-DD */
export function todayStr(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 毫秒时间戳 → 本地日期 YYYY-MM-DD */
export function tsToDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return todayStr(new Date(n));
}

export function isValidCode(code) {
  return /^\d{6}$/.test(String(code || '').trim());
}

export function isValidAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
