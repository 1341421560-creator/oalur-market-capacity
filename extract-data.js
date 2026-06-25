const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { activatePage } = require('./browser-page-utils');
const { selectSurvivalBaselinePeriod } = require('./survival-baseline');
const { selectTargetCategories } = require('./category-selector');
const { writeKeywordIntentAnalysis } = require('./keyword-intent-ai');
const {
  appendReferenceCategoryArgs,
  buildReferenceCategorySelectionSummary,
  parseReferenceCategoryArgs
} = require('./reference-categories');
const {
  aggregateParentListings,
  applyTargetCategoryMatch,
  listingMatchesTargetCategories,
  parseNumber
} = require('./parent-listing-aggregate');
const { buildRescuePriceGuard } = require('./rescue-price-guard');
const {
  applyCodexSemanticReview,
  applyCodexSemanticReviewExclusion,
  buildCodexSemanticReviewCandidates,
  loadCodexSemanticReview,
  REVIEW_STANDARD
} = require('./codex-semantic-review');
const {
  TARGET_CATEGORY_REVIEW_STANDARD,
  applyTargetCategoryCodexReview,
  buildTargetCategoryCodexReviewRequest,
  loadTargetCategoryCodexReview,
  writeTargetCategoryCodexReviewRequest
} = require('./target-category-codex-review');
const { createRunLogger } = require('./run-log');

const OALUR_FILTER_URL = 'https://vip.oalur.com/insight/filter/index?site=US';
const OALUR_PRODUCT_INFO_URL = 'https://vip.oalur.com/products/information';
const OALUR_NAV_TIMEOUT_MS = 30000;

async function gotoOalurFilter(page, contextLabel = 'Oalur page') {
  try {
    await activatePage(page);
    await page.goto(OALUR_FILTER_URL, { waitUntil: 'domcontentloaded', timeout: OALUR_NAV_TIMEOUT_MS });
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('timeout')) {
      console.error(`ERROR: ${contextLabel} navigation timed out after 30s. Stop execution and report to user.`);
    }
    throw error;
  }
}

async function isVariantSkuChecked(page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector('.var-sku .el-checkbox');
    if (!wrapper) return null;
    const input = wrapper.querySelector('input[type="checkbox"]');
    return wrapper.classList.contains('is-checked') ||
      input?.checked === true ||
      input?.getAttribute('aria-checked') === 'true';
  });
}

async function ensureVariantSkuEnabled(page) {
  await page.waitForSelector('.var-sku .el-checkbox', { timeout: 10000 });
  let checked = await isVariantSkuChecked(page);
  if (checked === null) throw new Error('Variant checkbox not found; stop to avoid missing variant data');
  if (!checked) {
    const beforeFirstAsin = await page.evaluate(() => {
      const row = document.querySelector('.el-table__body-wrapper table tbody tr:first-child');
      return row?.innerText?.match(/ASIN:\s*([A-Z0-9]{10})/)?.[1] || '';
    });
    await page.evaluate(() => {
      const wrapper = document.querySelector('.var-sku .el-checkbox');
      const input = wrapper?.querySelector('input[type="checkbox"]');
      (input || wrapper)?.click();
    });
    await page.waitForFunction(() => {
      const wrapper = document.querySelector('.var-sku .el-checkbox');
      const input = wrapper?.querySelector('input[type="checkbox"]');
      return !!wrapper && (wrapper.classList.contains('is-checked') || input?.checked === true || input?.getAttribute('aria-checked') === 'true');
    }, { timeout: 10000 });
    await page.waitForFunction((before) => {
      const row = document.querySelector('.el-table__body-wrapper table tbody tr:first-child');
      const asin = row?.innerText?.match(/ASIN:\s*([A-Z0-9]{10})/)?.[1] || '';
      const loading = [...document.querySelectorAll('.el-loading-mask')].some(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      });
      return !loading && asin && (!before || asin !== before || document.querySelectorAll('.el-table__body-wrapper table tbody tr').length > 1);
    }, { timeout: 15000 }, beforeFirstAsin).catch(() => {});
  }
  checked = await isVariantSkuChecked(page);
  if (!checked) throw new Error('Variant checkbox is not checked; stop before first-page extraction');
  console.log('Variant checkbox checked before extraction');
}

