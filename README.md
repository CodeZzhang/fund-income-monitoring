# 个人基金收益监控 H5

极简、无广告的基金收益聚合看板。纯静态单页应用，数据只存在你本机浏览器里，不上传任何服务器。

## 功能

| 模块 | 说明 |
| :--- | :--- |
| 空状态引导 | 首次打开提示「开始添加你的第一只基金」 |
| 基金管理 | 添加（代码自动识别名称）/ 编辑份额 / 删除（二次确认） |
| 首页看板 | 当日预估总收益、持仓市值、每只基金的净值·涨跌幅·当日盈亏 |
| 净值走势 | 点击卡片进入详情，ECharts 双轴图（单位净值折线 + 日涨幅柱状），支持当日 / 近 1 月 / 近 3 月 / 近 1 年；**鼠标悬停 / 手指点按显示十字准星与数值弹层**（日期、单位净值、日涨幅） |
| 当日净值曲线 | 盘中自动采集估值点位绘制当日分时曲线（含昨收基准线） |
| 刷新 | 打开页面自动刷新一次、右上角手动刷新、下拉刷新 |
| 数据备份 | 导出 / 导入 JSON，跨设备迁移；可一键清空 |

配色遵循国内习惯：**红涨绿跌**。

## 技术栈

- Vue 3（全局构建，含模板编译器）+ ECharts 5 + Dexie 4，全部本地化在 `vendor/`，**无需 npm 安装、无需打包**
- 存储：IndexedDB（库名 `FundMonitorDB`，仓库 `funds` / `history_cache`）；IndexedDB 不可用时自动降级到 localStorage / 内存
- 路由：hash 路由（`#/fund/000001`），无后端

> **图表弹层实现说明**：ECharts 内置 tooltip 在本项目的容器环境下不显示内容（实测
> `tooltipModel` 缺失、`_tryShow` 收到的 `dataByCoordSys` 恒为空），但 axisPointer
> 联动完全正常。因此保留内置 tooltip 仅用于驱动十字准星（`extraCssText: display:none`
> 隐藏其弹层），数值弹层改为监听 `chart.on('updateAxisPointer')` 后自行渲染 DOM，
> 显示日期 / 单位净值 / 日涨幅，并随指针在图表内收敛定位。

## 本地运行

```bash
# 任意静态服务器，例如
python -m http.server 8080
# 然后浏览器打开 http://127.0.0.1:8080
```

> 直接双击 `index.html` 以 `file://` 打开无法使用：ES Module 与 IndexedDB 均受同源策略限制。

## 数据来源

| 用途 | 主数据源 | 兜底数据源 |
| :--- | :--- | :--- |
| 最新净值 / 日涨跌 / 名称 / 类型 | 天天基金移动端接口 `fundmobapi.eastmoney.com`（响应带 `Access-Control-Allow-Origin: *`，免代理） | `fund.eastmoney.com/pingzhongdata/{code}.js`，以 `<script>` 加载，不受 CORS 限制 |
| 名称搜索 | `fundsuggest.eastmoney.com` JSONP | 同上 |
| 历史净值 | `FundMNHisNetList`（近 400 个交易日） | `pingzhongdata` 全量走势；结果写入 IndexedDB 缓存 6 小时 |

### 当日净值曲线是怎么来的

官方的「净值估算 / 分时估值」接口（老 `fundgz.1234567.com.cn`）**已下线**，PC 页面该模块也已被注释掉，
目前没有免费可用的分时估值序列接口。因此当日曲线采取**自建采样**：

- 盘中（`FundMNFInfo` 的 `GSZ`/`GSZZL`/`GZTIME` 有值时判定为盘中）每次刷新写入一个采样点
  `{时间, 估算净值, 估算涨跌幅}`，存进 IndexedDB 的 `intraday` 仓库（按自然日分组，同分钟去重，上限 300 点）
- 页面打开期间每 5 分钟自动刷新采样一次，切回前台时立即采样；盘中保持页面打开即可得到完整分时走势
- 图表带昨收基准虚线；非盘中 / 周末无采样点时，当日页给出明确说明而不是画假曲线

**已知限制**：天天基金移动端接口会拒绝桌面浏览器的 User-Agent（返回「网络繁忙」），
此时自动走 `<script>` 兜底数据源（体积较大，首次约数百 KB，之后 6 小时读本地缓存）。
移动端浏览器 / 微信内置浏览器不受影响。

接口全部为第三方免费接口，可能限流或下线；代码已做降级：取不到数据时显示 `--` 并给出提示。

## 部署到 GitHub Pages

1. 推送代码到 GitHub 仓库
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**
3. 已内置 `.github/workflows/pages.yml`，push 到 `main` 后自动部署，产出 HTTPS 链接

也可在 Settings → Pages 里直接选 `Deploy from a branch` + `/(root)`，无需 Actions。

绑定自定义域名：仓库 Settings → Pages → Custom domain 填写域名，并在域名解析里加一条 CNAME 指向 `用户名.github.io`。

## 目录结构

```
index.html
assets/css/app.css
assets/js/  config.js  utils.js  db.js  api.js  app.js
vendor/     vue / dexie / echarts（本地化，避免 CDN 被墙）
```

## 隐私与免责

- 所有持仓数据仅保存在本机浏览器的 IndexedDB 中，清理浏览器数据、更换设备或浏览器都会丢失，请定期用「导出备份」保存。
- 净值一般在交易日 20:00 后更新，盘中展示的净值为估算值；数据仅供参考，实际收益以销售机构为准。
