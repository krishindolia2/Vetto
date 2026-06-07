#!/bin/bash
set -e

# ==============================================================================
# VETTO.IN PRODUCTION DEPLOYMENT & AUTOMATION SCRIPT
# ==============================================================================

echo "============================================================"
echo "[VETTO DEPLOY] Starting Production Release Orchestration"
echo "============================================================"

# 1. SECURE ENV CONFIGURATION LAYER
echo "[STEP 1] Checking Secure Environment Configuration..."
if [ -z "$GEMINI_API_KEY" ]; then
    echo "  ⚠️  GEMINI_API_KEY is not set in active shell environment."
    if [ -f ".env" ]; then
        echo "  ℹ️  Found local .env file. Checking credentials securely..."
        # Safely extract GEMINI_API_KEY from .env without leaking keys
        ENV_KEY=$(grep -E "^GEMINI_API_KEY=" .env | cut -d'=' -f2- | tr -d '"'\'' ')
        if [ -n "$ENV_KEY" ]; then
            export GEMINI_API_KEY="$ENV_KEY"
            echo "  ✅ GEMINI_API_KEY successfully loaded from .env config."
        else
            echo "  ❌ ERROR: GEMINI_API_KEY could not be resolved from environment or .env file."
            exit 1
        fi
    else
        echo "  ❌ ERROR: No .env file found and GEMINI_API_KEY is not set."
        exit 1
    fi
else
    echo "  ✅ GEMINI_API_KEY is present and secured in env variables."
fi

# 2. CACHE INDEXING INJECTION ARCHITECTURE
echo -e "\n[STEP 2] Cache Database Indexing Commands (tailored for V8 Envelope Schema):"
echo "------------------------------------------------------------"
echo "SQL Index Command (PostgreSQL / MySQL):"
echo "  CREATE INDEX idx_audit_cache_v8 ON audit_cache (vertical, resolved_product, query_type);"
echo ""
echo "MongoDB Index Command:"
echo "  db.audit_cache.createIndex({ \"data.vertical\": 1, \"data.queryType\": 1, \"data.resolvedProduct\": 1 }, { name: \"idx_audit_cache_v8\" });"
echo ""
echo "Firestore Composite Index Spec:"
echo "  Collection: audit_cache"
echo "  Fields: vertical (Ascending), resolvedProduct (Ascending), queryType (Ascending)"
echo "------------------------------------------------------------"

# 3. RATE-LIMITING PROTECTION MIDDLEWARE ARCHITECTURE
echo -e "\n[STEP 3] Rate-Limiting Protection Middleware Code Spec:"
echo "------------------------------------------------------------"
cat << 'EOF'
// Drop-in implementation code for production rate-limiting in server.ts:
// Protects Tier 2 API allocation (14.4K RPD) by limiting IPs to 60 requests/hour

const productionHourlyIpHistory = new Map<string, { count: number; lastReset: number }>();
const HOURLY_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS_PER_HOUR = 60;

function productionRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers['x-vetto-auth'];
  if (authHeader === 'development') {
    return next(); // Bypass rate limiting for developer pre-cache script
  }
  
  const ip = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "unknown-ip").split(',')[0].trim();
  const now = Date.now();
  const history = productionHourlyIpHistory.get(ip);
  
  if (!history || (now - history.lastReset > HOURLY_LIMIT_WINDOW)) {
    productionHourlyIpHistory.set(ip, { count: 1, lastReset: now });
  } else {
    history.count += 1;
    if (history.count > MAX_REQUESTS_PER_HOUR) {
      console.warn(`[Launch Guard] Production rate limit triggered for IP ${ip} (${history.count} req/hr)`);
      return res.status(429).json({
        error: "Rate Limit Exceeded: You have reached the hourly limit of 60 searches. Please try again later."
      });
    }
  }
  next();
}

// In server.ts, apply: app.post("/api/audit", productionRateLimiter, securityGuard, async (req, res) => { ...
EOF
echo "------------------------------------------------------------"

# 4. LAUNCH SANITY EXECUTION LIFECYCLE
echo -e "\n[STEP 4] Launching Build Sanity Check & Pre-Caching Lifecycle..."

# Run compilation checks
echo "  Running 'npm run build'..."
npm run build

# Run TypeScript Lint checks
echo "  Running 'npx tsc --noEmit' type checking..."
npx tsc --noEmit

# Spin up pre-cache worker script to warm up catalog
echo "  Triggering pre-cache warming worker..."
if [ -f "pre_cache_worker.ts" ]; then
    # Start server in background momentarily to run the worker
    echo "  Starting temporary server instance..."
    PORT=3010 PATH=./node_modules/.bin:$PATH npx tsx server.ts > server_temp.log 2>&1 &
    SERVER_PID=$!
    
    # Wait for server to boot
    echo "  Waiting for server boot (5s)..."
    sleep 5
    
    # Run pre-cache worker
    echo "  Executing pre_cache_worker.ts..."
    PATH=./node_modules/.bin:$PATH npx tsx pre_cache_worker.ts
    
    # Clean up server instance
    echo "  Shutting down temporary server (PID $SERVER_PID)..."
    kill $SERVER_PID || true
else
    echo "  ⚠️  Warning: pre_cache_worker.ts not found. Skipping cache warming."
fi

echo -e "\n============================================================"
echo "✅ DEPLOYMENT SANITY VERIFICATION COMPLETE: Ready for Release!"
echo "============================================================"
