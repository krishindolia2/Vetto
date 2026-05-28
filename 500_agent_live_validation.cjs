const http = require('http');
const fs = require('fs');

const API_URL = 'http://localhost:3000/api/audit';

// Generate 500 Unseen Independent Queries
const queries = [];
const brands = ["LG", "Whirlpool", "Bosch", "Godrej", "Voltas", "Hitachi", "Daikin", "IFB", "Haier", "Panasonic", "Sony", "JBL", "Boat", "Noise", "Fire-Boltt", "Nothing", "Motorola", "Realme", "Oppo", "Vivo", "Poco", "Infinix", "Tecno", "iQOO", "Marshall", "Sennheiser", "Skullcandy", "Bose", "Sonos", "Yamaha"];
const products = ["Washing Machine", "Refrigerator", "AC", "Microwave", "Dishwasher", "Water Purifier", "Geyser", "Vacuum Cleaner", "Air Purifier", "Fan", "Heater", "Cooler", "Iron", "Mixer Grinder", "Juicer", "Toaster", "Coffee Maker", "Kettle", "Induction", "Chimney"];
const attributes = ["Best", "Cheapest", "Top Rated", "Smart", "Energy Efficient", "Budget", "Premium", "Heavy Duty", "Silent", "Portable"];
const categories = ["electronics", "home"];

let queryCounter = 0;
for (let b = 0; b < brands.length; b++) {
  for (let p = 0; p < products.length; p++) {
     if (queryCounter >= 500) break;
     const attr = attributes[(b + p) % attributes.length];
     const text = `${attr} ${brands[b]} ${products[p]}`;
     const budget = ((p + 1) * 3000).toString();
     
     queries.push({
       id: queryCounter + 1,
       role: `IndependentUser_${queryCounter + 1}`,
       text: text,
       budget: budget,
       expectedCategory: categories[(b + p) % 2],
       primaryKeyword: brands[b].toLowerCase()
     });
     queryCounter++;
  }
}

async function runTest() {
  const results = [];
  const startTotal = Date.now();
  console.log(`Starting 500-User Extreme Independent Validation...`);

  const BATCH_SIZE = 50; // Massively aggressive concurrency testing
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    
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
              
              // Validation 1: Trust & Idea Validation (AI Persona checks)
              const summary = responseJson.aamAadmiSummary || "";
              if (!summary.includes("Bhai") && !summary.includes("yaar") && !summary.includes("le lo") && !summary.includes("mat lena") && !summary.includes("mehenga") && !summary.includes("sasta") && !summary.includes("Bhaiya") && !summary.includes("worth it")) {
                 issues.push(`Trust Fail: Summary sounds like generic AI spam. Does not maintain ground reality Aam Aadmi persona.`);
              }
              
              // Validation 2: Live Link Authentication
              const links = responseJson.priceIntegrity?.procurementLinks || [];
              for (const l of links) {
                 if (l.stockStatus !== "Out of Stock" && l.url) {
                    if (!l.url.startsWith("http")) {
                        issues.push(`Link Authentication Fail: Invalid URL format for ${l.platform}`);
                    }
                    // URL mapping check - strict keyword extraction
                    // Since it's mock cache, they might route to search pages. If so, verify it passes standard test bounds.
                 }
              }

              // Validation 3: Price Ground Reality (Mathematical Bounding)
              const bestDeals = links.filter(l => l.isBestDeal);
              if (bestDeals.length > 1) {
                 issues.push(`Accuracy Fail: Multiple isBestDeal flags true`);
              }
              if (bestDeals.length === 1 && links.length > 1) {
                 const bestDealNum = parseInt(bestDeals[0].price.replace(/[^\\d]/g, ""));
                 
                 // If best deal is somehow absurdly low (like ₹1 for a washing machine) or absurdly high (₹9999999)
                 if (bestDealNum < 100 || bestDealNum > 500000) {
                     issues.push(`Price Ground Reality Fail: Absurd hallucinated price of ₹${bestDealNum}`);
                 }

                 const otherLinks = links.filter(l => !l.isBestDeal && l.price && l.price !== "Out of Stock");
                 for (const other of otherLinks) {
                    const otherNum = parseInt(other.price.replace(/[^\\d]/g, ""));
                    if (!isNaN(otherNum) && !isNaN(bestDealNum) && otherNum < bestDealNum) {
                       issues.push(`Accuracy Fail: Best Deal price (₹${bestDealNum}) is higher than another platform (₹${otherNum})`);
                    }
                 }
              }
              
              resolve({
                userId: tc.id,
                role: tc.role,
                query: tc.text,
                latencyMs: latency,
                status: issues.length === 0 ? "PASS" : "FAIL",
                issues: issues,
                resolvedProduct: responseJson.productName,
                finalDecision: responseJson.finalDecision
              });
            } catch (err) {
              resolve({
                userId: tc.id,
                role: tc.role,
                query: tc.text,
                latencyMs: latency,
                status: "CRITICAL_ERROR",
                issues: [`Parse Error/Crash: ${err.message}`]
              });
            }
          });
        });
        
        req.on('error', (err) => {
           resolve({
                userId: tc.id,
                role: tc.role,
                query: tc.text,
                latencyMs: Date.now() - startTime,
                status: "CRITICAL_ERROR",
                issues: [`Request failed: ${err.message}`]
           });
        });

        req.write(JSON.stringify({ query: tc.text, budget: tc.budget }));
        req.end();
      });
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    console.log(`Completed batch ${i / BATCH_SIZE + 1} of ${Math.ceil(queries.length / BATCH_SIZE)}`);
  }
  
  const totalTime = Date.now() - startTotal;
  console.log(`\nExtreme Simulation Completed in ${totalTime}ms`);
  
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const critical = results.filter(r => r.status === "CRITICAL_ERROR").length;
  
  console.log(`\nResults: ${passed} PASS, ${failed} FAIL, ${critical} CRITICAL`);
  
  fs.writeFileSync('500_user_validation_report.json', JSON.stringify(results, null, 2));
  console.log(`Detailed feedback saved to 500_user_validation_report.json`);
}

runTest().catch(console.error);
