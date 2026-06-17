const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const [, , lifecyclePath, marketDataPath, outputPathArg] = process.argv;
const CPC_SAMPLE_LIMIT = 30;
const CPC_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.OALUR_CPC_CONCURRENCY || 4)));

if (!lifecyclePath || !marketDataPath) {
  console.error('Usage: node extract-cpc-opportunity.js <asin-lifecycle.json> <market-data.json> [output.json]');
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parsePrice(value) {
  if (typeof value === 'number') return value;
  const n = parseFloat(String(value || '').replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function median(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  const idx = (sortedNums.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedNums[lo];
  return sortedNums[lo] + (sortedNums[hi] - sortedNums[lo]) * (idx - lo);
}

function classifyCpcRatio(ratioPct) {
  if (ratioPct == null || !Number.isFinite(ratioPct)) return { grade: '未分析', conclusion: 'CPC 或客单价缺失' };
  if (ratioPct < 5) return { grade: '健康', conclusion: 'CPC/客单价低于 5%，广告点击成本相对客单价压力较低' };
  if (ratioPct < 8) return { grade: '可接受', conclusion: 'CPC/客单价处于 5%-8%，广告成本可接受，但仍需利润空间承接' };
  if (ratioPct < 12) return { grade: '偏高', conclusion: 'CPC/客单价处于 8%-12%，需要强利润或强转化支撑' };
  if (ratioPct < 15) return { grade: '高风险', conclusion: 'CPC/客单价处于 12%-15%，新品冷启动广告压力高' };
  return { grade: '很高风险', conclusion: 'CPC/客单价达到 15% 以上，广告成本风险很高' };
}

function findLocalProduct(marketData, asin) {
  const all = [...(marketData.data || []), ...(marketData.excluded || [])];
  const parent = all.find(item =>
    item.asin === asin
    || (Array.isArray(item.childAsins) && item.childAsins.includes(asin))
    || (Array.isArray(item.variantRows) && item.variantRows.some(row => row.asin === asin))
  );
  if (!parent) return null;
  const child = Array.isArray(parent.variantRows) ? parent.variantRows.find(row => row.asin === asin) : null;
  return child || parent;
}

function selectAcosSample(marketData, fallbackAsins) {
  const filteredParents = Array.isArray(marketData.data) ? marketData.data : [];
  const candidates = filteredParents
    .map(item => ({
      asin: item.asin,
      title: item.title || '',
      sales: parseNumber(item.salesNumAggregated || item.sales),
      price: parsePrice(item.price),
      ratings: parseNumber(item.ratingsNumAggregated || item.ratings),
      category: item.category || ''
    }))
    .filter(item => item.asin && item.sales > 0 && item.price != null && item.price > 0);

  const ratingUsable = candidates.filter(item => item.ratings > 0);
  const priceValues = ratingUsable.map(item => item.price).sort((a, b) => a - b);
  const q1 = percentile(priceValues, 0.25);
  const q3 = percentile(priceValues, 0.75);
  const iqr = q1 != null && q3 != null ? q3 - q1 : 0;
  const lowerPrice = q1 == null ? 0 : Math.max(3, q1 - (1.5 * iqr));
  const upperPrice = q3 == null ? Number.POSITIVE_INFINITY : q3 + (1.5 * iqr || q3);
  let valid = ratingUsable.filter(item => item.price >= lowerPrice && item.price <= upperPrice);

  if (valid.length < Math.min(10, ratingUsable.length)) {
    valid = ratingUsable;
  }

  const sample = valid
    .sort((a, b) => b.sales - a.sales)
    .slice(0, CPC_SAMPLE_LIMIT);

  if (sample.length) {
    return {
      asins: sample.map(item => item.asin),
      source: 'filtered-parent-sales-top',
      selection: {
        source: 'filtered parent listings',
        limit: CPC_SAMPLE_LIMIT,
        filteredParentCount: filteredParents.length,
        candidateCount: candidates.length,
        ratingUsableCount: ratingUsable.length,
        priceFilteredCount: valid.length,
        sampleCount: sample.length,
        priceFilter: {
          q1: q1 == null ? null : Number(q1.toFixed(2)),
          q3: q3 == null ? null : Number(q3.toFixed(2)),
          lower: Number(lowerPrice.toFixed(2)),
          upper: Number(upperPrice.toFixed(2))
        },
        rules: [
          'use filtered parent listings only',
          'exclude missing/zero price',
          'exclude missing/zero Ratings',
          'exclude price outliers by IQR',
          'sort by parent monthly sales descending',
          `take top ${CPC_SAMPLE_LIMIT}`
        ]
      }
    };
  }

  return {
    asins: fallbackAsins,
    source: 'lifecycle-fallback',
    selection: {
      source: 'lifecycle ASIN fallback',
      limit: fallbackAsins.length,
      filteredParentCount: filteredParents.length,
      candidateCount: candidates.length,
      ratingUsableCount: ratingUsable.length,
      priceFilteredCount: valid.length,
      sampleCount: fallbackAsins.length,
      rules: ['market data sample unavailable; fallback to lifecycle ASIN list']
    }
  };
}

async function fetchJson(page, url, options = {}) {
  return await page.evaluate(async ({ url, options }) => {
    const res = await fetch(url, {
      credentials: 'include',
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {})
      }
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }, { url, options });
}

async function getAcosData(page, asin) {
  const productUrl = `/gw/search/api/ad/acos/product?asin=${encodeURIComponent(asin)}&site=US&platform=AMAZON`;
  const productRes = await fetchJson(page, productUrl);
  const product = productRes.json && productRes.json.data ? productRes.json.data : null;
  if (!product) {
    return {
      asin,
      error: `产品信息接口失败: HTTP ${productRes.status}`,
      productResponse: productRes.json
    };
  }

  const pathId = product.lastCategory?.pathId || product.topCategory?.pathId;
  let cal = null;
  if (pathId) {
    const calRes = await fetchJson(page, '/gw/search/api/ad/acos/cal?site=US&platform=AMAZON', {
      method: 'POST',
      body: JSON.stringify({ pathIds: [pathId], asin })
    });
    cal = calRes.json && calRes.json.data ? calRes.json.data : null;
  }

  return {
    asin,
    price: parsePrice(product.price),
    avgCpc: product.avgCpc != null ? product.avgCpc : (cal ? cal.avgCpc : null),
    category: product.lastCategory?.fullPath || product.topCategory?.fullPath || '',
    categoryPathId: pathId || '',
    priceConversionRates: cal?.priceConversionRates || null
  };
}

async function getAcosDataInNewPage(browser, asin) {
  const page = await browser.newPage();
  try {
    page.setDefaultNavigationTimeout(30000);
    await page.goto('https://vip.oalur.com/tool/acos?site=US', { waitUntil: 'domcontentloaded', timeout: 30000 });
    return await getAcosData(page, asin);
  } finally {
    await page.close().catch(() => {});
  }
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const lifecycle = readJson(lifecyclePath);
  const marketData = readJson(marketDataPath);
  const fallbackAsins = lifecycle.asins || (lifecycle.products || []).map(item => item.asin).filter(Boolean);
  const sample = selectAcosSample(marketData, fallbackAsins);
  const asins = [...new Set(sample.asins || [])];
  if (!asins.length) {
    throw new Error('未找到可用于 CPC 分析的 ASIN 样本');
  }

  const outputPath = outputPathArg || path.join(path.dirname(lifecyclePath), 'cpc-opportunity.json');

  console.log(`CPC sample source: ${sample.source}, ASIN count: ${asins.length}`);
  console.log(`CPC concurrency: ${CPC_CONCURRENCY} pages`);
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const products = await runPool(asins, CPC_CONCURRENCY, async (asin) => {
    const local = findLocalProduct(marketData, asin);
    const remote = await getAcosDataInNewPage(browser, asin);
    const price = remote.price || parsePrice(local?.price);
    const avgCpc = remote.avgCpc;
    const ratioPct = price && avgCpc != null ? (avgCpc / price) * 100 : null;
    const classification = classifyCpcRatio(ratioPct);
    const product = {
      asin,
      title: local?.title || '',
      price,
      avgCpc,
      cpcPriceRatioPct: ratioPct == null ? null : Number(ratioPct.toFixed(2)),
      grade: classification.grade,
      conclusion: classification.conclusion,
      category: remote.category || local?.category || '',
      categoryPathId: remote.categoryPathId || '',
      source: 'Oalur ACOS tool'
    };
    console.log(`${asin}: price=${price ?? '-'} cpc=${avgCpc ?? '-'} ratio=${ratioPct == null ? '-' : ratioPct.toFixed(2) + '%'} ${classification.grade}`);
    return product;
  });
  await browser.disconnect();

  const ratios = products.map(item => item.cpcPriceRatioPct).filter(v => typeof v === 'number');
  const avgRatio = ratios.length ? ratios.reduce((s, v) => s + v, 0) / ratios.length : null;
  const medianRatio = median(ratios);
  const avgCpcValues = products.map(item => item.avgCpc).filter(v => typeof v === 'number');
  const avgCpc = avgCpcValues.length ? avgCpcValues.reduce((s, v) => s + v, 0) / avgCpcValues.length : null;
  const medianCpc = median(avgCpcValues);
  const summaryClass = classifyCpcRatio(medianRatio);

  const result = {
    keyword: marketData.keyword || '',
    analyzedAt: new Date().toISOString(),
    sampleSource: sample.source,
    sampleSelection: sample.selection,
    criteria: {
      metric: 'CPC/客单价比值（中位数）',
      formula: 'avgCpc / price * 100%',
      levels: [
        { range: '<5%', grade: '健康' },
        { range: '5%-8%', grade: '可接受' },
        { range: '8%-12%', grade: '偏高' },
        { range: '12%-15%', grade: '高风险' },
        { range: '>=15%', grade: '很高风险' }
      ],
      source: 'knowledge/amazon-opportunity-index-criteria.md'
    },
    summary: {
      asinCount: products.length,
      avgCpc: avgCpc == null ? null : Number(avgCpc.toFixed(2)),
      avgCpcPriceRatioPct: avgRatio == null ? null : Number(avgRatio.toFixed(2)),
      medianCpc: medianCpc == null ? null : Number(medianCpc.toFixed(2)),
      medianCpcPriceRatioPct: medianRatio == null ? null : Number(medianRatio.toFixed(2)),
      grade: summaryClass.grade,
      conclusion: summaryClass.conclusion
    },
    products
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Saved: ${outputPath}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
