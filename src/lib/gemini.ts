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
      stockStatus?: string;
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
  images?: string[],
  onProgress?: (partial: Partial<Recommendation>, preFetchedPrices?: any[]) => void
): Promise<Recommendation> {
  const maxRetries = 3;
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream"
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
        // If it's a critical non-retryable error (like 403/Forbidden for Billing restriction or 401/Unauthorized)
        if ([401, 403].includes(response.status)) {
          const errorData = await response.json().catch(() => ({}));
          const customErr = new Error(errorData.message || errorData.error || `Access Denied: ${response.status}`);
          (customErr as any).errorType = errorData.errorType;
          (customErr as any).rawError = errorData.error;
          throw customErr;
        }

        // If it's a transient server error or quota limit (429, 500, 502, 503, 504), retry with backoff + jitter
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < maxRetries - 1) {
          const jitter = Math.random() * 800;
          const delay = (1000 * Math.pow(2, attempt)) + jitter;
          console.warn(`Gateway/Server transient error ${response.status} on attempt ${attempt + 1}. Retrying in ${Math.round(delay)}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (response.status === 429) {
          throw new Error("Quota Exceeded: Your Vetto Engine limit has been reached. Please try again later.");
        }

        const errorData = await response.json().catch(() => ({}));
        const customErr = new Error(errorData.message || errorData.error || `Audit Server Error: ${response.status}`);
        (customErr as any).errorType = errorData.errorType;
        (customErr as any).rawError = errorData.error;
        throw customErr;
      }

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("text/event-stream")) {
        // If it's an unstable state but could be transient, retry
        if (attempt < maxRetries - 1) {
          const jitter = Math.random() * 800;
          const delay = 1000 + jitter;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        
        const text = await response.text().catch(() => "N/A");
        console.error("Non-SSE Response Body:", text);
        throw new Error(`The Vetto Engine returned an unstable state (Format: ${contentType || 'Unknown'}). This usually happens during peak demand.`);
      }

      if (!response.body) throw new Error("No response body in stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      
      let fullText = "";
      let preFetchedPrices: any[] = [];
      let buffer = "";
      
      let lastUpdateTime = 0;
      const { jsonrepair } = await import("jsonrepair");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || ""; // Keep the last incomplete chunk in the buffer
        
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.replace("data: ", "").trim();
            if (dataStr === "[DONE]") continue;
            
            try {
              const data = JSON.parse(dataStr);
              if (data.type === "metadata") {
                preFetchedPrices = data.preFetchedPrices || [];
              } else if (data.type === "error") {
                throw new Error(data.message || "Engine stream aborted due to an error");
              } else if (data.type === "chunk") {
                fullText += data.text;
                if (onProgress) {
                  const now = Date.now();
                  // Throttle UI updates to max 10fps to prevent browser freeze
                  if (now - lastUpdateTime > 100) {
                    lastUpdateTime = now;
                    try {
                      const cleaned = cleanJsonString(fullText);
                      const repaired = jsonrepair(cleaned);
                      onProgress(JSON.parse(repaired), preFetchedPrices);
                    } catch (e) {
                      // ignore parse errors for partial chunks
                    }
                  }
                }
              } else if (data.type === "final") {
                return data.auditData as Recommendation;
              }
            } catch (err) {
              if (err instanceof Error && err.message !== "Failed to parse SSE chunk") {
                throw err;
              }
              console.warn("Failed to parse SSE chunk", dataStr);
            }
          }
        }
      }
      
      throw new Error("Stream closed before receiving final payload");
    } catch (error: any) {
      lastError = error;

      // If it's a billing/access error, do not retry, just throw immediately
      if (error.errorType === "BILLING_DUNNING_DENY" || error.status === 403 || error.status === 401) {
        break;
      }

      // If it's a network error or generic fetch failure, retry with backoff + jitter
      const isNetworkError = error.message?.includes("fetch") || 
                             error.message?.includes("NetworkError") || 
                             error.message?.includes("Failed to fetch") ||
                             error.message?.includes("network") ||
                             error.message?.includes("JSON") ||
                             error.name === "SyntaxError";

      if (isNetworkError && attempt < maxRetries - 1) {
        const jitter = Math.random() * 800;
        const delay = (1000 * Math.pow(2, attempt)) + jitter;
        console.warn(`Network transient failure on attempt ${attempt + 1}. Retrying in ${Math.round(delay)}ms...`, error);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }

  console.error("Client Audit Error:", lastError);
  const finalError = new Error(`Engine Link Lost: ${lastError?.message || "Unknown Error"}`);
  (finalError as any).errorType = lastError?.errorType;
  (finalError as any).rawError = lastError?.rawError;
  throw finalError;
}

export function cleanJsonString(str: string): string {
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
