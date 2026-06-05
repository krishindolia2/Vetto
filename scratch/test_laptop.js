import fs from 'fs';

async function testQuery() {
  const query = "best gaming laptop under 50k";
  console.log(`Sending query: "${query}"`);
  
  try {
    const response = await fetch('http://localhost:3010/api/audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query,
        budget: "50000",
        useCase: "General gaming and daily programming usage"
      })
    });
    
    if (!response.ok) {
      console.error(`HTTP error! status: ${response.status}`);
      const text = await response.text();
      console.error(text);
      return;
    }
    
    const data = await response.json();
    console.log("=========================================");
    console.log(`Resolved Product: ${data.productName}`);
    console.log(`Final Decision: ${data.finalDecision}`);
    console.log(`Paisa Vasool Index: ${data.paisaVasoolIndex}`);
    console.log(`Why Best: ${data.whyBest}`);
    console.log(`Divergence Index: ${data.socialAudit?.integrityAudit?.divergenceIndex}`);
    console.log(`Fake Review Score: ${data.socialAudit?.integrityAudit?.fakeReviewScore}`);
    console.log("Procurement Links:");
    console.log(JSON.stringify(data.priceIntegrity?.procurementLinks, null, 2));
    console.log("=========================================");
    fs.writeFileSync('scratch/laptop_audit_response.json', JSON.stringify(data, null, 2));
    console.log("Full response saved to scratch/laptop_audit_response.json");
  } catch (error) {
    console.error("Error running test query:", error);
  }
}

testQuery();
