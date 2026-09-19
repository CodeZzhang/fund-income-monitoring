// 数据接口层：双数据源 + 本地缓存 + 降级策略
//
// 数据源 A（主）：天天基金移动端开放接口，响应带 Access-Control-Allow-Origin: *，
//                 体积小、字段全，但仅移动端 UA 可用（桌面浏览器会返回「网络繁忙」）。
// 数据源 B（兜底）：fund.eastmoney.com/pingzhongdata/{code}.js，以 <script> 方式加载，
//                 不受 CORS 限制，桌面 / 移动均可用，但体积较大（数百 KB），故内存缓存 10 分钟。
import {
  API_BASE, API_COMMON, SEARCH_API, PINGZHONG_API,
  REQUEST_TIMEOUT, CONCURRENCY, HISTORY_SIZE, CACHE_TTL, PZ_TTL,
  INTRADAY_MAX_POINTS, BATCH_SIZE,
} from './config.js';
import { store } from './db.js';
import { toNum, todayStr, tsToDate } from './utils.js';

export class ApiError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ApiError';
  }
}

/* ---------------- 基础请求 ---------------- */
async function getJson(url, timeout = REQUEST_TIMEOUT) {
  let ctrl;
  let timer = null;
  if (typeof AbortController !== 'undefined') {
    ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeout);
  }
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) throw new ApiError('接口返回 ' + res.status);
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError('请求超时');
    if (e instanceof ApiError) throw e;
    throw new ApiError('网络异常，请稍后重试');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** JSONP / 脚本加载：经典 <script> 不受同源策略限制 */
function loadScript(url, { timeout = REQUEST_TIMEOUT, read, failMsg } = {}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new ApiError('请求超时')); }, timeout);
    function cleanup() {
      clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    script.onload = () => {
      cleanup();
      try { resolve(read ? read() : undefined); } catch (e) { reject(new ApiError('数据解析失败')); }
    };
    script.onerror = () => { cleanup(); reject(new ApiError(failMsg || '网络异常，请稍后重试')); };
    script.src = url;
    document.head.appendChild(script);
  });
}

function jsonp(url, cbParam = 'callback', timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const cbName = '__fmcb_' + Math.random().toString(36).slice(2, 9);
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new ApiError('请求超时')); }, timeout);
    function cleanup() {
      clearTimeout(timer);
      try { window[cbName] = undefined; } catch (e) { /* noop */ }
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cbName] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new ApiError('网络异常')); };
    script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + cbParam + '=' + cbName;
    document.head.appendChild(script);
  });
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

function prevNavOf(nav, rate) {
  if (nav === null || rate === null || rate <= -100) return null;
  return nav / (1 + rate / 100);
}

/* ---------------- 数据源 A：天天基金移动端接口 ---------------- */
async function infoFromMobile(code) {
  const url = `${API_BASE}/FundMNBasicInformation?${API_COMMON}&FCODE=${encodeURIComponent(code)}&_=${Date.now()}`;
  const j = await getJson(url);
  const d = j && j.Datas;
  if (!d) throw new ApiError('未查询到该基金，请检查代码');
  const nav = toNum(d.DWJZ);
  const rate = toNum(d.RZDF);
  const navDate = d.FSRQ || '';
  return {
    code: String(d.FCODE || code),
    name: stripTags(d.SHORTNAME) || String(code),
    type: stripTags(d.FTYPE),
    company: stripTags(d.JJGS),
    nav,
    prevNav: prevNavOf(nav, rate),
    rate,
    navDate,
    settled: !!navDate && navDate === todayStr(),
    source: 'mobile',
  };
}

/**
 * 批量行情（含盘中估值）：一次请求取多只，字段见下
 * NAV/NAVCHGRT/PDATE = 最新已公布净值 / 日涨幅 / 净值日期
 * GSZ/GSZZL/GZTIME   = 盘中估算净值 / 估算涨跌幅 / 估算时间（非交易日为 null）
 */
