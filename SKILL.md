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
- **参考类目（可选）**：只参与初始目标类目/待救回类目选择，不直接救回 ASIN，不跳过标题意图或价格守卫，不参与后续评分。CLI 使用 `--reference-categories "类目1||类目2"`；文件使用 `--reference-categories-file output/任务/reference-categories.txt`，每行一个类目。

## 多关键词分析流程

当输入多个关键词时，默认必须使用**独立抓取 + 离线合并**，把每个关键词先保存成单独数据文件，再通过 `merge-data.js` 合并成一个数据库，确保页面状态残留不会污染后续关键词。

### 默认方式：逗号输入，脚本自动独立抓取并合并
```bash
node skills/oalur-market-capacity/extract-data.js "Cookie Cutter,Biscuit Cutter" 10000 output/日期-Cookie-Cutter-Biscuit-Cutter/data/merged-data.json
```

脚本会自动执行：
1. `Cookie Cutter` 独立抓取到 `output/日期-Cookie-Cutter-Biscuit-Cutter/data/Cookie-Cutter-data.json`
2. `Biscuit Cutter` 独立抓取到 `output/日期-Cookie-Cutter-Biscuit-Cutter/data/Biscuit-Cutter-data.json`
3. 调用 `merge-data.js --output` 合并为 `merged-data.json`

### 手动方式：独立抓取 + merge-data.js 合并
```bash
# 分别独立抓取
node skills/oalur-market-capacity/extract-data.js "Cookie Cutter" 10000 output/日期-Cookie-Cutter/data/cookie-data.json
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-data.json

# 合并去重（ASIN去重 + 父体 Listing 聚合 + 类目/标题意图过滤 + 价格守卫）
node skills/oalur-market-capacity/merge-data.js output/日期-Cookie-Cutter/data/cookie-data.json output/日期-Biscuit-Cutter/data/biscuit-data.json --output output/日期-merged-data/data/merged-data.json

# 生成报告
node skills/oalur-market-capacity/generate-report.js output/日期-merged-data/data/merged-data.json
```

`merge-data.js` 合并时会重新执行目标类目选择、功能等价候选类目救回、标题意图判断和救回价格守卫，过滤口径必须与 `extract-data.js` / `refilter-data.js` 保持一致。输出路径优先使用 `--output` 或 `--out` 指定；如果省略输出路径，脚本会自动写到 `output/日期-merged-data/data/merged-data.json`，不会把已存在的最后一个输入文件当输出覆盖。旧式“最后一个不存在的路径作为输出文件”仅作为兼容模式，不建议继续使用。脚本读取 JSON 时会兼容 UTF-8 BOM。

### 不推荐方式：单进程连抓
旧版本支持在同一页面会话内连续抓取多个关键词，但 Oalur 页面状态可能残留，导致后续关键词结果与单独搜索不一致。当前默认不再使用该方式。

## 品类底线排名（自动匹配）

根据关键词推断品类，匹配对应的底线排名：

| 品类 | 底线 BSR | 关键词示例 |
|---|---|---|
| 美妆工具 | 8,000-10,000 | makeup brush, eyelash curler |
| 厨房家居 | 15,000 | biscuit cutter, spatula, kitchen gadget |
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
              └─ 未匹配 → 默认 15,000
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
- 无法匹配 → 默认 15000

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

参考类目示例：
```bash
node skills/oalur-market-capacity/extract-data.js "dishwasher cleaner tablets" 20000 output/日期-Dishwasher-Cleaner-Tablets/data/data.json --reference-categories "Home & Kitchen > Cleaning Supplies > Household Cleaning > Kitchen Cleaners > Dishwasher & Garbage Disposal Cleaners > Dishwasher Cleaners||Health & Household > House Supplies > Dishwashing > Dishwasher Cleaners||Health & Household > House Supplies > Household Cleaning > Kitchen Cleaners > Dishwasher & Garbage Disposal Cleaners > Dishwasher Cleaners"
```


脚本自动完成：关键词输入、BSR 设置、勾选查看其他变体、翻页提取、ASIN 去重、父体 Listing 聚合、类目/标题意图过滤。

#### 参考类目输入

参考类目只作用于最初的类目筛选模块：

1. 如果输入参考类目，`selectTargetCategories` 会对候选类目做参考匹配加权，匹配类型、加权分和命中来源写入 `categorySelection` / `referenceCategorySelection`。
2. 参考类目不是白名单，不会直接把 ASIN 救回，也不会跳过标题意图或价格守卫。
3. 其它类目仍按原评分规则选择目标类目和救回候选类目；参考类目只影响初始类目选择阶段。
4. 最终 `targetCategories` 仍由评分门槛、类目证据和参考类目加权共同决定，不是简单把参考类目并入结果。
5. 非目标类目如果进入 `equivalentCandidateCategories`，后续必须通过标题意图救回；标题意图救回仍受价格守卫约束。
6. 只有产品自身类目命中 `targetCategories` 时才直进；其它类目仍需走救回流程。
7. 参考类目不进入利润、竞争、新品、季节性或最终评分。
8. 多关键词、历史新品抓取、`merge-data.js` 和 `refilter-data.js` 都支持同样参数，保证初始类目筛选口径一致。

