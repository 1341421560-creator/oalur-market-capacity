# 市场容量 + 季节性与生命周期分析 Skill（Oalur）

## 用途
1. **市场容量分析**：基于亚马逊大类排名（BSR）判断产品市场容量
2. **季节性分析**：基于 Google Trends + Oalur 站内数据，判断产品季节性和市场趋势
3. **ASIN 价格排名趋势分析**：基于 Oalur 导出的 Excel，调用 `oalur-asin-trend` skill 生成合并趋势图

输入关键词，自动完成全部数据提取和分析，生成 **2 个 HTML 报告**：
- **报告 1**：市场容量 + 竞争分析 + 季节性 + 新品存活率（`output/日期-关键词/reports/日期_关键词_市场容量分析.html`）
- **报告 2**：所有老品 ASIN 的 Buybox价格/Ratings数/大类BSR 趋势（`output/日期-关键词/reports/日期_关键词_ASIN趋势分析.html`）

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

# 合并去重（ASIN去重 + PASIN去重保留BSR最小的 + 类目过滤）
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


脚本自动完成：关键词输入、BSR 设置、勾选变体、翻页提取、去重、类目过滤。

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

### Step 6: 生成完整报告（市场容量 + 季节性 + 存活率）

```bash
node skills/oalur-market-capacity/generate-report.js output/日期-关键词/data/数据文件.json --seasonality output/日期-关键词/data/关键词-seasonality.json --historical output/日期-关键词/data/关键词-historical.json --asin-lifecycle output/日期-关键词/data/关键词-asin-lifecycle.json
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

### Step 7: 保存报告
自动保存到：
```
output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_市场容量分析.html       ← 报告1：完整分析
output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_ASIN趋势分析.html        ← 报告2：ASIN价格排名趋势
```

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

📎 完整报告：output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_市场容量分析.html
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

📎 完整报告（含季节性）：output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_市场容量分析.html
```

## 关键技术点

1. **puppeteer-core 连接**：`puppeteer.connect({ browserURL: 'http://localhost:9222' })` 直连 Edge CDP
2. **关键词输入**：必须用 `input[placeholder*="支持ASIN"]` 选择器，不要用 `.keyword-wrap input`（会选到下拉框）
3. **Vue 响应式**：用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` 触发 Vue 绑定
4. **BSR 输入**：在 `大类BSR排名` label 的父元素中找 `input[type="number"]`
5. **el-table 提取**：用 `.el-table__body-wrapper table tbody tr` 选择器
6. **类目路径提取**：从 titleCell 的各行中找包含 `>` 且以英文字母开头的行（排除 PASIN 行）
7. **上架时间解析**：优先用 `listingAge`（"X年X月X天"），为空时用 `listingDate`（"YYYY-MM-DD"）计算月数差
7. **查看其他变体**：默认关闭（取消勾选 `.var-sku .el-checkbox`），通过 PASIN 去重处理变体重复，避免销量重复计算
8. **分页翻页**：点击 `.el-pager .number` 后必须等待内容变化（比较整页 ASIN 集合，不能只比较首行），不能固定等待
9. **去重**：最终数据必须按 ASIN 去重
10. **类目过滤**：自动取产品数最多的类目作为目标类目（如搜 Biscuit Cutter → 目标类目自动选 `Cookie Cutters`），过滤掉其他类目的产品
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
3. **"查看其他变体"默认关闭**：通过 PASIN 去重处理变体重复，避免销量重复计算
4. **必须按类目过滤**：Oalur 搜索结果包含大量无关品类，不过滤会导致分析失真。自动取产品数最多的类目作为目标类目，排除的产品也存入结果文件
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
6. 关闭"查看其他变体"勾选
7. 开始提取数据（翻页）

## 完整流程示例

```bash
# Step 1: 确认 Edge CDP 可用
Test-NetConnection -ComputerName localhost -Port 9222 -InformationLevel Quiet

# Step 2: 提取当前 BSR 市场数据
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-data.json

# Step 3: 提取季节性数据（会自动生成 ASIN趋势分析.html）
node skills/oalur-market-capacity/extract-seasonality.js "Biscuit Cutter" output/日期-Biscuit-Cutter/data/biscuit-data.json output/日期-Biscuit-Cutter/data/biscuit-seasonality.json

# Step 4: 提取 6 个月前历史数据（用于新品存活率，如当前是 2026-06 → 2025-12）
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-historical.json --time-filter 2025-12

# Step 5: 生成完整报告
node skills/oalur-market-capacity/generate-report.js output/日期-Biscuit-Cutter/data/biscuit-data.json --seasonality output/日期-Biscuit-Cutter/data/biscuit-seasonality.json --historical output/日期-Biscuit-Cutter/data/biscuit-historical.json --asin-lifecycle output/日期-Biscuit-Cutter/data/biscuit-asin-lifecycle.json
```

报告自动保存到：
- `output/YYYY-MM-DD-Biscuit-Cutter/reports/YYYY-MM-DD_Biscuit-Cutter_市场容量分析.html`（报告1：完整分析）
- `output/YYYY-MM-DD-ASIN列表/reports/YYYY-MM-DD_ASIN列表_ASIN趋势分析.html`（报告2：ASIN价格排名趋势，Step 3 自动生成）
