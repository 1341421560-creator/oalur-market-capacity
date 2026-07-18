---
name: oalur-market-capacity
description: Analyze Amazon US market capacity, category relevance, parent-listing semantics, seasonality, historical new-product survival, ASIN lifecycle, CPC opportunity, and competition with Oalur data. Use when Codex must run or resume the local Oalur market-analysis workflow, process keyword JSON batches, handle local Codex review gates, or generate final market and child-ASIN reports.
---

# 市场初步分析 Skill（Oalur）

## 用途
1. **市场容量分析**：基于亚马逊大类排名（BSR）判断产品市场容量
2. **季节性分析**：基于 Google Trends + Oalur 站内数据，判断产品季节性和市场趋势
3. **ASIN 价格排名趋势分析**：基于 Oalur 导出的 Excel，调用 `oalur-asin-trend` skill 生成合并趋势图

输入关键词，自动完成全部数据提取和分析，生成 **3 个 HTML 报告**：
- **报告 1**：市场容量 + 利润快筛 + 竞争分析 + 新品存活率 + 季节性趋势（`output/日期-关键词/reports/日期_关键词_市场分析.html`）
- **报告 2**：老品 ASIN 的 Buybox价格/Ratings数/大类BSR 趋势（`output/日期-关键词/reports/日期_关键词_ASIN生命周期趋势分析.html`）
- **报告 3**：父体代表 ASIN 与子 ASIN 明细（`output/日期-关键词/reports/日期_关键词_子ASIN明细.html`）

## 数据源
- **平台**：Oalur（鸥鹭）- https://vip.oalur.com/insight/filter/index?site=US
- **需要登录**：使用 Edge 浏览器（CDP 端口 9222）连接用户登录态
- **连接方式**：puppeteer-core 直连 `http://localhost:9222`

## 前置依赖
- `puppeteer-core` 和 `xlsx` 已安装在本 skill 工程的 `node_modules/`
- Edge 浏览器已通过 `--remote-debugging-port=9222` 启动
- ASIN 趋势 Excel 默认保存到 `output/日期-任务名/excel/`；如需指定浏览器下载目录，可设置环境变量 `OALUR_DOWNLOAD_DIR`

## 输入
- **产品关键词**：亚马逊搜索词、长尾词，如 "Biscuit Cutter"、"Silicone Spatula" 等
- **多关键词**：英文逗号分隔，如 "Cookie Cutter,Biscuit Cutter"，用于合并同品类不同关键词的数据
- **参考类目（可选）**：作为类目级 Codex 的强优先级输入。抓取到的 Amazon 完整类目路径与输入参考类目精确一致，且 `keyword` 核心产品词与该类目叶子精确匹配时，该类目必须直接判为 `target`；其他非精确匹配的参考类目才作为普通判断上下文或非目标类目的产品级语义复核触发信号。CLI 使用 `--reference-categories "类目1||类目2"`；文件使用 `--reference-categories-file output/任务/reference-categories.txt`，每行一个类目。
- **批量 JSON（可选）**：每个产品建议包含 `{ asin, category, categories, keyword, matchType, hasExactMatch, score, title, bulletPoints, description }`。`keyword` 是市场分析关键词；`title`、`category`、`categories`、`bulletPoints`、`description`、参考类目和抓取类目共同构成 Codex 本地语义判断上下文。`asin` 只作为追踪标识，不是类目级判断的必要条件。

### 类目与 listing 判断的核心优先级

`keyword` 与 `[category, ...categories]` 是并列的**强参照**：前者界定要分析的核心产品和购买任务，后者界定该核心产品已知的 Amazon 类目语境。二者必须共同进入每一次逐路径类目判断和逐父体 listing 判断，不能将其中任一项降为次级信号。

`title`、`bulletPoints`、`description`、抓取类目完整路径、路径样例与规则分数用于核验、补充和排除明显跑偏项，他们也作为参照；它们不得将品牌、型号、兼容系统、颜色、材质、尺寸、套装数量或其他非 keyword 明示的属性升级为核心产品约束，也不得压过 `keyword` 或 `[category, ...categories]`。

判定 `target` 或语义救回 `include` 时，必须同时满足以下三项：

1. **同一类消费者**：目标买家和购买意图一致。
2. **同一使用场景**：使用环境、任务和结果一致。
3. **同一替代关系**：消费者可在同一次购买决策中横向比较或二选一，而非配件、耗材补充、工具、收纳/承载物、设备或辅助产品。

**双精确命中硬规则**：当抓取到的 Amazon 完整类目路径与输入参考类目精确一致，且 `keyword` 核心产品词与该完整路径的叶子类目精确匹配时，该类目必须判为 `target`。精确匹配忽略大小写、首尾空格、标点和不改变产品含义的单复数差异。类目样本中混入的商业/工业产品、其他系统产品、异常标题、规则分数或类目占比都不得把该结论降级为 `review` 或 `exclude`。

只有不满足双精确命中硬规则的类目，才按上述“同一类消费者、同一使用场景、同一替代关系”进行普通语义判断，并可写入 `target`、`exclude` 或 `review`。

## 唯一主流程（按此顺序执行）

除非用户明确只要求某一个局部动作，否则按以下顺序完成单关键词市场分析。不得把后面的报告、季节性或 CPC 步骤提前当作最终结果。

