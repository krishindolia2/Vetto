import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 3010;
const API_URL = `http://localhost:${PORT}/api/audit`;

const HIGH_VOLUME_PRODUCTS = [
  // Electronics
  "iPhone 16 Pro",
  "MacBook Air M3",
  "Sony WH-1000XM5",
  "OnePlus 12R",
  "Realme Buds Air 6 Pro",
  
  // Fashion
  "Unisex Heavyweight Oversized Hoodie",
  "Unisex Oversized Pullover Sweatshirt",
  "Pure Cotton Cargo Pants",
  "Air Jordan 1 Retro Low",
  
  // Automotive
  "Ola S1 Pro Gen 2",
  "Tata Nexon EV",
  "Ather 450X",
  "Mahindra XUV700"
];

async function runPreCache() {
  console.log(`============================================================`);
  console.log(`[PRE-CACHE WORKER] Starting Pre-Cache Run for ${HIGH_VOLUME_PRODUCTS.length} Items`);
  console.log(`[PRE-CACHE WORKER] Target Endpoint: ${API_URL}`);
  console.log(`============================================================\n`);

  for (const product of HIGH_VOLUME_PRODUCTS) {
    console.log(`[PRE-CACHE WORKER] Auditing & Caching: "${product}"...`);
    const startTime = Date.now();
    
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vetto-auth": "development" // Bypass rate limiting guard
        },
        body: JSON.stringify({ query: product })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`  ❌ [FAILED] HTTP Error ${response.status}: ${errText}`);
        continue;
      }

      const resData: any = await response.json();
      const duration = Date.now() - startTime;
      
      console.log(`  ✅ [SUCCESS] Cached successfully in ${duration}ms`);
      console.log(`     - Detected Vertical: ${resData.vertical?.toUpperCase()}`);
      console.log(`     - Recommendation: ${resData.auditData?.recommendation}`);
      console.log(`     - Value Score: ${resData.auditData?.value_for_money_score}/100\n`);

    } catch (error: any) {
      console.error(`  ❌ [FAILED] Network/Execution Error:`, error.message || error);
    }
    
    // Politeness delay between requests to avoid rate limits or CPU overload
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log(`============================================================`);
  console.log(`[PRE-CACHE WORKER] Completed Pre-Cache Operations`);
  console.log(`============================================================`);
}

runPreCache();
