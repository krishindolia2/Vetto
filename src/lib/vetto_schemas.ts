import { Type } from "@google/genai";

// ============================================================================
// 1. FASHION VERTICAL SCHEMAS & INTERFACES
// ============================================================================

export interface FashionAuditData {
  analyzed_item_name: string;
  recommendation: "BUY" | "SKIP";
  material_honesty_score: number; // 0-100 rating of fabric blend claims vs reality
  gsm_weight: number; // Fabric weight in grams per square meter (GSM)
  wash_durability: string; // Long-term behavior after multiple washes (shrinkage, bleeding, etc.)
  sizing_alert: string; // Fit advice (e.g., "Runs 1 size large, order smaller")
  value_for_money_score: number; // 0-100 rating
  brand_tax: number; // Estimated markup for logo status (in INR)
  hook_statement: string; // Engaging 2-sentence summary hook
  reasoning_summary: string; // Detailed logical breakdown of quality
  ground_truth_wins: string[]; // List of verified positive aspects (pros)
  potential_risks: string[]; // List of verified negative aspects (cons)
  smarter_alternative: {
    name: string;
    alternative_value_score: number;
    alternative_brand_surcharge: number;
    alternative_cost_target: number;
    justification: string;
  };
  extra_costs_to_watch: string; // Accessories, special wash care, etc.
}

export const FashionAuditGenAISchema = {
  type: Type.OBJECT,
  properties: {
    analyzed_item_name: { type: Type.STRING, description: "Full precise model name and brand of apparel/sneaker" },
    recommendation: { type: Type.STRING, enum: ["BUY", "SKIP"], description: "BUY or SKIP verdict" },
    material_honesty_score: { type: Type.INTEGER, description: "Honesty score of raw material/blend claims, 0-100" },
    gsm_weight: { type: Type.INTEGER, description: "Fabric density weight in GSM (grams per square meter)" },
    wash_durability: { type: Type.STRING, description: "Wash resistance, color bleeding risk, and shrinkage details" },
    sizing_alert: { type: Type.STRING, description: "Precise sizing alignment guidance (runs small/large/true)" },
    value_for_money_score: { type: Type.INTEGER, description: "Utility vs pricing score, 0-100" },
    brand_tax: { type: Type.INTEGER, description: "Estimated financial premium paid purely for brand logo in INR" },
    hook_statement: { type: Type.STRING, description: "Sharp, culturally-resonant 2-sentence opening summary hook" },
    reasoning_summary: { type: Type.STRING, description: "Mathematically sound logical truth explaining why it succeeds or fails" },
    ground_truth_wins: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Verified objective advantages/pros"
    },
    potential_risks: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Verified defects/cons/shrinkage issues"
    },
    smarter_alternative: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Brand and model name of alternative" },
        alternative_value_score: { type: Type.INTEGER, description: "0-100 value score" },
        alternative_brand_surcharge: { type: Type.INTEGER, description: "Status tax savings in INR" },
        alternative_cost_target: { type: Type.INTEGER, description: "Target price in INR" },
        justification: { type: Type.STRING, description: "Why this alternative represents superior value" }
      },
      required: ["name", "alternative_value_score", "alternative_brand_surcharge", "alternative_cost_target", "justification"]
    },
    extra_costs_to_watch: { type: Type.STRING, description: "Hidden costs like dry cleaning, premium accessories, etc." }
  },
  required: [
    "analyzed_item_name", "recommendation", "material_honesty_score", "gsm_weight",
    "wash_durability", "sizing_alert", "value_for_money_score", "brand_tax",
    "hook_statement", "reasoning_summary", "ground_truth_wins", "potential_risks",
    "smarter_alternative", "extra_costs_to_watch"
  ]
};

// ============================================================================
// 2. ELECTRONICS VERTICAL SCHEMAS & INTERFACES
// ============================================================================

export interface ElectronicsAuditData {
  analyzed_item_name: string;
  recommendation: "BUY" | "SKIP";
  bottleneck_warning: string; // e.g., "Soldered RAM limits multitasking longevity"
  thermal_throttling_index: number; // 0-100 score indicating heat generation & slowdown risk
  longevity_rating_years: number; // Expected functional lifespan before replacement
  jargon_demystifier: {
    buzzword: string;
    honest_truth: string;
  }[]; // Deconstructs marketing jargon
  value_for_money_score: number;
  brand_tax: number;
  hook_statement: string;
  reasoning_summary: string;
  ground_truth_wins: string[];
  potential_risks: string[];
  smarter_alternative: {
    name: string;
    alternative_value_score: number;
    alternative_brand_surcharge: number;
    alternative_cost_target: number;
    justification: string;
  };
  extra_costs_to_watch: string; // e.g., mandatory charger, screen replacement costs
}

