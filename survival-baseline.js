function padMonth(month) {
  return String(month).padStart(2, '0');
}

function addMonths(year, month, offset) {
  const date = new Date(year, month - 1 + offset, 1);
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

function formatYm(period) {
  return `${period.year}-${padMonth(period.month)}`;
}

function formatChineseMonth(period) {
  return `${period.year}年${period.month}月`;
}

function parsePeriod(value) {
  const text = String(value || '');
  let match = text.match(/(\d{4})-(\d{1,2})/);
  if (!match) match = text.match(/(\d{4})年(\d{1,2})月/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function selectSurvivalBaselinePeriod(reportDate = new Date()) {
  const reportYear = reportDate.getFullYear();
  const reportMonth = reportDate.getMonth() + 1;
  const rawTarget = addMonths(reportYear, reportMonth, -6);
  let selected = rawTarget;
  let window = [rawTarget];
  let reason = '使用机械向前 6 个月的正常月份。';
  let adjusted = false;

  if (rawTarget.month === 12) {
    window = [1, 2, 3].map(month => ({ year: rawTarget.year + 1, month }));
    selected = window[0];
    reason = '机械向前 6 个月落在 12 月，圣诞季新品上架与销量结构异常，改用次年 1-3 月正常窗口；默认选 1 月，若补采多月可优先选样本更完整月份。';
    adjusted = true;
  } else if (rawTarget.month === 6 || rawTarget.month === 7) {
    window = [8, 9].map(month => ({ year: rawTarget.year, month }));
    selected = window[0];
    reason = '机械向前 6 个月落在 6-7 月，Prime Day / 会员日会扰动新品与销量结构，改用 8-9 月正常窗口；默认选 8 月，若补采多月可优先选样本更完整月份。';
    adjusted = true;
  }

  return {
    reportMonth: formatYm({ year: reportYear, month: reportMonth }),
    rawTarget,
    rawTargetYm: formatYm(rawTarget),
    rawTargetLabel: formatChineseMonth(rawTarget),
    selected,
    selectedYm: formatYm(selected),
    selectedLabel: formatChineseMonth(selected),
    window,
    windowYm: window.map(formatYm),
    windowLabel: window.map(formatChineseMonth).join('、'),
    adjusted,
    reason
  };
}

module.exports = {
  addMonths,
  formatChineseMonth,
  formatYm,
  parsePeriod,
  selectSurvivalBaselinePeriod
};