#### JSON 批量顺序执行

如果输入文件是 `keywords-agent-same.json` 这类结构，使用批量入口顺序执行：

```bash
node skills/oalur-market-capacity/run-keyword-json-batch.js output/来源/data/keywords-agent-same.json --bsr 20000 --start 2 --limit 1
```

批量脚本读取顶层 `products[]`，每个产品使用：
- `keyword` 作为市场分析关键词。
- `[category, ...categories]` 合并去重后作为参考类目。
- `--start` 使用 1-based 序号，`--start 2 --limit 1` 表示只跑第二个产品。
- 默认 BSR 为 `20000`；如需统一调整，传 `--bsr 数值`。
- 默认开启断点续跑。脚本会在批次目录写入 `batch-progress.json`，记录当前产品序号、当前步骤、已完成/失败状态。
- 如果命令超时或中断，重新执行同一命令会跳过已完成产品，并从未完成产品的缺失步骤继续。
- 如果跨日期继续旧批次，传 `--batch-root output/YYYY-MM-DD-automated-market` 指向原批次目录。
- 如需忽略进度并重跑选中范围，传 `--no-resume`。

输出统一放在批次目录：

```text
output/YYYY-MM-DD-automated-market/YYYY-MM-DD-002-Crumpet-Rings-20000/
```

单品目录内继续使用现有 `data/`、`reports/`、`excel/` 结构。批量脚本按顺序串行执行，不并发，避免 Edge/Oalur 页面状态互相污染。

#### 未识别类目补查

如果筛选页抓到的 ASIN 类目为空、乱码、`unknown`，或不是完整路径（不包含 `>`），脚本不能直接把它作为“未识别”参与目标类目评分。必须在 ASIN 去重后、目标类目选择前补查：

1. 打开 `https://vip.oalur.com/products/information?asin=ASIN&site=US`。
2. 优先读取页面 XHR 中的 `basicInfo` / `bsrTrends` 数据。
3. 提取产品所属品类路径；同时保存大类 BSR 排名趋势摘要（最近点数、最新 BSR、近 30 个点）。
4. 如果成功拿到完整品类路径，回填到该 ASIN 的 `category`，并标记 `categorySupplementedFrom: "products-information"`。
5. 补查摘要写入输出 JSON 的 `categorySupplementSummary`，用于复查哪些 ASIN 被回填、哪些失败。

默认补查并发为 5 个 ASIN 页面，最多 5 个；可通过 `OALUR_CATEGORY_SUPPLEMENT_CONCURRENCY` 调整。每个补查页面必须在完成后关闭。

#### 缺失上架时间补查

普通市场分析中，缺失上架时间不在过滤前补查；只有产品已经进入最终 `data` 分析池后，才补齐上架时间。历史新品快照模式例外，因为必须用上架时间判断 6 个月窗口，此时需要在历史过滤前补查。

1. 打开 `https://vip.oalur.com/products/information?asin=ASIN&site=US`。
2. 优先从页面 XHR 的 `basicInfo` / 详情 payload 中提取上架时间；失败时再从页面文本中按“上架时间 / Listing Date / Date First Available”等标签解析。
3. 成功后回填该 ASIN 的 `listingDate`，并标记 `listingDateSupplementedFrom: "products-information"`。
4. 补查摘要写入输出 JSON 的 `listingDateSupplementSummary`。
5. 历史新品快照模式下，补齐上架时间后必须再次执行 6 个月窗口过滤，避免日期缺失的老品误入历史新品样本。

默认补查并发为 5 个 ASIN 页面，最多 5 个；可通过 `OALUR_LISTING_DATE_SUPPLEMENT_CONCURRENCY` 调整。每个补查页面必须在完成后关闭。

#### 固定 BSR 抓取口径

用户输入多少 BSR，就只按该 BSR 范围抓取和分析；脚本不再根据月销量最低数自动建议扩大 BSR，也不做新增区间扩容采集。

