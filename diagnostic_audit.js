import { assert } from 'console';

async function runTest(query) {
  console.log(`\n============================================================`);
  console.log(`[DIAGNOSTIC] Running Audit for: "${query}"`);
  console.log(`============================================================`);
  
  try {
    const response = await fetch('http://localhost:3010/api/audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.error(`[ERROR] Audit request failed: ${response.status} - ${errText}`);
      return;
    }
    
    const resData = await response.json();
    const { vertical, queryType, resolvedProduct, auditData } = resData;
    
    console.log(`[ROUTER RESULT] Standardized Product: "${resolvedProduct}"`);
    console.log(`[ROUTER RESULT] Query Type: "${queryType}"`);
    console.log(`[ROUTER RESULT] Detected Vertical: "${vertical.toUpperCase()}"`);
    console.log(`[REPORT RESULT] Timing Verdict: "${auditData.recommendation}"`);
    console.log(`[REPORT RESULT] Value Score: ${auditData.value_for_money_score}/100`);
    console.log(`[REPORT RESULT] Brand Tax: ₹${auditData.brand_tax}`);
    
    console.log(`\n[VERTICAL METRICS VERIFICATION]`);
    switch(vertical) {
      case 'electronics':
        console.log(`  - Bottleneck Warning: "${auditData.bottleneck_warning}"`);
        console.log(`  - Thermal Throttling Index: ${auditData.thermal_throttling_index}/100`);
        console.log(`  - Longevity Rating: ${auditData.longevity_rating_years} Years`);
        console.log(`  - Jargon Demystifiers:`, auditData.jargon_demystifier);
        
        // Assertions
        if (auditData.thermal_throttling_index !== undefined && auditData.longevity_rating_years !== undefined) {
          console.log(`  ✅ [PASS] Electronics specific parameters successfully resolved.`);
        } else {
          console.log(`  ❌ [FAIL] Missing electronics parameters.`);
        }
        break;
        
      case 'fashion':
        console.log(`  - Material Honesty Score: ${auditData.material_honesty_score}%`);
        console.log(`  - GSM Weight: ${auditData.gsm_weight} GSM`);
        console.log(`  - Sizing Alert: "${auditData.sizing_alert}"`);
        console.log(`  - Wash & Lifecycle Durability: "${auditData.wash_durability}"`);
        
        // Assertions
        if (auditData.material_honesty_score !== undefined && auditData.gsm_weight !== undefined) {
          console.log(`  ✅ [PASS] Fashion specific parameters successfully resolved.`);
        } else {
          console.log(`  ❌ [FAIL] Missing fashion parameters.`);
        }
        break;
        
      case 'automotive':
        console.log(`  - 5-Year Total Cost of Ownership: ₹${auditData.total_cost_of_ownership_5yr}`);
        console.log(`  - NCAP Safety Rating: "${auditData.safety_rating_ncap}"`);
        console.log(`  - Resale value retention curve:`, auditData.resale_value_retention_curve);
        
        // Assertions
        if (auditData.total_cost_of_ownership_5yr !== undefined && auditData.safety_rating_ncap !== undefined) {
          console.log(`  ✅ [PASS] Automotive specific parameters successfully resolved.`);
        } else {
          console.log(`  ❌ [FAIL] Missing automotive parameters.`);
        }
        break;
        
      default:
        console.log(`  ⚠ Resolved to generic/fallback vertical.`);
    }
    
  } catch (error) {
    console.error(`[ERROR] Test run failed:`, error);
  }
}

async function main() {
  // Delay helper to prevent rate limiting
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
  // 1. Electronics
  await runTest("MacBook Pro M3 16GB");
  await sleep(3000);
  
  // 2. Fashion
  await runTest("Premium Heavyweight Oversized Hoodie");
  await sleep(3000);
  
  // 3. Automotive
  await runTest("Ola S1 Pro Gen 2");
}

main();
