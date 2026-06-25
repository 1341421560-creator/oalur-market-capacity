/**
 * Extract Oalur ASIN trends.
 *
 * Default mode reads each ASIN tab's own XHR responses directly:
 * - basicInfo
 * - dataTrends
 * - keepaTrends
 * - bsrTrends
 *
 * This avoids Excel download pairing issues. Use --excel only as an explicit fallback.
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { activatePage } = require('./browser-page-utils');

const OALUR_ASIN_SEARCH_URL = 'https://vip.oalur.com/insight/product/search?site=US';
const OALUR_NAV_TIMEOUT_MS = 30000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function todayString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function safeSegment(value) {
  return String(value || 'output').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function outputDirs(taskName) {
  const date = todayString();
  const root = path.join(process.cwd(), 'output', `${date}-${safeSegment(taskName)}`);
  return {
    root,
    data: path.join(root, 'data'),
    reports: path.join(root, 'reports'),
    excel: path.join(root, 'excel')
  };
}

function outputDirsFromOutFile(outFile, fallbackTaskName) {
  if (!outFile) return outputDirs(fallbackTaskName);
  const outDir = path.dirname(path.normalize(outFile));
  if (path.basename(outDir).toLowerCase() === 'data') {
    const root = path.dirname(outDir);
    return {
      root,
      data: path.join(root, 'data'),
      reports: path.join(root, 'reports'),
      excel: path.join(root, 'excel')
    };
  }
  return outputDirs(fallbackTaskName);
}

const asinArg = process.argv[2];
const requestedOutFile = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
const useExcelFallback = process.argv.includes('--excel');
const reportOnly = process.argv.includes('--report-only');
const ASIN_TREND_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.OALUR_ASIN_TREND_CONCURRENCY || 5)));

if (!asinArg) {
  console.error('Usage: node extract-asin-trends.js "ASIN1,ASIN2,..." [output.json] [--excel]');
  process.exit(1);
}

const asins = asinArg.split(',').map(s => s.trim()).filter(Boolean);
const taskName = asins.slice(0, 3).join('-') || 'asin-trends';
const dirs = outputDirsFromOutFile(requestedOutFile, taskName);
const outFile = requestedOutFile || path.join(dirs.data, 'asin-trends.json');
const DOWNLOAD_DIR = process.env.OALUR_DOWNLOAD_DIR || dirs.excel;
const BROWSER_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

async function gotoOalurAsinSearch(page, asin) {
  try {
    await activatePage(page);
    await page.goto(OALUR_ASIN_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: OALUR_NAV_TIMEOUT_MS });
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('timeout')) {
      console.error(`ERROR: ASIN ${asin} navigation timed out after 30s. Stop this ASIN and report to user.`);
    }
    throw error;
  }
}

function relPath(filePath) {
  return path.relative(process.cwd(), filePath) || '.';
}

function reportPrefixFromRoot(root) {
  return path.basename(root).replace(/^\d{4}-\d{2}-\d{2}-/, '') || taskName;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[$,#,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pairSeries(dates = [], values = [], key) {
  const out = [];
  for (let i = 0; i < Math.min(dates.length, values.length); i++) {
    const value = parseNumber(values[i]);
    if (value === null || value <= 0) continue;
    out.push({ date: dates[i], [key]: value });
  }
  return out;
}

function extractMainBsr(bsrData) {
  const history = bsrData?.bsrAllHistory || {};
  const dates = history.dates || [];
  const topId = bsrData?.top?.[0]?.categoryId;
  if (!topId || !Array.isArray(history[topId])) return [];
  return pairSeries(dates, history[topId], 'mainBsr');
}

function normalizeMonthlyTrend(data) {
  const months = data?.dates || [];
  const monthlySales = data?.saleVolume || [];
  const monthlyRevenue = data?.salesNumber || [];
  if (!months.length) return null;
  return { months, monthlySales, monthlyRevenue, avgPrice: [] };
}

function lifecycleFromSeries(asin, product, directTrendData) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 4);
  cutoff.setDate(3);
  const cutoffStr = cutoff.toISOString().substring(0, 10);

  const priceData = (directTrendData?.priceData || []).filter(d => d.date >= cutoffStr && d.buyboxPrice != null);
  const ratingsData = (directTrendData?.ratingsData || []).filter(d => d.date >= cutoffStr && d.ratingsNum != null);
  const bsrData = (directTrendData?.bsrData || []).filter(d => d.date >= cutoffStr && d.mainBsr != null);

  if (!priceData.length) return null;

  const firstP = priceData[0];
  const lastP = priceData[priceData.length - 1];
  const firstR = ratingsData[0] || null;
  const lastR = ratingsData[ratingsData.length - 1] || null;
  const firstB = bsrData[0] || null;
  const lastB = bsrData[bsrData.length - 1] || null;

  const prices = priceData.map(d => d.buyboxPrice);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);

  const bsrs = bsrData.map(d => d.mainBsr);
  const minBsr = bsrs.length ? Math.min(...bsrs) : 0;
  const maxBsr = bsrs.length ? Math.max(...bsrs) : 0;

  const ratingIncrease = firstR && lastR ? lastR.ratingsNum - firstR.ratingsNum : 0;
  const daysDiff = priceData.length;
  const ratingPerMonth = daysDiff > 0 ? (ratingIncrease / (daysDiff / 30)).toFixed(1) : '0';

  const mid = Math.floor(priceData.length / 2);
  const firstHalf = priceData.slice(0, mid);
  const secondHalf = priceData.slice(-mid);
  const avgPriceFirst = firstHalf.reduce((s, d) => s + d.buyboxPrice, 0) / Math.max(1, firstHalf.length);
  const avgPriceSecond = secondHalf.reduce((s, d) => s + d.buyboxPrice, 0) / Math.max(1, secondHalf.length);

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
  const ratingsSlow = growthFirst > 0 && growthLast < growthFirst * 0.5;
  const lifecycleRisks = [
    priceDown ? '价格下行≥7%' : null,
    bsrUp ? '大类BSR恶化≥15%' : null,
    ratingsSlow ? 'Ratings增速放缓≥50%' : null
  ].filter(Boolean);
  const lifecycleScore = lifecycleRisks.length === 0 ? 5 : lifecycleRisks.length === 1 ? 3 : lifecycleRisks.length === 2 ? 1 : 0;

  let lifecycle = '健康成熟';
  let cls = 'pass';
  if (priceDown && bsrUp) { lifecycle = '衰退期'; cls = 'fail'; }
  else if (priceDown) { lifecycle = '成熟后期'; cls = 'caution'; }
  else if (bsrUp) { lifecycle = '排名下滑'; cls = 'caution'; }
  else if (ratingsSlow) { lifecycle = '成熟期'; cls = 'pass'; }
  return {
    asin,
    title: product.title || '',
    brand: product.brand || '',
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
    growthFirst, growthLast,
    lifecycleScore, lifecycleRisks
  };
}

async function navigateAndOpenTrends(page, asin) {
  await gotoOalurAsinSearch(page, asin);
  await sleep(3000);

  await page.evaluate((value) => {
    const input =
      document.querySelector('input[placeholder*="2000"]') ||
      document.querySelector('input[placeholder*="支持"]');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, asin);
  await sleep(500);

  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.innerText.trim() === '立即查询') {
        button.click();
        return;
      }
    }
  });
  await sleep(6000);

  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.innerText.trim() === '数据趋势') {
        button.click();
        return;
      }
    }
  });
  await sleep(8000);

  await page.evaluate(() => {
    const dialog = document.querySelector('.el-dialog');
    if (!dialog) return;
    for (const item of dialog.querySelectorAll('.el-tabs__item')) {
      if (item.innerText.trim() === '价格&排名趋势') {
        item.click();
        return;
      }
    }
  });
}

async function extractDirect(browser, asin, index, total) {
  const page = await browser.newPage();
  await activatePage(page);
  const state = { basicInfo: null, salesTrend: null, keepaTrend: null, bsrTrend: null };

  page.on('response', async response => {
    const url = response.url();
    if (!url.includes(asin)) return;
    if (!/basicInfo|dataTrends|keepaTrends|bsrTrends/.test(url)) return;
    try {
      const json = JSON.parse(await response.text());
      if (url.includes('basicInfo')) state.basicInfo = json.data;
      if (url.includes('type=SALES_VOLUME')) state.salesTrend = json.data;
      if (url.includes('keepaTrends')) state.keepaTrend = json.data;
      if (url.includes('bsrTrends')) state.bsrTrend = json.data;
    } catch {}
  });

  console.log(`\n[${index + 1}/${total}] ASIN ${asin}: direct XHR read`);
  try {
    await navigateAndOpenTrends(page, asin);
    for (let i = 0; i < 20; i++) {
      if (state.keepaTrend && state.bsrTrend && state.salesTrend) break;
      await sleep(1000);
    }

    const keepaDates = state.keepaTrend?.dates || [];
    const directTrendData = {
      priceData: pairSeries(keepaDates, state.keepaTrend?.price || [], 'buyboxPrice'),
      ratingsData: pairSeries(keepaDates, state.keepaTrend?.ratingNum || [], 'ratingsNum'),
      bsrData: extractMainBsr(state.bsrTrend)
    };
    const trendData = normalizeMonthlyTrend(state.salesTrend);
    const product = {
      asin,
      title: state.basicInfo?.title || state.basicInfo?.name || '',
      brand: state.basicInfo?.brand || '',
      trendData,
      directTrendData,
      totalMonths: trendData?.months?.length || 0,
      extractionMode: 'xhr'
    };

    console.log(`  price=${directTrendData.priceData.length}, ratings=${directTrendData.ratingsData.length}, bsr=${directTrendData.bsrData.length}, salesMonths=${product.totalMonths}`);
    return product;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

function trendRows(item) {
  const byDate = new Map();
  for (const p of item.priceData) byDate.set(p.date, { date: p.date, price: p.buyboxPrice });
  for (const r of item.ratingsData) byDate.set(r.date, { ...(byDate.get(r.date) || { date: r.date }), ratings: r.ratingsNum });
  for (const b of item.bsrData) byDate.set(b.date, { ...(byDate.get(b.date) || { date: b.date }), bsr: b.mainBsr });
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-500)
    .map(row => `<tr><td>${row.date}</td><td>${row.price == null ? '-' : '$' + Number(row.price).toFixed(2)}</td><td>${row.ratings == null ? '-' : Number(row.ratings).toLocaleString()}</td><td>${row.bsr == null ? '-' : '#' + Number(row.bsr).toLocaleString()}</td></tr>`)
    .join('\n');
}

function generateDirectLifecycleReport(lifecycleItems, lifecycleJsonPath) {
  const today = todayString();
  const filePrefix = reportPrefixFromRoot(dirs.root);
  const reportPath = path.join(dirs.reports, `${today}_${filePrefix}_ASIN生命周期趋势分析.html`);
  fs.mkdirSync(dirs.reports, { recursive: true });

  const summaryRows = lifecycleItems.map(d => `<tr>
    <td><a href="https://www.amazon.com/dp/${d.asin}" target="_blank">${d.asin}</a></td>
    <td>$${d.firstP.buyboxPrice.toFixed(2)} → $${d.lastP.buyboxPrice.toFixed(2)}</td>
    <td>${d.firstB ? '#' + d.firstB.mainBsr.toLocaleString() : '-'} → ${d.lastB ? '#' + d.lastB.mainBsr.toLocaleString() : '-'}</td>
    <td>${d.firstR ? d.firstR.ratingsNum.toLocaleString() : '-'} → ${d.lastR ? d.lastR.ratingsNum.toLocaleString() : '-'}</td>
    <td>${d.lifecycleScore}/5</td>
    <td>${d.lifecycleRisks.length ? d.lifecycleRisks.join('；') : '未命中明显风险'}</td>
    <td class="${d.cls}">${d.lifecycle}</td>
  </tr>`).join('\n');
  const avgLifecycleScore = lifecycleItems.length
    ? lifecycleItems.reduce((s, d) => s + d.lifecycleScore, 0) / lifecycleItems.length
    : 0;
  const severeLifecycleCount = lifecycleItems.filter(d => d.lifecycleScore <= 1).length;

  const cards = lifecycleItems.map((d, idx) => `<section class="card">
    <h2>${d.asin} <span class="${d.cls}">${d.lifecycle}</span></h2>
    <div class="metrics">
      <div><b>$${d.lastP.buyboxPrice.toFixed(2)}</b><span>当前价格</span></div>
      <div><b>${d.lastR ? d.lastR.ratingsNum.toLocaleString() : '-'}</b><span>Ratings</span></div>
      <div><b>${d.lastB ? '#' + d.lastB.mainBsr.toLocaleString() : '-'}</b><span>大类 BSR</span></div>
    </div>
    <div class="charts">
      <div class="chart-card"><h3>Buybox 价格日趋势</h3><canvas id="price${idx}"></canvas></div>
      <div class="chart-card"><h3>Ratings 日趋势</h3><canvas id="ratings${idx}"></canvas></div>
      <div class="chart-card"><h3>大类 BSR 日趋势</h3><canvas id="bsr${idx}"></canvas></div>
    </div>
    <details><summary>查看 ${d.asin} 明细数据表（价格 / Ratings / 大类 BSR）</summary>
      <table><tr><th>日期</th><th>Buybox 价格</th><th>Ratings</th><th>大类 BSR</th></tr>${trendRows(d)}</table>
    </details>
  </section>`).join('\n');

  const chartJs = lifecycleItems.map((d, idx) => `
    renderLineChart('price${idx}', 'Buybox 价格 ($)', ${JSON.stringify(d.priceData.map(p => ({ x: p.date, y: p.buyboxPrice })))}, '#1677ff', false);
    renderLineChart('ratings${idx}', 'Ratings', ${JSON.stringify(d.ratingsData.map(r => ({ x: r.date, y: r.ratingsNum })))}, '#16a34a', false);
    renderLineChart('bsr${idx}', '大类 BSR', ${JSON.stringify(d.bsrData.map(b => ({ x: b.date, y: b.mainBsr })))}, '#7c3aed', true);
  `).join('\n');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${filePrefix} ASIN 生命周期趋势分析</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3"></script>
  <style>
    body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#f5f7fb;color:#222;margin:0;padding:24px}
    h1{margin:0 0 16px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:18px;margin:16px 0}
    h2{margin:0 0 12px}h3{font-size:14px;margin:0 0 10px;color:#334155}
    table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #e5e7eb;padding:8px;text-align:left}th{background:#f8fafc}
    .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}.metrics div{background:#f8fafc;border-radius:6px;padding:10px}.metrics span{display:block;color:#666;font-size:12px;margin-top:4px}
    .charts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.chart-card{border:1px solid #e5e7eb;border-radius:8px;padding:12px;background:#fff}.chart-card canvas{width:100%!important;height:240px!important}
    .pass{color:#15803d;font-weight:700}.caution{color:#b45309;font-weight:700}.fail{color:#b91c1c;font-weight:700}
    details{margin-top:12px;max-height:420px;overflow:auto}
    @media (max-width: 980px){.charts,.metrics{grid-template-columns:1fr}}
  </style></head><body>
  <h1>ASIN 价格 & 排名生命周期趋势分析</h1>
  <p>数据来源：Oalur 当前页面 XHR 直读（keepaTrends / bsrTrends / dataTrends），未导出 Excel。生命周期摘要：${relPath(lifecycleJsonPath)}</p>
  <section class="card"><h2>汇总</h2>
    <p>整体生命周期得分：<strong>${avgLifecycleScore.toFixed(1)}/5</strong>；严重风险 ASIN：<strong>${severeLifecycleCount}</strong> 个。</p>
    <table><tr><th>ASIN</th><th>价格变化</th><th>大类 BSR 变化</th><th>Ratings 变化</th><th>得分</th><th>命中风险</th><th>生命周期</th></tr>${summaryRows}</table>
  </section>
  <section class="card"><h2>知识库生命周期判定标准</h2>
    <p>每个 ASIN 满分 5 分：未命中风险=5分；命中1项=3分；命中2项=1分；命中3项=0分。</p>
    <p>1. 价格后半段低于前半段 7% 以上：价格下行，可能进入成熟后期或衰退期。</p>
    <p>2. 大类 BSR 后半段高于前半段 15% 以上：大类排名下滑，竞争力下降；大类 BSR 缺失时不参与该项统计。</p>
    <p>3. Ratings 月增速后半段比前半段放缓 50% 以上：成熟期后段信号。</p>
  </section>
  ${cards}
  <script>
    function renderLineChart(id, label, data, color, reverseY) {
      const el = document.getElementById(id);
      if (!el) return;
      new Chart(el, {
        type: 'line',
        data: { datasets: [{ label, data, borderColor: color, backgroundColor: color + '22', pointRadius: 0, borderWidth: 1.8, tension: 0.25, fill: false }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: true, labels: { boxWidth: 12 } } },
          scales: {
            x: { type: 'time', time: { unit: 'month' }, ticks: { maxRotation: 0 } },
            y: { reverse: reverseY, beginAtZero: false }
          }
        }
      });
    }
    ${chartJs}
  </script></body></html>`;
  fs.writeFileSync(reportPath, html, 'utf-8');
  console.log(`Direct lifecycle report saved: ${relPath(reportPath)}`);
}
function saveLifecycle(products) {
  const lifecycleItems = products
    .map(p => lifecycleFromSeries(p.asin, p, p.directTrendData))
    .filter(Boolean);
  const lifecycleJsonPath = outFile.endsWith('-asin-trends.json')
    ? outFile.replace(/-asin-trends\.json$/, '-asin-lifecycle.json')
    : path.join(path.dirname(outFile), 'asin-lifecycle.json');
  const lifecycleSummary = lifecycleItems.map(d => ({
    asin: d.asin,
    lifecycle: d.lifecycle,
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
    avgBsrSecond: Math.round(d.avgBsrSecond),
    growthFirst: d.growthFirst,
    growthLast: d.growthLast,
    lifecycleScore: d.lifecycleScore,
    lifecycleRisks: d.lifecycleRisks
  }));
  fs.writeFileSync(lifecycleJsonPath, JSON.stringify({ asins, analyzedAt: new Date().toISOString(), mode: 'xhr', products: lifecycleSummary }, null, 2), 'utf-8');
  generateDirectLifecycleReport(lifecycleItems, lifecycleJsonPath);
  console.log(`Lifecycle summary saved: ${relPath(lifecycleJsonPath)} | ${lifecycleSummary.length} ASIN`);
}

function runExcelFallback() {
  const combinedScript = path.join(__dirname, 'generate-asin-trends-combined.js');
  const lifecycleJsonPath = outFile.endsWith('-asin-trends.json')
    ? outFile.replace(/-asin-trends\.json$/, '-asin-lifecycle.json')
    : path.join(path.dirname(outFile), 'asin-lifecycle.json');
  if (!fs.existsSync(combinedScript)) return;
  const reportPrefix = reportPrefixFromRoot(dirs.root);
  execSync(
    `node "${combinedScript}" "${asinArg}" "${reportPrefix}" --json-out "${lifecycleJsonPath}"`,
    { stdio: 'inherit', timeout: 60000, env: { ...process.env, OALUR_DOWNLOAD_DIR: DOWNLOAD_DIR } }
  );
}

(async () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`ASIN trend extraction: ${asins.length} ASIN | mode=${useExcelFallback ? 'excel-fallback' : 'xhr-direct'}`);
  console.log('='.repeat(50));
  console.log(`Output JSON: ${relPath(outFile)}`);

  if (reportOnly) {
    if (!fs.existsSync(outFile)) {
      throw new Error(`Report-only mode requires existing trend JSON: ${relPath(outFile)}`);
    }
    const existing = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    saveLifecycle(existing.products || []);
    return;
  }

  if (useExcelFallback) {
    console.log(`Excel fallback requested. Excel dir: ${relPath(DOWNLOAD_DIR)}`);
    runExcelFallback();
    return;
  }

  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null, protocolTimeout: 600000 });
  console.log(`Direct XHR concurrency: ${ASIN_TREND_CONCURRENCY} tabs`);
  let results = await runPool(asins, ASIN_TREND_CONCURRENCY, async (asin, i) => {
    await sleep((i % ASIN_TREND_CONCURRENCY) * 500);
    return extractDirect(browser, asin, i, asins.length);
  });

  const failed = results.filter(product =>
    !product.trendData ||
    !product.directTrendData?.priceData?.length ||
    !product.directTrendData?.ratingsData?.length ||
    !product.directTrendData?.bsrData?.length
  );

  if (failed.length) {
    console.log(`\nRetry ${failed.length} ASIN with incomplete direct data...`);
    for (const product of failed) {
      const idx = asins.indexOf(product.asin);
      if (idx < 0) continue;
      results[idx] = await extractDirect(browser, product.asin, idx + 0.5, asins.length);
    }
  }

  await browser.disconnect();

  const output = {
    asins,
    extractedAt: new Date().toISOString(),
    mode: 'xhr',
    products: results
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nData saved: ${relPath(outFile)}`);
  console.log(`Direct trends: ${results.filter(p => p.directTrendData?.priceData?.length && p.directTrendData?.bsrData?.length).length}/${results.length} ASIN`);
  console.log(`Sales trends: ${results.filter(p => p.trendData?.months?.length).length}/${results.length} ASIN`);

  saveLifecycle(results);
})().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});