- 默认抓取范围为 `1-BSR上限`。
- 如果人工指定 `--bsr-min`，脚本只设置该 BSR 区间并抓取，不把它当作自动扩容流程。
- 目标匹配产品不再因为月销量 `<200` 或销量缺失移入 `excluded`；销量缺失/低销量只作为报告风险提示，不参与类目过滤。
- 报告需要提示样本充足性：如果过滤后目标父体 `<90`，或过滤后最低月销量 `>600`，报告显示“建议增加样本”。这只是人工建议，不自动扩容。

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
- 父体销量/销售额优先取 Oalur 代表父体行数值；Oalur 父体行的月销量、月销售额通常已自带子 ASIN 汇总，不能在代表行有效时再对子 ASIN 求和，否则会重复计算。
- 如果代表父体行月销量或月销售额缺失、为 `--` 或为 0，才允许使用子体指标兜底：先读取同一 ASIN 行里的 `子体销量 / 子体销售额`，再按该父体下已抓到的子 ASIN 行求和；多个子 ASIN 必须累加，只有 1 个子 ASIN 时也要使用该行子体指标。兜底后写入 `salesRevenueMetricSource` 和对应 fallback reason，若子体指标也没有有效销量/销售额，则保留缺失并在报告风险中体现。
- 父体 Ratings 需要先判断子 ASIN 是否共享同一个评分池：如果 2 个或以上子 ASIN Ratings 完全相同，或高 Ratings（中位数 >=1000）且相差不大（最大最小差 / 中位数 <=25%），或最大/最小差异极大（最大 >=500 且最大/最小 >=4），视为共享评分，父体 Ratings 取最大值；否则视为独立评分，父体 Ratings 按所有子 ASIN 求和。
- 执行完共享/独立评分判断后，如果父体 Ratings 仍为 0，才允许进入 `https://vip.oalur.com/products/information?asin=父体ASIN&site=US` 补查该父体 ASIN 的“评分数/评论数”前半段评分数；补查只更新 Ratings，不更新销量和销售额。Ratings 补查默认并发为 5 个 ASIN 页面，最多 5 个，可通过 `OALUR_RATINGS_SUPPLEMENT_CONCURRENCY` 调整，每个补查页面必须在完成后关闭。
- 代表父体 ASIN 的 `sales`、`revenue` 字段必须优先来自代表父体行，只有代表行缺失/为 0 时才使用子 ASIN 求和兜底；`ratings` 字段必须按共享/独立评分规则计算。
- 报告中的竞争数量按父体 Listing 统计，避免变体重复计算。
- “纯新父体”必须使用严格口径：代表 ASIN 上架时间在窗口内，并且父体下全部已抓到的子 ASIN 上架时间都在窗口内；任一子 ASIN 上架时间缺失或超出窗口，都不能算纯新父体。老父体新增目标相关子 ASIN 只能算“父体新品子ASIN”，不能进入纯新父体存活率。

### Step 3: 生成分析报告（市场容量 only）

```bash
node skills/oalur-market-capacity/generate-report.js output/日期-关键词/data/数据文件.json
```

### Step 3.5: 只更新过滤逻辑时离线重筛

如果当前数据已经完整抓取过，例如 `data + excluded` 中已经包含所有父体 Listing 和 `variantRows`，修改类目过滤、标题意图、同义词、宽类目二次过滤规则后，禁止重新打开 Oalur 抓取。先用现有 JSON 离线重筛：

```bash
node skills/oalur-market-capacity/refilter-data.js output/日期-关键词/data/数据文件.json
```

该脚本会读取现有 `data` 和 `excluded`，合并为完整父体集合，重新计算 `targetCategories`、`categorySelection`、`data`、`excluded`，并覆盖输出 JSON。随后只需要重新执行 `generate-report.js` 和 `generate-child-asin-report.js`。只有原始页数不完整、缺少 `excluded`、缺少 `variantRows`，或需要补新月份/新关键词时，才重新抓取 Oalur。

### Step 4: 提取季节性数据

从 BSR 数据中自动选取上架 >3 年的 ASIN，提取以下三个数据源：

```bash
node skills/oalur-market-capacity/extract-seasonality.js "关键词" output/日期-关键词/data/数据文件.json output/日期-关键词/data/关键词-seasonality.json
```

脚本自动完成：
1. **Google Trends 5年搜索趋势**：从 Google Trends 网页提取公开数据（不需要登录，不截图）
   - 如果原始长尾词 Google Trends 数据过于稀疏（例如 5 年周数据非零点 `<24` 或非零率 `<15%`），不能直接用该数据判断季节性。
   - 此时允许本地 agent/本地规则从关键词中提取核心词后重试，例如 `fruit basket for kitchen counter` → `fruit basket`。
   - 报告必须展示原始关键词、实际 Google Trends 查询词和降级原因；核心词只用于 Google Trends 季节性验证，不改变 Oalur 搜索词、类目过滤、产品过滤或评分的其他数据源。
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

### Step 4.5: 关键词 AI 同义词分析（不参与过滤）

输入关键词后，`extract-data.js` 会先生成 `keyword-intent-analysis.json`：
- 如果环境变量 `OPENAI_API_KEY` 可用，尝试使用 OpenAI 兼容接口生成候选词分析。
- 如果 `OPENAI_API_KEY` 不可用或请求失败，使用本地内置 token 同义词输出兜底分析。
- 该文件只用于人工复核和后续完善规则，不参与 `targetCategories` 选择，不参与标题意图救回，不改变过滤结果。
- 如需跳过该步骤，可加 `--skip-keyword-intent-analysis`。

### Step 5: 提取新品存活率历史基准数据

**缓存优先**：如果 `output/日期-关键词/data/关键词-historical.json` 已存在且时间范围正确，直接使用缓存，无需重新抓取。

