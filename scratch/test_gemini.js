const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function testGrounding(query) {
  const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-pro", 
    tools: [{ googleSearch: {} }] 
  });
  
  const prompt = `Find the exact current live price and the direct product URL on Amazon India and Flipkart for: "${query}". Return a JSON array.`;
  
  const result = await model.generateContent(prompt);
  console.log(result.response.text());
}

testGrounding("Lenovo IdeaPad Slim 3 12th Gen Core i5 16GB");
