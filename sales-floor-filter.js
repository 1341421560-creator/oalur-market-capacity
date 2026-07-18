const { parseNumber } = require('./parent-listing-aggregate');

const DEFAULT_SALES_FLOOR_MIN = 200;

function salesFloorMinFromEnv() {
  const value = Number(process.env.OALUR_SALES_FLOOR_MIN || DEFAULT_SALES_FLOOR_MIN);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SALES_FLOOR_MIN;
}

function monthlySalesValue(item) {
  return parseNumber(item?.salesNumAggregated ?? item?.sales);
}

function markSalesFloorExcluded(item, salesFloorMin) {
  const salesValue = monthlySalesValue(item);
  item.salesFloorExcluded = true;
  item.salesFloorValue = salesValue;
  item.salesFloorMin = salesFloorMin;
  item.salesFloorExcludedReason = salesValue > 0
    ? `monthly sales ${salesValue} below ${salesFloorMin}`
    : `monthly sales missing or below ${salesFloorMin}`;
  return item;
}

function salesFloorSummary(items, salesFloorMin) {
  const rows = Array.isArray(items) ? items : [];
  const positive = rows.filter(item => monthlySalesValue(item) > 0);
  const missing = rows.length - positive.length;
  return {
    salesFloorMin,
    count: rows.length,
    positiveLowSalesCount: positive.length,
    missingOrZeroSalesCount: missing,
    asins: rows.map(item => item.asin).filter(Boolean).slice(0, 50),
    sample: rows.slice(0, 20).map(item => ({
      asin: item.asin || '',
      parentAsin: item.parentAsin || item.pasin || '',
      title: item.title || '',
      sales: monthlySalesValue(item),
      category: item.category || '',
      categories: item.categories || []
    }))
  };
}

function applySalesFloorFilter(items, options = {}) {
  const salesFloorMin = Number.isFinite(Number(options.salesFloorMin))
    ? Number(options.salesFloorMin)
    : salesFloorMinFromEnv();
  const included = [];
  const excluded = [];

  for (const item of Array.isArray(items) ? items : []) {
    const salesValue = monthlySalesValue(item);
    if (salesValue < salesFloorMin) {
      excluded.push(markSalesFloorExcluded(item, salesFloorMin));
    } else {
      delete item.salesFloorExcluded;
      delete item.salesFloorValue;
      delete item.salesFloorMin;
      delete item.salesFloorExcludedReason;
      included.push(item);
    }
  }

  return {
    included,
    excluded,
    summary: salesFloorSummary(excluded, salesFloorMin)
  };
}

module.exports = {
  DEFAULT_SALES_FLOOR_MIN,
  applySalesFloorFilter,
  monthlySalesValue,
  salesFloorMinFromEnv,
  salesFloorSummary
};