**时间范围自动计算**：先基于当前月份倒推 6 个月，再避开异常月份：
- 如果机械候选月是 `12月`，不要用圣诞季，改用次年 `1-3月` 正常窗口，默认先抓 `1月`。
- 如果机械候选月是 `6月` 或 `7月`，不要用 Prime Day / 会员日扰动月，改用 `8-9月` 正常窗口，默认先抓 `8月`。
- 其他月份使用机械倒推 6 个月。
- 如果后续补采多个窗口月，优先选新品样本数更多、总样本更完整、且离 6 个月目标更近的月份。

```bash
# 推荐：自动选择新品存活率历史基准月
node skills/oalur-market-capacity/extract-data.js "关键词" BSR上限 output/日期-关键词/data/关键词-historical.json --survival-baseline auto

# 示例：当前 2026 年 6 月，机械 6 个月前是 2025-12，但 12 月为圣诞异常月，应改用 2026-01 到 2026-03 正常窗口，默认先抓 2026-01
# 示例：当前 2026 年 1 月，机械 6 个月前是 2025-07，但 6-7 月为 Prime Day/会员日扰动，应改用 2025-08 到 2025-09 正常窗口，默认先抓 2025-08
```

脚本自动完成：选择合理历史基准月 → 点击 `.time-scope .time-select li` 切换时间 → 搜索关键词 → 提取历史 BSR 数据。

历史数据只用于新品存活率，不需要抓完整历史市场盘。使用 `--survival-baseline auto` 或 `--historical-new-only` 时，脚本必须：
- 在历史月份查询结果加载后，点击第 9 列“上架时间”的下箭头，按上架时间从新到旧排序。
- 只保留历史快照时上架 `<6个月` 的产品，作为新品候选集。
- 翻页时如果当前页已经没有 `<6个月` 产品，停止继续翻页。
- 输出 JSON 标记 `historicalNewOnly: true`，避免误认为是完整历史市场数据。

⚠️ 如果缓存文件的时间范围不在推荐正常窗口内，`generate-report.js` 会打印警告并在报告中写明“机械 6 个月候选月”和“推荐基准窗口”，但仍使用当前传入数据生成报告。

⚠️ **新品存活率边界情况**：如果推荐历史基准窗口内该 BSR 范围没有上架 <6 个月的纯新父体 Listing（即 `histNewProducts.length === 0`），说明当时没有纯新父体存在，不存在存活率可计算。此时报告会显示「该 BSR 范围内无历史纯新父体」，而不是 0% 存活率。

### Step 6: 提取 CPC/客单价比值（广告成本快判）

当需要判断 CPC 广告点击单价时，禁止只看 CPC 绝对值；必须按照 `knowledge/amazon-opportunity-index-criteria.md` 使用 `CPC / 客单价 * 100%`。默认样本从过滤后的父体 Listing 中按月销量排序取前 30 个，排除价格异常和 Ratings 缺失样本；报告主指标使用中位数 CPC/客单价，不使用平均值作为主要判断。

数据来源：Oalur ACOS 工具 `https://vip.oalur.com/tool/acos?site=US`。

```bash
node skills/oalur-market-capacity/extract-cpc-opportunity.js output/日期-关键词/data/关键词-asin-lifecycle.json output/日期-关键词/data/数据文件.json output/日期-关键词/data/关键词-cpc-opportunity.json
```

判定标准：
- `<5%`：健康
- `5%-8%`：可接受
- `8%-12%`：偏高，需要强利润/强转化支撑
- `12%-15%`：高风险
- `>=15%`：很高风险

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
| **Oalur 站内季节性** | Oalur searchesTrend | 月均峰谷比 + 峰值/中位月 + Top2月占比 + 年度峰值重复 + 最近12月峰值 | 全部满足才算 Oalur 强信号 |
| **季节性得分** | Google + Oalur + 老品ASIN 综合 | 三源证据等级 | 两类强信号 = 确认强季节性；一类强信号 = 疑似强季节性 |
| **峰值月份** | Google + Oalur | 多峰值月份取交集 | 用于制定备货和广告计划 |
| **ASIN 趋势验证** | 3 个老品 ASIN 月销量 | 观察每年同月的销量峰谷 | 确认季节性在真实销售数据中的体现 |

Google Trends 口径补充：
- Google Trends 原始数据是周级搜索兴趣，季节性判断必须先按月份聚合为多年月均值，再计算月均峰谷比；禁止直接用单周最高/最低点判断强季节性。
- 原始长尾词数据过稀疏时，可以由本地 agent/本地规则提取核心词重试，但必须在报告中说明，不得静默替换。
- 如果只有 Oalur 站内搜索量支持强季节性，而 Google Trends 或老品 ASIN 趋势没有第二类证据确认，只能标记为“疑似强季节性”。