1. **确认任务边界**：读取 keyword、标题、参考类目、卖点、描述和用户指定 BSR；未指定时 BSR 默认为 `25000`。确认输出目录、当前市场与历史新品范围；预估超过 800 行时停止并请用户授权。
2. **准备浏览器与抓取状态**：确认 Edge CDP 9222、Oalur 登录态、关键词输入、BSR 范围、100 条/页和“查看其他变体”均正确。每个新关键词独立页面状态；多关键词必须独立抓取后离线合并。
3. **抓取原始数据**：先抓取当前市场完整原始数据；如需新品存活率，再抓取历史纯新候选原始快照。当前与历史原始数据都完成抓取后，才进入第 4、5 步进行类目与父体复核。补查 unknown 类目和必要的历史上架时间；按 ASIN 去重、按父体 Listing 聚合，但此时不把规则分数视为最终过滤决策。
4. **Codex 本地逐路径类目判断**：只对第一次当前市场抓取后去重的 Amazon 完整类目路径复核一次。先执行双精确命中硬规则：抓取完整路径与输入参考类目精确一致，且 `keyword` 核心产品词与叶子类目精确匹配时，必须写入 `target`。未双精确命中的路径再结合完整路径/叶子、路径样例和规则证据，按“同一类消费者、同一使用场景、同一替代关系”写入 `target`、`exclude` 或 `review`。品牌、型号、兼容性及混入样本仅作核验，不得推翻双精确命中的 `target`。历史新品必须复用这套已完成的类目结论，不另建历史类目 review。
5. **Codex 本地逐父体语义判断**：分别处理当前 listing 与历史新品 listing 中、非目标类目触发的候选父体。以 `parentAsin` 为唯一索引，逐条判断同一消费者、同一使用场景和直接替代关系；每个父体从一开始只写一条 Codex 本地生成的最终 `products` 决策理由，不得由脚本、模板或覆盖层生成第二条理由。
6. **Codex 完成校验 gate**：当前市场类目 review 一份、当前 listing review 一份、历史 listing review 一份都必须通过覆盖数、唯一父体、具体理由、模板 reason 为 0 的校验。未通过时回到第 4 或第 5 步；此时只能称为待完成数据，不能称最终结果。

> **强制 gate 执行与对话可见性规则**：`Codex target review is incomplete`、`Codex semantic review is incomplete` 或 `CODEX_REVIEW_REQUIRED` 只表示**自动脚本**必须暂停，绝不表示 Codex 可以暂停、等待用户处理，或以“后台处理中”代替判断。Codex 必须立即在当前对话窗口接手第 4/5 步：按批次展示每条类目路径或父体的 `ASIN / 标题 / 类目 / 证据 / target|exclude|review / 具体理由`，同时把实际判断写入 review 文件；通过第 6 步校验后，自动从第 7 步恢复批处理。除非原始数据、浏览器连接或外部站点确实失败且无法安全恢复，否则不得把 gate 作为向用户索取下一步操作、结束本轮、发送 final 回复或无可见进展的理由。
7. **离线重筛**：对已有当前和历史 JSON 分别执行 `refilter-data.js`；历史 JSON 必须引用当前市场已完成的类目 review，只使用自己的历史 listing review。修改判断后禁止重新抓取，除非原始数据不完整。
8. **重算最终池依赖数据**：用当前最终过滤池提取季节性、ASIN 生命周期和 CPC；历史最终过滤池只用于新品存活率。任何在重筛前生成的这些文件均为暂存，需要按最终池刷新。
9. **生成与交付报告**：依次生成主报告、子 ASIN 报告和结果日志；子 ASIN 报告是完整流程必选项。只有第 6 步通过后才可称“最终报告”。用户明确要求预览时可提前生成，但必须标记“阶段性/暂存”。

下文的“执行细节与命令参考”按第 2 步至第 9 步的实际先后连续编排；批量 JSON 位于第 3 步，多个关键词、技术实现、统计口径和图表说明位于主链之后作为补充参考。

## ❗ BSR 值选择流程（严格执行）

```
用户说要分析某产品
         ↓
用户是否明确说了 BSR 值？
  ├─ 是 → 用用户指定的值（如 BSR 12000）
  └─ 否 → 默认使用 25,000
```

## 执行细节与命令参考

本节不再定义执行先后；唯一顺序以“唯一主流程（按此顺序执行）”为准。以下标题显式标明所属主流程步骤，阅读时按主流程跳转，不得按本节旧内容的物理位置推断顺序。

### 主流程第 2 步：确认 Edge 浏览器可用

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

### 主流程第 3 步：抓取当前市场原始数据

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

#### 参考类目输入

参考类目是本地 Codex 的强优先级输入：

1. 参考类目必须进入类目级 Codex 判断。`target-category-codex-review.js` 会把抓取到的所有 Amazon 类目、参考匹配类目，以及没有抓到行的手工参考类目写入 `*-target-category-codex-review.json`。
2. 抓取完整路径与输入参考类目精确一致，且 `keyword` 核心产品词与叶子类目精确匹配时，类目级 Codex 必须写入 `target/include/yes`，该类目直接进入 `targetCategories`。
3. 双精确命中的 `target` 不得因路径样本中混入商业/工业产品、其他系统产品、异常标题、规则分数或类目占比而降级。
4. 只有没有双精确命中的参考匹配类目，才继续接受普通语义判断；若被判为 `exclude` 或 `review`，可作为非目标类目的产品级 Codex 语义复核触发信号。
5. 参考类目本身不参与利润、竞争、新品、季节性或最终评分。
6. 多关键词、历史新品抓取、`merge-data.js` 和 `refilter-data.js` 都必须使用同样参考类目规则，保证换对话窗口也不会走旧逻辑。

#### JSON 批量顺序执行

如果输入文件是 `keywords-agent-same.json` 这类结构，使用批量入口顺序执行：

```bash
node skills/oalur-market-capacity/run-keyword-json-batch.js output/来源/data/keywords-agent-same.json --bsr 25000 --start 2 --limit 1
```

