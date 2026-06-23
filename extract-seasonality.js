/**
 * 季节性与生命周期分析脚本
 * 整合 Google Trends + Oalur 搜索量 + ASIN 销量趋势，生成分析报告
 *
 * 用法: node extract-seasonality.js "关键词" <BSR数据文件.json> [输出文件.json]
 * 示例: node extract-seasonality.js "Biscuit Cutter" output/日期-Biscuit-Cutter/data/biscuit-data.json output/日期-Biscuit-Cutter/data/biscuit-seasonality.json
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { localKeywordIntentAnalysis } = require('./keyword-intent-ai');
const { createRunLogger } = require('./run-log');

function safeSegment(value) {
  return String(value || 'output').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function outputDirs(taskName) {
  const date = new Date().toISOString().split('T')[0];
  const root = path.join(process.cwd(), 'output', `${date}-${safeSegment(taskName)}`);
  return {
    root,
    data: path.join(root, 'data'),
    reports: path.join(root, 'reports'),
    excel: path.join(root, 'excel'),
    cache: path.join(root, 'cache')
  };
}

const SKILL_DIR = __dirname;

const rawKeyword = process.argv[2];
function firstKeyword(value) {
  return String(value || '')
    .split(/\s*,\s*|\s+\+\s+/)
    .map(s => s.trim())
    .filter(Boolean)[0] || '';
}

const keyword = firstKeyword(rawKeyword);
const bsrDataFile = process.argv[3];
const safeName = safeSegment(keyword || 'output');
const defaultDirs = outputDirs(keyword || 'output');
const outFile = process.argv[4] || path.join(defaultDirs.data, safeName + '-seasonality.json');
const dirs = process.argv[4]
  ? (() => {
      const dataDir = path.resolve(path.dirname(outFile));
      const root = path.basename(dataDir).toLowerCase() === 'data'
        ? path.dirname(dataDir)
        : dataDir;
      return {
        root,
        data: dataDir,
        reports: path.join(root, 'reports'),
        excel: path.join(root, 'excel'),
        cache: path.join(root, 'cache')
      };
    })()
  : defaultDirs;
fs.mkdirSync(dirs.data, { recursive: true });

if (!rawKeyword || !keyword) {
  console.error('用法: node extract-seasonality.js "关键词" <BSR数据文件.json> [输出文件.json]');
  process.exit(1);
}

const logger = createRunLogger({
  outputFile: outFile,
  keyword,
  scriptName: 'extract-seasonality.js'
});
logger.start({
  rawKeyword,
  keyword,
  bsrDataFile: bsrDataFile ? path.relative(process.cwd(), path.resolve(bsrDataFile)) : null,
  outFile: path.relative(process.cwd(), path.resolve(outFile)),
  logFile: path.relative(process.cwd(), logger.logFile)
});
console.log(`Run log: ${path.relative(process.cwd(), logger.logFile)}`);

const gtrendsFile = path.join(dirs.data, safeName + '-google-trends.json');
const oalurVolFile = path.join(dirs.data, safeName + '-oalur-volume.json');
const asinTrendsFile = path.join(dirs.data, safeName + '-asin-trends.json');
const keywordIntentFile = path.join(dirs.data, 'keyword-intent-analysis.json');
const nodeBin = process.execPath;
const googleTrendsAttempts = [];

function googleTrendsQuality(data) {
  const points = data?.data5Years || data?.data || [];
  if (!Array.isArray(points) || points.length === 0) {
    return { ok: false, reason: 'missing Google Trends timeline data', points: 0, nonzero: 0, nonzeroRate: 0 };
  }
  const values = points.map(p => Number(p.value)).filter(Number.isFinite);
  const nonzero = values.filter(v => v > 0).length;
  const nonzeroRate = values.length ? nonzero / values.length : 0;
  const max = values.length ? Math.max(...values) : 0;
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const sparse = values.length >= 52 && (nonzero < 24 || nonzeroRate < 0.15);
  if (sparse) {
    return {
      ok: false,
      reason: `Google Trends data is too sparse: ${nonzero}/${values.length} nonzero points (${Math.round(nonzeroRate * 100)}%)`,
      points: values.length,
      nonzero,
      nonzeroRate,
      max,
      avg
    };
  }
  return { ok: true, reason: '', points: values.length, nonzero, nonzeroRate, max, avg };
}

function runLocalKeywordAgent(keyword) {
  const analysis = localKeywordIntentAnalysis(keyword, [
    'Google Trends routing uses this local-agent core keyword plan before falling back from sparse long-tail data.'
  ]);
  const payload = {
    generatedAt: new Date().toISOString(),
    model: null,
    usedOpenAI: false,
    filteringImpact: 'none',
    warning: 'Local keyword agent output is used for Google Trends core-term routing; product filtering still uses category and market data rules.',
    keywords: [analysis]
  };
  try {
    fs.writeFileSync(keywordIntentFile, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    console.warn(`Keyword intent analysis write skipped: ${error.message}`);
  }
  return analysis;
}

function uniqueStrings(values) {
  return [...new Set((values || [])
    .map(value => String(value || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean))];
}

function googleTrendsFallbackKeywords(value, keywordAgent) {
  const agentCandidates = uniqueStrings([
    ...(keywordAgent?.googleTrendsKeywords || []),
    keywordAgent?.coreKeyword
  ]);
  const cleaned = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const agentFallbacks = agentCandidates.filter(candidate => {
    const normalized = candidate.toLowerCase();
    return normalized && normalized !== cleaned && normalized.split(/\s+/).length >= 2;
  });
  if (agentFallbacks.length) return agentFallbacks;

  // Defensive fallback if the local-agent payload is unavailable.
  if (!cleaned) return [];

  const candidates = [];
  const beforeFor = cleaned.split(/\s+for\s+/i)[0]?.trim();
  if (beforeFor && beforeFor !== cleaned) candidates.push(beforeFor);

  const specWords = new Set([
    'gallon', 'gallons', 'gal', 'quart', 'quarts', 'qt', 'oz', 'ounce', 'ounces',
    'liter', 'liters', 'litre', 'litres', 'ml', 'lb', 'lbs', 'inch', 'inches',
    'ft', 'feet', 'cm', 'mm', 'small', 'large', 'xl', 'mini', 'wide', 'tall',
    'clear', 'white', 'black', 'silver', 'gold', 'plastic', 'glass', 'metal',
    'stainless', 'steel', 'wood', 'wooden', 'pack', 'packs', 'set', 'with'
  ]);
  const tokens = cleaned
    .split(/\s+/)
    .filter(token => token && !/^\d+([./-]\d+)?$/.test(token))
    .filter(token => !/^\d+(oz|qt|gal|ml|l|lb|lbs|in|inch|cm|mm)?$/.test(token))
    .filter(token => !specWords.has(token));

  if (tokens.length >= 2) candidates.push(tokens.join(' '));
  if (tokens.length >= 3) candidates.push(tokens.slice(-2).join(' '));

  const synonymPhrases = {
    'drink dispenser': ['beverage dispenser'],
    'water dispenser': ['beverage dispenser'],
    'beverage tub': ['drink tub'],
    'ice bucket': ['ice bucket'],
    'coffee maker': ['coffee maker'],
    'salt pepper grinder': ['pepper grinder', 'salt grinder']
  };
  for (const candidate of [...candidates]) {
    for (const [phrase, synonyms] of Object.entries(synonymPhrases)) {
      if (candidate.includes(phrase)) candidates.push(...synonyms);
    }
  }

  return uniqueStrings(candidates).filter(candidate => candidate !== cleaned && candidate.split(/\s+/).length >= 2);
}

function runGoogleTrendsExtraction(queryKeyword, outputFile) {
  const attempt = {
    queryKeyword,
    outputFile: path.relative(process.cwd(), outputFile),
    startedAt: new Date().toISOString()
  };
  const startedMs = Date.now();
  try {
    execFileSync(
      nodeBin,
      [path.join(SKILL_DIR, 'extract-google-trends.js'), queryKeyword, outputFile],
      { stdio: 'inherit', timeout: 90000, env: { ...process.env, OALUR_RUN_LOG: logger.logFile } }
    );
    const data = fs.existsSync(outputFile) ? JSON.parse(fs.readFileSync(outputFile, 'utf-8')) : null;
    const points = data?.data5Years || data?.data || [];
    attempt.completedAt = new Date().toISOString();
    attempt.durationMs = Date.now() - startedMs;
    attempt.status = data?.error && !points.length ? 'failed' : 'completed';
    attempt.points = Array.isArray(points) ? points.length : 0;
    attempt.error = data?.error || null;
    googleTrendsAttempts.push(attempt);
    logger.info('google_trends.attempt', attempt);
    return data;
  } catch (error) {
    attempt.completedAt = new Date().toISOString();
    attempt.durationMs = Date.now() - startedMs;
    attempt.status = 'failed';
    attempt.error = error.message;
    googleTrendsAttempts.push(attempt);
    logger.warn('google_trends.attempt', attempt);
    throw error;
  }
}

function annotateGoogleTrendsData(data, requestedKeyword, queryKeyword, quality, fallbackReason = '') {
  if (!data) return data;
  data.requestedKeyword = requestedKeyword;
  data.queryKeyword = queryKeyword;
  data.quality = quality || googleTrendsQuality(data);
  if (fallbackReason) data.keywordFallbackReason = fallbackReason;
  return data;
}

const SEASONALITY_MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

function median(values) {
  const arr = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!arr.length) return 0;
  return arr[Math.floor(arr.length / 2)];
}

function circularMonthDistance(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!x || !y) return 12;
  const diff = Math.abs(x - y);
  return Math.min(diff, 12 - diff);
}

function isNearPeakMonth(month, peakMonths) {
  return peakMonths.some(peak => circularMonthDistance(month, peak) <= 1);
}

function analyzeMonthlySeasonality(entries, options = {}) {
  const limit = options.limit || 36;
  const sorted = entries
    .filter(item => item.month && Number.isFinite(Number(item.value)))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-limit);
  if (!sorted.length) {
    return {
      level: 'none',
      score: 0,
      peakMonths: [],
      monthAvgs: SEASONALITY_MONTHS.map(() => 0),
      reason: 'no monthly data'
    };
  }

  const monthBuckets = {};
  const yearBuckets = {};
  for (const item of sorted) {
    const year = item.month.slice(0, 4);
    const month = item.month.slice(5, 7);
    if (!monthBuckets[month]) monthBuckets[month] = [];
    monthBuckets[month].push(Number(item.value) || 0);
    if (!yearBuckets[year]) yearBuckets[year] = [];
    yearBuckets[year].push({ month, value: Number(item.value) || 0 });
  }

  const monthAvgs = SEASONALITY_MONTHS.map(month => {
    const arr = monthBuckets[month] || [];
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  });
  const positive = monthAvgs.filter(v => v > 0);
  const maxAvg = positive.length ? Math.max(...positive) : 0;
  const minAvg = positive.length ? Math.min(...positive) : 0;
  const medianAvg = median(monthAvgs);
  const peakAvgRatio = minAvg > 0 ? maxAvg / minAvg : maxAvg;
  const maxMedianRatio = medianAvg > 0 ? maxAvg / medianAvg : maxAvg;
  const totalAvg = monthAvgs.reduce((a, b) => a + b, 0);
  const top2Share = totalAvg > 0
    ? [...monthAvgs].sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0) / totalAvg
    : 0;
  const peakMonths = maxAvg > 0
    ? SEASONALITY_MONTHS
        .filter((month, index) => monthAvgs[index] >= Math.max(maxAvg * 0.85, medianAvg * 1.25))
        .map(month => Number(month))
    : [];

  const validYears = Object.entries(yearBuckets)
    .filter(([, rows]) => rows.length >= 8)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-3)
    .map(([year, rows]) => {
      const peak = [...rows].sort((a, b) => b.value - a.value)[0];
      return { year, peakMonth: Number(peak.month), peakValue: peak.value, count: rows.length };
    });
  const stableYearCount = peakMonths.length
    ? validYears.filter(item => isNearPeakMonth(item.peakMonth, peakMonths)).length
    : 0;

  const recentRows = sorted.slice(-12);
  const recentPeak = recentRows.length ? [...recentRows].sort((a, b) => b.value - a.value)[0] : null;
  const recentValues = recentRows.map(item => Number(item.value) || 0);
  const recentMedian = median(recentValues);
  const recentPeakRatio = recentPeak && recentMedian > 0 ? Number(recentPeak.value) / recentMedian : 0;
  const recentStillPeak = recentPeak && peakMonths.length
    ? isNearPeakMonth(Number(recentPeak.month.slice(5, 7)), peakMonths) && recentPeakRatio >= 1.25
    : false;

  const strong = peakAvgRatio >= 2.5 &&
    maxMedianRatio >= 1.5 &&
    top2Share >= 0.24 &&
    stableYearCount >= 2 &&
    recentStillPeak;
  const weak = !strong && peakAvgRatio >= 1.8 &&
    maxMedianRatio >= 1.25 &&
    (stableYearCount >= 2 || recentStillPeak || top2Share >= 0.22);
  const level = strong ? 'strong' : weak ? 'weak' : 'none';
  const score = strong ? 60 : weak ? 40 : 0;
  const reason = [
    `月均峰谷比 ${peakAvgRatio.toFixed(2)}`,
    `峰值/中位月 ${maxMedianRatio.toFixed(2)}`,
    `Top2月占比 ${(top2Share * 100).toFixed(1)}%`,
    `近3个完整/近完整年份峰值命中 ${stableYearCount}/${validYears.length}`,
    recentPeak ? `最近12月峰值 ${recentPeak.month}，相对中位 ${recentPeakRatio.toFixed(2)}x` : '最近12月数据不足'
  ].join('；');

  return {
    level,
    score,
    peakMonths,
    monthAvgs: monthAvgs.map(v => Math.round(v)),
    peakAvgRatio,
    maxMedianRatio,
    top2Share,
    stableYearCount,
    validYearCount: validYears.length,
    yearPeaks: validYears,
    recentPeakMonth: recentPeak?.month || '',
    recentPeakRatio,
    recentStillPeak: Boolean(recentStillPeak),
    reason
  };
}

function analyzeAsinSalesSeasonality(asinTrends) {
  const products = asinTrends?.products || [];
  const totals = {};
  for (const product of products) {
    const months = product.trendData?.months || [];
    const sales = product.trendData?.monthlySales || [];
    months.forEach((month, index) => {
      totals[month] = (totals[month] || 0) + (Number(sales[index]) || 0);
    });
  }
  const evidence = analyzeMonthlySeasonality(
    Object.entries(totals).map(([month, value]) => ({ month, value })),
    { limit: 36 }
  );
  return {
    ...evidence,
    productCount: products.filter(product => product.trendData?.months?.length).length
  };
}

// ============================================
// 上架时间解析工具
// ============================================
function parseAgeMonths(item) {
  if (item.listingAge) {
    const y = item.listingAge.match(/(\d+)年/);
    const m = item.listingAge.match(/(\d+)月/);
    return (y ? parseInt(y[1]) : 0) * 12 + (m ? parseInt(m[1]) : 0);
  }
  if (item.listingDate) {
    const listed = new Date(item.listingDate);
    const now = new Date();
    return (now.getFullYear() - listed.getFullYear()) * 12 + (now.getMonth() - listed.getMonth());
  }
  return -1;
}

// 解析小类排名
function parseSubRank(subRankStr) {
  if (!subRankStr) return 0;
  const n = parseInt(subRankStr.replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

// 解析销售额（从 Oalur 预估销售额字段，如 "$70,003.3" → 70003.3）
function parseRevenue(d) {
  if (!d.revenue) return 0;
  const s = d.revenue.replace(/[$,]/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ============================================
// 从 BSR 数据中选取上架 >3 年且销售额度相近的 ASIN（5-6 个）
// 条件：上架 >3 年、销售额度接近、排除头部产品
// ============================================
function pickOldAsins(bsrData, count = 6) {
  if (!bsrData || !bsrData.data || bsrData.data.length === 0) return [];

  // 按 BSR 排序，排除 head 产品（跳过排名最高的以免选到#1 #2）
  const sortedByBsr = [...bsrData.data].sort((a, b) => (a.bsr || 999999) - (b.bsr || 999999));
  const skipHeadCount = Math.min(5, Math.floor(sortedByBsr.length * 0.15)); // 跳过前15%的头部
  const nonHeadProducts = sortedByBsr.slice(skipHeadCount);

  const oldProducts = nonHeadProducts
    .filter(d => parseAgeMonths(d) > 36)
    .filter(d => d.asin)
    .map(d => ({
      ...d,
      ageMonths: parseAgeMonths(d),
      revenueNum: parseRevenue(d)
    }))
    .filter(d => d.revenueNum > 0); // 必须有销售额数据

  if (oldProducts.length === 0) return [];
  if (oldProducts.length <= count) return oldProducts.slice(0, count);

  // 按上架时间段分组：3-4年、4-5年、5年+
  const groups = {};
  oldProducts.forEach(p => {
    let key;
    if (p.ageMonths <= 48) key = '3-4年';
    else if (p.ageMonths <= 60) key = '4-5年';
    else key = '5年+';
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  // 选产品数最多的组（同一时间段更有可比性）
  const largestGroup = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)[0][1];

  const groupLabel = Object.entries(groups).sort((a,b)=>b[1].length-a[1].length)[0][0];
  console.log(`  选取上架时间段: ${groupLabel} (${largestGroup.length} 个产品)`);

  // 按销售额排序
  const sorted = largestGroup.sort((a, b) => a.revenueNum - b.revenueNum);

  // 滑窗找销售额最接近的 count 个产品
  let bestWindow = null;
  let bestRange = Infinity;
  for (let i = 0; i <= sorted.length - count; i++) {
    const window = sorted.slice(i, i + count);
    const revRange = window[window.length - 1].revenueNum - window[0].revenueNum;
    // 归一化：用相对差值（极差/中位数）来衡量集中度
    const medianRev = window[Math.floor(window.length / 2)].revenueNum;
    const normalizedRange = medianRev > 0 ? revRange / medianRev : revRange;
    if (normalizedRange < bestRange) {
      bestRange = normalizedRange;
      bestWindow = window;
    }
  }

  // 按销售额从高到低排序展示
  const result = (bestWindow || sorted.slice(0, count))
    .sort((a, b) => b.revenueNum - a.revenueNum);

  console.log(`  销售额范围: $${Math.min(...result.map(p => p.revenueNum)).toLocaleString()} ~ $${Math.max(...result.map(p => p.revenueNum)).toLocaleString()}`);
  console.log(`  上架时间: ${result.map(p => p.listingAge || p.listingDate || '--').join(', ')}`);
  result.forEach(p => console.log(`    ${p.asin} | $${Math.round(p.revenueNum).toLocaleString()} | BSR#${p.bsr} | ${p.listingAge || p.listingDate || '--'}`));

  return result;
}

// ============================================
// 季节性分析
// ============================================
function analyzeSeasonality(gtData, oalurVolData, asinTrends) {
  const result = {
    googleTrendsShape: '',
    googlePeakMonths: [],
    googleMonthAvgs: null,
    oalurPeakMonths: [],
    oalurMonthAvgs: null,
    seasonalityScore: 0,
    seasonalityType: 'unknown',
    googleVsOalurDeviation: ''
  };

  // ─── Google Trends 分析 ───
  if (gtData && (gtData.data5Years || gtData.data) && (gtData.data5Years || gtData.data).length > 0) {
    const points = gtData.data5Years || gtData.data;
    const quality = googleTrendsQuality(gtData);

    // Group weekly Google Trends points by calendar month, then judge seasonality by month averages.
    const monthBuckets = {};
    points.forEach(p => {
      if (p.date && p.date.length >= 7) {
        const month = p.date.substring(5, 7);
        if (!monthBuckets[month]) monthBuckets[month] = [];
        monthBuckets[month].push(Number(p.value) || 0);
      }
    });

    const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    const monthAvgs = {};
    months.forEach(m => {
      const arr = monthBuckets[m] || [];
      monthAvgs[m] = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    });

    const avgValues = months.map(m => monthAvgs[m] || 0);
    const maxMonthVal = Math.max(...avgValues);
    const nonZeroMonthVals = avgValues.filter(v => v > 0);
    const minMonthVal = nonZeroMonthVals.length ? Math.min(...nonZeroMonthVals) : 0;
    const peakValleyRatio = minMonthVal > 0 ? maxMonthVal / minMonthVal : maxMonthVal;
    const medianMonthVal = nonZeroMonthVals.length
      ? [...nonZeroMonthVals].sort((a, b) => a - b)[Math.floor(nonZeroMonthVals.length / 2)]
      : 0;
    const displayPeakThreshold = Math.max(maxMonthVal * 0.84, medianMonthVal * 1.08);
    result.googlePeakMonths = peakValleyRatio >= 1.25
      ? months.filter((m, i) => {
          const prev = avgValues[(i + 11) % 12];
          const next = avgValues[(i + 1) % 12];
          return avgValues[i] >= displayPeakThreshold && avgValues[i] >= prev && avgValues[i] >= next;
        })
      : [];
    result.googleMonthAvgs = months.map(m => Math.round(monthAvgs[m] || 0));

    if (!quality.ok) {
      result.googleTrendsShape = `Google Trends 数据过稀疏，不参与季节性判断（${quality.reason}）`;
    } else if (peakValleyRatio >= 2.0 && result.googlePeakMonths.length > 0) {
      result.googleTrendsShape = `明显的季节性峰谷（月均峰谷比=${peakValleyRatio.toFixed(1)}）`;
      result.seasonalityScore += 50;
    } else if (peakValleyRatio >= 1.5 && result.googlePeakMonths.length > 0) {
      result.googleTrendsShape = `温和的季节性波动（月均峰谷比=${peakValleyRatio.toFixed(1)}）`;
      result.seasonalityScore += 30;
    } else {
      result.googleTrendsShape = `无明显季节性（月均峰谷比=${peakValleyRatio.toFixed(1)}）`;
    }

    console.log(`\n📈 Google Trends 分析:`);
    console.log(`  数据点: ${points.length} 个, 峰谷比: ${peakValleyRatio.toFixed(1)}`);
    console.log(`  趋势形态: ${result.googleTrendsShape}`);
    console.log(`  峰值月份: ${result.googlePeakMonths.map(m => m + '月').join('、')}`);
    console.log(`  各月均值: ${months.map((m, i) => m + '月=' + Math.round(avgValues[i])).join(' ')}`);
  }

  // ─── Oalur 搜索量分析 ───
  let oalurSeasonality = { level: 'none', score: 0, peakMonths: [], reason: 'no Oalur monthly search data' };
  if (oalurVolData && oalurVolData.searchesTrend) {
    const allMonths = Object.keys(oalurVolData.searchesTrend).sort();
    const recentMonths = allMonths.slice(-36);
    const trendEntries = recentMonths.map(month => ({ month, value: Number(oalurVolData.searchesTrend[month]) || 0 }));
    oalurSeasonality = analyzeMonthlySeasonality(trendEntries, { limit: 36 });

    result.oalurPeakMonths = oalurSeasonality.peakMonths.map(month => month + '月');
    result.oalurMonthAvgs = oalurSeasonality.monthAvgs;
    result.oalurSeasonality = oalurSeasonality;
    result.seasonalityScore = Math.max(result.seasonalityScore, oalurSeasonality.score);

    console.log(`\n📊 Oalur 搜索量分析 (${recentMonths.length} 个月):`);
    console.log(`  证据等级: ${oalurSeasonality.level}`);
    console.log(`  ${oalurSeasonality.reason}`);
    console.log(`  旺季月份: ${result.oalurPeakMonths.join('、') || '无'}`);
  }

  // ─── 最终判定 ───
  const asinSeasonality = analyzeAsinSalesSeasonality(asinTrends);
  result.asinSeasonality = asinSeasonality;

  const googleIsNotSeasonal = /无明显|过稀疏/.test(result.googleTrendsShape);
  const googleLevel = !googleIsNotSeasonal && result.googlePeakMonths.length > 0 && /明显/.test(result.googleTrendsShape)
    ? 'strong'
    : !googleIsNotSeasonal && result.googlePeakMonths.length > 0 && /温和/.test(result.googleTrendsShape)
      ? 'weak'
      : 'none';
  const oalurLevel = result.oalurSeasonality?.level || 'none';
  const asinLevel = asinSeasonality.productCount >= 3 ? asinSeasonality.level : 'none';
  const strongSignals = [googleLevel, oalurLevel, asinLevel].filter(level => level === 'strong').length;
  const weakOrStrongSignals = [googleLevel, oalurLevel, asinLevel].filter(level => level === 'strong' || level === 'weak').length;

  result.seasonalityEvidence = {
    google: googleLevel,
    oalur: oalurLevel,
    asin: asinLevel,
    strongCount: strongSignals,
    signalCount: weakOrStrongSignals,
    notes: {
      google: result.googleTrendsShape || 'no Google Trends evidence',
      oalur: result.oalurSeasonality?.reason || 'no Oalur evidence',
      asin: asinSeasonality.productCount >= 3 ? asinSeasonality.reason : 'old ASIN sample is insufficient'
    }
  };

  if (strongSignals >= 2) {
    result.seasonalityType = '确认强季节性';
    result.seasonalityScore = 60;
  } else if (strongSignals === 1) {
    result.seasonalityType = '疑似强季节性';
    result.seasonalityScore = Math.max(45, Math.min(result.seasonalityScore, 45));
  } else if (weakOrStrongSignals >= 2) {
    result.seasonalityType = '弱季节性';
    result.seasonalityScore = 35;
  } else if (weakOrStrongSignals === 1) {
    result.seasonalityType = '疑似弱季节性';
    result.seasonalityScore = 25;
  } else {
    result.seasonalityType = '非季节性';
    result.seasonalityScore = 0;
  }

  // ─── Google vs Oalur 偏差 ───
  if (gtData && result.googlePeakMonths.length > 0 && result.oalurPeakMonths.length > 0) {
    const gtSet = new Set(result.googlePeakMonths.map(m => parseInt(m)));
    const oaSet = new Set(result.oalurPeakMonths.map(m => parseInt(m)));
    const overlap = [...gtSet].filter(m => oaSet.has(m));
    if (overlap.length === 0) {
      result.googleVsOalurDeviation = '⚠️ 峰值月份不一致，请以 Oalur 站内为准';
    } else if (overlap.length < Math.min(gtSet.size, oaSet.size)) {
      result.googleVsOalurDeviation = '部分一致，Oalur 站内峰值可能滞后 1-2 个月';
    } else {
      result.googleVsOalurDeviation = '✅ 峰值月份一致';
    }
  }

  return result;
}

// ============================================
// 主流程
// ============================================
(async () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🌀 季节性与生命周期分析`);
  console.log(`  关键词: ${keyword}`);
  console.log('='.repeat(50));

  const keywordAgent = runLocalKeywordAgent(keyword);
  console.log(`Local keyword agent: core="${keywordAgent.coreKeyword}", Google Trends candidates=${(keywordAgent.googleTrendsKeywords || []).join(', ') || '--'}`);
  logger.info('google_trends.local_keyword_agent', {
    keyword,
    coreKeyword: keywordAgent.coreKeyword,
    googleTrendsKeywords: keywordAgent.googleTrendsKeywords || [],
    keywordIntentFile: path.relative(process.cwd(), keywordIntentFile)
  });

  // ─── Step 1: Google Trends ───
  let gtData = null;
  if (fs.existsSync(gtrendsFile)) {
    console.log(`\n📁 Step 1/3: 读取已有 Google Trends 缓存`);
    gtData = JSON.parse(fs.readFileSync(gtrendsFile, 'utf-8'));
  } else {
    console.log(`\n🌐 Step 1/3: 提取 Google Trends 数据...`);
    try {
      gtData = runGoogleTrendsExtraction(keyword, gtrendsFile);
    } catch (e) {
      console.log(`⚠️ Google Trends 提取失败: ${e.message}`);
    }
  }

  // ─── Step 2: Oalur 搜索量 ───
  if (!gtData && fs.existsSync(gtrendsFile)) {
    try {
      gtData = JSON.parse(fs.readFileSync(gtrendsFile, 'utf-8'));
    } catch {}
  }

  // Retry invalid Google Trends cache instead of reusing a previous failed result.
  if (gtData && (gtData.error || !Array.isArray(gtData.data5Years) || gtData.data5Years.length === 0)) {
    const previousError = gtData.error || 'missing data5Years';
    console.log(`Google Trends cache invalid, retrying: ${previousError}`);
    try {
      gtData = runGoogleTrendsExtraction(keyword, gtrendsFile);
    } catch (e) {
      console.log(`Google Trends retry failed: ${e.message}`);
      gtData = { keyword, error: e.message, previousError, extractedAt: new Date().toISOString() };
      fs.writeFileSync(gtrendsFile, JSON.stringify(gtData, null, 2), 'utf-8');
    }
  }

  if (gtData && !gtData.error) {
    let quality = googleTrendsQuality(gtData);
    const fallbackKeywords = googleTrendsFallbackKeywords(keyword, keywordAgent);
    if (!quality.ok && fallbackKeywords.length) {
      const fallbackReason = quality.reason;
      console.log(`Google Trends data sparse for "${keyword}", retrying with local core-term candidates: ${fallbackKeywords.join(', ')}`);
      let bestFallback = null;
      for (const fallbackKeyword of fallbackKeywords) {
        try {
          const fallbackData = runGoogleTrendsExtraction(fallbackKeyword, gtrendsFile);
          const fallbackQuality = googleTrendsQuality(fallbackData);
          const annotated = annotateGoogleTrendsData(fallbackData, keyword, fallbackKeyword, fallbackQuality, fallbackReason);
          console.log(`Google Trends core candidate "${fallbackKeyword}": ${fallbackQuality.ok ? 'ok' : fallbackQuality.reason}`);
          if (!bestFallback || (fallbackQuality.nonzeroRate || 0) > (bestFallback.quality.nonzeroRate || 0)) {
            bestFallback = { data: annotated, quality: fallbackQuality };
          }
          if (fallbackQuality.ok) {
            gtData = annotated;
            quality = fallbackQuality;
            break;
          }
        } catch (e) {
          console.log(`Google Trends fallback "${fallbackKeyword}" failed: ${e.message}`);
        }
      }
      if (!quality.ok && bestFallback) {
        gtData = bestFallback.data;
        quality = bestFallback.quality;
      }
      if (!gtData || !Array.isArray(gtData.data5Years)) {
        gtData = {
          keyword,
          requestedKeyword: keyword,
          queryKeyword: fallbackKeywords[0],
          error: `Google Trends fallback failed for all candidates: ${fallbackReason}`,
          previousError: fallbackReason,
          extractedAt: new Date().toISOString()
        };
      }
      fs.writeFileSync(gtrendsFile, JSON.stringify(gtData, null, 2), 'utf-8');
    } else {
      gtData = annotateGoogleTrendsData(gtData, keyword, gtData.queryKeyword || gtData.keyword || keyword, quality);
      fs.writeFileSync(gtrendsFile, JSON.stringify(gtData, null, 2), 'utf-8');
    }
    if (gtData?.quality && !gtData.quality.ok) {
      gtData.error = gtData.quality.reason;
      fs.writeFileSync(gtrendsFile, JSON.stringify(gtData, null, 2), 'utf-8');
    }
  }

  let oalurVolData = null;
  if (fs.existsSync(oalurVolFile)) {
    console.log(`\n📁 Step 2/3: 读取已有 Oalur 搜索量缓存`);
    oalurVolData = JSON.parse(fs.readFileSync(oalurVolFile, 'utf-8'));
  } else {
    console.log(`\n📊 Step 2/3: 提取 Oalur 搜索量数据...`);
    try {
      execFileSync(
        nodeBin,
        [path.join(SKILL_DIR, 'extract-oalur-search-volume.js'), keyword, oalurVolFile],
        { stdio: 'inherit', timeout: 120000 }
      );
      if (fs.existsSync(oalurVolFile)) {
        oalurVolData = JSON.parse(fs.readFileSync(oalurVolFile, 'utf-8'));
      }
    } catch (e) {
      console.log(`⚠️ Oalur 搜索量提取失败: ${e.message}`);
    }
  }

  // ─── Step 3: ASIN 趋势 ───
  let asinTrends = null;
  const pickedAsins = []; // 记录选中的 ASIN

  if (bsrDataFile && fs.existsSync(bsrDataFile)) {
    const bsrData = JSON.parse(fs.readFileSync(bsrDataFile, 'utf-8'));
    const oldAsins = pickOldAsins(bsrData);

    if (oldAsins.length > 0) {
      oldAsins.forEach(a => pickedAsins.push({ asin: a.asin, bsr: a.bsr, brand: a.brand, title: a.title?.substring(0, 60), listingAge: a.listingAge }));
      const expectedAsins = oldAsins.map(a => a.asin);
      const expectedSet = new Set(expectedAsins);
      let cacheUsable = false;

      if (fs.existsSync(asinTrendsFile)) {
        console.log('\nStep 3/3: reading existing ASIN trend cache');
        asinTrends = JSON.parse(fs.readFileSync(asinTrendsFile, 'utf-8'));
        const cachedAsins = (asinTrends.products || []).map(product => product.asin).filter(Boolean);
        cacheUsable = cachedAsins.length === expectedAsins.length && cachedAsins.every(asin => expectedSet.has(asin));
        if (!cacheUsable) {
          console.log('ASIN trend cache does not match current selected ASINs; re-extracting.');
          asinTrends = null;
        }
      }

      if (!cacheUsable) {
        const asinList = expectedAsins.join(',');
        console.log(`\nStep 3/3: extracting ASIN trends (${oldAsins.length} ASIN, listed >3 years)`);
        console.log(`  ASINs: ${oldAsins.map(a => `${a.asin}(BSR#${a.bsr})`).join(', ')}`);

        try {
          execFileSync(
            nodeBin,
            [path.join(SKILL_DIR, 'extract-asin-trends.js'), asinList, asinTrendsFile],
            { stdio: 'inherit', timeout: 240000 }
          );
          if (fs.existsSync(asinTrendsFile)) {
            asinTrends = JSON.parse(fs.readFileSync(asinTrendsFile, 'utf-8'));
          }
        } catch (e) {
          console.log(`ASIN trend extraction failed: ${e.message}`);
        }
      }
    } else {
      console.log('\nStep 3/3: no ASIN listed >3 years found in BSR data; skipped');
    }
  } else {
    console.log('\nStep 3/3: BSR data file does not exist; skipped ASIN trend extraction');
  }

  // ─── Step 4: 分析 ───
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🔬 季节性分析...`);
  console.log('='.repeat(50));

  const seasonality = analyzeSeasonality(gtData, oalurVolData, asinTrends);

  // ─── Step 5: 输出 ───
  const finalGooglePoints = gtData?.data5Years || gtData?.data || [];
  const googleTrendsRouting = {
    requestedKeyword: keyword,
    finalQueryKeyword: gtData?.queryKeyword || gtData?.keyword || keyword,
    fallbackUsed: Boolean(gtData?.queryKeyword && gtData.queryKeyword !== keyword),
    fallbackReason: gtData?.keywordFallbackReason || gtData?.previousError || '',
    localAgent: {
      coreKeyword: keywordAgent.coreKeyword,
      googleTrendsKeywords: keywordAgent.googleTrendsKeywords || []
    },
    attempts: googleTrendsAttempts,
    finalStatus: gtData?.error && !(Array.isArray(finalGooglePoints) && finalGooglePoints.length)
      ? 'failed'
      : Array.isArray(finalGooglePoints) && finalGooglePoints.length
        ? 'completed'
        : 'missing',
    finalPoints: Array.isArray(finalGooglePoints) ? finalGooglePoints.length : 0,
    finalQuality: gtData?.quality || googleTrendsQuality(gtData)
  };
  logger.info('google_trends.final', googleTrendsRouting);

  const output = {
    rawKeyword,
    keyword,
    seasonalityKeyword: keyword,
    analyzedAt: new Date().toISOString(),
    seasonality,
    pickedAsins,
    dataSources: {
      googleTrends: !!gtData,
      oalurVolume: !!oalurVolData,
      asinTrends: !!asinTrends
    },
    googleTrendsRouting,
    googleTrendsData: gtData,
    oalurVolumeData: oalurVolData,
    asinTrendsData: asinTrends
  };

  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  logger.end({
    status: 'completed',
    outFile: path.relative(process.cwd(), outFile),
    seasonalityType: seasonality.seasonalityType,
    seasonalityScore: seasonality.seasonalityScore,
    googleTrendsStatus: googleTrendsRouting.finalStatus,
    googleTrendsFinalQuery: googleTrendsRouting.finalQueryKeyword,
    googleTrendsFinalPoints: googleTrendsRouting.finalPoints
  });

  // ─── 摘要 ───
  console.log(`\n${'='.repeat(50)}`);
  console.log('📋 季节性分析摘要');
  console.log('='.repeat(50));
  console.log(`🌀 季节性: ${seasonality.seasonalityType} (得分: ${seasonality.seasonalityScore})`);
  console.log(`📈 Google Trends: ${seasonality.googleTrendsShape}`);
  console.log(`   峰值月份: ${seasonality.googlePeakMonths.map(m => m + '月').join('、') || '无'}`);
  console.log(`📊 Oalur 峰值: ${seasonality.oalurPeakMonths.join('、') || '无'}`);
  if (seasonality.googleVsOalurDeviation) console.log(`🔗 偏差: ${seasonality.googleVsOalurDeviation}`);
  if (asinTrends) console.log(`📈 ASIN 趋势: ${asinTrends.products?.filter(p => p.trendData).length || 0} 个有数据`);
  console.log(`\n✅ 数据已保存: ${outFile}`);

})().catch(error => {
  logger.error('run.failed', { error: error.message, stack: error.stack });
  throw error;
});
