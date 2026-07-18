const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage: node apply-semantic-review-decisions.js <review.json> --exclude-all <reason>');
}

const reviewFile = process.argv[2];
const mode = process.argv[3];
const reason = process.argv.slice(4).join(' ').trim();
if (!reviewFile || mode !== '--exclude-all' || !reason) {
  usage();
  process.exit(1);
}

const resolvedReviewFile = path.resolve(reviewFile);
const review = JSON.parse(fs.readFileSync(resolvedReviewFile, 'utf8'));
const candidates = Array.isArray(review.candidates) ? review.candidates : [];
const products = candidates.flatMap(candidate => Array.isArray(candidate.products) ? candidate.products : []);
const byParent = new Map();
for (const product of products) {
  const key = product.parentAsin || product.asin;
  if (key && !byParent.has(key)) byParent.set(key, product);
}

review.products = [...byParent.values()].map(product => ({
  asin: product.asin || '',
  parentAsin: product.parentAsin || '',
  decision: 'exclude',
  reason,
  confidence: 'high',
  reviewedBy: 'local-codex',
  reviewedAt: new Date().toISOString()
}));
review.decisions = [];
review.items = [];
review.status = 'completed-local-codex-review';
review.completedAt = new Date().toISOString();
fs.writeFileSync(resolvedReviewFile, JSON.stringify(review, null, 2), 'utf8');
console.log(`Applied ${review.products.length} explicit semantic exclusions.`);
