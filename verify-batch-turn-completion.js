const fs = require('fs');
const path = require('path');
const { isConfirmedHardSkip } = require('./oalur-query-guard');

const TERMINAL_ITEM_STATUSES = new Set(['completed', 'skipped']);
const REQUIRED_COMPLETED_STEPS = ['mainReport', 'childAsinReport', 'resultLog'];
const REQUIRED_TERMINAL_STEPS = [
  'marketData',
  'historicalData',
  'marketCodexReview',
  'historicalCodexReview',
  'seasonality',
  'cpcOpportunity',
  ...REQUIRED_COMPLETED_STEPS
];

function selectedItemNumbers(progress) {
  const selected = progress?.selected || {};
  const outputStart = Number(selected.outputStart ?? selected.start);
  const count = Number(selected.count);
  if (!Number.isInteger(outputStart) || outputStart < 1 || !Number.isInteger(count) || count < 1) {
    return [];
  }
  return Array.from({ length: count }, (_, offset) => outputStart + offset);
}

function itemKey(index) {
  return String(index).padStart(3, '0');
}

function isNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function findNonEmptyFile(directory, predicate) {
  try {
    return fs.readdirSync(directory)
      .map(file => path.join(directory, file))
      .find(file => predicate(path.basename(file)) && isNonEmptyFile(file)) || null;
  } catch {
    return null;
  }
}

function artifactBlockers(item, options) {
  if (options.checkArtifacts === false) return [];
  if (!String(item?.itemRoot || '').trim()) return ['item output root is missing'];

  const itemRoot = path.isAbsolute(item.itemRoot)
    ? item.itemRoot
    : path.resolve(options.artifactBase || process.cwd(), item.itemRoot);
  const resultLog = findNonEmptyFile(itemRoot, file => file.endsWith('-result.log'));
  const blockers = [];

  if (!fs.existsSync(itemRoot)) blockers.push('item output root does not exist');
  if (!resultLog) blockers.push('non-empty result log file is missing');
  if (item.status === 'completed') {
    const reportsDir = path.join(itemRoot, 'reports');
    const mainReport = findNonEmptyFile(reportsDir, file => file.endsWith('_市场分析.html'));
    const childReport = findNonEmptyFile(reportsDir, file => file.endsWith('_子ASIN明细.html'));
    if (!mainReport) blockers.push('non-empty main report file is missing');
    if (!childReport) blockers.push('non-empty child-ASIN report file is missing');
  }

  return blockers;
}