批量脚本读取顶层 `products[]`，每个产品使用：
- `keyword` 作为市场分析关键词。
- `[category, ...categories]` 合并去重后作为参考类目。
- `title` 作为本地 Codex 核验核心产品/功能属性的上下文；不得将标题中的品牌、型号或兼容性在 keyword 未明示时升级为核心约束。
- `bulletPoints` 作为输入产品卖点逐条读取；兼容字段为 `bullets`、`features`。它们与标题一起用于识别核心产品、功能、使用场景和购买任务，不能在类目或 listing 判断时省略。
- `description` 作为输入产品补充描述读取；兼容字段为 `productDescription`。没有描述时保留为空，不能用脚本猜测或补写描述。
- 脚本将上述字段合并为唯一的 `inputProductContext`，在抓取当前市场和历史新品时传入，并写入两个数据 JSON 顶层；后续当前市场类目逐路径判断、当前 listing 逐父体判断、历史 listing 逐父体判断都必须从这一份上下文读取卖点和描述。
- `asin` 只用于跟踪和决策文件索引；类目级 Codex 判断不依赖 ASIN，强参照是关键词`keyword`与 `[category, ...categories]`，标题、卖点、抓取类目、类目全路径和样本标题用于核验。
- `matchType`、`hasExactMatch`、`score` 只作为证据层；Codex 必须依据完整路径、输入参考类目和 `keyword` 亲自确认是否双精确命中。一旦确认双精确命中，必须判为 `target`，不得再由其他证据降级。
- `--start` 使用 1-based 序号，`--start 2 --limit 1` 表示只跑第二个产品。
- 默认 BSR 为 `25000`；如需统一调整，传 `--bsr 数值`。
- 默认开启断点续跑。脚本会在批次目录写入 `batch-progress.json`，记录当前产品序号、当前步骤、已完成/失败状态。
- 如果命令超时或中断，重新执行同一命令会跳过已完成产品，并从未完成产品的缺失步骤继续。
- 如果跨日期继续旧批次，传 `--batch-root output/YYYY-MM-DD-automated-market` 指向原批次目录。
- 如需忽略进度并重跑选中范围，传 `--no-resume`。

批量脚本只负责按关键词串行编排和维护 `batch-progress.json`，不能代替 Codex 本地语义判断。每个关键词必须按以下状态推进：

1. 先抓取当前市场原始数据；如需新品存活率，再抓取历史新品原始数据。两个原始数据池都完成后才开始 Codex 复核。
2. 生成唯一的当前市场类目 review 请求。自动脚本在 `Codex target review is incomplete` / `CODEX_REVIEW_REQUIRED` 状态进入 `awaiting_codex_review`；当前 Codex 任务继续运行，并对当前市场去重类目路径逐条完成判断。
3. 将第 2 步完成的当前市场类目 review 同时应用到当前与历史原始数据；禁止生成或加载 `*-historical-target-category-codex-review.json`。
4. 为当前 listing 和历史 listing 分别生成父体候选 review 请求；自动脚本在 `Codex semantic review is incomplete` / `CODEX_REVIEW_REQUIRED` 状态进入 `awaiting_codex_review`，当前 Codex 任务继续运行，并对两个 listing 池的候选父体逐条完成判断。
5. 通过 Codex 完成校验 gate 后，分别离线重筛当前和历史 JSON，重算最终池依赖数据，再生成最终报告。

**gate 的责任边界**：第 2、4 步中的“停止”仅指 `run-keyword-json-batch.js` 停止调用后续自动脚本。该停止会立即把控制权交给当前对话中的 Codex，而不是交给用户。Codex 必须在同一任务中以可见的分批判断完成 review、更新文件、运行校验，再恢复同一条批处理命令；不得只报告候选数量、只说“继续处理中”、或在未完成判断时结束交付。

**gate 状态机（强制）**：

1. 看到 `CODEX_REVIEW_REQUIRED`、`awaiting_codex_review` 或 incomplete 提示后，将工具调用视为“控制权返回 Codex”，不得视为错误、阻塞或任务终点；即使脚本以退出码 0 返回，也不得称为完成。
2. 立即读取输出中指定的 review 文件及候选原始证据；候选多时分批展示，但不得等待用户回复才继续下一批。
3. 每批在对话中展示判断后，使用直接文件 patch 写入对应人工决定；禁止用规则、正则、模板或批量 helper 代替语义判断。
4. 运行覆盖数、唯一键、具体理由及模板理由为 0 的 gate 校验。校验未通过时在当前任务内修正并重跑，不得发送 final 回复。
5. 校验通过后，使用 `resumeArgs` 或原始参数恢复同一条批处理命令。若又遇到下一层 gate，从第 1 步继续循环。
6. 只有所选产品状态为 `completed`/业务规则明确为 `skipped`、最终文件已经落盘并完成边界核验后，才允许结束当前回复。用户若要求“跑完停下”，含义是产品完整完成后不启动下一个产品，不是停在 gate。

**对话结束验收 gate（强制执行，不得只靠文字判断）**：

1. 批处理启动、恢复、失败或进入复核 gate 时，`batch-progress.json` 必须保持 `codexCanSendFinal: false`；复核 gate 同时输出 `finalResponseBlocked: true`。
2. Codex 准备发送任何 final 回复前，必须运行 `node verify-batch-turn-completion.js "output/批次目录/batch-progress.json"`。上下文压缩、任务自动续接或工具调用返回都不能跳过该命令。
3. 只有命令退出码为 `0` 且输出同时包含 `terminal: true`、`codexCanSendFinal: true`、`codexTurnStatus: "final_response_allowed"` 时，才允许发送 final 回复。
4. 命令退出码非 `0`，或输出为 `must_continue_in_current_conversation` 时，禁止用 final 汇报阶段进度；必须读取 `blockers`，在 commentary 中展示当前复核判断并继续完成同一批次，然后再次验收。
5. `progress.status`、单个脚本退出码 `0`、部分产品完成、已生成部分报告，都不能单独证明当前对话可以结束。
6. 验收器必须同时核对所选输出编号与输入产品身份、所有必需步骤的终态，以及非空的主报告、子 ASIN 报告和结果日志；任一文件缺失、为空或编号复用冲突时继续当前任务，不得结束。

因此，批量恢复只会从尚未完成的抓取、Codex 判断、重筛或报告步骤继续；它不得使用规则、正则或批量 helper 自动填入类目或父体的最终理由。

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

默认补查并发为 5 个 ASIN 页面，最多 5 个；可通过 `OALUR_CATEGORY_SUPPLEMENT_CONCURRENCY` 调整。补查使用固定 worker 页面复用，完成后关闭。

#### 缺失上架时间补查

普通市场分析中，缺失上架时间不在过滤前补查；只有产品已经进入最终 `data` 分析池后，才补齐上架时间。历史新品快照模式例外，因为必须用上架时间判断 6 个月窗口，此时需要在历史过滤前补查。

1. 打开 `https://vip.oalur.com/products/information?asin=ASIN&site=US`。
2. 优先从页面 XHR 的 `basicInfo` / 详情 payload 中提取上架时间；失败时再从页面文本中按“上架时间 / Listing Date / Date First Available”等标签解析。
3. 成功后回填该 ASIN 的 `listingDate`，并标记 `listingDateSupplementedFrom: "products-information"`。
4. 补查摘要写入输出 JSON 的 `listingDateSupplementSummary`。
5. 历史新品快照模式下，补齐上架时间后必须再次执行 6 个月窗口过滤，避免日期缺失的老品误入历史新品样本。

