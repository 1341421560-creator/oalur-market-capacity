function parsePrice(value) {
  const n = parseFloat(String(value || '').replace(/[$,]/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function quantile(values, q) {
  const nums = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = (nums.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return nums[lo];
  return nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
}

function buildRescuePriceGuard(items, listingMatchesTargetCategories) {
  const targetPrices = [];
  for (const item of items) {
    if (!listingMatchesTargetCategories(item)) continue;
    const price = parsePrice(item.price);
    if (price != null) targetPrices.push(price);
  }

  if (targetPrices.length < 20) {
    return {
      enabled: false,
      reason: 'target price sample too small',
      targetSampleSize: targetPrices.length
    };
  }

  const q1 = quantile(targetPrices, 0.25);
  const median = quantile(targetPrices, 0.5);
  const q3 = quantile(targetPrices, 0.75);
  const p90 = quantile(targetPrices, 0.9);
  const iqr = q3 - q1;
  const upperLimit = p90 * 1.1;
  const lowerLimit = Math.max(0, q1 - iqr * 1.5);

  return {
    enabled: true,
    rule: 'target_category_p90_x_1.1',
    targetSampleSize: targetPrices.length,
    q1: round(q1),
    median: round(median),
    q3: round(q3),
    p90: round(p90),
    lowerLimit: round(lowerLimit),
    upperLimit: round(upperLimit)
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function rescuePriceMatches(item, guard) {
  if (!guard || !guard.enabled) return true;
  const price = parsePrice(item.price);
  if (price == null) {
    item.keywordIntentRescuePriceCheck = 'missing_price_allowed';
    return true;
  }
  const ok = price >= guard.lowerLimit && price <= guard.upperLimit;
  item.keywordIntentRescuePrice = price;
  item.keywordIntentRescuePriceCheck = ok ? 'passed' : 'rejected';
  if (!ok) {
    item.keywordIntentRescueRejected = true;
    item.keywordIntentRescueRejectedReason = `price ${price} outside target range ${guard.lowerLimit}-${guard.upperLimit}`;
  }
  return ok;
}

module.exports = {
  buildRescuePriceGuard,
  rescuePriceMatches,
  parsePrice
};
