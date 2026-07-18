const fs = require('fs');
const path = require('path');
const {
  buildInputProductContext,
  mergeInputProductContexts,
  primaryInputProductContext
} = require('./input-product-context');

const REVIEW_STANDARD = {
  version: 1,
  triggerRule: 'Create local Codex semantic review candidates only after target-category Codex review has judged the category as exclude/review instead of target.',
  triggerDetails: [
    'Layer 1 must finish first: input product context + full category path + title/bullet samples decide target/exclude/review for each category.',
    'Target-category listings enter the final listing pool directly and do not need product-level Codex review.',
    'Only categories with a completed non-target target-category Codex decision can become Layer 2 sources.',
    'JS relevance signals can explain why a non-target category is worth product-level review, but they cannot replace the Layer 1 Codex category decision.'
  ],
  decisionRule: 'Rescue listings when local Codex judges that the core product type, core use case, and core problem solved match the input keyword on Amazon US.',
  includeRule: 'Manual/electric/automatic operation, material, size, capacity, color, bundle contents, lid/base/accessory variations, disposable/reusable form, and compatible tray or mouth sizes are attribute differences and can be included when the input keyword does not explicitly make that attribute a core constraint.',
  excludeRule: 'Exclude listings with a different core product type, core use case, or core problem solved. Attribute differences should exclude only when the input keyword explicitly constrains that attribute, such as electric, automatic, manual, machine, disposable, reusable, with lid, or a specific size/capacity.',
  requiredContext: 'Local Codex must read the input product context from JSON (keyword, title, reference categories, bullet points, description) plus candidate listing titles, categories, bullets/description, price, sales, BSR, and candidate reasons before writing decisions. An exact full-path reference match combined with an exact keyword-to-leaf product-term match must already be a target category; only non-exact reference matches judged non-target can reach this rescue layer.',
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

function reviewHasDecisions(review) {
  return reviewEntries(review).some(entry => {
    const value = entry.decision || entry.status;
    return isTargetDecision(value) || isExcludeDecision(value);
  });
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
    reviewLoaded: reviewHasDecisions(review || {}),
    reviewIndex: indexReview(review || {})
  };
}

function productReviewContext(item) {
  return {
    asin: item.asin || '',
    parentAsin: item.parentAsin || item.pasin || '',
    title: item.title || '',
    category: item.category || '',
    categories: item.categories || [],
    description: item.description || item.productDescription || '',
    bulletPoints: item.bulletPoints || item.bullets || item.features || [],
    images: item.images || item.imageUrls || item.mainImage || item.image || [],
    sales: item.sales || '',
    bsr: item.bsr || '',
    price: item.price || '',
    brand: item.brand || ''
  };
}

function buildCandidateProducts(items, category, targetSet = new Set()) {
  return items
    .filter(item => {
      const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);
      return categories.includes(category) && !categories.some(itemCategory => targetSet.has(normalizeCategory(itemCategory)));
    })
    .map(productReviewContext);
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
  return matched.map(referenceCategory => `input JSON reference category was not judged target by target-category Codex review; product-level semantic rescue context: ${referenceCategory}`);
}

function buildCodexSemanticReviewCandidates({ keywords, inputProductContext, inputProductContexts, categorySelection, targetCategories, items, referenceCategories }) {
  const keywordList = Array.isArray(keywords) ? keywords.filter(Boolean) : [keywords].filter(Boolean);
  const contextList = mergeInputProductContexts([
    ...(Array.isArray(inputProductContexts) ? inputProductContexts : []),
    inputProductContext || buildInputProductContext({}, {
      keyword: keywordList[0] || keywordList.join(' + '),
      category: Array.isArray(referenceCategories) ? referenceCategories[0] : '',
      categories: referenceCategories
    })
  ]);
  const primaryContext = primaryInputProductContext(contextList);
  const targetSet = new Set(Array.isArray(targetCategories) ? targetCategories : []);
  const normalizedReferenceCategories = [...new Set((Array.isArray(referenceCategories) ? referenceCategories : [])
    .map(category => String(category || '').trim())
    .filter(Boolean))];
  const candidateByCategory = new Map();

  for (const row of (categorySelection || [])) {
    if (!row || !row.category || targetSet.has(row.category)) continue;
    if (!hasNonTargetCategoryCodexDecision(row)) continue;
    const reasons = [
      ...candidateReasons(row),
      ...referenceCandidateReason(row, normalizedReferenceCategories)
    ];
    if (!reasons.length) continue;
    candidateByCategory.set(normalizeCategory(row.category), {
      ...row,
      codexCandidateReasons: [...new Set(reasons)],
      products: buildCandidateProducts(items, row.category, new Set((targetCategories || []).map(normalizeCategory)))
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
    selectedKeyword: row.selectedKeyword || keywordList[0] || '',
    inputProductContext: primaryContext,
    ...(contextList.length > 1 ? { inputProductContexts: contextList } : {}),
    reviewStandard: REVIEW_STANDARD,
    reviewQuestion: REVIEW_STANDARD.decisionRule,
    products: row.products || buildCandidateProducts(items, row.category, new Set((targetCategories || []).map(normalizeCategory)))
  }));
}

function comparableRequest(value) {
  const clone = { ...(value || {}) };
  delete clone.generatedAt;
  return JSON.stringify(clone);
}

function writeCodexSemanticReviewRequest(dataFile, candidates = [], existingReview = null, reviewFileOverride = null) {
  const reviewFile = reviewFileOverride || reviewFileForDataFile(dataFile);
  const currentExists = Boolean(existingReview) || fs.existsSync(reviewFile);
  const current = existingReview || readJsonIfExists(reviewFile) || {};
  const candidateList = Array.isArray(candidates) ? candidates : [];
  if (!candidateList.length && !currentExists) {
    return { reviewFile, written: false, reason: 'no semantic review candidates' };
  }
  const firstCandidate = candidateList[0] || {};
  const payload = {
    version: REVIEW_STANDARD.version,
    status: reviewHasDecisions(current) ? 'local-codex-reviewed-with-refreshed-context' : 'pending-local-codex-review',
    generatedAt: new Date().toISOString(),
    reviewStandard: REVIEW_STANDARD,
    inputProductContext: firstCandidate.inputProductContext || null,
    ...(Array.isArray(firstCandidate.inputProductContexts) && firstCandidate.inputProductContexts.length > 1
      ? { inputProductContexts: firstCandidate.inputProductContexts }
      : {}),
    candidates: candidateList,
    products: Array.isArray(current.products) ? current.products : [],
    decisions: Array.isArray(current.decisions) ? current.decisions : [],
    items: Array.isArray(current.items) ? current.items : []
  };
  if (comparableRequest(current) === comparableRequest(payload)) {
    return { reviewFile, written: false, reason: 'existing semantic review request preserved' };
  }
  fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
  fs.writeFileSync(reviewFile, JSON.stringify(payload, null, 2), 'utf8');
  return {
    reviewFile,
    written: true,
    reason: reviewHasDecisions(current)
      ? 'semantic review request context refreshed; existing decisions preserved'
      : 'pending semantic review request refreshed'
  };
}

module.exports = {
  applyCodexSemanticReview,
  applyCodexSemanticReviewExclusion,
  buildCodexSemanticReviewCandidates,
  loadCodexSemanticReview,
  REVIEW_STANDARD,
  reviewFileForDataFile,
  writeCodexSemanticReviewRequest
};
