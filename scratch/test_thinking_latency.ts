import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.VETTO_KEY || process.env.GEMINI_API_KEY });

async function testLatency(enableThinkingConfig: boolean) {
  console.log(`\nTesting with enableThinkingConfig = ${enableThinkingConfig}`);
  const startTime = Date.now();
  try {
    const config: any = {
      temperature: 0.0,
      maxOutputTokens: 500,
    };
    if (enableThinkingConfig) {
      config.thinkingConfig = {
        thinkingLevel: ThinkingLevel.MINIMAL
      };
    }
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [{ role: "user", parts: [{ text: "Explain how a dishwasher works in 100 words." }] }],
      config: config
    });
    const duration = Date.now() - startTime;
    console.log(`Duration: ${duration}ms`);
    console.log(`Response length: ${response.text?.length} chars`);
  } catch (err: any) {
    console.error("Error:", err.message || err);
  }
}

async function run() {
  // Run both to compare
  await testLatency(false);
  await testLatency(true);
}

run();
