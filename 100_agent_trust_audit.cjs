const http = require('http');
const fs = require('fs');

const API_URL = 'http://localhost:3000/api/audit';

// Generate 100 Agents with 2 diverse queries each
const categories = ['electronics', 'fashion', 'automotive'];
const baseProducts = {
  electronics: ["laptop", "phone", "smartwatch", "earbuds", "tv", "camera", "tablet", "monitor", "power bank", "router"],
  fashion: ["sneakers", "jacket", "jeans", "t-shirt", "sunglasses", "backpack", "watch", "shoes", "hoodie", "cap"],
  automotive: ["car", "scooter", "bike", "helmet", "dashcam", "tyres", "engine oil", "car cover", "ev", "suv"]
};

const brands = {
  electronics: ["Apple", "Samsung", "Sony", "Dell", "HP", "Asus", "Lenovo", "OnePlus", "Xiaomi", "LG"],
  fashion: ["Nike", "Adidas", "Puma", "Levi's", "Zara", "H&M", "Casio", "Woodland", "Ray-Ban", "Wildcraft"],
  automotive: ["Maruti", "Hyundai", "Tata", "Mahindra", "Honda", "Royal Enfield", "TVS", "Bajaj", "Ather", "Ola"]
};

const agents = [];
for (let i = 1; i <= 100; i++) {
  // Query 1
  const cat1 = categories[i % 3];
  const prod1 = `${brands[cat1][i % 10]} ${baseProducts[cat1][(i * 2) % 10]}`;
  const budget1 = (i * 1500).toString();
  
  // Query 2 (Different Category)
  const cat2 = categories[(i + 1) % 3];
  const prod2 = `best cheap ${baseProducts[cat2][(i * 3) % 10]}`;
  const budget2 = (i * 1000).toString();

  agents.push({
    id: i,
    role: `Agent_${i}`,
    queries: [
      { qId: `${i}_A`, text: prod1, budget: budget1, expectedCategory: cat1 },
      { qId: `${i}_B`, text: prod2, budget: budget2, expectedCategory: cat2 }
    ]
  });
}

// Flatten into 200 distinct test cases
const testCases = [];
agents.forEach(agent => {
  agent.queries.forEach(q => {
    testCases.push({
      agentId: agent.id,
      role: agent.role,
      qId: q.qId,
      query: q.text,
      budget: q.budget,
      expectedCategory: q.expectedCategory
    });
  });
});