默认补查并发为 5 个 ASIN 页面，最多 5 个；可通过 `OALUR_LISTING_DATE_SUPPLEMENT_CONCURRENCY` 调整。补查使用固定 worker 页面复用，完成后关闭。

#### 固定 BSR 抓取口径

用户输入多少 BSR，就只按该 BSR 范围抓取和分析；脚本不再根据月销量最低数自动建议扩大 BSR，也不做新增区间扩容采集。

- 默认抓取范围为 `1-BSR上限`。
- 如果人工指定 `--bsr-min`，脚本只设置该 BSR 区间并抓取，不把它当作自动扩容流程。
- 目标匹配产品不再因为月销量 `<200` 或销量缺失移入 `excluded`；销量缺失/低销量只作为报告风险提示，不参与类目过滤。
- 报告需要提示样本充足性：如果过滤后目标父体 `<90`，或过滤后最低月销量 `>600`，报告显示“建议增加样本”。这只是人工建议，不自动扩容。

点击确认查询前，必须先把 Oalur 分页从默认 **20 条/页** 改为 **100 条/页**。修改分页控件不等于查询已经提交；切换成功后必须再次点击页面上可见且可用的“确认查询”，等待 loading/表格/分页刷新，并在刷新后再次断言仍为 100 条/页，才允许读取总计和页数。`总计=0` 但表格存在行、页数仍是旧值，或 `总计 / 100` 与最后页不一致时，一律视为查询未确认或页面状态残留，禁止用 `lastPage × 100` 预估，更不能据此触发超 800 行跳过。默认最大采集约 **800 条 ASIN/变体数据**，即 100 条/页下最多约 **8 页**；如果实际页数少于 8 页，则按实际页数抓取。超过 800 条时停止并报告已确认查询返回的实际总计/页数，用户确认后才允许使用 `--allow-over-800` 或 `OALUR_ALLOW_OVER_800=1` 继续。

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
- 执行完共享/独立评分判断后，如果父体 Ratings 仍为 0，才允许进入 `https://vip.oalur.com/products/information?asin=父体ASIN&site=US` 补查该父体 ASIN 的“评分数/评论数”前半段评分数；补查只更新 Ratings，不更新销量和销售额。Ratings 补查默认并发为 5 个 ASIN 页面，最多 5 个，可通过 `OALUR_RATINGS_SUPPLEMENT_CONCURRENCY` 调整。补查使用固定 worker 页面复用，完成后关闭。
- 代表父体 ASIN 的 `sales`、`revenue` 字段必须优先来自代表父体行，只有代表行缺失/为 0 时才使用子 ASIN 求和兜底；`ratings` 字段必须按共享/独立评分规则计算。
- 报告中的竞争数量按父体 Listing 统计，避免变体重复计算。
- “纯新父体”必须使用严格口径：代表 ASIN 上架时间在窗口内，并且父体下全部已抓到且最终判定为目标相关的子 ASIN 上架时间都在窗口内；任一已抓到的最终目标相关子 ASIN 上架时间缺失或超出窗口，都不能算纯新父体。老父体新增目标相关子 ASIN 只能算“父体新品子ASIN”，不能进入纯新父体存活率。

### 主流程第 3 步：提取历史新品原始数据（需要新品存活率时）

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
- 补齐缺失上架时间后，只保留历史快照时上架 `<6个月` 的产品，作为新品候选集。
- 翻页时如果当前页已经没有 `<6个月` 产品，停止继续翻页。
- 当前与历史原始数据都完成抓取后，历史新品候选集复用当前市场类目级 Codex 判断；只对历史候选父体执行独立的产品级 Codex 语义救回。只有过滤后的历史核心产品才能进入 6 个月纯新父体样本。
- 输出 JSON 标记 `historicalNewOnly: true`，避免误认为是完整历史市场数据。

⚠️ 如果缓存文件的时间范围不在推荐正常窗口内，`generate-report.js` 会打印警告并在报告中写明“机械 6 个月候选月”和“推荐基准窗口”，但仍使用当前传入数据生成报告。

⚠️ **新品存活率边界情况**：如果推荐历史基准窗口内该 BSR 范围没有上架 <6 个月的纯新父体 Listing（即 `histNewProducts.length === 0`），说明当时没有可验证的历史核心纯新父体，不存在存活率可计算。此时报告会显示「该 BSR 范围内无历史纯新父体」，而不是 0% 存活率。

### 主流程第 4 步：Codex 本地逐路径类目判断

目标类目不由规则分数最终裁判。`category-selector.js` 的分数、占比、标题命中率、`contextMatch`、`functionalEquivalent` 只作为证据层和候选层；最终目标类目以 Codex 对 Amazon 类目归属的逐路径判断为准。

1. JS 抓取并去重所有 Amazon 类目，保留完整路径、父体数量、占比、规则分数和样本标题。
2. `selectTargetCategories` 生成 provisional 候选和规则证据，但不生成最终结论。
3. `target-category-codex-review.js` 生成 `*-target-category-codex-review.json`。Codex 必须读取输入 keyword、title、参考类目、bulletPoints、description、完整 Amazon 路径/叶子、路径样例和规则证据，逐路径判断“核心产品是否天然归属该类目”。
   - `inputProductContext`、`reviewStandard` 与参考类目上下文只在 review JSON 顶层保留一份；`categories` 只保存去重完整路径、统计证据和样例 listing；`decisions` 只保存逐路径结论。
4. 先检查双精确命中：完整路径与输入参考类目精确一致，且 `keyword` 核心产品词与叶子类目精确匹配时，必须写 `target/include/yes`；样本混入、规则分数和类目占比不能覆盖该硬结论。未双精确命中的路径才执行普通语义判断。
5. 类目结论只接受 `target/include/yes`、`exclude/no`、`review`；只有 `target/include/yes` 写入最终 `targetCategories`。
6. 父体或任一子 ASIN 命中最终 `targetCategories` 时，直接进入最终 listing 池，并清理旧的 `codexSemanticReviewExcluded`、`codexSemanticReviewRescued`、`codexSemanticReviewDecision`、`targetCategoryTitleIntentRejected` 标记。
7. 类目级判断不需要额外 ASIN 信息。ASIN 只用于追踪、去重和后续父体索引；判断核心依赖输入上下文、完整类目路径、路径样例和证据。

