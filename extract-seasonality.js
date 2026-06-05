/**
 * 季节性与生命周期分析脚本
 * 整合 Google Trends + Oalur 搜索量 + ASIN 销量趋势，生成分析报告
 *
 * 用法: node extract-seasonality.js "关键词" <BSR数据文件.json> [输出文件.json]
 * 示例: node extract-seasonality.js "Biscuit Cutter" output/日期-Biscuit-Cutter/data/biscuit-data.json output/日期-Biscuit-Cutter/data/biscuit-seasonality.json
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

const keyword = process.argv[2];
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

if (!keyword) {
  console.error('用法: node extract-seasonality.js "关键词" <BSR数据文件.json> [输出文件.json]');
  process.exit(1);
}

const gtrendsFile = path.join(dirs.data, safeName + '-google-trends.json');
const oalurVolFile = path.join(dirs.data, safeName + '-oalur-volume.json');
const asinTrendsFile = path.join(dirs.data, safeName + '-asin-trends.json');

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
    const values = points.map(p => p.value);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const peakValleyRatio = min > 0 ? max / min : max;

    // 按月分组求多年均值
    const monthByYear = {};
    points.forEach(p => {
      if (p.date && p.date.length >= 7) {
        const year = p.date.substring(0, 4);
        const month = p.date.substring(5, 7);
        if (!monthByYear[year]) monthByYear[year] = {};
        monthByYear[year][month] = p.value;
      }
    });

    const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    const monthAvgs = {};
    months.forEach(m => {
      let sum = 0, count = 0;
      Object.values(monthByYear).forEach(yd => {
        if (yd[m] !== undefined) { sum += yd[m]; count++; }
      });
      monthAvgs[m] = count > 0 ? sum / count : 0;
    });

    const avgValues = months.map(m => monthAvgs[m] || 0);
    const maxMonthVal = Math.max(...avgValues);
    result.googlePeakMonths = months.filter((m, i) => avgValues[i] >= maxMonthVal * 0.85);
    result.googleMonthAvgs = months.map(m => Math.round(monthAvgs[m] || 0));

    if (peakValleyRatio >= 2.0) {
      result.googleTrendsShape = '明显的季节性峰谷 (峰谷比≥2)';
      result.seasonalityScore += 50;
    } else if (peakValleyRatio >= 1.5) {
      result.googleTrendsShape = '温和的季节性波动 (峰谷比1.5-2)';
      result.seasonalityScore += 30;
    } else {
      result.googleTrendsShape = `无明显季节性 (峰谷比=${peakValleyRatio.toFixed(1)})`;
    }

    console.log(`\n📈 Google Trends 分析:`);
    console.log(`  数据点: ${points.length} 个, 峰谷比: ${peakValleyRatio.toFixed(1)}`);
    console.log(`  趋势形态: ${result.googleTrendsShape}`);
    console.log(`  峰值月份: ${result.googlePeakMonths.map(m => m + '月').join('、')}`);
    console.log(`  各月均值: ${months.map((m, i) => m + '月=' + Math.round(avgValues[i])).join(' ')}`);
  }

  // ─── Oalur 搜索量分析 ───
  if (oalurVolData && oalurVolData.searchesTrend) {
    const allMonths = Object.keys(oalurVolData.searchesTrend).sort();
    const recentMonths = allMonths.slice(-36);
    const searchesTrend = {};
    recentMonths.forEach(m => { searchesTrend[m] = oalurVolData.searchesTrend[m]; });

    const months = Object.keys(searchesTrend).sort();
    const volumes = months.map(m => searchesTrend[m]);

    if (volumes.length > 0) {
      const monthAvg = {};
      months.forEach(m => {
        const mn = m.substring(5, 7);
        if (!monthAvg[mn]) monthAvg[mn] = [];
        monthAvg[mn].push(searchesTrend[m]);
      });

      const monthAvgsObj = {};
      Object.keys(monthAvg).forEach(m => {
        monthAvgsObj[m] = monthAvg[m].reduce((a, b) => a + b, 0) / monthAvg[m].length;
      });

      const avgValues = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']
        .map(m => monthAvgsObj[m] || 0);
      const maxAvg = Math.max(...avgValues);
      const minNonZero = Math.min(...avgValues.filter(v => v > 0));
      const peakAvgRatio = minNonZero > 0 ? maxAvg / minNonZero : maxAvg;

      result.oalurPeakMonths = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']
        .filter((m, i) => avgValues[i] >= maxAvg * 0.8)
        .map(m => parseInt(m) + '月');
      result.oalurMonthAvgs = avgValues.map(v => Math.round(v));

      if (peakAvgRatio >= 2.5) {
        result.seasonalityScore = Math.max(result.seasonalityScore, 60);
      } else if (peakAvgRatio >= 1.8) {
        result.seasonalityScore = Math.max(result.seasonalityScore, 40);
      }

      console.log(`\n📊 Oalur 搜索量分析 (${months.length} 个月):`);
      console.log(`  多年月均峰谷比: ${peakAvgRatio.toFixed(1)}`);
      console.log(`  旺季月份: ${result.oalurPeakMonths.join('、')}`);
    }
  }

  // ─── 最终判定 ───
  if (result.seasonalityScore >= 60) result.seasonalityType = '强季节性';
  else if (result.seasonalityScore >= 30) result.seasonalityType = '弱季节性';
  else result.seasonalityType = '非季节性';

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

  // ─── Step 1: Google Trends ───
  let gtData = null;
  if (fs.existsSync(gtrendsFile)) {
    console.log(`\n📁 Step 1/3: 读取已有 Google Trends 缓存`);
    gtData = JSON.parse(fs.readFileSync(gtrendsFile, 'utf-8'));
  } else {
    console.log(`\n🌐 Step 1/3: 提取 Google Trends 数据...`);
    try {
      execSync(
        `node "${path.join(SKILL_DIR, 'extract-google-trends.js')}" "${keyword}" "${gtrendsFile}"`,
        { stdio: 'inherit', timeout: 60000 }
      );
      if (fs.existsSync(gtrendsFile)) {
        gtData = JSON.parse(fs.readFileSync(gtrendsFile, 'utf-8'));
      }
    } catch (e) {
      console.log(`⚠️ Google Trends 提取失败: ${e.message}`);
    }
  }

  // ─── Step 2: Oalur 搜索量 ───
  let oalurVolData = null;
  if (fs.existsSync(oalurVolFile)) {
    console.log(`\n📁 Step 2/3: 读取已有 Oalur 搜索量缓存`);
    oalurVolData = JSON.parse(fs.readFileSync(oalurVolFile, 'utf-8'));
  } else {
    console.log(`\n📊 Step 2/3: 提取 Oalur 搜索量数据...`);
    try {
      execSync(
        `node "${path.join(SKILL_DIR, 'extract-oalur-search-volume.js')}" "${keyword}" "${oalurVolFile}"`,
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
    if (fs.existsSync(asinTrendsFile)) {
      console.log(`\n📁 Step 3/3: 读取已有 ASIN 趋势缓存`);
      asinTrends = JSON.parse(fs.readFileSync(asinTrendsFile, 'utf-8'));
    } else {
      const bsrData = JSON.parse(fs.readFileSync(bsrDataFile, 'utf-8'));
      const oldAsins = pickOldAsins(bsrData);

      if (oldAsins.length > 0) {
        oldAsins.forEach(a => pickedAsins.push({ asin: a.asin, bsr: a.bsr, brand: a.brand, title: a.title?.substring(0, 60), listingAge: a.listingAge }));
        const asinList = oldAsins.map(a => a.asin).join(',');

        console.log(`\n📈 Step 3/3: 提取 ASIN 趋势 (${oldAsins.length} 个, 上架>3年)`);
        console.log(`  ASINs: ${oldAsins.map(a => `${a.asin}(BSR#${a.bsr})`).join(', ')}`);

        try {
          execSync(
            `node "${path.join(SKILL_DIR, 'extract-asin-trends.js')}" "${asinList}" "${asinTrendsFile}"`,
            { stdio: 'inherit', timeout: 240000 }
          );
          if (fs.existsSync(asinTrendsFile)) {
            asinTrends = JSON.parse(fs.readFileSync(asinTrendsFile, 'utf-8'));
          }
        } catch (e) {
          console.log(`⚠️ ASIN 趋势提取失败: ${e.message}`);
        }
      } else {
        console.log(`\n⚠️ Step 3/3: BSR 数据中未找到上架>3年的 ASIN，跳过`);
      }
    }
  } else {
    console.log(`\n⚠️ Step 3/3: BSR 数据文件不存在，跳过 ASIN 趋势提取`);
  }

  // ─── Step 4: 分析 ───
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🔬 季节性分析...`);
  console.log('='.repeat(50));

  const seasonality = analyzeSeasonality(gtData, oalurVolData, asinTrends);

  // ─── Step 5: 输出 ───
  const output = {
    keyword,
    analyzedAt: new Date().toISOString(),
    seasonality,
    pickedAsins,
    dataSources: {
      googleTrends: !!gtData,
      oalurVolume: !!oalurVolData,
      asinTrends: !!asinTrends
    },
    googleTrendsData: gtData,
    oalurVolumeData: oalurVolData,
    asinTrendsData: asinTrends
  };

  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

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

})();
