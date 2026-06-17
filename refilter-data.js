const fs = require('fs');
const path = require('path');
const { selectTargetCategories, listingMatchesKeywordIntent, titleMatchesKeywordIntent } = require('./category-selector');
const {
  aggregateParentListings,
  applyTargetCategoryMatch,
  listingMatchesTargetCategories
} = require('./parent-listing-aggregate');
const { buildRescuePriceGuard, rescuePriceMatches } = require('./rescue-price-guard');

const inputPath = process.argv[2];
const outputPath = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : inputPath;

if (!inputPath) {
  console.error('Usage: node refilter-data.js <market-data.json> [output.json]');
  process.exit(1);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function listingKey(item) {
  return item.parentAsin || item.pasin || item.asin;
}

function sourceRowsFromListing(item) {
  const parentKey = listingKey(item);
  if (Array.isArray(item.variantRows) && item.variantRows.length) {
    return item.variantRows.map(row => ({
      ...row,
      sourceKeyword: row.sourceKeyword || item.sourceKeyword,
      parentAsin: row.parentAsin || parentKey,
      pasin: row.pasin || (row.asin && row.asin !== parentKey ? parentKey : row.pasin),
      brand: row.brand || item.brand,
      sellerType: row.sellerType || item.sellerType,
      variants: row.variants || item.variants,
      sellerCount: row.sellerCount || item.sellerCount
    }));
  }
  return [clone(item)];
}

function allSourceRows(marketData) {
  const byAsin = new Map();
  for (const item of [...(marketData.data || []), ...(marketData.excluded || [])]) {
    for (const row of sourceRowsFromListing(item)) {
      if (!row.asin) continue;
      if (!byAsin.has(row.asin)) byAsin.set(row.asin, row);
    }
  }
  return [...byAsin.values()];
}

function allParentListings(marketData) {
  return aggregateParentListings(allSourceRows(marketData));
}

function categorySelectionRows(parents) {
  return parents.flatMap(parent => {
    if (Array.isArray(parent.variantRows) && parent.variantRows.length) {
      return parent.variantRows.map(row => ({
        ...row,
        sourceKeyword: parent.sourceKeyword,
        parentAsin: parent.parentAsin || parent.pasin || parent.asin
      }));
    }
    return [parent];
  });
}

function reapplyFilter(marketData) {
  const keywords = Array.isArray(marketData.keywords) && marketData.keywords.length
    ? marketData.keywords
    : [marketData.keyword].filter(Boolean);
  const parents = allParentListings(marketData);
  const categorySelectionSource = categorySelectionRows(parents);
  const categorySelectionResult = selectTargetCategories(categorySelectionSource, keywords);
  const targetCategories = categorySelectionResult.targetCategories;
  const targetCategorySet = new Set(targetCategories);
  const equivalentCategorySet = new Set(
    categorySelectionResult.categorySelection
      .filter(d => d.titleIntentRescueCandidate || d.functionalEquivalent)
      .filter(d => !targetCategorySet.has(d.category))
      .map(d => d.category)
  );

  const prepared = parents.map(parent => {
    const item = applyTargetCategoryMatch(parent, targetCategorySet);
    delete item.keywordIntentRescued;
    delete item.keywordIntentRescuePrice;
    delete item.keywordIntentRescuePriceCheck;
    delete item.keywordIntentRescueRejected;
    delete item.keywordIntentRescueRejectedReason;
    delete item.targetCategoryTitleIntentRequired;
    delete item.targetCategoryTitleIntentRejected;
    return item;
  });
  const rescuePriceGuard = buildRescuePriceGuard(
    prepared,
    item => listingMatchesTargetCategories(item, targetCategorySet)
  );

  const listingMatchesFilter = (item) => {
    if (listingMatchesTargetCategories(item, targetCategorySet)) {
      item.targetCategoryDirectMatched = true;
      return true;
    }

    const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);
    const equivalentCategoryHit = categories.some(category => equivalentCategorySet.has(category));
    if (!equivalentCategoryHit) return false;
    const rescued = listingMatchesKeywordIntent(item, keywords);
    if (rescued && !rescuePriceMatches(item, rescuePriceGuard)) return false;
    if (rescued) {
      const rescuedRows = (Array.isArray(item.variantRows) ? item.variantRows : [])
        .filter(row => equivalentCategorySet.has(row.category) && keywords.some(keyword => titleMatchesKeywordIntent(row.title || item.title, keyword)));
      item.targetMatchedCategories = [...new Set([...(item.targetMatchedCategories || []), ...rescuedRows.map(row => row.category).filter(Boolean)])];
      item.targetMatchedChildAsins = [...new Set(rescuedRows.map(row => row.asin).filter(Boolean))];
      item.keywordIntentRescued = true;
    }
    return rescued;
  };

  const matched = prepared.filter(listingMatchesFilter);
  const data = matched;
  const matchedSet = new Set(matched);
  const excluded = prepared.filter(item => !matchedSet.has(item));
  const categoryDistribution = Object.entries(categorySelectionSource.reduce((acc, row) => {
    const category = row.category || 'unknown';
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]);

  return {
    ...marketData,
    targetCategory: targetCategories[0] || '',
    targetCategories,
    equivalentCandidateCategories: [...equivalentCategorySet],
    categorySelection: categorySelectionResult.categorySelection,
    rescuePriceGuard,
    categoryDistribution,
    filteredCount: data.length,
    excludedCount: excluded.length,
    targetMatchedCount: matched.length,
    salesFloorExcludedCount: 0,
    rawTotal: parents.length,
    total: parents.length,
    allCount: parents.length,
    refilteredAt: new Date().toISOString(),
    data,
    excluded
  };
}

const marketData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const result = reapplyFilter(marketData);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');

console.log(`Refiltered: ${inputPath} -> ${outputPath}`);
console.log(`Parents: ${result.total}, filtered: ${result.filteredCount}, excluded: ${result.excludedCount}`);
console.log(`Target categories: ${result.targetCategories.join(' | ')}`);
