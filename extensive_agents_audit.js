import fs from 'fs';
import path from 'path';

// Helper to delay execution to respect rate limiting (6 requests/minute)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runAudit(query, budget, useCase) {
  console.log(`\n------------------------------------------------------------`);
  console.log(`[AUDIT RUN] Query: "${query}" | Budget: "${budget || 'N/A'}"`);
  console.log(`[AUDIT RUN] UseCase: "${useCase}"`);
  console.log(`------------------------------------------------------------`);

  const startTime = Date.now();
  const response = await fetch('http://localhost:3010/api/audit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Host': 'localhost:3010'
    },
    body: JSON.stringify({
      query,
      budget,
      useCase: useCase || 'Standard consumer purchase audit'
    })
  });

  const latencyMs = Date.now() - startTime;
  console.log(`[API RESPONSE] Status: ${response.status} | Latency: ${(latencyMs / 1000).toFixed(2)}s`);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP Error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return { data, latencyMs };
}

function auditDataForAgent(agentName, category, query, budget, data, latencyMs) {
  const issues = [];
  const passes = [];
  
  const resolvedName = data.productName || '';
  const priceIntegrity = data.priceIntegrity || {};
  const procurementLinks = priceIntegrity.procurementLinks || [];
  const lowestDeal = procurementLinks.find(link => link.isBestDeal);
  const priceHistory = priceIntegrity.priceHistory || [];
  const cleanSummary = data.aamAadmiSummary || '';

  // 1. Target Resolution
  if (!resolvedName) {
    issues.push("Product model was not resolved successfully (productName is empty).");
  } else {
    passes.push(`Resolved query to product: "${resolvedName}"`);
  }

  // 2. Budget Integrity Check
  if (budget) {
    const budgetNum = parseInt(budget.replace(/[^\d]/g, ''), 10);
    if (lowestDeal && lowestDeal.price && !/out of stock/i.test(lowestDeal.price)) {
      const dealPriceNum = parseInt(lowestDeal.price.replace(/[^\d]/g, ''), 10);
      
      const isBroadCategory = /under|below|budget|recommend|suggest|best|which/i.test(query) && !query.includes(" vs ");
      
      if (dealPriceNum > budgetNum) {
        if (isBroadCategory) {
          issues.push(`Budget violation: Resolved product deal price (₹${dealPriceNum}) exceeds category budget constraint (₹${budgetNum})!`);
        } else {
          // Explicit search. Check if bhaiya warns user.
          const lowerSummary = cleanSummary.toLowerCase();
          const hasBudgetWarning = lowerSummary.includes("exceed") || lowerSummary.includes("cross") || lowerSummary.includes("budget") || lowerSummary.includes("mehenga") || lowerSummary.includes("limit") || lowerSummary.includes("save") || lowerSummary.includes("diwali") || lowerSummary.includes("sales") || lowerSummary.includes("alternative");
          if (hasBudgetWarning) {
            passes.push(`Intelligent Warning Pass: Deal price (₹${dealPriceNum}) exceeds budget constraint (₹${budgetNum}) for explicit model search, but bhaiya warned the user correctly: "${cleanSummary.substring(0, 80)}..."`);
          } else {
            issues.push(`Budget warning missing: Deal price (₹${dealPriceNum}) exceeds budget constraint (₹${budgetNum}) for explicit model search, but no warning was found in aamAadmiSummary!`);
          }
        }
      } else {
        passes.push(`Budget fits: Deal price is ₹${dealPriceNum.toLocaleString('en-IN')} (Budget: ₹${budgetNum.toLocaleString('en-IN')})`);
      }
    } else {
      passes.push(`Budget check: Target item is Out of Stock or no price available, skipping numerical validation.`);
    }
  }

  // 3. Platform Links & Category Mappings Strictness
  const allowedDomains = {
    electronics: ['amazon', 'flipkart', 'croma', 'reliancedigital', 'reliance.com'],
    fashion: ['myntra', 'ajio', 'amazon', 'flipkart', 'adidas', 'nike', 'puma', 'zara', 'roadster'],
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
    const priceStr = link.price || '';
    const stockStatus = link.stockStatus || '';

    const isOos = /out of stock|oos/i.test(stockStatus) || /out of stock|oos/i.test(priceStr) || priceStr === '';
    
    if (isOos) {
      if (link.url !== '') {
        issues.push(`OOS platform "${link.platform}" has non-empty URL: "${link.url}" (must be empty string)`);
      } else {
        passes.push(`OOS platform "${link.platform}" correctly has empty URL string.`);
      }
    } else {
      if (link.url === '') {
        issues.push(`In-stock platform "${link.platform}" has an empty URL!`);
      }

      const allowed = allowedDomains[category] || [];
      const disallowed = disallowedDomains[category] || [];
      
      const isDomainAllowed = allowed.some(d => url.includes(d) || platform.includes(d));
      const isDomainDisallowed = disallowed.some(d => url.includes(d) || platform.includes(d));

      if (isDomainDisallowed) {
        issues.push(`Category Mismatch: Found "${link.platform}" link ("${link.url}") in ${category} category query!`);
      } else if (!isDomainAllowed) {
        if (category === 'automotive') {
          const isBrandSite = ['royal', 'enfield', 'ather', 'ola', 'suzuki', 'tata', 'mahindra', 'hyundai', 'honda', 'yamaha', 'bajaj', 'tvs', 'ktm', 'byd', 'mg'].some(b => url.includes(b));
          if (isBrandSite) {
            passes.push(`Direct brand site allowed for automotive: "${link.url}"`);
          } else {
            issues.push(`Disallowed portal inside Automotive: "${link.url}" (only specialist portals allowed)`);
          }
        } else {
          issues.push(`Unrecognized domain for ${category}: "${link.url}"`);
        }
      } else {
        passes.push(`Link for ${link.platform} is appropriate for ${category}.`);
      }
    }
  });

  // 4. Price History Congruency
  if (lowestDeal && lowestDeal.price && !/out of stock/i.test(lowestDeal.price)) {
    const lowestDealNum = parseInt(lowestDeal.price.replace(/[^\d]/g, ''), 10);
    if (priceHistory.length > 0) {
      const latestNode = priceHistory[priceHistory.length - 1];
      if (latestNode.price !== lowestDealNum) {
        issues.push(`Price congruency fail! lowestDeal price is ₹${lowestDealNum} but latest history chart node is ₹${latestNode.price} for ${latestNode.month}. Every price must match!`);
      } else {
        passes.push(`Price history latest node matches the lowest deal price perfectly (₹${lowestDealNum}).`);
      }
    } else {
      issues.push(`priceHistory array is completely empty!`);
    }
  }

  // 5. Banned Jargon Words Audit
  const bannedWords = ['equilibrium', 'volatility', 'msrp', 'market correction', 'depreciation', 'portfolio'];
  const dataString = JSON.stringify(data).toLowerCase();
  
  bannedWords.forEach(word => {
    if (dataString.includes(word)) {
      issues.push(`Jargon detected: Found banned commercial term "${word}" in response!`);
    }
  });

  // 6. Hinglish elder brother tone verification
  const isHinglish = /bhai|yaar|lena|hoga|mat|budget|sasta|mehenga|le lo/i.test(cleanSummary) || /deal|value|worth/i.test(cleanSummary);
  if (!isHinglish) {
    issues.push(`Tone mismatch: Summary does not seem to carry the friendly elder brother Hinglish tone.`);
  } else {
    passes.push(`Passed elder brother Hinglish tone verification.`);
  }

  const score = Math.max(0, 100 - (issues.length * 20));

  return {
    agent: agentName,
    category,
    query,
    budget,
    resolvedProduct: resolvedName,
    latencySec: (latencyMs / 1000).toFixed(2),
    score,
    passedChecksCount: passes.length,
    failedChecks: issues,
    rawOutputSummary: {
      finalDecision: data.finalDecision,
      paisaVasoolIndex: data.paisaVasoolIndex,
      statusTax: data.statusTax,
      utilityScore: data.utilityScore,
      aamAadmiSummary: data.aamAadmiSummary,
      procurementLinksCount: procurementLinks.length
    }
  };
}

