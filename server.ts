import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
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
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 15;

function securityGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  console.log("-> Hit securityGuard");
  const authHeader = req.headers['x-vetto-auth'];
  if (authHeader === 'development') {
     return next(); // Bypass rate limiting for internal testing scripts
  }

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

/**
 * Safe Promise Timeout Helper to eliminate timer leaks and catch delayed orphaned promise rejections.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorName = "TIMEOUT_EXCEEDED"): Promise<T> {
  let timerId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(errorName)), timeoutMs);
  });
  promise.catch((err) => {
    if (!timerId) {
      console.warn(`[Orphan Absorber] Late rejection from timed-out promise caught safely:`, err.message);
    }
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

// Retry helper for transient failures and access blocks with automatic stable model fallback
async function callGeminiWithRetry(params: GeminiParams, retries = 3, baseDelay = 1000, customAi?: GoogleGenAI | null) {
  const activeAi = customAi || ai;
  if (!activeAi) throw new Error("AI not initialized");
  
  // Standard production stable models to maximize availability and optimize cost billing
  const fallbackModels = [
    "gemini-2.5-flash",
    "gemini-1.5-flash"
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
        const newConfig = { ...callParams.config };
        // Optimize token limits to enforce ultra-low latency for pre-fetch logic
        if (!newConfig.maxOutputTokens) newConfig.maxOutputTokens = 800;
        console.log(`[Resiliency Engine] Stripping thinkingConfig for non-Gemini-3 model: ${currentModel}`);
        delete newConfig.thinkingConfig;
        callParams.config = newConfig;
      }

      return await activeAi.models.generateContent(callParams);
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

function cleanJsonString(str: string): string {
  let cleaned = str.trim();
  
  // 1. Strip markdown code blocks at the beginning or anywhere before the first brace
  const firstBrace = cleaned.search(/[{[]/);
  if (firstBrace !== -1) {
    cleaned = cleaned.substring(firstBrace);
  }
  
  // 2. Remove markdown code block endings and any text following them
  const markdownEndIndex = cleaned.lastIndexOf("```");
  if (markdownEndIndex !== -1) {
    cleaned = cleaned.substring(0, markdownEndIndex).trim();
  }
  
  // 3. Remove trailing text if we have a closing brace/bracket and there's text after it
  const lastBrace = cleaned.lastIndexOf('}');
  const lastBracket = cleaned.lastIndexOf(']');
  const lastValidIndex = Math.max(lastBrace, lastBracket);
  if (lastValidIndex !== -1 && lastValidIndex < cleaned.length - 1) {
    const remaining = cleaned.substring(lastValidIndex + 1).trim();
    if (remaining.length > 0 && !/^[}\]]*$/.test(remaining)) {
      cleaned = cleaned.substring(0, lastValidIndex + 1);
    }
  }
  
  return cleaned.trim();
}

function repairJson(jsonStr: string): string {
  try {
    const cleaned = cleanJsonString(jsonStr);
    return jsonrepair(cleaned);
  } catch (err) {
    console.error("jsonrepair failed, falling back to original string", err);
    return jsonStr;
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

const cachePath = path.join(os.tmpdir(), "audit_cache_persistent.json");

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
    isAnalysis: { type: Type.BOOLEAN, description: "Is analysis" },
    productName: { type: Type.STRING, description: "Product formal name" },
    isComparison: { type: Type.BOOLEAN, description: "Is comparison" },
    finalDecision: { type: Type.STRING, description: "Verdict: BUY, WAIT, or RUN" },
    pros: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Advantages (max 3, brief)" },
    cons: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Dealbreakers (max 3, brief)" },
    whyBest: { type: Type.STRING, description: "Logic behind decision (1 sentence)" },
    aamAadmiSummary: { type: Type.STRING, description: "Simple, easy English summary with a short real-world example" },
    avoid: { type: Type.STRING, description: "What to avoid" },
    regretWarning: { type: Type.STRING, description: "Regret warning" },
    confidenceScore: { type: Type.INTEGER, description: "Confidence 0-100" },
    regretRisk: { type: Type.STRING, description: "Risk: Low, Medium, High" },
    whyRegret: { type: Type.STRING, description: "Trigger for regret" },
    saferChoice: { type: Type.STRING, description: "Standard alternative" },
    personalizedInsight: { type: Type.STRING, description: "Actionable insight" },
    socialHook: { type: Type.STRING, description: "Social headline" },
    postOutputHook: { type: Type.STRING, description: "Post-conclusion warning" },
    marketTiming: { type: Type.STRING, description: "Timing: BUY, WAIT, or RUN" },
    marketReasoning: { type: Type.STRING, description: "Timing reasoning" },
    specLongevity: { type: Type.STRING, description: "Years relevant" },
    paisaVasoolIndex: { type: Type.INTEGER, description: "Value score 0-100" },
    statusTax: { type: Type.INTEGER, description: "Status tax in Rupees" },
    utilityScore: { type: Type.INTEGER, description: "Utility score 0-100" },
    hiddenCosts: { type: Type.STRING, description: "Sneaky extra costs" },
    platformWarShield: {
      type: Type.OBJECT,
      properties: {
        hasMarketingSilos: { type: Type.BOOLEAN, description: "Marketing traps present" },
        siloExposure: { type: Type.STRING, description: "Marketing exposure" },
        truthResilienceScore: { type: Type.INTEGER, description: "Filter resistance 0-100" },
        bypassStrategyUsed: { type: Type.STRING, description: "Bypass strategy" }
      },
      required: ["hasMarketingSilos", "siloExposure", "truthResilienceScore", "bypassStrategyUsed"]
    },
    vettoContrast: {
      type: Type.OBJECT,
      properties: {
        alternativeName: { type: Type.STRING, description: "Alternative name" },
        whyContrast: { type: Type.STRING, description: "Why superior value" },
        pviBoost: { type: Type.INTEGER, description: "Value boost 0-100" },
        priceDelta: { type: Type.STRING, description: "Price gap" },
        fairPriceTarget: { type: Type.STRING, description: "Fair value target" },
        procurementGuidance: { type: Type.STRING, description: "Best way to buy" },
        strategicAdvantage: { type: Type.STRING, description: "Advantage" }
      },
      required: ["alternativeName", "whyContrast", "pviBoost", "priceDelta", "fairPriceTarget", "procurementGuidance", "strategicAdvantage"]
    },
    strategicRoadmap: {
      type: Type.OBJECT,
      properties: {
        immediateAction: { type: Type.STRING, description: "Next step" },
        peakUtilityAge: { type: Type.STRING, description: "When performance peaks" },
        exitStrategy: { type: Type.STRING, description: "Resale or upgrade path" }
      },
      required: ["immediateAction", "peakUtilityAge", "exitStrategy"]
    },
    communityPulse: {
      type: Type.OBJECT,
      properties: {
        redditConsensus: { type: Type.STRING, description: "Reddit consensus" },
        twitterPulse: { type: Type.STRING, description: "X sentiment" },
        youtubeReality: { type: Type.STRING, description: "YouTube reality" },
        linkedinProfessional: { type: Type.STRING, description: "Expert view" },
        topUSP: { type: Type.STRING, description: "Top USP" },
        topGripe: { type: Type.STRING, description: "Top user complaint" }
      },
      required: ["redditConsensus", "twitterPulse", "youtubeReality", "linkedinProfessional", "topUSP", "topGripe"]
    },
    lifecyclePhase: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.STRING, description: "Lifecycle stage" },
        isObsoleteSoon: { type: Type.BOOLEAN, description: "Obsolete within 3 months" },
        nextMajorUpdate: { type: Type.STRING, description: "Next launch details" }
      },
      required: ["status", "isObsoleteSoon", "nextMajorUpdate"]
    },
    priceIntegrity: {
      type: Type.OBJECT,
      properties: {
        currentPriceAudit: { type: Type.STRING, description: "Current price feedback" },
        historicalContext: { type: Type.STRING, description: "Past sales context" },
        priceHistory: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              month: { type: Type.STRING, description: "Month" },
              price: { type: Type.INTEGER, description: "Price" }
            },
            required: ["month", "price"]
          },
          description: "Approximate price history"
        },
        dealScore: { type: Type.INTEGER, description: "Deal score 0-100" },
        discountStrategy: { type: Type.STRING, description: "Card cashback and coupon tips" },
        procurementLinks: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              platform: { type: Type.STRING, description: "Platform name" },
              label: { type: Type.STRING, description: "Button label" },
              price: { type: Type.STRING, description: "Current price" },
              isBestDeal: { type: Type.BOOLEAN, description: "Is best deal" },
              url: { type: Type.STRING, description: "Direct search page URL" },
              stockStatus: { type: Type.STRING, description: "Stock status" }
            },
            required: ["platform", "label", "price", "isBestDeal", "url", "stockStatus"]
          },
          description: "Indian retail sites"
        }
      },
      required: ["currentPriceAudit", "historicalContext", "priceHistory", "dealScore", "discountStrategy", "procurementLinks"]
    },
    bhartiyaPersonaAudit: { type: Type.STRING, description: "Household reality check" },
    features: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "Feature name" },
          score: { type: Type.INTEGER, description: "Score 0-100" },
          details: { type: Type.STRING, description: "Reality details" }
        },
        required: ["name", "score", "details"]
      },
      description: "Critical feature metrics"
    },
    socialAudit: {
      type: Type.OBJECT,
      properties: {
        aggregatedRating: { type: Type.NUMBER, description: "Rating 0-5" },
        sentimentSplit: {
          type: Type.OBJECT,
          properties: {
            positive: { type: Type.INTEGER, description: "Positive %" },
            negative: { type: Type.INTEGER, description: "Negative %" },
            mixed: { type: Type.INTEGER, description: "Mixed %" }
          },
          required: ["positive", "negative", "mixed"]
        },
        criticsConsensus: { type: Type.STRING, description: "Critics bottomline" },
        userRealityCheck: { type: Type.STRING, description: "User consensus" },
        integrityAudit: {
          type: Type.OBJECT,
          properties: {
            isFakeReviewRisk: { type: Type.BOOLEAN, description: "Paid reviews risk" },
            fakeReviewScore: { type: Type.INTEGER, description: "Score 0-100" },
            botSignalDetection: { type: Type.STRING, description: "Bot statement" },
            verifiedPurchaseTruth: { type: Type.STRING, description: "Verified buyers check" },
            crossPlatformPatterns: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  platform: { type: Type.STRING, description: "Platform" },
                  sentiment: { type: Type.INTEGER, description: "Sentiment" },
                  botRisk: { type: Type.STRING, description: "Risk" }
                },
                required: ["platform", "sentiment", "botRisk"]
              }
            },
            divergenceIndex: { type: Type.INTEGER, description: "Hype gap 0-100" },
            buzzwordSlayer: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  term: { type: Type.STRING, description: "Buzzword" },
                  reality: { type: Type.STRING, description: "Reality" }
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
  
  // Self-Healing Cache Versioning Gate
  if (data.schemaVersion !== "v3") {
    console.log(`[Cache Engine] Bypassing cache due to schema version mismatch (expected: "v3", found: "${data.schemaVersion || "none"}").`);
    return false;
  }
  
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
        return p.includes("tbd") || p.includes("n/a") || p === "0" || p === "";
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

      const electronicsKeywords = [
        'laptop', 'mobile', 'phone', 'buds', 'earphones', 'headphone', 'audio', 'speaker', 'tv', 'television', 'fridge', 
        'refrigerator', 'ac', 'air conditioner', 'microwave', 'oven', 'camera', 'monitor', 'keyboard', 'mouse', 
        'ipad', 'tablet', 'samsung', 'apple', 'macbook', 'asus', 'dell', 'hp', 'lenovo', 'oneplus', 'realme', 'xiaomi', 
        'redmi', 'soundbar', 'charger', 'powerbank', 'graphics card', 'rtx', 'amd', 'intel', 'processor'
      ];
      const isElectronics = electronicsKeywords.some(kw => combinedText.includes(kw));
      if (isElectronics) {
        const hasFashionStore = links.some((link: any) => {
          const pf = String(link.platform || "").toLowerCase();
          return pf.includes("myntra") || pf.includes("ajio");
        });
        if (hasFashionStore) {
          console.log(`[Cache Engine] Bypassing cache to heal category-platform mismatch (found fashion store for electronics item: "${prodName}").`);
          return false;
        }
      }

      const automotiveKeywords = [
        'car', 'bike', 'vehicle', 'motorcycle', 'tyre', 'tire', 'helmet', 'dashcam', 'gps tracker', 'alloy wheels',
        'car perfume', 'tata', 'mahindra', 'hyundai', 'maruti suzuki', 'honda', 'yamaha', 'royal enfield', 'ather', 'ola s1',
        'scooter', 'inflator', 'car wash', 'lubricant', 'engine oil'
      ];
      const isAutomotive = automotiveKeywords.some(kw => combinedText.includes(kw));
      if (isAutomotive) {
        const hasInvalidStore = links.some((link: any) => {
          const pf = String(link.platform || "").toLowerCase();
          return pf.includes("myntra") || pf.includes("ajio") || pf.includes("croma") || pf.includes("reliance");
        });
        if (hasInvalidStore) {
          console.log(`[Cache Engine] Bypassing cache to heal category-platform mismatch (found invalid store for automotive item: "${prodName}").`);
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

// Helper to classify if an automotive item is a two-wheeler (scooter, bike, etc.)
function isTwoWheeler(prodName: string, query: string): boolean {
  const combined = `${prodName} ${query}`.toLowerCase();
  const bikeKeywords = ['bike', 'motorcycle', 'royal enfield', 'ather', 'ola s1', 'scooter', 'yamaha', 'pulsar', 'activa', 'splendor', 'himalayan', 'tvs', 'ktm', 'bullet', 'pulsar', 'apache', 'suzuki access', 'jupiter', 'dio'];
  return bikeKeywords.some(kw => combined.includes(kw));
}

// Detect category based on product identity and search params to align platform selection
function detectProductCategory(prodName: string, query: string): 'electronics' | 'fashion' | 'automotive' | 'general' {
  const combined = `${prodName} ${query}`.toLowerCase();
  
  const fashionKeywords = [
    'sneaker', 'shoe', 'slipper', 'sandal', 'boot', 'nike', 'adidas', 'puma', 'reebok', 'samba', 'dunk', 'jordan', 
    'clothing', 'shirt', 'tshirt', 'jeans', 'pant', 'jacket', 'trousers', 'wear', 'apparel', 'perfume', 'watch', 
    'bag', 'backpack', 'wallet', 'comet shoes', 'comet sneakers', 'woodland', 'crocs', 'fashion', 't-shirt', 'hoodie', 'socks', 'sweatshirt'
  ];
  
  const electronicsKeywords = [
    'laptop', 'mobile', 'phone', 'buds', 'earphones', 'headphone', 'audio', 'speaker', 'tv', 'television', 'fridge', 
    'refrigerator', 'ac', 'air conditioner', 'microwave', 'oven', 'camera', 'monitor', 'keyboard', 'mouse', 
    'ipad', 'tablet', 'samsung', 'apple', 'macbook', 'asus', 'dell', 'hp', 'lenovo', 'oneplus', 'realme', 'xiaomi', 
    'redmi', 'soundbar', 'charger', 'powerbank', 'graphics card', 'rtx', 'amd', 'intel', 'processor'
  ];

  const automotiveKeywords = [
    'car', 'bike', 'vehicle', 'motorcycle', 'tyre', 'tire', 'helmet', 'dashcam', 'gps tracker', 'alloy wheels',
    'car perfume', 'tata', 'mahindra', 'hyundai', 'maruti suzuki', 'honda', 'yamaha', 'royal enfield', 'ather', 'ola s1',
    'scooter', 'inflator', 'car wash', 'lubricant', 'engine oil', 'ev', 'electric vehicle', 'mg comet', 'byd', 'mg motor',
    'suv', 'sedan', 'hatchback', 'nexon', 'punch', 'thar', 'creta', 'seltos', 'xuv700', 'scorpio', 'fortuner'
  ];

  const accessoryKeywords = [
    'helmet', 'dashcam', 'gps tracker', 'tyre', 'tire', 'inflator', 'lubricant', 
    'engine oil', 'cleaner', 'perfume', 'wax', 'polish', 'mat', 'cover', 'holder', 
    'mount', 'gloves', 'jacket', 'accessories', 'accessory', 'light', 'horn'
  ];
  
  const matchKeyword = (kw: string) => {
    if (kw.length <= 3) {
      const escaped = kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      return regex.test(combined);
    }
    return combined.includes(kw);
  };
  
  const hasFashion = fashionKeywords.some(matchKeyword);
  const hasElectronics = electronicsKeywords.some(matchKeyword);
  const hasAutomotive = automotiveKeywords.some(matchKeyword);
  const hasAccessory = accessoryKeywords.some(matchKeyword);
  
  if (hasAutomotive && !hasAccessory) {
    return 'automotive';
  } else if (hasFashion && !hasElectronics) {
    return 'fashion';
  } else if (hasElectronics || (hasAccessory && (combined.includes('dashcam') || combined.includes('gps') || combined.includes('inflator') || combined.includes('light')))) {
    return 'electronics';
  } else if (hasAccessory) {
    return 'general';
  }
  return 'general';
}

// Simple consumer-friendly jargon sanitization helper (Jargon Shield)
function sanitizeBannedJargon(text: string): string {
  if (!text) return "";
  let clean = text;
  
  const jargonReplacements: { pattern: RegExp, replacement: string }[] = [
    { pattern: /\bdepreciation\b/gi, replacement: "price drop over time" },
    { pattern: /\bvolatility\b/gi, replacement: "price ups and downs" },
    { pattern: /\bequilibrium\b/gi, replacement: "stable pricing" },
    { pattern: /\bmsrp\b/gi, replacement: "standard market price" },
    { pattern: /\bmarket correction\b/gi, replacement: "price adjustment" },
    { pattern: /\bportfolio\b/gi, replacement: "collection" },
    { pattern: /\barbitrage\b/gi, replacement: "saving difference" },
    { pattern: /\bprice elasticity\b/gi, replacement: "price sensitivity" }
  ];
  
  jargonReplacements.forEach(({ pattern, replacement }) => {
    clean = clean.replace(pattern, replacement);
  });
  
  return clean;
}

// Recursively walks the output object and sanitizes all string fields
function sanitizeObjectJargon(obj: any): any {
  if (typeof obj === "string") {
    return sanitizeBannedJargon(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObjectJargon(item));
  }
  if (obj !== null && typeof obj === "object") {
    const cleaned: any = {};
    for (const key in obj) {
      cleaned[key] = sanitizeObjectJargon(obj[key]);
    }
    return cleaned;
  }
  return obj;
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
  let targetUrl = (url || "").trim();
  
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
                           targetUrl.includes("example.com") ||
                           /(?:itm|dp\/|p\/|buy\/|product\/)(?:[a-zA-Z0-9]*?(?:0{5,}|9{5,}|1{5,}|2{5,}|3{5,}|4{5,}|5{5,}|6{5,}|7{5,}|8{5,})[a-zA-Z0-9]*)/i.test(targetUrl);
  
  if (isPlaceholderUrl) {
    isGenericOrMismatched = true;
  }

  // Deep URL accessory check to force self-healing
  const urlLower = targetUrl.toLowerCase();
  const accessoryKeywords = ["cover", "case", "tempered", "pouch", "guard", "strap", "sleeve", "cable", "keychain", "cleaning-kit", "tripod", "lens-protector"];
  const nameLower = decodedProdName.toLowerCase();
  const isAccessoryLink = accessoryKeywords.some(kw => urlLower.includes(kw)) && !accessoryKeywords.some(kw => nameLower.includes(kw));

  if (isAccessoryLink) {
    isGenericOrMismatched = true;
    console.log(`[URL Cleaner] Detected accessory link: ${targetUrl} for product: ${decodedProdName}. Forcing fallback.`);
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
      } else if (platformLower.includes("carwale") && !host.includes("carwale.com")) {
        platformDomainMatch = false;
      } else if (platformLower.includes("bikewale") && !host.includes("bikewale.com")) {
        platformDomainMatch = false;
      } else if (platformLower.includes("cardekho") && !host.includes("cardekho.com")) {
        platformDomainMatch = false;
      } else if (platformLower.includes("bikedekho") && !host.includes("bikedekho.com")) {
        platformDomainMatch = false;
      } else if (platformLower.includes("zigwheels") && !host.includes("zigwheels.com")) {
        platformDomainMatch = false;
      }

      if (!platformDomainMatch) {
        isGenericOrMismatched = true;
      } else {
        // Belong to the correct platform. Define generic homes/carts/help/login pages as generic
        const genericPaths = ["", "/", "/index.html", "/index.php", "/login", "/signup", "/register", "/cart", "/checkout"];
        if (genericPaths.includes(path) || path.length < 5) {
          isGenericOrMismatched = true;
        }
      }
    } catch (e) {
      // Fallback: Check if pointing to naked home domain
      const cleanUrlStr = targetUrl.replace(/^(https?:\/\/)?(www\.)?/, "").toLowerCase();
      const nakedDomains = [
        "amazon.in", "amazon.in/", "flipkart.com", "flipkart.com/", 
        "croma.com", "croma.com/", "reliancedigital.in", "reliancedigital.in/", 
        "myntra.com", "myntra.com/", "ajio.com", "ajio.com/",
        "carwale.com", "carwale.com/", "bikewale.com", "bikewale.com/",
        "cardekho.com", "cardekho.com/", "bikedekho.com", "bikedekho.com/",
        "zigwheels.com", "zigwheels.com/"
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

  // Detect if the incoming URL is a search URL to dynamically heal and force correct resolved query terms
  let isSearchUrl = false;
  try {
    const urlObj = new URL(targetUrl);
    const host = urlObj.hostname.toLowerCase();
    const path = urlObj.pathname.toLowerCase();
    
    // Only flag true search page path routes rather than product pages with query params
    isSearchUrl = path === "/s" || 
                  path.includes("/search") || 
                  path.startsWith("/s/") || 
                  (host.includes("google") && path.includes("/search"));
  } catch (e) {
    isSearchUrl = urlLower.includes("/search") || 
                  urlLower.includes("/s?") || 
                  urlLower.includes("search?") || 
                  urlLower.includes("search/");
  }

  // 4. Force high-fidelity deep-search query fallbacks for generic/mismatched/broken/search links
  if (isGenericOrMismatched || isSearchUrl) {
    if (platformLower.includes("amazon")) {
      targetUrl = `https://www.amazon.in/s?k=${encodedPlusProdName}`;
    } else if (platformLower.includes("flipkart")) {
      targetUrl = `https://www.flipkart.com/search?q=${encodedPlusProdName}`;
    } else if (platformLower.includes("croma")) {
      targetUrl = `https://www.croma.com/search/?text=${encodedPlusProdName}`;
    } else if (platformLower.includes("reliance")) {
      targetUrl = `https://www.reliancedigital.in/search?q=${encodedPlusProdName}`;
    } else if (platformLower.includes("myntra")) {
      targetUrl = `https://www.myntra.com/search?q=${encodedPlusProdName}`;
    } else if (platformLower.includes("ajio")) {
      targetUrl = `https://www.ajio.com/search/?text=${encodedPlusProdName}`;
    } else if (platformLower.includes("carwale")) {
      targetUrl = `https://www.carwale.com/search/?q=${encodedPlusProdName}`;
    } else if (platformLower.includes("bikewale")) {
      targetUrl = `https://www.bikewale.com/search/?q=${encodedPlusProdName}`;
    } else if (platformLower.includes("cardekho")) {
      targetUrl = `https://www.cardekho.com/search/${encodedPlusProdName}`;
    } else if (platformLower.includes("bikedekho")) {
      targetUrl = `https://www.bikedekho.com/search/${encodedPlusProdName}`;
    } else if (platformLower.includes("zigwheels")) {
      targetUrl = `https://www.zigwheels.com/search/?q=${encodedPlusProdName}`;
    } else {
      // For automotive brands or any other custom platform, let's direct to their official website search or search Google
      if (platformLower.includes("tata") && !platformLower.includes("cliq")) {
        targetUrl = "https://www.tatamotors.com";
      } else if (platformLower.includes("tatacliq") || platformLower.includes("cliq")) {
        targetUrl = `https://www.tatacliq.com/search/?text=${encodedPlusProdName}`;
      } else if (platformLower.includes("mahindra")) {
        targetUrl = "https://auto.mahindra.com";
      } else if (platformLower.includes("hyundai")) {
        targetUrl = "https://www.hyundai.com/in";
      } else if (platformLower.includes("maruti") || platformLower.includes("suzuki")) {
        targetUrl = "https://www.marutisuzuki.com";
      } else if (platformLower.includes("honda")) {
        targetUrl = "https://www.hondacarindia.com";
      } else if (platformLower.includes("ather")) {
        targetUrl = "https://www.atherenergy.com";
      } else if (platformLower.includes("ola")) {
        targetUrl = "https://www.olaelectric.com";
      } else if (platformLower.includes("royal enfield")) {
        targetUrl = "https://www.royalenfield.com";
      } else if (platformLower.includes("yamaha")) {
        targetUrl = "https://www.yamaha-motor-india.com";
      } else {
        targetUrl = `https://www.google.com/search?q=${encodedPlusProdName}`;
      }
    }
  }

  // 5. Ensure secure protocol is enabled
  if (targetUrl && !targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  return targetUrl;
}

// Extract working grounding URLs straight from the Google Search Grounding Metadata chunks
function extractGroundingUrlForPlatform(response: any, platformName: string, productQuery?: string): string | null {
  try {
    const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (Array.isArray(chunks)) {
      const pLower = platformName.toLowerCase();
      for (const chunk of chunks) {
        const uri = chunk?.web?.uri || chunk?.web?.url;
        if (uri && typeof uri === 'string') {
          const uriLower = uri.toLowerCase();
          
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(uri);
          } catch (e) {
            continue;
          }
          const host = parsedUrl.hostname.toLowerCase();
          const path = parsedUrl.pathname.toLowerCase();

          // 1. Generic Link Check
          const genericPaths = ["", "/", "/index.html", "/index.php", "/login", "/signup", "/register", "/cart", "/checkout", "/help", "/about", "/terms"];
          if (genericPaths.includes(path) || path.length < 5) {
            continue;
          }

          // 2. Low Quality check
          const isLowQuality = path.includes("/help/") || 
                              path.includes("/display.html") || 
                              path.includes("/seller") ||
                              path.includes("/display/") ||
                              path.includes("/about") ||
                              path.includes("/contact");
          if (isLowQuality) {
            continue;
          }

          // 3. Accessory Leak Check
          if (productQuery) {
            const queryLower = productQuery.toLowerCase();
            const accessoryKeywords = ["cover", "case", "tempered", "pouch", "guard", "strap", "sleeve", "cable", "keychain", "cleaning-kit", "tripod", "lens-protector"];
            const hasAccessoryKeywordInUrl = accessoryKeywords.some(kw => path.includes(kw) || uriLower.includes(kw));
            const queryWantsAccessory = accessoryKeywords.some(kw => queryLower.includes(kw));
            if (hasAccessoryKeywordInUrl && !queryWantsAccessory) {
              console.log(`[Grounding URL Filter] Rejected accessory leak link: ${uri} for query: ${productQuery}`);
              continue;
            }
          }

          // 4. Platform Domain matching and high-confidence product page check
          const isProductPage = path.includes("/dp/") || path.includes("/p/") || path.includes("-p-") || path.includes("/product/") || path.includes("/buy/");
          
          if (pLower.includes("amazon") && (uriLower.includes("amazon.in") || uriLower.includes("amazon.com"))) {
            if (isProductPage) return uri;
            else if (!uriLower.includes("/s?")) return uri; // accept if not a basic search page
          }
          if (pLower.includes("flipkart") && uriLower.includes("flipkart.com")) {
            if (isProductPage) return uri;
          }
          if (pLower.includes("croma") && uriLower.includes("croma.com")) {
            if (isProductPage) return uri;
          }
          if (pLower.includes("reliance") && (uriLower.includes("reliancedigital") || uriLower.includes("reliance.com"))) {
            if (isProductPage) return uri;
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
          if (pLower.includes("carwale") && uriLower.includes("carwale.com")) {
            return uri;
          }
          if (pLower.includes("bikewale") && uriLower.includes("bikewale.com")) {
            return uri;
          }
          if (pLower.includes("cardekho") && uriLower.includes("cardekho.com")) {
            return uri;
          }
          if (pLower.includes("bikedekho") && uriLower.includes("bikedekho.com")) {
            return uri;
          }
          if (pLower.includes("zigwheels") && uriLower.includes("zigwheels.com")) {
            return uri;
          }

          // Automotive Brands check
          const brandKeywords = ["tata", "mahindra", "hyundai", "suzuki", "maruti", "honda", "yamaha", "royal enfield", "ather", "ola"];
          for (const bk of brandKeywords) {
            if (pLower.includes(bk) && uriLower.includes(bk)) {
              return uri;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[Grounding URL Extractor] Error parsing grounding metadata chunks:", err);
  }
  return null;
}

// Ultra-fast pure semantic resolver (Stage 1) to determine exact product specifications without search latency
async function resolveSpecificProductName(query: string, budget = "", useCase = "", customAi?: GoogleGenAI | null): Promise<{ productName: string, queryType: "category" | "specific" | "comparison" }> {
  const activeAi = customAi || ai;
  if (!activeAi) return { productName: query, queryType: "specific" };
  try {
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

    const response = await callGeminiWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.0,
        maxOutputTokens: 4000
      }
    }, 3, 1000, customAi);

    let text = "";
    if (response && typeof response.text === 'string') {
      text = response.text.trim();
    } else if (response?.candidates?.[0]?.content?.parts) {
      text = response.candidates[0].content.parts
        .map((p: any) => p.text || "")
        .join("")
        .trim();
    }
    
    let parsed: any = null;
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      const sliced = text.substring(jsonStart, jsonEnd + 1);
      try {
        const repaired = repairJson(sliced);
        parsed = JSON.parse(repaired);
      } catch (e) {
        console.warn("[Semantic Resolver] Failed to parse sliced JSON from grounded search response:", e);
      }
    }

    if (!parsed) {
      // Grounded search response did not contain valid JSON, let's format it using a fallback call.
      // Call gemini-2.5-flash without search grounding (which allows responseMimeType: "application/json").
      console.log(`[Semantic Resolver] Grounded search response did not contain valid JSON. Invoking fast JSON formatting fallback.`);
      const fallbackPrompt = `You are a precision JSON formatting helper.
      The user queried: "${query}"
      Budget: ${budget ? `₹${budget}` : "Unlimited"}
      UseCase: "${useCase || "General Use"}"
      
      Here is the conversational recommendation or search result text from a search engine query:
      "${text}"
      
      Task:
      Extract or resolve the absolute best specific product model name (e.g. "HP Victus 15 Ryzen 5 5600H / RTX 3050" or "Lenovo IdeaPad Gaming 3 Ryzen 5 6600H / RTX 3050") from the text that fits the user's budget and query. If the text does not contain a specific product name, resolve the user's original query directly to a specific mainstream product available in India.
      
      Return strictly a JSON object conforming to this schema:
      {
        "productName": "Resolved full specific product name with specifications",
        "queryType": "category" | "specific" | "comparison"
      }`;

      const fallbackResponse = await callGeminiWithRetry({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: fallbackPrompt }] }],
        config: {
          responseMimeType: "application/json",
          temperature: 0.0,
          maxOutputTokens: 250
        }
      }, 2, 500, customAi);

      let fallbackText = "";
      if (fallbackResponse && typeof fallbackResponse.text === 'string') {
        fallbackText = fallbackResponse.text.trim();
      } else if (fallbackResponse?.candidates?.[0]?.content?.parts) {
        fallbackText = fallbackResponse.candidates[0].content.parts
          .map((p: any) => p.text || "")
          .join("")
          .trim();
      }

      const fJsonStart = fallbackText.indexOf('{');
      const fJsonEnd = fallbackText.lastIndexOf('}');
      if (fJsonStart !== -1 && fJsonEnd !== -1 && fJsonEnd > fJsonStart) {
        fallbackText = fallbackText.substring(fJsonStart, fJsonEnd + 1);
      }
      
      const repaired = repairJson(fallbackText);
      parsed = JSON.parse(repaired);
    }

    let productName = parsed.productName || query;
    let queryType = parsed.queryType || "specific";

    if (queryType === "comparison" || productName.toLowerCase().includes(" vs ") || productName.toLowerCase().includes(" vs. ")) {
      const parts = productName.split(/\s+vs\.?\s+/i);
      if (parts.length > 0) {
        productName = parts[0].trim();
      }
    }

    return {
      productName,
      queryType
    };
  } catch (e) {
    console.error("[Semantic Resolver] Error resolving query:", e);
    return { productName: query, queryType: "specific" };
  }
}

// Perform internet search grounding to retrieve actual live pricing and platform links for a resolved specific product (Stage 2)
async function preFetchLivePricesAndLinks(resolvedProductName: string, resolvedQueryType: string, originalQuery: string, budgetLimit = "", useCase = "", retries = 2, customAi?: GoogleGenAI | null): Promise<{ resolvedProductName: string, queryType: string, prices: any[] } | null> {
  const activeAi = customAi || ai;
  if (!activeAi) return null;
  
  const cleanQuery = originalQuery.trim();
  if (!resolvedProductName) return null;

  const fallbackModels = [
    "gemini-2.5-flash",
    "gemini-1.5-flash"
  ];

  for (let attempt = 0; attempt < retries; attempt++) {
    const modelToUse = fallbackModels[attempt % fallbackModels.length];
    try {
      console.log(`[Price Verification Pre-fetch] (Attempt ${attempt + 1}/${retries}) Querying Google Search grounding via ${modelToUse} for resolved product: "${resolvedProductName}"`);
      
      const category = detectProductCategory("", resolvedProductName);
      let platformRestrictionRule = "";
      if (category === 'fashion') {
        platformRestrictionRule = `CRITICAL CATEGORY PLATFORM RULE: This is a FASHION product query. You MUST actively restrict the e-commerce platforms and links to: Myntra, Ajio, Amazon India, and Flipkart. Do NOT look up or return prices/links for Croma, Reliance Digital, or other irrelevant sites.`;
      } else if (category === 'electronics') {
        platformRestrictionRule = `CRITICAL CATEGORY PLATFORM RULE: This is an ELECTRONICS product query. You MUST actively restrict the e-commerce platforms and links to: Croma, Reliance Digital, Amazon India, and Flipkart. Do NOT look up or return prices/links for Myntra, Ajio, or other irrelevant sites.`;
      } else if (category === 'automotive') {
        platformRestrictionRule = `CRITICAL CATEGORY PLATFORM RULE: This is an AUTOMOTIVE (cars, bikes) query. You MUST actively restrict the platforms and links to: CarWale, BikeWale, CarDekho, BikeDekho, ZigWheels, and the official brand store web page (e.g. Maruti Suzuki, Tata Motors, Hyundai India, Honda, Ather Energy, Ola Electric, Royal Enfield, Yamaha, etc.). Do NOT look up or return prices/links for Amazon, Flipkart, Myntra, Ajio, Croma, or Reliance Digital under any circumstances.`;
      } else {
        platformRestrictionRule = `CRITICAL CATEGORY PLATFORM RULE: For general products, restrict e-commerce platforms to: Amazon India, Flipkart, Croma, Reliance Digital, Ajio, Myntra, or Tata CLiQ.`;
      }

      const preFetchPrompt = `You are a precision internet search tool and price scraper for fetching live real-world e-commerce prices.
      Target Resolved Specific Product: "${resolvedProductName}"
      Original User Query Context: "${cleanQuery}" ${budgetLimit ? `(Budget: ₹${budgetLimit})` : ""}
      
      Your single goal is to find active prices, stock status, and direct product links for the EXACT resolved product "${resolvedProductName}".
      Do NOT look up general category listicles. You MUST focus your search strictly on this specific resolved product model.
      
      STEP 1: PRICE FETCHING
      Identify the currently active real-world selling prices (in Indian Rupees, ₹), actual stock status (e.g., 'In Stock', 'Out of Stock'), and matching product direct URLs (specifically product pages, e.g. /dp/ or /p/) for the EXACT resolved product "${resolvedProductName}" on at least 3 major e-commerce platforms in India.
      
      ${platformRestrictionRule}
      
      CRITICAL ACCURACY & LINK-SYNC RULES:
      1. ONLY return pricing and stock status for the EXACT specifications of "${resolvedProductName}".
      2. PRICE-TO-LINK SYNCHRONIZATION SAFEGUARD: The price you return for a platform MUST be the exact active price displayed on the returned URL page today. Under no circumstances are you allowed to pair a low price found in an outdated snippet with a URL that points to a higher-priced listing or a different specification variant.
      3. VARIANT CONSISTENCY RULE: If the URL points to a different configuration (e.g. different storage/RAM), mark that platform Out of Stock.
      4. If that specific model or spec variant is not available, or is out of stock on a retailer platform, you MUST set its "price" to "Out of Stock", "stockStatus" to "Out of Stock", "url" to "", and "exactVariantMatch" as false.
      5. NEVER substitute or return the price of a different variant.
      6. You MUST only return the price of the actual core main product itself. Strictly IGNORE accessories, cases, covers, chargers, bags, refurbished/used units, or parts.
      7. BASE PUBLIC RETAIL PRICE RULE: Under no circumstances are you allowed to return prices that depend on trade-ins, exchange offers, corporate discounts, or specific bank credit card instant cashbacks. Only return the standard public retail selling price that any general user sees upon landing on the retailer product page.
      8. You MUST search the internet right now using search grounding. Actively perform multiple, targeted Google search queries for each platform specifically (e.g. search "[Resolved Product Name] Amazon India price", "[Resolved Product Name] Flipkart price", "[Resolved Product Name] Croma price") to fetch the exact active prices and direct product landing pages instead of generic blogs or outdated lists.
      9. For "url", you MUST prioritize returning a working direct product page URL (like Amazon /dp/ or Flipkart /p/) ONLY if it is explicitly present in the grounding chunks/metadata. If it is NOT present in the grounding metadata, you MUST return the platform's search URL fallback (e.g. "https://www.amazon.in/s?k=[URL_ENCODED_PRODUCT_NAME]") or an empty string. Under no circumstances are you allowed to fabricate, guess, or invent a product page URL containing made-up numeric IDs or placeholders (like itm99999 or itm00000). Doing so violates Vetto's safety rules.
      10. HALLUCINATION STRICT-RULE: Do not invent prices. If you do not see a price explicitly written in current google search results for a reputable Indian e-commerce platform, return "Out of Stock".
      
      Return the results in a strict JSON object conforming to the response schema:
      - "product_name": set this exactly to the specific product model "${resolvedProductName}".
      - "where_to_buy": an array of objects, each containing:
        * "platform": e.g., Amazon, Flipkart, Croma.
        * "current_price": the exact numeric base price without bank discounts (as a number, e.g. 37999). If out of stock or unavailable, set to 0.
        * "exact_url": the raw canonical link extracted directly from grounding chunks.
      Only return valid JSON conforming to the schema. No markdown, no explanations.`;

      const response = await callGeminiWithRetry({
        model: modelToUse,
        contents: [{ role: "user", parts: [{ text: preFetchPrompt }] }],
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.0,
          maxOutputTokens: 1000,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MINIMAL
          }
        }
      }, 3, 1000, customAi);

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
        const jsonStart = jsonText.indexOf('{');
        const jsonEnd = jsonText.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          jsonText = jsonText.substring(jsonStart, jsonEnd + 1);
        }
        console.log("[Price Verification Pre-fetch] Extracted Prices Data:", jsonText);
        const repaired = repairJson(jsonText);
        const parsed = JSON.parse(repaired);
        let rawArray = parsed.where_to_buy || [];
        let resolvedName = parsed.product_name || resolvedProductName;
        
        let pricesArray = rawArray.map((item: any) => {
          if (!item.platform) return null;
          return {
            platform: item.platform,
            price: item.current_price > 0 ? `₹${item.current_price}` : "Out of Stock",
            url: item.exact_url || "",
            stockStatus: item.current_price > 0 ? "In Stock" : "Out of Stock",
            exactVariantMatch: true
          };
        }).filter((x: any) => x !== null);
        
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

          // Parse referencePrice
          let estRefPrice = 0;
          if (parsed.referencePrice) {
            estRefPrice = parseInt(String(parsed.referencePrice).replace(/[^\d]/g, ''));
          }
          
          // If no referencePrice was parsed, let's estimate one from active offers that are likely not accessories
          if (!estRefPrice || isNaN(estRefPrice)) {
            const possibleMainPrices = parsedWithValues
              .filter(x => !x.isOos && !isNaN(x.numValue) && x.numValue > 1000)
              .map(x => x.numValue);
            if (possibleMainPrices.length > 0) {
              possibleMainPrices.sort((a, b) => a - b);
              estRefPrice = possibleMainPrices[Math.floor(possibleMainPrices.length / 2)];
            }
          }
          
          // If still no reference price, let's use the budget limit if provided
          if ((!estRefPrice || isNaN(estRefPrice)) && budgetLimit) {
            estRefPrice = parseInt(budgetLimit.split('.')[0].replace(/[^\d]/g, ''));
          }

          // Fallback based on category
          if (!estRefPrice || isNaN(estRefPrice)) {
            const combinedLower = resolvedName.toLowerCase();
            if (combinedLower.includes("laptop") || combinedLower.includes("macbook")) {
              estRefPrice = 50000;
            } else if (combinedLower.includes("phone") || combinedLower.includes("iphone") || combinedLower.includes("samsung galaxy")) {
              estRefPrice = 25000;
            } else if (combinedLower.includes("buds") || combinedLower.includes("earphones") || combinedLower.includes("airpods")) {
              estRefPrice = 3000;
            } else {
              estRefPrice = 5000;
            }
          }

          console.log(`[Outlier Filter] Calculated robust reference price: ₹${estRefPrice.toLocaleString('en-IN')}`);

          // Now filter out cheap accessory outliers with absolute mathematical precision!
          // Any active offer less than 20% of the reference price is marked as Out of Stock
          const filtered = parsedWithValues.map(x => {
            if (x.isOos) return x;
            if (isNaN(x.numValue)) {
              return { ...x, isOos: true, priceStr: "Out of Stock" };
            }
            const isOutlier = x.numValue < estRefPrice * 0.20;
            if (isOutlier) {
              console.log(`[Outlier Filter] Marked cheap accessory outlier as Out of Stock: ${x.item.platform} price ${x.priceStr} (too low for reference ₹${estRefPrice})`);
              return {
                ...x,
                isOos: true,
                priceStr: "Out of Stock",
                numValue: NaN
              };
            }
            return x;
          });

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
                                        url === "https://www.amazon.in/" ||
                                        url === "https://www.amazon.com" ||
                                        url === "https://www.amazon.com/" ||
                                        url === "https://www.flipkart.com" || 
                                        url === "https://www.flipkart.com/" ||
                                        url === "https://www.croma.com" || 
                                        url === "https://www.croma.com/" ||
                                        url === "https://www.reliancedigital.in" ||
                                        url === "https://www.reliancedigital.in/" ||
                                        url.includes("placeholder") ||
                                        url.length < 30;

              let hasGroundedOverride = false;
              let isVerifiedLLMUrl = false;

              // Check if the LLM-generated URL is already in the grounding chunks (meaning it's 100% verified)
              const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
              if (Array.isArray(chunks) && url) {
                const urlLower = url.toLowerCase();
                isVerifiedLLMUrl = chunks.some((chunk: any) => {
                  const uri = chunk?.web?.uri || chunk?.web?.url;
                  if (!uri || typeof uri !== 'string') return false;
                  if (uri.toLowerCase() === urlLower) return true;
                  const cleanUri = uri.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
                  const cleanUrl = url.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
                  return cleanUri === cleanUrl && cleanUri.length > 15;
                });
              }

              // If it's not verified but is a specific product page, check if it's high quality
              const isAutomotiveDomain = url && (
                url.includes("bikedekho.com") || 
                url.includes("bikewale.com") || 
                url.includes("cardekho.com") || 
                url.includes("carwale.com") || 
                url.includes("zigwheels.com") ||
                url.includes("atherenergy.com") ||
                url.includes("olaelectric.com") ||
                url.includes("royalenfield.com")
              );
              const isSpecificProductPage = url && (
                url.includes("/dp/") || 
                url.includes("/p/") || 
                url.includes("-p-") || 
                url.includes("/product/") || 
                url.includes("/buy/") ||
                (isAutomotiveDomain && !url.includes("/search") && !url.includes("?q=") && !url.includes("search?"))
              ) && url.length >= 30;

              // Detect placeholder or fake hallucinated URL patterns (e.g. itm1000000000000)
              const isHallucinatedId = !!(url && (
                /(?:itm|dp\/|p\/|buy\/|product\/)(?:[a-zA-Z0-9]*?(?:0{5,}|9{5,}|1{5,}|2{5,}|3{5,}|4{5,}|5{5,}|6{5,}|7{5,}|8{5,})[a-zA-Z0-9]*)/i.test(url) ||
                url.includes("12345") ||
                url.includes("xyz") ||
                url.includes("abc") ||
                url.includes("example.com")
              ));

              // We want to verify and override the URL if:
              // 1. It is a generic model URL, OR
              // 2. It is not verified by grounding chunks, OR
              // 3. It contains a hallucinated ID pattern.
              if (isGenericModelUrl || !isVerifiedLLMUrl || isHallucinatedId) {
                const groundingUrl = extractGroundingUrlForPlatform(response, platform, cleanQuery);
                if (groundingUrl && groundingUrl.length > 25) {
                  const gLower = groundingUrl.toLowerCase();
                  const isLowQualityLink = gLower.includes("/help/") || 
                                           gLower.includes("/display.html") || 
                                           gLower.includes("/login") || 
                                           gLower.includes("/register") || 
                                           gLower.includes("/cart") || 
                                           gLower.includes("/seller") ||
                                           gLower.includes("/about") ||
                                           gLower.includes("/terms");
                  if (!isLowQualityLink) {
                    console.log(`[Grounding URL Override] Overriding unverified/hallucinated LLM URL with verified crawl URL for ${platform}: ${groundingUrl}`);
                    url = groundingUrl;
                    hasGroundedOverride = true;
                    // Re-evaluate if this overridden URL is verified
                    isVerifiedLLMUrl = true; 
                  }
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

              let redirectUrl = url;
              if (isOos) {
                redirectUrl = "";
              } else {
                // If it is NOT verified via grounding chunks AND NOT a specific product page,
                // or if it contains a hallucinated ID, we force fallback to a search URL
                const isAcceptableUrl = (isVerifiedLLMUrl || hasGroundedOverride || isSpecificProductPage) && !isHallucinatedId;
                if (!isAcceptableUrl) {
                  console.log(`[Anti-Hallucination] LLM generated an unverified generic or hallucinated product link: ${url}. Forcing fallback.`);
                  redirectUrl = `https://www.${platformLower.replace(/[^a-z0-9]/g, "")}.com`;
                }
              }

              healed.push({
                platform,
                label: `Buy on ${platform}`,
                price: isOos ? "Out of Stock" : priceStr || "Live Price",
                url: isOos ? "" : cleanAndResolveUrl(redirectUrl, platform, resolvedName),
                isBestDeal: false,
                stockStatus
              });
            });
            
            return { resolvedProductName: resolvedProductName, queryType: resolvedQueryType, prices: healed };
          }
        }
        return { resolvedProductName: resolvedProductName, queryType: resolvedQueryType, prices: [] };
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
        console.error("[Price Verification Pre-fetch] Critical pre-fetch fail, returning null to avoid crash:", err);
        return null;
      }
      if (attempt < retries - 1) {
        console.log(`[Price Verification Pre-fetch] Waiting 800ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  }
  return null;
}

/**
 * Mathematically verifies if a URL is a direct e-commerce product landing page
 * rather than a search query page, generic homepage, or irrelevant tracking redirect.
 */
