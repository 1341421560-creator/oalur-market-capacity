const fs = require('fs');
const path = require('path');

const REVIEW_STANDARD = {
  version: 1,
  triggerRule: 'Create local Codex semantic review candidates for non-target categories when they are high-share, high-relevance, title-intent, or functional-equivalent candidates.',
  triggerDetails: [
    'High-share: non-target, non-unknown category with parent-listing share >5%.',
    'High-relevance: non-target category with relevance score >=110, or score >=70 with count >=3.',
    'Title-intent: non-target category where multiple listing titles strongly match the input keyword intent.',
    'Functional-equivalent: non-target category that appears functionally equivalent but still requires Codex review before rescue.'
  ],
  decisionRule: 'Rescue only listings that local Codex judges to be the same product type and to have the same functional attributes as the input keyword.',
  includeRule: 'Variants, sizes, materials, colors, capacities, compatible mouth sizes, and bundles can be included when the core function and product type match.',
  excludeRule: 'Exclude listings with a different core product type or different core function, even when titles share generic words with the input keyword.',
  requiredContext: 'Local Codex must read the input keyword plus candidate listing titles and categories before writing decisions.',
  rescueMechanism: 'Filtering rescues only products explicitly marked target/include/yes in the product codex semantic review JSON file.'
};

function reviewFileForDataFile(dataFile) {
  const resolved = path.resolve(dataFile);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved).replace(/-data\.json$/i, '').replace(/\.json$/i, '');
  return path.join(dir, `${base}-codex-semantic-review.json`);
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveReviewFile(dataFile, marketData = {}) {
  const explicit = marketData.codexSemanticReviewFile;
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(path.dirname(path.resolve(dataFile)), explicit);
  }
  return reviewFileForDataFile(dataFile);
}

function normalizeDecision(value) {
  return String(value || '').trim().toLowerCase();
}

function isTargetDecision(value) {
  return ['target', 'include', 'included', 'yes', 'true', '目标', '目标产品', '是'].includes(normalizeDecision(value));
}

function isExcludeDecision(value) {
  return ['exclude', 'excluded', 'non_target', 'non-target', 'not_target', 'not-target', 'no', 'false', 'reject', 'rejected'].includes(normalizeDecision(value));
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function listingIdentifiers(item) {
  const ids = [
    item.asin,
    item.parentAsin,
    item.pasin,
    ...(Array.isArray(item.childAsins) ? item.childAsins : []),
    ...(Array.isArray(item.variantRows) ? item.variantRows.flatMap(row => [row.asin, row.parentAsin, row.pasin]) : [])
  ];
  return [...new Set(ids.map(value => String(value || '').trim()).filter(Boolean))];
}

function reviewEntries(review) {
  return [
    ...listValues(review?.products),
    ...listValues(review?.decisions),
    ...listValues(review?.items)
  ].filter(entry => entry && typeof entry === 'object');
}

function entryIdentifiers(entry) {
  return [
    entry.asin,
    entry.parentAsin,
    entry.pasin,
    ...listValues(entry.asins),
    ...listValues(entry.childAsins)
  ].map(value => String(value || '').trim()).filter(Boolean);
}

function indexReview(review) {
  const byId = new Map();
  for (const entry of reviewEntries(review)) {
    const ids = entryIdentifiers(entry);
    if (!ids.length) continue;
    for (const id of ids) byId.set(id, entry);
  }
  return byId;
}

function findReviewDecision(item, reviewIndex) {
  for (const id of listingIdentifiers(item)) {
    const entry = reviewIndex.get(id);
    if (entry) return entry;
  }
  return null;
}

function applyCodexSemanticReview(item, reviewIndex) {
  const decision = findReviewDecision(item, reviewIndex);
  if (!decision || !isTargetDecision(decision.decision || decision.status)) return false;
  item.codexSemanticReviewRescued = true;
  item.codexSemanticReviewDecision = {
    decision: decision.decision || decision.status,
    reason: decision.reason || '',
    reviewedBy: decision.reviewedBy || '',
    reviewedAt: decision.reviewedAt || ''
  };
  return true;
}

function applyCodexSemanticReviewExclusion(item, reviewIndex) {
  const decision = findReviewDecision(item, reviewIndex);
  if (!decision || !isExcludeDecision(decision.decision || decision.status)) return false;
  item.codexSemanticReviewExcluded = true;
  item.codexSemanticReviewDecision = {
    decision: decision.decision || decision.status,
    reason: decision.reason || '',
    reviewedBy: decision.reviewedBy || '',
    reviewedAt: decision.reviewedAt || ''
  };
  return true;
}

function loadCodexSemanticReview(dataFile, marketData = {}) {
  const reviewFile = resolveReviewFile(dataFile, marketData);
  const review = readJsonIfExists(reviewFile);
  return {
    reviewFile,
    review,
    reviewIndex: indexReview(review || {})
  };
}

function buildCandidateProducts(items, category) {
  return items
    .filter(item => {
      const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);
      return categories.includes(category);
    })
    .map(item => ({
      asin: item.asin || '',
      parentAsin: item.parentAsin || item.pasin || '',
      title: item.title || '',
      category: item.category || '',
      categories: item.categories || [],
      sales: item.sales || '',
      bsr: item.bsr || '',
      price: item.price || '',
      brand: item.brand || ''
    }));
}

