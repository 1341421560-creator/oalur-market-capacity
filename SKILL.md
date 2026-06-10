# 市场容量 + 季节性与生命周期分析 Skill（Oalur）

## 用途
1. **市场容量分析**：基于亚马逊大类排名（BSR）判断产品市场容量
2. **季节性分析**：基于 Google Trends + Oalur 站内数据，判断产品季节性和市场趋势
3. **ASIN 价格排名趋势分析**：基于 Oalur 导出的 Excel，调用 `oalur-asin-trend` skill 生成合并趋势图

输入关键词，自动完成全部数据提取和分析，生成 **2 个 HTML 报告**：
- **报告 1**：市场容量 + 利润快筛 + 竞争分析 + 新品存活率 + 季节性趋势（`output/日期-关键词/reports/日期_关键词_市场分析.html`）
- **报告 2**：老品 ASIN 的 Buybox价格/Ratings数/大类BSR 趋势（`output/日期-关键词/reports/日期_关键词_ASIN生命周期趋势分析.html`）
- **可选报告 3**：父体代表 ASIN 与子 ASIN 明细（`output/日期-关键词/reports/日期_关键词_子ASIN明细.html`）

## 数据源
- **平台**：Oalur（鸥鹭）- https://vip.oalur.com/insight/filter/index?site=US
- **需要登录**：使用 Edge 浏览器（CDP 端口 9222）连接用户登录态
- **连接方式**：puppeteer-core 直连 `http://localhost:9222`（不使用 OpenClaw browser tool，因其 edge profile CDP 连接不稳定）

## 前置依赖
- `puppeteer-core` 和 `xlsx` 已安装在本 skill 工程的 `node_modules/`
- Edge 浏览器已通过 `--remote-debugging-port=9222` 启动
- ASIN 趋势 Excel 默认保存到 `output/日期-任务名/excel/`；如需指定浏览器下载目录，可设置环境变量 `OALUR_DOWNLOAD_DIR`

## 输入
- **产品关键词**：亚马逊搜索词、长尾词，如 "Biscuit Cutter"、"Silicone Spatula" 等
- **多关键词**：英文逗号分隔，如 "Cookie Cutter,Biscuit Cutter"，用于合并同品类不同关键词的数据

## 多关键词分析流程

当输入多个关键词时，默认必须使用**独立抓取 + 离线合并**，把每个关键词先保存成单独数据文件，再通过 `merge-data.js` 合并成一个数据库，确保页面状态残留不会污染后续关键词。

### 默认方式：逗号输入，脚本自动独立抓取并合并
```bash
node skills/oalur-market-capacity/extract-data.js "Cookie Cutter,Biscuit Cutter" 10000 output/日期-Cookie-Cutter-Biscuit-Cutter/data/merged-data.json
```

脚本会自动执行：
1. `Cookie Cutter` 独立抓取到 `output/日期-Cookie-Cutter-Biscuit-Cutter/data/Cookie-Cutter-data.json`
2. `Biscuit Cutter` 独立抓取到 `output/日期-Cookie-Cutter-Biscuit-Cutter/data/Biscuit-Cutter-data.json`
3. 调用 `merge-data.js` 合并为 `merged-data.json`

### 手动方式：独立抓取 + merge-data.js 合并
```bash
# 分别独立抓取
node skills/oalur-market-capacity/extract-data.js "Cookie Cutter" 10000 output/日期-Cookie-Cutter/data/cookie-data.json
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-data.json

# 合并去重（ASIN去重 + 父体 Listing 聚合 + 类目/标题意图过滤）
node skills/oalur-market-capacity/merge-data.js output/日期-Cookie-Cutter/data/cookie-data.json output/日期-Biscuit-Cutter/data/biscuit-data.json output/日期-merged-data/data/merged-data.json

# 生成报告
node skills/oalur-market-capacity/generate-report.js output/日期-merged-data/data/merged-data.json
```

### 不推荐方式：单进程连抓
旧版本支持在同一页面会话内连续抓取多个关键词，但 Oalur 页面状态可能残留，导致后续关键词结果与单独搜索不一致。当前默认不再使用该方式。

## 品类底线排名（自动匹配）

根据关键词推断品类，匹配对应的底线排名：

| 品类 | 底线 BSR | 关键词示例 |
|---|---|---|
| 美妆工具 | 8,000-10,000 | makeup brush, eyelash curler |
| 厨房家居 | 10,000 | biscuit cutter, spatula, kitchen gadget |
| 宠物用品 | 25,000 | dog toy, pet bed, cat scratcher |
| 鞋服 | 30,000 | running shoes, yoga pants |
| 工具家装 | 15,000 | screwdriver, drill bit, tape measure |
| 个人护理 | 10,000 | hair clipper, toothbrush holder |
| 消费电子 | 需具体分析 | phone case, earbuds, charger |
| 办公用品 | 15,000 | pen holder, desk organizer |
| 运动户外 | 20,000 | resistance band, yoga mat |
| 母婴用品 | 15,000 | baby bottle, pacifier |
| 宠物 | 25,000 | dog leash, cat toy |
| 玩具 | 20,000 | building blocks, puzzle |
| 汽车配件 | 15,000 | car phone mount, seat cover |
| 园艺 | 15,000 | garden tool, plant pot |

