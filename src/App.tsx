import React, { useState } from 'react';
import { 
  Shirt, 
  Cpu, 
  Car, 
  ShieldAlert, 
  TrendingDown, 
  Sparkles, 
  HelpCircle,
  AlertTriangle,
  CheckCircle2,
  DollarSign
} from 'lucide-react';

// Import our TypeScript interfaces from the schemas file we just created
import { FashionAuditData, ElectronicsAuditData, AutomotiveAuditData } from './lib/vetto_schemas';

interface AuditResponse {
  vertical: 'fashion' | 'electronics' | 'automotive' | 'generic';
  queryType: 'category' | 'specific' | 'comparison';
  resolvedProduct: string;
  auditData: FashionAuditData & ElectronicsAuditData & AutomotiveAuditData; // Union for UI typing comfort
}

export default function App() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [audit, setAudit] = useState<AuditResponse | null>(null);

  // Simulated API call handler to trigger your Node/Express backend
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
      console.error("Vetto Pipeline UI Error:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0C] text-[#F3F4F6] font-sans antialiased selection:bg-amber-500/30">
      {/* Premium Luxury Background Accents */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-blue-500/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Navigation Header */}
      <header className="border-b border-white/5 backdrop-blur-md sticky top-0 z-50 bg-[#0A0A0C]/80">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span className="text-2xl font-black tracking-widest bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent">
              VETTO
            </span>
            <span className="text-[10px] uppercase tracking-widest bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded border border-white/5 font-mono">
              Pro Preview
            </span>
          </div>
          <div className="text-xs font-mono text-zinc-500">IND_MARKET_MATRIX_2026</div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        {/* Core Input Engine Card */}
        <section className="text-center mb-16">
          <h1 className="text-4xl sm:text-5xl font-light tracking-tight text-white mb-4">
            Demystify Value. <span className="font-serif italic font-normal text-amber-400">Expose Hype.</span>
          </h1>
          <p className="text-zinc-400 max-w-xl mx-auto text-sm sm:text-base leading-relaxed">
            A zero-affiliate forensic audit network uncovering raw manufacturing truth, structural defects, and localized market metrics across major consumption verticals.
          </p>

          <form onSubmit={handleAuditRequest} className="mt-8 max-w-2xl mx-auto relative group">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter item name (e.g., MacBook M3 Pro, Royal Enfield 450, Premium Cotton Hoodie)..."
              className="w-full bg-[#121215] border border-white/10 rounded-full px-6 py-4 text-sm focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/50 transition-all duration-300 pr-36 placeholder:text-zinc-600 shadow-2xl group-hover:border-white/20"
            />
            <button
              type="submit"
              disabled={loading}
              className="absolute right-2 top-2 bottom-2 bg-gradient-to-r from-zinc-100 to-zinc-300 hover:from-white hover:to-white text-black font-medium text-xs tracking-wider uppercase rounded-full px-6 transition-all duration-200 disabled:opacity-50 flex items-center space-x-2"
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span>Audit Now</span>
                </>
              )}
            </button>
          </form>
        </section>

        {/* Audit Report Presentation Screen */}
        {loading && (
          <div className="py-20 text-center space-y-4">
            <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm font-mono text-zinc-500 tracking-wider uppercase animate-pulse">
              Deep Research Agent is scouring local specifications & live community gripes...
            </p>
          </div>
        )}

        {!loading && audit && (
          <div className="space-y-8 animate-fade-in">
            
            {/* Verdict Summary Header Section */}
            <div className="bg-[#121215] border border-white/5 rounded-2xl p-6 sm:p-8 relative overflow-hidden shadow-2xl">
              <div className={`absolute top-0 right-0 w-32 h-32 opacity-10 rounded-full blur-2xl ${audit.auditData.recommendation === 'BUY' ? 'bg-emerald-500' : 'bg-red-500'}`} />
              
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/5 pb-6">
                <div>
                  <div className="flex items-center space-x-2 text-xs font-mono text-zinc-500 uppercase tracking-widest mb-1">
                    {audit.vertical === 'fashion' && <Shirt className="w-3.5 h-3.5 text-blue-400" />}
                    {audit.vertical === 'electronics' && <Cpu className="w-3.5 h-3.5 text-purple-400" />}
                    {audit.vertical === 'automotive' && <Car className="w-3.5 h-3.5 text-amber-400" />}
                    <span>{audit.vertical} Audit Matrix</span>
                  </div>
                  <h2 className="text-2xl font-semibold text-white tracking-tight">{audit.resolvedProduct}</h2>
                </div>

                <div className="flex items-center space-x-4">
                  <div className="text-right">
                    <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Paisa Vasool Score</div>
                    <div className="text-2xl font-bold text-amber-400 font-mono">{audit.auditData.value_for_money_score}<span className="text-xs text-zinc-600">/100</span></div>
                  </div>
                  <div className={`px-6 py-2 rounded-xl text-sm font-bold tracking-widest uppercase font-mono shadow-inner border ${
                    audit.auditData.recommendation === 'BUY' 
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                      : 'bg-red-500/10 text-red-400 border-red-500/20'
                  }`}>
                    {audit.auditData.recommendation}
                  </div>
                </div>
              </div>

              {/* Hook Statement / Clinical Overview */}
              <div className="mt-6">
                <p className="text-lg font-serif italic text-zinc-200 leading-relaxed">
                  "{audit.auditData.hook_statement}"
                </p>
                <p className="text-sm text-zinc-400 mt-3 leading-relaxed">
                  {audit.auditData.reasoning_summary}
                </p>
              </div>

              {/* Financial Status Tax Breakdown */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6 pt-6 border-t border-white/5">
                <div className="bg-[#18181C] border border-white/5 rounded-xl p-4 flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <DollarSign className="w-5 h-5 text-red-400" />
                    <div>
                      <h4 className="text-xs text-zinc-500 uppercase tracking-wider">Premium Status Tax</h4>
                      <p className="text-xs text-zinc-400 font-mono mt-0.5">Paid purely for branding</p>
                    </div>
                  </div>
                  <span className="text-lg font-semibold text-zinc-200 font-mono">₹{audit.auditData.brand_tax.toLocaleString('en-IN')}</span>
                </div>

                <div className="bg-[#18181C] border border-white/5 rounded-xl p-4 flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <ShieldAlert className="w-5 h-5 text-zinc-400" />
                    <div>
                      <h4 className="text-xs text-zinc-500 uppercase tracking-wider">Hidden Cost Exposures</h4>
                      <p className="text-xs text-zinc-400 font-mono mt-0.5">Post-purchase leakage</p>
                    </div>
                  </div>
                  <span className="text-xs text-zinc-300 max-w-[180px] text-right truncate">{audit.auditData.extra_costs_to_watch}</span>
                </div>
              </div>
            </div>

            {/* CONDITIONAL VERTICAL METRICS LAYOUT ENGINE */}
            
            {/* 1. Fashion Presentation Card */}
            {audit.vertical === 'fashion' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-[#121215] border border-white/5 rounded-xl p-5 text-center">
                  <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Material Honesty</h4>
                  <div className="text-3xl font-bold text-blue-400 font-mono">{audit.auditData.material_honesty_score}%</div>
                  <p className="text-[11px] text-zinc-500 mt-2">Fabric purity vs advertised claims</p>
                </div>
                <div className="bg-[#121215] border border-white/5 rounded-xl p-5 text-center">
                  <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Fabric Weight</h4>
                  <div className="text-3xl font-bold text-zinc-200 font-mono">{audit.auditData.gsm_weight} <span className="text-xs text-zinc-500">GSM</span></div>
                  <p className="text-[11px] text-zinc-500 mt-2">Weave density and material structural thickness</p>
                </div>
                <div className="bg-[#121215] border border-white/5 rounded-xl p-5 text-center">
                  <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Sizing Alignment</h4>
                  <div className="text-xs font-semibold text-amber-400 mt-3 px-2 py-1 bg-amber-500/5 rounded border border-amber-500/10 truncate">
                    {audit.auditData.sizing_alert}
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-2">Verified crowd fit adjustments</p>
                </div>
                <div className="bg-[#121215] border border-white/5 rounded-xl p-5 sm:col-span-3 text-left">
                  <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-2 font-mono">Wash & Lifecycle Durability Metrics</h4>
                  <p className="text-sm text-zinc-300 leading-relaxed">{audit.auditData.wash_durability}</p>
                </div>
              </div>
            )}

            {/* 2. Electronics Presentation Card */}
            {audit.vertical === 'electronics' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="bg-[#121215] border border-white/5 rounded-xl p-5 text-center">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Sustained Thermal Load</h4>
                    <div className="text-3xl font-bold text-purple-400 font-mono">{audit.auditData.thermal_throttling_index}<span className="text-xs text-zinc-600">/100</span></div>
                    <p className="text-[11px] text-zinc-500 mt-2">Higher index matches aggressive performance slowdowns</p>
                  </div>
                  <div className="bg-[#121215] border border-white/5 rounded-xl p-5 text-center">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Support Lifecycle</h4>
                    <div className="text-3xl font-bold text-zinc-200 font-mono">{audit.auditData.longevity_rating_years} <span className="text-xs text-zinc-500">Years</span></div>
                    <p className="text-[11px] text-zinc-500 mt-2">Estimated software support & component lifespan</p>
                  </div>
                  <div className="bg-[#121215] border border-white/5 rounded-xl p-5 text-left flex flex-col justify-center">
                    <h4 className="text-xs text-zinc-500 uppercase tracking-widest mb-1 font-mono">Hardware Ceiling</h4>
                    <p className="text-xs text-red-400 font-medium leading-tight mt-1">{audit.auditData.bottleneck_warning}</p>
                  </div>
                </div>

                {/* Jargon Demystifier Interactive Accordion Layout */}
                <div className="bg-[#121215] border border-white/5 rounded-xl p-6">
                  <h4 className="text-xs font-mono text-zinc-400 uppercase tracking-widest mb-4 flex items-center space-x-2">
                    <Sparkles className="w-4 h-4 text-purple-400" />
                    <span>Marketing Jargon Demystified</span>
                  </h4>
                  <div className="space-y-3">
                    {audit.auditData.jargon_demystifier?.map((item, idx) => (
                      <div key={idx} className="bg-[#18181C] border border-white/5 rounded-lg p-3 text-sm">
                        <span className="font-semibold text-zinc-300 font-mono bg-zinc-800 px-2 py-0.5 rounded text-xs mr-2">{item.buzzword}</span>
                        <span className="text-zinc-400">→ {item.honest_truth}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 3. Automotive Presentation Card */}
            {audit.vertical === 'automotive' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="bg-[#121215] border border-white/5 rounded-xl p-5 flex items-center justify-between">
                    <div>
                      <h4 className="text-xs text-zinc-500 uppercase tracking-widest">5-Year True Lifecycle Cost</h4>
                      <p className="text-[11px] text-zinc-500 mt-0.5">Fuel + Scheduled Services + Protection Insurance</p>
                    </div>
                    <div className="text-xl font-bold text-amber-400 font-mono">₹{audit.auditData.total_cost_of_ownership_5yr.toLocaleString('en-IN')}</div>
                  </div>
                  <div className="bg-[#121215] border border-white/5 rounded-xl p-5 flex items-center justify-between">
                    <div>
                      <h4 className="text-xs text-zinc-500 uppercase tracking-widest">Crashworthiness Rating</h4>
                      <p className="text-[11px] text-zinc-500 mt-0.5">Verified Structural Integrity Database</p>
                    </div>
                    <div className="text-xs font-semibold px-3 py-1 bg-zinc-800 text-zinc-200 border border-white/10 rounded font-mono uppercase tracking-wider">
                      {audit.auditData.safety_rating_ncap}
                    </div>
                  </div>
                </div>

                {/* Resale Retention Chart Element */}
                <div className="bg-[#121215] border border-white/5 rounded-xl p-6">
                  <h4 className="text-xs font-mono text-zinc-400 uppercase tracking-widest mb-4 flex items-center space-x-2">
                    <TrendingDown className="w-4 h-4 text-amber-400" />
                    <span>Projected 5-Year Resale Value Retention Curves</span>
                  </h4>
                  <div className="grid grid-cols-5 gap-2 pt-4">
                    {audit.auditData.resale_value_retention_curve?.map((point, idx) => (
                      <div key={idx} className="text-center space-y-2">
                        <div className="text-[10px] text-zinc-500 font-mono uppercase">Yr {point.year}</div>
                        <div className="bg-zinc-900 h-16 w-full rounded relative flex items-end">
                          <div 
                            style={{ height: `${point.retention_percentage}%` }}
                            className="bg-gradient-to-t from-amber-500/20 to-amber-500/60 w-full rounded-b transition-all duration-500"
                          />
                        </div>
                        <div className="text-xs font-mono text-zinc-300">{point.retention_percentage}%</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Pros and Cons Dual Columns Split Panel */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="bg-[#121215] border border-emerald-500/10 rounded-xl p-6">
                <h3 className="text-xs font-mono text-emerald-400 uppercase tracking-widest mb-4 flex items-center space-x-2">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Ground Truth Advantages</span>
                </h3>
                <ul className="space-y-3">
                  {audit.auditData.ground_truth_wins?.map((win, idx) => (
                    <li key={idx} className="text-sm text-zinc-400 flex items-start space-x-2">
                      <span className="text-emerald-500 mt-1 text-xs">•</span>
                      <span>{win}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-[#121215] border border-red-500/10 rounded-xl p-6">
                <h3 className="text-xs font-mono text-red-400 uppercase tracking-widest mb-4 flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Verified Risks & Product Flaws</span>
                </h3>
                <ul className="space-y-3">
                  {audit.auditData.potential_risks?.map((risk, idx) => (
                    <li key={idx} className="text-sm text-zinc-400 flex items-start space-x-2">
                      <span className="text-red-500 mt-1 text-xs">•</span>
                      <span>{risk}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Smarter Alternative Arbitrage Vector Component */}
            <div className="bg-gradient-to-r from-amber-500/5 via-transparent to-transparent border border-amber-500/20 rounded-2xl p-6 sm:p-8">
              <div className="flex items-center space-x-2 text-xs font-mono text-amber-400 uppercase tracking-widest mb-3">
                <HelpCircle className="w-4 h-4" />
                <span>Value Arbitrage Play</span>
              </div>
              <h3 className="text-lg font-medium text-white tracking-tight">
                Smarter Alternative Recommendation: <span className="text-amber-400 font-semibold">{audit.auditData.smarter_alternative?.name}</span>
              </h3>
              <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
                {audit.auditData.smarter_alternative?.justification}
              </p>

              <div className="grid grid-cols-3 gap-4 mt-6 pt-4 border-t border-white/5 text-center sm:text-left">
                <div>
                  <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Alternative Value Score</div>
                  <div className="text-xl font-bold text-zinc-200 font-mono mt-0.5">{audit.auditData.smarter_alternative?.alternative_value_score}<span className="text-xs text-zinc-600">/100</span></div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Target Deal Cost</div>
                  <div className="text-xl font-bold text-zinc-200 font-mono mt-0.5">₹{audit.auditData.smarter_alternative?.alternative_cost_target.toLocaleString('en-IN')}</div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Saved Brand Surcharge</div>
                  <div className="text-xl font-bold text-emerald-400 font-mono mt-0.5">₹{audit.auditData.smarter_alternative?.alternative_brand_surcharge.toLocaleString('en-IN')}</div>
                </div>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}