#### 类目证据层

关键词会拆成：
- 修饰词：除最后一个词以外的 token，例如 `Coffee Spoons` 的 `coffee`。
- 产品形态词：最后一个 token，例如 `spoon`。
- 形态同义词：例如 `spoon` 可扩展为 `spoon/scoop`。

类目分数主要由完整路径 token、叶子类目、路径下标题匹配率、父体数量/占比、参考类目匹配和上下文冲突组成，但不得直接作为最终裁判。`contextMatch=false` 是“父级泛词命中而叶子实际是另一产品/功能”等风险信号，不能靠高分或高占比直接越过。

### 主流程第 5 步：Codex 本地逐父体语义判断

已命中 `targetCategories` 的父体 Listing 或任一子 ASIN 直接进入最终 listing 池，不参与产品级判断，也不能被产品级排除踢出。非目标类目 listing 默认进入 `excluded`；只有本步骤明确 `target/include/yes` 的父体才能救回。

候选来自 `codex-semantic-review.js`：
- `highShareTitleRescueCandidate`：非目标、非 unknown 类目，父体数量占比 `>5%`。
- 非目标类目 `score >=110`，或 `score >=70` 且 `count >=3`。
- `titleIntentRescueCandidate`、`functionalEquivalent`，或参考匹配类目已被类目级判断为 `exclude/review`。

当前 listing 与历史 listing 必须分别生成 `*-codex-semantic-review.json`。Codex 以 `parentAsin` 为唯一索引，逐父体读取输入 `keyword`、`title`、`category/categories`、`bulletPoints`、`description`，再读取候选 listing 标题、类目、bullets/description、价格、销量、BSR 和候选原因，判断是否同时满足：

- 同一类消费者：目标买家和购买意图一致。
- 同一使用场景：使用环境、任务和结果一致。
- 同一替代关系：消费者可在同一次购买决策中横向比较或二选一，而非配件、耗材补充、工具、收纳/承载物、设备或辅助产品。
- listing 证据明确：标题、类目、卖点/描述或候选上下文能支撑结论；证据不足时写 `exclude/no` 或 `review`，不得凭泛词猜测。

手动/电动/自动、材质、尺寸、容量、颜色、套装内容、带盖/不带盖、底座/提手/配件、一次性/可重复使用及兼容口径，默认是属性或变体差异；只有输入 keyword 明确把它写成核心限定词时，才因不符排除。`floor cleaners` 可包含 liquid、concentrate、spray、mop soap、tablet；`floor cleaning tablets` 应排除普通 liquid cleaner；`trash bags` 不救回 trash cans、holders、dispensers；`carpet deodorizer` 可救回明确用于 carpet deodorizing 的 fabric spray，但 pet urine enzyme cleaner 通常是不同的宠物事故清洁任务。

每个候选父体从一开始只写一条 Codex 本地生成的最终 `products` 决策理由。只有 `target/include/yes` 设置 `codexSemanticReviewRescued: true`、`codexSemanticReviewDecision`、`targetMatchedCategories`；`exclude/no` 只作用于非目标类目 listing。

### 主流程第 6 步：Codex 本地语义分析完成校验

当前市场类目 review、当前 listing review、历史 listing review 都必须通过下列校验，才可称为最终数据：

1. 逐路径/逐父体均已覆盖，且候选数等于唯一最终决策父体数。
2. 每条理由含本步骤要求的具体证据和结论；`reviewedBy: local-codex` 及逐路径/`per-parent-semantic` 方法仅是留痕，不能代替理由。
3. 模板 reason、规则/正则/批量脚本生成的 gate-filler 为 0。下列文字一律视为模板，必须重做：
   - `Listing title and use case match the input product core.`
   - `Listing title or category indicates a different core product type or use case.`
   - `Category is selected by local rules or matches the input product reference category.`
   - `Category represents a different core product type or buying intent from the input product.`
4. 产品级记录以 `parentAsin` 唯一；候选原始证据可留在 `candidates`，但不得以 `decisions` 覆盖层或脚本再生成第二条最终理由。

如果批处理停在 `Codex target review is incomplete` 或 `Codex semantic review is incomplete`，由 Codex 按第 4 或第 5 步逐条完成，不得为通过校验批量补写。修改任何类目或 listing 判断后，必须从第 7 步开始刷新最终池，重新执行第 8 步的季节性、ASIN 生命周期和 CPC，再重新执行第 9 步的主报告、子 ASIN 报告和结果日志。用户要求预览时可生成阶段性报告，但必须标为暂存。

### 主流程第 7 步：只更新过滤逻辑时离线重筛

如果当前数据已经完整抓取过，例如 `data + excluded` 中已经包含所有父体 Listing 和 `variantRows`，修改类目判断、Codex 决策、语义救回条件、同义词或报告口径后，禁止重新打开 Oalur 抓取。先用现有 JSON 离线重筛：

```bash
node skills/oalur-market-capacity/refilter-data.js output/日期-关键词/data/数据文件.json
```

该脚本会读取现有 `data` 和 `excluded`，合并为完整父体集合，重新计算规则证据评分，加载并应用 `*-target-category-codex-review.json`，再加载并应用 `*-codex-semantic-review.json`，最后重写 `targetCategories`、`categorySelection`、`codexSemanticReviewCandidates`、`data`、`excluded`。重筛完成后，必须重新执行第 8 步的季节性、ASIN 生命周期和 CPC，再执行第 9 步的主报告、子 ASIN 报告和结果日志。只有原始页数不完整、缺少 `excluded`、缺少 `variantRows`，或需要补新月份/新关键词时，才重新抓取 Oalur。

### 主流程第 8 步：提取季节性与 ASIN 生命周期数据

从 BSR 数据中自动选取上架 >3 年的 ASIN，提取以下三个数据源：

