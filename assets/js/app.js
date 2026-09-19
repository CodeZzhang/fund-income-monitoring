// 应用入口：Vue3 单页应用（首页看板 / 增删改 / 详情走势 / 备份）
import { initDB, store, exportData, importData, dbStatus } from './db.js';
import { refreshFunds, fetchFundInfo, fetchHistory, searchFundName, buildQuote, getIntraday } from './api.js';
import { RANGES, AUTO_REFRESH_MS } from './config.js';
import {
  fmtMoney, fmtPct, fmtNav, fmtAmount, fmtTime, trendClass, trendOf,
  isValidCode, isValidAmount, todayStr,
} from './utils.js';

const { createApp } = Vue;
const F = { fmtMoney, fmtPct, fmtNav, fmtAmount, trendClass, trendOf };

// 数值弹层宽度估算（与 CSS min-width 匹配），用于计算水平定位与边界收敛
const TIP_W = 168;

/* ============ 总览卡片 ============ */
const OverviewCard = {
  name: 'OverviewCard',
  props: {
    profit: { type: Number, default: null },
    marketValue: { type: Number, default: null },
    count: { type: Number, default: 0 },
    updatedAt: { type: Number, default: 0 },
    loading: { type: Boolean, default: false },
  },
  computed: {
    profitText() {
      if (this.loading && this.profit === null) return '加载中…';
      return this.profit === null ? '--' : F.fmtMoney(this.profit, true);
    },
    timeText() { return this.updatedAt ? fmtTime(this.updatedAt) : '尚未刷新'; },
  },
  methods: F,
  template: `
    <section class="overview">
      <div class="ov-label">当日预估总收益（元）</div>
      <div class="ov-value num">{{ profitText }}</div>
      <div class="ov-row">
        <div><span class="k">持仓市值</span><span class="v num">¥{{ fmtMoney(marketValue) }}</span></div>
        <div><span class="k">持有基金</span><span class="v num">{{ count }} 只</span></div>
      </div>
      <div class="ov-time">更新于 {{ timeText }}</div>
    </section>
  `,
};

/* ============ 基金卡片 ============ */
const FundCard = {
  name: 'FundCard',
  props: { fund: { type: Object, required: true }, quote: { type: Object, default: null } },
  computed: {
    displayName() { return (this.quote && this.quote.name) || this.fund.fund_name || this.fund.fund_code; },
    profitText() {
      const q = this.quote;
      if (!q) return '--';
      return q.error ? '--' : F.fmtMoney(q.profit, true);
    },
    rateText() {
      const q = this.quote;
      if (!q) return '--';
      return q.error ? '获取失败' : F.fmtPct(q.rate);
    },
    navText() {
      const q = this.quote;
      if (!q || q.nav === null) return '--';
      return F.fmtNav(q.nav);
    },
    navDateText() {
      const q = this.quote;
      if (!q || !q.navDate || q.isEstimate) return '';
      return q.navDate;
    },
    statusTag() {
      const q = this.quote;
      if (!q || q.error) return '';
      if (q.isEstimate) return '盘中估算';
      return q.settled ? '' : '待更新';
    },
  },
  methods: F,
  template: `
    <article class="fund-card" @click="$emit('open', fund.fund_code)">
      <template v-if="!quote">
        <div class="sk-anim">
          <div class="sk-line w60"></div>
          <div class="sk-line w40 short"></div>
          <div class="sk-line w80" style="margin-top:14px"></div>
        </div>
      </template>
      <template v-else>
      <div class="fund-main">
        <div class="fund-info">
          <div class="fund-name">{{ displayName }}</div>
          <div class="fund-sub">
            {{ fund.fund_code }}
            <span class="tag" v-if="quote && quote.type">{{ quote.type }}</span>
            <span class="tag" v-if="statusTag">{{ statusTag }}</span>
            <span class="tag" v-if="navDateText">净值 {{ navDateText }}</span>
          </div>
        </div>
        <div class="fund-profit">
          <div class="p-val num" :class="trendClass(quote && quote.error ? null : (quote && quote.profit))">{{ profitText }}</div>
          <div class="p-rate num" :class="trendClass(quote && quote.error ? null : (quote && quote.rate))">{{ rateText }}</div>
        </div>
      </div>
      <div class="fund-metrics">
        <div class="m">
          <div class="k">最新净值</div>
          <div class="v num">{{ navText }}</div>
        </div>
        <div class="m">
          <div class="k">持有份额</div>
          <div class="v num">{{ fmtAmount(fund.holding_amount) }}</div>
        </div>
        <div class="m">
          <div class="k">持仓市值</div>
          <div class="v num">¥{{ fmtMoney(quote && quote.marketValue) }}</div>
        </div>
      </div>
      <div class="fund-ops">
        <button class="mini-btn" @click.stop="$emit('edit', fund)">编辑份额</button>
        <button class="mini-btn danger" @click.stop="$emit('remove', fund)">删除</button>
      </div>
      <div class="fund-sub" v-if="quote.error" style="margin-top:8px;color:var(--up)">
        {{ quote.error }}
      </div>
      </template>
    </article>
  `,
};