export const ElectronicsAuditGenAISchema = {
  type: Type.OBJECT,
  properties: {
    analyzed_item_name: { type: Type.STRING, description: "Full canonical model name and specs tier" },
    recommendation: { type: Type.STRING, enum: ["BUY", "SKIP"], description: "BUY or SKIP verdict" },
    bottleneck_warning: { type: Type.STRING, description: "Soldered components, memory ceilings, or port limits" },
    thermal_throttling_index: { type: Type.INTEGER, description: "Sustained workload heat and performance slowdown index, 0-100" },
    longevity_rating_years: { type: Type.INTEGER, description: "Estimated software support/hardware health cycle in years" },
    jargon_demystifier: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          buzzword: { type: Type.STRING, description: "Marketing hype buzzword (e.g., Retina, AI-Battery)" },
          honest_truth: { type: Type.STRING, description: "Brutal reality of what it actually means" }
        },
        required: ["buzzword", "honest_truth"]
      }
    },
    value_for_money_score: { type: Type.INTEGER, description: "Utility vs price score, 0-100" },
    brand_tax: { type: Type.INTEGER, description: "Premium charged purely for marketing/logo in INR" },
    hook_statement: { type: Type.STRING, description: "Sharp, 2-sentence opening summary hook" },
    reasoning_summary: { type: Type.STRING, description: "Logical explanation showing exact value math" },
    ground_truth_wins: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Verified hardware advantages"
    },
    potential_risks: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Verified hardware flaws/compromises"
    },
    smarter_alternative: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Brand and model of alternative" },
        alternative_value_score: { type: Type.INTEGER, description: "0-100 value score" },
        alternative_brand_surcharge: { type: Type.INTEGER, description: "Status tax savings in INR" },
        alternative_cost_target: { type: Type.INTEGER, description: "Target price in INR" },
        justification: { type: Type.STRING, description: "Why this alternative is superior" }
      },
      required: ["name", "alternative_value_score", "alternative_brand_surcharge", "alternative_cost_target", "justification"]
    },
    extra_costs_to_watch: { type: Type.STRING, description: "Hidden costs like power bricks, cases, repairs" }
  },
  required: [
    "analyzed_item_name", "recommendation", "bottleneck_warning", "thermal_throttling_index",
    "longevity_rating_years", "jargon_demystifier", "value_for_money_score", "brand_tax",
    "hook_statement", "reasoning_summary", "ground_truth_wins", "potential_risks",
    "smarter_alternative", "extra_costs_to_watch"
  ]
};

// ============================================================================
// 3. AUTOMOTIVE VERTICAL SCHEMAS & INTERFACES
// ============================================================================

export interface AutomotiveAuditData {
  analyzed_item_name: string;
  recommendation: "BUY" | "SKIP";
  total_cost_of_ownership_5yr: number; // Sum of fuel/charging, insurance, maintenance, and depreciation (in INR)
  safety_rating_ncap: string; // NCAP rating (e.g., "5-Star Global NCAP", "Not Tested")
  resale_value_retention_curve: {
    year: number;
    retention_percentage: number;
  }[]; // Projected value depreciation mapping
  value_for_money_score: number;
  brand_tax: number;
  hook_statement: string;
  reasoning_summary: string;
  ground_truth_wins: string[];
  potential_risks: string[];
  smarter_alternative: {
    name: string;
    alternative_value_score: number;
    alternative_brand_surcharge: number;
    alternative_cost_target: number;
    justification: string;
  };
  extra_costs_to_watch: string; // e.g., battery replacement costs for EV, mandatory logistics charges
}

export const AutomotiveAuditGenAISchema = {
  type: Type.OBJECT,
  properties: {
    analyzed_item_name: { type: Type.STRING, description: "Full canonical model, trim, and transmission type" },
    recommendation: { type: Type.STRING, enum: ["BUY", "SKIP"], description: "BUY or SKIP verdict" },
    total_cost_of_ownership_5yr: { type: Type.INTEGER, description: "Calculated 5-year running cost including fuel, insurance, and service in INR" },
    safety_rating_ncap: { type: Type.STRING, description: "Verified NCAP crash test rating and active safety suite status" },
    resale_value_retention_curve: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          year: { type: Type.INTEGER, description: "Year 1 to 5 of ownership" },
          retention_percentage: { type: Type.INTEGER, description: "Percentage of original value retained, 0-100" }
        },
        required: ["year", "retention_percentage"]
      },
      description: "Yearly resale depreciation mapping"
    },
    value_for_money_score: { type: Type.INTEGER, description: "Utility vs capital cost score, 0-100" },
    brand_tax: { type: Type.INTEGER, description: "Estimated markup for badge prestige in INR" },
    hook_statement: { type: Type.STRING, description: "Sharp, 2-sentence opening summary hook" },
    reasoning_summary: { type: Type.STRING, description: "Logical explanation showing lifecycle math" },
    ground_truth_wins: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Verified mechanical/chassis strengths"
    },
    potential_risks: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Verified parts, safety, or reliability flaws"
    },
    smarter_alternative: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Brand and model of alternative vehicle" },
        alternative_value_score: { type: Type.INTEGER, description: "0-100 value score" },
        alternative_brand_surcharge: { type: Type.INTEGER, description: "Prestige tax savings in INR" },
        alternative_cost_target: { type: Type.INTEGER, description: "Target price in INR" },
        justification: { type: Type.STRING, description: "Why this vehicle represents superior long-term value" }
      },
      required: ["name", "alternative_value_score", "alternative_brand_surcharge", "alternative_cost_target", "justification"]
    },
    extra_costs_to_watch: { type: Type.STRING, description: "Hidden costs like battery packs, road tax, mandatory dealer add-ons" }
  },
  required: [
    "analyzed_item_name", "recommendation", "total_cost_of_ownership_5yr", "safety_rating_ncap",
    "resale_value_retention_curve", "value_for_money_score", "brand_tax",
    "hook_statement", "reasoning_summary", "ground_truth_wins", "potential_risks",
    "smarter_alternative", "extra_costs_to_watch"
  ]
};
