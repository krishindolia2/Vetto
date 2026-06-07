import React, { useState } from 'react';
import { 
  Shirt, Cpu, Car, ShieldAlert, Sparkles, AlertTriangle, 
  CheckCircle2, DollarSign, MessageSquare, ThumbsUp, 
  HelpCircle, ShieldCheck, ArrowRight, Activity
} from 'lucide-react';

export default function App() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [audit, setAudit] = useState<any>(null);

  const handleAuditRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query) return;
    
    setLoading(true);
    try {
      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await response.json();
      setAudit(data);
    } catch (error) {
      console.error("Vetto Dashboard Pipeline Error:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#060608] text-[#F3F4F6] font-sans antialiased selection:bg-amber-500/30">
      {/* Luxury Minimalist Background Highlights */}
      <div className="absolute top-0 left-1/3 w-[500px] h-[500px] bg-gradient-to-tr from-amber-500/5 to-transparent rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute top-1/2 right-1/4 w-[400px] h-[400px] bg-gradient-to-br from-blue-500/5 to-transparent rounded-full blur-[140px] pointer-events-none" />

      {/* Navigation Bar */}
      <header className="border-b border-white/5 backdrop-blur-md sticky top-0 z-50 bg-[#060608]/90">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span className="text-2xl font-black tracking-widest bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent">
              VETTO
            </span>
            <span className="text-[10px] uppercase tracking-widest bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded border border-white/5 font-mono">
              Pro Preview
            </span>
          </div>
          <div className="text-xs font-mono text-zinc-500 tracking-wider">IND_MARKET_MATRIX_2026</div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-16">
        {/* Search & Input Framework */}
        <section className="text-center mb-16">
          <h1 className="text-4xl sm:text-6xl font-extralight tracking-tight text-white mb-4">
            Demystify Value. <span className="font-serif italic font-normal text-amber-400">Expose Hype.</span>
          </h1>
          <p className="text-zinc-400 max-w-2xl mx-auto text-sm sm:text-base leading-relaxed">
            India's independent, zero-affiliate consumer shield. We dissect marketing layers and analyze real buyer experiences across electronics, fashion, and vehicles.
          </p>

          <form onSubmit={handleAuditRequest} className="mt-10 max-w-2xl mx-auto relative group">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a laptop, smartphone, clothing brand, or vehicle..."
              className="w-full bg-[#0E0E12] border border-white/10 rounded-full px-8 py-5 text-sm focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/50 transition-all duration-300 pr-40 placeholder:text-zinc-600 shadow-2xl group-hover:border-white/15"
            />
            <button
              type="submit"
              disabled={loading}
              className="absolute right-2 top-2 bottom-2 bg-gradient-to-r from-zinc-100 to-zinc-300 hover:from-white hover:to-white text-black font-semibold text-xs tracking-wider uppercase rounded-full px-8 transition-all duration-200 disabled:opacity-50 flex items-center space-x-2"
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
              ) : (
                <span>Audit Now</span>
              )}
            </button>
          </form>
        </section>

        {/* Loading Analytics State */}
        {loading && (
          <div className="py-24 text-center space-y-4 max-w-md mx-auto">
            <div className="w-10 h-10 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
            <p className="text-xs font-mono text-amber-400 tracking-widest uppercase animate-pulse">
              Vetto Agent is scouring local specifications & live community gripes...
            </p>
          </div>
        )}

        {/* THE NEW USER DASHBOARD CORE */}
        {!loading && audit && (
          <div className="space-y-8 animate-fade-in">
            
            {/* SECTION 1: PRIMARY VERDICT & SCORE OVERVIEW */}
            <div className="bg-[#0E0E12] border border-white/5 rounded-2xl p-6 sm:p-8 relative overflow-hidden shadow-2xl">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 border-b border-white/5 pb-6">
                <div>
                  <div className="flex items-center space-x-2 text-xs font-mono text-zinc-500 uppercase tracking-widest mb-1.5">
                    <Activity className="w-3.5 h-3.5 text-amber-400" />
                    <span>Instant Live Analysis ({audit.vertical})</span>
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
                    {audit.auditData?.analyzed_item_name || audit.resolvedProduct}
                  </h2>
                </div>

                {/* Score Indicators */}
                <div className="flex items-center space-x-6">
                  <div className="text-left">
                    <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Value For Money</div>
                    <div className="text-3xl font-extrabold text-amber-400 font-mono">
                      {audit.auditData?.value_for_money_score || 50}<span className="text-xs text-zinc-600">/100</span>
                    </div>
                  </div>
                  <div className={`px-8 py-3 rounded-xl text-xs font-bold tracking-widest uppercase font-mono shadow-inner border ${
                    audit.auditData?.recommendation === 'BUY' 
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                      : 'bg-red-500/10 text-red-400 border-red-500/20'
                  }`}>
                    Official Verdict: {audit.auditData?.recommendation || 'SKIP'}
                  </div>
                </div>
              </div>

              {/* The Anchor Executive Hook Statement */}
              <div className="mt-6">
                <p className="text-lg sm:text-xl font-serif italic text-zinc-200 leading-relaxed">
                  "{audit.auditData?.hook_statement}"
                </p>
              </div>
            </div>

            {/* SECTION 2: DYNAMIC SPECIFIC INDUSTRY INSIGHTS */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {audit.vertical === 'electronics' && (
                <>
                  <div className="bg-[#0E0E12] border border-white/5 rounded-xl p-6">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1 font-mono">Hardware Ceiling</h4>
                    <p className="text-sm font-medium text-red-400 mt-2">{audit.auditData?.bottleneck_warning || "N/A"}</p>
                  </div>
                  <div className="bg-[#0E0E12] border border-white/5 rounded-xl p-6 text-center">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1 font-mono">Thermal Performance Index</h4>
                    <div className="text-3xl font-bold text-purple-400 font-mono mt-2">{audit.auditData?.thermal_throttling_index || 0}</div>
                    <p className="text-[10px] text-zinc-600 mt-1">Higher means more heat slowdown</p>
                  </div>
                  <div className="bg-[#0E0E12] border border-white/5 rounded-xl p-6 text-center">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1 font-mono">Expected Support Lifecycle</h4>
                    <div className="text-3xl font-bold text-zinc-300 font-mono mt-2">{audit.auditData?.longevity_rating_years || 0} <span className="text-xs text-zinc-500">Years</span></div>
                  </div>
                </>
              )}

              {audit.vertical === 'fashion' && (
                <>
                  <div className="bg-[#0E0E12] border border-white/5 rounded-xl p-6 text-center">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1 font-mono">Material Honesty Ratio</h4>
                    <div className="text-3xl font-bold text-blue-400 font-mono mt-2">{audit.auditData?.material_honesty_score || 0}%</div>
                  </div>
                  <div className="bg-[#0E0E12] border border-white/5 rounded-xl p-6 text-center">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1 font-mono">Fabric Density Weight</h4>
                    <div className="text-3xl font-bold text-zinc-300 font-mono mt-2">{audit.auditData?.gsm_weight || 0} <span className="text-xs text-zinc-500">GSM</span></div>
                  </div>
                  <div className="bg-[#0E0E12] border border-white/5 rounded-xl p-6">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1 font-mono">Sizing Alignment</h4>
                    <p className="text-sm font-semibold text-amber-400 mt-2">{audit.auditData?.sizing_alert || "True to Size"}</p>
                  </div>
                </>
              )}

              {audit.vertical === 'automotive' && (
                <>
                  <div className="bg-[#0E0E12] border border-white/5 rounded-xl p-6 flex flex-col justify-between">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest font-mono">Crash Test Rating</h4>
                    <div className="text-base font-bold text-zinc-200 mt-2 bg-zinc-800 px-3 py-1 rounded border border-white/5 inline-block w-max font-mono">
                      {audit.auditData?.safety_rating_ncap || "Not Tested"}
                    </div>
                  </div>
                  <div className="bg-[#0E0E12] border border-white/5 rounded-xl p-6 md:col-span-2 flex items-center justify-between">
                    <div>
                      <h4 className="text-xs text-zinc-500 uppercase tracking-widest font-mono">5-Year Projected Cost of Ownership</h4>
                      <p className="text-[11px] text-zinc-500">Includes fuel/charging, regular maintenance & insurance curves</p>
                    </div>
                    <div className="text-2xl font-bold text-amber-400 font-mono">
                      ₹{(audit.auditData?.total_cost_of_ownership_5yr || 0).toLocaleString('en-IN')}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* SECTION 3: MARKETING HYPED VS. ACTUAL REALITY REVIEWS */}
            <div className="bg-[#0E0E12] border border-white/5 rounded-2xl p-6 sm:p-8 space-y-6">
              <h3 className="text-xs font-mono text-zinc-400 uppercase tracking-widest flex items-center space-x-2 border-b border-white/5 pb-4">
                <MessageSquare className="w-4 h-4 text-amber-400" />
                <span>Marketing Claims vs. Actual Buyer Reality</span>
              </h3>

              {/* Jargon or Hype Checklist Loop */}
              {audit.vertical === 'electronics' && audit.auditData?.jargon_demystifier ? (
                <div className="space-y-3">
                  {audit.auditData.jargon_demystifier.map((item: any, idx: number) => (
                    <div key={idx} className="bg-[#131318] border border-white/5 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-2">
                      <div className="text-xs font-mono font-bold bg-red-500/10 text-red-400 px-3 py-1 rounded border border-red-500/15 w-max">
                        Hype: {item.buzzword}
                      </div>
                      <div className="text-sm text-zinc-300 sm:ml-4 flex-1">
                        <span className="text-zinc-500 font-mono mr-1">Reality Check →</span> {item.honest_truth}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-[#131318] border border-white/5 rounded-xl p-4 text-sm text-zinc-300">
                  <span className="text-zinc-500 font-mono mr-1">Fabric & Wash Durability Lifecycle Report:</span> {audit.auditData?.wash_durability || "Standard commercial tier behavior tracking data output clean."}
                </div>
              )}

              {/* Real World Buyer Gripes Layout Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div className="bg-[#131318] border border-emerald-500/10 rounded-xl p-5">
                  <h4 className="text-xs font-mono text-emerald-400 uppercase tracking-widest mb-3 flex items-center space-x-2">
                    <ThumbsUp className="w-3.5 h-3.5" />
                    <span>Where It Actually Succeeds</span>
                  </h4>
                  <ul className="space-y-2 text-sm text-zinc-400">
                    {audit.auditData?.ground_truth_wins?.map((win: string, i: number) => (
                      <li key={i} className="flex items-start space-x-2">
                        <span className="text-emerald-500 mt-0.5">•</span>
                        <span>{win}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-[#131318] border border-red-500/10 rounded-xl p-5">
                  <h4 className="text-xs font-mono text-red-400 uppercase tracking-widest mb-3 flex items-center space-x-2">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Real Community Claims & Discovered Defects</span>
                  </h4>
                  <ul className="space-y-2 text-sm text-zinc-400">
                    {audit.auditData?.potential_risks?.map((risk: string, i: number) => (
                      <li key={i} className="flex items-start space-x-2">
                        <span className="text-red-500 mt-0.5">•</span>
                        <span>{risk}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {/* SECTION 4: THE ULTIMATE PAISA VASOOL ADVICE BANNER */}
            <div className="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/20 rounded-2xl p-6 sm:p-8">
              <div className="flex items-center space-x-2 text-xs font-mono text-amber-400 uppercase tracking-widest mb-3">
                <ShieldCheck className="w-4 h-4" />
                <span>Our Final Independent Advice</span>
              </div>
              <h3 className="text-xl font-medium text-white tracking-tight">
                Smarter Market Move: Switch to <span className="text-amber-400 font-bold">{audit.auditData?.smarter_alternative?.name}</span>
              </h3>
              <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
                {audit.auditData?.smarter_alternative?.justification}
              </p>

              {/* Financial Savings Metrics Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-6 border-t border-white/5">
                <div>
                  <h5 className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Estimated Brand Tax</h5>
                  <p className="text-lg font-bold font-mono text-red-400 mt-0.5">
                    ₹{(audit.auditData?.brand_tax || 0).toLocaleString('en-IN')}
                  </p>
                </div>
                <div>
                  <h5 className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Alternative Cost Target</h5>
                  <p className="text-lg font-bold font-mono text-zinc-200 mt-0.5">
                    ₹{(audit.auditData?.smarter_alternative?.alternative_cost_target || 0).toLocaleString('en-IN')}
                  </p>
                </div>
                <div className="col-span-2 bg-amber-500/5 border border-amber-500/10 rounded-xl p-3 flex items-center justify-between text-left px-4">
                  <div>
                    <h5 className="text-[9px] font-mono text-amber-500/70 uppercase tracking-wider">Arbitrage Savings</h5>
                    <p className="text-xs text-zinc-400">Total cash saved by cutting out marketing premium markup</p>
                  </div>
                  <span className="text-lg font-black font-mono text-amber-400 pl-2">
                    Extra Wallet Protection
                  </span>
                </div>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}
