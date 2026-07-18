function confirmedFirstPageMetrics(result, pageSize = 100) {
  const rows = Array.isArray(result?.data) ? result.data.length : 0;
  const total = Number(result?.total || 0);
  const lastPage = Number(result?.lastPage || 0);
  const source = result?.totalText ? ` (${result.totalText})` : '';

  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`Invalid page size: ${pageSize}`);
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(
      `Confirmed Oalur query has ${rows} table rows but no positive total count${source}. ` +
      'Do not estimate from stale pagination; click confirm query and wait for the refreshed result.'
    );
  }
  if (!Number.isInteger(lastPage) || lastPage < 1) {
    throw new Error(`Confirmed Oalur query has an invalid last page: ${result?.lastPage}`);
  }
  if (rows < 1 || rows > pageSize) {
    throw new Error(`Confirmed Oalur first page row count ${rows} is outside 1-${pageSize}`);
  }
  if (total < rows) {
    throw new Error(`Confirmed Oalur total ${total} is smaller than first-page row count ${rows}`);
  }

  const expectedLastPage = Math.max(1, Math.ceil(total / pageSize));
  if (lastPage !== expectedLastPage) {
    throw new Error(
      `Confirmed Oalur pagination is inconsistent: total=${total}, pageSize=${pageSize}, ` +
      `expectedLastPage=${expectedLastPage}, actualLastPage=${lastPage}. ` +
      'Do not use this state for row estimation.'
    );
  }

  return { rows, total, lastPage, expectedLastPage, pageSize };
}

function estimateRowsFromConfirmedFirstPage(result, pageSize = 100) {
  return confirmedFirstPageMetrics(result, pageSize).total;
}

function isConfirmedHardSkip(details, pageSize = 100, hardSkipRows = 800) {
  const total = Number(details?.total || 0);
  const estimatedRows = Number(details?.estimatedRows || 0);
  const lastPage = Number(details?.lastPage || 0);
  const firstPageRows = Number(details?.firstPageRows || 0);
  return Number.isFinite(total) && total > hardSkipRows &&
    estimatedRows === total &&
    Number.isInteger(lastPage) && lastPage === Math.ceil(total / pageSize) &&
    Number.isInteger(firstPageRows) && firstPageRows > 0 && firstPageRows <= pageSize;
}

module.exports = {
  confirmedFirstPageMetrics,
  estimateRowsFromConfirmedFirstPage,
  isConfirmedHardSkip
};