Oalur 站内强季节性信号必须同时满足：
- 多年月均峰谷比 `>=2.5`。
- 峰值月 / 中位月 `>=1.5`。
- Top2 月搜索量占全年月均总量 `>=24%`。
- 最近 3 个完整或近完整年份中，至少 2 年峰值出现在聚合峰值月或相邻月份。
- 最近 12 个月峰值仍出现在聚合峰值月或相邻月份，且相对最近 12 个月中位数 `>=1.25x`。

最终季节性分类：
- `确认强季节性`：Google、Oalur、老品 ASIN 三类证据中至少两类为强信号。
- `疑似强季节性`：只有一类强信号。
- `弱季节性`：没有强信号，但至少两类有弱信号。
- `疑似弱季节性`：只有一类弱信号。
- `非季节性`：三类都没有明显季节性信号。

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

### 最终评判标准：是否进入产品深化阶段

主报告首页必须输出“最终评判标准”卡片，作为最后判断口径。该结论只判断是否值得继续做供应链、专利、样品、包装和差异化验证，不等于直接开发。

产品深化门槛：
- `>=120分`：进入产品深化。
- `105-119分`：补采/复核关键缺口后再判断。
- `<105分`：不进入产品深化。

评分模块总分 150：
- 市场容量 15 分：有效父体 Listing 数 5 分 + BSR 连续性 10 分。有效父体 Listing 数按过滤后父体数量评分：`>150` 得 5 分，`>120` 得 4 分，`>90` 得 3 分，`>60` 得 2 分，`>30` 得 1 分，`<=30` 得 0 分。BSR 连续性 10 分拆成头部覆盖 4 分 + 内部连续 6 分：头部覆盖按第一个目标父体 BSR / 最大 BSR 阈值评分，`<=5%` 得 4 分，`5%-15%` 得 2 分，`>15%` 得 0 分；内部连续按最大相邻 BSR 断层 / 最大 BSR 阈值评分，`<=10%` 得 6 分，`10%-20%` 得 4 分，`20%-35%` 得 2 分，`35%-50%` 得 1 分，`>50%` 得 0 分。容量只证明当前 BSR 范围内目标相关父体数量和排名连续性，不直接证明能做。
- 行业调整后机会指数 15 分：行业调整后机会指数 8 分 + 在售商品数趋势 7 分，不把有效机会指数计入最终评分。行业调整后机会指数 = `基础机会指数 × 行业调整系数`，评分为：`>=2` 得 8 分，`1-2` 得 6 分，`0.5-1` 得 4 分，`0.2-0.5` 得 2 分，`<0.2` 得 0 分。供需比容易受搜索词和在售数口径影响，只作为前置筛选项。
- 在售商品数趋势 7 分：不能只用全周期前半段和后半段平均值判断。必须递进拆分：先把全周期一分为二，计算长期趋势；再把后半段一分为二，计算近期趋势；最后把近期段再一分为二，计算当前趋势。变化率公式统一为 `(后段均值 / 前段均值 - 1) × 100%`。趋势状态：`D=下降<=-10%`、`S=稳定-10%到10%`、`U=温和增加10%-25%`、`X=快速增加>25%`。评分使用趋势组合规则表，不做权重加权；`U` 和 `X` 都先视为市场活跃/增长信号，`S-S-S` 代表成熟稳定但不满分，`近期=D 且 当前=D` 代表市场萎靡得 0 分。长期趋势为 `D` 时优先按低分处理：近期和当前都增长也最多 4 分，代表长期收缩后的修复，不等同于健康扩张。典型分档：长期非 `D` 且近期和当前均为 `U/X` 得 7 分；当前为 `U/X` 且近期为 `S` 得 6 分；`S-S-S` 得 5 分；长期 `D`、近期和当前均增长得 4 分；长期 `D` 且仅当前反弹得 2-3 分；近期和当前均为 `D` 得 0 分。
- 品牌/单品集中度 25 分：品牌 CR3 8 分 + TOP1/TOP3 单品销量集中度 7 分 + TOP3 点击/转化份额 7 分 + 品牌分散度/卖家结构 3 分。品牌 CR3 评分：`<30%` 得 8 分，`30%-40%` 得 7 分，`40%-50%` 得 5 分，`50%-60%` 得 3 分，`>=60%` 得 0 分。单品集中度评分：TOP1 `<15%` 且 TOP3 `<30%` 得 7 分，TOP1 `<20%` 且 TOP3 `<35%` 得 6 分，TOP1 `<30%` 且 TOP3 `<45%` 得 5 分，TOP1 `<35%` 且 TOP3 `<55%` 得 3 分，否则 0 分。TOP3 点击/转化份额评分：点击 `>50%` 且转化 `>50%` 得 0 分；点击不高但转化 `>50%` 得 2 分；点击 `>50%` 但转化不高得 4 分；点击 `<20%` 且转化 `<20%` 得 7 分；其他中等集中度得 5 分；数据缺失按 4 分中性偏保守。品牌分散度/卖家结构评分：品牌分散度 `>60%` 得 2 分，`40%-60%` 得 1 分，否则 0 分；亚马逊自营占比 `<10%` 额外得 1 分。竞争结构决定新品是否有足够切入口，权重高于容量和机会指数。
- 评论壁垒 15 分：Oalur 当前抓取字段是 `Ratings` 数，不是 Amazon 真实评论数；报告统一按 `预估评论数 = Ratings × 7%` 折算。前20平均预估评论 `<600`，预估中位数 `<350`，前20预估评论数 `<100` 的产品至少 3 个，且近6个月有新品进入前20。这里的“低评论数”不是低评分，含义是前排是否存在低社会证明产品；评论壁垒衡量进入难度，但不应压过新品活力。
- 预估评论数分布图必须使用适合 `Ratings × 7%` 折算后的区间：`<50`、`50-100`、`100-300`、`300-600`、`600+`。图表标题和说明必须明确这是预估评论数分布，不是原始 Ratings 分布。
- 新品活力 30 分：6个月纯新父体存活评分按 15 分折算、当前 `<6个月` 纯新父体销量承接 8 分、`<12个月` 纯新父体销量承接 7 分共同评分。6个月纯新父体存活率不能作为一票否决。父体下新增子 ASIN 只作为辅助证据，不能代表全新 Listing 的冷启动能力。
- 6个月纯新父体存活基础评分 10 分拆分为：样本量可信度 2 分（历史纯新父体 `>=10` 得 2 分，`5-9` 得 1 分，`<5` 得 0 分）；有效 BSR 存活率 5 分（`>=30%` 得 5 分，`20%-30%` 得 4 分，`15%-20%` 得 3 分，`8%-15%` 得 2 分，`0%-8%` 得 1 分，`0%` 得 0 分）；存活父体销量质量 3 分（存活父体当前销量中位数 `>=` 当前市场销量中位数得 3 分，达到 `50%-100%` 得 2 分，有存活但低于 `50%` 得 1 分，无存活得 0 分）。首页最终评分中该 10 分会折算为 15 分。
- `<6个月` 纯新父体销量承接 8 分：样本可信度 1 分（有纯新父体即 1 分，数量多不额外加分）；销量质量 5 分（纯新父体销量中位数 / 全市场销量中位数：`>=1` 得满分，`0.6-1` 得 3 分，`0.3-0.6` 得 1 分，`<0.3` 得 0 分）；销量分散/可复制性 2 分（纯新父体销量中位数 / 纯新父体最高销量：`>=0.5` 得满分，`0.2-0.5` 得 1 分，`<0.2` 得 0 分；样本只有 1 个时该项不得分）。该项不按新品数量多直接加分，避免红海铺货被误判为新品友好。
- `<12个月` 纯新父体销量承接 7 分：采用三因子保守口径，覆盖度 2 分 + 销量承接 3 分 + 销量质量 2 分。覆盖度按纯新父体占比评分：`>=15%` 得 2 分，`8%-15%` 得 1 分，`<8%` 但有样本得 0.5 分，无样本得 0 分。销量承接按纯新父体销量占比评分：`>=20%` 得 3 分，`10%-20%` 得 2 分，`5%-10%` 得 1 分，`<5%` 得 0 分。销量质量按纯新父体销量中位数 / 全市场销量中位数评分：`>=1` 得 2 分，`0.6-1` 得 1 分，`<0.6` 得 0 分。`<12个月` 窗口更宽，需要加入销量质量，但不能照搬 `<6个月` 的分散/可复制性口径，避免把已经跑了 8-11 个月的成熟新品过度奖励。
- 毛利空间 20 分：销量加权毛利率 8 分 + 低毛利销量占比 5 分 + FBA/售价压力 3 分 + 价格带利润结构 4 分。销量加权毛利率评分：`>=45%` 得 8 分，`40%-45%` 得 6 分，`35%-40%` 得 4 分，`<35%` 得 0 分。低毛利销量占比指毛利率 `<35%` 产品销量 / 有毛利率样本总销量：`<10%` 得 5 分，`10%-25%` 得 3 分，`25%-40%` 得 1 分，`>=40%` 得 0 分。FBA/售价压力使用销量加权 FBA/售价：`<20%` 得 3 分，`20%-28%` 得 2 分，`28%-35%` 得 1 分，`>=35%` 得 0 分。价格带利润结构使用销量加权单件毛利额评分：`>=4美元` 得 4 分，`3-4美元` 得 3 分，`2-3美元` 得 1 分，`<2美元` 得 0 分；如果 `<$8` 低价带销量过半且该价格带单件毛利偏低，则该项封顶到 1-2 分。CPC/客单价只在广告成本模块计分，毛利空间中只作为利润侵蚀提醒，避免重复惩罚。有效成本率因当前数据不足，不参与评分，列为产品深化阶段补采项。
- 广告成本 15 分：使用过滤后父体 Listing 销量前 30 样本的中位 CPC/客单价评分；`<5%` 得 15 分，`5%-8%` 得 12 分，`8%-12%` 得 8 分，`12%-15%` 得 3 分，`>=15%` 得 0 分。当前没有引入转化率模型，因此该指标按更保守阈值处理。广告成本会直接影响冷启动和利润侵蚀，必须独立计分。
- 季节性/生命周期风险 15 分：季节性风险 6 分 + 搜索需求生命周期 9 分；老品 ASIN 生命周期只作为验证信号，不进入最终评分。强节日性或强季节性必须由 Google Trends、Oalur 站内搜索量、老品 ASIN 销售/BSR 趋势中至少两类证据确认；证据不足只标记为疑似，不作为强扣分或一票否决。Google 峰值月必须是稳定峰值月：最高月相对中位月、次高月、最低月都有明显优势，否则显示“无稳定峰值月”。生命周期不能主要依赖抽样 ASIN，搜索需求趋势权重要高。

