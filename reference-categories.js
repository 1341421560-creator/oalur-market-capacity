const fs = require('fs');

function splitReferenceCategories(value) {
  return String(value || '')
    .split('||')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseReferenceCategoryArgs(argv = process.argv.slice(2)) {
  const categories = [];
  const directIdx = argv.indexOf('--reference-categories');
  if (directIdx > -1) {
    categories.push(...splitReferenceCategories(argv[directIdx + 1] || ''));
  }

  const fileIdx = argv.indexOf('--reference-categories-file');
  if (fileIdx > -1) {
    const file = argv[fileIdx + 1];
    if (file && fs.existsSync(file)) {
      categories.push(...fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean));
    } else if (file) {
      throw new Error(`Reference categories file not found: ${file}`);
    }
  }

  return normalizeReferenceCategories(categories);
}

function normalizeReferenceCategory(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .split('>')
    .map(part => part.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(' > ');
}

function normalizeReferenceCategories(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeReferenceCategory(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function appendReferenceCategoryArgs(args, referenceCategories = []) {
  const normalized = normalizeReferenceCategories(referenceCategories);
  if (normalized.length) {
    args.push('--reference-categories', normalized.join('||'));
  }
  return args;
}

function buildReferenceCategorySelectionSummary(referenceCategories = [], categorySelection = []) {
  const normalizedReferences = normalizeReferenceCategories(referenceCategories);
  const matchedBy = new Set(
    (categorySelection || [])
      .filter(row => row.referenceCategoryMatch && row.referenceCategoryMatchedBy)
      .map(row => normalizeReferenceCategory(row.referenceCategoryMatchedBy).toLowerCase())
  );
  const matchedCategories = (categorySelection || [])
    .filter(row => row.referenceCategoryMatch)
    .map(row => ({
      category: row.category,
      referenceCategory: row.referenceCategoryMatchedBy,
      matchType: row.referenceCategoryMatchType,
      scoreBoost: 0
    }));
  const unmatchedCategories = normalizedReferences.filter(category => !matchedBy.has(category.toLowerCase()));
  return {
    mode: normalizedReferences.length ? 'target-category-review-first' : 'none',
    scope: normalizedReferences.length ? 'target-category-codex-review; product-level-rescue-only-if-not-target' : 'none',
    matchedCount: matchedCategories.length,
    unmatchedCount: unmatchedCategories.length,
    matchedCategories,
    unmatchedCategories
  };
}

module.exports = {
  appendReferenceCategoryArgs,
  buildReferenceCategorySelectionSummary,
  normalizeReferenceCategories,
  normalizeReferenceCategory,
  parseReferenceCategoryArgs,
  splitReferenceCategories
};
