function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parentKey(item) {
  return item?.parentAsin || item?.pasin || item?.asin || '';
}

function sourceRowsFromListing(item) {
  const parentAsin = parentKey(item);
  if (Array.isArray(item?.variantRows) && item.variantRows.length) {
    return item.variantRows.map(row => ({
      ...row,
      sourceKeyword: row.sourceKeyword || item.sourceKeyword,
      parentAsin: row.parentAsin || parentAsin,
      pasin: row.pasin || (row.asin && row.asin !== parentAsin ? parentAsin : row.pasin),
      brand: row.brand || item.brand,
      sellerType: row.sellerType || item.sellerType,
      variants: row.variants || item.variants,
      sellerCount: row.sellerCount || item.sellerCount
    }));
  }
  return [clone(item)];
}

function dedupeCanonicalVariantRows(rows) {
  const byAsin = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.asin || byAsin.has(row.asin)) continue;
    byAsin.set(row.asin, clone(row));
  }
  return [...byAsin.values()];
}

function canonicalVariantRowsFromMarketData(marketData) {
  const stored = Array.isArray(marketData?.canonicalRawVariantRows)
    ? marketData.canonicalRawVariantRows
    : [];
  if (stored.length) return dedupeCanonicalVariantRows(stored);

  const parents = [
    ...(Array.isArray(marketData?.data) ? marketData.data : []),
    ...(Array.isArray(marketData?.excluded) ? marketData.excluded : [])
  ];
  return dedupeCanonicalVariantRows(parents.flatMap(sourceRowsFromListing));
}

module.exports = {
  canonicalVariantRowsFromMarketData,
  dedupeCanonicalVariantRows
};