```bash
node skills/oalur-market-capacity/extract-seasonality.js "关键词" output/日期-关键词/data/数据文件.json output/日期-关键词/data/关键词-seasonality.json
```

脚本自动完成：
1. **Google Trends 5年搜索趋势**：直接打开固定页面 `https://trends.google.com/trends/explore?date=today%205-y&geo=US&hl=zh-CN` 抓取公开数据
   - 如果原始长尾词 Google Trends 数据过于稀疏（例如 5 年周数据非零点 `<24` 或非零率 `<15%`），不能直接用该数据判断季节性。
   - 此时允许本地 agent/本地规则从关键词中提取核心词后重试，例如 `fruit basket for kitchen counter` → `fruit basket`。
   - 报告必须展示原始关键词、实际 Google Trends 查询词和降级原因；核心词只用于 Google Trends 季节性验证，不改变 Oalur 搜索词、类目过滤、产品过滤或评分的其他数据源。
2. **Oalur 关键词月度趋势（36个月）**：从 Oalur 关键词研究页的 Pinia store 一次性提取 6 个数据集
3. **老品 ASIN 月度销量趋势**：从 BSR 数据中自动选取上架 >3 年、销售额接近的 ASIN，提取近 35 个月的月度销售趋势（同时导出"价格&排名趋势" Excel）
4. **季节性分析**：计算峰谷比、峰值月份、多年月均值，输出季节性结论
5. **ASIN 趋势合并报告**：导出 Excel 后自动调用 `generate-asin-trends-combined.js`，生成独立的 Buybox价格/Ratings数/大类BSR 趋势 HTML

#### 多关键词季节性口径

如果输入多个关键词，季节性和 ABA 趋势默认使用第一个输入关键词。例如输入 `Coffee Spoon,Espresso Spoon`，第 8 步季节性使用 `Coffee Spoon`。

### 辅助证据：关键词 AI 同义词分析（不参与过滤）

输入关键词后，`extract-data.js` 会先生成 `keyword-intent-analysis.json`：
- 如果环境变量 `OPENAI_API_KEY` 可用，尝试使用 OpenAI 兼容接口生成候选词分析。
- 如果 `OPENAI_API_KEY` 不可用或请求失败，使用本地内置 token 同义词输出兜底分析。
- 该文件只用于审计和后续完善规则，不参与 `targetCategories` 最终决策，不参与产品级 Codex 救回，不改变过滤结果。
- 如需跳过该步骤，可加 `--skip-keyword-intent-analysis`。

### 主流程第 8 步：提取 CPC/客单价比值（广告成本快判）

当需要判断 CPC 广告点击单价时，禁止只看 CPC 绝对值；必须按照 `knowledge/amazon-opportunity-index-criteria.md` 使用 `CPC / 客单价 * 100%`。默认样本从过滤后的父体 Listing 中按月销量排序取前 30 个，排除价格异常和 Ratings 缺失样本；报告主指标使用中位数 CPC/客单价，不使用平均值作为主要判断。

数据来源：Oalur ACOS 工具 `https://vip.oalur.com/tool/acos?site=US`。

```bash
node skills/oalur-market-capacity/extract-cpc-opportunity.js output/日期-关键词/data/关键词-asin-lifecycle.json output/日期-关键词/data/数据文件.json output/日期-关键词/data/关键词-cpc-opportunity.json
```
### 主流程第 9 步：生成完整报告（市场容量 + 季节性 + 存活率）

```bash
node skills/oalur-market-capacity/generate-report.js output/日期-关键词/data/数据文件.json --seasonality output/日期-关键词/data/关键词-seasonality.json --historical output/日期-关键词/data/关键词-historical.json --asin-lifecycle output/日期-关键词/data/关键词-asin-lifecycle.json --cpc-opportunity output/日期-关键词/data/关键词-cpc-opportunity.json
```

模板文件：`skills/oalur-market-capacity/report-template.html`
生成脚本：`skills/oalur-market-capacity/generate-report.js`

⚠️ **ASIN 趋势合并报告**（第 8 步执行时自动生成，无需单独执行）：`extract-asin-trends.js` 导出 Excel 后自动调用 `generate-asin-trends-combined.js` 生成第 2 个 HTML。

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

### 新增分析模块

| 分析模块 | 数据来源 | 输出内容 |
|---|---|---|
| **TOP3 头部垄断度** | `topClickRatioTrend` + `topConvertRatioTrend` | 最近6月均值 → 四种判定：严重垄断/转化垄断/曝光集中/无垄断 |
| **机会指数趋势** | `oppIndexTrend` + `productTotalNumTrend` | 前后半段对比 → 上升/稳定/下降 + 在售商品数趋势 |
| **标品/非标品判断** | TOP3份额 + 搜索排名波动 | 标品倾向/非标品倾向/混合型 + 对应策略建议 |

TOP3 点击份额与转化份额必须按的四象限解读，禁止简单相加：
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

### 最终评判标准：是否进入产品深化阶段

主报告首页必须输出“最终评判标准”卡片，作为最后判断口径。该结论只判断是否值得继续做供应链、专利、样品、包装和差异化验证，不等于直接开发。

一票否决项仅限当前数据可以证明的硬风险：
- 行业调整后基础机会指数 `<0.2`。
- 品牌 CR3 `>60%`。
- CPC/客单价 `>=15%`。
- 销量加权毛利率 `<35%`。

### 主流程第 9 步：保存报告
自动保存到：
```
output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_市场分析.html              ← 报告1：完整分析
output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_ASIN生命周期趋势分析.html   ← 报告2：ASIN价格排名趋势
output/YYYY-MM-DD-关键词/reports/YYYY-MM-DD_关键词_子ASIN明细.html             ← 报告3：子ASIN明细
```

### 主流程第 9 步：生成子 ASIN 明细报告（必选）

完整流程必须执行：

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
- “匹配依据”列显示 `目标类目` / `产品级 Codex 救回` / `未命中`

### 非主流程：市场容量阶段性报告（仅用户明确要求预览时）

```bash
node skills/oalur-market-capacity/generate-report.js output/日期-关键词/data/数据文件.json
```
仅在用户明确要求预览时执行。它不替代第 4–7 步的 Codex 判断、完成校验、离线重筛和第 9 步最终报告。

