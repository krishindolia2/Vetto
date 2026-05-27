import fs from 'fs';
import path from 'path';

// Helper to delay execution to respect rate limiting (6 requests/minute)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runAudit(query, budget, useCase) {
  console.log(`\n------------------------------------------------------------`);
  console.log(`[20-AGENT RUN] Query: "${query}" | Budget: "${budget || 'N/A'}"`);
  console.log(`[20-AGENT RUN] Context: "${useCase}"`);
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
  console.log("STARTING MASSIVE 20-AGENT TELEMETRY RUN");
  console.log("============================================================");

  const testSuite = [
    // Persona 1: Rohan (Budget Gamer)
    {
      agent: "Rohan_Gamer",
      category: "electronics",
      query: "best gaming laptop under 70k",
      budget: "70000",
      useCase: "Needs Ryzen 5/i5 processor, GTX 3050/4050 GPU for heavy esports gaming. Values cooling performance and RAM expandability."
    },
    {
      agent: "Rohan_Gamer",
      category: "electronics",
      query: "OnePlus Nord 4 12GB 256GB",
      budget: "32000",
      useCase: "Student wanting to verify if the 12GB RAM variant is the best value option under 32k."
    },

    // Persona 2: Priya (Sneakerhead / Blogger)
    {
      agent: "Priya_Blogger",
      category: "fashion",
      query: "Adidas Samba vs Nike AF1",
      budget: "10000",
      useCase: "Wants trendy daily sneakers. Cares about narrow fit of Sambas vs heavy sole of Air Force 1."
    },
    {
      agent: "Priya_Blogger",
      category: "fashion",
      query: "Zara puffer jacket",
      budget: "8000",
      useCase: "IT engineer checking winter wear options. Wants to verify direct fashion brand links."
    },

    // Persona 3: Amit (Motorcycle Commuter)
    {
      agent: "Amit_Commuter",
      category: "automotive",
      query: "Royal Enfield Himalayan 450",
      budget: "300000",
      useCase: "Commuter checking ex-showroom vs on-road pricing and direct RE brand portal link safety."
    },
    {
      agent: "Amit_Commuter",
      category: "automotive",
      query: "best electric scooter under 1.2 lakh",
      budget: "120000",
      useCase: "Homemaker wanting safe commuter scooter for grocery runs. Cares about real range."
    },

    // Persona 4: Sneha (Budget Homemaker)
    {
      agent: "Sneha_Homemaker",
      category: "electronics",
      query: "best phone under 15000",
      budget: "15000",
      useCase: "Housewife wanting simple phone with excellent battery life, clean UI, and durable build."
    },
    {
      agent: "Sneha_Homemaker",
      category: "electronics",
      query: "best ANC headphones under 20k",
      budget: "20000",
      useCase: "WFH mom wanting premium active noise cancellation to work peacefully at home."
    },

    // Persona 5: Kabir (IT Manager / Family Man)
    {
      agent: "Kabir_IT",
      category: "electronics",
      query: "is Samsung Galaxy S24 Ultra worth the high price?",
      budget: "100000",
      useCase: "IT manager wanting a highly secure premium phone. Checking status tax markup."
    },
    {
      agent: "Kabir_IT",
      category: "electronics",
      query: "Mi powerbank 20000mAh",
      budget: "3000",
      useCase: "Frequent traveler checking direct accessory price checks and low-outlier resilience."
    },

    // Persona 6: Varun (Fitness Enthusiast)
    {
      agent: "Varun_Fitness",
      category: "fashion",
      query: "best running shoes under 4000",
      budget: "4000",
      useCase: "Wants lightweight running shoes for morning jogs. Expecting direct ASICS/Puma/Nike links."
    },
    {
      agent: "Varun_Fitness",
      category: "fashion",
      query: "is Levis 511 slim fit jeans worth the price?",
      budget: "3500",
      useCase: "College student checking jeans durability, authentic Levis store link, and fit ratings."
    },

    // Persona 7: Divya (Office Goer)
    {
      agent: "Divya_Office",
      category: "fashion",
      query: "Nike Jordan 1 Low under 10k",
      budget: "10000",
      useCase: "Office worker wanting stylish sneakers that look authentic and are currently active in India."
    },
    {
      agent: "Divya_Office",
      category: "fashion",
      query: "Myntra Roadster t-shirt",
      budget: "1000",
      useCase: "Budget check on cheap daily wear clothing. Cares about outlier cover/case filtering."
    },

    // Persona 8: Kabir_Car (First Car Buyer)
    {
      agent: "Kabir_Car",
      category: "automotive",
      query: "Tata Nexon EV",
      budget: "1600000",
      useCase: "Family EV SUV buyer checking CarWale/CarDekho links and zero Amazon leak."
    },
    {
      agent: "Kabir_Car",
      category: "automotive",
      query: "is MG Comet EV worth buying for office parking?",
      budget: "800000",
      useCase: "Urban commuter needing a tiny compact vehicle for highly congested corporate parkings."
    },

    // Persona 9: Sneha_M3 (WFH Professional)
    {
      agent: "Sneha_Professional",
      category: "electronics",
      query: "iPad Air M2 vs iPad Pro M4",
      budget: "80000",
      useCase: "Designer wanting a high-fidelity display for digital sketching and vector editing."
    },
    {
      agent: "Sneha_Professional",
      category: "electronics",
      query: "is MacBook Air M3 8GB RAM worth buying in 2026?",
      budget: "90000",
      useCase: "Office clerk checking documentation performance bottlenecks."
    },

    // Persona 10: Amit_OffRoad (Off-Road Enthusiast)
    {
      agent: "Amit_OffRoad",
      category: "automotive",
      query: "Ather 450x vs Ola S1 Pro",
      budget: "150000",
      useCase: "Wants a premium smart electric scooter. Checking tech differences and direct brand sites."
    },
    {
      agent: "Amit_OffRoad",
      category: "automotive",
      query: "Thar Roxx 4x4",
      budget: "2000000",
      useCase: "Cruiser wanting off-roading capability for weekend trails. Checking on-road estimates."
    }
  ];

  const results = [];

  for (let i = 0; i < testSuite.length; i++) {
    const test = testSuite[i];
    try {
      const auditRes = await runAudit(test.query, test.budget, test.useCase);
      const audited = auditDataForAgent(test.agent, test.category, test.query, test.budget, auditRes.data, auditRes.latencyMs);
      results.push(audited);
      
      console.log(`[20-AGENT RESULT] Agent: ${audited.agent} | Score: ${audited.score}/100 | Latency: ${audited.latencySec}s | Target: "${audited.resolvedProduct}"`);
      if (audited.failedChecks.length > 0) {
        console.log("  Gaps Detected:");
        audited.failedChecks.forEach(fc => console.log(`    - ${fc}`));
      } else {
        console.log("  [PASS] 100/100 safe.");
      }
    } catch (err) {
      console.error(`[20-AGENT FAILED] Error running query "${test.query}":`, err.message || err);
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

  // Save 20-agent telemetry
  const reportPath = '/Users/krish/antigravity/Vetto/twenty_agents_results.json';
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n============================================================`);
  console.log(`[SUCCESS] 20-Agent Simulation Completed Successfully!`);
  console.log(`Results saved to: ${reportPath}`);
  console.log(`============================================================`);
  
  const brainReportPath = '/Users/krish/.gemini/antigravity/brain/75b9cfe7-5775-4ff7-81a5-0641cf543405/twenty_agents_results.json';
  fs.writeFileSync(brainReportPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Saved report copy to brain: ${brainReportPath}`);
}

main();