async function runTest() {
  const results = [];
  const startTotal = Date.now();
  console.log(`Starting 100-Agent (200 Queries) Hyper-Scale Validation...`);

  // Run in batches of 20 to heavily stress test concurrency and logic stability
  const BATCH_SIZE = 20;
  for (let i = 0; i < testCases.length; i += BATCH_SIZE) {
    const batch = testCases.slice(i, i + BATCH_SIZE);
    
    const batchPromises = batch.map(async (tc) => {
      const startTime = Date.now();
      return new Promise((resolve) => {
        const req = http.request(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-vetto-auth': 'development'
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const latency = Date.now() - startTime;
            
            try {
              const responseJson = JSON.parse(data);
              const issues = [];
              
              // Validation 1: Latency (Strict 10s Rule)
              if (latency > 10000) {
                 issues.push(`LATENCY FAIL: Took ${latency}ms`);
              }

              // Validation 2: Category Logic Contamination Check
              const links = responseJson.priceIntegrity?.procurementLinks || [];
              const platforms = links.map(l => (l.platform || "").toLowerCase());
              
              if (tc.expectedCategory === 'automotive') {
                 const invalidPlatforms = platforms.filter(p => p.includes("amazon") || p.includes("flipkart") || p.includes("myntra") || p.includes("ajio") || p.includes("croma"));
                 if (invalidPlatforms.length > 0) {
                   issues.push(`Category Contamination: Auto query returned ${invalidPlatforms.join(", ")}`);
                 }
              }
              if (tc.expectedCategory === 'fashion') {
                 const invalidPlatforms = platforms.filter(p => p.includes("croma") || p.includes("reliance") || p.includes("carwale") || p.includes("zigwheels"));
                 if (invalidPlatforms.length > 0) {
                   issues.push(`Category Contamination: Fashion query returned ${invalidPlatforms.join(", ")}`);
                 }
              }

              // Validation 3: Accuracy Metric (Price Congruency & isBestDeal)
              const bestDeals = links.filter(l => l.isBestDeal);
              if (bestDeals.length > 1) {
                 issues.push(`Accuracy Fail: Multiple isBestDeal flags true`);
              }
              if (bestDeals.length === 1 && links.length > 1) {
                 const bestDealNum = parseInt(bestDeals[0].price.replace(/[^\\d]/g, ""));
                 const otherLinks = links.filter(l => !l.isBestDeal && l.price && l.price !== "Out of Stock");
                 for (const other of otherLinks) {
                    const otherNum = parseInt(other.price.replace(/[^\\d]/g, ""));
                    if (!isNaN(otherNum) && !isNaN(bestDealNum) && otherNum < bestDealNum) {
                       issues.push(`Accuracy Fail: Best Deal price (₹${bestDealNum}) is higher than another platform (₹${otherNum})`);
                    }
                 }
              }
              
              // Validation 4: Budget Limit Adherence
              if (tc.budget) {
                 const budgetNum = parseInt(tc.budget);
                 if (bestDeals.length === 1) {
                    const bestDealNum = parseInt(bestDeals[0].price.replace(/[^\\d]/g, ""));
                    if (!isNaN(bestDealNum) && bestDealNum > budgetNum && responseJson.finalDecision === "BUY") {
                       issues.push(`Trust Fail: Recommended BUY despite price (₹${bestDealNum}) exceeding budget (₹${budgetNum})`);
                    }
                 }
              }

              // Validation 5: Link Integrity
              for (const l of links) {
                 if (l.stockStatus !== "Out of Stock" && (!l.url || !l.url.startsWith("http"))) {
                    issues.push(`Link Accuracy Fail: Missing/invalid URL for ${l.platform}`);
                 }
              }
              
              resolve({
                qId: tc.qId,
                agentId: tc.agentId,
                query: tc.query,
                latencyMs: latency,
                status: issues.length === 0 ? "PASS" : "FAIL",
                issues: issues,
                resolvedProduct: responseJson.productName,
                finalDecision: responseJson.finalDecision
              });
            } catch (err) {
              resolve({
                qId: tc.qId,
                agentId: tc.agentId,
                query: tc.query,
                latencyMs: latency,
                status: "CRITICAL_ERROR",
                issues: [`Parse Error/Crash: ${err.message}`]
              });
            }
          });
        });
        
        req.on('error', (err) => {
           resolve({
                qId: tc.qId,
                agentId: tc.agentId,
                query: tc.query,
                latencyMs: Date.now() - startTime,
                status: "CRITICAL_ERROR",
                issues: [`Request failed: ${err.message}`]
           });
        });

        req.write(JSON.stringify({ query: tc.query, budget: tc.budget }));
        req.end();
      });
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    console.log(`Completed batch ${i / BATCH_SIZE + 1} of ${Math.ceil(testCases.length / BATCH_SIZE)}`);
  }
  
  const totalTime = Date.now() - startTotal;
  console.log(`\nSimulation Completed in ${totalTime}ms`);
  
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const critical = results.filter(r => r.status === "CRITICAL_ERROR").length;
  
  console.log(`\nResults: ${passed} PASS, ${failed} FAIL, ${critical} CRITICAL`);
  
  fs.writeFileSync('100_agent_feedback.json', JSON.stringify(results, null, 2));
  console.log(`Detailed feedback saved to 100_agent_feedback.json`);
}

runTest().catch(console.error);