function safeSegment(value) {
  return String(value || 'output').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function formatInteger(value) {
  return Math.round(value || 0).toLocaleString('en-US');
}

function parsePlainNumber(value) {
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
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

// Parse product age strings from the search table.
const MAX_PAGES = 20;
const HARD_SKIP_ROWS = 500;

// 閸濅胶琚惔鏇犲殠鐞涱煉绱欐禒?SKILL.md 閸氬本顒炵紒瀛樺Б閿?
const CATEGORY_BSR_TABLE = [
  { keywords: ['makeup', 'brush', 'eyelash', 'cosmetic', 'beauty'], bsr: 10000, name: 'beauty' },
  { keywords: ['cook', 'cookie', 'baking', 'kitchen', 'spatula', 'biscuit', 'cutter', 'gadget', 'utensil'], bsr: 10000, name: 'kitchen' },
  { keywords: ['pet', 'dog', 'cat', 'leash', 'toy', 'bed', 'scratch'], bsr: 25000, name: 'pet' },
  { keywords: ['shoe', 'shirt', 'pant', 'yoga', 'running', 'clothing', 'sweater'], bsr: 30000, name: 'apparel' },
  { keywords: ['screwdriver', 'drill', 'tape', 'tool', 'home', 'hardware'], bsr: 15000, name: 'tools' },
  { keywords: ['hair', 'clipper', 'toothbrush', 'shaver', 'trimmer'], bsr: 10000, name: 'personal-care' },
  { keywords: ['phone', 'case', 'earbud', 'charger', 'cable', 'electronic'], bsr: 0, name: 'electronics' }, // 0 = manual review
  { keywords: ['pen', 'desk', 'organizer', 'office', 'stationery'], bsr: 15000, name: 'office' },
  { keywords: ['resistance', 'yoga', 'mat', 'sport', 'exercise', 'gym'], bsr: 20000, name: 'sports' },
  { keywords: ['baby', 'bottle', 'pacifier', 'nursery', 'infant'], bsr: 15000, name: 'baby' },
  { keywords: ['block', 'puzzle', 'toy', 'game', 'LEGO'], bsr: 20000, name: 'toys' },
  { keywords: ['car', 'phone', 'mount', 'cover', 'automotive'], bsr: 15000, name: 'automotive' },
  { keywords: ['garden', 'plant', 'pot', 'outdoor', 'lawn'], bsr: 15000, name: 'garden' },
];

// 娴犲骸鍙ч柨顔跨槤閼奉亜濮╅崠褰掑帳閸濅胶琚惔鏇犲殠 BSR
function autoDetectBsr(keyword) {
  const kw = keyword.toLowerCase();
  for (const cat of CATEGORY_BSR_TABLE) {
    if (cat.keywords.some(k => kw.includes(k))) {
      if (cat.bsr === 0) return null; // 闂団偓閸忚渹缍嬮崚鍡樼€?
      return cat.bsr;
    }
  }
  return 10000; // 姒涙顓?
}

// 閸欏倹鏆熼敍姘彠闁款喛鐦?,閸忔娊鏁拠?,... [BSR娑撳﹪妾篯 [鏉堟挸鍤弬鍥︽閸氬硶 [--time-filter YYYY-MM]
// BSR娑撳﹪妾烘稉鍝勫讲闁寮弫甯礉娑撳秳绱堕弮鎯板殰閸斻劋绮犻崗鎶芥暛鐠囧秴灏柊宥呮惂缁绨崇痪?
// 缁€杞扮伐: node extract-data.js "Cookie Cutter" 10000 merged-data.json
// 缁€杞扮伐: node extract-data.js "Cookie Cutter"閿涘牐鍤滈崝銊ュ爱闁?BSR閿?
// Example: node extract-data.js "Cookie Cutter" 10000 data.json --survival-baseline auto
const keywordsRaw = process.argv[2];
const userBsr = process.argv[3];
const defaultOutFile = keywordsRaw ? keywordsRaw.split(',')[0].trim().replace(/\s+/g, '-') + '-data.json' : '';
const dirs = outputDirs(keywordsRaw ? keywordsRaw.split(',')[0].trim() : 'output');
const explicitOutFile = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : null;
let outFile = explicitOutFile || path.join(dirs.data, defaultOutFile);

// Extract rows from the product search result table.
const timeFilterIdx = process.argv.indexOf('--time-filter');
const survivalBaselineIdx = process.argv.indexOf('--survival-baseline');
const survivalBaselineMode = survivalBaselineIdx > -1 ? (process.argv[survivalBaselineIdx + 1] || 'auto') : null;
const survivalBaseline = survivalBaselineMode === 'auto' ? selectSurvivalBaselinePeriod(new Date()) : null;
const timeFilterRaw = timeFilterIdx > -1 ? process.argv[timeFilterIdx + 1] : (survivalBaseline ? survivalBaseline.selectedYm : null);
const historicalNewOnly = Boolean(survivalBaseline) || process.argv.includes('--historical-new-only');
const allowOverPageLimit = process.argv.includes('--allow-over-400') || process.env.OALUR_ALLOW_OVER_400 === '1';
const bsrMinIdx = process.argv.indexOf('--bsr-min');
const minBsr = bsrMinIdx > -1 ? String(process.argv[bsrMinIdx + 1] || '1') : String(process.env.OALUR_BSR_MIN || '1');
const salesFloorMin = Number(process.env.OALUR_SALES_FLOOR_MIN || 200);
const referenceCategories = parseReferenceCategoryArgs(process.argv.slice(2));
let timeFilterLabel = null; // Example: 2025年12月
if (timeFilterRaw) {
  const [y, m] = timeFilterRaw.split('-');
  if (y && m) {
    timeFilterLabel = `${y}年${parseInt(m, 10)}月`;
    console.log(`Time filter: ${timeFilterLabel}`);
  }
}
if (survivalBaseline) {
  console.log(`Survival baseline: raw=${survivalBaseline.rawTargetYm}, selected=${survivalBaseline.selectedYm}, window=${survivalBaseline.windowYm.join(',')}`);
  console.log(`Survival baseline reason: ${survivalBaseline.reason}`);
}

if (!keywordsRaw) {
  console.error('閻劍纭? node extract-data.js "閸忔娊鏁拠?,閸忔娊鏁拠?,..." [BSR娑撳﹪妾篯 [鏉堟挸鍤弬鍥︽.json]');
  console.error('缁€杞扮伐: node extract-data.js "Cookie Cutter" 10000');
  console.error('Example: node extract-data.js "Cookie Cutter"');
  process.exit(1);
}

const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);
if (keywords.length > 1 && !explicitOutFile) {
  outFile = path.join(outputDirs(keywords.join('-')).data, 'merged-data.json');
}

const logger = createRunLogger({
  outputFile: outFile,
  keyword: keywords.join(' + '),
  scriptName: 'extract-data.js'
});
logger.start({
  keywords,
  outFile: path.relative(process.cwd(), outFile),
  args: process.argv.slice(2),
  historicalNewOnly,
  allowOverPageLimit,
  logFile: path.relative(process.cwd(), logger.logFile)
});
console.log(`Run log: ${path.relative(process.cwd(), logger.logFile)}`);

const runStats = {
  pageLimit: {
    maxPages: MAX_PAGES,
    maxRows: MAX_PAGES * 20,
    hardSkipRows: HARD_SKIP_ROWS,
    allowOverPageLimit
  },
  keywords: {}
};

class SkipOver500Error extends Error {
  constructor(details) {
    super(`Oalur result estimated ${details.estimatedRows} rows for "${details.keyword}", exceeding hard skip limit ${HARD_SKIP_ROWS}.`);
    this.name = 'SkipOver500Error';
    this.code = 'SKIP_OVER_500';
    this.details = details;
  }
}

function estimateRowsFromFirstPage(result) {
  return Math.max(result.total || 0, result.lastPage * 20);
}

function writeSkippedOver500Output(details) {
  const output = {
    keywords,
    keyword: keywords.join(' + '),
    bsrRange: minBsr + '-' + maxBsr,
    timeFilter: timeFilterLabel || '近30天',
    historicalNewOnly,
    skipped: true,
    skippedOver500: true,
    skipReason: 'estimated product count exceeds hard limit',
    skipDetails: details,
    rawTotal: 0,
    total: 0,
    allCount: 0,
    filteredCount: 0,
    excludedCount: 0,
    targetMatchedCount: 0,
    salesFloorExcludedCount: 0,
    targetCategory: '',
    targetCategories: [],
    equivalentCandidateCategories: [],
    codexSemanticReviewStandard: REVIEW_STANDARD,
    targetCategoryCodexReviewStandard: TARGET_CATEGORY_REVIEW_STANDARD,
    referenceCategories,
    categorySelection: [],
    categoryDistribution: [],
    keywordStats: {},
    marketRunSummary: {
      logFile: path.relative(process.cwd(), logger.logFile),
      outputFile: path.relative(process.cwd(), outFile),
      keywords,
      bsrRange: `${minBsr}-${maxBsr}`,
      skipped: true,
      skippedOver500: true,
      skipDetails: details,
      codexSemanticReviewStandard: REVIEW_STANDARD,
      targetCategoryCodexReviewStandard: TARGET_CATEGORY_REVIEW_STANDARD,
      generatedAt: new Date().toISOString()
    },
    data: [],
    excluded: []
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');
  logger.warn('market.skip_over_500.output_written', {
    outputFile: path.relative(process.cwd(), outFile),
    ...details
  });
}

let keywordIntentAnalysisPromise = null;
if (!process.argv.includes('--skip-keyword-intent-analysis')) {
  keywordIntentAnalysisPromise = writeKeywordIntentAnalysis(keywords, outFile)
    .then(result => {
      const sources = result.analysis.keywords.map(item => `${item.keyword}:${item.source}`).join(', ');
      console.log(`Keyword intent analysis saved: ${result.file} (${sources})`);
      logger.info('keyword_intent.saved', {
        file: path.relative(process.cwd(), result.file),
        sources
      });
      return result;
    })
    .catch(error => {
      console.warn(`Keyword intent analysis failed and was skipped: ${error.message}`);
      logger.warn('keyword_intent.failed', { error: error.message });
      return null;
    });
}

// BSR 閸婂ジ鈧瀚ㄩ柅鏄忕帆閿涙氨鏁ら幋閿嬪瘹鐎?> 閼奉亜濮╅崠褰掑帳 > 姒涙顓?0000
let maxBsr;
const firstKw = keywords[0];
if (userBsr) {
  maxBsr = userBsr;
  console.log(`Keywords: ${keywords.join(' | ')}`);
    console.log(`BSR range: ${minBsr}-${maxBsr} (user specified)`);
} else {
  const detected = autoDetectBsr(firstKw);
  if (detected === null) {
    maxBsr = '10000';
    console.log('Category needs manual BSR review; using default 10000');
  } else {
    maxBsr = String(detected);
    console.log(`Keywords: ${keywords.join(' | ')}`);
    console.log(`BSR range: ${minBsr}-${maxBsr} (auto detected)`);
  }
}

logger.info('market.parameters', {
  keywords,
  bsrRange: `${minBsr}-${maxBsr}`,
  timeFilter: timeFilterLabel || '近30天',
  historicalNewOnly,
  survivalBaseline: survivalBaseline || null,
  referenceCategories
});

// 閹绘劕褰囬崙鑺ユ殶閿涘牆鎯堢猾鑽ゆ窗鐠侯垰绶為幓鎰絿閿?
// Oalur 鐞涖劌銇旈崚妤佹Ё鐏忓嫸绱?
// cells[0]=閸曢箖鈧? cells[1]=娴溠冩惂娣団剝浼? cells[2]=妫板嫪鍙婇柨鈧柌? cells[3]=妫板嫪鍙婇柨鈧崬顕€顤?
// cells[4]=鐎涙劒缍嬮柨鈧柌?鐎涙劒缍嬮柨鈧崬顕€顤? cells[5]=婢堆呰閹烘帒鎮? cells[6]=鐏忓繒琚幒鎺戞倳  cells[7]=Buybox娴犻攱鐗?
// cells[8]=listing age, cells[9]=rating count, cells[10]=rating score, cells[11]=BuyBox price.
// cells[12]=閸欐ü缍嬮弫? cells[13]=閸楁牕顔嶉弫? cells[14]=FBA&濮ｆ稑鍩勯悳? cells[15]=闁插秹鍣?娴ｆ挾袧
function runNodeScript(args, label) {
  console.log(`\n閳?${label}`);
  console.log(`node ${args.map(a => /\s/.test(String(a)) ? `"${a}"` : a).join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code: ${result.status}`);
    process.exit(result.status || 1);
  }
}

if (keywords.length > 1) {
  console.log(`\nMultiple keywords: independent extraction then offline merge: ${keywords.join(' | ')}`);
  logger.info('market.multi_keyword_start', {
    keywords,
    outputFile: path.relative(process.cwd(), outFile)
  });
  const mergedDirs = outputDirs(keywords.join('-'));
  const dataFiles = keywords.map(kw => {
    const file = path.join(mergedDirs.data, `${safeSegment(kw)}-data.json`);
    const childArgs = [path.join(__dirname, 'extract-data.js'), kw, String(maxBsr), file];
    if (timeFilterRaw) childArgs.push('--time-filter', timeFilterRaw);
    if (historicalNewOnly) childArgs.push('--historical-new-only');
    if (minBsr !== '1') childArgs.push('--bsr-min', minBsr);
    if (allowOverPageLimit) childArgs.push('--allow-over-400');
    appendReferenceCategoryArgs(childArgs, referenceCategories);
    childArgs.push('--skip-keyword-intent-analysis');
    runNodeScript(childArgs, `extract ${kw}`);
    return file;
  });
  runNodeScript([path.join(__dirname, 'merge-data.js'), ...dataFiles, '--output', outFile], 'merge keyword data');
  console.log(`\nMerged multi-keyword data saved: ${outFile}`);
  logger.end({
    status: 'completed',
    mode: 'multi-keyword',
    mergedFiles: dataFiles.map(file => path.relative(process.cwd(), file)),
    outFile: path.relative(process.cwd(), outFile)
  });
  process.exit(0);
}

const extractPageData = (page) => page.evaluate(() => {
  function cellLines(cell) {
    return (cell?.innerText || '').split('\n').map(line => line.trim()).filter(Boolean);
  }

  function primaryCellValue(cell) {
    return cellLines(cell)[0] || '';
  }

  function childSalesValue(cell) {
    const lines = cellLines(cell).slice(1);
    return lines.find(line => /\d/.test(line) && !/%/.test(line) && !/\$/.test(line)) || '';
  }

  function childRevenueValue(cell) {
    const lines = cellLines(cell).slice(1);
    return lines.find(line => /\$/.test(line) && /\d/.test(line) && !/%/.test(line))
      || lines.find(line => /\d/.test(line) && !/%/.test(line)) || '';
  }

  const rows = document.querySelectorAll('.el-table__body-wrapper table tbody tr');
  const data = [];
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 10) {
      const titleCell = cells[1]?.innerText || '';
      const lines = titleCell.split('\n').map(l => l.trim()).filter(l => l);
      const asinMatch = titleCell.match(/ASIN:\s*([A-Z0-9]{10})/);
      const pasinMatch = titleCell.match(/PASIN:\s*([A-Z0-9]{10})/);
      const category = lines.find(l => l.includes('>') && /^[A-Z]/.test(l) && !l.includes('PASIN')) || '';
      const dateMatch = (cells[8]?.innerText || '').match(/(\d{4}-\d{2}-\d{2})/);
      const ageMatch = (cells[8]?.innerText || '').match(/(\d+\s*(?:年|year|years)\s*\d*\s*(?:月|month|months)?\s*\d*\s*(?:天|day|days)?)/i);
      data.push({
        title: lines[0]?.substring(0, 100) || '',
        asin: asinMatch ? asinMatch[1] : '',
        pasin: pasinMatch ? pasinMatch[1] : '',
        category,
        sales: primaryCellValue(cells[2]),
        revenue: primaryCellValue(cells[3]),
        salesCellText: (cells[2]?.innerText || '').trim(),
        revenueCellText: (cells[3]?.innerText || '').trim(),
        childSales: childSalesValue(cells[2]),
        childRevenue: childRevenueValue(cells[3]),
        bsr: parseInt((cells[5]?.innerText || '').replace('#', '').trim()) || 0,
        subRank: (cells[6]?.innerText || '').replace('#', '').trim(),
        price: (cells[7]?.innerText || '').trim(),
        listingDate: dateMatch ? dateMatch[1] : '',
        listingAge: ageMatch ? ageMatch[1] : '',
        ratings: (cells[9]?.innerText || '').trim().split('\n')[0],
        brand: (cells[10]?.innerText || '').trim(),
        sellerType: (cells[11]?.innerText || '').split('\n').slice(1).join(' ').trim(),
        variants: (cells[12]?.innerText || '').trim(),
        sellerCount: (cells[13]?.innerText || '').trim(),
        margin: (cells[14]?.innerText || '').trim(),
        weight: (cells[15]?.innerText || '').trim()
      });
    }
  });
  const totalText = document.body.innerText.match(/(?:鍏眧total)\s*(\d+)\s*(?:鏉items|results)?/i);
  const total = totalText ? parseInt(totalText[1]) : 0;
  const pagerBtns = document.querySelectorAll('.el-pager .number');
  const lastPage = pagerBtns.length > 0 ? parseInt(pagerBtns[pagerBtns.length - 1].innerText) : 1;
  return { data, total, lastPage };
});

