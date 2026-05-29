import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.VETTO_KEY || process.env.GEMINI_API_KEY });

async function testModel(modelName: string) {
  console.log(`Testing model: ${modelName}`);
  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: "Hello, list 3 words" }] }]
    });
    console.log(`SUCCESS for ${modelName}:`, response.text);
  } catch (err: any) {
    console.error(`FAILED for ${modelName}:`, err.message || err);
  }
}

async function run() {
  await testModel("gemini-3.5-flash");
  await testModel("gemini-2.5-flash");
  await testModel("gemini-2.0-flash");
  await testModel("gemini-1.5-flash");
}

run();
