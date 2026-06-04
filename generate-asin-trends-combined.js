/**
 * 分析所有已导出的 ASIN 价格排名趋势 Excel，生成合并 HTML 报告
 * 
 * 用法: node analyze-combined.js "ASIN1,ASIN2,..." [输出文件名前缀]
 * 示例: node analyze-combined.js "B074W66D85,B083QLRBLK" Biscuit-Cutter
 * 
 * 输出: output/YYYY-MM-DD-前缀/reports/YYYY-MM-DD_前缀_ASIN趋势分析.html
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

function safeSegment(value) {
  return String(value || 'output').trim().toLowerCase().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function outputDirs(taskName) {
  const date = new Date().toISOString().split('T')[0];
  const root = path.join(process.cwd(), 'output', `${date}-${safeSegment(taskName)}`);
  return {
    root,
    data: path.join(root, 'data'),
    reports: path.join(root, 'reports'),
    excel: path.join(root, 'excel')
  };
}

const asinArg = process.argv[2];
const jsonOutIdx = process.argv.indexOf('--json-out');
const jsonOutParam = jsonOutIdx > -1 ? process.argv[jsonOutIdx + 1] : null;
const namePrefix = (jsonOutIdx === 3 ? '' : process.argv[3]) || '';

if (!asinArg) {
  console.error('❌ 用法: node analyze-combined.js "ASIN1,ASIN2,..." [输出文件名前缀]');
  process.exit(1);
}

const asins = asinArg.split(',').map(s => s.trim()).filter(Boolean);
const today = new Date().toISOString().split('T')[0];
const defaultPrefix = asins.slice(0, 3).join('-');
const filePrefix = namePrefix || defaultPrefix;
const dirs = outputDirs(filePrefix);
const DOWNLOAD_DIR = process.env.OALUR_DOWNLOAD_DIR || dirs.excel;
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`📊 合并 ASIN 趋势分析: ${asins.length} 个 ASIN`);
console.log('='.repeat(50));

// 为每个 ASIN 找对应的 Excel 文件（取最新的）
const asinData = [];

for (const asin of asins) {
  const files = fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => f.startsWith('价格&排名趋势_' + asin + '_') && f.endsWith('.xlsx'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    console.log(`  ⚠️ ${asin}: 未找到导出文件，跳过`);
    continue;
  }

  const excelFile = path.join(DOWNLOAD_DIR, files[0].name);
  console.log(`  📂 ${asin}: ${files[0].name}`);

  try {
    const wb = XLSX.readFile(excelFile);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const headers = rows[0].map(h => String(h || ''));

    // 解析数据
    const data = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[0]) continue;
      const mainBsrValue = r[9] != null ? parseInt(r[9]) : NaN;
      data.push({
        date: String(r[0]),
        buyboxPrice: r[1] != null ? parseFloat(r[1]) : null,
        ratingsNum: r[7] != null ? parseInt(r[7]) : null,
        mainBsr: Number.isFinite(mainBsrValue) && mainBsrValue > 0 ? mainBsrValue : null
      });
    }

    // 取近4年
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 4);
    cutoff.setDate(3);
    const cutoffStr = cutoff.toISOString().substring(0, 10);
    const filtered = data.filter(d => d.date >= cutoffStr);

    const priceData = filtered.filter(d => d.buyboxPrice != null);
    const ratingsData = filtered.filter(d => d.ratingsNum != null);
    const bsrData = filtered.filter(d => d.mainBsr != null);

    if (priceData.length === 0) {
      console.log(`    ⚠️ 无有效数据`);
      continue;
    }

    const firstP = priceData[0];
    const lastP = priceData[priceData.length - 1];
    const firstR = ratingsData[0];
    const lastR = ratingsData[ratingsData.length - 1];
    const firstB = bsrData[0];
    const lastB = bsrData[bsrData.length - 1];

    const prices = priceData.map(d => d.buyboxPrice);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);

    const bsrs = bsrData.map(d => d.mainBsr);
    const minBsr = bsrs.length > 0 ? Math.min(...bsrs) : 0;
    const maxBsr = bsrs.length > 0 ? Math.max(...bsrs) : 0;

    const ratingIncrease = firstR && lastR ? lastR.ratingsNum - firstR.ratingsNum : 0;
    const daysDiff = priceData.length;
    const ratingPerMonth = daysDiff > 0 ? (ratingIncrease / (daysDiff / 30)).toFixed(1) : '0';

    // 生命周期判断
    const mid = Math.floor(priceData.length / 2);
    const firstHalf = priceData.slice(0, mid);
    const secondHalf = priceData.slice(-mid);
    const avgPriceFirst = firstHalf.reduce((s, d) => s + d.buyboxPrice, 0) / firstHalf.length;
    const avgPriceSecond = secondHalf.reduce((s, d) => s + d.buyboxPrice, 0) / secondHalf.length;

    const bsrMid = Math.floor(bsrData.length / 2);
    const avgBsrFirst = bsrMid > 0 ? bsrData.slice(0, bsrMid).reduce((s, d) => s + d.mainBsr, 0) / bsrMid : 0;
    const avgBsrSecond = bsrMid > 0 ? bsrData.slice(-bsrMid).reduce((s, d) => s + d.mainBsr, 0) / bsrMid : 0;

    const ratingMid = Math.floor(ratingsData.length / 2);
    const growthFirst = ratingMid >= 2
      ? (ratingsData[ratingMid - 1].ratingsNum - ratingsData[0].ratingsNum) / Math.max(1, ratingMid / 30)
      : 0;
    const growthLast = ratingsData.length - ratingMid >= 2
      ? (ratingsData[ratingsData.length - 1].ratingsNum - ratingsData[ratingMid].ratingsNum) / Math.max(1, (ratingsData.length - ratingMid) / 30)
      : 0;

    const priceDown = avgPriceSecond < avgPriceFirst * 0.93;
    const bsrUp = avgBsrFirst > 0 && avgBsrSecond > avgBsrFirst * 1.15;

    let lifecycle, cls;
    if (priceDown && bsrUp) { lifecycle = '⚠️ 衰退期'; cls = 'fail'; }
    else if (priceDown) { lifecycle = '⚠️ 成熟后期'; cls = 'caution'; }
    else if (bsrUp) { lifecycle = '⚠️ 排名下滑'; cls = 'caution'; }
    else if (growthLast < growthFirst * 0.5 && growthFirst > 0) { lifecycle = '➡️ 成熟期'; cls = 'pass'; }
    else { lifecycle = '✅ 健康成熟'; cls = 'pass'; }

    asinData.push({
      asin,
      file: files[0].name,
      priceData,
      ratingsData,
      bsrData,
      firstP, lastP, firstR, lastR, firstB, lastB,
      avgPrice, maxPrice, minPrice,
      minBsr, maxBsr,
      ratingIncrease,
      ratingPerMonth,
      lifecycle,
      cls,
      avgPriceFirst, avgPriceSecond,
      avgBsrFirst, avgBsrSecond,
      growthFirst, growthLast
    });

    console.log(`    ✅ ${priceData.length} 条价格, ${ratingsData.length} 条评论, ${bsrData.length} 条BSR → ${lifecycle}`);
  } catch (e) {
    console.log(`    ❌ 解析失败: ${e.message.substring(0, 60)}`);
  }
}

if (asinData.length === 0) {
  console.error('❌ 无有效 ASIN 数据');
  process.exit(1);
}

// 生成合并 HTML
const outPath = path.join(dirs.reports,
  `${today}_${filePrefix}_ASIN趋势分析.html`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const cleanOutPath = path.join(dirs.reports,
  `${today}_${filePrefix}_ASIN生命周期趋势分析.html`);

function normalizeLifecycle(value) {
  const raw = String(value || '');
  if (raw.includes('衰') || raw.includes('琛伴')) return '衰退期';
  if (raw.includes('后期') || raw.includes('鍚庢湡')) return '成熟后期';
  if (raw.includes('鍋') || raw.includes('悍')) return '健康成熟';
  if (raw.includes('成熟') || raw.includes('鎴愮啛')) return '健康成熟';
  return raw || '未识别';
}

const asinCardsHtml = asinData.map((d, idx) => `
<div class="card">
  <h2>📊 ${d.asin} <span class="lifecycle-${d.cls}">${d.lifecycle}</span></h2>
  <div class="summary">
    <div class="metric"><div class="value">$${d.lastP.buyboxPrice.toFixed(2)}</div><div class="label">当前价格</div></div>
    <div class="metric"><div class="value">${d.lastR ? d.lastR.ratingsNum.toLocaleString() : 'N/A'}</div><div class="label">Ratings</div></div>
    <div class="metric"><div class="value">#${d.lastB ? d.lastB.mainBsr.toLocaleString() : 'N/A'}</div><div class="label">大类BSR</div></div>
    <div class="metric"><div class="value">${d.ratingPerMonth}/月</div><div class="label">评论增速</div></div>
  </div>
  <div class="chart-row">
    <div class="chart-card">
      <h3>Buybox 价格趋势</h3>
      <div class="chart-container"><canvas id="priceChart${idx}"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>Ratings 数趋势</h3>
      <div class="chart-container"><canvas id="ratingsChart${idx}"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>大类 BSR 趋势</h3>
      <div class="chart-container"><canvas id="bsrChart${idx}"></canvas></div>
    </div>
  </div>
</div>
`).join('\n');

const chartsJs = asinData.map((d, idx) => `
// ${d.asin}
new Chart(document.getElementById('priceChart${idx}'), {
  type: 'line',
  data: { datasets: [{ label: 'Buybox 价格 (\$)', data: ${JSON.stringify(d.priceData.map(p => ({x: p.date, y: p.buyboxPrice})))}, borderColor: '#1890ff', backgroundColor: 'rgba(24,144,255,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { type: 'time', time: { unit: 'month' } }, y: { beginAtZero: false } } }
});
new Chart(document.getElementById('ratingsChart${idx}'), {
  type: 'line',
  data: { datasets: [{ label: 'Ratings 数', data: ${JSON.stringify(d.ratingsData.map(p => ({x: p.date, y: p.ratingsNum})))}, borderColor: '#52c41a', backgroundColor: 'rgba(82,196,26,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { type: 'time', time: { unit: 'month' } }, y: { beginAtZero: true } } }
});
new Chart(document.getElementById('bsrChart${idx}'), {
  type: 'line',
  data: { datasets: [{ label: '大类 BSR', data: ${JSON.stringify(d.bsrData.map(p => ({x: p.date, y: p.mainBsr})))}, borderColor: '#722ed1', backgroundColor: 'rgba(114,46,209,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { type: 'time', time: { unit: 'month' } }, y: { reverse: true } } }
});
`).join('\n');

// 汇总表格
const summaryRows = asinData.map(d => `
<tr>
  <td><a href="https://www.amazon.com/dp/${d.asin}" target="_blank">${d.asin}</a></td>
  <td>$${d.firstP.buyboxPrice.toFixed(2)} → $${d.lastP.buyboxPrice.toFixed(2)}</td>
  <td>#${d.firstB.mainBsr.toLocaleString()} → #${d.lastB.mainBsr.toLocaleString()}</td>
  <td>${d.firstR.ratingsNum.toLocaleString()} → ${d.lastR.ratingsNum.toLocaleString()}</td>
  <td>${d.ratingPerMonth}/月</td>
  <td><span class="lifecycle-${d.cls}">${d.lifecycle}</span></td>
</tr>
`).join('\n');

const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${filePrefix} ASIN 趋势分析</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei',sans-serif;max-width:1400px;margin:0 auto;padding:20px;background:#f5f5f5;color:#333}
h1{color:#1890ff;margin-bottom:8px}
h2{color:#333;border-bottom:2px solid #1890ff;padding-bottom:8px;margin:12px 0;font-size:16px}
h3{font-size:13px;color:#666;margin-bottom:8px}
.card{background:white;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
.chart-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.chart-card{background:#fafafa;border-radius:8px;padding:12px}
.chart-container{position:relative;height:200px}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px}
.metric{text-align:center}
.metric .value{font-size:18px;font-weight:bold;color:#1890ff}
.metric .label{color:#666;margin-top:2px;font-size:12px}
.info{background:#e6f7ff;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px;color:#0050b3;line-height:1.8}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f0f5ff;padding:10px 12px;text-align:left;border-bottom:2px solid #1890ff}
td{padding:8px 12px;border-bottom:1px solid #f0f0f0}
tr:hover{background:#fafafa}
.lifecycle-pass{color:#52c41a;font-weight:bold}
.lifecycle-caution{color:#faad14;font-weight:bold}
.lifecycle-fail{color:#ff4d4f;font-weight:bold}
</style></head><body>
<h1>📊 ASIN 价格&排名趋势分析</h1>
<div class="info">
  数据来源：Oalur 价格排名趋势导出 | ${asinData.length} 个 ASIN | 报告生成：${new Date().toISOString().replace('T', ' ').substring(0, 16)}
</div>

<div class="card">
  <h2>📋 汇总</h2>
  <table>
    <tr><th>ASIN</th><th>价格变化</th><th>BSR 变化</th><th>Ratings 变化</th><th>增速</th><th>生命周期</th></tr>
    ${summaryRows}
  </table>
</div>

<div class="card" style="background:#f0f5ff;">
  <h2>📐 知识库生命周期判定标准（第八章）</h2>
  <div style="font-size:13px;line-height:2.0;color:#555;">
    <p>① <strong>价格后半段 &lt; 前半段 × 0.93</strong> → 📉 价格下行（成熟后期/衰退期信号）</p>
    <p>② <strong>BSR 后半段 &gt; 前半段 × 1.15</strong> → 📉 排名下滑（竞争力下降，BSR 值越大排名越差）</p>
    <p>③ <strong>评论月增后半段 &lt; 前半段 × 0.5</strong> → 增速放缓（成熟期特征）</p>
    <p>④ <strong>均价持续走低</strong> → 市场内卷/价格战/红海信号 | <strong>头部评论增量放缓</strong> → 产品周期下行</p>
    <p style="margin-top:8px;color:#999;font-size:12px;">📖 知识库来源：第六章四大指标（商品/品牌集中度/评论壁垒/新品存活率）+ 第八章（季节性/生命周期）</p>
  </div>
</div>

${asinCardsHtml}

<script>
${chartsJs}
<\/script>
</body></html>`;

const cleanSummaryRows = asinData.map(d => `
<tr>
  <td><a href="https://www.amazon.com/dp/${d.asin}" target="_blank">${d.asin}</a></td>
  <td>$${d.firstP.buyboxPrice.toFixed(2)} → $${d.lastP.buyboxPrice.toFixed(2)}</td>
  <td>${d.firstB && d.lastB ? `#${d.firstB.mainBsr.toLocaleString()} → #${d.lastB.mainBsr.toLocaleString()}` : '未采集大类 BSR'}</td>
  <td>${d.firstR.ratingsNum.toLocaleString()} → ${d.lastR.ratingsNum.toLocaleString()}</td>
  <td>${d.ratingPerMonth}/月</td>
  <td><span class="lifecycle-${d.cls}">${normalizeLifecycle(d.lifecycle)}</span></td>
</tr>
`).join('\n');

function buildTrendRows(d) {
  const priceByDate = new Map(d.priceData.map(p => [p.date, p.buyboxPrice]));
  const ratingsByDate = new Map(d.ratingsData.map(p => [p.date, p.ratingsNum]));
  const bsrByDate = new Map(d.bsrData.map(p => [p.date, p.mainBsr]));
  const dates = [...new Set([
    ...d.priceData.map(p => p.date),
    ...d.ratingsData.map(p => p.date),
    ...d.bsrData.map(p => p.date)
  ])].sort();
  return dates.map(date => {
    const price = priceByDate.get(date);
    const ratings = ratingsByDate.get(date);
    const bsr = bsrByDate.get(date);
    return `<tr><td>${date}</td><td>${price == null ? '-' : '$' + price.toFixed(2)}</td><td>${ratings == null ? '-' : ratings.toLocaleString()}</td><td>${bsr == null ? '-' : '#' + bsr.toLocaleString()}</td></tr>`;
  }).join('\n');
}

const cleanAsinCardsHtml = asinData.map((d, idx) => `
<div class="card">
  <h2>${d.asin} <span class="lifecycle-${d.cls}">${normalizeLifecycle(d.lifecycle)}</span></h2>
  <div class="summary">
    <div class="metric"><div class="value">$${d.lastP.buyboxPrice.toFixed(2)}</div><div class="label">当前价格</div></div>
    <div class="metric"><div class="value">${d.lastR ? d.lastR.ratingsNum.toLocaleString() : 'N/A'}</div><div class="label">Ratings</div></div>
    <div class="metric"><div class="value">#${d.lastB ? d.lastB.mainBsr.toLocaleString() : 'N/A'}</div><div class="label">大类 BSR</div></div>
    <div class="metric"><div class="value">${d.ratingPerMonth}/月</div><div class="label">评论增速</div></div>
  </div>
  <div class="chart-row">
    <div class="chart-card"><h3>Buybox 价格趋势</h3><div class="chart-container"><canvas id="cleanPriceChart${idx}"></canvas></div></div>
    <div class="chart-card"><h3>Ratings 数趋势</h3><div class="chart-container"><canvas id="cleanRatingsChart${idx}"></canvas></div></div>
    <div class="chart-card"><h3>大类 BSR 趋势</h3><div class="chart-container"><canvas id="cleanBsrChart${idx}"></canvas></div></div>
  </div>
  <details style="margin-top:14px;">
    <summary style="cursor:pointer;font-weight:700;color:#1890ff;">查看 ${d.asin} 明细数据表（价格 / Ratings / 大类 BSR）</summary>
    <div style="max-height:360px;overflow:auto;margin-top:10px;border:1px solid #e8e8e8;border-radius:8px;">
      <table>
        <tr><th>日期</th><th>Buybox 价格</th><th>Ratings</th><th>大类 BSR</th></tr>
        ${buildTrendRows(d)}
      </table>
    </div>
    <p style="font-size:12px;color:#999;margin-top:6px;">说明：大类 BSR 为空、0 或非数字时不统计，表格中显示为 “-”。</p>
  </details>
</div>
`).join('\n');

const cleanChartsJs = asinData.map((d, idx) => `
new Chart(document.getElementById('cleanPriceChart${idx}'), {
  type: 'line',
  data: { datasets: [{ label: 'Buybox 价格 ($)', data: ${JSON.stringify(d.priceData.map(p => ({x: p.date, y: p.buyboxPrice})))}, borderColor: '#1890ff', backgroundColor: 'rgba(24,144,255,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { type: 'time', time: { unit: 'month' } }, y: { beginAtZero: false } } }
});
new Chart(document.getElementById('cleanRatingsChart${idx}'), {
  type: 'line',
  data: { datasets: [{ label: 'Ratings 数', data: ${JSON.stringify(d.ratingsData.map(p => ({x: p.date, y: p.ratingsNum})))}, borderColor: '#52c41a', backgroundColor: 'rgba(82,196,26,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { type: 'time', time: { unit: 'month' } }, y: { beginAtZero: true } } }
});
new Chart(document.getElementById('cleanBsrChart${idx}'), {
  type: 'line',
  data: { datasets: [{ label: '大类 BSR', data: ${JSON.stringify(d.bsrData.map(p => ({x: p.date, y: p.mainBsr})))}, borderColor: '#722ed1', backgroundColor: 'rgba(114,46,209,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { type: 'time', time: { unit: 'month' } }, y: { reverse: true } } }
});
`).join('\n');

const cleanHtml = html
  .replace(/<title>.*?<\/title>/, `<title>${filePrefix} ASIN 生命周期趋势分析</title>`)
  .replace(/<h1>.*?<\/h1>/, '<h1>ASIN 价格 & 排名生命周期趋势分析</h1>')
  .replace(/<div class="info">[\s\S]*?<\/div>\s*<div class="card">/, `<div class="info">\n  数据来源：Oalur 价格排名趋势导出 | ${asinData.length} 个 ASIN | 报告生成：${new Date().toISOString().replace('T', ' ').substring(0, 16)}\n</div>\n\n<div class="card">`)
  .replace(/<h2>.*?<\/h2>\s*<table>\s*<tr><th>ASIN[\s\S]*?<\/table>/, `<h2>汇总</h2>\n  <table>\n    <tr><th>ASIN</th><th>价格变化</th><th>BSR 变化</th><th>Ratings 变化</th><th>增速</th><th>生命周期</th></tr>\n    ${cleanSummaryRows}\n  </table>`)
  .replace(/<div class="card" style="background:#f0f5ff;">[\s\S]*?\n<\/div>\n\n\$\{asinCardsHtml\}/, `<div class="card" style="background:#f0f5ff;">\n  <h2>知识库生命周期判定标准</h2>\n  <div style="font-size:13px;line-height:2.0;color:#555;">\n    <p>1. <strong>价格后半段 &lt; 前半段 × 0.93</strong>：价格下行，可能进入成熟后期或衰退期。</p>\n    <p>2. <strong>BSR 后半段 &gt; 前半段 × 1.15</strong>：排名下滑，竞争力下降。</p>\n    <p>3. <strong>评论月增速显著放缓</strong>：成熟期后段信号。</p>\n    <p>4. <strong>均价持续走低 + 头部评论增量放缓</strong>：通常意味着价格内卷和生命周期下行。</p>\n    <p style="margin-top:8px;color:#999;font-size:12px;">知识库来源：市场竞争量化指标 + 季节性与生命周期判断。</p>\n  </div>\n</div>\n\n${cleanAsinCardsHtml}`)
  .replace(chartsJs, cleanChartsJs);

fs.writeFileSync(cleanOutPath, cleanHtml, 'utf-8');
const directCleanHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${filePrefix} ASIN 生命周期趋势分析</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei',sans-serif;max-width:1400px;margin:0 auto;padding:20px;background:#f5f5f5;color:#333}
h1{color:#1890ff;margin-bottom:8px}
h2{color:#333;border-bottom:2px solid #1890ff;padding-bottom:8px;margin:12px 0;font-size:16px}
h3{font-size:13px;color:#666;margin-bottom:8px}
.card{background:white;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
.chart-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.chart-card{background:#fafafa;border-radius:8px;padding:12px}
.chart-container{position:relative;height:200px}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px}
.metric{text-align:center}
.metric .value{font-size:18px;font-weight:bold;color:#1890ff}
.metric .label{color:#666;margin-top:2px;font-size:12px}
.info{background:#e6f7ff;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px;color:#0050b3;line-height:1.8}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f0f5ff;padding:10px 12px;text-align:left;border-bottom:2px solid #1890ff;position:sticky;top:0}
td{padding:8px 12px;border-bottom:1px solid #f0f0f0}
tr:hover{background:#fafafa}
.lifecycle-pass{color:#52c41a;font-weight:bold}
.lifecycle-caution{color:#faad14;font-weight:bold}
.lifecycle-fail{color:#ff4d4f;font-weight:bold}
</style></head><body>
<h1>ASIN 价格 & 排名生命周期趋势分析</h1>
<div class="info">
  数据来源：Oalur 价格排名趋势导出 | ${asinData.length} 个 ASIN | 报告生成：${new Date().toISOString().replace('T', ' ').substring(0, 16)}
</div>
<div class="card">
  <h2>汇总</h2>
  <table>
    <tr><th>ASIN</th><th>价格变化</th><th>大类 BSR 变化</th><th>Ratings 变化</th><th>增速</th><th>生命周期</th></tr>
    ${cleanSummaryRows}
  </table>
</div>
<div class="card" style="background:#f0f5ff;">
  <h2>知识库生命周期判定标准</h2>
  <div style="font-size:13px;line-height:2.0;color:#555;">
    <p>1. <strong>价格后半段 &lt; 前半段 × 0.93</strong>：价格下行，可能进入成熟后期或衰退期。</p>
    <p>2. <strong>大类 BSR 后半段 &gt; 前半段 × 1.15</strong>：大类排名下滑，竞争力下降；大类 BSR 缺失时不参与该项统计。</p>
    <p>3. <strong>评论月增速显著放缓</strong>：成熟期后段信号。</p>
    <p>4. <strong>均价持续走低 + 头部评论增量放缓</strong>：通常意味着价格内卷和生命周期下行。</p>
  </div>
</div>
${cleanAsinCardsHtml}
<script>
${cleanChartsJs}
</script>
</body></html>`;
fs.writeFileSync(cleanOutPath, directCleanHtml, 'utf-8');
console.log(`\n✅ 合并报告已保存: ${outPath}`);
console.log(`   📊 包含 ${asinData.length} 个 ASIN 的趋势图表`);

// 额外保存生命周期摘要 JSON（供 generate-report.js 主报告使用）
const lifecycleJsonPath = jsonOutParam ||
  path.join(dirs.data, `${filePrefix}-asin-lifecycle.json`);
const lifecycleSummary = asinData.map(d => ({
  asin: d.asin,
  lifecycle: d.lifecycle.replace(/^[✅⚠️➡️]\s*/, ''),
  lifecycleClass: d.cls,
  priceFirst: d.firstP.buyboxPrice,
  priceLast: d.lastP.buyboxPrice,
  priceMax: d.maxPrice,
  priceMin: d.minPrice,
  bsrFirst: d.firstB?.mainBsr || 0,
  bsrLast: d.lastB?.mainBsr || 0,
  bsrBest: d.minBsr,
  ratingsFirst: d.firstR?.ratingsNum || 0,
  ratingsLast: d.lastR?.ratingsNum || 0,
  ratingPerMonth: d.ratingPerMonth,
  avgPriceFirst: d.avgPriceFirst,
  avgPriceSecond: d.avgPriceSecond,
  avgBsrFirst: Math.round(d.avgBsrFirst),
  avgBsrSecond: Math.round(d.avgBsrSecond)
}));
fs.mkdirSync(path.dirname(lifecycleJsonPath), { recursive: true });
fs.writeFileSync(lifecycleJsonPath, JSON.stringify({ asins, analyzedAt: new Date().toISOString(), products: lifecycleSummary }, null, 2));
const normalizedLifecycleSummary = lifecycleSummary.map(p => ({
  ...p,
  lifecycle: normalizeLifecycle(p.lifecycle)
}));
fs.writeFileSync(lifecycleJsonPath, JSON.stringify({ asins, analyzedAt: new Date().toISOString(), products: normalizedLifecycleSummary }, null, 2), 'utf-8');
console.log(`生命周期摘要: ${lifecycleJsonPath}`);
console.log(`📋 生命周期摘要: ${lifecycleJsonPath}`);