## ❗ BSR 值选择流程（严格执行）

```
用户说要分析某产品
         ↓
用户是否明确说了 BSR 值？
  ├─ 是 → 用用户指定的值（如 BSR 12000）
  └─ 否 → 从品类底线表自动匹配
              ├─ 匹配到 → 用匹配的底线值
              └─ 未匹配 → 默认 10,000
```

**示例：**
- 用户说"分析一下 Cookie Cutter" → 关键词含 cook/cookie/kitchen/baking → 匹配"厨房家居" → BSR=10000
- 用户说"分析 Cookie Cutter，BSR 设 12000" → 用户明确指定 → BSR=12000
- 用户说"分析 phone case" → 匹配"消费电子" → 需具体分析，询问用户

**类型关键词匹配规则：**
- 如果关键词含 cook/cookie/baking/kitchen/spatula → 厨房家居 → 10000
- 如果关键词含 pet/dog/cat → 宠物 → 25000
- 如果关键词含 shoe/shirt/pant → 鞋服 → 30000
- ...其余以此类推（从品类底线表取）
- 无法匹配 → 默认 10000

## 底线表维护

**底线表数据来源**：知识库 `knowledge/amazon-selection-profit-vs-sales.md` 第 3.3 节

**更新频率**：
- 当用户更新知识库文件时 → 同步更新 SKILL.md 中的底线表
- 如果用户提到"底线变了"或"更新品类底线" → 从知识库重新读取

**默认值**：无法匹配时使用 10,000

## 操作流程

### Step 1: 确认 Edge 浏览器可用

检查 CDP 端口 9222 是否在线：
```powershell
Test-NetConnection -ComputerName localhost -Port 9222 -InformationLevel Quiet
```

如果返回 False，用以下命令重启 Edge（使用默认用户数据目录，保留 Oalur 登录态）：
```powershell
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -ArgumentList "--remote-debugging-port=9222","--no-first-run"
Start-Sleep -Seconds 5
```

⚠️ **不要用** `--user-data-dir` 指定其他目录，否则会丢失 Oalur 登录态。

### Step 2: 执行数据提取脚本

```bash
node skills/oalur-market-capacity/extract-data.js "关键词" BSR上限 输出文件.json
```

示例：
```bash
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-cutter-data.json
```


脚本自动完成：关键词输入、BSR 设置、勾选查看其他变体、翻页提取、ASIN 去重、父体 Listing 聚合、类目/标题意图过滤。

默认最大抓取页数为 **20 页**。Oalur 每页通常 20 条，因此单关键词最多采集约 **400 条 ASIN/变体数据**；如果实际页数少于 20 页，则按实际页数抓取。

#### 查看其他变体与父体聚合规则

必须在抓取第一页前确认 Oalur 的 **查看其他变体** 已勾选：

1. 点击确认查询后，先检查 `.var-sku .el-checkbox` 状态。
2. 如果未勾选，立即勾选并等待状态生效。
3. 第一页提取前必须再次断言已勾选；失败则停止执行。
4. 每次翻页后、提取该页前，也要再次确认已勾选。

数据口径：
- Oalur 原始行按 **ASIN/变体** 抓取。
- 先按 ASIN 去重。
- 再按 `pasin || parentAsin || asin` 聚合为 **父体 Listing**。
- 父体 Listing 的代表 ASIN 默认取该父体下 **大类 BSR 最好的子 ASIN**。
- 父体销量/销售额按所有子 ASIN 汇总。
- 报告中的竞争数量按父体 Listing 统计，避免变体重复计算。

### Step 3: 生成分析报告（市场容量 only）

```bash
node skills/oalur-market-capacity/generate-report.js output/日期-关键词/data/数据文件.json
```

### Step 4: 提取季节性数据

从 BSR 数据中自动选取上架 >3 年的 ASIN，提取以下三个数据源：

```bash
node skills/oalur-market-capacity/extract-seasonality.js "关键词" output/日期-关键词/data/数据文件.json output/日期-关键词/data/关键词-seasonality.json
```

