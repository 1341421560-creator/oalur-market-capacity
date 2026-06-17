const fs = require('fs');
const path = require('path');
const { titleMatchesKeywordIntent } = require('./category-selector');
const { aggregateRatingsForParent, aggregateVariantMetrics } = require('./parent-listing-aggregate');

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function safeKeyword(value) {
  return String(value || 'unknown').trim().replace(/\s+/g, '-').replace(/[\\/:*?"<>|]+/g, '-');
}

function parseNumber(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[$,%#]/g, '').replace(/,/g, '').trim();
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function formatInteger(value) {
  return Math.round(value || 0).toLocaleString('en-US');
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function outputDirsFromDataFile(filePath, keyword) {
  const dataDir = path.resolve(path.dirname(filePath));
  if (path.basename(dataDir).toLowerCase() === 'data') {
    const root = path.dirname(dataDir);
    return { root, reports: path.join(root, 'reports') };
  }
  const root = path.join(process.cwd(), 'output', `${localDateString()}-${safeKeyword(keyword)}`);
  return { root, reports: path.join(root, 'reports') };
}

function resolveDataPathWithScorePrefixFallback(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const dataDir = path.resolve(path.dirname(resolved));
  if (path.basename(dataDir).toLowerCase() !== 'data') return resolved;
  const root = path.dirname(dataDir);
  const outputDir = path.dirname(root);
  const rootName = path.basename(root);
  if (/^\d+score-/i.test(rootName)) return resolved;
  if (!fs.existsSync(outputDir)) return resolved;
  const matchedRoot = fs.readdirSync(outputDir)
    .filter(name => new RegExp(`^\\d+score-${rootName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(name))
    .map(name => ({
      name,
      mtimeMs: fs.statSync(path.join(outputDir, name)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(item => item.name)
    .map(name => path.join(outputDir, name, 'data', path.basename(resolved)))
    .find(candidate => fs.existsSync(candidate));
  if (matchedRoot) return matchedRoot;
  return fs.existsSync(resolved) ? resolved : resolved;
}

function childAsinCountExcludingRepresentative(item) {
  const asins = Array.isArray(item.childAsins) && item.childAsins.length
    ? item.childAsins
    : (Array.isArray(item.variantRows) ? item.variantRows.map(row => row.asin) : []);
  const unique = new Set(asins.filter(Boolean));
  if (item.asin) unique.delete(item.asin);
  return unique.size;
}

function variantRows(item) {
  if (Array.isArray(item.variantRows) && item.variantRows.length) return item.variantRows;
  return [{
    asin: item.asin,
    pasin: item.pasin || item.parentAsin,
    category: item.category,
    title: item.title,
    sales: item.sales,
    revenue: item.revenue,
    bsr: item.bsr,
    subRank: item.subRank,
    price: item.price,
    listingDate: item.listingDate,
    listingAge: item.listingAge,
    ratings: item.ratings,
    brand: item.brand
  }];
}

function representativeMetricRow(item, rows) {
  const sourceRows = Array.isArray(rows) && rows.length ? rows : [];
  return sourceRows.find(row => row.asin && row.asin === item.asin)
    || [...sourceRows].sort((a, b) => {
      const ab = parseNumber(a.bsr) > 0 ? parseNumber(a.bsr) : Number.MAX_SAFE_INTEGER;
      const bb = parseNumber(b.bsr) > 0 ? parseNumber(b.bsr) : Number.MAX_SAFE_INTEGER;
      return ab - bb;
    })[0]
    || item;
}

function aggregateParentMetrics(item) {
  const rows = variantRows(item);
  const aggregated = aggregateVariantMetrics({ ...item }, rows);
  const ratingsAggregation = aggregateRatingsForParent(rows);
  const supplementedRatings = parseNumber(item.ratingsNumAggregated || item.ratings);
  const useSupplementedRatings = ratingsAggregation.value <= 0
    && supplementedRatings > 0
    && String(item.ratingsSupplementedFrom || '').includes('products/information');
  const ratingsValue = useSupplementedRatings ? supplementedRatings : ratingsAggregation.value;

  return {
    ...item,
    sales: aggregated.sales,
    revenue: aggregated.revenue,
    ratings: formatInteger(ratingsValue),
    salesNumAggregated: aggregated.salesNumAggregated,
    revenueNumAggregated: aggregated.revenueNumAggregated,
    ratingsNumAggregated: Math.round(ratingsValue),
    salesRevenueMetricSource: aggregated.salesRevenueMetricSource,
    salesMetricFallbackReason: aggregated.salesMetricFallbackReason,
    revenueMetricFallbackReason: aggregated.revenueMetricFallbackReason,
    ratingsMetricSource: useSupplementedRatings ? item.ratingsMetricSource : ratingsAggregation.mode,
    ratingsMetricReason: useSupplementedRatings ? item.ratingsMetricReason : ratingsAggregation.reason,
    ratingsMetricValues: useSupplementedRatings ? item.ratingsMetricValues : ratingsAggregation.values
  };
}

function rowMatchText(row, parent, keyword) {
  const targetCategoryMatched = Array.isArray(parent.targetMatchedChildAsins) && parent.targetMatchedChildAsins.includes(row.asin);
  const titleIntentMatched = titleMatchesKeywordIntent(row.title || '', keyword);
  if (targetCategoryMatched && titleIntentMatched) return '目标类目+标题意图';
  if (targetCategoryMatched) return '目标类目';
  if (titleIntentMatched) return '标题意图';
  return '未命中';
}

function rowHtml(row, parent, keyword) {
  const isRepresentative = row.asin === parent.asin;
  const role = isRepresentative ? '代表ASIN' : '子ASIN';
  const matchText = rowMatchText(row, parent, keyword);
  return `<tr class="${isRepresentative ? 'rep-row' : ''}">
    <td>${escapeHtml(role)}</td>
    <td><a href="https://www.amazon.com/dp/${escapeHtml(row.asin)}" target="_blank">${escapeHtml(row.asin || '-')}</a></td>
    <td>${escapeHtml(row.pasin || parent.parentAsin || parent.pasin || '-')}</td>
    <td>${escapeHtml(matchText)}</td>
    <td class="title" title="${escapeHtml(row.title || '')}">${escapeHtml(row.title || '-')}</td>
    <td>${escapeHtml(row.category || '-')}</td>
    <td>${escapeHtml(row.sales || '-')}</td>
    <td>${escapeHtml(row.revenue || '-')}</td>
    <td>${escapeHtml(row.bsr || '-')}</td>
    <td>${escapeHtml(row.subRank || '-')}</td>
    <td>${escapeHtml(row.price || '-')}</td>
    <td>${escapeHtml(row.listingAge || row.listingDate || '-')}</td>
    <td>${escapeHtml(row.ratings || '-')}</td>
    <td>${escapeHtml(row.brand || '-')}</td>
  </tr>`;
}

function parentSection(item, index, keyword) {
  const rows = variantRows(item).slice().sort((a, b) => {
    if (a.asin === item.asin) return -1;
    if (b.asin === item.asin) return 1;
    return String(a.asin || '').localeCompare(String(b.asin || ''));
  });
  const filterSource = item.keywordIntentRescued ? '标题意图救回' : (item.targetCategoryTitleIntentRequired ? '目标类目+标题意图' : '目标类目');
  const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);

  return `<section class="card">
    <div class="parent-head">
      <div>
        <h2>${index + 1}. <a href="https://www.amazon.com/dp/${escapeHtml(item.asin)}" target="_blank">${escapeHtml(item.asin || '-')}</a></h2>
        <div class="muted">父体ASIN：${escapeHtml(item.parentAsin || item.pasin || item.asin || '-')} | 过滤来源：${escapeHtml(filterSource)}</div>
      </div>
      <div class="metric"><b>${childAsinCountExcludingRepresentative(item)}</b><span>子ASIN数</span></div>
      <div class="metric"><b>${rows.length}</b><span>同父体ASIN总数</span></div>
      <div class="metric"><b>${escapeHtml(item.sales || '-')}</b><span>父体月销量</span></div>
      <div class="metric"><b>${escapeHtml(item.ratings || '-')}</b><span>父体 Ratings</span></div>
      <div class="metric"><b>#${escapeHtml(item.bsr || '-')}</b><span>代表ASIN BSR</span></div>
    </div>
    <div class="category-line"><strong>父体类目：</strong>${categories.map(escapeHtml).join('；') || '-'}</div>
    <div class="category-line"><strong>指标口径：</strong>父体月销量、月销售额取 Oalur 代表父体行数值（已自带子 ASIN 销量/销售额）；父体 Ratings 按共享/独立评分规则计算。表格中的 Ratings 是 Oalur 抓取的 Ratings 数，不是评论数。</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>角色</th><th>ASIN</th><th>父体ASIN</th><th>匹配依据</th><th>标题</th><th>类目</th>
          <th>月销量</th><th>月销售额</th><th>大类BSR</th><th>小类排名</th><th>价格</th><th>上架时间</th><th>Ratings</th><th>品牌</th>
        </tr></thead>
        <tbody>${rows.map(row => rowHtml(row, item, keyword)).join('\n')}</tbody>
      </table>
    </div>
  </section>`;
}

const dataFile = process.argv[2];
if (!dataFile) {
  console.error('Usage: node generate-child-asin-report.js <data.json>');
  process.exit(1);
}

const resolvedDataPath = resolveDataPathWithScorePrefixFallback(dataFile);
const jsonData = JSON.parse(fs.readFileSync(resolvedDataPath, 'utf-8'));
const data = Array.isArray(jsonData.data) ? jsonData.data.map(aggregateParentMetrics) : [];
const keyword = jsonData.keyword || path.basename(resolvedDataPath, '.json');
const date = localDateString();
const dirs = outputDirsFromDataFile(resolvedDataPath, keyword);
fs.mkdirSync(dirs.reports, { recursive: true });
const reportPath = path.join(dirs.reports, `${date}_${safeKeyword(keyword)}_子ASIN明细.html`);

const sorted = data.slice().sort((a, b) => parseNumber(a.bsr) - parseNumber(b.bsr));
const totalChildCount = sorted.reduce((sum, item) => sum + childAsinCountExcludingRepresentative(item), 0);
const rescuedCount = sorted.filter(item => item.keywordIntentRescued).length;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(keyword)} 子ASIN明细</title>
  <style>
    body { font-family: Arial, "Microsoft YaHei", sans-serif; margin: 0; background: #f5f7fb; color: #1f2937; }
    .container { max-width: 1560px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 0; font-size: 18px; }
    a { color: #1677ff; text-decoration: none; }
    .meta { color: #64748b; margin-bottom: 18px; line-height: 1.7; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
    .summary .box, .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .summary .box { padding: 14px 16px; }
    .summary b { display: block; font-size: 24px; margin-bottom: 4px; }
    .summary span, .muted { color: #64748b; font-size: 13px; }
    .card { padding: 16px; margin-bottom: 16px; }
    .parent-head { display: grid; grid-template-columns: minmax(360px, 1fr) 110px 130px 130px 130px 130px; gap: 12px; align-items: center; margin-bottom: 12px; }
    .metric { text-align: center; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px; }
    .metric b { display: block; font-size: 18px; margin-bottom: 4px; }
    .metric span { color: #64748b; font-size: 12px; }
    .category-line { font-size: 13px; color: #475569; background: #f8fafc; padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 1500px; }
    th, td { border: 1px solid #e5e7eb; padding: 8px 10px; font-size: 12px; vertical-align: top; }
    th { background: #f1f5f9; color: #334155; text-align: left; white-space: nowrap; }
    td { background: #fff; }
    tr.rep-row td { background: #fff7e6; }
    td.title { max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(keyword)} 子ASIN明细</h1>
    <div class="meta">
      数据文件：${escapeHtml(path.relative(process.cwd(), resolvedDataPath))}<br>
      BSR范围：${escapeHtml(jsonData.bsrRange || '-')} | 目标类目组：${escapeHtml((jsonData.targetCategories || [jsonData.targetCategory]).filter(Boolean).join('；') || '-')}<br>
      口径：过滤决定父体 Listing 是否进入分析；进入后，父体销量/销售额取 Oalur 代表父体行数值，父体 Ratings 按共享/独立评分规则计算。
    </div>
    <div class="summary">
      <div class="box"><b>${sorted.length}</b><span>过滤后父体 Listing</span></div>
      <div class="box"><b>${totalChildCount}</b><span>子ASIN总数（不含代表）</span></div>
      <div class="box"><b>${rescuedCount}</b><span>标题意图救回父体</span></div>
      <div class="box"><b>${escapeHtml(jsonData.allCount || jsonData.total || '-')}</b><span>聚合前父体口径</span></div>
      <div class="box"><b>${escapeHtml(jsonData.excludedCount || 0)}</b><span>排除父体 Listing</span></div>
    </div>
    ${sorted.map((item, index) => parentSection(item, index, keyword)).join('\n')}
  </div>
</body>
</html>`;

fs.writeFileSync(reportPath, html, 'utf-8');
console.log(`Child ASIN report saved: ${path.relative(process.cwd(), reportPath)}`);
