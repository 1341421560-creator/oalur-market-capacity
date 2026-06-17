const fs = require('fs');
const path = require('path');
const { selectTargetCategories, listingMatchesKeywordIntent, titleMatchesKeywordIntent } = require('./category-selector');
const {
  aggregateParentListings,
  applyTargetCategoryMatch,
  listingMatchesTargetCategories,
  parseNumber
} = require('./parent-listing-aggregate');
const { buildRescuePriceGuard, rescuePriceMatches } = require('./rescue-price-guard');

const basePath = process.argv[2];
const deltaPath = process.argv[3];
const outputPath = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : basePath;

if (!basePath || !deltaPath) {
  console.error('Usage: node merge-incremental-data.js <base-market-data.json> <delta-market-data.json> [output.json]');
  process.exit(1);
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parentKey(item) {
  return item.parentAsin || item.pasin || item.asin;
}

function allParents(marketData) {
  return [...(marketData.data || []), ...(marketData.excluded || [])].map(clone);
}

function sourceRowsFromListing(item) {
  const key = parentKey(item);
  if (Array.isArray(item.variantRows) && item.variantRows.length) {
    return item.variantRows.map(row => ({
      ...row,
      sourceKeyword: row.sourceKeyword || item.sourceKeyword,
      parentAsin: row.parentAsin || key,
      pasin: row.pasin || (row.asin && row.asin !== key ? key : row.pasin),
      brand: row.brand || item.brand,
      sellerType: row.sellerType || item.sellerType,
      variants: row.variants || item.variants,
      sellerCount: row.sellerCount || item.sellerCount
    }));
  }
  return [clone(item)];
}

function sourceRows(marketData) {
  return allParents(marketData).flatMap(sourceRowsFromListing);
}

function categoryRows(parents) {
  return parents.flatMap(parent => {
    const rows = Array.isArray(parent.variantRows) && parent.variantRows.length ? parent.variantRows : [parent];
    return rows.flatMap(row => {
      const categories = Array.isArray(row.categories) && row.categories.length ? row.categories : [row.category].filter(Boolean);
      return categories.length
        ? categories.map(category => ({ ...row, category, sourceKeyword: parent.sourceKeyword, parentAsin: parentKey(parent) }))
        : [{ ...row, sourceKeyword: parent.sourceKeyword, parentAsin: parentKey(parent) }];
    });
  });
}

function combineParents(baseData, deltaData) {
  const byAsin = new Map();
  for (const row of [...sourceRows(baseData), ...sourceRows(deltaData)]) {
    if (!row.asin) continue;
    const existing = byAsin.get(row.asin);
    if (!existing) {
      byAsin.set(row.asin, row);
      continue;
    }
    byAsin.set(row.asin, mergeRowsByBsr(existing, row));
  }
  return aggregateParentListings([...byAsin.values()]);
}

function mergeRowsByBsr(existing, row) {
  const existingBsr = parseNumber(existing.bsr) || Number.MAX_SAFE_INTEGER;
  const rowBsr = parseNumber(row.bsr) || Number.MAX_SAFE_INTEGER;
  const winner = rowBsr < existingBsr ? row : existing;
  const loser = winner === row ? existing : row;
  return {
    ...loser,
    ...winner,
    categories: [...new Set([...(loser.categories || []), ...(winner.categories || [])].filter(Boolean))]
  };
}

function mergeVariantRows(a = [], b = []) {
  const byAsin = new Map();
  for (const row of [...a, ...b]) {
    if (!row?.asin) continue;
    const existing = byAsin.get(row.asin);
    if (!existing) byAsin.set(row.asin, row);
    else {
      byAsin.set(row.asin, {
        ...existing,
        ...row,
        categories: [...new Set([...(existing.categories || []), ...(row.categories || [])].filter(Boolean))]
      });
    }
  }
  return [...byAsin.values()];
}

function mergeCategoryCounts(a = [], b = []) {
  const counts = new Map();
  for (const item of [...a, ...b]) {
    if (!item?.category) continue;
    counts.set(item.category, (counts.get(item.category) || 0) + Number(item.count || 0));
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((x, y) => y.count - x.count);
}

function reapplyFilter(baseData, deltaData, parents) {
  const keywords = Array.isArray(baseData.keywords) && baseData.keywords.length
    ? baseData.keywords
    : (Array.isArray(deltaData.keywords) && deltaData.keywords.length ? deltaData.keywords : [baseData.keyword || deltaData.keyword].filter(Boolean));
  const categorySelectionSource = categoryRows(parents);
  const lockedCategorySelection = Array.isArray(baseData.categorySelection) && baseData.categorySelection.length
    ? baseData.categorySelection
    : null;
  const selectedFromBase = Array.isArray(baseData.targetCategories) ? baseData.targetCategories.filter(Boolean) : [];
  const categorySelectionResult = lockedCategorySelection
    ? {
        targetCategory: selectedFromBase[0] || '',
        targetCategories: selectedFromBase,
        categorySelection: lockedCategorySelection
      }
    : selectTargetCategories(categorySelectionSource, keywords);
  const targetCategories = categorySelectionResult.targetCategories || [];
  const targetCategorySet = new Set(targetCategories);
  const equivalentCategorySet = new Set(
    (Array.isArray(baseData.equivalentCandidateCategories) && baseData.equivalentCandidateCategories.length
      ? baseData.equivalentCandidateCategories
      : categorySelectionResult.categorySelection.filter(d => d.titleIntentRescueCandidate || d.functionalEquivalent).map(d => d.category))
      .filter(category => !targetCategorySet.has(category))
  );
  const prepared = parents.map(parent => {
    const item = applyTargetCategoryMatch(parent, targetCategorySet);
    delete item.keywordIntentRescued;
    delete item.targetCategoryTitleIntentRequired;
    delete item.targetCategoryTitleIntentRejected;
    return item;
  });
  const rescuePriceGuard = buildRescuePriceGuard(prepared, item => listingMatchesTargetCategories(item, targetCategorySet));
  const matches = (item) => {
    if (listingMatchesTargetCategories(item, targetCategorySet)) {
      item.targetCategoryDirectMatched = true;
      return true;
    }
    const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);
    if (!categories.some(category => equivalentCategorySet.has(category))) return false;
    const rescued = listingMatchesKeywordIntent(item, keywords);
    if (rescued && !rescuePriceMatches(item, rescuePriceGuard)) return false;
    if (rescued) item.keywordIntentRescued = true;
    return rescued;
  };
  const matched = prepared.filter(matches);
  const data = matched;
  const matchedSet = new Set(matched);
  const excluded = prepared.filter(item => !matchedSet.has(item));
  const categoryDistribution = Object.entries(categorySelectionSource.reduce((acc, row) => {
    const category = row.category || 'unknown';
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]);
  return {
    ...baseData,
    keyword: baseData.keyword || deltaData.keyword,
    keywords,
    bsrRange: mergedBsrRange(baseData.bsrRange, deltaData.bsrRange),
    incrementalMerge: {
      basePath,
      deltaPath,
      mergedAt: new Date().toISOString(),
      baseRange: baseData.bsrRange,
      deltaRange: deltaData.bsrRange,
      categorySelectionLockedFromBase: Boolean(lockedCategorySelection)
    },
    targetCategory: targetCategories[0] || '',
    targetCategories,
    equivalentCandidateCategories: [...equivalentCategorySet],
    rescuePriceGuard,
    categorySelection: categorySelectionResult.categorySelection,
    categoryDistribution,
    targetMatchedCount: matched.length,
    salesFloorExcludedCount: 0,
    filteredCount: data.length,
    excludedCount: excluded.length,
    rawTotal: parents.length,
    total: parents.length,
    allCount: parents.length,
    data,
    excluded
  };
}

function mergedBsrRange(a, b) {
  const values = [a, b].flatMap(value => String(value || '').split('-').map(n => Number(n)).filter(Number.isFinite));
  if (!values.length) return a || b || '';
  return `${Math.min(...values)}-${Math.max(...values)}`;
}

try {
  const baseData = readJson(basePath);
  const deltaData = readJson(deltaPath);
  const parents = combineParents(baseData, deltaData);
  const result = reapplyFilter(baseData, deltaData, parents);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Incremental merged: ${basePath} + ${deltaPath} -> ${outputPath}`);
  console.log(`Parents: ${result.total}, filtered: ${result.filteredCount}, excluded: ${result.excludedCount}, BSR ${result.bsrRange}`);
  console.log(`Target categories: ${result.targetCategories.join(' | ')}`);
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