脚本自动完成：
1. **Google Trends 5年搜索趋势**：从 Google Trends 网页提取公开数据（不需要登录，不截图）
2. **Oalur 关键词月度趋势（36个月）**：从 Oalur 关键词研究页的 Pinia store 一次性提取 6 个数据集：
   - 搜索量趋势（searchesTrend）
   - 搜索排名趋势（searchesRankTrend）
   - 机会指数趋势（oppIndexTrend）
   - 在售商品数趋势（productTotalNumTrend）
   - TOP3 产品点击份额趋势（topClickRatioTrend）
   - TOP3 转化份额趋势（topConvertRatioTrend）
   需 Edge CDP 登录态。数据在切换为"按月"后重新加载，所有 6 个字段同时存在于 Pinia store。
3. **老品 ASIN 月度销量趋势**：从 BSR 数据中自动选取上架 >3 年、销售额接近的 ASIN，提取近 35 个月的月度销售趋势（同时导出"价格&排名趋势" Excel）
4. **季节性分析**：计算峰谷比、峰值月份、多年月均值，输出季节性结论
5. **ASIN 趋势合并报告**：导出 Excel 后自动调用 `generate-asin-trends-combined.js`，生成独立的 Buybox价格/Ratings数/大类BSR 趋势 HTML

#### 多关键词季节性口径

如果输入多个关键词，季节性和 ABA 趋势默认使用第一个输入关键词。例如输入 `Coffee Spoon,Espresso Spoon`，Step 3 季节性使用 `Coffee Spoon`。

### Step 5: 提取 6 个月前历史数据（新品存活率）

**缓存优先**：如果 `output/日期-关键词/data/关键词-historical.json` 已存在且时间范围正确，直接使用缓存，无需重新抓取。

**时间范围自动计算**：基于当前月份倒推 6 个月。例：
- 当前 2026 年 6 月 → `--time-filter 2025-12`
- 当前 2026 年 7 月 → `--time-filter 2026-01`
- 当前 2026 年 12 月 → `--time-filter 2026-06`

```bash
# 示例：当前 2026 年 6 月，6 个月前 = 2025 年 12 月
# 如果 output/日期-关键词/data/关键词-historical.json 已存在且时间匹配，跳过此步
node skills/oalur-market-capacity/extract-data.js "关键词" BSR上限 output/日期-关键词/data/关键词-historical.json --time-filter 2025-12
```

脚本自动完成：点击 `.time-scope .time-select li` 切换时间 → 搜索关键词 → 提取历史 BSR 数据。

⚠️ 如果缓存文件的时间范围与预期不符，`generate-report.js` 会打印警告但仍使用该数据。

⚠️ **新品存活率边界情况**：如果 6 个月前该 BSR 范围内没有上架 <6 个月的新品（即 `histNewProducts.length === 0`），说明当时没有新品存在，不存在存活率可计算。此时报告会显示「该 BSR 范围内无新品」，而不是 0% 存活率。

### Step 6: 提取 CPC/客单价比值（广告成本快判）

当需要判断 CPC 广告点击单价时，禁止只看 CPC 绝对值；必须按照 `knowledge/amazon-opportunity-index-criteria.md` 使用 `CPC / 客单价 * 100%`。

数据来源：Oalur ACOS 工具 `https://vip.oalur.com/tool/acos?site=US`。

```bash
node skills/oalur-market-capacity/extract-cpc-opportunity.js output/日期-关键词/data/关键词-asin-lifecycle.json output/日期-关键词/data/数据文件.json output/日期-关键词/data/关键词-cpc-opportunity.json
```

判定标准：
- `<5%`：极佳
- `5%-10%`：良好
- `10%-15%`：一般
- `>15%`：很差

### Step 7: 生成完整报告（市场容量 + 季节性 + 存活率）

```bash
node skills/oalur-market-capacity/generate-report.js output/日期-关键词/data/数据文件.json --seasonality output/日期-关键词/data/关键词-seasonality.json --historical output/日期-关键词/data/关键词-historical.json --asin-lifecycle output/日期-关键词/data/关键词-asin-lifecycle.json --cpc-opportunity output/日期-关键词/data/关键词-cpc-opportunity.json
```

模板文件：`skills/oalur-market-capacity/report-template.html`
生成脚本：`skills/oalur-market-capacity/generate-report.js`

⚠️ **ASIN 趋势合并报告**（Step 4 执行时自动生成，无需单独执行）：`extract-asin-trends.js` 导出 Excel 后自动调用 `generate-asin-trends-combined.js` 生成第 2 个 HTML。

### 季节性分析维度（自动计算）

| 维度 | 数据源 | 计算方式 | 判定标准 |
|---|---|---|---|
| **Google 峰谷比** | Google Trends | 多年月均值的 max/min | ≥2 = 明显季节性, 1.5-2 = 温和季节性 |
| **Oalur 峰谷比** | Oalur searchesTrend | 多年月均值的 max/min | ≥2.5 = 强季节性, 1.8-2.5 = 温和 |
| **季节性得分** | Google + Oalur 综合 | Google 最高+50分, Oalur 最高+60分 | ≥60 = 强季节性, 30-59 = 弱季节性 |
| **峰值月份** | Google + Oalur | 多峰值月份取交集 | 用于制定备货和广告计划 |
| **ASIN 趋势验证** | 3 个老品 ASIN 月销量 | 观察每年同月的销量峰谷 | 确认季节性在真实销售数据中的体现 |