/* ============ 添加 / 编辑弹窗 ============ */
const FundForm = {
  name: 'FundForm',
  props: { fund: { type: Object, default: null } },
  emits: ['close', 'save'],
  data() {
    return {
      code: '',
      name: '',
      amount: '',
      hint: '',
      hintType: '',
      submitting: false,
      error: '',
      timer: null,
    };
  },
  computed: {
    isEdit() { return !!this.fund; },
    canSubmit() { return isValidCode(this.code) && isValidAmount(this.amount) && !this.submitting; },
  },
  created() { this.reset(); },
  unmounted() { if (this.timer) clearTimeout(this.timer); },
  methods: {
    reset() {
      this.code = this.fund ? this.fund.fund_code : '';
      this.name = this.fund ? this.fund.fund_name : '';
      this.amount = this.fund ? String(this.fund.holding_amount) : '';
      this.hint = this.fund ? '' : '输入 6 位基金代码后自动识别名称';
      this.hintType = '';
      this.error = '';
    },
    onCodeInput() {
      this.code = String(this.code).replace(/\D/g, '').slice(0, 6);
      this.name = '';
      this.error = '';
      if (this.timer) clearTimeout(this.timer);
      if (!isValidCode(this.code)) {
        this.hint = '输入 6 位基金代码后自动识别名称';
        this.hintType = '';
        return;
      }
      this.hint = '正在识别基金名称…';
      this.hintType = '';
      this.timer = setTimeout(() => this.lookupName(), 350);
    },
    async lookupName() {
      const code = this.code;
      // 先用主接口（含净值），拿不到名称再走搜索兜底
      try {
        const info = await fetchFundInfo(code);
        if (this.code === code) {
          this.name = info.name || '';
          this.hint = `已识别：${info.name}${info.nav !== null ? `（最新净值 ${info.nav.toFixed(4)}）` : ''}`;
          this.hintType = 'ok';
          return;
        }
      } catch (e) { /* 继续走兜底 */ }
      const name = await searchFundName(code);
      if (this.code !== code) return;
      if (name) {
        this.name = name;
        this.hint = `已识别：${name}`;
        this.hintType = 'ok';
      } else {
        this.hint = '未自动识别到名称，可手动填写';
        this.hintType = 'err';
      }
    },
    submit() {
      this.error = '';
      if (!isValidCode(this.code)) { this.error = '请输入 6 位数字基金代码'; return; }
      if (!isValidAmount(this.amount)) { this.error = '请输入正确的持有份额（≥ 0）'; return; }
      this.submitting = true;
      this.$emit('save', {
        code: this.code,
        name: String(this.name || '').trim() || this.code,
        amount: Number(this.amount),
      });
    },
  },
  template: `
    <div class="modal-mask" @click.self="$emit('close')">
      <div class="modal">
        <h3>{{ isEdit ? '编辑持有份额' : '添加基金' }}</h3>
        <div class="field">
          <label>基金代码</label>
          <input type="tel" inputmode="numeric" maxlength="6" placeholder="如 000001"
                 v-model="code" @input="onCodeInput" :disabled="isEdit">
          <div class="hint" :class="hintType">{{ hint }}</div>
        </div>
        <div class="field">
          <label>基金名称（可手动修改）</label>
          <input type="text" placeholder="自动识别，也可手动填写" v-model="name" maxlength="40">
        </div>
        <div class="field">
          <label>持有份额</label>
          <input type="number" inputmode="decimal" step="0.01" min="0" placeholder="如 1000" v-model="amount">
        </div>
        <div class="hint err" v-if="error" style="margin:-6px 0 10px">{{ error }}</div>
        <div class="modal-actions">
          <button class="btn ghost" @click="$emit('close')">取消</button>
          <button class="btn" :class="{ghost: !canSubmit}" @click="submit" :disabled="!canSubmit">
            {{ submitting ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  `,
};