function parseBatchItem(d) {
  if (!d || !d.FCODE) return null;
  const publishedNav = toNum(d.NAV);
  const publishedDate = d.PDATE || '';
  const gsz = toNum(d.GSZ);
  const gszzl = toNum(d.GSZZL);
  const gztime = d.GZTIME || '';
  const isEstimate = gsz !== null && gszzl !== null;
  const today = todayStr();

  let nav;
  let rate;
  let navDate;
  let settled;
  let prevNav;
  if (isEstimate) {
    nav = gsz;
    rate = gszzl;
    navDate = gztime.slice(0, 10) || today;
    settled = false;
    prevNav = publishedNav !== null ? publishedNav : prevNavOf(gsz, gszzl);
  } else {
    nav = publishedNav;
    rate = toNum(d.NAVCHGRT);
    navDate = publishedDate;
    settled = !!publishedDate && publishedDate === today;
    prevNav = prevNavOf(nav, rate);
  }
  return {
    code: String(d.FCODE),
    name: stripTags(d.SHORTNAME) || String(d.FCODE),
    type: '',
    company: '',
    nav,
    prevNav,
    rate,
    navDate,
    settled,
    isEstimate,
    estimate: isEstimate ? { value: gsz, rate: gszzl, time: gztime } : null,
    accNav: toNum(d.ACCNAV),
    source: 'mobile',
  };
}

async function fetchBatch(codes) {
  const url = `${API_BASE}/FundMNFInfo?${API_COMMON}&Fcodes=${codes.join(',')}`
    + `&pageIndex=1&pageSize=${Math.max(20, codes.length)}&_=${Date.now()}`;
  const j = await getJson(url);
  const list = (j && j.Datas) || [];
  if (!list.length) throw new ApiError('批量行情为空');
  const map = {};
  list.forEach((d) => {
    const item = parseBatchItem(d);
    if (item) map[item.code] = item;
  });
  return map;
}

/** 批量取行情：先逐只取基本信息（含类型/公司），再用一次批量请求补盘中估值 */
export async function fetchQuotes(codes) {
  const result = {};
  const queue = codes.slice();
  const size = Math.max(1, Math.min(CONCURRENCY, queue.length));
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) {
      const code = queue.shift();
      try {
        result[code] = await fetchFundInfo(code);
      } catch (e) {
        result[code] = null;
      }
    }
  }));

  try {
    for (let i = 0; i < codes.length; i += BATCH_SIZE) {
      const map = await fetchBatch(codes.slice(i, i + BATCH_SIZE));
      Object.keys(map).forEach((c) => {
        const item = map[c];
        const base = result[c];
        if (!base) { result[c] = item; return; }
        if (item.isEstimate) {
          result[c] = {
            ...base,
            nav: item.nav, prevNav: item.prevNav, rate: item.rate,
            navDate: item.navDate, settled: false,
            isEstimate: true, estimate: item.estimate, source: 'mobile+gz',
          };
        } else {
          result[c] = { ...base, isEstimate: false, estimate: null };
        }
      });
    }
  } catch (e) { /* 估值接口不可用（如桌面 UA）时忽略，沿用已公布净值 */ }
  return result;
}

/** 记录当日分时采样点（仅盘中估算有效时） */
export async function recordIntraday(code, quote) {
  if (!quote || quote.error || !quote.isEstimate || !quote.estimate) return null;
  const date = todayStr();
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const t = `${p(now.getHours())}:${p(now.getMinutes())}`;

  let rec = null;
  try { rec = await store.getIntraday(code); } catch (e) { rec = null; }
  if (!rec || rec.date !== date || !Array.isArray(rec.points)) {
    rec = { fund_code: code, date, base: quote.prevNav, points: [] };
  }
  if (quote.prevNav !== null) rec.base = quote.prevNav;

  const point = { t, v: quote.estimate.value, r: quote.estimate.rate };
  const last = rec.points[rec.points.length - 1];
  if (last && last.t === t) rec.points[rec.points.length - 1] = point;
  else rec.points.push(point);
  if (rec.points.length > INTRADAY_MAX_POINTS) rec.points = rec.points.slice(-INTRADAY_MAX_POINTS);
  rec.last_update = Date.now();

  try { await store.setIntraday(rec); } catch (e) { /* 存储失败不影响展示 */ }
  return rec;
}