生命周期评分标准：
- 季节性风险满分 6 分：非强季节性 6 分；弱季节性 4 分；疑似强季节性但证据不足 3 分；强季节性 0-2 分。
- 搜索需求生命周期满分 9 分：先按全周期一分为二判断长期趋势，再把后半段一分为二判断近期趋势，最后把近期段继续一分为二判断当前趋势。长期非 D + 近期增长 + 当前增长按高分折算；长期非 D + 当前稳定/增长按中高分折算；长期 D + 近期/当前修复按中低分折算；近期 D + 当前 D 得低分；长期/近期/当前全 D 得 0 分；数据不足按中性分处理。
- 老品 ASIN 生命周期只展示不计分：每个老品 ASIN 先按 5 分制判断风险，再按严重风险 ASIN 占比生成验证结论；该验证结论用于复核季节性/生命周期风险，但不进入最终 150 分评分。
- 每个老品 ASIN 内部仍按 5 分制判断：
- 未命中风险：5 分。
- 命中 1 项风险：3 分。
- 命中 2 项风险：1 分。
- 命中 3 项风险：0 分。
- 风险项 1：价格后半段比前半段下降 `>=7%`。
- 风险项 2：大类 BSR 后半段比前半段恶化 `>=15%`；大类 BSR 缺失时不统计该项。
- 风险项 3：Ratings 月增速后半段比前半段放缓 `>=50%`。
- 首页最终评分不再把老品 ASIN 和搜索需求混成一个 30%/70% 加权分，而是分别展示季节性、搜索需求、老品 ASIN 三个子分。
- `季节性与市场趋势分析` 模块必须展示同一套 Oalur 搜索量递进趋势结论，不能只放在生命周期摘要里。
- 独立 `ASIN生命周期趋势分析.html` 必须展示每个 ASIN 的生命周期得分、命中风险和整体生命周期结论。

