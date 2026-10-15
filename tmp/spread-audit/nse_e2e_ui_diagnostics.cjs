// Read-only audit of the actual TypeScript view helper; no UI/source changes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'algo-trading/node_modules/typescript'));
const sourcePath = path.join(root, 'algo-trading/src/pages/SpreadsPage/viewFilters.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const helper = new Module(sourcePath);
helper._compile(compiled, sourcePath);
const row = {ticker:'AUDIT', type:'BEAR CALL', earnings:false, short_strike:100,
  credit:.01, credit_points_unrounded:.005, ror_pct:15, cushion_pct:2, vrp:1.2, p_adj:.2, ev:0};
const displayedCredit = Number(row.credit_points_unrounded.toFixed(6));
const filtered = helper.exports.displayedCandidates([row], '', '', '', {credit:{min:'.006'}}, '', 'asc');
assert.equal(filtered.length, 1);
assert.ok(displayedCredit < .006);
const evidence = {scope:'Synthetic diagnostic input through current production view helper; no market data',
  credit_precision_mismatch:{api_credit:row.credit, displayed_credit:displayedCredit,
    minimum_credit_filter:.006, row_survives_filter:true},
  production_source:sourcePath};
fs.writeFileSync(path.join(__dirname, 'nse-e2e-ui-evidence.json'), JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
