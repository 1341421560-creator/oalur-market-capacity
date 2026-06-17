const fs = require('fs');
const path = require('path');
const { parsePeriod, selectSurvivalBaselinePeriod } = require('./survival-baseline');
const { aggregateRatingsForParent, aggregateVariantMetrics } = require('./parent-listing-aggregate');

function safeSegment(value) {
  return String(value || 'output').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function outputDirs(taskName) {
  const date = localDateString();
  const root = path.join(process.cwd(), 'output', `${date}-${safeSegment(taskName)}`);
  return {
    root,
    reports: path.join(root, 'reports')
  };
}

function outputDirsFromDataFile(filePath, taskName) {
  const dataDir = path.resolve(path.dirname(filePath));
  if (path.basename(dataDir).toLowerCase() === 'data') {
    const root = path.dirname(dataDir);
    return {
      root,
      reports: path.join(root, 'reports')
    };
  }
  return outputDirs(taskName);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function parsePlainNumber(value) {
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function stemToken(token) {
  const t = String(token || '').toLowerCase();
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 3 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function normalizeKeyword(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map(stemToken)
    .join(' ') || '';
}

function keywordRecommendationFromOalur(queryKeyword, oalurData) {
  if (!oalurData) return null;
  if (oalurData.keywordRecommendation?.recommendedKeyword) return oalurData.keywordRecommendation;
  const rows = Array.isArray(oalurData.allKeywords) ? oalurData.allKeywords : [];
  if (!rows.length) return null;
  const normalizedQuery = normalizeKeyword(queryKeyword);
  const similarRows = rows
    .filter(row => normalizeKeyword(row.keyword) === normalizedQuery)
    .map(row => ({ ...row, weeklySearchVolume: parsePlainNumber(row.searchVolume) }))
    .sort((a, b) => b.weeklySearchVolume - a.weeklySearchVolume);
  if (!similarRows.length) return null;
  const queriedRow = rows.find(row => String(row.keyword || '').toLowerCase() === String(queryKeyword || '').toLowerCase());
  const best = similarRows[0];
  const isQueryBest = String(best.keyword || '').toLowerCase() === String(queryKeyword || '').toLowerCase();
  return {
    queriedKeyword: queryKeyword,
    recommendedKeyword: best.keyword,
    matchedKeyword: queriedRow?.keyword || '',
    isQueryBest,
    queriedWeeklySearchVolume: queriedRow ? parsePlainNumber(queriedRow.searchVolume) : null,
    recommendedWeeklySearchVolume: best.weeklySearchVolume,
    candidateCount: similarRows.length,
    candidates: similarRows.slice(0, 5).map(row => ({
      keyword: row.keyword,
      searchVolume: row.searchVolume,
      weeklySearchVolume: row.weeklySearchVolume,
      searchRank: row.searchRank,
      productCount: row.productCount
    }))
  };
}

function keywordRecommendationHtml(recommendation, embedded = false) {
  if (!recommendation?.recommendedKeyword) return '';
  const queried = recommendation.queriedKeyword || jsonData.keyword || '';
  const recommended = recommendation.recommendedKeyword;
  const queriedVol = recommendation.queriedWeeklySearchVolume == null ? '未匹配' : Number(recommendation.queriedWeeklySearchVolume).toLocaleString();
  const recommendedVol = recommendation.recommendedWeeklySearchVolume == null ? '未采集' : Number(recommendation.recommendedWeeklySearchVolume).toLocaleString();
  const ok = recommendation.isQueryBest;
  const bg = ok ? '#f6ffed' : '#fff7e6';
  const border = ok ? '#b7eb8f' : '#ffd591';
  const color = ok ? '#237804' : '#ad6800';
  const title = ok ? 'ABA 搜索词检查：当前关键词没问题' : 'ABA 搜索词检查：建议更换搜索词';
  const main = ok
    ? `当前输入词 <strong>${escapeHtml(queried)}</strong> 已是相似关键词中周搜索量最高的词。`
    : `建议优先搜索 <strong>${escapeHtml(recommended)}</strong>，而不是 <strong>${escapeHtml(queried)}</strong>。`;
  if (embedded) {
    return `
  <div style="padding:10px 14px;background:${bg};border:1px solid ${border};border-radius:8px;font-size:13px;line-height:1.8;margin-bottom:16px;color:#555;">
    <strong style="color:${color};">${title}：</strong>${main}
    周搜索量：推荐词 ${recommendedVol}；当前输入词 ${queriedVol}。
  </div>`;
  }
  return `
<div class="card" style="background:${bg};border:1px solid ${border};padding:16px 20px;">
  <h2 style="border:none;margin-bottom:8px;color:${color};padding-bottom:0;">${title}</h2>
  <div style="font-size:14px;line-height:1.8;color:#555;">
    ${main}<br>
    周搜索量：推荐词 ${recommendedVol}；当前输入词 ${queriedVol}。判断范围为 ABA 搜索结果中与输入词单复数/词根相同的相似关键词。
  </div>
</div>`;
}

function opportunityAdjustmentForContext(context) {
  const categoryText = String(context.category || '').toLowerCase();
  const keywordText = String(context.keyword || '').toLowerCase();
  const seasonalityText = String(context.seasonalityType || '').toLowerCase();
  const text = [keywordText, categoryText, seasonalityText].filter(Boolean).join(' ');
  const topCategory = categoryText.split('>')[0].trim();
  const has = (...terms) => terms.some(term => text.includes(term));
  const hasCategory = (...terms) => terms.some(term => categoryText.includes(term));
  const topIs = (...terms) => terms.some(term => topCategory === term);
  let coefficient = 0.80;
  let type = '默认保守类目';
  const reasons = ['未命中更细类目时，按知识库默认保守系数 0.80'];
  let baseType = type;

  const setBase = (value, label, reason) => {
    coefficient = value;
    type = label;
    baseType = label;
    reasons[0] = reason;
  };

  const setSubcategory = (value, label, reason) => {
    coefficient = value;
    type = `${baseType} - ${label}`;
    reasons.push(reason);
  };

  if (topIs('health & household') || hasCategory('house supplies', 'cleaning tools', 'dishwashing', 'sponges', 'cleaning cloths', 'scouring pads')) setBase(0.85, 'Health & Household cleaning supplies', '家用清洁/耗材场景，需求稳定，按健康家居清洁耗材基础系数处理');
  else if (topIs('health', 'medical', 'health / medical / supplements') || hasCategory('medical', 'supplement')) setBase(0.55, 'Health / Medical / Supplements', '健康/医疗/补充剂合规和平台审核风险高');
  else if (topIs('clothing, shoes & jewelry')) setBase(0.60, 'Clothing, Shoes & Jewelry', '尺码、退货、审美和款式风险高');
  else if (topIs('electronics', 'computers', 'camera & photo', 'cell phones & accessories') || hasCategory('bluetooth', 'charger')) setBase(0.65, 'Electronics', '退货、兼容、安规和价格竞争较强');
  else if (topIs('baby products')) setBase(0.65, 'Baby Products', '安全与合规要求高，用户信任门槛高');
  else if (topIs('beauty & personal care') || hasCategory('skincare', 'makeup', 'hair care')) setBase(0.65, 'Beauty & Personal Care', '品牌、信任和评论壁垒较强');
  else if (topIs('toys & games')) setBase(0.70, 'Toys & Games', '合规、安全、侵权和季节性风险较高');
  else if (topIs('kitchen & dining') || hasCategory('bakeware', 'dining & entertaining')) setBase(0.775, 'Kitchen & Dining', '低价小工具和模具较卷，专业工具可提高');
  else if (topIs('home & kitchen')) setBase(0.80, 'Home & Kitchen', '大盘稳定，但同质化和价格战明显');
  else if (topIs('sports & outdoors')) setBase(0.80, 'Sports & Outdoors', '需求好，但季节性和退货风险存在');
  else if (topIs('automotive')) setBase(0.825, 'Automotive', '需求明确，但车型兼容和电子类风险需注意');
  else if (topIs('pet supplies')) setBase(0.85, 'Pet Supplies', '小件和耗材较好，大件和服饰需打折');
  else if (topIs('office products')) setBase(0.85, 'Office Products', '需求稳定，部分低价文具较卷');
  else if (topIs('patio, lawn & garden') || hasCategory('patio, lawn & garden', 'gardening', 'watering')) setBase(0.875, 'Patio, Lawn & Garden', '小件园艺较好，大件庭院用品需打折');
  else if (topIs('tools & home improvement') || hasCategory('hardware')) setBase(0.90, 'Tools & Home Improvement', '功能型强，用户目标明确，相对友好');
  else if (topIs('arts, crafts & sewing') || hasCategory('craft', 'sewing', 'diy')) setBase(0.90, 'Arts, Crafts & Sewing', '小众精准、DIY 场景明确，适合差异化');

  if (topIs('home & kitchen')) {
    if (hasCategory('storage & organization', 'space saver bags', 'closet storage')) {
      setSubcategory(0.75, 'Storage & Organization', 'Home & Kitchen 细分：收纳/压缩袋类同质化和价格战明显，按 0.70-0.85 区间取 0.75');
    } else if (hasCategory('cleaning supplies', 'household cleaning', 'cleaning tools')) {
      setSubcategory(0.85, 'Cleaning Supplies', 'Home & Kitchen 细分：清洁工具需求稳定，按 0.75-0.90 区间取 0.85');
    } else if (hasCategory('bedding', 'bath')) {
      setSubcategory(0.70, 'Bedding/Bath', 'Home & Kitchen 细分：床品/浴室用品存在体积、退货和材质投诉风险，按 0.65-0.80 区间取 0.70');
    } else if (hasCategory('home décor', 'home decor')) {
      setSubcategory(0.85, 'Home Decor', 'Home & Kitchen 细分：家居装饰受设计差异影响，按 0.80-0.95 区间取 0.85');
    }
  } else if (topIs('kitchen & dining')) {
    if (hasCategory('bakeware', 'baking tools')) {
      setSubcategory(0.80, 'Bakeware', 'Kitchen & Dining 细分：烘焙工具有需求但受季节和造型影响，按 0.75-0.90 区间取 0.80');
    } else if (hasCategory('molds', 'silicone molds')) {
      setSubcategory(0.75, 'Silicone Molds', 'Kitchen & Dining 细分：硅胶模具低价红海，按 0.65-0.80 区间取 0.75');
    } else if (hasCategory('utensils', 'gadgets')) {
      setSubcategory(0.75, 'Kitchen Gadgets', 'Kitchen & Dining 细分：普通厨房小工具低价同质化，按 0.70-0.85 区间取 0.75');
    }
  } else if (topIs('patio, lawn & garden')) {
    if (hasCategory('watering equipment', 'nozzles', 'garden hoses')) {
      setSubcategory(0.90, 'Watering Equipment', 'Patio, Lawn & Garden 细分：小件浇灌配件需求明确，按 0.85-0.90 区间取 0.90');
    }
  } else if (topIs('tools & home improvement')) {
    if (hasCategory('hardware', 'power tool accessories', 'hand tools')) {
      setSubcategory(0.95, 'Functional Tools/Hardware', 'Tools & Home Improvement 细分：功能型五金/工具配件目标明确，按 0.90-1.10 区间取 0.95');
    }
  }

  if ((topIs('kitchen & dining') || topIs('home & kitchen')) && has('chocolate mold', 'chocolate molds')) {
    coefficient = Math.min(coefficient, 0.75);
    type = `${baseType} - Chocolate molds`;
    reasons.push('细分知识库：Chocolate molds 普通款建议 0.70-0.80');
  } else if ((topIs('kitchen & dining') || topIs('home & kitchen')) && has('silicone mold', 'silicone molds')) {
    coefficient = Math.min(coefficient, 0.75);
    type = `${baseType} - Silicone molds`;
    reasons.push('细分知识库：Silicone molds 低价红海，建议 0.65-0.80');
  }
  coefficient = Math.max(0.40, Math.min(1.20, Math.round(coefficient * 1000) / 1000));
  return { coefficient, type, reason: reasons.join('；') };
}

function supplyTrendEvidence(trend) {
  const entries = Object.entries(trend || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, value]) => ({ month, value: Number(value) }))
    .filter(item => Number.isFinite(item.value));
  if (entries.length < 8) {
    return {
      score: 3,
      level: '趋势数据不足',
      text: '在售商品数趋势点不足，按中性偏保守处理。',
      longDeltaPct: null,
      recentDeltaPct: null,
      currentDeltaPct: null
    };
  }
  const avg = (items) => items.length ? items.reduce((sum, item) => sum + item.value, 0) / items.length : null;
  const pct = (from, to) => from > 0 && to != null ? (to / from - 1) * 100 : null;
  const classify = (delta) => {
    if (delta == null) return 'unknown';
    if (delta <= -10) return 'down';
    if (delta <= 10) return 'stable';
    if (delta <= 25) return 'up';
    return 'surge';
  };
  const label = (kind) => ({
    down: '供给下降',
    stable: '供给稳定',
    up: '供给增加',
    surge: '供给快速增加',
    unknown: '无法判断'
  }[kind] || '无法判断');
  const mid = Math.floor(entries.length / 2);
  const first = entries.slice(0, mid);
  const second = entries.slice(mid);
  const secondMid = Math.floor(second.length / 2);
  const recentBase = second.slice(0, secondMid);
  const recent = second.slice(secondMid);
  const recentMid = Math.floor(recent.length / 2);
  const currentBase = recent.slice(0, recentMid);
  const current = recent.slice(recentMid);

  const avgFirst = avg(first);
  const avgSecond = avg(second);
  const avgRecentBase = avg(recentBase);
  const avgRecent = avg(recent);
  const avgCurrentBase = avg(currentBase);
  const avgCurrent = avg(current);
  const longDeltaPct = pct(avgFirst, avgSecond);
  const recentDeltaPct = pct(avgRecentBase, avgRecent);
  const currentDeltaPct = pct(avgCurrentBase, avgCurrent);
  const longKind = classify(longDeltaPct);
  const recentKind = classify(recentDeltaPct);
  const currentKind = classify(currentDeltaPct);
  const codeForKind = (kind) => ({
    down: 'D',
    stable: 'S',
    up: 'U',
    surge: 'X',
    unknown: '?'
  }[kind] || '?');
  const trendKey = `${codeForKind(longKind)}-${codeForKind(recentKind)}-${codeForKind(currentKind)}`;
  const isGrowth = (kind) => kind === 'up' || kind === 'surge';
  const isDown = (kind) => kind === 'down';
  const hasShock = [longKind, recentKind, currentKind].includes('down')
    && [longKind, recentKind, currentKind].includes('surge');
  const score = (() => {
    if (trendKey.includes('?')) return 4;
    if (isDown(longKind)) {
      if (isDown(recentKind) && isDown(currentKind)) return 0;
      if (isDown(currentKind)) return 1;
      if (isDown(recentKind) && isGrowth(currentKind)) return 2;
      if (recentKind === 'stable' && currentKind === 'stable') return 2;
      if (recentKind === 'stable' && isGrowth(currentKind)) return 3;
      if (isGrowth(recentKind) && currentKind === 'stable') return 3;
      if (isGrowth(recentKind) && isGrowth(currentKind)) return 4;
      return 2;
    }
    if (isDown(recentKind) && isDown(currentKind)) return 0;
    if (isDown(currentKind)) return isGrowth(recentKind) ? 3 : 2;
    if (isGrowth(currentKind) && isGrowth(recentKind)) return 7;
    if (isGrowth(currentKind) && recentKind === 'stable') return 6;
    if (isGrowth(currentKind) && isDown(recentKind)) return 4;
    if (currentKind === 'stable' && isGrowth(recentKind)) return hasShock ? 5 : 6;
    if (currentKind === 'stable' && recentKind === 'stable') return longKind === 'stable' ? 5 : 6;
    if (currentKind === 'stable' && isDown(recentKind)) return 4;
    return 4;
  })();
  const level = score >= 7 ? '持续增长'
    : score >= 6 ? '增长后趋稳或当前增长'
      : score >= 5 ? '成熟稳定'
        : score >= 4 ? '震荡观察'
          : score >= 3 ? '当前回落'
            : score >= 2 ? '供给转弱'
              : score >= 1 ? '偏弱'
                : '市场萎靡';
  const fmtPct = value => value == null ? '无法计算' : `${value.toFixed(1)}%`;
  const text = `在售商品数递进分段：前半段均值 ${avgFirst.toFixed(0)}，后半段均值 ${avgSecond.toFixed(0)}（长期 ${fmtPct(longDeltaPct)}，${label(longKind)}）；后半段前部均值 ${avgRecentBase.toFixed(0)}，后半段后部均值 ${avgRecent.toFixed(0)}（近期 ${fmtPct(recentDeltaPct)}，${label(recentKind)}）；近期前部均值 ${avgCurrentBase.toFixed(0)}，当前段均值 ${avgCurrent.toFixed(0)}（当前 ${fmtPct(currentDeltaPct)}，${label(currentKind)}）。趋势组合 ${trendKey}，按规则表得 ${score}/7；U/X 均先视为增长信号，长期 D 视为长期收缩后的修复，近期和当前连续 D 视为市场萎靡。`;
  return {
    score,
    level,
    text,
    longDeltaPct,
    recentDeltaPct,
    currentDeltaPct,
    longKind,
    recentKind,
    currentKind,
    trendKey,
    avgFirst,
    avgSecond,
    avgRecentBase,
    avgRecent,
    avgCurrentBase,
    avgCurrent
  };
}

function productTitle(d) {
  return d?.title || d?.productTitle || d?.productName || d?.name || d?.itemName || d?.asin || '无标题';
}

function parseMetricNumber(value) {
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatMetricInteger(value) {
  return Math.round(value || 0).toLocaleString('en-US');
}

function formatMetricMoney(value) {
  return '$' + Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

function representativeMetricRowForReport(item, rows) {
  const sourceRows = Array.isArray(rows) && rows.length ? rows : [];
  return sourceRows.find(row => row.asin && row.asin === item.asin)
    || [...sourceRows].sort((a, b) => {
      const ab = parseMetricNumber(a.bsr) > 0 ? parseMetricNumber(a.bsr) : Number.MAX_SAFE_INTEGER;
      const bb = parseMetricNumber(b.bsr) > 0 ? parseMetricNumber(b.bsr) : Number.MAX_SAFE_INTEGER;
      return ab - bb;
    })[0]
    || item;
}

function refreshParentAggregatedMetricsForReport(items) {
  return (items || []).map(item => {
    const rows = Array.isArray(item.variantRows) && item.variantRows.length ? item.variantRows : [];
    if (!rows.length) return item;
    const metricRows = rows;
    const aggregated = aggregateVariantMetrics({ ...item }, metricRows);
    const ratingsAggregation = aggregateRatingsForParent(metricRows);
    const supplementedRatings = parseMetricNumber(item.ratingsNumAggregated || item.ratings);
    const useSupplementedRatings = ratingsAggregation.value <= 0
      && supplementedRatings > 0
      && String(item.ratingsSupplementedFrom || '').includes('products/information');
    const ratingsValue = useSupplementedRatings ? supplementedRatings : ratingsAggregation.value;
    return {
      ...item,
      sales: aggregated.sales,
      revenue: aggregated.revenue,
      ratings: formatMetricInteger(ratingsValue),
      salesNumAggregated: aggregated.salesNumAggregated,
      revenueNumAggregated: aggregated.revenueNumAggregated,
      ratingsNumAggregated: Math.round(ratingsValue),
      aggregatedMetricAsins: [...new Set(metricRows.map(row => row.asin).filter(Boolean))],
      aggregatedMetricRowCount: metricRows.length,
      salesRevenueMetricSource: aggregated.salesRevenueMetricSource,
      salesMetricFallbackReason: aggregated.salesMetricFallbackReason,
      revenueMetricFallbackReason: aggregated.revenueMetricFallbackReason,
      ratingsMetricSource: useSupplementedRatings ? item.ratingsMetricSource : ratingsAggregation.mode,
      ratingsMetricReason: useSupplementedRatings ? item.ratingsMetricReason : ratingsAggregation.reason,
      ratingsMetricValues: useSupplementedRatings ? item.ratingsMetricValues : ratingsAggregation.values
    };
  });
}

// 璇诲彇鏁版嵁鏂囦欢锛堟敮鎸佺粷瀵硅矾寰勬垨鐩稿褰撳墠宸ョ▼ output 鐩綍鐨勮矾寰勶級
const dataFile = process.argv[2];
if (!dataFile) { console.error('Usage: node generate-report.js <data.json> [--seasonality <seasonality.json>] [--historical <historical.json>] [--asin-lifecycle <asin-lifecycle.json>]'); process.exit(1); }
const resolvedDataPath = path.isAbsolute(dataFile) ? dataFile : path.join(process.cwd(), dataFile);
const jsonData = JSON.parse(fs.readFileSync(resolvedDataPath, 'utf-8'));
const targetCategoryDisplay = Array.isArray(jsonData.targetCategories) && jsonData.targetCategories.length
  ? jsonData.targetCategories.join('；')
  : (jsonData.targetCategory || '未知');
const targetCategorySetForDisplay = new Set(Array.isArray(jsonData.targetCategories) ? jsonData.targetCategories : [jsonData.targetCategory].filter(Boolean));
const rescueCategoriesForDisplay = (Array.isArray(jsonData.equivalentCandidateCategories) ? jsonData.equivalentCandidateCategories : [])
  .filter(category => category && !targetCategorySetForDisplay.has(category));
const rescueCategoryDisplay = rescueCategoriesForDisplay.length ? rescueCategoriesForDisplay.join('；') : '无';
const rescuePriceGuard = jsonData.rescuePriceGuard || {};
const rescuePriceRuleText = rescuePriceGuard.enabled
  ? `仅作用于标题意图救回；动态 P90=${rescuePriceGuard.p90}，上限=P90×1.1=$${rescuePriceGuard.upperLimit}，样本=${rescuePriceGuard.targetSampleSize} 个目标类目产品`
  : '未启用';
function categoryMeetsTargetThreshold(row) {
  if (!row || row.functionalEquivalent) return false;
  const score = Number(row.score);
  const count = Number(row.count);
  const titleAllRate = Number(row.titleAllRate);
  if (!Number.isFinite(score) || !Number.isFinite(count)) return false;
  return (score >= 110 && (count >= 3 || score >= 180))
    || (row.shapeHit && row.contextMatch !== false && count >= 20 && Number.isFinite(titleAllRate) && titleAllRate >= 0.5);
}
const categorySelectionRows = Array.isArray(jsonData.categorySelection) ? jsonData.categorySelection : [];
const selectedCategoryRows = categorySelectionRows.filter(row => targetCategorySetForDisplay.has(row.category));
const qualifiedCategoryRows = categorySelectionRows.filter(categoryMeetsTargetThreshold);
const fallbackTargetRows = selectedCategoryRows.filter(row => !categoryMeetsTargetThreshold(row));
const targetCategorySelectionNote = fallbackTargetRows.length
  ? `<span style="color:#ad4e00;font-weight:600;">未发现达到目标类目门槛的类目，当前目标类目为兜底选择，请重点复核过滤结果。</span> 最高分类目：${escapeHtml(categorySelectionRows[0]?.category || '未知')}（${Number(categorySelectionRows[0]?.score || 0).toFixed(1)}分）；目标门槛：相关分≥110且父体数≥3，或相关分≥180。`
  : `已按目标类目门槛选中：${qualifiedCategoryRows.length || selectedCategoryRows.length} 个达标类目。目标门槛：相关分≥110且父体数≥3，或相关分≥180。`;
const metricTargetCategories = Array.isArray(jsonData.targetCategories) && jsonData.targetCategories.length
  ? jsonData.targetCategories
  : [jsonData.targetCategory].filter(Boolean);
function itemHasAnyTargetCategory(item, targetSet) {
  const directCategories = [
    item?.category,
    ...(Array.isArray(item?.categories) ? item.categories : []),
    ...(Array.isArray(item?.targetMatchedCategories) ? item.targetMatchedCategories : [])
  ].filter(Boolean);
  if (directCategories.some(category => targetSet.has(category))) return true;
  return (Array.isArray(item?.variantRows) ? item.variantRows : []).some(row => {
    const rowCategories = [
      row?.category,
      ...(Array.isArray(row?.categories) ? row.categories : [])
    ].filter(Boolean);
    return rowCategories.some(category => targetSet.has(category));
  });
}
jsonData.data = refreshParentAggregatedMetricsForReport(jsonData.data || []);
jsonData.excluded = refreshParentAggregatedMetricsForReport(jsonData.excluded || []);

// 鍙€夌殑瀛ｈ妭鎬т笌鐢熷懡鍛ㄦ湡鍒嗘瀽鏁版嵁
const seasonalityIdx = process.argv.indexOf('--seasonality');
const seasonalityFile = seasonalityIdx > -1 ? process.argv[seasonalityIdx + 1] : null;
let seasonalityData = null;
if (seasonalityFile && fs.existsSync(seasonalityFile)) {
  seasonalityData = JSON.parse(fs.readFileSync(seasonalityFile, 'utf-8'));
  console.log('已加载季节性数据:', seasonalityFile);
}

// 鍙€夌殑 6 涓湀鍓嶅巻鍙叉暟鎹紙鐢ㄤ簬鏂板搧瀛樻椿鐜囪绠楋級
const historicalIdx = process.argv.indexOf('--historical');
let historicalFile = historicalIdx > -1 ? process.argv[historicalIdx + 1] : null;
if (!historicalFile) {
  const dataDir = path.dirname(resolvedDataPath);
  const autoFile = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).find(file => /historical\.json$/i.test(file))
    : null;
  if (autoFile) historicalFile = path.join(dataDir, autoFile);
}
let historicalData = null;
let survivalRateData = null;
let survivalBaselineInfo = selectSurvivalBaselinePeriod(new Date());
let historicalPeriodCheck = null;
if (historicalFile && fs.existsSync(historicalFile)) {
  historicalData = JSON.parse(fs.readFileSync(historicalFile, 'utf-8'));
  if (Array.isArray(jsonData.targetCategories) && jsonData.targetCategories.length) {
    const targetSet = new Set(jsonData.targetCategories);
    const histAll = [...(historicalData.data || []), ...(historicalData.excluded || [])];
    historicalData.data = histAll.filter(item => itemHasAnyTargetCategory(item, targetSet));
    historicalData.excluded = histAll.filter(item => !itemHasAnyTargetCategory(item, targetSet));
    historicalData.filteredCount = historicalData.data.length;
    historicalData.excludedCount = historicalData.excluded.length;
    historicalData.targetCategory = jsonData.targetCategory;
    historicalData.targetCategories = jsonData.targetCategories;
  }
  historicalData.data = refreshParentAggregatedMetricsForReport(historicalData.data || []);
  historicalData.excluded = refreshParentAggregatedMetricsForReport(historicalData.excluded || []);
  console.log('已加载历史数据:', historicalFile, '| 时间:', historicalData.timeFilter);
  const histPeriod = parsePeriod(historicalData.timeFilter || '');
  const histYm = histPeriod ? `${histPeriod.year}-${String(histPeriod.month).padStart(2, '0')}` : '';
  const isRecommendedHistoricalPeriod = histPeriod ? survivalBaselineInfo.windowYm.includes(histYm) : false;
  historicalPeriodCheck = {
    histYm,
    isRecommendedHistoricalPeriod,
    message: histPeriod
      ? isRecommendedHistoricalPeriod
        ? `历史数据 ${historicalData.timeFilter} 位于推荐新品存活率基准窗口 ${survivalBaselineInfo.windowLabel}。${survivalBaselineInfo.reason}`
        : `历史数据 ${historicalData.timeFilter} 不在推荐新品存活率基准窗口 ${survivalBaselineInfo.windowLabel}；机械 6 个月候选为 ${survivalBaselineInfo.rawTargetLabel}。${survivalBaselineInfo.reason}`
      : `无法识别历史数据月份；推荐新品存活率基准窗口为 ${survivalBaselineInfo.windowLabel}。`
  };
  if (!isRecommendedHistoricalPeriod) {
    console.warn(`警告：${historicalPeriodCheck.message}`);
  }
}

// 鍙€夌殑 ASIN 鐢熷懡鍛ㄦ湡鍒嗘瀽鏁版嵁
const lifecycleIdx = process.argv.indexOf('--asin-lifecycle');
const lifecycleFile = lifecycleIdx > -1 ? process.argv[lifecycleIdx + 1] : null;
let lifecycleData = null;
if (lifecycleFile && fs.existsSync(lifecycleFile)) {
  lifecycleData = JSON.parse(fs.readFileSync(lifecycleFile, 'utf-8'));
  console.log('已加载生命周期数据:', lifecycleFile, '|', lifecycleData.products?.length || 0, '个 ASIN');
}

const cpcIdx = process.argv.indexOf('--cpc-opportunity');
let cpcOpportunityFile = cpcIdx > -1 ? process.argv[cpcIdx + 1] : null;
if (!cpcOpportunityFile) {
  const dataDir = path.dirname(resolvedDataPath);
  const autoFile = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).find(file => /cpc-opportunity\.json$/i.test(file))
    : null;
  if (autoFile) cpcOpportunityFile = path.join(dataDir, autoFile);
}
let cpcOpportunityData = null;
if (cpcOpportunityFile && fs.existsSync(cpcOpportunityFile)) {
  cpcOpportunityData = JSON.parse(fs.readFileSync(cpcOpportunityFile, 'utf-8'));
  console.log('已加载 CPC/客单价数据:', cpcOpportunityFile, '|', cpcOpportunityData.products?.length || 0, '个 ASIN');
}

const data = jsonData.data;
const excluded = jsonData.excluded || [];
const total = jsonData.total;
const TODAY = new Date();
const REPORT_DATE = localDateString(TODAY);

function buildExcludedCategorySummaryBlock(jsonData, excludedItems) {
  const excludedCount = excludedItems.length;
  if (!excludedCount) return '';
  const targetSet = new Set(Array.isArray(jsonData.targetCategories) ? jsonData.targetCategories : [jsonData.targetCategory].filter(Boolean));
  const rescueSet = new Set(Array.isArray(jsonData.equivalentCandidateCategories) ? jsonData.equivalentCandidateCategories : []);
  const selectionByCategory = new Map((jsonData.categorySelection || []).map(row => [row.category, row]));
  const countByCategory = new Map();
  for (const item of excludedItems) {
    const category = item.category || '未识别';
    countByCategory.set(category, (countByCategory.get(category) || 0) + 1);
  }
  const rows = [...countByCategory.entries()].map(([category, count]) => {
    const selection = selectionByCategory.get(category) || {};
    const score = Number(selection.score);
    const share = excludedCount ? count / excludedCount : 0;
    const flags = [];
    if (share >= 0.05) flags.push('数量占比高');
    if (Number.isFinite(score) && score >= 35) flags.push('相关分较高');
    if (rescueSet.has(category)) flags.push('救回候选但未通过标题/价格');
    if (targetSet.has(category)) flags.push('目标类目内被排除');
    return {
      category,
      count,
      share,
      score: Number.isFinite(score) ? score : null,
      reason: selection.reason || '',
      flags
    };
  });
  const importantRows = rows
    .filter(row => row.share >= 0.05 || (row.score != null && row.score >= 35))
    .sort((a, b) => {
      const scoreDiff = (b.score ?? -999) - (a.score ?? -999);
      if (scoreDiff) return scoreDiff;
      return b.count - a.count;
    })
    .slice(0, 12);
  if (!importantRows.length) return '';
  return `
<div class="card">
  <h2>高分/高占比被过滤类目</h2>
  <div style="margin-bottom:10px;padding:8px 12px;background:#fff7e6;border-left:4px solid #faad14;border-radius:6px;font-size:12px;color:#666;line-height:1.8;">
    展示规则：只列出被过滤父体 Listing 中数量占比 ≥5%，或类目相关性评分 ≥35 的类目。用于人工复核是否存在目标类目漏选或标题意图救回不足。
  </div>
  <div class="scroll-table">
    <table>
      <tr><th>#</th><th>被过滤类目</th><th>父体数量</th><th>排除占比</th><th>类目相关分</th><th>提示</th><th>评分原因</th></tr>
      ${importantRows.map((row, index) => `
      <tr>
        <td>${index + 1}</td>
        <td style="min-width:360px;max-width:760px;white-space:normal;line-height:1.5;">${escapeHtml(row.category)}</td>
        <td>${row.count}</td>
        <td>${(row.share * 100).toFixed(1)}%</td>
        <td>${row.score == null ? '--' : row.score.toFixed(1)}</td>
        <td>${escapeHtml(row.flags.length ? row.flags.join('；') : '人工复核')}</td>
        <td style="min-width:240px;white-space:normal;line-height:1.5;color:#666;">${escapeHtml(row.reason || '--')}</td>
      </tr>`).join('')}
    </table>
  </div>
</div>`;
}

const rawTotal = jsonData.rawTotal || data.length;
const keywordIntentRescuedCount = data.filter(d => d.keywordIntentRescued).length;

// Parse listing age. Prefer listingAge, fall back to listingDate.
function parseAge(d) {
  if (d.listingAge) {
    const y = d.listingAge.match(/(\d+)\s*年/);
    const m = d.listingAge.match(/(\d+)\s*月/);
    return (y ? parseInt(y[1]) : 0) * 12 + (m ? parseInt(m[1]) : 0);
  }
  if (d.listingDate) {
    const listed = new Date(d.listingDate);
    let months = (TODAY.getFullYear() - listed.getFullYear()) * 12 + (TODAY.getMonth() - listed.getMonth());
    if (TODAY.getDate() < listed.getDate()) months -= 1;
    return Math.max(0, months);
  }
  return -1;
}

function formatAge(d) {
  const months = parseAge(d);
  if (months < 0) return d.listingDate || '--';
  if (months < 12) return months + '个月';
  return (months / 12).toFixed(1) + '年';
}

function relevantChildRows(d) {
  const rows = Array.isArray(d.variantRows) && d.variantRows.length
    ? d.variantRows
    : [{
      asin: d.asin,
      pasin: d.pasin,
      title: d.title,
      listingDate: d.listingDate,
      listingAge: d.listingAge,
      sales: d.sales,
      revenue: d.revenue,
      bsr: d.bsr,
      brand: d.brand
    }];
  const matched = Array.isArray(d.targetMatchedChildAsins) && d.targetMatchedChildAsins.length
    ? new Set(d.targetMatchedChildAsins)
    : null;
  const relevant = matched ? rows.filter(row => matched.has(row.asin)) : rows;
  return relevant.length ? relevant : rows;
}

function allChildRows(d) {
  return Array.isArray(d.variantRows) && d.variantRows.length
    ? d.variantRows
    : [{
      asin: d.asin,
      pasin: d.pasin,
      title: d.title,
      listingDate: d.listingDate,
      listingAge: d.listingAge,
      sales: d.sales,
      revenue: d.revenue,
      bsr: d.bsr,
      brand: d.brand
    }];
}

function enrichParentNewVariantInfo(d) {
  const rows = relevantChildRows(d);
  const newRows = rows
    .map(row => ({ ...row, ageMonths: parseAge(row) }))
    .filter(row => row.ageMonths >= 0 && row.ageMonths < 6)
    .sort((a, b) => a.ageMonths - b.ageMonths);
  const under12Rows = rows
    .map(row => ({ ...row, ageMonths: parseAge(row) }))
    .filter(row => row.ageMonths >= 0 && row.ageMonths < 12)
    .sort((a, b) => a.ageMonths - b.ageMonths);
  const rowsWithAge = allChildRows(d).map(row => ({ ...row, ageMonths: parseAge(row) }));
  const representativeAgeMonths = parseAge(d);
  d.isPureUnder6mParent = representativeAgeMonths >= 0
    && representativeAgeMonths < 6
    && rowsWithAge.length > 0
    && rowsWithAge.every(row => row.ageMonths >= 0 && row.ageMonths < 6);
  d.isPureUnder12mParent = representativeAgeMonths >= 0
    && representativeAgeMonths < 12
    && rowsWithAge.length > 0
    && rowsWithAge.every(row => row.ageMonths >= 0 && row.ageMonths < 12);
  d.pureParentCheckedChildAsins = [...new Set(rowsWithAge.map(row => row.asin).filter(Boolean))];
  d.pureParentMissingDateAsins = [...new Set(rowsWithAge.filter(row => row.ageMonths < 0).map(row => row.asin).filter(Boolean))];
  d.relevantChildAsinCount = new Set(rows.map(row => row.asin).filter(Boolean)).size || d.childAsinCount || 1;
  d.newChildAsins = [...new Set(newRows.map(row => row.asin).filter(Boolean))];
  d.under12mChildAsins = [...new Set(under12Rows.map(row => row.asin).filter(Boolean))];
  d.parentHasNewVariant = d.newChildAsins.length > 0;
  d.parentHasUnder12mVariant = d.under12mChildAsins.length > 0;
  d.newestChildAsin = newRows[0]?.asin || '';
  d.newestChildAgeMonths = newRows[0]?.ageMonths ?? null;
  d.newestUnder12mChildAsin = under12Rows[0]?.asin || '';
  d.newestUnder12mChildAgeMonths = under12Rows[0]?.ageMonths ?? null;
  d.newVariantSource = d.parentHasNewVariant
    ? (d.newestChildAsin && d.newestChildAsin !== d.asin ? '父体新品子ASIN' : '代表ASIN新品')
    : '';
  d.under12mVariantSource = d.parentHasUnder12mVariant
    ? (d.newestUnder12mChildAsin && d.newestUnder12mChildAsin !== d.asin ? '父体<12月子ASIN' : '代表ASIN<12月')
    : '';
  return d;
}

data.forEach(enrichParentNewVariantInfo);

function childAsinCountExcludingRepresentative(d) {
  const asins = Array.isArray(d.childAsins) && d.childAsins.length
    ? d.childAsins
    : (Array.isArray(d.variantRows) ? d.variantRows.map(row => row.asin) : []);
  const unique = new Set(asins.filter(Boolean));
  if (d.asin) unique.delete(d.asin);
  return unique.size;
}

function getBsrInterval(maxRank) {
  if (maxRank <= 20000) return 1000;
  if (maxRank <= 30000) return 2000;
  return 4000;
}

// BSR distribution, using dynamic rank intervals.
const bsrMax = parseInt((jsonData.bsrRange || '1-10000').split('-')[1]) || 10000;
const bsrInterval = getBsrInterval(bsrMax);
const bsrSegmentCount = Math.ceil(bsrMax / bsrInterval);
const bsrRanges = [];
for (let i = 0; i < bsrSegmentCount; i++) {
  const start = i * bsrInterval;
  const end = (i + 1) * bsrInterval;
  bsrRanges.push({ label: `${start}-${end}`, min: start, max: end });
}
const bsrDist = bsrRanges.map(r => ({ label: r.label, count: data.filter(d => d.bsr >= r.min && d.bsr <= r.max).length }));
const sortedBsrValues = data.map(d => Number(d.bsr)).filter(Number.isFinite).sort((a, b) => a - b);
const maxAdjacentBsrGap = sortedBsrValues.length > 1
  ? Math.max(...sortedBsrValues.slice(1).map((value, index) => value - sortedBsrValues[index]))
  : null;
const bsrGapRatio = maxAdjacentBsrGap != null && bsrMax > 0 ? maxAdjacentBsrGap / bsrMax : null;
const firstBsrValue = sortedBsrValues.length ? sortedBsrValues[0] : null;
const firstBsrRatio = firstBsrValue != null && bsrMax > 0 ? firstBsrValue / bsrMax : null;

// 涓婃灦鏃堕棿鍒嗗竷
const ageRanges = [
  { label: '0-6个月', min: 0, max: 6 },
  { label: '6-12个月', min: 6, max: 12 },
  { label: '1-2年', min: 12, max: 24 },
  { label: '2-3年', min: 24, max: 36 },
  { label: '3-5年', min: 36, max: 60 },
  { label: '5年以上', min: 60, max: 999 },
];
const ageDist = ageRanges.map(r => ({ label: r.label, count: data.filter(d => { const m = parseAge(d); return m >= r.min && m < r.max; }).length }));

// 价格分布
const priceRanges = [
  { label: '$0-5', min: 0, max: 5 },
  { label: '$5-10', min: 5, max: 10 },
  { label: '$10-15', min: 10, max: 15 },
  { label: '$15-20', min: 15, max: 20 },
  { label: '$20-30', min: 20, max: 30 },
  { label: '$30-40', min: 30, max: 40 },
  { label: '$40-50', min: 40, max: 50 },
  { label: '$50-75', min: 50, max: 75 },
  { label: '$75+', min: 75, max: Infinity },
];
const priceDist = priceRanges.map(r => ({ label: r.label, count: data.filter(d => { const p = parseFloat(String(d.price || '').replace(/[$,]/g, '')); return !isNaN(p) && p >= r.min && p < r.max; }).length }));

// 鍝佺墝
const brandCount = {};
data.forEach(d => { if (d.brand) brandCount[d.brand] = (brandCount[d.brand] || 0) + 1; });
const topBrands = Object.entries(brandCount).sort((a, b) => b[1] - a[1]).slice(0, 10);

// 鍗栧绫诲瀷
const sellerCount = {};
data.forEach(d => {
  const st = d.sellerType?.includes('亚马逊') ? '亚马逊自营' : d.sellerType?.includes('FBA') ? 'FBA' : d.sellerType?.includes('FBM') ? 'FBM' : '其他';
  sellerCount[st] = (sellerCount[st] || 0) + 1;
});

// 鏂板搧锛氭寜鐖朵綋 Listing 缁熻锛屼絾妫€鏌ョ埗浣撲笅鐩爣鐩稿叧瀛?ASIN銆?
const newProductsData = data.filter(d => d.parentHasNewVariant);
const newProducts = newProductsData.length;
const newPct = data.length > 0 ? ((newProducts / data.length) * 100).toFixed(1) : '0';
const pureNewProductsData = data.filter(d => d.isPureUnder6mParent);
const pureNewProducts = pureNewProductsData.length;
const pureNewPct = data.length > 0 ? ((pureNewProducts / data.length) * 100).toFixed(1) : '0';

// ============ 鏂板搧瀛樻椿鐜囷紙6涓湀锛?===========
if (historicalData && historicalData.data) {
  // Parse historical timeFilter such as "2025年12月".
  const tfMatch = (historicalData.timeFilter || '').match(/(\d{4})年(\d{1,2})月/);
  if (tfMatch) {
    const histYear = parseInt(tfMatch[1]);
    const histMonth = parseInt(tfMatch[2]);
    const histDate = new Date(histYear, histMonth - 1, 15); // Use mid-month as reference point.
    const sixMonthsBeforeHist = new Date(histDate);
    sixMonthsBeforeHist.setMonth(sixMonthsBeforeHist.getMonth() - 6);

    const isHistoricalUnder6m = (row) => {
      if (!row?.listingDate) return false;
      const listed = new Date(row.listingDate);
      return listed >= sixMonthsBeforeHist && listed <= histDate;
    };
    const isHistoricalPureNewParent = (item) => {
      const rows = allChildRows(item);
      return isHistoricalUnder6m(item)
        && rows.length > 0
        && rows.every(isHistoricalUnder6m);
    };

    // Historical pure-new parent listings at the historical snapshot.
    const histNewProducts = historicalData.data.filter(isHistoricalPureNewParent);

    // 褰撳墠鏁版嵁鐨?ASIN 闆嗗悎
    const currentAsins = new Set(data.flatMap(d => [d.asin, d.pasin, d.parentAsin, ...(d.childAsins || []), ...(d.targetMatchedChildAsins || [])]).filter(Boolean));
    const currentAsinSales = new Map();
    data.forEach(item => {
      const sales = parseSalesNum(item);
      [item.asin, item.pasin, item.parentAsin, ...(item.childAsins || []), ...(item.targetMatchedChildAsins || [])]
        .filter(Boolean)
        .forEach(asin => currentAsinSales.set(asin, Math.max(currentAsinSales.get(asin) || 0, sales)));
    });
    const currentSalesNumsForSurvival = data.map(parseSalesNum).filter(n => n > 0).sort((a, b) => a - b);
    const currentSalesMedianForSurvival = currentSalesNumsForSurvival.length > 0
      ? (currentSalesNumsForSurvival.length % 2 !== 0
        ? currentSalesNumsForSurvival[Math.floor(currentSalesNumsForSurvival.length / 2)]
        : (currentSalesNumsForSurvival[currentSalesNumsForSurvival.length / 2 - 1] + currentSalesNumsForSurvival[currentSalesNumsForSurvival.length / 2]) / 2)
      : 0;
    const listingAsins = (item) => [...new Set([
      item.asin,
      item.pasin,
      item.parentAsin,
      ...(item.childAsins || []),
      ...(item.targetMatchedChildAsins || []),
      ...(Array.isArray(item.variantRows) ? item.variantRows.map(row => row.asin) : [])
    ].filter(Boolean))];
    const listingSurvived = (item) => listingAsins(item).some(asin => currentAsins.has(asin));
    const listingCurrentSales = (item) => Math.max(...listingAsins(item).map(asin => currentAsinSales.get(asin) || 0), 0);

    // Historical new products that still survive in the current BSR range.
    const surviving = histNewProducts.filter(d => listingSurvived(d));

    const hasHistoricalNewProducts = histNewProducts.length > 0;

    if (hasHistoricalNewProducts) {
      const survivalRate = ((surviving.length / histNewProducts.length) * 100).toFixed(1);
      const survivedSalesNums = surviving.map(listingCurrentSales).filter(n => n > 0).sort((a, b) => a - b);
      const survivedSalesMedian = survivedSalesNums.length > 0
        ? (survivedSalesNums.length % 2 !== 0
          ? survivedSalesNums[Math.floor(survivedSalesNums.length / 2)]
          : (survivedSalesNums[survivedSalesNums.length / 2 - 1] + survivedSalesNums[survivedSalesNums.length / 2]) / 2)
        : 0;
      const survivalSampleScore = histNewProducts.length >= 10 ? 2 : histNewProducts.length >= 5 ? 1 : 0;
      const survivalRateNum = parseFloat(survivalRate);
      const survivalRateScore = survivalRateNum >= 30 ? 5
        : survivalRateNum >= 20 ? 4
          : survivalRateNum >= 15 ? 3
            : survivalRateNum >= 8 ? 2
              : survivalRateNum > 0 ? 1
                : 0;
      const survivalSalesQualityScore = survivedSalesNums.length === 0 ? 0
        : currentSalesMedianForSurvival > 0 && survivedSalesMedian >= currentSalesMedianForSurvival ? 3
          : currentSalesMedianForSurvival > 0 && survivedSalesMedian >= currentSalesMedianForSurvival * 0.5 ? 2
            : 1;
      const survivalScore = survivalSampleScore + survivalRateScore + survivalSalesQualityScore;

      // 鐢熸垚瀛樻椿 ASIN 闆嗗悎鏂逛究鏌ヨ
      const survivingSet = new Set(surviving.flatMap(listingAsins));

      // 褰撴椂鏂板搧鐨勮鎯呭垪琛紙鍚瓨娲荤姸鎬侊級
      const histNewProductList = histNewProducts.map(d => ({
        asin: d.asin || '-',
        brand: d.brand || '-',
        listingDate: d.listingDate || d.listingAge || '--',
        childCount: allChildRows(d).length,
        survived: listingSurvived(d),
        currentSales: listingSurvived(d) ? listingCurrentSales(d) : '-'
      })).sort((a, b) => (b.survived ? 1 : 0) - (a.survived ? 1 : 0));

      const histNewRows = histNewProductList.map(p =>
        `<tr><td><a href="https://www.amazon.com/dp/${p.asin}" target="_blank">${p.asin}</a></td><td>${p.brand}</td><td>${p.listingDate}</td><td>${p.childCount}</td><td>${p.survived ? '存活' : '已淘汰'}</td><td>${p.currentSales === '-' ? '-' : p.currentSales.toLocaleString()}</td></tr>`
      ).join('\n');

      survivalRateData = {
        historicalPeriod: historicalData.timeFilter,
        histNewCount: histNewProducts.length,
        survivingCount: surviving.length,
        survivalRate: parseFloat(survivalRate),
        survivalRateStr: survivalRate + '%',
        survivalScore,
        survivalSampleScore,
        survivalRateScore,
        survivalSalesQualityScore,
        survivedSalesMedian,
        currentSalesMedian: currentSalesMedianForSurvival,
        hasNoNewProducts: false,
        // 鍒ゅ畾锛氱煡璇嗗簱鏍囧噯
        level: parseFloat(survivalRate) >= 60 ? '非常健康' :
               parseFloat(survivalRate) >= 35 ? '正常' :
               parseFloat(survivalRate) >= 25 ? '有竞争压力' : '存活率偏低',
        levelClass: parseFloat(survivalRate) >= 60 ? 'pass' :
                    parseFloat(survivalRate) >= 35 ? 'pass' :
                    parseFloat(survivalRate) >= 25 ? 'caution' : 'fail',
        histNewRows: histNewRows,
        histNewCountActual: histNewProductList.length,
        baselineInfo: survivalBaselineInfo,
        periodCheck: historicalPeriodCheck
      };

      console.log(`\n新品存活率分析`);
      console.log(`  历史时间: ${historicalData.timeFilter}`);
      console.log(`  当时新品: ${histNewProducts.length} 个`);
      console.log(`  仍存活: ${surviving.length} 个`);
      console.log(`  存活率: ${survivalRate}%（${survivalRateData.level}）`);
    } else {
      // 璇?BSR 鑼冨洿鍐呮棤鏂板搧锛屽瓨娲荤巼涓嶉€傜敤
      survivalRateData = {
        historicalPeriod: historicalData.timeFilter,
        histNewCount: 0,
        survivingCount: 0,
        survivalRate: null,
        survivalRateStr: '样本0，无法计算',
        survivalScore: 4,
        survivalSampleScore: 0,
        survivalRateScore: 2,
        survivalSalesQualityScore: 2,
        survivedSalesMedian: 0,
        currentSalesMedian: 0,
        hasNoNewProducts: true,
        level: '无严格纯新父体样本',
        levelClass: 'caution',
        histNewRows: '',
        histNewCountActual: 0,
        baselineInfo: survivalBaselineInfo,
        periodCheck: historicalPeriodCheck
      };

      console.log(`\n新品存活率分析`);
      console.log(`  历史时间: ${historicalData.timeFilter}`);
      console.log('  历史 BSR 范围内无严格纯新父体样本，存活率无法计算，按中性 4/10 计入新品活力');
    }
  }
}

// Sales statistics use positive monthly sales only for distribution metrics.
const totalSales = data.reduce((s, d) => s + parseSalesNum(d), 0);
const allParsedSalesNums = data.map(parseSalesNum);
const missingSalesCount = allParsedSalesNums.filter(value => value <= 0).length;
const allSalesNums = allParsedSalesNums.filter(value => value > 0).sort((a, b) => a - b);
const salesMedian = allSalesNums.length > 0 ? (allSalesNums.length % 2 !== 0 ? allSalesNums[Math.floor(allSalesNums.length / 2)] : (allSalesNums[allSalesNums.length / 2 - 1] + allSalesNums[allSalesNums.length / 2]) / 2) : 0;
const salesAvg = allSalesNums.length > 0 ? Math.round(allSalesNums.reduce((a, b) => a + b, 0) / allSalesNums.length) : 0;
const salesMax = allSalesNums.length > 0 ? Math.max(...allSalesNums) : 0;
const salesMin = allSalesNums.length > 0 ? Math.min(...allSalesNums) : 0;
const salesFloorMinTarget = Number(jsonData.analysisSalesFloor || process.env.OALUR_SALES_FLOOR_MIN || 200);
const sampleIncreaseReasons = [];
if (data.length > 0 && data.length < 90) sampleIncreaseReasons.push(`过滤后目标父体仅 ${data.length} 个，低于 90 个的稳定分析样本线`);
if (missingSalesCount > 0) sampleIncreaseReasons.push(`${missingSalesCount} 个目标父体月销量缺失，未计入最低/中位销量统计`);
if (salesMin > 600) sampleIncreaseReasons.push(`当前最低月销量 ${salesMin.toLocaleString()}，明显高于 300，低销量尾部样本不足`);
const shouldSuggestMoreSamples = sampleIncreaseReasons.length > 0;
const salesFloorExpansionLevel = shouldSuggestMoreSamples ? '建议增加样本' : '按输入 BSR 固定分析';
const salesFloorExpansionText = !allSalesNums.length
  ? `过滤后产品缺少月销量数据；本报告仍按用户输入的 BSR 范围 1-${bsrMax.toLocaleString()} 固定分析，不做自动扩容判断。`
  : shouldSuggestMoreSamples
    ? `本报告仍按用户输入的 BSR 范围 1-${bsrMax.toLocaleString()} 固定分析，不自动扩大 BSR；但当前样本建议继续增加：${sampleIncreaseReasons.join('；')}。月销量缺失或低于 ${salesFloorMinTarget.toLocaleString()} 的目标产品仍保留在分析池，不再因销量底线移入排除项。`
    : `本报告按用户输入的 BSR 范围 1-${bsrMax.toLocaleString()} 固定分析，不做自动扩容或下一轮 BSR 建议。月销量缺失或低于 ${salesFloorMinTarget.toLocaleString()} 的目标产品仍保留在分析池，不再因销量底线移入排除项。`;
const salesFloorExpansionBlock = `
  <div style="margin-top:12px;padding:12px 14px;background:${shouldSuggestMoreSamples ? '#fff7e6' : '#f6ffed'};border-left:4px solid ${shouldSuggestMoreSamples ? '#faad14' : '#52c41a'};border-radius:8px;font-size:13px;line-height:1.8;color:#555;">
    <strong>BSR 分析范围：</strong>${salesFloorExpansionLevel}<br>
    ${salesFloorExpansionText}<br>
    <strong>判断口径：</strong>用户输入多少 BSR，就只分析该范围内抓取并过滤后的父体 Listing；系统不会自动扩大 BSR，但会在目标父体数量不足或最低月销量明显偏高时提示增加样本。
  </div>`;

// 閿€鍞缁熻锛堢編鍏冿級
const allRevNums = data.map(d => parseRevenue(d)).sort((a, b) => a - b);
const revMedian = allRevNums.length > 0 ? (allRevNums.length % 2 !== 0 ? allRevNums[Math.floor(allRevNums.length / 2)] : (allRevNums[allRevNums.length / 2 - 1] + allRevNums[allRevNums.length / 2]) / 2) : 0;
const revAvg = allRevNums.length > 0 ? allRevNums.reduce((a, b) => a + b, 0) / allRevNums.length : 0;
const revMax = allRevNums.length > 0 ? Math.max(...allRevNums) : 0;
const revMin = allRevNums.length > 0 ? Math.min(...allRevNums) : 0;
const totalRev = allRevNums.reduce((a, b) => a + b, 0);

function medianNumber(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function profitProxyForListing(d) {
  const variantProfitRows = Array.isArray(d.variantRows)
    ? d.variantRows.map(row => {
      const parsed = parseFbaMargin(row);
      const price = parsePriceNum(row);
      return {
        asin: row.asin,
        price,
        fbaFee: parsed.fbaFee,
        marginPct: parsed.marginPct
      };
    }).filter(row => row.price > 0 && row.marginPct != null)
    : [];

  if (variantProfitRows.length >= 2) {
    const price = medianNumber(variantProfitRows.map(row => row.price));
    const fbaFee = medianNumber(variantProfitRows.map(row => row.fbaFee));
    const marginPct = medianNumber(variantProfitRows.map(row => row.marginPct));
    return {
      price,
      fbaFee,
      marginPct,
      source: 'child-median',
      sourceLabel: '子ASIN中位数',
      childProfitSampleCount: variantProfitRows.length
    };
  }

  const parsed = parseFbaMargin(d);
  return {
    price: parsePriceNum(d),
    fbaFee: parsed.fbaFee,
    marginPct: parsed.marginPct,
    source: Array.isArray(d.variantRows) && d.variantRows.length > 1 ? 'representative-proxy' : 'single-asin',
    sourceLabel: Array.isArray(d.variantRows) && d.variantRows.length > 1 ? '代表ASIN代理' : '单ASIN',
    childProfitSampleCount: variantProfitRows.length
  };
}

// Profit quick screening from Oalur FBA & margin fields.
const profitDetails = data.map(d => {
  const profitProxy = profitProxyForListing(d);
  const priceNum = profitProxy.price;
  const salesNum = parseSalesNum(d);
  const fbaRatio = profitProxy.fbaFee != null && priceNum > 0 ? (profitProxy.fbaFee / priceNum * 100) : null;
  const unitGrossProfit = profitProxy.marginPct != null && priceNum > 0 ? priceNum * profitProxy.marginPct / 100 : null;
  let status = '毛利率缺失';
  let statusClass = 'caution';
  if (profitProxy.marginPct != null) {
    if (profitProxy.marginPct >= 40) {
      status = '稳健';
      statusClass = 'pass';
    } else if (profitProxy.marginPct >= 35) {
      status = '过底线';
      statusClass = 'caution';
    } else {
      status = '低于底线';
      statusClass = 'fail';
    }
  }
  return {
    asin: d.asin || '-',
    title: productTitle(d),
    price: priceNum,
    sales: salesNum,
    fbaFee: profitProxy.fbaFee,
    fbaRatio,
    marginPct: profitProxy.marginPct,
    unitGrossProfit,
    profitSource: profitProxy.source,
    profitSourceLabel: profitProxy.sourceLabel,
    childProfitSampleCount: profitProxy.childProfitSampleCount,
    status,
    statusClass
  };
});
const fbaValues = profitDetails.map(d => d.fbaFee).filter(Number.isFinite);
const marginValues = profitDetails.map(d => d.marginPct).filter(Number.isFinite);
const fbaRatioValues = profitDetails.map(d => d.fbaRatio).filter(Number.isFinite);
const avgFbaFee = fbaValues.length ? fbaValues.reduce((a, b) => a + b, 0) / fbaValues.length : null;
const avgMarginPct = marginValues.length ? marginValues.reduce((a, b) => a + b, 0) / marginValues.length : null;
const avgFbaRatio = fbaRatioValues.length ? fbaRatioValues.reduce((a, b) => a + b, 0) / fbaRatioValues.length : null;
const marginPass35 = profitDetails.filter(d => d.marginPct != null && d.marginPct >= 35).length;
const marginPass40 = profitDetails.filter(d => d.marginPct != null && d.marginPct >= 40).length;
const marginBelow35 = profitDetails.filter(d => d.marginPct != null && d.marginPct < 35).length;
const marginMissing = profitDetails.filter(d => d.marginPct == null).length;
const weightedMarginTotalSales = profitDetails.filter(d => d.marginPct != null && d.sales > 0).reduce((s, d) => s + d.sales, 0);
const salesWeightedMarginPct = weightedMarginTotalSales > 0
  ? profitDetails.filter(d => d.marginPct != null && d.sales > 0).reduce((s, d) => s + d.marginPct * d.sales, 0) / weightedMarginTotalSales
  : null;
const weightedFbaTotalSales = profitDetails.filter(d => d.fbaRatio != null && d.sales > 0).reduce((s, d) => s + d.sales, 0);
const salesWeightedFbaRatio = weightedFbaTotalSales > 0
  ? profitDetails.filter(d => d.fbaRatio != null && d.sales > 0).reduce((s, d) => s + d.fbaRatio * d.sales, 0) / weightedFbaTotalSales
  : null;
const lowMarginSales = profitDetails.filter(d => d.marginPct != null && d.marginPct < 35).reduce((s, d) => s + d.sales, 0);
const lowMarginSalesSharePct = weightedMarginTotalSales > 0 ? (lowMarginSales / weightedMarginTotalSales * 100) : null;
const pricedSales = profitDetails.filter(d => d.price > 0).reduce((s, d) => s + d.sales, 0);
const lowPriceSales = profitDetails.filter(d => d.price > 0 && d.price < 8).reduce((s, d) => s + d.sales, 0);
const midPriceSales = profitDetails.filter(d => d.price >= 8 && d.price <= 12).reduce((s, d) => s + d.sales, 0);
const highPriceSales = profitDetails.filter(d => d.price > 12).reduce((s, d) => s + d.sales, 0);
const lowPriceSalesSharePct = pricedSales > 0 ? (lowPriceSales / pricedSales * 100) : null;
const midPriceSalesSharePct = pricedSales > 0 ? (midPriceSales / pricedSales * 100) : null;
const highPriceSalesSharePct = pricedSales > 0 ? (highPriceSales / pricedSales * 100) : null;
const unitProfitSales = profitDetails.filter(d => d.unitGrossProfit != null && d.sales > 0).reduce((s, d) => s + d.sales, 0);
const salesWeightedUnitGrossProfit = unitProfitSales > 0
  ? profitDetails.filter(d => d.unitGrossProfit != null && d.sales > 0).reduce((s, d) => s + d.unitGrossProfit * d.sales, 0) / unitProfitSales
  : null;
const profitSourceCounts = profitDetails.reduce((acc, item) => {
  acc[item.profitSourceLabel] = (acc[item.profitSourceLabel] || 0) + 1;
  return acc;
}, {});
const priceBandDefs = [
  { label: '<$8', match: d => d.price > 0 && d.price < 8 },
  { label: '$8-$12', match: d => d.price >= 8 && d.price <= 12 },
  { label: '>$12', match: d => d.price > 12 }
];
const priceBandProfitStats = priceBandDefs.map(def => {
  const rows = profitDetails.filter(def.match);
  const sales = rows.reduce((s, d) => s + d.sales, 0);
  const marginSales = rows.filter(d => d.marginPct != null && d.sales > 0).reduce((s, d) => s + d.sales, 0);
  const unitSales = rows.filter(d => d.unitGrossProfit != null && d.sales > 0).reduce((s, d) => s + d.sales, 0);
  const lowMarginBandSales = rows.filter(d => d.marginPct != null && d.marginPct < 35).reduce((s, d) => s + d.sales, 0);
  return {
    label: def.label,
    count: rows.length,
    sales,
    salesSharePct: pricedSales > 0 ? sales / pricedSales * 100 : null,
    weightedMarginPct: marginSales > 0 ? rows.filter(d => d.marginPct != null && d.sales > 0).reduce((s, d) => s + d.marginPct * d.sales, 0) / marginSales : null,
    weightedUnitGrossProfit: unitSales > 0 ? rows.filter(d => d.unitGrossProfit != null && d.sales > 0).reduce((s, d) => s + d.unitGrossProfit * d.sales, 0) / unitSales : null,
    lowMarginSalesSharePct: marginSales > 0 ? lowMarginBandSales / marginSales * 100 : null
  };
});
const lowPriceBandProfit = priceBandProfitStats.find(b => b.label === '<$8');
const weightedMarginScore = salesWeightedMarginPct == null ? 4
  : salesWeightedMarginPct >= 45 ? 8
    : salesWeightedMarginPct >= 40 ? 6
      : salesWeightedMarginPct >= 35 ? 4
        : 0;
const lowMarginSalesScore = lowMarginSalesSharePct == null ? 2
  : lowMarginSalesSharePct < 10 ? 5
    : lowMarginSalesSharePct < 25 ? 3
      : lowMarginSalesSharePct < 40 ? 1
        : 0;
const fbaPressureRatioForScore = salesWeightedFbaRatio ?? avgFbaRatio;
const fbaPressureScore = fbaPressureRatioForScore == null ? 1
  : fbaPressureRatioForScore < 20 ? 3
    : fbaPressureRatioForScore < 28 ? 2
      : fbaPressureRatioForScore < 35 ? 1
        : 0;
let priceProfitStructureScore = salesWeightedUnitGrossProfit == null ? 2
  : salesWeightedUnitGrossProfit >= 4 ? 4
    : salesWeightedUnitGrossProfit >= 3 ? 3
      : salesWeightedUnitGrossProfit >= 2 ? 1
        : 0;
if (lowPriceSalesSharePct != null && lowPriceSalesSharePct >= 50 && lowPriceBandProfit?.weightedUnitGrossProfit != null) {
  if (lowPriceBandProfit.weightedUnitGrossProfit < 3) priceProfitStructureScore = Math.min(priceProfitStructureScore, 1);
  else if (lowPriceBandProfit.weightedUnitGrossProfit < 4) priceProfitStructureScore = Math.min(priceProfitStructureScore, 2);
}
const marginScore = weightedMarginScore + lowMarginSalesScore + fbaPressureScore + priceProfitStructureScore;
const fmtPct = value => value == null ? '未采集' : value.toFixed(1) + '%';
const fmtMoney = value => value == null ? '未采集' : '$' + value.toFixed(2);
const profitConclusionClass = salesWeightedMarginPct == null
  ? 'caution'
  : marginScore >= 16
    ? 'pass'
    : marginScore >= 12
      ? 'caution'
      : 'fail';
const profitConclusion = salesWeightedMarginPct == null
  ? 'FBA&毛利率字段不足，无法做利润快筛'
  : profitConclusionClass === 'pass'
    ? '利润快筛通过：销量加权毛利率和低毛利销量占比表现较好'
    : profitConclusionClass === 'caution'
      ? '利润快筛谨慎：利润结构过底线，但低价或低毛利销量仍需复核'
      : '利润快筛不通过：销量加权毛利、低毛利销量或低客单价结构存在明显压力';

// New product sales analysis: final judgement is based on pure new parent listings.
const newSalesNums = pureNewProductsData.map(parseSalesNum).filter(n => n > 0).sort((a, b) => a - b);
const newSalesMedian = newSalesNums.length > 0 ? (newSalesNums.length % 2 !== 0 ? newSalesNums[Math.floor(newSalesNums.length / 2)] : (newSalesNums[newSalesNums.length / 2 - 1] + newSalesNums[newSalesNums.length / 2]) / 2) : 0;
const newSalesAvg = newSalesNums.length > 0 ? Math.round(newSalesNums.reduce((a, b) => a + b, 0) / newSalesNums.length) : 0;
const newSalesMax = newSalesNums.length > 0 ? Math.max(...newSalesNums) : 0;
const newSalesTotal = pureNewProductsData.reduce((s, d) => s + parseSalesNum(d), 0);
const newTopShare = totalSales > 0 && newSalesMax > 0 ? ((newSalesMax / totalSales) * 100).toFixed(1) : '0';
const newMedianShare = totalSales > 0 && newSalesMedian > 0 ? ((newSalesMedian / totalSales) * 100).toFixed(1) : '0';
const pureNewSalesShare = totalSales > 0 ? ((newSalesTotal / totalSales) * 100).toFixed(1) : '0';
const newSalesRatio = salesMedian > 0 && newSalesMedian > 0 ? (newSalesMedian / salesMedian) : 0;
const newSalesMedianToMaxRatio = newSalesMax > 0 && newSalesMedian > 0 ? newSalesMedian / newSalesMax : 0;
const newSalesSummary = pureNewProductsData.length === 0
  ? `近 6 个月无纯新父体，短期新品切入证据不足。父体新品子ASIN ${newProductsData.length} 个只能说明老父体变体更新，不能代表新 Listing 冷启动能力`
  : newSalesRatio >= 0.8
    ? `纯新父体销量可接近存量盘：${pureNewProductsData.length} 个纯新父体，合计销量占 ${pureNewSalesShare}%，销量中位数 ${newSalesMedian.toLocaleString()}，约为全市场中位数 ${(newSalesRatio * 100).toFixed(0)}%`
    : `纯新父体销量偏弱：${pureNewProductsData.length} 个纯新父体，合计销量占 ${pureNewSalesShare}%，销量中位数 ${newSalesMedian.toLocaleString()}，仅为全市场中位数 ${(newSalesRatio * 100).toFixed(0)}%`;
const newSalesSummaryColor = pureNewProductsData.length === 0 ? '#faad14' : newSalesRatio >= 0.8 ? '#52c41a' : '#faad14';
const survivalSummary = !survivalRateData
  ? '未分析 6 个月纯新父体存活率'
  : survivalRateData.hasNoNewProducts
    ? `${survivalRateData.historicalPeriod} 严格纯新父体样本为 0，存活率无法计算，按中性 4/10 计入新品活力`
    : `6 个月纯新父体存活率 ${survivalRateData.survivalRateStr}，${survivalRateData.level}`;
const survivalSummaryColor = !survivalRateData || survivalRateData.levelClass === 'info'
  ? '#8c8c8c'
  : survivalRateData.levelClass === 'pass'
    ? '#52c41a'
    : survivalRateData.levelClass === 'caution'
      ? '#faad14'
      : '#ff4d4f';

// <12涓湀浜у搧鍒嗘瀽
const under12mData = data.filter(d => d.parentHasUnder12mVariant);
const pureUnder12mData = data.filter(d => d.isPureUnder12mParent);
const under12mSalesNums = pureUnder12mData.map(parseSalesNum).filter(n => n > 0).sort((a, b) => a - b);
const under12mMedian = under12mSalesNums.length > 0 ? (under12mSalesNums.length % 2 !== 0 ? under12mSalesNums[Math.floor(under12mSalesNums.length / 2)] : (under12mSalesNums[under12mSalesNums.length / 2 - 1] + under12mSalesNums[under12mSalesNums.length / 2]) / 2) : 0;
const under12mAvg = under12mSalesNums.length > 0 ? Math.round(under12mSalesNums.reduce((a, b) => a + b, 0) / under12mSalesNums.length) : 0;
const under12mMax = under12mSalesNums.length > 0 ? Math.max(...under12mSalesNums) : 0;
const under12mTotal = pureUnder12mData.reduce((s, d) => s + parseSalesNum(d), 0);
const under12mShare = totalSales > 0 ? ((under12mTotal / totalSales) * 100).toFixed(1) : '0';
const under12mMaxShare = totalSales > 0 && under12mMax > 0 ? ((under12mMax / totalSales) * 100).toFixed(1) : '0';
const under12mMedianShare = totalSales > 0 && under12mMedian > 0 ? ((under12mMedian / totalSales) * 100).toFixed(1) : '0';
const under12mMedianRatio = salesMedian > 0 && under12mMedian > 0 ? under12mMedian / salesMedian : 0;
const under12mMedianToMaxRatio = under12mMax > 0 && under12mMedian > 0 ? under12mMedian / under12mMax : 0;
const under12mPctNum = data.length > 0 ? (pureUnder12mData.length / data.length) * 100 : 0;
const under12mShareNum = parseFloat(under12mShare) || 0;
function scoreNewParentSalesCarry({ count, salesMedianRatio, medianToMaxRatio, maxScore }) {
  const sampleScore = count > 0 ? 1 : 0;
  const qualityMax = maxScore === 8 ? 5 : 4;
  const concentrationMax = maxScore - 1 - qualityMax;
  const qualityScore = count === 0 ? 0
    : salesMedianRatio >= 1 ? qualityMax
      : salesMedianRatio >= 0.6 ? Math.max(1, qualityMax - 2)
        : salesMedianRatio >= 0.3 ? 1
          : 0;
  const concentrationScore = count <= 1 ? 0
    : medianToMaxRatio >= 0.5 ? concentrationMax
      : medianToMaxRatio >= 0.2 ? Math.max(1, concentrationMax - 1)
        : 0;
  const score = Math.min(maxScore, sampleScore + qualityScore + concentrationScore);
  return { score, sampleScore, qualityScore, concentrationScore, qualityMax, concentrationMax };
}
const newSalesCarryScore = scoreNewParentSalesCarry({
  count: pureNewProductsData.length,
  salesMedianRatio: newSalesRatio,
  medianToMaxRatio: newSalesMedianToMaxRatio,
  maxScore: 8
});
const under12mCarryScore = scoreNewParentSalesCarry({
  count: pureUnder12mData.length,
  salesMedianRatio: under12mMedianRatio,
  medianToMaxRatio: under12mMedianToMaxRatio,
  maxScore: 7
});
const under12mCoverageScore = under12mPctNum >= 15 ? 2
  : under12mPctNum >= 8 ? 1
    : pureUnder12mData.length > 0 ? 0.5
      : 0;
const under12mSalesShareScore = under12mShareNum >= 20 ? 3
  : under12mShareNum >= 10 ? 2
    : under12mShareNum >= 5 ? 1
      : 0;
const under12mSalesQualityScore = under12mMedianRatio >= 1 ? 2
  : under12mMedianRatio >= 0.6 ? 1
    : 0;
const under12mBalancedScore = under12mCoverageScore + under12mSalesShareScore + under12mSalesQualityScore;
const under12mLevel = pureUnder12mData.length === 0
  ? '无近1年纯新父体样本'
  : under12mBalancedScore >= 6
    ? '近1年新品承接强'
    : under12mBalancedScore >= 4
      ? '近1年新品有承接'
      : '近1年新品承接弱';
const under12mSummary = pureUnder12mData.length === 0
  ? `近1年无纯新父体样本，无法证明全新父体 Listing 能独立拿到销量。父体<12月子ASIN ${under12mData.length} 个仅作为辅助观察。`
  : `近1年纯新父体 ${pureUnder12mData.length} 个，占过滤后 ${under12mPctNum.toFixed(1)}%；合计销量占 ${under12mShare}%；销量中位数 ${under12mMedian.toLocaleString()}，约为全市场中位数 ${(under12mMedianRatio * 100).toFixed(0)}%。父体<12月子ASIN样本 ${under12mData.length} 个仅作辅助。判定：${under12mLevel}。`;
const survivalIntegratedSummary = (() => {
  if (!survivalRateData) return `${under12mSummary}未加载 6 个月历史数据，因此不能判断纯新父体留存。`;
  if (survivalRateData.hasNoNewProducts) return `${survivalRateData.historicalPeriod} 严格纯新父体样本为 0，说明该历史窗口没有可验证的全新父体 Listing 留存样本，存活率无法计算；该项按中性 4/10 计入新品活力，避免把“无样本”误判为“新品失败”。${under12mSummary}`;
  const survivalWeak = survivalRateData.survivalRate < 35;
  const under12Weak = under12mLevel === '近1年新品承接弱' || under12mLevel === '无近1年样本';
  if (survivalWeak && under12Weak) {
    return `6个月纯新父体存活率 ${survivalRateData.survivalRateStr}，且${under12mSummary}两项同时偏弱，说明全新父体进入后持续留在有效 BSR 区间的难度较高，可能存在老品/头部压制。`;
  }
  if (survivalWeak) {
    return `6个月纯新父体存活率 ${survivalRateData.survivalRateStr} 偏低，但${under12mSummary}不能仅凭存活率下重结论，需要结合近1年样本继续观察。`;
  }
  return `6个月纯新父体存活率 ${survivalRateData.survivalRateStr}，${under12mSummary}新品进入与留存证据相对更完整。`;
})();

// New product detail rows.
const newProductDetails = newProductsData.map(d => ({
  asin: d.asin,
  newChildAsin: d.newestChildAsin || d.asin,
  source: d.newVariantSource || '代表ASIN新品',
  pureUnder6mParent: d.isPureUnder6mParent,
  childCount: childAsinCountExcludingRepresentative(d),
  brand: d.brand || '-',
  sales: parseSalesNum(d),
  share: totalSales > 0 ? ((parseSalesNum(d) / totalSales) * 100).toFixed(1) : '0',
  age: d.newestChildAgeMonths ?? parseAge(d)
})).sort((a, b) => b.sales - a.sales);

// <12涓湀浜у搧璇︽儏鍒楄〃
const under12mDetails = under12mData.map(d => ({
  asin: d.asin,
  newChildAsin: d.newestUnder12mChildAsin || d.asin,
  under12mChildAsins: Array.isArray(d.under12mChildAsins) && d.under12mChildAsins.length ? d.under12mChildAsins : [d.newestUnder12mChildAsin || d.asin],
  source: d.under12mVariantSource || '代表ASIN<12月',
  pureUnder12mParent: d.isPureUnder12mParent,
  childCount: childAsinCountExcludingRepresentative(d),
  brand: d.brand || '-',
  sales: parseSalesNum(d),
  share: totalSales > 0 ? ((parseSalesNum(d) / totalSales) * 100).toFixed(1) : '0',
  age: d.newestUnder12mChildAgeMonths ?? parseAge(d)
})).sort((a, b) => b.sales - a.sales);

// 5姝ユ硶
const hasGap = bsrDist.some(r => r.count === 0);
let conclusion, conclusionClass, reason;
if (data.length < 30) {
  conclusion = '容量偏小';
  conclusionClass = 'fail';
  reason = '过滤后产品仅 ' + data.length + ' 个，低于知识库最低门槛（BSR 底线内高相关产品 >30 个），市场容量可能不足';
} else if (hasGap) {
  conclusion = '容量结构异常'; conclusionClass = 'caution';
  reason = '过滤后产品超过 30 个，但 BSR 区间存在断层，说明容量连续性或竞争结构需要复核';
} else {
  conclusion = data.length >= 80 ? '容量较大' : '容量中等';
  conclusionClass = data.length >= 80 ? 'pass' : 'caution';
  reason = '过滤后 ' + data.length + ' 个高相关产品，超过知识库最低门槛（>30）且 BSR 分布无断层；该结论只描述容量，不代表最终进入建议';
}
const capacityStandardText = '知识库明确标准：BSR 底线内高相关产品数量 >30 是最低容量门槛；少于 30 可能容量不足；区间断层代表容量有限或竞争结构特殊。知识库没有严格给出“大/中/小”分级。本报告操作分级：<30=容量偏小；30-79 且无断层=容量中等；≥80 且无断层=容量较大；有断层=容量结构异常。';

const avgPrice = data.length > 0 ? '$' + (data.reduce((s, d) => s + (parseFloat((d.price || '').replace('$', '')) || 0), 0) / data.length).toFixed(2) : '-';
const maxBsrVal = data.length > 0 ? Math.max(...data.map(d => d.bsr)).toLocaleString() : '-';
const top10Bsr = data.sort((a, b) => a.bsr - b.bsr).slice(0, 10).map(d => d.bsr).join('-');
const gapText = bsrDist.filter(r => r.count === 0).map(r => r.label).join('、') || '无断层';

// ============ 甯傚満绔炰簤鍒嗘瀽 ============

// Parse estimated revenue from Oalur fields.
function parseRevenue(d) {
  if (!d.revenue) return 0;
  const s = d.revenue.replace(/[$,]/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Parse estimated sales from Oalur fields.
function parseSalesNum(d) {
  if (!d.sales) return 0;
  const s = d.sales.replace(/,/g, '').replace('+', '').trim();
  const n = parseInt(s);
  return isNaN(n) ? 0 : n;
}

function parsePriceNum(d) {
  const n = parseFloat(String(d.price || '').replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function parseFbaMargin(d) {
  const text = String(d.margin || '');
  const fbaMatch = text.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  const marginMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  return {
    fbaFee: fbaMatch ? parseFloat(fbaMatch[1]) : null,
    marginPct: marginMatch ? parseFloat(marginMatch[1]) : null
  };
}

// --- 1. 鍗曞搧甯傚満鍗犳瘮锛堟寜棰勪及閿€閲忥級 ---
const salesSorted = [...data].sort((a, b) => parseSalesNum(b) - parseSalesNum(a));
const top1ItemShare = totalSales > 0 ? ((parseSalesNum(salesSorted[0]) / totalSales) * 100).toFixed(1) : '0';
const top5ItemShare = totalSales > 0 ? (salesSorted.slice(0, 5).reduce((s, d) => s + parseSalesNum(d), 0) / totalSales * 100).toFixed(1) : '0';
const top10ItemShare = totalSales > 0 ? (salesSorted.slice(0, 10).reduce((s, d) => s + parseSalesNum(d), 0) / totalSales * 100).toFixed(1) : '0';
const top3ItemShare = totalSales > 0 ? (salesSorted.slice(0, 3).reduce((s, d) => s + parseSalesNum(d), 0) / totalSales * 100).toFixed(1) : '0';
const top1ItemAsin = salesSorted[0]?.asin || '-';

// --- 鍗曞搧甯傚満鍗犳瘮锛堟寜棰勪及閿€鍞锛?---
const salesSortedByRev = [...data].sort((a, b) => parseRevenue(b) - parseRevenue(a));
const totalRevenue = data.reduce((s, d) => s + parseRevenue(d), 0);
const top1ItemRevShare = totalRevenue > 0 ? ((parseRevenue(salesSortedByRev[0]) / totalRevenue) * 100).toFixed(1) : '0';
const top5ItemRevShare = totalRevenue > 0 ? (salesSortedByRev.slice(0, 5).reduce((s, d) => s + parseRevenue(d), 0) / totalRevenue * 100).toFixed(1) : '0';
const top10ItemRevShare = totalRevenue > 0 ? (salesSortedByRev.slice(0, 10).reduce((s, d) => s + parseRevenue(d), 0) / totalRevenue * 100).toFixed(1) : '0';
const top3ItemRevShare = totalRevenue > 0 ? (salesSortedByRev.slice(0, 3).reduce((s, d) => s + parseRevenue(d), 0) / totalRevenue * 100).toFixed(1) : '0';
const top1ItemRevAsin = salesSortedByRev[0]?.asin || '-';

// --- 2. 鍝佺墝闆嗕腑搴︼紙鎸夐浼伴攢閲忥級 ---
const brandSales = {};
data.forEach(d => {
  if (!d.brand) return;
  brandSales[d.brand] = (brandSales[d.brand] || 0) + parseSalesNum(d);
});
const brandSalesSorted = Object.entries(brandSales).sort((a, b) => b[1] - a[1]);
const top1Brand = brandSalesSorted[0] || ['-', 0];
const top1BrandShare = totalSales > 0 ? ((top1Brand[1] / totalSales) * 100).toFixed(1) : '0';
const top3BrandShare = totalSales > 0 ? (brandSalesSorted.slice(0, 3).reduce((s, b) => s + b[1], 0) / totalSales * 100).toFixed(1) : '0';
const top5BrandShare = totalSales > 0 ? (brandSalesSorted.slice(0, 5).reduce((s, b) => s + b[1], 0) / totalSales * 100).toFixed(1) : '0';
const brandCr3 = parseFloat(top3BrandShare) || 0;
const brandCr3Level = brandCr3 < 40 ? '低垄断' : brandCr3 < 60 ? '中度垄断' : '高垄断';
const brandCr3Standard = 'CR3 <40% = 低垄断；40%-60% = 中度垄断；>60% = 高垄断';
// Brand dispersion outside TOP5.
const brandDispersion = totalSales > 0 ? (100 - parseFloat(top5BrandShare)).toFixed(1) : '0';
// 鍝佺墝鏌辩姸鍥炬暟鎹紙TOP10 鍝佺墝鎸夐攢閲忓崰姣旓級
const top10BrandBySales = brandSalesSorted.slice(0, 10).map(([b, s]) => ({
  brand: b,
  sales: s,
  share: totalSales > 0 ? ((s / totalSales) * 100).toFixed(1) : '0'
}));

// --- 鍝佺墝闆嗕腑搴︼紙鎸夐浼伴攢鍞锛?---
const brandRevenue = {};
data.forEach(d => {
  if (!d.brand) return;
  brandRevenue[d.brand] = (brandRevenue[d.brand] || 0) + parseRevenue(d);
});
const brandRevenueSorted = Object.entries(brandRevenue).sort((a, b) => b[1] - a[1]);
const top1BrandRev = brandRevenueSorted[0] || ['-', 0];
const top1BrandRevShare = totalRevenue > 0 ? ((top1BrandRev[1] / totalRevenue) * 100).toFixed(1) : '0';
const top3BrandRevShare = totalRevenue > 0 ? (brandRevenueSorted.slice(0, 3).reduce((s, b) => s + b[1], 0) / totalRevenue * 100).toFixed(1) : '0';
const top5BrandRevShare = totalRevenue > 0 ? (brandRevenueSorted.slice(0, 5).reduce((s, b) => s + b[1], 0) / totalRevenue * 100).toFixed(1) : '0';
const brandRevDispersion = totalRevenue > 0 ? (100 - parseFloat(top5BrandRevShare)).toFixed(1) : '0';
const top10BrandByRevenue = brandRevenueSorted.slice(0, 10).map(([b, r]) => ({
  brand: b,
  revenue: r,
  share: totalRevenue > 0 ? ((r / totalRevenue) * 100).toFixed(1) : '0'
}));

// --- 3. Entry barriers ---
function detectEntryBarriers() {
  const barriers = [];
  const avgPriceNum = data.length > 0 ? data.reduce((s, d) => s + (parseFloat((d.price || '').replace('$', '')) || 0), 0) / data.length : 0;
  if (avgPriceNum > 50) barriers.push('高单价（平均 $' + avgPriceNum.toFixed(0) + '）会提高资金门槛');
  const hasWeight = data.some(d => d.weight && d.weight !== '' && d.weight !== '0');
  if (hasWeight) barriers.push('涉及重量/大件，物流成本可能较高');
  const certKeywords = ['FDA', 'UL', 'FCC', 'CE ', 'CPSC', 'EPA', 'DOT'];
  const certProducts = data.filter(d => certKeywords.some(k => (d.title || '').toUpperCase().includes(k)));
  if (certProducts.length > 3) barriers.push('部分产品涉及认证关键词：' + certKeywords.filter(k => data.some(d => (d.title || '').toUpperCase().includes(k))).join('/'));
  const amzCount = data.filter(d => d.sellerType?.includes('亚马逊')).length;
  if (amzCount > data.length * 0.2) barriers.push('亚马逊自营占比 ' + ((amzCount / data.length) * 100).toFixed(0) + '%，平台强势介入');
  if (barriers.length === 0) barriers.push('暂未发现明显进入限制（仍需补充认证、专利和供应链核验）');
  return barriers;
}
const entryBarriers = detectEntryBarriers();

// --- 4. 鏂板搧鍒嗘瀽澧炲己 ---
const newProductsWithBrand = newProductsData.filter(d => d.brand && brandSalesSorted.slice(0, 10).some(([b]) => b === d.brand));
const newBrandCount = new Set(newProductsData.map(d => d.brand).filter(Boolean)).size;
const newProductsAboveTarget = newProductsData.filter(d => d.bsr <= bsrMax).length;

// --- 5. Review barrier analysis ---
// Oalur exports Ratings count here, not Amazon review count. Estimate reviews as 8% of ratings.
const REVIEW_ESTIMATE_RATE = 0.08;
function parseRatingCount(d) {
  if (!d.ratings) return 0;
  const n = parseInt(d.ratings.replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}
function parseReviewCount(d) {
  return Math.round(parseRatingCount(d) * REVIEW_ESTIMATE_RATE);
}
const reviewRanges = [
  { label: '< 50', min: 0, max: 50 },
  { label: '50 - 100', min: 50, max: 100 },
  { label: '100 - 300', min: 100, max: 300 },
  { label: '300 - 600', min: 300, max: 600 },
  { label: '600+', min: 600, max: 999999 }
];
const reviewDist = reviewRanges.map(r => ({
  label: r.label,
  count: data.filter(d => { const rc = parseReviewCount(d); return rc >= r.min && rc < r.max; }).length
}));
const lowReviewCount = data.filter(d => parseReviewCount(d) < 500).length;
const lowReviewPct = data.length > 0 ? ((lowReviewCount / data.length) * 100).toFixed(1) : '0';
const avgReviews = data.length > 0 ? Math.round(data.reduce((s, d) => s + parseReviewCount(d), 0) / data.length).toLocaleString() : '-';

// Top 20 review analysis by BSR.
const top20ByBsr = [...data].sort((a, b) => (a.bsr || 999999) - (b.bsr || 999999)).slice(0, 20);
const top20Reviews = top20ByBsr.map(d => parseReviewCount(d)).filter(n => n > 0).sort((a, b) => a - b);
const top20AvgReviews = top20ByBsr.length > 0 ? Math.round(top20ByBsr.reduce((s, d) => s + parseReviewCount(d), 0) / top20ByBsr.length).toLocaleString() : '-';
const top20ReviewMedian = top20Reviews.length > 0 ? (top20Reviews.length % 2 !== 0 ? top20Reviews[Math.floor(top20Reviews.length / 2)] : Math.round((top20Reviews[top20Reviews.length / 2 - 1] + top20Reviews[top20Reviews.length / 2]) / 2)) : 0;
const top20LowReviewCount = top20ByBsr.filter(d => parseReviewCount(d) < 100).length; // 鐭ヨ瘑搴撴爣鍑嗭細鍓?0涓?100鏉＄殑鏁伴噺

// Global review median.
const allReviewNums = data.map(d => parseReviewCount(d)).filter(n => n > 0).sort((a, b) => a - b);
const reviewMedian = allReviewNums.length > 0 ? (allReviewNums.length % 2 !== 0 ? allReviewNums[Math.floor(allReviewNums.length / 2)] : Math.round((allReviewNums[allReviewNums.length / 2 - 1] + allReviewNums[allReviewNums.length / 2]) / 2)) : 0;

// --- 6. 鍗栧鎬ц川涓庡競鍦虹粨鏋勶紙鎸夐浼伴攢閲忥級 ---
const sellerSales = {};
data.forEach(d => {
  const st = d.sellerType?.includes('亚马逊') ? '亚马逊自营' : d.sellerType?.includes('FBA') ? 'FBA' : d.sellerType?.includes('FBM') ? 'FBM' : '其他';
  sellerSales[st] = (sellerSales[st] || 0) + parseSalesNum(d);
});
const sellerSalesSorted = Object.entries(sellerSales).sort((a, b) => b[1] - a[1]);
const topSellerType = sellerSalesSorted[0] || ['-', 0];
const topSellerShare = totalSales > 0 ? ((topSellerType[1] / totalSales) * 100).toFixed(1) : '0';

// --- Competition summary ---
let compConclusion, compConclusionClass, compReasons = [];
if (parseFloat(top1ItemShare) > 30) {
  compReasons.push('TOP1 单品占比 ' + top1ItemShare + '%，高于 30%，存在单品集中风险');
} else {
  compReasons.push('TOP1 单品占比 ' + top1ItemShare + '%，低于 30%，竞争相对分散');
}
if (parseFloat(top3ItemShare) > 45) {
  compReasons.push('TOP3 单品合计 ' + top3ItemShare + '%，高于 45%，头部集中');
} else {
  compReasons.push('TOP3 单品合计 ' + top3ItemShare + '%，低于 45%，无明显头部垄断');
}
if (parseFloat(top1BrandShare) > 30) {
  compReasons.push('TOP1 品牌份额 ' + top1BrandShare + '%，高于 30%，品牌集中度偏高');
} else {
  compReasons.push('TOP1 品牌份额 ' + top1BrandShare + '%，低于 30%，无明显垄断品牌');
}
if (brandCr3 >= 60) {
  compReasons.push('品牌 CR3 ' + top3BrandShare + '%，高于 60%，高垄断');
} else if (brandCr3 >= 40) {
  compReasons.push('品牌 CR3 ' + top3BrandShare + '%，处于 40%-60%，中度垄断');
} else {
  compReasons.push('品牌 CR3 ' + top3BrandShare + '%，低于 40%，品牌竞争分散');
}
if (parseFloat(brandDispersion) > 40) {
  compReasons.push('品牌分散度 ' + brandDispersion + '%，高于 40%，属于竞争型市场');
} else {
  compReasons.push('品牌分散度 ' + brandDispersion + '%，低于 40%，市场偏集中');
}
if (topSellerType[0] === '亚马逊自营' && parseFloat(topSellerShare) > 50) {
  compReasons.push('亚马逊自营销量占比 ' + topSellerShare + '%，高于 50%，平台强势介入');
} else {
  compReasons.push('卖家结构正常：最大类型为 ' + topSellerType[0] + '，占比 ' + topSellerShare + '%；FBA/FBM 只是履约方式');
}
if (parseFloat(pureNewPct) > 10) {
  compReasons.push('6 个月内纯新父体 ' + pureNewProductsData.length + ' 个（' + pureNewPct + '%），市场有活力');
} else {
  compReasons.push('6 个月内纯新父体仅 ' + pureNewProductsData.length + ' 个（' + pureNewPct + '%），市场偏固化；父体新品子ASIN只作为辅助');
}
if (top20AvgReviews !== '-' && parseInt(top20AvgReviews.replace(/,/g, '')) < 600) {
  compReasons.push('前 20 名预估评论 ' + top20AvgReviews + '，低于 600，评论壁垒低');
} else {
  compReasons.push('前 20 名预估评论 ' + top20AvgReviews + '，高于 600，评论壁垒较高');
}
if (reviewMedian < 350) {
  compReasons.push('预估评论中位数 ' + reviewMedian.toLocaleString() + '，低于 350');
} else {
  compReasons.push('预估评论中位数 ' + reviewMedian.toLocaleString() + '，高于 350，历史积累较深');
}
if (top20LowReviewCount >= 3) {
  compReasons.push('前 20 名中有 ' + top20LowReviewCount + ' 个预估评论数低于 100，新品仍有挤入机会');
} else {
  compReasons.push('前 20 名中仅 ' + top20LowReviewCount + ' 个预估评论数低于 100，前排评论壁垒高');
}
if (parseFloat(lowReviewPct) > 30) {
  compReasons.push('预估评论数 < 500 的产品占 ' + lowReviewPct + '%，整体评论门槛不算极端');
}
compReasons.push('<strong>口径说明：</strong>当前 Oalur 字段为 Ratings 数，报告按 Ratings × 8% 估算评论数；评论壁垒需同时看前 20 平均值、中位数、低评论产品数量。');

function passText(ok) {
  return ok ? '<span style="color:#237804;font-weight:600;">通过</span>' : '<span style="color:#ad6800;font-weight:600;">需关注</span>';
}

const compCheckRows = [
  {
    dim: '单品集中度',
    current: `TOP1 ${top1ItemShare}%；TOP3 ${top3ItemShare}%`,
    standard: 'TOP1 <30%；TOP3 <45%',
    result: passText(parseFloat(top1ItemShare) < 30 && parseFloat(top3ItemShare) < 45),
    note: parseFloat(top3ItemShare) < 45 ? '头部单品未形成明显垄断。' : '头部单品拿走较多销量，跟卖/同质化风险高。'
  },
  {
    dim: '品牌 CR3',
    current: `TOP1 ${top1BrandShare}%；CR3 ${top3BrandShare}%（${brandCr3Level}）`,
    standard: brandCr3Standard,
    result: passText(brandCr3 < 40),
    note: brandCr3 < 40 ? '品牌 CR3 低，头部品牌未形成强垄断。' : brandCr3 < 60 ? '中度垄断，需要差异化竞争。' : '高垄断，新品牌进入压力大。'
  },
  {
    dim: '品牌分散度',
    current: `${brandDispersion}%`,
    standard: '>40%',
    result: passText(parseFloat(brandDispersion) > 40),
    note: parseFloat(brandDispersion) > 40 ? '非头部品牌仍有较大销量空间。' : '尾部空间偏小。'
  },
  {
    dim: '评论壁垒',
    current: `前20预估均评 ${top20AvgReviews}；预估中位数 ${reviewMedian.toLocaleString()}；前20低预估评论数 ${top20LowReviewCount} 个`,
    standard: '前20预估均评 <600；预估中位数 <350；前20预估评论数<100的产品 >=3',
    result: passText(top20AvgReviews !== '-' && parseInt(top20AvgReviews.replace(/,/g, '')) < 600 && reviewMedian < 350 && top20LowReviewCount >= 3),
    note: 'Oalur 当前抓取的是 Ratings，按 8% 折算为预估评论数；低评论数不是低评分。'
  },
  {
    dim: '平台介入',
    current: `${topSellerType[0]} ${topSellerShare}%`,
    standard: '亚马逊自营 <50%',
    result: passText(!(topSellerType[0] === '亚马逊自营' && parseFloat(topSellerShare) > 50)),
    note: 'FBA/FBM 是履约方式，不等同平台垄断。'
  },
  {
    dim: '新品活跃度',
    current: `<6个月纯新父体 ${pureNewProductsData.length} 个（${pureNewPct}%）；<12个月纯新父体 ${pureUnder12mData.length} 个（${under12mPctNum.toFixed(1)}%）`,
    standard: '<6个月纯新父体 >10% 或 <12个月纯新父体 >=8%',
    result: passText(parseFloat(pureNewPct) > 10 || under12mPctNum >= 8),
    note: '新品活跃度以纯新父体为主；老父体新增子ASIN只作为辅助。'
  }
];

const compCheckRowsHtml = compCheckRows.map(row => `
  <tr>
    <td>${row.dim}</td>
    <td>${row.current}</td>
    <td>${row.standard}</td>
    <td>${row.result}</td>
    <td>${row.note}</td>
  </tr>
`).join('');

// Overall conclusion: FBA/FBM is logistics mode, not a monopoly signal.
const hasMonopoly = parseFloat(top1ItemShare) > 30 || brandCr3 >= 60;
const isAmazonMonopoly = topSellerType[0] === '亚马逊自营' && parseFloat(topSellerShare) > 50;
if (isAmazonMonopoly) {
  compConclusion = '亚马逊自营强势介入，建议放弃';
  compConclusionClass = 'fail';
} else if (hasMonopoly) {
  compConclusion = '品牌/单品集中度偏高，竞争激烈';
  compConclusionClass = 'caution';
} else if (parseFloat(pureNewPct) < 5 && data.length > 30) {
  compConclusion = '市场偏固化，新品机会有限';
  compConclusionClass = 'caution';
} else if (parseFloat(brandDispersion) > 40 && parseFloat(top1ItemShare) < 15) {
  compConclusion = '竞争分散，有切入机会';
  compConclusionClass = 'pass';
} else {
  compConclusion = '竞争中等，需要差异化切入';
  compConclusionClass = 'caution';
}
const compCompactSummary = `${compConclusion}。核心证据：TOP3 单品 ${top3ItemShare}%，品牌 CR3 ${top3BrandShare}%（${brandCr3Level}），品牌分散度 ${brandDispersion}%，前20预估评论 ${top20AvgReviews}，<12个月纯新父体销量占比 ${under12mShare}%。`;

// Competition standards reference from the local knowledge base.
const compStandardsRef = `
<div class="card">
  <h2>量化标准参考（知识库）</h2>
  <p style="color:#666;font-size:13px;margin-bottom:12px;">
    以下为知识库中的选品量化标准，与当前抓取数据做对比。
  </p>
  <table>
    <tr><th>维度</th><th>知识库标准</th><th>当前值</th><th>判定</th></tr>
    <tr><td>TOP1 单品销量占比</td><td>&lt; 30%</td><td>${top1ItemShare}%</td><td>${parseFloat(top1ItemShare) < 30 ? '达标' : '未达标'}</td></tr>
    <tr><td>TOP3 单品销量合计</td><td>&lt; 45%</td><td>${top3ItemShare}%</td><td>${parseFloat(top3ItemShare) < 45 ? '达标' : '未达标'}</td></tr>
    <tr><td>TOP1 品牌份额</td><td>&lt; 28%</td><td>${top1BrandShare}%</td><td>${parseFloat(top1BrandShare) < 28 ? '达标' : '未达标'}</td></tr>
    <tr><td>TOP3 品牌合计</td><td>&lt; 45%</td><td>${top3BrandShare}%</td><td>${parseFloat(top3BrandShare) < 45 ? '达标' : '未达标'}</td></tr>
    <tr><td>品牌分散度</td><td>&gt; 40%</td><td>${brandDispersion}%</td><td>${parseFloat(brandDispersion) > 40 ? '达标' : '未达标'}</td></tr>
    <tr><td>前 20 平均预估评论数</td><td>&lt; 600</td><td>${top20AvgReviews}</td><td>${top20AvgReviews !== '-' && parseInt(top20AvgReviews.replace(/,/g, '')) < 600 ? '达标' : '未达标'}</td></tr>
    <tr><td>预估评论中位数</td><td>&lt; 350</td><td>${reviewMedian.toLocaleString()}</td><td>${reviewMedian < 350 ? '达标' : '未达标'}</td></tr>
    <tr><td>前 20 中预估评论 &lt;100 的产品数</td><td>&gt;= 3 个</td><td>${top20LowReviewCount} 个</td><td>${top20LowReviewCount >= 3 ? '达标' : '未达标'}</td></tr>
    <tr><td>Oalur 平均毛利率</td><td>美国 ≥35%，严格 ≥40%</td><td>${avgMarginPct == null ? '未采集' : avgMarginPct.toFixed(1) + '%'}</td><td>${avgMarginPct == null ? '未分析' : avgMarginPct >= 40 ? '稳健' : avgMarginPct >= 35 ? '过底线' : '未达标'}</td></tr>
    <tr><td>纯新父体占比（&lt;6个月）</td><td>存在可观察纯新父体</td><td>${pureNewProductsData.length} 个（${pureNewPct}%）</td><td>${parseFloat(pureNewPct) > 10 ? '活跃' : '偏少'}</td></tr>
    <tr><td>纯新父体存活率（6个月）</td><td>&gt;= 35%</td><td>${survivalRateData ? survivalRateData.survivalRateStr : '未分析'}</td><td>${survivalRateData ? (survivalRateData.hasNoNewProducts ? '样本0，中性4/10' : (survivalRateData.survivalRate >= 35 ? '达标' : '未达标')) : '未分析'}</td></tr>
  </table>
  <div style="margin-top:12px;padding:8px 12px;background:#f0f5ff;border-radius:6px;font-size:12px;color:#666;line-height:1.8;">
    <strong>知识库来源：</strong>市场竞争量化、利润与销量取舍、新品存活率、评论壁垒判断。
  </div>
</div>`;

// 璇诲彇妯℃澘
let html = fs.readFileSync(path.join(__dirname, 'report-template.html'), 'utf-8');

// Placeholder replacements.
const replacements = {
  '{{KEYWORD}}': jsonData.keyword || '未知',
  '{{DATE}}': REPORT_DATE,
  '{{MAX_BSR}}': bsrMax.toLocaleString(),
  '{{TARGET_CATEGORY}}': targetCategoryDisplay,
  '{{TARGET_CATEGORY_SELECTION_NOTE}}': targetCategorySelectionNote,
  '{{RESCUE_CATEGORIES}}': rescueCategoryDisplay,
  '{{RESCUE_PRICE_RULE}}': rescuePriceRuleText,
  '{{ALL_COUNT}}': jsonData.allCount || 0,
  '{{FILTERED_COUNT}}': data.length,
  '{{EXCLUDED_COUNT}}': excluded.length,
  '{{RAW_TOTAL}}': rawTotal,
  '{{TOTAL}}': total,
  '{{KEYWORD_INTENT_RESCUED_COUNT}}': keywordIntentRescuedCount,
  '{{NEW_PCT}}': pureNewPct,
  '{{SALES_MEDIAN}}': salesMedian.toLocaleString(),
  '{{SALES_AVG}}': salesAvg.toLocaleString(),
  '{{SALES_MAX}}': salesMax.toLocaleString(),
  '{{SALES_MIN}}': salesMin.toLocaleString(),
  '{{SALES_FLOOR_EXPANSION_BLOCK}}': salesFloorExpansionBlock,
  '{{REV_MEDIAN}}': '$' + Math.round(revMedian).toLocaleString(),
  '{{REV_AVG}}': '$' + Math.round(revAvg).toLocaleString(),
  '{{REV_MAX}}': '$' + Math.round(revMax).toLocaleString(),
  '{{REV_MIN}}': '$' + Math.round(revMin).toLocaleString(),
  '{{TOTAL_REVENUE}}': '$' + Math.round(totalRev).toLocaleString(),
  '{{TOTAL_SALES}}': totalSales.toLocaleString(),
  '{{PROFIT_BLOCK}}': '',
  '{{AVG_FBA_FEE}}': avgFbaFee == null ? '未采集' : '$' + avgFbaFee.toFixed(2),
  '{{AVG_MARGIN_PCT}}': avgMarginPct == null ? '未采集' : avgMarginPct.toFixed(1) + '%',
  '{{SALES_WEIGHTED_MARGIN_PCT}}': salesWeightedMarginPct == null ? '未采集' : salesWeightedMarginPct.toFixed(1) + '%',
  '{{AVG_FBA_RATIO}}': avgFbaRatio == null ? '未采集' : avgFbaRatio.toFixed(1) + '%',
  '{{MARGIN_PASS35_COUNT}}': marginPass35,
  '{{MARGIN_PASS40_COUNT}}': marginPass40,
  '{{MARGIN_BELOW35_COUNT}}': marginBelow35,
  '{{MARGIN_MISSING_COUNT}}': marginMissing,
  '{{NEW_SALES_MEDIAN}}': newSalesMedian.toLocaleString(),
  '{{NEW_SALES_AVG}}': newSalesAvg.toLocaleString(),
  '{{NEW_SALES_MAX}}': newSalesMax.toLocaleString(),
  '{{NEW_TOP_SHARE}}': newTopShare,
  '{{NEW_MEDIAN_SHARE}}': newMedianShare,
  '{{NEW_SALES_SUMMARY}}': newSalesSummary,
  '{{NEW_SALES_SUMMARY_COLOR}}': newSalesSummaryColor,
  '{{SURVIVAL_SUMMARY}}': survivalSummary,
  '{{SURVIVAL_SUMMARY_COLOR}}': survivalSummaryColor,
  '{{KEYWORD_RECOMMENDATION_BLOCK}}': '',
  '{{UNDER12M_COUNT}}': pureUnder12mData.length,
  '{{UNDER12M_PCT}}': under12mPctNum.toFixed(1),
  '{{UNDER12M_SALES_MAX}}': under12mMax.toLocaleString(),
  '{{UNDER12M_SALES_MEDIAN}}': under12mMedian.toLocaleString(),
  '{{UNDER12M_SALES_AVG}}': under12mAvg.toLocaleString(),
  '{{UNDER12M_TOTAL}}': under12mTotal.toLocaleString(),
  '{{UNDER12M_SHARE}}': under12mShare,
  '{{UNDER12M_MAX_SHARE}}': under12mMaxShare,
  '{{UNDER12M_MEDIAN_SHARE}}': under12mMedianShare,
  '{{UNDER12M_SUMMARY}}': under12mSummary,
  '{{UNDER12M_LEVEL}}': under12mLevel,
  '{{SURVIVAL_INTEGRATED_SUMMARY}}': survivalIntegratedSummary,
  '{{TIME_RANGE}}': jsonData.timeFilter || '最近30天',
  '{{MAX_BSR_VAL}}': maxBsrVal,
  '{{AVG_PRICE}}': avgPrice,
  '{{STEP1}}': data.length > 30 ? '超过30个' : '不足30个',
  '{{TOP10_BSR}}': top10Bsr,
  '{{GAP_TEXT}}': gapText,
  '{{STEP3}}': hasGap ? '存在断层' : '分布均匀',
  '{{NEW_COUNT}}': pureNewProducts,
  '{{STEP4}}': parseFloat(pureNewPct) > 10 ? '纯新父体活跃' : '纯新父体偏少',
  '{{CONCLUSION}}': conclusion,
  '{{CONCLUSION_CLASS}}': conclusionClass,
  '{{REASON}}': reason,
  '{{CAPACITY_STANDARD_TEXT}}': capacityStandardText,
  '{{BSR_LABELS}}': JSON.stringify(bsrDist.map(r => r.label)),
  '{{BSR_DATA}}': JSON.stringify(bsrDist.map(r => r.count)),
  '{{AGE_LABELS}}': JSON.stringify(ageDist.map(r => r.label)),
  '{{AGE_DATA}}': JSON.stringify(ageDist.map(r => r.count)),
  '{{PRICE_LABELS}}': JSON.stringify(priceDist.map(r => r.label)),
  '{{PRICE_DATA}}': JSON.stringify(priceDist.map(r => r.count)),
  // 绔炰簤鍒嗘瀽
  '{{TOP1_ITEM_SHARE}}': top1ItemShare,
  '{{TOP1_ITEM_ASIN}}': top1ItemAsin,
  '{{TOP5_ITEM_SHARE}}': top5ItemShare,
  '{{TOP10_ITEM_SHARE}}': top10ItemShare,
  '{{TOP3_ITEM_SHARE}}': top3ItemShare,
  '{{TOP1_ITEM_CLASS}}': parseFloat(top1ItemShare) > 30 ? 'warn' : 'ok',
  '{{TOP3_ITEM_CLASS}}': parseFloat(top3ItemShare) > 45 ? 'warn' : 'ok',
  '{{TOP3_BRAND_CLASS}}': brandCr3 >= 40 ? 'warn' : 'ok',
  '{{BRAND_DISP_CLASS}}': parseFloat(brandDispersion) > 40 ? 'ok' : 'warn',
  '{{TOP1_ITEM_REV_SHARE}}': top1ItemRevShare,
  '{{TOP1_ITEM_REV_ASIN}}': top1ItemRevAsin,
  '{{TOP5_ITEM_REV_SHARE}}': top5ItemRevShare,
  '{{TOP10_ITEM_REV_SHARE}}': top10ItemRevShare,
  '{{TOP3_ITEM_REV_SHARE}}': top3ItemRevShare,
  '{{TOP1_BRAND}}': top1Brand[0],
  '{{TOP1_BRAND_SHARE}}': top1BrandShare,
  '{{TOP3_BRAND_SHARE}}': top3BrandShare,
  '{{TOP5_BRAND_SHARE}}': top5BrandShare,
  '{{BRAND_DISPERSION}}': brandDispersion,
  '{{AVG_REVIEWS}}': avgReviews,
  '{{REVIEW_MEDIAN}}': reviewMedian.toLocaleString(),
  '{{TOP20_AVG_REVIEWS}}': top20AvgReviews,
  '{{TOP20_REVIEW_MEDIAN}}': top20ReviewMedian.toLocaleString(),
  '{{TOP20_LOW_REVIEW_COUNT}}': top20LowReviewCount,
  '{{LOW_REVIEW_COUNT}}': lowReviewCount,
  '{{LOW_REVIEW_PCT}}': lowReviewPct,
  '{{TOP_SELLER_TYPE}}': topSellerType[0],
  '{{TOP_SELLER_SHARE}}': topSellerShare,
  '{{COMP_CONCLUSION}}': compConclusion,
  '{{COMP_CONCLUSION_CLASS}}': compConclusionClass,
  '{{COMP_CHECK_ROWS}}': compCheckRowsHtml,
  '{{COMP_COMPACT_SUMMARY}}': compCompactSummary,
  '{{COMP_STANDARDS_REF}}': '',
  // Survival rate.
  '{{SURVIVAL_RATE}}': survivalRateData ? survivalRateData.survivalRateStr : '未分析',
  '{{SURVIVAL_LEVEL}}': survivalRateData ? survivalRateData.level : '未分析',
  '{{SURVIVAL_LEVEL_CLASS}}': survivalRateData ? survivalRateData.levelClass : '',
  '{{SURVIVAL_HIST_NEW}}': survivalRateData ? survivalRateData.histNewCount : 0,
  '{{SURVIVAL_SURVIVING}}': survivalRateData ? survivalRateData.survivingCount : 0,
  '{{HISTORICAL_PERIOD}}': survivalRateData ? survivalRateData.historicalPeriod : '最近30天',
  '{{SURVIVAL_HTML}}': survivalRateData ? `
<div class="card">
  <h2>6 个月纯新父体存活率</h2>
  <div style="padding:12px;background:#f9f9f9;border-radius:8px;font-size:13px;line-height:1.8;">
    <strong>计算方法：</strong>${survivalRateData.historicalPeriod} 时 BSR 范围内上架 &lt;6个月的纯新父体 Listing，到当前仍在目标类目/有效 BSR 区间内的比例。纯新父体要求代表 ASIN 与父体下全部已抓子 ASIN 都 &lt;6个月；任一子 ASIN 上架时间缺失或 >=6个月，均不计入纯新父体。该指标是“有效 BSR 区间存活率”，不是 Amazon 仍在售率。<br>
    <strong>历史基准窗口：</strong>机械向前 6 个月候选为 ${survivalRateData.baselineInfo?.rawTargetLabel || '--'}；推荐正常窗口为 ${survivalRateData.baselineInfo?.windowLabel || '--'}。${survivalRateData.periodCheck?.message || ''}
  </div>
  <div style="margin-top:12px;padding:12px;background:#f0f5ff;border-radius:8px;font-size:13px;line-height:1.8;">
    <strong>存活率评分（10分）：</strong>${survivalRateData.survivalScore ?? 0}/10<br>
    样本量可信度：${survivalRateData.survivalSampleScore ?? 0}/2（历史纯新父体 ${survivalRateData.histNewCount} 个） |
    有效 BSR 存活率：${survivalRateData.survivalRateScore ?? 0}/5（${survivalRateData.survivalRateStr}） |
    存活父体销量质量：${survivalRateData.survivalSalesQualityScore ?? 0}/3（存活父体销量中位数 ${Number(survivalRateData.survivedSalesMedian || 0).toLocaleString()}，当前市场中位数 ${Number(survivalRateData.currentSalesMedian || 0).toLocaleString()}）${survivalRateData.hasNoNewProducts ? '<br><strong>样本0口径：</strong>历史窗口没有可验证纯新父体样本时，该项按中性 4/10 计入，不把“无样本”当作“新品失败”。' : ''}
  </div>
  <div class="conclusion ${survivalRateData.levelClass}">存活率 ${survivalRateData.survivalRateStr} - ${survivalRateData.level}</div>
  ${survivalRateData.histNewRows ? `<table style="margin-top:16px;"><tr><th>父体/代表ASIN</th><th>品牌</th><th>上架时间</th><th>全部子ASIN数</th><th>状态</th><th>当前销量</th></tr>${survivalRateData.histNewRows}</table>` : ''}
</div>
` : '',
  '{{CAPACITY_SUMMARY}}': conclusion,
  '{{CAPACITY_SUMMARY_CLASS}}': conclusionClass,
  '{{CAPACITY_SUMMARY_COLOR}}': conclusionClass === 'pass' ? '#52c41a' : conclusionClass === 'caution' ? '#faad14' : '#ff4d4f',
  '{{CAPACITY_SUMMARY_SHORT}}': conclusion.replace(/<br>.*$/, '').replace(/^[鉁呪殸锔忊潓]\s*/, ''),
  '{{COMP_SUMMARY}}': compConclusion,
  '{{COMP_SUMMARY_CLASS}}': compConclusionClass,
  '{{COMP_SUMMARY_COLOR}}': compConclusionClass === 'pass' ? '#52c41a' : compConclusionClass === 'caution' ? '#faad14' : '#ff4d4f',
  '{{SEASONALITY_SUMMARY}}': '<span style="color:#999">未分析</span>',
  '{{SEASONALITY_SUMMARY_CLASS}}': '',
  '{{BRAND_LABELS}}': JSON.stringify(topBrands.map(([b]) => b)),
  '{{BRAND_DATA}}': JSON.stringify(topBrands.map(([, c]) => c)),
  '{{TOP10_BRAND_SALES_LABELS}}': JSON.stringify(top10BrandBySales.map(b => b.brand)),
  '{{TOP10_BRAND_SALES_DATA}}': JSON.stringify(top10BrandBySales.map(b => parseFloat(b.share))),
  '{{TOP10_BRAND_REV_LABELS}}': JSON.stringify(top10BrandByRevenue.map(b => b.brand)),
  '{{TOP10_BRAND_REV_DATA}}': JSON.stringify(top10BrandByRevenue.map(b => parseFloat(b.share))),
  '{{TOP1_BRAND_REV}}': top1BrandRev[0],
  '{{TOP1_BRAND_REV_SHARE}}': top1BrandRevShare,
  '{{TOP3_BRAND_REV_SHARE}}': top3BrandRevShare,
  '{{TOP5_BRAND_REV_SHARE}}': top5BrandRevShare,
  '{{BRAND_REV_DISPERSION}}': brandRevDispersion,
  '{{REVIEW_LABELS}}': JSON.stringify(reviewDist.map(r => r.label)),
  '{{REVIEW_DATA}}': JSON.stringify(reviewDist.map(r => r.count)),
  '{{SELLER_SALES_LABELS}}': JSON.stringify(sellerSalesSorted.map(s => s[0])),
  '{{SELLER_SALES_DATA}}': JSON.stringify(sellerSalesSorted.map(s => totalSales > 0 ? parseFloat(((s[1] / totalSales) * 100).toFixed(1)) : 0)),
  '{{LIFECYCLE_BLOCK}}': '',
  '{{KNOWLEDGE_AUDIT_BLOCK}}': '',
  '{{EXCLUDED_CATEGORY_SUMMARY_BLOCK}}': buildExcludedCategorySummaryBlock(jsonData, excluded),
  '{{BSR_INSIGHT}}': '',
  '{{AGE_INSIGHT}}': '',
  '{{PRICE_INSIGHT}}': '',
};

// Competition standards are rendered in the compact competition table.
replacements['{{COMP_STANDARDS_REF}}'] = '';

// ============ Knowledge insights ============

// BSR distribution insight.
const bsrGaps = bsrDist.filter(r => r.count === 0).map(r => r.label);
const maxCountInterval = bsrDist.reduce((a, b) => a.count > b.count ? a : b, bsrDist[0]);
const denseIntervals = bsrDist.filter(r => r.count >= Math.max(3, data.length / bsrSegmentCount * 1.5));
replacements['{{BSR_INSIGHT}}'] = `
<div style="margin-top:12px;padding:10px 14px;background:#f0f5ff;border-radius:8px;font-size:12px;color:#555;line-height:1.9;">
  <strong>知识库解读：</strong>使用 ${bsrInterval} 排名等宽区间观察容量连续性。最密集区间为 <strong>${maxCountInterval.label}</strong>，包含 ${maxCountInterval.count} 个产品。<br>
  ${bsrGaps.length > 0 ? `发现断层区间：<strong>${bsrGaps.join('、')}</strong>，需关注需求不连续或竞争结构特殊。` : '未发现断层，BSR 分布较连续。'}<br>
  ${parseFloat(top1ItemShare) > 30 ? 'TOP1 单品占比超过 30%，头部集中度偏高。' : 'TOP1 单品占比未超过 30%，头部集中度可接受。'}
</div>`;

// Listing age insight.
const oldCount = data.filter(d => { const m = parseAge(d); return m >= 36; }).length;
const midCount = data.filter(d => { const m = parseAge(d); return m >= 12 && m < 36; }).length;
replacements['{{AGE_INSIGHT}}'] = `
<div style="margin-top:12px;padding:10px 14px;background:#f0f5ff;border-radius:8px;font-size:12px;color:#555;line-height:1.9;">
  <strong>知识库解读：</strong>6 个月内纯新父体 ${pureNewProductsData.length} 个，占 ${pureNewPct}%；父体新品子ASIN样本 ${newProductsData.length} 个；3 年以上老品 ${oldCount} 个，占 ${(oldCount / Math.max(data.length, 1) * 100).toFixed(0)}%。<br>
  ${parseFloat(pureNewPct) > 10 ? '纯新父体占比尚可，说明市场仍有全新 Listing 进入。' : '纯新父体占比偏少，说明市场可能偏固化；老父体新增子ASIN不能单独证明新品冷启动能力。'}
</div>`;

// Price distribution insight.
const priceNums = data.map(d => parseFloat((d.price || '').replace('$', ''))).filter(p => !isNaN(p) && p > 0);
const priceMedian = priceNums.length > 0 ? priceNums.sort((a,b)=>a-b)[Math.floor(priceNums.length/2)] : 0;
const lowPricePct = priceNums.length > 0 ? (priceNums.filter(p => p < 10).length / priceNums.length * 100).toFixed(0) : '0';
const midPricePct = priceNums.length > 0 ? (priceNums.filter(p => p >= 10 && p < 20).length / priceNums.length * 100).toFixed(0) : '0';
replacements['{{PRICE_INSIGHT}}'] = `
<div style="margin-top:12px;padding:10px 14px;background:#f0f5ff;border-radius:8px;font-size:12px;color:#555;line-height:1.9;">
  <strong>知识库解读：</strong>价格中位数 $${priceMedian.toFixed(2)}，均价 ${avgPrice}；低于 $10 的产品占 ${lowPricePct}%，$10-$20 的产品占 ${midPricePct}%。<br>
  ${parseInt(lowPricePct) > 50 ? '低价产品占比高，利润和广告容错空间需要重点核算。' : '低价产品占比可控，但仍需补齐采购、FBA、头程和退货成本。'}
</div>`;

const profitRows = profitDetails
  .slice()
  .sort((a, b) => b.sales - a.sales)
  .map((d, i) => {
    const marginText = d.marginPct == null ? '-' : d.marginPct.toFixed(1) + '%';
    const fbaText = d.fbaFee == null ? '-' : '$' + d.fbaFee.toFixed(2);
    const fbaRatioText = d.fbaRatio == null ? '-' : d.fbaRatio.toFixed(1) + '%';
    const priceText = d.price > 0 ? '$' + d.price.toFixed(2) : '-';
    const unitProfitText = d.unitGrossProfit == null ? '-' : '$' + d.unitGrossProfit.toFixed(2);
    return `<tr>
      <td>${i + 1}</td>
      <td><a href="https://www.amazon.com/dp/${escapeHtml(d.asin)}" target="_blank">${escapeHtml(d.asin)}</a></td>
      <td style="max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(d.title)}">${escapeHtml(d.title.substring(0, 80))}</td>
      <td>${priceText}</td>
      <td>${fbaText}</td>
      <td>${fbaRatioText}</td>
      <td>${marginText}</td>
      <td>${unitProfitText}</td>
      <td>${d.sales.toLocaleString()}</td>
      <td>${escapeHtml(d.profitSourceLabel)}</td>
      <td><span class="${d.statusClass}">${d.status}</span></td>
    </tr>`;
  }).join('\n');

const priceBandProfitRows = priceBandProfitStats.map(row => `
      <tr>
        <td>${escapeHtml(row.label)}</td>
        <td>${row.count}</td>
        <td>${row.sales.toLocaleString()}</td>
        <td>${fmtPct(row.salesSharePct)}</td>
        <td>${fmtPct(row.weightedMarginPct)}</td>
        <td>${fmtMoney(row.weightedUnitGrossProfit)}</td>
        <td>${fmtPct(row.lowMarginSalesSharePct)}</td>
      </tr>`).join('');

function cpcRatioStyle(grade) {
  if (grade === '健康' || grade === '极佳' || grade === '良好') return 'color:#237804;font-weight:600;';
  if (grade === '可接受') return 'color:#3f6600;font-weight:600;';
  if (grade === '偏高' || grade === '一般') return 'color:#ad6800;font-weight:600;';
  return 'color:#cf1322;font-weight:600;';
}

const cpcSummary = cpcOpportunityData?.summary || null;
const cpcProducts = Array.isArray(cpcOpportunityData?.products) ? cpcOpportunityData.products : [];
const cpcMetricCpc = cpcSummary?.medianCpc ?? cpcSummary?.avgCpc ?? null;
const cpcMetricRatio = cpcSummary?.medianCpcPriceRatioPct ?? cpcSummary?.avgCpcPriceRatioPct ?? null;
const cpcMetricLabel = cpcSummary?.medianCpcPriceRatioPct == null ? '平均' : '中位';
const cpcSampleSelection = cpcOpportunityData?.sampleSelection || null;
const cpcOpportunityBlock = cpcSummary ? `
  <div style="margin-top:18px;padding:14px;background:#f6ffed;border:1px solid #b7eb8f;border-radius:8px;">
    <h3 style="margin-top:0;">CPC/客单价比值（广告成本快判）</h3>
    <div class="metric-grid">
      <div class="metric"><div class="value">${cpcMetricCpc == null ? '未采集' : '$' + Number(cpcMetricCpc).toFixed(2)}</div><div class="label">${cpcMetricLabel} CPC</div></div>
      <div class="metric"><div class="value">${cpcMetricRatio == null ? '未采集' : Number(cpcMetricRatio).toFixed(2) + '%'}</div><div class="label">${cpcMetricLabel} CPC/客单价</div></div>
      <div class="metric"><div class="value">${escapeHtml(cpcSummary.grade || '未分析')}</div><div class="label">知识库判定</div></div>
      <div class="metric"><div class="value">${cpcSummary.asinCount || cpcProducts.length}</div><div class="label">样本 ASIN</div></div>
    </div>
    <div style="font-size:13px;line-height:1.8;color:#555;margin-top:8px;">
      <strong>结论：</strong>${escapeHtml(cpcSummary.conclusion || '')}<br>
      <strong>样本口径：</strong>${escapeHtml(cpcSampleSelection?.source || '过滤后父体 Listing')}，优先按父体月销量取前 ${escapeHtml(cpcSampleSelection?.limit || 30)} 个，排除价格异常和 Ratings 缺失样本，报告主指标取中位数。<br>
      <strong>判断标准：</strong>CPC/客单价 &lt;5% 健康；5%-8% 可接受；8%-12% 偏高，需要强利润/强转化支撑；12%-15% 高风险；&ge;15% 很高风险。单看 CPC 绝对值无意义，必须结合客单价。
    </div>
    <div class="scroll-table" style="margin-top:12px;">
      <table>
        <tr><th>ASIN</th><th>售价</th><th>CPC</th><th>CPC/客单价</th><th>判定</th><th>类目</th></tr>
        ${cpcProducts.map(item => `
          <tr>
            <td><a href="https://www.amazon.com/dp/${escapeHtml(item.asin)}" target="_blank">${escapeHtml(item.asin)}</a></td>
            <td>${item.price == null ? '-' : '$' + Number(item.price).toFixed(2)}</td>
            <td>${item.avgCpc == null ? '-' : '$' + Number(item.avgCpc).toFixed(2)}</td>
            <td>${item.cpcPriceRatioPct == null ? '-' : Number(item.cpcPriceRatioPct).toFixed(2) + '%'}</td>
            <td><span style="${cpcRatioStyle(item.grade)}">${escapeHtml(item.grade || '-')}</span></td>
            <td style="max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(item.category || '')}">${escapeHtml(item.category || '-')}</td>
          </tr>`).join('')}
      </table>
    </div>
  </div>
` : `
  <div style="margin-top:18px;padding:12px;background:#fff7e6;border:1px solid #ffd591;border-radius:8px;font-size:13px;color:#555;">
    <strong>CPC/客单价比值：</strong>未加载 CPC 数据。可运行 <code>extract-cpc-opportunity.js</code> 生成 <code>*-cpc-opportunity.json</code> 后重新生成报告。
  </div>
`;

replacements['{{PROFIT_BLOCK}}'] = `
<div class="card">
  <h2>利润快筛（FBA & 毛利率）</h2>
  <div class="metric-grid">
    <div class="metric"><div class="value">${fmtPct(salesWeightedMarginPct)}</div><div class="label">销量加权毛利率</div></div>
    <div class="metric"><div class="value">${fmtPct(lowMarginSalesSharePct)}</div><div class="label">低毛利销量占比</div></div>
    <div class="metric"><div class="value">${fmtPct(salesWeightedFbaRatio)}</div><div class="label">销量加权 FBA/售价</div></div>
    <div class="metric"><div class="value">${fmtMoney(salesWeightedUnitGrossProfit)}</div><div class="label">销量加权单件毛利</div></div>
  </div>
  <div class="summary" style="margin-top:12px;">
    <div class="metric"><div class="value">${weightedMarginScore}/8</div><div class="label">加权毛利率得分</div></div>
    <div class="metric"><div class="value">${lowMarginSalesScore}/5</div><div class="label">低毛利销量得分</div></div>
    <div class="metric"><div class="value">${fbaPressureScore}/3</div><div class="label">FBA 压力得分</div></div>
    <div class="metric"><div class="value">${priceProfitStructureScore}/4</div><div class="label">价格带利润结构</div></div>
  </div>
  <div class="conclusion ${profitConclusionClass}" style="font-size:16px;text-align:left;line-height:1.8;">
    ${profitConclusion}<br>
    <small>知识库标准：美国站毛利率 ≥35% 为底线，≥40% 更稳；售价最好达到产品成本价 4-5 倍，有效成本率需 &gt;100%。当前 Oalur 字段只能做 FBA 与毛利率快筛，采购成本、头程、包装、CPC 和有效成本率仍需补采后复核。</small>
  </div>
  <div style="margin-top:16px;padding:12px;background:#f9f9f9;border-radius:8px;">
    <strong>利润快筛量化标准：</strong>
    <table style="margin-top:10px;">
      <tr><th>指标</th><th>通过/稳健</th><th>谨慎</th><th>不通过</th><th>当前值</th></tr>
      <tr><td>销量加权毛利率（8分）</td><td>≥45%</td><td>35%-45%</td><td>&lt;35%</td><td>${fmtPct(salesWeightedMarginPct)}</td></tr>
      <tr><td>低毛利销量占比（5分）</td><td>&lt;10%</td><td>10%-40%</td><td>≥40%</td><td>${fmtPct(lowMarginSalesSharePct)}</td></tr>
      <tr><td>销量加权 FBA/售价（3分）</td><td>&lt;20%</td><td>20%-35%</td><td>≥35%</td><td>${fmtPct(salesWeightedFbaRatio)}</td></tr>
      <tr><td>价格带利润结构（4分）</td><td>单件毛利≥$4</td><td>$2-$4</td><td>&lt;$2</td><td>${fmtMoney(salesWeightedUnitGrossProfit)}</td></tr>
      <tr><td>CPC/客单价（广告成本模块）</td><td>&lt;8%</td><td>8%-15%</td><td>&ge;15%</td><td>${cpcMetricRatio == null ? '未采集' : Number(cpcMetricRatio).toFixed(2) + '%'}</td></tr>
    </table>
    <div style="font-size:12px;color:#666;line-height:1.8;margin-top:8px;">
      利润口径：${Object.entries(profitSourceCounts).map(([k, v]) => `${escapeHtml(k)} ${v} 个`).join('；')}。当前历史数据如果缺少子 ASIN margin，只能用代表 ASIN 代理父体利润；新抓取数据会保留子 ASIN margin 并优先用子 ASIN 中位数。CPC/客单价已在广告成本模块单独计分。
    </div>
  </div>
  <div class="scroll-table" style="margin-top:14px;">
    <table>
      <tr><th>价格带</th><th>父体数</th><th>月销量</th><th>销量占比</th><th>销量加权毛利率</th><th>销量加权单件毛利</th><th>低毛利销量占比</th></tr>
      ${priceBandProfitRows}
    </table>
  </div>
  ${cpcOpportunityBlock}
  <div class="scroll-table" style="margin-top:16px;">
    <table>
      <tr><th>#</th><th>ASIN</th><th>产品名称</th><th>售价</th><th>FBA</th><th>FBA/售价</th><th>毛利率</th><th>单件毛利</th><th>月销量</th><th>利润口径</th><th>快筛</th></tr>
      ${profitRows}
    </table>
  </div>
</div>`;

// Brand rows by product count.
replacements['{{BRAND_ROWS}}'] = topBrands.map(([b, c]) =>
  '<tr><td>' + b + '</td><td>' + c + '</td><td>' + ((c / data.length) * 100).toFixed(1) + '%</td></tr>'
).join('\n');

// 鍝佺墝琛岋紙鎸夐攢閲忓崰姣旓級
replacements['{{BRAND_SALES_ROWS}}'] = top10BrandBySales.map(b =>
  '<tr><td>' + b.brand + '</td><td>' + b.sales.toLocaleString() + '</td><td>' + b.share + '%</td></tr>'
).join('\n');
replacements['{{BRAND_REVENUE_ROWS}}'] = top10BrandByRevenue.map(b =>
  '<tr><td>' + b.brand + '</td><td>$' + b.revenue.toLocaleString() + '</td><td>' + b.share + '%</td></tr>'
).join('\n');

// Seller type rows by product count.
replacements['{{SELLER_ROWS}}'] = Object.entries(sellerCount).sort((a, b) => b[1] - a[1]).map(([st, c]) =>
  '<tr><td>' + st + '</td><td>' + c + '</td><td>' + ((c / data.length) * 100).toFixed(1) + '%</td></tr>'
).join('\n');

// 绔炰簤鍒嗘瀽鐞嗙敱鍒楄〃
replacements['{{COMP_REASONS}}'] = compReasons.map(r => '<li>' + r + '</li>').join('\n');

// 杩涘叆闄愬埗鍒楄〃
replacements['{{ENTRY_BARRIERS}}'] = entryBarriers.map(b => '<li>' + b + '</li>').join('\n');

// New product detail rows.
replacements['{{NEW_PRODUCT_ROWS}}'] = newProductDetails.map((d, i) =>
  '<tr><td>' + (i + 1) + '</td><td><a href="https://www.amazon.com/dp/' + d.asin + '" target="_blank">' + d.asin + '</a></td><td><a href="https://www.amazon.com/dp/' + d.newChildAsin + '" target="_blank">' + d.newChildAsin + '</a></td><td>' + d.source + '</td><td>' + (d.pureUnder6mParent ? '<span style="color:#237804;font-weight:600;">纯新父体</span>' : '-') + '</td><td>' + d.childCount + '</td><td>' + d.brand + '</td><td>' + d.sales.toLocaleString() + '</td><td>' + d.share + '%</td><td>' + d.age + '个月</td></tr>'
).join('\n');

// Under-12-month product detail rows.
replacements['{{UNDER12M_ROWS}}'] = under12mDetails.map((d, i) => {
  const under12mLinks = [...new Set(d.under12mChildAsins.filter(Boolean))]
    .map(asin => '<a href="https://www.amazon.com/dp/' + asin + '" target="_blank">' + asin + '</a>')
    .join('<br>');
  const pureTag = d.pureUnder12mParent ? '<span style="color:#237804;font-weight:600;">纯新父体</span>' : '-';
  return '<tr><td>' + (i + 1) + '</td><td><a href="https://www.amazon.com/dp/' + d.asin + '" target="_blank">' + d.asin + '</a></td><td>' + under12mLinks + '</td><td>' + d.source + '</td><td>' + pureTag + '</td><td>' + d.childCount + '</td><td>' + d.brand + '</td><td>' + d.sales.toLocaleString() + '</td><td>' + d.share + '%</td><td>' + d.age + '个月</td></tr>';
}).join('\n');

// Excluded product rows.
replacements['{{EXCLUDED_ROWS}}'] = excluded.map((d, i) => {
  const fullTitle = productTitle(d);
  const shortTitle = fullTitle.length > 140 ? fullTitle.substring(0, 140) + '...' : fullTitle;
  const asinCell = d.asin ? `<a href="https://www.amazon.com/dp/${escapeHtml(d.asin)}" target="_blank">${escapeHtml(d.asin)}</a>` : '-';
  const reason = d.keywordIntentRescueRejectedReason
    ? '标题意图救回失败：价格超出目标类目区间'
    : (d.targetCategoryTitleIntentRejected ? '目标宽类目标题意图不匹配' : '非目标类目');
  return '<tr><td>' + (i + 1) + '</td><td>' + asinCell + '</td><td style="min-width:360px;max-width:720px;white-space:normal;line-height:1.5;" title="' + escapeHtml(fullTitle) + '">' + escapeHtml(shortTitle) + '</td><td style="font-size:11px;color:#999;">' + escapeHtml(d.category || '未识别') + '</td><td style="font-size:12px;color:#666;">' + escapeHtml(reason) + '</td></tr>';
}).join('\n');

// Keyword source rows.
const kwSourceData = jsonData.keywordStats ? Object.entries(jsonData.keywordStats).map(([kw, count]) => ({ keyword: kw, count })) : [];
const kwSourceRows = kwSourceData.map((k, i) =>
  '<tr><td>' + (i + 1) + '</td><td>' + k.keyword + '</td><td>' + k.count + '</td></tr>'
).join('\n');

// Product detail rows.
replacements['{{PRODUCT_ROWS}}'] = data.sort((a, b) => a.bsr - b.bsr).map((d, i) =>
  '<tr><td>' + (i + 1) + '</td><td style="max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + d.title + '">' + d.title.substring(0, 60) + '</td><td><a href="https://www.amazon.com/dp/' + d.asin + '" target="_blank">' + d.asin + '</a></td><td>' + (d.keywordIntentRescued ? '<span style="color:#ad6800;font-weight:600;">标题意图救回</span>' : (d.targetCategoryTitleIntentRequired ? '<span style="color:#096dd9;font-weight:600;">目标类目+标题意图</span>' : '目标类目')) + '</td><td>' + childAsinCountExcludingRepresentative(d) + '</td><td>' + d.sales + '</td><td>' + d.bsr + '</td><td>' + d.subRank + '</td><td>' + d.price + '</td><td>' + formatAge(d) + '</td><td>' + parseReviewCount(d).toLocaleString() + ' / ' + (d.ratings || '0') + '</td><td>' + d.brand + '</td></tr>'
).join('\n');
replacements['{{KW_SOURCE_ROWS}}'] = kwSourceRows;

// ============ Legacy seasonality block disabled after encoding damage ============
/*
if (seasonalityData && seasonalityData.seasonality) {
  const s = seasonalityData.seasonality;
  const sType = s.seasonalityType;
  const sScore = s.seasonalityScore;
  const sColor = sType === '寮哄鑺傛€? ? '#3b82f6' : sType === '寮卞鑺傛€? ? '#eab308' : '#22c55e';

  const gtPointsAll = seasonalityData.googleTrendsData?.data5Years || [];
  const gtPoints = gtPointsAll.slice(-156); // 鐙珛鍥捐〃鐢ㄦ渶杩?骞?  const gtLabels = gtPoints.map(p => p.date);
  const gtValues = gtPoints.map(p => p.value);

  let volLabels = [], volValues = [];
  if (seasonalityData.oalurVolumeData?.searchesTrend) {
    const st = seasonalityData.oalurVolumeData.searchesTrend;
    const sortedMonths = Object.keys(st).sort().slice(-36);
    volLabels = sortedMonths.map(m => m.substring(0, 7));
    volValues = sortedMonths.map(m => st[m]);
  }

  // 机会指数 & 在售商品数
  let oppLabels = [], oppValues = [], productNumValues = [];
  if (seasonalityData.oalurVolumeData?.oppIndexTrend) {
    const st = seasonalityData.oalurVolumeData.oppIndexTrend;
    const sortedMonths = Object.keys(st).sort().slice(-36);
    oppLabels = sortedMonths.map(m => m.substring(0, 7));
    oppValues = sortedMonths.map(m => st[m]);
  }
  if (seasonalityData.oalurVolumeData?.productTotalNumTrend) {
    const st = seasonalityData.oalurVolumeData.productTotalNumTrend;
    const sortedMonths = Object.keys(st).sort().slice(-36);
    productNumValues = sortedMonths.map(m => st[m]);
  }

  // TOP3 点击份额 & 转化份额（对齐相同月份）
  let top3Labels = [], topClickValues = [], topConvertValues = [];
  if (seasonalityData.oalurVolumeData?.topClickRatioTrend) {
    const st = seasonalityData.oalurVolumeData.topClickRatioTrend;
    const sortedMonths = Object.keys(st).sort().slice(-36);
    top3Labels = sortedMonths.map(m => m.substring(0, 7));
    topClickValues = sortedMonths.map(m => st[m]);
  }
  if (seasonalityData.oalurVolumeData?.topConvertRatioTrend) {
    const st = seasonalityData.oalurVolumeData.topConvertRatioTrend;
    topConvertValues = top3Labels.map(m => {
      const key = Object.keys(st).find(k => k.substring(0, 7) === m);
      return key ? st[key] : null;
    });
  }

  const hasTop3Data = top3Labels.length > 0 && topClickValues.length > 0;
  const hasOppData = oppLabels.length > 0 && oppValues.length > 0;

  // 知识库分析：TOP3 头部垄断度
  let top3MonopolyAnalysis = '';
  if (hasTop3Data) {
    // 鍙栨渶杩?6 涓湀骞冲潎鍊硷紙浠ｈ〃褰撳墠鐘舵€侊級
    const recentClick = topClickValues.slice(-6).filter(v => v != null);
    const recentConvert = topConvertValues.slice(-6).filter(v => v != null);
    const avgClick = recentClick.length > 0 ? recentClick.reduce((a, b) => a + b, 0) / recentClick.length : 0;
    const avgConvert = recentConvert.length > 0 ? recentConvert.reduce((a, b) => a + b, 0) / recentConvert.length : 0;
    const totalTop3 = avgClick + avgConvert;

    let monopolyLevel, monopolyColor, monopolyAdvice;
    if (avgClick > 50 && avgConvert > 50) {
      monopolyLevel = '头部垄断严重';
      monopolyColor = '#ff4d4f';
      monopolyAdvice = 'TOP3 点击和转化份额均 > 50%，主要流量和成交被头部产品牢牢掌控，新卖家很难突破。建议寻找更细分的子类目或走差异化路线。';
    } else if (avgConvert > 50) {
      monopolyLevel = '头部转化垄断';
      monopolyColor = '#faad14';
      monopolyAdvice = 'TOP3 点击份额不高但转化份额 > 50%，消费者最终仍倾向购买头部产品，头部转化能力强。需要在 listing 质量和价格上匹配头部标准。';
    } else if (avgClick > 50) {
      monopolyLevel = '头部曝光集中';
      monopolyColor = '#faad14';
      monopolyAdvice = 'TOP3 点击份额 > 50% 但转化份额较低，头部曝光集中但流量被其他竞品分流。可能整体转化率偏低，或竞品在价格、变体等维度竞争。';
    } else if (avgClick < 20 && avgConvert < 20) {
      monopolyLevel = '头部垄断低（但竞争可能激烈）';
      monopolyColor = '#52c41a';
      monopolyAdvice = 'TOP3 点击和转化份额均 < 20%，无明显头部垄断。但低份额也可能说明市场竞争非常激烈、流量极其分散，需要结合机会指数和竞品数量进一步判断。';
    } else {
      monopolyLevel = '头部集中度适中';
      monopolyColor = '#52c41a';
      monopolyAdvice = 'TOP3 份额处于中等水平，市场有一定集中度但未形成垄断，新卖家仍有一定切入空间。';
    }

    top3MonopolyAnalysis = `
<div style="margin-top:16px;padding:14px;background:#f9f9f9;border-left:4px solid ${monopolyColor};border-radius:8px;">
  <div style="font-size:16px;font-weight:700;color:${monopolyColor};margin-bottom:8px;">${monopolyLevel}</div>
  <div style="font-size:13px;line-height:1.8;color:#555;">
    <strong>最近 6 个月均值：</strong>点击份额 ${avgClick.toFixed(1)}% | 转化份额 ${avgConvert.toFixed(1)}% | 头部合计 ${totalTop3.toFixed(1)}%<br>
    ${monopolyAdvice}
  </div>
</div>`;
  }

  // 知识库分析：机会指数趋势
  let oppAnalysis = '';
  if (hasOppData) {
    const firstHalf = oppValues.slice(0, Math.floor(oppValues.length / 2));
    const secondHalf = oppValues.slice(Math.floor(oppValues.length / 2));
    const avgFirst = firstHalf.length > 0 ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : 0;
    const avgSecond = secondHalf.length > 0 ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : 0;
    const oppTrend = avgSecond - avgFirst;
    const oppTrendPct = avgFirst > 0 ? ((oppTrend / avgFirst) * 100).toFixed(1) : '0';

    // 在售商品数趋势
    const prodFirstHalf = productNumValues.slice(0, Math.floor(productNumValues.length / 2));
    const prodSecondHalf = productNumValues.slice(Math.floor(productNumValues.length / 2));
    const prodAvgFirst = prodFirstHalf.length > 0 ? prodFirstHalf.reduce((a, b) => a + b, 0) / prodFirstHalf.length : 0;
    const prodAvgSecond = prodSecondHalf.length > 0 ? prodSecondHalf.reduce((a, b) => a + b, 0) / prodSecondHalf.length : 0;
    const prodTrend = prodAvgSecond - prodAvgFirst;
    const prodTrendPct = prodAvgFirst > 0 ? ((prodTrend / prodAvgFirst) * 100).toFixed(1) : '0';

    let oppTrendText, oppTrendColor, oppAdvice;
    if (oppTrendPct > 15) {
      oppTrendText = '机会指数显著上升：' + oppTrendPct + '%';
      oppTrendColor = '#52c41a';
      oppAdvice = '需求增速快于供给增速，市场在扩大，进入窗口较好。';
    } else if (oppTrendPct > 5) {
      oppTrendText = '机会指数温和上升：' + oppTrendPct + '%';
      oppTrendColor = '#52c41a';
      oppAdvice = '市场供需关系轻微改善，可持续关注。';
    } else if (oppTrendPct > -5) {
      oppTrendText = '机会指数基本稳定：' + oppTrendPct + '%';
      oppTrendColor = '#faad14';
      oppAdvice = '市场供需相对平衡，竞争格局稳定。';
    } else if (oppTrendPct > -15) {
      oppTrendText = '机会指数下降：' + oppTrendPct + '%';
      oppTrendColor = '#ff4d4f';
      oppAdvice = '竞争加剧或需求萎缩，进入需要谨慎。';
    } else {
      oppTrendText = '机会指数显著下降：' + oppTrendPct + '%';
      oppTrendColor = '#ff4d4f';
      oppAdvice = '市场快速恶化，供给增长远超需求或需求大幅萎缩。不建议此时进入。';
    }

    let prodTrendText = prodTrendPct > 10 ? `在售商品数增长 ${prodTrendPct}%（卖家持续涌入）` :
      prodTrendPct > 0 ? `在售商品数小幅增长 ${prodTrendPct}%` :
      `在售商品数下降 ${Math.abs(prodTrendPct)}%（市场竞争者减少或趋于稳定）`;

    oppAnalysis = `
<div style="margin-top:16px;padding:14px;background:#f9f9f9;border-left:4px solid ${oppTrendColor};border-radius:8px;">
  <div style="font-size:16px;font-weight:700;color:${oppTrendColor};margin-bottom:8px;">${oppTrendText}</div>
  <div style="font-size:13px;line-height:1.8;color:#555;">
    <strong>前半段均值：</strong>${avgFirst.toFixed(1)} -> <strong>后半段均值：</strong>${avgSecond.toFixed(1)}<br>
    ${oppAdvice}<br>
    <strong>在售商品数：</strong>${prodTrendText}
  </div>
</div>`;
  }

  // 知识库分析：标品/非标品判断
  let productTypeAnalysis = '';
  if (hasTop3Data && hasOppData) {
    // 基于 TOP3 份额分散度和机会指数判断标品/非标品倾向
    const recentClick = topClickValues.slice(-6).filter(v => v != null);
    const avgClick = recentClick.length > 0 ? recentClick.reduce((a, b) => a + b, 0) / recentClick.length : 0;

    // 关键词集中度：用搜索排名稳定性判断，排名波动大更偏非标品。
    let rankVolatility = 0;
    if (seasonalityData.oalurVolumeData?.searchesRankTrend) {
      const rankData = seasonalityData.oalurVolumeData.searchesRankTrend;
      const rankValues = Object.keys(rankData).sort().slice(-36).map(k => rankData[k]);
      if (rankValues.length > 1) {
        const rankMean = rankValues.reduce((a, b) => a + b, 0) / rankValues.length;
        rankVolatility = rankValues.reduce((s, v) => s + Math.abs(v - rankMean), 0) / rankValues.length / Math.max(rankMean, 1);
      }
    }

    let typeLabel, typeColor, typeDesc;
    if (avgClick > 50) {
      typeLabel = '标品倾向';
      typeColor = '#1890ff';
      typeDesc = 'TOP3 点击份额集中（>50%），流量集中在少数核心词，符合标品的流量特征。关键词排名变化幅度' + (rankVolatility > 0.3 ? '较大' : '较小') + '。';
    } else if (avgClick < 30 && rankVolatility > 0.3) {
      typeLabel = '非标品倾向';
      typeColor = '#722ed1';
      typeDesc = 'TOP3 点击份额分散（<30%），关键词排名波动大，流量分散到长尾词，符合非标品的流量特征。';
    } else {
      typeLabel = '混合型';
      typeColor = '#faad14';
      typeDesc = '流量集中度介于标品和非标品之间，可能存在多个细分需求方向。建议进一步分析子类目。';
    }

    productTypeAnalysis = `
<div style="margin-top:12px;padding:14px;background:linear-gradient(135deg,#f0f5ff,#f5f0ff);border-radius:8px;">
  <div style="font-size:15px;font-weight:700;color:${typeColor};margin-bottom:6px;">${typeLabel}</div>
  <div style="font-size:13px;line-height:1.8;color:#555;">
    ${typeDesc}<br>
    <strong>知识库建议：</strong>${typeLabel.includes('标品') ? '标品需要走自主设计研发方向，打造核心竞争力，避免纯价格竞争。可考虑品牌调性差异化，例如高端定位。' : typeLabel.includes('非标品') ? '非标品适合中小卖家切入，可尝试微创新（外观、功能组合、场景化）建立差异化，并注意把握季节性窗口。' : '混合型市场需要进一步细分，找到更接近非标品方向的切入点，避免在大词上烧钱内卷。'}
  </div>
</div>`;
  }

  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const gtMonthAvgs = s.googleMonthAvgs || [];
  const oaMonthAvgs = s.oalurMonthAvgs || [];

  // Google Trends 周级转月级 + Oalur 月度数据，对齐重叠月份。
  const gtMonthlyMap = {};
  gtPointsAll.forEach(p => {
    if (p.date && p.date.length >= 7) {
      const m = p.date.substring(0, 7);
      if (!gtMonthlyMap[m]) gtMonthlyMap[m] = { sum: 0, count: 0 };
      gtMonthlyMap[m].sum += p.value;
      gtMonthlyMap[m].count += 1;
    }
  });
  const oalurMonthlyMap = {};
  volLabels.forEach((l, i) => { oalurMonthlyMap[l] = volValues[i]; });
  const allMonths = [...new Set([...Object.keys(gtMonthlyMap), ...Object.keys(oalurMonthlyMap)])].sort();
  const compareLabels = allMonths.filter(m => oalurMonthlyMap[m] !== undefined);
  const compareGtVals = compareLabels.map(m => Math.round(gtMonthlyMap[m]?.sum / gtMonthlyMap[m]?.count) || null);
  const compareOaVals = compareLabels.map(m => oalurMonthlyMap[m] || null);

  const peakText = s.seasonalityType === '强季节性' ? '旺季前 2 个月备货，旺季前 1 个月推广告。注意控制淡季库存。'
    : s.seasonalityType === '弱季节性' ? '有温和季节性波动，可参考旺季月份优化广告投放节奏。'
    : '无明显季节性，可全年稳定运营，库存压力较小。';

  // ASIN trend charts: monthly revenue, unified y-axis.
  let asinChartsHtml = '';
  let asinChartsJs = '';
  let asinMaxRevenue = 0;
  const asinProducts = seasonalityData.asinTrendsData?.products;
  if (asinProducts) {
    // 鍙繚鐣欏綋鍓嶈繃婊ゅ悗浜у搧鍒楄〃涓殑 ASIN锛堢‘淇濅笌浜у搧鏄庣粏琛ㄤ竴鑷达級
    const currentFilteredAsins = new Set(data.map(d => d.asin).filter(Boolean));
    const validProducts = asinProducts.filter(p => p.trendData && currentFilteredAsins.has(p.asin));
    // Calculate max monthly revenue across ASINs for a shared y-axis.
    validProducts.forEach(p => {
      const revs = p.trendData.monthlyRevenue.map(v => {
        const n = parseInt(String(v).replace(/[$,]/g, ''));
        return isNaN(n) ? 0 : n;
      });
      const maxR = Math.max(...revs, 0);
      if (maxR > asinMaxRevenue) asinMaxRevenue = maxR;
    });
    asinMaxRevenue = Math.ceil(asinMaxRevenue / 1000) * 1000 || 1000;

    validProducts.forEach((p, idx) => {
      const ms = p.trendData.months;
      const rs = p.trendData.monthlyRevenue.map(v => {
        const n = parseInt(String(v).replace(/[$,]/g, ''));
        return isNaN(n) ? 0 : n;
      });
      asinChartsHtml += `
    <div class="card" style="margin-bottom:12px;">
      <h3 style="font-size:14px;">${p.asin} (${p.brand || 'N/A'}) - ${(p.title || '').substring(0, 80)}</h3>
      <div class="chart-container" style="height:250px;">
        <canvas id="asinChart${idx}"></canvas>
      </div>
    </div>`;
      asinChartsJs += `
  (function() {
    const c = document.getElementById('asinChart${idx}');
    if (c) new Chart(c, {
      type: 'bar',
      data: { labels: ${JSON.stringify(ms)}, datasets: [{ label: '月销售额($)', data: ${JSON.stringify(rs)}, backgroundColor: 'rgba(16,185,129,0.6)', borderColor: 'rgba(16,185,129,1)', borderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: ${asinMaxRevenue}, title: { display: true, text: '\$' } } } }
    });
  })();`;
    });
  }

  // Update top summary card with seasonality conclusion.
  const sColorHex = sType === '强季节性' ? '#3b82f6' : sType === '弱季节性' ? '#eab308' : '#22c55e';
  replacements['{{SEASONALITY_SUMMARY}}'] = `<span style="color:${sColorHex};font-weight:700">${sType}</span>`;
  replacements['{{SEASONALITY_SUMMARY_CLASS}}'] = '';

  const seasonalityBlock = `
<h1 style="margin-top:32px;">Seasonality and Market Trend Analysis</h1>

<div class="card">
  <div class="summary">
    <div class="metric"><div class="value" style="color:${sColor}">${sType}</div><div class="label">瀛ｈ妭鎬х被鍨?/div></div>
    <div class="metric"><div class="value">${sScore}</div><div class="label">瀛ｈ妭鎬у緱鍒?/div></div>
    <div class="metric"><div class="value">${s.googlePeakMonths.map(m => m + 'M').join(', ') || 'None'}</div><div class="label">Google Peak Months</div></div>
    <div class="metric"><div class="value">${s.oalurPeakMonths.join('銆?) || '鏃?}</div><div class="label">Oalur 宄板€兼湀浠?/div></div>
  </div>
  <div style="margin-top:16px;padding:12px;background:#f0f5ff;border-radius:8px;font-size:14px;line-height:1.8;">
    <strong>Google Trends:</strong> ${s.googleTrendsShape}<br>
    <strong>Data consistency:</strong> ${s.googleVsOalurDeviation || 'No obvious deviation detected'}<br>
    <strong>Strategy:</strong> ${peakText}
  </div>
</div>

<div class="chart-row">
  <div class="card">
    <h2>Google Trends - 5-year Search Interest</h2>
    <div class="chart-container"><canvas id="gtChart"></canvas></div>
  </div>
  <div class="card">
    <h2>Oalur - Monthly Search Volume Trend (36 months)</h2>
    <div class="chart-container"><canvas id="oalurVolChart"></canvas></div>
  </div>
</div>

<div class="card">
  <h2>Google vs Oalur Monthly Data Comparison</h2>
  <div class="chart-container"><canvas id="compareChart"></canvas></div>
  <div style="margin-top:12px;padding:12px;background:#f0f5ff;border-radius:8px;font-size:13px;line-height:1.9;">
    <strong>Knowledge base note: Seasonality and lifecycle</strong><br>
    鈥?Google Trends 鍙嶆槧鍏ㄧ綉鎼滅储鍏磋叮锛堝寘鍚俊鎭悳绱級锛孫alur 鍙嶆槧浜氶┈閫婄珯鍐呰喘鐗╂悳绱?br>
    - If peak months differ, use Oalur in-site demand as the primary inventory and ad-planning reference.<br>
    鈥?Google 宄拌胺姣?鈮? 鈫?鏄庢樉瀛ｈ妭鎬э紱Oalur 宄拌胺姣?鈮?.5 鈫?寮哄鑺傛€?br>
    鈥?鈿狅笍 鏂版墜鍗栧涓嶅缓璁秹瓒宠妭鏃ユ€т骇鍝侊紙绐楀彛浠?-3涓湀锛屽璐ч闄╂瀬楂橈級<br>
    鈥?鍒ゆ柇甯傚満闇€姹傚繀椤荤敤绔欏唴鏁版嵁宸ュ叿锛屼笉鍙粎渚濊禆 Google Trends<br>
    - Decision checklist: Google volatility, Oalur demand consistency, repeated BSR peaks, and holiday dependence.
  </div>
</div>

${hasOppData ? `
<div class="chart-row">
  <div class="card">
    <h2>Oalur - Monthly Opportunity Index Trend (36 months)</h2>
    <div class="chart-container"><canvas id="oppIndexChart"></canvas></div>
  </div>
  <div class="card">
    <h2>Oalur - Monthly Active Product Count Trend (36 months)</h2>
    <div class="chart-container"><canvas id="productNumChart"></canvas></div>
  </div>
</div>
<div style="margin-top:12px;padding:12px;background:#f0f5ff;border-radius:8px;font-size:13px;line-height:1.9;">
  <strong>Opportunity index interpretation:</strong><br>
  - Opportunity index = search volume / active product count. Higher values indicate stronger relative demand.<br>
  - Rising index means demand grows faster than supply; falling index means competition intensifies or demand weakens.<br>
  鈥?鍦ㄥ敭鍟嗗搧鏁版寔缁闀?鈫?鏂板崠瀹朵笉鏂秾鍏ワ紝绔炰簤鍔犲墽锛涚ǔ瀹氭垨涓嬮檷 鈫?甯傚満瓒嬩簬鎴愮啛鎴栭ケ鍜?br>
  ${oppAnalysis}
</div>
` : ''}

${hasTop3Data ? `
<div class="card">
  <h2>TOP3 Product Click Share & TOP3 Conversion Share (recent 6 months)</h2>
  <div class="chart-row">
    <div class="chart-container" style="height:300px;"><canvas id="top3Chart"></canvas></div>
  </div>
  ${top3MonopolyAnalysis}
  ${productTypeAnalysis}
  <div style="margin-top:12px;padding:12px;background:#f0f5ff;border-radius:8px;font-size:13px;line-height:1.9;">
    <strong>Knowledge base note: standard vs non-standard products and TOP3 monopoly</strong><br>
    鈥?TOP3鐐瑰嚮浠介鍜岃浆鍖栦唤棰濋兘 > 50% 鈫?澶撮儴鍨勬柇涓ラ噸锛屾柊鍗栧寰堥毦绐佺牬<br>
    鈥?鐐瑰嚮浠介 > 50% 浣嗚浆鍖栦綆 鈫?澶撮儴鏇濆厜闆嗕腑浣嗘祦閲忚鍒嗘祦锛屽彲鑳藉湪浠锋牸/鍙樹綋绛夌淮搴︽湁绔炰簤绌洪棿<br>
    鈥?涓よ€呴兘 < 20% 鈫?澶撮儴鍨勬柇浣庯紝浣嗕篃鍙兘璇存槑绔炰簤闈炲父婵€鐑堬紙澶ц瘝甯歌锛?br>
    鈥?娴侀噺闆嗕腑鍦ㄥ皯鏁板ぇ璇?鈫?鏍囧搧鐗瑰緛锛涙祦閲忓垎鏁ｅ埌闀垮熬 鈫?闈炴爣鍝佺壒寰?br>
    鈥?鈿狅笍 鐐瑰嚮浠介鍜岃浆鍖栦唤棰濇槸<strong>涓嶅悓缁村害</strong>锛屽垎鍒弽鏄犳洕鍏夐泦涓害鍜屾垚浜ら泦涓害
  </div>
</div>
` : ''}

${asinChartsHtml ? `
<h2 style="color:#333;border-bottom:2px solid #1890ff;padding-bottom:8px;margin:16px 0;font-size:18px;">Old ASIN Monthly Revenue Trend (>3 years listed, unified y-axis)</h2>
<div style="font-size:13px;color:#666;margin-bottom:12px;">
  Selected old ASINs listed for more than 3 years with comparable revenue levels. Count: ${seasonalityData.pickedAsins?.length || 0}.</div>
${asinChartsHtml}
` : ''}

<script>
(function() {
  const c = document.getElementById('gtChart');
  if (!c) return;
  new Chart(c, {
    type: 'line',
    data: { labels: ${JSON.stringify(gtLabels)}, datasets: [{ label: '鎼滅储鍏磋叮', data: ${JSON.stringify(gtValues)}, borderColor: '#667eea', backgroundColor: 'rgba(102,126,234,0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
})();
(function() {
  const c = document.getElementById('oalurVolChart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: { labels: ${JSON.stringify(volLabels)}, datasets: [{ label: 'Monthly Search Volume', data: ${JSON.stringify(volValues)}, backgroundColor: 'rgba(251,146,60,0.6)', borderColor: '#fb923c', borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
})();
(function() {
  const c = document.getElementById('compareChart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(compareLabels)},
      datasets: [
        { label: 'Google Trends锛堟湀鍧囷級', data: ${JSON.stringify(compareGtVals)}, backgroundColor: 'rgba(102,126,234,0.4)', borderColor: '#667eea', borderWidth: 1, yAxisID: 'y' },
        { label: 'Oalur 鎼滅储閲?, data: ${JSON.stringify(compareOaVals)}, backgroundColor: 'rgba(251,146,60,0.4)', borderColor: '#fb923c', borderWidth: 1, yAxisID: 'y1' }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { title: { display: true, text: 'Month' } }, y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Google Trends Interest' } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Oalur Search Volume' } } } }
  });
})();
${hasOppData ? `
(function() {
  const c = document.getElementById('oppIndexChart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: { labels: ${JSON.stringify(oppLabels)}, datasets: [{ label: 'Opportunity Index', data: ${JSON.stringify(oppValues)}, backgroundColor: 'rgba(147,51,234,0.6)', borderColor: '#9333ea', borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: 'Opportunity Index' } } } }
  });
})();
(function() {
  const c = document.getElementById('productNumChart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: { labels: ${JSON.stringify(oppLabels)}, datasets: [{ label: '鍦ㄥ敭鍟嗗搧鏁?, data: ${JSON.stringify(productNumValues)}, backgroundColor: 'rgba(14,165,233,0.6)', borderColor: '#0ea5e9', borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: '鍦ㄥ敭鍟嗗搧鏁? } } } }
  });
})();
` : ''}
${hasTop3Data ? `
(function() {
  const c = document.getElementById('top3Chart');
  if (!c) return;
  new Chart(c, {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(top3Labels)},
      datasets: [
        { label: 'TOP3 鐐瑰嚮浠介(%)', data: ${JSON.stringify(topClickValues)}, backgroundColor: 'rgba(239,68,68,0.5)', borderColor: '#ef4444', borderWidth: 1, yAxisID: 'y' },
        { label: 'TOP3 杞寲浠介(%)', data: ${JSON.stringify(topConvertValues)}, backgroundColor: 'rgba(34,197,94,0.5)', borderColor: '#22c55e', borderWidth: 1, yAxisID: 'y' }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { title: { display: true, text: 'Month' } }, y: { beginAtZero: true, max: 100, title: { display: true, text: '%' } } } }
  });
})();
` : ''}
${asinChartsJs}
<\/script>`;

  replacements['{{SEASONALITY_BLOCK}}'] = seasonalityBlock;
} else {
  replacements['{{SEASONALITY_BLOCK}}'] = '';
}
*/

// ============ Seasonality and market trend summary ============
if (seasonalityData && seasonalityData.seasonality) {
  const s = seasonalityData.seasonality;
  const normalizeMonth = (m) => {
    const matched = String(m || '').match(/\d{1,2}/);
    return matched ? `${parseInt(matched[0], 10)}月` : String(m || '');
  };
  const normalizeSeasonalityType = (type) => {
    const raw = String(type || '');
    if (raw.includes('强') || raw.includes('寮哄')) return '强季节性';
    if (raw.includes('弱') || raw.includes('寮卞')) return '弱季节性';
    if ((s.seasonalityScore || 0) >= 60) return '强季节性';
    return raw || '未识别';
  };
  const trendSeries = (trend, limit = 36) => {
    const keys = Object.keys(trend || {}).sort().slice(-limit);
    return {
      labels: keys.map(k => k.substring(0, 7)),
      values: keys.map(k => Number(trend[k])).filter(Number.isFinite)
    };
  };
  const sType = normalizeSeasonalityType(s.seasonalityType);
  const sScore = s.seasonalityScore ?? '-';
  const sColor = sType === '强季节性' ? '#3b82f6' : sType === '弱季节性' ? '#eab308' : '#22c55e';
  const googleTrendsError = seasonalityData.googleTrendsData?.error || '';
  const gtPoints = (seasonalityData.googleTrendsData?.data5Years || []).slice(-156);
  const gtLabels = gtPoints.map(p => p.date);
  const gtValues = gtPoints.map(p => Number(p.value)).filter(Number.isFinite);
  const googleTrendsStatusBlock = googleTrendsError
    ? `<div style="margin-top:8px;padding:10px 12px;background:#fff2f0;border:1px solid #ffccc7;border-radius:8px;font-size:12px;line-height:1.8;color:#a8071a;"><strong>Google Trends 抓取失败：</strong>${escapeHtml(googleTrendsError)}</div>`
    : '';
  const searchSeries = trendSeries(seasonalityData.oalurVolumeData?.searchesTrend);
  const oppSeries = trendSeries(seasonalityData.oalurVolumeData?.oppIndexTrend);
  const productSeries = trendSeries(seasonalityData.oalurVolumeData?.productTotalNumTrend);
  const clickSeries = trendSeries(seasonalityData.oalurVolumeData?.topClickRatioTrend);
  const convertMap = seasonalityData.oalurVolumeData?.topConvertRatioTrend || {};
  const seasonalityKeywordForRecommendation = seasonalityData.seasonalityKeyword || seasonalityData.keyword || seasonalityData.oalurVolumeData?.keyword || jsonData.keyword;
  const abaKeywordRecommendation = keywordRecommendationFromOalur(seasonalityKeywordForRecommendation, seasonalityData.oalurVolumeData);
  const abaKeywordRecommendationBlock = keywordRecommendationHtml(abaKeywordRecommendation);
  const abaKeywordRecommendationInline = keywordRecommendationHtml(abaKeywordRecommendation, true);
  const convertValues = clickSeries.labels.map(label => {
    const key = Object.keys(convertMap).find(k => k.substring(0, 7) === label);
    return key ? Number(convertMap[key]) : null;
  });
  const recentAverage = (trend) => {
    const values = Object.keys(trend).sort().slice(-6).map(k => Number(trend[k])).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const avgClick = recentAverage(seasonalityData.oalurVolumeData?.topClickRatioTrend || {});
  const avgConvert = recentAverage(seasonalityData.oalurVolumeData?.topConvertRatioTrend || {});
  const seriesChange = (values) => {
    const nums = values.filter(Number.isFinite);
    if (nums.length < 4) return null;
    const mid = Math.floor(nums.length / 2);
    const first = nums.slice(0, mid);
    const second = nums.slice(mid);
    const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
    const avgSecond = second.reduce((a, b) => a + b, 0) / second.length;
    return {
      avgFirst,
      avgSecond,
      deltaPct: avgFirst > 0 ? ((avgSecond / avgFirst - 1) * 100) : null
    };
  };
  const oppChange = seriesChange(oppSeries.values);
  const productChange = seriesChange(productSeries.values);
  const productSupplyTrend = supplyTrendEvidence(seasonalityData.oalurVolumeData?.productTotalNumTrend);
  const oppAnalysisText = oppChange
    ? `机会指数从前半段均值 ${oppChange.avgFirst.toFixed(1)} 变为后半段 ${oppChange.avgSecond.toFixed(1)}，变化 ${oppChange.deltaPct == null ? '无法计算' : oppChange.deltaPct.toFixed(1) + '%'}。${oppChange.deltaPct != null && oppChange.deltaPct > 10 ? '需求相对供给改善，市场机会边际增强。' : oppChange.deltaPct != null && oppChange.deltaPct < -10 ? '机会指数走弱，可能是供给增加快于需求或需求回落。' : '机会指数整体较稳定，需结合 CPC 和利润核算判断真实机会。'}`
    : '机会指数历史点不足，暂不能形成趋势判断。';
  const productAnalysisText = productSupplyTrend.text;
  const classifyTop3Share = (click, convert) => {
    if (!Number.isFinite(click) || !Number.isFinite(convert)) {
      return {
        level: '未采集',
        quadrant: '数据不足',
        standardType: '未判断',
        note: '缺少 TOP3 点击份额或转化份额，不能判断头部垄断度。'
      };
    }
    if (click > 50 && convert > 50) {
      return {
        level: '头部垄断严重',
        quadrant: '点击 >50% 且转化 >50%',
        standardType: '标品/强头部倾向',
        note: '主要曝光和成交都被 TOP3 产品拿走，很难直接和头部竞争。'
      };
    }
    if (click <= 50 && convert > 50) {
      return {
        level: '转化垄断强',
        quadrant: '点击不高但转化 >50%',
        standardType: '强头部倾向',
        note: 'TOP3 未拿走主要曝光，但消费者最终明显选择头部，说明头部 Listing 转化能力强。'
      };
    }
    if (click > 50 && convert <= 50) {
      return {
        level: '曝光集中但转化外流',
        quadrant: '点击 >50% 但转化不高',
        standardType: '混合型',
        note: 'TOP3 获得主要曝光，但成交被其他竞品分走，可能存在价格、变体、评价或差异化切入空间，也可能是整体转化率偏低。'
      };
    }
    if (click < 20 && convert < 20) {
      return {
        level: '头部垄断低',
        quadrant: '点击 <20% 且转化 <20%',
        standardType: '非标/长尾分散倾向',
        note: '头部产品没有明显垄断，但也可能代表大词流量高度分散、竞争面很广。'
      };
    }
    return {
      level: '中等集中度',
      quadrant: '20%-50% 区间',
      standardType: '混合型',
      note: '市场有一定集中度但未形成强垄断，需要结合核心竞品数、CPC、评论壁垒和新品存活率判断。'
    };
  };
  const top3ShareClass = classifyTop3Share(avgClick, avgConvert);
  const top3AnalysisText = avgClick == null || avgConvert == null
    ? 'TOP3 点击/转化数据不足，不能判断头部流量和成交集中度。'
    : `最近 6 个月 TOP3 点击份额均值 ${avgClick.toFixed(1)}%，转化份额均值 ${avgConvert.toFixed(1)}%，判定为“${top3ShareClass.level}”（${top3ShareClass.quadrant}）。${top3ShareClass.note} 标品/非标品倾向：${top3ShareClass.standardType}。点击份额代表曝光集中度，转化份额代表成交集中度，二者是不同维度，不能直接相加得出结论。`;
  const classifyBasicOpportunity = (value) => {
    if (!Number.isFinite(value)) return { level: '未采集', note: '缺少基础机会指数' };
    if (value > 10) return { level: '极致蓝海', note: '需求远大于供给，但需排查专利、季节性爆发或头部垄断' };
    if (value >= 5) return { level: '优质蓝海', note: '需求旺盛，竞争较小' };
    if (value >= 2) return { level: '轻度竞争', note: '供需平衡偏需求端' };
    if (value >= 1) return { level: '中度竞争', note: '供需基本平衡，需要差异化' };
    if (value >= 0.5) return { level: '中高竞争', note: '供给略大于需求' };
    if (value >= 0.2) return { level: '红海市场', note: '供给明显大于需求' };
    return { level: '极致红海', note: '市场高度饱和' };
  };
  const classifyEffectiveOpportunity = (value) => {
    if (!Number.isFinite(value)) return { level: '未采集', note: '缺少搜索量或公式参数' };
    if (value > 10000) return { level: '极佳', note: '前3页每个商品理论可分到较多有效流量' };
    if (value >= 5000) return { level: '良好', note: '竞争温和，Listing 达标后有出单空间' };
    if (value >= 1000) return { level: '一般', note: '需要运营技巧和广告投入' };
    return { level: '较差', note: '前3页有效曝光不足' };
  };
  const lastTrendPoint = (trend) => {
    const entries = Object.entries(trend || {}).sort().map(([month, value]) => ({ month, value: Number(value) })).filter(item => Number.isFinite(item.value));
    return entries.length ? entries[entries.length - 1] : null;
  };
  const latestOpp = lastTrendPoint(seasonalityData.oalurVolumeData?.oppIndexTrend);
  const latestSearch = lastTrendPoint(seasonalityData.oalurVolumeData?.searchesTrend);
  const latestProduct = lastTrendPoint(seasonalityData.oalurVolumeData?.productTotalNumTrend);
  const latestBasicOpp = latestOpp?.value ?? (latestSearch && latestProduct && latestProduct.value > 0 ? latestSearch.value / latestProduct.value : null);
  const oppAdjustment = opportunityAdjustmentForContext({
    keyword: jsonData.keyword,
    category: targetCategoryDisplay,
    seasonalityType: sType
  });
  const adjustedBasicOpp = latestBasicOpp == null ? null : latestBasicOpp * oppAdjustment.coefficient;
  const effectiveOpp = latestSearch ? (latestSearch.value * 0.9) / (48 * 0.04) : null;
  const basicOppClass = classifyBasicOpportunity(latestBasicOpp);
  const adjustedBasicOppClass = classifyBasicOpportunity(adjustedBasicOpp);
  const effectiveOppClass = classifyEffectiveOpportunity(effectiveOpp);
  const productTrendLevel = productSupplyTrend.level;
  const oppQuantRows = `
    <tr><td>基础机会指数（原始）</td><td>${latestBasicOpp == null ? '未采集' : latestBasicOpp.toFixed(2)}${latestOpp?.month ? `（${latestOpp.month}）` : ''}</td><td>&gt;10 极致蓝海；5-10 优质蓝海；2-5 轻度竞争；1-2 中度竞争；0.5-1 中高竞争；0.2-0.5 红海；&lt;0.2 极致红海</td><td>${basicOppClass.level}</td><td>${basicOppClass.note}</td></tr>
    <tr><td>行业调整系数</td><td>×${oppAdjustment.coefficient.toFixed(2)}</td><td>按 knowledge/category-opportunity-adjustment.md 的选品分析行业系数；命中多条时取更保守系数</td><td>${oppAdjustment.type}</td><td>${oppAdjustment.reason}</td></tr>
    <tr><td>行业调整后机会指数</td><td>${adjustedBasicOpp == null ? '未采集' : adjustedBasicOpp.toFixed(2)}</td><td>原始基础机会指数 × 行业调整系数，仍使用基础机会指数分档</td><td>${adjustedBasicOppClass.level}</td><td>${adjustedBasicOppClass.note}</td></tr>
    <tr><td>有效机会指数</td><td>${effectiveOpp == null ? '未采集' : effectiveOpp.toFixed(0)}</td><td>&gt;10000 极佳；5000-10000 良好；1000-5000 一般；&lt;1000 较差</td><td>${effectiveOppClass.level}</td><td>公式：(月搜索量 × 0.9) ÷ (前3页48个商品 × 4%行业转化率)。该值只作为流量池解释项，不进入首页最终评分。${effectiveOppClass.note}</td></tr>
    <tr><td>在售商品数趋势</td><td>${latestProduct == null ? '未采集' : latestProduct.value.toLocaleString()}；长期 ${productSupplyTrend.longDeltaPct == null ? '无法计算' : productSupplyTrend.longDeltaPct.toFixed(1) + '%'}，近期 ${productSupplyTrend.recentDeltaPct == null ? '无法计算' : productSupplyTrend.recentDeltaPct.toFixed(1) + '%'}，当前 ${productSupplyTrend.currentDeltaPct == null ? '无法计算' : productSupplyTrend.currentDeltaPct.toFixed(1) + '%'}</td><td>递进分段：全周期前/后半段、后半段再前/后、近期段再前/后；当前和近期权重更高</td><td>${productTrendLevel}</td><td>${productAnalysisText}</td></tr>
    <tr><td>品牌 CR3</td><td>${top3BrandShare}%（${brandCr3Level}）</td><td>${brandCr3Standard}</td><td>${brandCr3Level}</td><td>CR3 比单纯机会指数更能说明头部品牌垄断程度。</td></tr>
  `;
  const oppDecisionText = `基础机会指数原始值为 ${latestBasicOpp == null ? '未采集' : latestBasicOpp.toFixed(2)}（${basicOppClass.level}），按“${oppAdjustment.type}”行业系数 ×${oppAdjustment.coefficient.toFixed(2)} 调整后为 ${adjustedBasicOpp == null ? '未采集' : adjustedBasicOpp.toFixed(2)}（${adjustedBasicOppClass.level}）；有效机会指数为 ${effectiveOpp == null ? '未采集' : effectiveOpp.toFixed(0)}（${effectiveOppClass.level}），品牌 CR3 为 ${top3BrandShare}%（${brandCr3Level}）。机会指数不能单独作为进入决策，需要与 CR3、评论壁垒、CPC/客单价、利润快筛和新品存活一起判断。`;
  const oppStandardText = '基础机会指数衡量“搜索量/在售商品数”的供需关系；行业调整后机会指数按 knowledge/category-opportunity-adjustment.md 的选品分析类目系数修正原始供需比；有效机会指数只作为流量池解释项，不进入首页最终评分。知识库强调：机会指数不是越高越好，指数异常高也可能代表专利、季节性爆发或头部垄断风险；CR3 应优先作为市场进入难易度指标。';
  const top3StandardText = '基于 knowledge/amazon-selection-standard-vs-nonstandard.md：点击 >50% 且转化 >50% = 头部垄断严重；点击不高但转化 >50% = 转化垄断强；点击 >50% 但转化不高 = 曝光集中但转化外流；点击 <20% 且转化 <20% = 头部垄断低但可能流量分散。点击和转化是不同维度，不直接相加。';
  const top3QuantRows = avgClick == null || avgConvert == null ? `
        <tr><td>TOP3 点击/转化</td><td>未采集</td><td>缺少 ABA 趋势数据</td><td>未判断</td><td>无法判定头部垄断度。</td></tr>
      ` : `
        <tr><td>TOP3 点击份额</td><td>${avgClick.toFixed(1)}%</td><td>&gt;50% 表示曝光集中；&lt;20% 表示曝光分散</td><td>${avgClick > 50 ? '曝光集中' : avgClick < 20 ? '曝光分散' : '中等曝光'}</td><td>点击份额反映消费者先看到/点击谁。</td></tr>
        <tr><td>TOP3 转化份额</td><td>${avgConvert.toFixed(1)}%</td><td>&gt;50% 表示成交集中；&lt;20% 表示成交分散</td><td>${avgConvert > 50 ? '成交集中' : avgConvert < 20 ? '成交分散' : '中等成交'}</td><td>转化份额反映消费者最终买谁。</td></tr>
        <tr><td>四象限判定</td><td>${top3ShareClass.quadrant}</td><td>按点击份额和转化份额分别判断，不做简单求和</td><td>${top3ShareClass.level}</td><td>${top3ShareClass.note}</td></tr>
        <tr><td>标品/非标品倾向</td><td>${top3ShareClass.standardType}</td><td>核心流量/成交越集中，越偏标品或强头部；越分散，越偏非标或长尾竞争</td><td>${top3ShareClass.standardType}</td><td>该判断只是流量结构线索，还要结合产品功能、价格带、变体和评论壁垒。</td></tr>
      `;
  const googleTrendPointsForPeak = seasonalityData.googleTrendsData?.data5Years || seasonalityData.googleTrendsData?.data || [];
  const computeGooglePeakMonths = () => {
    const points = googleTrendPointsForPeak;
    if (!points.length) return [];
    const monthByYear = {};
    points.forEach(p => {
      if (!p.date || p.date.length < 7) return;
      const year = p.date.substring(0, 4);
      const month = p.date.substring(5, 7);
      const value = Number(p.value);
      if (!Number.isFinite(value)) return;
      if (!monthByYear[year]) monthByYear[year] = {};
      monthByYear[year][month] = value;
    });
    const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    const avgs = months.map(m => {
      let sum = 0;
      let count = 0;
      Object.values(monthByYear).forEach(yd => {
        if (yd[m] !== undefined) {
          sum += yd[m];
          count += 1;
        }
      });
      return count > 0 ? sum / count : 0;
    });
    const maxAvg = Math.max(...avgs);
    if (!Number.isFinite(maxAvg) || maxAvg <= 0) return [];
    const positive = avgs.filter(v => v > 0).sort((a, b) => a - b);
    const medianAvg = positive.length ? positive[Math.floor(positive.length / 2)] : 0;
    const sortedDesc = [...positive].sort((a, b) => b - a);
    const secondAvg = sortedDesc[1] || 0;
    const minAvg = positive[0] || 0;
    const hasStablePeak = medianAvg > 0
      && minAvg > 0
      && maxAvg / medianAvg >= 1.5
      && maxAvg / Math.max(secondAvg, 1) >= 1.25
      && maxAvg / minAvg >= 2;
    if (!hasStablePeak) return [];
    return months.filter((m, i) => avgs[i] >= maxAvg * 0.9);
  };
  const googlePeakMonths = computeGooglePeakMonths();
  const googlePeakNote = googleTrendsError
    ? `Google Trends 抓取失败：${googleTrendsError}。Google 峰值月暂不参与判断。`
    : googlePeakMonths.length > 0
      ? 'Google 峰值月按 5 年周级搜索兴趣汇总为多年月均值，并要求最高月相对中位月、次高月和最低月都有明显优势；达到最高月均值 90% 以上的月份计为稳定峰值月。'
      : googleTrendPointsForPeak.length > 0
        ? 'Google Trends 有数据，但最高月相对中位月、次高月或最低月的优势不足，不能认定为稳定峰值月。'
        : 'Google Trends 数据缺失或无法解析，Google 峰值月暂不参与判断。';
  const googlePeaks = googlePeakMonths.map(normalizeMonth).join('、') || '无稳定峰值月';
  const oalurPeaks = (s.oalurPeakMonths || []).map(normalizeMonth).join('、') || '无';
  const searchDemandTrend = searchDemandLifecycleEvidence(seasonalityData);
  const dataConsistency = (() => {
    if (!googlePeakMonths.length || !(s.oalurPeakMonths || []).length) return s.googleVsOalurDeviation || 'Google 或 Oalur 峰值月不足，无法做峰值一致性判断';
    const gtSet = new Set(googlePeakMonths.map(m => parseInt(String(m).match(/\d{1,2}/)?.[0] || '0', 10)).filter(Boolean));
    const oalurSet = new Set((s.oalurPeakMonths || []).map(m => parseInt(String(m).match(/\d{1,2}/)?.[0] || '0', 10)).filter(Boolean));
    const overlap = [...gtSet].filter(m => oalurSet.has(m));
    if (overlap.length === 0) return '峰值月份不一致，请优先以 Oalur 站内搜索量为准';
    if (overlap.length < Math.min(gtSet.size, oalurSet.size)) return '峰值月份部分一致，Oalur 站内峰值可能滞后或更集中';
    return '峰值月份一致';
  })();
  const seasonAdvice = sType === '强季节性'
    ? '该品类旺季集中，需提前 2-3 个月完成采购和入仓，淡季库存与现金流风险较高。'
    : '季节性压力相对较低，但仍需结合站内搜索量、BSR 和广告成本验证全年稳定性。';

  replacements['{{SEASONALITY_SUMMARY}}'] = `<span style="color:${sColor};font-weight:700">${sType}</span>`;
  replacements['{{SEASONALITY_SUMMARY_CLASS}}'] = '';
  replacements['{{KEYWORD_RECOMMENDATION_BLOCK}}'] = abaKeywordRecommendationBlock;
  replacements['{{SEASONALITY_BLOCK}}'] = `
<div class="card">
  <h2>季节性与市场趋势分析</h2>
  ${abaKeywordRecommendationInline}
  <div class="metric-grid">
    <div class="metric"><div class="value" style="color:${sColor}">${sType}</div><div class="label">季节性类型</div></div>
    <div class="metric"><div class="value">${sScore}</div><div class="label">季节性得分</div></div>
    <div class="metric"><div class="value">${googlePeaks}</div><div class="label">Google 峰值月</div></div>
    <div class="metric"><div class="value">${oalurPeaks}</div><div class="label">Oalur 峰值月</div></div>
  </div>
  <div style="padding:10px 14px;background:#f0f5ff;border-radius:8px;font-size:13px;line-height:1.8;margin-bottom:16px;">
    <strong>数据一致性：</strong>${dataConsistency}<br>
    <strong>Google 判断口径：</strong>${googlePeakNote}<br>
    <strong>搜索量趋势：</strong>${searchDemandTrend.text}<br>
    <strong>知识库解读：</strong>${seasonAdvice} 判断季节性必须用 Google Trends、站内搜索量、BSR/销量趋势交叉验证，不能只看单一工具。<br>
    <strong>TOP3 最近6月：</strong>点击份额 ${avgClick == null ? '未采集' : avgClick.toFixed(1) + '%'}；转化份额 ${avgConvert == null ? '未采集' : avgConvert.toFixed(1) + '%'}。
  </div>
  <div class="chart-row">
    <div>
      <h2>Google Trends 搜索兴趣</h2>
      <div class="chart-container"><canvas id="seasonGtChart"></canvas></div>
      ${googleTrendsStatusBlock}
    </div>
    <div>
      <h2>Oalur 月度搜索量</h2>
      <div class="chart-container"><canvas id="seasonSearchChart"></canvas></div>
      <div style="margin-top:8px;padding:10px 12px;background:#fff7e6;border-radius:8px;font-size:12px;line-height:1.8;color:#555;">
        <strong>搜索量递进趋势：</strong>${searchDemandTrend.text}<br>
        <strong>判断口径：</strong>先按全周期一分为二判断长期趋势，再把后半段一分为二判断近期趋势，最后把近期段继续一分为二判断当前趋势；该结果同时进入生命周期评分。
      </div>
    </div>
  </div>
  <div class="chart-row">
    <div>
      <h2>机会指数与在售商品数</h2>
      <div class="chart-container"><canvas id="seasonOppChart"></canvas></div>
      <div style="margin-top:8px;padding:10px 12px;background:#f0f5ff;border-radius:8px;font-size:12px;line-height:1.8;color:#555;">
        <strong>量化结论：</strong>${oppDecisionText}<br>
        <strong>分析：</strong>${oppAnalysisText}<br>
        <strong>供给侧：</strong>${productAnalysisText}<br>
        <strong>评判标准：</strong>${oppStandardText}
      </div>
      <table style="margin-top:12px;">
        <tr><th>指标</th><th>当前值</th><th>知识库标准</th><th>判定</th><th>说明</th></tr>
        ${oppQuantRows}
      </table>
    </div>
    <div>
      <h2>TOP3 点击份额与转化份额</h2>
      <div class="chart-container"><canvas id="seasonTop3Chart"></canvas></div>
      <div style="margin-top:8px;padding:10px 12px;background:#fff7e6;border-radius:8px;font-size:12px;line-height:1.8;color:#555;">
        <strong>分析：</strong>${top3AnalysisText}<br>
        <strong>评判标准：</strong>${top3StandardText}
      </div>
      <table style="margin-top:12px;">
        <tr><th>指标</th><th>当前值</th><th>知识库标准</th><th>判定</th><th>说明</th></tr>
        ${top3QuantRows}
      </table>
    </div>
  </div>
</div>`;
  replacements['{{SEASONALITY_BLOCK}}'] += `
<script>
(function(){
  function drawChart(id, config) {
    var el = document.getElementById(id);
    if (el && window.Chart) new Chart(el, config);
  }
  drawChart('seasonGtChart', {
    type: 'line',
    data: { labels: ${JSON.stringify(gtLabels)}, datasets: [{ label: 'Google Trends', data: ${JSON.stringify(gtValues)}, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', tension: 0.25, fill: true }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }
  });
  drawChart('seasonSearchChart', {
    type: 'bar',
    data: { labels: ${JSON.stringify(searchSeries.labels)}, datasets: [{ label: '月度搜索量', data: ${JSON.stringify(searchSeries.values)}, backgroundColor: 'rgba(251,146,60,0.65)', borderColor: '#fb923c', borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
  drawChart('seasonOppChart', {
    type: 'line',
    data: { labels: ${JSON.stringify(oppSeries.labels)}, datasets: [
      { label: '机会指数', data: ${JSON.stringify(oppSeries.values)}, borderColor: '#9333ea', backgroundColor: 'rgba(147,51,234,0.08)', tension: 0.25, yAxisID: 'y' },
      { label: '在售商品数', data: ${JSON.stringify(productSeries.values)}, borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.08)', tension: 0.25, yAxisID: 'y1' }
    ] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, position: 'left' }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } } }
  });
  drawChart('seasonTop3Chart', {
    type: 'line',
    data: { labels: ${JSON.stringify(clickSeries.labels)}, datasets: [
      { label: 'TOP3 点击份额', data: ${JSON.stringify(clickSeries.values)}, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)', tension: 0.25 },
      { label: 'TOP3 转化份额', data: ${JSON.stringify(convertValues)}, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.08)', tension: 0.25 }
    ] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100 } } }
  });
})();
</script>`;
} else {
  replacements['{{SEASONALITY_BLOCK}}'] = '';
}

// ============ ASIN lifecycle analysis ============
if (lifecycleData && lifecycleData.products && lifecycleData.products.length > 0) {
  const lifecycleKeyword = (jsonData.keyword || 'unknown').replace(/\s+/g, '-');
  const lifecycleReportsDir = outputDirsFromDataFile(resolvedDataPath, lifecycleKeyword).reports;
  const lifecycleReportName = fs.existsSync(lifecycleReportsDir)
    ? (fs.readdirSync(lifecycleReportsDir)
      .filter(name => name.includes('ASIN生命周期趋势分析') && name.endsWith('.html'))
      .map(name => ({ name, mtimeMs: fs.statSync(path.join(lifecycleReportsDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name || `${REPORT_DATE}_${lifecycleKeyword}_ASIN生命周期趋势分析.html`)
    : `${REPORT_DATE}_${lifecycleKeyword}_ASIN生命周期趋势分析.html`;
  const normalizeLifecycle = (value) => {
    const raw = String(value || '');
    if (raw.includes('衰') || raw.includes('琛伴')) return '衰退期';
    if (raw.includes('后期') || raw.includes('鍚庢湡')) return '成熟后期';
    if (raw.includes('成熟') || raw.includes('鎴愮啛')) return '健康成熟';
    return raw || '未识别';
  };
  const lifecycleRows = lifecycleData.products.map(p => {
    const lifecycleScore = lifecycleScoreForProduct(p);
    const priceChangePct = p.priceFirst > 0 ? ((p.priceLast / p.priceFirst - 1) * 100).toFixed(1) : '0';
    const priceArrow = parseFloat(priceChangePct) > 5 ? '↑' : parseFloat(priceChangePct) < -5 ? '↓' : '→';
    const bsrChange = p.bsrFirst > 0 && p.bsrLast > 0 ? (p.bsrLast - p.bsrFirst) : 0;
    const bsrArrow = bsrChange > 0 ? '↓' : bsrChange < 0 ? '↑' : '→';
    const lifecycle = normalizeLifecycle(p.lifecycle);
    return `<tr>
      <td><a href="https://www.amazon.com/dp/${p.asin}" target="_blank">${p.asin}</a></td>
      <td>$${p.priceFirst.toFixed(2)} → $${p.priceLast.toFixed(2)} ${priceArrow}（${priceChangePct}%）</td>
      <td>#${p.bsrFirst.toLocaleString()} → #${p.bsrLast.toLocaleString()} ${bsrArrow}</td>
      <td>${p.ratingsFirst.toLocaleString()} → ${p.ratingsLast.toLocaleString()}（${p.ratingPerMonth}/月）</td>
      <td>${lifecycleScore.score}/5</td>
      <td>${lifecycleScore.risks.length ? lifecycleScore.risks.join('；') : '未命中明显风险'}</td>
      <td><span class="${p.lifecycleClass}">${lifecycle}</span></td>
    </tr>`;
  }).join('\n');
  const lifecycleOverall = lifecycleRiskEvidence(lifecycleData, seasonalityData);
  const lifecycleReportPath = path.join(lifecycleReportsDir, lifecycleReportName);
  if (fs.existsSync(lifecycleReportPath) && lifecycleOverall.demand) {
    const marker = '<!-- CATEGORY_SEARCH_LIFECYCLE_BLOCK -->';
    const searchLifecycleBlock = `${marker}
  <section class="card"><h2>品类搜索量生命周期补充</h2>
    <p>生命周期综合判断不只看抽样 ASIN，也加入关键词整体搜索量趋势。</p>
    <p><strong>${escapeHtml(lifecycleOverall.demand.level)}</strong>：${escapeHtml(lifecycleOverall.demand.text)}</p>
    <p>首页最终评分口径：季节性风险 6 分 + 搜索需求生命周期 9 分。搜索量趋势按长期、近期、当前递进分段判断，老品 ASIN 只作为验证信号，不计入最终评分。</p>
  </section>`;
    const oldLifecycleHtml = fs.readFileSync(lifecycleReportPath, 'utf-8');
    const cleanedLifecycleHtml = oldLifecycleHtml.replace(new RegExp(`${marker}[\\s\\S]*?<section class="card"><h2>知识库生命周期判定标准</h2>`), '<section class="card"><h2>知识库生命周期判定标准</h2>');
    const patchedLifecycleHtml = cleanedLifecycleHtml.replace('<section class="card"><h2>知识库生命周期判定标准</h2>', `${searchLifecycleBlock}\n  <section class="card"><h2>知识库生命周期判定标准</h2>`);
    fs.writeFileSync(lifecycleReportPath, patchedLifecycleHtml, 'utf-8');
  }

  replacements['{{LIFECYCLE_BLOCK}}'] = `
<div class="card">
  <h2>老品 ASIN 生命周期分析</h2>
  <p style="color:#666;font-size:13px;margin-bottom:12px;">
    从当前市场中抽取上架时间较长的代表性 ASIN，基于 Oalur 导出的 <strong>Buybox 价格 / Ratings 数 / 大类 BSR</strong> 趋势判断生命周期。
  </p>
  <div style="padding:10px 14px;background:#fff7e6;border-left:4px solid #faad14;border-radius:8px;font-size:13px;line-height:1.8;margin-bottom:12px;">
    <strong>独立老品 ASIN 生命周期分析报告：</strong>
    <a href="./${lifecycleReportName}" target="_blank">${lifecycleReportName}</a><br>
    主报告只展示生命周期摘要；完整价格、Ratings、BSR 趋势图请打开该独立报告查看。<br>
    <strong>生命周期量化结论：</strong>${lifecycleOverall.level}；${lifecycleOverall.text}
  </div>
  <table>
    <tr><th>ASIN</th><th>价格趋势</th><th>BSR 趋势</th><th>Ratings 增长</th><th>得分</th><th>命中风险</th><th>生命周期</th></tr>
    ${lifecycleRows}
  </table>
  <div style="margin-top:12px;padding:8px 12px;background:#f0f5ff;border-radius:6px;font-size:12px;color:#666;line-height:1.8;">
    <strong>生命周期量化标准：</strong><br>
    每个 ASIN 满分 5 分。未命中风险=5分；命中1项=3分；命中2项=1分；命中3项=0分。风险项：价格后半段比前半段下降 ≥7%；大类 BSR 后半段比前半段恶化 ≥15%；Ratings 月增速后半段比前半段放缓 ≥50%。<br>
    首页最终评分口径：季节性风险 6 分 + 搜索需求生命周期 9 分。品类搜索量生命周期先按全周期一分为二，再把后半段继续一分为二判断近期趋势，最后把近期段再一分为二判断当前趋势；老品 ASIN 只作为验证信号，并观察严重风险 ASIN 占比，不计入最终评分。<br>
    <strong>当前缺口：</strong>生命周期判断仍依赖 Oalur 可导出的有限 ASIN 与搜索量趋势，建议继续扩大样本，并结合广告位、价格促销频率和断货记录验证。
  </div>
</div>`;
}

// 鎵ц鏇挎崲
// ============ 知识库缺口审计与产品缺陷提示 ============
const auditItems = [];

function auditRow(level, item, current, impact, nextStep) {
  const color = level === '高风险' ? '#ff4d4f' : level === '中风险' ? '#faad14' : '#1890ff';
  return `<tr>
    <td style="font-weight:bold;color:${color};white-space:nowrap;">${level}</td>
    <td>${item}</td>
    <td>${current}</td>
    <td>${impact}</td>
    <td>${nextStep}</td>
  </tr>`;
}

const avgPriceNumForAudit = parseFloat(String(avgPrice).replace('$', '')) || 0;
const lowPriceRisk = priceNums.length > 0 && priceNums.filter(p => p < 10).length / priceNums.length > 0.5;
const top20AvgReviewNumForAudit = numFromDisplay(top20AvgReviews) ?? 0;
const reviewBarrierHigh = top20AvgReviewNumForAudit >= 600 || reviewMedian >= 350 || top20LowReviewCount < 3;
const strongSeasonal = seasonalityData?.seasonality?.seasonalityType === '强季节性';
const oalurPeakMonths = seasonalityData?.seasonality?.oalurPeakMonths || [];
const top3ClickTrend = seasonalityData?.oalurVolumeData?.topClickRatioTrend || null;
const top3ConvertTrend = seasonalityData?.oalurVolumeData?.topConvertRatioTrend || null;
function avgLastTrendValues(obj, count = 6) {
  const vals = Object.entries(obj || {}).sort().slice(-count).map(([, v]) => Number(v)).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
const top3ClickLast6 = avgLastTrendValues(top3ClickTrend);
const top3ConvertLast6 = avgLastTrendValues(top3ConvertTrend);

auditItems.push(auditRow(
  data.length <= 30 ? '高风险' : '中风险',
  '市场容量最低门槛',
  `过滤后 ${data.length} 个产品；知识库最低门槛为 BSR 底线内 >30 个高相关 SKU`,
  data.length <= 30 ? '当前样本低于最低容量门槛，说明该细分类目有效需求或可竞争坑位不足。' : '数量刚过最低线时仍需结合评论壁垒、利润和新品存活率判断。',
  '用 Amazon 最小类目页或其他工具交叉验证该类目 BSR 底线内 SKU 数，确认不是 Oalur 搜索词口径偏窄。'
));

auditItems.push(auditRow(
  lowPriceRisk ? '高风险' : '中风险',
  '利润与现金流未验证',
  `均价 ${avgPrice}；Oalur 平均 FBA ${avgFbaFee == null ? '未采集' : '$' + avgFbaFee.toFixed(2)}；平均毛利率 ${avgMarginPct == null ? '未采集' : avgMarginPct.toFixed(1) + '%'}；<$10 产品占 ${lowPricePct}%`,
  `知识库要求毛利率 >=35%，售价至少为成本 4 倍，且有效成本率 >100%。当前已做 Oalur FBA&毛利率快筛，但没有采购成本、头程、包装、CPC 和有效成本率，仍不能证明该品类最终可赚钱。${avgPriceNumForAudit < 10 ? ' 低客单价会压缩广告和退货容错空间。' : ''}`,
  '补采 2-3 家供应商中间段 MOQ 报价、包装尺寸/重量、头程、CPC 和佣金口径，复核毛利率与有效成本率。'
));

auditItems.push(auditRow(
  reviewBarrierHigh ? '高风险' : '中风险',
  '评论壁垒偏高',
  `前20平均预估评论 ${top20AvgReviews}；预估评论中位数 ${reviewMedian.toLocaleString()}；前20中预估评论<100 的产品 ${top20LowReviewCount} 个`,
  '知识库标准为前20平均预估评论 <600、预估评论中位数 <350、前20中预估评论<100 至少 3 个。当前评论壁垒偏高，新品转化和自然排名追赶成本较大。',
  '补采前 10-20 个竞品的评论时间分布、差评标题、QA 和评分结构，区分真实壁垒与可改进缺陷机会。'
));

auditItems.push(auditRow(
  strongSeasonal ? '高风险' : '中风险',
  '季节性与库存风险',
  strongSeasonal ? `强季节性；Oalur 旺季月份：${oalurPeakMonths.join('、') || '未识别'}` : `季节性：${seasonalityData?.seasonality?.seasonalityType || '未分析'}`,
  '知识库要求季节性产品做 Google Trends、站内搜索量和 BSR 波动交叉验证。强季节性会放大备货、现金流和错过旺季窗口的风险。',
  '补充旺季前 3 个月备货计划、供应商交期、补货周期、淡季清仓策略，并验证 ASIN 多年同月 BSR/销量波动。'
));

auditItems.push(auditRow(
  '中风险',
  'CPC 与广告壁垒未验证',
  '当前报告没有核心关键词 CPC、首页广告位品牌结构、旺季 CPC 波动',
  '知识库将 $1.4 CPC 作为美国站十人团队上限；若 CPC 超标，即使市场容量够，也可能被广告成本吞噬利润。',
  '补采核心 3-5 个关键词 CPC、首页广告位品牌、旺季/淡季 CPC，并加入 ACoS 容忍度判断。'
));

auditItems.push(auditRow(
  '中风险',
  '专利/认证风险未排查',
  `目标类目：${targetCategoryDisplay || '--'}；当前报告未检查 USPTO、外观专利、食品接触材料或儿童产品认证`,
  '知识库指出“需求大但卖家少”可能意味着专利或认证门槛。Cookie Cutter 属厨房/食品接触工具，材料安全与食品接触合规需要单独确认。',
  '补充 USPTO/Google 图片/专利库检索、食品接触材料要求、工厂认证文件，报告中增加合规结论。'
));

auditItems.push(auditRow(
  '中风险',
  '用户痛点和产品缺陷未解析',
  '当前只抓了 Ratings 数，评论数按 Ratings × 8% 估算；没有抓评论标题、1-3 星差评、QA、具体抱怨词',
  '知识库要求从差评和 QA 中提炼具体产品因素，否则无法判断应改尺寸、材质、锋利度、清洗便利性、套装组合还是包装。',
  '抓取前 10 个竞品评论标题/差评/QA，输出高频痛点、对应产品因素和可执行改款方向。'
));

auditItems.push(auditRow(
  (parseFloat(top3ItemShare) > 45 || parseFloat(top3BrandShare) > 45) ? '高风险' : '中风险',
  '标品/非标品差异化不足',
  top3ClickLast6 != null && top3ConvertLast6 != null
    ? `最近6月 TOP3 点击份额均值 ${top3ClickLast6.toFixed(1)}%，转化份额均值 ${top3ConvertLast6.toFixed(1)}%`
    : '缺少 TOP3 点击/转化趋势或关键词长尾分布',
  '知识库指出标品普货会越来越卷，必须走自主设计、组合微创新或高端定位。仅靠市场容量不能证明可进入。',
  '补采核心词/长尾词分布、竞品功能/尺寸/套装/材质矩阵，增加“可差异化切入点”表。'
));

auditItems.push(auditRow(
  '中风险',
  '供应链、包装与成本口径缺失',
  `当前已解析 Oalur FBA 估算，平均 ${avgFbaFee == null ? '未采集' : '$' + avgFbaFee.toFixed(2)}；但未量化包装方案、头程、MOQ 和供应商专业度`,
  '知识库强调包装高度/尺寸会直接改变 FBA 费用，MOQ 和中间段价格决定真实首单现金流。',
  '从抓取数据中增加重量/体积分布；补充供应商报价、包装尺寸和头程后复核 FBA 档位和包装优化空间。'
));

auditItems.push(auditRow(
  historicalData ? '中风险' : '高风险',
  '数据口径仍需交叉验证',
  historicalData ? `已加载 ${historicalData.timeFilter} 历史数据，但仍是 Oalur 可见榜单口径` : '未加载历史数据',
  '知识库要求最小类目页、长期 BSR 波动、多工具交叉验证。当前数据来自 Oalur 页面，不等于 Amazon 原生最小类目的完整历史。',
  '保留数据口径说明；必要时用 Amazon 最小类目页、Keepa/Helium10 与 Oalur 数据交叉验证。'
));

replacements['{{KNOWLEDGE_AUDIT_BLOCK}}'] = '';

// ============ Final product-deepening decision ============
function numFromDisplay(value) {
  const n = parseFloat(String(value ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function lastNumericTrendPoint(trend) {
  const entries = Object.entries(trend || {})
    .sort()
    .map(([month, value]) => ({ month, value: Number(value) }))
    .filter(item => Number.isFinite(item.value));
  return entries.length ? entries[entries.length - 1] : null;
}

function monthlyAverageRatioFromSeries(items) {
  const grouped = {};
  items.forEach(item => {
    if (!item.month || !Number.isFinite(item.value)) return;
    const month = String(item.month).match(/-(\d{2})/)?.[1] || String(item.month).match(/^(\d{1,2})$/)?.[1];
    if (!month) return;
    const key = month.padStart(2, '0');
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item.value);
  });
  const avgs = Object.values(grouped)
    .map(vals => vals.reduce((a, b) => a + b, 0) / vals.length)
    .filter(v => Number.isFinite(v) && v > 0);
  if (avgs.length < 6) return null;
  const min = Math.min(...avgs);
  const max = Math.max(...avgs);
  return min > 0 ? max / min : null;
}

function googleSeasonalityRatio(dataObj) {
  const points = dataObj?.googleTrendsData?.data5Years || dataObj?.googleTrendsData?.data || [];
  return monthlyAverageRatioFromSeries(points.map(p => ({
    month: String(p.date || '').substring(0, 7),
    value: Number(p.value)
  })));
}

function oalurSeasonalityRatio(dataObj) {
  return monthlyAverageRatioFromSeries(Object.entries(dataObj?.oalurVolumeData?.searchesTrend || {}).map(([month, value]) => ({
    month,
    value: Number(value)
  })));
}

function asinRevenueSeasonalityRatio(dataObj) {
  const products = dataObj?.asinTrendsData?.products || [];
  const items = [];
  products.forEach(product => {
    const months = product.trendData?.months || [];
    const revenues = product.trendData?.monthlyRevenue || [];
    months.forEach((month, idx) => {
      const value = Number(String(revenues[idx] || '').replace(/[$,]/g, ''));
      if (Number.isFinite(value) && value > 0) items.push({ month, value });
    });
  });
  return monthlyAverageRatioFromSeries(items);
}

function normalizeSeasonalityLabel(value, score) {
  const text = String(value || '');
  if (text.includes('强') || text.includes('寮哄') || Number(score) >= 60) return '强季节性';
  if (text.includes('弱') || text.includes('寮卞') || Number(score) >= 30) return '弱季节性';
  if (!text || text === 'undefined') return '未分析';
  return text;
}

function seasonalityRiskEvidence(dataObj) {
  if (!dataObj?.seasonality) {
    return { level: '未分析', score: 3, confirmed: false, suspected: false, text: '未加载季节性数据，暂按中性分处理。' };
  }
  const s = dataObj.seasonality;
  const label = normalizeSeasonalityLabel(s.seasonalityType, s.seasonalityScore);
  const gtRatio = googleSeasonalityRatio(dataObj);
  const oalurRatio = oalurSeasonalityRatio(dataObj);
  const asinRatio = asinRevenueSeasonalityRatio(dataObj);
  const evidence = [];
  if (gtRatio != null && gtRatio >= 2) evidence.push(`Google 多年月均峰谷比 ${gtRatio.toFixed(2)} ≥ 2`);
  if (oalurRatio != null && oalurRatio >= 2.5) evidence.push(`Oalur 站内搜索峰谷比 ${oalurRatio.toFixed(2)} ≥ 2.5`);
  if (asinRatio != null && asinRatio >= 2) evidence.push(`老品 ASIN 月销售额峰谷比 ${asinRatio.toFixed(2)} ≥ 2`);
  if (label === '强季节性' && evidence.length >= 2) {
    return { level: '明确强季节性', score: 0, confirmed: true, suspected: false, text: `${evidence.join('；')}。至少两类证据成立，作为最终评分扣分项。` };
  }
  if (label === '强季节性' || evidence.length === 1) {
    return { level: '疑似季节性', score: 2, confirmed: false, suspected: true, text: `${evidence.join('；') || `报告标签为${label}`}。证据不足两类，不作为一票否决。` };
  }
  if (label === '弱季节性') {
    return { level: '弱季节性', score: 4, confirmed: false, suspected: false, text: '有一定季节波动，但未达到强季节性验证条件。' };
  }
  return { level: '非强季节性', score: 5, confirmed: false, suspected: false, text: '未发现强季节性多源证据。' };
}

function seasonalityFinalScore(evidence) {
  if (!evidence || evidence.level === '未分析') {
    return { score: 3, text: '季节性数据不足，按中性偏保守计 3/6。' };
  }
  if (evidence.confirmed) {
    const strongEvidenceCount = (evidence.text.match(/≥/g) || []).length;
    const score = strongEvidenceCount >= 3 ? 0 : 2;
    return { score, text: `强季节性已由多源证据确认，按 ${score}/6 计分。` };
  }
  if (evidence.suspected) return { score: 3, text: '疑似强季节性但证据不足两类，按 3/6 计分。' };
  if (evidence.level === '弱季节性') return { score: 4, text: '弱季节性，按 4/6 计分。' };
  return { score: 6, text: '未发现强季节性多源证据，按 6/6 计分。' };
}

function lifecycleScoreForProduct(p) {
  const priceFirst = Number(p.avgPriceFirst || p.priceFirst || 0);
  const priceSecond = Number(p.avgPriceSecond || p.priceLast || 0);
  const bsrFirst = Number(p.avgBsrFirst || p.bsrFirst || 0);
  const bsrSecond = Number(p.avgBsrSecond || p.bsrLast || 0);
  const growthFirst = Number(p.growthFirst || 0);
  const growthLast = Number(p.growthLast || 0);
  const priceChangePct = priceFirst > 0 && priceSecond > 0 ? (priceSecond / priceFirst - 1) * 100 : null;
  const bsrChangePct = bsrFirst > 0 && bsrSecond > 0 ? (bsrSecond / bsrFirst - 1) * 100 : null;
  const ratingsSlowdownPct = growthFirst > 0 ? (1 - growthLast / growthFirst) * 100 : null;
  const risks = [];
  if (priceChangePct != null && priceChangePct <= -7) risks.push('价格下行≥7%');
  if (bsrChangePct != null && bsrChangePct >= 15) risks.push('大类BSR恶化≥15%');
  if (ratingsSlowdownPct != null && ratingsSlowdownPct >= 50) risks.push('Ratings增速放缓≥50%');
  const score = risks.length === 0 ? 5 : risks.length === 1 ? 3 : risks.length === 2 ? 1 : 0;
  const level = risks.length === 0 ? '健康/稳定'
    : risks.length === 1 ? '轻度风险'
      : risks.length === 2 ? '明显下行'
        : '衰退风险';
  return { score, level, risks, priceChangePct, bsrChangePct, ratingsSlowdownPct };
}

function searchDemandLifecycleEvidence(seasonalityObj) {
  const trend = seasonalityObj?.oalurVolumeData?.searchesTrend || {};
  const entries = Object.entries(trend)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, value]) => ({ month, value: Number(value) }))
    .filter(item => Number.isFinite(item.value));
  const values = entries.map(item => item.value);
  if (values.length < 8) {
    return { score: 3, score6: 3, level: '搜索量未充分分析', text: 'Oalur 搜索量趋势点不足，按中性偏保守处理。', deltaPct: null };
  }
  const avg = (items) => items.length ? items.reduce((sum, item) => sum + item.value, 0) / items.length : null;
  const pct = (from, to) => from > 0 && to != null ? (to / from - 1) * 100 : null;
  const mid = Math.floor(values.length / 2);
  const first = entries.slice(0, mid);
  const second = entries.slice(mid);
  const secondMid = Math.floor(second.length / 2);
  const recentBase = second.slice(0, secondMid);
  const recent = second.slice(secondMid);
  const recentMid = Math.floor(recent.length / 2);
  const currentBase = recent.slice(0, recentMid);
  const current = recent.slice(recentMid);
  const avgFirst = avg(first);
  const avgSecond = avg(second);
  const avgRecentBase = avg(recentBase);
  const avgRecent = avg(recent);
  const avgCurrentBase = avg(currentBase);
  const avgCurrent = avg(current);
  const longDeltaPct = pct(avgFirst, avgSecond);
  const recentDeltaPct = pct(avgRecentBase, avgRecent);
  const currentDeltaPct = pct(avgCurrentBase, avgCurrent);
  const currentVsHistoryPct = pct(avgFirst, avgCurrent);
  const longScore = longDeltaPct == null ? 3 : longDeltaPct >= 10 ? 5 : longDeltaPct >= -10 ? 4 : longDeltaPct >= -25 ? 2 : 0;
  const recentScore = recentDeltaPct == null ? 3 : recentDeltaPct >= 8 ? 5 : recentDeltaPct >= -8 ? 4 : recentDeltaPct >= -20 ? 2 : 0;
  const currentScore = currentDeltaPct == null ? 3 : currentDeltaPct >= 5 ? 5 : currentDeltaPct >= -5 ? 4 : currentDeltaPct >= -15 ? 2 : 0;
  const currentLevelScore = currentVsHistoryPct == null ? 3 : currentVsHistoryPct >= 10 ? 5 : currentVsHistoryPct >= -10 ? 4 : currentVsHistoryPct >= -25 ? 2 : 0;
  const score = Math.round((longScore * 0.25) + (recentScore * 0.25) + (currentScore * 0.3) + (currentLevelScore * 0.2));
  const trendKind = (delta) => {
    if (delta == null) return '?';
    if (delta <= -10) return 'D';
    if (delta <= 10) return 'S';
    if (delta <= 25) return 'U';
    return 'X';
  };
  const isGrowth = kind => kind === 'U' || kind === 'X';
  const longKind = trendKind(longDeltaPct);
  const recentKind = trendKind(recentDeltaPct);
  const currentKind = trendKind(currentDeltaPct);
  const trendKey = `${longKind}-${recentKind}-${currentKind}`;
  const score6 = (() => {
    if (trendKey.includes('?')) return 3;
    if (longKind === 'D' && recentKind === 'D' && currentKind === 'D') return 0;
    if (recentKind === 'D' && currentKind === 'D') return longKind === 'D' ? 0 : 1;
    if (longKind !== 'D' && isGrowth(recentKind) && isGrowth(currentKind)) return 6;
    if (longKind !== 'D' && (currentKind === 'S' || isGrowth(currentKind))) return 5;
    if (longKind === 'D' && isGrowth(recentKind) && isGrowth(currentKind)) return 4;
    if (longKind === 'D' && (isGrowth(recentKind) || isGrowth(currentKind) || currentKind === 'S')) return 3;
    if (currentKind === 'D') return 2;
    return 3;
  })();
  const level = score >= 5 ? '搜索需求增长'
    : score >= 4 ? '搜索需求稳定'
      : score >= 2 ? '搜索需求回落'
        : '搜索需求明显下行';
  const fmtPct = value => value == null ? '无法计算' : `${value.toFixed(1)}%`;
  const text = `Oalur 搜索量递进分段：历史基准均值 ${avgFirst.toFixed(0)}，后半段均值 ${avgSecond.toFixed(0)}（长期 ${fmtPct(longDeltaPct)}，${longKind}）；近期前段均值 ${avgRecentBase.toFixed(0)}，近期后段均值 ${avgRecent.toFixed(0)}（近期 ${fmtPct(recentDeltaPct)}，${recentKind}）；当前前段均值 ${avgCurrentBase.toFixed(0)}，当前段均值 ${avgCurrent.toFixed(0)}（当前 ${fmtPct(currentDeltaPct)}，${currentKind}，当前相对历史 ${fmtPct(currentVsHistoryPct)}），趋势组合 ${trendKey}，搜索需求生命周期得 ${score6}/6，判定为${level}。`;
  return {
    score,
    score6,
    level,
    text,
    deltaPct: longDeltaPct,
    longDeltaPct,
    recentDeltaPct,
    currentDeltaPct,
    currentVsHistoryPct,
    longKind,
    recentKind,
    currentKind,
    trendKey,
    avgFirst,
    avgSecond,
    avgRecentBase,
    avgRecent,
    avgCurrentBase,
    avgCurrent,
    segments: {
      first: first.map(item => item.month),
      second: second.map(item => item.month),
      recentBase: recentBase.map(item => item.month),
      recent: recent.map(item => item.month),
      currentBase: currentBase.map(item => item.month),
      current: current.map(item => item.month)
    }
  };
}

function oldAsinLifecycleFinalEvidence(dataObj) {
  const products = Array.isArray(dataObj?.products) ? dataObj.products : [];
  if (!products.length) {
    return { score: 1, level: '老品样本缺失', text: '未加载老品 ASIN 生命周期数据，按 1/3 保守计分。', rows: [] };
  }
  const rows = products.map(p => ({ asin: p.asin, ...lifecycleScoreForProduct(p) }));
  const severeCount = rows.filter(row => row.score <= 1).length;
  const severeShare = severeCount / rows.length;
  let score = severeShare === 0 ? 3 : severeShare <= 0.25 ? 2 : severeShare <= 0.5 ? 1 : 0;
  if (rows.length < 3) score = Math.min(score, 2);
  const level = score >= 3 ? '老品信号健康'
    : score >= 2 ? '老品轻微风险'
      : score >= 1 ? '老品风险偏高'
        : '老品风险明显';
  const riskCount = rows.filter(row => row.risks.length > 0).length;
  const text = `${rows.length} 个老品 ASIN 中 ${riskCount} 个命中风险，严重风险 ${severeCount} 个（${(severeShare * 100).toFixed(1)}%）；老品 ASIN 验证项得 ${score}/3。${rows.length < 3 ? '样本少于 3 个，最高只给 2 分。' : ''}`;
  return { score, level, text, rows, severeCount, severeShare, riskCount };
}

function lifecycleRiskEvidence(dataObj, seasonalityObj) {
  const products = Array.isArray(dataObj?.products) ? dataObj.products : [];
  const demand = searchDemandLifecycleEvidence(seasonalityObj);
  const demandScore = Number.isFinite(demand.score6) ? demand.score6 : demand.score;
  if (!products.length) {
    return { score: demandScore, level: demand.level, text: `未加载老品 ASIN 生命周期数据，生命周期仅参考搜索量趋势。${demand.text}`, rows: [], demand };
  }
  const rows = products.map(p => ({ asin: p.asin, ...lifecycleScoreForProduct(p) }));
  const avgScore = rows.reduce((s, row) => s + row.score, 0) / rows.length;
  const severeCount = rows.filter(row => row.score <= 1).length;
  const riskCount = rows.filter(row => row.risks.length > 0).length;
  const severeShare = severeCount / rows.length;
  let asinScore3 = severeShare === 0 ? 3 : severeShare <= 0.25 ? 2 : severeShare <= 0.5 ? 1 : 0;
  if (rows.length < 3) asinScore3 = Math.min(asinScore3, 2);
  const combinedScore = demandScore + asinScore3;
  const level = combinedScore >= 8 ? '生命周期健康'
    : combinedScore >= 6 ? '轻微生命周期风险'
      : combinedScore >= 4 ? '生命周期风险偏高'
        : '生命周期下行明显';
  const text = `${products.length} 个老品 ASIN 中 ${riskCount} 个命中生命周期风险，严重风险 ${severeCount} 个（${(severeShare * 100).toFixed(1)}%）；ASIN 平均得分 ${avgScore.toFixed(1)}/5；搜索需求生命周期 ${demandScore}/6，老品 ASIN 验证项 ${asinScore3}/3。${demand.text}`;
  return { score: combinedScore, level, text, rows, demand, asinScore: asinScore3, avgScore };
}

function scoreFinalDecision() {
  const rows = [];
  const vetoes = [];
  const addRow = (module, weight, score, current, standard, source, note) => {
    rows.push({ module, weight, score, current, standard, source, note });
  };

  const effectiveProductCountScore = data.length > 150 ? 5
    : data.length > 120 ? 4
      : data.length > 90 ? 3
        : data.length > 60 ? 2
          : data.length > 30 ? 1
            : 0;
  const bsrHeadCoverageScore = firstBsrRatio == null ? 0
    : firstBsrRatio <= 0.05 ? 4
      : firstBsrRatio <= 0.15 ? 2
        : 0;
  const bsrInternalContinuityScore = bsrGapRatio == null ? 0
    : bsrGapRatio <= 0.10 ? 6
      : bsrGapRatio <= 0.20 ? 4
        : bsrGapRatio <= 0.35 ? 2
          : bsrGapRatio <= 0.50 ? 1
            : 0;
  const bsrContinuityScore = bsrHeadCoverageScore + bsrInternalContinuityScore;
  const capacityScore = effectiveProductCountScore + bsrContinuityScore;
  addRow('市场容量', 15, capacityScore, `有效父体 ${data.length} 个，数量得分 ${effectiveProductCountScore}/5；第一个目标父体 BSR ${firstBsrValue == null ? '无法计算' : firstBsrValue.toLocaleString()}，头部覆盖 ${bsrHeadCoverageScore}/4；最大 BSR 断层 ${maxAdjacentBsrGap == null ? '无法计算' : maxAdjacentBsrGap.toLocaleString()}，断层比例 ${bsrGapRatio == null ? '无法计算' : (bsrGapRatio * 100).toFixed(1) + '%'}，内部连续 ${bsrInternalContinuityScore}/6；月销量最低 ${salesMin.toLocaleString()}，${salesFloorExpansionLevel}`, '有效父体数量5分：>150满分，>120得4，>90得3，>60得2，>30得1；BSR连续性10分=头部覆盖4分+内部连续6分；月销量最低数仅描述当前输入 BSR 范围内的样本底部。目标父体<90或最低月销量>600时，只提示增加样本，不自动扩容', '项目内部评分口径', `BSR连续性同时看头部是否有目标产品和出现目标产品后的内部断层，避免头部缺口被后段连续掩盖。${salesFloorExpansionText}`);

  const latestOppForFinal = lastNumericTrendPoint(seasonalityData?.oalurVolumeData?.oppIndexTrend);
  const latestSearchForFinal = lastNumericTrendPoint(seasonalityData?.oalurVolumeData?.searchesTrend);
  const latestProductForFinal = lastNumericTrendPoint(seasonalityData?.oalurVolumeData?.productTotalNumTrend);
  const rawOppForFinal = latestOppForFinal?.value ?? (latestSearchForFinal && latestProductForFinal && latestProductForFinal.value > 0 ? latestSearchForFinal.value / latestProductForFinal.value : null);
  const seasonLabelForFinal = normalizeSeasonalityLabel(seasonalityData?.seasonality?.seasonalityType, seasonalityData?.seasonality?.seasonalityScore);
  const oppAdjustmentForFinal = opportunityAdjustmentForContext({
    keyword: jsonData.keyword,
    category: targetCategoryDisplay,
    seasonalityType: seasonLabelForFinal
  });
  const adjustedOppForFinal = rawOppForFinal == null ? null : rawOppForFinal * oppAdjustmentForFinal.coefficient;
  const oppBaseScore = adjustedOppForFinal == null ? 5 : adjustedOppForFinal >= 2 ? 8 : adjustedOppForFinal >= 1 ? 6 : adjustedOppForFinal >= 0.5 ? 4 : adjustedOppForFinal >= 0.2 ? 2 : 0;
  const supplyTrendForFinal = supplyTrendEvidence(seasonalityData?.oalurVolumeData?.productTotalNumTrend);
  const oppScore = oppBaseScore + supplyTrendForFinal.score;
  if (adjustedOppForFinal != null && adjustedOppForFinal < 0.2) vetoes.push('行业调整后基础机会指数 <0.2，属于极致红海。');
  addRow('行业调整后机会指数', 15, oppScore, adjustedOppForFinal == null ? `机会指数未采集；在售趋势 ${supplyTrendForFinal.score}/7（${supplyTrendForFinal.level}）` : `机会指数 ${adjustedOppForFinal.toFixed(2)}（原始 ${rawOppForFinal.toFixed(2)} × ${oppAdjustmentForFinal.coefficient.toFixed(2)}），机会指数得分 ${oppBaseScore}/8；在售趋势 ${supplyTrendForFinal.score}/7（${supplyTrendForFinal.level}）`, '机会指数8分：>=2满分，1-2得6，0.5-1得4，0.2-0.5得2，<0.2得0；在售商品数趋势7分：按长期/近期/当前趋势组合真值表评分，不考虑有效机会指数', '知识库 + 项目内部系数', supplyTrendForFinal.text);

  const top1ItemShareNum = parseFloat(top1ItemShare) || 0;
  const top3ItemShareNum = parseFloat(top3ItemShare) || 0;
  const brandDispersionNum = parseFloat(brandDispersion) || 0;
  const amazonRetailShare = data.length ? (data.filter(d => d.sellerType?.includes('亚马逊')).length / data.length) * 100 : 0;
  const recentTrendAverage = (trend) => {
    const values = Object.keys(trend || {}).sort().slice(-6).map(k => Number(trend[k])).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const finalAvgClick = recentTrendAverage(seasonalityData?.oalurVolumeData?.topClickRatioTrend);
  const finalAvgConvert = recentTrendAverage(seasonalityData?.oalurVolumeData?.topConvertRatioTrend);
  const brandCr3Score = brandCr3 < 30 ? 8
    : brandCr3 < 40 ? 7
      : brandCr3 < 50 ? 5
        : brandCr3 < 60 ? 3
          : 0;
  const itemConcentrationScore = top1ItemShareNum < 15 && top3ItemShareNum < 30 ? 7
    : top1ItemShareNum < 20 && top3ItemShareNum < 35 ? 6
      : top1ItemShareNum < 30 && top3ItemShareNum < 45 ? 5
        : top1ItemShareNum < 35 && top3ItemShareNum < 55 ? 3
          : 0;
  const top3TrafficScore = finalAvgClick == null || finalAvgConvert == null ? 4
    : finalAvgClick > 50 && finalAvgConvert > 50 ? 0
      : finalAvgConvert > 50 ? 2
        : finalAvgClick > 50 ? 4
          : finalAvgClick < 20 && finalAvgConvert < 20 ? 7
            : 5;
  const dispersionSellerScore = (brandDispersionNum > 60 ? 2 : brandDispersionNum > 40 ? 1 : 0)
    + (amazonRetailShare < 10 ? 1 : 0);
  const competitionScore = brandCr3Score + itemConcentrationScore + top3TrafficScore + dispersionSellerScore;
  if (brandCr3 > 60) vetoes.push('品牌 CR3 >60%，头部品牌高垄断。');
  addRow('品牌/单品集中度', 25, competitionScore, `品牌CR3 ${top3BrandShare}% 得 ${brandCr3Score}/8；TOP1单品 ${top1ItemShare}%、TOP3单品 ${top3ItemShare}% 得 ${itemConcentrationScore}/7；TOP3点击 ${finalAvgClick == null ? '未采集' : finalAvgClick.toFixed(1) + '%'}、转化 ${finalAvgConvert == null ? '未采集' : finalAvgConvert.toFixed(1) + '%'} 得 ${top3TrafficScore}/7；品牌分散度 ${brandDispersion}%、亚马逊自营 ${amazonRetailShare.toFixed(1)}% 得 ${dispersionSellerScore}/3`, '品牌CR3 8分；TOP1/TOP3单品销量集中度7分；TOP3点击/转化份额7分；品牌分散度/卖家结构3分', '知识库 + ABA趋势', 'TOP3 点击/转化比品牌 CR3 更接近真实流量和成交垄断；FBA/FBM 只是履约方式，卖家结构只惩罚亚马逊自营占比偏高。');

  const top20AvgReviewNum = numFromDisplay(top20AvgReviews) ?? 0;
  const reviewPassCount = [
    top20AvgReviewNum < 600,
    reviewMedian < 350,
    top20LowReviewCount >= 3,
    newProductsData.length > 0
  ].filter(Boolean).length;
  const reviewScore = reviewPassCount === 4 ? 15 : reviewPassCount === 3 ? 11 : reviewPassCount === 2 ? 8 : reviewPassCount === 1 ? 3 : 0;
  addRow('评论壁垒', 15, reviewScore, `前20平均预估评论 ${top20AvgReviews}；预估中位数 ${reviewMedian.toLocaleString()}；前20低预估评论数产品 ${top20LowReviewCount} 个`, '前20平均预估评论 <600；预估中位数 <350；前20预估评论数<100的产品至少3个；近6个月有新品进前20', '知识库 + Oalur字段折算', `满足 ${reviewPassCount}/4 项。当前抓取字段是 Ratings，按 Ratings × 8% 估算评论数；评论壁垒衡量进入难度，但不应压过新品活力。`);

  const survivalScore = survivalRateData
    ? Number(survivalRateData.survivalScore || 0)
    : 0;
  const survivalScore15 = Math.round(survivalScore * 1.5);
  const newPctScore = newSalesCarryScore.score;
  const under12Score = under12mBalancedScore;
  const vitalityScore = survivalScore15 + newPctScore + under12Score;
  addRow('新品活力', 30, vitalityScore, `6个月纯新父体存活：${survivalRateData ? (survivalRateData.hasNoNewProducts ? `历史严格纯新父体样本0，中性评分 ${survivalScore}/10，折算 ${survivalScore15}/15` : `${survivalRateData.survivalRateStr}，存活评分 ${survivalScore}/10，折算 ${survivalScore15}/15`) : '未分析'}；<6月销量承接 ${newPctScore}/8（样本${newSalesCarryScore.sampleScore}/1，质量${newSalesCarryScore.qualityScore}/${newSalesCarryScore.qualityMax}，分散${newSalesCarryScore.concentrationScore}/${newSalesCarryScore.concentrationMax}）；<12月销量承接 ${under12Score}/7（覆盖${under12mCoverageScore}/2，销量${under12mSalesShareScore}/3，质量${under12mSalesQualityScore}/2）`, '存活折算15分；当前<6月纯新父体销量承接8分，按销量质量和可复制性判断；<12月纯新父体销量承接7分，按覆盖度2分 + 销量占比3分 + 销量质量2分判断。历史窗口严格纯新父体样本为0时不是未分析，也不能按新品失败处理，给中性4/10并折算6/15。', '知识库 + 我的整理', `<6月窗口样本少，重点看是否已有新 Listing 拿到有效销量；<12月窗口更宽，加入销量质量但不过度奖励成熟新品。`);

  const cpcRatio = cpcMetricRatio == null ? null : Number(cpcMetricRatio);
  const cpcScore = cpcRatio == null ? 8 : cpcRatio < 5 ? 15 : cpcRatio < 8 ? 12 : cpcRatio < 12 ? 8 : cpcRatio < 15 ? 3 : 0;
  if (cpcRatio != null && cpcRatio >= 15) vetoes.push('CPC/客单价 >=15%，广告成本风险很高。');
  addRow('广告成本', 15, cpcScore, cpcRatio == null ? '未采集' : `${cpcMetricLabel} ${cpcRatio.toFixed(2)}%`, '<5% 健康；5%-8% 可接受；8%-12% 偏高；12%-15% 高风险；>=15% 很高风险', '知识库 + Oalur ACOS', `样本优先取过滤后父体 Listing 销量前 ${cpcSampleSelection?.limit || 30}，排除价格异常和 Ratings 缺失样本，报告主指标用中位数。当前没有引入转化率模型，因此用更保守的 CPC/客单价分层。`);

  if (salesWeightedMarginPct != null && salesWeightedMarginPct < 35) vetoes.push('销量加权毛利率 <35%，低于利润底线。');
  addRow('毛利空间', 20, marginScore, `销量加权毛利率 ${fmtPct(salesWeightedMarginPct)}，得 ${weightedMarginScore}/8；低毛利销量占比 ${fmtPct(lowMarginSalesSharePct)}，得 ${lowMarginSalesScore}/5；销量加权 FBA/售价 ${fmtPct(salesWeightedFbaRatio)}，得 ${fbaPressureScore}/3；销量加权单件毛利 ${fmtMoney(salesWeightedUnitGrossProfit)}，价格带利润结构得 ${priceProfitStructureScore}/4`, '销量加权毛利率8分：≥45满分，40-45得6，35-40得4，<35得0；低毛利销量占比5分：<10满分，10-25得3，25-40得1，≥40得0；FBA/售价3分：<20满分，20-28得2，28-35得1，≥35得0；价格带利润结构4分：单件毛利≥$4满分，$3-$4得3，$2-$3得1，<$2得0；低价带销量过半且单件毛利偏低时封顶', '知识库 + 我的整理', `价格带结构：${priceBandProfitStats.map(row => `${row.label}销量${fmtPct(row.salesSharePct)}、单件毛利${fmtMoney(row.weightedUnitGrossProfit)}`).join('；')}。利润口径：${Object.entries(profitSourceCounts).map(([k, v]) => `${k}${v}个`).join('；')}。CPC/客单价 ${cpcRatio == null ? '未采集' : cpcMetricLabel + ' ' + cpcRatio.toFixed(2) + '%'} 已在广告成本中计分。`);

  const seasonRisk = seasonalityRiskEvidence(seasonalityData);
  const seasonFinal = seasonalityFinalScore(seasonRisk);
  const demandLifecycle = searchDemandLifecycleEvidence(seasonalityData);
  const demandScore = Number.isFinite(demandLifecycle.score6) ? demandLifecycle.score6 : 3;
  const oldAsinLifecycle = oldAsinLifecycleFinalEvidence(lifecycleData);
  const demandScore9 = Math.round(demandScore / 6 * 9);
  const seasonLifecycleScore = seasonFinal.score + demandScore9;
  addRow('季节性/生命周期风险', 15, seasonLifecycleScore, `季节性 ${seasonFinal.score}/6（${seasonRisk.level}）；搜索需求 ${demandScore9}/9（原始 ${demandScore}/6，${demandLifecycle.trendKey || '数据不足'}）；老品 ASIN 仅展示不计分（${oldAsinLifecycle.level}）`, '季节性6分 + 搜索需求生命周期9分；强季节性需至少两类证据；搜索需求按长期/近期/当前递进趋势组合评分；老品ASIN只作为验证信号，不进入最终评分', '知识库 + 我的整理', `${seasonFinal.text} ${demandLifecycle.text} 老品 ASIN 不计入最终评分，仅作趋势验证：${oldAsinLifecycle.text}`);

  const totalScore = rows.reduce((sum, row) => sum + row.score, 0);
  const finalLevel = vetoes.length > 0
    ? { text: '不进入产品深化', cls: 'fail' }
    : totalScore >= 120
      ? { text: '进入产品深化', cls: 'pass' }
      : totalScore >= 105
        ? { text: '补采后再判断', cls: 'caution' }
        : { text: '不进入产品深化', cls: 'fail' };

  return { rows, vetoes, totalScore, finalLevel };
}

const finalDecision = scoreFinalDecision();
const finalRowsHtml = finalDecision.rows.map(row => `
  <tr>
    <td>${row.module}</td>
    <td>${row.weight}</td>
    <td><strong>${row.score}</strong></td>
    <td>${row.current}</td>
    <td>${row.standard}</td>
    <td>${row.source}</td>
    <td>${row.note}</td>
  </tr>`).join('\n');
const finalVetoHtml = finalDecision.vetoes.length
  ? `<div style="margin-top:12px;padding:10px 12px;background:#fff2f0;border:1px solid #ffccc7;border-radius:8px;font-size:13px;line-height:1.8;color:#a8071a;"><strong>一票否决项：</strong>${finalDecision.vetoes.map(escapeHtml).join('；')}</div>`
  : `<div style="margin-top:12px;padding:10px 12px;background:#f6ffed;border:1px solid #b7eb8f;border-radius:8px;font-size:13px;line-height:1.8;color:#237804;"><strong>一票否决项：</strong>未触发。新品6个月存活率不作为一票否决，只进入核心评分。</div>`;
const childAsinReportName = `${REPORT_DATE}_${safeSegment(jsonData.keyword || 'unknown')}_子ASIN明细.html`;

replacements['{{FINAL_DECISION_BLOCK}}'] = `
<div class="card" style="border:2px solid #1677ff;">
  <h2 style="border:none;padding-left:0;">最终评判标准：是否进入产品深化阶段</h2>
  <div class="summary">
    <div class="metric"><div class="value">${finalDecision.totalScore}</div><div class="label">市场验证总分 / 150</div></div>
    <div class="metric"><div class="value" style="font-size:22px;color:${finalDecision.finalLevel.cls === 'pass' ? '#52c41a' : finalDecision.finalLevel.cls === 'caution' ? '#faad14' : '#ff4d4f'}">${finalDecision.finalLevel.text}</div><div class="label">最终结论</div></div>
    <div class="metric"><div class="value" style="font-size:18px;">≥120</div><div class="label">进入产品深化门槛</div></div>
    <div class="metric"><div class="value" style="font-size:18px;">105-119</div><div class="label">补采/复核区间</div></div>
  </div>
  <div class="conclusion ${finalDecision.finalLevel.cls}" style="font-size:18px;text-align:left;line-height:1.8;">
    ${finalDecision.finalLevel.text}。本结论是报告首页最终评判标准，只判断是否值得继续做供应链、专利、样品、包装和差异化验证，不等于直接开发。
  </div>
  ${finalVetoHtml}
  <div style="margin-top:12px;padding:10px 12px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;line-height:1.8;color:#475569;">
    <strong>相关报告：</strong><a href="./${childAsinReportName}" target="_blank">${childAsinReportName}</a><br>
    子 ASIN 明细报告展示每个父体 Listing 下的子 ASIN、类目、销量、销售额、BSR、上架时间和 Ratings；父体销量/销售额取 Oalur 代表父体行数值，父体 Ratings 按共享/独立评分规则计算。
  </div>
  <table style="margin-top:12px;">
    <tr><th>模块</th><th>权重</th><th>得分</th><th>当前值</th><th>评判标准</th><th>来源</th><th>说明</th></tr>
    ${finalRowsHtml}
  </table>
  <div style="margin-top:12px;padding:10px 12px;background:#f0f5ff;border-radius:8px;font-size:12px;line-height:1.8;color:#555;">
    <strong>口径说明：</strong>最终评判采用 150 分制：市场容量15、机会指数15、竞争结构25、评论壁垒15、新品活力30、毛利空间20、广告成本15、季节性/生命周期15。有效成本率因当前缺采购成本、头程、包装等数据，暂不参与评分，列为产品深化阶段补采项；广告成本优先取过滤后父体 Listing 销量前30样本的中位 CPC/客单价，当前没有引入转化率模型，因此按更保守阈值评分；评论壁垒按 Oalur Ratings × 8% 估算评论数；6个月纯新父体存活率只进入“新品活力”评分，不直接否决；季节性/生命周期拆成季节性风险6分、搜索需求生命周期9分；强季节性必须由 Google Trends、Oalur 站内搜索量、老品 ASIN 销售/BSR 趋势中至少两类证据确认，证据不足时只标记为疑似；搜索需求按长期/近期/当前递进分段，老品 ASIN 只作为验证信号，不计入最终评分。
  </div>
</div>`;

for (const [key, val] of Object.entries(replacements)) {
  html = html.split(key).join(val);
}

// Save report.
const keyword = (jsonData.keyword || 'unknown').replace(/\s+/g, '-');
const finalOutputDirs = outputDirsFromDataFile(resolvedDataPath, keyword);
const outPath = path.join(finalOutputDirs.reports, REPORT_DATE + '_' + keyword + '_市场分析.html');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf-8');
console.log('报告已保存:', outPath);
console.log('\n=== 摘要 ===');
console.log('关键词:', jsonData.keyword);
console.log('目标类目:', targetCategoryDisplay);
console.log('过滤后:', data.length, '条 | 排除:', excluded.length, '条');
console.log('月销量最低数:', salesMin.toLocaleString(), '|', salesFloorExpansionLevel);
console.log('新品:', newProducts, '个 (' + newPct + '%)');
console.log('结论:', conclusion, '-', reason);
console.log('\n=== 竞争分析 ===');
console.log('单品占比: TOP1=' + top1ItemShare + '%, TOP3=' + top3ItemShare + '%, TOP10=' + top10ItemShare + '%');
console.log('品牌集中度: TOP1=' + top1Brand[0] + '(' + top1BrandShare + '%), TOP3=' + top3BrandShare + '%, 分散度=' + brandDispersion + '%');
console.log('预估评论数: 平均 ' + avgReviews + ', <500 预估评论占 ' + lowReviewPct + '%（按 Ratings × 8%）');
console.log('卖家结构: ' + topSellerType[0] + ' 占比 ' + topSellerShare + '%');
console.log('竞争结论:', compConclusion);
