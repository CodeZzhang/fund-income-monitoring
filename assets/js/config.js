// 全局配置：接口地址、存储、缓存策略
export const DB_NAME = 'FundMonitorDB';
export const DB_VERSION = 1;

// 天天基金移动端开放接口（响应带 Access-Control-Allow-Origin: *，浏览器可直连，无需代理）
export const API_BASE = 'https://fundmobapi.eastmoney.com/FundMNewApi';
export const API_COMMON = 'deviceid=Wap&plat=Wap&product=EFund&version=2.0.0';

// 基金名称搜索（JSONP，作为自动填充名称的兜底来源）
export const SEARCH_API = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx';

// 兜底数据源：以 <script> 方式加载，不受 CORS 与 UA 限制
export const PINGZHONG_API = 'https://fund.eastmoney.com/pingzhongdata';

export const REQUEST_TIMEOUT = 10000;   // 单次请求超时（毫秒）
export const CONCURRENCY = 4;           // 批量刷新并发数
export const HISTORY_SIZE = 400;        // 历史净值单次拉取条数（≈ 近 1.5 年）
export const CACHE_TTL = 6 * 3600 * 1000; // 历史净值缓存有效期（IndexedDB）
export const PZ_TTL = 10 * 60 * 1000;     // pingzhongdata 内存缓存有效期

export const RANGES = [
  { key: 'today', label: '当日', days: 0 },
  { key: '1m', label: '近1月', days: 30 },
  { key: '3m', label: '近3月', days: 90 },
  { key: '1y', label: '近1年', days: 365 },
];

export const AUTO_REFRESH_MS = 5 * 60 * 1000;  // 盘中自动采样间隔
export const INTRADAY_MAX_POINTS = 300;        // 当日分时采样点上限
export const BATCH_SIZE = 20;                  // 批量行情接口单次基金数上限

export const STORAGE_KEY = 'FundMonitorDB_FALLBACK';
