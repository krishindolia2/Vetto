import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.VETTO_KEY || process.env.GEMINI_API_KEY });

async function run() {
  try {
    const response = await ai.models.list();
    for (const model of response) {
      console.log(model.name);
    }
  } catch (err) {
    console.error(err);
  }
}

run();