### 季节性报告包含的图表

1. **季节性结论卡片**：季节性类型、得分、峰值月份、策略建议
2. **Google Trends 折线图**：5年搜索兴趣趋势（周级数据）
3. **Oalur 月搜索量柱状图**：36个月站内搜索量
4. **Google vs Oalur 对比图**：双 Y 轴多年月均值叠加图
5. **💡 Oalur 月度机会指数趋势图**：36个月机会指数（搜索量/在售商品数）+ **趋势分析**（上升/稳定/下降判定）
6. **📦 Oalur 月度在售商品数趋势图**：36个月市场竞争规模变化
7. **🏆 TOP3 产品点击份额 & 转化份额**：合并柱状图 + **头部垄断度判定**（四种情况自动匹配知识库标准） + **标品/非标品倾向判断** + 月度数据对照表
8. **3 个老品 ASIN 月度销售额柱状图**：近 35 个月真实销售趋势

### 新增分析模块（基于知识库 `amazon-selection-standard-vs-nonstandard.md`）

| 分析模块 | 数据来源 | 输出内容 |
|---|---|---|
| **TOP3 头部垄断度** | `topClickRatioTrend` + `topConvertRatioTrend` | 最近6月均值 → 四种判定：严重垄断/转化垄断/曝光集中/无垄断 |
| **机会指数趋势** | `oppIndexTrend` + `productTotalNumTrend` | 前后半段对比 → 上升/稳定/下降 + 在售商品数趋势 |
| **标品/非标品判断** | TOP3份额 + 搜索排名波动 | 标品倾向/非标品倾向/混合型 + 对应策略建议 |

TOP3 点击份额与转化份额必须按 `knowledge/amazon-selection-standard-vs-nonstandard.md` 的四象限解读，禁止简单相加：
- 点击 >50% 且转化 >50%：头部垄断严重。
- 点击不高但转化 >50%：转化垄断强，消费者最终选头部。
- 点击 >50% 但转化不高：曝光集中但转化外流，可能存在差异化切入或整体转化偏低。
- 点击 <20% 且转化 <20%：头部垄断低，但也可能代表大词流量高度分散、竞争面很广。

报告中必须同时输出：最近 6 个月 TOP3 点击均值、转化均值、四象限判定、标品/非标品倾向，以及“点击和转化是不同维度，不能直接相加”的说明。

### 机会指数与 CR3 量化标准（基于 `amazon-opportunity-index-criteria.md`）

机会指数与在售商品数模块必须同时输出：
- 基础机会指数原始值：`月搜索量 / 在售商品数`，优先使用 Oalur `oppIndexTrend`。
- 行业调整系数：按 `knowledge/category-opportunity-adjustment.md` 的“选品分析用行业机会指数调整系数”匹配类目/关键词/季节性线索。
- 行业调整后机会指数：`基础机会指数原始值 × 行业调整系数`，报告判断以该值为主。
- 有效机会指数：`(月搜索量 × 0.9) / (48 × 0.04)`，其中 48 为前 3 页商品数，0.04 为行业平均转化率。
- 品牌 CR3：过滤后目标市场 TOP3 品牌销量 / 总销量。

基础机会指数标准：`>10` 极致蓝海；`5-10` 优质蓝海；`2-5` 轻度竞争；`1-2` 中度竞争；`0.5-1` 中高竞争；`0.2-0.5` 红海；`<0.2` 极致红海。

行业调整系数必须展示命中的类目类型、系数和原因；命中多条规则时取更保守的较低系数。有效机会指数只用于判断前 3 页有效流量池规模，不替代行业调整后机会指数。

有效机会指数标准：`>10000` 极佳；`5000-10000` 良好；`1000-5000` 一般；`<1000` 较差。

品牌 CR3 标准：`<40%` 低垄断；`40%-60%` 中度垄断；`>60%` 高垄断。CR3 比单纯机会指数更能说明头部品牌垄断程度，机会指数不能单独作为进入决策。

### Step 8: 保存报告
自动保存到：
```
output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_市场分析.html              ← 报告1：完整分析
output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_ASIN生命周期趋势分析.html   ← 报告2：ASIN价格排名趋势
```

### Step 9: 可选生成子 ASIN 明细报告

当用户要求“把所有父体代表 ASIN 单独输出一份报告”“输出它的子 ASIN、类目”等时，执行：

```bash
node skills/oalur-market-capacity/generate-child-asin-report.js output/日期-关键词/data/数据文件.json
```

报告自动保存到：

```text
output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_子ASIN明细.html
```

