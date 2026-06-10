const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const [, , lifecyclePath, marketDataPath, outputPathArg] = process.argv;

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

function classifyCpcRatio(ratioPct) {
  if (ratioPct == null || !Number.isFinite(ratioPct)) return { grade: '未分析', conclusion: 'CPC 或客单价缺失' };
  if (ratioPct < 5) return { grade: '极佳', conclusion: '广告成本极低，低转化率下仍有利润空间' };
  if (ratioPct < 10) return { grade: '良好', conclusion: '广告成本合理，属于健康盈利区间' };
  if (ratioPct < 15) return { grade: '一般', conclusion: '广告成本偏高，需要优化 Listing 和广告结构' };
  return { grade: '很差', conclusion: '广告成本过高，广告盈利难度大' };
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

async function main() {
  const lifecycle = readJson(lifecyclePath);
  const marketData = readJson(marketDataPath);
  const asins = lifecycle.asins || (lifecycle.products || []).map(item => item.asin).filter(Boolean);
  if (!asins.length) {
    throw new Error('未在生命周期数据中找到 ASIN 列表');
  }

  const outputPath = outputPathArg || path.join(path.dirname(lifecyclePath), 'cpc-opportunity.json');

  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(30000);
  await page.goto('https://vip.oalur.com/tool/acos?site=US', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 2500));

  const products = [];
  for (const asin of asins) {
    const local = findLocalProduct(marketData, asin);
    const remote = await getAcosData(page, asin);
    const price = remote.price || parsePrice(local?.price);
    const avgCpc = remote.avgCpc;
    const ratioPct = price && avgCpc != null ? (avgCpc / price) * 100 : null;
    const classification = classifyCpcRatio(ratioPct);
    products.push({
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
    });
    console.log(`${asin}: price=${price ?? '-'} cpc=${avgCpc ?? '-'} ratio=${ratioPct == null ? '-' : ratioPct.toFixed(2) + '%'} ${classification.grade}`);
  }

  await page.close();
  await browser.disconnect();

  const ratios = products.map(item => item.cpcPriceRatioPct).filter(v => typeof v === 'number');
  const avgRatio = ratios.length ? ratios.reduce((s, v) => s + v, 0) / ratios.length : null;
  const avgCpcValues = products.map(item => item.avgCpc).filter(v => typeof v === 'number');
  const avgCpc = avgCpcValues.length ? avgCpcValues.reduce((s, v) => s + v, 0) / avgCpcValues.length : null;
  const summaryClass = classifyCpcRatio(avgRatio);

  const result = {
    keyword: marketData.keyword || '',
    analyzedAt: new Date().toISOString(),
    criteria: {
      metric: 'CPC/客单价比值',
      formula: 'avgCpc / price * 100%',
      levels: [
        { range: '<5%', grade: '极佳' },
        { range: '5%-10%', grade: '良好' },
        { range: '10%-15%', grade: '一般' },
        { range: '>15%', grade: '很差' }
      ],
      source: 'knowledge/amazon-opportunity-index-criteria.md'
    },
    summary: {
      asinCount: products.length,
      avgCpc: avgCpc == null ? null : Number(avgCpc.toFixed(2)),
      avgCpcPriceRatioPct: avgRatio == null ? null : Number(avgRatio.toFixed(2)),
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
