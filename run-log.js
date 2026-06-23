const fs = require('fs');
const path = require('path');

function safeSegment(value) {
  return String(value || 'run')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'run';
}

function runRootFromOutput(outputFile) {
  if (!outputFile) return process.cwd();
  const outputDir = path.resolve(path.dirname(outputFile));
  const name = path.basename(outputDir).toLowerCase();
  if (['data', 'excel', 'reports', 'cache'].includes(name)) {
    return path.dirname(outputDir);
  }
  return outputDir;
}

function defaultLogFileForOutput(outputFile, keyword) {
  const root = runRootFromOutput(outputFile);
  const fallback = outputFile
    ? path.basename(outputFile).replace(/\.(json|html|xlsx|csv)$/i, '')
    : 'run';
  const base = safeSegment(keyword || fallback).toLowerCase();
  return path.join(root, `${base}-run.log`);
}

function compactDetails(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, (key, nestedValue) => {
      if (nestedValue instanceof Error) {
        return { message: nestedValue.message, stack: nestedValue.stack };
      }
      return nestedValue;
    });
  } catch (error) {
    return String(value);
  }
}

function createRunLogger(options = {}) {
  const logFile = path.resolve(
    options.logFile ||
    process.env.OALUR_RUN_LOG ||
    defaultLogFileForOutput(options.outputFile, options.keyword)
  );
  const scriptName = options.scriptName || path.basename(process.argv[1] || 'node');

  function write(level, event, details) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const detailText = compactDetails(details);
    const line = `[${new Date().toISOString()}] ${level} ${scriptName} ${event}${detailText ? ` ${detailText}` : ''}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  }

  return {
    logFile,
    info: (event, details) => write('INFO', event, details),
    warn: (event, details) => write('WARN', event, details),
    error: (event, details) => write('ERROR', event, details),
    start: (details) => write('INFO', 'run.start', details),
    end: (details) => write('INFO', 'run.end', details)
  };
}

module.exports = {
  createRunLogger,
  defaultLogFileForOutput,
  runRootFromOutput,
  safeSegment
};
