const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

// 最大翻页数限制（防止无限循环）
const MAX_PAGES = 10;

// 品类底线表（从 SKILL.md 同步维护）
const CATEGORY_BSR_TABLE = [
  { keywords: ['makeup', 'brush', 'eyelash', 'cosmetic', 'beauty'], bsr: 10000, name: '美妆工具' },
  { keywords: ['cook', 'cookie', 'baking', 'kitchen', 'spatula', 'biscuit', 'cutter', 'gadget', 'utensil'], bsr: 10000, name: '厨房家居' },
  { keywords: ['pet', 'dog', 'cat', 'leash', 'toy', 'bed', 'scratch'], bsr: 25000, name: '宠物用品' },
  { keywords: ['shoe', 'shirt', 'pant', 'yoga', 'running', 'clothing', 'sweater'], bsr: 30000, name: '鞋服' },
  { keywords: ['screwdriver', 'drill', 'tape', 'tool', 'home', 'hardware'], bsr: 15000, name: '工具家装' },
  { keywords: ['hair', 'clipper', 'toothbrush', 'shaver', 'trimmer'], bsr: 10000, name: '个人护理' },
  { keywords: ['phone', 'case', 'earbud', 'charger', 'cable', 'electronic'], bsr: 0, name: '消费电子' }, // 0 = 需具体分析
  { keywords: ['pen', 'desk', 'organizer', 'office', 'stationery'], bsr: 15000, name: '办公用品' },
  { keywords: ['resistance', 'yoga', 'mat', 'sport', 'exercise', 'gym'], bsr: 20000, name: '运动户外' },
  { keywords: ['baby', 'bottle', 'pacifier', 'nursery', 'infant'], bsr: 15000, name: '母婴用品' },
  { keywords: ['block', 'puzzle', 'toy', 'game', 'LEGO'], bsr: 20000, name: '玩具' },
  { keywords: ['car', 'phone', 'mount', 'cover', 'automotive'], bsr: 15000, name: '汽车配件' },
  { keywords: ['garden', 'plant', 'pot', 'outdoor', 'lawn'], bsr: 15000, name: '园艺' },
];

// 从关键词自动匹配品类底线 BSR
function autoDetectBsr(keyword) {
  const kw = keyword.toLowerCase();
  for (const cat of CATEGORY_BSR_TABLE) {
    if (cat.keywords.some(k => kw.includes(k))) {
      if (cat.bsr === 0) return null; // 需具体分析
      return cat.bsr;
    }
  }
  return 10000; // 默认
}

// 参数：关键词1,关键词2,... [BSR上限] [输出文件名] [--time-filter YYYY-MM]
// BSR上限为可选参数，不传时自动从关键词匹配品类底线
// 示例: node extract-data.js "Cookie Cutter" 10000 merged-data.json
// 示例: node extract-data.js "Cookie Cutter"（自动匹配 BSR）
// 示例: node extract-data.js "Cookie Cutter" 10000 data.json --time-filter 2025-12
const keywordsRaw = process.argv[2];
const userBsr = process.argv[3];
const defaultOutFile = keywordsRaw ? keywordsRaw.split(',')[0].trim().replace(/\s+/g, '-') + '-data.json' : '';
const dirs = outputDirs(keywordsRaw ? keywordsRaw.split(',')[0].trim() : 'output');
const explicitOutFile = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : null;
let outFile = explicitOutFile || path.join(dirs.data, defaultOutFile);

// 时间筛选器（可选，用于历史数据回溯）
const timeFilterIdx = process.argv.indexOf('--time-filter');
const timeFilterRaw = timeFilterIdx > -1 ? process.argv[timeFilterIdx + 1] : null;
let timeFilterLabel = null; // 如 "2025年12月"
if (timeFilterRaw) {
  const [y, m] = timeFilterRaw.split('-');
  if (y && m) {
    timeFilterLabel = `${y}年${parseInt(m)}月`;
    console.log(`⏰ 时间筛选: ${timeFilterLabel}`);
  }
}

if (!keywordsRaw) {
  console.error('用法: node extract-data.js "关键词1,关键词2,..." [BSR上限] [输出文件.json]');
  console.error('示例: node extract-data.js "Cookie Cutter" 10000');
  console.error('示例: node extract-data.js "Cookie Cutter"（自动匹配 BSR）');
  process.exit(1);
}

const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);
if (keywords.length > 1 && !explicitOutFile) {
  outFile = path.join(outputDirs(keywords.join('-')).data, 'merged-data.json');
}

