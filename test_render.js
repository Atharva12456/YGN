const fs = require('fs');

global.window = { location: { search: '' } };
global.document = {
  querySelectorAll: () => [], querySelector: () => null,
  getElementById: () => ({ classList: { add: () => {} } }), addEventListener: () => {}
};
global.navigator = {};

const code = fs.readFileSync('docs/app.js', 'utf8');
eval(code);

const container = { innerHTML: '' };
const tests = [
  { name: 'Empty dossier', data: { member: { bioguideId: 'test' } } },
  { name: 'Null values everywhere', data: { member: { name: null }, wiki: { summary: null }, history: { terms: [ { startYear: null } ] } } },
  { name: 'Stocks missing trades but exists', data: { member: {}, stocks: { trades: null, filings: [ {} ], ownerBreakdown: null } } },
  { name: 'Legislation empty arrays', data: { member: {}, legislation: { sponsored: [ { url: null, title: null } ], cosponsored: [] } } },
  { name: 'Committees malformed', data: { member: {}, committees: { assignments: [ { isSubcommittee: true, code: null }, { isSubcommittee: false, code: 'X' } ] } } },
  { name: 'Contact partial', data: { member: {}, contact: { official: { website: null }, social: { twitter: null }, profiles: { foo: null } } } },
];

let failed = false;
for (const t of tests) {
  try {
    renderDossierUI(container, t.data);
    console.log('PASS:', t.name);
  } catch (e) {
    console.error('FAIL:', t.name, e);
    failed = true;
  }
}
if (failed) process.exit(1);