一票否决项仅限当前数据可以证明的硬风险：
- 行业调整后基础机会指数 `<0.2`。
- 品牌 CR3 `>60%`。
- CPC/客单价 `>=15%`。
- 销量加权毛利率 `<35%`。

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
- 所有同父体 ASIN 的标题、类目、销量、销售额、BSR、小类排名、价格、上架时间、Ratings 数、品牌
- “匹配依据”列显示 `目标类目` / `标题意图救回` / `未命中`

## 目标类目与标题意图过滤

不要再用“数量最多的类目”作为唯一目标类目。当前类目过滤由 `category-selector.js` 计算关键词相关性分，并允许“功能等价候选类目 + 单 ASIN 标题意图”二次保留。

目标类目可以是一个，也可以是多个。只要类目进入 `targetCategories`，它就是目标类目；父体或任一子 ASIN 命中目标类目时，直接进入目标匹配池，不再做标题意图二次过滤。

标题意图只用于非目标类目的候选救回：
- 未进入 `targetCategories` 的功能等价候选类目，必须通过标题意图 + 价格守卫才能进入分析池。
- 已进入 `targetCategories` 的目标类目不能再因为标题缺少某个修饰词被排除。

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
- `6个月纯新父体存活率` 和 `当前纯新父体销量承接（<6个月）` 是两个不同指标：前者看历史纯新父体是否仍留在当前目标类目/有效 BSR 区间，后者看当前市场里纯新父体是否能拿到销量。历史窗口没有严格纯新父体样本时，不能显示“未分析”，也不能按新品失败给 0 分；应明确写“样本0，无法计算存活率”，并按中性 `4/10` 计入新品活力。
- `<6个月`当前纯新父体销量承接和 `<12个月`近1年产品销量分析的主结论必须基于 **纯新父体** 的数量、销量和市场占比；父体新品子 ASIN / 父体 `<12月` 子 ASIN 仅作为辅助观察。

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

📈 BSR 区间分布（等宽区间，禁止 5000-10000 不等宽区间）：
- BSR 上限 <=20000：使用 1000 间隔
- BSR 上限 >20000 且 <=30000：使用 2000 间隔
- BSR 上限 >30000：使用 4000 间隔
- 示例：0-2000、2000-4000、4000-6000 ...

📅 上架时间分布：
- 0-6个月：[X] 个（[X]%）
- 6-12个月：[X] 个（[X]%）
- ...