export async function getIntraday(code) {
  try {
    const rec = await store.getIntraday(code);
    if (rec && rec.date === todayStr() && Array.isArray(rec.points)) return rec;
  } catch (e) { /* noop */ }
  return null;
}

async function historyFromMobile(code) {
  const url = `${API_BASE}/FundMNHisNetList?${API_COMMON}&FCODE=${encodeURIComponent(code)}`
    + `&pageIndex=1&pageSize=${HISTORY_SIZE}&_=${Date.now()}`;
  const j = await getJson(url);
  const list = (j && j.Datas) || [];
  const data = list
    .map((x) => ({ date: x.FSRQ, value: toNum(x.DWJZ), rate: toNum(x.JZZZL) }))
    .filter((x) => !!x.date && x.value !== null)
    .reverse(); // 接口按日期倒序，转成正序便于画图
  if (!data.length) throw new ApiError('暂无历史净值数据');
  return data;
}

/* ---------------- 数据源 B：pingzhongdata（脚本加载，全平台可用） ---------------- */
const pzMemo = new Map();   // code -> { name, data, ts }
let pzQueue = Promise.resolve();

function loadPingZhongRaw(code) {
  // 串行加载：脚本通过全局变量回传数据，并发会互相覆盖
  const task = () => loadScript(
    `${PINGZHONG_API}/${encodeURIComponent(code)}.js?_=${Date.now()}`,
    {
      timeout: 20000,
      // 404 的 HTML 会作为脚本解析失败，此时更可能是代码不存在
      failMsg: '未查询到该基金，请检查基金代码',
      read: () => {
        const name = stripTags(window.fS_name);
        const codeGot = String(window.fS_code || '');
        const trend = window.Data_netWorthTrend;
        if (codeGot && codeGot !== String(code)) throw new Error('数据错配');
        if (!Array.isArray(trend) || !trend.length) return null;
        return { name, trend };
      },
    },
  );
  const p = pzQueue.then(task, task);
  pzQueue = p.then(() => undefined, () => undefined);
  return p;
}

async function pzData(code, force = false) {
  const hit = pzMemo.get(code);
  if (!force && hit && Date.now() - hit.ts < PZ_TTL) return hit;
  const raw = await loadPingZhongRaw(code);
  if (!raw || !raw.trend.length) throw new ApiError('未查询到该基金，请检查代码');
  const data = raw.trend
    .map((p) => ({ date: tsToDate(p.x), value: toNum(p.y), rate: toNum(p.equityReturn) }))
    .filter((x) => !!x.date && x.value !== null);
  if (!data.length) throw new ApiError('未查询到该基金，请检查代码');
  const rec = { name: raw.name, data, ts: Date.now() };
  pzMemo.set(code, rec);
  // 兜底数据体积较大，落一份到 IndexedDB，后续 6 小时内直接读本地
  store.setHistoryCache({ fund_code: code, name: rec.name, data, last_update: Date.now() })
    .catch(() => {});
  return rec;
}

/* ---------------- 对外接口 ---------------- */
/** 基金最新净值 / 日涨跌 / 名称 */
export async function fetchFundInfo(code) {
  try {
    return await infoFromMobile(code);
  } catch (e) {
    // 二级兜底：本地缓存（6 小时内有效，离线也能看上次数据）
    try {
      const c = await store.getHistoryCache(code);
      if (c && c.name && Array.isArray(c.data) && c.data.length
          && Date.now() - (c.last_update || 0) < CACHE_TTL) {
        const last = c.data[c.data.length - 1];
        const navDate = last.date || '';
        return {
          code: String(code), name: c.name, type: '', company: '',
          nav: last.value, prevNav: prevNavOf(last.value, last.rate), rate: last.rate,
          navDate, settled: !!navDate && navDate === todayStr(), source: 'cache',
        };
      }
    } catch (_) { /* 缓存不可用则继续 */ }

    const rec = await pzData(code);
    const last = rec.data[rec.data.length - 1];
    const navDate = last.date || '';
    return {
      code: String(code),
      name: rec.name || String(code),
      type: '',
      company: '',
      nav: last.value,
      prevNav: prevNavOf(last.value, last.rate),
      rate: last.rate,
      navDate,
      settled: !!navDate && navDate === todayStr(),
      source: 'pingzhong',
    };
  }
}

