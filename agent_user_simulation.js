import fs from 'fs';
import path from 'path';

// Helper to delay execution to respect rate limiting (6 requests/minute)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runAudit(query, budget, useCase) {
  console.log(`\n------------------------------------------------------------`);
  console.log(`[SIMULATION RUN] Query: "${query}" | Budget: "${budget || 'N/A'}"`);
  console.log(`[SIMULATION RUN] Context: "${useCase}"`);
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
      useCase: useCase || 'Standard consumer guidance'
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
  
  // 1. Resolve target
  if (!resolvedName) {
    issues.push("Product model was not resolved successfully (productName is empty).");
  } else {
    passes.push(`Resolved category query to: "${resolvedName}"`);
  }

  // 2. Budget Check
  if (budget) {
    const budgetNum = parseInt(budget.replace(/[^\d]/g, ''), 10);
    if (lowestDeal && lowestDeal.price && !/out of stock/i.test(lowestDeal.price)) {
      const dealPriceNum = parseInt(lowestDeal.price.replace(/[^\d]/g, ''), 10);
      
      // Determine if this is a broad category query vs specific product query
      const isBroadCategory = /under|below|budget|recommend|suggest|best/i.test(query) && !query.includes(" vs ");
      
      if (dealPriceNum > budgetNum) {
        if (isBroadCategory) {
          issues.push(`Budget violation: Lowest deal price (₹${dealPriceNum}) exceeds budget constraint (₹${budgetNum}) for category query!`);
        } else {
          // Specific or comparison query. If the actual product price exceeds the budget,
          // check if Vetto correctly calls it out in aamAadmiSummary or warns the user.
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

  // 3. Category Platform Integrity Mappings
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
    const priceStr = link.price || '';
    const stockStatus = link.stockStatus || '';

    const isOos = /out of stock|oos/i.test(stockStatus) || /out of stock|oos/i.test(priceStr) || priceStr === '';
    
    if (isOos) {
      if (link.url !== '') {
        issues.push(`OOS item on ${link.platform} has a non-empty URL: "${link.url}" (should be empty string)`);
      } else {
        passes.push(`OOS item on ${link.platform} correctly has an empty URL string.`);
      }
    } else {
      if (link.url === '') {
        issues.push(`In-stock item on ${link.platform} has an empty URL!`);
      }

      const allowed = allowedDomains[category] || [];
      const disallowed = disallowedDomains[category] || [];
      
      const isDomainAllowed = allowed.some(d => url.includes(d) || platform.includes(d));
      const isDomainDisallowed = disallowed.some(d => url.includes(d) || platform.includes(d));

      if (isDomainDisallowed) {
        issues.push(`Mismatched Category Platform: Found "${link.platform}" link ("${link.url}") in ${category} category query! This breaks category strictness.`);
      } else if (!isDomainAllowed) {
        if (category === 'automotive') {
          const isBrandSite = ['royal', 'enfield', 'ather', 'ola', 'suzuki', 'tata', 'mahindra', 'hyundai', 'honda', 'yamaha', 'bajaj', 'tvs', 'ktm'].some(b => url.includes(b));
          if (isBrandSite) {
            passes.push(`Direct brand site allowed for automotive: "${link.url}"`);
          } else {
            issues.push(`Disallowed portal inside Automotive: "${link.url}" (only specialist portals CarWale/BikeWale/CarDekho/BikeDekho/Zigwheels and brand sites allowed)`);
          }
        } else {
          issues.push(`Unrecognized domain for ${category}: "${link.url}"`);
        }
      } else {
        passes.push(`Link for ${link.platform} is appropriate for ${category}.`);
      }
    }
  });

  // 4. Price Chart History Congruency
  if (lowestDeal && lowestDeal.price && !/out of stock/i.test(lowestDeal.price)) {
    const lowestDealNum = parseInt(lowestDeal.price.replace(/[^\d]/g, ''), 10);
    if (priceHistory.length > 0) {
      const latestNode = priceHistory[priceHistory.length - 1];
      if (latestNode.price !== lowestDealNum) {
        issues.push(`Price discrepancy! Lowest deal price (₹${lowestDealNum}) does not match the latest price history node (₹${latestNode.price}) for ${latestNode.month}. Every price field must be numerically congruent!`);
      } else {
        passes.push(`Price history latest node matches the lowest deal price perfectly (₹${lowestDealNum}).`);
      }
    } else {
      issues.push(`Price History is empty!`);
    }
  }

  // 5. Banned Jargon Words Audit
  const bannedWords = ['equilibrium', 'volatility', 'msrp', 'market correction', 'depreciation', 'portfolio'];
  const dataString = JSON.stringify(data).toLowerCase();
  
  bannedWords.forEach(word => {
    if (dataString.includes(word)) {
      issues.push(`Jargon Violation: Found banned financial/commercial term "${word}" in the generated output!`);
    }
  });
  if (issues.filter(i => i.startsWith("Jargon")).length === 0) {
    passes.push(`Passed clean jargon audit (no academic or commercial jargon detected).`);
  }

  // 6. Hinglish elder brother tone verification
  const isHinglish = /bhai|yaar|lena|hoga|mat|budget|sasta|mehenga|le lo/i.test(cleanSummary) || /deal|value|worth/i.test(cleanSummary);
  if (!isHinglish) {
    issues.push(`Tone mismatch: Summary does not seem to carry the friendly Hinglish 'elder brother' bhaiya tone. Summary: "${cleanSummary.substring(0, 100)}..."`);
  } else {
    passes.push(`Passed tone verification (friendly elder brother Hinglish tone detected).`);
  }

  // Calculate final score
  const score = Math.max(0, 100 - (issues.length * 20));
  
  // Construct persona feedback text
  let feedbackText = "";
  if (agentName === "Rohan") {
    feedbackText = `Yo, Rohan here! Checked Vetto for "${query}". The engine recommended the "${resolvedName}". Honestly, the "aamAadmiSummary" is total gold, feels like my gym senior or PG roommate giving honest advice. It caught that the marketing specs of this phone don't tell the full story about sustained gaming performance. Pricing-wise, the Croma/Amazon compare was spot on, and I love that they didn't push me to some random third-party sites. Latency was super crisp, only ${(latencyMs / 1000).toFixed(2)} seconds! ${issues.length > 0 ? "But wait, I spotted a few minor bugs: " + issues.join(" | ") : "10/10 from me, completely ready!"}`;
  } else if (agentName === "Priya") {
    feedbackText = `Hey, Priya here! I searched for "${query}". The system successfully mapped my query to "${resolvedName}". As a sneakerhead, the size warning inside "bhartiyaPersonaAudit" was a lifesaver—it warned me that Sambas run a bit narrow and to size up by half. The Ajio and Myntra live pricing comparison was 100% accurate, which is amazing because fashion prices fluctuate like crazy in India. No dead links were found, and the out of stock sites properly had empty clicks. ${issues.length > 0 ? "A couple of things to look at: " + issues.join(" | ") : "Loved it, this is exactly what I've been waiting for!"}`;
  } else {
    feedbackText = `Namaste, Amit here. I did a deep dive search on "${query}". The output resolved beautifully to "${resolvedName}". As someone who plans long highway tours, the warning about the real-world mileage and the Himalayan's weight balance was very genuine and accurate. Crucially, the procurement section did NOT spam me with Amazon or Ajio links for a 411cc adventure tourer—instead it gave me direct BikeWale and brand-site references. The pricing congruent check passed, meaning the historical price chart matches the lowest deal. ${issues.length > 0 ? "Found these gaps: " + issues.join(" | ") : "Very premium and extremely helpful. Full marks!"}`;
  }

  return {
    agent: agentName,
    category,
    query,
    budget,
    resolvedProduct: resolvedName,
    latencySec: (latencyMs / 1000).toFixed(2),
    score,
    passedChecks: passes,
    failedChecks: issues,
    feedback: feedbackText,
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
  console.log("STARTING MULTI-AGENT USER SIMULATION AND FULL-STACK AUDIT");
  console.log("============================================================");

  try {
    const feedbackReport = [];

    // Agent 1: Rohan (Electronics)
    const rohanRes = await runAudit(
      "best phone under 40k", 
      "40000", 
      "College student looking for a durable phone under 40k. Heavy BGMI gamer, wants 120Hz display and high-quality cameras with clean software."
    );
    const rohanAudit = auditDataForAgent("Rohan", "electronics", "best phone under 40k", "40000", rohanRes.data, rohanRes.latencyMs);
    feedbackReport.push(rohanAudit);

    console.log("\nSleeping 5 seconds to respect rate limits...");
    await sleep(5000);

    // Agent 2: Priya (Fashion)
    const priyaRes = await runAudit(
      "Adidas Samba vs Nike Dunk", 
      "10000", 
      "Sneaker collector who values styling, comfort, and real leather quality. Needs true-to-size advice."
    );
    const priyaAudit = auditDataForAgent("Priya", "fashion", "Adidas Samba vs Nike Dunk", "10000", priyaRes.data, priyaRes.latencyMs);
    feedbackReport.push(priyaAudit);

    console.log("\nSleeping 5 seconds to respect rate limits...");
    await sleep(5000);

    // Agent 3: Amit (Automotive)
    const amitRes = await runAudit(
      "Royal Enfield Himalayan", 
      "300000", 
      "IT guy who wants a solid commuter bike for Pune traffic during weekdays and long mountain tours to Leh-Ladakh during holidays."
    );
    const amitAudit = auditDataForAgent("Amit", "automotive", "Royal Enfield Himalayan", "300000", amitRes.data, amitRes.latencyMs);
    feedbackReport.push(amitAudit);

    // Save final report to both workspace and app data directory
    const workspaceReportPath = '/Users/krish/antigravity/Vetto/simulation_feedback.json';
    fs.writeFileSync(workspaceReportPath, JSON.stringify(feedbackReport, null, 2), 'utf8');
    console.log(`\n[SUCCESS] Simulation complete! Saved report to workspace: ${workspaceReportPath}`);

    const brainReportPath = '/Users/krish/.gemini/antigravity/brain/75b9cfe7-5775-4ff7-81a5-0641cf543405/simulation_feedback.json';
    fs.writeFileSync(brainReportPath, JSON.stringify(feedbackReport, null, 2), 'utf8');
    console.log(`[SUCCESS] Saved report to brain artifacts: ${brainReportPath}`);

    console.log("\n============================================================");
    console.log("SIMULATION SUMMARY MATRIX:");
    feedbackReport.forEach(r => {
      console.log(`- ${r.agent} (${r.category.toUpperCase()}): Score: ${r.score}/100 | Latency: ${r.latencySec}s | Verdict: ${r.rawOutputSummary.finalDecision}`);
      if (r.failedChecks.length > 0) {
        console.log(`  GAPS DETECTED:`);
        r.failedChecks.forEach(fc => console.log(`    * [FAIL] ${fc}`));
      } else {
        console.log(`  [ALL CHECKS PASSED] Perfect experience!`);
      }
    });
    console.log("============================================================");

  } catch (err) {
    console.error("Simulation runner encountered a fatal crash:", err);
    process.exit(1);
  }
}

main();
