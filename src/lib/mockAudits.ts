import { FashionAuditData, ElectronicsAuditData, AutomotiveAuditData } from "./vetto_schemas";

export interface MockAuditResponse {
  vertical: 'fashion' | 'electronics' | 'automotive' | 'generic';
  queryType: 'category' | 'specific' | 'comparison';
  resolvedProduct: string;
  auditData: FashionAuditData & ElectronicsAuditData & AutomotiveAuditData;
}

// 1. ELECTRONICS MOCK AUDIT (iPhone 16 Pro)
export const mockElectronicsAudit: MockAuditResponse = {
  vertical: "electronics",
  queryType: "specific",
  resolvedProduct: "Apple iPhone 16 Pro (128GB, Natural Titanium)",
  auditData: {
    analyzed_item_name: "Apple iPhone 16 Pro 128GB",
    recommendation: "SKIP",
    value_for_money_score: 45,
    brand_tax: 45000,
    hook_statement: "An exceptional device burdened by base storage limitations and a heavy status markup. The hardware is premium, but the pricing is pure prestige.",
    reasoning_summary: "While the camera and chip speed are industry-leading, locking high-end ProRes features behind 256GB+ models makes the 128GB base SKU a poor value proposition. The brand tax is extremely high.",
    ground_truth_wins: [
      "Excellent 120Hz ProMotion display",
      "ProRes camera versatility",
      "Industry-leading single-core CPU speeds"
    ],
    potential_risks: [
      "ProRes video recording disabled on base 128GB SKU",
      "Thermal throttling under heavy graphic rendering",
      "High repair costs without AppleCare+"
    ],
    smarter_alternative: {
      name: "iPhone 15 Pro 256GB",
      alternative_value_score: 82,
      alternative_brand_surcharge: 15000,
      alternative_cost_target: 95000,
      justification: "Offers 90% of the daily utility and performance of the 16 Pro, but provides double the storage capacity for a lower total price."
    },
    extra_costs_to_watch: "₹1,900 official charger (missing from box) and premium AppleCare+ subscription.",
    
    // Electronics specific fields
    bottleneck_warning: "128GB base storage restricts high-bitrate ProRes video recording; soldered RAM limits future AI performance.",
    thermal_throttling_index: 65,
    longevity_rating_years: 6,
    jargon_demystifier: [
      {
        buzzword: "Apple Intelligence",
        honest_truth: "A suite of on-device AI features that are heavily optimized but require standard processing. Not a reason to upgrade if you own an iPhone 15."
      },
      {
        buzzword: "Super Retina XDR",
        honest_truth: "A high-quality OLED screen with standard high-refresh rates. Excellent display, but uses standard premium panels manufactured by Samsung/LG."
      }
    ],

    // Fallback dummies for other interfaces
    material_honesty_score: 100,
    gsm_weight: 0,
    wash_durability: "",
    sizing_alert: "",
    total_cost_of_ownership_5yr: 0,
    safety_rating_ncap: "",
    resale_value_retention_curve: []
  }
};

// 2. FASHION MOCK AUDIT (Streetwear Hoodie)
export const mockFashionAudit: MockAuditResponse = {
  vertical: "fashion",
  queryType: "category",
  resolvedProduct: "Evo Vogue 450 GSM Heavyweight Oversized Hoodie",
  auditData: {
    analyzed_item_name: "Unisex Heavyweight Oversized Hoodie",
    recommendation: "BUY",
    value_for_money_score: 88,
    brand_tax: 800,
    hook_statement: "A masterclass in heavyweight cotton loopback construction. Thick, structured, and free of fast-fashion synthetic blends.",
    reasoning_summary: "Unlike typical high-street hoodies that use 50% polyester to cut costs, this hoodie uses 95% premium long-staple cotton and 5% spandex for stretch, delivering true warmth and structural drape.",
    ground_truth_wins: [
      "True 450 GSM weight feels premium",
      "Pre-shrunk fabric prevents wash shrinkage",
      "Strong double-stitched shoulder seams"
    ],
    potential_risks: [
      "Very heavy to dry in winter monsoon conditions",
      "Hood is thick and might feel bulky under light jackets"
    ],
    smarter_alternative: {
      name: "Vogue Cotton Heavyweight Pullover",
      alternative_value_score: 92,
      alternative_brand_surcharge: 500,
      alternative_cost_target: 2500,
      justification: "Matches the 450 GSM cotton specifications exactly but omits the luxury brand logo, saving you an additional ₹800 brand tax."
    },
    extra_costs_to_watch: "Requires line drying or low-temperature tumble drying to maintain bio-wash softness.",
    
    // Fashion specific fields
    material_honesty_score: 95,
    gsm_weight: 450,
    wash_durability: "Excellent colorfastness and pre-shrunk weave minimized bleeding. Handled standard machine wash cycles with less than 2% shrinkage.",
    sizing_alert: "Unisex oversized fit. Runs true to size for a relaxed streetwear silhouette. Order one size down for a standard fit.",

    // Fallback dummies for other interfaces
    bottleneck_warning: "",
    thermal_throttling_index: 0,
    longevity_rating_years: 0,
    jargon_demystifier: [],
    total_cost_of_ownership_5yr: 0,
    safety_rating_ncap: "",
    resale_value_retention_curve: []
  }
};

// 3. AUTOMOTIVE MOCK AUDIT (Electric Scooter)
export const mockAutomotiveAudit: MockAuditResponse = {
  vertical: "automotive",
  queryType: "specific",
  resolvedProduct: "Ola S1 Pro Gen 2 Electric Scooter",
  auditData: {
    analyzed_item_name: "Ola S1 Pro Gen 2",
    recommendation: "SKIP",
    value_for_money_score: 45,
    brand_tax: 15000,
    hook_statement: "Feature-loaded electric scooter held back by software reliability issues, battery replacement anxiety, and depreciation curves.",
    reasoning_summary: "The scooter offers class-leading range and acceleration. However, electric vehicle battery degradation and fast-moving software cycles result in steeper depreciation than traditional petrol-powered two-wheelers.",
    ground_truth_wins: [
      "Class-leading 0-40 km/h acceleration",
      "Excellent range on single charge",
      "Large under-seat boot space"
    ],
    potential_risks: [
      "Software glitches causing sudden screen lockouts",
      "Steep resale value drop after year 3",
      "Inconsistent service center turnaround times"
    ],
    smarter_alternative: {
      name: "Ather 450X 3.7 kWh",
      alternative_value_score: 78,
      alternative_brand_surcharge: 5000,
      alternative_cost_target: 145000,
      justification: "Features superior software stability, a proven aluminium chassis, and significantly better service network trust in India."
    },
    extra_costs_to_watch: "Requires home charger installation cost and yearly subscription for connected maps.",
    
    // Automotive specific fields
    total_cost_of_ownership_5yr: 120000,
    safety_rating_ncap: "Not Rated (Two-Wheeler)",
    resale_value_retention_curve: [
      { year: 1, retention_percentage: 70 },
      { year: 2, retention_percentage: 55 },
      { year: 3, retention_percentage: 40 },
      { year: 4, retention_percentage: 30 },
      { year: 5, retention_percentage: 20 }
    ],

    // Fallback dummies for other interfaces
    bottleneck_warning: "",
    thermal_throttling_index: 0,
    longevity_rating_years: 0,
    jargon_demystifier: [],
    material_honesty_score: 100,
    gsm_weight: 0,
    wash_durability: "",
    sizing_alert: ""
  }
};