async function main() {
  console.log("============================================================");
  console.log("STARTING EXTENSIVE MULTI-AGENT TELEMETRY RUN (12 QUERIES)");
  console.log("============================================================");

  const testSuite = [
    // Persona 1: Rohan (Techie Student)
    {
      agent: "Rohan",
      category: "electronics",
      query: "best smartphone under 25k",
      budget: "25000",
      useCase: "College student, heavy WhatsApp, Instagram, and BGMI gaming. Wants high refresh rate screen and decent battery."
    },
    {
      agent: "Rohan",
      category: "electronics",
      query: "OnePlus 12 16GB 512GB",
      budget: "65000",
      useCase: "Power user wanting to verify if buying the premium variant is a smart value decision or status tax trap."
    },

    // Persona 2: Priya (Trendy Fashionista)
    {
      agent: "Priya",
      category: "fashion",
      query: "best running shoes under 5k",
      budget: "5000",
      useCase: "Weekend runner wanting comfortable shoes that look trendy and run true to size."
    },
    {
      agent: "Priya",
      category: "fashion",
      query: "Adidas Samba OG",
      budget: "10000",
      useCase: "Style blogger checking active prices on Myntra/Ajio, fit concerns, and cheaper alternatives."
    },

    // Persona 3: Amit (Motorcycle Commuter)
    {
      agent: "Amit",
      category: "automotive",
      query: "best electric scooter under 1.5 lakh",
      budget: "150000",
      useCase: "Daily office commuter in high traffic Bangalore. Needs real-world range, charging time, and battery longevity advice."
    },
    {
      agent: "Amit",
      category: "automotive",
      query: "Royal Enfield Classic 350",
      budget: "250000",
      useCase: "Leisure cruiser enthusiast wanting to verify exact specialty platform prices and long-term mileage feedback."
    },

    // Persona 4: Sneha (Budget Homemaker)
    {
      agent: "Sneha",
      category: "electronics",
      query: "Sony WH-1000XM5 vs Bose QC Ultra",
      budget: "30000",
      useCase: "WFH professional looking for the absolute best active noise-canceling headphones for long meetings."
    },
    {
      agent: "Sneha",
      category: "electronics",
      query: "is MacBook Air M3 8GB RAM worth buying in 2026?",
      budget: "90000",
      useCase: "Freelance copywriter wanting to know if 8GB RAM is a bottleneck or enough for office/docs."
    },

    // Persona 5: Varun (Fitness Enthusiast)
    {
      agent: "Varun",
      category: "fashion",
      query: "Nike Air Force 1 vs Adidas Stan Smith",
      budget: "9000",
      useCase: "Casual wearer wanting white sneakers that are easy to clean, comfortable, and fit well."
    },
    {
      agent: "Varun",
      category: "fashion",
      query: "is Zara winter jacket worth the price?",
      budget: "8000",
      useCase: "Wants premium aesthetic winter wear for Delhi cold. Needs durability and status tax audit."
    },

    // Persona 6: Kabir (Family Car Buyer)
    {
      agent: "Kabir",
      category: "automotive",
      query: "Tata Nexon EV vs Mahindra XUV400",
      budget: "1600000",
      useCase: "Family man wanting a safe electric SUV for city driving. Needs safety ratings, battery tech differences, and actual range."
    },
    {
      agent: "Kabir",
      category: "automotive",
      query: "is MG Comet EV worth buying for daily city commute?",
      budget: "800000",
      useCase: "Suburban commuter looking for an ultra-compact electric car for narrow streets and office parking."
    }
  ];

  const results = [];

  for (let i = 0; i < testSuite.length; i++) {
    const test = testSuite[i];
    try {
      const auditRes = await runAudit(test.query, test.budget, test.useCase);
      const audited = auditDataForAgent(test.agent, test.category, test.query, test.budget, auditRes.data, auditRes.latencyMs);
      results.push(audited);
      
      console.log(`[TEST RESULT] Agent: ${audited.agent} | Score: ${audited.score}/100 | Latency: ${audited.latencySec}s | Product: "${audited.resolvedProduct}"`);
      if (audited.failedChecks.length > 0) {
        console.log("  Gaps Detected:");
        audited.failedChecks.forEach(fc => console.log(`    - ${fc}`));
      } else {
        console.log("  [PASS] All checks passed.");
      }
    } catch (err) {
      console.error(`[TEST FAILED] Error running query "${test.query}":`, err.message || err);
      results.push({
        agent: test.agent,
        category: test.category,
        query: test.query,
        budget: test.budget,
        resolvedProduct: "CRASHED",
        latencySec: "0.00",
        score: 0,
        passedChecksCount: 0,
        failedChecks: [err.message || String(err)],
        rawOutputSummary: {}
      });
    }

    // Sleep to respect API rate limits (6 requests/minute)
    if (i < testSuite.length - 1) {
      console.log("Sleeping 8 seconds before next request...");
      await sleep(8000);
    }
  }

  // Write telemetry results
  const reportPath = '/Users/krish/antigravity/Vetto/extensive_audit_results.json';
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n============================================================`);
  console.log(`[SUCCESS] Extensive Telemetry Run Completed!`);
  console.log(`Results saved to: ${reportPath}`);
  console.log(`============================================================`);
}

main();
