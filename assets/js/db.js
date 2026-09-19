// 存储层：IndexedDB（Dexie）为主，异常时降级到 localStorage / 内存
import { DB_NAME, DB_VERSION, STORAGE_KEY } from './config.js';

export const dbStatus = { mode: 'indexeddb', error: '' };

/* ---------------- IndexedDB 后端 ---------------- */
function createDexieBackend() {
  const db = new Dexie(DB_NAME);
  db.version(DB_VERSION).stores({
    funds: 'fund_code, add_time',
    history_cache: 'fund_code',
  });
  // V2：新增当日分时采样仓库（旧库自动升级，不丢数据）
  db.version(2).stores({ intraday: 'fund_code' });

  return {
    kind: 'indexeddb',
    open: () => db.open(),
    listFunds: () => db.funds.orderBy('add_time').toArray(),
    getFund: (code) => db.funds.get(code),
    putFund: (f) => db.funds.put(f),
    deleteFund: (code) => db.funds.delete(code),
    countFunds: () => db.funds.count(),
    getHistoryCache: (code) => db.history_cache.get(code),
    setHistoryCache: (rec) => db.history_cache.put(rec),
    getIntraday: (code) => db.intraday.get(code),
    setIntraday: (rec) => db.intraday.put(rec),
    listIntraday: () => db.intraday.toArray(),
    clearAll: () => Promise.all([db.funds.clear(), db.history_cache.clear(), db.intraday.clear()]),
  };
}

/* ---------------- 降级后端（localStorage / 内存） ---------------- */
function createFallbackBackend() {
  let mem = null;
  let canUseLS = true;
  try {
    window.localStorage.setItem('__t', '1');
    window.localStorage.removeItem('__t');
  } catch (e) {
    canUseLS = false;
  }

  const read = () => {
    if (mem) return mem;
    if (canUseLS) {
      try {
        mem = JSON.parse(window.localStorage.getItem(STORAGE_KEY)) || { funds: [], cache: [] };
      } catch (e) {
        mem = { funds: [], cache: [], intraday: [] };
      }
    } else {
      mem = { funds: [], cache: [], intraday: [] };
    }
    if (!mem.intraday) mem.intraday = [];
    return mem;
  };
  const write = () => {
    if (!canUseLS) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mem));
    } catch (e) {
      /* 配额不足时静默退化为内存 */
    }
  };

  return {
    kind: canUseLS ? 'localStorage' : 'memory',
    open: () => Promise.resolve(),
    listFunds: async () => read().funds.slice().sort((a, b) => (a.add_time || 0) - (b.add_time || 0)),
    getFund: async (code) => read().funds.find((f) => f.fund_code === code) || null,
    putFund: async (f) => {
      const s = read();
      const i = s.funds.findIndex((x) => x.fund_code === f.fund_code);
      if (i >= 0) s.funds[i] = { ...s.funds[i], ...f };
      else s.funds.push(f);
      write();
    },
    deleteFund: async (code) => {
      const s = read();
      s.funds = s.funds.filter((x) => x.fund_code !== code);
      write();
    },
    countFunds: async () => read().funds.length,
    getHistoryCache: async (code) => read().cache.find((x) => x.fund_code === code) || null,
    setHistoryCache: async (rec) => {
      const s = read();
      const i = s.cache.findIndex((x) => x.fund_code === rec.fund_code);
      if (i >= 0) s.cache[i] = rec;
      else s.cache.push(rec);
      write();
    },
    getIntraday: async (code) => read().intraday.find((x) => x.fund_code === code) || null,
    setIntraday: async (rec) => {
      const s = read();
      const i = s.intraday.findIndex((x) => x.fund_code === rec.fund_code);
      if (i >= 0) s.intraday[i] = rec;
      else s.intraday.push(rec);
      write();
    },
    listIntraday: async () => read().intraday.slice(),
    clearAll: async () => {
      mem = { funds: [], cache: [], intraday: [] };
      write();
    },
  };
}

let backend;
try {
  if (typeof window === 'undefined' || !window.indexedDB) throw new Error('当前环境不支持 IndexedDB');
  backend = createDexieBackend();
} catch (e) {
  dbStatus.error = e.message;
  backend = createFallbackBackend();
}

/** 打开存储并确认可用；IndexedDB 不可用时自动降级 */
export async function initDB() {
  try {
    await backend.open();
    dbStatus.mode = backend.kind;
  } catch (e) {
    dbStatus.error = e && e.message ? e.message : String(e);
    backend = createFallbackBackend();
    await backend.open();
    dbStatus.mode = backend.kind;
  }
  return dbStatus.mode;
}

export const store = {
  get mode() { return backend.kind; },
  listFunds: () => backend.listFunds(),
  getFund: (code) => backend.getFund(code),
  putFund: (f) => backend.putFund(f),
  deleteFund: (code) => backend.deleteFund(code),
  countFunds: () => backend.countFunds(),
  getHistoryCache: (code) => backend.getHistoryCache(code),
  setHistoryCache: (rec) => backend.setHistoryCache(rec),
  getIntraday: (code) => backend.getIntraday(code),
  setIntraday: (rec) => backend.setIntraday(rec),
  listIntraday: () => backend.listIntraday(),
  clearAll: () => backend.clearAll(),
};

/** 导出全部数据（用于备份 / 跨设备迁移） */
export async function exportData() {
  const funds = await backend.listFunds();
  const cache = await Promise.all(funds.map((f) => backend.getHistoryCache(f.fund_code)));
  return {
    app: 'fund-income-monitoring',
    version: DB_VERSION,
    export_at: Date.now(),
    funds,
    history_cache: cache.filter(Boolean),
    intraday: await backend.listIntraday(),
  };
}

/** 导入备份数据；返回导入条数 */
export async function importData(json) {
  const funds = Array.isArray(json && json.funds) ? json.funds : null;
  if (!funds) throw new Error('文件格式不正确，缺少 funds 字段');
  for (const f of funds) {
    if (!f || !/^\d{6}$/.test(String(f.fund_code || ''))) continue;
    await backend.putFund({
      fund_code: String(f.fund_code),
      fund_name: String(f.fund_name || f.fund_code),
      holding_amount: Number(f.holding_amount) || 0,
      add_time: Number(f.add_time) || Date.now(),
      update_time: Number(f.update_time) || Date.now(),
    });
  }
  const caches = Array.isArray(json.history_cache) ? json.history_cache : [];
  for (const c of caches) {
    if (c && /^\d{6}$/.test(String(c.fund_code || ''))) await backend.setHistoryCache(c);
  }
  const intraday = Array.isArray(json.intraday) ? json.intraday : [];
  for (const d of intraday) {
    if (d && /^\d{6}$/.test(String(d.fund_code || ''))) await backend.setIntraday(d);
  }
  return funds.length;
}