报告内容：
- 每个过滤后的父体 Listing 一个模块
- 父体代表 ASIN、父体 ASIN、过滤来源
- 子 ASIN 数（不含代表 ASIN 本身）
- 同父体 ASIN 总数
- 所有同父体 ASIN 的标题、类目、销量、销售额、BSR、小类排名、价格、上架时间、评论数、品牌
- “匹配依据”列显示 `目标类目` / `标题意图` / `目标类目+标题意图` / `未命中`

## 目标类目与标题意图过滤

不要再用“数量最多的类目”作为唯一目标类目。当前类目过滤由 `category-selector.js` 计算关键词相关性分，并允许“功能等价候选类目 + 单 ASIN 标题意图”二次保留。

### 类目评分

关键词会拆成：
- 修饰词：除最后一个词以外的 token，例如 `Coffee Spoons` 的 `coffee`
- 产品形态词：最后一个 token，例如 `spoon`
- 形态同义词：例如 `spoon` 可扩展为 `spoon/scoop`

类目分数主要由以下部分组成：
- 类目路径包含全部关键词 token：+85
- 类目路径命中产品形态：+35
- 类目叶子类目命中产品形态：+20
- 类目路径每命中一个修饰词：+24
- 叶子类目每命中一个修饰词：+10
- 类目下标题强匹配率：最高 +45
- 类目下标题部分匹配率：最高 +12
- 类目产品数量权重：最高 +14

扣分规则：
- 只命中产品形态，但没有修饰词，且标题强匹配率 <35%：-35
- 只命中修饰词，但没有产品形态，且标题强匹配率 <20%：-16
- 修饰词和产品形态都没命中：-60

目标类目选择门槛：
- 分数 >= 110，且产品数 >= 3
- 或分数 >= 180，即使产品数少于 3 也可选
- 如果没有任何类目达标，才回退选分数最高的一个类目

### 功能等价候选类目

像 `Coffee Spoons` 这类搜索，`Teaspoons`、`Iced Tea Spoons`、`Measuring Spoon Sets` 可能是功能等价候选，但不能整类直接纳入目标类目。

候选条件：
- 类目路径命中产品形态词或其同义词
- 类目路径没有命中修饰词
- 类目下标题强匹配率 >=35%
- 标题部分匹配率 >=70%
- 叶子类目不能是 `rest/holder/stand/rack/organizer/case/cover` 这类配件类目

候选类目内的单个父体 Listing 还必须通过标题意图：
- 标题必须命中产品形态词，例如 `spoon/scoop`
- 标题必须命中修饰词或其意图同义词，例如 `coffee/espresso/demitasse/cappuccino/latte/moka`
- `Chocolate Molds` 场景中，`chocolate` 的意图同义词包括 `candy/gummy/caramel/fondant/bonbon/truffle`

通过该规则保留的父体 Listing 必须设置：
- `keywordIntentRescued: true`
- `targetMatchedChildAsins`
- 报告中“过滤来源”列显示 **标题意图救回**

示例：
- `B091CHRKVH`：类目是 `Teaspoons`，标题含 `Coffee/Tea Spoons`，可被标题意图救回。
- `B0C78BBX27`：类目也是 `Teaspoons`，但标题只有泛 `Spoon Set`，不命中 coffee/espresso 意图，应排除。

## 新品统计口径

父体 Listing 的代表 ASIN 仍然取 BSR 最好的子 ASIN，但新品统计不能只看代表 ASIN。

新品分析必须按父体 Listing 统计，并检查父体下目标相关子 ASIN：
- 只要目标相关子 ASIN 中存在 `<6个月`，该父体 Listing 计入新品父体。
- 如果新品不是代表 ASIN，而是父体下某个子 ASIN，报告标记为 **父体新品子ASIN**。
- `<12个月` 分析同理，标记为 **父体<12月子ASIN**。
- 如果代表 ASIN 自身 `<12个月`，且目标相关子 ASIN 全部 `<12个月`，在 `<12个月` 列表中标记为 **纯新父体**。

过滤后的 ASIN 表必须包含：
- 过滤来源：`目标类目` / `标题意图救回`
- 子 ASIN 数（同父体下除当前代表 ASIN 以外的 ASIN 数，不含代表 ASIN 本身）

新品销量表必须包含：
- 父体/代表 ASIN
- 新品子 ASIN
- 来源
- 子 ASIN 数（不含代表 ASIN 本身）

## 输出格式

