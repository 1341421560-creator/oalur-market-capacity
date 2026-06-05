const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const asinArg = process.argv[2] || 'B091FBB2KW';
const asins = asinArg.split(',').map(s => s.trim()).filter(Boolean);

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
  const preferredKeys = ['kitchen'];
  const key = preferredKeys.find(k => Array.isArray(history[k])) ||
    Object.keys(history).find(k => k !== 'dates' && Array.isArray(history[k]) && history[k].every(v => typeof v === 'number' || v === null));
  return pairSeries(dates, key ? history[key] : [], 'mainBsr');
}

async function openTrendDialog(page, asin) {
  await page.goto('https://vip.oalur.com/insight/product/search?site=US', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
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

async function collectForAsin(browser, asin, index, total) {
  const page = await browser.newPage();
  const state = { asin, basicInfo: null, salesTrend: null, keepaTrend: null, bsrTrend: null };

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

  console.log(`[${index + 1}/${total}] ${asin} open`);
  try {
    await openTrendDialog(page, asin);
    for (let i = 0; i < 20; i++) {
      if (state.keepaTrend && state.bsrTrend && state.salesTrend) break;
      await sleep(1000);
    }

    const dates = state.keepaTrend?.dates || [];
    const priceData = pairSeries(dates, state.keepaTrend?.price || [], 'buyboxPrice');
    const ratingsData = pairSeries(dates, state.keepaTrend?.ratingNum || [], 'ratingsNum');
    const bsrData = extractMainBsr(state.bsrTrend);
    const salesMonths = state.salesTrend?.dates || [];
    const monthlySales = state.salesTrend?.saleVolume || state.salesTrend?.salesNumber || [];

    return {
      asin,
      title: state.basicInfo?.title || state.basicInfo?.name || '',
      brand: state.basicInfo?.brand || '',
      totalMonths: salesMonths.length,
      trendData: salesMonths.length ? {
        months: salesMonths,
        monthlySales,
        monthlyRevenue: state.salesTrend?.salesNumber || []
      } : null,
      directTrendData: { priceData, ratingsData, bsrData },
      counts: {
        price: priceData.length,
        ratings: ratingsData.length,
        mainBsr: bsrData.length,
        salesMonths: salesMonths.length
      }
    };
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const results = await Promise.all(asins.map((asin, i) => collectForAsin(browser, asin, i, asins.length)));
  await browser.disconnect();
  console.log(JSON.stringify({
    extractedAt: new Date().toISOString(),
    asins,
    products: results.map(product => ({
      asin: product.asin,
      brand: product.brand,
      counts: product.counts,
      firstPrice: product.directTrendData.priceData[0],
      lastPrice: product.directTrendData.priceData.at(-1),
      firstBsr: product.directTrendData.bsrData[0],
      lastBsr: product.directTrendData.bsrData.at(-1)
    }))
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
