const fs = require('fs');
const p = 'extract-seasonality.js';
let s = fs.readFileSync(p, 'utf8');
const re = /      execSync\(\s*`node "\$\{path\.join\(SKILL_DIR, 'extract-google-trends\.js'\)\}" "\$\{keyword\}" "\$\{gtrendsFile\}"`,\s*\{ stdio: 'inherit', timeout: 90000 \}\s*\);\s*if \(fs\.existsSync\(gtrendsFile\)\) \{\s*gtData = JSON\.parse\(fs\.readFileSync\(gtrendsFile, 'utf-8'\)\);\s*\}/g;
let count = 0;
s = s.replace(re, () => { count++; return '      gtData = runGoogleTrendsExtraction(keyword, gtrendsFile);'; });
if (count !== 2) throw new Error(`Expected 2 replacements, got ${count}`);
fs.writeFileSync(p, s, 'utf8');
console.log(`replaced ${count} Google Trends exec blocks`);
