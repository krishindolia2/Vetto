const http = require('http');
const fs = require('fs');

const API_URL = 'http://localhost:3000/api/audit';

// Define 20 diverse agent scenarios representing user queries
const agents = [
  { id: 1, role: "Gamer", query: "best gaming laptop under 70k", budget: "70000", expectedCategory: "electronics" },
  { id: 2, role: "Fashionista", query: "white sneakers for men", budget: "3000", expectedCategory: "fashion" },
  { id: 3, role: "Automotive Enthusiast", query: "best mileage bike", budget: "120000", expectedCategory: "automotive" },
  { id: 4, role: "Student", query: "is iPad 9th gen worth it?", budget: "", expectedCategory: "electronics" },
  { id: 5, role: "Tech Reviewer", query: "MacBook Air M2 vs M3", budget: "", expectedCategory: "electronics" },
  { id: 6, role: "Home Buyer", query: "best washing machine under 20k", budget: "20000", expectedCategory: "electronics" },
  { id: 7, role: "Sneakerhead", query: "Nike Air Force 1", budget: "", expectedCategory: "fashion" },
  { id: 8, role: "Commuter", query: "Ola S1 Pro vs Ather 450X", budget: "", expectedCategory: "automotive" },
  { id: 9, role: "Photographer", query: "Sony A7IV", budget: "", expectedCategory: "electronics" },
  { id: 10, role: "Hype Beast", query: "Yeezy Boost 350", budget: "", expectedCategory: "fashion" },
  { id: 11, role: "Family Car Buyer", query: "safest family car under 15 lakhs", budget: "1500000", expectedCategory: "automotive" },
  { id: 12, role: "Audiophile", query: "best noise cancelling headphones", budget: "25000", expectedCategory: "electronics" },
  { id: 13, role: "Bargain Hunter", query: "cheapest 5g phone", budget: "10000", expectedCategory: "electronics" },
  { id: 14, role: "Gym Rat", query: "best gym shoes", budget: "5000", expectedCategory: "fashion" },
  { id: 15, role: "Offroader", query: "Mahindra Thar", budget: "", expectedCategory: "automotive" },
  { id: 16, role: "Premium Buyer", query: "iPhone 15 Pro Max", budget: "", expectedCategory: "electronics" },
  { id: 17, role: "Winter Shopper", query: "north face winter jacket", budget: "10000", expectedCategory: "fashion" },
  { id: 18, role: "Daily Rider", query: "Honda Activa 6G", budget: "", expectedCategory: "automotive" },
  { id: 19, role: "Smart Home Fan", query: "Amazon Echo Dot", budget: "4000", expectedCategory: "electronics" },
  { id: 20, role: "Skeptical Buyer", query: "is Samsung S24 ultra worth 1.3 lakhs?", budget: "130000", expectedCategory: "electronics" }
];

