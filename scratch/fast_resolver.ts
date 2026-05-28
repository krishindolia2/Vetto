async function resolveSpecificProduct(query: string, budget: string): Promise<{ resolvedName: string, queryType: string }> {
  if (!ai) return { resolvedName: query, queryType: "specific" };
  
  const prompt = `You are a product resolution engine for the Indian market.
User Query: "${query}"
Budget Constraint: ${budget ? `₹${budget}` : "None"}

Your job is to determine if this is a generic/category query (e.g., "best laptop under 50k", "good running shoes") or a specific product (e.g., "MacBook Air M2", "Nike Pegasus 40").
If it is a specific product, return it exactly.
If it is a generic category query, you MUST recommend exactly ONE specific, highly-rated product model that perfectly matches their query and strictly fits under their budget.

Return ONLY a valid JSON object in this format:
{
  "resolvedName": "Exact Full Product Name (e.g. Lenovo IdeaPad Slim 3 12th Gen Core i5 16GB)",
  "queryType": "category" // or "specific" or "comparison"
}`;

  try {
    const response = await callGeminiWithRetry({
      model: "gemini-3.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.0 }
    });
    const text = response.text || "";
    const repaired = repairJson(text);
    const parsed = JSON.parse(repaired);
    return {
      resolvedName: parsed.resolvedName || query,
      queryType: parsed.queryType || "specific"
    };
  } catch (err) {
    console.error("[Fast Resolver] Failed:", err);
    return { resolvedName: query, queryType: "specific" };
  }
}