function historicalSnapshotDate() {
  if (!timeFilterRaw) return null;
  const [year, month] = timeFilterRaw.split('-').map(Number);
  if (!year || !month) return null;
  return new Date(year, month - 1, 15);
}

function isWithinSixMonthsAtHistoricalSnapshot(item) {
  const snapshot = historicalSnapshotDate();
  if (!snapshot || !item?.listingDate) return true;
  const listed = new Date(item.listingDate);
  if (Number.isNaN(listed.getTime())) return true;
  const sixMonthsBefore = new Date(snapshot);
  sixMonthsBefore.setMonth(sixMonthsBefore.getMonth() - 6);
  return listed >= sixMonthsBefore && listed <= snapshot;
}

function filterHistoricalNewCandidates(items) {
  if (!historicalNewOnly) return items;
  return items.filter(isWithinSixMonthsAtHistoricalSnapshot);
}

function summarizeDataQuality(items) {
  const rows = Array.isArray(items) ? items : [];
  const salesValues = rows.map(item => parseNumber(item.salesNumAggregated || item.sales)).filter(value => value > 0);
  return {
    productCount: rows.length,
    minMonthlySales: salesValues.length ? Math.min(...salesValues) : null,
    maxMonthlySales: salesValues.length ? Math.max(...salesValues) : null,
    missingSales: rows.filter(item => parseNumber(item.salesNumAggregated || item.sales) <= 0).length,
    missingRevenue: rows.filter(item => parseNumber(item.revenueNumAggregated || item.revenue) <= 0).length,
    missingPrice: rows.filter(item => parseNumber(item.price) <= 0).length,
    missingListingDate: rows.filter(item => !normalizeListingDate(item.listingDate)).length,
    missingCategory: rows.filter(item => isUnknownCategoryValue(item.category)).length,
    missingRatings: rows.filter(item => parseNumber(item.ratingsNumAggregated || item.ratings) <= 0).length
  };
}

function isUnknownCategoryValue(category) {
  const value = String(category || '').trim();
  if (!value) return true;
  if (!value.includes('>')) return true;
  return /未识别|unknown|鏈|鏈|未识/i.test(value);
}

function extractCategoryFromProductPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const seen = new Set();
  const findPathString = (value, depth = 0) => {
    if (depth > 4 || value == null) return '';
    if (typeof value === 'string') return value.includes('>') ? value.trim() : '';
    if (typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);
    if (Array.isArray(value)) {
      const joined = value.map(item => typeof item === 'string' ? item : (item?.name || item?.categoryName || '')).filter(Boolean).join(' > ');
      if (joined.includes('>')) return joined.trim();
      for (const item of value) {
        const found = findPathString(item, depth + 1);
        if (found) return found;
      }
      return '';
    }
    for (const key of Object.keys(value)) {
      if (!/cat|path|node|rank|bsr/i.test(key)) continue;
      const found = findPathString(value[key], depth + 1);
      if (found) return found;
    }
    return '';
  };
  const candidates = [
    payload.category,
    payload.categoryPath,
    payload.category_path,
    payload.fullCategory,
    payload.full_category,
    payload.nodePath,
    payload.node_path,
    payload.browseNodePath,
    payload.browse_node_path
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.includes('>')) return value.trim();
    if (Array.isArray(value)) {
      const joined = value.map(item => typeof item === 'string' ? item : (item?.name || item?.categoryName || '')).filter(Boolean).join(' > ');
      if (joined.includes('>')) return joined.trim();
    }
  }
  return findPathString(payload);
}

