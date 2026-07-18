function parseNumber(value) {
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatInteger(value) {
  return Math.round(value || 0).toLocaleString('en-US');
}

function formatMoney(value) {
  return '$' + Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

function hasPositiveMetric(value) {
  return parseNumber(value) > 0;
}

function sumMetric(rows, field) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => parseNumber(row[field]))
    .filter(value => value > 0)
    .reduce((total, value) => total + value, 0);
}

function sumMetricWithFallback(rows, field, fallbackField) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => {
      const primary = parseNumber(row[field]);
      return primary > 0 ? primary : parseNumber(row[fallbackField]);
    })
    .filter(value => value > 0)
    .reduce((total, value) => total + value, 0);
}

function aggregateRatingsForParent(rows) {
  const sourceRows = Array.isArray(rows) && rows.length ? rows : [];
  const values = sourceRows
    .map(row => ({ asin: row.asin, value: parseNumber(row.ratings) }))
    .filter(row => row.value > 0);

  if (!values.length) {
    return {
      value: 0,
      mode: 'missing',
      reason: 'no-positive-ratings',
      values: []
    };
  }
  if (values.length === 1) {
    return {
      value: values[0].value,
      mode: 'single',
      reason: 'single-rating',
      values
    };
  }

  const nums = values.map(row => row.value).sort((a, b) => a - b);
  const min = nums[0];
  const max = nums[nums.length - 1];
  const median = nums[Math.floor(nums.length / 2)];
  const sum = nums.reduce((total, value) => total + value, 0);
  const counts = new Map();
  nums.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  const hasDuplicate = [...counts.values()].some(count => count >= 2);
  const relativeSpread = median > 0 ? (max - min) / median : 0;
  const extremeRatio = min > 0 ? max / min : Infinity;

  if (hasDuplicate) {
    return {
      value: max,
      mode: 'shared',
      reason: 'duplicate-child-ratings',
      values
    };
  }
  if (median >= 1000 && relativeSpread <= 0.25) {
    return {
      value: max,
      mode: 'shared',
      reason: 'high-close-child-ratings',
      values
    };
  }
  if (max >= 500 && extremeRatio >= 4) {
    return {
      value: max,
      mode: 'shared',
      reason: 'extreme-child-rating-gap',
      values
    };
  }

  return {
    value: sum,
    mode: 'sum',
    reason: 'independent-child-ratings',
    values
  };
}

function representativeMetricRow(item, rows) {
  const sourceRows = Array.isArray(rows) && rows.length ? rows : [];
  return sourceRows.find(row => row.asin && row.asin === item.asin)
    || [...sourceRows].sort((a, b) => {
      const ab = parseNumber(a.bsr) > 0 ? parseNumber(a.bsr) : Number.MAX_SAFE_INTEGER;
      const bb = parseNumber(b.bsr) > 0 ? parseNumber(b.bsr) : Number.MAX_SAFE_INTEGER;
      return ab - bb;
    })[0]
    || item;
}

function aggregateVariantMetrics(item, rows) {
  const sourceRows = Array.isArray(rows) && rows.length ? rows : [];
  const baseMetricRow = representativeMetricRow(item, sourceRows);
  const baseSalesValid = hasPositiveMetric(baseMetricRow.sales);
  const baseRevenueValid = hasPositiveMetric(baseMetricRow.revenue);
  const childSalesTotal = baseSalesValid ? 0 : sumMetricWithFallback(sourceRows, 'sales', 'childSales');
  const childRevenueTotal = baseRevenueValid ? 0 : sumMetricWithFallback(sourceRows, 'revenue', 'childRevenue');
  const childSalesValid = childSalesTotal > 0;
  const childRevenueValid = childRevenueTotal > 0;
  const salesTotal = baseSalesValid ? parseNumber(baseMetricRow.sales) : childSalesTotal;
  const revenueTotal = baseRevenueValid ? parseNumber(baseMetricRow.revenue) : childRevenueTotal;
  const ratingsAggregation = aggregateRatingsForParent(sourceRows);
  item.sales = baseSalesValid ? baseMetricRow.sales : (childSalesValid ? formatInteger(salesTotal) : (baseMetricRow.sales || '--'));
  item.revenue = baseRevenueValid ? baseMetricRow.revenue : (childRevenueValid ? formatMoney(revenueTotal) : (baseMetricRow.revenue || '--'));
  item.ratings = formatInteger(ratingsAggregation.value);
  item.salesNumAggregated = Math.round(salesTotal);
  item.revenueNumAggregated = Math.round(revenueTotal * 10) / 10;
  item.ratingsNumAggregated = Math.round(ratingsAggregation.value);
  item.aggregatedMetricAsins = [...new Set(sourceRows.map(row => row.asin).filter(Boolean))];
  item.aggregatedMetricRowCount = sourceRows.length;
  item.salesRevenueMetricSource = metricSourceLabel(baseSalesValid, baseRevenueValid, childSalesValid, childRevenueValid);
  item.salesMetricFallbackReason = baseSalesValid ? '' : (childSalesValid ? 'representative-sales-missing-or-zero' : 'representative-and-child-sales-missing-or-zero');
  item.revenueMetricFallbackReason = baseRevenueValid ? '' : (childRevenueValid ? 'representative-revenue-missing-or-zero' : 'representative-and-child-revenue-missing-or-zero');
  item.ratingsMetricSource = ratingsAggregation.mode;
  item.ratingsMetricReason = ratingsAggregation.reason;
  item.ratingsMetricValues = ratingsAggregation.values;
  return item;
}