## 可选变体：多关键词分析

仅在用户输入多个关键词时使用。每个关键词仍按第 1–7 步独立完成抓取、Codex 判断和重筛后，才可离线合并；不得在一个 Oalur 页面会话中连抓多个关键词。

### 默认方式：逗号输入，脚本独立抓取后合并

```bash
node skills/oalur-market-capacity/extract-data.js "Cookie Cutter,Biscuit Cutter" 10000 output/日期-Cookie-Cutter-Biscuit-Cutter/data/merged-data.json
```

脚本将 `Cookie Cutter` 与 `Biscuit Cutter` 分别保存为独立数据文件，再调用 `merge-data.js --output` 合并为 `merged-data.json`。合并后的类目路径和候选父体仍必须经 Codex 逐条完成第 4–6 步；不得由合并脚本生成最终类目或父体理由。

### 手动方式：独立抓取 + merge-data.js 合并

```bash
node skills/oalur-market-capacity/extract-data.js "Cookie Cutter" 10000 output/日期-Cookie-Cutter/data/cookie-data.json
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-data.json
node skills/oalur-market-capacity/merge-data.js output/日期-Cookie-Cutter/data/cookie-data.json output/日期-Biscuit-Cutter/data/biscuit-data.json --output output/日期-merged-data/data/merged-data.json
```

`merge-data.js` 只重新计算规则证据、ASIN 去重和父体聚合，并加载已完成的决策文件；过滤口径必须与 `extract-data.js` / `refilter-data.js` 保持一致。输出路径优先使用 `--output` 或 `--out`；省略时默认写入 `output/日期-merged-data/data/merged-data.json`，不会覆盖已有输入文件，并兼容 UTF-8 BOM。

### 不推荐方式：单进程连抓

同一页面会话连续抓取多个关键词会残留 Oalur 页面状态，导致后续关键词与独立搜索不一致，默认禁止。

## 新品统计口径

父体 Listing 的代表 ASIN 仍然取 BSR 最好的子 ASIN，但新品统计不能只看代表 ASIN。

新品分析必须按父体 Listing 统计，并检查父体下目标相关子 ASIN：
- 所有新品、纯新父体、历史存活率判断都必须基于最终过滤后的 listing 池，即 `data` 中的目标类目直接命中产品 + 产品级 Codex 救回产品。
- 只要最终过滤池内的目标相关子 ASIN 中存在 `<6个月`，该父体 Listing 计入新品父体。
- 如果新品不是代表 ASIN，而是父体下某个子 ASIN，报告标记为 **父体新品子ASIN**。
- `<12个月` 分析同理，标记为 **父体<12月子ASIN**。
- 如果代表 ASIN 自身 `<12个月`，且父体下全部已抓到且最终判定为目标相关的子 ASIN 都 `<12个月`，在 `<12个月` 列表中标记为 **纯新父体**；任一已抓到的最终目标相关子 ASIN 日期缺失或超出窗口，都不能标记为纯新父体。
- `6个月纯新父体存活率` 和 `当前纯新父体销量承接（<6个月）` 是两个不同指标：前者看历史纯新父体是否仍留在当前目标类目/有效 BSR 区间，后者看当前市场里纯新父体是否能拿到销量。历史窗口没有严格纯新父体样本时，不能显示“未分析”，也不能按新品失败给 0 分；应明确写“样本0，无法计算存活率”，并按中性 `4/10` 计入新品活力。
- `<6个月`当前纯新父体销量承接和 `<12个月`近1年产品销量分析的主结论必须基于 **纯新父体** 的数量、销量和市场占比；父体新品子 ASIN / 父体 `<12月` 子 ASIN 仅作为辅助观察。

过滤后的 ASIN 表必须包含：
- 过滤来源：`目标类目` / `产品级 Codex 救回`
- 子 ASIN 数（同父体下除当前代表 ASIN 以外的 ASIN 数，不含代表 ASIN 本身）

新品销量表必须包含：
- 父体/代表 ASIN
- 新品子 ASIN
- 来源
- 子 ASIN 数（不含代表 ASIN 本身）

## 实现约束（不另定义流程）

本节只说明脚本实现和数据结构；执行先后、类目结论和父体结论只能以主流程第 1–9 步为准。