### 消息摘要（发送给用户）
```
📊 市场容量分析：[关键词]

目标类目：[自动识别的类目路径]
底线 BSR：[底线值]
底线内产品：[X] 条（过滤前 [Y] 条，排除 [Z] 条）
前100名最后一名排名：[X]（底线 [Y]）

📈 BSR 区间分布（等宽 1000 间隔，禁止 5000-10000 不等宽区间）：
- 0-1000：[X] 个
- 1000-2000：[X] 个
- 2000-3000：[X] 个
- 3000-4000：[X] 个
- 4000-5000：[X] 个
- 5000-6000：[X] 个
- 6000-7000：[X] 个
- 7000-8000：[X] 个
- 8000-9000：[X] 个
- 9000-10000：[X] 个

📅 上架时间分布：
- 0-6个月：[X] 个（[X]%）
- 6-12个月：[X] 个（[X]%）
- ...

✅ 市场容量结论：[建议进入 / ⚠️ 慎入 / ❌ 不进入]
原因：[简述]

⚔️ 竞争分析：
- 单品占比：TOP1 [X]%，TOP3 [X]%，TOP5 [X]%，TOP10 [X]%
- 品牌集中度：TOP1 [品牌名] [X]%，TOP3 [X]%，分散度 [X]%
- 评论壁垒：前20平均 [X]（<600），中位数 [X]（<350），前20中<100条: [X]个（≥3）
- 卖家结构：[最大类型] 占比 [X]%
- 进入限制：[有/无]
- 竞争结论：[✅ 竞争适中 / ⚠️ 竞争激烈]

📎 完整报告：output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_市场分析.html
```

### 季节性摘要（追加在市场容量摘要之后）
```
🌀 季节性与市场趋势分析：[关键词]

季节性类型：[强季节性 / 弱季节性 / 非季节性]（得分：[X]）
Google Trends 峰值月份：[月份列表]
Oalur 站内峰值月份：[月份列表]
数据一致性：[一致 / 偏差说明]

📈 Google Trends：5年趋势形态 [描述]
📊 Oalur 搜索量：[X] 个月数据，多年月均峰谷比 [X]
📈 老品 ASIN 趋势：[X] 个 ASIN 有月度销售数据

💡 策略建议：[旺季备货建议 / 全年运营建议]

📎 完整报告（含季节性）：output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_市场分析.html
```

## 关键技术点

1. **puppeteer-core 连接**：`puppeteer.connect({ browserURL: 'http://localhost:9222' })` 直连 Edge CDP
2. **关键词输入**：必须用 `input[placeholder*="支持ASIN"]` 选择器，不要用 `.keyword-wrap input`（会选到下拉框）
3. **Vue 响应式**：用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` 触发 Vue 绑定
4. **BSR 输入**：在 `大类BSR排名` label 的父元素中找 `input[type="number"]`
5. **el-table 提取**：用 `.el-table__body-wrapper table tbody tr` 选择器
6. **类目路径提取**：从 titleCell 的各行中找包含 `>` 且以英文字母开头的行（排除 PASIN 行）
7. **上架时间解析**：优先用 `listingAge`（"X年X月X天"），为空时用 `listingDate`（"YYYY-MM-DD"）计算月数差
7. **查看其他变体**：必须开启。第一页抓取前和每次翻页后都要确认 `.var-sku .el-checkbox` 已勾选；如果无法勾选则停止执行。
8. **分页翻页**：点击 `.el-pager .number` 后必须等待内容变化（比较整页 ASIN 集合，不能只比较首行），不能固定等待
9. **去重与聚合**：先按 ASIN 去重，再按父体聚合；代表 ASIN 取父体下大类 BSR 最好的子 ASIN，销量/销售额按父体汇总
10. **类目过滤**：使用关键词相关性评分选择目标类目；功能等价候选类目只能通过单 ASIN 标题意图救回，不能整类直接纳入
11. **排除产品存档**：过滤掉的产品也输出到结果文件（`excluded` 字段），方便复查

## 竞争分析报告包含的图表

1. **竞争核心指标卡片**：TOP1 单品占比、TOP3 品牌份额、品牌分散度、平均星级
2. **品牌集中度柱状图**（按销量占比，TOP10 品牌横向柱状图）
3. **星级评分分布柱状图**（5 个区间）
4. **卖家性质饼图**（按销量占比，亚马逊自营/FBA/FBM）
5. **单品市场占比进度条**（TOP1/TOP5/TOP10）
6. **进入限制分析列表**（自动检测 + 人工补充）
7. **竞争综合结论**（基于六大维度的自动判断）

## 注意事项

1. **不要用 OpenClaw browser tool**：edge profile CDP 连接不稳定，snapshot/evaluate 会超时
2. **必须用 puppeteer-core 直连**：脚本在本 skill 工程目录下执行，依赖从本地 `node_modules/` 解析
3. **"查看其他变体"必须开启**：抓取 ASIN/变体明细后按父体 Listing 聚合，竞争数量按父体统计
4. **必须按类目和标题意图过滤**：Oalur 搜索结果包含大量无关品类，不过滤会导致分析失真。目标类目用评分选择；功能等价候选类目内只保留标题命中搜索意图的 ASIN
5. **分页必须等内容变化**：点击页码后轮询检查整页 ASIN 集合是否变化（不能只比较首行，否则会误判）
6. **去重**：最终数据按 ASIN 去重
7. **默认近30天**：时间范围通常已默认选中"近30天"，无需额外操作
8. **存档规则**：抓取数据、报告和 Excel 分别保存到 `output/日期-关键词/data`、`output/日期-关键词/reports`、`output/日期-关键词/excel`

### 季节性分析注意事项

1. **Google Trends 是公开数据**：不需要登录，不需要 CDP 连接，puppeteer 直接访问即可
2. **Oalur 搜索量和 ASIN 趋势需要 CDP**：需要通过 Edge 浏览器（端口 9222）保持 Oalur 登录态
3. **ASIN 自动选取**：从 BSR 数据中取上架 >3 年且 BSR 最好的 3 个，无需手动指定
4. **Google Trends 峰值可能比亚马逊早 1-2 个月**：分析结论中需要标注偏差
5. **分析 5 年数据，不要只看 1 年**：避免某年异常（疫情、大促等）干扰判断
6. **提取脚本间需要独立页面**：每次提取都使用 puppeteer 新建标签页，避免页面状态冲突

## ⚠️ 执行顺序（死记！千万别搞反）

**必须先输入关键字 → 再设置 BSR 排名 → 最后点击确认查询**

**错误示例（翻页无限循环的根因）**：
- ❌ 页面状态残留 → 关键字输入失败（没清空/没填上）→ 只成功设了 BSR → Oalur 返回总计 0 条 → lastPage=500 → 翻 500 页
- ❌ 不要以为设了 BSR 就会出东西，**关键字是搜索的前提，BSR 是筛选项**

**每次爬新关键词前**：
- 如果 Edge 页面状态可疑（前一次爬取结果还留在页面上），**必须 reload 页面**，保证表单从空白状态开始
- 如果 reload 后还不行 → kill 所有 Edge 进程重新启动
- 关键字输入后肉眼确认 `总计: 非0条`，再继续，否则立刻中断排查

**正确顺序**：
1. 导航到 Oalur 筛选页（或 reload）
2. **先填关键字**（必须！否则 Oalur 返回 0 条）
3. **再设 BSR 范围**（min=1, max=BSR上限）
4. 再点击确认查询
5. 等待表格刷新后检查 `总计: 非0` → 确认搜索成功
6. 勾选并确认"查看其他变体"已开启
7. 第一页抓取前再次断言变体已开启
8. 开始提取数据（翻页），每页抓取前都确认变体仍开启

## 完整流程示例

```bash
# Step 1: 确认 Edge CDP 可用
Test-NetConnection -ComputerName localhost -Port 9222 -InformationLevel Quiet