/* ============ 详情：净值走势 ============ */
const FundDetail = {
  name: 'FundDetail',
  props: {
    code: { type: String, required: true },
    fund: { type: Object, default: null },
    quote: { type: Object, default: null },
    tick: { type: Number, default: 0 },
  },
  emits: ['back', 'edit'],
  data() {
    return {
      range: '1m',
      rangePicked: false,
      history: [],
      intraday: null,
      hisName: '',
      loading: true,
      error: '',
      stale: false,
      updatedAt: 0,
      chart: null,
      chartH: 240,
      tipShow: false,
      tipIdx: -1,
      tipLeft: 8,
      tipHead: '',
      tipLabel: '单位净值',
      tipNav: null,
      tipRate: null,
    };
  },
  computed: {
    ranges() { return RANGES; },
    series() {
      const days = (RANGES.find((r) => r.key === this.range) || RANGES[0]).days;
      return this.history.slice(-days);
    },
    /** 最新（当天/最新交易日）的净值点：优先用实时行情，历史数据兜底 */
    latest() {
      const q = this.quote;
      if (q && !q.error && q.nav !== null) {
        return { date: q.navDate || '', value: q.nav, rate: q.rate, settled: !!q.settled };
      }
      const h = this.history[this.history.length - 1];
      if (h) return { date: h.date, value: h.value, rate: h.rate, settled: h.date === todayStr() };
      return null;
    },
    isToday() { return this.range === 'today'; },
    todayBase() { return this.intraday ? this.intraday.base : null; },
    /** 走势数据：历史区间 + 最新一天（若历史里还没有就补到末尾）；当日档位用分时采样 */
    chartPoints() {
      if (this.isToday) {
        return this.intraday && Array.isArray(this.intraday.points) ? this.intraday.points : [];
      }
      const s = this.series;
      const q = this.latest;
      if (!q || q.value === null || !q.date) return s;
      if (s.length && s[s.length - 1].date === q.date) return s;
      return s.concat([{ date: q.date, value: q.value, rate: q.rate }]);
    },
    rangeChange() {
      const s = this.chartPoints;
      if (!s.length) return null;
      if (this.isToday) {
        const base = this.todayBase;
        const last = s[s.length - 1].v;
        if (!base || last === null || last === undefined) return null;
        return ((last - base) / base) * 100;
      }
      if (s.length < 2) return null;
      const first = s[0].value;
      const last = s[s.length - 1].value;
      return first ? ((last - first) / first) * 100 : null;
    },
    rangeLabel() { return (RANGES.find((r) => r.key === this.range) || RANGES[0]).label; },
    latestTag() {
      const q = this.quote;
      if (q && q.isEstimate) return '盘中估算';
      return this.latest && this.latest.settled ? '已公布' : '未更新';
    },
    emptyTip() {
      if (this.isToday) {
        return '当日分时曲线由盘中估值采样绘制：交易日 9:30-15:00 保持页面打开或多次刷新即可自动采集，当前暂无采样点。';
      }
      return this.error || '暂无历史净值数据';
    },
    name() {
      return (this.quote && this.quote.name) || this.hisName
        || (this.fund && this.fund.fund_name) || this.code;
    },
    profitText() { return this.quote && !this.quote.error ? fmtMoney(this.quote.profit, true) : '--'; },
  },
  watch: {
    range() { this.$nextTick(this.renderChart); },
    code() { this.load(); },
    tick() { this.loadIntraday(); },
  },
  mounted() { this.load(); window.addEventListener('resize', this.onResize); },
  unmounted() {
    window.removeEventListener('resize', this.onResize);
    if (this.chart) { this.chart.dispose(); this.chart = null; }
  },
  methods: {
    fmtMoney, fmtPct, fmtNav, fmtAmount, trendClass,
    async loadIntraday() {
      const rec = await getIntraday(this.code);
      this.intraday = rec;
      // 当日已有采样点时默认切到「当日」曲线
      if (rec && rec.points && rec.points.length && !this.rangePicked) this.range = 'today';
      if (this.isToday) this.$nextTick(this.renderChart);
    },
    pickRange(key) {
      this.rangePicked = true;
      this.range = key;
    },
    async load(force = false) {
      this.loading = true;
      this.error = '';
      try {
        const res = await fetchHistory(this.code, force, this.name);
        this.history = res.data;
        this.hisName = res.name || '';
        this.stale = !!res.stale;
        this.updatedAt = res.updatedAt || 0;
        if (res.error) this.error = res.error + '（展示本地缓存）';
        this.$nextTick(this.renderChart);
      } catch (e) {
        this.history = [];
        this.error = e.message || '历史数据获取失败';
      } finally {
        this.loading = false;
      }
      this.loadIntraday();
    },
    onResize() { if (this.chart) this.chart.resize(); },
    renderChart() {
      const el = this.$refs.chart;
      const s = this.chartPoints;
      // v-if 会把容器移出 DOM，此时同步销毁实例，避免内存泄漏
      if (!el || !s.length) {
        if (this.chart) { this.chart.dispose(); this.chart = null; }
        return;
      }
      const isToday = this.isToday;
      const dates = s.map((x) => (isToday ? x.t : x.date));
      const values = s.map((x) => (isToday ? x.v : x.value));
      const rates = s.map((x) => (isToday ? x.r : x.rate));
      const base = isToday ? this.todayBase : null;
      const up = this.rangeChange === null || this.rangeChange >= 0;
      const color = up ? '#e8433a' : '#12b76a';

      if (!this.chart) this.chart = echarts.init(el);
      this.chart.setOption({
        animation: false,
        grid: { left: 4, right: 4, top: 30, bottom: 4, containLabel: true },
        // 只借用内置 tooltip 驱动十字准星（axisPointer），数值弹层由 showTip 自己渲染
        tooltip: {
          trigger: 'axis',
          triggerOn: 'mousemove|touch',
          confine: true,
          backgroundColor: 'rgba(27,29,33,.95)',
          borderWidth: 0,
          padding: [9, 13],
          textStyle: { color: '#fff', fontSize: 13, lineHeight: 19 },
          extraCssText: 'display:none !important;',
          axisPointer: {
            type: 'cross',
            crossStyle: { color: '#c0c4cc' },
            lineStyle: { color: '#c0c4cc', type: 'dashed', width: 1 },
          },
          formatter: () => '',
        },
        legend: {
          show: true, top: 0, right: 4, itemGap: 10, itemWidth: 10, itemHeight: 8,
          textStyle: { color: '#9ca3af', fontSize: 11 },
          data: [isToday ? '估算净值' : '单位净值', '日涨幅'],
        },
        xAxis: {
          type: 'category',
          data: dates,
          boundaryGap: true,
          axisLine: { lineStyle: { color: '#ebedf0' } },
          axisTick: { show: false },
          axisLabel: {
            color: '#9ca3af', fontSize: 10,
            interval: isToday ? Math.max(0, Math.ceil(dates.length / 4) - 1)
              : Math.max(0, Math.ceil(dates.length / 5) - 1),
            formatter: (v) => (isToday ? String(v) : String(v).slice(5)),
          },
          axisPointer: {
            label: {
              show: true,
              backgroundColor: '#374151', color: '#fff',
              fontSize: 11, padding: [3, 6], borderRadius: 4,
              formatter: (p) => (isToday ? String(p.value) : String(p.value).slice(5)),
            },
          },
        },
        yAxis: [
          {
            type: 'value', scale: true,
            splitLine: { lineStyle: { color: '#f0f1f3' } },
            axisLine: { show: false }, axisTick: { show: false },
            axisLabel: { color: '#9ca3af', fontSize: 10, formatter: (v) => Number(v).toFixed(3) },
            axisPointer: { label: { show: false } },
          },
          {
            type: 'value', scale: true,
            splitLine: { show: false },
            axisLine: { show: false }, axisTick: { show: false },
            axisLabel: { color: '#9ca3af', fontSize: 10, formatter: (v) => Number(v).toFixed(1) + '%' },
            axisPointer: { label: { show: false } },
          },
        ],
        series: [
          {
            name: isToday ? '估算净值' : '单位净值', type: 'line', yAxisIndex: 0,
            data: values, smooth: true,
            showSymbol: true, symbol: 'circle',
            symbolSize: s.length > 80 ? 3 : 5,
            lineStyle: { width: 2, color },
            itemStyle: { color },
            emphasis: { focus: 'series', scale: false },
            markLine: (isToday && base) ? {
              silent: true, symbol: 'none',
              label: {
                formatter: '昨收 ' + Number(base).toFixed(4),
                position: 'insideEndTop', color: '#9ca3af', fontSize: 10,
              },
              lineStyle: { color: '#d0d3d9', type: 'dashed', width: 1 },
              data: [{ yAxis: base }],
            } : undefined,
            areaStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: color + '38' },
                { offset: 1, color: color + '05' },
              ]),
            },
          },
          {
            name: '日涨幅', type: 'bar', yAxisIndex: 1,
            data: rates, barMaxWidth: 6,
            itemStyle: {
              color: (p) => (p.value === null || p.value === undefined
                ? 'transparent' : (p.value >= 0 ? '#e8433a' : '#12b76a')),
            },
          },
        ],
      }, true);

      // 数值弹层：内置 tooltip 的显示逻辑在本页不稳定，
      // 改为监听 axisPointer 联动事件（数据完整可靠）后自行渲染 DOM 弹层
      this.chart.off('updateAxisPointer');
      this.chart.on('updateAxisPointer', (info) => {
        if (!info || !info.axesInfo || !info.axesInfo.length) return;
        let idx = null;
        for (const a of info.axesInfo) {
          if (a.axisDim === 'x' && a.axisIndex === 0) {
            idx = Number.isInteger(a.value) ? a.value : Math.round(a.value);
            break;
          }
        }
        if (idx === null || idx < 0 || idx >= s.length) { this.hideTip(); return; }
        this.showTip(idx, s, dates, isToday);
      });
    },
    showTip(idx, s, dates, isToday) {
      this.tipIdx = idx;
      this.tipLabel = isToday ? '估算净值' : '单位净值';
      this.tipHead = isToday && this.intraday ? `${this.intraday.date} ${dates[idx]}` : dates[idx];
      this.tipNav = isToday ? s[idx].v : s[idx].value;
      this.tipRate = isToday ? s[idx].r : s[idx].rate;
      this.tipShow = true;
      const box = this.$refs.chartBox;
      if (box) {
        box.removeEventListener('mouseleave', this.hideTip);
        box.addEventListener('mouseleave', this.hideTip);
      }
      const el = this.$refs.chart;
      if (el && box) {
        const r = el.getBoundingClientRect();
        const bx = box.getBoundingClientRect();
        let left = (r.left - bx.left) + r.width * (idx / Math.max(1, s.length - 1));
        left = Math.min(Math.max(4, left + 12), Math.max(4, bx.width - TIP_W - 4));
        this.tipLeft = Math.round(left);
      }
    },
    hideTip() {
      this.tipShow = false;
      const box = this.$refs.chartBox;
      if (box) box.removeEventListener('mouseleave', this.hideTip);
    },
  },
  template: `
    <div>
      <div class="detail-head">
        <div class="d-name">{{ name }}</div>
        <div class="d-sub">{{ code }}<span v-if="quote && quote.company"> · {{ quote.company }}</span></div>
      </div>

      <div class="d-stat">
        <div class="m">
          <div class="k">{{ quote && quote.isEstimate ? '估算净值' : '单位净值' }}</div>
          <div class="v num">{{ latest ? fmtNav(latest.value) : '--' }}</div>
          <div class="s">{{ latest && latest.date ? latest.date : '--' }}</div>
        </div>
        <div class="m">
          <div class="k">日涨幅</div>
          <div class="v num" :class="trendClass(latest && latest.rate)">{{ fmtPct(latest && latest.rate) }}</div>
          <div class="s">{{ latestTag }}</div>
        </div>
        <div class="m">
          <div class="k">当日收益</div>
          <div class="v num" :class="trendClass(quote && quote.profit)">{{ profitText }}</div>
          <div class="s">份额 {{ fmtAmount(fund && fund.holding_amount) }}</div>
        </div>
        <div class="m">
          <div class="k">区间涨跌</div>
          <div class="v num" :class="trendClass(rangeChange)">{{ fmtPct(rangeChange) }}</div>
          <div class="s">{{ rangeLabel }}</div>
        </div>
      </div>

      <div class="range-tabs">
        <button v-for="r in ranges" :key="r.key" :class="{on: range === r.key}" @click="pickRange(r.key)">{{ r.label }}</button>
        <button class="on" style="background:#fff;color:var(--text-2);border-color:var(--line)"
                @click="load(true)">{{ loading ? '加载中…' : '刷新数据' }}</button>
      </div>

      <div class="hint" v-if="isToday" style="padding:0 14px 8px">
        当日曲线基于盘中估值采样：页面每 5 分钟自动采样一次（共 {{ chartPoints.length }} 点），
        盘中保持页面打开即可得到完整分时走势。
      </div>

      <div class="chart-box" ref="chartBox">
        <div class="chart" ref="chart" :style="{ height: chartH + 'px' }" v-if="chartPoints.length"></div>
        <div class="chart-tip2" v-show="tipShow" :style="{ left: tipLeft + 'px' }">
          <div class="h">{{ tipHead }}</div>
          <div class="r"><span class="k">{{ tipLabel }}</span><b class="num">{{ fmtNav(tipNav) }}</b></div>
          <div class="r"><span class="k">日涨幅</span><b class="num" :class="trendClass(tipRate)">{{ fmtPct(tipRate) }}</b></div>
        </div>
        <div class="chart-tip" v-if="loading">正在加载净值数据…</div>
        <div class="chart-tip" v-else-if="!chartPoints.length">{{ emptyTip }}</div>
        <div class="hint" v-else-if="error && !isToday" style="padding:2px 12px 8px">{{ error }}</div>
        <div class="chart-hint" v-if="chartPoints.length">
          <span class="dot"></span>鼠标悬停 / 点按曲线查看具体数值
        </div>
      </div>

      <div class="his-title">
        {{ isToday ? '当日分时采样（时间 / 估算净值 / 日涨幅）' : '净值明细（单位净值 / 日涨幅）' }}
        ，共 {{ chartPoints.length }} 点
      </div>
      <div class="his-list">
        <div class="his-row" v-for="(item, idx) in chartPoints.slice().reverse().slice(0, 30)" :key="(isToday ? item.t : item.date) + idx">
          <div class="d num">{{ isToday ? item.t : item.date }}<span class="tag" v-if="idx === 0">最新</span></div>
          <div class="n num">{{ fmtNav(isToday ? item.v : item.value) }}</div>
          <div class="r num" :class="trendClass(isToday ? item.r : item.rate)">{{ fmtPct(isToday ? item.r : item.rate) }}</div>
        </div>
        <div class="chart-tip" v-if="!chartPoints.length">暂无数据</div>
      </div>

      <div class="add-bar" style="margin-top:12px" v-if="fund">
        <button class="btn ghost block" @click="$emit('edit', fund)">修改持有份额</button>
      </div>
    </div>
  `,
};