async function runTest() {
  const results = [];
  const startTotal = Date.now();
  console.log(`Starting 20-Agent Simulation...`);

  const BATCH_SIZE = 5;
  for (let i = 0; i < agents.length; i += BATCH_SIZE) {
    const batch = agents.slice(i, i + BATCH_SIZE);
    
    const batchPromises = batch.map(async (agent) => {
      const startTime = Date.now();
      return new Promise((resolve) => {
        const req = http.request(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-vetto-auth': 'development' // Mock auth bypass for local test if any
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const latency = Date.now() - startTime;
            
            try {
              const responseJson = JSON.parse(data);
              
              const issues = [];
              
              // Validation 1: Latency
              if (latency > 15000) {
                 // Relaxing strict 10s slightly for batch testing locally
                 issues.push(`Latency warning: Took ${latency}ms`);
              }

              // Validation 2: Category Logic Link Enforcement
              const links = responseJson.priceIntegrity?.procurementLinks || [];
              const platforms = links.map(l => (l.platform || "").toLowerCase());
              
              if (agent.expectedCategory === 'automotive') {
                 const invalidPlatforms = platforms.filter(p => p.includes("amazon") || p.includes("flipkart") || p.includes("myntra") || p.includes("ajio") || p.includes("croma"));
                 if (invalidPlatforms.length > 0) {
                   issues.push(`Category Enforcement Fail: Automotive query returned invalid platforms: ${invalidPlatforms.join(", ")}`);
                 }
              }
              if (agent.expectedCategory === 'fashion') {
                 const invalidPlatforms = platforms.filter(p => p.includes("croma") || p.includes("reliance") || p.includes("carwale") || p.includes("zigwheels"));
                 if (invalidPlatforms.length > 0) {
                   issues.push(`Category Enforcement Fail: Fashion query returned invalid platforms: ${invalidPlatforms.join(", ")}`);
                 }
              }

              // Validation 3: Price Congruency
              const bestDeals = links.filter(l => l.isBestDeal);
              if (bestDeals.length > 1) {
                 issues.push(`Congruency Fail: Multiple isBestDeal flags true`);
              }
              if (bestDeals.length === 1 && links.length > 1) {
                 const bestDealNum = parseInt(bestDeals[0].price.replace(/[^\\d]/g, ""));
                 const otherLinks = links.filter(l => !l.isBestDeal && l.price && l.price !== "Out of Stock");
                 for (const other of otherLinks) {
                    const otherNum = parseInt(other.price.replace(/[^\\d]/g, ""));
                    if (!isNaN(otherNum) && !isNaN(bestDealNum) && otherNum < bestDealNum) {
                       issues.push(`Congruency Fail: 'Best Deal' price (₹${bestDealNum}) is higher than another platform (₹${otherNum})`);
                    }
                 }
              }
              
              // Validation 4: Budget Enforcement
              if (agent.budget) {
                 const budgetNum = parseInt(agent.budget);
                 if (bestDeals.length === 1) {
                    const bestDealNum = parseInt(bestDeals[0].price.replace(/[^\\d]/g, ""));
                    if (!isNaN(bestDealNum) && bestDealNum > budgetNum && responseJson.finalDecision === "BUY") {
                       issues.push(`Budget Fail: Price (₹${bestDealNum}) > Budget (₹${budgetNum}) but decision is BUY`);
                    }
                 }
              }

              // Validation 5: Link Accuracy (URL is present and starts with http)
              for (const l of links) {
                 if (l.stockStatus !== "Out of Stock" && (!l.url || !l.url.startsWith("http"))) {
                    issues.push(`Link Accuracy Fail: Valid stock but missing/invalid URL for ${l.platform}`);
                 }
                 if (l.stockStatus === "Out of Stock" && l.url) {
                    issues.push(`Link Accuracy Fail: Out of stock but URL was provided for ${l.platform}`);
                 }
              }
              
              resolve({
                agentId: agent.id,
                role: agent.role,
                query: agent.query,
                latencyMs: latency,
                status: issues.length === 0 ? "PASS" : "FAIL",
                issues: issues,
                resolvedProduct: responseJson.productName,
                finalDecision: responseJson.finalDecision,
                platformsFound: platforms
              });
            } catch (err) {
              resolve({
                agentId: agent.id,
                role: agent.role,
                query: agent.query,
                latencyMs: latency,
                status: "CRITICAL_ERROR",
                issues: [`JSON Parse Error or Server Crash: ${err.message}`]
              });
            }
          });
        });
        
        req.on('error', (err) => {
           resolve({
                agentId: agent.id,
                role: agent.role,
                query: agent.query,
                latencyMs: Date.now() - startTime,
                status: "CRITICAL_ERROR",
                issues: [`Request failed: ${err.message}`]
           });
        });

        req.write(JSON.stringify({ query: agent.query, budget: agent.budget }));
        req.end();
      });
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    console.log(`Completed batch ${i / BATCH_SIZE + 1} of ${Math.ceil(agents.length / BATCH_SIZE)}`);
  }
  
  const totalTime = Date.now() - startTotal;
  console.log(`\nSimulation Completed in ${totalTime}ms`);
  
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const critical = results.filter(r => r.status === "CRITICAL_ERROR").length;
  
  console.log(`\nResults: ${passed} PASS, ${failed} FAIL, ${critical} CRITICAL`);
  
  fs.writeFileSync('simulation_feedback.json', JSON.stringify(results, null, 2));
  console.log(`Detailed feedback saved to simulation_feedback.json`);
}

runTest().catch(console.error);