1. **浏览器连接与表单**：用 `puppeteer.connect({ browserURL: 'http://localhost:9222' })` 直连 Edge CDP；关键词用 `input[placeholder*="支持ASIN"]`，以 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` 触发 Vue；BSR 在“大类BSR排名” label 父元素的 `input[type="number"]` 中设置。
2. **页面数据读取**：表格行使用 `.el-table__body-wrapper table tbody tr`；类目路径从 titleCell 中包含 `>` 且以英文字母开头的行读取，排除 PASIN 行；上架时间优先解析 `listingAge`，为空时用 `listingDate` 计算月数。
3. **父体聚合**：先按 ASIN 去重，再按 `pasin || parentAsin || asin` 聚合；代表 ASIN 取父体下大类 BSR 最好的子 ASIN。销量/销售额优先用代表父体行，缺失或为 0 才按子体指标兜底；Ratings 按共享/独立评分规则计算。
4. **并发边界**：ASIN 趋势和 CPC 可使用独立 tab 的小并发池，所有临时 tab/page 必须关闭；同一 Oalur 筛选表的翻页不可并发，因为分页、筛选条件和“查看其他变体”共享页面状态。
5. **辅助同义词**：`keyword-intent-analysis.json` 只提供候选证据，不参与类目或父体最终决策；任何将其写入内置表的变更必须先获用户确认。
6. **结果留痕**：非目标且未被 Codex 救回的产品保留在 `excluded`，供后续复查。

## 竞争分析报告包含的图表

1. **竞争核心指标卡片**：TOP1 单品占比、TOP3 品牌份额、品牌分散度、平均星级
2. **品牌集中度柱状图**（按销量占比，TOP10 品牌横向柱状图）
3. **星级评分分布柱状图**（5 个区间）
4. **卖家性质饼图**（按销量占比，亚马逊自营/FBA/FBM）
5. **单品市场占比进度条**（TOP1/TOP3/TOP10）
6. **进入限制分析列表**（自动检测 + 人工补充）
7. **竞争综合结论**（基于六大维度的自动判断）

## 注意事项（跨步骤硬停条件）

本节不重复主流程，只列出任何步骤都不能绕过的限制：

1. 使用 `puppeteer-core` 直连现有 Edge CDP；不使用不稳定的 OpenClaw browser tool，也不使用其他 `--user-data-dir`。
2. 当前市场结果超过 800 行时停止并报告预计页数/行数；只有用户明确授权后才可使用 `--allow-over-800` 或 `OALUR_ALLOW_OVER_800=1`。
3. 筛选页出现关键词未生效、总计为 0、分页内容未变或“查看其他变体”无法确认时，停止抓取并按“抓取页面操作要点”恢复页面状态；不得继续翻页或推断数据完整。
4. 修改类目或父体 Codex 决策后，不重新抓取已有完整原始数据；必须回到第 7 步离线重筛，再重算第 8 步数据和第 9 步报告。
5. 历史新品只复用当前市场的已完成类目判断，并拥有独立的历史 listing 父体判断；禁止生成历史类目 review。
6. 当前市场数据、历史数据、报告和 Excel 分别保存在对应任务目录的 `data/`、`reports/`、`excel/` 中。

### 季节性分析注意事项

1. **Google Trends 是公开网页数据**：不需要登录，不需要 CDP 连接；直接打开 `https://trends.google.com/trends/explore?date=today%205-y&geo=US&hl=zh-CN`，不要长期调用 Trends API。
2. **Oalur 搜索量和 ASIN 趋势需要 CDP**：需要通过 Edge 浏览器（端口 9222）保持 Oalur 登录态
3. **ASIN 自动选取**：从最终 BSR 数据池中选择上架 >3 年且销售额接近的 3 个 ASIN，无需手动指定
4. **分析 5 年数据，不要只看 1 年**：避免某年异常（疫情、大促等）干扰判断
5. **提取脚本间需要独立页面**：每次提取都使用 puppeteer 新建标签页，避免页面状态冲突

## 抓取页面操作要点（主流程第 3 步参考）

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
4. 把分页改为 **100条/页**
5. 再点击页面上可见且未禁用的“确认查询”；脚本必须取得明确的 `clicked: true`，找不到或按钮不可用就停止
6. 等待 loading/表格/分页刷新，再次确认关键字、100 条/页、`总计: 非0` 及 `ceil(总计/100) = 最后页`；任一不一致就停止，禁止读取旧分页进行预估
7. 勾选并确认"查看其他变体"已开启
8. 第一页抓取前再次断言变体已开启
9. 开始提取数据（翻页），每页抓取前都确认变体仍开启

## 主流程命令清单（按第 1–9 步）

```bash
# 第 1 步：确认 keyword、title、参考类目、bulletPoints、description 和 BSR；未指定 BSR 时使用 25000。

# 第 2 步：确认 Edge CDP 可用
Test-NetConnection -ComputerName localhost -Port 9222 -InformationLevel Quiet

# 第 3 步：提取当前 BSR 市场数据；如需新品存活率，再提取历史新品快照。
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-data.json
node skills/oalur-market-capacity/extract-data.js "Biscuit Cutter" 10000 output/日期-Biscuit-Cutter/data/biscuit-historical.json --survival-baseline auto

# 第 4 步：Codex 对当前市场去重的完整类目路径逐条写入 target/exclude/review；历史新品复用此类目文件。
# 第 5 步：Codex 对当前 listing 和历史 listing 候选父体分别逐条写入唯一 products 决策。
# 第 6 步：检查三个 review 的覆盖数、唯一父体、具体理由和模板 reason = 0；未通过不得继续。

# 第 7 步：按已完成的 Codex 决策离线重筛当前和历史 JSON。
node skills/oalur-market-capacity/refilter-data.js output/日期-Biscuit-Cutter/data/biscuit-data.json
node skills/oalur-market-capacity/refilter-data.js output/日期-Biscuit-Cutter/data/biscuit-historical.json

# 第 8 步：仅基于当前最终过滤池提取季节性、ASIN 生命周期和 CPC。
node skills/oalur-market-capacity/extract-seasonality.js "Biscuit Cutter" output/日期-Biscuit-Cutter/data/biscuit-data.json output/日期-Biscuit-Cutter/data/biscuit-seasonality.json
node skills/oalur-market-capacity/extract-cpc-opportunity.js output/日期-Biscuit-Cutter/data/biscuit-asin-lifecycle.json output/日期-Biscuit-Cutter/data/biscuit-data.json output/日期-Biscuit-Cutter/data/biscuit-cpc-opportunity.json

# 第 9 步：生成主报告、子 ASIN 报告和结果日志。
node skills/oalur-market-capacity/generate-report.js output/日期-Biscuit-Cutter/data/biscuit-data.json --seasonality output/日期-Biscuit-Cutter/data/biscuit-seasonality.json --historical output/日期-Biscuit-Cutter/data/biscuit-historical.json --asin-lifecycle output/日期-Biscuit-Cutter/data/biscuit-asin-lifecycle.json --cpc-opportunity output/日期-Biscuit-Cutter/data/biscuit-cpc-opportunity.json
node skills/oalur-market-capacity/generate-child-asin-report.js output/日期-Biscuit-Cutter/data/biscuit-data.json
node skills/oalur-market-capacity/generate-result-log.js output/日期-Biscuit-Cutter
```

报告自动保存到：
- `output/YYYY-MM-DD-Biscuit-Cutter/reports/YYYY-MM-DD_Biscuit-Cutter_市场分析.html`（报告1：完整分析）
- `output/YYYY-MM-DD-Biscuit-Cutter/reports/YYYY-MM-DD_Biscuit-Cutter_ASIN生命周期趋势分析.html`（报告2：ASIN价格排名趋势，第 8 步自动生成）
- `output/YYYY-MM-DD-Biscuit-Cutter/reports/YYYY-MM-DD_Biscuit-Cutter_子ASIN明细.html`（报告3：子 ASIN 明细）
- `output/YYYY-MM-DD-Biscuit-Cutter/biscuit-cutter-result.log`（结果日志）