function normalizeListingDate(value) {
  if (value == null) return '';
  if (typeof value === 'number') {
    const date = value > 100000000000 ? new Date(value) : new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const match = text.match(/(20\d{2}|19\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function extractListingDateFromProductPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const seen = new Set();
  const keyPattern = /listing|listed|available|launch|release|shelf|create|date|time|上架/i;
  const walk = (value, key = '', depth = 0) => {
    if (depth > 5 || value == null) return '';
    if ((typeof value === 'string' || typeof value === 'number') && keyPattern.test(key)) {
      return normalizeListingDate(value);
    }
    if (typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, key, depth + 1);
        if (found) return found;
      }
      return '';
    }
    const keys = Object.keys(value);
    const orderedKeys = [
      ...keys.filter(k => keyPattern.test(k)),
      ...keys.filter(k => !keyPattern.test(k))
    ];
    for (const nextKey of orderedKeys) {
      const found = walk(value[nextKey], nextKey, depth + 1);
      if (found) return found;
    }
    return '';
  };
  return walk(payload);
}

function extractListingDateFromText(text) {
  const normalized = String(text || '').replace(/\u00a0/g, ' ');
  const match = normalized.match(/(?:上架时间|上架日期|上市时间|Listing\s*Date|Date\s*First\s*Available|First\s*Available|Available\s*Date)[^\d]*(20\d{2}|19\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/i);
  return match ? normalizeListingDate(match[0]) : '';
}

function extractCategoryFromBsrTrendPayload(payload) {
  const top = Array.isArray(payload?.top) ? payload.top : [];
  for (const item of top) {
    const candidates = [
      item?.categoryPath,
      item?.category_path,
      item?.path,
      item?.fullPath,
      item?.namePath,
      item?.categoryNamePath,
      item?.categoryName,
      item?.name
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.includes('>')) return value.trim();
    }
  }
  return '';
}

function uniqueCategoryPaths(values) {
  return [...new Set((values || [])
    .map(value => String(value || '').trim())
    .filter(value => value.includes('>') && /^[A-Z]/.test(value) && value.length < 240))];
}

function extractMainBsrTrendSummary(payload) {
  const history = payload?.bsrAllHistory || {};
  const dates = Array.isArray(history.dates) ? history.dates : [];
  const top = Array.isArray(payload?.top) ? payload.top : [];
  const category = top[0] || null;
  const categoryId = category?.categoryId || category?.id || category?.nodeId || null;
  const values = categoryId && Array.isArray(history[categoryId]) ? history[categoryId] : [];
  const points = [];
  for (let i = 0; i < Math.min(dates.length, values.length); i++) {
    const value = parsePlainNumber(values[i]);
    if (value > 0) points.push({ date: dates[i], bsr: value });
  }
  const latest = points[points.length - 1] || null;
  return {
    categoryId: categoryId || '',
    categoryName: category?.categoryName || category?.name || '',
    pointCount: points.length,
    latestDate: latest?.date || '',
    latestBsr: latest?.bsr || 0,
    recentPoints: points.slice(-30)
  };
}

async function extractAsinCategoryFromProductInformation(browser, asin) {
  const page = await browser.newPage();
  const state = { basicInfo: null, bsrTrend: null };
  const onResponse = async response => {
    const url = response.url();
    if (!url.includes(asin) && !/basicInfo|bsrTrends|rank|category/i.test(url)) return;
    if (!/basicInfo|bsrTrends|rank|category|information/i.test(url)) return;
    try {
      const json = JSON.parse(await response.text());
      if (url.includes('basicInfo')) state.basicInfo = json.data || json;
      else if (url.includes('bsrTrends')) state.bsrTrend = json.data || json;
      else if (/products\/information|products\/base|productInfo|product\/info/i.test(url) && !state.basicInfo) {
        state.basicInfo = json.data || json;
      }
    } catch {}
  };
  page.on('response', onResponse);
  try {
    await gotoProductInformation(page, asin);
    await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, { timeout: 30000 });
    for (let i = 0; i < 10; i++) {
      if (state.basicInfo || state.bsrTrend) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    await page.waitForFunction(() => {
      const lines = document.body.innerText.split('\n').map(line => line.trim()).filter(Boolean);
      return lines.some(line =>
        line.includes('>') &&
        /^[A-Z]/.test(line) &&
        !line.includes('http') &&
        !line.includes('ASIN') &&
        line.length < 240
      );
    }, { timeout: 30000 }).catch(() => {});
    const pageTextCategories = await page.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(line => line.trim()).filter(Boolean);
      return lines.filter(line =>
        line.includes('>') &&
        /^[A-Z]/.test(line) &&
        !line.includes('http') &&
        !line.includes('ASIN') &&
        line.length < 240
      );
    }).catch(() => []);
    const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const payloadCategory =
      extractCategoryFromProductPayload(state.basicInfo) ||
      extractCategoryFromBsrTrendPayload(state.bsrTrend);
    const categories = uniqueCategoryPaths([payloadCategory, ...pageTextCategories]);
    const category = categories[0] || '';
    const listingDate =
      extractListingDateFromProductPayload(state.basicInfo) ||
      extractListingDateFromText(pageText);
    return {
      asin,
      category,
      categories,
      listingDate,
      title: state.basicInfo?.title || state.basicInfo?.name || '',
      brand: state.basicInfo?.brand || '',
      bsrTrend: extractMainBsrTrendSummary(state.bsrTrend),
      source: category || listingDate ? 'products-information' : 'not-found'
    };
  } finally {
    page.off('response', onResponse);
    await page.close().catch(() => {});
  }
}

async function supplementUnknownCategories(browser, items) {
  const targets = (items || []).filter(item => item.asin && isUnknownCategoryValue(item.category));
  const uniqueAsins = [...new Set(targets.map(item => item.asin))];
  if (!uniqueAsins.length) {
    console.log('Category supplement: no unknown categories');
    return { checked: 0, supplemented: 0, failed: 0, items: [] };
  }
  console.log(`Category supplement: ${uniqueAsins.length} ASIN with unknown category`);
  const summary = { checked: 0, supplemented: 0, failed: 0, items: [] };
  const cache = new Map();
  const concurrency = Math.max(1, Math.min(5, Number(process.env.OALUR_CATEGORY_SUPPLEMENT_CONCURRENCY || 5)));
  let cursor = 0;
  async function worker() {
    while (cursor < uniqueAsins.length) {
      const asin = uniqueAsins[cursor++];
      summary.checked += 1;
      try {
        const result = await extractAsinCategoryFromProductInformation(browser, asin);
        cache.set(asin, result);
        if (result.category && !isUnknownCategoryValue(result.category)) {
          summary.supplemented += 1;
          console.log(`  ${asin}: category supplemented -> ${result.category}`);
        } else {
          summary.failed += 1;
          console.warn(`  ${asin}: category not found on product search detail`);
        }
        summary.items.push({
          asin,
          category: result.category || '',
          categories: result.categories || [],
          listingDate: result.listingDate || '',
          source: result.source,
          bsrTrend: result.bsrTrend
        });
      } catch (error) {
        summary.failed += 1;
        cache.set(asin, { asin, category: '', source: 'error', error: error.message });
        summary.items.push({ asin, category: '', source: 'error', error: error.message });
        console.warn(`  ${asin}: category supplement failed: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueAsins.length) }, () => worker()));
  for (const item of targets) {
    const result = cache.get(item.asin);
    if (!result?.category || isUnknownCategoryValue(result.category)) continue;
    item.category = result.category;
    item.categories = result.categories || [result.category];
    item.categorySupplementedFrom = result.source;
    item.categorySupplementCategories = result.categories || [result.category];
    item.categorySupplementBsrTrend = result.bsrTrend;
    if (!normalizeListingDate(item.listingDate) && result.listingDate) {
      item.listingDate = result.listingDate;
      item.listingDateSupplementedFrom = result.source;
    }
    if (!item.title && result.title) item.title = result.title.substring(0, 100);
    if (!item.brand && result.brand) item.brand = result.brand;
  }
  console.log(`Category supplement done: checked ${summary.checked}, supplemented ${summary.supplemented}, failed ${summary.failed}`);
  return summary;
}

async function supplementMissingListingDates(browser, items) {
  const targets = (items || []).filter(item => item.asin && !normalizeListingDate(item.listingDate));
  const uniqueAsins = [...new Set(targets.map(item => item.asin))];
  if (!uniqueAsins.length) {
    console.log('Listing date supplement: no missing listing dates');
    return { checked: 0, supplemented: 0, failed: 0, items: [] };
  }
  console.log(`Listing date supplement: ${uniqueAsins.length} ASIN with missing listing date`);
  const summary = { checked: 0, supplemented: 0, failed: 0, items: [] };
  const cache = new Map();
  const concurrency = Math.max(1, Math.min(5, Number(process.env.OALUR_LISTING_DATE_SUPPLEMENT_CONCURRENCY || 5)));
  let cursor = 0;
  async function worker() {
    while (cursor < uniqueAsins.length) {
      const asin = uniqueAsins[cursor++];
      summary.checked += 1;
      try {
        const result = await extractAsinCategoryFromProductInformation(browser, asin);
        cache.set(asin, result);
        if (result.listingDate) {
          summary.supplemented += 1;
          console.log(`  ${asin}: listing date supplemented -> ${result.listingDate}`);
        } else {
          summary.failed += 1;
          console.warn(`  ${asin}: listing date not found on product information page`);
        }
        summary.items.push({ asin, listingDate: result.listingDate || '', source: result.source });
      } catch (error) {
        summary.failed += 1;
        cache.set(asin, { asin, listingDate: '', source: 'error', error: error.message });
        summary.items.push({ asin, listingDate: '', source: 'error', error: error.message });
        console.warn(`  ${asin}: listing date supplement failed: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueAsins.length) }, () => worker()));
  for (const item of targets) {
    const result = cache.get(item.asin);
    if (!result?.listingDate) continue;
    item.listingDate = result.listingDate;
    item.listingDateSupplementedFrom = result.source;
    if (!item.title && result.title) item.title = result.title.substring(0, 100);
    if (!item.brand && result.brand) item.brand = result.brand;
  }
  console.log(`Listing date supplement done: checked ${summary.checked}, supplemented ${summary.supplemented}, failed ${summary.failed}`);
  return summary;
}