// BSR 值选择逻辑：用户指定 > 自动匹配 > 默认10000
let maxBsr;
const firstKw = keywords[0];
if (userBsr) {
  maxBsr = userBsr;
  console.log(`📋 关键词列表: ${keywords.join(' | ')}`);
  console.log(`📋 BSR上限: ${maxBsr}（用户指定）`);
} else {
  const detected = autoDetectBsr(firstKw);
  if (detected === null) {
    maxBsr = '10000';
    console.log(`⚠️ 品类"消费电子"需具体分析 BSR 底线，暂用默认 10000，请确认或指定 BSR 值`);
  } else {
    maxBsr = String(detected);
    console.log(`📋 关键词列表: ${keywords.join(' | ')}`);
    console.log(`📋 BSR上限: ${maxBsr}（自动匹配品类底线）`);
  }
}

// 提取函数（含类目路径提取）
// Oalur 表头列映射：
// cells[0]=勾选  cells[1]=产品信息  cells[2]=预估销量  cells[3]=预估销售额
// cells[4]=子体销量&子体销售额  cells[5]=大类排名  cells[6]=小类排名  cells[7]=Buybox价格
// cells[8]=上架时间  cells[9]=总Rating数  cells[10]=品牌  cells[11]=BuyBox卖家
// cells[12]=变体数  cells[13]=卖家数  cells[14]=FBA&毛利率  cells[15]=重量/体积
function runNodeScript(args, label) {
  console.log(`\n▶ ${label}`);
  console.log(`node ${args.map(a => /\s/.test(String(a)) ? `"${a}"` : a).join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(`❌ ${label} 启动失败: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`❌ ${label} 失败，退出码: ${result.status}`);
    process.exit(result.status || 1);
  }
}

if (keywords.length > 1) {
  console.log(`\n📦 多关键词默认使用独立抓取 + 离线合并: ${keywords.join(' | ')}`);
  const mergedDirs = outputDirs(keywords.join('-'));
  const dataFiles = keywords.map(kw => {
    const file = path.join(mergedDirs.data, `${safeSegment(kw)}-data.json`);
    const childArgs = [path.join(__dirname, 'extract-data.js'), kw, String(maxBsr), file];
    if (timeFilterRaw) childArgs.push('--time-filter', timeFilterRaw);
    runNodeScript(childArgs, `独立抓取 ${kw}`);
    return file;
  });
  runNodeScript([path.join(__dirname, 'merge-data.js'), ...dataFiles, outFile], '合并关键词数据');
  console.log(`\n✅ 多关键词合并数据库已生成: ${outFile}`);
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
      const ageMatch = (cells[8]?.innerText || '').match(/(\d+年\d+月\d+天)/);
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
  const totalText = document.body.innerText.match(/共\s*(\d+)\s*条数据/);
  const total = totalText ? parseInt(totalText[1]) : 0;
  const pagerBtns = document.querySelectorAll('.el-pager .number');
  const lastPage = pagerBtns.length > 0 ? parseInt(pagerBtns[pagerBtns.length - 1].innerText) : 1;
  return { data, total, lastPage };
});