# Step 2: 提取当前 BSR 市场数据
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-data.json

# Step 3: 提取季节性数据（会自动生成 ASIN生命周期趋势分析.html）
node skills/oalur-market-capacity/extract-seasonality.js "Biscuit Cutter" output/日期-Biscuit-Cutter/data/biscuit-data.json output/日期-Biscuit-Cutter/data/biscuit-seasonality.json

# Step 4: 提取 6 个月前历史数据（用于新品存活率，如当前是 2026-06 → 2025-12）
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-historical.json --time-filter 2025-12

# Step 5: 生成完整报告
node skills/oalur-market-capacity/generate-report.js output/日期-Biscuit-Cutter/data/biscuit-data.json --seasonality output/日期-Biscuit-Cutter/data/biscuit-seasonality.json --historical output/日期-Biscuit-Cutter/data/biscuit-historical.json --asin-lifecycle output/日期-Biscuit-Cutter/data/biscuit-asin-lifecycle.json
```

报告自动保存到：
- `output/YYYY-MM-DD-Biscuit-Cutter/reports/YYYY-MM-DD_Biscuit-Cutter_市场分析.html`（报告1：完整分析）
- `output/YYYY-MM-DD-Biscuit-Cutter/reports/YYYY-MM-DD_Biscuit-Cutter_ASIN生命周期趋势分析.html`（报告2：ASIN价格排名趋势，Step 3 自动生成）

## HTML 报告离线打包流程

当用户要求“打包两个 HTML 报告”“让报告在别的电脑上也能浏览”时，必须把主报告和 ASIN 生命周期报告做成独立离线包。

### 打包目标

输出到当前任务目录下：

```text
output/YYYY-MM-DD-关键词/package/关键词-html-reports-offline-时间戳/
output/YYYY-MM-DD-关键词/package/关键词-html-reports-offline-时间戳.zip
```

包内必须包含：

```text
YYYY-MM-DD_关键词_市场分析.html
YYYY-MM-DD_关键词_ASIN生命周期趋势分析.html
assets/chart.umd.min.js
assets/chartjs-adapter-date-fns.bundle.min.js
README.txt
```

### 依赖本地化

两个报告使用 Chart.js 渲染图表，不能保留 CDN 依赖，否则别的电脑离线打开会缺图。

需要下载并保存到 `downloads/`，再复制到打包目录的 `assets/`：

```text
https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.min.js
https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3/dist/chartjs-adapter-date-fns.bundle.min.js
```

打包副本中的脚本引用必须替换为：

```html
<script src="assets/chart.umd.min.js"></script>
<script src="assets/chartjs-adapter-date-fns.bundle.min.js"></script>
```

注意：只修改打包副本，不要为了打包去改 `reports/` 下的原始报告。

### 打包命令示例

以下示例以 `Coffee Spoon` 为例，实际使用时替换任务目录和文件名：

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskDir = 'output\2026-06-05-Coffee-Spoon'
$packageRoot = "$taskDir\package\coffee-spoon-html-reports-offline-$stamp"
$assetsDir = "$packageRoot\assets"
New-Item -ItemType Directory -Force downloads, $assetsDir | Out-Null

$chartDownload = "downloads\chart.umd.min-$stamp.js"
$adapterDownload = "downloads\chartjs-adapter-date-fns.bundle.min-$stamp.js"
Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.min.js' -OutFile $chartDownload
Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3/dist/chartjs-adapter-date-fns.bundle.min.js' -OutFile $adapterDownload

Copy-Item $chartDownload "$assetsDir\chart.umd.min.js"
Copy-Item $adapterDownload "$assetsDir\chartjs-adapter-date-fns.bundle.min.js"
Copy-Item "$taskDir\reports\2026-06-05_Coffee-Spoon_市场分析.html" "$packageRoot\2026-06-05_Coffee-Spoon_市场分析.html"
Copy-Item "$taskDir\reports\2026-06-05_Coffee-Spoon_ASIN生命周期趋势分析.html" "$packageRoot\2026-06-05_Coffee-Spoon_ASIN生命周期趋势分析.html"

$main = "$packageRoot\2026-06-05_Coffee-Spoon_市场分析.html"
$life = "$packageRoot\2026-06-05_Coffee-Spoon_ASIN生命周期趋势分析.html"
(Get-Content -Raw -Encoding UTF8 $main).Replace('https://cdn.jsdelivr.net/npm/chart.js','assets/chart.umd.min.js') | Set-Content -Encoding UTF8 $main
(Get-Content -Raw -Encoding UTF8 $life).Replace('https://cdn.jsdelivr.net/npm/chart.js','assets/chart.umd.min.js').Replace('https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3','assets/chartjs-adapter-date-fns.bundle.min.js') | Set-Content -Encoding UTF8 $life

@"
打开方式：
1. 解压 zip。
2. 双击主报告 HTML。
3. 主报告中的 ASIN 生命周期链接会打开同目录下的生命周期报告。

说明：
- Chart.js 与日期适配器已放在 assets/，图表可离线浏览。
- Amazon 商品链接仍为外部网页链接，需要联网才能打开商品详情。
"@ | Set-Content -Encoding UTF8 "$packageRoot\README.txt"

Compress-Archive -Path "$packageRoot\*" -DestinationPath "$packageRoot.zip"
```

