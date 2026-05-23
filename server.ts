import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { initializeApp as initializeFirebase } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

dotenv.config();

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

// Retry helper for transient failures with fallback capability
async function callGeminiWithRetry(params: GeminiParams, retries = 8, baseDelay = 1000) {
  if (!ai) throw new Error("AI not initialized");
  
  const targetModel = params.model || "gemini-3.5-flash"; // Default to 3.5-flash
  const fallbackModels = [
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite"
  ];
  
  let currentModel = targetModel;
  
  for (let i = 0; i < retries; i++) {
    try {
      // Start rotating models earlier (after 2 failures) to bypass localized demand spikes
      if (i >= 2) {
        const nextModel = fallbackModels[i % fallbackModels.length];
        if (nextModel !== currentModel) {
          console.log(`[Resiliency Engine] Rotating to stable backup: ${nextModel} (Attempt ${i + 1})`);
          currentModel = nextModel;
        }
      }
      
      const callParams = { ...params, model: currentModel };
      
      // Clean up config for models that do not support thinking (only Gemini 3 series does)
      if (!currentModel.includes("gemini-3")) {
        if (callParams.config?.thinkingConfig) {
          console.log(`[Resiliency Engine] Stripping thinkingConfig for non-Gemini-3 model: ${currentModel}`);
          delete callParams.config.thinkingConfig;
        }
      }

      return await ai.models.generateContent(callParams);
    } catch (error: any) {
      const errorMsg = error.message?.toLowerCase() || "";
      const status = error.status || error.code || 0;
      const isTransient = errorMsg.includes("503") || 
                          errorMsg.includes("502") ||
                          errorMsg.includes("504") ||
                          errorMsg.includes("bad gateway") ||
                          errorMsg.includes("gateway") ||
                          errorMsg.includes("unavailable") ||
                          errorMsg.includes("429") ||
                          errorMsg.includes("high demand") ||
                          errorMsg.includes("too many requests") ||
                          errorMsg.includes("fetch failed") ||
                          errorMsg.includes("deadline exceeded") ||
                          [502, 503, 504, 429].includes(status);
      
      if (isTransient && i < retries - 1) {
        // More aggressive exponential backoff with jitter
        const jitter = Math.random() * 1500;
        const delay = (baseDelay * Math.pow(1.5, i)) + jitter;
        
        console.warn(`[Launch Guard] Gemini transient failure on ${currentModel} (Code: ${error.message}). Retrying in ${Math.round(delay)}ms... (Attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

const defaultAuditData = {
  isAnalysis: true,
  productName: "Product Audit",
  isComparison: false,
  finalDecision: "Verdict Pending (Engine Timeout)",
  whyBest: "The audit was partially generated due to high token demand.",
  pros: ["Incomplete response from underlying engine"],
  cons: ["Incomplete response from underlying engine"],
  aamAadmiSummary: "Analysis data not provided.",
  avoid: "",
  regretWarning: "",
  confidenceScore: 50,
  regretRisk: "Medium",
  whyRegret: "",
  saferChoice: "",
  marketTiming: "Neutral",
  marketReasoning: "",
  specLongevity: "",
  personalizedInsight: "",
  socialHook: "Vetto Audit",
  postOutputHook: "",
  paisaVasoolIndex: 50,
  statusTax: 0,
  utilityScore: 50,
  hiddenCosts: "None identified before truncation.",
  platformWarShield: {
    hasMarketingSilos: false,
    siloExposure: "Data trace cut off",
    truthResilienceScore: 50,
    bypassStrategyUsed: "Fallback shield activated"
  },
  vettoContrast: {
    alternativeName: "Safe Alternative",
    whyContrast: "Deep contrast trace interrupted",
    pviBoost: 0,
    priceDelta: "₹0",
    fairPriceTarget: "₹0",
    procurementGuidance: "Verify on primary platforms directly",
    strategicAdvantage: "Interrupted"
  },
  priceIntegrity: {
    currentPriceAudit: "Trace cut off",
    historicalContext: "Trace cut off",
    priceHistory: [
      { month: "Jan", price: 0 }
    ],
    dealScore: 50,
    discountStrategy: "Trace cut off",
    procurementLinks: [
      { platform: "Amazon", label: "Search Amazon", price: "Check Live", isBestDeal: true, url: "https://www.amazon.in" }
    ]
  },
  strategicRoadmap: {
    immediateAction: "Retry the audit in a few seconds",
    peakUtilityAge: "N/A",
    exitStrategy: "N/A"
  },
  communityPulse: {
    redditConsensus: "Interrupted",
    twitterPulse: "Interrupted",
    youtubeReality: "Interrupted",
    linkedinProfessional: "Interrupted",
    topUSP: "Interrupted",
    topGripe: "Interrupted"
  },
  lifecyclePhase: {
    status: "Active",
    isObsoleteSoon: false,
    nextMajorUpdate: "Next Generation"
  },
  bhartiyaPersonaAudit: "Audit interrupted due to network congestion.",
  technicalNode: "Trace cut off",
  buildIntegrity: "Trace cut off",
  resaleValueNode: "Trace cut off",
  ecosystemLockIn: "Trace cut off",
  features: [
    { name: "General Integrity", score: 50, details: "Technical analysis pending" }
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
const CACHE_TTL = 1000 * 60 * 60 * 24 * 365; // 365 days to ensure perfect consistency

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
              url: { type: Type.STRING, description: "Direct product or keyword search query URL to verify on platform (e.g., https://www.amazon.in/s?k=product+name)" }
            },
            required: ["platform", "label", "price", "isBestDeal", "url"]
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

app.post("/api/audit", securityGuard, async (req, res) => {
  if (!ai) {
    return res.status(401).json({ 
      error: "Vetto Engine Core not initialized. Please ensure GEMINI_API_KEY is set." 
    });
  }

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
          { platform: "Amazon", label: "Search Amazon India", price: "Live Price", isBestDeal: true, url: "https://www.amazon.in" },
          { platform: "Flipkart", label: "Search Flipkart India", price: "Live Price", isBestDeal: false, url: "https://www.flipkart.com" }
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
  const budgetDigits = (budget || "").replace(/[^0-9]/g, "");
  const normBudget = budgetDigits ? budgetDigits : (budget || "").toLowerCase().trim();
  const normUseCase = (useCase || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();

  // Create a safe, standardized Firestore-compatible document ID from the normalized key
  const cacheKey = !images || images.length === 0 
    ? Buffer.from(`${normQuery}-${normBudget}-${normUseCase}`).toString('base64').replace(/[/+=]/g, '_')
    : null;

  if (cacheKey) {
    // 1. First attempt to fetch from persistent, global Firestore-based Shared Cache
    if (backendDb) {
      try {
        const cacheDocRef = doc(backendDb, "audit_cache", cacheKey);
        const cacheSnap = await getDoc(cacheDocRef);
        if (cacheSnap.exists()) {
          const cached = cacheSnap.data();
          if (Date.now() - (cached.timestamp || 0) < CACHE_TTL) {
            console.log(`[Cache Engine] Serving global Firestore cached verdict for: ${query} (ID: ${cacheKey})`);
            return res.json(cached.data);
          }
        }
      } catch (cacheErr) {
        console.error("[Cache Engine] Firestore read failure. Falling back to in-memory local cache.", cacheErr);
      }
    }

    // 2. Fall back to local in-memory container cache (essential if Firestore is offline or slow)
    if (auditCache.has(cacheKey)) {
      const cached = auditCache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`[Cache Engine] Serving local in-memory container cached verdict for: ${query} (Key: ${cacheKey})`);
        return res.json(cached.data);
      }
      auditCache.delete(cacheKey);
      saveCacheToDisk();
    }
  }

  try {
    const currentDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const historyText = history && history.length > 0 
      ? `\nPrevious Decisions History (Brief):\n${history.slice(0, 3).map((h: any, i: number) => `Decision ${i+1}: ${h.productName} -> ${h.marketTiming} (${h.finalDecision.substring(0, 50)}...)`).join('\n')}`
      : '';

    const promptText = `CURRENT DATE: ${currentDate}
Establish Strategic Audit for: ${query || "Analyzed Visual Evidence"}
Target Capital: ${budget || 'Unlimited'}
Strategic Context: ${useCase || 'General Deployment'}${historyText}

${images && images.length > 0 ? "IMPORTANT: Analyze the attached screenshots meticulously. Look for technical specifications, material quality indicators, marketing traps, and real-world durability markers." : ""}`;

    const systemPrompt = `You are Vetto (The Founder's Truth Engine). Your mission: Protect the hard-earned money of the Indian consumer.
You provide the absolute FINAL verdict. No generic summaries. No hallucinations.

STRICT PRICING & SCORING PROTOCOLS:
1. VALUE FOR MONEY (Paisa Vasool): 0-100. Be strict. 90+ is rare (unbeatable value). 50 is average. <30 is a ripoff.
2. BRAND PREMIUM (Status Tax): Calculate the EXACT currency difference (in ₹) between this product and a similarly specced reliable alternative from a less "hyped" brand. Do not guess; base it on current market listings.
3. UTILITY SCORE: 0-100. Based purely on features that actually work as advertised in real-world Indian conditions (heat, dust, connectivity).
4. TRUTH DIVERGENCE: 0-100. Higher means the marketing is lying more compared to Reddit/Twitter owner reports.
5. REVIEW AUTHENTICITY: 0-100. Low scores if you detect bot patterns, repetitive phrasing, or disproportionate 5-star ratings.
6. DEAL RATING: 0-100. 100 means historical low. 0 means peak price/MSRP trap.
7. TARGET PRICE: This MUST be the scientifically calculated "Fair Value" you should pay. Use historical sale patterns (Big Billion Days, Prime Day) to determine the logical entry point.
8. PRICE COMPARISON & VERIFICATION LINKS:
    - You MUST provide live-accurate pricing for major Indian platforms like Amazon.in, Flipkart, Reliance Digital, Croma, and Official Brand Stores.
    - Provide direct clickable verifying search or product URLs for each vendor in the "procurementLinks" array under the "url" property.
    - For Amazon, use: https://www.amazon.in/s?k=[urlencoded_product_name]
    - For Flipkart, use: https://www.flipkart.com/search?q=[urlencoded_product_name]
    - For Croma, use: https://www.croma.com/search/?text=[urlencoded_product_name]
    - For Reliance Digital, use: https://www.reliancedigital.in/search?q=[urlencoded_product_name]
    - For Official Brand Stores or others, use their search URL or their primary landing page.
    - This ensures the user can instantly click, verify real-time price accuracy, check stock delivery timelines, and securely buy the item.
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

TONE: Brutally honest, protective, and simple. Use "Bhartiya" context. You are the user's smart elder brother. No technical jargon. Accuracy in pricing is our lifeblood. Ensure "Status Tax" feels like a real penalty for buying a badge.`;

    console.log(`[Audit Req] Start: ${query?.substring(0, 50) || "Visual Analysis"} (${images?.length || 0} images)`);
    const startTime = Date.now();
    const modelToUse = "gemini-3.5-flash";
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
    const useSearchGrounding = true;
    
    console.log(`[Cache Engine] Active Mode: Live Google Search Grounding for maximum platform price integrity`);

    const genResponse = await callGeminiWithRetry({
      model: modelToUse,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: systemPrompt + 
          "\n\nCRITICAL REQUIREMENT FOR ZERO LATENCY & SPEED:\n" +
          "Your response must comply 100% with the strict JSON structure. Because the structure is extensive, YOU MUST keep every text value extremely short, terse, and punchy. " +
          "Each text field (definitions, details, summaries, reasons) must be at most 1 short sentence or quick phrase. Do not generate multi-sentence text. This is absolutely essential to achieve ultra-fast generation and low latency.",
        ...(useSearchGrounding ? { tools: [{ googleSearch: {} }] } : {}),
        responseMimeType: "application/json",
        responseSchema: auditResponseSchema,
        temperature: 0.0,
        maxOutputTokens: 8192,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.LOW,
        },
      }
    });

    const duration = Date.now() - startTime;
    console.log(`[Audit Req] Model finished in ${duration}ms`);

    let text = "";
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

      // Post-process to guarantee direct, working, user-friendly live links on Indian platforms
      if (auditData?.priceIntegrity?.procurementLinks && Array.isArray(auditData.priceIntegrity.procurementLinks)) {
        const prodName = auditData.productName || parsedQuery || "product";
        const encodedProdName = encodeURIComponent(prodName);
        auditData.priceIntegrity.procurementLinks = auditData.priceIntegrity.procurementLinks.map((link: any) => {
          let rawUrl = link.url || "";
          
          // Clean up model-generated placeholder tags
          if (rawUrl.includes("[urlencoded_product_name]")) {
            rawUrl = rawUrl.replace(/\[urlencoded_product_name\]/g, encodedProdName);
          } else if (rawUrl.includes("urlencoded_product_name")) {
            rawUrl = rawUrl.replace(/urlencoded_product_name/g, encodedProdName);
          }
          
          const platformLower = (link.platform || "").toLowerCase();
          
          // If URL is missing, invalid, or just highlights a generic root domain, reconstruct a proper direct search link
          const isGeneric = !rawUrl || 
                            rawUrl === "https://www.amazon.in" || 
                            rawUrl === "https://www.flipkart.com" || 
                            rawUrl === "https://www.croma.com" || 
                            rawUrl === "https://www.reliancedigital.in" ||
                            (!rawUrl.includes("?") && !rawUrl.includes("/p/") && !rawUrl.includes("/s?"));
                            
          if (isGeneric) {
            if (platformLower.includes("amazon")) {
              rawUrl = `https://www.amazon.in/s?k=${encodedProdName}`;
            } else if (platformLower.includes("flipkart")) {
              rawUrl = `https://www.flipkart.com/search?q=${encodedProdName}`;
            } else if (platformLower.includes("croma")) {
              rawUrl = `https://www.croma.com/search/?text=${encodedProdName}`;
            } else if (platformLower.includes("reliance")) {
              rawUrl = `https://www.reliancedigital.in/search?q=${encodedProdName}`;
            } else if (!rawUrl) {
              rawUrl = `https://www.google.com/search?q=${encodedProdName}`;
            }
          }
          
          // Ensure protocol is present
          if (rawUrl && !rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
            rawUrl = "https://" + rawUrl;
          }
          
          return {
            ...link,
            url: rawUrl
          };
        });
      }
    } catch (parseError) {
      console.error("JSON Parse Error. Raw Text:", text, "Parsing error:", parseError);
      // Absolute fallback: secure default object
      auditData = deepMerge(defaultAuditData, {});
    }

    // Store in cache if applicable
    if (cacheKey) {
      // 1. Save to global persistent Firestore Cache
      if (backendDb) {
        try {
          const cacheDocRef = doc(backendDb, "audit_cache", cacheKey);
          await setDoc(cacheDocRef, {
            data: auditData,
            timestamp: Date.now(),
            query: parsedQuery,
            createdAt: serverTimestamp()
          });
          console.log(`[Cache Engine] Successfully stored audit in Firestore for query: ${parsedQuery} (ID: ${cacheKey})`);
        } catch (cacheStoreErr) {
          console.error("[Cache Engine] Firestore write failure:", cacheStoreErr);
        }
      }

      // 2. Save to local in-memory container fallback
      auditCache.set(cacheKey, { data: auditData, timestamp: Date.now() });
      saveCacheToDisk();
    }

    res.json(auditData);
  } catch (error: any) {
    console.error("Vetto Server Error:", error);
    
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