function productInformationUrl(asin) {
  return `${OALUR_PRODUCT_INFO_URL}?asin=${encodeURIComponent(asin)}&site=US`;
}

async function gotoProductInformation(page, asin) {
  const url = productInformationUrl(asin);
  try {
    await activatePage(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: OALUR_NAV_TIMEOUT_MS });
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('timeout')) {
      console.error(`ERROR: product information ${asin} navigation timed out after 30s. Stop execution and report to user.`);
    }
    throw error;
  }
}

async function extractRatingFromProductInformation(page, asin) {
  await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, { timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));
  const result = await page.evaluate((targetAsin) => {
    const normalize = value => String(value || '').replace(/\u00a0/g, ' ').trim();
    const parseNum = value => {
      const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };
    const text = normalize(document.body.innerText);
    const patterns = [
      /评分数\s*\/\s*评论数\s*[:：]?\s*([0-9][0-9,]*)/i,
      /Ratings?\s*\/\s*Reviews?\s*[:：]?\s*([0-9][0-9,]*)/i,
      /评分数\s*[:：]?\s*([0-9][0-9,]*)/i,
      /Ratings?\s*[:：]?\s*([0-9][0-9,]*)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const value = parseNum(match?.[1]);
      if (value > 0) return { value, evidence: match[0].slice(0, 120) };
    }
    const lines = text.split('\n').map(normalize).filter(Boolean);
    const ratingLine = lines.find(line => /评分数|Ratings?/i.test(line) && /评论数|Reviews?/i.test(line));
    if (ratingLine) {
      const nums = ratingLine.match(/[0-9][0-9,]*/g) || [];
      const value = parseNum(nums[0]);
      if (value > 0) return { value, evidence: ratingLine.slice(0, 120) };
    }
    const asinLineIndex = lines.findIndex(line => line.includes(targetAsin));
    const nearby = asinLineIndex >= 0 ? lines.slice(Math.max(0, asinLineIndex - 8), asinLineIndex + 12).join(' | ') : '';
    return { value: 0, evidence: nearby.slice(0, 240) };
  }, asin);
  return result;
}

async function supplementZeroParentRatings(browser, items) {
  const targets = (items || []).filter(item => item.asin && parseNumber(item.ratingsNumAggregated || item.ratings) <= 0);
  if (!targets.length) {
    console.log('Parent Ratings supplement: no zero-rating parent listings');
    return { checked: 0, supplemented: 0, failed: 0 };
  }

  console.log(`Parent Ratings supplement: ${targets.length} parent listings have zero Ratings`);
  const summary = { checked: 0, supplemented: 0, failed: 0, items: [] };
  const concurrency = Math.max(1, Math.min(5, Number(process.env.OALUR_RATINGS_SUPPLEMENT_CONCURRENCY || 5)));
  let cursor = 0;
  async function worker() {
    const page = await browser.newPage();
    try {
      while (cursor < targets.length) {
        const item = targets[cursor++];
        summary.checked += 1;
        const asin = item.asin;
        try {
          await gotoProductInformation(page, asin);
          const rating = await extractRatingFromProductInformation(page, asin);
          if (rating.value > 0) {
            item.ratings = formatInteger(rating.value);
            item.ratingsNumAggregated = Math.round(rating.value);
            item.ratingsMetricSource = 'product-information-parent-zero';
            item.ratingsMetricReason = 'parent-ratings-zero-supplemented';
            item.ratingsMetricValues = [{ asin, value: Math.round(rating.value), source: 'products/information' }];
            item.ratingsSupplementedFrom = 'products/information-parent-zero';
            item.ratingsSupplementEvidence = rating.evidence;
            summary.supplemented += 1;
            summary.items.push({ asin, rating: Math.round(rating.value), status: 'supplemented' });
            console.log(`  ${asin}: supplemented Ratings ${formatInteger(rating.value)}`);
          } else {
            item.ratingsLookupFailed = true;
            item.ratingsLookupEvidence = rating.evidence;
            summary.failed += 1;
            summary.items.push({ asin, rating: 0, status: 'not-found' });
            console.warn(`  ${asin}: Ratings not found on product information page`);
          }
        } catch (error) {
          item.ratingsLookupFailed = true;
          item.ratingsLookupError = error.message;
          summary.failed += 1;
          summary.items.push({ asin, rating: 0, status: 'error', error: error.message });
          console.warn(`  ${asin}: Ratings supplement failed: ${error.message}`);
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  console.log(`Parent Ratings supplement done: checked ${summary.checked}, supplemented ${summary.supplemented}, failed ${summary.failed}`);
  return summary;
}

async function sortByListingDateNewestFirst(page, keyword) {
  if (!historicalNewOnly) {
    const summary = {
      keyword,
      skipped: true,
      reason: 'current-market-extraction-keeps-default-sort'
    };
    logger.info('market.sort_listing_date', summary);
    return summary;
  }
  const clicked = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('.el-table__header-wrapper th')];
    const target = headers[8] || headers.find(th => /涓婃灦|Listing|Date|鏃堕棿/.test(th.innerText || ''));
    if (!target) return { clicked: false, reason: 'listing-date-header-not-found' };
    const descending = target.querySelector('.descending, .sort-caret.descending');
    const ascending = target.querySelector('.ascending, .sort-caret.ascending');
    (descending || ascending || target).click();
    return {
      clicked: true,
      headerText: (target.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    };
  });
  if (clicked.clicked) {
    console.log('Historical new-only mode: sorted by listing date before extraction');
    await new Promise(r => setTimeout(r, 3000));
    const check = await extractPageData(page).catch(() => ({ data: [] }));
    const dates = check.data.map(item => normalizeListingDate(item.listingDate)).filter(Boolean).slice(0, 8);
    const verifiedDescending = dates.length < 2 || dates.every((date, index) => index === 0 || date <= dates[index - 1]);
    const summary = {
      keyword,
      clicked: true,
      headerText: clicked.headerText,
      verifiedDescending,
      sampleDates: dates
    };
    logger.info('market.sort_listing_date', summary);
    return summary;
  } else {
    const summary = {
      keyword,
      clicked: false,
      reason: clicked.reason || 'unknown'
    };
    console.warn('Historical new-only mode: listing date sort header not found; continuing with filtered extraction');
    logger.warn('market.sort_listing_date', summary);
    return summary;
  }
}

async function waitForResultRows(page, timeout = 20000) {
  await page.waitForFunction(() => {
    const row = document.querySelector('.el-table__body-wrapper table tbody tr:first-child');
    const loading = [...document.querySelectorAll('.el-loading-mask')].some(el => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    return !loading && row && /ASIN:\s*[A-Z0-9]{10}/.test(row.innerText);
  }, { timeout });
}

async function clickConfirmQuery(page) {
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      const text = btn.innerText.trim();
      if (text === '确认查询' || text === '纭鏌ヨ') { btn.click(); break; }
    }
  });
}