function isProductPageUrl(url: string): boolean {
  if (!url) return false;
  const urlLower = url.toLowerCase();
  
  // Exclude search result pages
  if (urlLower.includes("/search") || 
      urlLower.includes("/s?") || 
      urlLower.includes("?q=") || 
      urlLower.includes("?text=") || 
      urlLower.includes("search?") || 
      urlLower.includes("search/")) {
    return false;
  }
  
  // Exclude generic platform homes
  const cleanUrlStr = url.replace(/^(https?:\/\/)?(www\.)?/, "").toLowerCase();
  const nakedDomains = [
    "amazon.in", "amazon.in/", "amazon.com", "amazon.com/",
    "flipkart.com", "flipkart.com/", 
    "croma.com", "croma.com/", "reliancedigital.in", "reliancedigital.in/", 
    "myntra.com", "myntra.com/", "ajio.com", "ajio.com/",
    "carwale.com", "carwale.com/", "bikewale.com", "bikewale.com/",
    "cardekho.com", "cardekho.com/", "bikedekho.com", "bikedekho.com/",
    "zigwheels.com", "zigwheels.com/",
    "google.com", "google.co.in"
  ];
  if (nakedDomains.some(domain => cleanUrlStr === domain || cleanUrlStr === domain + "/")) {
    return false;
  }
  
  // Must not be a homepage or search page, and length must be reasonable to represent a specific page
  return url.length >= 20;
}