### 打包后必须验证

1. 检查 zip 内容必须包含 2 个 HTML、2 个 assets JS、README：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead("output\...\package\xxx.zip").Entries | Select-Object FullName,Length
```

2. 检查包内 HTML 不再引用 CDN：

```powershell
Select-String -Path "output\...\package\xxx\*.html" -Pattern 'cdn.jsdelivr.net|<script src|assets/|ASIN生命周期趋势分析'
```

结果中不应出现 `cdn.jsdelivr.net`，应出现 `assets/chart.umd.min.js` 和 `assets/chartjs-adapter-date-fns.bundle.min.js`。

3. 用 Edge CDP 打开包内两个 HTML，检查 canvas 数量和非空渲染：

```javascript
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const pkgDir = path.resolve('output/YYYY-MM-DD-关键词/package/xxx');
const files = fs.readdirSync(pkgDir).filter(f => f.endsWith('.html'));
const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: { width: 1440, height: 1000 } });
for (const file of files) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(pkgDir, file)).href, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500));
  const canvases = await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => {
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonEmpty = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) nonEmpty++;
    return { id: c.id, nonEmpty };
  }));
  console.log(file, { canvasCount: canvases.length, emptyCanvas: canvases.filter(c => c.nonEmpty === 0).length });
  await page.close();
}
await browser.disconnect();
```

合格标准：
- 主报告和生命周期报告都能从 `file://` 打开。
- `emptyCanvas` 必须为 `0`。
- 生命周期报告应有 `6 个 ASIN × 3 张图 = 18` 个 canvas（如果 ASIN 数量不同，则按实际 ASIN 数 × 3）。
