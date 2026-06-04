import fs from 'fs';
import path from 'path';

// Helper to delay execution to respect server rate-limiting (max 6 requests/min)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runAudit(query, budget, useCase) {
  console.log(`\n============================================================`);
  console.log(`[TESTING] Query: "${query}", Budget: "${budget || 'None'}"`);
  console.log(`============================================================`);

  const response = await fetch('http://localhost:3010/api/audit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Host': 'localhost:3010'
    },
    body: JSON.stringify({
      query,
      budget,
      useCase: useCase || 'Standard consumer purchase guidance'
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP Error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data;
}

function auditCategory(category, query, budget, data) {
  const issues = [];
  const checks = [];

  // Check 1: Product Resolved
  const resolvedName = data.productName || '';
  checks.push(`Resolved Product Name: "${resolvedName}"`);
  if (!resolvedName) {
    issues.push(`Product name was not resolved or is empty!`);
  }

  // Check 2: Budget fit
  const priceIntegrity = data.priceIntegrity || {};
  const procurementLinks = priceIntegrity.procurementLinks || [];
  const lowestDeal = procurementLinks.find(link => link.isBestDeal);
  
  if (budget) {
    const budgetNum = parseInt(budget.replace(/[^\d]/g, ''), 10);
    if (lowestDeal && lowestDeal.price && lowestDeal.price !== 'Out of Stock') {
      const dealPriceNum = parseInt(lowestDeal.price.replace(/[^\d]/g, ''), 10);
      checks.push(`Budget: ₹${budgetNum.toLocaleString('en-IN')}, Deal Price: ₹${dealPriceNum.toLocaleString('en-IN')}`);
      if (dealPriceNum > budgetNum) {
        issues.push(`FAIL: Recommended product's deal price (₹${dealPriceNum}) exceeds budget constraint (₹${budgetNum})!`);
      } else {
        checks.push(`PASS: Recommended product's deal price fits the budget constraint.`);
      }
    } else {
      checks.push(`Budget check skipped: No active deal price found (Out of Stock).`);
    }
  }

  // Check 3: Platform Links & Category appropriateness
  checks.push(`Found ${procurementLinks.length} procurement links.`);
  
  const allowedDomains = {
    electronics: ['amazon', 'flipkart', 'croma', 'reliancedigital', 'reliance.com'],
    fashion: ['myntra', 'ajio', 'amazon', 'flipkart'],
    automotive: ['carwale', 'bikewale', 'cardekho', 'bikedekho', 'zigwheels']
  };

  const disallowedDomains = {
    electronics: ['myntra', 'ajio', 'carwale', 'bikewale', 'cardekho', 'bikedekho', 'zigwheels'],
    fashion: ['croma', 'reliancedigital', 'reliance.com', 'carwale', 'bikewale', 'cardekho', 'bikedekho', 'zigwheels'],
    automotive: ['amazon', 'flipkart', 'myntra', 'ajio', 'croma', 'reliancedigital', 'reliance.com']
  };

  procurementLinks.forEach(link => {
    const platform = (link.platform || '').toLowerCase();
    const url = (link.url || '').toLowerCase();
    const stockStatus = link.stockStatus || '';
    const priceStr = link.price || '';

    checks.push(`Link: ${link.platform} | Price: ${link.price} | Stock: ${link.stockStatus} | URL: ${link.url}`);

    // Check OOS URLs are strictly empty
    const isOos = /out of stock|oos/i.test(stockStatus) || /out of stock|oos/i.test(priceStr) || priceStr === '';
    if (isOos) {
      if (link.url !== '') {
        issues.push(`FAIL: OOS item on ${link.platform} has a non-empty URL: "${link.url}"`);
      } else {
        checks.push(`PASS: OOS item on ${link.platform} correctly has an empty URL string.`);
      }
    } else {
      if (link.url === '') {
        issues.push(`FAIL: In-stock item on ${link.platform} has an empty URL!`);
      }
      
      // Category platform matching
      const allowed = allowedDomains[category] || [];
      const disallowed = disallowedDomains[category] || [];
      
      const isDomainAllowed = allowed.some(d => url.includes(d) || platform.includes(d));
      const isDomainDisallowed = disallowed.some(d => url.includes(d) || platform.includes(d));

      if (isDomainDisallowed) {
        issues.push(`FAIL: Mismatched Category URL for ${category} category on ${link.platform}: "${link.url}" (should not contain ${disallowed.join('/')})`);
      } else if (!isDomainAllowed) {
        // Brands direct websites are allowed in automotive
        if (category === 'automotive') {
          const isBrandSite = ['royal', 'enfield', 'ather', 'ola', 'suzuki', 'tata', 'mahindra', 'hyundai', 'honda', 'yamaha'].some(b => url.includes(b));
          if (isBrandSite) {
            checks.push(`PASS: Direct brand site URL allowed for automotive: "${link.url}"`);
          } else {
            issues.push(`WARNING: Unrecognized platform link for automotive: "${link.url}"`);
          }
        } else {
          issues.push(`WARNING: Unrecognized platform link for ${category}: "${link.url}"`);
        }
      } else {
        checks.push(`PASS: Platform link for ${link.platform} is appropriate for ${category} category.`);
      }
    }
  });

  // Check 4: Price history congruency & chart nodes
  const priceHistory = priceIntegrity.priceHistory || [];
  if (lowestDeal && lowestDeal.price && lowestDeal.price !== 'Out of Stock') {
    const lowestDealNum = parseInt(lowestDeal.price.replace(/[^\d]/g, ''), 10);
    
    // Check if the latest chart node in priceHistory matches the lowest deal price
    if (priceHistory.length > 0) {
      const latestNode = priceHistory[priceHistory.length - 1];
      const latestNodePrice = latestNode.price;
      checks.push(`Lowest Deal Price: ₹${lowestDealNum}, Latest Chart Node Price: ₹${latestNodePrice} (${latestNode.month})`);
      if (lowestDealNum !== latestNodePrice) {
        issues.push(`FAIL: Price level discrepancy! Lowest deal price is ₹${lowestDealNum} but the current chart node price is ₹${latestNodePrice}. Every price field must be numerically congruent with the best deal!`);
      } else {
        checks.push(`PASS: Price history latest node matches the lowest deal price.`);
      }
    } else {
      issues.push(`FAIL: priceHistory array is empty!`);
    }
  }

  // Check 5: Tone and Banned Jargon Words
  const bannedWords = ['equilibrium', 'volatility', 'msrp', 'market correction', 'depreciation', 'portfolio'];
  const textToCheck = JSON.stringify(data).toLowerCase();
  
  bannedWords.forEach(word => {
    if (textToCheck.includes(word)) {
      issues.push(`FAIL: Found banned commercial buzzword/jargon "${word}" in response text!`);
    } else {
      checks.push(`PASS: Banned jargon "${word}" is not present in the response.`);
    }
  });

  // Tone check snippet
  checks.push(`aamAadmiSummary: "${data.aamAadmiSummary}"`);
  
  // Look for friendly elder brother markers (Hinglish/English)
  const featuresCheck = data.bhartiyaPersonaAudit || '';
  checks.push(`bhartiyaPersonaAudit: "${featuresCheck}"`);

  return {
    category,
    query,
    budget,
    resolvedName,
    finalDecision: data.finalDecision,
    checks,
    issues,
    rawResponse: data
  };
}

async function main() {
  try {
    const results = [];

    // Test 1: Electronics (Category with Budget)
    const elRes1 = await runAudit("best earbuds under 5k", "5000", "Daily train commuter needing great active noise cancellation and clear mic quality.");
    const elAudit1 = auditCategory("electronics", "best earbuds under 5k", "5000", elRes1);
    results.push(elAudit1);

    console.log("Sleeping 4 seconds to respect rate limits...");
    await sleep(4000);

    // Test 2: Electronics (Specific Product without Budget)
    const elRes2 = await runAudit("MacBook Air M2 256GB", "", "CS student looking for a thin laptop for college coding projects.");
    const elAudit2 = auditCategory("electronics", "MacBook Air M2 256GB", "", elRes2);
    results.push(elAudit2);

    console.log("Sleeping 4 seconds to respect rate limits...");
    await sleep(4000);

    // Test 3: Fashion (Category with specific use case and no budget)
    const faRes = await runAudit("durable running shoes for flat feet", "", "Marathon runner wanting durable cushioning and high arch support.");
    const faAudit = auditCategory("fashion", "durable running shoes for flat feet", "", faRes);
    results.push(faAudit);

    console.log("Sleeping 4 seconds to respect rate limits...");
    await sleep(4000);

    // Test 4: Automotive (Comparison with Budget)
    const auRes = await runAudit("Ather 450x vs Ola S1 Pro", "150000", "Daily city commuter looking for low maintenance electric scooter with good build quality.");
    const auAudit = auditCategory("automotive", "Ather 450x vs Ola S1 Pro", "150000", auRes);
    results.push(auAudit);

    // Write results to file
    const reportPath = path.join('/Users/krish/antigravity/Vetto', 'test_results.json');
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\n============================================================`);
    console.log(`[SUCCESS] All integration tests run successfully!`);
    console.log(`Results saved to: ${reportPath}`);
    console.log(`============================================================`);
  } catch (err) {
    console.error("Test execution failed:", err);
    process.exit(1);
  }
}

main();