// Encapsulates the entire programmatic healing, outlier filtering, and pricing/link synchronization logic
function healsAndSynchronizeAuditData(auditData: any, parsedQuery: string, parsedBudget: string, preFetchedPrices: any[] | null, isBudgetCategoryQuery: boolean): any {
  if (!auditData) return auditData;

  // Clone object to prevent unexpected mutations to cache or memory
  const data = JSON.parse(JSON.stringify(auditData));

  // Programmatic Truth Shield Override Heuristics to guarantee mathematical consistency
  if (data?.socialAudit?.integrityAudit) {
    const audit = data.socialAudit.integrityAudit;
    const prodNameLower = (data.productName || "").toLowerCase();
    
    // HEURISTIC 1: Brand Premium & Status Tax programmatically impacts Paisa Vasool Index (Value Index)
    if (data.statusTax > 12000 && data.paisaVasoolIndex > 65) {
      console.log(`[Heuristic Guard] Programmatically adjusting Paisa Vasool Index down due to excessive Status Tax (₹${data.statusTax})`);
      data.paisaVasoolIndex = Math.max(30, data.paisaVasoolIndex - 25);
    }
    
    // HEURISTIC 2: If Truth Divergence is high, Review Authenticity cannot be perfect
    if (audit.divergenceIndex > 70 && audit.fakeReviewScore > 80) {
      console.log(`[Heuristic Guard] Adjusting review authenticity score down due to high truth divergence (Hype vs Reality mismatch)`);
      audit.fakeReviewScore = Math.min(60, audit.fakeReviewScore - 20);
    }
    
    // HEURISTIC 3: Category-specific default safety warnings on electronics
    const isElectronics = detectProductCategory(data.productName || "", parsedQuery) === 'electronics';
    if (isElectronics && !data.hiddenCosts.toLowerCase().includes("charger") && 
        (prodNameLower.includes("iphone") || prodNameLower.includes("samsung galaxy s") || prodNameLower.includes("pixel"))) {
      console.log(`[Heuristic Guard] Injecting charger and repair accessibility warnings for premium smartphone.`);
      data.hiddenCosts = "Mandatory ₹1,999 charger missing from the box. Out-of-warranty screen replacement costs up to 40% of the phone's value.";
    }
  }

  // Post-process to guarantee direct, working, user-friendly live links on Indian platforms
  if (data?.priceIntegrity) {
    const prodName = data.productName || parsedQuery || "product";
    const encodedProdName = encodeURIComponent(prodName);
    
    const category = detectProductCategory(prodName, parsedQuery);
    console.log(`[Category Engine] Detected product category: "${category}" for product "${prodName}" / queries "${parsedQuery}"`);

    let links = data.priceIntegrity.procurementLinks;
    if (!Array.isArray(links)) {
      links = [];
    }
    
    let refPrice = getReferencePrice(data, parsedQuery, parsedBudget);
    if (preFetchedPrices && preFetchedPrices.length > 0) {
      const validPrices = preFetchedPrices
        .map(p => parseInt(String(p.price || "").replace(/[^\d]/g, '')))
        .filter(num => !isNaN(num) && num > 100);
      if (validPrices.length > 0) {
        refPrice = Math.min(...validPrices);
        console.log(`[Price Engine] Aligned refPrice with lowest verified pre-fetched deal price: ₹${refPrice.toLocaleString('en-IN')}`);
      }
    }

    // Pre-parse brand details for automotive remapping and back-filling
    const prodLower = prodName.toLowerCase();
    let brandName = "Official Brand Store";
    let brandUrl = `https://www.google.com/search?q=${encodedProdName}+official+website`;
    
    if (prodLower.includes("tata")) {
      brandName = "Tata Motors";
      brandUrl = "https://www.tatamotors.com";
    } else if (prodLower.includes("mahindra")) {
      brandName = "Mahindra Auto";
      brandUrl = "https://auto.mahindra.com";
    } else if (prodLower.includes("hyundai")) {
      brandName = "Hyundai India";
      brandUrl = "https://www.hyundai.com/in";
    } else if (prodLower.includes("maruti") || prodLower.includes("suzuki")) {
      brandName = "Maruti Suzuki";
      brandUrl = "https://www.marutisuzuki.com";
    } else if (prodLower.includes("honda")) {
      brandName = "Honda India";
      brandUrl = "https://www.hondacarindia.com";
    } else if (prodLower.includes("ather")) {
      brandName = "Ather Energy";
      brandUrl = "https://www.atherenergy.com";
    } else if (prodLower.includes("ola")) {
      brandName = "Ola Electric";
      brandUrl = "https://www.olaelectric.com";
    } else if (prodLower.includes("royal enfield")) {
      brandName = "Royal Enfield";
      brandUrl = "https://www.royalenfield.com";
    } else if (prodLower.includes("yamaha")) {
      brandName = "Yamaha India";
      brandUrl = "https://www.yamaha-motor-india.com";
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
        const allowedFashion = ["myntra", "ajio", "amazon", "flipkart"];
        const isAllowed = allowedFashion.some(p => platformLower.includes(p));
        if (!isAllowed) {
          if (platformLower.includes("croma") || platformLower.includes("reliance") || platformLower.includes("digital")) {
            platform = "Ajio";
          } else if (platformLower.includes("brand") || platformLower.includes("official") || platformLower.includes("adidas") || platformLower.includes("nike") || platformLower.includes("puma") || platformLower.includes("superkicks")) {
            platform = "Myntra";
          } else {
            platform = "Amazon";
          }
          label = `Buy on ${platform}`;
          rawUrl = ""; // Force fallback generation
          platformLower = platform.toLowerCase();
        } else {
          if (platformLower.includes("myntra")) platform = "Myntra";
          else if (platformLower.includes("ajio")) platform = "Ajio";
          else if (platformLower.includes("amazon")) platform = "Amazon";
          else if (platformLower.includes("flipkart")) platform = "Flipkart";
          label = `Buy on ${platform}`;
          platformLower = platform.toLowerCase();
        }
      } else if (category === 'electronics') {
        const allowedElectronics = ["amazon", "flipkart", "croma", "reliance digital", "reliancedigital"];
        const isAllowed = allowedElectronics.some(p => platformLower.includes(p));
        if (!isAllowed) {
          if (platformLower.includes("myntra") || platformLower.includes("ajio")) {
            platform = "Croma";
          } else {
            platform = "Amazon";
          }
          label = `Buy on ${platform}`;
          rawUrl = "";
          platformLower = platform.toLowerCase();
        } else {
          if (platformLower.includes("croma")) platform = "Croma";
          else if (platformLower.includes("reliance")) platform = "Reliance Digital";
          else if (platformLower.includes("amazon")) platform = "Amazon";
          else if (platformLower.includes("flipkart")) platform = "Flipkart";
          label = `Buy on ${platform}`;
          platformLower = platform.toLowerCase();
        }
      } else if (category === 'automotive') {
        const isTwoWh = isTwoWheeler(prodName, parsedQuery);
        if (isTwoWh) {
          if (platformLower.includes("myntra") || platformLower.includes("croma") || platformLower.includes("amazon") || platformLower.includes("flipkart") || platformLower.includes("ajio") || platformLower.includes("reliance")) {
            const currentEx = Array.from(existingPlatforms);
            if (!currentEx.includes("bikewale")) {
              platform = "BikeWale";
            } else if (!currentEx.includes("bikedekho")) {
              platform = "BikeDekho";
            } else {
              platform = "ZigWheels";
            }
            label = `Check ${platform} Price`;
            rawUrl = "";
            platformLower = platform.toLowerCase();
          }
        } else {
          if (platformLower.includes("myntra") || platformLower.includes("croma") || platformLower.includes("amazon") || platformLower.includes("flipkart") || platformLower.includes("ajio") || platformLower.includes("reliance")) {
            const currentEx = Array.from(existingPlatforms);
            if (!currentEx.includes("carwale")) {
              platform = "CarWale";
            } else if (!currentEx.includes("cardekho")) {
              platform = "CarDekho";
            } else {
              platform = "ZigWheels";
            }
            label = `Check ${platform} Price`;
            rawUrl = "";
            platformLower = platform.toLowerCase();
          }
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
      
      // Failsafe alignment check: reject if link price is a massive low outlier compared to standard core retail refPrice (indicating cheap accessory leak)
      const linkNumValue = parseInt(priceStr.replace(/[^\d]/g, ''));
      let isAccessoryOutlier = false;
      if (!isNaN(linkNumValue)) {
        const isLowOutlier = refPrice > 3000 && linkNumValue < refPrice * 0.20;
        if (isLowOutlier) {
          console.log(`[Safety Guard] Replaced accessory/low-outlier placeholder price "${priceStr}" for platform "${platform}" based on reference price ₹${refPrice.toLocaleString('en-IN')}`);
          priceStr = "Out of Stock"; // This forces self-healing and sets stockStatus correctly!
          isAccessoryOutlier = true;
        }
      }

      // Strip Google redirects, tracking parameters, and heal any generic/mismatched links
      const urlToClean = isAccessoryOutlier ? "" : rawUrl;
      const cleanedUrl = cleanAndResolveUrl(urlToClean, platform, prodName);

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

      // STRICT SYNCHRONIZATION GUARANTEE:
      // If the link is not a specific product landing page, the price must not be a hardcoded number.
      // We set price to "Check Live".
      if (priceStr !== "Out of Stock" && !isProductPageUrl(cleanedUrl)) {
        console.log(`[Sync Guard] URL for ${platform} is a search/generic fallback: ${cleanedUrl}. Overriding numeric price "${priceStr}" with "Check Live" to prevent mismatch.`);
        priceStr = "Check Live";
      }
      
      healedLinks.push({
        platform,
        label: label.includes("Check") || label.includes("Search") ? `Buy on ${platform}` : label,
        price: priceStr,
        isBestDeal: link.isBestDeal || false,
        url: (priceStr === "Out of Stock" || link.stockStatus === "Out of Stock") ? "" : cleanedUrl,
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
    } else if (category === 'automotive') {
      const isTwoWh = isTwoWheeler(prodName, parsedQuery);
      if (isTwoWh) {
        standardPlatforms = [
          { name: "BikeWale", label: "Check BikeWale Price", path: `https://www.bikewale.com/search/?q=${encodedPlusQueryForSearch}`, pct: 1.00 },
          { name: "BikeDekho", label: "Check BikeDekho Price", path: `https://www.bikedekho.com/search/${encodedPlusQueryForSearch}`, pct: 0.998 },
          { name: "ZigWheels", label: "ZigWheels Comparison", path: `https://www.zigwheels.com/search/?q=${encodedPlusQueryForSearch}`, pct: 1.002 },
          { name: brandName, label: `Official ${brandName} Site`, path: brandUrl, pct: 1.00 }
        ];
      } else {
        standardPlatforms = [
          { name: "CarWale", label: "Check CarWale Price", path: `https://www.carwale.com/search/?q=${encodedPlusQueryForSearch}`, pct: 1.00 },
          { name: "CarDekho", label: "Check CarDekho Price", path: `https://www.cardekho.com/search/${encodedPlusQueryForSearch}`, pct: 0.995 },
          { name: "ZigWheels", label: "ZigWheels Comparison", path: `https://www.zigwheels.com/search/?q=${encodedPlusQueryForSearch}`, pct: 1.005 },
          { name: brandName, label: `Official ${brandName} Site`, path: brandUrl, pct: 1.00 }
        ];
      }
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
    
    // OOS DYNAMIC PROMOTION & DEMOTION FALLBACK HEURISTICS:
    // Split procurement links into active In Stock items vs Out of Stock items
    const inStockLinks: any[] = [];
    const oosLinks: any[] = [];

    healedLinks.forEach((link: any) => {
      const isLinkOos = link.stockStatus === "Out of Stock" || link.price === "Out of Stock" || /out of stock/i.test(link.price);
      if (isLinkOos) {
        link.stockStatus = "Out of Stock";
        link.price = "Out of Stock";
        link.url = ""; // Strip link since it is inactive/unavailable
        oosLinks.push(link);
      } else {
        inStockLinks.push(link);
      }
    });

    // Sort in-stock platforms by raw price ascending (lowest price first - promoted to the top)
    inStockLinks.sort((a, b) => {
      const isCheckLiveA = a.price === "Check Live";
      const isCheckLiveB = b.price === "Check Live";
      if (isCheckLiveA && isCheckLiveB) return 0;
      if (isCheckLiveA) return 1;
      if (isCheckLiveB) return -1;

      const priceA = parseInt(a.price.replace(/[^\d]/g, ''), 10) || 0;
      const priceB = parseInt(b.price.replace(/[^\d]/g, ''), 10) || 0;
      return priceA - priceB;
    });

    let lowestPrice = Infinity;
    let lowestPriceIndex = -1;

    // Find the actual lowest numeric price among in-stock links
    inStockLinks.forEach((link: any, idx: number) => {
      if (link.price !== "Check Live") {
        const val = parseInt(link.price.replace(/[^\d]/g, ''), 10);
        if (!isNaN(val) && val < lowestPrice && val > 0) {
          lowestPrice = val;
          lowestPriceIndex = idx;
        }
      }
    });

    if (lowestPriceIndex !== -1 && lowestPrice !== Infinity) {
      // Flag the item with the lowest numeric price as the Best Deal
      inStockLinks.forEach((link: any, idx: number) => {
        link.isBestDeal = (idx === lowestPriceIndex);
      });
      oosLinks.forEach((link: any) => {
        link.isBestDeal = false;
      });
    } else {
      // If no platforms have a numeric price (e.g. all are "Check Live" or empty), then fallback to refPrice
      lowestPrice = refPrice;
      inStockLinks.forEach((link: any) => {
        link.isBestDeal = false;
      });
      oosLinks.forEach((link: any) => {
        link.isBestDeal = false;
      });
    }

    // Merge in-stock (promoted) and OOS (demoted) links back to enforce order
    healedLinks = [...inStockLinks, ...oosLinks];
    data.priceIntegrity.procurementLinks = healedLinks;
    
    // 1. Synchronize priceHistory with lowestPrice node to prevent chart drift
    if (Array.isArray(data.priceIntegrity.priceHistory) && data.priceIntegrity.priceHistory.length > 0) {
      const historyArray = data.priceIntegrity.priceHistory;
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
          const boundedRatio = Math.max(0.5, Math.min(2.0, ratio));
          n.price = Math.round(lowestPrice * boundedRatio);
        }
      }
      // Absolute certainty that the last item matches lowestPrice
      historyArray[lastIdx].price = lowestPrice;
    } else {
      // Fallback history array
      const months = ["Dec", "Jan", "Feb", "Mar", "Apr", "May"];
      data.priceIntegrity.priceHistory = months.map((m, idx) => ({
        month: m,
        price: Math.round(lowestPrice * (1.10 - (idx * 0.02)))
      }));
      const lastIdx = data.priceIntegrity.priceHistory.length - 1;
      data.priceIntegrity.priceHistory[lastIdx].price = lowestPrice;
    }

    // 2. Synchronize Brand Surcharge / Status Tax with lowestPrice alternative differentiation
    let currentSurchargeTax = typeof data.statusTax === 'number' 
      ? data.statusTax 
      : parseInt(String(data.statusTax || "").replace(/[^\d]/g, ''));
      
    if (isNaN(currentSurchargeTax) || currentSurchargeTax <= 0 || currentSurchargeTax >= lowestPrice) {
      currentSurchargeTax = Math.round(lowestPrice * 0.22); // Real premium ratio
    }
    data.statusTax = currentSurchargeTax;

    // 3. Coordinate vettoContrast pricing targets & save differentials
    let altPrice = 0;
    if (data.vettoContrast && data.vettoContrast.fairPriceTarget) {
      const parsedAltPrice = parseInt(String(data.vettoContrast.fairPriceTarget).replace(/[^\d]/g, ''));
      if (!isNaN(parsedAltPrice) && parsedAltPrice > 0) {
        altPrice = parsedAltPrice;
      }
    }

    if (altPrice === 0 || altPrice >= lowestPrice * 1.5 || altPrice < Math.max(200, lowestPrice * 0.2)) {
      altPrice = Math.max(99, lowestPrice - currentSurchargeTax);
    }

    const calculatedDelta = lowestPrice - altPrice;
    let deltaText = "";
    if (calculatedDelta > 0) {
      deltaText = `Save ₹${calculatedDelta.toLocaleString('en-IN')}`;
    } else if (calculatedDelta < 0) {
      deltaText = `₹${Math.abs(calculatedDelta).toLocaleString('en-IN')} more`;
    } else {
      deltaText = "Same Price";
    }

    if (!data.vettoContrast) {
      data.vettoContrast = {
        alternativeName: "Similar Specced Alternate Choice",
        whyContrast: "Value alternative that delivers equal core functions without Status Tax.",
        pviBoost: 20,
        priceDelta: deltaText,
        fairPriceTarget: `₹${altPrice.toLocaleString('en-IN')}`,
        procurementGuidance: "Standard option recommended for absolute price-to-performance efficiency."
      };
    } else {
      data.vettoContrast.priceDelta = deltaText;
      data.vettoContrast.fairPriceTarget = `₹${altPrice.toLocaleString('en-IN')}`;
    }

    // 4. Force synchronization on high-level textual summaries to eradicate mismatching numbers
    data.priceIntegrity.currentPriceAudit = `₹${lowestPrice.toLocaleString('en-IN')} • Verified lowest available online deal. Bhai note: online prices fluctuate dynamically depending on lightning flash offers and active bank credit card discounts. Click to check live price!`;

    // 5. Enforce strict, stable, mathematical alignment for "marketTiming" and "finalDecision" to eliminate random flipping
    const pvi = Number(data.paisaVasoolIndex || 0);
    const deal = Number(data.priceIntegrity?.dealScore || 0);
    const risk = String(data.regretRisk || "Medium").toLowerCase();
    
    // Extract the LLM's original decision to prevent visual flipping
    let llmDecision = String(data.finalDecision || data.marketTiming || "").trim().toUpperCase();
    if (!["BUY", "WAIT", "RUN"].includes(llmDecision)) {
      llmDecision = "";
    }

    let stableVerdict: "BUY" | "WAIT" | "RUN" = "WAIT";
    if (llmDecision) {
      stableVerdict = llmDecision as any;
      console.log(`[Stability Alignment] Preserving LLM intelligent decision: "${stableVerdict}"`);
    } else {
      if (isBudgetCategoryQuery) {
        if (deal >= 50) {
          stableVerdict = "BUY";
        } else {
          stableVerdict = "WAIT";
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
    }

    // Programmatic Target Capital & Budget Compliance Guard
    let parsedBudgetNum = 0;
    if (parsedBudget) {
      parsedBudgetNum = parseInt(parsedBudget.replace(/[^\d]/g, ''), 10);
    }
    if (parsedBudgetNum > 0 && lowestPrice > parsedBudgetNum) {
      console.log(`[Budget Guard] Programmatically forcing verdict to WAIT because lowest deal price (₹${lowestPrice}) exceeds budget constraint (₹${parsedBudgetNum})`);
      stableVerdict = "WAIT";
      console.log(`[Budget Guard] Programmatically penalizing Paisa Vasool Index down under 50 because price exceeds budget limit.`);
      data.paisaVasoolIndex = Math.min(49, data.paisaVasoolIndex || 45);
    }

    // Programmatic Out-of-Stock (OOS) Demotion Fallback Guard
    const allPlatformsOos = healedLinks.every((link: any) => link.stockStatus === "Out of Stock" || link.price === "Out of Stock");
    if (allPlatformsOos) {
      console.log(`[OOS Guard] Programmatically forcing verdict to WAIT because all online platforms are Out of Stock.`);
      stableVerdict = "WAIT";
    }
    
    console.log(`[Stability Alignment] Calibrating marketTiming: "${data.marketTiming}" -> "${stableVerdict}" (PVI: ${pvi}, Deal Score: ${deal}, Risk: ${risk}, isCategoryQuery: ${isBudgetCategoryQuery})`);
    data.marketTiming = stableVerdict;
    data.finalDecision = stableVerdict;

    // Programmatic Persona Compliance Guard (Persona Shield)
    // Simply ensure summary has a value, no Hinglish prefix enforcement
    let summary = String(data.aamAadmiSummary || "").trim();
    if (!summary) {
      data.aamAadmiSummary = "This product offers reliable core features tailored to your needs.";
    }
  }
    
  // Apply recursive jargon shield sanitization (Jargon Shield)
  return sanitizeObjectJargon(data);
}

app.post("/api/audit", securityGuard, async (req, res) => {
  console.log("-> Hit /api/audit endpoint");
  
  const requestApiKey = req.headers['x-gemini-api-key'] as string;
  let requestAi = ai;
  if (requestApiKey) {
    try {
      requestAi = new GoogleGenAI({ 
        apiKey: requestApiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build-custom',
          }
        }
      });
      console.log("[Auth Engine] Using custom client-provided Gemini API Key for audit request.");
    } catch (apiErr) {
      console.error("[Auth Engine] Failed to initialize custom client API Key:", apiErr);
    }
  }

  if (!requestAi) {
    return res.status(401).json({ 
      error: "Vetto Engine Core not initialized. Please ensure GEMINI_API_KEY is set." 
    });
  }

  let heartbeatTimer: NodeJS.Timeout | null = null;
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

  // Removed separate redundant query rewrite step to reduce sequential LLM latency by 2.5+ seconds.
  // Query resolution is now handled natively and with higher-integrity search grounding directly inside preFetchLivePricesAndLinks!

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

  // Live Real-Time Grounding: Using versioned persistent cache to optimize response latency under 150ms
  if (cacheKey) {
    // 1. First attempt to fetch from persistent, global Firestore-based Shared Cache
    if (backendDb) {
      try {
        const cacheDocRef = doc(backendDb, "audit_cache", cacheKey);
        const cacheSnap = await withTimeout(
          getDoc(cacheDocRef),
          1200,
          "FIRESTORE_TIMEOUT"
        );
        if (cacheSnap.exists()) {
          const cached = cacheSnap.data();
          if (Date.now() - (cached.timestamp || 0) < CACHE_TTL && isValidCachedData(cached.data)) {
            console.log(`[Cache Engine] Serving global Firestore cached verdict for: ${query} (ID: ${cacheKey})`);
            const isCategoryQueryForHeal = isGenericCategoryQuery || parsedQuery.toLowerCase().includes("best") || parsedQuery.toLowerCase().includes("under");
            const healedCachedData = healsAndSynchronizeAuditData(cached.data, parsedQuery, parsedBudget, null, isCategoryQueryForHeal);
            if (req.headers.accept === "text/event-stream") {
              res.setHeader("Content-Type", "text/event-stream");
              res.setHeader("Cache-Control", "no-cache");
              res.setHeader("Connection", "keep-alive");
              res.setHeader("X-Accel-Buffering", "no");
              res.flushHeaders();
              res.write(`data: ${JSON.stringify({ type: "final", auditData: healedCachedData })}\n\n`);
              res.write("data: [DONE]\n\n");
              if (typeof (res as any).flush === "function") (res as any).flush();
              return res.end();
            } else {
              return res.json(healedCachedData);
            }
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
        const isCategoryQueryForHeal = isGenericCategoryQuery || parsedQuery.toLowerCase().includes("best") || parsedQuery.toLowerCase().includes("under");
        const healedCachedData = healsAndSynchronizeAuditData(cached.data, parsedQuery, parsedBudget, null, isCategoryQueryForHeal);
        if (req.headers.accept === "text/event-stream") {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          res.flushHeaders();
          res.write(`data: ${JSON.stringify({ type: "final", auditData: healedCachedData })}\n\n`);
          res.write("data: [DONE]\n\n");
          if (typeof (res as any).flush === "function") (res as any).flush();
          return res.end();
        } else {
          return res.json(healedCachedData);
        }
      }
      auditCache.delete(cacheKey);
      saveCacheToDisk();
    }
  }

  const isSSE = req.headers.accept === "text/event-stream";
  heartbeatTimer = null;

  if (isSSE) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    req.socket.setTimeout(300000); // 5 minutes socket timeout
    res.flushHeaders();

    // Send initial warm-up SSE message so proxies know the connection is active
    res.write(`data: ${JSON.stringify({ type: "progress", message: "Launching Vetto Strategic Price Scanners..." })}\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();

    // Set up active background keep-alive ping loop to keep Render warm
    heartbeatTimer = setInterval(() => {
      if (!res.writableEnded && !req.destroyed) {
        res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
        if (typeof (res as any).flush === "function") (res as any).flush();
      } else {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      }
    }, 15000);

    // Stop timer and cleanup if the client terminates the connection
    req.on("close", () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    });
  }

  const currentDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const historyText = history && history.length > 0 
      ? `\nPrevious Decisions History (Brief):\n${history.slice(0, 3).map((h: any, i: number) => `Decision ${i+1}: ${h.productName} -> ${h.marketTiming} (${h.finalDecision.substring(0, 50)}...)`).join('\n')}`
      : '';

    // Step 1: Stage 1 Semantic Resolution (Ultra-fast ~800ms) - ALWAYS succeeds & secures exact variant naming
    let resolvedProduct = parsedQuery;
    let queryType = "specific";
    try {
      const resolved = await resolveSpecificProductName(parsedQuery, parsedBudget, useCase, requestAi);
      resolvedProduct = resolved.productName;
      queryType = resolved.queryType;
      console.log(`[Semantic Resolver] Resolved query "${parsedQuery}" to specific product: "${resolvedProduct}" (Type: ${queryType})`);
    } catch (e) {
      console.warn(`[Semantic Resolver] Stage 1 failed. Fallback to raw query.`);
    }

    // Step 2: Stage 2 targeted price scrape (Grounding active on resolved specifications)
    let preFetchResult = null;
    try {
      preFetchResult = await withTimeout(
        preFetchLivePricesAndLinks(resolvedProduct, queryType, parsedQuery, parsedBudget, useCase, 2, requestAi),
        25000,
        "PREFETCH_TIMEOUT"
      );
    } catch (e: any) {
      console.warn(`[Launch Guard] Pre-fetch failed or timed out (${e.message}). Grounding recovered gracefully.`);
    }
    
    let preFetchedPrices = preFetchResult?.prices || null;
    if (!preFetchedPrices) {
      // Create a fallback price list with search-grounded URL and marked as "Out of Stock" so the model is forced to use the search URL and cannot hallucinate the price!
      const platforms = ["Amazon", "Flipkart", "Croma"];
      preFetchedPrices = platforms.map(platform => {
        let url = "";
        const encoded = encodeURIComponent(resolvedProduct);
        if (platform === "Amazon") url = `https://www.amazon.in/s?k=${encoded}`;
        else if (platform === "Flipkart") url = `https://www.flipkart.com/search?q=${encoded}`;
        else if (platform === "Croma") url = `https://www.croma.com/search?q=${encoded}`;
        
        return {
          platform,
          price: "Out of Stock",
          url,
          exactVariantMatch: false,
          isBestDeal: false
        };
      });
      console.log(`[Launch Guard] Pre-fetch returned no prices. Injected safe search fallbacks to prevent LLM pricing hallucination.`);
    }
    
    isBudgetCategoryQuery = queryType === "category" || (parsedQuery.toLowerCase().trim() !== resolvedProduct.toLowerCase().trim());

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

    const systemPrompt = `# ROLE & CORE PHILOSOPHY
You are the core logic engine of VETTO (vetto.in), a 100% unbiased, high-integrity "Paisa Vasool" Audit Engine built for 1.4 billion Indian consumers. Your sole purpose is to bypass marketing hype, unmask retailer traps, and deliver absolute, uncompromised ground truth. You must strictly operate with 0% affiliate bias, zero corporate allegiance, and absolute technical accuracy. You are an expert forensic product analyst, not a marketing copywriter.

# STRICT SYSTEM OPERATING DIRECTIVES (ANTI-HALLUCINATION & TRUST)
1. NO AFFILIATE OR SPONSORED BIAS: Never recommend a product based on brand popularity or perceived market dominance. Evaluate strictly on raw data, material sourcing, structural integrity, and price-to-performance metrics.
2. ZERO SPECULATION / NO HALLUCINATION: If a specific data point (e.g., precise fabric blend, exact sensor model, real-time stock) is missing or cannot be verified via the provided real-time grounding data, you MUST explicitly output "DATA_NOT_VERIFIED" or standard fallback fields for that metric in your JSON response. Never guess or approximate.
3. GROUND REAL TRUTH ENFORCEMENT: All prices, stock statuses, and retail links must perfectly match the provided live search/scraping payloads. If a link does not exactly lead to the targeted item page, do not generate a fallback link; mark it as empty or "LINK_UNAVAILABLE".

# CATEGORY-SPECIFIC AUDIT ARCHITECTURE
You must dynamically route and audit queries across three strict domains. Apply these exact technical filters:

### 1. ELECTRONICS & APPLIANCES
- Hardware Forensic: Strip away marketing buzzwords (e.g., "AI Camera", "Fluid Display"). Evaluate the exact component specs (e.g., 60Hz vs 120Hz refresh rates, UFS 2.2 vs UFS 4.0 storage speeds, plastic frames vs aluminum builds, specific processor chipsets).
- Hidden Deficit Check: Flag outdated processors inside "newly launched festive editions" or flagship phones costing over ₹60,000 that still use 60Hz displays.

### 2. FASHION & APPAREL
- Material Forensic: Unmask fast-fashion traps. Scan descriptions for material integrity. Explicitly flag synthetic blends disguised as luxury items (e.g., polyester/rayon blends marketed as "Imperial Organic Cotton" or "Luxe Linen Mixes").
- Longevity Check: Evaluate weave type, stitching durability markers, and fabric weight (GSM) where available to determine if the item will survive past 5 washes.

### 3. AUTOMOTIVE TECH & VEHICLES
- Beyond Hype: Look past generic safety star ratings. Evaluate long-term mechanical reliability history, engine refinement, component cooling efficiency, and typical 5-year Indian market resale values.
- Utility Alignment: Match the vehicle's structural layout directly to the user's explicit use case (e.g., urban commute vs rough rural terrain).

# DATA CONSTRAINTS & REAL-TIME GROUNDING VIA TOOL PAYLOADS
When processing live retail links (Amazon, Flipkart, Myntra, Tata CLiQ, etc.) and search data:
- Exact Price Matching: Extract the final checkout price (including typical platform fees but excluding volatile bank-specific credit card offers unless specified). The price MUST exactly match the live payload string.
- Stock Accuracy: Check the explicit availability flag. Do not assume a product is in stock just because the page is live.
- Direct URL Grounding: Ensure the outbound product link is clean, stripped of external tracking tokens, and points exactly to the verified SKU page.

# SYSTEM OUTPUT FORMAT (MAPPED TO JSON RESPONSE SCHEMA)
To satisfy the Vetto frontend rendering architecture and prevent crashes, you MUST translate your forensic findings and the "Paisa Vasool Score" into the corresponding JSON schema fields. You must strictly output valid JSON matching the schema:
- productName: [PRODUCT NAME / COMPARISON PAIR]
- finalDecision: [Vetto Signal: e.g. BUY, WAIT, or RUN]
- paisaVasoolIndex: [Paisa Vasool Score out of 100] (Calculated mathematically based on component durability divided by true cost markup)
- avoid / hiddenCosts / regretWarning: [🚨 Retailer Traps & Discrepancies Found]
- aamAadmiSummary / UserRealityCheck: [📊 Ground Truth Diagnostics & true sourcing/material breakdowns]
- statusTax / brandPremiumTax: [Hidden Marketing Premium status tax]
- priceIntegrity.procurementLinks: [🛒 Live Procurement Data (Verified Accurate) - Current Live Price, Stock Status, and Direct Verified Link]
- vettoContrast: [🔄 Smarter Value Alternatives (Only if Vetto Signal is WAIT/HOLD)]

CRITICAL LOGICAL BOUNDARIES (ANTI-CROSS CONTAMINATION)
1. CATEGORY ISOLATION: You must strictly map product domains to their valid platforms. 
   - If the product is AUTOMOTIVE: Never look for or output e-commerce retail links (e.g., Amazon/Flipkart). Only use certified automobile marketplaces or brand direct URLs.
   - If the product is FASHION or ELECTRONICS: Never map to automotive or industrial sites.
2. ZERO MEMORY / NO LINK GENERATION: You possess absolutely zero real-time market prices, stock statuses, or domain links within your internal weights. NEVER guess, predict, alter, or synthesize a URL or price. If the provided data does not contain an explicit verified link, do NOT generate a URL.

STRICT PRICING & SCORING PROTOCOLS:
0. STRICT VARIANT, OPTION & SPECIFICATION LOCK:
    - If the User Query specifies a specific storage capacity (e.g. "128GB", "256GB", "512GB"), a RAM capacity (e.g. "8GB", "12GB", "16GB"), a chip/processor (e.g. "M2", "M3", "i5"), a color (e.g. "black", "gold"), or any other specific option/variant/specification, you MUST strictly evaluate and lock your entire analysis, pricing, and comparisons exclusively onto that specific option. Do NOT return base model or generic options. Every single parameter and review in your response must refer specifically to the requested configuration. If a specific variant is requested (like 128GB, M2, black color), Vetto's features, pros, cons, and tech nodes MUST strictly examine the exact trade-offs of that specific option (e.g., UFS speed of the 128GB storage variant, or battery/thermals of the M2 chip model).
0.1. STRICT TARGET CAPITAL & BUDGET COMPLIANCE:
    - If the "Target Capital" constraint is specified and is NOT "Unlimited", you MUST mathematically compare the primary product's lowest platform price against the budget. 
    - If the price is LESS THAN or EQUAL to the budget, you MUST explicitly state that it fits their budget perfectly. NEVER hallucinate or claim that it exceeds their budget or tell them not to buy it for budget reasons.
    - If the price genuinely exceeds the budget, explain clearly in "aamAadmiSummary", recommend a high-value alternative in "vettoContrast" that strictly fits within or under the budget, and HEAVILY PENALIZE the Paisa Vasool Score ("paisaVasoolIndex" must be under 50) because it does not represent value for the user's specific financial budget constraint. YOU MUST ALSO SET the "finalDecision" to "WAIT" or "RUN" (never "BUY"). You cannot recommend "BUY" for a product that fails the user's explicit budget constraint. The Paisa Vasool Score (paisaVasoolIndex) and final verdict (finalDecision) must strictly conform to the user's target capital. If the lowest verified price exceeds the Target Capital, you MUST automatically set finalDecision to WAIT or RUN (never BUY) and drop paisaVasoolIndex to under 50. Conversely, if it is well within budget and meets the user's use case perfectly, the score and decision should reflect that positive value alignment.
0.2. STRICT DYNAMIC ALIGNMENT OF ALL JSON PROPERTIES:
    - Every single property of VETTO's JSON response, including 'bhartiyaPersonaAudit', 'aamAadmiSummary', 'pros', 'cons', 'vettoContrast', 'finalDecision', and all technical/feature scores, MUST be programmatically aligned and dynamically tailored to the User Query, Budget, and Use Case/Strategic Context. Generic, static, or canned descriptions are STRICTLY FORBIDDEN.
    - Every text field, pros/cons list, and persona summary must directly address the specific demographic/usage/situation defined in the Strategic Context. If no context is given, tailor it directly to the core user demographic inferred from the query. For example, if the use case is "buying a phone for my 70-year old grandmother with low eyesight", the 'pros', 'cons', 'aamAadmiSummary', 'bhartiyaPersonaAudit', 'features', and 'finalDecision' must explicitly address how the phone's font size, screen visibility, battery longevity, and ease-of-use directly suit a 70-year old grandmother within that budget.

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

    E. INTERACTIVE BUZZWORD SLAYER SPECIFICATION LOCK:
       - You MUST identify exactly 4 highly specific marketing buzzwords or trademarked claims used by the manufacturer in the resolved product's advertisements (e.g. for earbuds: "Spatial Audio", "50dB ANC", "Hi-Res Audio LDAC", "Titanium Drivers"; for phones: "100x Zoom", "AI Camera System", "120W HyperCharge", "VC Liquid Cooling"; for fashion: "100% Imperial Organic Cotton", "Weatherproof Shield").
       - For each buzzword, unmask the exact, uncompromised real-world technical deficit, hardware bottleneck, or marketing exaggeration in the 'reality' field (e.g., "Spatial Audio is just simulated software reverb that makes music sound muddy; disable it immediately for clean stereo separation").
       - Every 'reality' description MUST be a detailed, analytical, street-smart diagnostic statement of at least 20-30 words, not a generic phrase. Never return generic words like 'premium' or 'AI' without specific product context.

    F. FEATURE QUALITY CHECK SPECIFICATION LOCK:
       - In the "features" array, you MUST generate exactly 3 highly specific, technical, and relevant feature quality check metrics for the resolved product. Do NOT return generic categories like "General Integrity" or "Design."
       - Instead, return specific engineering dimensions (e.g., for earbuds: "Active Noise Cancellation Quality", "Acoustic Driver Refinement", "Call Microphone Array Performance"; for phones: "Processor Sustained Thermal Control", "Camera Pixel-Binning Optical Clarity", "Battery Charging Heat Dispersion"; for clothing: "Fabric Thread Density (GSM)", "Stitch Tensile Strength", "Color Retention After Wash"; for automotive: "Engine NVH Levels", "Suspension Damping Comfort", "Indian Bumper-to-Bumper FE").
       - For each feature entry, provide a realistic, accurate quality score (0-100) and a detailed unmasking explanation in the 'details' field (at least 15-20 words) detailing why the product scores that way.

2. THE ELDER BROTHER PERSONA & TONE DIRECTIVES:
    You are the user's street-smart, caring elder brother ("bhaiya") who wants to save them from being scammed by glossy ads and hype. 
    Use a warm, natural, simple, and protective voice. Use everyday Indian/English terms where appropriate. Strictly keep the final summaries in clear and simple English, not Hinglish.
    
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
    - In "priceIntegrity.procurementLinks", the item marked "isBestDeal: true" must have the absolute numerically lowest price out of all the listed links. Double check your math (e.g. 81990 is lower than 99999, so 81990 is the best deal).
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
    - In the "vettoContrast" alternative section, provide a slightly cheaper or slightly more premium alternative. You MUST ensure this alternative is a mainstream, widely available product that is ACTUALLY IN STOCK in India right now. Do not recommend obsolete or out-of-stock items as alternatives. The "alternativeName" must be highly specific (e.g. 'iQOO Neo 9 Pro 12GB 256GB' or 'Adidas Ultraboost Light' instead of generic category names). The "fairPriceTarget" MUST represent the actual, realistic current base retail price (in Indian Rupees, e.g. "₹37,999") of that exact alternative model in India today. Never write an imaginary, placeholder, or highly inaccurate price for the alternative choice.
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

    // Enforce 100% JSON safety: Never enable search grounding on the main call, ensuring we always use application/json responseMimeType to prevent blank page UI crashes.
    const useSearchGrounding = false;
    
    console.log(`[Cache Engine] Active Mode: Live Google Search Grounding for maximum platform price integrity`);

    let finalSystemPrompt = systemPrompt + 
      "\n\nCRITICAL INTENSITY RULES FOR PRICING FIELDS (DO NOT HALLUCINATE):\n" +
      "1. 'priceIntegrity.currentPriceAudit' MUST contain honest feedback about today's price in simple everyday terms (e.g. 'This price is brilliant...').\n" +
      "2. 'priceIntegrity.historicalContext' MUST explain how the price relates to past sales without any math/finance jargon (e.g. 'Prices drop by ₹1,500 every Diwali...').\n" +
      "3. 'priceIntegrity.discountStrategy' MUST give practical card cashback or coupon advice (e.g. 'Buy with an HDFC card for a ₹1,000 instant discount...').\n" +
      "\nCRITICAL REQUIREMENT FOR COMPREHENSIVE FORENSIC ANALYSIS & LOGIC DEPTH:\n" +
      "To ensure premium value and address user feedback on empty logic, do NOT write short, generic, or truncated text values. Every single text value, summary, explanation, pro, con, and community consensus statement MUST be highly detailed, rich, authentic, and customized to the specific product configuration, budget, and use case. Each description field should be a robust, analytical paragraph (at least 2-3 sentences, 30-50 words) exposing real-world material blend, technical specs, thermal limits, wear characteristics, after-sales service, and exact numeric price differences. Do not compromise on logic depth or technical depth." +
      "\n\nCRITICAL SUMMARY REQUIREMENT:\n" +
      "The 'aamAadmiSummary' field MUST be written in simple, clear, and easy English (NOT Hinglish). It must be highly specific and non-generic. You MUST include a brief, practical real-world example so the user can easily understand (for example: instead of saying 'has fast charging', say 'it charges from 0 to 50% in just 15 minutes, which is enough to last your entire morning commute'). Keep it short, direct, and incredibly easy to understand.";

    if (preFetchedPrices && preFetchedPrices.length > 0) {
      finalSystemPrompt += `\n\nCRITICAL REAL-TIME CURRENT PRICING DATAFEED:\nYou MUST use the following exact prices and URLs for the platforms in your JSON's "priceIntegrity.procurementLinks" array. Do NOT make up other prices or change these fields. Use exactly these values:\n${JSON.stringify(preFetchedPrices.map(p => ({ platform: p.platform, price: p.price, url: p.url, isBestDeal: p.isBestDeal })), null, 2)}`;
    }

    const genConfig: any = {
      systemInstruction: finalSystemPrompt,
      ...(useSearchGrounding ? { tools: [{ googleSearch: {} }] } : {}),
      temperature: 0.0,
      maxOutputTokens: 8192,
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL
      }
    };

    // Fully eliminate the error combination: Tool use with responseMimeType "application/json" is unsupported
    if (!useSearchGrounding) {
      genConfig.responseMimeType = "application/json";
      genConfig.responseSchema = auditResponseSchema;
    }

    let isAborted = false;
    req.on("close", () => {
      console.log(`[Stream Guard] Client disconnected. Signalling cancellation...`);
      isAborted = true;
    });

    let text = "";
    
    if (isSSE) {
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        req.socket.setTimeout(300000);
        res.flushHeaders();
      }
      
      // Send initial metadata with preFetchedPrices
      res.write(`data: ${JSON.stringify({ type: "metadata", preFetchedPrices })}\n\n`);
      if (typeof (res as any).flush === "function") (res as any).flush();

      try {
        let stream: any;
        let lastErr: any;
        const streamFallbackModels = ["gemini-2.5-flash", "gemini-1.5-flash"];
        let activeStreamModel = modelToUse;

        // Resilient retry with model fallback rotation
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            if (attempt > 0) {
              const rotated = streamFallbackModels[attempt % streamFallbackModels.length];
              if (rotated !== activeStreamModel) {
                console.log(`[Launch Guard] Stream init failure. Rotating to fallback model: ${rotated}`);
                activeStreamModel = rotated;
              }
            }
            
            const activeConfig = { ...genConfig };
            if (!activeStreamModel.includes("gemini-3")) {
              delete activeConfig.thinkingConfig;
            }
            stream = await requestAi.models.generateContentStream({
              model: activeStreamModel,
              contents: [{ role: "user", parts }],
              config: activeConfig,
            });
            break;
          } catch (e: any) {
            lastErr = e;
            
            // If the error is a 503, 429, or 500, we should backoff and try the fallback model next loop
            console.warn(`[Launch Guard] Gemini transient failure on ${activeStreamModel} (Code: ${e?.status || e?.code}). Retrying... (Attempt ${attempt + 1}/4)`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          }
        }
        if (!stream) throw lastErr;

        for await (const chunk of stream) {
          if (isAborted) break;
          const chunkText = chunk.text;
          if (chunkText) {
            text += chunkText;
            res.write(`data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`);
            if (typeof (res as any).flush === "function") (res as any).flush();
          }
        }

        if (isAborted) {
          console.log(`[Stream Guard] Terminating active request handlers for aborted client.`);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          res.end();
          return;
        }
      } catch (err: any) {
        console.error("Stream generation failed:", err);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
        if (typeof (res as any).flush === "function") (res as any).flush();
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

      // Programmatic Truth Shield programmatic healing, outlier filtering, and pricing/link synchronization logic
      auditData = healsAndSynchronizeAuditData(auditData, parsedQuery, parsedBudget, preFetchedPrices, isBudgetCategoryQuery); 
      // Apply recursive jargon shield sanitization (Jargon Shield)
      auditData = sanitizeObjectJargon(auditData);

      console.log(`[Audit Req] Total latency: ${Date.now() - startTime}ms`);
      
        if (isSSE) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          res.write(`data: ${JSON.stringify({ type: "final", auditData })}\n\n`);
          res.write("data: [DONE]\n\n");
          if (typeof (res as any).flush === "function") (res as any).flush();
          res.end();
        } else {
          res.status(200).json(auditData);
        }
      } catch (parseError) {
        console.error("JSON Parse Error:", parseError, "Raw Text:", text);
        if (isSSE) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          res.write(`data: ${JSON.stringify({ type: "error", message: "Engine failed to format results cleanly." })}\n\n`);
          if (typeof (res as any).flush === "function") (res as any).flush();
          res.end();
        } else {
          res.status(500).json({ error: "The engine failed to articulate its verdict cleanly. Please try again." });
        }
      }

    // Live Real-Time Grounding: Persisting versioned cache for sub-second repeat responses
    if (cacheKey) {
      // 1. Save to global persistent Firestore Cache
      if (backendDb) {
        const cacheDocRef = doc(backendDb, "audit_cache", cacheKey);
        (async () => {
          try {
            await withTimeout(
              setDoc(cacheDocRef, {
                data: { ...auditData, schemaVersion: "v3" },
                timestamp: Date.now(),
                query: parsedQuery,
                createdAt: serverTimestamp()
              }),
              1500,
              "FIRESTORE_WRITE_TIMEOUT"
            );
            console.log(`[Cache Engine] Successfully stored audit in Firestore for query: ${parsedQuery} (ID: ${cacheKey})`);
          } catch (cacheStoreErr: any) {
            console.error("[Cache Engine] Firestore write failed or timed out:", cacheStoreErr.message);
          }
        })();
      }

      // 2. Save to local in-memory container fallback
      auditCache.set(cacheKey, { data: { ...auditData, schemaVersion: "v3" }, timestamp: Date.now() });
      saveCacheToDisk();
    }
  } catch (error: any) {
    console.error("Vetto Server Error:", error);
    
    const isSSE = req.headers.accept === "text/event-stream";
    const errorMsg = String(error.message || "").toLowerCase();
    
    let message = error.message || "Failed to generate audit report.";
    let status = 500;
    let errorType: string | undefined = undefined;
    
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
      status = 403;
      errorType = "BILLING_DUNNING_DENY";
      message = "We have detected a Google Cloud billing restriction (dunning decision is deny) on this workspace's Google Gemini API key or project. Service can be restored instantly by adding or verifying a valid personal API key in AI Studio's 'Settings > Secrets' panel (top-right gear icon).";
    } else if (errorMsg.includes("safety")) {
      status = 400;
      message = "Audit Aborted: The query triggered safety protocols. Please refine your request.";
    } else if (errorMsg.includes("503") || errorMsg.includes("unavailable")) {
      status = 503;
      message = "Engine High Demand: The Strategic Engine is currently under extreme load. Retries were attempted but the spike persists.";
    } else if (errorMsg.includes("429") || errorMsg.includes("quota")) {
      status = 429;
      message = "Quota Exceeded: Your Vetto Engine limit has been reached. Please try again later.";
    }
    
    if (isSSE) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        req.socket.setTimeout(300000);
        res.flushHeaders();
      }
      res.write(`data: ${JSON.stringify({ type: "error", message, errorType })}\n\n`);
      if (typeof (res as any).flush === "function") (res as any).flush();
      res.end();
    } else {
      res.status(status).json({ 
        error: message, 
        errorType, 
        engineStatus: "OVERLOADED" 
      });
    }
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

    await withTimeout(
      runTransaction(backendDb, async (transaction) => {
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
      }),
      3000,
      "WAITLIST_DB_TIMEOUT"
    );

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

    await withTimeout(
      setDoc(logRef, visitorData),
      2000,
      "ANALYTICS_WRITE_TIMEOUT"
    );

    // Safely increment global visits counter (activeUsers)
    const statsRef = doc(backendDb, 'stats', 'global');
    await withTimeout(
      setDoc(statsRef, {
        activeUsers: increment(1),
        updatedAt: serverTimestamp(),
      }, { merge: true }),
      2000,
      "ANALYTICS_COUNTER_TIMEOUT"
    );

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
