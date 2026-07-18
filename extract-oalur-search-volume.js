/**
 * Oalur（鸥鹭）关键词月度搜索量提取脚本
 * 
 * 流程：
 * 1. 导航到 Oalur 关键词研究页面
 * 2. 输入关键词 → 立即查询
 * 3. 在搜索结果中找到精确匹配的关键词行
 * 4. 点击"搜索排名趋势"列 → 打开趋势图弹窗
 * 5. 将数据周期切换为"按月"
 * 6. 从 Pinia store 直接读取月度搜索量趋势数据
 * 
 * 用法: node extract-oalur-search-volume.js "关键词" [输出文件.json]
 * 示例: node extract-oalur-search-volume.js "Biscuit Cutter" output/日期-Biscuit-Cutter/data/vol-data.json
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { activatePage } = require('./browser-page-utils');

function safeSegment(value) {
  return String(value || 'output').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function outputDirs(taskName) {
  const date = new Date().toISOString().split('T')[0];
  const root = path.join(process.cwd(), 'output', `${date}-${safeSegment(taskName)}`);
  return {
    data: path.join(root, 'data')
  };
}

function parseNumber(value) {
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function stemToken(token) {
  const t = String(token || '').toLowerCase();
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 3 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function normalizeKeyword(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map(stemToken)
    .join(' ') || '';
}

function buildKeywordRecommendation(queryKeyword, rows) {
  const normalizedQuery = normalizeKeyword(queryKeyword);
  const similarRows = rows
    .filter(row => normalizeKeyword(row.keyword) === normalizedQuery)
    .map(row => ({ ...row, weeklySearchVolume: parseNumber(row.searchVolume) }))
    .sort((a, b) => b.weeklySearchVolume - a.weeklySearchVolume);
  const recommendationCandidates = similarRows.length ? similarRows : rows
    .map(row => ({ ...row, weeklySearchVolume: parseNumber(row.searchVolume) }))
    .sort((a, b) => b.weeklySearchVolume - a.weeklySearchVolume)
    .slice(0, 1);
  const queriedRow = rows.find(row => row.keyword.toLowerCase() === String(queryKeyword).toLowerCase());
  const queriedVolume = queriedRow ? parseNumber(queriedRow.searchVolume) : null;
  const best = recommendationCandidates[0] || null;
  const scoringRow = similarRows[0] || null;
  const recommendedKeyword = best?.keyword || queryKeyword;
  const isQueryBest = normalizeKeyword(recommendedKeyword) === normalizedQuery &&
    String(recommendedKeyword).toLowerCase() === String(queryKeyword).toLowerCase();
  return {
    queriedKeyword: queryKeyword,
    recommendedKeyword,
    scoringKeyword: scoringRow?.keyword || '',
    scoringMatchType: scoringRow
      ? (String(scoringRow.keyword).toLowerCase() === String(queryKeyword).toLowerCase() ? 'exact' : 'normalized-equivalent')
      : 'missing',
    matchedKeyword: queriedRow?.keyword || '',
    isQueryBest,
    queriedWeeklySearchVolume: queriedVolume,
    recommendedWeeklySearchVolume: best ? best.weeklySearchVolume : null,
    candidateCount: recommendationCandidates.length,
    candidates: recommendationCandidates.slice(0, 5).map(row => ({
      keyword: row.keyword,
      searchVolume: row.searchVolume,
      weeklySearchVolume: row.weeklySearchVolume,
      searchRank: row.searchRank,
      productCount: row.productCount
    })),
    message: isQueryBest
      ? `当前搜索词 "${queryKeyword}" 已是相似关键词中周搜索量最高的词，搜索词没有问题。`
      : `建议优先搜索 "${recommendedKeyword}"，它在相似关键词中的周搜索量最高，高于当前输入词 "${queryKeyword}"。`
  };
}

const keyword = process.argv[2];
const defaultOut = keyword ? safeSegment(keyword) + '-oalur-volume.json' : '';
const outFile = process.argv[3] || path.join(outputDirs(keyword || 'output').data, defaultOut);
fs.mkdirSync(path.dirname(outFile), { recursive: true });

if (!keyword) {
  console.error('用法: node extract-oalur-search-volume.js "关键词" [输出文件.json]');
  process.exit(1);
}

async function extractVolume(page, kw) {
  const url = 'https://vip.oalur.com/keyword/selection?site=US';
  const maxSearchAttempts = 3;
  const tableLoadTimeoutMs = 45000;

  const readKeywordTable = async () => page.evaluate(() => {
    const rows = document.querySelectorAll('tr.el-table__row, .el-table__body-wrapper tbody tr');
    return Array.from(rows).map(row => {
      const tds = row.querySelectorAll('td');
      if (tds.length < 8) return null;
      return {
        keyword: tds[1]?.innerText?.trim() || '',
        category: (tds[2]?.innerText || '').replace(/\n/g, ' | ').trim(),
        searchRank: (tds[5]?.innerText || '').trim(),
        productCount: (tds[6]?.innerText || '').trim(),
        searchVolume: (tds[7]?.innerText || '').trim(),
        historyRank: (tds[8]?.innerText || '').replace(/\n/g, ' | ').trim(),
        rankChange: (tds[9]?.innerText || '').replace(/\n/g, ' | ').trim(),
        changeRate: (tds[10]?.innerText || '').replace(/\n/g, ' | ').trim(),
        suggestedCPC: (tds[11]?.innerText || '').replace(/\n/g, ' | ').trim(),
        top3Brands: (tds[12]?.innerText || '').replace(/\n/g, ' | ').trim()
      };
    }).filter(row => row && row.keyword);
  });

  const submitSearch = async () => {
    const inputFound = await page.evaluate((query) => {
      const input = document.querySelector('input[placeholder*="请输入关键词"]') ||
        document.querySelector('input[placeholder*="关键字"]') ||
        document.querySelector('input[type="text"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, kw);
    if (!inputFound) throw new Error('Oalur keyword input was not found');
    await new Promise(resolve => setTimeout(resolve, 800));
    const submitted = await page.evaluate(() => {
      for (const button of document.querySelectorAll('button')) {
        if (button.innerText.trim() === '立即查询') {
          button.click();
          return true;
        }
      }
      return false;
    });
    if (!submitted) throw new Error('Oalur search button was not found');
  };

  // ===== Step 1: 导航 =====
  console.log('🌐 导航至 Oalur 关键词研究页面...');
  await activatePage(page);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  let tableData = [];
  for (let attempt = 1; attempt <= maxSearchAttempts; attempt++) {
    if (attempt > 1) {
      console.log(`Keyword table did not load; refreshing before retry ${attempt}/${maxSearchAttempts}...`);
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    }
    console.log(`Searching Oalur keyword "${kw}" (attempt ${attempt}/${maxSearchAttempts})...`);
    await submitSearch();
    const tableLoaded = await page.waitForFunction(
      () => Array.from(document.querySelectorAll('tr.el-table__row, .el-table__body-wrapper tbody tr'))
        .some(row => row.querySelectorAll('td').length >= 8),
      { timeout: tableLoadTimeoutMs }
    ).then(() => true).catch(() => false);
    tableData = await readKeywordTable();
    if (tableLoaded && tableData.length > 0) break;
  }

  if (tableData.length === 0) {
    throw new Error(`Oalur keyword table did not load after ${maxSearchAttempts} attempts; no empty cache was written`);
  }

  console.log(`Keyword table loaded: ${tableData.length} row(s)`);

  const keywordRecommendation = buildKeywordRecommendation(kw, tableData);
  // Scoring may only use an exact or normalized-equivalent query. A broader or branded recommendation remains display-only.
  const trendKeyword = keywordRecommendation.scoringKeyword || '';
  const exactMatch = trendKeyword ? tableData.find(r => r.keyword.toLowerCase() === trendKeyword.toLowerCase()) : null;
  const basicData = exactMatch || null;

  if (!basicData) {
    console.log(`⚠️ 未找到关键词 "${kw}" 的精确或规范化等价结果，趋势评分留空；品牌词或宽泛词仅保留为展示建议。`);
    const emptyResult = {
      keyword: kw,
      trendKeyword: '',
      trendKeywordStatus: 'missing-exact-match',
      scoringEligible: false,
      extractedAt: new Date().toISOString(),
      basicData: null,
      allKeywords: tableData,
      keywordRecommendation,
      searchesTrend: {},
      searchesRankTrend: {},
      oppIndexTrend: {},
      productTotalNumTrend: {},
      topClickRatioTrend: {},
      topConvertRatioTrend: {},
      dataCycle: '按月',
      monthlyCount: 0,
      dateRange: null
    };
    fs.writeFileSync(outFile, JSON.stringify(emptyResult, null, 2));
    console.log(`✅ 空趋势结果已保存: ${outFile}`);
    return emptyResult;
  }

  console.log(`✅ 匹配行: "${basicData.keyword}"`);
  console.log(`💡 ABA 搜索词建议: ${keywordRecommendation.message}`);

  // ===== Step 4: 点击趋势列打开弹窗 =====
  console.log('📈 打开趋势图弹窗...');
  const clickResult = await page.evaluate((kw) => {
    const rows = document.querySelectorAll('tr.el-table__row');
    for (const row of rows) {
      const kwCell = row.querySelectorAll('td')[1];
      if (kwCell && kwCell.innerText.trim().toLowerCase() === kw.toLowerCase()) {
        const tds = row.querySelectorAll('td');
        const canvas = tds[4]?.querySelector('canvas');
        if (canvas) canvas.click();
        else if (tds.length >= 5) tds[4].click();
        return 'clicked';
      }
    }
    return 'row not found';
  }, trendKeyword);
  console.log(`   点击: ${clickResult}`);
  await new Promise(r => setTimeout(r, 6000));

  // ===== Step 5: 切换数据周期为"按月" =====
  console.log('🔄 切换数据周期: 按周 → 按月...');
  await page.evaluate(() => {
    const dialog = document.querySelector('.el-dialog.trends-list');
    const trigger = dialog?.querySelector('.trends-filter [class*="trigger"]');
    if (trigger) trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 2000));

  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.innerText?.trim() === '按月') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          el.dispatchEvent(new Event('mousedown', { bubbles: true }));
          el.dispatchEvent(new Event('mouseup', { bubbles: true }));
          el.dispatchEvent(new Event('click', { bubbles: true }));
          return;
        }
      }
    }
  });
  // 等图表数据加载
  console.log('⏳ 等待图表数据加载...');
  await new Promise(r => setTimeout(r, 8000));

  // ===== Step 6: 从 Pinia store 读取月度趋势数据 =====
  console.log('📥 从 Pinia store 读取月度趋势数据...');
  let trendData = null;
  for (let retry = 0; retry < 5; retry++) {
    trendData = await page.evaluate(() => {
      const app = document.querySelector('#__nuxt, #app');
      if (!app || !app.__vue_app__) return { error: 'no vue app' };
      const pinia = app.__vue_app__.config.globalProperties.$pinia;
      if (!pinia) return { error: 'no pinia' };
      const store = pinia.state.value.keywordDataTrendsStore;
      if (!store) return { error: 'no keywordDataTrendsStore' };
      const dt = store.dataTrends;
      if (!dt) return { error: 'no dataTrends' };
      // 提取全部 6 个数据集
      const extract = (obj) => obj ? JSON.parse(JSON.stringify(obj)) : null;
      return {
        keyword: store.keyword,
        period: store.period,
        searchesTrend: extract(dt.searchesTrend),
        searchesRankTrend: extract(dt.searchesRankTrend),
        oppIndexTrend: extract(dt.oppIndexTrend),
        productTotalNumTrend: extract(dt.productTotalNumTrend),
        topClickRatioTrend: extract(dt.topClickRatioTrend),
        topConvertRatioTrend: extract(dt.topConvertRatioTrend)
      };
    });

    if (trendData && trendData.searchesTrend && Object.keys(trendData.searchesTrend).length > 0) {
      console.log(`✅ 成功获取趋势数据: ${Object.keys(trendData.searchesTrend).length} 个数据点`);
      break;
    }
    console.log(`   等待中... (${retry + 1}/5)`);
    await new Promise(r => setTimeout(r, 3000));
  }

  // ===== Step 7: 只保留最近36个月的数据 =====
  const MAX_MONTHS = 36;
  
  function sliceRecent(obj) {
    if (!obj) return {};
    const result = {};
    const sortedMonths = Object.keys(obj).sort();
    const recentMonths = sortedMonths.slice(-MAX_MONTHS);
    recentMonths.forEach(m => { result[m] = obj[m]; });
    return result;
  }

  const searchesTrend = sliceRecent(trendData?.searchesTrend);
  const searchesRankTrend = sliceRecent(trendData?.searchesRankTrend);
  const oppIndexTrend = sliceRecent(trendData?.oppIndexTrend);
  const productTotalNumTrend = sliceRecent(trendData?.productTotalNumTrend);
  const topClickRatioTrend = sliceRecent(trendData?.topClickRatioTrend);
  const topConvertRatioTrend = sliceRecent(trendData?.topConvertRatioTrend);

  if (Object.keys(searchesTrend).length === 0) {
    throw new Error('Oalur trend dialog did not load monthly search data; no incomplete cache was written');
  }

  // ===== Step 8: 保存结果 =====
  const sortedMonths = Object.keys(searchesTrend).sort();
  const result = {
    keyword: kw,
    trendKeyword,
    trendKeywordStatus: keywordRecommendation.scoringMatchType,
    scoringEligible: true,
    extractedAt: new Date().toISOString(),
    basicData,
    allKeywords: tableData,
    keywordRecommendation,
    // 搜索趋势区
    searchesTrend,
    searchesRankTrend,
    oppIndexTrend,
    productTotalNumTrend,
    // TOP3 点击&转化区
    topClickRatioTrend,
    topConvertRatioTrend,
    dataCycle: '按月',
    monthlyCount: sortedMonths.length,
    dateRange: sortedMonths.length > 0 ? {
      start: sortedMonths[0],
      end: sortedMonths[sortedMonths.length - 1]
    } : null
  };

  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`✅ 数据已保存: ${outFile}`);
  console.log(`   📊 月度数据: ${result.monthlyCount} 个数据点`);
  if (result.dateRange) console.log(`   📅 范围: ${result.dateRange.start} ~ ${result.dateRange.end}`);
  // 输出各数据集信息
  const dsInfo = [
    ['搜索量', searchesTrend],
    ['搜索排名', searchesRankTrend],
    ['机会指数', oppIndexTrend],
    ['在售商品数', productTotalNumTrend],
    ['TOP3点击份额', topClickRatioTrend],
    ['TOP3转化份额', topConvertRatioTrend]
  ];
  for (const [label, data] of dsInfo) {
    const keys = Object.keys(data);
    if (keys.length > 0) {
      const vals = keys.map(k => data[k]).filter(v => v !== null && v !== undefined);
      console.log(`   📈 ${label}: ${keys.length} 个数据点, 范围 ${vals.length > 0 ? Math.min(...vals) : 'N/A'} ~ ${vals.length > 0 ? Math.max(...vals) : 'N/A'}`);
    } else {
      console.log(`   ⚠️ ${label}: 无数据`);
    }
  }

  return result;
}

(async () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🔍 Oalur 关键词月度搜索量提取`);
  console.log(`   关键词: "${keyword}"`);
  console.log('='.repeat(50));

  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null, protocolTimeout: 600000 });
  console.log('✅ 已连接 Edge 浏览器');

  try {
    // 新建标签页，不干扰用户当前页面
    const page = await browser.newPage();
    await extractVolume(page, keyword);
    // 提取完后关闭新标签页
    await page.close();
  } finally {
    await browser.disconnect();
  }
})().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
