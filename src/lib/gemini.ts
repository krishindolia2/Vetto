export interface Recommendation {
  id?: string;
  timestamp?: number;
  isAnalysis: boolean;
  productName: string;
  isComparison: boolean;
  finalDecision: string;
  pros: string[];
  cons: string[];
  winner?: string;
  loser?: string;
  comparisonDelta?: string;
  whyBest: string;
  aamAadmiSummary: string;
  avoid: string;
  regretWarning: string;
  confidenceScore: number;
  regretRisk: "Low" | "Medium" | "High";
  whyRegret: string;
  saferChoice: string;
  personalizedInsight: string;
  socialHook: string;
  postOutputHook: string;
  marketTiming: "BUY" | "WAIT" | "RUN";
  marketReasoning: string;
  specLongevity: string;
  paisaVasoolIndex: number;
  statusTax: number;
  utilityScore: number;
  hiddenCosts: string;
  platformWarShield: {
    hasMarketingSilos: boolean;
    siloExposure: string;
    truthResilienceScore: number;
    bypassStrategyUsed: string;
  };
  vettoContrast: {
    alternativeName: string;
    whyContrast: string;
    pviBoost: number;
    priceDelta: string;
    fairPriceTarget: string;
    procurementGuidance: string;
    strategicAdvantage: string;
  };
  strategicRoadmap: {
    immediateAction: string;
    peakUtilityAge: string;
    exitStrategy: string;
  };
  communityPulse: {
    redditConsensus: string;
    twitterPulse: string;
    youtubeReality: string;
    linkedinProfessional: string;
    topUSP: string;
    topGripe: string;
  };
  lifecyclePhase: {
    status: string;
    isObsoleteSoon: boolean;
    nextMajorUpdate: string;
  };
  priceIntegrity: {
    currentPriceAudit: string;
    historicalContext: string;
    priceHistory: {
      month: string;
      price: number;
    }[];
    dealScore: number;
    discountStrategy: string;
    procurementLinks: {
      platform: string;
      label: string;
      price: string;
      isBestDeal: boolean;
      url?: string;
    }[];
  };
  bhartiyaPersonaAudit: string;
  technicalNode?: string;
  buildIntegrity?: string;
  resaleValueNode?: string;
  ecosystemLockIn?: string;
  socialAudit: {
    aggregatedRating: number;
    sentimentSplit: {
      positive: number;
      negative: number;
      mixed: number;
    };
    criticsConsensus: string;
    userRealityCheck: string;
    integrityAudit: {
      isFakeReviewRisk: boolean;
      fakeReviewScore: number;
      botSignalDetection: string;
      verifiedPurchaseTruth: string;
      crossPlatformPatterns: {
        platform: string;
        sentiment: number; // 0-100
        botRisk: "Low" | "Medium" | "High";
      }[];
      divergenceIndex: number; // 0-100 (Difference between marketing vs reality)
      buzzwordSlayer: {
        term: string;
        reality: string;
      }[];
    };
  };
  features: {
    name: string;
    score: number; // 0-100
    details: string;
  }[];
}

export async function getRecommendation(
  query: string, 
  budget?: string, 
  useCase?: string,
  history?: Recommendation[],
  images?: string[]
): Promise<Recommendation> {
  const maxRetries = 3;
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          budget,
          useCase,
          history,
          images,
        }),
      });

      if (!response.ok) {
        // If it's a transient server error (502, 503, 504), retry
        if ([502, 503, 504].includes(response.status) && attempt < maxRetries - 1) {
          const delay = 1000 * Math.pow(2, attempt);
          console.warn(`Gateway/Server transient error ${response.status}. Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (response.status === 429) {
          throw new Error("Quota Exceeded: Your Gemini API limit has been reached. Please try again later.");
        }
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Audit Server Error: ${response.status}`);
      }

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        // If it's an unstable state but could be transient, retry
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        const text = await response.text().catch(() => "N/A");
        console.error("Non-JSON Response Body:", text);
        throw new Error(`The Vetto Engine returned an unstable state (Format: ${contentType || 'Unknown'}). This usually happens during peak demand.`);
      }

      return await response.json();
    } catch (error: any) {
      lastError = error;
      // If it's a network error, retry
      if ((error.message?.includes("fetch") || error.message?.includes("NetworkError")) && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      break;
    }
  }

  console.error("Client Audit Error:", lastError);
  throw new Error(`Engine Link Lost: ${lastError?.message || "Unknown Error"}`);
}