async function setInputValue(page, elementHandle, value) {
  await elementHandle.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(value), { delay: 10 });
  await elementHandle.evaluate(input => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  });
}

async function setBsrRange(page, min, max) {
  const handles = await page.evaluateHandle(() => {
    const labels = document.querySelectorAll('.el-form-item__label, label, span');
    for (const label of labels) {
      const labelText = label.innerText || '';
      if ((labelText.includes('BSR') && (labelText.includes('大类') || labelText.includes('澶х被'))) ||
        labelText.includes('大类BSR排名') || labelText.includes('澶х被BSR鎺掑悕')) {
        const parent = label.closest('.el-form-item') || label.parentElement?.parentElement;
        const inputs = parent ? [...parent.querySelectorAll('input[type="number"]')] : [];
        if (inputs.length >= 2) return inputs.slice(0, 2);
      }
    }
    return [];
  });
  const properties = await handles.getProperties();
  const inputs = [...properties.values()].slice(0, 2).map(handle => handle.asElement()).filter(Boolean);
  if (inputs.length < 2) throw new Error('BSR range inputs not found');
  await setInputValue(page, inputs[0], min);
  await setInputValue(page, inputs[1], max);
  const values = await page.evaluate(() => {
    const labels = document.querySelectorAll('.el-form-item__label, label, span');
    for (const label of labels) {
      const labelText = label.innerText || '';
      if ((labelText.includes('BSR') && (labelText.includes('大类') || labelText.includes('澶х被'))) ||
        labelText.includes('大类BSR排名') || labelText.includes('澶х被BSR鎺掑悕')) {
        const parent = label.closest('.el-form-item') || label.parentElement?.parentElement;
        const inputs = parent ? [...parent.querySelectorAll('input[type="number"]')] : [];
        return inputs.slice(0, 2).map(input => input.value);
      }
    }
    return [];
  });
  if (String(values[0]) !== String(min) || String(values[1]) !== String(max)) {
    throw new Error(`BSR range was not applied; expected ${min}-${max}, got ${values.join('-')}`);
  }
  console.log(`BSR inputs applied: ${values[0]}-${values[1]}`);
}

