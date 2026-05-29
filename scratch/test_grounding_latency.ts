import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.VETTO_KEY || process.env.GEMINI_API_KEY });

async function testGrounding(modelName: string) {
  console.log(`\nTesting Grounding with model: ${modelName}`);
  const startTime = Date.now();
  try {
    const config: any = {
      tools: [{ googleSearch: {} }],
      temperature: 0.0,
      maxOutputTokens: 500,
    };
    if (modelName.includes("gemini-3")) {
      config.thinkingConfig = {
        thinkingLevel: ThinkingLevel.MINIMAL
      };
    } else {
      config.thinkingConfig = {
        thinkingBudget: 0
      };
    }
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: "Search for GoPro HERO13 Black price in India and list the price and store link" }] }],
      config: config
    });
    const duration = Date.now() - startTime;
    console.log(`Duration: ${duration}ms`);
    console.log(`Response:`, response.text);
  } catch (err: any) {
    console.error("Error:", err.message || err);
  }
}

async function run() {
  await testGrounding("gemini-3.5-flash");
  await testGrounding("gemini-2.5-flash");
}

run();
