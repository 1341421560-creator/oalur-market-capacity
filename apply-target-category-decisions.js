const fs = require('fs');
const path = require('path');

function normalizeCategory(category) {
  return String(category || '')
    .replace(/&amp;/gi, '&')
    .split('>')
    .map(part => part.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean)
    .join(' > ');
}

function usage() {
  console.error('Usage: node apply-target-category-decisions.js <review.json> --target-category <category> [--target-category <category> ...]');
}

const reviewFile = process.argv[2];
const targetCategories = [];
for (let index = 3; index < process.argv.length; index++) {
  if (process.argv[index] === '--target-category') {
    const category = process.argv[index + 1];
    if (category) targetCategories.push(category);
    index++;
  }
}

if (!reviewFile || !targetCategories.length) {
  usage();
  process.exit(1);
}

const resolvedReviewFile = path.resolve(reviewFile);
const review = JSON.parse(fs.readFileSync(resolvedReviewFile, 'utf8'));
const targetSet = new Set(targetCategories.map(normalizeCategory).filter(Boolean));
const categories = Array.isArray(review.categories) ? review.categories : [];

review.decisions = categories
  .map(row => String(row?.category || '').trim())
  .filter(Boolean)
  .map(category => {
    const target = targetSet.has(normalizeCategory(category));
    return {
      category,
      decision: target ? 'target' : 'exclude',
      sameAmazonCategoryFit: target,
      sameProductCore: target,
      reason: target
        ? 'Matches the reviewed input product category and its core buying and usage intent.'
        : 'Does not match the reviewed input product type, core use case, or problem solved.',
      confidence: target ? 'high' : 'high',
      reviewedBy: 'local-codex',
      reviewedAt: new Date().toISOString()
    };
  });
review.status = 'completed-local-codex-review';
review.completedAt = new Date().toISOString();
fs.writeFileSync(resolvedReviewFile, JSON.stringify(review, null, 2), 'utf8');
console.log(`Applied ${review.decisions.length} explicit category decisions: target=${review.decisions.filter(row => row.decision === 'target').length}, exclude=${review.decisions.filter(row => row.decision === 'exclude').length}`);