/* ============ 备份 / 设置 ============ */
const SettingsSheet = {
  name: 'SettingsSheet',
  props: { mode: { type: String, default: 'indexeddb' }, count: { type: Number, default: 0 } },
  emits: ['close', 'export', 'import', 'clear'],
  data() { return { fileName: '', error: '' }; },
  computed: {
    modeText() {
      return {
        indexeddb: 'IndexedDB（正常）',
        localStorage: 'localStorage（IndexedDB 不可用，已降级）',
        memory: '内存（浏览器禁用了本地存储，关闭页面即丢失）',
      }[this.mode] || this.mode;
    },
  },
  methods: {
    pickFile() { this.$refs.file.click(); },
    onFile(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this.fileName = file.name;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          this.$emit('import', JSON.parse(String(reader.result)));
        } catch (err) {
          this.error = '文件解析失败，请选择本应用导出的 JSON 备份';
        }
      };
      reader.onerror = () => { this.error = '文件读取失败'; };
      reader.readAsText(file);
      e.target.value = '';
    },
    confirmClear() {
      if (window.confirm('确定清空全部基金数据？此操作不可恢复，建议先导出备份。')) {
        this.$emit('clear');
      }
    },
  },
  template: `
    <div class="modal-mask" @click.self="$emit('close')">
      <div class="modal">
        <h3>数据备份与设置</h3>
        <div class="settings-body">
          <div>存储方式：{{ modeText }}</div>
          <div>当前持有：{{ count }} 只基金</div>
          <div class="warn">
            所有数据仅保存在你本机浏览器中，不会上传服务器。清理浏览器数据、更换设备或浏览器都会导致数据丢失，请定期导出备份。
          </div>
          <button class="btn block" @click="$emit('export')">导出备份（JSON 文件）</button>
          <button class="btn ghost block" style="margin-top:10px" @click="pickFile">导入备份</button>
          <input type="file" accept="application/json,.json" ref="file" @change="onFile">
          <div v-if="fileName" style="margin-top:8px">已选择：{{ fileName }}</div>
          <div class="hint err" v-if="error" style="margin-top:8px">{{ error }}</div>
          <button class="btn ghost block" style="margin-top:10px;color:var(--up)" @click="confirmClear">清空全部数据</button>
          <button class="btn ghost block" style="margin-top:10px" @click="$emit('close')">关闭</button>
        </div>
      </div>
    </div>
  `,
};

