import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const apiKey = process.env.VETTO_KEY || process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

async function callWithRetry(params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await ai.models.generateContent(params);
    } catch (e) {
      console.warn(`Attempt ${i + 1} failed: ${e.message}`);
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
}

async function testResolver() {
  const query = "best gaming laptop under 50k";
  const budget = "50000";
  const useCase = "General gaming and daily programming usage";
  
  const prompt = `You are a precision product semantic resolver. 
  Analyze the user's query: "${query}"
  Budget Limit: ${budget ? `₹${budget}` : "Unlimited"}
  Specific Need/Context: "${useCase || "General Use"}"

  Task:
  1. Determine the "queryType":
     - "category": User is asking for a general recommendation (e.g. "best phone under 30k", "running shoes").
     - "comparison": User is comparing two or more products (e.g. "iPhone 15 vs S24").
     - "specific": User is asking about a single specific product model (e.g. "iQOO Neo 9 Pro", "Royal Enfield Himalayan").
  2. Resolve this to exactly ONE highly specific product model name ("productName").
     - If "category", pick the absolute best value-for-money product that fits strictly within the budget and matches their context. Make sure it is an exact, specific product variant available in India (e.g. "Realme Buds Air 6 Pro 50dB ANC" or "OnePlus Buds 3" for earbuds under 5k - NOT "boat earbuds" or "OnePlus Buds Nord").
     - CURRENT & ACTIVE SKU RULE: You MUST resolve category queries to CURRENT (2025/2026), active, and widely available product models in India today. Do NOT select obsolete or discontinued models (e.g., do not recommend GTX 1650 or Ryzen 5500H laptops if RTX 3050 / Ryzen 5600H or newer laptops are widely available within budget).
     - IN-STOCK VERIFICATION: Use the search grounding results to verify that the product is actually active and in stock on major Indian retail platforms (like Amazon India or Flipkart) today. Do NOT select discontinued or out-of-stock models.
     - CONCISE CANONICAL FORMAT: The "productName" MUST be clean, concise, and optimized for search engine queries. It should contain the brand, model series, processor, and GPU, but do NOT include verbose specifications like dimensions, display refresh rate, exact port lists, year, or release tags (e.g. return "Lenovo IdeaPad Gaming 3 Ryzen 5 6600H RTX 3050" or "HP Victus 15 Ryzen 5 5600H RTX 3050" - NOT "Lenovo IdeaPad Gaming 3 15.6 inch FHD 120Hz (AMD Ryzen 5 6600H, NVIDIA GeForce RTX 3050 4GB, 8GB DDR5, 512GB SSD, Windows 11)"). A clean name is critical for accurate price scraping.
     - BUDGET CEILING ALIGNMENT RULE: If the user provides a budget limit (e.g. "under 5k", "under 40k", "under 30k"), you MUST target the upper-tier of that budget constraint to deliver the maximum premium utility. Select a superior, spec-dominating product that lands strictly between 80% to 100% of the budget range (e.g., if the budget is 5k, select a superior ₹4,000-₹4,900 option like "Realme Buds Air 6 Pro" or "OnePlus Buds 3", rather than aggressively downgrading the user to a basic ₹2,000 product). Recommending a cheap, under-specced product when the budget allows for a far more premium, spec-dominating choice is a critical failure.
     - If "specific", return the clean, full canonical product name with specific configurations if inferred (e.g. "Royal Enfield Himalayan 450 Standard").
     - If "comparison", return the primary or first product name.

  Return strictly a JSON object conforming to this schema:
  {
    "productName": "Resolved full specific product name with specifications",
    "queryType": "category" | "specific" | "comparison"
  }
  No explanation, no markdown.`;

  console.log("Calling gemini-2.5-flash with search grounding...");
  try {
    const response = await callWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.0,
        maxOutputTokens: 4000
      }
    });

    console.log("=========================================");
    console.log("FULL RESPONSE:");
    console.log(JSON.stringify(response, null, 2));
    console.log("=========================================");
  } catch (err) {
    console.error("Error running test:", err);
  }
}

testResolver();
