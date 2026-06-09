const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { selectTargetCategories, listingMatchesKeywordIntent, titleMatchesKeywordIntent } = require('./category-selector');
const {
  aggregateParentListings,
  applyTargetCategoryMatch,
  listingMatchesTargetCategories
} = require('./parent-listing-aggregate');

const OALUR_FILTER_URL = 'https://vip.oalur.com/insight/filter/index?site=US';
const OALUR_NAV_TIMEOUT_MS = 30000;

async function gotoOalurFilter(page, contextLabel = 'Oalur page') {
  try {
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

// 鏈€澶х炕椤垫暟闄愬埗锛堥槻姝㈡棤闄愬惊鐜級
const MAX_PAGES = 10;

// 鍝佺被搴曠嚎琛紙浠?SKILL.md 鍚屾缁存姢锛?
const CATEGORY_BSR_TABLE = [
  { keywords: ['makeup', 'brush', 'eyelash', 'cosmetic', 'beauty'], bsr: 10000, name: '缇庡宸ュ叿' },
  { keywords: ['cook', 'cookie', 'baking', 'kitchen', 'spatula', 'biscuit', 'cutter', 'gadget', 'utensil'], bsr: 10000, name: '鍘ㄦ埧瀹跺眳' },
  { keywords: ['pet', 'dog', 'cat', 'leash', 'toy', 'bed', 'scratch'], bsr: 25000, name: '瀹犵墿鐢ㄥ搧' },
  { keywords: ['shoe', 'shirt', 'pant', 'yoga', 'running', 'clothing', 'sweater'], bsr: 30000, name: '闉嬫湇' },
  { keywords: ['screwdriver', 'drill', 'tape', 'tool', 'home', 'hardware'], bsr: 15000, name: '宸ュ叿瀹惰' },
  { keywords: ['hair', 'clipper', 'toothbrush', 'shaver', 'trimmer'], bsr: 10000, name: '涓汉鎶ょ悊' },
  { keywords: ['phone', 'case', 'earbud', 'charger', 'cable', 'electronic'], bsr: 0, name: '娑堣垂鐢靛瓙' }, // 0 = 闇€鍏蜂綋鍒嗘瀽
  { keywords: ['pen', 'desk', 'organizer', 'office', 'stationery'], bsr: 15000, name: '鍔炲叕鐢ㄥ搧' },
  { keywords: ['resistance', 'yoga', 'mat', 'sport', 'exercise', 'gym'], bsr: 20000, name: '杩愬姩鎴峰' },
  { keywords: ['baby', 'bottle', 'pacifier', 'nursery', 'infant'], bsr: 15000, name: '姣嶅┐鐢ㄥ搧' },
  { keywords: ['block', 'puzzle', 'toy', 'game', 'LEGO'], bsr: 20000, name: '鐜╁叿' },
  { keywords: ['car', 'phone', 'mount', 'cover', 'automotive'], bsr: 15000, name: '姹借溅閰嶄欢' },
  { keywords: ['garden', 'plant', 'pot', 'outdoor', 'lawn'], bsr: 15000, name: '鍥壓' },
];

// 浠庡叧閿瘝鑷姩鍖归厤鍝佺被搴曠嚎 BSR
function autoDetectBsr(keyword) {
  const kw = keyword.toLowerCase();
  for (const cat of CATEGORY_BSR_TABLE) {
    if (cat.keywords.some(k => kw.includes(k))) {
      if (cat.bsr === 0) return null; // 闇€鍏蜂綋鍒嗘瀽
      return cat.bsr;
    }
  }
  return 10000; // 榛樿
}

// 鍙傛暟锛氬叧閿瘝1,鍏抽敭璇?,... [BSR涓婇檺] [杈撳嚭鏂囦欢鍚峕 [--time-filter YYYY-MM]
// BSR涓婇檺涓哄彲閫夊弬鏁帮紝涓嶄紶鏃惰嚜鍔ㄤ粠鍏抽敭璇嶅尮閰嶅搧绫诲簳绾?
// 绀轰緥: node extract-data.js "Cookie Cutter" 10000 merged-data.json
// 绀轰緥: node extract-data.js "Cookie Cutter"锛堣嚜鍔ㄥ尮閰?BSR锛?
// 绀轰緥: node extract-data.js "Cookie Cutter" 10000 data.json --time-filter 2025-12
const keywordsRaw = process.argv[2];
const userBsr = process.argv[3];
const defaultOutFile = keywordsRaw ? keywordsRaw.split(',')[0].trim().replace(/\s+/g, '-') + '-data.json' : '';
const dirs = outputDirs(keywordsRaw ? keywordsRaw.split(',')[0].trim() : 'output');
const explicitOutFile = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : null;
let outFile = explicitOutFile || path.join(dirs.data, defaultOutFile);

// 鏃堕棿绛涢€夊櫒锛堝彲閫夛紝鐢ㄤ簬鍘嗗彶鏁版嵁鍥炴函锛?
const timeFilterIdx = process.argv.indexOf('--time-filter');
const timeFilterRaw = timeFilterIdx > -1 ? process.argv[timeFilterIdx + 1] : null;
let timeFilterLabel = null; // 濡?"2025骞?2鏈?
if (timeFilterRaw) {
  const [y, m] = timeFilterRaw.split('-');
  if (y && m) {
    timeFilterLabel = `${y}年${parseInt(m, 10)}月`;
    console.log(`Time filter: ${timeFilterLabel}`);
  }
}

if (!keywordsRaw) {
  console.error('鐢ㄦ硶: node extract-data.js "鍏抽敭璇?,鍏抽敭璇?,..." [BSR涓婇檺] [杈撳嚭鏂囦欢.json]');
  console.error('绀轰緥: node extract-data.js "Cookie Cutter" 10000');
  console.error('Example: node extract-data.js "Cookie Cutter"');
  process.exit(1);
}

const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);
if (keywords.length > 1 && !explicitOutFile) {
  outFile = path.join(outputDirs(keywords.join('-')).data, 'merged-data.json');
}

// BSR 鍊奸€夋嫨閫昏緫锛氱敤鎴锋寚瀹?> 鑷姩鍖归厤 > 榛樿10000
let maxBsr;
const firstKw = keywords[0];
if (userBsr) {
  maxBsr = userBsr;
  console.log(`Keywords: ${keywords.join(' | ')}`);
  console.log(`BSR max: ${maxBsr} (user specified)`);
} else {
  const detected = autoDetectBsr(firstKw);
  if (detected === null) {
    maxBsr = '10000';
    console.log('Category needs manual BSR review; using default 10000');
  } else {
    maxBsr = String(detected);
    console.log(`Keywords: ${keywords.join(' | ')}`);
    console.log(`BSR max: ${maxBsr} (auto detected)`);
  }
}

// 鎻愬彇鍑芥暟锛堝惈绫荤洰璺緞鎻愬彇锛?
// Oalur 琛ㄥご鍒楁槧灏勶細
// cells[0]=鍕鹃€? cells[1]=浜у搧淇℃伅  cells[2]=棰勪及閿€閲? cells[3]=棰勪及閿€鍞
// cells[4]=瀛愪綋閿€閲?瀛愪綋閿€鍞  cells[5]=澶х被鎺掑悕  cells[6]=灏忕被鎺掑悕  cells[7]=Buybox浠锋牸
// cells[8]=涓婃灦鏃堕棿  cells[9]=鎬籖ating鏁? cells[10]=鍝佺墝  cells[11]=BuyBox鍗栧
// cells[12]=鍙樹綋鏁? cells[13]=鍗栧鏁? cells[14]=FBA&姣涘埄鐜? cells[15]=閲嶉噺/浣撶Н
function runNodeScript(args, label) {
  console.log(`\n鈻?${label}`);
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
  const mergedDirs = outputDirs(keywords.join('-'));
  const dataFiles = keywords.map(kw => {
    const file = path.join(mergedDirs.data, `${safeSegment(kw)}-data.json`);
    const childArgs = [path.join(__dirname, 'extract-data.js'), kw, String(maxBsr), file];
    if (timeFilterRaw) childArgs.push('--time-filter', timeFilterRaw);
    runNodeScript(childArgs, `extract ${kw}`);
    return file;
  });
  runNodeScript([path.join(__dirname, 'merge-data.js'), ...dataFiles, outFile], 'merge keyword data');
  console.log(`\nMerged multi-keyword data saved: ${outFile}`);
  process.exit(0);
}

const extractPageData = (page) => page.evaluate(() => {
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
        sales: (cells[2]?.innerText || '').trim().split('\n')[0],
        revenue: (cells[3]?.innerText || '').trim().split('\n')[0],
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
  const totalText = document.body.innerText.match(/(?:共|total)\s*(\d+)\s*(?:条|items|results)?/i);
  const total = totalText ? parseInt(totalText[1]) : 0;
  const pagerBtns = document.querySelectorAll('.el-pager .number');
  const lastPage = pagerBtns.length > 0 ? parseInt(pagerBtns[pagerBtns.length - 1].innerText) : 1;
  return { data, total, lastPage };
});

// 鎵ц鍗曚釜鍏抽敭璇嶇殑鎼滅储+鎻愬彇
async function extractKeyword(page, keyword) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Keyword: ${keyword}`);
  console.log('='.repeat(50));

  // 0. 姣忔閲嶆柊鍔犺浇椤甸潰锛岀‘淇濆共鍑€鐘舵€?
  await gotoOalurFilter(page, `keyword ${keyword}`);
  await new Promise(r => setTimeout(r, 3000));

  // 1. 娓呯┖鏃ц緭鍏ュ苟杈撳叆鏂板叧閿瘝
  await page.evaluate((kw) => {
    const input = document.querySelector('input[placeholder*="支持ASIN"], input[placeholder*="ASIN"]');
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

  // 2. 璁剧疆 BSR
  await page.evaluate((max) => {
    const labels = document.querySelectorAll('.el-form-item__label, label, span');
    for (const label of labels) {
      if (label.innerText?.includes('大类BSR排名') || label.innerText?.includes('大类BSR')) {
        const parent = label.closest('.el-form-item') || label.parentElement?.parentElement;
        if (!parent) continue;
        const inputs = parent.querySelectorAll('input[type="number"]');
        if (inputs.length >= 2) {
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          s.call(inputs[0], '1');
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
          inputs[0].dispatchEvent(new Event('blur', { bubbles: true }));
          s.call(inputs[1], String(max));
          inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
          inputs[1].dispatchEvent(new Event('blur', { bubbles: true }));
        }
        break;
      }
    }
  }, maxBsr);
  await new Promise(r => setTimeout(r, 500));

  // 3. 璁剧疆鏃堕棿绛涢€夛紙鏄惧紡鎸囧畾锛氬綋鍓?杩?0澶╋紝鍘嗗彶=鎸囧畾鏈堜唤锛?
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

  // 4. 鐐瑰嚮纭鏌ヨ
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.innerText.trim() === '确认查询') { btn.click(); break; }
    }
  });
  await new Promise(r => setTimeout(r, 5000));

  await ensureVariantSkuEnabled(page);
  // 绛夊緟琛ㄦ牸鍒锋柊锛堢‘淇?ASIN 鍙彁鍙栵級
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const hasAsin = await page.evaluate(() => {
      const row = document.querySelector('.el-table__body-wrapper table tbody tr:first-child');
      return row && /ASIN:\s*[A-Z0-9]{10}/.test(row.innerText);
    });
    if (hasAsin) { console.log('鉁?宸叉煡璇紙鏌ョ湅鍏朵粬鍙樹綋锛氬紑鍚紝鍒嗘瀽鎸夌埗浣撹仛鍚堬級'); break; }
  }

  // 4. 鎻愬彇绗?椤?
  if (!(await isVariantSkuChecked(page))) throw new Error('第一页抓取前“查看其他变体”不是勾选状态，停止执行');
  let result = await extractPageData(page);
  let allData = result.data;
  console.log(`First page: ${allData.length} rows, total: ${result.total}, pages: ${result.lastPage}`);

  // 5. 鍒嗛〉锛堟瘮杈冩暣椤?ASIN 闆嗗悎锛?
  if (result.lastPage > 1) {
    const actualLastPage = Math.min(result.lastPage, MAX_PAGES);
    console.log(`  鏈€澶х炕椤? ${actualLastPage} 椤碉紙涓婇檺 ${actualLastPage * 20} 鏉★級`);
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
      let pageData = [];
      let changed = false;
      for (let wait = 0; wait < 10; wait++) {
        await new Promise(r => setTimeout(r, 1000));
        const check = await extractPageData(page);
        if (check.data.length === 0) continue;
        const hasNewAsins = check.data.some(d => d.asin && !prevPageAsins.has(d.asin));
        if (hasNewAsins) {
          pageData = check.data;
          changed = true;
          break;
        }
      }
      if (!changed) { console.log(`  page ${p}: unchanged, skipped`); continue; }
      pageData.forEach(d => prevPageAsins.add(d.asin));
      allData = allData.concat(pageData);
      console.log(`  page ${p}: ${pageData.length} rows, accumulated: ${allData.length}`);
    }
  }

  // 鏍囪鏉ユ簮鍏抽敭璇?
  allData.forEach(d => { d.sourceKeyword = keyword; });
  console.log(`"${keyword}" extracted: ${allData.length} rows`);
  return allData;
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('oalur.com/insight/filter'));
  if (!page) {
    page = await browser.newPage();
    await gotoOalurFilter(page, 'initial page');
  }
  console.log('鉁?宸茶繛鎺?Edge');

  // 閫愪釜鍏抽敭璇嶆姄鍙?
  let allRawData = [];
  const keywordStats = {};
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    // 姣忎釜鍏抽敭璇嶉噸鏂板姞杞介〉闈紝纭繚鎼滅储鐙珛
    if (i > 0) {
      console.log('\nReloading page for next keyword...');
      await gotoOalurFilter(page, `keyword ${kw}`);
      await new Promise(r => setTimeout(r, 3000));
    }
    const kwData = await extractKeyword(page, kw);
    keywordStats[kw] = kwData.length;
    allRawData = allRawData.concat(kwData);
  }

  console.log(`\n${'='.repeat(50)}`);
  // ASIN 鍘婚噸
  const seenAsin = new Set();
  allRawData = allRawData.filter(item => {
    if (!item.asin || seenAsin.has(item.asin)) return false;
    seenAsin.add(item.asin);
    return true;
  });
  console.log(`ASIN deduplicated: ${allRawData.length} rows`);

  const categorySelectionSource = allRawData;
  const categorySelectionResult = selectTargetCategories(categorySelectionSource, keywords);
  const targetCategory = categorySelectionResult.targetCategory;
  const targetCategories = categorySelectionResult.targetCategories;
  const targetCategorySet = new Set(targetCategories);
  const equivalentCategorySet = new Set(
    categorySelectionResult.categorySelection
      .filter(d => d.functionalEquivalent)
      .map(d => d.category)
  );

  const beforeParentAggregate = allRawData.length;
  allRawData = aggregateParentListings(allRawData).map(item => applyTargetCategoryMatch(item, targetCategorySet));
  console.log(`Parent listing aggregation: ${beforeParentAggregate} ASIN/variants -> ${allRawData.length} parent listings`);

  const catCount = {};
  categorySelectionSource.forEach(d => {
    const cat = d.category || '未识别';
    catCount[cat] = (catCount[cat] || 0) + 1;
  });
  const sortedCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]);
  console.log('\nCategory distribution (ASIN/variant rows):');
  sortedCats.forEach(([cat, count]) => console.log(`  [${count}] ${cat}`));

  const listingMatchesFilter = (item) => {
    if (listingMatchesTargetCategories(item, targetCategorySet)) return true;
    const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);
    const equivalentCategoryHit = categories.some(category => equivalentCategorySet.has(category));
    if (!equivalentCategoryHit) return false;
    const rescued = listingMatchesKeywordIntent(item, keywords);
    if (rescued) {
      const rescuedRows = (Array.isArray(item.variantRows) ? item.variantRows : [])
        .filter(row => equivalentCategorySet.has(row.category) && keywords.some(keyword => titleMatchesKeywordIntent(row.title || item.title, keyword)));
      item.targetMatchedCategories = [...new Set([...(item.targetMatchedCategories || []), ...rescuedRows.map(row => row.category).filter(Boolean)])];
      item.targetMatchedChildAsins = [...new Set(rescuedRows.map(row => row.asin).filter(Boolean))];
      item.keywordIntentRescued = true;
    }
    return rescued;
  };
  const filtered = allRawData.filter(d => listingMatchesFilter(d));
  const excluded = allRawData.filter(d => !listingMatchesFilter(d));
  console.log(`\nTarget categories: ${targetCategories.join(' | ')}`);
  console.log(`Filtered: ${allRawData.length} -> ${filtered.length}, excluded ${excluded.length}`);

  // 淇濆瓨
  const output = {
    keywords: keywords,
    keyword: keywords.join(' + '),
    bsrRange: '1-' + maxBsr,
    timeFilter: timeFilterLabel || '近30天',
    rawTotal: allRawData.length,
    total: allRawData.length,
    allCount: allRawData.length,
    filteredCount: filtered.length,
    excludedCount: excluded.length,
    targetCategory,
    targetCategories,
    equivalentCandidateCategories: [...equivalentCategorySet],
    categorySelection: categorySelectionResult.categorySelection,
    categoryDistribution: sortedCats,
    keywordStats,
    data: filtered,
    excluded
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nData saved: ${outFile}`);

  // 鎽樿
  console.log(`\n${'='.repeat(50)}`);
  console.log('Extraction summary');
  console.log('='.repeat(50));
  keywords.forEach(kw => console.log(`  "${kw}": ${keywordStats[kw]} rows`));
  console.log(`  after merge/dedupe: ${allRawData.length} rows`);
  console.log(`  after target filtering: ${filtered.length} rows`);

  await browser.disconnect();
})().catch(err => { console.error('Error:', err.message); process.exit(1); });