async function extractKeyword(page, keyword) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Keyword: ${keyword}`);
  console.log('='.repeat(50));
  const keywordRun = {
    keyword,
    startedAt: new Date().toISOString(),
    bsrRange: `${minBsr}-${maxBsr}`,
    timeFilter: timeFilterLabel || '近30天',
    historicalNewOnly,
    allowOverPageLimit,
    pagesAvailable: null,
    pagesFetched: 0,
    rowsExtracted: 0
  };
  runStats.keywords[keyword] = keywordRun;
  logger.info('market.keyword_start', keywordRun);

  // 0. 濮ｅ繑顐奸柌宥嗘煀閸旂姾娴囨い鐢告桨閿涘瞼鈥樻穱婵嗗叡閸戔偓閻樿埖鈧?
  await gotoOalurFilter(page, `keyword ${keyword}`);
  await new Promise(r => setTimeout(r, 3000));

  // 1. Navigate to Oalur product search and prepare query filters.
  await page.evaluate((kw) => {
    const input = document.querySelector('input[placeholder*="鏀寔ASIN"], input[placeholder*="ASIN"]');
    if (input) {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      s.call(input, kw);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }, keyword);
  await new Promise(r => setTimeout(r, 500));

  // 2. Set BSR range.
  console.log(`Applying BSR range to page: ${minBsr}-${maxBsr}`);
  await setBsrRange(page, minBsr, maxBsr);
  await new Promise(r => setTimeout(r, 500));

  // 3. 鐠佸墽鐤嗛弮鍫曟？缁涙盯鈧绱欓弰鎯х础閹稿洤鐣鹃敍姘秼閸?鏉?0婢垛晪绱濋崢鍡楀蕉=閹稿洤鐣鹃張鍫滃敜閿?
  const timeToClick = timeFilterLabel || '近30天';
  console.log(`Time filter: ${timeToClick}`);
  await page.evaluate((label) => {
    const lis = document.querySelectorAll('.time-scope li');
    for (const li of lis) {
      if (li.innerText.trim() === label) {
        const btn = li.querySelector('button');
        if (btn) btn.click();
        return;
      }
    }
  }, timeToClick);
  await new Promise(r => setTimeout(r, 3000));

  // 4. Click confirm/search when the query UI is ready.
  await clickConfirmQuery(page);
  await new Promise(r => setTimeout(r, 5000));

  await ensureVariantSkuEnabled(page);
  // 缁涘绶熺悰銊︾壐閸掗攱鏌婇敍鍫⑩€樻穱?ASIN 閸欘垱褰侀崣鏍电礆
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const hasAsin = await page.evaluate(() => {
      const row = document.querySelector('.el-table__body-wrapper table tbody tr:first-child');
      return row && /ASIN:\s*[A-Z0-9]{10}/.test(row.innerText);
    });
    if (hasAsin) { console.log('Search results loaded.'); break; }
  }

  // 4. 閹绘劕褰囩粭?妞?
  if (!(await isVariantSkuChecked(page))) throw new Error('绗竴椤垫姄鍙栧墠鈥滄煡鐪嬪叾浠栧彉浣撯€濅笉鏄嬀閫夌姸鎬侊紝鍋滄鎵ц');
  keywordRun.listingDateSort = await sortByListingDateNewestFirst(page, keyword);
  await ensureVariantSkuEnabled(page);
  let result = await extractPageData(page);
  let allData = filterHistoricalNewCandidates(result.data);
  keywordRun.firstPage = {
    rawRows: result.data.length,
    keptRows: allData.length,
    total: result.total,
    lastPage: result.lastPage
  };
  keywordRun.pagesAvailable = result.lastPage;
  keywordRun.pagesFetched = 1;
  console.log(`First page: ${allData.length}/${result.data.length} rows, total: ${result.total}, pages: ${result.lastPage}`);
  logger.info('market.first_page', {
    keyword,
    ...keywordRun.firstPage
  });
  if (!historicalNewOnly) {
    const estimatedRows = estimateRowsFromFirstPage(result);
    if (estimatedRows > HARD_SKIP_ROWS) {
      const details = {
        keyword,
        estimatedRows,
        total: result.total,
        lastPage: result.lastPage,
        firstPageRows: result.data.length,
        hardSkipRows: HARD_SKIP_ROWS,
        bsrRange: `${minBsr}-${maxBsr}`,
        timeFilter: timeFilterLabel || '近30天',
        checkedAt: new Date().toISOString()
      };
      keywordRun.skippedOver500 = true;
      keywordRun.skipDetails = details;
      logger.warn('market.skip_over_500', details);
      throw new SkipOver500Error(details);
    }
  }
  if (!historicalNewOnly && result.lastPage > MAX_PAGES && !allowOverPageLimit) {
    const estimatedRows = estimateRowsFromFirstPage(result);
    keywordRun.pageLimitExceeded = true;
    keywordRun.pageLimitAction = 'stop_before_over_400';
    logger.warn('market.page_limit_exceeded', {
      keyword,
      lastPage: result.lastPage,
      estimatedRows,
      maxPages: MAX_PAGES,
      maxRows: MAX_PAGES * 20,
      continueAfter400: false,
      rerunWith: '--allow-over-400'
    });
    throw new Error(
      `Oalur result has ${result.lastPage} pages, estimated ${estimatedRows} rows, exceeding current limit ${MAX_PAGES} pages / ${MAX_PAGES * 20} rows. ` +
      `Stop here and ask user whether to continue. If confirmed, rerun with --allow-over-400.`
    );
  }

  // 5. 閸掑棝銆夐敍鍫熺槷鏉堝啯鏆ｆい?ASIN 闂嗗棗鎮庨敍?
  if (historicalNewOnly && result.data.length > 0 && allData.length === 0) {
    console.log('Historical new-only mode: first page has no products listed within 6 months at snapshot; stop pagination');
    keywordRun.pagination = {
      stopReason: 'historical-first-page-outside-six-month-window',
      pagesPlanned: 1,
      pagesFetched: 1
    };
    logger.info('market.pagination_plan', { keyword, ...keywordRun.pagination });
  } else if (result.lastPage > 1) {
    const actualLastPage = allowOverPageLimit ? result.lastPage : Math.min(result.lastPage, MAX_PAGES);
    console.log(`  extracting up to ${actualLastPage} pages, about ${actualLastPage * 20} rows`);
    keywordRun.pagination = {
      pagesAvailable: result.lastPage,
      pagesPlanned: actualLastPage,
      maxPages: MAX_PAGES,
      exceededDefaultLimit: result.lastPage > MAX_PAGES,
      continueAfter400: result.lastPage > MAX_PAGES && allowOverPageLimit
    };
    logger.info('market.pagination_plan', { keyword, ...keywordRun.pagination });
    const prevPageAsins = new Set(allData.map(d => d.asin));
    for (let p = 2; p <= actualLastPage; p++) {
      await page.evaluate((targetPage) => {
        const pager = document.querySelector('.el-pager');
        if (!pager) return;
        const btns = pager.querySelectorAll('.number');
        for (const btn of btns) {
          if (btn.innerText.trim() === String(targetPage)) { btn.click(); break; }
        }
      }, p);
      await ensureVariantSkuEnabled(page);
      let rawPageData = [];
      let changed = false;
      for (let wait = 0; wait < 10; wait++) {
        await new Promise(r => setTimeout(r, 1000));
        const check = await extractPageData(page);
        if (check.data.length === 0) continue;
        const hasNewAsins = check.data.some(d => d.asin && !prevPageAsins.has(d.asin));
        if (hasNewAsins) {
          rawPageData = check.data;
          changed = true;
          break;
        }
      }
      if (!changed) { console.log(`  page ${p}: unchanged, skipped`); continue; }
      rawPageData.forEach(d => prevPageAsins.add(d.asin));
      const pageData = filterHistoricalNewCandidates(rawPageData);
      if (historicalNewOnly && rawPageData.length > 0 && pageData.length === 0) {
        console.log(`  page ${p}: 0/${rawPageData.length} rows within 6 months at snapshot; stop pagination`);
        break;
      }
      allData = allData.concat(pageData);
      console.log(`  page ${p}: ${pageData.length}/${rawPageData.length} rows, accumulated: ${allData.length}`);
      keywordRun.pagesFetched = p;
      logger.info('market.page_extracted', {
        keyword,
        page: p,
        rawRows: rawPageData.length,
        keptRows: pageData.length,
        accumulatedRows: allData.length
      });
    }
  }

  // Extract keyword data and merge results.
  allData.forEach(d => { d.sourceKeyword = keyword; });
  keywordRun.rowsExtracted = allData.length;
  keywordRun.completedAt = new Date().toISOString();
  console.log(`"${keyword}" extracted: ${allData.length} rows`);
  logger.info('market.keyword_complete', {
    keyword,
    rowsExtracted: allData.length,
    pagesFetched: keywordRun.pagesFetched,
    pagesAvailable: keywordRun.pagesAvailable
  });
  return allData;
}

(async () => {
  if (keywordIntentAnalysisPromise) await keywordIntentAnalysisPromise;
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null, protocolTimeout: 600000 });
  const page = await browser.newPage();
  await gotoOalurFilter(page, 'initial page');
  await activatePage(page);
  console.log('閴?瀹歌尪绻涢幒?Edge');

  // 闁劒閲滈崗鎶芥暛鐠囧秵濮勯崣?
  let allRawData = [];
  const keywordStats = {};
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    // 濮ｅ繋閲滈崗鎶芥暛鐠囧秹鍣搁弬鏉垮鏉炰粙銆夐棃顫礉绾喕绻氶幖婊呭偍閻欘剛鐝?
    if (i > 0) {
      console.log('\nReloading page for next keyword...');
      await gotoOalurFilter(page, `keyword ${kw}`);
      await new Promise(r => setTimeout(r, 3000));
    }
    let kwData = [];
    try {
      kwData = await extractKeyword(page, kw);
    } catch (error) {
      if (error?.code === 'SKIP_OVER_500') {
        writeSkippedOver500Output(error.details);
        logger.end({
          status: 'skipped',
          skippedOver500: true,
          outputFile: path.relative(process.cwd(), outFile),
          skipDetails: error.details
        });
        await page.close().catch(() => {});
        await browser.disconnect();
        return;
      }
      throw error;
    }
    keywordStats[kw] = kwData.length;
    allRawData = allRawData.concat(kwData);
  }

  console.log(`\n${'='.repeat(50)}`);
  // ASIN 閸樺鍣?
  const seenAsin = new Set();
  allRawData = allRawData.filter(item => {
    if (!item.asin || seenAsin.has(item.asin)) return false;
    seenAsin.add(item.asin);
    return true;
  });
  console.log(`ASIN deduplicated: ${allRawData.length} rows`);

  const categorySupplementSummary = await supplementUnknownCategories(browser, allRawData);
  let listingDateSupplementSummary = { checked: 0, supplemented: 0, failed: 0, details: [], skipped: !historicalNewOnly };
  if (historicalNewOnly) {
    listingDateSupplementSummary = await supplementMissingListingDates(browser, allRawData);
    const beforeDateFiltered = allRawData.length;
    allRawData = filterHistoricalNewCandidates(allRawData);
    console.log(`Historical new-only mode after listing date supplement: ${allRawData.length}/${beforeDateFiltered} rows remain`);
  }
  const categorySelectionSource = allRawData.flatMap(item => {
    const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);
    return categories.length ? categories.map(category => ({ ...item, category })) : [item];
  });
  const initialCategorySelectionResult = selectTargetCategories(categorySelectionSource, keywords, { referenceCategories });
  const targetCategoryCodexReview = loadTargetCategoryCodexReview(outFile, {});
  const targetCategoryCodexApplication = applyTargetCategoryCodexReview(initialCategorySelectionResult, targetCategoryCodexReview.review);
  const categorySelectionResult = targetCategoryCodexApplication.categorySelectionResult;
  const targetCategory = categorySelectionResult.targetCategory;
  const targetCategories = categorySelectionResult.targetCategories;
  const targetCategoryCodexReviewRequest = buildTargetCategoryCodexReviewRequest({
    keywords,
    categorySelection: categorySelectionResult.categorySelection,
    targetCategories,
    referenceCategories,
    items: categorySelectionSource
  });
  const targetCategoryCodexReviewWrite = writeTargetCategoryCodexReviewRequest(
    outFile,
    targetCategoryCodexReviewRequest,
    targetCategoryCodexReview.review,
    targetCategoryCodexReview.reviewFile
  );
  const referenceCategorySelection = buildReferenceCategorySelectionSummary(
    referenceCategories,
    categorySelectionResult.categorySelection
  );
  const targetCategorySet = new Set(targetCategories);
  const codexSemanticReview = loadCodexSemanticReview(outFile, {});
  const equivalentCategorySet = new Set(
    categorySelectionResult.categorySelection
      .filter(d => d.titleIntentRescueCandidate || d.functionalEquivalent)
      .filter(d => !targetCategorySet.has(d.category))
      .map(d => d.category)
  );

  const beforeParentAggregate = allRawData.length;
  allRawData = aggregateParentListings(allRawData).map(item => applyTargetCategoryMatch(item, targetCategorySet));
  console.log(`Parent listing aggregation: ${beforeParentAggregate} ASIN/variants -> ${allRawData.length} parent listings`);
  let ratingsSupplementSummary = { checked: 0, supplemented: 0, failed: 0, details: [], skipped: true };

  const catCount = {};
  categorySelectionSource.forEach(d => {
    const cat = d.category || 'unknown';
    catCount[cat] = (catCount[cat] || 0) + 1;
  });
  const sortedCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]);
  console.log('\nCategory distribution (ASIN/variant rows):');
  sortedCats.forEach(([cat, count]) => console.log(`  [${count}] ${cat}`));
  const rescuePriceGuard = buildRescuePriceGuard(
    allRawData,
    item => listingMatchesTargetCategories(item, targetCategorySet)
  );
  if (rescuePriceGuard.enabled) {
    console.log(`Rescue price guard: target n=${rescuePriceGuard.targetSampleSize}, median=$${rescuePriceGuard.median}, allowed $${rescuePriceGuard.lowerLimit}-$${rescuePriceGuard.upperLimit}`);
  } else {
    console.log(`Rescue price guard disabled: ${rescuePriceGuard.reason}`);
  }

  const listingMatchesFilter = (item) => {
    const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);
    if (listingMatchesTargetCategories(item, targetCategorySet)) {
      item.targetCategoryDirectMatched = true;
      delete item.codexSemanticReviewExcluded;
      delete item.codexSemanticReviewRescued;
      delete item.codexSemanticReviewDecision;
      delete item.targetCategoryTitleIntentRejected;
      return true;
    }
    if (applyCodexSemanticReviewExclusion(item, codexSemanticReview.reviewIndex)) {
      return false;
    }
    if (applyCodexSemanticReview(item, codexSemanticReview.reviewIndex)) {
      item.targetMatchedCategories = [...new Set([...(item.targetMatchedCategories || []), ...categories])];
      return true;
    }
    return false;
  };
  const matched = [];
  const notMatched = [];
  allRawData.forEach(item => {
    if (listingMatchesFilter(item)) matched.push(item);
    else notMatched.push(item);
  });
  const filtered = matched;
  const excluded = notMatched;
  const codexSemanticReviewCandidates = buildCodexSemanticReviewCandidates({
    keywords,
    categorySelection: categorySelectionResult.categorySelection,
    targetCategories,
    items: allRawData,
    referenceCategories
  });
  if (!historicalNewOnly) {
    listingDateSupplementSummary = await supplementMissingListingDates(browser, filtered);
  }
  ratingsSupplementSummary = await supplementZeroParentRatings(browser, filtered);
  console.log(`\nTarget categories: ${targetCategories.join(' | ')}`);
  console.log(`Filtered: ${allRawData.length} -> ${filtered.length}, excluded ${excluded.length}`);

  const missingDataSummary = summarizeDataQuality(filtered);
  const allParentDataSummary = summarizeDataQuality(allRawData);
  const marketRunSummary = {
    logFile: path.relative(process.cwd(), logger.logFile),
    outputFile: path.relative(process.cwd(), outFile),
    keywords,
    bsrRange: `${minBsr}-${maxBsr}`,
    timeFilter: timeFilterLabel || '近30天',
    historicalNewOnly,
    pageLimit: runStats.pageLimit,
    keywordRuns: runStats.keywords,
    rawRowsAfterAsinDedupeAndParentAggregation: allRawData.length,
    filteredProductCount: filtered.length,
    excludedProductCount: excluded.length,
    minMonthlySales: missingDataSummary.minMonthlySales,
    missingDataSummary,
    allParentDataSummary,
    supplementSummary: {
      category: categorySupplementSummary,
      listingDate: listingDateSupplementSummary,
      ratings: ratingsSupplementSummary
    },
    targetCategories,
    equivalentCandidateCategories: [...equivalentCategorySet],
    targetCategoryCodexReviewFile: path.relative(path.dirname(path.resolve(outFile)), targetCategoryCodexReview.reviewFile),
    targetCategoryCodexReviewLoaded: targetCategoryCodexApplication.decisionCount > 0,
    targetCategoryCodexReviewApplied: Boolean(targetCategoryCodexApplication.applied),
    targetCategorySelectionMode: targetCategoryCodexApplication.mode,
    targetCategoryCodexReviewDecisionCount: targetCategoryCodexApplication.decisionCount,
    targetCategoryCodexReviewReviewedCategoryCount: targetCategoryCodexApplication.reviewedCategoryCount,
    targetCategoryCodexReviewTotalCategoryCount: targetCategoryCodexApplication.totalCategoryCount,
    targetCategoryCodexReviewComplete: Boolean(targetCategoryCodexApplication.complete),
    targetCategoryCodexReviewIncludedCategories: targetCategoryCodexApplication.includedCategories,
    targetCategoryCodexReviewExcludedCategories: targetCategoryCodexApplication.excludedCategories,
    targetCategoryCodexReviewStandard: TARGET_CATEGORY_REVIEW_STANDARD,
    targetCategoryCodexReviewRequestFile: path.relative(path.dirname(path.resolve(outFile)), targetCategoryCodexReviewWrite.reviewFile),
    targetCategoryCodexReviewRequestWritten: Boolean(targetCategoryCodexReviewWrite.written),
    codexSemanticReviewFile: path.relative(path.dirname(path.resolve(outFile)), codexSemanticReview.reviewFile),
    codexSemanticReviewLoaded: Boolean(codexSemanticReview.review),
    codexSemanticReviewStandard: REVIEW_STANDARD,
    codexSemanticReviewCandidates,
    generatedAt: new Date().toISOString()
  };
  logger.info('market.final_summary', marketRunSummary);

  // 娣囨繂鐡?
  const output = {
    keywords: keywords,
    keyword: keywords.join(' + '),
    bsrRange: minBsr + '-' + maxBsr,
    timeFilter: timeFilterLabel || '近30天',
    historicalNewOnly,
    survivalBaseline: survivalBaseline || null,
    historicalNewOnlyRule: historicalNewOnly ? 'sort by listing date and keep products listed within 6 months at historical snapshot' : null,
    rawTotal: allRawData.length,
    total: allRawData.length,
    allCount: allRawData.length,
    filteredCount: filtered.length,
    excludedCount: excluded.length,
    targetMatchedCount: matched.length,
    salesFloorExcludedCount: 0,
    targetCategory,
    targetCategories,
    equivalentCandidateCategories: [...equivalentCategorySet],
    referenceCategories,
    referenceCategorySelection,
    targetCategoryCodexReviewFile: path.relative(path.dirname(path.resolve(outFile)), targetCategoryCodexReview.reviewFile),
    targetCategoryCodexReviewLoaded: targetCategoryCodexApplication.decisionCount > 0,
    targetCategoryCodexReviewApplied: Boolean(targetCategoryCodexApplication.applied),
    targetCategorySelectionMode: targetCategoryCodexApplication.mode,
    targetCategoryCodexReviewDecisionCount: targetCategoryCodexApplication.decisionCount,
    targetCategoryCodexReviewReviewedCategoryCount: targetCategoryCodexApplication.reviewedCategoryCount,
    targetCategoryCodexReviewTotalCategoryCount: targetCategoryCodexApplication.totalCategoryCount,
    targetCategoryCodexReviewComplete: Boolean(targetCategoryCodexApplication.complete),
    targetCategoryCodexReviewIncludedCategories: targetCategoryCodexApplication.includedCategories,
    targetCategoryCodexReviewExcludedCategories: targetCategoryCodexApplication.excludedCategories,
    targetCategoryCodexReviewStandard: TARGET_CATEGORY_REVIEW_STANDARD,
    targetCategoryCodexReviewRequestFile: path.relative(path.dirname(path.resolve(outFile)), targetCategoryCodexReviewWrite.reviewFile),
    targetCategoryCodexReviewRequestWritten: Boolean(targetCategoryCodexReviewWrite.written),
    targetCategoryCodexReviewRequest,
    codexSemanticReviewFile: path.relative(path.dirname(path.resolve(outFile)), codexSemanticReview.reviewFile),
    codexSemanticReviewLoaded: Boolean(codexSemanticReview.review),
    codexSemanticReviewStandard: REVIEW_STANDARD,
    codexSemanticReviewCandidates,
    rescuePriceGuard,
    categorySelection: categorySelectionResult.categorySelection,
    categoryDistribution: sortedCats,
    keywordStats,
    marketRunSummary,
    ratingsSupplementSummary,
    categorySupplementSummary,
    listingDateSupplementSummary,
    data: filtered,
    excluded
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nData saved: ${outFile}`);
  logger.end({
    status: 'completed',
    outputFile: path.relative(process.cwd(), outFile),
    productCount: filtered.length,
    minMonthlySales: missingDataSummary.minMonthlySales,
    missingDataSummary
  });

  // 閹芥顩?
  console.log(`\n${'='.repeat(50)}`);
  console.log('Extraction summary');
  console.log('='.repeat(50));
  keywords.forEach(kw => console.log(`  "${kw}": ${keywordStats[kw]} rows`));
  console.log(`  after merge/dedupe: ${allRawData.length} rows`);
  console.log(`  after target filtering: ${filtered.length} rows`);

  await page.close().catch(() => {});
  await browser.disconnect();
})().catch(err => {
  logger.error('run.failed', { error: err.message, stack: err.stack });
  console.error('Error:', err.message);
  process.exit(1);
});