// 执行单个关键词的搜索+提取
async function extractKeyword(page, keyword) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🔍 关键词: ${keyword}`);
  console.log('='.repeat(50));

  // 0. 每次重新加载页面，确保干净状态
  await gotoOalurFilter(page, `keyword ${keyword}`);
  await new Promise(r => setTimeout(r, 3000));

  // 1. 清空旧输入并输入新关键词
  await page.evaluate((kw) => {
    const input = document.querySelector('input[placeholder*="支持ASIN"]');
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

  // 2. 设置 BSR
  await page.evaluate((max) => {
    const labels = document.querySelectorAll('.el-form-item__label, label, span');
    for (const label of labels) {
      if (label.innerText?.includes('大类BSR排名')) {
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

  // 3. 设置时间筛选（显式指定：当前=近30天，历史=指定月份）
  const timeToClick = timeFilterLabel || '近30天';
  console.log(`⏰ 时间筛选: ${timeToClick}`);
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

  // 4. 点击确认查询
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.innerText.trim() === '确认查询') { btn.click(); break; }
    }
  });
  await new Promise(r => setTimeout(r, 5000));

  // 5. "查看其他变体"默认关闭
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.innerText.trim() === '确认查询') { btn.click(); break; }
    }
  });
  await new Promise(r => setTimeout(r, 5000));

  // 5. "查看其他变体"默认关闭
  await page.evaluate(() => {
    const cb = document.querySelector('.var-sku .el-checkbox');
    if (cb && cb.classList.contains('is-checked')) cb.click();
  });
  // 等待表格刷新（确保 ASIN 可提取）
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const hasAsin = await page.evaluate(() => {
      const row = document.querySelector('.el-table__body-wrapper table tbody tr:first-child');
      return row && /ASIN:\s*[A-Z0-9]{10}/.test(row.innerText);
    });
    if (hasAsin) { console.log('✅ 已查询（查看其他变体：关闭）'); break; }
  }

  // 4. 提取第1页
  let result = await extractPageData(page);
  let allData = result.data;
  console.log(`✅ 第1页: ${allData.length} 条, 总计: ${result.total} 条, 共 ${result.lastPage} 页`);

  // 5. 分页（比较整页 ASIN 集合）
  if (result.lastPage > 1) {
    const actualLastPage = Math.min(result.lastPage, MAX_PAGES);
    console.log(`  最大翻页: ${actualLastPage} 页（上限 ${actualLastPage * 20} 条）`);
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
      if (!changed) { console.log(`  第${p}页: 内容未变化，跳过`); continue; }
      pageData.forEach(d => prevPageAsins.add(d.asin));
      allData = allData.concat(pageData);
      console.log(`  第${p}页: ${pageData.length} 条, 累计: ${allData.length} 条`);
    }
  }

  // 标记来源关键词
  allData.forEach(d => { d.sourceKeyword = keyword; });
  console.log(`✅ "${keyword}" 提取完成: ${allData.length} 条`);
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
  console.log('✅ 已连接 Edge');

  // 逐个关键词抓取
  let allRawData = [];
  const keywordStats = {};
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    // 每个关键词重新加载页面，确保搜索独立
    if (i > 0) {
      console.log(`\n🔄 加载新页面...`);
      await gotoOalurFilter(page, `keyword ${kw}`);
      await new Promise(r => setTimeout(r, 3000));
    }
    const kwData = await extractKeyword(page, kw);
    keywordStats[kw] = kwData.length;
    allRawData = allRawData.concat(kwData);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log('📊 合并去重');
  console.log('='.repeat(50));
  console.log(`合并前总计: ${allRawData.length} 条`);

  // ASIN 去重
  const seenAsin = new Set();
  allRawData = allRawData.filter(item => {
    if (!item.asin || seenAsin.has(item.asin)) return false;
    seenAsin.add(item.asin);
    return true;
  });
  console.log(`ASIN 去重后: ${allRawData.length} 条`);

  // PASIN 去重：同一父体只保留 BSR 最小的那条
  const pasinMap = new Map();
  allRawData.forEach(item => {
    const key = item.pasin || item.asin;
    if (!pasinMap.has(key) || item.bsr < pasinMap.get(key).bsr) {
      pasinMap.set(key, item);
    }
  });
  const deduplicated = Array.from(pasinMap.values());
  const removedByPasin = allRawData.length - deduplicated.length;
  allRawData = deduplicated;
  if (removedByPasin > 0) console.log(`PASIN 去重: 移除 ${removedByPasin} 条变体重复，剩余 ${allRawData.length} 条`);
  console.log(`最终去重: ${allRawData.length} 条`);

  // 类目过滤（取最常见的类目）
  const catCount = {};
  allRawData.forEach(d => {
    const cat = d.category || '未识别';
    catCount[cat] = (catCount[cat] || 0) + 1;
  });
  const sortedCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]);
  console.log('\n📊 类目分布:');
  sortedCats.forEach(([cat, count]) => console.log(`  [${count}] ${cat}`));

  const topCat = sortedCats.find(([cat]) => cat !== '未识别');
  const targetCategory = topCat ? topCat[0] : '';
  const filtered = allRawData.filter(d => d.category === targetCategory);
  const excluded = allRawData.filter(d => d.category !== targetCategory);
  console.log(`\n🎯 目标类目: ${targetCategory}`);
  console.log(`✅ 过滤: ${allRawData.length} → ${filtered.length} 条, 排除 ${excluded.length} 条`);

  // 保存
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
    categoryDistribution: sortedCats,
    keywordStats,
    data: filtered,
    excluded
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\n✅ 数据已保存: ${outFile}`);

  // 摘要
  console.log(`\n${'='.repeat(50)}`);
  console.log('📋 抓取摘要');
  console.log('='.repeat(50));
  keywords.forEach(kw => console.log(`  "${kw}": ${keywordStats[kw]} 条`));
  console.log(`  合并去重后: ${allRawData.length} 条`);
  console.log(`  目标类目过滤后: ${filtered.length} 条`);

  await browser.disconnect();
})().catch(err => { console.error('Error:', err.message); process.exit(1); });