/** 名称搜索：JSONP 搜索接口，失败再回落 pingzhongdata */
export async function searchFundName(code) {
  try {
    const data = await jsonp(`${SEARCH_API}?m=1&key=${encodeURIComponent(code)}`);
    const list = data && data.Datas;
    if (Array.isArray(list) && list.length) {
      const hit = list.find((x) => String(x.CODE) === String(code)) || list[0];
      const name = stripTags(hit && (hit.NAME || hit.NAMEJP));
      if (name) return name;
    }
  } catch (e) { /* 继续兜底 */ }
  try {
    const rec = await pzData(code);
    return rec.name || '';
  } catch (e) {
    return '';
  }
}

/** 历史净值：本地缓存 → 移动端接口 → pingzhongdata；全部失败时回落旧缓存 */
export async function fetchHistory(code, force = false, nameHint = '') {
  let cached = null;
  try {
    cached = await store.getHistoryCache(code);
  } catch (e) {
    cached = null;
  }
  const cacheUsable = cached && Array.isArray(cached.data) && cached.data.length;
  if (!force && cacheUsable && Date.now() - (cached.last_update || 0) < CACHE_TTL) {
    return { data: cached.data, name: cached.name || '', stale: false, updatedAt: cached.last_update };
  }

  const save = async (data, name) => {
    try {
      await store.setHistoryCache({ fund_code: code, name, data, last_update: Date.now() });
    } catch (e) { /* 缓存写入失败不影响展示 */ }
  };

  try {
    const data = await historyFromMobile(code);
    await save(data, nameHint || '');
    return { data, name: nameHint || '', stale: false, updatedAt: Date.now() };
  } catch (e1) {
    try {
      const rec = await pzData(code, force);
      await save(rec.data, rec.name);
      return { data: rec.data, name: rec.name, stale: false, updatedAt: Date.now() };
    } catch (e2) {
      if (cacheUsable) return { data: cached.data, name: cached.name || '', stale: true, updatedAt: cached.last_update, error: e2.message };
      throw e2;
    }
  }
}

/** 由持仓份额推导收益与市值 */
export function buildQuote(fund, info) {
  const amount = Number(fund.holding_amount) || 0;
  const nav = info.nav;
  const profit = nav !== null && info.prevNav !== null ? (nav - info.prevNav) * amount : null;
  return {
    ...info,
    amount,
    profit,
    marketValue: nav !== null ? nav * amount : null,
    error: null,
  };
}

/** 批量刷新，逐条回调以便渐进渲染；盘中估算会自动写入当日分时采样 */
export async function refreshFunds(funds, onResult) {
  const list = funds.slice();
  if (!list.length) return;
  const map = await fetchQuotes(list.map((f) => f.fund_code));
  for (const f of list) {
    const info = map[f.fund_code];
    if (info) {
      const quote = buildQuote(f, info);
      onResult(f.fund_code, quote);
      recordIntraday(f.fund_code, quote).catch(() => {});
    } else {
      onResult(f.fund_code, {
        code: f.fund_code,
        name: f.fund_name,
        amount: Number(f.holding_amount) || 0,
        nav: null,
        prevNav: null,
        rate: null,
        navDate: '',
        settled: false,
        isEstimate: false,
        estimate: null,
        profit: null,
        marketValue: null,
        error: '未查询到该基金，请检查基金代码',
      });
    }
  }
}