✅ 市场容量结论：[建议进入 / ⚠️ 慎入 / ❌ 不进入]
原因：[简述]

⚔️ 竞争分析：
- 单品占比：TOP1 [X]%，TOP3 [X]%，TOP5 [X]%，TOP10 [X]%
- 品牌集中度：TOP1 [品牌名] [X]%，TOP3 [X]%，分散度 [X]%
- 评论壁垒：前20平均预估评论 [X]（<600），预估中位数 [X]（<350），前20中预估评论<100条: [X]个（≥3）；预估评论数 = Ratings × 7%
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
9. **去重与聚合**：先按 ASIN 去重（相同 ASIN 去重，不按相同父体 PASIN 去重），再按父体聚合；代表 ASIN 取父体下大类 BSR 最好的子 ASIN；销量/销售额优先取代表父体行数值，只有代表行缺失或为 0 时才按同一行 `子体销量 / 子体销售额` 与子 ASIN 行求和兜底，Ratings 按共享/独立评分规则计算。
10. **类目过滤**：使用关键词相关性评分选择一个或多个目标类目。进入 `targetCategories` 的目标类目直接通过筛选；功能等价候选类目只能通过单 ASIN 标题意图 + 价格守卫救回，不能整类直接纳入。标题意图救回会在主报告和子 ASIN 明细中标记为 `标题意图救回`；已经命中目标类目的产品标记为 `目标类目`。
11. **销量缺失/低销量处理**：目标匹配产品不再因为月销量 `<200` 或销量缺失移入 `excluded`；这类产品仍进入 `data`，报告中按销量缺失/低销量风险展示。`excluded` 只用于非目标类目、未通过候选救回或价格守卫的产品。
12. **分页上限**：默认最多抓 20 页（约 400 行）。如果 Oalur 结果超过 20 页，脚本必须停止并向用户报告预计页数/行数；用户确认后才允许用 `--allow-over-400` 或 `OALUR_ALLOW_OVER_400=1` 继续抓取。
13. **并行规则**：可以并行的独立任务要并行，例如 ASIN 趋势每个 ASIN 独立 tab、CPC 样本按小并发池独立 tab 抓取；每个临时 tab/page 必须在 `finally` 中关闭。不能并行同一个 Oalur 筛选表格的翻页抓取，因为分页、筛选条件和“查看其他变体”共享页面状态。
14. **AI 同义词**：默认只使用内置同义词表。`keyword-intent-analysis.json` 仅作人工审计，不参与过滤；AI/人工分析结果必须经用户确认并写入内置表后才生效。
15. **排除产品存档**：过滤掉的产品也输出到结果文件（`excluded` 字段），方便复查

## 竞争分析报告包含的图表

1. **竞争核心指标卡片**：TOP1 单品占比、TOP3 品牌份额、品牌分散度、平均星级
2. **品牌集中度柱状图**（按销量占比，TOP10 品牌横向柱状图）
3. **星级评分分布柱状图**（5 个区间）
4. **卖家性质饼图**（按销量占比，亚马逊自营/FBA/FBM）
5. **单品市场占比进度条**（TOP1/TOP3/TOP10）
6. **进入限制分析列表**（自动检测 + 人工补充）
7. **竞争综合结论**（基于六大维度的自动判断）

## 注意事项

1. **不要用 OpenClaw browser tool**：edge profile CDP 连接不稳定，snapshot/evaluate 会超时
2. **必须用 puppeteer-core 直连**：脚本在本 skill 工程目录下执行，依赖从本地 `node_modules/` 解析
3. **"查看其他变体"必须开启**：抓取 ASIN/变体明细后按父体 Listing 聚合，竞争数量按父体统计
4. **必须按类目和标题意图过滤**：Oalur 搜索结果包含大量无关品类，不过滤会导致分析失真。目标类目用评分选择；功能等价候选类目内只保留标题命中搜索意图的 ASIN
5. **分页必须等内容变化**：点击页码后轮询检查整页 ASIN 集合是否变化（不能只比较首行，否则会误判）
6. **超过 20 页必须请示**：当前抓取默认最多 20 页。超过 20 页时停止执行并报告，确认后再带 `--allow-over-400` 继续。
7. **并发抓取必须关闭窗口**：ASIN 趋势和 CPC 可以多开 tab 并行，ASIN 趋势默认并发为 5，可用 `OALUR_ASIN_TREND_CONCURRENCY` 调整但最多 5；默认 CPC 并发为 4，可用 `OALUR_CPC_CONCURRENCY` 调整；抓完必须关闭 tab，不能残留窗口。
8. **去重**：最终数据按 ASIN 去重
9. **默认近30天**：时间范围通常已默认选中"近30天"，无需额外操作
10. **存档规则**：抓取数据、报告和 Excel 分别保存到 `output/日期-关键词/data`、`output/日期-关键词/reports`、`output/日期-关键词/excel`

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

# Step 4: 提取新品存活率历史基准数据（自动避开 12 月、6-7 月异常窗口）
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-historical.json --survival-baseline auto

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
