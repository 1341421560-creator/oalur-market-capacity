const fs = require('fs');
const path = require('path');

function safeSegment(value) {
  return String(value || 'output').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function outputDirs(taskName) {
  const date = localDateString();
  const root = path.join(process.cwd(), 'output', `${date}-${safeSegment(taskName)}`);
  return {
    root,
    reports: path.join(root, 'reports')
  };
}

function outputDirsFromDataFile(filePath, taskName) {
  const dataDir = path.resolve(path.dirname(filePath));
  if (path.basename(dataDir).toLowerCase() === 'data') {
    const root = path.dirname(dataDir);
    return {
      root,
      reports: path.join(root, 'reports')
    };
  }
  return outputDirs(taskName);
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

function productTitle(d) {
  return d?.title || d?.productTitle || d?.productName || d?.name || d?.itemName || d?.asin || '无标题';
}

// 璇诲彇鏁版嵁鏂囦欢锛堟敮鎸佺粷瀵硅矾寰勬垨鐩稿褰撳墠宸ョ▼ output 鐩綍鐨勮矾寰勶級
const dataFile = process.argv[2];
if (!dataFile) { console.error('鐢ㄦ硶: node generate-report.js <鏁版嵁鏂囦欢.json> [--seasonality <瀛ｈ妭鎬ф暟鎹?json>] [--historical <鍘嗗彶鏁版嵁.json>] [--asin-lifecycle <鐢熷懡鍛ㄦ湡.json>]'); process.exit(1); }
const resolvedDataPath = path.isAbsolute(dataFile) ? dataFile : path.join(process.cwd(), dataFile);
const jsonData = JSON.parse(fs.readFileSync(resolvedDataPath, 'utf-8'));

// 鍙€夌殑瀛ｈ妭鎬т笌鐢熷懡鍛ㄦ湡鍒嗘瀽鏁版嵁
const seasonalityIdx = process.argv.indexOf('--seasonality');
const seasonalityFile = seasonalityIdx > -1 ? process.argv[seasonalityIdx + 1] : null;
let seasonalityData = null;
if (seasonalityFile && fs.existsSync(seasonalityFile)) {
  seasonalityData = JSON.parse(fs.readFileSync(seasonalityFile, 'utf-8'));
  console.log('馃搨 宸插姞杞藉鑺傛€ф暟鎹?', seasonalityFile);
}

// 鍙€夌殑 6 涓湀鍓嶅巻鍙叉暟鎹紙鐢ㄤ簬鏂板搧瀛樻椿鐜囪绠楋級
const historicalIdx = process.argv.indexOf('--historical');
const historicalFile = historicalIdx > -1 ? process.argv[historicalIdx + 1] : null;
let historicalData = null;
let survivalRateData = null;
if (historicalFile && fs.existsSync(historicalFile)) {
  historicalData = JSON.parse(fs.readFileSync(historicalFile, 'utf-8'));
  console.log('馃搨 宸插姞杞藉巻鍙叉暟鎹?', historicalFile, '| 鏃堕棿:', historicalData.timeFilter);
  // 校验历史数据时间是否接近期望的 6 个月前月份。
  const histTime = historicalData.timeFilter || '';
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const expectedYear = sixMonthsAgo.getFullYear();
  const expectedMonth = String(sixMonthsAgo.getMonth() + 1).padStart(2, '0');
  const expectedChineseMonth = `${expectedYear}年${parseInt(expectedMonth, 10)}月`;
  if (!histTime.includes(expectedChineseMonth)) {
    console.warn(`警告：历史数据时间 ${histTime} 与预期 6 个月前（${expectedChineseMonth}）不一致，请确认是否需要重新抓取。`);
  }
}

// 鍙€夌殑 ASIN 鐢熷懡鍛ㄦ湡鍒嗘瀽鏁版嵁
const lifecycleIdx = process.argv.indexOf('--asin-lifecycle');
const lifecycleFile = lifecycleIdx > -1 ? process.argv[lifecycleIdx + 1] : null;
let lifecycleData = null;
if (lifecycleFile && fs.existsSync(lifecycleFile)) {
  lifecycleData = JSON.parse(fs.readFileSync(lifecycleFile, 'utf-8'));
  console.log('馃搨 宸插姞杞界敓鍛藉懆鏈熸暟鎹?', lifecycleFile, '|', lifecycleData.products?.length || 0, '涓?ASIN');
}

const data = jsonData.data;
const excluded = jsonData.excluded || [];
const total = jsonData.total;
const TODAY = new Date();
const REPORT_DATE = localDateString(TODAY);

const rawTotal = jsonData.rawTotal || data.length;

// Parse listing age. Prefer listingAge, fall back to listingDate.
function parseAge(d) {
  if (d.listingAge) {
    const y = d.listingAge.match(/(\d+)\s*年/);
    const m = d.listingAge.match(/(\d+)\s*月/);
    return (y ? parseInt(y[1]) : 0) * 12 + (m ? parseInt(m[1]) : 0);
  }
  if (d.listingDate) {
    const listed = new Date(d.listingDate);
    let months = (TODAY.getFullYear() - listed.getFullYear()) * 12 + (TODAY.getMonth() - listed.getMonth());
    if (TODAY.getDate() < listed.getDate()) months -= 1;
    return Math.max(0, months);
  }
  return -1;
}

function formatAge(d) {
  const months = parseAge(d);
  if (months < 0) return d.listingDate || '--';
  if (months < 12) return months + '个月';
  return (months / 12).toFixed(1) + '年';
}

// BSR distribution, using 1000-rank intervals.
const bsrMax = parseInt((jsonData.bsrRange || '1-10000').split('-')[1]) || 10000;
const bsrInterval = 1000;
const bsrSegmentCount = Math.ceil(bsrMax / bsrInterval);
const bsrRanges = [];
for (let i = 0; i < bsrSegmentCount; i++) {
  const start = i * bsrInterval;
  const end = (i + 1) * bsrInterval;
  bsrRanges.push({ label: `${start}-${end}`, min: start, max: end });
}
const bsrDist = bsrRanges.map(r => ({ label: r.label, count: data.filter(d => d.bsr >= r.min && d.bsr <= r.max).length }));

// 涓婃灦鏃堕棿鍒嗗竷
const ageRanges = [
  { label: '0-6个月', min: 0, max: 6 },
  { label: '6-12个月', min: 6, max: 12 },
  { label: '1-2年', min: 12, max: 24 },
  { label: '2-3年', min: 24, max: 36 },
  { label: '3-5年', min: 36, max: 60 },
  { label: '5年以上', min: 60, max: 999 },
];
const ageDist = ageRanges.map(r => ({ label: r.label, count: data.filter(d => { const m = parseAge(d); return m >= r.min && m < r.max; }).length }));

// 浠锋牸鍒嗗竷
const priceRanges = [
  { label: '$0-5', min: 0, max: 5 },
  { label: '$5-10', min: 5, max: 10 },
  { label: '$10-15', min: 10, max: 15 },
  { label: '$15-20', min: 15, max: 20 },
  { label: '$20+', min: 20, max: 9999 },
];
const priceDist = priceRanges.map(r => ({ label: r.label, count: data.filter(d => { const p = parseFloat((d.price || '').replace('$', '')); return !isNaN(p) && p >= r.min && p < r.max; }).length }));

// 鍝佺墝
const brandCount = {};
data.forEach(d => { if (d.brand) brandCount[d.brand] = (brandCount[d.brand] || 0) + 1; });
const topBrands = Object.entries(brandCount).sort((a, b) => b[1] - a[1]).slice(0, 10);

// 鍗栧绫诲瀷
const sellerCount = {};
data.forEach(d => {
  const st = d.sellerType?.includes('亚马逊') ? '亚马逊自营' : d.sellerType?.includes('FBA') ? 'FBA' : d.sellerType?.includes('FBM') ? 'FBM' : '其他';
  sellerCount[st] = (sellerCount[st] || 0) + 1;
});

// 鏂板搧
const newProductsData = data.filter(d => { const m = parseAge(d); return m >= 0 && m < 6; });
const newProducts = newProductsData.length;
const newPct = data.length > 0 ? ((newProducts / data.length) * 100).toFixed(1) : '0';

// ============ 鏂板搧瀛樻椿鐜囷紙6涓湀锛?===========
if (historicalData && historicalData.data) {
  // Parse historical timeFilter such as "2025年12月".
  const tfMatch = (historicalData.timeFilter || '').match(/(\d{4})年(\d{1,2})月/);
  if (tfMatch) {
    const histYear = parseInt(tfMatch[1]);
    const histMonth = parseInt(tfMatch[2]);
    const histDate = new Date(histYear, histMonth - 1, 15); // 鏈堜腑浣滀负鍙傝€冪偣
    const sixMonthsBeforeHist = new Date(histDate);
    sixMonthsBeforeHist.setMonth(sixMonthsBeforeHist.getMonth() - 6);

    // Historical products listed within the six months before the historical snapshot.
    const histNewProducts = historicalData.data.filter(d => {
      if (!d.listingDate) return false;
      const listed = new Date(d.listingDate);
      return listed >= sixMonthsBeforeHist && listed <= histDate;
    });

    // 褰撳墠鏁版嵁鐨?ASIN 闆嗗悎
    const currentAsins = new Set(data.map(d => d.asin).filter(Boolean));

    // Historical new products that still survive in the current BSR range.
    const surviving = histNewProducts.filter(d => d.asin && currentAsins.has(d.asin));

    const hasHistoricalNewProducts = histNewProducts.length > 0;

    if (hasHistoricalNewProducts) {
      const survivalRate = ((surviving.length / histNewProducts.length) * 100).toFixed(1);

      // 鐢熸垚瀛樻椿 ASIN 闆嗗悎鏂逛究鏌ヨ
      const survivingSet = new Set(surviving.filter(d => d.asin).map(d => d.asin));

      // 褰撴椂鏂板搧鐨勮鎯呭垪琛紙鍚瓨娲荤姸鎬侊級
      const histNewProductList = histNewProducts.map(d => ({
        asin: d.asin || '-',
        brand: d.brand || '-',
        listingDate: d.listingDate || d.listingAge || '--',
        survived: d.asin ? survivingSet.has(d.asin) : false,
        currentSales: d.asin && currentAsins.has(d.asin) ? parseSalesNum(d) : '-'
      })).sort((a, b) => (b.survived ? 1 : 0) - (a.survived ? 1 : 0));

      const histNewRows = histNewProductList.map(p =>
        `<tr><td><a href="https://www.amazon.com/dp/${p.asin}" target="_blank">${p.asin}</a></td><td>${p.brand}</td><td>${p.listingDate}</td><td>${p.survived ? '存活' : '已淘汰'}</td></tr>`
      ).join('\n');

      survivalRateData = {
        historicalPeriod: historicalData.timeFilter,
        histNewCount: histNewProducts.length,
        survivingCount: surviving.length,
        survivalRate: parseFloat(survivalRate),
        survivalRateStr: survivalRate + '%',
        hasNoNewProducts: false,
        // 鍒ゅ畾锛氱煡璇嗗簱鏍囧噯
        level: parseFloat(survivalRate) >= 60 ? '非常健康' :
               parseFloat(survivalRate) >= 35 ? '正常' :
               parseFloat(survivalRate) >= 25 ? '有竞争压力' : '头部压制严重',
        levelClass: parseFloat(survivalRate) >= 60 ? 'pass' :
                    parseFloat(survivalRate) >= 35 ? 'pass' :
                    parseFloat(survivalRate) >= 25 ? 'caution' : 'fail',
        histNewRows: histNewRows,
        histNewCountActual: histNewProductList.length
      };

      console.log(`\n馃啎 鏂板搧瀛樻椿鐜囧垎鏋?`);
      console.log(`  鍘嗗彶鏃堕棿: ${historicalData.timeFilter}`);
      console.log(`  当时新品: ${histNewProducts.length} 个`);
      console.log(`  仍存活: ${surviving.length} 个`);
      console.log(`  存活率: ${survivalRate}%（${survivalRateData.level}）`);
    } else {
      // 璇?BSR 鑼冨洿鍐呮棤鏂板搧锛屽瓨娲荤巼涓嶉€傜敤
      survivalRateData = {
        historicalPeriod: historicalData.timeFilter,
        histNewCount: 0,
        survivingCount: 0,
        survivalRate: null,
        survivalRateStr: '新品不存在',
        hasNoNewProducts: true,
        level: '新品不存在',
        levelClass: 'info',
        histNewRows: '',
        histNewCountActual: 0
      };

      console.log(`\n馃啎 鏂板搧瀛樻椿鐜囧垎鏋?`);
      console.log(`  鍘嗗彶鏃堕棿: ${historicalData.timeFilter}`);
      console.log(`  璇?BSR 鑼冨洿鍐呮棤鏂板搧锛堜笂鏋?<6 涓湀锛夛紝瀛樻椿鐜囦笉閫傜敤`);
    }
  }
}

// 閿€閲忕粺璁★紙鎵€鏈変骇鍝侊紝涓嶆帓闄?0 鍊硷級
const totalSales = data.reduce((s, d) => s + parseSalesNum(d), 0);
const allSalesNums = data.map(parseSalesNum).sort((a, b) => a - b);
const salesMedian = allSalesNums.length > 0 ? (allSalesNums.length % 2 !== 0 ? allSalesNums[Math.floor(allSalesNums.length / 2)] : (allSalesNums[allSalesNums.length / 2 - 1] + allSalesNums[allSalesNums.length / 2]) / 2) : 0;
const salesAvg = allSalesNums.length > 0 ? Math.round(allSalesNums.reduce((a, b) => a + b, 0) / allSalesNums.length) : 0;
const salesMax = allSalesNums.length > 0 ? Math.max(...allSalesNums) : 0;
const salesMin = allSalesNums.length > 0 ? Math.min(...allSalesNums) : 0;

// 閿€鍞缁熻锛堢編鍏冿級
const allRevNums = data.map(d => parseRevenue(d)).sort((a, b) => a - b);
const revMedian = allRevNums.length > 0 ? (allRevNums.length % 2 !== 0 ? allRevNums[Math.floor(allRevNums.length / 2)] : (allRevNums[allRevNums.length / 2 - 1] + allRevNums[allRevNums.length / 2]) / 2) : 0;
const revAvg = allRevNums.length > 0 ? allRevNums.reduce((a, b) => a + b, 0) / allRevNums.length : 0;
const revMax = allRevNums.length > 0 ? Math.max(...allRevNums) : 0;
const revMin = allRevNums.length > 0 ? Math.min(...allRevNums) : 0;
const totalRev = allRevNums.reduce((a, b) => a + b, 0);

// Profit quick screening from Oalur FBA & margin fields.
const profitDetails = data.map(d => {
  const parsed = parseFbaMargin(d);
  const priceNum = parsePriceNum(d);
  const salesNum = parseSalesNum(d);
  const fbaRatio = parsed.fbaFee != null && priceNum > 0 ? (parsed.fbaFee / priceNum * 100) : null;
  let status = '毛利率缺失';
  let statusClass = 'caution';
  if (parsed.marginPct != null) {
    if (parsed.marginPct >= 40) {
      status = '稳健';
      statusClass = 'pass';
    } else if (parsed.marginPct >= 35) {
      status = '过底线';
      statusClass = 'caution';
    } else {
      status = '低于底线';
      statusClass = 'fail';
    }
  }
  return {
    asin: d.asin || '-',
    title: productTitle(d),
    price: priceNum,
    sales: salesNum,
    fbaFee: parsed.fbaFee,
    fbaRatio,
    marginPct: parsed.marginPct,
    status,
    statusClass
  };
});
const fbaValues = profitDetails.map(d => d.fbaFee).filter(Number.isFinite);
const marginValues = profitDetails.map(d => d.marginPct).filter(Number.isFinite);
const fbaRatioValues = profitDetails.map(d => d.fbaRatio).filter(Number.isFinite);
const avgFbaFee = fbaValues.length ? fbaValues.reduce((a, b) => a + b, 0) / fbaValues.length : null;
const avgMarginPct = marginValues.length ? marginValues.reduce((a, b) => a + b, 0) / marginValues.length : null;
const avgFbaRatio = fbaRatioValues.length ? fbaRatioValues.reduce((a, b) => a + b, 0) / fbaRatioValues.length : null;
const marginPass35 = profitDetails.filter(d => d.marginPct != null && d.marginPct >= 35).length;
const marginPass40 = profitDetails.filter(d => d.marginPct != null && d.marginPct >= 40).length;
const marginBelow35 = profitDetails.filter(d => d.marginPct != null && d.marginPct < 35).length;
const marginMissing = profitDetails.filter(d => d.marginPct == null).length;
const weightedMarginTotalSales = profitDetails.filter(d => d.marginPct != null && d.sales > 0).reduce((s, d) => s + d.sales, 0);
const salesWeightedMarginPct = weightedMarginTotalSales > 0
  ? profitDetails.filter(d => d.marginPct != null && d.sales > 0).reduce((s, d) => s + d.marginPct * d.sales, 0) / weightedMarginTotalSales
  : null;
const profitConclusionClass = avgMarginPct == null
  ? 'caution'
  : avgMarginPct >= 40 && marginBelow35 === 0
    ? 'pass'
    : avgMarginPct >= 35 && marginBelow35 <= Math.max(1, data.length * 0.15)
      ? 'caution'
      : 'fail';
const profitConclusion = avgMarginPct == null
  ? 'FBA&毛利率字段不足，无法做利润快筛'
  : profitConclusionClass === 'pass'
    ? '利润快筛通过：平均毛利率达到严格线，且未发现低于 35% 的产品'
    : profitConclusionClass === 'caution'
      ? '利润快筛谨慎：平均毛利率过底线，但部分产品低于严格线或存在缺失'
      : '利润快筛不通过：平均毛利率或低毛利产品比例未达知识库底线';

// New product sales analysis.
const newSalesNums = newProductsData.map(parseSalesNum).filter(n => n > 0).sort((a, b) => a - b);
const newSalesMedian = newSalesNums.length > 0 ? (newSalesNums.length % 2 !== 0 ? newSalesNums[Math.floor(newSalesNums.length / 2)] : (newSalesNums[newSalesNums.length / 2 - 1] + newSalesNums[newSalesNums.length / 2]) / 2) : 0;
const newSalesAvg = newSalesNums.length > 0 ? Math.round(newSalesNums.reduce((a, b) => a + b, 0) / newSalesNums.length) : 0;
const newSalesMax = newSalesNums.length > 0 ? Math.max(...newSalesNums) : 0;
const newTopShare = totalSales > 0 && newSalesMax > 0 ? ((newSalesMax / totalSales) * 100).toFixed(1) : '0';
const newMedianShare = totalSales > 0 && newSalesMedian > 0 ? ((newSalesMedian / totalSales) * 100).toFixed(1) : '0';
const newSalesRatio = salesMedian > 0 && newSalesMedian > 0 ? (newSalesMedian / salesMedian) : 0;
const newSalesSummary = newProductsData.length === 0
  ? '近 6 个月无可观察新品，短期新品切入样本不足'
  : newSalesRatio >= 0.8
    ? `新品销量可接近存量盘：新品中位数 ${newSalesMedian.toLocaleString()}，约为全市场中位数 ${(newSalesRatio * 100).toFixed(0)}%`
    : `新品销量偏弱：新品中位数 ${newSalesMedian.toLocaleString()}，仅为全市场中位数 ${(newSalesRatio * 100).toFixed(0)}%`;
const newSalesSummaryColor = newProductsData.length === 0 ? '#faad14' : newSalesRatio >= 0.8 ? '#52c41a' : '#faad14';
const survivalSummary = !survivalRateData
  ? '未分析 6 个月新品存活率'
  : survivalRateData.hasNoNewProducts
    ? `${survivalRateData.historicalPeriod} 无历史新品，存活率不适用`
    : `6 个月新品存活率 ${survivalRateData.survivalRateStr}，${survivalRateData.level}`;
const survivalSummaryColor = !survivalRateData || survivalRateData.levelClass === 'info'
  ? '#8c8c8c'
  : survivalRateData.levelClass === 'pass'
    ? '#52c41a'
    : survivalRateData.levelClass === 'caution'
      ? '#faad14'
      : '#ff4d4f';

// <12涓湀浜у搧鍒嗘瀽
const under12mData = data.filter(d => { const m = parseAge(d); return m >= 0 && m < 12; });
const under12mSalesNums = under12mData.map(parseSalesNum).filter(n => n > 0).sort((a, b) => a - b);
const under12mMedian = under12mSalesNums.length > 0 ? (under12mSalesNums.length % 2 !== 0 ? under12mSalesNums[Math.floor(under12mSalesNums.length / 2)] : (under12mSalesNums[under12mSalesNums.length / 2 - 1] + under12mSalesNums[under12mSalesNums.length / 2]) / 2) : 0;
const under12mAvg = under12mSalesNums.length > 0 ? Math.round(under12mSalesNums.reduce((a, b) => a + b, 0) / under12mSalesNums.length) : 0;
const under12mMax = under12mSalesNums.length > 0 ? Math.max(...under12mSalesNums) : 0;
const under12mTotal = under12mData.reduce((s, d) => s + parseSalesNum(d), 0);
const under12mShare = totalSales > 0 ? ((under12mTotal / totalSales) * 100).toFixed(1) : '0';
const under12mMaxShare = totalSales > 0 && under12mMax > 0 ? ((under12mMax / totalSales) * 100).toFixed(1) : '0';
const under12mMedianShare = totalSales > 0 && under12mMedian > 0 ? ((under12mMedian / totalSales) * 100).toFixed(1) : '0';

// New product detail rows.
const newProductDetails = newProductsData.map(d => ({
  asin: d.asin,
  brand: d.brand || '-',
  sales: parseSalesNum(d),
  share: totalSales > 0 ? ((parseSalesNum(d) / totalSales) * 100).toFixed(1) : '0',
  age: parseAge(d)
})).sort((a, b) => b.sales - a.sales);

// <12涓湀浜у搧璇︽儏鍒楄〃
const under12mDetails = under12mData.map(d => ({
  asin: d.asin,
  brand: d.brand || '-',
  sales: parseSalesNum(d),
  share: totalSales > 0 ? ((parseSalesNum(d) / totalSales) * 100).toFixed(1) : '0',
  age: parseAge(d)
})).sort((a, b) => b.sales - a.sales);

// 5姝ユ硶
const hasGap = bsrDist.some(r => r.count === 0);
let conclusion, conclusionClass, reason;
if (data.length < 30) {
  conclusion = '不进入';
  conclusionClass = 'fail';
  reason = '过滤后产品仅 ' + data.length + ' 个（要求 > 30），市场容量不足';
} else if (hasGap) {
  conclusion = '谨慎进入'; conclusionClass = 'caution';
  reason = 'BSR 区间存在断层，市场结构不稳定';
} else {
  conclusion = '建议进入'; conclusionClass = 'pass';
  reason = '过滤后 ' + data.length + ' 个产品，市场容量充足；新品占比 ' + newPct + '%，有机会切入';
}

const avgPrice = data.length > 0 ? '$' + (data.reduce((s, d) => s + (parseFloat((d.price || '').replace('$', '')) || 0), 0) / data.length).toFixed(2) : '-';
const maxBsrVal = data.length > 0 ? Math.max(...data.map(d => d.bsr)).toLocaleString() : '-';
const top10Bsr = data.sort((a, b) => a.bsr - b.bsr).slice(0, 10).map(d => d.bsr).join('-');
const gapText = bsrDist.filter(r => r.count === 0).map(r => r.label).join('、') || '无断层';

// ============ 甯傚満绔炰簤鍒嗘瀽 ============

// Parse estimated revenue from Oalur fields.
function parseRevenue(d) {
  if (!d.revenue) return 0;
  const s = d.revenue.replace(/[$,]/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Parse estimated sales from Oalur fields.
function parseSalesNum(d) {
  if (!d.sales) return 0;
  const s = d.sales.replace(/,/g, '').replace('+', '').trim();
  const n = parseInt(s);
  return isNaN(n) ? 0 : n;
}

function parsePriceNum(d) {
  const n = parseFloat(String(d.price || '').replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function parseFbaMargin(d) {
  const text = String(d.margin || '');
  const fbaMatch = text.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  const marginMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  return {
    fbaFee: fbaMatch ? parseFloat(fbaMatch[1]) : null,
    marginPct: marginMatch ? parseFloat(marginMatch[1]) : null
  };
}

// --- 1. 鍗曞搧甯傚満鍗犳瘮锛堟寜棰勪及閿€閲忥級 ---
const salesSorted = [...data].sort((a, b) => parseSalesNum(b) - parseSalesNum(a));
const top1ItemShare = totalSales > 0 ? ((parseSalesNum(salesSorted[0]) / totalSales) * 100).toFixed(1) : '0';
const top5ItemShare = totalSales > 0 ? (salesSorted.slice(0, 5).reduce((s, d) => s + parseSalesNum(d), 0) / totalSales * 100).toFixed(1) : '0';
const top10ItemShare = totalSales > 0 ? (salesSorted.slice(0, 10).reduce((s, d) => s + parseSalesNum(d), 0) / totalSales * 100).toFixed(1) : '0';
const top3ItemShare = totalSales > 0 ? (salesSorted.slice(0, 3).reduce((s, d) => s + parseSalesNum(d), 0) / totalSales * 100).toFixed(1) : '0';
const top1ItemAsin = salesSorted[0]?.asin || '-';

// --- 鍗曞搧甯傚満鍗犳瘮锛堟寜棰勪及閿€鍞锛?---
const salesSortedByRev = [...data].sort((a, b) => parseRevenue(b) - parseRevenue(a));
const totalRevenue = data.reduce((s, d) => s + parseRevenue(d), 0);
const top1ItemRevShare = totalRevenue > 0 ? ((parseRevenue(salesSortedByRev[0]) / totalRevenue) * 100).toFixed(1) : '0';
const top5ItemRevShare = totalRevenue > 0 ? (salesSortedByRev.slice(0, 5).reduce((s, d) => s + parseRevenue(d), 0) / totalRevenue * 100).toFixed(1) : '0';
const top10ItemRevShare = totalRevenue > 0 ? (salesSortedByRev.slice(0, 10).reduce((s, d) => s + parseRevenue(d), 0) / totalRevenue * 100).toFixed(1) : '0';
const top1ItemRevAsin = salesSortedByRev[0]?.asin || '-';

// --- 2. 鍝佺墝闆嗕腑搴︼紙鎸夐浼伴攢閲忥級 ---
const brandSales = {};
data.forEach(d => {
  if (!d.brand) return;
  brandSales[d.brand] = (brandSales[d.brand] || 0) + parseSalesNum(d);
});
const brandSalesSorted = Object.entries(brandSales).sort((a, b) => b[1] - a[1]);
const top1Brand = brandSalesSorted[0] || ['-', 0];
const top1BrandShare = totalSales > 0 ? ((top1Brand[1] / totalSales) * 100).toFixed(1) : '0';
const top3BrandShare = totalSales > 0 ? (brandSalesSorted.slice(0, 3).reduce((s, b) => s + b[1], 0) / totalSales * 100).toFixed(1) : '0';
const top5BrandShare = totalSales > 0 ? (brandSalesSorted.slice(0, 5).reduce((s, b) => s + b[1], 0) / totalSales * 100).toFixed(1) : '0';
// Brand dispersion outside TOP5.
const brandDispersion = totalSales > 0 ? (100 - parseFloat(top5BrandShare)).toFixed(1) : '0';
// 鍝佺墝鏌辩姸鍥炬暟鎹紙TOP10 鍝佺墝鎸夐攢閲忓崰姣旓級
const top10BrandBySales = brandSalesSorted.slice(0, 10).map(([b, s]) => ({
  brand: b,
  sales: s,
  share: totalSales > 0 ? ((s / totalSales) * 100).toFixed(1) : '0'
}));

// --- 鍝佺墝闆嗕腑搴︼紙鎸夐浼伴攢鍞锛?---
const brandRevenue = {};
data.forEach(d => {
  if (!d.brand) return;
  brandRevenue[d.brand] = (brandRevenue[d.brand] || 0) + parseRevenue(d);
});
const brandRevenueSorted = Object.entries(brandRevenue).sort((a, b) => b[1] - a[1]);
const top1BrandRev = brandRevenueSorted[0] || ['-', 0];
const top1BrandRevShare = totalRevenue > 0 ? ((top1BrandRev[1] / totalRevenue) * 100).toFixed(1) : '0';
const top3BrandRevShare = totalRevenue > 0 ? (brandRevenueSorted.slice(0, 3).reduce((s, b) => s + b[1], 0) / totalRevenue * 100).toFixed(1) : '0';
const top5BrandRevShare = totalRevenue > 0 ? (brandRevenueSorted.slice(0, 5).reduce((s, b) => s + b[1], 0) / totalRevenue * 100).toFixed(1) : '0';
const brandRevDispersion = totalRevenue > 0 ? (100 - parseFloat(top5BrandRevShare)).toFixed(1) : '0';
const top10BrandByRevenue = brandRevenueSorted.slice(0, 10).map(([b, r]) => ({
  brand: b,
  revenue: r,
  share: totalRevenue > 0 ? ((r / totalRevenue) * 100).toFixed(1) : '0'
}));

// --- 3. Entry barriers ---
function detectEntryBarriers() {
  const barriers = [];
  const avgPriceNum = data.length > 0 ? data.reduce((s, d) => s + (parseFloat((d.price || '').replace('$', '')) || 0), 0) / data.length : 0;
  if (avgPriceNum > 50) barriers.push('高单价（平均 $' + avgPriceNum.toFixed(0) + '）会提高资金门槛');
  const hasWeight = data.some(d => d.weight && d.weight !== '' && d.weight !== '0');
  if (hasWeight) barriers.push('涉及重量/大件，物流成本可能较高');
  const certKeywords = ['FDA', 'UL', 'FCC', 'CE ', 'CPSC', 'EPA', 'DOT'];
  const certProducts = data.filter(d => certKeywords.some(k => (d.title || '').toUpperCase().includes(k)));
  if (certProducts.length > 3) barriers.push('部分产品涉及认证关键词：' + certKeywords.filter(k => data.some(d => (d.title || '').toUpperCase().includes(k))).join('/'));
  const amzCount = data.filter(d => d.sellerType?.includes('亚马逊')).length;
  if (amzCount > data.length * 0.2) barriers.push('亚马逊自营占比 ' + ((amzCount / data.length) * 100).toFixed(0) + '%，平台强势介入');
  if (barriers.length === 0) barriers.push('暂未发现明显进入限制（仍需补充认证、专利和供应链核验）');
  return barriers;
}
const entryBarriers = detectEntryBarriers();

// --- 4. 鏂板搧鍒嗘瀽澧炲己 ---
const newProductsWithBrand = newProductsData.filter(d => d.brand && brandSalesSorted.slice(0, 10).some(([b]) => b === d.brand));
const newBrandCount = new Set(newProductsData.map(d => d.brand).filter(Boolean)).size;
const newProductsAboveTarget = newProductsData.filter(d => d.bsr <= bsrMax).length;

// --- 5. 璇勮鏁板垎鏋愶紙鏄熺骇鏁版嵁闇€浠庝簹椹€婇〉闈㈣幏鍙栵紝姝ゅ鐢ㄨ瘎璁烘暟鍒嗘瀽甯傚満鎴愮啛搴︼級 ---
function parseReviewCount(d) {
  if (!d.ratings) return 0;
  const n = parseInt(d.ratings.replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}
const reviewRanges = [
  { label: '< 100', min: 0, max: 100 },
  { label: '100 - 500', min: 100, max: 500 },
  { label: '500 - 2000', min: 500, max: 2000 },
  { label: '2000 - 10000', min: 2000, max: 10000 },
  { label: '10000+', min: 10000, max: 999999 }
];
const reviewDist = reviewRanges.map(r => ({
  label: r.label,
  count: data.filter(d => { const rc = parseReviewCount(d); return rc >= r.min && rc < r.max; }).length
}));
const lowReviewCount = data.filter(d => parseReviewCount(d) < 500).length;
const lowReviewPct = data.length > 0 ? ((lowReviewCount / data.length) * 100).toFixed(1) : '0';
const avgReviews = data.length > 0 ? Math.round(data.reduce((s, d) => s + parseReviewCount(d), 0) / data.length).toLocaleString() : '-';

// Top 20 review analysis by BSR.
const top20ByBsr = [...data].sort((a, b) => (a.bsr || 999999) - (b.bsr || 999999)).slice(0, 20);
const top20Reviews = top20ByBsr.map(d => parseReviewCount(d)).filter(n => n > 0).sort((a, b) => a - b);
const top20AvgReviews = top20ByBsr.length > 0 ? Math.round(top20ByBsr.reduce((s, d) => s + parseReviewCount(d), 0) / top20ByBsr.length).toLocaleString() : '-';
const top20ReviewMedian = top20Reviews.length > 0 ? (top20Reviews.length % 2 !== 0 ? top20Reviews[Math.floor(top20Reviews.length / 2)] : Math.round((top20Reviews[top20Reviews.length / 2 - 1] + top20Reviews[top20Reviews.length / 2]) / 2)) : 0;
const top20LowReviewCount = top20ByBsr.filter(d => parseReviewCount(d) < 100).length; // 鐭ヨ瘑搴撴爣鍑嗭細鍓?0涓?100鏉＄殑鏁伴噺

// Global review median.
const allReviewNums = data.map(d => parseReviewCount(d)).filter(n => n > 0).sort((a, b) => a - b);
const reviewMedian = allReviewNums.length > 0 ? (allReviewNums.length % 2 !== 0 ? allReviewNums[Math.floor(allReviewNums.length / 2)] : Math.round((allReviewNums[allReviewNums.length / 2 - 1] + allReviewNums[allReviewNums.length / 2]) / 2)) : 0;

// --- 6. 鍗栧鎬ц川涓庡競鍦虹粨鏋勶紙鎸夐浼伴攢閲忥級 ---
const sellerSales = {};
data.forEach(d => {
  const st = d.sellerType?.includes('亚马逊') ? '亚马逊自营' : d.sellerType?.includes('FBA') ? 'FBA' : d.sellerType?.includes('FBM') ? 'FBM' : '其他';
  sellerSales[st] = (sellerSales[st] || 0) + parseSalesNum(d);
});
const sellerSalesSorted = Object.entries(sellerSales).sort((a, b) => b[1] - a[1]);
const topSellerType = sellerSalesSorted[0] || ['-', 0];
const topSellerShare = totalSales > 0 ? ((topSellerType[1] / totalSales) * 100).toFixed(1) : '0';

// --- Competition summary ---
let compConclusion, compConclusionClass, compReasons = [];
if (parseFloat(top1ItemShare) > 30) {
  compReasons.push('TOP1 单品占比 ' + top1ItemShare + '%，高于 30%，存在单品集中风险');
} else {
  compReasons.push('TOP1 单品占比 ' + top1ItemShare + '%，低于 30%，竞争相对分散');
}
if (parseFloat(top3ItemShare) > 45) {
  compReasons.push('TOP3 单品合计 ' + top3ItemShare + '%，高于 45%，头部集中');
} else {
  compReasons.push('TOP3 单品合计 ' + top3ItemShare + '%，低于 45%，无明显头部垄断');
}
if (parseFloat(top1BrandShare) > 30) {
  compReasons.push('TOP1 品牌份额 ' + top1BrandShare + '%，高于 30%，品牌集中度偏高');
} else {
  compReasons.push('TOP1 品牌份额 ' + top1BrandShare + '%，低于 30%，无明显垄断品牌');
}
if (parseFloat(top3BrandShare) > 50) {
  compReasons.push('TOP3 品牌合计 ' + top3BrandShare + '%，高于 50%，集中度高');
} else {
  compReasons.push('TOP3 品牌合计 ' + top3BrandShare + '%，低于 50%，品牌竞争分散');
}
if (parseFloat(brandDispersion) > 40) {
  compReasons.push('品牌分散度 ' + brandDispersion + '%，高于 40%，属于竞争型市场');
} else {
  compReasons.push('品牌分散度 ' + brandDispersion + '%，低于 40%，市场偏集中');
}
if (topSellerType[0] === '亚马逊自营' && parseFloat(topSellerShare) > 50) {
  compReasons.push('亚马逊自营销量占比 ' + topSellerShare + '%，高于 50%，平台强势介入');
} else {
  compReasons.push('卖家结构正常：最大类型为 ' + topSellerType[0] + '，占比 ' + topSellerShare + '%；FBA/FBM 只是履约方式');
}
if (parseFloat(newPct) > 10) {
  compReasons.push('6 个月内新品 ' + newProductsData.length + ' 个（' + newPct + '%），市场有活力');
} else {
  compReasons.push('6 个月内新品仅 ' + newProductsData.length + ' 个（' + newPct + '%），市场偏固化');
}
if (top20AvgReviews !== '-' && parseInt(top20AvgReviews.replace(/,/g, '')) < 600) {
  compReasons.push('前 20 名平均评论 ' + top20AvgReviews + '，低于 600，评论壁垒低');
} else {
  compReasons.push('前 20 名平均评论 ' + top20AvgReviews + '，高于 600，评论壁垒较高');
}
if (reviewMedian < 350) {
  compReasons.push('评论中位数 ' + reviewMedian.toLocaleString() + '，低于 350');
} else {
  compReasons.push('评论中位数 ' + reviewMedian.toLocaleString() + '，高于 350，历史积累较深');
}
if (top20LowReviewCount >= 3) {
  compReasons.push('前 20 名中有 ' + top20LowReviewCount + ' 个评论数低于 100，新品仍有挤入机会');
} else {
  compReasons.push('前 20 名中仅 ' + top20LowReviewCount + ' 个评论数低于 100，前排评论壁垒高');
}
if (parseFloat(lowReviewPct) > 30) {
  compReasons.push('评论数 < 500 的产品占 ' + lowReviewPct + '%，整体评论门槛不算极端');
}
compReasons.push('<strong>知识库要点：</strong>评论壁垒需同时看前 20 平均值、中位数、低评论产品数量；FBA/FBM 不等同垄断，只有亚马逊自营占比过高才构成平台强势介入。');

// 缁煎悎缁撹锛團BA/FBM 鏄墿娴佹柟寮忥紝涓嶇畻鍨勬柇锛涘彧鏈変簹椹€婅嚜钀ユ垨鍗曚竴鍝佺墝/鍗曞搧鍗犵粷瀵逛紭鍔挎墠绠楀瀯鏂級
const hasMonopoly = parseFloat(top1ItemShare) > 30 || parseFloat(top3BrandShare) > 50;
const isAmazonMonopoly = topSellerType[0] === '亚马逊自营' && parseFloat(topSellerShare) > 50;
if (isAmazonMonopoly) {
  compConclusion = '亚马逊自营强势介入，建议放弃';
  compConclusionClass = 'fail';
} else if (hasMonopoly) {
  compConclusion = '品牌/单品集中度偏高，竞争激烈';
  compConclusionClass = 'caution';
} else if (parseFloat(newPct) < 5 && data.length > 30) {
  compConclusion = '市场偏固化，新品机会有限';
  compConclusionClass = 'caution';
} else if (parseFloat(brandDispersion) > 40 && parseFloat(top1ItemShare) < 15) {
  compConclusion = '竞争分散，有切入机会';
  compConclusionClass = 'pass';
} else {
  compConclusion = '竞争中等，需要差异化切入';
  compConclusionClass = 'caution';
}

// Competition standards reference from the local knowledge base.
const compStandardsRef = `
<div class="card">
  <h2>量化标准参考（知识库）</h2>
  <p style="color:#666;font-size:13px;margin-bottom:12px;">
    以下为知识库中的选品量化标准，与当前抓取数据做对比。
  </p>
  <table>
    <tr><th>维度</th><th>知识库标准</th><th>当前值</th><th>判定</th></tr>
    <tr><td>TOP1 单品销量占比</td><td>&lt; 30%</td><td>${top1ItemShare}%</td><td>${parseFloat(top1ItemShare) < 30 ? '达标' : '未达标'}</td></tr>
    <tr><td>TOP3 单品销量合计</td><td>&lt; 45%</td><td>${top3ItemShare}%</td><td>${parseFloat(top3ItemShare) < 45 ? '达标' : '未达标'}</td></tr>
    <tr><td>TOP1 品牌份额</td><td>&lt; 28%</td><td>${top1BrandShare}%</td><td>${parseFloat(top1BrandShare) < 28 ? '达标' : '未达标'}</td></tr>
    <tr><td>TOP3 品牌合计</td><td>&lt; 45%</td><td>${top3BrandShare}%</td><td>${parseFloat(top3BrandShare) < 45 ? '达标' : '未达标'}</td></tr>
    <tr><td>品牌分散度</td><td>&gt; 40%</td><td>${brandDispersion}%</td><td>${parseFloat(brandDispersion) > 40 ? '达标' : '未达标'}</td></tr>
    <tr><td>前 20 平均评论数</td><td>&lt; 600</td><td>${top20AvgReviews}</td><td>${top20AvgReviews !== '-' && parseInt(top20AvgReviews.replace(/,/g, '')) < 600 ? '达标' : '未达标'}</td></tr>
    <tr><td>评论中位数</td><td>&lt; 350</td><td>${reviewMedian.toLocaleString()}</td><td>${reviewMedian < 350 ? '达标' : '未达标'}</td></tr>
    <tr><td>前 20 中评论 &lt;100 的产品数</td><td>&gt;= 3 个</td><td>${top20LowReviewCount} 个</td><td>${top20LowReviewCount >= 3 ? '达标' : '未达标'}</td></tr>
    <tr><td>Oalur 平均毛利率</td><td>美国 ≥35%，严格 ≥40%</td><td>${avgMarginPct == null ? '未采集' : avgMarginPct.toFixed(1) + '%'}</td><td>${avgMarginPct == null ? '未分析' : avgMarginPct >= 40 ? '稳健' : avgMarginPct >= 35 ? '过底线' : '未达标'}</td></tr>
    <tr><td>新品占比（&lt;6个月）</td><td>存在可观察新品</td><td>${newProductsData.length} 个（${newPct}%）</td><td>${parseFloat(newPct) > 10 ? '活跃' : '偏少'}</td></tr>
    <tr><td>新品存活率（6个月）</td><td>&gt;= 35%</td><td>${survivalRateData ? survivalRateData.survivalRateStr : '未分析'}</td><td>${survivalRateData ? (survivalRateData.hasNoNewProducts ? '无历史新品' : (survivalRateData.survivalRate >= 35 ? '达标' : '未达标')) : '未分析'}</td></tr>
  </table>
  <div style="margin-top:12px;padding:8px 12px;background:#f0f5ff;border-radius:6px;font-size:12px;color:#666;line-height:1.8;">
    <strong>知识库来源：</strong>市场竞争量化、利润与销量取舍、新品存活率、评论壁垒判断。
  </div>
</div>`;

// 璇诲彇妯℃澘
let html = fs.readFileSync(path.join(__dirname, 'report-template.html'), 'utf-8');

// Placeholder replacements.
const replacements = {
  '{{KEYWORD}}': jsonData.keyword || '未知',
  '{{DATE}}': REPORT_DATE,
  '{{MAX_BSR}}': bsrMax.toLocaleString(),
  '{{TARGET_CATEGORY}}': jsonData.targetCategory || '未知',
  '{{ALL_COUNT}}': jsonData.allCount || 0,
  '{{FILTERED_COUNT}}': data.length,
  '{{EXCLUDED_COUNT}}': excluded.length,
  '{{RAW_TOTAL}}': rawTotal,
  '{{TOTAL}}': total,
  '{{NEW_PCT}}': newPct,
  '{{SALES_MEDIAN}}': salesMedian.toLocaleString(),
  '{{SALES_AVG}}': salesAvg.toLocaleString(),
  '{{SALES_MAX}}': salesMax.toLocaleString(),
  '{{SALES_MIN}}': salesMin.toLocaleString(),
  '{{REV_MEDIAN}}': '$' + Math.round(revMedian).toLocaleString(),
  '{{REV_AVG}}': '$' + Math.round(revAvg).toLocaleString(),
  '{{REV_MAX}}': '$' + Math.round(revMax).toLocaleString(),
  '{{REV_MIN}}': '$' + Math.round(revMin).toLocaleString(),
  '{{TOTAL_REVENUE}}': '$' + Math.round(totalRev).toLocaleString(),
  '{{TOTAL_SALES}}': totalSales.toLocaleString(),
  '{{PROFIT_BLOCK}}': '',
  '{{AVG_FBA_FEE}}': avgFbaFee == null ? '未采集' : '$' + avgFbaFee.toFixed(2),
  '{{AVG_MARGIN_PCT}}': avgMarginPct == null ? '未采集' : avgMarginPct.toFixed(1) + '%',
  '{{SALES_WEIGHTED_MARGIN_PCT}}': salesWeightedMarginPct == null ? '未采集' : salesWeightedMarginPct.toFixed(1) + '%',
  '{{AVG_FBA_RATIO}}': avgFbaRatio == null ? '未采集' : avgFbaRatio.toFixed(1) + '%',
  '{{MARGIN_PASS35_COUNT}}': marginPass35,
  '{{MARGIN_PASS40_COUNT}}': marginPass40,
  '{{MARGIN_BELOW35_COUNT}}': marginBelow35,
  '{{MARGIN_MISSING_COUNT}}': marginMissing,
  '{{NEW_SALES_MEDIAN}}': newSalesMedian.toLocaleString(),
  '{{NEW_SALES_AVG}}': newSalesAvg.toLocaleString(),
  '{{NEW_SALES_MAX}}': newSalesMax.toLocaleString(),
  '{{NEW_TOP_SHARE}}': newTopShare,
  '{{NEW_MEDIAN_SHARE}}': newMedianShare,
  '{{NEW_SALES_SUMMARY}}': newSalesSummary,
  '{{NEW_SALES_SUMMARY_COLOR}}': newSalesSummaryColor,
  '{{SURVIVAL_SUMMARY}}': survivalSummary,
  '{{SURVIVAL_SUMMARY_COLOR}}': survivalSummaryColor,
  '{{UNDER12M_COUNT}}': under12mData.length,
  '{{UNDER12M_PCT}}': data.length > 0 ? ((under12mData.length / data.length) * 100).toFixed(1) : '0',
  '{{UNDER12M_SALES_MAX}}': under12mMax.toLocaleString(),
  '{{UNDER12M_SALES_MEDIAN}}': under12mMedian.toLocaleString(),
  '{{UNDER12M_SALES_AVG}}': under12mAvg.toLocaleString(),
  '{{UNDER12M_TOTAL}}': under12mTotal.toLocaleString(),
  '{{UNDER12M_SHARE}}': under12mShare,
  '{{UNDER12M_MAX_SHARE}}': under12mMaxShare,
  '{{UNDER12M_MEDIAN_SHARE}}': under12mMedianShare,
  '{{TIME_RANGE}}': jsonData.timeFilter || '最近30天',
  '{{MAX_BSR_VAL}}': maxBsrVal,
  '{{AVG_PRICE}}': avgPrice,
  '{{STEP1}}': data.length > 30 ? '超过30个' : '不足30个',
  '{{TOP10_BSR}}': top10Bsr,
  '{{GAP_TEXT}}': gapText,
  '{{STEP3}}': hasGap ? '存在断层' : '分布均匀',
  '{{NEW_COUNT}}': newProducts,
  '{{STEP4}}': parseFloat(newPct) > 10 ? '有机会' : '新品偏少',
  '{{CONCLUSION}}': conclusion,
  '{{CONCLUSION_CLASS}}': conclusionClass,
  '{{REASON}}': reason,
  '{{BSR_LABELS}}': JSON.stringify(bsrDist.map(r => r.label)),
  '{{BSR_DATA}}': JSON.stringify(bsrDist.map(r => r.count)),
  '{{AGE_LABELS}}': JSON.stringify(ageDist.map(r => r.label)),
  '{{AGE_DATA}}': JSON.stringify(ageDist.map(r => r.count)),
  '{{PRICE_LABELS}}': JSON.stringify(priceDist.map(r => r.label)),
  '{{PRICE_DATA}}': JSON.stringify(priceDist.map(r => r.count)),
  // 绔炰簤鍒嗘瀽
  '{{TOP1_ITEM_SHARE}}': top1ItemShare,
  '{{TOP1_ITEM_ASIN}}': top1ItemAsin,
  '{{TOP5_ITEM_SHARE}}': top5ItemShare,
  '{{TOP10_ITEM_SHARE}}': top10ItemShare,
  '{{TOP3_ITEM_SHARE}}': top3ItemShare,
  '{{TOP1_ITEM_CLASS}}': parseFloat(top1ItemShare) > 30 ? 'warn' : 'ok',
  '{{TOP3_ITEM_CLASS}}': parseFloat(top3ItemShare) > 45 ? 'warn' : 'ok',
  '{{TOP3_BRAND_CLASS}}': parseFloat(top3BrandShare) > 50 ? 'warn' : 'ok',
  '{{BRAND_DISP_CLASS}}': parseFloat(brandDispersion) > 40 ? 'ok' : 'warn',
  '{{TOP1_ITEM_REV_SHARE}}': top1ItemRevShare,
  '{{TOP1_ITEM_REV_ASIN}}': top1ItemRevAsin,
  '{{TOP5_ITEM_REV_SHARE}}': top5ItemRevShare,
  '{{TOP10_ITEM_REV_SHARE}}': top10ItemRevShare,
  '{{TOP1_BRAND}}': top1Brand[0],
  '{{TOP1_BRAND_SHARE}}': top1BrandShare,
  '{{TOP3_BRAND_SHARE}}': top3BrandShare,
  '{{TOP5_BRAND_SHARE}}': top5BrandShare,
  '{{BRAND_DISPERSION}}': brandDispersion,
  '{{AVG_REVIEWS}}': avgReviews,
  '{{REVIEW_MEDIAN}}': reviewMedian.toLocaleString(),
  '{{TOP20_AVG_REVIEWS}}': top20AvgReviews,
  '{{TOP20_REVIEW_MEDIAN}}': top20ReviewMedian.toLocaleString(),
  '{{TOP20_LOW_REVIEW_COUNT}}': top20LowReviewCount,
  '{{LOW_REVIEW_COUNT}}': lowReviewCount,
  '{{LOW_REVIEW_PCT}}': lowReviewPct,
  '{{TOP_SELLER_TYPE}}': topSellerType[0],
  '{{TOP_SELLER_SHARE}}': topSellerShare,
  '{{COMP_CONCLUSION}}': compConclusion,
  '{{COMP_CONCLUSION_CLASS}}': compConclusionClass,
  '{{COMP_STANDARDS_REF}}': '',
  // Survival rate.
  '{{SURVIVAL_RATE}}': survivalRateData ? survivalRateData.survivalRateStr : '未分析',
  '{{SURVIVAL_LEVEL}}': survivalRateData ? survivalRateData.level : '未分析',
  '{{SURVIVAL_LEVEL_CLASS}}': survivalRateData ? survivalRateData.levelClass : '',
  '{{SURVIVAL_HIST_NEW}}': survivalRateData ? survivalRateData.histNewCount : 0,
  '{{SURVIVAL_SURVIVING}}': survivalRateData ? survivalRateData.survivingCount : 0,
  '{{HISTORICAL_PERIOD}}': survivalRateData ? survivalRateData.historicalPeriod : '最近30天',
  '{{SURVIVAL_HTML}}': survivalRateData ? `
<div class="card">
  <h2>6 个月新品存活率</h2>
  <div style="padding:12px;background:#f9f9f9;border-radius:8px;font-size:13px;line-height:1.8;">
    <strong>计算方法：</strong>${survivalRateData.historicalPeriod} 时 BSR 范围内的新品，到当前仍在同一 BSR 范围内的比例。
  </div>
  <div class="conclusion ${survivalRateData.levelClass}">存活率 ${survivalRateData.survivalRateStr} - ${survivalRateData.level}</div>
  ${survivalRateData.histNewRows ? `<table style="margin-top:16px;"><tr><th>ASIN</th><th>品牌</th><th>上架时间</th><th>状态</th></tr>${survivalRateData.histNewRows}</table>` : ''}
</div>
` : '',
  '{{CAPACITY_SUMMARY}}': conclusion,
  '{{CAPACITY_SUMMARY_CLASS}}': conclusionClass,
  '{{CAPACITY_SUMMARY_COLOR}}': conclusionClass === 'pass' ? '#52c41a' : conclusionClass === 'caution' ? '#faad14' : '#ff4d4f',
  '{{CAPACITY_SUMMARY_SHORT}}': conclusion.replace(/<br>.*$/, '').replace(/^[鉁呪殸锔忊潓]\s*/, ''),
  '{{COMP_SUMMARY}}': compConclusion,
  '{{COMP_SUMMARY_CLASS}}': compConclusionClass,
  '{{COMP_SUMMARY_COLOR}}': compConclusionClass === 'pass' ? '#52c41a' : compConclusionClass === 'caution' ? '#faad14' : '#ff4d4f',
  '{{SEASONALITY_SUMMARY}}': '<span style="color:#999">未分析</span>',
  '{{SEASONALITY_SUMMARY_CLASS}}': '',
  '{{BRAND_LABELS}}': JSON.stringify(topBrands.map(([b]) => b)),
  '{{BRAND_DATA}}': JSON.stringify(topBrands.map(([, c]) => c)),
  '{{TOP10_BRAND_SALES_LABELS}}': JSON.stringify(top10BrandBySales.map(b => b.brand)),
  '{{TOP10_BRAND_SALES_DATA}}': JSON.stringify(top10BrandBySales.map(b => parseFloat(b.share))),
  '{{TOP10_BRAND_REV_LABELS}}': JSON.stringify(top10BrandByRevenue.map(b => b.brand)),
  '{{TOP10_BRAND_REV_DATA}}': JSON.stringify(top10BrandByRevenue.map(b => parseFloat(b.share))),
  '{{TOP1_BRAND_REV}}': top1BrandRev[0],
  '{{TOP1_BRAND_REV_SHARE}}': top1BrandRevShare,
  '{{TOP3_BRAND_REV_SHARE}}': top3BrandRevShare,
  '{{TOP5_BRAND_REV_SHARE}}': top5BrandRevShare,
  '{{BRAND_REV_DISPERSION}}': brandRevDispersion,
  '{{REVIEW_LABELS}}': JSON.stringify(reviewDist.map(r => r.label)),
  '{{REVIEW_DATA}}': JSON.stringify(reviewDist.map(r => r.count)),
  '{{SELLER_SALES_LABELS}}': JSON.stringify(sellerSalesSorted.map(s => s[0])),
  '{{SELLER_SALES_DATA}}': JSON.stringify(sellerSalesSorted.map(s => totalSales > 0 ? parseFloat(((s[1] / totalSales) * 100).toFixed(1)) : 0)),
  '{{LIFECYCLE_BLOCK}}': '',
  '{{KNOWLEDGE_AUDIT_BLOCK}}': '',
  '{{BSR_INSIGHT}}': '',
  '{{AGE_INSIGHT}}': '',
  '{{PRICE_INSIGHT}}': '',
};

// Competition standards reference.
replacements['{{COMP_STANDARDS_REF}}'] = compStandardsRef;

// ============ Knowledge insights ============

// BSR distribution insight.
const bsrGaps = bsrDist.filter(r => r.count === 0).map(r => r.label);
const maxCountInterval = bsrDist.reduce((a, b) => a.count > b.count ? a : b, bsrDist[0]);
const denseIntervals = bsrDist.filter(r => r.count >= Math.max(3, data.length / bsrSegmentCount * 1.5));
replacements['{{BSR_INSIGHT}}'] = `
<div style="margin-top:12px;padding:10px 14px;background:#f0f5ff;border-radius:8px;font-size:12px;color:#555;line-height:1.9;">
  <strong>知识库解读：</strong>使用 ${bsrInterval} 排名等宽区间观察容量连续性。最密集区间为 <strong>${maxCountInterval.label}</strong>，包含 ${maxCountInterval.count} 个产品。<br>
  ${bsrGaps.length > 0 ? `发现断层区间：<strong>${bsrGaps.join('、')}</strong>，需关注需求不连续或竞争结构特殊。` : '未发现断层，BSR 分布较连续。'}<br>
  ${parseFloat(top1ItemShare) > 30 ? 'TOP1 单品占比超过 30%，头部集中度偏高。' : 'TOP1 单品占比未超过 30%，头部集中度可接受。'}
</div>`;

// Listing age insight.
const oldCount = data.filter(d => { const m = parseAge(d); return m >= 36; }).length;
const midCount = data.filter(d => { const m = parseAge(d); return m >= 12 && m < 36; }).length;
replacements['{{AGE_INSIGHT}}'] = `
<div style="margin-top:12px;padding:10px 14px;background:#f0f5ff;border-radius:8px;font-size:12px;color:#555;line-height:1.9;">
  <strong>知识库解读：</strong>6 个月内新品 ${newProductsData.length} 个，占 ${newPct}%；3 年以上老品 ${oldCount} 个，占 ${(oldCount / Math.max(data.length, 1) * 100).toFixed(0)}%。<br>
  ${parseFloat(newPct) > 10 ? '新品占比尚可，说明市场仍有新进入者。' : '新品占比偏少，说明市场可能偏固化或新品切入难度较高。'}
</div>`;

// Price distribution insight.
const priceNums = data.map(d => parseFloat((d.price || '').replace('$', ''))).filter(p => !isNaN(p) && p > 0);
const priceMedian = priceNums.length > 0 ? priceNums.sort((a,b)=>a-b)[Math.floor(priceNums.length/2)] : 0;
const lowPricePct = priceNums.length > 0 ? (priceNums.filter(p => p < 10).length / priceNums.length * 100).toFixed(0) : '0';
const midPricePct = priceNums.length > 0 ? (priceNums.filter(p => p >= 10 && p < 20).length / priceNums.length * 100).toFixed(0) : '0';
replacements['{{PRICE_INSIGHT}}'] = `
<div style="margin-top:12px;padding:10px 14px;background:#f0f5ff;border-radius:8px;font-size:12px;color:#555;line-height:1.9;">
  <strong>知识库解读：</strong>价格中位数 $${priceMedian.toFixed(2)}，均价 ${avgPrice}；低于 $10 的产品占 ${lowPricePct}%，$10-$20 的产品占 ${midPricePct}%。<br>
  ${parseInt(lowPricePct) > 50 ? '低价产品占比高，利润和广告容错空间需要重点核算。' : '低价产品占比可控，但仍需补齐采购、FBA、头程和退货成本。'}
</div>`;

const profitRows = profitDetails
  .slice()
  .sort((a, b) => b.sales - a.sales)
  .map((d, i) => {
    const marginText = d.marginPct == null ? '-' : d.marginPct.toFixed(1) + '%';
    const fbaText = d.fbaFee == null ? '-' : '$' + d.fbaFee.toFixed(2);
    const fbaRatioText = d.fbaRatio == null ? '-' : d.fbaRatio.toFixed(1) + '%';
    const priceText = d.price > 0 ? '$' + d.price.toFixed(2) : '-';
    return `<tr>
      <td>${i + 1}</td>
      <td><a href="https://www.amazon.com/dp/${escapeHtml(d.asin)}" target="_blank">${escapeHtml(d.asin)}</a></td>
      <td style="max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(d.title)}">${escapeHtml(d.title.substring(0, 80))}</td>
      <td>${priceText}</td>
      <td>${fbaText}</td>
      <td>${fbaRatioText}</td>
      <td>${marginText}</td>
      <td>${d.sales.toLocaleString()}</td>
      <td><span class="${d.statusClass}">${d.status}</span></td>
    </tr>`;
  }).join('\n');

replacements['{{PROFIT_BLOCK}}'] = `
<div class="card">
  <h2>利润快筛（FBA & 毛利率）</h2>
  <div class="metric-grid">
    <div class="metric"><div class="value">${avgFbaFee == null ? '未采集' : '$' + avgFbaFee.toFixed(2)}</div><div class="label">平均 FBA 费用</div></div>
    <div class="metric"><div class="value">${avgMarginPct == null ? '未采集' : avgMarginPct.toFixed(1) + '%'}</div><div class="label">平均毛利率</div></div>
    <div class="metric"><div class="value">${salesWeightedMarginPct == null ? '未采集' : salesWeightedMarginPct.toFixed(1) + '%'}</div><div class="label">销量加权毛利率</div></div>
    <div class="metric"><div class="value">${avgFbaRatio == null ? '未采集' : avgFbaRatio.toFixed(1) + '%'}</div><div class="label">FBA/售价均值</div></div>
  </div>
  <div class="summary" style="margin-top:12px;">
    <div class="metric"><div class="value">${marginPass40}</div><div class="label">≥40% 稳健线</div></div>
    <div class="metric"><div class="value">${marginPass35}</div><div class="label">≥35% 底线</div></div>
    <div class="metric"><div class="value">${marginBelow35}</div><div class="label">&lt;35% 低毛利</div></div>
    <div class="metric"><div class="value">${marginMissing}</div><div class="label">毛利率缺失</div></div>
  </div>
  <div class="conclusion ${profitConclusionClass}" style="font-size:16px;text-align:left;line-height:1.8;">
    ${profitConclusion}<br>
    <small>知识库标准：美国站毛利率 ≥35% 为底线，≥40% 更稳；售价最好达到产品成本价 4-5 倍，有效成本率需 &gt;100%。当前 Oalur 字段只能做 FBA 与毛利率快筛，采购成本、头程、包装、CPC 和有效成本率仍需补采后复核。</small>
  </div>
  <div class="scroll-table" style="margin-top:16px;">
    <table>
      <tr><th>#</th><th>ASIN</th><th>产品名称</th><th>售价</th><th>FBA</th><th>FBA/售价</th><th>毛利率</th><th>月销量</th><th>快筛</th></tr>
      ${profitRows}
    </table>
  </div>
</div>`;

// Brand rows by product count.
replacements['{{BRAND_ROWS}}'] = topBrands.map(([b, c]) =>
  '<tr><td>' + b + '</td><td>' + c + '</td><td>' + ((c / data.length) * 100).toFixed(1) + '%</td></tr>'
).join('\n');

// 鍝佺墝琛岋紙鎸夐攢閲忓崰姣旓級
replacements['{{BRAND_SALES_ROWS}}'] = top10BrandBySales.map(b =>
  '<tr><td>' + b.brand + '</td><td>' + b.sales.toLocaleString() + '</td><td>' + b.share + '%</td></tr>'
).join('\n');
replacements['{{BRAND_REVENUE_ROWS}}'] = top10BrandByRevenue.map(b =>
  '<tr><td>' + b.brand + '</td><td>$' + b.revenue.toLocaleString() + '</td><td>' + b.share + '%</td></tr>'
).join('\n');

// Seller type rows by product count.
replacements['{{SELLER_ROWS}}'] = Object.entries(sellerCount).sort((a, b) => b[1] - a[1]).map(([st, c]) =>
  '<tr><td>' + st + '</td><td>' + c + '</td><td>' + ((c / data.length) * 100).toFixed(1) + '%</td></tr>'
).join('\n');

// 绔炰簤鍒嗘瀽鐞嗙敱鍒楄〃
replacements['{{COMP_REASONS}}'] = compReasons.map(r => '<li>' + r + '</li>').join('\n');

// 杩涘叆闄愬埗鍒楄〃
replacements['{{ENTRY_BARRIERS}}'] = entryBarriers.map(b => '<li>' + b + '</li>').join('\n');

// New product detail rows.
replacements['{{NEW_PRODUCT_ROWS}}'] = newProductDetails.map((d, i) =>
  '<tr><td>' + (i + 1) + '</td><td><a href="https://www.amazon.com/dp/' + d.asin + '" target="_blank">' + d.asin + '</a></td><td>' + d.brand + '</td><td>' + d.sales.toLocaleString() + '</td><td>' + d.share + '%</td><td>' + d.age + '个月</td></tr>'
).join('\n');

// Under-12-month product detail rows.
replacements['{{UNDER12M_ROWS}}'] = under12mDetails.map((d, i) =>
  '<tr><td>' + (i + 1) + '</td><td><a href="https://www.amazon.com/dp/' + d.asin + '" target="_blank">' + d.asin + '</a></td><td>' + d.brand + '</td><td>' + d.sales.toLocaleString() + '</td><td>' + d.share + '%</td><td>' + d.age + '个月</td></tr>'
).join('\n');

// Excluded product rows.
replacements['{{EXCLUDED_ROWS}}'] = excluded.map((d, i) => {
  const fullTitle = productTitle(d);
  const shortTitle = fullTitle.length > 140 ? fullTitle.substring(0, 140) + '...' : fullTitle;
  const asinCell = d.asin ? `<a href="https://www.amazon.com/dp/${escapeHtml(d.asin)}" target="_blank">${escapeHtml(d.asin)}</a>` : '-';
  return '<tr><td>' + (i + 1) + '</td><td>' + asinCell + '</td><td style="min-width:360px;max-width:720px;white-space:normal;line-height:1.5;" title="' + escapeHtml(fullTitle) + '">' + escapeHtml(shortTitle) + '</td><td style="font-size:11px;color:#999;">' + escapeHtml(d.category || '未识别') + '</td></tr>';
}).join('\n');

// Keyword source rows.
const kwSourceData = jsonData.keywordStats ? Object.entries(jsonData.keywordStats).map(([kw, count]) => ({ keyword: kw, count })) : [];
const kwSourceRows = kwSourceData.map((k, i) =>
  '<tr><td>' + (i + 1) + '</td><td>' + k.keyword + '</td><td>' + k.count + '</td></tr>'
).join('\n');

// Product detail rows.
replacements['{{PRODUCT_ROWS}}'] = data.sort((a, b) => a.bsr - b.bsr).map((d, i) =>
  '<tr><td>' + (i + 1) + '</td><td style="max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + d.title + '">' + d.title.substring(0, 60) + '</td><td><a href="https://www.amazon.com/dp/' + d.asin + '" target="_blank">' + d.asin + '</a></td><td>' + d.sales + '</td><td>' + d.bsr + '</td><td>' + d.subRank + '</td><td>' + d.price + '</td><td>' + formatAge(d) + '</td><td>' + d.ratings + '</td><td>' + d.brand + '</td></tr>'
).join('\n');
replacements['{{KW_SOURCE_ROWS}}'] = kwSourceRows;

// ============ Legacy seasonality block disabled after encoding damage ============
/*
if (seasonalityData && seasonalityData.seasonality) {
  const s = seasonalityData.seasonality;
  const sType = s.seasonalityType;
  const sScore = s.seasonalityScore;
  const sColor = sType === '寮哄鑺傛€? ? '#3b82f6' : sType === '寮卞鑺傛€? ? '#eab308' : '#22c55e';

  const gtPointsAll = seasonalityData.googleTrendsData?.data5Years || [];
  const gtPoints = gtPointsAll.slice(-156); // 鐙珛鍥捐〃鐢ㄦ渶杩?骞?  const gtLabels = gtPoints.map(p => p.date);
  const gtValues = gtPoints.map(p => p.value);

  let volLabels = [], volValues = [];
  if (seasonalityData.oalurVolumeData?.searchesTrend) {
    const st = seasonalityData.oalurVolumeData.searchesTrend;
    const sortedMonths = Object.keys(st).sort().slice(-36);
    volLabels = sortedMonths.map(m => m.substring(0, 7));
    volValues = sortedMonths.map(m => st[m]);
  }

  // 鈹€鈹€ 鏈轰細鎸囨暟 & 鍦ㄥ敭鍟嗗搧鏁?鈹€鈹€
  let oppLabels = [], oppValues = [], productNumValues = [];
  if (seasonalityData.oalurVolumeData?.oppIndexTrend) {
    const st = seasonalityData.oalurVolumeData.oppIndexTrend;
    const sortedMonths = Object.keys(st).sort().slice(-36);
    oppLabels = sortedMonths.map(m => m.substring(0, 7));
    oppValues = sortedMonths.map(m => st[m]);
  }
  if (seasonalityData.oalurVolumeData?.productTotalNumTrend) {
    const st = seasonalityData.oalurVolumeData.productTotalNumTrend;
    const sortedMonths = Object.keys(st).sort().slice(-36);
    productNumValues = sortedMonths.map(m => st[m]);
  }

  // 鈹€鈹€ TOP3 鐐瑰嚮浠介 & 杞寲浠介锛堝榻愮浉鍚屾湀浠斤級 鈹€鈹€
  let top3Labels = [], topClickValues = [], topConvertValues = [];
  if (seasonalityData.oalurVolumeData?.topClickRatioTrend) {
    const st = seasonalityData.oalurVolumeData.topClickRatioTrend;
    const sortedMonths = Object.keys(st).sort().slice(-36);
    top3Labels = sortedMonths.map(m => m.substring(0, 7));
    topClickValues = sortedMonths.map(m => st[m]);
  }
  if (seasonalityData.oalurVolumeData?.topConvertRatioTrend) {
    const st = seasonalityData.oalurVolumeData.topConvertRatioTrend;
    topConvertValues = top3Labels.map(m => {
      const key = Object.keys(st).find(k => k.substring(0, 7) === m);
      return key ? st[key] : null;
    });
  }

  const hasTop3Data = top3Labels.length > 0 && topClickValues.length > 0;
  const hasOppData = oppLabels.length > 0 && oppValues.length > 0;

  // 鈹€鈹€ 鐭ヨ瘑搴撳垎鏋? TOP3 澶撮儴鍨勬柇搴?鈹€鈹€
  let top3MonopolyAnalysis = '';
  if (hasTop3Data) {
    // 鍙栨渶杩?6 涓湀骞冲潎鍊硷紙浠ｈ〃褰撳墠鐘舵€侊級
    const recentClick = topClickValues.slice(-6).filter(v => v != null);
    const recentConvert = topConvertValues.slice(-6).filter(v => v != null);
    const avgClick = recentClick.length > 0 ? recentClick.reduce((a, b) => a + b, 0) / recentClick.length : 0;
    const avgConvert = recentConvert.length > 0 ? recentConvert.reduce((a, b) => a + b, 0) / recentConvert.length : 0;
    const totalTop3 = avgClick + avgConvert;

    let monopolyLevel, monopolyColor, monopolyAdvice;
    if (avgClick > 50 && avgConvert > 50) {
      monopolyLevel = '馃敶 澶撮儴鍨勬柇涓ラ噸';
      monopolyColor = '#ff4d4f';
      monopolyAdvice = 'TOP3 鐐瑰嚮鍜岃浆鍖栦唤棰濆潎 > 50%锛屼富瑕佹祦閲忓拰鎴愪氦琚ご閮ㄤ骇鍝佺墷鐗㈡帉鎺э紝鏂板崠瀹跺緢闅剧獊鐮淬€傚缓璁鎵炬洿缁嗗垎鐨勫瓙绫荤洰鎴栬蛋宸紓鍖栬矾绾裤€?;
    } else if (avgConvert > 50) {
      monopolyLevel = '馃煛 澶撮儴杞寲鍨勬柇';
      monopolyColor = '#faad14';
      monopolyAdvice = 'TOP3 鐐瑰嚮浠介涓嶉珮浣嗚浆鍖栦唤棰?> 50%锛屾秷璐硅€呮渶缁堜粛鍊惧悜璐拱澶撮儴浜у搧锛屽ご閮ㄨ浆鍖栬兘鍔涘己銆傞渶鍦╨isting璐ㄩ噺鍜屼环鏍间笂鍖归厤澶撮儴鏍囧噯銆?;
    } else if (avgClick > 50) {
      monopolyLevel = '馃煛 澶撮儴鏇濆厜闆嗕腑';
      monopolyColor = '#faad14';
      monopolyAdvice = 'TOP3 鐐瑰嚮浠介 > 50% 浣嗚浆鍖栦唤棰濊緝浣庯紝澶撮儴鏇濆厜闆嗕腑浣嗘祦閲忚鍏朵粬绔炲搧鍒嗘祦銆傚彲鑳芥暣浣撹浆鍖栫巼鍋忎綆锛屾垨绔炲搧鍦ㄥ叾浠栫淮搴︼紙浠锋牸銆佸彉浣撶瓑锛夌珵浜夈€?;
    } else if (avgClick < 20 && avgConvert < 20) {
      monopolyLevel = '馃煝 澶撮儴鍨勬柇浣庯紙浣嗙珵浜夊彲鑳芥縺鐑堬級';
      monopolyColor = '#52c41a';
      monopolyAdvice = 'TOP3 鐐瑰嚮鍜岃浆鍖栦唤棰濆潎 < 20%锛屾棤澶撮儴鍨勬柇銆備絾浣庝唤棰濅篃鍙兘璇存槑甯傚満绔炰簤闈炲父婵€鐑堬紝娴侀噺鏋佸叾鍒嗘暎銆傜粨鍚堟満浼氭寚鏁板拰绔炲搧鏁拌繘涓€姝ュ垽鏂€?;
    } else {
      monopolyLevel = '馃煝 澶撮儴闆嗕腑搴﹂€備腑';
      monopolyColor = '#52c41a';
      monopolyAdvice = 'TOP3 浠介澶勪簬涓瓑姘村钩锛屽競鍦烘湁涓€瀹氶泦涓害浣嗘湭鍨勬柇锛屾柊鍗栧鏈変竴瀹氬垏鍏ョ┖闂淬€?;
    }

    top3MonopolyAnalysis = `
<div style="margin-top:16px;padding:14px;background:#f9f9f9;border-left:4px solid ${monopolyColor};border-radius:8px;">
  <div style="font-size:16px;font-weight:700;color:${monopolyColor};margin-bottom:8px;">${monopolyLevel}</div>
  <div style="font-size:13px;line-height:1.8;color:#555;">
    <strong>鏈€杩?6 涓湀鍧囧€硷細</strong>鐐瑰嚮浠介 ${avgClick.toFixed(1)}% | 杞寲浠介 ${avgConvert.toFixed(1)}% | 澶撮儴鍚堣 ${totalTop3.toFixed(1)}%<br>
    ${monopolyAdvice}
  </div>
</div>`;
  }

  // 鈹€鈹€ 鐭ヨ瘑搴撳垎鏋? 鏈轰細鎸囨暟瓒嬪娍 鈹€鈹€
  let oppAnalysis = '';
  if (hasOppData) {
    const firstHalf = oppValues.slice(0, Math.floor(oppValues.length / 2));
    const secondHalf = oppValues.slice(Math.floor(oppValues.length / 2));
    const avgFirst = firstHalf.length > 0 ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : 0;
    const avgSecond = secondHalf.length > 0 ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : 0;
    const oppTrend = avgSecond - avgFirst;
    const oppTrendPct = avgFirst > 0 ? ((oppTrend / avgFirst) * 100).toFixed(1) : '0';

    // 鍦ㄥ敭鍟嗗搧鏁拌秼鍔?    const prodFirstHalf = productNumValues.slice(0, Math.floor(productNumValues.length / 2));
    const prodSecondHalf = productNumValues.slice(Math.floor(productNumValues.length / 2));
    const prodAvgFirst = prodFirstHalf.length > 0 ? prodFirstHalf.reduce((a, b) => a + b, 0) / prodFirstHalf.length : 0;
    const prodAvgSecond = prodSecondHalf.length > 0 ? prodSecondHalf.reduce((a, b) => a + b, 0) / prodSecondHalf.length : 0;
    const prodTrend = prodAvgSecond - prodAvgFirst;
    const prodTrendPct = prodAvgFirst > 0 ? ((prodTrend / prodAvgFirst) * 100).toFixed(1) : '0';

    let oppTrendText, oppTrendColor, oppAdvice;
    if (oppTrendPct > 15) {
      oppTrendText = '馃搱 鏈轰細鎸囨暟鏄捐憲涓婂崌锛?' + oppTrendPct + '%锛?;
      oppTrendColor = '#52c41a';
      oppAdvice = '闇€姹傚閫熷揩浜庝緵缁欏閫燂紝甯傚満鍦ㄦ墿澶э紝杩涘叆绐楀彛杈冨ソ銆?;
    } else if (oppTrendPct > 5) {
      oppTrendText = '馃搱 鏈轰細鎸囨暟娓╁拰涓婂崌锛?' + oppTrendPct + '%锛?;
      oppTrendColor = '#52c41a';
      oppAdvice = '甯傚満渚涢渶鍏崇郴杞诲井鏀瑰杽锛屽彲鎸佺画鍏虫敞銆?;
    } else if (oppTrendPct > -5) {
      oppTrendText = '鉃★笍 鏈轰細鎸囨暟鍩烘湰绋冲畾锛? + oppTrendPct + '%锛?;
      oppTrendColor = '#faad14';
      oppAdvice = '甯傚満渚涢渶鐩稿骞宠　锛岀珵浜夋牸灞€绋冲畾銆?;
    } else if (oppTrendPct > -15) {
      oppTrendText = '馃搲 鏈轰細鎸囨暟涓嬮檷锛? + oppTrendPct + '%锛?;
      oppTrendColor = '#ff4d4f';
      oppAdvice = '绔炰簤鍔犲墽鎴栭渶姹傝悗缂╋紝杩涘叆闇€璋ㄦ厧銆?;
    } else {
      oppTrendText = '馃搲 鏈轰細鎸囨暟鏄捐憲涓嬮檷锛? + oppTrendPct + '%锛?;
      oppTrendColor = '#ff4d4f';
      oppAdvice = '甯傚満蹇€熸伓鍖栵紝渚涚粰澧為暱杩滆秴闇€姹傛垨闇€姹傚ぇ骞呰悗缂┿€備笉寤鸿姝ゆ椂杩涘叆銆?;
    }

    let prodTrendText = prodTrendPct > 10 ? `鍦ㄥ敭鍟嗗搧鏁板闀?${prodTrendPct}%锛堝崠瀹舵寔缁秾鍏ワ級` :
      prodTrendPct > 0 ? `鍦ㄥ敭鍟嗗搧鏁板皬骞呭闀?${prodTrendPct}%` :
      `鍦ㄥ敭鍟嗗搧鏁颁笅闄?${Math.abs(prodTrendPct)}%锛堝競鍦虹珵浜夎€呭噺灏戞垨瓒嬩簬绋冲畾锛塦;

    oppAnalysis = `
<div style="margin-top:16px;padding:14px;background:#f9f9f9;border-left:4px solid ${oppTrendColor};border-radius:8px;">
  <div style="font-size:16px;font-weight:700;color:${oppTrendColor};margin-bottom:8px;">${oppTrendText}</div>
  <div style="font-size:13px;line-height:1.8;color:#555;">
    <strong>鍓嶅崐娈靛潎鍊硷細</strong>${avgFirst.toFixed(1)} 鈫?<strong>鍚庡崐娈靛潎鍊硷細</strong>${avgSecond.toFixed(1)}<br>
    ${oppAdvice}<br>
    <strong>鍦ㄥ敭鍟嗗搧鏁帮細</strong>${prodTrendText}
  </div>
</div>`;
  }

  // 鈹€鈹€ 鐭ヨ瘑搴撳垎鏋? 鏍囧搧/闈炴爣鍝佸垽鏂?鈹€鈹€
  let productTypeAnalysis = '';
  if (hasTop3Data && hasOppData) {
    // 鍩轰簬 TOP3 浠介鍒嗘暎搴﹀拰鏈轰細鎸囨暟鍒ゆ柇鏍囧搧/闈炴爣鍝佸€惧悜
    const recentClick = topClickValues.slice(-6).filter(v => v != null);
    const avgClick = recentClick.length > 0 ? recentClick.reduce((a, b) => a + b, 0) / recentClick.length : 0;

    // 鍏抽敭璇嶉泦涓害锛氱敤鎼滅储鎺掑悕鐨勭ǔ瀹氭€ф潵鍒ゆ柇锛坰earchesRankTrend 鍙樺寲骞呭害澶?闈炴爣鍝侊級
    let rankVolatility = 0;
    if (seasonalityData.oalurVolumeData?.searchesRankTrend) {
      const rankData = seasonalityData.oalurVolumeData.searchesRankTrend;
      const rankValues = Object.keys(rankData).sort().slice(-36).map(k => rankData[k]);
      if (rankValues.length > 1) {
        const rankMean = rankValues.reduce((a, b) => a + b, 0) / rankValues.length;
        rankVolatility = rankValues.reduce((s, v) => s + Math.abs(v - rankMean), 0) / rankValues.length / Math.max(rankMean, 1);
      }
    }

    let typeLabel, typeColor, typeDesc;
    if (avgClick > 50) {
      typeLabel = '鏍囧搧鍊惧悜';
      typeColor = '#1890ff';
      typeDesc = 'TOP3 鐐瑰嚮浠介闆嗕腑锛?50%锛夛紝娴侀噺闆嗕腑鍦ㄥ皯鏁版牳蹇冭瘝锛岀鍚堟爣鍝佺殑娴侀噺鐗瑰緛銆傚叧閿瘝鎺掑悕鍙樺寲骞呭害' + (rankVolatility > 0.3 ? '杈冨ぇ' : '杈冨皬') + '銆?;
    } else if (avgClick < 30 && rankVolatility > 0.3) {
      typeLabel = '闈炴爣鍝佸€惧悜';
      typeColor = '#722ed1';
      typeDesc = 'TOP3 鐐瑰嚮浠介鍒嗘暎锛?30%锛夛紝鍏抽敭璇嶆帓鍚嶆尝鍔ㄥぇ锛屾祦閲忓垎鏁ｅ埌闀垮熬璇嶏紝绗﹀悎闈炴爣鍝佺殑娴侀噺鐗瑰緛銆?;
    } else {
      typeLabel = '娣峰悎鍨?;
      typeColor = '#faad14';
      typeDesc = '娴侀噺闆嗕腑搴︿粙浜庢爣鍝佸拰闈炴爣鍝佷箣闂达紝鍙兘瀛樺湪澶氫釜缁嗗垎闇€姹傛柟鍚戙€傚缓璁繘涓€姝ュ垎鏋愬瓙绫荤洰銆?;
    }

    productTypeAnalysis = `
<div style="margin-top:12px;padding:14px;background:linear-gradient(135deg,#f0f5ff,#f5f0ff);border-radius:8px;">
  <div style="font-size:15px;font-weight:700;color:${typeColor};margin-bottom:6px;">馃彿锔?${typeLabel}</div>
  <div style="font-size:13px;line-height:1.8;color:#555;">
    ${typeDesc}<br>
    <strong>馃摉 鐭ヨ瘑搴撳缓璁細</strong>${typeLabel.includes('鏍囧搧') ? '鏍囧搧闇€璧拌嚜涓昏璁＄爺鍙戞柟鍚戯紝鎵撻€犳牳蹇冪珵浜夊姏锛岄伩鍏嶇函浠锋牸绔炰簤銆傝€冭檻鍋氬搧鐗岃皟鎬у樊寮傚寲锛堝楂樼瀹氫綅锛夈€? : typeLabel.includes('闈炴爣鍝?) ? '闈炴爣鍝侀€傚悎涓皬鍗栧鍒囧叆锛屽彲灏濊瘯寰垱鏂帮紙澶栬/鍔熻兘缁勫悎/鍦烘櫙鍖栵級寤虹珛宸紓鍖栥€傛敞鎰忔妸鎻″鑺傛€х獥鍙ｃ€? : '娣峰悎鍨嬪競鍦洪渶杩涗竴姝ョ粏鍒嗭紝鎵惧埌灞炰簬闈炴爣鍝佹柟鍚戠殑鍒囧叆鐐癸紝閬垮厤鍦ㄦ爣鍝佸ぇ璇嶄笂鐑ч挶鍐呭嵎銆?}
  </div>
</div>`;
  }

  const monthNames = ['1鏈?,'2鏈?,'3鏈?,'4鏈?,'5鏈?,'6鏈?,'7鏈?,'8鏈?,'9鏈?,'10鏈?,'11鏈?,'12鏈?];
  const gtMonthAvgs = s.googleMonthAvgs || [];
  const oaMonthAvgs = s.oalurMonthAvgs || [];

  // Google Trends 鍛ㄧ骇 鈫?鏈堢骇 + Oalur 鏈堝害鏁版嵁 鈫?瀵归綈閲嶅彔鏈堜唤
  const gtMonthlyMap = {};
  gtPointsAll.forEach(p => {
    if (p.date && p.date.length >= 7) {
      const m = p.date.substring(0, 7);
      if (!gtMonthlyMap[m]) gtMonthlyMap[m] = { sum: 0, count: 0 };
      gtMonthlyMap[m].sum += p.value;
      gtMonthlyMap[m].count += 1;
    }
  });
  const oalurMonthlyMap = {};
  volLabels.forEach((l, i) => { oalurMonthlyMap[l] = volValues[i]; });
  const allMonths = [...new Set([...Object.keys(gtMonthlyMap), ...Object.keys(oalurMonthlyMap)])].sort();
  const compareLabels = allMonths.filter(m => oalurMonthlyMap[m] !== undefined);
  const compareGtVals = compareLabels.map(m => Math.round(gtMonthlyMap[m]?.sum / gtMonthlyMap[m]?.count) || null);
  const compareOaVals = compareLabels.map(m => oalurMonthlyMap[m] || null);

  const peakText = s.seasonalityType === '寮哄鑺傛€? ? '鏃哄鍓?涓湀澶囪揣锛屾椇瀛ｅ墠1涓湀鎺ㄥ箍鍛娿€傛敞鎰忔帶鍒舵贰瀛ｅ簱瀛樸€?
    : s.seasonalityType === '寮卞鑺傛€? ? '鏈夋俯鍜屽鑺傛€ф尝鍔紝鍙弬鑰冩椇瀛ｆ湀浠戒紭鍖栧箍鍛婃姇鏀捐妭濂忋€?
    : '鏃犳槑鏄惧鑺傛€э紝鍙叏骞寸ǔ瀹氳繍钀ワ紝搴撳瓨鍘嬪姏杈冨皬銆?;

  // ASIN 瓒嬪娍鍥捐〃锛堟敼涓烘湀閿€鍞锛岀旱鍧愭爣缁熶竴锛?  let asinChartsHtml = '';
  let asinChartsJs = '';
  let asinMaxRevenue = 0;
  const asinProducts = seasonalityData.asinTrendsData?.products;
  if (asinProducts) {
    // 鍙繚鐣欏綋鍓嶈繃婊ゅ悗浜у搧鍒楄〃涓殑 ASIN锛堢‘淇濅笌浜у搧鏄庣粏琛ㄤ竴鑷达級
    const currentFilteredAsins = new Set(data.map(d => d.asin).filter(Boolean));
    const validProducts = asinProducts.filter(p => p.trendData && currentFilteredAsins.has(p.asin));
    // 璁＄畻鎵€鏈?ASIN 鐨勬渶澶ф湀閿€鍞锛堢敤浜庣粺涓€绾靛潗鏍囷級锛屽悜涓婂彇鏁村埌鍗冧綅
    validProducts.forEach(p => {
      const revs = p.trendData.monthlyRevenue.map(v => {
        const n = parseInt(String(v).replace(/[$,]/g, ''));
        return isNaN(n) ? 0 : n;
      });
      const maxR = Math.max(...revs, 0);
      if (maxR > asinMaxRevenue) asinMaxRevenue = maxR;
    });
    asinMaxRevenue = Math.ceil(asinMaxRevenue / 1000) * 1000 || 1000;

    validProducts.forEach((p, idx) => {
      const ms = p.trendData.months;
      const rs = p.trendData.monthlyRevenue.map(v => {
        const n = parseInt(String(v).replace(/[$,]/g, ''));
        return isNaN(n) ? 0 : n;
      });
      asinChartsHtml += `
    <div class="card" style="margin-bottom:12px;">
      <h3 style="font-size:14px;">馃搱 ${p.asin} (${p.brand || 'N/A'}) 鈥?${(p.title || '').substring(0, 80)}</h3>
      <div class="chart-container" style="height:250px;">
        <canvas id="asinChart${idx}"></canvas>
      </div>
    </div>`;
      asinChartsJs += `
  (function() {
    const c = document.getElementById('asinChart${idx}');
    if (c) new Chart(c, {
      type: 'bar',
      data: { labels: ${JSON.stringify(ms)}, datasets: [{ label: '鏈堥攢鍞(\$)', data: ${JSON.stringify(rs)}, backgroundColor: 'rgba(16,185,129,0.6)', borderColor: 'rgba(16,185,129,1)', borderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: ${asinMaxRevenue}, title: { display: true, text: '\$' } } } }
    });
  })();`;
    });
  }

  // 瑕嗙洊椤堕儴姹囨€诲崱鐗囩殑瀛ｈ妭鎬х粨璁?  const sColorHex = sType === '寮哄鑺傛€? ? '#3b82f6' : sType === '寮卞鑺傛€? ? '#eab308' : '#22c55e';
  replacements['{{SEASONALITY_SUMMARY}}'] = `<span style="color:${sColorHex};font-weight:700">${sType}</span>`;
  replacements['{{SEASONALITY_SUMMARY_CLASS}}'] = '';

  const seasonalityBlock = `
<h1 style="margin-top:32px;">馃寑 瀛ｈ妭鎬т笌甯傚満瓒嬪娍鍒嗘瀽</h1>

<div class="card">
  <div class="summary">
    <div class="metric"><div class="value" style="color:${sColor}">${sType}</div><div class="label">瀛ｈ妭鎬х被鍨?/div></div>
    <div class="metric"><div class="value">${sScore}</div><div class="label">瀛ｈ妭鎬у緱鍒?/div></div>
    <div class="metric"><div class="value">${s.googlePeakMonths.map(m => m + '鏈?).join('銆?) || '鏃?}</div><div class="label">Google 宄板€兼湀浠?/div></div>
    <div class="metric"><div class="value">${s.oalurPeakMonths.join('銆?) || '鏃?}</div><div class="label">Oalur 宄板€兼湀浠?/div></div>
  </div>
  <div style="margin-top:16px;padding:12px;background:#f0f5ff;border-radius:8px;font-size:14px;line-height:1.8;">
    <strong>馃搱 Google Trends:</strong> ${s.googleTrendsShape}<br>
    <strong>馃敆 鏁版嵁涓€鑷存€?</strong> ${s.googleVsOalurDeviation || '鏈娴嬪埌鏄庢樉鍋忓樊'}<br>
    <strong>馃挕 绛栫暐寤鸿:</strong> ${peakText}
  </div>
</div>

<div class="chart-row">
  <div class="card">
    <h2>馃搱 Google Trends 鈥?5骞存悳绱㈠叴瓒ｈ秼鍔?/h2>
    <div class="chart-container"><canvas id="gtChart"></canvas></div>
  </div>
  <div class="card">
    <h2>馃搳 Oalur 鈥?鏈堝害鎼滅储閲忚秼鍔匡紙36涓湀锛?/h2>
    <div class="chart-container"><canvas id="oalurVolChart"></canvas></div>
  </div>
</div>

<div class="card">
  <h2>馃敩 Google vs Oalur 鏈堝害鏁版嵁瀵规瘮锛堥噸鍙犳湀浠斤級</h2>
  <div class="chart-container"><canvas id="compareChart"></canvas></div>
  <div style="margin-top:12px;padding:12px;background:#f0f5ff;border-radius:8px;font-size:13px;line-height:1.9;">
    <strong>馃摉 鐭ヨ瘑搴撹В璇伙紙绗叓绔?瀛ｈ妭鎬т笌鐢熷懡鍛ㄦ湡锛夛細</strong><br>
    鈥?Google Trends 鍙嶆槧鍏ㄧ綉鎼滅储鍏磋叮锛堝寘鍚俊鎭悳绱級锛孫alur 鍙嶆槧浜氶┈閫婄珯鍐呰喘鐗╂悳绱?br>
    鈥?涓よ€呭嘲鍊兼湀浠藉鏈夊亸宸紙閫氬父 Oalur 婊炲悗 1-2 涓湀锛夛紝<strong>浠?Oalur 绔欏唴鏁版嵁涓哄噯</strong>鍒跺畾澶囪揣鍜屽箍鍛婅鍒?br>
    鈥?Google 宄拌胺姣?鈮? 鈫?鏄庢樉瀛ｈ妭鎬э紱Oalur 宄拌胺姣?鈮?.5 鈫?寮哄鑺傛€?br>
    鈥?鈿狅笍 鏂版墜鍗栧涓嶅缓璁秹瓒宠妭鏃ユ€т骇鍝侊紙绐楀彛浠?-3涓湀锛屽璐ч闄╂瀬楂橈級<br>
    鈥?鍒ゆ柇甯傚満闇€姹傚繀椤荤敤绔欏唴鏁版嵁宸ュ叿锛屼笉鍙粎渚濊禆 Google Trends<br>
    鈥?馃搵 鍐崇瓥娓呭崟锛欸oogle娉㈠姩鏄庢樉? | 绔欏唴鎼滅储閲忎竴鑷? | BSR鐗瑰畾鏈堜唤鍙嶅宄板€? | 鏄惁涓鸿妭鏃ユ€т骇鍝?
  </div>
</div>

${hasOppData ? `
<div class="chart-row">
  <div class="card">
    <h2>馃挕 Oalur 鈥?鏈堝害鏈轰細鎸囨暟瓒嬪娍锛?6涓湀锛?/h2>
    <div class="chart-container"><canvas id="oppIndexChart"></canvas></div>
  </div>
  <div class="card">
    <h2>馃摝 Oalur 鈥?鏈堝害鍦ㄥ敭鍟嗗搧鏁拌秼鍔匡紙36涓湀锛?/h2>
    <div class="chart-container"><canvas id="productNumChart"></canvas></div>
  </div>
</div>
<div style="margin-top:12px;padding:12px;background:#f0f5ff;border-radius:8px;font-size:13px;line-height:1.9;">
  <strong>馃摉 鏈轰細鎸囨暟瑙ｈ锛?/strong><br>
  鈥?鏈轰細鎸囨暟 = 鎼滅储閲?/ 鍦ㄥ敭鍟嗗搧鏁帮紝鏁板€艰秺楂樿〃绀洪渶姹傜浉瀵逛緵缁欒秺鏃虹洓锛岃繘鍏ユ満浼氳秺澶?br>
  鈥?鏈轰細鎸囨暟鎸佺画涓婂崌 鈫?闇€姹傚閫熷揩浜庝緵缁欙紝甯傚満鍦ㄦ墿澶э紱鎸佺画涓嬮檷 鈫?绔炰簤鍔犲墽鎴栭渶姹傝悗缂?br>
  鈥?鍦ㄥ敭鍟嗗搧鏁版寔缁闀?鈫?鏂板崠瀹朵笉鏂秾鍏ワ紝绔炰簤鍔犲墽锛涚ǔ瀹氭垨涓嬮檷 鈫?甯傚満瓒嬩簬鎴愮啛鎴栭ケ鍜?br>
  ${oppAnalysis}
</div>
` : ''}

${hasTop3Data ? `
<div class="card">
  <h2>馃弳 TOP3 浜у搧鐐瑰嚮浠介 & TOP3 杞寲浠介锛?6涓湀锛屽悎骞跺鐓э級</h2>
  <div class="chart-row">
    <div class="chart-container" style="height:300px;"><canvas id="top3Chart"></canvas></div>
  </div>
  ${top3MonopolyAnalysis}
  ${productTypeAnalysis}
  <div style="margin-top:12px;padding:12px;background:#f0f5ff;border-radius:8px;font-size:13px;line-height:1.9;">
    <strong>馃摉 鐭ヨ瘑搴撹В璇伙紙鏍囧搧vs闈炴爣鍝?& TOP3鍨勬柇搴︼級锛?/strong><br>
    鈥?TOP3鐐瑰嚮浠介鍜岃浆鍖栦唤棰濋兘 > 50% 鈫?澶撮儴鍨勬柇涓ラ噸锛屾柊鍗栧寰堥毦绐佺牬<br>
    鈥?鐐瑰嚮浠介 > 50% 浣嗚浆鍖栦綆 鈫?澶撮儴鏇濆厜闆嗕腑浣嗘祦閲忚鍒嗘祦锛屽彲鑳藉湪浠锋牸/鍙樹綋绛夌淮搴︽湁绔炰簤绌洪棿<br>
    鈥?涓よ€呴兘 < 20% 鈫?澶撮儴鍨勬柇浣庯紝浣嗕篃鍙兘璇存槑绔炰簤闈炲父婵€鐑堬紙澶ц瘝甯歌锛?br>
    鈥?娴侀噺闆嗕腑鍦ㄥ皯鏁板ぇ璇?鈫?鏍囧搧鐗瑰緛锛涙祦閲忓垎鏁ｅ埌闀垮熬 鈫?闈炴爣鍝佺壒寰?br>
    鈥?鈿狅笍 鐐瑰嚮浠介鍜岃浆鍖栦唤棰濇槸<strong>涓嶅悓缁村害</strong>锛屽垎鍒弽鏄犳洕鍏夐泦涓害鍜屾垚浜ら泦涓害
  </div>
</div>
` : ''}

${asinChartsHtml ? `
<h2 style="color:#333;border-bottom:2px solid #1890ff;padding-bottom:8px;margin:16px 0;font-size:18px;">馃搱 鑰佸搧 ASIN 鏈堝害閿€鍞瓒嬪娍锛堜笂鏋?3骞达紝缁熶竴绾靛潗鏍囷級</h2>
<div style="font-size:13px;color:#666;margin-bottom:12px;">
  閫夊彇涓婃灦鏃堕棿 >3 骞淬€侀攢鍞搴︽帴杩戯紙閬垮紑澶撮儴浜у搧锛夌殑 ${seasonalityData.pickedAsins?.length || 0} 涓€佸搧 ASIN锛屽垎鏋愬叾杩?5涓湀鏈堝害閿€鍞瓒嬪娍锛?</div>
${asinChartsHtml}
` : ''}

<script>
(function() {
  const c = document.getElementById('gtChart');
  if (!c) return;
  new Chart(c, {
    type: 'line',
    data: { labels: ${JSON.stringify(gtLabels)}, datasets: [{ label: '鎼滅储鍏磋叮', data: ${JSON.stringify(gtValues)}, borderColor: '#667eea', backgroundColor: 'rgba(102,126,234,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
})();
(function() {
  const c = document.getElementById('oalurVolChart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: { labels: ${JSON.stringify(volLabels)}, datasets: [{ label: '鏈堟悳绱㈤噺', data: ${JSON.stringify(volValues)}, backgroundColor: 'rgba(251,146,60,0.6)', borderColor: '#fb923c', borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
})();
(function() {
  const c = document.getElementById('compareChart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(compareLabels)},
      datasets: [
        { label: 'Google Trends锛堟湀鍧囷級', data: ${JSON.stringify(compareGtVals)}, backgroundColor: 'rgba(102,126,234,0.4)', borderColor: '#667eea', borderWidth: 1, yAxisID: 'y' },
        { label: 'Oalur 鎼滅储閲?, data: ${JSON.stringify(compareOaVals)}, backgroundColor: 'rgba(251,146,60,0.4)', borderColor: '#fb923c', borderWidth: 1, yAxisID: 'y1' }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { title: { display: true, text: '鏈堜唤' } }, y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Google Trends锛堝叴瓒ｅ€硷級' } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Oalur 鎼滅储閲? } } } }
  });
})();
${hasOppData ? `
(function() {
  const c = document.getElementById('oppIndexChart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: { labels: ${JSON.stringify(oppLabels)}, datasets: [{ label: '鏈轰細鎸囨暟', data: ${JSON.stringify(oppValues)}, backgroundColor: 'rgba(147,51,234,0.6)', borderColor: '#9333ea', borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: '鏈轰細鎸囨暟' } } } }
  });
})();
(function() {
  const c = document.getElementById('productNumChart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: { labels: ${JSON.stringify(oppLabels)}, datasets: [{ label: '鍦ㄥ敭鍟嗗搧鏁?, data: ${JSON.stringify(productNumValues)}, backgroundColor: 'rgba(14,165,233,0.6)', borderColor: '#0ea5e9', borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: '鍦ㄥ敭鍟嗗搧鏁? } } } }
  });
})();
` : ''}
${hasTop3Data ? `
(function() {
  const c = document.getElementById('top3Chart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(top3Labels)},
      datasets: [
        { label: 'TOP3 鐐瑰嚮浠介(%)', data: ${JSON.stringify(topClickValues)}, backgroundColor: 'rgba(239,68,68,0.5)', borderColor: '#ef4444', borderWidth: 1, yAxisID: 'y' },
        { label: 'TOP3 杞寲浠介(%)', data: ${JSON.stringify(topConvertValues)}, backgroundColor: 'rgba(34,197,94,0.5)', borderColor: '#22c55e', borderWidth: 1, yAxisID: 'y' }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { title: { display: true, text: '鏈堜唤' } }, y: { beginAtZero: true, max: 100, title: { display: true, text: '%' } } } }
  });
})();
` : ''}
${asinChartsJs}
<\/script>`;

  replacements['{{SEASONALITY_BLOCK}}'] = seasonalityBlock;
} else {
  replacements['{{SEASONALITY_BLOCK}}'] = '';
}
*/

// ============ Seasonality and market trend summary ============
if (seasonalityData && seasonalityData.seasonality) {
  const s = seasonalityData.seasonality;
  const normalizeMonth = (m) => {
    const matched = String(m || '').match(/\d{1,2}/);
    return matched ? `${parseInt(matched[0], 10)}月` : String(m || '');
  };
  const normalizeSeasonalityType = (type) => {
    const raw = String(type || '');
    if (raw.includes('强') || raw.includes('寮哄')) return '强季节性';
    if (raw.includes('弱') || raw.includes('寮卞')) return '弱季节性';
    if ((s.seasonalityScore || 0) >= 60) return '强季节性';
    return raw || '未识别';
  };
  const trendSeries = (trend, limit = 36) => {
    const keys = Object.keys(trend || {}).sort().slice(-limit);
    return {
      labels: keys.map(k => k.substring(0, 7)),
      values: keys.map(k => Number(trend[k])).filter(Number.isFinite)
    };
  };
  const sType = normalizeSeasonalityType(s.seasonalityType);
  const sScore = s.seasonalityScore ?? '-';
  const sColor = sType === '强季节性' ? '#3b82f6' : sType === '弱季节性' ? '#eab308' : '#22c55e';
  const gtPoints = (seasonalityData.googleTrendsData?.data5Years || []).slice(-156);
  const gtLabels = gtPoints.map(p => p.date);
  const gtValues = gtPoints.map(p => Number(p.value)).filter(Number.isFinite);
  const searchSeries = trendSeries(seasonalityData.oalurVolumeData?.searchesTrend);
  const oppSeries = trendSeries(seasonalityData.oalurVolumeData?.oppIndexTrend);
  const productSeries = trendSeries(seasonalityData.oalurVolumeData?.productTotalNumTrend);
  const clickSeries = trendSeries(seasonalityData.oalurVolumeData?.topClickRatioTrend);
  const convertMap = seasonalityData.oalurVolumeData?.topConvertRatioTrend || {};
  const convertValues = clickSeries.labels.map(label => {
    const key = Object.keys(convertMap).find(k => k.substring(0, 7) === label);
    return key ? Number(convertMap[key]) : null;
  });
  const recentAverage = (trend) => {
    const values = Object.keys(trend).sort().slice(-6).map(k => Number(trend[k])).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const avgClick = recentAverage(seasonalityData.oalurVolumeData?.topClickRatioTrend || {});
  const avgConvert = recentAverage(seasonalityData.oalurVolumeData?.topConvertRatioTrend || {});
  const seriesChange = (values) => {
    const nums = values.filter(Number.isFinite);
    if (nums.length < 4) return null;
    const mid = Math.floor(nums.length / 2);
    const first = nums.slice(0, mid);
    const second = nums.slice(mid);
    const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
    const avgSecond = second.reduce((a, b) => a + b, 0) / second.length;
    return {
      avgFirst,
      avgSecond,
      deltaPct: avgFirst > 0 ? ((avgSecond / avgFirst - 1) * 100) : null
    };
  };
  const oppChange = seriesChange(oppSeries.values);
  const productChange = seriesChange(productSeries.values);
  const oppAnalysisText = oppChange
    ? `机会指数从前半段均值 ${oppChange.avgFirst.toFixed(1)} 变为后半段 ${oppChange.avgSecond.toFixed(1)}，变化 ${oppChange.deltaPct == null ? '无法计算' : oppChange.deltaPct.toFixed(1) + '%'}。${oppChange.deltaPct != null && oppChange.deltaPct > 10 ? '需求相对供给改善，市场机会边际增强。' : oppChange.deltaPct != null && oppChange.deltaPct < -10 ? '机会指数走弱，可能是供给增加快于需求或需求回落。' : '机会指数整体较稳定，需结合 CPC 和利润核算判断真实机会。'}`
    : '机会指数历史点不足，暂不能形成趋势判断。';
  const productAnalysisText = productChange
    ? `在售商品数从前半段均值 ${productChange.avgFirst.toFixed(0)} 变为后半段 ${productChange.avgSecond.toFixed(0)}，变化 ${productChange.deltaPct == null ? '无法计算' : productChange.deltaPct.toFixed(1) + '%'}。${productChange.deltaPct != null && productChange.deltaPct > 10 ? '供给端明显增加，后续竞争和广告成本可能上升。' : productChange.deltaPct != null && productChange.deltaPct < -10 ? '供给端减少，可能存在出清或需求降温，需要结合搜索量判断。' : '供给端相对稳定。'}`
    : '在售商品数历史点不足，暂不能形成趋势判断。';
  const top3AnalysisText = avgClick == null || avgConvert == null
    ? 'TOP3 点击/转化数据不足，不能判断头部流量和成交集中度。'
    : `${avgClick > 50 || avgConvert > 50 ? '头部集中风险偏高。' : avgClick < 20 && avgConvert < 20 ? '头部集中度较低，但也可能代表流量高度分散、竞争面更广。' : '头部集中度中等。'}最近 6 个月 TOP3 点击份额均值 ${avgClick.toFixed(1)}%，转化份额均值 ${avgConvert.toFixed(1)}%。点击份额代表曝光集中度，转化份额代表成交集中度，二者都需要和广告 CPC、评论壁垒一起判断。`;
  const oppStandardText = '机会指数上升且在售商品数稳定或下降，代表需求相对供给改善；机会指数下降且在售商品数上升，代表供给挤压或需求走弱；变化幅度超过 10% 视为需要重点关注。';
  const top3StandardText = 'TOP3 点击或转化份额 >50% 为头部集中风险偏高；两者均 <20% 为头部垄断弱但流量分散；20%-50% 为中等集中度，需要结合 CPC、评论壁垒和新品存活率判断。';
  const computeGooglePeakMonths = () => {
    const points = seasonalityData.googleTrendsData?.data5Years || seasonalityData.googleTrendsData?.data || [];
    if (!points.length) return [];
    const monthByYear = {};
    points.forEach(p => {
      if (!p.date || p.date.length < 7) return;
      const year = p.date.substring(0, 4);
      const month = p.date.substring(5, 7);
      const value = Number(p.value);
      if (!Number.isFinite(value)) return;
      if (!monthByYear[year]) monthByYear[year] = {};
      monthByYear[year][month] = value;
    });
    const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    const avgs = months.map(m => {
      let sum = 0;
      let count = 0;
      Object.values(monthByYear).forEach(yd => {
        if (yd[m] !== undefined) {
          sum += yd[m];
          count += 1;
        }
      });
      return count > 0 ? sum / count : 0;
    });
    const maxAvg = Math.max(...avgs);
    if (!Number.isFinite(maxAvg) || maxAvg <= 0) return [];
    return months.filter((m, i) => avgs[i] >= maxAvg * 0.85);
  };
  const googlePeakMonths = (s.googlePeakMonths && s.googlePeakMonths.length > 0)
    ? s.googlePeakMonths
    : computeGooglePeakMonths();
  const googlePeakNote = googlePeakMonths.length > 0
    ? 'Google 峰值月按 5 年周级搜索兴趣汇总为多年月均值，达到最高月均值 85% 以上的月份计为峰值月。'
    : 'Google Trends 数据缺失或无法解析，Google 峰值月暂不参与判断。';
  const googlePeaks = googlePeakMonths.map(normalizeMonth).join('、') || '无';
  const oalurPeaks = (s.oalurPeakMonths || []).map(normalizeMonth).join('、') || '无';
  const dataConsistency = (() => {
    if (!googlePeakMonths.length || !(s.oalurPeakMonths || []).length) return s.googleVsOalurDeviation || 'Google 或 Oalur 峰值月不足，无法做峰值一致性判断';
    const gtSet = new Set(googlePeakMonths.map(m => parseInt(String(m).match(/\d{1,2}/)?.[0] || '0', 10)).filter(Boolean));
    const oalurSet = new Set((s.oalurPeakMonths || []).map(m => parseInt(String(m).match(/\d{1,2}/)?.[0] || '0', 10)).filter(Boolean));
    const overlap = [...gtSet].filter(m => oalurSet.has(m));
    if (overlap.length === 0) return '峰值月份不一致，请优先以 Oalur 站内搜索量为准';
    if (overlap.length < Math.min(gtSet.size, oalurSet.size)) return '峰值月份部分一致，Oalur 站内峰值可能滞后或更集中';
    return '峰值月份一致';
  })();
  const seasonAdvice = sType === '强季节性'
    ? '该品类旺季集中，需提前 2-3 个月完成采购和入仓，淡季库存与现金流风险较高。'
    : '季节性压力相对较低，但仍需结合站内搜索量、BSR 和广告成本验证全年稳定性。';

  replacements['{{SEASONALITY_SUMMARY}}'] = `<span style="color:${sColor};font-weight:700">${sType}</span>`;
  replacements['{{SEASONALITY_SUMMARY_CLASS}}'] = '';
  replacements['{{SEASONALITY_BLOCK}}'] = `
<div class="card">
  <h2>季节性与市场趋势分析</h2>
  <div class="metric-grid">
    <div class="metric"><div class="value" style="color:${sColor}">${sType}</div><div class="label">季节性类型</div></div>
    <div class="metric"><div class="value">${sScore}</div><div class="label">季节性得分</div></div>
    <div class="metric"><div class="value">${googlePeaks}</div><div class="label">Google 峰值月</div></div>
    <div class="metric"><div class="value">${oalurPeaks}</div><div class="label">Oalur 峰值月</div></div>
  </div>
  <div style="padding:10px 14px;background:#f0f5ff;border-radius:8px;font-size:13px;line-height:1.8;margin-bottom:16px;">
    <strong>数据一致性：</strong>${dataConsistency}<br>
    <strong>Google 判断口径：</strong>${googlePeakNote}<br>
    <strong>知识库解读：</strong>${seasonAdvice} 判断季节性必须用 Google Trends、站内搜索量、BSR/销量趋势交叉验证，不能只看单一工具。<br>
    <strong>TOP3 最近6月：</strong>点击份额 ${avgClick == null ? '未采集' : avgClick.toFixed(1) + '%'}；转化份额 ${avgConvert == null ? '未采集' : avgConvert.toFixed(1) + '%'}。
  </div>
  <div class="chart-row">
    <div>
      <h2>Google Trends 搜索兴趣</h2>
      <div class="chart-container"><canvas id="seasonGtChart"></canvas></div>
    </div>
    <div>
      <h2>Oalur 月度搜索量</h2>
      <div class="chart-container"><canvas id="seasonSearchChart"></canvas></div>
    </div>
  </div>
  <div class="chart-row">
    <div>
      <h2>机会指数与在售商品数</h2>
      <div class="chart-container"><canvas id="seasonOppChart"></canvas></div>
      <div style="margin-top:8px;padding:10px 12px;background:#f0f5ff;border-radius:8px;font-size:12px;line-height:1.8;color:#555;">
        <strong>分析：</strong>${oppAnalysisText}<br>
        <strong>供给侧：</strong>${productAnalysisText}<br>
        <strong>评判标准：</strong>${oppStandardText}
      </div>
    </div>
    <div>
      <h2>TOP3 点击份额与转化份额</h2>
      <div class="chart-container"><canvas id="seasonTop3Chart"></canvas></div>
      <div style="margin-top:8px;padding:10px 12px;background:#fff7e6;border-radius:8px;font-size:12px;line-height:1.8;color:#555;">
        <strong>分析：</strong>${top3AnalysisText}<br>
        <strong>评判标准：</strong>${top3StandardText}
      </div>
    </div>
  </div>
</div>`;
  replacements['{{SEASONALITY_BLOCK}}'] += `
<script>
(function(){
  function drawChart(id, config) {
    var el = document.getElementById(id);
    if (el && window.Chart) new Chart(el, config);
  }
  drawChart('seasonGtChart', {
    type: 'line',
    data: { labels: ${JSON.stringify(gtLabels)}, datasets: [{ label: 'Google Trends', data: ${JSON.stringify(gtValues)}, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', tension: 0.25, fill: true }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }
  });
  drawChart('seasonSearchChart', {
    type: 'bar',
    data: { labels: ${JSON.stringify(searchSeries.labels)}, datasets: [{ label: '月度搜索量', data: ${JSON.stringify(searchSeries.values)}, backgroundColor: 'rgba(251,146,60,0.65)', borderColor: '#fb923c', borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
  drawChart('seasonOppChart', {
    type: 'line',
    data: { labels: ${JSON.stringify(oppSeries.labels)}, datasets: [
      { label: '机会指数', data: ${JSON.stringify(oppSeries.values)}, borderColor: '#9333ea', backgroundColor: 'rgba(147,51,234,0.08)', tension: 0.25, yAxisID: 'y' },
      { label: '在售商品数', data: ${JSON.stringify(productSeries.values)}, borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.08)', tension: 0.25, yAxisID: 'y1' }
    ] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, position: 'left' }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } } }
  });
  drawChart('seasonTop3Chart', {
    type: 'line',
    data: { labels: ${JSON.stringify(clickSeries.labels)}, datasets: [
      { label: 'TOP3 点击份额', data: ${JSON.stringify(clickSeries.values)}, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)', tension: 0.25 },
      { label: 'TOP3 转化份额', data: ${JSON.stringify(convertValues)}, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.08)', tension: 0.25 }
    ] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100 } } }
  });
})();
</script>`;
} else {
  replacements['{{SEASONALITY_BLOCK}}'] = '';
}

// ============ ASIN lifecycle analysis ============
if (lifecycleData && lifecycleData.products && lifecycleData.products.length > 0) {
  const lifecycleKeyword = (jsonData.keyword || 'unknown').replace(/\s+/g, '-');
  const lifecycleReportName = `${REPORT_DATE}_${lifecycleKeyword}_ASIN生命周期趋势分析.html`;
  const normalizeLifecycle = (value) => {
    const raw = String(value || '');
    if (raw.includes('衰') || raw.includes('琛伴')) return '衰退期';
    if (raw.includes('后期') || raw.includes('鍚庢湡')) return '成熟后期';
    if (raw.includes('成熟') || raw.includes('鎴愮啛')) return '健康成熟';
    return raw || '未识别';
  };
  const lifecycleRows = lifecycleData.products.map(p => {
    const priceChangePct = p.priceFirst > 0 ? ((p.priceLast / p.priceFirst - 1) * 100).toFixed(1) : '0';
    const priceArrow = parseFloat(priceChangePct) > 5 ? '↑' : parseFloat(priceChangePct) < -5 ? '↓' : '→';
    const bsrChange = p.bsrFirst > 0 && p.bsrLast > 0 ? (p.bsrLast - p.bsrFirst) : 0;
    const bsrArrow = bsrChange > 0 ? '↓' : bsrChange < 0 ? '↑' : '→';
    const lifecycle = normalizeLifecycle(p.lifecycle);
    return `<tr>
      <td><a href="https://www.amazon.com/dp/${p.asin}" target="_blank">${p.asin}</a></td>
      <td>$${p.priceFirst.toFixed(2)} → $${p.priceLast.toFixed(2)} ${priceArrow}（${priceChangePct}%）</td>
      <td>#${p.bsrFirst.toLocaleString()} → #${p.bsrLast.toLocaleString()} ${bsrArrow}</td>
      <td>${p.ratingsFirst.toLocaleString()} → ${p.ratingsLast.toLocaleString()}（${p.ratingPerMonth}/月）</td>
      <td><span class="${p.lifecycleClass}">${lifecycle}</span></td>
    </tr>`;
  }).join('\n');

  replacements['{{LIFECYCLE_BLOCK}}'] = `
<div class="card">
  <h2>老品 ASIN 生命周期分析</h2>
  <p style="color:#666;font-size:13px;margin-bottom:12px;">
    从当前市场中抽取上架时间较长的代表性 ASIN，基于 Oalur 导出的 <strong>Buybox 价格 / Ratings 数 / 大类 BSR</strong> 趋势判断生命周期。
  </p>
  <div style="padding:10px 14px;background:#fff7e6;border-left:4px solid #faad14;border-radius:8px;font-size:13px;line-height:1.8;margin-bottom:12px;">
    <strong>独立老品 ASIN 生命周期分析报告：</strong>
    <a href="./${lifecycleReportName}" target="_blank">${lifecycleReportName}</a><br>
    主报告只展示生命周期摘要；完整价格、Ratings、BSR 趋势图请打开该独立报告查看。
  </div>
  <table>
    <tr><th>ASIN</th><th>价格趋势</th><th>BSR 趋势</th><th>Ratings 增长</th><th>生命周期</th></tr>
    ${lifecycleRows}
  </table>
  <div style="margin-top:12px;padding:8px 12px;background:#f0f5ff;border-radius:6px;font-size:12px;color:#666;line-height:1.8;">
    <strong>知识库生命周期判定标准：</strong><br>
    1. 价格后半段低于前半段 7% 以上，说明价格下行，可能进入成熟后期或衰退期。<br>
    2. BSR 后半段显著变差，说明竞争力下降。<br>
    3. Ratings 月增速明显放缓，是成熟期后段的重要信号。<br>
    4. 均价持续走低叠加头部评论增速放缓，通常意味着价格内卷和生命周期下行。<br>
    <strong>当前缺口：</strong>生命周期判断仍依赖 Oalur 可导出的有限 ASIN，建议继续扩大样本，并结合广告位、价格促销频率和断货记录验证。
  </div>
</div>`;
}

// 鎵ц鏇挎崲
// ============ 知识库缺口审计与产品缺陷提示 ============
const auditItems = [];

function auditRow(level, item, current, impact, nextStep) {
  const color = level === '高风险' ? '#ff4d4f' : level === '中风险' ? '#faad14' : '#1890ff';
  return `<tr>
    <td style="font-weight:bold;color:${color};white-space:nowrap;">${level}</td>
    <td>${item}</td>
    <td>${current}</td>
    <td>${impact}</td>
    <td>${nextStep}</td>
  </tr>`;
}

const avgPriceNumForAudit = parseFloat(String(avgPrice).replace('$', '')) || 0;
const lowPriceRisk = priceNums.length > 0 && priceNums.filter(p => p < 10).length / priceNums.length > 0.5;
const reviewBarrierHigh = top20AvgReviews >= 600 || reviewMedian >= 350 || top20LowReviewCount < 3;
const strongSeasonal = seasonalityData?.seasonality?.seasonalityType === '强季节性';
const oalurPeakMonths = seasonalityData?.seasonality?.oalurPeakMonths || [];
const top3ClickTrend = seasonalityData?.oalurVolumeData?.topClickRatioTrend || null;
const top3ConvertTrend = seasonalityData?.oalurVolumeData?.topConvertRatioTrend || null;
function avgLastTrendValues(obj, count = 6) {
  const vals = Object.entries(obj || {}).sort().slice(-count).map(([, v]) => Number(v)).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
const top3ClickLast6 = avgLastTrendValues(top3ClickTrend);
const top3ConvertLast6 = avgLastTrendValues(top3ConvertTrend);

auditItems.push(auditRow(
  data.length <= 30 ? '高风险' : '中风险',
  '市场容量最低门槛',
  `过滤后 ${data.length} 个产品；知识库最低门槛为 BSR 底线内 >30 个高相关 SKU`,
  data.length <= 30 ? '当前样本低于最低容量门槛，说明该细分类目有效需求或可竞争坑位不足。' : '数量刚过最低线时仍需结合评论壁垒、利润和新品存活率判断。',
  '用 Amazon 最小类目页或其他工具交叉验证该类目 BSR 底线内 SKU 数，确认不是 Oalur 搜索词口径偏窄。'
));

auditItems.push(auditRow(
  lowPriceRisk ? '高风险' : '中风险',
  '利润与现金流未验证',
  `均价 ${avgPrice}；Oalur 平均 FBA ${avgFbaFee == null ? '未采集' : '$' + avgFbaFee.toFixed(2)}；平均毛利率 ${avgMarginPct == null ? '未采集' : avgMarginPct.toFixed(1) + '%'}；<$10 产品占 ${lowPricePct}%`,
  `知识库要求毛利率 >=35%，售价至少为成本 4 倍，且有效成本率 >100%。当前已做 Oalur FBA&毛利率快筛，但没有采购成本、头程、包装、CPC 和有效成本率，仍不能证明该品类最终可赚钱。${avgPriceNumForAudit < 10 ? ' 低客单价会压缩广告和退货容错空间。' : ''}`,
  '补采 2-3 家供应商中间段 MOQ 报价、包装尺寸/重量、头程、CPC 和佣金口径，复核毛利率与有效成本率。'
));

auditItems.push(auditRow(
  reviewBarrierHigh ? '高风险' : '中风险',
  '评论壁垒偏高',
  `前20平均评论 ${top20AvgReviews}；评论中位数 ${reviewMedian.toLocaleString()}；前20中评论<100 的产品 ${top20LowReviewCount} 个`,
  '知识库标准为前20平均 <600、评论中位数 <350、前20中评论<100 至少 3 个。当前评论壁垒偏高，新品转化和自然排名追赶成本较大。',
  '补采前 10-20 个竞品的评论时间分布、差评标题、QA 和评分结构，区分真实壁垒与可改进缺陷机会。'
));

auditItems.push(auditRow(
  strongSeasonal ? '高风险' : '中风险',
  '季节性与库存风险',
  strongSeasonal ? `强季节性；Oalur 旺季月份：${oalurPeakMonths.join('、') || '未识别'}` : `季节性：${seasonalityData?.seasonality?.seasonalityType || '未分析'}`,
  '知识库要求季节性产品做 Google Trends、站内搜索量和 BSR 波动交叉验证。强季节性会放大备货、现金流和错过旺季窗口的风险。',
  '补充旺季前 3 个月备货计划、供应商交期、补货周期、淡季清仓策略，并验证 ASIN 多年同月 BSR/销量波动。'
));

auditItems.push(auditRow(
  '中风险',
  'CPC 与广告壁垒未验证',
  '当前报告没有核心关键词 CPC、首页广告位品牌结构、旺季 CPC 波动',
  '知识库将 $1.4 CPC 作为美国站十人团队上限；若 CPC 超标，即使市场容量够，也可能被广告成本吞噬利润。',
  '补采核心 3-5 个关键词 CPC、首页广告位品牌、旺季/淡季 CPC，并加入 ACoS 容忍度判断。'
));

auditItems.push(auditRow(
  '中风险',
  '专利/认证风险未排查',
  `目标类目：${jsonData.targetCategory || '--'}；当前报告未检查 USPTO、外观专利、食品接触材料或儿童产品认证`,
  '知识库指出“需求大但卖家少”可能意味着专利或认证门槛。Cookie Cutter 属厨房/食品接触工具，材料安全与食品接触合规需要单独确认。',
  '补充 USPTO/Google 图片/专利库检索、食品接触材料要求、工厂认证文件，报告中增加合规结论。'
));

auditItems.push(auditRow(
  '中风险',
  '用户痛点和产品缺陷未解析',
  '当前只抓了评论数量，没有抓评论标题、1-3 星差评、QA、具体抱怨词',
  '知识库要求从差评和 QA 中提炼具体产品因素，否则无法判断应改尺寸、材质、锋利度、清洗便利性、套装组合还是包装。',
  '抓取前 10 个竞品评论标题/差评/QA，输出高频痛点、对应产品因素和可执行改款方向。'
));

auditItems.push(auditRow(
  (parseFloat(top3ItemShare) > 45 || parseFloat(top3BrandShare) > 45) ? '高风险' : '中风险',
  '标品/非标品差异化不足',
  top3ClickLast6 != null && top3ConvertLast6 != null
    ? `最近6月 TOP3 点击份额均值 ${top3ClickLast6.toFixed(1)}%，转化份额均值 ${top3ConvertLast6.toFixed(1)}%`
    : '缺少 TOP3 点击/转化趋势或关键词长尾分布',
  '知识库指出标品普货会越来越卷，必须走自主设计、组合微创新或高端定位。仅靠市场容量不能证明可进入。',
  '补采核心词/长尾词分布、竞品功能/尺寸/套装/材质矩阵，增加“可差异化切入点”表。'
));

auditItems.push(auditRow(
  '中风险',
  '供应链、包装与成本口径缺失',
  `当前已解析 Oalur FBA 估算，平均 ${avgFbaFee == null ? '未采集' : '$' + avgFbaFee.toFixed(2)}；但未量化包装方案、头程、MOQ 和供应商专业度`,
  '知识库强调包装高度/尺寸会直接改变 FBA 费用，MOQ 和中间段价格决定真实首单现金流。',
  '从抓取数据中增加重量/体积分布；补充供应商报价、包装尺寸和头程后复核 FBA 档位和包装优化空间。'
));

auditItems.push(auditRow(
  historicalData ? '中风险' : '高风险',
  '数据口径仍需交叉验证',
  historicalData ? `已加载 ${historicalData.timeFilter} 历史数据，但仍是 Oalur 可见榜单口径` : '未加载历史数据',
  '知识库要求最小类目页、长期 BSR 波动、多工具交叉验证。当前数据来自 Oalur 页面，不等于 Amazon 原生最小类目的完整历史。',
  '保留数据口径说明；必要时用 Amazon 最小类目页、Keepa/Helium10 与 Oalur 数据交叉验证。'
));

replacements['{{KNOWLEDGE_AUDIT_BLOCK}}'] = `
<div class="card">
  <h2>📌 知识库缺口审计与产品缺陷提示</h2>
  <p style="font-size:13px;color:#666;line-height:1.8;margin-bottom:12px;">
    该模块基于 <code>./knowledge</code> 中的选品方法论，对当前 Oalur 抓取数据无法证明的关键决策项做缺口审计。
    结论原则：已有数据只用于市场/竞争初筛；利润、合规、用户痛点和供应链未验证前，不应直接进入开发。
  </p>
  <table>
    <tr><th>风险等级</th><th>知识库检查项</th><th>当前证据</th><th>对决策的影响</th><th>下一步补采/优化</th></tr>
    ${auditItems.join('\n')}
  </table>
  <div class="conclusion caution" style="font-size:16px;text-align:left;line-height:1.8;">
    当前报告适合作为“市场容量与竞争初筛”，还不能单独作为最终开发决策。
    必须补齐毛利核算、CPC、专利认证、评论痛点、供应链报价和包装/FBA 成本后，再判断是否进入样品开发。
  </div>
</div>`;
for (const [key, val] of Object.entries(replacements)) {
  html = html.split(key).join(val);
}

// Save report.
const keyword = (jsonData.keyword || 'unknown').replace(/\s+/g, '-');
const outPath = path.join(outputDirsFromDataFile(resolvedDataPath, keyword).reports, REPORT_DATE + '_' + keyword + '_市场分析.html');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf-8');
console.log('报告已保存:', outPath);
console.log('\n=== 摘要 ===');
console.log('关键词:', jsonData.keyword);
console.log('目标类目:', jsonData.targetCategory);
console.log('过滤后:', data.length, '条 | 排除:', excluded.length, '条');
console.log('新品:', newProducts, '个 (' + newPct + '%)');
console.log('结论:', conclusion, '-', reason);
console.log('\n=== 竞争分析 ===');
console.log('单品占比: TOP1=' + top1ItemShare + '%, TOP5=' + top5ItemShare + '%, TOP10=' + top10ItemShare + '%');
console.log('品牌集中度: TOP1=' + top1Brand[0] + '(' + top1BrandShare + '%), TOP3=' + top3BrandShare + '%, 分散度=' + brandDispersion + '%');
console.log('评论数: 平均 ' + avgReviews + ', <500 评论占 ' + lowReviewPct + '%');
console.log('卖家结构: ' + topSellerType[0] + ' 占比 ' + topSellerShare + '%');
console.log('竞争结论:', compConclusion);

