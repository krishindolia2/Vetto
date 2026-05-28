const http = require('http');
const fs = require('fs');

const API_URL = 'http://localhost:3000/api/audit';

// Generate 50 diverse queries
const agents = [
  { id: 1, role: "Tech Bro", query: "MacBook Pro M3 Max", budget: "", expectedCategory: "electronics" },
  { id: 2, role: "College Student", query: "best laptop under 40000", budget: "40000", expectedCategory: "electronics" },
  { id: 3, role: "Hype Beast", query: "Air Jordan 1 Retro High", budget: "", expectedCategory: "fashion" },
  { id: 4, role: "Dad", query: "Maruti Suzuki Ertiga", budget: "", expectedCategory: "automotive" },
  { id: 5, role: "Gamer", query: "PS5 Disc Edition", budget: "", expectedCategory: "electronics" },
  { id: 6, role: "Influencer", query: "Dyson Airwrap", budget: "", expectedCategory: "electronics" },
  { id: 7, role: "Biker", query: "Royal Enfield Classic 350", budget: "", expectedCategory: "automotive" },
  { id: 8, role: "Bargain Hunter", query: "cheapest 5g phone", budget: "12000", expectedCategory: "electronics" },
  { id: 9, role: "Fitness Freak", query: "Nike Metcon 9", budget: "10000", expectedCategory: "fashion" },
  { id: 10, role: "Photographer", query: "Sony A7IV camera", budget: "", expectedCategory: "electronics" },
  { id: 11, role: "Audiophile", query: "Sony WH-1000XM5", budget: "", expectedCategory: "electronics" },
  { id: 12, role: "Smart Home Enthusiast", query: "Amazon Echo Dot", budget: "", expectedCategory: "electronics" },
  { id: 13, role: "Premium Buyer", query: "iPhone 15 Pro Max 1TB", budget: "", expectedCategory: "electronics" },
  { id: 14, role: "Budget Buyer", query: "Samsung Galaxy M14", budget: "15000", expectedCategory: "electronics" },
  { id: 15, role: "Office Worker", query: "Logitech MX Master 3S", budget: "", expectedCategory: "electronics" },
  { id: 16, role: "Traveler", query: "American Tourister Trolley Bag", budget: "5000", expectedCategory: "fashion" },
  { id: 17, role: "EV Enthusiast", query: "Tata Nexon EV", budget: "", expectedCategory: "automotive" },
  { id: 18, role: "Commuter", query: "Ola S1 Pro", budget: "", expectedCategory: "automotive" },
  { id: 19, role: "Winter Shopper", query: "North Face Jacket", budget: "12000", expectedCategory: "fashion" },
  { id: 20, role: "Skeptical Buyer", query: "is Samsung S24 ultra worth it?", budget: "", expectedCategory: "electronics" },
  { id: 21, role: "Reader", query: "Kindle Paperwhite", budget: "", expectedCategory: "electronics" },
  { id: 22, role: "Chef", query: "Philips Air Fryer", budget: "", expectedCategory: "electronics" },
  { id: 23, role: "Student", query: "iPad 9th Gen", budget: "30000", expectedCategory: "electronics" },
  { id: 24, role: "Vlogger", query: "DJI Osmo Pocket 3", budget: "", expectedCategory: "electronics" },
  { id: 25, role: "Programmer", query: "Keychron K2 keyboard", budget: "", expectedCategory: "electronics" },
  { id: 26, role: "Luxury Shopper", query: "Rolex Submariner", budget: "", expectedCategory: "fashion" },
  { id: 27, role: "Casual Gamer", query: "Nintendo Switch OLED", budget: "", expectedCategory: "electronics" },
  { id: 28, role: "Home Owner", query: "Roborock S8 vacuum", budget: "", expectedCategory: "electronics" },
  { id: 29, role: "Runner", query: "Asics Gel Kayano 30", budget: "", expectedCategory: "fashion" },
  { id: 30, role: "Musician", query: "Yamaha F310 acoustic guitar", budget: "10000", expectedCategory: "electronics" },
  { id: 31, role: "Cinephile", query: "LG C3 OLED TV 55 inch", budget: "", expectedCategory: "electronics" },
  { id: 32, role: "Offroader", query: "Mahindra Thar 4x4", budget: "", expectedCategory: "automotive" },
  { id: 33, role: "Eco Warrior", query: "Ather 450X", budget: "", expectedCategory: "automotive" },
  { id: 34, role: "New Parent", query: "LuvLap baby stroller", budget: "5000", expectedCategory: "fashion" },
  { id: 35, role: "Caffeine Addict", query: "Breville Barista Express", budget: "", expectedCategory: "electronics" },
  { id: 36, role: "Streamer", query: "Elgato Stream Deck", budget: "", expectedCategory: "electronics" },
  { id: 37, role: "DIYer", query: "Bosch Power Drill", budget: "", expectedCategory: "electronics" },
  { id: 38, role: "Cyclist", query: "Firefox Geared Cycle", budget: "15000", expectedCategory: "automotive" },
  { id: 39, role: "Sneakerhead", query: "Yeezy Boost 350", budget: "", expectedCategory: "fashion" },
  { id: 40, role: "Gadget Freak", query: "Meta Quest 3", budget: "", expectedCategory: "electronics" },
  { id: 41, role: "Apple Fanboy", query: "Apple Watch Ultra 2", budget: "", expectedCategory: "electronics" },
  { id: 42, role: "Android Purist", query: "Google Pixel 8 Pro", budget: "", expectedCategory: "electronics" },
  { id: 43, role: "Movie Buff", query: "Bose Soundbar 900", budget: "", expectedCategory: "electronics" },
  { id: 44, role: "Minimalist", query: "Nothing Phone 2", budget: "", expectedCategory: "electronics" },
  { id: 45, role: "Power User", query: "Samsung Odyssey G9 Monitor", budget: "", expectedCategory: "electronics" },
  { id: 46, role: "Classic Man", query: "Casio G-Shock", budget: "", expectedCategory: "fashion" },
  { id: 47, role: "Speed Demon", query: "KTM Duke 390", budget: "", expectedCategory: "automotive" },
  { id: 48, role: "Practical Buyer", query: "Honda City", budget: "", expectedCategory: "automotive" },
  { id: 49, role: "Tech Reviewer", query: "OnePlus 12", budget: "", expectedCategory: "electronics" },
  { id: 50, role: "Casual User", query: "best power bank 20000mah", budget: "2000", expectedCategory: "electronics" }
];

async function runTest() {
  const results = [];
  const startTotal = Date.now();
  console.log(`Starting 50-Agent Massive Simulation...`);

  // We will run in batches of 10 to simulate high concurrency
  const BATCH_SIZE = 10;
  for (let i = 0; i < agents.length; i += BATCH_SIZE) {
    const batch = agents.slice(i, i + BATCH_SIZE);
    
    const batchPromises = batch.map(async (agent) => {
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
                 issues.push(`LATENCY FAIL: Took ${latency}ms (Limit: 10000ms)`);
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

              // Validation 5: Link Accuracy
              for (const l of links) {
                 if (l.stockStatus !== "Out of Stock" && (!l.url || !l.url.startsWith("http"))) {
                    issues.push(`Link Accuracy Fail: Valid stock but missing/invalid URL for ${l.platform}`);
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
                finalDecision: responseJson.finalDecision
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
  
  fs.writeFileSync('50_agent_results.json', JSON.stringify(results, null, 2));
  console.log(`Detailed feedback saved to 50_agent_results.json`);
}

runTest().catch(console.error);
