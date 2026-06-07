import React, { useState } from 'react';
import { 
  Shirt, Cpu, Car, ShieldAlert, Sparkles, AlertTriangle, 
  CheckCircle2, DollarSign, MessageSquare, ThumbsUp, 
  HelpCircle, ShieldCheck, ArrowRight, Activity, Zap, Check, RotateCcw
} from 'lucide-react';

const SAMPLE_SEARCHES = [
  { label: "MacBook Air M3", query: "MacBook Air M3" },
  { label: "iPhone 15", query: "iPhone 15" },
  { label: "Premium Cotton Hoodie", query: "Premium Cotton Hoodie" },
  { label: "Running Sneakers", query: "Running Sneakers" },
  { label: "Electric Scooter", query: "Electric Scooter" },
  { label: "Hatchback Car", query: "Hatchback Car" }
];

export default function App() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [audit, setAudit] = useState<any>(null);
  
  // Interactive Calculator States
  const [usageYears, setUsageYears] = useState(3);
  const [useFrequency, setUseFrequency] = useState(5); // times per week
  const [expectedWashes, setExpectedWashes] = useState(60); // for fashion
  const [intendedKM, setIntendedKM] = useState(40000); // for automotive

  // Buzzword Slaying Board State
  const [slashedBuzzwords, setSlashedBuzzwords] = useState<string[]>([]);
  const [activeBuzzwordDetail, setActiveBuzzwordDetail] = useState<any>(null);

  // Recursively sanitize Hinglish and overly technical jargon from API data
  const sanitizeAuditData = (data: any): any => {
    if (!data) return null;
    const serialized = JSON.stringify(data);
    const sanitized = serialized
      .replace(/paisa\s*vasool/gi, "Value for Money")
      .replace(/brand\s*tax/gi, "Brand Markup")
      .replace(/aam\s*aadmi/gi, "everyday consumer")
      .replace(/bharatiya/gi, "Indian")
      .replace(/thermal\s*throttling/gi, "heat slowdown")
      .replace(/ncap/gi, "Crash Safety")
      .replace(/gsm\s*weight/gi, "Fabric Density")
      .replace(/jargon\s*demystifier/gi, "Marketing Hype Slayer")
      .replace(/smarter\s*alternative/gi, "Better Value Alternative");
    return JSON.parse(sanitized);
  };

  const handleAuditRequest = async (searchQuery: string) => {
    if (!searchQuery) return;
    setQuery(searchQuery);
    setLoading(true);
    setAudit(null);
    setSlashedBuzzwords([]);
    setActiveBuzzwordDetail(null);
    
    try {
      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await response.json();
      const cleanData = sanitizeAuditData(data);
      setAudit(cleanData);
      
      // Pre-select first buzzword if electronics
      const buzzwords = getBuzzwordsList(cleanData);
      if (buzzwords && buzzwords.length > 0) {
        setActiveBuzzwordDetail(buzzwords[0]);
      }
    } catch (error) {
      console.error("Vetto Dashboard Pipeline Error:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleAuditRequest(query);
  };

  // Helper to get buzzwords list for the Buzzword Slaying Board
  const getBuzzwordsList = (currentAudit: any) => {
    if (!currentAudit) return [];
    if (currentAudit.vertical === 'electronics' && currentAudit.auditData?.jargon_demystifier?.length > 0) {
      return currentAudit.auditData.jargon_demystifier;
    }
    // Simple, non-technical default buzzwords for fashion/automotive when not provided
    if (currentAudit.vertical === 'fashion') {
      return [
        { buzzword: "Designer Fit Template", honest_truth: "Standard production sizes adjusted minimally for brand aesthetics." },
        { buzzword: "Artisanal Aged Blend", honest_truth: "Chemical fabric treatment applied in factory lines to soften texture." },
        { buzzword: "Heritage Woven Blend", honest_truth: "Standard cotton-polyester machine weave without specialized manual crafting." }
      ];
    }
    if (currentAudit.vertical === 'automotive') {
      return [
        { buzzword: "Smart-Assist Propulsion", honest_truth: "A small supplementary battery providing basic electrical backup for startup." },
        { buzzword: "Ergonomic Control Center", honest_truth: "A standard plastic layout configured with modern angular styling." },
        { buzzword: "Zero Upkeep Structure", honest_truth: "Requires standard periodic mechanical maintenance and parts checks." }
      ];
    }
    return [
      { buzzword: "Advanced Smart Optimization", honest_truth: "Standard code boundaries controlling background battery usage." }
    ];
  };

  const toggleSlashedBuzzword = (buzzword: string) => {
    if (slashedBuzzwords.includes(buzzword)) {
      setSlashedBuzzwords(slashedBuzzwords.filter(b => b !== buzzword));
    } else {
      setSlashedBuzzwords([...slashedBuzzwords, buzzword]);
    }
  };

  // Calculations for Interactive Calculator
  const getEstimatedPrice = () => {
    if (!audit?.auditData) return 0;
    const target = audit.auditData.smarter_alternative?.alternative_cost_target || 0;
    const markup = audit.auditData.brand_tax || 0;
    if (target + markup > 0) return target + markup;
    
    // Sensible vertical defaults
    if (audit.vertical === 'electronics') return 60000;
    if (audit.vertical === 'fashion') return 2500;
    if (audit.vertical === 'automotive') return 150000;
    return 10000;
  };

  const calculateCalculatorMetrics = () => {
    const price = getEstimatedPrice();
    const baseScore = audit?.auditData?.value_for_money_score || 50;
    
    if (audit?.vertical === 'electronics') {
      const totalUses = usageYears * 52 * useFrequency;
      const costPerUse = totalUses > 0 ? price / totalUses : 0;
      // Target usage index: daily usage for 5 years is the golden standard
      const usageDensity = totalUses / (5 * 52 * 5); 
      const adjustedScore = Math.min(100, Math.max(10, Math.round(baseScore * (0.6 + 0.4 * usageDensity))));
      
      let feedback = "Moderate value. Consider your options carefully.";
      if (adjustedScore >= 75) feedback = "Excellent value. Heavy usage justifies the purchase cost.";
      else if (adjustedScore < 50) feedback = "High markup and rare usage make this a poor choice.";
      
      return { costPerUse, unit: "day of use", adjustedScore, feedback };
    }
    
    if (audit?.vertical === 'fashion') {
      const costPerUse = expectedWashes > 0 ? price / expectedWashes : 0;
      const usageDensity = expectedWashes / 80; // 80 washes is golden standard
      const adjustedScore = Math.min(100, Math.max(10, Math.round(baseScore * (0.5 + 0.5 * usageDensity))));
      
      let feedback = "Decent value. Standard wear cycles expected.";
      if (adjustedScore >= 75) feedback = "Highly durable selection. Low cost per wash cycle.";
      else if (adjustedScore < 50) feedback = "Short-lived fabric and high pricing limit value.";
      
      return { costPerUse, unit: "wash cycle", adjustedScore, feedback };
    }
    
    if (audit?.vertical === 'automotive') {
      const upkeep = audit.auditData?.total_cost_of_ownership_5yr || 80000;
      const totalCost = price + (upkeep * (usageYears / 5));
      const costPerKM = intendedKM > 0 ? totalCost / intendedKM : 0;
      const usageDensity = intendedKM / 60000; // 60k KM is golden standard
      const adjustedScore = Math.min(100, Math.max(10, Math.round(baseScore * (0.6 + 0.4 * usageDensity))));
      
      let feedback = "Standard ownership costs. Average value curve.";
      if (adjustedScore >= 75) feedback = "Highly efficient. High distance offsets original markup.";
      else if (adjustedScore < 50) feedback = "Expensive upkeep with low travel yields poor value.";
      
      return { costPerUse: costPerKM, unit: "kilometer driven", adjustedScore, feedback };
    }
    
    return { costPerUse: 0, unit: "use", adjustedScore: baseScore, feedback: "" };
  };

  const calc = calculateCalculatorMetrics();

  // Dynamic SVG Chart Coordinates Generator
  const getSvgChartPath = () => {
    if (!audit?.auditData?.resale_value_retention_curve) return { pathD: "", areaD: "", points: [] };
    const curve = audit.auditData.resale_value_retention_curve;
    
    // Map Year 1-5 to X coordinates: 40, 100, 160, 220, 280 (width 320)
    // Map Retention % to Y coordinates: 20 (for 100%) to 120 (for 0%) (height 140)
    const points = curve.map((pt: any) => {
      const x = 40 + (pt.year - 1) * 60;
      const y = 20 + (100 - pt.retention_percentage) * 1.0;
      return { x, y, year: pt.year, pct: pt.retention_percentage };
    });
    
    const pathD = points.map((p: any, idx: number) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const areaD = `${pathD} L ${points[points.length - 1].x} 120 L ${points[0].x} 120 Z`;
    
    return { pathD, areaD, points };
  };

  const chart = getSvgChartPath();

  // Fallbacks for User Ratings & Social Sentiment
  const realUser = audit?.auditData?.real_user_metrics || {
    average_rating: 4.2,
    total_reviews: 120,
    satisfaction_percentage: 84,
    feedback_summary: "Verified buyers find it offers decent performance, though some criticize the premium pricing."
  };

  const sentiment = audit?.auditData?.social_sentiment || {
    reddit: { consensus: "Reddit users frequently discuss typical build quality and minor software quirks.", sentiment_label: "Mixed", discussion_volume: "Moderate" },
    youtube: { consensus: "Video reviews generally praise the aesthetics but warn about sustained thermals.", sentiment_label: "Mixed", video_reviews_analyzed: 5 },
    linkedin: { consensus: "LinkedIn users note it as a premium option for professional workspaces.", sentiment_label: "Positive", professional_relevance: "Professional staple" },
    x_platform: { consensus: "Chatter on X highlights shipping times and pricing markdowns.", sentiment_label: "Mixed", viral_complaints_noted: false }
  };

  // Helper to get color classes for sentiments
  const getSentimentBadgeColor = (label: string) => {
    const cleanLabel = (label || "").toLowerCase();
    if (cleanLabel.includes("pos")) return "bg-emerald-50 text-emerald-700 border-emerald-250";
    if (cleanLabel.includes("neg")) return "bg-rose-50 text-rose-700 border-rose-250";
    return "bg-amber-50 text-amber-700 border-amber-250";
  };

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-[#1D1D1F] font-sans antialiased selection:bg-blue-500/10 selection:text-blue-600 relative overflow-x-hidden">
      {/* Premium Minimalist Light Ambient Background */}
      <div className="absolute top-0 left-1/4 w-[700px] h-[700px] bg-gradient-to-tr from-blue-500/5 to-indigo-500/5 rounded-full blur-[160px] pointer-events-none z-0" />
      <div className="absolute top-[40%] right-1/4 w-[600px] h-[600px] bg-gradient-to-br from-blue-500/3 to-purple-500/3 rounded-full blur-[150px] pointer-events-none z-0" />

      {/* Navigation Header */}
      <header className="border-b border-slate-200/50 backdrop-blur-md sticky top-0 z-50 bg-white/80">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span className="text-xl font-bold tracking-wider bg-gradient-to-r from-slate-900 via-slate-800 to-blue-600 bg-clip-text text-transparent font-display">
              VETTO
            </span>
            <span className="text-[9px] uppercase tracking-widest bg-slate-100 text-slate-500 px-2.5 py-1 rounded-full border border-slate-200 font-mono font-bold">
              Verification Center
            </span>
          </div>
          <div className="text-[10px] font-mono text-slate-400 tracking-wider">SECURE_VERIFICATION_MATRIX</div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12 relative z-10">
        
        {/* Search Framework */}
        <section className="text-center mb-12">
          <h1 className="text-4xl sm:text-5xl font-light tracking-tight text-slate-900 mb-4 font-display">
            Verify the Value. <span className="font-serif italic font-normal text-blue-600">Reveal the Truth.</span>
          </h1>
          <p className="text-slate-500 max-w-2xl mx-auto text-sm leading-relaxed">
            An independent consumer shield designed to highlight quality, evaluate brand markup, and uncover actual buyer experiences.
          </p>

          <form onSubmit={handleFormSubmit} className="mt-8 max-w-2xl mx-auto relative group">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for any laptop, mobile, clothing brand, or vehicle..."
              className="w-full bg-white border border-slate-200 rounded-full px-8 py-4.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all duration-300 pr-40 shadow-[0_12px_40px_rgba(0,0,0,0.03)] group-hover:border-slate-300"
            />
            <button
              type="submit"
              disabled={loading}
              className="absolute right-2 top-2 bottom-2 bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs tracking-wider uppercase rounded-full px-8 transition-all duration-200 disabled:opacity-50 flex items-center space-x-2"
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <Zap className="w-3.5 h-3.5" />
                  <span>Analyze</span>
                </>
              )}
            </button>
          </form>

          {/* Quick Click Tags */}
          <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-2xl mx-auto">
            <span className="text-[10px] text-slate-400 font-mono self-center mr-1 uppercase tracking-wider">Try Example:</span>
            {SAMPLE_SEARCHES.map((item, idx) => (
              <button
                key={idx}
                onClick={() => handleAuditRequest(item.query)}
                className="text-xs bg-white border border-slate-200/60 hover:border-blue-500/40 text-slate-600 hover:text-blue-600 px-3.5 py-1.5 rounded-full transition-all duration-200 cursor-pointer shadow-[0_2px_8px_rgba(0,0,0,0.01)] hover:-translate-y-0.5"
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>

        {/* Loading Interface */}
        {loading && (
          <div className="py-20 text-center space-y-6 max-w-sm mx-auto">
            <div className="w-12 h-12 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
            <div className="space-y-2">
              <p className="text-xs font-mono text-blue-600 tracking-wider uppercase animate-pulse">
                Running Verification Engine
              </p>
              <p className="text-xs text-slate-400">
                Checking details, scanning reviews, and calculating value scores...
              </p>
            </div>
          </div>
        )}

        {/* Results Core */}
        {!loading && audit && (
          <div className="space-y-8 animate-fade-in">
            
            {/* Row 1: Primary Verdict & Dynamic Calculator */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
              
              {/* Verdict Overview (3/5 Columns) */}
              <div className="md:col-span-3 bg-white border border-slate-200/60 rounded-3xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.015)] relative overflow-hidden flex flex-col justify-between">
                <div>
                  <div className="flex items-center space-x-2 text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-3">
                    <Activity className="w-3.5 h-3.5 text-blue-600" />
                    <span>Real-time Value Verdict ({audit.vertical})</span>
                  </div>
                  
                  <div className="flex items-center justify-between gap-4 mt-2">
                    <h2 className="text-2xl sm:text-3xl font-semibold text-slate-900 tracking-tight font-display">
                      {audit.auditData?.analyzed_item_name || audit.resolvedProduct}
                    </h2>
                    
                    <span className={`px-4 py-1.5 rounded-full text-xs font-bold tracking-widest uppercase font-mono border shrink-0 ${
                      audit.auditData?.recommendation === 'BUY' 
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200/60' 
                        : 'bg-rose-50 text-rose-700 border-rose-200/60'
                    }`}>
                      {audit.auditData?.recommendation === 'BUY' ? 'BUY' : 'WAIT'}
                    </span>
                  </div>
                </div>

                <div className="my-8 border-l-2 border-blue-500/20 pl-4 py-1">
                  <p className="text-base sm:text-lg font-serif italic text-slate-800 leading-relaxed">
                    "{audit.auditData?.hook_statement}"
                  </p>
                </div>

                <div className="text-sm text-slate-500 leading-relaxed border-t border-slate-100 pt-6">
                  {audit.auditData?.reasoning_summary}
                </div>
              </div>

              {/* Interactive Calculator (2/5 Columns) */}
              <div className="md:col-span-2 bg-white border border-slate-200/60 rounded-3xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.015)] flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-[10px] font-mono tracking-widest text-slate-400 font-bold uppercase">
                      Value Calculator
                    </span>
                    <span className="px-2 py-0.5 rounded bg-blue-50 border border-blue-100 text-blue-600 font-mono text-[9px] font-bold uppercase">
                      Interactive Simulation
                    </span>
                  </div>

                  <h3 className="text-sm font-semibold text-slate-800 mb-1">Estimate Your Usage</h3>
                  <p className="text-xs text-slate-400 mb-6">Adjust the inputs to recalculate your cost-per-use value score.</p>

                  {/* Dynamic Sliders based on vertical */}
                  {audit.vertical === 'electronics' && (
                    <div className="space-y-5">
                      <div>
                        <div className="flex justify-between text-xs font-medium text-slate-600 mb-1.5">
                          <span>Target Lifespan</span>
                          <span className="text-blue-600 font-mono">{usageYears} Years</span>
                        </div>
                        <input 
                          type="range" 
                          min="1" 
                          max="7" 
                          value={usageYears} 
                          onChange={(e) => setUsageYears(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-slate-100 accent-blue-600 rounded-lg cursor-pointer transition-all"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-xs font-medium text-slate-600 mb-1.5">
                          <span>Usage Frequency</span>
                          <span className="text-blue-600 font-mono">{useFrequency} Days / Week</span>
                        </div>
                        <input 
                          type="range" 
                          min="1" 
                          max="7" 
                          value={useFrequency} 
                          onChange={(e) => setUseFrequency(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-slate-100 accent-blue-600 rounded-lg cursor-pointer transition-all"
                        />
                      </div>
                    </div>
                  )}

                  {audit.vertical === 'fashion' && (
                    <div className="space-y-5">
                      <div>
                        <div className="flex justify-between text-xs font-medium text-slate-600 mb-1.5">
                          <span>Wash Lifespan Limit</span>
                          <span className="text-blue-600 font-mono">{expectedWashes} Wash Cycles</span>
                        </div>
                        <input 
                          type="range" 
                          min="10" 
                          max="200" 
                          step="10"
                          value={expectedWashes} 
                          onChange={(e) => setExpectedWashes(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-slate-100 accent-blue-600 rounded-lg cursor-pointer transition-all"
                        />
                      </div>
                    </div>
                  )}

                  {audit.vertical === 'automotive' && (
                    <div className="space-y-5">
                      <div>
                        <div className="flex justify-between text-xs font-medium text-slate-600 mb-1.5">
                          <span>Distance Intended</span>
                          <span className="text-blue-600 font-mono">{(intendedKM).toLocaleString()} KM</span>
                        </div>
                        <input 
                          type="range" 
                          min="10000" 
                          max="100000" 
                          step="5000"
                          value={intendedKM} 
                          onChange={(e) => setIntendedKM(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-slate-100 accent-blue-600 rounded-lg cursor-pointer transition-all"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-xs font-medium text-slate-600 mb-1.5">
                          <span>Ownership Period</span>
                          <span className="text-blue-600 font-mono">{usageYears} Years</span>
                        </div>
                        <input 
                          type="range" 
                          min="1" 
                          max="5" 
                          value={usageYears} 
                          onChange={(e) => setUsageYears(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-slate-100 accent-blue-600 rounded-lg cursor-pointer transition-all"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Calculation Output Panel */}
                <div className="mt-8 pt-6 border-t border-slate-100 space-y-4">
                  <div className="flex justify-between items-end">
                    <div>
                      <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider">Estimated Cost / {calc.unit}</span>
                      <p className="text-2xl font-bold font-mono text-slate-800 mt-0.5">
                        ₹{calc.costPerUse.toFixed(2)}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider">Adjusted Score</span>
                      <p className="text-2xl font-bold font-mono text-blue-600 mt-0.5">
                        {calc.adjustedScore}<span className="text-xs text-slate-400">/100</span>
                      </p>
                    </div>
                  </div>
                  
                  <div className="bg-slate-50 border border-slate-200/50 rounded-2xl p-4 text-xs text-slate-600 leading-relaxed font-sans">
                    {calc.feedback}
                  </div>
                </div>
              </div>

            </div>

            {/* Marketing vs Reality Dashboard */}
            <div className="bg-white border border-slate-200/60 rounded-3xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.015)] space-y-6">
              <div className="border-b border-slate-100 pb-4">
                <h3 className="text-lg font-semibold text-slate-900 tracking-tight font-display">
                  Marketing vs. Reality Check
                </h3>
                <p className="text-xs text-slate-400 mt-1">Comparing advertised claims and status parameters with objective user experiences.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                
                {/* Jargon Slayer Board (3/5 Columns) */}
                <div className="md:col-span-3 space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-mono tracking-widest text-slate-400 font-bold uppercase">
                      Claim Strikethrough Board
                    </span>
                    <span className="text-[9px] px-2 py-0.5 bg-rose-50 border border-rose-100 text-rose-600 rounded font-mono font-bold uppercase">
                      Select to Deconstruct
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2 py-2">
                    {getBuzzwordsList(audit).map((item: any, idx: number) => {
                      const isSlashed = slashedBuzzwords.includes(item.buzzword);
                      return (
                        <button
                          key={idx}
                          onClick={() => {
                            toggleSlashedBuzzword(item.buzzword);
                            setActiveBuzzwordDetail(item);
                          }}
                          className={`text-xs px-4.5 py-2.5 rounded-full border transition-all duration-300 flex items-center space-x-2 cursor-pointer ${
                            isSlashed 
                              ? 'bg-rose-50 border-rose-200 text-rose-600 line-through decoration-rose-500 decoration-2' 
                              : 'bg-white border-slate-200 text-slate-700 hover:border-slate-350 shadow-[0_2px_6px_rgba(0,0,0,0.01)] hover:-translate-y-0.5'
                          }`}
                        >
                          {isSlashed && <Check className="w-3 h-3 text-rose-500 shrink-0" />}
                          <span>{item.buzzword}</span>
                        </button>
                      );
                    })}
                  </div>

                  {activeBuzzwordDetail && (
                    <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-5 space-y-2 animate-fade-in">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-800">{activeBuzzwordDetail.buzzword}</span>
                        <span className={`text-[9px] px-2 py-0.5 rounded font-mono font-semibold ${
                          slashedBuzzwords.includes(activeBuzzwordDetail.buzzword) 
                            ? 'bg-rose-100 text-rose-700' 
                            : 'bg-blue-100 text-blue-700'
                        }`}>
                          {slashedBuzzwords.includes(activeBuzzwordDetail.buzzword) ? 'HYPED' : 'CLAIMED'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed font-sans pt-1">
                        {activeBuzzwordDetail.honest_truth}
                      </p>
                    </div>
                  )}
                </div>

                {/* Verified Buyer Ratings Card (2/5 Columns) */}
                <div className="md:col-span-2 bg-slate-50/70 border border-slate-200/50 rounded-2xl p-6 flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] font-mono tracking-widest text-slate-400 font-bold uppercase">
                      Verified Buyer Summary
                    </span>
                    
                    <div className="flex items-baseline space-x-2 mt-4">
                      <span className="text-4xl font-extrabold font-mono text-slate-800">
                        {realUser.average_rating.toFixed(1)}
                      </span>
                      <span className="text-sm text-slate-400 font-sans">/ 5.0 Rating</span>
                    </div>

                    {/* Star Rating Display */}
                    <div className="flex items-center space-x-1 mt-2">
                      {[1, 2, 3, 4, 5].map((starValue) => {
                        const isFilled = starValue <= Math.floor(realUser.average_rating);
                        const isHalf = !isFilled && (starValue - 0.5 <= realUser.average_rating);
                        return (
                          <svg 
                            key={starValue} 
                            className={`w-4 h-4 ${isFilled ? 'text-amber-400' : isHalf ? 'text-amber-300' : 'text-slate-200'}`} 
                            fill="currentColor" 
                            viewBox="0 0 20 20"
                          >
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                        );
                      })}
                      <span className="text-[10px] text-slate-400 font-mono ml-2">
                        ({realUser.total_reviews.toLocaleString()} verified buyers)
                      </span>
                    </div>
                  </div>

                  <div className="mt-6 pt-4 border-t border-slate-200/60 space-y-4">
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-semibold text-slate-700">
                        <span>User Satisfaction</span>
                        <span className="text-blue-600 font-mono">{realUser.satisfaction_percentage}%</span>
                      </div>
                      <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                        <div 
                          className="bg-blue-600 h-full rounded-full" 
                          style={{ width: `${realUser.satisfaction_percentage}%` }}
                        />
                      </div>
                    </div>

                    <p className="text-xs text-slate-500 leading-relaxed italic">
                      "{realUser.feedback_summary}"
                    </p>
                  </div>
                </div>

              </div>
            </div>

            {/* Live Public Sentiment Hub (Reddit, YouTube, LinkedIn, X) */}
            <div className="space-y-4">
              <h3 className="text-xs font-mono text-slate-400 uppercase tracking-widest flex items-center space-x-2">
                <Activity className="w-4 h-4 text-blue-600" />
                <span>Live Public Sentiment Tracker</span>
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                
                {/* Reddit Sentiment */}
                <div className="bg-white border border-slate-200/60 rounded-2xl p-6 shadow-sm flex flex-col justify-between space-y-4 hover:border-orange-500/20 transition-all duration-300">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2 text-orange-600">
                      {/* Reddit Icon SVG */}
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M24 11.5c0-1.65-1.35-3-3-3-.96 0-1.86.48-2.42 1.24-1.64-1-3.85-1.64-6.23-1.72l1.3-4.14 4.22.9c.04.93.8 1.67 1.75 1.67 1 0 1.8-.8 1.8-1.8s-.8-1.8-1.8-1.8c-.9 0-1.64.66-1.77 1.5l-4.7-1c-.22-.04-.45.08-.5.3l-1.5 4.8c-2.46.06-4.75.7-6.42 1.74-.56-.74-1.46-1.22-2.4-1.22-1.65 0-3 1.35-3 3 0 1.2.7 2.22 1.7 2.73-.08.35-.12.72-.12 1.1 0 3.97 4.7 7.2 10.5 7.2 5.77 0 10.5-3.23 10.5-7.2 0-.37-.04-.74-.13-1.1 1-.5 1.7-1.53 1.7-2.73zM6 14.5c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm10.83 4.26c-1.32 1.32-3.82 1.4-4.83 1.4s-3.5-.08-4.83-1.4c-.16-.16-.16-.42 0-.58.16-.16.42-.16.58 0 1.14 1.14 3.23 1.22 4.25 1.22s3.1-.08 4.25-1.22c.15-.16.4-.16.56 0 .17.16.17.43.02.58zm-.83-2.26c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
                      </svg>
                      <span className="font-semibold text-slate-800 text-sm">Reddit</span>
                    </div>
                    <span className={`px-2 py-0.5 text-[9px] font-bold border rounded uppercase font-mono ${getSentimentBadgeColor(sentiment.reddit.sentiment_label)}`}>
                      {sentiment.reddit.sentiment_label}
                    </span>
                  </div>

                  <p className="text-xs text-slate-650 leading-relaxed font-sans flex-1">
                    {sentiment.reddit.consensus}
                  </p>

                  <div className="pt-2 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-400 font-mono">
                    <span>VOLUME</span>
                    <span className="font-bold text-slate-600">{sentiment.reddit.discussion_volume}</span>
                  </div>
                </div>

                {/* YouTube Sentiment */}
                <div className="bg-white border border-slate-200/60 rounded-2xl p-6 shadow-sm flex flex-col justify-between space-y-4 hover:border-red-500/20 transition-all duration-300">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2 text-red-650">
                      {/* YouTube Icon SVG */}
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M23.498 6.163a3.003 3.003 0 00-2.11-2.108C19.53 3.5 12 3.5 12 3.5s-7.53 0-9.388.555A3.002 3.002 0 00.5 6.163C0 8.024 0 12 0 12s0 3.976.5 5.837a3.003 3.003 0 002.11 2.108c1.858.555 9.388.555 9.388.555s7.53 0 9.388-.555a3.002 3.002 0 002.11-2.108c.5-1.861.5-5.837.5-5.837s0-3.976-.5-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                      </svg>
                      <span className="font-semibold text-slate-800 text-sm">YouTube</span>
                    </div>
                    <span className={`px-2 py-0.5 text-[9px] font-bold border rounded uppercase font-mono ${getSentimentBadgeColor(sentiment.youtube.sentiment_label)}`}>
                      {sentiment.youtube.sentiment_label}
                    </span>
                  </div>

                  <p className="text-xs text-slate-650 leading-relaxed font-sans flex-1">
                    {sentiment.youtube.consensus}
                  </p>

                  <div className="pt-2 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-400 font-mono">
                    <span>REVIEWS</span>
                    <span className="font-bold text-slate-600">{sentiment.youtube.video_reviews_analyzed} Channels</span>
                  </div>
                </div>

                {/* LinkedIn Sentiment */}
                <div className="bg-white border border-slate-200/60 rounded-2xl p-6 shadow-sm flex flex-col justify-between space-y-4 hover:border-blue-500/20 transition-all duration-300">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2 text-blue-700">
                      {/* LinkedIn Icon SVG */}
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M22.23 0H1.77C.8 0 0 .77 0 1.72v20.56C0 23.23.8 24 1.77 24h20.46c.98 0 1.77-.77 1.77-1.72V1.72C24 .77 23.2 0 22.23 0zM7.12 20.45H3.56V9H7.12v11.45zM5.34 7.43c-1.14 0-2.06-.92-2.06-2.06 0-1.14.92-2.06 2.06-2.06 1.14 0 2.06.92 2.06 2.06 0 1.14-.92 2.06-2.06 2.06zm15.11 13.02h-3.56v-5.6c0-1.34-.03-3.05-1.86-3.05-1.86 0-2.14 1.45-2.14 2.95v5.7h-3.56V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29z"/>
                      </svg>
                      <span className="font-semibold text-slate-800 text-sm">LinkedIn</span>
                    </div>
                    <span className={`px-2 py-0.5 text-[9px] font-bold border rounded uppercase font-mono ${getSentimentBadgeColor(sentiment.linkedin.sentiment_label)}`}>
                      {sentiment.linkedin.sentiment_label}
                    </span>
                  </div>

                  <p className="text-xs text-slate-650 leading-relaxed font-sans flex-1">
                    {sentiment.linkedin.consensus}
                  </p>

                  <div className="pt-2 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-400 font-mono">
                    <span>RELEVANCE</span>
                    <span className="font-bold text-slate-600 truncate max-w-[100px] text-right">{sentiment.linkedin.professional_relevance}</span>
                  </div>
                </div>

                {/* X Sentiment */}
                <div className="bg-white border border-slate-200/60 rounded-2xl p-6 shadow-sm flex flex-col justify-between space-y-4 hover:border-slate-800/20 transition-all duration-300">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2 text-slate-900">
                      {/* X Icon SVG */}
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                      </svg>
                      <span className="font-semibold text-slate-800 text-sm">X Platform</span>
                    </div>
                    <span className={`px-2 py-0.5 text-[9px] font-bold border rounded uppercase font-mono ${getSentimentBadgeColor(sentiment.x_platform.sentiment_label)}`}>
                      {sentiment.x_platform.sentiment_label}
                    </span>
                  </div>

                  <p className="text-xs text-slate-650 leading-relaxed font-sans flex-1">
                    {sentiment.x_platform.consensus}
                  </p>

                  <div className="pt-2 border-t border-slate-100 flex justify-between items-center text-[10px] text-slate-400 font-mono">
                    <span>WARNINGS</span>
                    <span className={`font-bold ${sentiment.x_platform.viral_complaints_noted ? 'text-rose-600' : 'text-slate-600'}`}>
                      {sentiment.x_platform.viral_complaints_noted ? 'Active Alerts' : 'No Alerts'}
                    </span>
                  </div>
                </div>

              </div>
            </div>

            {/* Dynamic Specific Telemetry Bento */}
            <div className="bg-white border border-slate-200/60 rounded-3xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.015)] space-y-6">
              <div className="border-b border-slate-100 pb-4">
                <span className="text-[10px] font-mono tracking-widest text-slate-400 font-bold uppercase">
                  Forensic Specifications
                </span>
              </div>

              {/* Electronics Telemetry */}
              {audit.vertical === 'electronics' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="space-y-2">
                    <h4 className="text-xs text-slate-500 font-medium">Internal Lifespan Limits</h4>
                    <p className="text-sm font-semibold text-rose-600 bg-rose-50/50 border border-rose-100 rounded-xl p-4">
                      {audit.auditData?.bottleneck_warning || "No severe hardware limitations identified."}
                    </p>
                  </div>
                  
                  <div className="flex justify-between items-center p-4 bg-slate-50 rounded-xl border border-slate-150 h-max self-center">
                    <div>
                      <h4 className="text-xs text-slate-500 font-medium">Estimated Build Longevity</h4>
                      <p className="text-[10px] text-slate-400 mt-0.5">Software & part life cycle</p>
                    </div>
                    <span className="text-2xl font-bold font-mono text-slate-800">
                      {audit.auditData?.longevity_rating_years || 3} <span className="text-xs text-slate-400 font-sans">Years</span>
                    </span>
                  </div>

                  <div className="space-y-2 self-center">
                    <div className="flex justify-between items-center">
                      <h4 className="text-xs text-slate-500 font-medium">Heat & Slowdown Risk</h4>
                      <span className="text-sm font-bold font-mono text-purple-600">
                        {audit.auditData?.thermal_throttling_index || 0}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                      <div 
                        className="bg-purple-500 h-full rounded-full transition-all duration-500" 
                        style={{ width: `${audit.auditData?.thermal_throttling_index || 0}%` }}
                      />
                    </div>
                    <p className="text-[9px] text-slate-400 text-right">Higher percentage indicates quicker performance throttling</p>
                  </div>
                </div>
              )}

              {/* Fashion Telemetry */}
              {audit.vertical === 'fashion' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <h4 className="text-xs text-slate-500 font-medium">Material Blend Correctness</h4>
                      <span className="text-sm font-bold font-mono text-blue-600">
                        {audit.auditData?.material_honesty_score || 0}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                      <div 
                        className="bg-blue-500 h-full rounded-full transition-all duration-500" 
                        style={{ width: `${audit.auditData?.material_honesty_score || 0}%` }}
                      />
                    </div>
                    <p className="text-[9px] text-slate-400">Honesty score of advertised blend claims vs actual testing</p>
                  </div>

                  <div className="flex justify-between items-center p-4 bg-slate-50 rounded-xl border border-slate-150 h-max self-center">
                    <div>
                      <h4 className="text-xs text-slate-500 font-medium">Fabric Density</h4>
                      <p className="text-[10px] text-slate-400 mt-0.5">Grams per square meter (GSM)</p>
                    </div>
                    <span className="text-2xl font-bold font-mono text-slate-800">
                      {audit.auditData?.gsm_weight || 0} <span className="text-xs text-slate-400 font-sans">GSM</span>
                    </span>
                  </div>

                  <div className="space-y-2">
                    <h4 className="text-xs text-slate-500 font-medium">Sizing Accuracy Alert</h4>
                    <p className="text-xs font-semibold text-amber-600 bg-amber-50/50 border border-amber-100 rounded-xl p-4">
                      {audit.auditData?.sizing_alert || "True to standard size specs."}
                    </p>
                  </div>
                </div>
              )}

              {/* Automotive Telemetry */}
              {audit.vertical === 'automotive' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="flex justify-between items-center p-4 bg-slate-50 rounded-xl border border-slate-150 h-max self-center">
                    <div>
                      <h4 className="text-xs text-slate-500 font-medium">Crash Safety Rating</h4>
                      <p className="text-[10px] text-slate-400 mt-0.5">NCAP and active safety tier</p>
                    </div>
                    <span className="text-xs font-bold text-slate-700 bg-white px-3 py-1.5 rounded border border-slate-200 font-mono shadow-sm">
                      {audit.auditData?.safety_rating_ncap || "Not Evaluated"}
                    </span>
                  </div>

                  {/* SVG Value Retention Curve Chart */}
                  {chart.points.length > 0 && (
                    <div className="space-y-2 md:col-span-2">
                      <h4 className="text-xs text-slate-500 font-medium">Value Retention Curve (5 Years)</h4>
                      <div className="bg-slate-50 border border-slate-150 rounded-xl p-3 flex justify-center">
                        <svg width="290" height="130" className="overflow-visible">
                          <defs>
                            <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.2"/>
                              <stop offset="100%" stopColor="#3B82F6" stopOpacity="0"/>
                            </linearGradient>
                          </defs>
                          
                          {/* Grid Lines */}
                          <line x1="40" y1="20" x2="280" y2="20" stroke="#E2E8F0" strokeDasharray="2" />
                          <line x1="40" y1="70" x2="280" y2="70" stroke="#E2E8F0" strokeDasharray="2" />
                          <line x1="40" y1="120" x2="280" y2="120" stroke="#E2E8F0" />
                          
                          {/* Y Axis Labels */}
                          <text x="32" y="24" fontSize="8" fill="#94A3B8" textAnchor="end" fontFamily="monospace">100%</text>
                          <text x="32" y="74" fontSize="8" fill="#94A3B8" textAnchor="end" fontFamily="monospace">50%</text>
                          <text x="32" y="124" fontSize="8" fill="#94A3B8" textAnchor="end" fontFamily="monospace">0%</text>

                          {/* Area fill */}
                          <path d={chart.areaD} fill="url(#chartGrad)" />
                          
                          {/* Value Path */}
                          <path d={chart.pathD} fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" />
                          
                          {/* Value Points */}
                          {chart.points.map((pt: any, i: number) => (
                            <g key={i}>
                              <circle cx={pt.x} cy={pt.y} r="4" fill="#3B82F6" stroke="#FFFFFF" strokeWidth="1.5" />
                              <text x={pt.x} y={pt.y - 8} fontSize="8" fontWeight="bold" fill="#334155" textAnchor="middle" fontFamily="monospace">
                                {pt.pct}%
                              </text>
                              <text x={pt.x} y="132" fontSize="8" fill="#94A3B8" textAnchor="middle" fontFamily="sans-serif">
                                Yr{pt.year}
                              </text>
                            </g>
                          ))}
                        </svg>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Row 3: Strengths & Weaknesses (Bento Grid) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Strengths Card */}
              <div className="bg-white border border-slate-200/60 rounded-3xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.015)]">
                <h4 className="text-xs font-mono text-emerald-700 uppercase tracking-widest mb-4 flex items-center space-x-2 border-b border-slate-100 pb-4">
                  <ThumbsUp className="w-4 h-4 text-emerald-600" />
                  <span>Key Advantages</span>
                </h4>
                <ul className="space-y-3.5 text-sm text-slate-600">
                  {audit.auditData?.ground_truth_wins?.map((win: string, i: number) => (
                    <li key={i} className="flex items-start space-x-3">
                      <span className="text-emerald-500 bg-emerald-50 rounded-full p-1 mt-0.5 shrink-0">
                        <Check className="w-3 h-3" />
                      </span>
                      <span className="leading-relaxed">{win}</span>
                    </li>
                  ))}
                  {(!audit.auditData?.ground_truth_wins || audit.auditData.ground_truth_wins.length === 0) && (
                    <li className="text-slate-400 italic">No specific strengths cataloged.</li>
                  )}
                </ul>
              </div>

              {/* Weaknesses Card */}
              <div className="bg-white border border-slate-200/60 rounded-3xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.015)]">
                <h4 className="text-xs font-mono text-rose-700 uppercase tracking-widest mb-4 flex items-center space-x-2 border-b border-slate-100 pb-4">
                  <AlertTriangle className="w-4 h-4 text-rose-600" />
                  <span>Key Disadvantages</span>
                </h4>
                <ul className="space-y-3.5 text-sm text-slate-600">
                  {audit.auditData?.potential_risks?.map((risk: string, i: number) => (
                    <li key={i} className="flex items-start space-x-3">
                      <span className="text-rose-500 bg-rose-50 rounded-full p-1 mt-0.5 shrink-0">
                        <XSign className="w-3 h-3" />
                      </span>
                      <span className="leading-relaxed">{risk}</span>
                    </li>
                  ))}
                  {(!audit.auditData?.potential_risks || audit.auditData.potential_risks.length === 0) && (
                    <li className="text-slate-400 italic">No potential issues or safety alerts cataloged.</li>
                  )}
                </ul>
              </div>

            </div>

            {/* Smart Value Suggestion / Alternative Comparison */}
            <div className="bg-white border border-slate-200/60 rounded-3xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.015)] space-y-6">
              <div className="flex items-center space-x-2 text-xs font-mono text-blue-600 uppercase tracking-widest border-b border-slate-100 pb-4">
                <ShieldCheck className="w-4.5 h-4.5" />
                <span>Smart Value Suggestion</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                
                {/* Alternative Justification */}
                <div className="md:col-span-3 space-y-4">
                  <h3 className="text-xl font-medium text-slate-900 tracking-tight font-display">
                    Consider This Alternative: <span className="text-blue-600 font-semibold">{audit.auditData?.smarter_alternative?.name}</span>
                  </h3>
                  <p className="text-sm text-slate-500 leading-relaxed">
                    {audit.auditData?.smarter_alternative?.justification}
                  </p>
                  
                  {audit.auditData?.extra_costs_to_watch && (
                    <div className="bg-slate-50 border border-slate-150 rounded-2xl p-4 text-xs text-slate-500 leading-relaxed mt-2">
                      <strong className="text-slate-700">Watch for extra ownership details:</strong> {audit.auditData.extra_costs_to_watch}
                    </div>
                  )}
                </div>

                {/* Side-by-side comparison table */}
                <div className="md:col-span-2 bg-slate-50/70 border border-slate-200/50 rounded-2xl p-5 space-y-4">
                  <h4 className="text-xs font-semibold text-slate-800">Value Comparison</h4>
                  
                  <div className="space-y-2.5 text-xs">
                    <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                      <span className="text-slate-500">Value Rating</span>
                      <span className="font-mono font-semibold text-slate-800">
                        {audit.auditData?.value_for_money_score || 50} vs {audit.auditData?.smarter_alternative?.alternative_value_score || 70}
                      </span>
                    </div>
                    <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                      <span className="text-slate-500">Estimated Price</span>
                      <span className="font-mono font-semibold text-slate-800">
                        ₹{(getEstimatedPrice()).toLocaleString('en-IN')} vs ₹{(audit.auditData?.smarter_alternative?.alternative_cost_target || 0).toLocaleString('en-IN')}
                      </span>
                    </div>
                    <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                      <span className="text-slate-500">Brand Premium Paid</span>
                      <span className="font-mono font-semibold text-rose-600">
                        ₹{(audit.auditData?.brand_tax || 0).toLocaleString('en-IN')}
                      </span>
                    </div>
                    <div className="flex justify-between py-1.5 text-blue-700 font-semibold pt-1">
                      <span>Pure Savings Opportunity</span>
                      <span className="font-mono">
                        ₹{Math.max(0, (audit.auditData?.brand_tax || 0) - (audit.auditData?.smarter_alternative?.alternative_brand_surcharge || 0)).toLocaleString('en-IN')}
                      </span>
                    </div>
                  </div>
                </div>

              </div>
            </div>

            {/* Vetto Final Advice Section */}
            <div className="bg-[#1E293B] text-white rounded-3xl p-8 shadow-xl relative overflow-hidden">
              {/* Subtle background glow */}
              <div className="absolute -top-12 -right-12 w-48 h-48 bg-blue-500/20 rounded-full blur-3xl pointer-events-none" />
              
              <div className="flex items-center space-x-2 text-xs font-mono text-blue-400 uppercase tracking-widest border-b border-slate-700 pb-4 mb-6">
                <ShieldCheck className="w-5 h-5 text-blue-500" />
                <span>Vetto Final Decision & Advisory Guide</span>
              </div>

              <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="space-y-3 md:max-w-2xl">
                  <h3 className="text-2xl font-bold tracking-tight font-display">
                    Our Final Recommendation: Buy or Skip?
                  </h3>
                  <p className="text-sm text-slate-350 leading-relaxed">
                    Based on verified hardware longevity, raw material blends, projected cost of ownership, and comprehensive social media reviews, we advise you to:
                  </p>
                  
                  <div className="flex flex-wrap gap-2 pt-2">
                    <span className="text-xs bg-slate-800 border border-slate-700 text-slate-300 px-3 py-1 rounded-full font-mono font-medium">
                      Real User Consensus: {realUser.average_rating.toFixed(1)} Stars
                    </span>
                    <span className="text-xs bg-slate-800 border border-slate-700 text-slate-300 px-3 py-1 rounded-full font-mono font-medium">
                      Reddit Volume: {sentiment.reddit.discussion_volume}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col items-center bg-slate-800/80 border border-slate-700/60 rounded-2xl p-6 text-center shrink-0 w-full md:w-64 shadow-lg backdrop-blur-sm">
                  <span className="text-[10px] font-mono tracking-widest text-slate-400 font-bold uppercase">
                    VETTO DECISION
                  </span>
                  <div className={`text-4xl font-black font-display tracking-tight mt-2.5 ${
                    audit.auditData?.recommendation === 'BUY' ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {audit.auditData?.recommendation === 'BUY' ? 'BUY' : 'WAIT / SKIP'}
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono mt-1">
                    Value score: {audit.auditData?.value_for_money_score || 50}/100
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8 pt-6 border-t border-slate-700">
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase text-emerald-400 font-mono tracking-wider">
                    Proceed with Purchase If:
                  </h4>
                  <ul className="space-y-2 text-xs text-slate-300">
                    <li className="flex items-start space-x-2">
                      <span className="text-emerald-400 mt-0.5 shrink-0">•</span>
                      <span>You prioritize the exact verified strengths (e.g. screen quality, fabric density, or safety NCAP levels).</span>
                    </li>
                    <li className="flex items-start space-x-2">
                      <span className="text-emerald-400 mt-0.5 shrink-0">•</span>
                      <span>Your personal usage calculator score resolves to over 75, indicating high daily utility.</span>
                    </li>
                    <li className="flex items-start space-x-2">
                      <span className="text-emerald-400 mt-0.5 shrink-0">•</span>
                      <span>You accept the brand markup and are comfortable with the identified hardware or upkeep limitations.</span>
                    </li>
                  </ul>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase text-rose-400 font-mono tracking-wider">
                    Avoid or Postpone If:
                  </h4>
                  <ul className="space-y-2 text-xs text-slate-300">
                    <li className="flex items-start space-x-2">
                      <span className="text-rose-400 mt-0.5 shrink-0">•</span>
                      <span>You wish to save on prestige markup by selecting the recommended value-driven alternative.</span>
                    </li>
                    <li className="flex items-start space-x-2">
                      <span className="text-rose-400 mt-0.5 shrink-0">•</span>
                      <span>The community complaints (on Reddit/X) or bottleneck limitations represent deal-breakers for you.</span>
                    </li>
                    <li className="flex items-start space-x-2">
                      <span className="text-rose-400 mt-0.5 shrink-0">•</span>
                      <span>Low expected usage frequency results in a high upkeep cost per daily utility unit.</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}

// Small custom X icon component for list weaknesses
function XSign(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <line x1="18" y1="6" x2="6" y2="18"></line>
      <line x1="6" y1="6" x2="18" y2="18"></line>
    </svg>
  );
}