/* ============ 根组件 ============ */
const App = {
  name: 'App',
  components: { OverviewCard, FundCard, FundForm, FundDetail, SettingsSheet },
  data() {
    return {
      view: 'home',
      detailCode: '',
      funds: [],
      quotes: {},
      dbLoading: true,
      refreshing: false,
      lastUpdate: 0,
      toastMsg: '',
      formOpen: false,
      editingFund: null,
      settingsOpen: false,
      storageMode: 'indexeddb',
      ptrDist: 0,
      ptrOn: false,
      toastTimer: null,
      pollTimer: null,
    };
  },
  computed: {
    title() { return this.view === 'detail' ? '净值走势' : '基金收益监控'; },
    validQuotes() {
      return this.funds.map((f) => this.quotes[f.fund_code]).filter((q) => q && !q.error && q.profit !== null);
    },
    totalProfit() {
      if (!this.validQuotes.length) return null;
      return this.validQuotes.reduce((s, q) => s + q.profit, 0);
    },
    totalMarketValue() {
      const list = this.funds.map((f) => this.quotes[f.fund_code]).filter((q) => q && !q.error && q.marketValue !== null);
      return list.length ? list.reduce((s, q) => s + q.marketValue, 0) : null;
    },
    detailFund() { return this.funds.find((f) => f.fund_code === this.detailCode) || null; },
    ptrText() { return this.ptrDist > 50 ? '释放立即刷新' : '下拉刷新'; },
  },
  created() { this.onHash(); },
  mounted() {
    window.addEventListener('hashchange', this.onHash);
    document.addEventListener('visibilitychange', this.onVisible);
    // 盘中定时采样：每 5 分钟刷新一次，用于绘制当日净值曲线
    this.pollTimer = setInterval(() => {
      if (!document.hidden) this.refresh();
    }, AUTO_REFRESH_MS);
    this.init();
  },
  unmounted() {
    window.removeEventListener('hashchange', this.onHash);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.pollTimer) clearInterval(this.pollTimer);
  },
  methods: {
    fmtMoney, fmtTime,
    async init() {
      try {
        this.storageMode = await initDB();
        if (dbStatus.error) {
          console.warn('[fund-monitor] 存储降级：', dbStatus.error);
        }
        this.funds = await store.listFunds();
      } catch (e) {
        this.storageMode = store.mode;
        this.toast('本地存储初始化失败，数据可能无法保存');
      } finally {
        this.dbLoading = false;
      }
      await this.refresh();
    },
    async refresh() {
      if (!this.funds.length) { this.lastUpdate = Date.now(); return; }
      if (this.refreshing) return;
      this.refreshing = true;
      const snapshot = this.funds.slice();
      await refreshFunds(snapshot, (code, quote) => {
        this.quotes = { ...this.quotes, [code]: quote };
        const f = this.funds.find((x) => x.fund_code === code);
        if (f && !quote.error && quote.name && quote.name !== f.fund_name) {
          f.fund_name = quote.name;
          store.putFund({ ...f, update_time: Date.now() }).catch(() => {});
        }
      });
      this.lastUpdate = Date.now();
      this.refreshing = false;
    },
    async refreshOne(code) {
      const f = this.funds.find((x) => x.fund_code === code);
      if (!f) return;
      try {
        const info = await fetchFundInfo(code);
        this.quotes = { ...this.quotes, [code]: buildQuote(f, info) };
      } catch (e) {
        this.toast(e.message || '数据获取失败');
      }
    },
    onVisible() { if (!document.hidden) this.refresh(); },
    onHash() {
      const m = String(location.hash || '').match(/^#\/fund\/(\d{6})/);
      if (m) {
        this.detailCode = m[1];
        this.view = 'detail';
      } else {
        this.detailCode = '';
        this.view = 'home';
      }
    },
    goHome() { location.hash = ''; },
    openDetail(code) { location.hash = '#/fund/' + code; },
    openAdd() { this.editingFund = null; this.formOpen = true; },
    openEdit(fund) { this.editingFund = fund; this.formOpen = true; },
    async saveFund(payload) {
      try {
        const existing = await store.getFund(payload.code);
        const rec = {
          fund_code: payload.code,
          fund_name: payload.name,
          holding_amount: payload.amount,
          add_time: existing ? existing.add_time : Date.now(),
          update_time: Date.now(),
        };
        await store.putFund(rec);
        const i = this.funds.findIndex((f) => f.fund_code === payload.code);
        if (i >= 0) this.funds.splice(i, 1, rec);
        else this.funds.push(rec);
        this.formOpen = false;
        this.editingFund = null;
        this.toast('已保存');
        await this.refreshOne(payload.code);
      } catch (e) {
        this.toast('保存失败：' + (e.message || e));
      }
    },
    async removeFund(fund) {
      if (!window.confirm(`确定删除「${fund.fund_name}」？删除后本地记录将一并清除。`)) return;
      try {
        await store.deleteFund(fund.fund_code);
        this.funds = this.funds.filter((f) => f.fund_code !== fund.fund_code);
        const next = { ...this.quotes };
        delete next[fund.fund_code];
        this.quotes = next;
        this.toast('已删除');
      } catch (e) {
        this.toast('删除失败');
      }
    },
    async doExport() {
      try {
        const data = await exportData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fund-backup-${todayStr()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        this.toast('备份已导出');
      } catch (e) {
        this.toast('导出失败');
      }
    },
    async doImport(json) {
      try {
        const n = await importData(json);
        this.funds = await store.listFunds();
        this.settingsOpen = false;
        this.toast(`已导入 ${n} 条记录`);
        await this.refresh();
      } catch (e) {
        this.toast('导入失败：' + e.message);
      }
    },
    async doClear() {
      try {
        await store.clearAll();
        this.funds = [];
        this.quotes = {};
        this.settingsOpen = false;
        this.toast('已清空');
      } catch (e) {
        this.toast('清空失败');
      }
    },
    toast(msg) {
      this.toastMsg = msg;
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toastMsg = ''; }, 2000);
    },
    /* 下拉刷新 */
    onTouchStart(e) {
      if (this.view !== 'home' || this.refreshing) return;
      if (window.scrollY > 2 || !e.touches || !e.touches.length) return;
      this.ptrOn = true;
      this._ptrY = e.touches[0].clientY;
    },
    onTouchMove(e) {
      if (!this.ptrOn || !e.touches || !e.touches.length) return;
      const dy = e.touches[0].clientY - this._ptrY;
      if (dy <= 0 || window.scrollY > 2) { this.ptrDist = 0; this.ptrOn = false; return; }
      this.ptrDist = Math.min(90, dy * 0.45);
      if (e.cancelable) e.preventDefault();
    },
    onTouchEnd() {
      if (!this.ptrOn) return;
      this.ptrOn = false;
      const d = this.ptrDist;
      this.ptrDist = 0;
      if (d > 50) this.refresh();
    },
  },
  template: `
    <div class="app-wrap" @touchstart="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd">
      <header class="app-header">
        <button v-if="view === 'detail'" class="icon-btn back-btn" @click="goHome">‹</button>
        <h1>{{ title }}</h1>
        <template v-if="view === 'home'">
          <button class="icon-btn" title="备份与设置" @click="settingsOpen = true">⚙</button>
          <button class="icon-btn" :class="{spin: refreshing}" title="刷新" @click="refresh">⟳</button>
        </template>
      </header>

      <div class="ptr" :class="{active: ptrDist > 0}">{{ ptrText }}</div>

      <template v-if="view === 'home'">
        <overview-card
          :profit="totalProfit"
          :market-value="totalMarketValue"
          :count="funds.length"
          :updated-at="lastUpdate"
          :loading="dbLoading || refreshing" />

        <template v-if="dbLoading">
          <div class="section-title">正在读取本地数据…</div>
          <div class="skeleton-card sk-anim">
            <div class="sk-line w60"></div>
            <div class="sk-line w40 short"></div>
            <div class="sk-line w80" style="margin-top:14px"></div>
          </div>
          <div class="skeleton-card sk-anim">
            <div class="sk-line w60"></div>
            <div class="sk-line w40 short"></div>
            <div class="sk-line w80" style="margin-top:14px"></div>
          </div>
        </template>

        <template v-else-if="funds.length">
          <div class="section-title">
            <span>我的持仓</span>
            <span v-if="refreshing">刷新中…</span>
          </div>
          <fund-card
            v-for="f in funds"
            :key="f.fund_code"
            :fund="f"
            :quote="quotes[f.fund_code] || null"
            @open="openDetail"
            @edit="openEdit"
            @remove="removeFund" />
          <div class="add-bar">
            <button class="btn ghost block" @click="openAdd">＋ 添加基金</button>
          </div>
        </template>

        <div v-else class="empty">
          <div class="empty-icon">📈</div>
          <p>还没有持仓基金<br>开始添加你的第一只基金</p>
          <button class="btn" @click="openAdd">添加基金</button>
        </div>

        <div class="footer">
          数据来自天天基金公开接口，仅供参考，实际收益以销售机构为准<br>
          净值一般在交易日 20:00 后更新，盘中展示为估算值
        </div>
      </template>

      <fund-detail
        v-else
        :code="detailCode"
        :fund="detailFund"
        :quote="quotes[detailCode] || null"
        :tick="lastUpdate"
        @back="goHome"
        @edit="openEdit" />

      <fund-form
        v-if="formOpen"
        :fund="editingFund"
        @close="formOpen = false; editingFund = null"
        @save="saveFund" />

      <settings-sheet
        v-if="settingsOpen"
        :mode="storageMode"
        :count="funds.length"
        @close="settingsOpen = false"
        @export="doExport"
        @import="doImport"
        @clear="doClear" />

      <div class="toast" v-if="toastMsg">{{ toastMsg }}</div>
    </div>
  `,
};

createApp(App).mount('#app');
