const fs = require('fs');
const path = require('path');
const { titleMatchesKeywordIntent } = require('./category-selector');

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

function outputDirsFromDataFile(filePath, keyword) {
  const dataDir = path.resolve(path.dirname(filePath));
  if (path.basename(dataDir).toLowerCase() === 'data') {
    const root = path.dirname(dataDir);
    return { root, reports: path.join(root, 'reports') };
  }
  const root = path.join(process.cwd(), 'output', `${localDateString()}-${safeKeyword(keyword)}`);
  return { root, reports: path.join(root, 'reports') };
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
    <td>${escapeHtml(row.pasin || parent.parentAsin || '-')}</td>
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
  const filterSource = item.keywordIntentRescued ? '标题意图救回' : '目标类目';
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
      <div class="metric"><b>#${escapeHtml(item.bsr || '-')}</b><span>代表BSR</span></div>
    </div>
    <div class="category-line"><strong>父体类目：</strong>${categories.map(escapeHtml).join('；') || '-'}</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>角色</th><th>ASIN</th><th>父体ASIN</th><th>匹配依据</th><th>标题</th><th>类目</th>
          <th>月销量</th><th>月销售额</th><th>大类BSR</th><th>小类排名</th><th>价格</th><th>上架时间</th><th>评论数</th><th>品牌</th>
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

const resolvedDataPath = path.isAbsolute(dataFile) ? dataFile : path.join(process.cwd(), dataFile);
const jsonData = JSON.parse(fs.readFileSync(resolvedDataPath, 'utf-8'));
const data = Array.isArray(jsonData.data) ? jsonData.data : [];
const keyword = jsonData.keyword || path.basename(resolvedDataPath, '.json');
const date = localDateString();
const dirs = outputDirsFromDataFile(resolvedDataPath, keyword);
fs.mkdirSync(dirs.reports, { recursive: true });
const reportPath = path.join(dirs.reports, `${date}_${safeKeyword(keyword)}_子ASIN明细.html`);

const sorted = data.slice().sort((a, b) => (a.bsr || Number.MAX_SAFE_INTEGER) - (b.bsr || Number.MAX_SAFE_INTEGER));
const totalChildCount = sorted.reduce((sum, item) => sum + childAsinCountExcludingRepresentative(item), 0);
const rescuedCount = sorted.filter(item => item.keywordIntentRescued).length;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(keyword)} 子ASIN明细</title>
  <style>
    body { font-family: Arial, "Microsoft YaHei", sans-serif; margin: 0; background: #f5f7fb; color: #1f2937; }
    .container { max-width: 1480px; margin: 0 auto; padding: 24px; }
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
    .parent-head { display: grid; grid-template-columns: minmax(360px, 1fr) 120px 140px 140px 120px; gap: 12px; align-items: center; margin-bottom: 12px; }
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
      BSR范围：${escapeHtml(jsonData.bsrRange || '-')} | 目标类目：${escapeHtml((jsonData.targetCategories || [jsonData.targetCategory]).filter(Boolean).join('；') || '-')}
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
console.log(`Child ASIN report saved: ${reportPath}`);
