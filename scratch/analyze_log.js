const fs = require('fs');

const log = fs.readFileSync('/Users/krish/antigravity/Vetto/server_dev.log', 'utf8');
const lines = log.split('\n');

console.log("=== Latency Profile of Vetto Backend ===");
const auditStarts = {};
const fetchStarts = {};

lines.forEach((line, idx) => {
  if (line.includes('Querying Google Search grounding')) {
    const match = line.match(/for: "(.*?)"/);
    const query = match ? match[1] : 'unknown';
    fetchStarts[query] = { idx, line };
  }
  if (line.includes('Extracted Prices Data')) {
    // Price fetch complete
  }
  if (line.includes('[Audit Req] Start:')) {
    const match = line.match(/Start: (.*?) \(/);
    const query = match ? match[1] : 'unknown';
    auditStarts[query] = Date.now(); // dummy, we'll check Model finished
  }
  if (line.includes('Model finished in')) {
    console.log(`Line ${idx + 1}: ${line}`);
  }
  if (line.includes('Total latency:')) {
    console.log(`Line ${idx + 1}: ${line}`);
  }
});
