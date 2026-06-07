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
  const sanitizeText = (text: string): string => {
    if (!text) return "";
    return text
      .replace(/paisa\s*vasool/gi, "Value for Money")
      .replace(/brand\s*tax/gi, "Brand Markup")
      .replace(/aam\s*aadmi/gi, "everyday consumer")
      .replace(/bharatiya/gi, "Indian")
      .replace(/thermal\s*throttling/gi, "heat slowdown")
      .replace(/ncap/gi, "Crash Safety")
      .replace(/gsm\s*weight/gi, "Fabric Density")
      .replace(/jargon\s*demystifier/gi, "Marketing Hype Slayer")
      .replace(/smarter\s*alternative/gi, "Better Value Alternative");
  };

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

            {/* Row 2: Buzzword Slaying Board & Dynamic Specific Telemetry */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
              
              {/* Buzzword Slaying Board (3/5 Columns) */}
              <div className="md:col-span-3 bg-white border border-slate-200/60 rounded-3xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.015)] space-y-6">
                <div className="flex justify-between items-center border-b border-slate-100 pb-4">
                  <span className="text-[10px] font-mono tracking-widest text-slate-400 font-bold uppercase flex items-center space-x-2">
                    <MessageSquare className="w-4 h-4 text-blue-600" />
                    <span>Marketing Hype Slayer</span>
                  </span>
                  <span className="text-[9px] px-2 py-0.5 bg-rose-50 border border-rose-100 text-rose-600 rounded font-mono font-bold uppercase">
                    Interactive Strikethrough
                  </span>
                </div>

                <p className="text-xs text-slate-400">
                  Select and click on marketing claims below to strike them out and reveal the reality behind the buzzwords.
                </p>

                {/* Grid of Buzzwords */}
                <div className="flex flex-wrap gap-2 pt-2">
                  {getBuzzwordsList(audit).map((item: any, idx: number) => {
                    const isSlashed = slashedBuzzwords.includes(item.buzzword);
                    return (
                      <button
                        key={idx}
                        onClick={() => {
                          toggleSlashedBuzzword(item.buzzword);
                          setActiveBuzzwordDetail(item);
                        }}
                        className={`text-xs px-4 py-2 rounded-full border transition-all duration-300 flex items-center space-x-2 cursor-pointer ${
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

                {/* Buzzword Explanation Card */}
                {activeBuzzwordDetail && (
                  <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-5 space-y-2 mt-4 animate-fade-in">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800">{activeBuzzwordDetail.buzzword}</span>
                      <span className={`text-[9px] px-2 py-0.5 rounded font-mono font-semibold ${
                        slashedBuzzwords.includes(activeBuzzwordDetail.buzzword) 
                          ? 'bg-rose-100 text-rose-700' 
                          : 'bg-blue-100 text-blue-700'
                      }`}>
                        {slashedBuzzwords.includes(activeBuzzwordDetail.buzzword) ? 'SLASHED' : 'CLAIM'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed font-sans pt-1">
                      {activeBuzzwordDetail.honest_truth}
                    </p>
                  </div>
                )}
              </div>

              {/* Dynamic Specific Telemetry Bento (2/5 Columns) */}
              <div className="md:col-span-2 bg-white border border-slate-200/60 rounded-3xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.015)] space-y-6">
                <div className="border-b border-slate-100 pb-4">
                  <span className="text-[10px] font-mono tracking-widest text-slate-400 font-bold uppercase">
                    Forensic Specifications
                  </span>
                </div>

                {/* Electronics Telemetry */}
                {audit.vertical === 'electronics' && (
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <h4 className="text-xs text-slate-500 font-medium">Internal Lifespan Limits</h4>
                      <p className="text-sm font-semibold text-rose-600 bg-rose-50/50 border border-rose-100 rounded-xl p-3">
                        {audit.auditData?.bottleneck_warning || "No severe hardware limitations identified."}
                      </p>
                    </div>
                    
                    <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-150">
                      <div>
                        <h4 className="text-xs text-slate-500 font-medium">Estimated Build Longevity</h4>
                        <p className="text-[10px] text-slate-400 mt-0.5">Software & part life cycle</p>
                      </div>
                      <span className="text-2xl font-bold font-mono text-slate-800">
                        {audit.auditData?.longevity_rating_years || 3} <span className="text-xs text-slate-400 font-sans">Years</span>
                      </span>
                    </div>

                    <div className="space-y-2">
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
                  <div className="space-y-6">
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

                    <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-150">
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
                      <p className="text-xs font-semibold text-amber-600 bg-amber-50/50 border border-amber-100 rounded-xl p-3">
                        {audit.auditData?.sizing_alert || "True to standard size specs."}
                      </p>
                    </div>
                  </div>
                )}

                {/* Automotive Telemetry */}
                {audit.vertical === 'automotive' && (
                  <div className="space-y-6">
                    <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-150">
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
                      <div className="space-y-3">
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

            {/* Row 4: Better Value Option Advice Block */}
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