function normalizeCategory(category) {
  return String(category || '')
    .replace(/&amp;/gi, '&')
    .split('>')
    .map(part => part.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean)
    .join(' > ');
}

function categoryMatchesReference(category, referenceCategory) {
  const categoryNorm = normalizeCategory(category);
  const referenceNorm = normalizeCategory(referenceCategory);
  if (!categoryNorm || !referenceNorm) return false;
  return categoryNorm === referenceNorm ||
    categoryNorm.startsWith(`${referenceNorm} > `) ||
    referenceNorm.startsWith(`${categoryNorm} > `);
}

function normalizeDecision(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isTargetDecision(value) {
  return ['target', 'include', 'included', 'yes', 'true'].includes(normalizeDecision(value));
}

function hasNonTargetCategoryCodexDecision(row) {
  const decision = row?.targetCategoryCodexDecision?.decision;
  return Boolean(decision) && !isTargetDecision(decision);
}

function productCategories(item) {
  return Array.isArray(item.categories) && item.categories.length
    ? item.categories.filter(Boolean)
    : [item.category].filter(Boolean);
}

function buildReferenceCandidateProducts(items, referenceCategory) {
  return items
    .filter(item => productCategories(item).some(category => categoryMatchesReference(category, referenceCategory)))
    .map(item => ({
      asin: item.asin || '',
      parentAsin: item.parentAsin || item.pasin || '',
      title: item.title || '',
      category: item.category || '',
      categories: item.categories || [],
      sales: item.sales || '',
      bsr: item.bsr || '',
      price: item.price || '',
      brand: item.brand || ''
    }));
}

function candidateReasons(row) {
  const reasons = [];
  const score = Number(row.score);
  const count = Number(row.count);
  if (row.highShareTitleRescueCandidate) {
    reasons.push(row.highShareTitleRescueReason || `high-share non-target category: category share ${Math.round(Number(row.categoryShare || 0) * 100)}%`);
  }
  if (row.titleIntentRescueCandidate) {
    reasons.push('title-intent candidate: multiple listing titles strongly match the input keyword intent');
  }
  if (row.functionalEquivalent) {
    reasons.push('functional-equivalent candidate: category appears functionally adjacent/equivalent but needs Codex semantic review');
  }
  if (Number.isFinite(score) && (score >= 110 || (score >= 70 && count >= 3))) {
    reasons.push(`high-relevance candidate: category relevance score ${score}, count ${Number.isFinite(count) ? count : 'N/A'}`);
  }
  return [...new Set(reasons)];
}

function referenceCandidateReason(row, referenceCategories = []) {
  if (!hasNonTargetCategoryCodexDecision(row)) return [];
  const matched = (referenceCategories || [])
    .filter(referenceCategory => categoryMatchesReference(row.category, referenceCategory));
  if (!matched.length) return [];
  return matched.map(referenceCategory => `manual reference category was not judged target by target-category Codex review; product-level rescue candidate: ${referenceCategory}`);
}

function buildCodexSemanticReviewCandidates({ keywords, categorySelection, targetCategories, items, referenceCategories }) {
  const targetSet = new Set(Array.isArray(targetCategories) ? targetCategories : []);
  const normalizedReferenceCategories = [...new Set((Array.isArray(referenceCategories) ? referenceCategories : [])
    .map(category => String(category || '').trim())
    .filter(Boolean))];
  const candidateByCategory = new Map();

  for (const row of (categorySelection || [])) {
    if (!row || !row.category || targetSet.has(row.category)) continue;
    const reasons = [
      ...candidateReasons(row),
      ...referenceCandidateReason(row, normalizedReferenceCategories)
    ];
    if (!reasons.length) continue;
    candidateByCategory.set(normalizeCategory(row.category), {
      ...row,
      codexCandidateReasons: [...new Set(reasons)],
      products: buildCandidateProducts(items, row.category)
    });
  }

  const candidateCategories = [...candidateByCategory.values()]
    .filter(row => row.category && !targetSet.has(row.category))
    .filter(row => row.codexCandidateReasons.length > 0);
  return candidateCategories.map(row => ({
    category: row.category,
    count: row.count,
    categoryShare: row.categoryShare,
    score: row.score,
    reason: row.codexCandidateReasons.join(' | '),
    candidateReasons: row.codexCandidateReasons,
    selectedKeyword: row.selectedKeyword || (keywords || [])[0] || '',
    reviewStandard: REVIEW_STANDARD,
    reviewQuestion: REVIEW_STANDARD.decisionRule,
    products: row.products || buildCandidateProducts(items, row.category)
  }));
}

module.exports = {
  applyCodexSemanticReview,
  applyCodexSemanticReviewExclusion,
  buildCodexSemanticReviewCandidates,
  loadCodexSemanticReview,
  REVIEW_STANDARD,
  reviewFileForDataFile
};
