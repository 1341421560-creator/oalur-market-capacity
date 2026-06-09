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

function representativeOf(items) {
  return [...items].sort((a, b) => {
    const ab = a.bsr > 0 ? a.bsr : Number.MAX_SAFE_INTEGER;
    const bb = b.bsr > 0 ? b.bsr : Number.MAX_SAFE_INTEGER;
    return ab - bb;
  })[0] || items[0];
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
    const salesTotal = group.reduce((sum, item) => sum + parseNumber(item.sales), 0);
    const revenueTotal = group.reduce((sum, item) => sum + parseNumber(item.revenue), 0);
    const childAsins = [...new Set(group.map(item => item.asin).filter(Boolean))];
    const sourceKeywords = [...new Set(group.map(item => item.sourceKeyword).filter(Boolean))];
    const categories = [...new Set(group.map(item => item.category).filter(Boolean))];
    const categoryCounts = categories.map(category => ({
      category,
      count: group.filter(item => item.category === category).length
    })).sort((a, b) => b.count - a.count);
    return {
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
        sales: item.sales,
        revenue: item.revenue,
        bsr: item.bsr,
        title: item.title,
        listingDate: item.listingDate,
        listingAge: item.listingAge,
        brand: item.brand,
        price: item.price,
        ratings: item.ratings,
        subRank: item.subRank
      })),
      sourceKeywords,
      sourceKeyword: representative.sourceKeyword || sourceKeywords[0] || '',
      aggregatedFromVariants: group.length > 1,
      variantRowCount: group.length,
      sales: formatInteger(salesTotal),
      revenue: formatMoney(revenueTotal),
      salesNumAggregated: Math.round(salesTotal),
      revenueNumAggregated: Math.round(revenueTotal * 10) / 10
    };
  });
}

function listingMatchesTargetCategories(item, targetCategorySet) {
  const categories = Array.isArray(item.categories) && item.categories.length
    ? item.categories
    : [item.category].filter(Boolean);
  return categories.some(category => targetCategorySet.has(category));
}

function applyTargetCategoryMatch(item, targetCategorySet) {
  const variantRows = Array.isArray(item.variantRows) ? item.variantRows : [];
  const matchedRows = variantRows.filter(row => targetCategorySet.has(row.category));
  const matchedCategories = [...new Set(matchedRows.map(row => row.category).filter(Boolean))];
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
  applyTargetCategoryMatch,
  listingMatchesTargetCategories,
  parseNumber
};
