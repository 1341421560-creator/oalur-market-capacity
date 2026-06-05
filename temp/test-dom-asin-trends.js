const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const asin = process.argv[2] || 'B091FBB2KW';

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
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, asin);
  await sleep(500);

  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.innerText.trim() === '立即查询') {
        button.click();
        return true;
      }
    }
    return false;
  });
  await sleep(6000);

  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.innerText.trim() === '数据趋势') {
        button.click();
        return true;
      }
    }
    return false;
  });
  await sleep(8000);

  await page.evaluate(() => {
    const dialog = document.querySelector('.el-dialog');
    if (!dialog) return false;
    for (const item of dialog.querySelectorAll('.el-tabs__item')) {
      if (item.innerText.trim() === '价格&排名趋势') {
        item.click();
        return true;
      }
    }
    return false;
  });
  await sleep(6000);
}

function extractDomTrend() {
  const dialog = document.querySelector('.el-dialog');
  if (!dialog) return { ok: false, reason: 'no dialog' };

  const tables = Array.from(dialog.querySelectorAll('table')).map((table, tableIndex) => {
    const rows = Array.from(table.querySelectorAll('tr')).map(row =>
      Array.from(row.querySelectorAll('th,td')).map(cell => cell.innerText.trim())
    ).filter(row => row.some(Boolean));
    return { tableIndex, rows };
  }).filter(table => table.rows.length > 0);

  const visibleText = dialog.innerText.slice(0, 3000);
  const canvasCount = dialog.querySelectorAll('canvas').length;
  const svgCount = dialog.querySelectorAll('svg').length;
  const activeTab = Array.from(dialog.querySelectorAll('.el-tabs__item'))
    .find(item => item.className.includes('is-active'))?.innerText.trim();

  const chartNodes = Array.from(dialog.querySelectorAll('[_echarts_instance_], div, canvas'))
    .map((node, index) => ({
      index,
      tag: node.tagName,
      cls: String(node.className || '').slice(0, 120),
      echartsId: node.getAttribute('_echarts_instance_'),
      text: node.innerText?.trim()?.slice(0, 120) || '',
      width: node.clientWidth,
      height: node.clientHeight
    }))
    .filter(item => item.echartsId || item.width > 200 && item.height > 100)
    .slice(0, 30);

  const echartsOptions = [];
  if (window.echarts) {
    for (const node of dialog.querySelectorAll('[_echarts_instance_]')) {
      const instance = window.echarts.getInstanceByDom(node);
      if (!instance) continue;
      const option = instance.getOption();
      echartsOptions.push({
        title: option.title,
        legend: option.legend,
        xAxis: option.xAxis,
        yAxis: option.yAxis,
        series: (option.series || []).map(series => ({
          name: series.name,
          type: series.type,
          dataLength: Array.isArray(series.data) ? series.data.length : 0,
          firstData: Array.isArray(series.data) ? series.data.slice(0, 5) : null,
          lastData: Array.isArray(series.data) ? series.data.slice(-5) : null
        }))
      });
    }
  }

  function summarizeValue(value, depth = 0) {
    if (depth > 2) return typeof value;
    if (Array.isArray(value)) {
      return {
        type: 'array',
        length: value.length,
        first: value.length ? summarizeValue(value[0], depth + 1) : null
      };
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).slice(0, 20);
      const out = { type: 'object', keys };
      for (const key of keys.slice(0, 8)) out[key] = summarizeValue(value[key], depth + 1);
      return out;
    }
    return value;
  }

  const vueCandidates = [];
  const seen = new Set();
  for (const node of dialog.querySelectorAll('*')) {
    const component = node.__vueParentComponent || node.__vue__;
    if (!component || seen.has(component)) continue;
    seen.add(component);
    const typeName = component.type?.name || component.type?.__name || component.proxy?.$options?.name || '';
    const buckets = {};
    for (const [bucketName, bucket] of Object.entries({
      setupState: component.setupState,
      data: component.data,
      props: component.props,
      ctx: component.ctx
    })) {
      if (!bucket || typeof bucket !== 'object') continue;
      const interesting = {};
      for (const key of Object.keys(bucket)) {
        if (/trend|price|rank|bsr|rating|history|chart|data|series|date|time/i.test(key)) {
          interesting[key] = summarizeValue(bucket[key]);
        }
      }
      if (Object.keys(interesting).length) buckets[bucketName] = interesting;
    }
    if (Object.keys(buckets).length) vueCandidates.push({
      typeName,
      tag: node.tagName,
      cls: String(node.className || '').slice(0, 80),
      buckets
    });
    if (vueCandidates.length >= 20) break;
  }

  const candidates = [];
  for (const key of Object.keys(window)) {
    if (/chart|trend|price|rank|bsr/i.test(key)) candidates.push(key);
    if (candidates.length >= 50) break;
  }

  return {
    ok: true,
    activeTab,
    tableCount: tables.length,
    tables: tables.map(table => ({
      tableIndex: table.tableIndex,
      rowCount: table.rows.length,
      firstRows: table.rows.slice(0, 8)
    })),
    canvasCount,
    svgCount,
    chartNodes,
    echartsAvailable: !!window.echarts,
    echartsOptions,
    vueCandidates,
    visibleText,
    windowCandidates: candidates
  };
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const page = await browser.newPage();
  await openTrendDialog(page, asin);
  const result = await page.evaluate(extractDomTrend);
  console.log(JSON.stringify({ asin, result }, null, 2));
  await page.close();
  await browser.disconnect();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