function metricSourceLabel(baseSalesValid, baseRevenueValid, childSalesValid, childRevenueValid) {
  if (baseSalesValid && baseRevenueValid) return 'representative-parent-row';
  if (baseSalesValid && childRevenueValid) return 'representative-sales-row-revenue-summed-children';
  if (childSalesValid && baseRevenueValid) return 'sales-summed-children-representative-revenue-row';
  if (childSalesValid && childRevenueValid) return 'summed-child-rows';
  if (!baseSalesValid && !childSalesValid && !baseRevenueValid && !childRevenueValid) return 'missing-child-metrics';
  if (!baseSalesValid && !childSalesValid) return 'missing-sales-revenue-summed-children';
  if (!baseRevenueValid && !childRevenueValid) return 'sales-summed-children-missing-revenue';
  return 'partial-child-metrics';
}

function representativeOf(items) {
  return [...items].sort((a, b) => {
    const ab = a.bsr > 0 ? a.bsr : Number.MAX_SAFE_INTEGER;
    const bb = b.bsr > 0 ? b.bsr : Number.MAX_SAFE_INTEGER;
    return ab - bb;
  })[0] || items[0];
}

function itemCategories(item) {
  return Array.isArray(item.categories) && item.categories.length
    ? item.categories.filter(Boolean)
    : [item.category].filter(Boolean);
}

function aggregateParentListings(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.pasin || item.parentAsin || item.asin;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return [...groups.entries()].map(([parentAsin, group]) => {
    const representative = representativeOf(group);
    const childAsins = [...new Set(group.map(item => item.asin).filter(Boolean))];
    const sourceKeywords = [...new Set(group.map(item => item.sourceKeyword).filter(Boolean))];
    const categories = [...new Set(group.flatMap(itemCategories))];
    const categoryCounts = categories.map(category => ({
      category,
      count: group.filter(item => itemCategories(item).includes(category)).length
    })).sort((a, b) => b.count - a.count);
    const listing = {
      ...representative,
      asin: representative.asin || parentAsin,
      pasin: representative.pasin || (parentAsin !== representative.asin ? parentAsin : ''),
      parentAsin,
      childAsins,
      childAsinCount: childAsins.length,
      categories,
      categoryCounts,
      variantRows: group.map(item => ({
        asin: item.asin,
        pasin: item.pasin,
        category: item.category,
        categories: itemCategories(item),
        sales: item.sales,
        revenue: item.revenue,
        salesCellText: item.salesCellText,
        revenueCellText: item.revenueCellText,
        childSales: item.childSales,
        childRevenue: item.childRevenue,
        bsr: item.bsr,
        title: item.title,
        listingDate: item.listingDate,
        listingAge: item.listingAge,
        listingDateSupplementedFrom: item.listingDateSupplementedFrom,
        brand: item.brand,
        price: item.price,
        margin: item.margin,
        weight: item.weight,
        ratings: item.ratings,
        subRank: item.subRank
      })),
      sourceKeywords,
      sourceKeyword: representative.sourceKeyword || sourceKeywords[0] || '',
      aggregatedFromVariants: group.length > 1,
      variantRowCount: group.length
    };
    return aggregateVariantMetrics(listing, listing.variantRows);
  });
}

function refreshParentAggregatedMetrics(items) {
  return (Array.isArray(items) ? items : []).map(item => {
    const metricRows = Array.isArray(item?.variantRows) && item.variantRows.length
      ? item.variantRows
      : [];
    if (!metricRows.length) return item;

    const aggregated = aggregateVariantMetrics({ ...item }, metricRows);
    const ratingsAggregation = aggregateRatingsForParent(metricRows);
    const supplementedRatings = parseNumber(item.ratingsNumAggregated || item.ratings);
    const useSupplementedRatings = ratingsAggregation.value <= 0
      && supplementedRatings > 0
      && String(item.ratingsSupplementedFrom || '').includes('products/information');
    const ratingsValue = useSupplementedRatings ? supplementedRatings : ratingsAggregation.value;

    return {
      ...aggregated,
      ratings: formatInteger(ratingsValue),
      ratingsNumAggregated: Math.round(ratingsValue),
      ratingsMetricSource: useSupplementedRatings ? item.ratingsMetricSource : ratingsAggregation.mode,
      ratingsMetricReason: useSupplementedRatings ? item.ratingsMetricReason : ratingsAggregation.reason,
      ratingsMetricValues: useSupplementedRatings ? item.ratingsMetricValues : ratingsAggregation.values
    };
  });
}

function listingMatchesTargetCategories(item, targetCategorySet) {
  return itemCategories(item).some(category => targetCategorySet.has(category));
}

function applyTargetCategoryMatch(item, targetCategorySet) {
  const variantRows = Array.isArray(item.variantRows) ? item.variantRows : [];
  const matchedRows = variantRows.filter(row => itemCategories(row).some(category => targetCategorySet.has(category)));
  const matchedCategories = [...new Set(matchedRows.flatMap(itemCategories).filter(category => targetCategorySet.has(category)))];
  if (matchedCategories.length) {
    item.targetMatchedCategories = matchedCategories;
    item.targetMatchedChildAsins = [...new Set(matchedRows.map(row => row.asin).filter(Boolean))];
    item.category = matchedCategories[0];
  } else {
    item.targetMatchedCategories = [];
    item.targetMatchedChildAsins = [];
  }
  return item;
}

module.exports = {
  aggregateParentListings,
  refreshParentAggregatedMetrics,
  aggregateVariantMetrics,
  applyTargetCategoryMatch,
  listingMatchesTargetCategories,
  aggregateRatingsForParent,
  parseNumber
};
