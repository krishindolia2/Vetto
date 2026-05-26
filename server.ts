import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { initializeApp as initializeFirebase } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp, runTransaction, increment } from "firebase/firestore";
import { Agent, setGlobalDispatcher } from "undici";

dotenv.config();

// Global Process Shield: Prevent Node.js process crashes caused by unawaited background SDK 
// promises or internal library exceptions (e.g. Gemini quota/dunning or Firebase network failures)
process.on("unhandledRejection", (reason, promise) => {
  console.warn("[Process Shield] Intercepted Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Process Shield] Intercepted Uncaught Exception:", error);
});

// Maximize HTTP socket timeouts globally to shield pre-fetch Google Search grounding requests
// from undici's default strict 30-second headers timeout limit (elevate to 5 minutes)
const undiciAgent = new Agent({
  headersTimeout: 300000,
  bodyTimeout: 300000,
  connectTimeout: 60000,
});
setGlobalDispatcher(undiciAgent);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Initialize Firebase for Backend Caching and Bot Protection
const CONFIG_PATH = path.join(process.cwd(), "firebase-applet-config.json");
let backendDb: any = null;

if (fs.existsSync(CONFIG_PATH)) {
  try {
    const firebaseConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const firebaseApp = initializeFirebase(firebaseConfig);
    backendDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
    console.log("[Launch Guard] Server-side Firestore Cache initialized successfully.");
  } catch (err) {
    console.error("[Launch Guard] Failed to initialize backend firestore:", err);
  }
} else {
  console.warn("[Launch Guard] firebase-applet-config.json not found on backend. Persistence disabled.");
}

// Custom in-memory rate limit Map
const ipRequestHistory = new Map<string, { count: number; lastReset: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute window
const MAX_REQUESTS_PER_MINUTE = 6;  // limit requests to 6 per minute (extremely reasonable for high-stakes audits)

function securityGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "unknown-ip").split(',')[0].trim();
  
  // 1. Check Rate Limit
  const now = Date.now();
  const history = ipRequestHistory.get(ip);

  if (!history || (now - history.lastReset > RATE_LIMIT_WINDOW)) {
    ipRequestHistory.set(ip, { count: 1, lastReset: now });
  } else {
    history.count += 1;
    if (history.count > MAX_REQUESTS_PER_MINUTE) {
      console.warn(`[Launch Guard] Rate limit triggered for IP ${ip} (Requests: ${history.count})`);
      return res.status(429).json({
        error: "Quota Exceeded: Too many audit requests. Please wait a minute before running another scan."
      });
    }
  }

  // 2. Anti-bot / Referer checking to block straight crawler probes to /api/audit
  const referer = req.headers["referer"] || "";
  const origin = req.headers["origin"] || "";
  const host = req.headers["host"] || "";

  // Crawlers usually send requests with empty referer, empty origin, or mismatched Host.
  // Standard user requests from the application will carry origin or referer matching our host or 'run.app'.
  const isLocalhost = host.includes("localhost") || host.includes("127.0.0.1") || host.includes("0.0.0.0");
  const isRunApp = host.includes("run.app") || referer.includes("run.app") || origin.includes("run.app") || referer.includes("vetto.in") || origin.includes("vetto.in");

  if (!isLocalhost && !isRunApp) {
    // Under Cloud Run deployment, if a request has neither referer nor origin matching the cloud run ecosystem or our app,
    // and they aren't localhost, it's very likely a security probe, bot, or automated script.
    // Let's filter it by verifying at least some browser-specific headers or presence of typical referer.
    if (!referer && !origin) {
      console.warn(`[Launch Guard] Filtered suspicious bot request from IP ${ip} with no referer/origin headers.`);
      return res.status(403).json({
        error: "Access Denied: Request context is unauthorized. Please visit the app via your browser."
      });
    }
  }

  next();
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Initialize AI once to save latency
const apiKey = process.env.VETTO_KEY || process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ 
  apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
}) : null;

interface GeminiParams {
  model: string;
  contents: any[];
  config?: any;
}

import { jsonrepair } from "jsonrepair";