function evaluateBatchTurnCompletion(progress, options = {}) {
  const blockers = [];
  const selectedItems = selectedItemNumbers(progress);

  if (!progress || typeof progress !== 'object') {
    blockers.push('batch progress is missing or invalid');
  } else {
    if (progress.status !== 'completed') {
      blockers.push(`batch status is ${progress.status || 'missing'}, not completed`);
    }
    if (progress.awaitingCodexReviewItem != null) {
      blockers.push(`item ${progress.awaitingCodexReviewItem} is awaiting Codex review`);
    }
    if (progress.pausedAt != null) {
      blockers.push(`batch is paused at ${progress.pausedAt}`);
    }
    if (!options.ignorePersistedFinalGate && progress.codexCanSendFinal === false) {
      blockers.push('persisted final-response permission is false');
    }
    if (
      !options.ignorePersistedFinalGate &&
      progress.finalResponseGate?.status &&
      progress.finalResponseGate.status !== 'allowed'
    ) {
      blockers.push(`final-response gate is ${progress.finalResponseGate.status}`);
    }
    if (!selectedItems.length) {
      blockers.push('selected batch range is missing or invalid');
    }
  }

  const itemStates = selectedItems.map(index => {
    const key = itemKey(index);
    const item = progress?.items?.[key];
    const itemBlockers = [];

    if (!item) {
      itemBlockers.push('progress entry is missing');
    } else if (!TERMINAL_ITEM_STATUSES.has(item.status)) {
      itemBlockers.push(`status is ${item.status || 'missing'}`);
    } else if (item.status === 'skipped') {
      if (!String(item.skipReason || '').trim()) {
        itemBlockers.push('business skip reason is missing');
      }
      if (item.steps?.resultLog?.status !== 'completed') {
        itemBlockers.push('result log is not completed');
      }
      if (!isConfirmedHardSkip(item.skipDetails, 100, 800)) {
        itemBlockers.push('hard-limit skip was not calculated from a confirmed positive total and consistent pagination');
      }
    } else {
      for (const step of REQUIRED_TERMINAL_STEPS) {
        const status = item.steps?.[step]?.status;
        if (!TERMINAL_ITEM_STATUSES.has(status)) {
          itemBlockers.push(`${step} has non-terminal status ${status || 'missing'}`);
        }
      }
      for (const step of REQUIRED_COMPLETED_STEPS) {
        if (item.steps?.[step]?.status !== 'completed') {
          itemBlockers.push(`${step} is not completed`);
        }
      }
      if (item.currentStep != null) {
        itemBlockers.push(`current step is still ${item.currentStep}`);
      }
      if (item.codexReviewGate != null) {
        itemBlockers.push('Codex review gate is still active');
      }
      if (item.skipReason != null || item.skipDetails != null || item.skippedAt != null) {
        itemBlockers.push('completed item still contains stale skip metadata');
      }
    }
    if (item?.error) {
      itemBlockers.push(`item error is still present: ${item.error}`);
    }
    itemBlockers.push(...artifactBlockers(item, options));

    if (itemBlockers.length) {
      blockers.push(`item ${index}: ${itemBlockers.join('; ')}`);
    }

    return {
      index,
      key,
      keyword: item?.keyword || '',
      status: item?.status || 'missing',
      ok: itemBlockers.length === 0,
      blockers: itemBlockers
    };
  });

  return {
    event: 'CODEX_TURN_COMPLETION_CHECK',
    terminal: blockers.length === 0,
    codexCanSendFinal: blockers.length === 0,
    codexTurnStatus: blockers.length === 0
      ? 'final_response_allowed'
      : 'must_continue_in_current_conversation',
    batchStatus: progress?.status || 'missing',
    selected: progress?.selected || null,
    selectedItems: itemStates,
    blockers
  };
}

function verifyProgressFile(progressFile) {
  const resolved = path.resolve(progressFile);
  const progress = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  let artifactBase = process.cwd();
  const relativeItemRoots = Object.values(progress.items || {})
    .map(item => item?.itemRoot)
    .filter(itemRoot => itemRoot && !path.isAbsolute(itemRoot));
  if (
    relativeItemRoots.length &&
    !relativeItemRoots.some(itemRoot => fs.existsSync(path.resolve(artifactBase, itemRoot)))
  ) {
    let candidate = path.dirname(resolved);
    while (true) {
      if (relativeItemRoots.some(itemRoot => fs.existsSync(path.resolve(candidate, itemRoot)))) {
        artifactBase = candidate;
        break;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return {
    progressFile: resolved,
    ...evaluateBatchTurnCompletion(progress, { artifactBase })
  };
}

function main() {
  const progressFile = process.argv[2];
  if (!progressFile) {
    console.error('Usage: node verify-batch-turn-completion.js <batch-progress.json>');
    process.exitCode = 1;
    return;
  }

  try {
    const result = verifyProgressFile(progressFile);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.codexCanSendFinal ? 0 : 2;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'CODEX_TURN_COMPLETION_CHECK',
      terminal: false,
      codexCanSendFinal: false,
      codexTurnStatus: 'must_continue_in_current_conversation',
      progressFile: path.resolve(progressFile),
      blockers: [error.message]
    }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateBatchTurnCompletion,
  REQUIRED_COMPLETED_STEPS,
  REQUIRED_TERMINAL_STEPS,
  TERMINAL_ITEM_STATUSES,
  verifyProgressFile
};