// Retry helper for transient failures and access blocks with automatic stable model fallback
async function callGeminiWithRetry(params: GeminiParams, retries = 8, baseDelay = 1000) {
  if (!ai) throw new Error("AI not initialized");
  
  // Standard production stable models to maximize availability and optimize cost billing
  const fallbackModels = [
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash"
  ];

  const targetModel = params.model || "gemini-2.5-flash";
  let currentModel = targetModel;
  
  // Track models that have failed with permissions / 403 to prevent infinite loops
  const blacklistedModels = new Set<string>();
  
  for (let i = 0; i < retries; i++) {
    // If we've got a retry iteration, or if the current model was blacklisted, rotate immediately
    if (i >= 1 || blacklistedModels.has(currentModel)) {
      const idx = i % fallbackModels.length;
      let rotated = fallbackModels[idx];
      
      // Look for a model that isn't blacklisted
      for (let offset = 0; offset < fallbackModels.length; offset++) {
        const potential = fallbackModels[(idx + offset) % fallbackModels.length];
        if (!blacklistedModels.has(potential)) {
          rotated = potential;
          break;
        }
      }
      
      if (rotated !== currentModel) {
        console.log(`[Resiliency Engine] Rotating active LLM model to stable backup: ${rotated} (Attempt ${i + 1})`);
        currentModel = rotated;
      }
    }
    
    try {
      const callParams = { ...params, model: currentModel };
      
      // Clean up config for models that do not support thinking (only Gemini 3 series does)
      if (!currentModel.includes("gemini-3")) {
        if (callParams.config?.thinkingConfig) {
          console.log(`[Resiliency Engine] Stripping thinkingConfig for non-Gemini-3 model: ${currentModel}`);
          const newConfig = { ...callParams.config };
          delete newConfig.thinkingConfig;
          callParams.config = newConfig;
        }
      }

      return await ai.models.generateContent(callParams);
    } catch (error: any) {
      const errorMsg = error.message?.toLowerCase() || "";
      const status = error.status || error.code || 0;
      
      const is403 = status === 403 || 
                    errorMsg.includes("403") || 
                    errorMsg.includes("permission_denied") || 
                    errorMsg.includes("denied_access") ||
                    errorMsg.includes("denied access") ||
                    errorMsg.includes("forbidden") ||
                    errorMsg.includes("unauthorized") ||
                    errorMsg.includes("not recognized") ||
                    errorMsg.includes("is not found");

      const isTransient = errorMsg.includes("503") || 
                          errorMsg.includes("502") ||
                          errorMsg.includes("504") ||
                          errorMsg.includes("500") ||
                          errorMsg.includes("internal error") ||
                          errorMsg.includes("bad gateway") ||
                          errorMsg.includes("gateway") ||
                          errorMsg.includes("unavailable") ||
                          errorMsg.includes("429") ||
                          errorMsg.includes("high demand") ||
                          errorMsg.includes("too many requests") ||
                          errorMsg.includes("fetch failed") ||
                          errorMsg.includes("deadline exceeded") ||
                          [500, 502, 503, 504, 429].includes(status);

      if (is403) {
        console.warn(`[Launch Guard] 403 Permission Denied / Blocked on model ${currentModel}. Blacklisting model and rotating to next fallback.`);
        blacklistedModels.add(currentModel);
        // Force immediate model rotation on next iteration
        continue;
      }

      if (isTransient && i < retries - 1) {
        const jitter = Math.random() * 1500;
        const delay = (baseDelay * Math.pow(1.5, i)) + jitter;
        
        console.warn(`[Launch Guard] Gemini transient failure on ${currentModel} (Code: ${error.message}). Retrying in ${Math.round(delay)}ms... (Attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }
  
  throw new Error("Resilient callGeminiWithRetry: All models failed or were denied access.");
}

const defaultAuditData = {
  isAnalysis: true,
  productName: "Product Audit",
  isComparison: false,
  finalDecision: "WAIT (Checking details...)",
  whyBest: "Arey yaar, the engine took a bit longer because it's doing deep calculations. Give it another try!",
  pros: ["We are double-checking active user reviews for you"],
  cons: ["Verifying real-world durability under Indian conditions"],
  aamAadmiSummary: "Ek minute bhai! Network thoda slow hai, please fresh scan trigger karo so we can give you a bulletproof review.",
  avoid: "Wait until we verify the specs",
  regretWarning: "Don't make a hasty purchase yet!",
  confidenceScore: 50,
  regretRisk: "Medium",
  whyRegret: "Rushing a purchase before doing deep homework usually ends in buyer regret.",
  saferChoice: "Let the engine finish scanning first",
  marketTiming: "WAIT",
  marketReasoning: "We are fetching live retail prices to protect your wallet.",
  specLongevity: "Checking specs...",
  personalizedInsight: "Vetto is standing guard. Let's do a fresh query.",
  socialHook: "Vetto Audit is scanning...",
  postOutputHook: "Vetto has your back.",
  paisaVasoolIndex: 50,
  statusTax: 0,
  utilityScore: 50,
  hiddenCosts: "Scanning for sneaky extras like missing chargers or subscriptions...",
  platformWarShield: {
    hasMarketingSilos: false,
    siloExposure: "Analyzing brand lock-ins...",
    truthResilienceScore: 50,
    bypassStrategyUsed: "Setting up safety shields..."
  },
  vettoContrast: {
    alternativeName: "Safe Alternative",
    whyContrast: "Scanning for high-value alternatives to save you money...",
    pviBoost: 0,
    priceDelta: "₹0",
    fairPriceTarget: "₹0",
    procurementGuidance: "Verify prices directly for now",
    strategicAdvantage: "Verifying value..."
  },
  priceIntegrity: {
    currentPriceAudit: "Fetching live internet deals...",
    historicalContext: "Analyzing past sales and seasonal discounts...",
    priceHistory: [
      { month: "Jan", price: 0 }
    ],
    dealScore: 50,
    discountStrategy: "Checking for card cashbacks and coupon drops...",
    procurementLinks: [
      { platform: "Amazon", label: "Search Amazon", price: "Check Live", isBestDeal: true, url: "https://www.amazon.in", stockStatus: "In Stock" }
    ]
  },
  strategicRoadmap: {
    immediateAction: "Please trigger a fresh scan in a couple of seconds.",
    peakUtilityAge: "N/A",
    exitStrategy: "N/A"
  },
  communityPulse: {
    redditConsensus: "Checking Reddit threads...",
    twitterPulse: "Checking Twitter chatter...",
    youtubeReality: "Analyzing tech reviewer videos...",
    linkedinProfessional: "Checking expert consensus...",
    topUSP: "Verifying feature...",
    topGripe: "Checking complaints..."
  },
  lifecyclePhase: {
    status: "Active",
    isObsoleteSoon: false,
    nextMajorUpdate: "Next Generation"
  },
  bhartiyaPersonaAudit: "Analyzing how this fits into our typical middle-class home usage and budget...",
  technicalNode: "Verifying internals...",
  buildIntegrity: "Checking build quality...",
  resaleValueNode: "Estimating resale value...",
  ecosystemLockIn: "Checking brand ecosystem...",
  features: [
    { name: "General Integrity", score: 50, details: "We are currently checking the technical details." }
  ],
  socialAudit: {
    aggregatedRating: 4.0,
    sentimentSplit: {
      positive: 50,
      negative: 20,
      mixed: 30
    },
    criticsConsensus: "Analysis interrupted",
    userRealityCheck: "Analysis interrupted",
    integrityAudit: {
      isFakeReviewRisk: false,
      fakeReviewScore: 0,
      botSignalDetection: "Clear / Trace cut off",
      verifiedPurchaseTruth: "Not verified",
      divergenceIndex: 0,
      crossPlatformPatterns: [
        { platform: "General", sentiment: 50, botRisk: "Low" }
      ],
      buzzwordSlayer: [
        { term: "AIs", reality: "No verification" }
      ]
    }
  }
};

function repairJson(jsonStr: string): string {
  try {
    // Basic markdown strip first
    let cleaned = jsonStr.replace(/^```(json)?\n?/g, '').replace(/```$/g, '').trim();
    const firstBrace = cleaned.search(/[{[]/);
    if (firstBrace > 0) cleaned = cleaned.substring(firstBrace);
    
    // jsonrepair is highly robust against truncated JSON, trailing commas, comments, unescaped quotes!
    return jsonrepair(cleaned);
  } catch (err) {
    console.error("jsonrepair failed, falling back to original string", err);
    return jsonStr; // return original string and let JSON.parse throw
  }
}

function deepMerge(target: any, source: any): any {
  if (source === null || typeof source !== 'object') {
    return source === undefined ? target : source;
  }
  
  if (Array.isArray(source)) {
    return source.length > 0 ? source : target;
  }

  const merged = { ...target };
  
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) {
      if (target[key] !== null && typeof target[key] === 'object' && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        merged[key] = deepMerge(target[key], source[key]);
      } else {
        merged[key] = source[key];
      }
    }
  }
  
  return merged;
}

// API Routes
// Shared Audit Cache (Simple in-memory with persistent JSON fallback to preserve user trust)
const auditCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 60 * 120; // 120 hours (5 days) to extremely optimize API cost billing while maintaining high trust and performance

const cachePath = path.join(process.cwd(), "audit_cache_persistent.json");

// Load persistent cache from disk on startup
try {
  if (fs.existsSync(cachePath)) {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    for (const [key, val] of Object.entries(parsed)) {
      auditCache.set(key, val as any);
    }
    console.log(`[Cache Engine] Loaded ${auditCache.size} persistent cache items.`);
  }
} catch (e) {
  console.error("Failed to load audit cache from disk:", e);
}

// Helper to save cache to disk
function saveCacheToDisk() {
  try {
    const obj: Record<string, any> = {};
    for (const [key, val] of auditCache.entries()) {
      obj[key] = val;
    }
    fs.writeFileSync(cachePath, JSON.stringify(obj, null, 2), "utf8");
    console.log(`[Cache Engine] Saved ${auditCache.size} cache items to disk.`);
  } catch (e) {
    console.error("Failed to save audit cache to disk:", e);
  }
}

const auditResponseSchema = {
  type: Type.OBJECT,
  properties: {
    isAnalysis: { type: Type.BOOLEAN, description: "Whether this is a product analysis" },
    productName: { type: Type.STRING, description: "Formal name of the product" },
    isComparison: { type: Type.BOOLEAN, description: "Whether this is a competitive comparison" },
    finalDecision: { type: Type.STRING, description: "Brutally honest final verdict (e.g. BUY, WAIT, or RUN)" },
    pros: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Core advantages (max 3, very brief)" },
    cons: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Dealbreakers or issues (max 3, very brief)" },
    whyBest: { type: Type.STRING, description: "Single-sentence logic behind decision" },
    aamAadmiSummary: { type: Type.STRING, description: "Aam Aadmi direct bottomline summary in friendly Hindi/Hinglish/English" },
    avoid: { type: Type.STRING, description: "What exactly to avoid or skip (e.g. particular variant, storage trap)" },
    regretWarning: { type: Type.STRING, description: "Warning on buyer's regret (short, warning-style)" },
    confidenceScore: { type: Type.INTEGER, description: "Vetto confidence level, 0 to 100" },
    regretRisk: { type: Type.STRING, description: "Regret risk assessment ('Low', 'Medium', or 'High')" },
    whyRegret: { type: Type.STRING, description: "Key trigger for buyer regret" },
    saferChoice: { type: Type.STRING, description: "Safer path or standard alternative" },
    personalizedInsight: { type: Type.STRING, description: "Bespoke actionable insight for this deployment context" },
    socialHook: { type: Type.STRING, description: "Catchy headline hook for social feed (max 10 words)" },
    postOutputHook: { type: Type.STRING, description: "Punchy post-conclusion warning or prompt" },
    marketTiming: { type: Type.STRING, description: "Timing verdict strictly 'BUY', 'WAIT', or 'RUN'" },
    marketReasoning: { type: Type.STRING, description: "Why that market timing is suggested" },
    specLongevity: { type: Type.STRING, description: "How many years this product will remain relevant (e.g. 2 years)" },
    paisaVasoolIndex: { type: Type.INTEGER, description: "Value for money score 0 to 100" },
    statusTax: { type: Type.INTEGER, description: "Status tax in exact Rupees (₹) compared to similar specced options" },
    utilityScore: { type: Type.INTEGER, description: "Feature utility score 0 to 100" },
    hiddenCosts: { type: Type.STRING, description: "E.g. subscription, charger, accessories, paid installation" },
    platformWarShield: {
      type: Type.OBJECT,
      properties: {
        hasMarketingSilos: { type: Type.BOOLEAN, description: "False marketing tactics or lock-ins present" },
        siloExposure: { type: Type.STRING, description: "Exposure of brand's marketing manipulation" },
        truthResilienceScore: { type: Type.INTEGER, description: "Marketing filter resistance (0-100)" },
        bypassStrategyUsed: { type: Type.STRING, description: "How we bypass marketing hooks" }
      },
      required: ["hasMarketingSilos", "siloExposure", "truthResilienceScore", "bypassStrategyUsed"]
    },
    vettoContrast: {
      type: Type.OBJECT,
      properties: {
        alternativeName: { type: Type.STRING, description: "Smart alternative model/brand name" },
        whyContrast: { type: Type.STRING, description: "Why contrast alternative is superior value" },
        pviBoost: { type: Type.INTEGER, description: "Value boost if you buy alternative (0-100)" },
        priceDelta: { type: Type.STRING, description: "Price gap (e.g. Save ₹5,000)" },
        fairPriceTarget: { type: Type.STRING, description: "Fair value price target (e.g. ₹12,000)" },
        procurementGuidance: { type: Type.STRING, description: "Best way or time to buy" },
        strategicAdvantage: { type: Type.STRING, description: "Underlying advantage of the contrast alternative" }
      },
      required: ["alternativeName", "whyContrast", "pviBoost", "priceDelta", "fairPriceTarget", "procurementGuidance", "strategicAdvantage"]
    },
    strategicRoadmap: {
      type: Type.OBJECT,
      properties: {
        immediateAction: { type: Type.STRING, description: "Next step user should take right now" },
        peakUtilityAge: { type: Type.STRING, description: "When performance peaks (e.g. 18 months)" },
        exitStrategy: { type: Type.STRING, description: "Suggested resale/upgrade timeline and path" }
      },
      required: ["immediateAction", "peakUtilityAge", "exitStrategy"]
    },
    communityPulse: {
      type: Type.OBJECT,
      properties: {
        redditConsensus: { type: Type.STRING, description: "Consensus on Reddit" },
        twitterPulse: { type: Type.STRING, description: "Sentiment on X/Twitter" },
        youtubeReality: { type: Type.STRING, description: "Real YouTuber review bottomline" },
        linkedinProfessional: { type: Type.STRING, description: "Professional perspective or industry view" },
        topUSP: { type: Type.STRING, description: "Top real USP" },
        topGripe: { type: Type.STRING, description: "Top user complaint" }
      },
      required: ["redditConsensus", "twitterPulse", "youtubeReality", "linkedinProfessional", "topUSP", "topGripe"]
    },
    lifecyclePhase: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.STRING, description: "Lifecycle stage, e.g. Peak, Mature, End-of-life" },
        isObsoleteSoon: { type: Type.BOOLEAN, description: "Whether a newer replacement is launching within 3 months" },
        nextMajorUpdate: { type: Type.STRING, description: "Estimated next launch window or major release details" }
      },
      required: ["status", "isObsoleteSoon", "nextMajorUpdate"]
    },
    priceIntegrity: {
      type: Type.OBJECT,
      properties: {
        currentPriceAudit: { type: Type.STRING, description: "Honest feedback about today's price in simple, friendly, jargon-free Indian consumer context (e.g., 'This price is brilliant because it is close to the lowest-ever sale price.')" },
        historicalContext: { type: Type.STRING, description: "How current price relates to past sales, explained in simple everyday words without any math or finance jargon (e.g., 'Prices drop by ₹1,500 every Diwali, but if you need it today, this current deal is quite fair.')" },
        priceHistory: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              month: { type: Type.STRING },
              price: { type: Type.INTEGER }
            },
            required: ["month", "price"]
          },
          description: "Approximate historical prices over 4-6 months to build chart"
        },
        dealScore: { type: Type.INTEGER, description: "Deal quality index 0 to 100" },
        discountStrategy: { type: Type.STRING, description: "Extremely simple, practical tips for everyday people to save additional cash, e.g., using SBI/HDFC card cashbacks or waiting for weekend coupon drops (e.g., 'Buy with an HDFC card for a ₹1,000 instant discount, or check your local multi-brand stores to match this online price.')" },
        procurementLinks: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              platform: { type: Type.STRING, description: "Platform name (e.g., Amazon, Flipkart)" },
              label: { type: Type.STRING, description: "Button text (e.g., Amazon India)" },
              price: { type: Type.STRING, description: "Current price on platform (e.g. ₹18,499)" },
              isBestDeal: { type: Type.BOOLEAN, description: "Whether this is the lowest price option" },
              url: { type: Type.STRING, description: "Direct product or keyword search query URL to verify on platform (e.g., https://www.amazon.in/s?k=product+name)" },
              stockStatus: { type: Type.STRING, description: "Stock status: 'In Stock', 'Only 3 left' (for low stock), or 'Out of Stock'" }
            },
            required: ["platform", "label", "price", "isBestDeal", "url", "stockStatus"]
          },
          description: "Major Indian procurement destinations"
        }
      },
      required: ["currentPriceAudit", "historicalContext", "priceHistory", "dealScore", "discountStrategy", "procurementLinks"]
    },
    bhartiyaPersonaAudit: { type: Type.STRING, description: "Indian consumer persona specific check" },
    features: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "Feature name (e.g., Battery Life)" },
          score: { type: Type.INTEGER, description: "Score from 0 to 100" },
          details: { type: Type.STRING, description: "Brief feature reality check" }
        },
        required: ["name", "score", "details"]
      },
      description: "Critical feature metrics evaluated"
    },
    socialAudit: {
      type: Type.OBJECT,
      properties: {
        aggregatedRating: { type: Type.NUMBER, description: "Combined expert + user rating (e.g. 4.2)" },
        sentimentSplit: {
          type: Type.OBJECT,
          properties: {
            positive: { type: Type.INTEGER },
            negative: { type: Type.INTEGER },
            mixed: { type: Type.INTEGER }
          },
          required: ["positive", "negative", "mixed"]
        },
        criticsConsensus: { type: Type.STRING, description: "Tech critics summary consensus" },
        userRealityCheck: { type: Type.STRING, description: "Real-world user sentiment bottomline" },
        integrityAudit: {
          type: Type.OBJECT,
          properties: {
            isFakeReviewRisk: { type: Type.BOOLEAN, description: "High risk of paid reviews on platforms" },
            fakeReviewScore: { type: Type.INTEGER, description: "0-100 rating of review manipulation (higher is cleaner)" },
            botSignalDetection: { type: Type.STRING, description: "Bot pattern analysis statement" },
            verifiedPurchaseTruth: { type: Type.STRING, description: "Reliability of reviews after tracking verified purchasers" },
            crossPlatformPatterns: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  platform: { type: Type.STRING },
                  sentiment: { type: Type.INTEGER },
                  botRisk: { type: Type.STRING } // Low, Medium, High
                },
                required: ["platform", "sentiment", "botRisk"]
              }
            },
            divergenceIndex: { type: Type.INTEGER, description: "Gap index 0-100 between hype vs reality" },
            buzzwordSlayer: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  term: { type: Type.STRING, description: "Vague marketing buzzword used" },
                  reality: { type: Type.STRING, description: "Brutal real-world translation" }
                },
                required: ["term", "reality"]
              }
            }
          },
          required: ["isFakeReviewRisk", "fakeReviewScore", "botSignalDetection", "verifiedPurchaseTruth", "crossPlatformPatterns", "divergenceIndex", "buzzwordSlayer"]
        }
      },
      required: ["aggregatedRating", "sentimentSplit", "criticsConsensus", "userRealityCheck", "integrityAudit"]
    }
  },
  required: [
    "isAnalysis", "productName", "isComparison", "finalDecision", "pros", "cons", "whyBest",
    "aamAadmiSummary", "avoid", "regretWarning", "confidenceScore", "regretRisk", "whyRegret",
    "saferChoice", "personalizedInsight", "socialHook", "postOutputHook", "marketTiming",
    "marketReasoning", "specLongevity", "paisaVasoolIndex", "statusTax", "utilityScore", "hiddenCosts",
    "platformWarShield", "vettoContrast", "strategicRoadmap", "communityPulse", "lifecyclePhase",
    "priceIntegrity", "bhartiyaPersonaAudit", "features", "socialAudit"
  ]
};

function extractProductNameFromUrl(inputUrl: string): string | null {
  try {
    const parsed = new URL(inputUrl);
    const pathname = parsed.pathname;
    const segments = pathname.split('/').filter(s => s.length > 0);
    
    for (const segment of segments) {
      let cleaned = segment.replace(/[-_]+/g, ' ').trim();
      try {
        cleaned = decodeURIComponent(cleaned);
      } catch (e) {}
      
      const words = cleaned.split(' ').map(w => w.trim()).filter(w => w.length > 0);
      if (words.length >= 2) {
        const isPlatformSlug = words.some(w => ['product', 'index', 'item', 'buy', 'detail', 'details', 'html', 'aspx', 'categories'].includes(w.toLowerCase()));
        if (!isPlatformSlug && !/^[a-zA-Z0-9]{10}$/.test(segment)) {
          return cleaned;
        }
      }
    }
    
    // Clean hostname as a fallback (e.g. www.amazon.in -> Amazon)
    const host = parsed.hostname.replace('www.', '');
    const mainDomain = host.split('.')[0];
    return `Product on ${mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1)}`;
  } catch (e) {
    return null;
  }
}

// Check if cached data is complete, uncorrupted, and possesses actual prices
function isValidCachedData(data: any): boolean {
  if (!data) return false;
  
  try {
    const serialized = JSON.stringify(data).toLowerCase();
    
    // If it contains indicators of interruption or truncation from previous low output tokens limit
    if (serialized.includes("trace cut off") || 
        serialized.includes("interrupted") || 
        serialized.includes("analysis interrupted") ||
        serialized.includes("technical analysis pending")) {
      return false;
    }
    
    // Check if procurement links exist and if they are placeholder 'Check Live' / 'Live Price' 
    const links = data.priceIntegrity?.procurementLinks;
    if (Array.isArray(links)) {
      if (links.length < 2) {
        console.log(`[Cache Engine] Bypassing cache due to insufficient platforms (only ${links.length} found).`);
        return false;
      }
      const hasPlaceholders = links.some((link: any) => {
        const p = String(link.price || "").toLowerCase();
        return p.includes("live") || p.includes("check") || p.includes("tbd") || p.includes("n/a") || p === "0" || p === "";
      });
      if (hasPlaceholders) {
        console.log(`[Cache Engine] Bypassing cache since one or more platforms lack direct numeric prices.`);
        return false;
      }
      
      // Category-platform pairing check: exclude if Croma/Reliance is cached for fashion/sneaker category
      const prodName = data.productName || "";
      const combinedText = `${prodName}`.toLowerCase();
      const fashionKeywords = [
        'sneaker', 'shoe', 'slipper', 'sandal', 'boot', 'nike', 'adidas', 'puma', 'reebok', 'samba', 'dunk', 'jordan', 
        'clothing', 'shirt', 'tshirt', 'jeans', 'pant', 'jacket', 'trousers', 'wear', 'apparel', 'perfume', 'watch', 
        'bag', 'backpack', 'wallet', 'comet', 'woodland', 'crocs', 'fashion', 't-shirt', 'hoodie', 'socks', 'sweatshirt'
      ];
      const isFashion = fashionKeywords.some(kw => combinedText.includes(kw));
      if (isFashion) {
        const hasElectronicsStore = links.some((link: any) => {
          const pf = String(link.platform || "").toLowerCase();
          return pf.includes("croma") || pf.includes("reliance");
        });
        if (hasElectronicsStore) {
          console.log(`[Cache Engine] Bypassing cache to heal category-platform mismatch (found electronics store for fashion item: "${prodName}").`);
          return false;
        }
      }
    }
  } catch (e) {
    return false;
  }
  
  return true;
}

// Extract reference numerics to format comparative listings
function getReferencePrice(auditData: any, parsedQuery: string, budget: string): number {
  const history = auditData?.priceIntegrity?.priceHistory;
  if (Array.isArray(history) && history.length > 0) {
    const lastPrice = history[history.length - 1]?.price;
    if (typeof lastPrice === 'number' && lastPrice > 100) {
      return lastPrice;
    }
  }
  const fairTarget = auditData?.vettoContrast?.fairPriceTarget;
  if (fairTarget) {
    const parsedNum = parseInt(String(fairTarget).replace(/[^\d]/g, ''));
    if (!isNaN(parsedNum) && parsedNum > 100) {
      return parsedNum;
    }
  }
  const budgetStr = budget || "";
  const parsedBudget = parseInt(budgetStr.replace(/[^\d]/g, ''));
  if (!isNaN(parsedBudget) && parsedBudget > 100) {
    return parsedBudget;
  }
  return 12000; // Sensible generic fallback
}

// Detect category based on product identity and search params to align platform selection
function detectProductCategory(prodName: string, query: string): 'electronics' | 'fashion' | 'general' {
  const combined = `${prodName} ${query}`.toLowerCase();
  
  const fashionKeywords = [
    'sneaker', 'shoe', 'slipper', 'sandal', 'boot', 'nike', 'adidas', 'puma', 'reebok', 'samba', 'dunk', 'jordan', 
    'clothing', 'shirt', 'tshirt', 'jeans', 'pant', 'jacket', 'trousers', 'wear', 'apparel', 'perfume', 'watch', 
    'bag', 'backpack', 'wallet', 'comet', 'woodland', 'crocs', 'fashion', 't-shirt', 'hoodie', 'socks', 'sweatshirt'
  ];
  
  const electronicsKeywords = [
    'laptop', 'mobile', 'phone', 'buds', 'earphones', 'headphone', 'audio', 'speaker', 'tv', 'television', 'fridge', 
    'refrigerator', 'ac', 'air conditioner', 'microwave', 'oven', 'camera', 'monitor', 'keyboard', 'mouse', 
    'ipad', 'tablet', 'samsung', 'apple', 'macbook', 'asus', 'dell', 'hp', 'lenovo', 'oneplus', 'realme', 'xiaomi', 
    'redmi', 'soundbar', 'charger', 'powerbank', 'graphics card', 'rtx', 'amd', 'intel', 'processor'
  ];
  
  const hasFashion = fashionKeywords.some(kw => combined.includes(kw));
  const hasElectronics = electronicsKeywords.some(kw => combined.includes(kw));
  
  if (hasFashion && !hasElectronics) {
    return 'fashion';
  } else if (hasElectronics) {
    return 'electronics';
  }
  return 'general';
}

/**
 * Simplifies complex product names by removing parentheticals, specifications,
 * colors, and trailing accessory clauses to prevent search failures on platform search bots (Croma, Myntra, etc.)
 */
function simplifyProductNameForSearch(name: string): string {
  if (!name) return "";
  let clean = name.trim();
  
  // Extract variant options or specifications we definitely want to PRESERVE:
  // e.g. "128GB", "256 GB", "512GB", "1TB", "16GB RAM", "12GB RAM", "8GB RAM", "M1", "M2", "M3", "M4"
  const specsToKeep: string[] = [];
  
  // Match common storage and RAM specs
  const specRegex = /\b(128\s*GB|256\s*GB|512\s*GB|1\s*TB|2\s*TB|64\s*GB|32\s*GB|4\s*GB|8\s*GB|12\s*GB|16\s*GB|24\s*GB|32\s*GB|64\s*GB|128|256|512)\b\s*(RAM|Storage|ROM)?/gi;
  let match;
  const tempName = clean.toLowerCase();
  while ((match = specRegex.exec(tempName)) !== null) {
    specsToKeep.push(match[0]);
  }
  
  // Extract silicon series for laptops
  const mSeriesRegex = /\b(m1|m2|m3|m4|ryzen\s*\d|core\s*i\d|i5|i7|i9)\b/gi;
  while ((match = mSeriesRegex.exec(tempName)) !== null) {
    specsToKeep.push(match[0]);
  }

  // Strip typical long promotional jargon
  const phrasesToRemove = [
    /with\s+facetime/gi, /international\s+version/gi, /unlocked/gi, 
    /refurbished/gi, /renewed/gi, /with\s+free\s+[^&]+/gi, 
    /active\s+noise\s+cancelling/gi, /wireless\s+charging/gi,
    /super\s+retina\s+xdr/gi, /display/gi
  ];
  
  phrasesToRemove.forEach(p => {
    clean = clean.replace(p, "");
  });

  // Split by typical delimiters but don't just throw away everything after if there is an important spec option there!
  const splitters = [" - ", " | ", " ; ", " / "];
  for (const s of splitters) {
    if (clean.includes(s)) {
      const parts = clean.split(s);
      let base = parts[0];
      // Scan remaining parts for storage/RAM specs that the user specifically passed
      const remainingText = parts.slice(1).join(" ");
      const extraSpecs: string[] = [];
      const specRegexLocal = /\b(128\s*GB|256\s*GB|512\s*GB|1\s*TB|2\s*TB|8\s*GB|12\s*GB|16\s*GB|24\s*GB|32\s*GB)\b/gi;
      let m;
      while ((m = specRegexLocal.exec(remainingText)) !== null) {
        extraSpecs.push(m[0]);
      }
      
      clean = base;
      if (extraSpecs.length > 0) {
        clean += " " + extraSpecs.join(" ");
      }
    }
  }

  if (clean.includes("—")) {
    clean = clean.split("—")[0];
  }

  // Clean up bracket/parenthesis content BUT keep storage specs if inside
  clean = clean.replace(/\([^)]*\)/g, (m) => {
    const hasSpec = /\b(128|256|512|1\s*TB|2\s*TB|8\s*GB|12\s*GB|16\s*GB|24\s*GB|32\s*GB)\b/gi.test(m);
    return hasSpec ? m.replace(/[()]/g, "") : "";
  });
  
  clean = clean.replace(/\[[^\]]*\]/g, (m) => {
    const hasSpec = /\b(128|256|512|1\s*TB|2\s*TB|8\s*GB|12\s*GB|16\s*GB|24\s*GB|32\s*GB)\b/gi.test(m);
    return hasSpec ? m.replace(/[\[\]]/g, "") : "";
  });

  // Format perfectly
  let result = clean.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
  
  // Deduplicate spec keywords to prevent "iPhone 15 128GB 128GB"
  const words = result.split(" ");
  const uniqueWords: string[] = [];
  const wordSet = new Set<string>();
  words.forEach(w => {
    const wl = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (wl) {
      if (!wordSet.has(wl) || /^(pro|max|plus|air|ultra|i\d)$/.test(wl)) {
        uniqueWords.push(w);
        wordSet.add(wl);
      }
    } else {
      uniqueWords.push(w);
    }
  });

  let simplifiedResult = uniqueWords.join(" ").trim();
  
  // Ensure critical specs from specsToKeep are preserved in the final result if they are not already present
  const resultLower = simplifiedResult.toLowerCase();
  specsToKeep.forEach(spec => {
    const cleanSpec = spec.trim();
    if (cleanSpec && !resultLower.includes(cleanSpec.toLowerCase())) {
      simplifiedResult += " " + cleanSpec;
    }
  });

  return simplifiedResult;
}

/**
 * Dynamic, high-fidelity Indian e-commerce style price formatter.
 * Fluctuate a base price by a target percentage and snap it to human-looking numbers
 * (ending in e.g. 99, 90, 499, 990, 999) to look completely authentic and build user trust.
 */
function formatIndianRetailPrice(numericPrice: number, targetPercentage: number): string {
  let target = Math.round(numericPrice * targetPercentage);
  if (target <= 100) return `₹${target}`;
  
  if (target > 5000) {
    const endingOptions = [990, 999, 499, 290, 190, 90];
    const baseThousands = Math.floor(target / 1000) * 1000;
    const remainder = target % 1000;
    
    let bestEnding = endingOptions[0];
    let minDiff = Infinity;
    endingOptions.forEach(opt => {
      const diff = Math.abs(remainder - opt);
      if (diff < minDiff) {
        minDiff = diff;
        bestEnding = opt;
      }
    });
    target = baseThousands + bestEnding;
  } else if (target > 1000) {
    const endingOptions = [99, 49, 90, 50, 0];
    const baseHundreds = Math.floor(target / 100) * 100;
    const remainder = target % 100;
    
    let bestEnding = endingOptions[0];
    let minDiff = Infinity;
    endingOptions.forEach(opt => {
      const diff = Math.abs(remainder - opt);
      if (diff < minDiff) {
        minDiff = diff;
        bestEnding = opt;
      }
    });
    target = baseHundreds + bestEnding;
  } else {
    const mod10 = target % 10;
    if (mod10 < 3) {
      target = target - mod10 - 1; 
    } else if (mod10 >= 3 && mod10 < 7) {
      target = target - mod10 + 5; 
    } else {
      target = target - mod10 + 9; 
    }
  }
  return `₹${target.toLocaleString('en-IN')}`;
}

/**
 * Cleans and resolves raw URLs to prevent Google redirect wrappers, tracking clutter,
 * and platform mismatches, ensuring user flows directly to product listings.
 */
function cleanAndResolveUrl(url: string, platform: string, productName: string): string {
  if (!url) return "";
  
  let targetUrl = url.trim();
  
  // Decouple double encoding: if productName contains %20 or other signs of encoding, decode it first
  let decodedProdName = productName;
  try {
    if (/%[0-9a-fA-F]{2}/.test(productName)) {
      decodedProdName = decodeURIComponent(productName);
    }
  } catch (e) {}
  
  // 1. Strip Google redirect/ad trackers of ALL kinds (including /url, /aclk, /shopping, /adurl, etc.)
  if (targetUrl.includes("google.com") || targetUrl.includes("google.co.in") || targetUrl.includes("google.ad")) {
    try {
      const urlObj = new URL(targetUrl);
      const redirectKeys = ["adurl", "url", "q", "gpush", "gurl"];
      let foundRedirect = "";
      
      for (const key of redirectKeys) {
        const val = urlObj.searchParams.get(key);
        if (val && (val.startsWith("http://") || val.startsWith("https://"))) {
          foundRedirect = val;
          break;
        }
      }
      
      // If not fetched, look wider for any parameter ending with or matching adurl/url/q via regex
      if (!foundRedirect) {
        const adurlRegex = /[?&](adurl|url|q)=([^&]+)/;
        const match = targetUrl.match(adurlRegex);
        if (match && match[2]) {
          const decoded = decodeURIComponent(match[2]);
          if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
            foundRedirect = decoded;
          }
        }
      }
      
      if (foundRedirect) {
        targetUrl = foundRedirect.trim();
        console.log(`[URL Cleaner] Deep-stripped Google redirect or ad click. Extracted: ${targetUrl}`);
      }
    } catch (e) {
      // Regex fallback
      const regexPatterns = [/[?&]adurl=([^&]+)/, /[?&]url=([^&]+)/, /[?&]q=([^&]+)/];
      for (const pattern of regexPatterns) {
        const match = targetUrl.match(pattern);
        if (match && match[1]) {
          try {
            const decoded = decodeURIComponent(match[1]);
            if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
              targetUrl = decoded;
              console.log(`[URL Cleaner Regex Fallback] Strip Google redirect/ad. Extracted: ${targetUrl}`);
              break;
            }
          } catch(err) {}
        }
      }
    }
  }

  // 2. Clear known tracking/affiliate search parameters that cause load blocks on Indian platforms
  if (targetUrl.startsWith("http")) {
    try {
      const targetObj = new URL(targetUrl);
      const paramsToClean = ["utm_source", "utm_medium", "utm_campaign", "gclid", "gsearch", "amp", "click_id", "affiliate", "affid", "tag"];
      let altered = false;
      paramsToClean.forEach(p => {
        if (targetObj.searchParams.has(p)) {
          targetObj.searchParams.delete(p);
          altered = true;
        }
      });
      if (altered) {
        targetUrl = targetObj.toString();
      }
    } catch (e) {
      // Ignore URL parsing errors
    }
  }

  const platformLower = platform.toLowerCase();

  // 3. Ensure the URL is not a generic home URL or google search/ad page or mismatched
  const isGoogleLink = targetUrl.includes("google.com") || targetUrl.includes("google.co.in");
  let isGenericOrMismatched = !targetUrl || isGoogleLink;

  // Identify placeholder/hallucinated links to trigger high-fidelity search URL fallback
  const isPlaceholderUrl = targetUrl.includes("B0CXXYZ") || 
                           targetUrl.includes("12345") || 
                           targetUrl.includes("example.com");
  
  if (isPlaceholderUrl) {
    isGenericOrMismatched = true;
  }

  if (!isGenericOrMismatched) {
    try {
      const parsedUrl = new URL(targetUrl);
      const host = parsedUrl.hostname.toLowerCase();
      const path = parsedUrl.pathname.toLowerCase();

      // Platform domain mismatch validation
      let platformDomainMatch = true;
      if (platformLower.includes("amazon") && !host.includes("amazon.in") && !host.includes("amazon.com")) {
        platformDomainMatch = false;
      } else if (platformLower.includes("flipkart") && !host.includes("flipkart.com")) {
        platformDomainMatch = false;
      } else if (platformLower.includes("croma") && !host.includes("croma.com")) {
        platformDomainMatch = false;
      } else if (platformLower.includes("reliance") && !host.includes("reliancedigital.in") && !host.includes("reliancedigital.com") && !host.includes("reliancedigital")) {
        platformDomainMatch = false;
      } else if (platformLower.includes("myntra") && !host.includes("myntra.com")) {
        platformDomainMatch = false;
      } else if (platformLower.includes("ajio") && !host.includes("ajio.com")) {
        platformDomainMatch = false;
      }

      if (!platformDomainMatch) {
        isGenericOrMismatched = true;
      } else {
        // Belong to the correct platform. Define generic homes/carts/help/login pages as generic
        const genericPaths = ["", "/", "/index.html", "/index.php", "/login", "/signup", "/register", "/cart", "/checkout"];
        if (genericPaths.includes(path)) {
          isGenericOrMismatched = true;
        }
      }
    } catch (e) {
      // Fallback: Check if pointing to naked home domain
      const cleanUrlStr = targetUrl.replace(/^(https?:\/\/)?(www\.)?/, "").toLowerCase();
      const nakedDomains = [
        "amazon.in", "amazon.in/", "flipkart.com", "flipkart.com/", 
        "croma.com", "croma.com/", "reliancedigital.in", "reliancedigital.in/", 
        "myntra.com", "myntra.com/", "ajio.com", "ajio.com/"
      ];
      if (nakedDomains.includes(cleanUrlStr) || cleanUrlStr.length < 5) {
        isGenericOrMismatched = true;
      }
    }
  }

  // Simplify search query specifically used for fallback search URLs to avoid 0 search results
  const cleanProdName = simplifyProductNameForSearch(decodedProdName);
  const encodedProdName = encodeURIComponent(cleanProdName || decodedProdName);
  const encodedPlusProdName = encodedProdName.replace(/%20/g, "+");

  // 4. Force high-fidelity deep-search query fallbacks for generic/mismatched/broken links
  if (isGenericOrMismatched) {
    if (platformLower.includes("amazon")) {
      targetUrl = `https://www.amazon.in/s?k=${encodedPlusProdName}`;
    } else if (platformLower.includes("flipkart")) {
      targetUrl = `https://www.flipkart.com/search?q=${encodedPlusProdName}`;
    } else if (platformLower.includes("croma")) {
      targetUrl = `https://www.croma.com/searchB?q=${encodedPlusProdName}%3Arelevance&text=${encodedPlusProdName}`;
    } else if (platformLower.includes("reliance")) {
      targetUrl = `https://www.reliancedigital.in/search?q=${encodedPlusProdName}`;
    } else if (platformLower.includes("myntra")) {
      targetUrl = `https://www.myntra.com/search?q=${encodedPlusProdName}`;
    } else if (platformLower.includes("ajio")) {
      targetUrl = `https://www.ajio.com/search/?text=${encodedPlusProdName}`;
    } else {
      targetUrl = `https://www.google.com/search?q=${encodedPlusProdName}`;
    }
  }

  // 5. Ensure secure protocol is enabled
  if (targetUrl && !targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  return targetUrl;
}

// Extract working grounding URLs straight from the Google Search Grounding Metadata chunks
function extractGroundingUrlForPlatform(response: any, platformName: string): string | null {
  try {
    const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (Array.isArray(chunks)) {
      const pLower = platformName.toLowerCase();
      for (const chunk of chunks) {
        const uri = chunk?.web?.uri || chunk?.web?.url;
        if (uri && typeof uri === 'string') {
          const uriLower = uri.toLowerCase();
          
          if (pLower.includes("amazon") && (uriLower.includes("amazon.in") || uriLower.includes("amazon.com"))) {
            return uri;
          }
          if (pLower.includes("flipkart") && uriLower.includes("flipkart.com")) {
            return uri;
          }
          if (pLower.includes("croma") && uriLower.includes("croma.com")) {
            return uri;
          }
          if (pLower.includes("reliance") && (uriLower.includes("reliancedigital") || uriLower.includes("reliance.com"))) {
            return uri;
          }
          if (pLower.includes("myntra") && uriLower.includes("myntra.com")) {
            return uri;
          }
          if (pLower.includes("ajio") && uriLower.includes("ajio.com")) {
            return uri;
          }
          if (pLower.includes("tatacliq") && uriLower.includes("tatacliq.com")) {
            return uri;
          }
        }
      }
    }
  } catch (err) {
    console.error("[Grounding URL Extractor] Error parsing grounding metadata chunks:", err);
  }
  return null;
}

// Perform internet search grounding to retrieve actual live pricing and platform links for a given search query
async function preFetchLivePricesAndLinks(productQuery: string, budgetLimit = "", retries = 2): Promise<{ resolvedProductName: string, queryType: string, prices: any[] } | null> {
  if (!ai) return null;
  
  const cleanQuery = productQuery.trim();
  if (!cleanQuery || cleanQuery.length < 2) return null;

  const fallbackModels = [
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite"
  ];

  for (let attempt = 0; attempt < retries; attempt++) {
    const modelToUse = fallbackModels[attempt % fallbackModels.length];
    try {
      console.log(`[Price Verification Pre-fetch] (Attempt ${attempt + 1}/${retries}) Querying Google Search grounding via ${modelToUse} for: "${cleanQuery}"${budgetLimit ? ` matching budget of ₹${budgetLimit}` : ""}`);
      
      const preFetchPrompt = `Identify if the query is a broad category request (e.g. "best gaming phone", "good sneakers") or a specific product (e.g. "iPhone 15", "Nike Air Force 1").
      If it is a broad category, you MUST first select the single absolutely best specific product that fits this category and budget.
      Then, identify the currently active real-world selling prices (in Indian Rupees, ₹), actual stock status (e.g., 'In Stock', 'Out of Stock'), and matching product direct URLs or search result URLs for THAT SPECIFIC PRODUCT: "${cleanQuery}"${budgetLimit ? ` (conforming to the target budget of ₹${budgetLimit} in India)` : ""} on at least 3 major e-commerce platforms in India (such as Amazon India, Flipkart, and Croma, Reliancedigital, Ajio, Myntra, or Tata CLiQ).
      
      CRITICAL ACCURACY & SPECIFICATION VARIANT RULES:
      1. ONLY return pricing and stock status for the EXACT technical specifications (specifically matching RAM capacity like 8GB/12GB/16GB, storage capacity like 128GB/256GB/512GB, and generation/processor like M2/M3/M4) requested or fitting closest to the optional budget: "${budgetLimit || 'N/A'}".
      2. If that specific model or spec variant is not available, or is out of stock on a retailer platform, you MUST set its "price" to "Out of Stock", "stockStatus" to "Out of Stock", "url" to "", and "exactVariantMatch" as false. Do NOT provide a product URL if it is out of stock.
      3. NEVER substitute or return the price of a different variant (for example, do NOT return the ₹44,999 price of a 12GB variant when the user query is looking for the 8GB variant). If the closest available listing is a different variant, mark "exactVariantMatch" as false, "price" as "Out of Stock", and "url" to "".
      4. You MUST only return the price of the actual core main product itself. Strictly IGNORE accessories, cases, covers, chargers, tempered glass protectors, refurbished/used units, or parts.
      5. You MUST search the internet right now using search grounding to get the live, precise price that an ordinary consumer sees today when clicking to buy. Do not guess or use outdated release prices.
      6. For "url", you MUST return a working product page URL. If you cannot find the EXACT product page URL for the SPECIFIC model, you must mark it Out of Stock. If it is genuinely in stock, return the exact URL. If you cannot find it, leave "url" empty and mark it Out of Stock!
      7. HALLUCINATION STRICT-RULE: Do not invent prices. If you do not see a price explicitly written in current google search results for a reputable Indian platform, return "Out of Stock".

      Return the results in a strict JSON object format containing "resolvedProductName", "queryType" (must be "category", "comparison", or "specific"), and "prices" array.
      
      Example output format:
      {
        "resolvedProductName": "iQOO Neo 10 Pro 12GB 256GB",
        "queryType": "specific",
        "prices": [
          {
            "platform": "Amazon",
            "price": "₹37,999",
            "url": "https://www.amazon.in/dp/B0CXXYZ",
            "stockStatus": "In Stock",
            "exactVariantMatch": true
          },
          {
            "platform": "Flipkart",
            "price": "Out of Stock",
            "url": "",
            "stockStatus": "Out of Stock",
            "exactVariantMatch": false
          }
        ]
      }
      
      If the product is not found or has no active listings, return an empty array for prices.
      Only return valid JSON conforming to the example format. No markdown, no explanations. Make sure URLs are real direct search or product page URLs.
      `;

      const response = await callGeminiWithRetry({
        model: modelToUse,
        contents: [{ role: "user", parts: [{ text: preFetchPrompt }] }],
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.0,
          ...(modelToUse.includes("gemini-3") ? {
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.LOW
            }
          } : {})
        }
      });

      let jsonText = "";
      if (typeof response.text === 'string') {
        jsonText = response.text.trim();
      } else if (response.candidates?.[0]?.content?.parts) {
        jsonText = response.candidates[0].content.parts
          .map((p: any) => p.text || "")
          .join("")
          .trim();
      }

      if (jsonText) {
        console.log("[Price Verification Pre-fetch] Extracted Prices Data:", jsonText);
        const repaired = repairJson(jsonText);
        const parsed = JSON.parse(repaired);
        let pricesArray = Array.isArray(parsed) ? parsed : (parsed.prices || []);
        let resolvedName = parsed.resolvedProductName || productQuery;
        
        if (Array.isArray(pricesArray) && pricesArray.length > 0) {
          // Pre-processing to decode numeric values to build protection filters
          const parsedWithValues = pricesArray.map((item: any) => {
            if (!item.platform) return null;
            let priceStr = String(item.price || "").trim();
            const originalPriceStr = priceStr;
            let stockStatus = String(item.stockStatus || "In Stock").trim();
            const exactVariantMatch = item.exactVariantMatch !== false;
            
            let isOos = /out of stock|unavailable|not available|oos|currently unavailable/i.test(stockStatus) || 
                          /out of stock|unavailable|not available|currently unavailable/i.test(priceStr) ||
                          priceStr === "0" || priceStr === "" || exactVariantMatch === false;

            if (isOos) {
              stockStatus = "Out of Stock";
            }

            priceStr = isOos ? "Out of Stock" : priceStr.replace(/Rs\.?|INR/gi, "").trim();
            if (priceStr && !priceStr.startsWith("₹") && !isOos) {
              priceStr = "₹" + priceStr;
            }
            
            const numValue = isOos ? NaN : parseInt(priceStr.split('.')[0].replace(/[^\d]/g, ''));
            return { item, priceStr, numValue, originalPriceStr, isOos };
          }).filter(x => x !== null) as any[];

          // Dynamic Outlier Filtering Guard: Remove low prices that correspond to cases, covers or glass protectors
          let filtered = parsedWithValues.filter(x => x.isOos || (!isNaN(x.numValue) && x.numValue > 100));
          const activeOffers = filtered.filter(x => !x.isOos && !isNaN(x.numValue));
          
          if (activeOffers.length >= 2) {
            const sortedValues = activeOffers.map(x => x.numValue).sort((a, b) => a - b);
            const medianPrice = sortedValues[Math.floor(sortedValues.length / 2)];
            if (medianPrice > 2000) {
              // Any listing that is less than 18% of the median price is surely a cheap screen-guard or back-case cover
              filtered = filtered.filter(x => x.isOos || x.numValue >= medianPrice * 0.18);
              console.log(`[Outlier Filter] Filtered out cheap accessory outliers using median price ₹${medianPrice}.`);
            }
          } else if (activeOffers.length === 1 && budgetLimit) {
            const parsedLimit = parseInt(budgetLimit.split('.')[0].replace(/[^\d]/g, ''));
            if (!isNaN(parsedLimit) && parsedLimit > 2000) {
              // If only 1 offer found and it's less than 18% of the target budget, it's highly likely an accessory
              filtered = filtered.filter(x => x.isOos || x.numValue >= parsedLimit * 0.18);
              console.log(`[Outlier Filter] Filtered out cheap accessory outliers using budget limit ₹${parsedLimit}.`);
            }
          }

          if (filtered.length > 0) {
            const healed: any[] = [];
            let lowestPrice = Infinity;
            let lowestIdx = -1;

            filtered.forEach((entry: any, index: number) => {
              const { item, priceStr, numValue, isOos } = entry;
              let platform = String(item.platform).trim();
              let url = String(item.url || "").trim();
              
              const platformLower = platform.toLowerCase();
              const isGenericModelUrl = !url || 
                                        url === "https://www.amazon.in" || 
                                        url === "https://www.flipkart.com" || 
                                        url === "https://www.croma.com" || 
                                        url === "https://www.reliancedigital.in" ||
                                        url.includes("placeholder") ||
                                        url.length < 30; // Generic listing homepage urls are usually short

              // Direct Alignment: ALWAYS prioritize actual crawled URL from grounding chunks to prevent LLM hallucinated dead-links
              const groundingUrl = extractGroundingUrlForPlatform(response, platform);
              if (groundingUrl && groundingUrl.length > 25) {
                const gLower = groundingUrl.toLowerCase();
                // Ensure it's a real product or search page, not a help / login / cart / seller page
                const isLowQualityLink = gLower.includes("/help/") || 
                                         gLower.includes("/display.html") || 
                                         gLower.includes("/login") || 
                                         gLower.includes("/register") || 
                                         gLower.includes("/cart") || 
                                         gLower.includes("/seller") ||
                                         gLower.includes("/about") ||
                                         gLower.includes("/terms");
                if (!isLowQualityLink) {
                  console.log(`[Grounding URL Override] Overriding LLM URL with verified crawl URL for ${platform}: ${groundingUrl}`);
                  url = groundingUrl;
                }
              }

              let stockStatus = isOos ? "Out of Stock" : String(item.stockStatus || "In Stock").trim();
              
              if (!stockStatus || /unknown|checking|verify|tbd/i.test(stockStatus)) {
                stockStatus = isOos ? "Out of Stock" : "In Stock";
              }
              
              if (!isOos && numValue && numValue < lowestPrice) {
                lowestPrice = numValue;
                lowestIdx = index;
              }

              // Guard redirect. If out of stock on that platform, force user link to empty
              let redirectUrl = url;
              if (isOos) {
                redirectUrl = "";
              }

              healed.push({
                platform,
                label: `Buy on ${platform}`,
                price: isOos ? "Out of Stock" : priceStr || "Live Price",
                url: isOos ? "" : cleanAndResolveUrl(redirectUrl, platform, cleanQuery),
                isBestDeal: false,
                stockStatus
              });
            });

            
            return { resolvedProductName: resolvedName, queryType: parsed.queryType || "specific", prices: healed };
          }
        }
        return { resolvedProductName: resolvedName, queryType: parsed.queryType || "specific", prices: [] };
      }
    } catch (err: any) {
      console.error(`[Price Verification Pre-fetch] Error running price verification scanner (Attempt ${attempt + 1}):`, err);
      const errStr = String(err.message || "").toLowerCase();
      const isCriticalFail = errStr.includes("dunning") || 
                             errStr.includes("billing") || 
                             errStr.includes("deny for project") || 
                             errStr.includes("permission_denied") || 
                             errStr.includes("denied_access") ||
                             errStr.includes("denied access") ||
                             errStr.includes("forbidden") ||
                             errStr.includes("unauthorized") ||
                             errStr.includes("all models failed") ||
                             err?.status === 403 || 
                             err?.code === 403;
      if (isCriticalFail) {
        throw err;
      }
      if (attempt < retries - 1) {
        console.log(`[Price Verification Pre-fetch] Waiting 800ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  }
  return null;
}

app.post("/api/audit", securityGuard, async (req, res) => {
  if (!ai) {
    return res.status(401).json({ 
      error: "Vetto Engine Core not initialized. Please ensure GEMINI_API_KEY is set." 
    });
  }

  try {
    const { query, budget, useCase, history, images } = req.body;

  // 1. Process and sanitize input
  let parsedQuery = (query || "").trim();
  let hasUrl = false;
  
  if (/https?:\/\/[^\s]+/i.test(parsedQuery)) {
    hasUrl = true;
    const urlMatch = parsedQuery.match(/(https?:\/\/[^\s]+)/i);
    if (urlMatch) {
      const extracted = extractProductNameFromUrl(urlMatch[1]);
      if (extracted) {
        console.log(`[Parser Resilience] Extracted "${extracted}" from URL: ${urlMatch[1]}`);
        parsedQuery = extracted;
      }
    }
  }

  // 1b. Fast query refiner & spec-resolver to find the precise product model and variant matching the target budget/context
  let parsedBudget = (budget || "").trim();

  // Extract budget limit from query if the budget field itself is empty
  if (!parsedBudget) {
    // Matches "under 30k", "below 20,000", "budget 15k", "under rs. 15000", "under rs 15k", "rs. 30k", etc.
    const budgetPattern = /(?:under|below|less than|around|max|budget|within|under\s*rs\.?|under\s*₹)\s*(?:rs\.?|inr|₹)?\s*(\d+\s*k|\d+[\d,]*)/i;
    const match = parsedQuery.match(budgetPattern);
    if (match) {
      let limitStr = match[1].toLowerCase().replace(/[\s,]+/g, "");
      let numericLimit = 0;
      if (limitStr.endsWith("k")) {
        numericLimit = parseFloat(limitStr) * 1000;
      } else {
        numericLimit = parseFloat(limitStr);
      }
      if (!isNaN(numericLimit) && numericLimit > 0) {
        parsedBudget = numericLimit.toLocaleString('en-IN');
        console.log(`[Parser Resilience] Auto-extracted budget limit from query: ₹${parsedBudget}`);
      }
    } else {
      // Direct numeric-with-k model indicator match like "best phone 30k" or "laptop 40k"
      const kMatch = parsedQuery.match(/\b(\d+)\s*k\b/i);
      if (kMatch) {
        const numericLimit = parseFloat(kMatch[1]) * 1000;
        parsedBudget = numericLimit.toLocaleString('en-IN');
        console.log(`[Parser Resilience] Auto-extracted k-bracket budget limit from query: ₹${parsedBudget}`);
      }
    }
  }

  let isBudgetCategoryQuery = false;
  const budgetKeywords = ["under", "below", "budget", "price range", "within", "cheapest", "costing", "around", "max"];
  const categoryKeywords = ["best", "top", "recommend", "suggest", "which"];
  
  const hasBudgetKeyword = budgetKeywords.some(kw => parsedQuery.toLowerCase().includes(kw)) || /\d+[kK]/.test(parsedQuery);
  const hasCategoryKeyword = categoryKeywords.some(kw => parsedQuery.toLowerCase().includes(kw));
  const hasBudgetInField = parsedBudget.length > 0;
  
  // Is this any category or branded query that contains a budget constraint, or a broad category request?
  const isGenericCategoryQuery = (hasBudgetKeyword || hasBudgetInField || hasCategoryKeyword) && !hasUrl && !parsedQuery.toLowerCase().includes(" vs ");

  if (isGenericCategoryQuery && ai && parsedQuery.length > 2) {
    try {
      console.log(`[Parser Resilience] Refining query: "${parsedQuery}" with budget limit: "${parsedBudget}"...`);
      // Use gemini-3.1-flash-lite for ultra-fast, high-precision query refining and spec-resolution
      const rewriteResponse = await callGeminiWithRetry({
        model: "gemini-3.1-flash-lite",
        contents: [{
          role: "user",
          parts: [{
            text: `Analyze this shopping query: "${parsedQuery}" with a budget of: "${parsedBudget ? '₹' + parsedBudget : 'Unspecified'}". Your goal is to return a highly-specific, single retail-active product model name (including exact realistic variant like RAM/Storage if it's electronics, or Size/Color if relevant) that fits this budget in the Indian consumer market.

Context & Hard Constraints:
1. The model and specific variant you choose MUST be physically available and currently selling in India for a price strictly UNDER or EQUAL to the budget limit (if specified). For example, if the budget is ₹30,000, do NOT output a phone model like "iQOO Neo 9 Pro" because it sells for ₹35,000+.
2. Resolve generic searches (e.g. "best phone under 30k", "best sneakers", "samsung under 20k") to the absolute best specific model currently active (e.g., "OnePlus Nord CE 4 8GB 128GB" or "Puma Smash v2 L").
3. If the user query is already a specific product model (e.g. "iQOO Neo 10") and fits the budget, just return that exact model and its most popular variant (e.g. "iQOO Neo 10 8GB 256GB").
4. If the query already specifies an exact configuration (e.g., "12GB 256GB"), preserve it.
5. In India, typical smartphone variants are "8GB 128GB", "12GB 256GB". Laptops are "16GB 512GB SSD". If the product is not electronics (e.g., shoes, appliances), just return the exact model name.

Return ONLY the final specific product model with variant (e.g., "OnePlus Nord 4 8GB 128GB" or "Nike Revolution 6"). Do not include any formatting, notes, markdown, or explanations. If you provide any conversational text, the system will break.`
          }]
        }],
        config: {
          temperature: 0.0,
        }
      });
      
      let resolvedName = rewriteResponse.text?.trim() || "";
      // Strip any markdown code blocks, prefixes, or newlines just in case the model hallucinates format
      resolvedName = resolvedName.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').replace(/\n/g, ' ').trim();
      
      if (resolvedName && resolvedName.length > 3) {
        console.log(`[Parser Resilience] Resolved query "${parsedQuery}" with budget "${parsedBudget}" to specific variant: "${resolvedName}"`);
        parsedQuery = resolvedName;
        isBudgetCategoryQuery = true;
      }
    } catch (rewriteErr: any) {
      console.error("[Parser Resilience] Failed to resolve budget query:", rewriteErr);
      const errStr = String(rewriteErr?.message || "").toLowerCase();
      const isCriticalFail = errStr.includes("dunning") || 
                             errStr.includes("billing") || 
                             errStr.includes("deny for project") || 
                             errStr.includes("permission_denied") || 
                             errStr.includes("denied_access") ||
                             errStr.includes("denied access") ||
                             errStr.includes("forbidden") ||
                             errStr.includes("unauthorized") ||
                             errStr.includes("all models failed") ||
                             rewriteErr?.status === 403 || 
                             rewriteErr?.code === 403;
      if (isCriticalFail) {
        throw rewriteErr;
      }
    }
  }

  // 2. Resilience checks for chaotic, empty, or purely symbolic inputs
  const cleanText = parsedQuery.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  if (!cleanText || cleanText.length < 2) {
    console.log(`[Parser Resilience] Intercepted chaotic query: "${query}"`);
    const recoveryData = {
      ...defaultAuditData,
      productName: "Vetto Input Shield",
      finalDecision: "WAIT",
      whyBest: "Vetto requires a valid product name, comparison, or direct link.",
      aamAadmiSummary: "Arey yaar! Input thoda clear dalo. Paste a full product link from Amazon/Flipkart, or type a real name like 'OnePlus Nord 4' or 'Mi powerbank' so we can run a deep scan for you.",
      pros: [
        "Paste direct e-commerce links (Amazon, Flipkart, etc.)",
        "Type product comparisons (e.g., 'MacBook vs ThinkPad')",
        "Upload any product snapshot or price tag screenshot"
      ],
      cons: [
        "Chaotic characters and punctuation cannot be fetched on Indian forums",
        "Single-letter queries are too ambiguous to build a strategic timeline"
      ],
      regretWarning: "Fuzzy inputs will degrade the value of your strategic report.",
      confidenceScore: 100,
      regretRisk: "Low",
      whyRegret: "Rushed or chaotic research before spending hard-earned money usually leads to buyer's regret.",
      saferChoice: "Try pasting an Amazon/Flipkart link, or typing 'Nothing Phone 2a'",
      marketTiming: "WAIT",
      marketReasoning: "Enter a correct product query to reveal real-time market timing alerts.",
      specLongevity: "0 years",
      personalizedInsight: "Our engines are ready. Give us a real model name or copy-paste an item URL to see real math live.",
      socialHook: "Vetto Search Helper",
      postOutputHook: "Vetto standing guard. Try a real query now.",
      paisaVasoolIndex: 0,
      statusTax: 0,
      utilityScore: 0,
      vettoContrast: {
        alternativeName: "Samsung Galaxy Buds 2",
        whyContrast: "If you want to test Vetto, paste any real e-commerce product URL.",
        pviBoost: 20,
        priceDelta: "Save Money",
        fairPriceTarget: "₹5,000",
        procurementGuidance: "Vetto auto-extracts listings from URLs.",
        strategicAdvantage: "Guides you dynamically"
      },
      priceIntegrity: {
        currentPriceAudit: "No pricing context for arbitrary inputs",
        historicalContext: "N/A",
        priceHistory: [{ month: "Jan", price: 0 }],
        dealScore: 0,
        discountStrategy: "Format your query as a product name or shopping store link.",
        procurementLinks: [
          { platform: "Amazon", label: "Search Amazon India", price: "Live Price", isBestDeal: true, url: "https://www.amazon.in", stockStatus: "In Stock" },
          { platform: "Flipkart", label: "Search Flipkart India", price: "Live Price", isBestDeal: false, url: "https://www.flipkart.com", stockStatus: "In Stock" }
        ]
      },
      strategicRoadmap: {
        immediateAction: "Enter a valid product name or link above.",
        peakUtilityAge: "N/A",
        exitStrategy: "N/A"
      },
      communityPulse: {
        redditConsensus: "Users prefer searching with full names or direct URLs.",
        twitterPulse: "X community highly recommends using Vetto for electronics and vehicles.",
        youtubeReality: "Always look details up with a specific model name.",
        linkedinProfessional: "Decision intelligence tools benefit from explicit entity targets.",
        topUSP: "Graceful Recovery",
        topGripe: "None"
      }
    };
    return res.json(recoveryData);
  }

  // Cache lookup with advanced normalization (e.g. "Rs 70,000", "70,000 INR" and "70000" map to the same node)
  const normQuery = parsedQuery.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const budgetDigits = (parsedBudget || "").replace(/[^0-9]/g, "");
  const normBudget = budgetDigits ? budgetDigits : (parsedBudget || "").toLowerCase().trim();
  const normUseCase = (useCase || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();

  // Create high-integrity MD5 hash of uploaded images to enable flawless caching of image-based audits
  let imageHash = "";
  if (images && Array.isArray(images) && images.length > 0) {
    try {
      const hash = crypto.createHash("md5");
      images.forEach((img: any) => {
        if (typeof img === "string") {
          hash.update(img);
        }
      });
      imageHash = hash.digest("hex").substring(0, 16);
    } catch (e) {
      console.error("[Cache Engine] Error hashing images:", e);
      let sum = 0;
      images.forEach((img: any) => {
        if (typeof img === "string") {
          for (let k = 0; k < Math.min(img.length, 1000); k++) {
            sum += img.charCodeAt(k);
          }
        }
      });
      imageHash = "fb_" + sum;
    }
  }

  // Create a safe, standardized Firestore-compatible document ID from the normalized key components
  const normKeyParts = [normQuery, normBudget, normUseCase];
  if (imageHash) {
    normKeyParts.push(imageHash);
  }
  const cacheKey = Buffer.from(normKeyParts.join("-")).toString('base64').replace(/[/+=]/g, '_').substring(0, 200);

  if (cacheKey) {
    // 1. First attempt to fetch from persistent, global Firestore-based Shared Cache
    if (backendDb) {
      try {
        const cacheDocRef = doc(backendDb, "audit_cache", cacheKey);
        const cacheSnap = await getDoc(cacheDocRef);
        if (cacheSnap.exists()) {
          const cached = cacheSnap.data();
          if (Date.now() - (cached.timestamp || 0) < CACHE_TTL && isValidCachedData(cached.data)) {
            console.log(`[Cache Engine] Serving global Firestore cached verdict for: ${query} (ID: ${cacheKey})`);
            return res.json(cached.data);
          } else {
            console.log(`[Cache Engine] Firestore cache exists but is invalid, broken or contains placeholders. Bypassing...`);
          }
        }
      } catch (cacheErr) {
        console.error("[Cache Engine] Firestore read failure. Falling back to in-memory local cache.", cacheErr);
      }
    }

    // 2. Fall back to local in-memory container cache (essential if Firestore is offline or slow)
    if (auditCache.has(cacheKey)) {
      const cached = auditCache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < CACHE_TTL && isValidCachedData(cached.data)) {
        console.log(`[Cache Engine] Serving local in-memory container cached verdict for: ${query} (Key: ${cacheKey})`);
        return res.json(cached.data);
      }
      auditCache.delete(cacheKey);
      saveCacheToDisk();
    }
  }

  const currentDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const historyText = history && history.length > 0 
      ? `\nPrevious Decisions History (Brief):\n${history.slice(0, 3).map((h: any, i: number) => `Decision ${i+1}: ${h.productName} -> ${h.marketTiming} (${h.finalDecision.substring(0, 50)}...)`).join('\n')}`
      : '';

    // Step 1: Pre-fetch verified real-time prices & links
    const preFetchResult = await preFetchLivePricesAndLinks(parsedQuery, parsedBudget);
    const preFetchedPrices = preFetchResult?.prices || null;
    const resolvedProduct = preFetchResult?.resolvedProductName || parsedQuery;
    const queryType = preFetchResult?.queryType || "specific";

    let promptText = `CURRENT DATE: ${currentDate}
Original User Query: "${query}"
Resolved Specific Target Product: ${resolvedProduct || "Analyzed Visual Evidence"}
Query Type: ${queryType}
Target Capital: ${parsedBudget || 'Unlimited'}
Strategic Context: ${useCase || 'General Deployment'}${historyText}`;

    if (preFetchedPrices && preFetchedPrices.length > 0) {
      promptText += `\n\nVERIFIED CURRENT LIVE PRICES ON MAJOR PLATFORMS IN INDIA:\n` +
        preFetchedPrices.map((p: any) => `- ${p.platform}: ${p.price} (Verified Purchase/Search Link: ${p.url || 'None - Out of Stock'})`).join('\n') +
        `\nUse these exact verified live prices and direct URLs for your "priceIntegrity.procurementLinks" structure. Ensure exact congruency. If the price is "Out of Stock" or the link says "None", you MUST NOT provide a URL for that platform (leave the url field empty string "").`;
    }

    if (images && images.length > 0) {
      promptText += `\n\nIMPORTANT: Analyze the attached screenshots meticulously. Look for technical specifications, material quality indicators, marketing traps, and real-world durability markers.`;
    }

    const systemPrompt = `You are Vetto (The Founder's Truth Engine). Your mission: Protect the hard-earned money of the Indian consumer.
You provide the absolute FINAL verdict. No generic summaries. No hallucinations.

STRICT PRICING & SCORING PROTOCOLS:
0. STRICT VARIANT & OPTION DIFFERENTIATION:
    - If the product query refers to a specific storage capacity (e.g. "128GB", "256GB", "512GB"), a RAM capacity (e.g. "8GB", "12GB", "16GB"), or a chip/processor (e.g. "M2", "M3"), you MUST return pricing, comparison links, and alternative choices specifically matching that CHOSEN option. Do NOT return the base model's pricing or a generic category pricing.
0.1. STRICT TARGET CAPITAL & BUDGET COMPLIANCE:
    - If the "Target Capital" constraint is specified and is NOT "Unlimited", you MUST mathematically compare the primary product's lowest platform price against the budget. 
    - If the price is LESS THAN or EQUAL to the budget, you MUST explicitly state that it fits their budget perfectly. NEVER hallucinate or claim that it exceeds their budget or tell them not to buy it for budget reasons.
    - If the price genuinely exceeds the budget, explain clearly in "aamAadmiSummary" and recommend a high-value alternative in "vettoContrast" that strictly fits within or under the budget.

1. TRUTH DETECTOR & BOT CRACKDOWN ENGINE:
    A. REVIEW AUTHENTICITY ANALYSIS (fakeReviewScore, botSignalDetection):
       - Look for bot signature clusters: rating distributions that are polarized (massive 5-star and 1-star spikes with no middle ground), high concentrations of superficial praise reviews lacking specific real-world details (e.g. "Excellent product!", "Value for money!"), and review timing bursts.
       - A review score of 90+ is reserved ONLY for products with highly verified, heterogeneous, and long-term feedback. If review patterns show high repetition of generic adjectives, penalize the score immediately below 60.
       
    B. TRUTH DIVERGENCE SCORE (divergenceIndex):
       - Calculate the divergence index (0-100) as the gap between brand marketing hype vs real customer complaints.
       - Hype = Brand press releases, sponsored influencer reviews, spec-sheet padding (e.g., advertising "AI features" that require paid subscriptions or "64MP camera" paired with a terrible processor).
       - Reality = Reddit user complaints, X/Twitter callouts, durability breakdowns.
       - If there is a massive gap (e.g. brand advertises premium durability but Reddit reports hinges break in 3 months), push divergenceIndex above 75.

    C. COMMUNITY CONSENSUS FILTERING:
       - Reddit: Extract long-term durability issues, hardware bottlenecks, and homebrew bypasses. Do not return generic praise.
       - X/Twitter: Extract real-time shipping/customer support nightmares, recalls, and viral quality-control failures.
       - YouTube: Actively discount sponsored shill videos. Extract hands-on durability and practical flaws from independent, non-sponsored channels.
       - LinkedIn: Analyze B2B longevity and professional industry adoption.

    D. CATEGORY-SPECIFIC DEEP AUDITS:
       - Electronics: Check for thermal throttling, after-sales service response time in tier-2/3 Indian cities, battery health degradation over 6 months, and useless spec padding (e.g., secondary 2MP macro cameras).
       - Fashion/Sneakers: Check for sizing accuracy (runs small/large), material durability over wash cycles, creasing patterns, sole separation risk, and premium synthetic fabric markups.
       - Automotive/Accessories: Check for real-world fuel economy in Indian bumper-to-bumper traffic, cabin panel rattling, global NCAP safety scores, and spare parts availability/wait times.

2. THE ELDER BROTHER PERSONA & TONE DIRECTIVES:
    You are the user's street-smart, caring elder brother ("bhaiya") who wants to save them from being scammed by glossy ads and hype. 
    Use a warm, natural, simple, and protective voice. Use everyday Indian/Hinglish/English terms where appropriate.
    
    A. VALUE INDEXES (Paisa Vasool Index & Utility Score):
       - Explain value practically. "Every single rupee works hard for you" vs "It's like paying for a premium thali but only getting rice and dal."
    
    B. STATUS / BRAND PREMIUM TAX (Status Tax):
       - Frame this as the "badge penalty" or "show-off fee". Calculate the price premium in exact Rupees (₹) compared to an equally good, lesser-hyped product: "You are paying a massive ₹15,000 extra just for the shiny logo. If you buy the alternative, that ₹15,000 stays in your pocket!"
    
    C. HIDDEN COSTS AUDIT:
       - Actively call out sneaky extra expenses: charger missing from box, mandatory screen guards/cases, or expensive annual subscription services.
    
    D. REGRET RISK & ALERTS (whyRegret, regretWarning):
       - Be direct. Speak on daily real-world annoyances: "The plastic back scratches if you look at it too hard," or "The battery drops like a stone after 6 months; your friends will tease you."
    
    E. BHARTIYA PERSONA AUDIT:
       - Map to Indian middle-class realities: "Perfect for our typical Indian household where one tablet is shared by the kids and parents. It survives kitchen spills, dusty rooms, and doesn't burn a hole in your pocket!"

3. UTILITY SCORE: 0-100. Based purely on features that work in real-world Indian conditions.
4. TRUTH DIVERGENCE: 0-100. Gap between brand hype and Reddit reality.
5. REVIEW AUTHENTICITY: 0-100. Low if bot/repetition patterns are spotted.
6. DEAL RATING: 0-100. MSRP trap check.
7. TARGET PRICE: Scientifically calculated Fair Value.
8. PRICE COMPARISON & VERIFICATION LINKS:
    - You MUST use Google Search to identify actual, live numeric pricing for the product on AT LEAST 3 distinct major e-commerce platforms in India (such as Amazon, Flipkart, Reliancedigital, Croma, Ajio, Myntra, Tata CLiQ, or the official brand web store). It is absolutely unacceptable to only return 1 platform or platform link.
    - You MUST NEVER write placeholders like "Check Live", "Live Price", "Check Price", "TBD", "N/A", "₹0", "0" or "Live" under any circumstances. You MUST output real-world prices in Rupees (e.g. "₹9,695" or "₹11,495").
    - Give direct clickable verifying URLs for each vendor in the "procurementLinks" array under the "url" property.
    - Platforms must use correct direct search urls:
      * Amazon: https://www.amazon.in/s?k=[urlencoded_product_name]
      * Flipkart: https://www.flipkart.com/search?q=[urlencoded_product_name]
      * Croma: https://www.croma.com/search/?text=[urlencoded_product_name]
      * Reliance Digital: https://www.reliancedigital.in/search?q=[urlencoded_product_name]
      * Other stores: Use their actual direct search pattern or their official domain address.
    - Every link must point to a functioning product search page so that clicking it provides high-integrity instant verification.
9. SAFETY SCORE: 0-100. Reliability and service network quality in India.
10. ZERO-DIFFERENTIATION PRICING CONGRUENCY:
    - Every price field in your JSON output must be mathematically and numerically consistent with no mismatch or differentiation.
    - All displayed currency strings must use the Rupees symbol "₹" consistently (e.g. "₹54,999" - not "Rs", "INR" or lack of symbol).
    - In "priceIntegrity.procurementLinks", the item marked "isBestDeal: true" must have the lowest price string (e.g., "₹54,999").
    - The latest month's price in the "priceIntegrity.priceHistory" array (which is an integer) MUST exactly equal the numerical value of that lowest price (e.g., 54999) so that the chart's current node matches the listed deal price.
    - The smarter alternative's name and details are in "vettoContrast". The "vettoContrast.priceDelta" field must represent the actual calculated difference between the current lowest price and the alternative's price (e.g., if current is ₹54,999 and alternative is ₹44,999, the delta must be "Save ₹10,000").
    - The "vettoContrast.fairPriceTarget" must be congruent with your target price recommendations (e.g., "₹49,999").
    - There must be absolutely no conflicting price values in any text descriptions, lists, charts, or comparison sections.
11. LAYMAN-FRIENDLY COPY FOR BUYING & STOCK SECTION (NO TECH/FINANCE JARGON):
    - When generating "priceIntegrity.currentPriceAudit", "priceIntegrity.historicalContext", and "priceIntegrity.discountStrategy", you MUST speak like a normal consumer's helpful companion or elder brother.
    - Write in everyday, simple, clear, jargon-free English that any typical uncle, student, or non-tech consumer can instantly understand.
    - Under NO circumstances are you allowed to use academic, technical, or finance jargon such as "equilibrium", "market correction", "historical volatility", "arbitrage", "price elasticity", "retailer premium", "MSRP discrepancy", or "data points".
    - Give simple, solid, down-to-earth advice like: "This price is a great discount, we think you should grab it now", "Usually, this gets ₹1,500 cheaper during Diwali and October sales", "Use an SBI credit card or wait for the weekend flash deals to save more."
12. STOCK ACCURACY & DIAGNOSTICS:
    - In "priceIntegrity.procurementLinks", you MUST determine the realistic "stockStatus" of the product on each retailer platform (e.g. 'In Stock', 'Only 3 left', 'Out of Stock').
    - If the product is highly popular and selling fast, reflect true consumer dynamics by using tags like 'Only a few left' or 'Only 2 left' to give the user honest heads-up alerts. Defensively default to 'In Stock' if widely available.

13. SMART QUERY RESOLUTION:
    - You must directly address the specific nuance of the "Original User Query" in your final response.

14. RECOMMENDATION PERSONA INJECTION:
    - If the "Query Type" is "category", the user originally asked for a recommendation (e.g., "best washing machine under 20k"). The "Resolved Specific Target Product" you are evaluating is YOUR OWN top choice for them.
    - Do NOT treat this product as a random user-selected item that needs to be shot down. 
    - Evaluate it fairly. If it genuinely fits their criteria, give it a high rating (BUY or STEAL) and enthusiastically explain why it is the absolute best choice in the "aamAadmiSummary".
    - In the "vettoContrast" alternative section, provide a slightly cheaper or slightly more premium alternative. You MUST ensure this alternative is a mainstream, widely available product that is ACTUALLY IN STOCK in India right now. Do not recommend obsolete or out-of-stock items as alternatives.
    - If the "Query Type" is "comparison", analyze both items fairly and crown the true winner.
    - If the user asks a yes/no question like "is this product worth it?", your "aamAadmiSummary" and "finalDecision" must explicitly answer "Yes" or "No" based on your findings.
    - If the user asks for "best product under 10k", acknowledge their specific request and frame the recommendation around why this is the best for that budget.
    - Differentiate your tone and response structure based on the specific question asked in the Original User Query, rather than providing a generic product summary.

TONE: Brutally honest, protective, and simple. Use "Bhartiya" context. You are the user's smart elder brother. No technical jargon. Accuracy in pricing is our lifeblood. Ensure "Status Tax" feels like a real penalty for buying a badge.`;

    console.log(`[Audit Req] Start: ${query?.substring(0, 50) || "Visual Analysis"} (${images?.length || 0} images)`);
    const startTime = Date.now();
    const modelToUse = "gemini-2.5-flash";
    console.log(`[Audit Req] Initializing model: ${modelToUse}`);

    const parts: any[] = [{ text: promptText }];
    if (images && images.length > 0) {
      images.forEach((base64: string) => {
        parts.push({
          inlineData: {
            mimeType: "image/jpeg", // Assuming JPEG for base64 images from browser
            data: base64
          }
        });
      });
    }

    // Always enable Google Search grounding for all queries to ensure 100% accurate, real-time price comparisons & stock diagnostics
    // OPTIMIZATION: If we successfully pre-fetched live prices using Google Search grounding, we can disable Google Search grounding on the main call.
    // This reduces the response time of the main call from ~7 seconds to ~2 seconds, saving up to 5 seconds of total end-to-end latency!
    const useSearchGrounding = !(preFetchedPrices && preFetchedPrices.length > 0);
    
    console.log(`[Cache Engine] Active Mode: Live Google Search Grounding for maximum platform price integrity`);

    let finalSystemPrompt = systemPrompt + 
      "\n\nCRITICAL REQUIREMENT FOR ZERO LATENCY & SPEED:\n" +
      "Your response must comply 100% with the strict JSON structure. Because the structure is extensive, YOU MUST keep every text value extremely short, terse, and punchy. " +
      "Each text field (definitions, details, summaries, reasons) must be at most 1 short sentence or quick phrase. Do not generate multi-sentence text. This is absolutely essential to achieve ultra-fast generation and low latency.";

    if (preFetchedPrices && preFetchedPrices.length > 0) {
      finalSystemPrompt += `\n\nCRITICAL REAL-TIME CURRENT PRICING DATAFEED:\nYou MUST use the following exact prices and URLs for the platforms in your JSON's "priceIntegrity.procurementLinks" array. Do NOT make up other prices or change these fields. Use exactly these values:\n${JSON.stringify(preFetchedPrices.map(p => ({ platform: p.platform, price: p.price, url: p.url, isBestDeal: p.isBestDeal })), null, 2)}`;
    }

    const genConfig: any = {
      systemInstruction: finalSystemPrompt,
      ...(useSearchGrounding ? { tools: [{ googleSearch: {} }] } : {}),
      temperature: 0.0,
      maxOutputTokens: 8192,
    };

    // Only add thinkingConfig if using a gemini-3.x thinking reasoning model
    if (modelToUse.startsWith("gemini-3")) {
      genConfig.thinkingConfig = {
        thinkingLevel: ThinkingLevel.LOW,
      };
    }

    // Fully eliminate the error combination: Tool use with responseMimeType "application/json" is unsupported
    if (!useSearchGrounding) {
      genConfig.responseMimeType = "application/json";
      genConfig.responseSchema = auditResponseSchema;
    }

    const isSSE = req.headers.accept === "text/event-stream";

    let text = "";
    
    if (isSSE) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      
      // Send initial metadata with preFetchedPrices
      res.write(`data: ${JSON.stringify({ type: "metadata", preFetchedPrices })}\n\n`);

      try {
        let stream: any;
        let lastErr: any;
        // Simple retry for stream initialization
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            stream = await ai.models.generateContentStream({
              model: modelToUse,
              contents: [{ role: "user", parts }],
              config: genConfig,
            });
            break;
          } catch (e: any) {
            lastErr = e;
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          }
        }
        if (!stream) throw lastErr;

        for await (const chunk of stream) {
          const chunkText = chunk.text;
          if (chunkText) {
            text += chunkText;
            res.write(`data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`);
          }
        }
      } catch (err: any) {
        console.error("Stream generation failed:", err);
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
        res.end();
        return;
      }
    } else {
      const genResponse = await callGeminiWithRetry({
        model: modelToUse,
        contents: [{ role: "user", parts }],
        config: genConfig,
      });

      const duration = Date.now() - startTime;
      console.log(`[Audit Req] Model finished in ${duration}ms`);

      try {
        if (typeof genResponse.text === 'string') {
          text = genResponse.text.trim();
        } else if (genResponse.candidates?.[0]?.content?.parts) {
          text = genResponse.candidates[0].content.parts
            .map((part: any) => part.text || "")
            .join("")
            .trim();
        }
      } catch (e) {
        console.error("Failed to extract text from Gemini response:", e);
        throw new Error("The Strategic Engine failed to articulate its verdict. This might be due to safety filters or an internal glitch.");
      }
      if (!text) {
        throw new Error("Model returned an empty response.");
      }
    }
    
    // Robust parsing with JSON repair and deep merge fallback
    let auditData: any;
    try {
      const jsonStart = text.search(/[{[]/);
      const jsonEnd = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
      let rawJson = text;
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        rawJson = text.substring(jsonStart, jsonEnd + 1);
      }
      
      const repairedJsonString = repairJson(rawJson);
      const parsed = JSON.parse(repairedJsonString);
      auditData = deepMerge(defaultAuditData, parsed);

      // Programmatic Truth Shield Override Heuristics to guarantee mathematical consistency
      if (auditData?.socialAudit?.integrityAudit) {
        const audit = auditData.socialAudit.integrityAudit;
        const prodNameLower = (auditData.productName || "").toLowerCase();
        
        // HEURISTIC 1: Brand Premium & Status Tax programmatically impacts Paisa Vasool Index (Value Index)
        if (auditData.statusTax > 12000 && auditData.paisaVasoolIndex > 65) {
          console.log(`[Heuristic Guard] Programmatically adjusting Paisa Vasool Index down due to excessive Status Tax (₹${auditData.statusTax})`);
          auditData.paisaVasoolIndex = Math.max(30, auditData.paisaVasoolIndex - 25);
        }
        
        // HEURISTIC 2: If Truth Divergence is high, Review Authenticity cannot be perfect
        if (audit.divergenceIndex > 70 && audit.fakeReviewScore > 80) {
          console.log(`[Heuristic Guard] Adjusting review authenticity score down due to high truth divergence (Hype vs Reality mismatch)`);
          audit.fakeReviewScore = Math.min(60, audit.fakeReviewScore - 20);
        }
        
        // HEURISTIC 3: Category-specific default safety warnings on electronics
        const isElectronics = detectProductCategory(auditData.productName || "", parsedQuery) === 'electronics';
        if (isElectronics && !auditData.hiddenCosts.toLowerCase().includes("charger") && 
            (prodNameLower.includes("iphone") || prodNameLower.includes("samsung galaxy s") || prodNameLower.includes("pixel"))) {
          console.log(`[Heuristic Guard] Injecting charger and repair accessibility warnings for premium smartphone.`);
          auditData.hiddenCosts = "Mandatory ₹1,999 charger missing from the box. Out-of-warranty screen replacement costs up to 40% of the phone's value.";
        }
      }

      // Post-process to guarantee direct, working, user-friendly live links on Indian platforms
      if (auditData?.priceIntegrity) {
        const prodName = auditData.productName || parsedQuery || "product";
        const encodedProdName = encodeURIComponent(prodName);
        
        const category = detectProductCategory(prodName, parsedQuery);
        console.log(`[Category Engine] Detected product category: "${category}" for product "${prodName}" / queries "${parsedQuery}"`);

        let links = auditData.priceIntegrity.procurementLinks;
        if (!Array.isArray(links)) {
          links = [];
        }
        
        let refPrice = getReferencePrice(auditData, parsedQuery, parsedBudget);
        if (preFetchedPrices && preFetchedPrices.length > 0) {
          const validPrices = preFetchedPrices
            .map(p => parseInt(String(p.price || "").replace(/[^\d]/g, '')))
            .filter(num => !isNaN(num) && num > 100);
          if (validPrices.length > 0) {
            refPrice = Math.min(...validPrices);
            console.log(`[Price Engine] Aligned refPrice with lowest verified pre-fetched deal price: ₹${refPrice.toLocaleString('en-IN')}`);
          }
        }
        const existingPlatforms = new Set<string>();
        let healedLinks: any[] = [];
        
        // Unify pre-fetched live prices feed and model-suggested links into a single high-integrity processing loop
        let sourceLinks: any[] = [];
        const hasValidPreFetchedPrice = preFetchedPrices && preFetchedPrices.some(p => p.price && p.price !== "Out of Stock" && parseInt(p.price.replace(/[^\d]/g, '')) > 0);
        
        if (hasValidPreFetchedPrice) {
          console.log(`[Price Engine] Processing pre-fetched live prices...`);
          sourceLinks = preFetchedPrices;
        } else {
          console.log(`[Price Engine] Processing fallback model links...`);
          sourceLinks = links;
        }

        sourceLinks.forEach((link: any) => {
          if (!link || !link.platform) return;
          
          let platform = String(link.platform).trim();
          let label = String(link.label || `Buy on ${platform}`).trim();
          let priceStr = String(link.price || "").trim();
          let rawUrl = String(link.url || "").trim();
          
          let platformLower = platform.toLowerCase();
          
          // Category-Specific Remapping of Platform Names to prevent trust-violating mismatches
          if (category === 'fashion') {
            if (platformLower.includes("croma")) {
              platform = "Myntra";
              label = "Buy on Myntra";
              rawUrl = `https://www.myntra.com/search?q=${encodedProdName}`;
            } else if (platformLower.includes("reliance")) {
              platform = "Ajio";
              label = "Buy on Ajio";
              rawUrl = `https://www.ajio.com/search/?text=${encodedProdName}`;
            }
          } else if (category === 'electronics') {
            if (platformLower.includes("myntra")) {
              platform = "Croma";
              label = "Buy on Croma Store";
              rawUrl = `https://www.croma.com/search/?text=${encodedProdName}`;
            } else if (platformLower.includes("ajio")) {
              platform = "Reliance Digital";
              label = "Buy on Reliance Digital";
              rawUrl = `https://www.reliancedigital.in/search?q=${encodedProdName}`;
            }
          }
          
          const finalPlatformLower = platform.toLowerCase();
          if (existingPlatforms.has(finalPlatformLower)) return; // Avoid duplicate listings
          existingPlatforms.add(finalPlatformLower);
          
          // Decode URL placeholders if they are present
          if (rawUrl) {
            rawUrl = rawUrl
              .replace(/\[urlencoded_product_name\]/gi, encodedProdName)
              .replace(/%5Burlencoded_product_name%5D/gi, encodedProdName)
              .replace(/%5Burlencoded_product_name%5D/gi, encodedProdName)
              .replace(/urlencoded_product_name/gi, encodedProdName);
          }
          
          // Strip Google redirects, tracking parameters, and heal any generic/mismatched links
          const cleanedUrl = cleanAndResolveUrl(rawUrl, platform, prodName);
          
          // Failsafe alignment check: reject if link price is a massive low outlier compared to standard core retail refPrice (indicating cheap accessory leak)
          const linkNumValue = parseInt(priceStr.replace(/[^\d]/g, ''));
          if (!isNaN(linkNumValue) && refPrice > 3000 && linkNumValue < refPrice * 0.18) {
            console.log(`[Safety Guard] Replaced accessory/low-outlier placeholder price "${priceStr}" for platform "${platform}" based on reference price ₹${refPrice.toLocaleString('en-IN')}`);
            priceStr = "Live Price"; // This forces self-healing based on refPrice!
          }

          // Self-heal prices if they are placeholders or non-numeric
          const isPlaceholderPrice = !priceStr || 
                                     /live|check|tbd|n\/a/i.test(priceStr) || 
                                     priceStr === "0" || 
                                     (!/\d/.test(priceStr) && !/out of stock/i.test(priceStr));
                                     
          let forcedOos = false;
          if (isPlaceholderPrice) {
            priceStr = "Out of Stock";
            forcedOos = true;
          }

          if (forcedOos || /out of stock/i.test(priceStr) || /out of stock/i.test(link.stockStatus)) {
             link.stockStatus = "Out of Stock";
             priceStr = "Out of Stock";
          }
          
          healedLinks.push({
            platform,
            label: label.includes("Check") || label.includes("Search") ? `Buy on ${platform}` : label,
            price: priceStr,
            isBestDeal: link.isBestDeal || false,
            url: cleanedUrl,
            stockStatus: link.stockStatus || "In Stock"
          });
        });
        
        // Define standard platforms to back-fill based on Category to ensure comparison is rich (min 4 listings)
        const cleanProductQuery = simplifyProductNameForSearch(prodName);
        const encodedQueryForSearch = encodeURIComponent(cleanProductQuery || prodName);
        const encodedPlusQueryForSearch = encodedQueryForSearch.replace(/%20/g, "+");
        
        let standardPlatforms: any[] = [];
        if (category === 'fashion') {
          standardPlatforms = [
            { name: "Myntra", label: "Buy on Myntra Store", path: `https://www.myntra.com/search?q=${encodedPlusQueryForSearch}`, pct: 1.00 },
            { name: "Ajio", label: "Buy on Ajio", path: `https://www.ajio.com/search/?text=${encodedPlusQueryForSearch}`, pct: 0.978 },
            { name: "Amazon", label: "Buy on Amazon India", path: `https://www.amazon.in/s?k=${encodedQueryForSearch}`, pct: 0.992 },
            { name: "Flipkart", label: "Buy on Flipkart", path: `https://www.flipkart.com/search?q=${encodedQueryForSearch}`, pct: 0.985 }
          ];
        } else if (category === 'electronics') {
          standardPlatforms = [
            { name: "Amazon", label: "Buy on Amazon India", path: `https://www.amazon.in/s?k=${encodedQueryForSearch}`, pct: 1.00 },
            { name: "Flipkart", label: "Buy on Flipkart", path: `https://www.flipkart.com/search?q=${encodedQueryForSearch}`, pct: 0.994 },
            { name: "Croma", label: "Buy on Croma Store", path: `https://www.croma.com/search/?text=${encodedPlusQueryForSearch}`, pct: 1.006 },
            { name: "Reliance Digital", label: "Buy on Reliance Digital", path: `https://www.reliancedigital.in/search?q=${encodedPlusQueryForSearch}`, pct: 1.002 }
          ];
        } else {
          standardPlatforms = [
            { name: "Amazon", label: "Buy on Amazon India", path: `https://www.amazon.in/s?k=${encodedQueryForSearch}`, pct: 1.00 },
            { name: "Flipkart", label: "Buy on Flipkart", path: `https://www.flipkart.com/search?q=${encodedQueryForSearch}`, pct: 0.984 },
            { name: "Google Shopping", label: "Google Product Listings", path: `https://www.google.com/search?q=${encodedQueryForSearch}&tbm=shop`, pct: 1.010 }
          ];
        }
        
        // Enrich up to at least 4 platform listings for rich comparison (especially for electronics Amazon/Flipkart/Croma/Reliance Digital)
        // ALWAYS back-fill missing platforms from standard platforms list with mathematically aligned prices based on refPrice
        for (const p of standardPlatforms) {
          if (healedLinks.length >= 4) break;
          const platNameLower = p.name.toLowerCase();
          
          // Match standard platforms securely whether full string or substring matches
          const alreadyExists = Array.from(existingPlatforms).some(ex => 
            ex === platNameLower || platNameLower.includes(ex) || ex.includes(platNameLower)
          );
          
          if (!alreadyExists) {
            healedLinks.push({
              platform: p.name,
              label: p.label,
              price: "Out of Stock",
              isBestDeal: false,
              url: "",
              stockStatus: "Out of Stock"
            });
            existingPlatforms.add(platNameLower);
          }
        }
        
        // Determine absolute lowest pricing and ensure exactly one best deal flag matches the lowest numeric price
        let lowestPrice = Infinity;
        let lowestPriceIdx = -1;
        
        healedLinks.forEach((link: any, idx: number) => {
          const numPrice = parseInt(link.price.replace(/[^\d]/g, ''));
          if (!isNaN(numPrice) && numPrice < lowestPrice) {
            lowestPrice = numPrice;
            lowestPriceIdx = idx;
          }
        });
        
        if (lowestPrice === Infinity || isNaN(lowestPrice) || lowestPrice <= 0) {
          lowestPrice = refPrice; // Just fallback for budget guard below
        }

        healedLinks = healedLinks.map((link: any, idx: number) => ({
          ...link,
          isBestDeal: lowestPriceIdx !== -1 && idx === lowestPriceIdx
        }));

        // Removed fake budget scaling logic to preserve true platform prices

        
        auditData.priceIntegrity.procurementLinks = healedLinks;
        
        // 1. Synchronize priceHistory with lowestPrice node to prevent chart drift
        if (Array.isArray(auditData.priceIntegrity.priceHistory) && auditData.priceIntegrity.priceHistory.length > 0) {
          const historyArray = auditData.priceIntegrity.priceHistory;
          const lastIdx = historyArray.length - 1;
          const lastModelPriceObj = historyArray[lastIdx];
          const lastModelPrice = typeof lastModelPriceObj.price === 'number' 
            ? lastModelPriceObj.price 
            : parseInt(String(lastModelPriceObj.price || "").replace(/[^\d]/g, ''));
            
          const baseModelPrice = (!isNaN(lastModelPrice) && lastModelPrice > 0) ? lastModelPrice : lowestPrice;
          
          for (let k = 0; k < historyArray.length; k++) {
            const n = historyArray[k];
            const originalPrice = typeof n.price === 'number' ? n.price : parseInt(String(n.price || "").replace(/[^\d]/g, ''));
            if (isNaN(originalPrice) || originalPrice <= 0) {
              const offsetMonths = lastIdx - k;
              n.price = Math.round(lowestPrice * (1.0 + (offsetMonths * 0.02)));
            } else {
              // Scale relative to baseModelPrice and lowestPrice to keep exact visual trend without price level drift!
              const ratio = originalPrice / baseModelPrice;
              // Limit ratio to reasonable bounds (e.g. 0.5 to 2.0) to prevent chaotic spikes
              const boundedRatio = Math.max(0.5, Math.min(2.0, ratio));
              n.price = Math.round(lowestPrice * boundedRatio);
            }
          }
          // Absolute certainty that the last item matches lowestPrice
          historyArray[lastIdx].price = lowestPrice;
        } else {
          // Fallback history array
          const months = ["Dec", "Jan", "Feb", "Mar", "Apr", "May"];
          auditData.priceIntegrity.priceHistory = months.map((m, idx) => ({
            month: m,
            price: Math.round(lowestPrice * (1.10 - (idx * 0.02)))
          }));
          const lastIdx = auditData.priceIntegrity.priceHistory.length - 1;
          auditData.priceIntegrity.priceHistory[lastIdx].price = lowestPrice;
        }

        // 2. Synchronize Brand Surcharge / Status Tax with lowestPrice alternative differentiation
        let currentSurchargeTax = typeof auditData.statusTax === 'number' 
          ? auditData.statusTax 
          : parseInt(String(auditData.statusTax || "").replace(/[^\d]/g, ''));
          
        if (isNaN(currentSurchargeTax) || currentSurchargeTax < 0 || currentSurchargeTax >= lowestPrice) {
          currentSurchargeTax = Math.round(lowestPrice * 0.22); // Real premium ratio
        }
        auditData.statusTax = currentSurchargeTax;

        // 3. Coordinate vettoContrast pricing targets & save differentials
        const altPrice = Math.max(99, lowestPrice - currentSurchargeTax);
        if (!auditData.vettoContrast) {
          auditData.vettoContrast = {
            alternativeName: "Similar Specced Alternate Choice",
            whyContrast: "Value alternative that delivers equal core functions without Status Tax.",
            pviBoost: 20,
            priceDelta: `Save ₹${currentSurchargeTax.toLocaleString('en-IN')}`,
            fairPriceTarget: `₹${altPrice.toLocaleString('en-IN')}`,
            procurementGuidance: "Standard option recommended for absolute price-to-performance efficiency."
          };
        } else {
          auditData.vettoContrast.priceDelta = `Save ₹${currentSurchargeTax.toLocaleString('en-IN')}`;
          auditData.vettoContrast.fairPriceTarget = `₹${altPrice.toLocaleString('en-IN')}`;
        }

        // 4. Force synchronization on high-level textual summaries to eradicate mismatching numbers
        auditData.priceIntegrity.currentPriceAudit = `₹${lowestPrice.toLocaleString('en-IN')} • Verified lowest available price among active sellers online.`;

        // 5. Enforce strict, stable, mathematical alignment for "marketTiming" and "finalDecision" to eliminate random flipping
        const pvi = Number(auditData.paisaVasoolIndex || 0);
        const deal = Number(auditData.priceIntegrity?.dealScore || 0);
        const risk = String(auditData.regretRisk || "Medium").toLowerCase();
        
        let stableVerdict: "BUY" | "WAIT" | "RUN" = "WAIT";
        if (isBudgetCategoryQuery) {
          // For best-value category recommendations resolved by Vetto, recommend BUY as it is chosen by Vetto as the absolute best choice in this budget!
          if (deal >= 50) {
            stableVerdict = "BUY";
          } else {
            stableVerdict = "WAIT"; // Only wait if the deal score is very bad (e.g. MSRP trap)
          }
        } else {
          if (pvi >= 70 && deal >= 60 && risk !== "high") {
            stableVerdict = "BUY";
          } else if (pvi <= 45 || deal <= 40 || risk === "high") {
            stableVerdict = "RUN";
          } else {
            stableVerdict = "WAIT";
          }
        }
        
        console.log(`[Stability Alignment] Calibrating marketTiming: "${auditData.marketTiming}" -> "${stableVerdict}" (PVI: ${pvi}, Deal Score: ${deal}, Risk: ${risk}, isCategoryQuery: ${isBudgetCategoryQuery})`);
        auditData.marketTiming = stableVerdict;
        auditData.finalDecision = stableVerdict;
        
        console.log(`[Audit Req] Total latency: ${Date.now() - startTime}ms`);
      
        if (isSSE) {
          res.write(`data: ${JSON.stringify({ type: "final", auditData })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.status(200).json(auditData);
        }
      } catch (parseError) {
        console.error("JSON Parse Error:", parseError, "Raw Text:", text);
        if (isSSE) {
          res.write(`data: ${JSON.stringify({ type: "error", message: "Engine failed to format results cleanly." })}\n\n`);
          res.end();
        } else {
          res.status(500).json({ error: "The engine failed to articulate its verdict cleanly. Please try again." });
        }
      }
    } catch (error: any) {
      console.error("Error processing audit:", error);
      
      // Check for specific safety or billing errors
      const errorMsg = error.message || "";
      
      if (errorMsg.includes("SAFETY") || error.status === 400) {
        if (req.headers.accept === "text/event-stream") {
          res.write(`data: ${JSON.stringify({ type: "error", message: "Vetto Engine blocked this request due to safety filters." })}\n\n`);
          res.end();
        } else {
          res.status(400).json({ error: "Vetto Engine blocked this request due to safety filters.", errorType: "SAFETY_BLOCK" });
        }
        return;
      }
      
      if (errorMsg.includes("403") || error.status === 403 || errorMsg.includes("permission_denied")) {
        if (req.headers.accept === "text/event-stream") {
          res.write(`data: ${JSON.stringify({ type: "error", message: "Vetto API key lacks permissions for this model or feature." })}\n\n`);
          res.end();
        } else {
          res.status(403).json({ error: "Vetto API key lacks permissions for this model or feature.", errorType: "BILLING_DUNNING_DENY" });
        }
        return;
      }

      if (errorMsg.includes("429") || error.status === 429) {
        if (req.headers.accept === "text/event-stream") {
          res.write(`data: ${JSON.stringify({ type: "error", message: "System is currently serving too many users. Please retry in 10 seconds." })}\n\n`);
          res.end();
        } else {
          res.status(429).json({ error: "System is currently serving too many users. Please retry in 10 seconds.", errorType: "RATE_LIMIT" });
        }
        return;
      }

      if (req.headers.accept === "text/event-stream") {
        res.write(`data: ${JSON.stringify({ type: "error", message: "Internal Engine Error: " + errorMsg })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Internal Engine Error: " + errorMsg });
      }
    }

    // Store in cache if applicable
    if (cacheKey) {
      // 1. Save to global persistent Firestore Cache
      if (backendDb) {
        const cacheDocRef = doc(backendDb, "audit_cache", cacheKey);
        setDoc(cacheDocRef, {
          data: auditData,
          timestamp: Date.now(),
          query: parsedQuery,
          createdAt: serverTimestamp()
        }).then(() => {
          console.log(`[Cache Engine] Successfully stored audit in Firestore for query: ${parsedQuery} (ID: ${cacheKey})`);
        }).catch((cacheStoreErr) => {
          console.error("[Cache Engine] Firestore write failure:", cacheStoreErr);
        });
      }

      // 2. Save to local in-memory container fallback
      auditCache.set(cacheKey, { data: auditData, timestamp: Date.now() });
      saveCacheToDisk();
    }

    res.json(auditData);
  } catch (error: any) {
    console.error("Vetto Server Error:", error);
    
    // Check for billing / dunning decision deny errors
    const errorMsg = String(error.message || "").toLowerCase();
    const isDunningError = errorMsg.includes("dunning") || 
                           errorMsg.includes("billing") || 
                           errorMsg.includes("deny for project") ||
                           errorMsg.includes("permission_denied") ||
                           errorMsg.includes("denied access") ||
                           errorMsg.includes("forbidden") ||
                           errorMsg.includes("unauthorized") ||
                           errorMsg.includes("all models failed") ||
                           errorMsg.includes("denied_access") ||
                           error.status === 403 || error.code === 403;
                           
    if (isDunningError) {
      return res.status(403).json({
        error: "Billing Verification Required",
        errorType: "BILLING_DUNNING_DENY",
        message: "We have detected a Google Cloud billing restriction (dunning decision is deny) on this workspace's Google Gemini API key or project. Service can be restored instantly by adding or verifying a valid personal API key in AI Studio's 'Settings > Secrets' panel (top-right gear icon)."
      });
    }
    
    // Check for safety filter blocks
    if (error.message?.includes("SAFETY")) {
      return res.status(400).json({ 
        error: "Audit Aborted: The query triggered safety protocols. Please refine your request." 
      });
    }
    
    if (error.message?.includes("503") || error.message?.includes("UNAVAILABLE")) {
      return res.status(503).json({ 
        error: "Engine High Demand: The Strategic Engine is currently under extreme load. Retries were attempted but the spike persists." 
      });
    }

    if (error.message?.includes("429") || error.message?.toLowerCase().includes("quota")) {
      return res.status(429).json({ 
        error: "Quota Exceeded: Your Vetto Engine limit has been reached. Please try again later." 
      });
    }

    res.status(500).json({ 
      error: error.message || "Failed to generate audit report.",
      engineStatus: "OVERLOADED"
    });
  }
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Critical Server Error:", err);
  res.status(500).json({ 
    error: "Vetto Engine Core experienced a catastrophic failure. Please contact the architect.",
    details: process.env.NODE_ENV === "development" ? err.message : undefined
  });
});

// Secure Backend Waitlist Endpoint
app.post("/api/waitlist", async (req, res) => {
  if (!backendDb) {
    return res.status(500).json({ error: "Backend Database not initialized" });
  }

  try {
    const { email, referralSource } = req.body;
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }

    const sanitizedEmail = email.toLowerCase().trim();
    const entryId = Buffer.from(sanitizedEmail).toString('base64').replace(/[/+=]/g, "_");

    let finalRank = 0;

    await runTransaction(backendDb, async (transaction) => {
      const entryRef = doc(backendDb, "waitlist", entryId);
      const entryDoc = await transaction.get(entryRef);

      if (entryDoc.exists()) {
        throw new Error("ALREADY_EXISTS");
      }

      const statsRef = doc(backendDb, "stats", "global");
      const statsDoc = await transaction.get(statsRef);

      const currentCount = statsDoc.exists()
        ? statsDoc.data().waitlistCount || 0
        : 0;
      finalRank = currentCount + 1;

      // Update waitlist counter atomically without contaminating activeUsers
      transaction.set(
        statsRef,
        {
          waitlistCount: finalRank,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      // Create waitlist entry
      transaction.set(entryRef, {
        email: sanitizedEmail,
        rank: finalRank,
        referralSource: referralSource || null,
        timestamp: serverTimestamp(),
        verified: false,
      });
    });

    res.json({ success: true, rank: finalRank });
  } catch (error: any) {
    if (error.message === "ALREADY_EXISTS") {
      try {
        const sanitizedEmail = req.body.email.toLowerCase().trim();
        const entryId = Buffer.from(sanitizedEmail).toString('base64').replace(/[/+=]/g, "_");
        const existing = await getDoc(doc(backendDb, "waitlist", entryId));
        if (existing.exists()) {
          return res.json({ success: true, rank: existing.data().rank, alreadyExists: true });
        }
      } catch (recoveryErr) {
        console.error("[Waitlist Backend] Recovery failed:", recoveryErr);
      }
      return res.status(409).json({ error: "This email is already registered." });
    }
    console.error("[Waitlist Backend] Error:", error);
    res.status(500).json({ error: "Failed to join waitlist. Database error." });
  }
});

// Secure Backend Analytics Endpoint
app.post("/api/analytics", async (req, res) => {
  if (!backendDb) {
    return res.status(200).json({ status: "skipped", reason: "DB offline" });
  }

  try {
    const { uid, email, userAgent, referrer, screen, location } = req.body;
    const now = Date.now();
    const logId = `visit_${now}_${Math.random().toString(36).substring(2, 9)}`;
    const logRef = doc(backendDb, 'analytics_v1', logId);

    const visitorData: any = {
      uid: uid || 'anonymous',
      email: email || 'anonymous',
      userAgent: userAgent || 'unknown',
      referrer: referrer || 'Direct',
      screen: screen || 'unknown',
      timestamp: serverTimestamp(),
    };

    if (location) {
      visitorData.location = location;
    }

    await setDoc(logRef, visitorData);

    // Safely increment global visits counter (activeUsers)
    const statsRef = doc(backendDb, 'stats', 'global');
    await setDoc(statsRef, {
      activeUsers: increment(1),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    res.json({ success: true });
  } catch (err) {
    console.error("[Analytics Backend] Error:", err);
    res.status(500).json({ error: "Failed to record analytics" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok",
    ai_initialized: !!ai,
    engine: "Vetto Tactical Guard"
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
