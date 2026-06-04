import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import {
  Zap,
  ShieldAlert,
  Target,
  AlertTriangle,
  Cpu,
  Search,
  ChevronRight,
  ArrowRight,
  Share2,
  ExternalLink,
  ThumbsUp,
  ThumbsDown,
  HelpCircle,
  X,
  Camera,
  Image as ImageIcon,
  Trash2,
  Car,
  ShoppingBag,
  ShieldCheck,
  Smartphone,
  Tag,
  TrendingUp,
  CreditCard,
  LogIn,
  LogOut,
  Warehouse,
  History,
  CheckCircle2,
  Lock,
  Key,
  ArrowUpRight,
  Globe,
  Activity,
  MapPin,
  Monitor,
  Rss,
  MessageSquare,
  Bell,
  BellOff,
  RefreshCw,
  Network,
  EyeOff,
  ZapOff,
  Trophy,
  Skull,
  Phone,
  Radio,
  Settings,
  Fingerprint,
  Layers,
  Loader2,
  Rocket,
  Youtube,
  Twitter,
  Linkedin,
  CircuitBoard,
  Timer,
  RotateCcw,
  CircleDashed,
  Plus,
  Download,
  User as UserIcon,
} from "lucide-react";
import { cn } from "./lib/utils";
import { getRecommendation, type Recommendation } from "./lib/gemini";
import {
  auth,
  db,
  googleProvider,
  type User as FirebaseUser,
} from "./lib/firebase";
import { trackVisit } from "./lib/analytics";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import {
  collection,
  query as firestoreQuery,
  where,
  onSnapshot,
  addDoc,
  deleteDoc,
  updateDoc,
  setDoc,
  getDoc,
  doc,
  orderBy,
  limit,
  serverTimestamp,
  getCountFromServer,
  increment,
} from "firebase/firestore";
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAnalytics, logEvent } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyAl_4rsy3DgxFgpFN6O4CZLuZFSjQrRaeY",
  authDomain: "gen-lang-client-0464302464.firebaseapp.com",
  projectId: "gen-lang-client-0464302464",
  storageBucket: "gen-lang-client-0464302464.firebasestorage.app",
  messagingSenderId: "29440464004",
  appId: "1:29440464004:web:731a62032d986d5d7eded1",
  measurementId: "G-XL2WCXDQ6L"
};

// Initialize Firebase Core & Analytics safely
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const analytics = typeof window !== 'undefined' ? getAnalytics(app) : null;

enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
) {
  const errMsg = error instanceof Error ? error.message : String(error);
  const isPermissionError =
    errMsg.toLowerCase().includes("permission") ||
    errMsg.toLowerCase().includes("unauthorized");

  const errInfo: FirestoreErrorInfo = {
    error: errMsg,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };

  if (isPermissionError) {
    console.error("Firestore Permission Error: ", JSON.stringify(errInfo));
    throw new Error(JSON.stringify(errInfo));
  } else {
    console.warn(
      "Firestore Transient/Network Status: ",
      errMsg,
      `(Operation: ${operationType}, Path: ${path})`,
    );
  }
}

const copyToClipboard = async (text: string) => {
  try {
    window.focus(); // Ensure document gets focus context

    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    } else {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      textArea.style.top = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand("copy");
      document.body.removeChild(textArea);
      return successful;
    }
  } catch (err) {
    console.error("Copy failed:", err);
    return false;
  }
};

const getNumericPrice = (res: any) => {
  if (!res) return 0;
  const bestDeal = res.priceIntegrity?.procurementLinks?.find(
    (l: any) => l.isBestDeal,
  );
  const priceStr = String(
    bestDeal?.price ||
    res.priceIntegrity?.procurementLinks?.[0]?.price ||
    res.vettoContrast?.fairPriceTarget || ""
  );
  if (/out of stock|unavailable|check live/i.test(priceStr)) {
    return 0; // Signifies OOS or Check Live
  }
  if (priceStr) {
    const num = parseInt(priceStr.split('.')[0].replace(/[^\d]/g, ""));
    if (!isNaN(num) && num > 0) return num;
  }
  return 0;
};

const simplifyProductNameForSearch = (name: string): string => {
  if (!name) return "";
  let clean = name.trim();

  // Extract variant options or specifications we definitely want to PRESERVE:
  // e.g. "128GB", "256 GB", "512GB", "1TB", "16GB RAM", "12GB RAM", "8GB RAM", "M1", "M2", "M3", "M4"
  const specsToKeep: string[] = [];

  // Match common storage and RAM specs
  const specRegex =
    /\b(128\s*GB|256\s*GB|512\s*GB|1\s*TB|2\s*TB|64\s*GB|32\s*GB|4\s*GB|8\s*GB|12\s*GB|16\s*GB|24\s*GB|32\s*GB|64\s*GB|128|256|512)\b\s*(RAM|Storage|ROM)?/gi;
  let match;
  const tempName = clean.toLowerCase();
  while ((match = specRegex.exec(tempName)) !== null) {
    specsToKeep.push(match[0]);
  }

  // Extract silicon series for laptops
  const mSeriesRegex = /\b(m1|m2|m3|m4|ryzen\s*\d|core\s*i\d|i5|i7|i9)\b/gi;
  while ((match = mSeriesRegex.exec(tempName)) !== null) {
    specsToKeep.push(match[0]);
  }

  // Strip typical long promotional jargon
  const phrasesToRemove = [
    /with\s+facetime/gi,
    /international\s+version/gi,
    /unlocked/gi,
    /refurbished/gi,
    /renewed/gi,
    /with\s+free\s+[^&]+/gi,
    /active\s+noise\s+cancelling/gi,
    /wireless\s+charging/gi,
    /super\s+retina\s+xdr/gi,
    /display/gi,
    /5G/g,
    /4G/g,
    /LTE/gi,
  ];

  phrasesToRemove.forEach((p) => {
    clean = clean.replace(p, "");
  });

  // Split by typical delimiters but don't just throw away everything after if there is an important spec option there!
  const splitters = [" - ", " | ", " ; ", " / "];
  for (const s of splitters) {
    if (clean.includes(s)) {
      const parts = clean.split(s);
      let base = parts[0];
      // Scan remaining parts for storage/RAM specs that the user specifically passed
      const remainingText = parts.slice(1).join(" ");
      const extraSpecs: string[] = [];
      const specRegexLocal =
        /\b(128\s*GB|256\s*GB|512\s*GB|1\s*TB|2\s*TB|8\s*GB|12\s*GB|16\s*GB|24\s*GB|32\s*GB)\b/gi;
      let m;
      while ((m = specRegexLocal.exec(remainingText)) !== null) {
        extraSpecs.push(m[0]);
      }

      clean = base;
      if (extraSpecs.length > 0) {
        clean += " " + extraSpecs.join(" ");
      }
    }
  }

  if (clean.includes("—")) {
    clean = clean.split("—")[0];
  }

  // Clean up bracket/parenthesis content BUT keep storage specs if inside
  clean = clean.replace(/\([^)]*\)/g, (m) => {
    const hasSpec =
      /\b(128|256|512|1\s*TB|2\s*TB|8\s*GB|12\s*GB|16\s*GB|24\s*GB|32\s*GB)\b/gi.test(
        m,
      );
    return hasSpec ? m.replace(/[()]/g, "") : "";
  });

  clean = clean.replace(/\[[^\]]*\]/g, (m) => {
    const hasSpec =
      /\b(128|256|512|1\s*TB|2\s*TB|8\s*GB|12\s*GB|16\s*GB|24\s*GB|32\s*GB)\b/gi.test(
        m,
      );
    return hasSpec ? m.replace(/[\[\]]/g, "") : "";
  });

  // Format perfectly
  let result = clean
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim();

  // Deduplicate spec keywords to prevent "iPhone 15 128GB 128GB"
  const words = result.split(" ");
  const uniqueWords: string[] = [];
  const wordSet = new Set<string>();
  words.forEach((w) => {
    const wl = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (wl) {
      if (!wordSet.has(wl) || /^(pro|max|plus|air|ultra|i\d)$/.test(wl)) {
        uniqueWords.push(w);
        wordSet.add(wl);
      }
    } else {
      uniqueWords.push(w);
    }
  });

  return uniqueWords.join(" ").trim();
};

function deepMerge(target: any, source: any): any {
  if (!source) return target;
  if (!target) return source;
  const output = { ...target };
  if (typeof target === 'object' && typeof source === 'object') {
    Object.keys(source).forEach(key => {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [garageAssets, setGarageAssets] = useState<any[]>([]);
  const [globalFeed, setGlobalFeed] = useState<any[]>([]);
  const [marketTrends, setMarketTrends] = useState<any[]>([]);
  const [globalStats, setGlobalStats] = useState({
    totalCapitalAudit: 4280145,
    activeUsers: 0,
    savingsSecured: 890450,
  });
  const [showGarage, setShowGarage] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState("");
  const [useCase, setUseCase] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [images, setImages] = useState<
    { url: string; file: File; base64: string }[]
  >([]);
  const [result, setResult] = useState<Recommendation | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error" | "info";
  } | null>(null);
  const showToast = (
    message: string,
    type: "success" | "error" | "info" = "success",
  ) => {
    setToast({ message, type });
  };
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistRank, setWaitlistRank] = useState<number | null>(() => {
    const saved = localStorage.getItem("vetto_rank");
    return saved ? parseInt(saved) : null;
  });
  const [isJoiningWaitlist, setIsJoiningWaitlist] = useState(false);
  const [onWaitlist, setOnWaitlist] = useState(
    () => localStorage.getItem("on_waitlist") === "true",
  );
  const [savedEmail, setSavedEmail] = useState(
    () => localStorage.getItem("vetto_email") || "",
  );
  const [referralNode, setReferralNode] = useState<string | null>(null);

  useEffect(() => {
    // Handle referral node from URL
    const params = new URLSearchParams(window.location.search);
    const node = params.get("node");
    if (node) {
      setReferralNode(node);
      // Clean up URL without reload
      const newUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, "", newUrl);
    }

    // Sync waitlist rank if missing
    if (onWaitlist && !waitlistRank && savedEmail) {
      const sanitizedEmail = savedEmail.toLowerCase().trim();
      const entryId = btoa(sanitizedEmail).replace(/[/+=]/g, "_");
      getDoc(doc(db, "waitlist", entryId))
        .then((snap) => {
          if (snap.exists()) {
            const rank = snap.data().rank;
            setWaitlistRank(rank);
            localStorage.setItem("vetto_rank", rank.toString());
          }
        })
        .catch((err) => {
          if (
            err instanceof Error &&
            err.message.toLowerCase().includes("offline")
          ) {
            console.warn(
              "Rank sync offline fallback: using local cached status.",
            );
          } else {
            console.error("Rank sync failed:", err);
          }
        });
    }
  }, [onWaitlist, waitlistRank, savedEmail]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdminDashboard, setShowAdminDashboard] = useState(false);
  const [adminHotline, setAdminHotline] = useState<any[]>([]);
  const [adminFeedback, setAdminFeedback] = useState<any[]>([]);
  const [adminAnalytics, setAdminAnalytics] = useState<any[]>([]);
  const [adminTab, setAdminTab] = useState<
    "hotline" | "feedback" | "analytics"
  >("hotline");
  const [isFounder, setIsFounder] = useState(true); // Now live for everyone
  const [founderKey, setFounderKey] = useState("");
  const [showFounderAuth, setShowFounderAuth] = useState(false);
  const [lastAuditTime, setLastAuditTime] = useState<number>(0);
  const AUDIT_COOLDOWN = 10000; // 10 seconds between audits
  const [hotlineMessage, setHotlineMessage] = useState("");
  const [isHotlineSubmitting, setIsHotlineSubmitting] = useState(false);
  const [showHotline, setShowHotline] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [auditComment, setAuditComment] = useState("");
  const [selectedScore, setSelectedScore] = useState<number | null>(null);
  const [tickerMessage, setTickerMessage] = useState("Vetto status: Live");
  const [broadcastInput, setBroadcastInput] = useState("");

  const [ownershipYears, setOwnershipYears] = useState(3);
  const [usagePattern, setUsagePattern] = useState<
    "daily" | "weekly" | "occasional"
  >("daily");
  const [maintenanceCost, setMaintenanceCost] = useState(0);
  const [slainBuzzwords, setSlainBuzzwords] = useState<number[]>([]);

  useEffect(() => {
    if (result) {
      const matches = result.specLongevity?.match(/\d+/);
      const years = matches ? parseInt(matches[0]) : 3;
      setOwnershipYears(years > 0 ? years : 3);
      setUsagePattern("daily");
      setMaintenanceCost((result.statusTax ?? 0) > 10000 ? 5000 : 1500);
      setSlainBuzzwords([]);
    }
  }, [result]);

  const triggerAuditForAlternative = async (altName: string) => {
    if (!altName) return;
    setQuery(altName);
    setResult(null);
    setLoading(true);
    setError(null);
    setBillingError(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      const recommendation = await getRecommendation(
        altName,
        budget,
        useCase,
        history,
        [],
        (partial) => {
          setLoading(false);
          setResult(prev => {
            const merged = deepMerge(prev || {}, partial) as any;
            merged.pros = merged.pros || [];
            merged.cons = merged.cons || [];
            merged.features = merged.features || [];
            if (!merged.priceIntegrity) merged.priceIntegrity = {};
            if (!merged.priceIntegrity.procurementLinks) merged.priceIntegrity.procurementLinks = [];
            if (!merged.priceIntegrity.priceHistory) merged.priceIntegrity.priceHistory = [];
            if (!merged.socialAudit) merged.socialAudit = { integrityAudit: {} };
            if (!merged.socialAudit.integrityAudit) merged.socialAudit.integrityAudit = {};
            if (!merged.platformWarShield) merged.platformWarShield = {};
            if (!merged.vettoContrast) merged.vettoContrast = {};
            if (!merged.strategicRoadmap) merged.strategicRoadmap = {};
            if (!merged.communityPulse) merged.communityPulse = {};
            if (!merged.lifecyclePhase) merged.lifecyclePhase = {};
            return {
              ...merged,
              id: (prev as any)?.id || 'temp',
              timestamp: (prev as any)?.timestamp || Date.now(),
            };
          });
        }
      );
      setLastAuditTime(Date.now());
      const recommendationWithMeta = {
        ...recommendation,
        id: crypto?.randomUUID ? crypto.randomUUID() : `rec-${Date.now()}`,
        timestamp: Date.now(),
      };
      setResult(recommendationWithMeta);
      const newHistory = [recommendationWithMeta, ...history].slice(0, 10);
      setHistory(newHistory);
      localStorage.setItem("decision_history", JSON.stringify(newHistory));
    } catch (err: any) {
      const errorMessage =
        typeof err === "string" ? err : err.message || "Unknown internal error";
      setError(errorMessage);
      if (
        err.errorType === "BILLING_DUNNING_DENY" ||
        errorMessage.includes("dunning") ||
        errorMessage.includes("Billing Verification") ||
        errorMessage.includes("denied access") ||
        errorMessage.includes("denied_access") ||
        errorMessage.includes("denied") ||
        errorMessage.includes("403") ||
        errorMessage.includes("forbidden") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("all models failed") ||
        errorMessage.includes("All models failed")
      ) {
        setBillingError(true);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsubscribeStatus = onSnapshot(
      doc(db, "status", "global"),
      (snapshot) => {
        if (snapshot.exists()) {
          setTickerMessage(snapshot.data().message || "Vetto status: Live");
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, "status/global");
      },
    );
    return () => unsubscribeStatus();
  }, []);

  const updateBroadcast = async () => {
    if (!broadcastInput.trim()) return;
    try {
      await setDoc(doc(db, "status", "global"), {
        message: broadcastInput.toUpperCase(),
        updatedAt: serverTimestamp(),
        author: user?.email,
      });
      setBroadcastInput("");
    } catch (err) {
      console.error("Failed to update broadcast:", err);
    }
  };

  const [history, setHistory] = useState<Recommendation[]>(() => {
    const saved = localStorage.getItem("decision_history");
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved) as Recommendation[];
      // Filter out invalid items and ensure unique IDs with fallback to index
      const validItems = parsed.filter(
        (item) => item && (item.finalDecision || item.aamAadmiSummary),
      );

      // Ensure absolute uniqueness across the list
      const seenIds = new Set<string>();
      return validItems.map((item, idx) => {
        let uniqueId = item.id || `rec-${Date.now()}-${idx}`;
        while (seenIds.has(uniqueId)) {
          uniqueId = `rec-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 7)}`;
        }
        seenIds.add(uniqueId);
        return {
          ...item,
          id: uniqueId,
          timestamp: item.timestamp || Date.now() - idx * 1000,
        };
      });
    } catch (e) {
      console.error("Failed to parse history:", e);
      return [];
    }
  });

  const clearHistory = () => {
    localStorage.removeItem("decision_history");
    setHistory([]);
    setResult(null);
  };
  const [error, setError] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<boolean>(false);
  const [time, setTime] = useState(
    new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    }, 1000);

    const unsubscribeAuth = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAdmin(u?.email === "krishindolia2@gmail.com");
    });

    // Track visit on mount
    trackVisit();

    return () => {
      clearInterval(timer);
      unsubscribeAuth();
    };
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setAdminHotline([]);
      return;
    }

    const hQuery = firestoreQuery(
      collection(db, "hotline"),
      orderBy("timestamp", "desc"),
    );
    const unsubscribeH = onSnapshot(
      hQuery,
      (snapshot) => {
        setAdminHotline(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, "hotline");
      },
    );

    const fQuery = firestoreQuery(
      collection(db, "audit_feedback"),
      orderBy("timestamp", "desc"),
    );
    const unsubscribeF = onSnapshot(
      fQuery,
      (snapshot) => {
        setAdminFeedback(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, "audit_feedback");
      },
    );

    const aQuery = firestoreQuery(
      collection(db, "analytics_v1"),
      orderBy("timestamp", "desc"),
      limit(100),
    );
    const unsubscribeA = onSnapshot(
      aQuery,
      (snapshot) => {
        setAdminAnalytics(
          snapshot.docs.map((d) => ({ id: d.id, ...d.data() })),
        );
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, "analytics_v1");
      },
    );

    return () => {
      unsubscribeH();
      unsubscribeF();
      unsubscribeA();
    };
  }, [isAdmin]);

  useEffect(() => {
    if (!user) {
      setGarageAssets([]);
      return;
    }

    const q = firestoreQuery(
      collection(db, "assets"),
      where("userId", "==", user.uid),
      orderBy("vettedAt", "desc"),
    );

    const unsubscribeGarage = onSnapshot(
      q,
      (snapshot) => {
        const assets = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        setGarageAssets(assets);
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, "assets");
      },
    );

    return () => unsubscribeGarage();
  }, [user]);

  useEffect(() => {
    if (!user) return; // Only show feed to logged in users as per rules update

    const q = firestoreQuery(
      collection(db, "feed"),
      orderBy("timestamp", "desc"),
      limit(20),
    );

    const unsubscribeFeed = onSnapshot(
      q,
      (snapshot) => {
        const items = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        setGlobalFeed(items);
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, "feed");
      },
    );

    const unsubscribeTrends = onSnapshot(
      collection(db, "trends"),
      (snapshot) => {
        if (snapshot.empty) {
          setMarketTrends([
            {
              id: "t1",
              title: "iPhone 16 Feature Leak",
              impact: "WAIT",
              desc: "Starting storage likely stays at 128GB. Don't buy iPhone 15 right now.",
            },
            {
              id: "t2",
              title: "Summer Sale Warning",
              impact: "RUN",
              desc: "90% of clothing deals are just old stock being cleared out.",
            },
            {
              id: "t3",
              title: "EV Subsidy Alert",
              impact: "BUY",
              desc: "Government discounts are ending this month. Buy your electric vehicle now.",
            },
          ]);
        } else {
          setMarketTrends(
            snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
          );
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, "trends");
      },
    );

    const unsubscribeStats = onSnapshot(
      doc(db, "stats", "global"),
      (snapshot) => {
        if (snapshot.exists()) {
          setGlobalStats(snapshot.data() as any);
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, "stats/global");
      },
    );

    return () => {
      unsubscribeFeed();
      unsubscribeTrends();
      unsubscribeStats();
    };
  }, []); // Remove user dependency to show feed to all guests

  const verifyAudit = async (feedId: string, currentLikes: number = 0) => {
    try {
      await updateDoc(doc(db, "feed", feedId), {
        likes: (currentLikes || 0) + 1,
      });
    } catch (err) {
      console.error("Verification failed:", err);
    }
  };

  const handleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      if (analytics) {
        logEvent(analytics, 'login', { method: 'Google' });
      }
      showToast("Successfully signed in!", "success");
    } catch (err: any) {
      console.error("Auth failed:", err);
      const errMsg = err?.message || String(err);
      const errCode = err?.code || "";

      if (
        errCode === "auth/unauthorized-domain" ||
        errMsg.includes("unauthorized-domain") ||
        errMsg.includes("authorized domain")
      ) {
        showToast(
          "Authorized Domain mismatch! Let's add vetto.in to Authorized Domains in the Firebase Console.",
          "error",
        );
      } else if (errCode === "auth/popup-blocked") {
        showToast(
          "Sign-in popup blocked by browser. Please allow popups for this site.",
          "error",
        );
      } else if (errCode === "auth/cancelled-popup-request") {
        // Safe to ignore or show subtle info
        showToast("Sign-in flow cancelled.", "info");
      } else {
        showToast(
          errCode ? `Sign-in error: ${errCode}` : `Authentication failed.`,
          "error",
        );
      }
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setResult(null);
  };

  const addToGarage = async () => {
    if (!user || !result) return;
    setIsSaving(true);
    try {
      await addDoc(collection(db, "assets"), {
        userId: user.uid,
        name: result.productName,
        paisaVasoolIndex: result.paisaVasoolIndex,
        finalDecision: result.finalDecision,
        exitStrategy: result.strategicRoadmap?.exitStrategy || "N/A",
        vettedAt: serverTimestamp(),
        originalRecId: result.id,
        marketTiming: result.marketTiming,
        lifecycleStatus: result.lifecyclePhase?.status || "N/A",
        currentPrice:
          result.priceIntegrity?.currentPriceAudit?.split("•")[0].trim() ||
          "N/A",
        targetPrice: result.vettoContrast?.fairPriceTarget || "N/A",
        priceAlertActive: true,
        lastPriceCheck: serverTimestamp(),
      });
      setShowGarage(true);
    } catch (err) {
      console.error("Failed to save to garage:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const removeFromGarage = async (assetId: string) => {
    try {
      await deleteDoc(doc(db, "assets", assetId));
    } catch (err) {
      console.error("Failed to remove from garage:", err);
    }
  };

  const togglePriceAlert = async (assetId: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, "assets", assetId), {
        priceAlertActive: !currentStatus,
      });
    } catch (err) {
      console.error("Failed to toggle alert:", err);
    }
  };

  const [isSyncing, setIsSyncing] = useState<string | null>(null);

  const deleteDocument = async (collectionName: string, docId: string) => {
    if (!isAdmin) return;
    if (
      !confirm(
        `Are you sure you want to burn node ${docId}? This action is irreversible.`,
      )
    )
      return;
    try {
      await deleteDoc(doc(db, collectionName, docId));
    } catch (err) {
      console.error("Burn failed:", err);
    }
  };

  const syncPrice = async (assetId: string) => {
    setIsSyncing(assetId);
    try {
      // In a real app, this would trigger a cloud function or backend scrape
      // Here we simulate a marketplace re-verification
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await updateDoc(doc(db, "assets", assetId), {
        lastPriceCheck: serverTimestamp(),
      });
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setIsSyncing(null);
    }
  };

  const isUrl = (text: string) => {
    try {
      const trimmed = text.trim();
      if (!trimmed.includes(".") || trimmed.includes(" ")) return false;
      const url = new URL(
        trimmed.includes("://") ? trimmed : `https://${trimmed}`,
      );
      return url.hostname.includes(".");
    } catch {
      return false;
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        setImages((prev) => [
          ...prev,
          { url: URL.createObjectURL(file), file, base64 },
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (index: number) => {
    setImages((prev) => {
      const newImages = [...prev];
      URL.revokeObjectURL(newImages[index].url);
      newImages.splice(index, 1);
      return newImages;
    });
  };

  const [auditStep, setAuditStep] = useState(0);
  const auditSteps = [
    "Searching for the latest prices (Amazon, Flipkart, etc.)...",
    "Checking for fake discounts and price tricks...",
    "Reading what real owners say on Reddit and X...",
    "Filtering out paid reviews and ad noise...",
    "Calculating how much value it really gives you...",
    "Finalizing the best choice for you...",
  ];

  useEffect(() => {
    let interval: any;
    if (loading) {
      setAuditStep(0);
      interval = setInterval(() => {
        setAuditStep((s) => (s + 1) % auditSteps.length);
      }, 800);
    }
    return () => clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    const messages = [
      "Vetto status: Live and Analyzing",
      "Alert: Price spikes detected in Electronics",
      "Expert Member saved ₹1,200 on latest deal",
      "Analyzing: iPhone 15 prices across stores",
      "System Accuracy: 99.9% Verified",
      "Market Update: Real-time price tracking active",
    ];
    let i = 0;
    const interval = setInterval(() => {
      setTickerMessage(messages[i % messages.length]);
      i++;
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleFounderAuth = (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedKey = founderKey.toUpperCase().trim();
    const VALID_KEYS = [
      "VETTO_FDR_2026",
      "FDR_FOUNDER",
      "ALPHA_100",
      "VETTO_LAUNCH",
      "GEMINI_ADMIN",
    ];

    if (VALID_KEYS.includes(normalizedKey)) {
      setIsFounder(true);
      localStorage.setItem("vetto_founder", "true");
      setShowFounderAuth(false);
      setFounderKey("");
      // Trigger kernel boot sound or haptic simulation
      if (window.navigator.vibrate) window.navigator.vibrate([100, 50, 100]);
    } else {
      showToast(
        "Incorrect access key. Please verify the code and try again.",
        "error",
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    if (analytics) {
      logEvent(analytics, 'search_query', {
        query_text: query,
        budget: budget || 'none',
        useCase: useCase || 'none'
      });
    }

    setResult(null);
    setLoading(true);
    setError(null);
    setBillingError(false);

    // Client-side rate limiting to protect the engine
    const now = Date.now();
    if (now - lastAuditTime < AUDIT_COOLDOWN) {
      const wait = Math.ceil((AUDIT_COOLDOWN - (now - lastAuditTime)) / 1000);
      setError(
        `System Busy: Analyzing market data. Retry in ${wait}s to prevent overflow.`,
      );
      setLoading(false);
      return;
    }

    try {
      // Extract just the base64 part (remove data:image/...;base64,)
      const base64Images = images.map((img) => img.base64.split(",")[1]);
      const recommendation = await getRecommendation(
        query,
        budget,
        useCase,
        history,
        base64Images,
        (partial) => {
          setLoading(false);
          setResult(prev => {
            const merged = deepMerge(prev || {}, partial) as any;
            merged.pros = merged.pros || [];
            merged.cons = merged.cons || [];
            merged.features = merged.features || [];
            if (!merged.priceIntegrity) merged.priceIntegrity = {};
            if (!merged.priceIntegrity.procurementLinks) merged.priceIntegrity.procurementLinks = [];
            if (!merged.priceIntegrity.priceHistory) merged.priceIntegrity.priceHistory = [];
            if (!merged.socialAudit) merged.socialAudit = { integrityAudit: {} };
            if (!merged.socialAudit.integrityAudit) merged.socialAudit.integrityAudit = {};
            if (!merged.platformWarShield) merged.platformWarShield = {};
            if (!merged.vettoContrast) merged.vettoContrast = {};
            if (!merged.strategicRoadmap) merged.strategicRoadmap = {};
            if (!merged.communityPulse) merged.communityPulse = {};
            if (!merged.lifecyclePhase) merged.lifecyclePhase = {};
            return {
              ...merged,
              id: (prev as any)?.id || 'temp',
              timestamp: (prev as any)?.timestamp || Date.now(),
            };
          });
        }
      );
      setLastAuditTime(Date.now());
      const recommendationWithMeta = {
        ...recommendation,
        id: crypto?.randomUUID ? crypto.randomUUID() : `rec-${Date.now()}`,
        timestamp: Date.now(),
      };
      setResult(recommendationWithMeta);

      if (analytics) {
        logEvent(analytics, 'audit_generated', {
          product_name: recommendationWithMeta.productName || 'unknown',
          value_index: recommendationWithMeta.paisaVasoolIndex || 0,
          category: recommendationWithMeta.category || 'unknown'
        });
      }

      // Automatic Social Feed Push if logically sound
      if (user && recommendationWithMeta.paisaVasoolIndex > 0) {
        try {
          await addDoc(collection(db, "feed"), {
            userId: user.uid,
            userDisplayName: user.displayName || "Vetto Strategist",
            userPhoto: user.photoURL || "",
            productName: recommendationWithMeta.productName,
            paisaVasoolIndex: recommendationWithMeta.paisaVasoolIndex,
            verdict:
              recommendationWithMeta.finalDecision.split(":")[0].trim() ||
              recommendationWithMeta.marketTiming,
            socialHook: recommendationWithMeta.socialHook,
            likes: 0,
            timestamp: serverTimestamp(),
          });
        } catch (feedErr) {
          console.error("Feed push failed:", feedErr);
        }
      }

      const newHistory = [recommendationWithMeta, ...history].slice(0, 10);
      setHistory(newHistory);
      localStorage.setItem("decision_history", JSON.stringify(newHistory));
    } catch (err: any) {
      const errorMessage =
        typeof err === "string" ? err : err.message || "Unknown internal error";
      setError(errorMessage);
      if (
        err.errorType === "BILLING_DUNNING_DENY" ||
        errorMessage.includes("dunning") ||
        errorMessage.includes("Billing Verification") ||
        errorMessage.includes("denied access") ||
        errorMessage.includes("denied_access") ||
        errorMessage.includes("denied") ||
        errorMessage.includes("403") ||
        errorMessage.includes("forbidden") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("all models failed") ||
        errorMessage.includes("All models failed")
      ) {
        setBillingError(true);
      }
      console.error("Audit deployment failed:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = () => {
    setError(null);
    setBillingError(false);
    handleSubmit({ preventDefault: () => {} } as React.FormEvent);
  };

  const joinWaitlist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!waitlistEmail || !/^\S+@\S+\.\S+$/.test(waitlistEmail)) {
      setError("Please provide a valid strategic email address.");
      return;
    }

    setIsJoiningWaitlist(true);
    setError(null);

    const sanitizedEmail = waitlistEmail.toLowerCase().trim();

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: sanitizedEmail,
          referralSource: referralNode || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 409 || data.error?.includes("registered")) {
          throw new Error("ALREADY_EXISTS");
        }
        throw new Error(data.error || "Failed to join waitlist.");
      }

      setWaitlistRank(data.rank);
      setOnWaitlist(true);
      setSavedEmail(sanitizedEmail);
      localStorage.setItem("on_waitlist", "true");
      localStorage.setItem("vetto_email", sanitizedEmail);
      localStorage.setItem("vetto_rank", data.rank.toString());
    } catch (err: any) {
      if (err.message === "ALREADY_EXISTS") {
        setError(
          "This email node is already secured in the waitlist registry.",
        );
        // Try to recover rank if possible
        try {
          const entryId = btoa(sanitizedEmail).replace(/[/+=]/g, "_");
          const { getDoc } = await import("firebase/firestore");
          const existing = await getDoc(doc(db, "waitlist", entryId));
          if (existing.exists()) {
            setWaitlistRank(existing.data().rank);
            setOnWaitlist(true);
            setSavedEmail(sanitizedEmail);
            localStorage.setItem("on_waitlist", "true");
            localStorage.setItem("vetto_email", sanitizedEmail);
            localStorage.setItem("vetto_rank", existing.data().rank.toString());
          }
        } catch (e) {
          console.error("Recovery failed:", e);
        }
      } else {
        console.error("Waitlist join failed:", err);
        setError(err.message || "Waitlist Error: Connection timed out. Please retry.");
      }
    } finally {
      setIsJoiningWaitlist(false);
    }
  };

  const formatTime = (ts: any) => {
    if (!ts) return "--:--";
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const formatDate = (ts: any) => {
    if (!ts) return "--/--/--";
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleDateString();
  };

  const handleAuditFeedback = async (score: number, comment?: string) => {
    if (!result) return;
    try {
      await addDoc(collection(db, "audit_feedback"), {
        recId: result.productName + "_" + Date.now(),
        accuracyScore: score,
        comment: comment || "",
        timestamp: serverTimestamp(),
      });
      setFeedbackSent(true);
      setAuditComment("");
      setSelectedScore(null);
      setTimeout(() => setFeedbackSent(false), 3000);
    } catch (err) {
      console.error("Feedback failed:", err);
    }
  };

  const submitHotlineMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hotlineMessage || !savedEmail) return;
    setIsHotlineSubmitting(true);
    try {
      await addDoc(collection(db, "hotline"), {
        email: savedEmail,
        message: hotlineMessage,
        timestamp: serverTimestamp(),
      });
      setHotlineMessage("");
      setShowHotline(false);
      showToast(
        "Your feedback has been sent directly to our team. Thank you!",
        "success",
      );
    } catch (err) {
      console.error("Hotline fail:", err);
    } finally {
      setIsHotlineSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-bg selection:bg-accent selection:text-bg overflow-hidden">
      <div className="ambient-glow -top-40 -left-40" />
      <div className="ambient-glow top-[60%] -right-40" />
      {/* Shared Feedback */}
      <AnimatePresence>
        <div className="fixed bottom-12 right-12 z-[100] flex flex-col items-end gap-4">
          {showHotline && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="w-80 glass-panel p-6 bg-white border-slate-200 border border-slate-200 overflow-hidden relative shadow-2xl"
            >
              <div className="absolute top-0 left-0 w-full h-[1px] bg-accent/40" />
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-3 h-3 text-accent" />
                    <span className="text-[9px] font-mono text-accent uppercase tracking-widest font-black">
                      Vetto Feedback
                    </span>
                  </div>
                  <button
                    onClick={() => setShowHotline(false)}
                    className="text-slate-400 hover:text-slate-900"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <p className="text-[10px] font-medium text-slate-500 leading-relaxed italic">
                  Have suggestions or found a bug? Type your feedback below to
                  reach out directly.
                </p>
                <form onSubmit={submitHotlineMessage} className="space-y-4">
                  <textarea
                    value={hotlineMessage}
                    onChange={(e) => setHotlineMessage(e.target.value)}
                    placeholder="Describe your experience..."
                    className="w-full bg-slate-50 border border-slate-100 p-3 text-xs font-medium text-slate-600 placeholder:text-slate-300 focus:outline-none focus:border-accent/40 resize-none h-32 rounded-xl"
                    required
                  />
                  <button
                    type="submit"
                    disabled={isHotlineSubmitting}
                    className="w-full bg-slate-900 text-white py-3 text-[9px] font-black uppercase tracking-[0.3em] hover:bg-accent transition-all disabled:opacity-50 rounded-xl"
                  >
                    {isHotlineSubmitting ? "SENDING..." : "SEND FEEDBACK"}
                  </button>
                </form>
              </div>
            </motion.div>
          )}

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setShowHotline(!showHotline)}
            className="w-16 h-16 rounded-full bg-slate-900 flex items-center justify-center shadow-lg border border-slate-800 hover:bg-accent transition group"
          >
            <MessageSquare className="w-6 h-6 text-white group-hover:rotate-12 transition-transform" />
          </motion.button>
        </div>
      </AnimatePresence>

      <div className="relative z-10 p-4 sm:p-6 md:p-12 max-w-[1440px] xl:px-16 mx-auto min-h-screen flex flex-col w-full">
        {/* Header */}
        <header className="pb-6 mb-6 md:pb-10 md:mb-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6 md:gap-8 border-b border-white/10">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-black tracking-widest text-gradient flex items-center gap-2 font-display">
                VETTO
              </h1>
              <div className="mono-tag">
                <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                Live Analysis
              </div>
            </div>
            <p className="text-xs text-zinc-400 font-medium">
              Tired from scrolling? Do Vetto now.
            </p>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowGuide(true)}
              className="flex items-center gap-2 px-4 py-2 text-zinc-400 hover:text-accent transition-all duration-300 cursor-pointer"
            >
              <HelpCircle className="w-4 h-4" />
              <span className="font-bold text-[10px] uppercase tracking-widest hidden sm:inline">
                How it Works
              </span>
            </button>
            {user ? (
              <div className="flex items-center gap-4">
                {isAdmin && (
                  <button
                    onClick={() => setShowAdminDashboard(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 rounded-full hover:bg-white/10 text-accent transition-all duration-300 shadow-md animate-pulse cursor-pointer"
                    title="Founder Portal Access"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    <span className="font-bold text-[10px] uppercase tracking-widest hidden md:inline">
                      Founder Panel
                    </span>
                  </button>
                )}
                <button
                  onClick={() => setShowGarage(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 rounded-full hover:bg-white/10 hover:border-white/20 text-white transition-all duration-300 cursor-pointer"
                >
                  <ShoppingBag className="w-4 h-4 text-accent" />
                  <span className="font-bold text-[11px] uppercase">
                    My List ({garageAssets.length})
                  </span>
                </button>
                <div className="flex items-center gap-3 pl-4 border-l border-white/10">
                  <img
                    src={user.photoURL || ""}
                    className="w-8 h-8 rounded-full border border-white/10 shadow-sm"
                    alt="avatar"
                  />
                  <button
                    onClick={handleSignOut}
                    className="text-zinc-500 hover:text-white transition-colors cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={handleSignIn}
                className="flex items-center gap-2 px-5 py-2.5 bg-accent text-bg rounded-full hover:bg-white transition-all duration-300 shadow-lg cursor-pointer"
              >
                <LogIn className="w-4 h-4" />
                <span className="font-bold text-[11px] uppercase">Sign In</span>
              </button>
            )}
          </div>
        </header>

        {/* Core Search & Audit Centerpiece */}
        {!result && !loading && (
          <div className="max-w-4xl mx-auto w-full mb-16 space-y-12">
            <div className="glass-panel p-8 md:p-12 space-y-10 relative">
              <div className="absolute -top-12 -left-12 w-48 h-48 bg-accent/5 rounded-full blur-3xl pointer-events-none" />
              <form onSubmit={handleSubmit} className="space-y-8 relative z-10">
                <div className="space-y-3 text-center md:text-left mb-8">
                  <div className="flex items-center gap-2.5 justify-center md:justify-start">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                    <span className="font-mono text-[9px] uppercase tracking-[0.40em] text-accent font-black">
                      Smart Value Checker
                    </span>
                  </div>
                  <h1 className="text-4xl md:text-5xl font-display font-black text-white tracking-tight leading-none">
                    Is it actually{" "}
                    <span className="text-gradient">
                      worth buying?
                    </span>
                  </h1>
                  <p className="text-slate-600 font-medium max-w-xl text-sm leading-relaxed mx-auto md:mx-0">
                    Paste any product link to instantly uncover fake reviews,
                    hidden fees, and smarter alternatives.
                  </p>
                </div>

                {/* Main Product/Url Input box */}
                <div className="relative group/search max-w-4xl">
                  <div className="absolute inset-y-0 left-6 flex items-center pointer-events-none">
                    <Search className="w-6 h-6 text-zinc-500 group-focus-within/search:text-accent transition-colors duration-300" />
                  </div>
                  <input
                    id="product-query"
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="e.g. iPhone 15 vs 16, organic cotton shirts, or paste major retail links..."
                    className="w-full bg-slate-100 border border-slate-200 focus:border-accent focus:bg-white rounded-2xl py-7 pl-16 pr-6 text-lg font-medium text-slate-900 shadow-sm hover:border-slate-300 transition-all duration-300 outline-none placeholder:text-slate-400"
                    required
                  />
                </div>

                {/* Additional parameters split */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl">
                  <div className="space-y-2.5">
                    <label className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-widest block ml-1">
                      Max Budget (Optional)
                    </label>
                    <div className="relative group/budget">
                      <div className="absolute inset-y-0 left-5 flex items-center pointer-events-none">
                        <span className="text-zinc-500 font-mono text-sm">
                          ₹
                        </span>
                      </div>
                      <input
                        type="text"
                        value={budget}
                        onChange={(e) => setBudget(e.target.value)}
                        placeholder="e.g. 50,000"
                        className="w-full bg-slate-100 border border-slate-200 focus:border-accent/40 focus:bg-white rounded-xl py-5 pl-10 pr-6 text-sm font-medium text-slate-900 outline-none transition-all shadow-sm"
                      />
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <label className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-widest block ml-1">
                      Main Use Case (Optional)
                    </label>
                    <input
                      type="text"
                      value={useCase}
                      onChange={(e) => setUseCase(e.target.value)}
                      placeholder="e.g. Office work, Family commute, Workout"
                      className="w-full bg-slate-100 border border-slate-200 focus:border-accent/40 focus:bg-white rounded-xl py-5 px-6 text-sm font-medium text-slate-900 outline-none transition-all shadow-sm mb-3"
                    />

                    {/* Interactive pill recommendations */}
                    <div className="flex flex-wrap gap-2">
                      {[
                        {
                          id: "tech",
                          label: "Electronics",
                          icon: Cpu,
                          hint: "Check: Phone/Laptop/Gadget",
                        },
                        {
                          id: "fashion",
                          label: "Fashion",
                          icon: ShoppingBag,
                          hint: "Check: Apparel/Materials",
                        },
                        {
                          id: "auto",
                          label: "Auto",
                          icon: Car,
                          hint: "Check: Vehicle/Safety",
                        },
                      ].map((cat) => (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => setUseCase(cat.hint)}
                          className={cn(
                            "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border text-[9px] uppercase tracking-wider font-bold transition-all duration-300",
                            useCase === cat.hint
                              ? "bg-accent border-accent text-bg"
                              : "border-white/10 bg-white/5 text-zinc-400 hover:border-white/20 hover:text-white",
                          )}
                        >
                          <cat.icon className="w-2.5 h-2.5" />
                          {cat.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Multimodal visual specifications */}
                <div className="border-t border-white/10 pt-6 max-w-4xl space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-widest block mb-0.5">
                        Attach Product Image or Spec Sheet (Optional)
                      </span>
                      <span className="text-[9px] text-slate-400 font-medium font-serif italic">
                        Analyzed instantly via Gemini Multimodal Vision checks
                      </span>
                    </div>
                    <label className="cursor-pointer group flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full transition-all duration-300">
                      <Camera className="w-3.5 h-3.5 text-accent" />
                      <span className="font-mono text-[9px] uppercase tracking-widest text-zinc-400 font-bold group-hover:text-white">
                        Add Photo
                      </span>
                      <input
                        type="file"
                        multiple
                        accept="image/*"
                        className="hidden"
                        onChange={handleImageUpload}
                      />
                    </label>
                  </div>

                  {images.length > 0 && (
                    <div className="flex flex-wrap gap-3 p-3 bg-white/5 rounded-2xl border border-white/10">
                      {images.map((img, idx) => (
                        <div
                          key={idx}
                          className="relative group/img w-20 h-20 bg-slate-50 border border-black/5 rounded-xl overflow-hidden shadow-sm"
                        >
                          <img
                            src={img.url}
                            alt="vetted specs"
                            className="w-full h-full object-cover group-hover/img:scale-105 transition-transform duration-300"
                          />
                          <button
                            type="button"
                            onClick={() => removeImage(idx)}
                            className="absolute inset-0 bg-red-600/90 flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity duration-300"
                          >
                            <X className="w-5 h-5 text-white" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex justify-center md:justify-end pt-4 border-t border-white/10">
                  <button
                    type="submit"
                    disabled={loading}
                    className="bg-accent text-bg min-w-[200px] py-4 px-10 rounded-xl text-[10px] font-black uppercase tracking-[0.3em] hover:bg-white hover:-translate-y-0.5 hover:shadow-[0_10px_20px_rgba(229,193,88,0.2)] transition-all duration-300 disabled:opacity-50 relative overflow-hidden cursor-pointer"
                  >
                    <span className={cn(loading && "opacity-0")}>
                      {loading ? "Engaging Scan..." : "Verify with Vetto"}
                    </span>
                    {loading && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 animate-spin text-bg" />
                      </div>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Garage Overlay */}
        <AnimatePresence>
          {showGarage && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[110] bg-slate-900/40 backdrop-blur-md flex justify-end"
              onClick={() => setShowGarage(false)}
            >
              <motion.div
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 200 }}
                className="w-full max-w-xl bg-white p-8 md:p-12 h-full overflow-y-auto custom-scrollbar shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-12 flex justify-between items-center">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-accent">
                      <Warehouse className="w-4 h-4" />
                      <span className="font-mono text-[10px] uppercase tracking-[0.5em] font-black">
                        Savings Vault
                      </span>
                    </div>
                    <h2 className="text-4xl font-black text-slate-900 tracking-tight">
                      Your Saved Results
                    </h2>
                  </div>
                  <button
                    onClick={() => setShowGarage(false)}
                    className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-all"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Portfolio Analytics */}
                {garageAssets.length > 0 && (
                  <div className="grid grid-cols-2 gap-4 mb-12">
                    <div className="p-6 bg-accent border border-accent rounded-3xl">
                      <div className="flex items-center gap-2 mb-4">
                        <TrendingUp className="w-3 h-3 text-white" />
                        <span className="text-[8px] font-mono text-white/40 uppercase tracking-widest">
                          Avg. PVI
                        </span>
                      </div>
                      <div className="text-4xl font-black text-white">
                        {Math.round(
                          garageAssets.reduce(
                            (acc, curr) => acc + curr.paisaVasoolIndex,
                            0,
                          ) / garageAssets.length,
                        )}
                        %
                      </div>
                      <div className="text-[9px] font-medium text-white/60 mt-1">
                        Portfolio Efficiency
                      </div>
                    </div>
                    <div className="p-6 bg-slate-50 border border-slate-100 rounded-3xl">
                      <div className="flex items-center gap-2 mb-4">
                        <ShieldAlert className="w-3 h-3 text-red-500" />
                        <span className="text-[8px] font-mono text-slate-400 uppercase tracking-widest">
                          Risk Assets
                        </span>
                      </div>
                      <div className="text-4xl font-black text-slate-900">
                        {
                          garageAssets.filter(
                            (a) =>
                              a.marketTiming === "RUN" ||
                              a.lifecycleStatus?.includes("Obsolete"),
                          ).length
                        }
                      </div>
                      <div className="text-[9px] font-medium text-slate-400 mt-1">
                        Requiring Exit Strategy
                      </div>
                    </div>
                  </div>
                )}

                <div className="space-y-6">
                  {garageAssets.length > 0 ? (
                    garageAssets.map((asset) => (
                      <div
                        key={asset.id}
                        className="p-8 group/asset border border-slate-100 hover:border-accent/20 transition-all relative overflow-hidden bg-slate-50 rounded-[2.5rem]"
                      >
                        <div className="absolute top-0 right-0 p-4 opacity-0 group-hover/asset:opacity-100 transition-opacity">
                          <button
                            onClick={() => removeFromGarage(asset.id)}
                            className="text-slate-300 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="relative z-10 space-y-6">
                          <div className="flex justify-between items-start">
                            <div className="space-y-1">
                              <span
                                className={cn(
                                  "text-[8px] font-mono font-black uppercase px-2 py-0.5 rounded-full border",
                                  asset.marketTiming === "RUN"
                                    ? "border-red-500/20 text-red-500 bg-red-500/5"
                                    : asset.marketTiming === "WAIT"
                                      ? "border-amber/20 text-amber bg-amber/5"
                                      : "border-accent/20 text-accent bg-accent/5",
                                )}
                              >
                                {asset.marketTiming} Recommendation
                              </span>
                              <h3 className="text-xl font-bold text-slate-900 group-hover/asset:text-accent transition-colors">
                                {asset.name}
                              </h3>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() =>
                                  togglePriceAlert(
                                    asset.id,
                                    asset.priceAlertActive,
                                  )
                                }
                                className={cn(
                                  "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                                  asset.priceAlertActive
                                    ? "bg-accent/10 text-accent border border-accent/20"
                                    : "bg-slate-100 text-slate-300 border border-slate-200",
                                )}
                                title={
                                  asset.priceAlertActive
                                    ? "Disable Alerts"
                                    : "Enable Price Alerts"
                                }
                              >
                                {asset.priceAlertActive ? (
                                  <Bell className="w-3.5 h-3.5" />
                                ) : (
                                  <BellOff className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <button
                                onClick={() => syncPrice(asset.id)}
                                disabled={isSyncing === asset.id}
                                className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 hover:text-accent hover:border-accent/20 transition-all disabled:opacity-50"
                                title="Sync Marketplace Data"
                              >
                                <RefreshCw
                                  className={cn(
                                    "w-3.5 h-3.5",
                                    isSyncing === asset.id && "animate-spin",
                                  )}
                                />
                              </button>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4 p-4 bg-white border border-slate-100 rounded-2xl">
                            <div className="space-y-1">
                              <span className="text-[7px] font-mono text-slate-400 uppercase tracking-widest">
                                Observed Price
                              </span>
                              <div className="text-sm font-mono text-slate-900">
                                {asset.currentPrice || "₹---"}
                              </div>
                            </div>
                            <div className="space-y-1 text-right">
                              <span className="text-[7px] font-mono text-accent/40 uppercase tracking-widest">
                                Target Price
                              </span>
                              <div className="text-sm font-mono text-accent">
                                {asset.targetPrice || "₹---"}
                              </div>
                            </div>
                          </div>

                          <div className="pt-4 border-t border-slate-100 space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 text-[9px] font-mono text-slate-400 uppercase">
                                <History className="w-3 h-3" />
                                Exit Logic:{" "}
                                <span className="text-slate-600 font-bold">
                                  {asset.exitStrategy}
                                </span>
                              </div>
                              <div className="text-right">
                                <div className="text-xl font-black text-slate-900">
                                  {asset.paisaVasoolIndex}%
                                </div>
                                <div className="text-[8px] font-mono text-slate-400 uppercase tracking-widest">
                                  Efficiency
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-[9px] font-mono text-slate-400 uppercase">
                              <div className="flex items-center gap-2">
                                <CheckCircle2 className="w-3 h-3 text-accent" />
                                Vetted: {formatDate(asset.vettedAt)}
                              </div>
                              <div className="flex items-center gap-2 text-slate-300 italic">
                                Last Sync:{" "}
                                {formatTime(
                                  asset.lastPriceCheck || asset.vettedAt,
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="py-20 text-center space-y-6 opacity-20">
                      <div className="w-20 h-20 rounded-full border-2 border-dashed border-slate-900 mx-auto flex items-center justify-center">
                        <Lock className="w-8 h-8 text-slate-900" />
                      </div>
                      <p className="text-lg font-serif italic max-w-xs mx-auto text-slate-900">
                        Your audit list is currently empty. Analyze products to
                        save them in your vault.
                      </p>
                    </div>
                  )}
                </div>

                <div className="mt-12 pt-12 border-t border-slate-100">
                  <div className="bg-accent/5 p-6 rounded-3xl border border-accent/10 space-y-4">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="w-3.5 h-3.5 text-accent" />
                      <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-accent">
                        Expert Advantage
                      </span>
                    </div>
                    <p className="text-[11px] font-medium text-slate-500 leading-relaxed">
                      Assets stored here are subject to real-time market timing
                      updates. We will notify you when lifecycle nodes shift.
                    </p>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {showGuide && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] bg-slate-900/95 backdrop-blur-xl flex items-center justify-center p-6"
              onClick={() => setShowGuide(false)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="max-w-4xl w-full bg-slate-900 border border-white/10 p-8 md:p-14 relative overflow-hidden max-h-[90vh] overflow-y-auto custom-scrollbar"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="absolute top-0 right-0 p-8">
                  <button
                    onClick={() => setShowGuide(false)}
                    className="text-accent/20 hover:text-accent transition-colors"
                  >
                    <X className="w-8 h-8" />
                  </button>
                </div>

                <div className="space-y-12">
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <ShieldCheck className="w-5 h-5 text-accent" />
                      <span className="text-[10px] uppercase tracking-[0.6em] text-accent font-black block">
                        Easy Guide
                      </span>
                    </div>
                    <h2 className="text-3xl sm:text-6xl font-serif italic text-white tracking-tight leading-none">
                      How Vetto Works
                    </h2>
                    <p className="text-sm font-serif italic text-white/40 max-w-2xl">
                      Vetto helps you save your hard-earned money. We look past
                      the fancy advertisements to tell you if a product is
                      actually worth buying. Here is how you can use it:
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-14 gap-y-12">
                    <div className="space-y-4 group">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full border border-accent/20 flex items-center justify-center text-[12px] font-black text-accent font-mono group-hover:bg-accent group-hover:text-bg transition-all">
                          01
                        </div>
                        <div className="space-y-1">
                          <span className="text-[11px] uppercase tracking-[0.3em] text-accent font-black block">
                            Share the Product
                          </span>
                          <span className="text-[9px] font-mono text-white/20 uppercase">
                            Action: Paste Link or Photo
                          </span>
                        </div>
                      </div>
                      <p className="text-xs font-serif italic text-white/50 leading-relaxed pl-14">
                        Just paste a link from Amazon or Flipkart, or upload a
                        photo of the product. We will start checking everything
                        for you immediately.
                      </p>
                    </div>

                    <div className="space-y-4 group">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full border border-accent/20 flex items-center justify-center text-[12px] font-black text-accent font-mono group-hover:bg-accent group-hover:text-bg transition-all">
                          02
                        </div>
                        <div className="space-y-1">
                          <span className="text-[11px] uppercase tracking-[0.3em] text-accent font-black block">
                            Checking the Truth
                          </span>
                          <span className="text-[9px] font-mono text-white/20 uppercase">
                            Analysis: Deep Scan
                          </span>
                        </div>
                      </div>
                      <p className="text-xs font-serif italic text-white/50 leading-relaxed pl-14">
                        We ignore the big claims made by brands. We check the
                        real quality—like phone speed, car safety, or material
                        strength. We tell you what you are actually getting.
                      </p>
                    </div>

                    <div className="space-y-4 group">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full border border-accent/20 flex items-center justify-center text-[12px] font-black text-accent font-mono group-hover:bg-accent group-hover:text-bg transition-all">
                          03
                        </div>
                        <div className="space-y-1">
                          <span className="text-[11px] uppercase tracking-[0.3em] text-accent font-black block">
                            Checking the Price
                          </span>
                          <span className="text-[9px] font-mono text-white/20 uppercase">
                            Version: Best Deals
                          </span>
                        </div>
                      </div>
                      <p className="text-xs font-serif italic text-white/50 leading-relaxed pl-14">
                        We find the best price and tell you if it's a real deal
                        or a fake sale. We also look for hidden credit card
                        discounts to save you more money.
                      </p>
                    </div>

                    <div className="space-y-4 group">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full border border-accent/20 flex items-center justify-center text-[12px] font-black text-accent font-mono group-hover:bg-accent group-hover:text-bg transition-all">
                          04
                        </div>
                        <div className="space-y-1">
                          <span className="text-[11px] uppercase tracking-[0.3em] text-accent font-black block">
                            The Final Result
                          </span>
                          <span className="text-[9px] font-mono text-white/20 uppercase">
                            Deployment: Final Recommendation
                          </span>
                        </div>
                      </div>
                      <p className="text-xs font-serif italic text-white/50 leading-relaxed pl-14">
                        Finally, we give you a clear choice:{" "}
                        <span className="text-white font-black underline">
                          BUY, WAIT, or RUN
                        </span>
                        . If it's a RUN, we will suggest a much better product
                        for your money.
                      </p>
                    </div>

                    <div className="group space-y-4">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full border border-accent/20 flex items-center justify-center text-[12px] font-black text-accent font-mono group-hover:bg-accent group-hover:text-bg transition-all">
                          05
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] uppercase tracking-[0.3em] text-accent font-black block">
                              Review Check
                            </span>
                            <span className="px-1.5 py-0.5 bg-accent text-bg text-[7px] font-black uppercase tracking-widest leading-none">
                              New
                            </span>
                          </div>
                          <span className="text-[9px] font-mono text-white/20 uppercase">
                            Public Opinion Scan
                          </span>
                        </div>
                      </div>
                      <p className="text-xs font-serif italic text-white/50 leading-relaxed pl-14">
                        We separate real customer reviews from fake ones. We
                        find the real truth—like common problems that brands and
                        influencers won't tell you about.
                      </p>
                    </div>
                  </div>

                  <div className="pt-10 border-t border-white/5 space-y-8">
                    <div className="bg-accent/5 border border-accent/10 p-8 rounded-sm">
                      <div className="flex items-center justify-between mb-6">
                        <span className="text-[10px] uppercase tracking-[0.4em] text-accent">
                          How Vetto Protects You
                        </span>
                        <div className="flex items-center gap-2">
                          <div className="w-1 h-1 bg-green-500 rounded-full" />
                          <span className="text-[8px] font-mono text-green-500/50 uppercase">
                            100% Honest
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
                        <div className="space-y-2">
                          <span className="text-[8px] font-mono text-white/30 uppercase block">
                            Other Apps
                          </span>
                          <p className="text-xs font-serif italic text-white/40">
                            Often show you ads or paid reviews that might not be
                            true.
                          </p>
                        </div>
                        <div className="h-[1px] sm:h-auto sm:w-[1px] bg-white/5 hidden sm:block" />
                        <div className="space-y-2 col-span-1 sm:col-span-2">
                          <span className="text-[8px] font-mono text-accent uppercase block">
                            Vetto System
                          </span>
                          <p className="text-xs font-serif italic text-white/80">
                            We are on your side. We treat marketing tricks as a
                            threat to your savings. Every check is done to help
                            you make the best decision for your money:{" "}
                            <span className="text-white font-black underline">
                              BUY, WAIT, or RUN
                            </span>
                            .
                          </p>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => setShowGuide(false)}
                      className="w-full bg-white text-bg py-5 font-black uppercase tracking-[0.4em] text-[11px] hover:bg-accent transition-all relative group overflow-hidden"
                    >
                      <span className="relative z-10">Get Started</span>
                      <div className="absolute inset-x-0 bottom-0 h-1 bg-accent/30 translate-y-full group-hover:translate-y-0 transition-transform" />
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Founder Admin Dashboard Overlay */}
        <AnimatePresence>
          {showAdminDashboard && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[200] bg-black/95 backdrop-blur-xl flex flex-col items-center p-6 md:p-12 overflow-hidden"
            >
              <div className="w-full max-w-6xl h-full flex flex-col gap-8">
                <div className="flex justify-between items-center border-b border-accent/20 pb-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-accent/20 rounded-sm">
                      <Lock className="w-6 h-6 text-accent" />
                    </div>
                    <div>
                      <h2 className="text-2xl font-mono text-white tracking-widest uppercase">
                        Founder Dashboard
                      </h2>
                      <p className="text-[10px] font-mono text-accent/60 uppercase tracking-widest">
                        Version 2.4 | Admin: {user?.email}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex bg-white/5 rounded-full p-1 border border-white/10">
                      {(["hotline", "feedback", "analytics"] as const).map(
                        (tab) => (
                          <button
                            key={tab}
                            onClick={() => setAdminTab(tab)}
                            className={cn(
                              "px-6 py-2 rounded-full font-mono text-[9px] uppercase tracking-widest transition-all",
                              adminTab === tab
                                ? "bg-accent text-bg font-black"
                                : "text-white/40 hover:text-white",
                            )}
                          >
                            {tab === "hotline" ? "Messages" : tab}
                          </button>
                        ),
                      )}
                    </div>
                    <button
                      onClick={() => setShowAdminDashboard(false)}
                      className="p-4 hover:bg-white/5 transition-all group border-l border-white/10 ml-4"
                    >
                      <X className="w-6 h-6 text-white/40 group-hover:text-white" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 flex-1 overflow-hidden">
                  {/* Left Column: Stats & Broadcast */}
                  <div className="space-y-8">
                    <div className="grid grid-cols-1 gap-4">
                      <div className="p-6 bg-white/5 border border-white/10 space-y-2">
                        <div className="text-[10px] font-mono text-white/20 uppercase tracking-widest">
                          Avg Feedback Score
                        </div>
                        <div className="text-3xl font-mono text-accent">
                          {adminFeedback.length > 0
                            ? (
                                adminFeedback.reduce(
                                  (a, b) => a + (b.accuracyScore || 0),
                                  0,
                                ) / adminFeedback.length
                              ).toFixed(1)
                            : "N/A"}
                          /5
                        </div>
                      </div>
                      <div className="p-6 bg-white/5 border border-white/10 space-y-2">
                        <div className="text-[10px] font-mono text-white/20 uppercase tracking-widest">
                          Hotline Signals
                        </div>
                        <div className="text-3xl font-mono text-white">
                          {adminHotline.length}
                        </div>
                      </div>
                    </div>

                    <div className="p-6 bg-white/5 border border-white/10 space-y-4">
                      <div className="flex items-center gap-2">
                        <Radio className="w-3 h-3 text-accent" />
                        <span className="text-[10px] font-mono text-white uppercase tracking-widest">
                          Global Messages
                        </span>
                      </div>
                      <div className="flex flex-col gap-2">
                        <input
                          type="text"
                          value={broadcastInput}
                          onChange={(e) => setBroadcastInput(e.target.value)}
                          placeholder="ENTER MESSAGE HERE..."
                          className="w-full bg-black/40 border border-white/10 p-3 font-mono text-[10px] text-accent uppercase tracking-widest focus:border-accent/40 outline-none"
                          onKeyDown={(e) =>
                            e.key === "Enter" && updateBroadcast()
                          }
                        />
                        <button
                          onClick={updateBroadcast}
                          className="w-full py-3 bg-accent text-bg font-mono text-[10px] font-black uppercase tracking-widest hover:bg-white transition-colors"
                        >
                          Push to Ticker
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Right Component: Content Area */}
                  <div className="lg:col-span-3 flex flex-col h-full p-6 bg-white/5 border border-white/10 overflow-hidden">
                    <div className="flex justify-between items-center mb-8">
                      <div className="flex items-center gap-2">
                        {adminTab === "hotline" && (
                          <Phone className="w-3 h-3 text-accent" />
                        )}
                        {adminTab === "feedback" && (
                          <ThumbsUp className="w-3 h-3 text-accent" />
                        )}
                        {adminTab === "analytics" && (
                          <Activity className="w-3 h-3 text-accent" />
                        )}
                        <span className="text-[10px] font-mono text-white uppercase tracking-widest">
                          {adminTab === "hotline" && "Founder Hotline Signals"}
                          {adminTab === "feedback" && "User Feedback"}
                          {adminTab === "analytics" &&
                            "Real-time System Access Logs"}
                        </span>
                      </div>
                      <button
                        onClick={() => {
                          let csv = "";
                          let filename = "";
                          if (adminTab === "hotline") {
                            csv =
                              "Email,Message,Timestamp\n" +
                              adminHotline
                                .map(
                                  (h) =>
                                    `${h.email},"${h.message.replace(/"/g, '""')}",${h.timestamp?.toDate ? h.timestamp.toDate().toISOString() : ""}`,
                                )
                                .join("\n");
                            filename = `vetto_hotline_${new Date().toISOString().split("T")[0]}.csv`;
                          } else if (adminTab === "feedback") {
                            csv =
                              "Reference,Score,Comment,Timestamp\n" +
                              adminFeedback
                                .map(
                                  (f) =>
                                    `${f.recId},${f.accuracyScore},"${(f.comment || "").replace(/"/g, '""')}",${f.timestamp?.toDate ? f.timestamp.toDate().toISOString() : ""}`,
                                )
                                .join("\n");
                            filename = `vetto_feedback_${new Date().toISOString().split("T")[0]}.csv`;
                          } else if (adminTab === "analytics") {
                            csv =
                              "UID,Email,UserAgent,Timestamp\n" +
                              adminAnalytics
                                .map(
                                  (a) =>
                                    `${a.uid},${a.email},"${(a.userAgent || "").replace(/"/g, '""')}",${a.timestamp?.toDate ? a.timestamp.toDate().toISOString() : ""}`,
                                )
                                .join("\n");
                            filename = `vetto_analytics_${new Date().toISOString().split("T")[0]}.csv`;
                          }
                          const blob = new Blob([csv], { type: "text/csv" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = filename;
                          a.click();
                        }}
                        className="text-[9px] font-mono text-accent hover:underline uppercase tracking-widest px-4 py-2 bg-accent/5 border border-accent/10"
                      >
                        [ DOWNLOAD CSV ]
                      </button>
                    </div>

                    <div className="flex-1 overflow-y-auto pr-2 scrollbar-hide">
                      {adminTab === "hotline" && (
                        <div className="space-y-4">
                          {adminHotline.length === 0 ? (
                            <div className="py-20 text-center text-[10px] font-mono text-white/10 uppercase tracking-widest">
                              No Signals Received
                            </div>
                          ) : (
                            adminHotline.map((msg) => (
                              <div
                                key={msg.id}
                                className="p-6 bg-black/40 border border-white/5 space-y-3 hover:border-accent/20 transition-colors group relative"
                              >
                                <button
                                  onClick={() =>
                                    deleteDocument("hotline", msg.id)
                                  }
                                  className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 p-2 text-white/10 hover:text-red-500 transition-all"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                                <div className="flex justify-between items-center">
                                  <span className="text-[10px] font-mono text-accent uppercase tracking-widest">
                                    {msg.email}
                                  </span>
                                  <span className="text-[8px] font-mono text-white/20">
                                    {msg.timestamp?.toDate
                                      ? msg.timestamp.toDate().toLocaleString()
                                      : "LIVE"}
                                  </span>
                                </div>
                                <p className="text-sm font-serif italic text-white/80 leading-relaxed">
                                  "{msg.message}"
                                </p>
                              </div>
                            ))
                          )}
                        </div>
                      )}

                      {adminTab === "feedback" && (
                        <div className="space-y-4">
                          {adminFeedback.length === 0 ? (
                            <div className="py-20 text-center text-[10px] font-mono text-white/10 uppercase tracking-widest">
                              No Feedback Shared Yet
                            </div>
                          ) : (
                            adminFeedback.map((fb) => (
                              <div
                                key={fb.id}
                                className="p-6 bg-black/40 border border-white/5 space-y-3 hover:border-accent/20 transition-colors"
                              >
                                <div className="flex justify-between items-start">
                                  <div className="space-y-1">
                                    <div className="flex items-center gap-4">
                                      <div className="flex gap-1">
                                        {[1, 2, 3, 4, 5].map((s) => (
                                          <div
                                            key={s}
                                            className={cn(
                                              "w-2 h-2 rounded-full",
                                              s <= fb.accuracyScore
                                                ? "bg-accent"
                                                : "bg-white/10",
                                            )}
                                          />
                                        ))}
                                      </div>
                                      <span className="text-[9px] font-mono text-white/40 uppercase tracking-widest">
                                        Score: {fb.accuracyScore}/5
                                      </span>
                                    </div>
                                    <div className="text-[8px] font-mono text-accent/40 uppercase tracking-tighter truncate max-w-[200px]">
                                      {fb.recId}
                                    </div>
                                  </div>
                                  <span className="text-[8px] font-mono text-white/20">
                                    {fb.timestamp?.toDate
                                      ? fb.timestamp.toDate().toLocaleString()
                                      : "RECENT"}
                                  </span>
                                </div>
                                {fb.comment && (
                                  <p className="text-sm font-serif italic text-white/80 border-t border-white/5 pt-3">
                                    "{fb.comment}"
                                  </p>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                      {adminTab === "analytics" && (
                        <div className="flex flex-col gap-4 overflow-y-auto pr-2 custom-scrollbar">
                          {adminAnalytics.length === 0 ? (
                            <div className="py-20 text-center text-[10px] font-mono text-white/20 uppercase tracking-widest">
                              No access logs detected.
                            </div>
                          ) : (
                            adminAnalytics.map((log) => (
                              <div
                                key={log.id}
                                className="p-4 bg-white/5 border border-white/10 hover:border-accent/40 transition-all group"
                              >
                                <div className="flex justify-between items-start">
                                  <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                      <Fingerprint className="w-3 h-3 text-accent" />
                                      <span className="text-[10px] font-mono text-white uppercase tracking-widest">
                                        {log.email}
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap gap-4 mt-2">
                                      <div className="flex items-center gap-1.5">
                                        <MapPin className="w-2.5 h-2.5 text-accent/40" />
                                        <span className="text-[9px] font-mono text-white/40 uppercase">
                                          {log.location || "Unknown Location"}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                        <Globe className="w-2.5 h-2.5 text-accent/40" />
                                        <span className="text-[9px] font-mono text-white/40 uppercase">
                                          {log.referrer || "Direct"}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                        <Monitor className="w-2.5 h-2.5 text-accent/40" />
                                        <span className="text-[9px] font-mono text-white/40 uppercase">
                                          {log.screen}
                                        </span>
                                      </div>
                                    </div>
                                    <div className="text-[9px] font-mono text-white/20 truncate max-w-md mt-1">
                                      {log.userAgent}
                                    </div>
                                  </div>
                                  <div className="text-[9px] font-mono text-accent/60 uppercase">
                                    {log.timestamp?.toDate
                                      ? log.timestamp.toDate().toLocaleString()
                                      : "PENDING"}
                                  </div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Dashboard Grid - Strictly Founder Managed */}
        {false && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex-grow flex flex-col items-center justify-center text-center p-8 space-y-12"
          >
            <div className="relative">
              <div className="absolute inset-0 bg-accent/20 blur-[100px] rounded-full animate-pulse" />
              <Lock className="w-16 h-16 text-accent mx-auto relative z-10" />
            </div>

            <div className="space-y-6 max-w-2xl">
              <div className="space-y-4">
                <span className="text-[10px] font-mono text-accent uppercase tracking-[0.5em] font-black">
                  Production Verified System
                </span>
                <h2 className="text-4xl md:text-7xl font-serif italic text-white uppercase leading-none tracking-tighter">
                  Status:{" "}
                  <span className="text-white/20">Pending Verification.</span>
                </h2>
              </div>

              <div className="p-10 glass-card border-accent/20 space-y-4 bg-accent/[0.02]">
                <div className="font-mono text-[9px] text-white/40 uppercase tracking-[0.4em]">
                  Your Global Rank
                </div>
                <div className="text-6xl font-serif italic text-white">
                  # {String(waitlistRank || "0000").padStart(4, "0")}
                </div>
                <div className="text-[10px] font-mono text-accent uppercase tracking-widest pt-4">
                  Estimated deployment: Batch 1
                </div>
              </div>

              <p className="text-sm md:text-lg font-serif italic text-white/40 leading-relaxed">
                Vetto is scaling carefully to ensure fast checks for our first
                users. Your invitation rank is secure.
              </p>

              <div className="pt-10 flex flex-col items-center gap-8">
                <div className="flex flex-col sm:flex-row gap-6">
                  <button
                    onClick={() => setShowFounderAuth(true)}
                    className="px-10 py-4 bg-accent text-bg text-[10px] font-black uppercase tracking-[0.3em] hover:bg-white transition-all shadow-[0_10px_30px_rgba(0,102,204,0.1)]"
                  >
                    Enter Invitation Key
                  </button>
                  <button
                    onClick={() => {
                      navigator
                        .share({
                          title: "Vetto Smart Buying Guide",
                          text: "I am using Vetto to find real value and avoid bad purchases. Check it out now.",
                          url: window.location.href,
                        })
                        .catch(async () => {
                          const ok = await copyToClipboard(
                            window.location.href,
                          );
                          if (ok)
                            showToast(
                              "Link copied to clipboard! Share it with others.",
                              "success",
                            );
                        });
                    }}
                    className="px-10 py-4 border border-white/10 text-white text-[10px] font-black uppercase tracking-[0.3em] hover:bg-white/5 transition-all"
                  >
                    Invite Others
                  </button>
                </div>

                <button
                  onClick={() => {
                    setOnWaitlist(false);
                    localStorage.removeItem("on_waitlist");
                  }}
                  className="text-[9px] font-mono text-white/10 uppercase tracking-[0.4em] hover:text-white transition-colors"
                >
                  Edit My Profile
                </button>
              </div>
            </div>
          </motion.div>
        )}

        <AnimatePresence>
          {showFounderAuth && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[200] bg-bg/95 backdrop-blur-3xl flex items-center justify-center p-6"
            >
              <div className="w-full max-w-md glass-panel p-12 space-y-10 border-accent/20 relative">
                <button
                  onClick={() => setShowFounderAuth(false)}
                  className="absolute top-6 right-6 text-white/20 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>

                <div className="text-center space-y-4">
                  <span className="text-[10px] font-mono text-accent uppercase tracking-[0.5em]">
                    Founder Verification
                  </span>
                  <p className="text-sm font-serif italic text-white/40">
                    Enter your Founder Key to access technical controls.
                  </p>
                </div>

                <form onSubmit={handleFounderAuth} className="space-y-8">
                  <input
                    autoFocus
                    type="password"
                    placeholder="Enter Key..."
                    value={founderKey}
                    onChange={(e) => setFounderKey(e.target.value)}
                    className="w-full bg-transparent border-b-2 border-white/10 py-4 text-2xl font-mono text-center text-accent tracking-[0.5em] focus:outline-none focus:border-accent transition-colors"
                  />
                  <button className="w-full bg-accent text-bg py-5 text-[11px] font-black uppercase tracking-[0.4em] hover:bg-white transition-all shadow-[0_10px_40px_rgba(0,102,204,0.2)]">
                    Access Dashboard
                  </button>
                </form>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Secondary layout components (Bento grid on landing, result layout on audit complete) */}
        {!result ? (
          <div className="max-w-5xl mx-auto w-full mt-4 mb-20 space-y-12">
            {/* Elegant Bento Row */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {/* Box 1: Vault & Shortlist */}
              <div className="bg-white border border-slate-150 p-8 rounded-[2rem] shadow-sm space-y-6 flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <History className="w-4 h-4 text-accent" />
                    <span className="text-[10px] font-mono font-black text-slate-400 uppercase tracking-widest">
                      Saved Checks
                    </span>
                  </div>
                  <h3 className="text-xl font-bold text-slate-950 font-serif italic">
                    Your Shortlisted Reports
                  </h3>
                  <p className="text-xs text-slate-500 leading-relaxed font-medium">
                    Products you check are saved in this shortlist panel. Access
                    them instantly with a single click.
                  </p>
                </div>

                <div className="pt-4 border-t border-slate-100 font-medium">
                  {history.length > 0 ? (
                    <div className="space-y-3">
                      {history.slice(0, 3).map((h, i) => (
                        <button
                          key={h.id || i}
                          onClick={() => setResult(h)}
                          className="w-full text-left p-3 bg-slate-50 hover:bg-slate-100 transition-colors rounded-xl flex items-center justify-between"
                        >
                          <span className="text-xs text-slate-700 truncate max-w-[150px]">
                            {h.productName || "Vetted Product"}
                          </span>
                          <span
                            className={cn(
                              "text-[8px] font-mono font-black px-2 py-0.5 rounded uppercase tracking-wider",
                              h.finalDecision?.toLowerCase().includes("run")
                                ? "bg-red-50 text-red-600"
                                : h.finalDecision
                                      ?.toLowerCase()
                                      .includes("wait")
                                  ? "bg-amber-50 text-amber-600"
                                  : "bg-green-50 text-green-650",
                            )}
                          >
                            {h.finalDecision?.includes("RUN")
                              ? "RUN"
                              : h.finalDecision?.includes("WAIT")
                                ? "WAIT"
                                : "BUY"}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="py-6 text-center space-y-2 opacity-50">
                      <Lock className="w-5 h-5 text-slate-300 mx-auto" />
                      <p className="text-[10px] text-slate-400 font-medium">
                        Your saved checks are currently empty.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Box 2: Consumer Trap Detector */}
              <div className="bg-white border border-slate-150 p-8 rounded-[2rem] shadow-sm space-y-6 lg:col-span-1">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-500" />
                    <span className="text-[10px] font-mono font-black text-red-500 uppercase tracking-widest">
                      Common Retailer Traps
                    </span>
                  </div>
                  <h3 className="text-xl font-bold text-slate-950 font-serif italic">
                    Watch Out For These
                  </h3>
                </div>
                <div className="space-y-3 pt-4 border-t border-slate-100 text-xs font-medium text-slate-600">
                  <div className="flex items-start gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 mt-1.5 shrink-0" />
                    <p>
                      Polyester fabrics marked as "Imperial Organic Cotton" or
                      "Luxe linen mixes".
                    </p>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 mt-1.5 shrink-0" />
                    <p>
                      Older smartphone chips inside newly launched "festive
                      collection" versions.
                    </p>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 mt-1.5 shrink-0" />
                    <p>
                      60Hz display refreshing panels on devices over ₹60,000.
                    </p>
                  </div>
                </div>
              </div>

              {/* Box 3: Why Vetto? */}
              <div className="bg-white border border-slate-150 p-8 rounded-[2rem] shadow-sm space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-green-500" />
                    <span className="text-[10px] font-mono font-black text-green-600 uppercase tracking-widest">
                      Unbiased Checks
                    </span>
                  </div>
                  <h3 className="text-xl font-bold text-slate-950 font-serif italic">
                    The Client Promise
                  </h3>
                  <p className="text-xs text-slate-500 leading-relaxed font-medium">
                    Unlike standard influencers or deal sites, Vetto has no
                    hidden partnerships, stores, or advertising blocks:
                  </p>
                </div>
                <div className="space-y-2.5 pt-4 border-t border-slate-100 text-[11px] font-semibold text-slate-600">
                  <div className="flex justify-between items-center bg-slate-50 px-3 py-2 rounded-lg">
                    <span>Affiliate Trap Risk</span>
                    <span className="text-red-500">0%</span>
                  </div>
                  <div className="flex justify-between items-center bg-slate-50 px-3 py-2 rounded-lg">
                    <span>True Material Sourcing</span>
                    <span className="text-green-650">Checked</span>
                  </div>
                  <div className="flex justify-between items-center bg-slate-50 px-3 py-2 rounded-lg">
                    <span>Fake Discount Filtering</span>
                    <span className="text-green-650">Active</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Peaceful live activity line */}
            <div className="bg-slate-50 border border-slate-150 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-[9px] text-slate-400 uppercase tracking-widest">
              <div className="flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 text-accent animate-pulse" />
                <span>Live verified feed across major Indian metros:</span>
              </div>
              <div className="flex flex-wrap gap-4 font-bold text-slate-600">
                <span>Gaming Headphones Verified • wait signal</span>
                <span>Bengaluru Family SUV • safe buy</span>
                <span>Noida Budget Phone • counterfeit reviews found</span>
              </div>
            </div>
          </div>
        ) : (
          /* Compact search bar for secondary queries when presenting results! */
          <div className="max-w-5xl mx-auto w-full mb-10 bg-white border border-slate-150 shadow-md rounded-[2rem] p-5">
            <form
              onSubmit={handleSubmit}
              className="flex flex-col md:flex-row items-center gap-4"
            >
              <div className="flex items-center gap-2.5 shrink-0">
                <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                <span className="text-[10px] font-mono font-black text-slate-400 uppercase tracking-widest">
                  New Check:
                </span>
              </div>
              <div className="relative flex-1 w-full">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <Search className="w-4 h-4 text-slate-300" />
                </div>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Check another item or paste link..."
                  className="w-full bg-slate-50 border border-slate-100 focus:border-accent/40 focus:bg-white rounded-xl py-3 pl-11 pr-4 text-sm font-medium text-slate-900 outline-none transition-all"
                  required
                />
              </div>
              <div className="flex gap-2 w-full md:w-auto shrink-0">
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 md:flex-none bg-slate-900 hover:bg-accent text-white py-3 px-8 rounded-xl text-[9px] font-black uppercase tracking-widest transition-colors flex items-center justify-center gap-2 min-w-[130px]"
                >
                  {loading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    "Check Again"
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    setQuery("");
                  }}
                  className="bg-slate-50 hover:bg-slate-100 text-slate-500 border border-slate-150 py-3 px-6 rounded-xl text-[9px] font-black uppercase tracking-widest transition-colors"
                >
                  Reset Home
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Results / Empty / Loading State */}
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[150] bg-white flex flex-col items-center justify-center text-center p-8 md:p-16 overflow-hidden"
            >
              {/* Premium Subtle Grid Background */}
              <div className="absolute inset-0 bg-[radial-gradient(#e2e8f0_1px,transparent_1px)] [background-size:24px_24px] opacity-40 pointer-events-none" />

              <div className="relative z-10 w-full max-w-2xl space-y-12">
                {/* Custom pulse validation seal */}
                <div className="relative flex justify-center items-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{
                      duration: 12,
                      repeat: Infinity,
                      ease: "linear",
                    }}
                    className="w-32 h-32 rounded-full border border-slate-200 flex items-center justify-center"
                  >
                    <div className="w-28 h-28 rounded-full border-2 border-dashed border-slate-200" />
                  </motion.div>
                  <motion.div
                    animate={{ scale: [0.95, 1.05, 0.95] }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                    className="absolute w-20 h-20 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center shadow-md border-slate-200"
                  >
                    <Fingerprint className="w-8 h-8 text-slate-800" />
                  </motion.div>
                </div>

                <div className="space-y-4">
                  <span className="text-[10px] sm:text-xs font-mono font-black text-slate-400 uppercase tracking-[0.4em] block">
                    Vetto Verification Protocol
                  </span>
                  <motion.p
                    key={auditStep}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="text-lg sm:text-xl font-medium text-slate-800 font-serif italic max-w-md mx-auto leading-relaxed"
                  >
                    {auditSteps[auditStep]}
                  </motion.p>
                </div>

                {/* Snappy Thin loading bar */}
                <div className="w-48 h-[2px] bg-slate-100 rounded-full mx-auto overflow-hidden">
                  <motion.div
                    animate={{ x: ["-100%", "100%"] }}
                    transition={{
                      repeat: Infinity,
                      duration: 1.5,
                      ease: "easeInOut",
                    }}
                    className="h-full w-1/2 bg-slate-900 rounded-full"
                  />
                </div>
              </div>
            </motion.div>
          ) : error ? (
            <motion.div
              key="error"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="max-w-2xl mx-auto py-16 px-8 text-center"
            >
              {billingError ? (
                <div className="bg-amber-50/80 border border-amber-200 rounded-3xl p-8 mb-8 text-left shadow-sm">
                  <div className="flex gap-4 items-start mb-6 animate-pulse">
                    <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center shrink-0">
                      <CreditCard className="w-6 h-6 text-amber-700" />
                    </div>
                    <div>
                      <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">
                        Verification Engine Capacity Reached
                      </h3>
                      <p className="text-xs text-amber-800 font-semibold mt-1">
                        High-priority audit queues are currently saturated under extreme public traffic.
                      </p>
                    </div>
                  </div>

                  <div className="space-y-4 text-slate-700 text-sm leading-relaxed">
                    <p className="font-medium">
                      Bhai note: VETTO's uncompromised, real-time forensic scanning is currently processing hundreds of queries. To ensure absolute speed and accuracy without waiting in high-priority queues, you can configure your own key:
                    </p>
                    <div className="border-t border-amber-200/60 my-4" />
                    <p className="font-bold text-slate-950 border-l-2 border-amber-500 pl-2">
                      To run high-speed scans instantly:
                    </p>
                    <ul className="list-decimal list-inside space-y-2.5 pl-1 text-slate-600 font-medium">
                      <li>
                        Click the <strong className="text-slate-900">Settings</strong> (⚙️) gear icon in the top-right corner.
                      </li>
                      <li>
                        Enter your personal, secure <strong className="text-slate-900">Gemini API Key</strong> to allocate dedicated, private quota directly for your audits.
                      </li>
                      <li>
                        Tap <strong className="text-slate-900">Try Again</strong> below to resume instant verification.
                      </li>
                    </ul>
                  </div>
                </div>
              ) : (
                <>
                  <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-8">
                    <ShieldAlert className="w-10 h-10 text-red-600" />
                  </div>
                  <h3 className="text-2xl font-black text-slate-900 mb-4 uppercase tracking-tight">
                    Verification Failed
                  </h3>
                </>
              )}

              {!billingError && (
                <p className="text-slate-600 font-medium mb-8 leading-relaxed">
                  {error}
                </p>
              )}

              <div className="flex justify-center gap-4">
                <button
                  onClick={() => {
                    setError(null);
                    setBillingError(false);
                    handleSubmit({ preventDefault: () => {} } as any);
                  }}
                  className="px-8 py-4 bg-accent text-white font-bold rounded-xl hover:bg-slate-900 transition-all text-xs uppercase tracking-widest flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" /> Try Again
                </button>
                <button
                  onClick={() => {
                    setError(null);
                    setBillingError(false);
                    setResult(null);
                    setQuery("");
                  }}
                  className="px-8 py-4 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition-all text-xs uppercase tracking-widest"
                >
                  Clear
                </button>
              </div>
            </motion.div>
          ) : result ? (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-12 pb-32 w-full"
            >
              {/* Hero Result Section */}
              <div className="glass-panel overflow-hidden">
                <div
                  className={cn(
                    "p-8 md:p-16 space-y-12 relative overflow-hidden",
                    result?.marketTiming === "RUN"
                      ? "bg-red-950/10 border-red-500/20"
                      : result?.marketTiming === "WAIT"
                        ? "bg-amber-950/10 border-amber-500/20"
                        : "bg-white/[0.02]",
                  )}
                >
                  <div className="flex flex-col md:flex-row md:items-start justify-between gap-12 relative z-10">
                    <div className="space-y-6 flex-1">
                      <div className="flex items-center gap-3">
                        <div className="mono-tag bg-white/5 border border-white/10">
                          Our Recommendation
                        </div>
                        <div className="flex items-center gap-1.5 px-3 py-1 bg-blue-600/20 border border-blue-500/30 rounded-full">
                          <ShieldCheck className="w-3 h-3 text-blue-400 animate-pulse" />
                          <span className="text-[8px] font-black text-blue-400 uppercase tracking-widest">
                            Verified Truth
                          </span>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <h1
                          className={cn(
                            "score-display",
                            result?.marketTiming === "RUN"
                              ? "text-red-500 drop-shadow-[0_0_20px_rgba(239,68,68,0.3)]"
                              : result?.marketTiming === "WAIT"
                                ? "text-amber-500 drop-shadow-[0_0_20px_rgba(245,158,11,0.3)]"
                                : "text-gradient drop-shadow-[0_0_20px_rgba(229,193,88,0.3)]",
                          )}
                        >
                          {result?.marketTiming || "Analyzing..."}
                        </h1>
                        <div className="flex items-center gap-3 mt-4">
                          <div className="h-px w-12 bg-white/10" />
                          <p className="text-sm font-black uppercase tracking-[0.3em] text-zinc-500">
                            Our Recommendation
                          </p>
                        </div>
                      </div>

                      <div className="space-y-3 pt-6 border-t border-white/10 max-w-sm">
                        <span className="section-heading mb-0">
                          The Item We Analyzed
                        </span>
                        <p className="text-2xl md:text-3xl font-black text-white tracking-tight leading-none">
                          {result?.productName || "Loading..."}
                        </p>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono font-bold text-zinc-500 uppercase tracking-widest">
                            Model Confirmed
                          </span>
                          <CheckCircle2 className="w-3 h-3 text-green-500 animate-bounce" />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4 shrink-0">
                      <button
                        onClick={() => {
                          const text = `VETTO REPORT: "${result?.aamAadmiSummary || ""}"\n\nRecommendation: ${result?.marketTiming || ""}\n\nRead the full report at: ${window.location.origin}`;
                          copyToClipboard(text);
                          showToast(
                            "Report copied to your clipboard!",
                            "success",
                          );
                        }}
                        className="w-full bg-accent text-bg px-10 py-6 rounded-2xl flex items-center justify-center gap-4 font-black uppercase tracking-[0.3em] text-[10px] hover:bg-white transition-all shadow-2xl group cursor-pointer"
                      >
                        <Share2 className="w-4 h-4 group-hover:scale-110 transition-transform duration-300" />
                        Share Report
                      </button>
                      <p className="text-[9px] font-mono text-center text-zinc-500 uppercase tracking-widest">
                        Secure Report Active
                      </p>
                    </div>
                  </div>

                  <div className="max-w-4xl relative z-10">
                    <p className="text-3xl md:text-4xl font-black text-white leading-[1.1] tracking-tight">
                      &ldquo;{result?.aamAadmiSummary || ""}&rdquo;
                    </p>
                  </div>
                </div>

                <div className="p-6 md:p-16 grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-16 border-t border-white/10 bg-transparent">
                  <div className="space-y-10">
                    <div>
                      <span className="section-heading">
                        Value for Money (0-100)
                      </span>
                      <div className="flex items-end gap-4">
                        <span className="text-6xl sm:text-7xl font-black text-white leading-none tracking-tighter">
                          {result?.paisaVasoolIndex ?? 0}
                        </span>
                        <span className="text-xl sm:text-2xl font-bold text-zinc-700 mb-2">
                          / 100
                        </span>
                      </div>
                      <div className="h-3 w-full bg-white/5 rounded-full mt-8 overflow-hidden border border-white/10 p-0.5">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${result?.paisaVasoolIndex ?? 0}%` }}
                          transition={{ duration: 1.5, ease: "easeOut" }}
                          className="h-full bg-accent rounded-full"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-6">
                      <div className="p-6 bg-white/5 rounded-2xl border border-white/10 space-y-2 shadow-sm">
                        <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest block">
                          The Brand "Tax"
                        </span>
                        <span className="text-2xl font-black text-red-400 tracking-tighter">
                          ₹{(result?.statusTax ?? 0).toLocaleString()}
                        </span>
                        <p className="text-[10px] text-zinc-500 font-medium italic truncate">
                          Extra cost for the brand name
                        </p>
                      </div>
                      <div className="p-6 bg-white/5 rounded-2xl border border-white/10 space-y-2">
                        <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest block">
                          Usefulness Score
                        </span>
                        <span className="text-2xl font-black text-white tracking-tighter">
                          {result?.utilityScore ?? 0}/100
                        </span>
                        <p className="text-[10px] text-zinc-500 font-medium italic">
                          How much it solves
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-10">
                    {/* Interactive "Paisa Vasool" Lifecycle Simulator */}
                    <div className="space-y-4">
                      <div className="flex justify-between items-center bg-white/5 p-4 rounded-xl border border-dashed border-white/10">
                        <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">
                          Interactive simulation
                        </span>
                        <div className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                          <span className="text-[8px] font-black font-mono text-accent uppercase">
                            Live math
                          </span>
                        </div>
                      </div>

                      <div className="p-8 bg-white/5 rounded-3xl border border-white/10 space-y-6">
                        <div className="space-y-1">
                          <h4 className="text-base font-black text-white font-display">
                            Your Real Usage Simulator
                          </h4>
                          <p className="text-xs text-zinc-400 font-medium leading-relaxed">
                            Recalculate your value scores based on how{" "}
                            <span className="underline decoration-accent decoration-2">
                              you
                            </span>{" "}
                            plan to use it.
                          </p>
                        </div>

                        <div className="h-px bg-white/10" />

                        {/* Slider 1: Expected Usage Years */}
                        <div className="space-y-2">
                          <div className="flex justify-between items-center">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                              Expected Usage (Years)
                            </span>
                            <span className="text-xs font-mono font-black text-slate-900">
                              {ownershipYears} Years
                            </span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="7"
                            value={ownershipYears}
                            onChange={(e) =>
                              setOwnershipYears(parseInt(e.target.value))
                            }
                            className="w-full accent-slate-950 h-1.5 bg-slate-200 rounded-full cursor-pointer appearance-none"
                          />
                        </div>

                        {/* Frequency Toggle */}
                        <div className="space-y-2">
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
                            Usage Frequency
                          </span>
                          <div className="grid grid-cols-3 gap-2">
                            {[
                              { key: "daily", label: "Daily", fact: "100%" },
                              { key: "weekly", label: "Weekly", fact: "30%" },
                              {
                                key: "occasional",
                                label: "Occasional",
                                fact: "10%",
                              },
                            ].map((freq) => (
                              <button
                                key={freq.key}
                                type="button"
                                onClick={() => setUsagePattern(freq.key as any)}
                                className={cn(
                                  "py-3 px-3 rounded-xl border text-[10px] font-black uppercase tracking-wider transition-colors",
                                  usagePattern === freq.key
                                    ? "bg-slate-900 border-slate-900 text-white shadow-sm"
                                    : "bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50",
                                )}
                              >
                                {freq.label}{" "}
                                <span className="opacity-40 block text-[8px] tracking-normal font-sans normal-case mt-0.5">
                                  ({freq.fact})
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Input for Maintenance/Accessories */}
                        <div className="space-y-2">
                          <div className="flex justify-between items-center">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                              Add-on expenses / maintenance
                            </span>
                            <span className="text-xs font-mono font-black text-slate-950">
                              ₹{maintenanceCost.toLocaleString()}
                            </span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max={Math.max(
                              10000,
                              Math.round(getNumericPrice(result) * 0.3),
                            )}
                            step="500"
                            value={maintenanceCost}
                            onChange={(e) =>
                              setMaintenanceCost(parseInt(e.target.value))
                            }
                            className="w-full h-1.5 bg-slate-200 rounded-full cursor-pointer appearance-none"
                          />
                        </div>

                        {/* Live Output Calculations */}
                        {(() => {
                          const basePrice = getNumericPrice(result);
                          const totalCost = basePrice + maintenanceCost;
                          const years = ownershipYears;
                          const freqFactor =
                            usagePattern === "daily"
                              ? 1.0
                              : usagePattern === "weekly"
                                ? 0.3
                                : 0.08;
                          const calculatedCpd = Math.max(
                            1,
                            Math.round(
                              totalCost / Math.max(1, years * 365 * freqFactor),
                            ),
                          );
                          const surcharge = Math.min(
                            95,
                            Math.max(
                              5,
                              Math.round(((result?.statusTax ?? 0) / totalCost) * 100),
                            ),
                          );
                          const computedPvi = Math.round(
                            (result?.paisaVasoolIndex ?? 0) *
                              (usagePattern === "daily"
                                ? 1.0
                                : usagePattern === "weekly"
                                  ? 0.75
                                  : 0.4) *
                              (ownershipYears >= 3
                                ? 1.0
                                : ownershipYears === 2
                                  ? 0.85
                                  : 0.7),
                          );
                          return (
                            <div className="bg-white/90 p-5 rounded-2xl border border-slate-200/60 space-y-4">
                              <div className="flex justify-between items-center">
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-wide">
                                  Pure Utility Cost Per Day
                                </span>
                                <span className="text-sm font-mono font-black text-slate-900">
                                  ₹{calculatedCpd}
                                </span>
                              </div>

                              <div className="h-px bg-slate-100" />

                              <div className="flex justify-between items-center">
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-wide">
                                  Calculated Status Surcharge
                                </span>
                                <span className="text-xs font-mono font-black text-zinc-600">
                                  {surcharge}% of price
                                </span>
                              </div>

                              <div className="h-px bg-slate-100" />

                              <div className="flex justify-between items-center">
                                <span className="text-[9px] font-black text-slate-900 uppercase tracking-wide">
                                  Simulated Paisa Vasool Score
                                </span>
                                <span
                                  className={cn(
                                    "text-xs font-mono font-black py-0.5 px-2 rounded border",
                                    computedPvi >= 75
                                      ? "text-emerald-700 bg-emerald-50 border-emerald-100"
                                      : computedPvi >= 45
                                        ? "text-amber-700 bg-amber-50 border-amber-100"
                                        : "text-rose-700 bg-rose-50 border-rose-100",
                                  )}
                                >
                                  {computedPvi} / 100
                                </span>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <span className="section-heading mb-0">
                          Scan Confidence
                        </span>
                        <span className="text-sm font-black text-slate-900">
                          {result?.confidenceScore ?? 0}%
                        </span>
                      </div>
                      <div className="p-8 bg-slate-50 rounded-3xl border border-slate-100 space-y-6">
                        <div className="flex items-start gap-4">
                          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                            <ShieldCheck className="w-3 h-3 text-white" />
                          </div>
                          <div>
                            <span className="text-[10px] font-black text-slate-900 uppercase tracking-widest block mb-1">
                              Report Reasoning
                            </span>
                            <p className="text-sm font-medium text-slate-600 leading-relaxed">
                              {result?.marketReasoning || ""}
                            </p>
                          </div>
                        </div>
                        <div className="h-px bg-slate-200/50" />
                        <div className="flex items-start gap-4">
                          <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                            <AlertTriangle className="w-3 h-3 text-slate-400" />
                          </div>
                          <div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">
                              Regret Risk
                            </span>
                            <p className="text-sm font-medium text-slate-600 leading-relaxed">
                              {result?.regretWarning || ""}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Checking if reviews are real */}
              <div className="theme-card-dark bg-slate-950 text-white rounded-[2rem] md:rounded-[2.5rem] p-6 md:p-16 space-y-10 md:space-y-12 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-12 opacity-[0.05]">
                  <Target className="w-64 md:w-96 h-64 md:h-96 text-white" />
                </div>

                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative z-10">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <Fingerprint className="w-4 h-4 text-slate-400" />
                      <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400">
                        Final Truth Check
                      </h3>
                    </div>
                    <p className="text-2xl md:text-3xl font-black tracking-tight">
                      Marketing <span className="text-slate-500">vs</span>{" "}
                      Reality
                    </p>
                  </div>
                  <div className="px-5 py-2 bg-white/5 border border-white/10 rounded-full flex items-center gap-2 self-start md:self-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
                    <span className="text-[10px] font-mono font-bold tracking-widest text-white/60">
                      Checking 1,400 Data Points
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 relative z-10">
                  <div className="group p-8 bg-white/5 border border-white/10 rounded-3xl flex flex-col justify-between h-full hover:bg-white/[0.08] transition-all duration-500">
                    <div className="space-y-6">
                      <div className="flex justify-between items-start">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                          Hype vs Reality Gap
                        </span>
                        <ShieldAlert className="w-4 h-4 text-red-500/50" />
                      </div>
                      <div className="space-y-4">
                        <div className="flex items-end gap-2">
                          <span className="text-5xl font-black text-white">
                            {result?.socialAudit?.integrityAudit?.divergenceIndex ?? 0}%
                          </span>
                          <span className="text-[10px] font-bold text-slate-400 mb-2 uppercase">
                            Gap
                          </span>
                        </div>
                        <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{
                              width: `${result?.socialAudit?.integrityAudit?.divergenceIndex ?? 0}%`,
                            }}
                            className="h-full bg-red-500"
                          />
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-white/70 leading-relaxed italic mt-6">
                      &ldquo;{result?.socialAudit?.userRealityCheck || ""}&rdquo;
                    </p>
                  </div>

                  {/* Interactively editable Buzzword Slaying Board */}
                  <div className="p-8 bg-white/5 border border-white/10 rounded-3xl flex flex-col justify-between h-full">
                    <div className="space-y-6">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest block font-mono">
                          Interactive Buzzword Slayer
                        </span>
                        <span className="text-[9px] px-2 py-0.5 rounded bg-red-500/20 border border-red-500/30 text-red-400 font-mono font-black uppercase tracking-wider animate-pulse">
                          Slay Targets
                        </span>
                      </div>

                      <p className="text-xs text-slate-300 leading-relaxed font-sans">
                        Companies use heavy jargon to inflate their prices. Tap
                        any buzzword below to "slay" it and inspect the actual
                        honest truth:
                      </p>

                      <div className="space-y-3">
                        {(result?.socialAudit?.integrityAudit?.buzzwordSlayer ?? [])
                          .slice(0, 4)
                          .map((b, i) => {
                            const isSlain = slainBuzzwords.includes(i);
                            return (
                              <motion.div
                                key={i}
                                onClick={() => {
                                  if (!isSlain) {
                                    setSlainBuzzwords([...slainBuzzwords, i]);
                                    showToast(
                                      `"${b.term}" slain! Truth unlocked.`,
                                      "success",
                                    );
                                  }
                                }}
                                className={cn(
                                  "p-4 rounded-xl border transition-all cursor-pointer relative overflow-hidden select-none group",
                                  isSlain
                                    ? "bg-emerald-950/20 border-emerald-500/40 text-emerald-300"
                                    : "bg-white/5 border-white/10 hover:border-red-500/50 hover:bg-white/10 text-white",
                                )}
                                whileHover={{ scale: 1.01 }}
                                whileTap={{ scale: 0.99 }}
                              >
                                {/* Slicing Slasher animation */}
                                {isSlain && (
                                  <motion.div
                                    initial={{ width: 0 }}
                                    animate={{ width: "100%" }}
                                    transition={{
                                      duration: 0.35,
                                      ease: "easeInOut",
                                    }}
                                    className="absolute top-1/2 left-0 h-0.5 bg-red-500 opacity-60"
                                  />
                                )}

                                <div className="flex justify-between items-center relative z-10">
                                  <span
                                    className={cn(
                                      "text-[11px] font-bold tracking-tight transition-all",
                                      isSlain
                                        ? "line-through text-white/30"
                                        : "text-white",
                                    )}
                                  >
                                    {b.term}
                                  </span>
                                  <span
                                    className={cn(
                                      "text-[8px] font-mono font-black uppercase px-1.5 py-0.5 rounded",
                                      isSlain
                                        ? "bg-emerald-950/30 text-emerald-400"
                                        : "bg-red-500/10 text-red-400 group-hover:bg-red-500/20",
                                    )}
                                  >
                                    {isSlain ? "SLAIN ✓" : "SLAY ⚔"}
                                  </span>
                                </div>

                                <AnimatePresence initial={false}>
                                  {isSlain && (
                                    <motion.div
                                      initial={{ height: 0, opacity: 0 }}
                                      animate={{ height: "auto", opacity: 1 }}
                                      transition={{ duration: 0.25 }}
                                      className="mt-3 pl-3 border-l border-emerald-500/30 space-y-1 relative z-10 overflow-hidden"
                                    >
                                      <span className="text-[8px] font-mono text-emerald-400 uppercase font-black tracking-widest block">
                                        Unvarnished Reality
                                      </span>
                                      <p className="text-xs text-white/85 font-medium leading-relaxed font-sans mt-1">
                                        {b.reality}
                                      </p>
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </motion.div>
                            );
                          })}
                      </div>
                    </div>
                  </div>

                  <div className="p-8 bg-slate-900 border border-white/10 rounded-3xl flex flex-col justify-between h-full relative overflow-hidden group/card">
                    <div className="absolute inset-0 bg-blue-500/5 opacity-0 group-hover/card:opacity-100 transition-opacity" />
                    <div className="relative z-10 space-y-6">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
                        Review Authenticity Score
                      </span>
                      <div className="space-y-4">
                        <div className="flex items-end gap-3">
                          <span className="text-6xl font-black text-white">
                            {result?.socialAudit?.integrityAudit?.fakeReviewScore ?? 0}
                          </span>
                          <span className="text-xl font-bold text-slate-400 mb-2 font-sans">
                            /100
                          </span>
                        </div>
                        <p className="text-xs text-slate-300">
                          Higher score indicates real, honest reviews from
                          actual buyers.
                        </p>
                      </div>
                    </div>
                    <div className="relative z-10 flex items-center gap-3 py-3 px-4 bg-white/5 rounded-2xl border border-white/5 mt-6">
                      <div
                        className={cn(
                          "w-2 h-2 rounded-full animate-pulse",
                          result?.socialAudit?.integrityAudit?.isFakeReviewRisk
                            ? "bg-red-500"
                            : "bg-green-500",
                        )}
                      />
                      <span className="text-[10px] font-bold text-white/80 uppercase tracking-wide truncate">
                        {result?.socialAudit?.integrityAudit?.isFakeReviewRisk
                          ? "⚠️ Risk of Fake Reviews Detected"
                          : "✅ Reviews Appear Genuine & Safe"}
                      </span>
                    </div>
                  </div>

                  {/* Hidden Costs Node */}
                  <div className="p-8 bg-red-950/20 border border-red-500/10 rounded-3xl flex flex-col justify-between h-full hover:bg-red-950/30 transition-all group/hidden">
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <CreditCard className="w-4 h-4 text-red-500" />
                        <span className="text-[10px] font-black text-red-500 uppercase tracking-widest">
                          Extra Costs to Watch Out For
                        </span>
                      </div>
                      <p className="text-sm font-bold text-white/90 leading-relaxed italic">
                        &ldquo;{result?.hiddenCosts || ""}&rdquo;
                      </p>
                    </div>
                    <div className="mt-6">
                      <div className="h-px bg-white/5 w-full mb-2" />
                      <span className="text-[8px] font-mono text-white/20 uppercase tracking-[0.3em]">
                        Capital Protection Active
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-12">
                {/* Is it right for you? */}
                <div className="px-4">
                  <div className="p-8 bg-amber-50/50 border border-amber-100 rounded-[2rem] space-y-4 relative overflow-hidden group/bhartiya">
                    <div className="absolute top-0 right-0 p-8 opacity-[0.03] group-hover/bhartiya:scale-110 transition-transform duration-700">
                      <UserIcon className="w-32 h-32 text-amber-950" />
                    </div>
                    <div className="flex items-center gap-3 relative z-10">
                      <MapPin className="w-4 h-4 text-amber-600" />
                      <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">
                        Is it Right for You?
                      </span>
                    </div>
                    <p className="text-lg md:text-xl font-bold text-slate-900 leading-relaxed relative z-10">
                      &ldquo;{result?.bhartiyaPersonaAudit || ""}&rdquo;
                    </p>
                    <div className="flex items-center gap-2 pt-2 opacity-50">
                      <span className="text-[9px] font-mono font-bold tracking-widest">
                        LOCALIZED CONTEXT ENABLED
                      </span>
                      <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    </div>
                  </div>
                </div>

                {/* Social Truth Hub */}
                <div className="space-y-10">
                  <div className="flex items-center justify-between px-4">
                    <span className="section-heading mb-0">
                      What People Are Really Saying
                    </span>
                    <div className="flex items-center gap-4">
                      <span className="text-[10px] font-mono font-bold text-slate-300 uppercase">
                        Live Public Data
                      </span>
                      <div className="h-4 w-[1px] bg-slate-200" />
                      <button className="text-[10px] font-black text-slate-950 uppercase tracking-widest hover:underline">
                        View All Seeds
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    {[
                      {
                        platform: "Reddit",
                        icon: MessageSquare,
                        color: "#FF4500",
                        data: result?.communityPulse?.redditConsensus || "",
                      },
                      {
                        platform: "X",
                        icon: Twitter,
                        color: "#000000",
                        data: result?.communityPulse?.twitterPulse || "",
                      },
                      {
                        platform: "YouTube",
                        icon: Youtube,
                        color: "#FF0000",
                        data: result?.communityPulse?.youtubeReality || "",
                      },
                      {
                        platform: "LinkedIn",
                        icon: Linkedin,
                        color: "#0A66C2",
                        data: result?.communityPulse?.linkedinProfessional || "",
                      },
                    ].map((source, i) => (
                      <motion.div
                        key={source.platform}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.1 }}
                        className="glass-card p-8 flex flex-col justify-between h-full animate-fadeIn"
                      >
                        <div className="space-y-6">
                          <div className="flex items-center justify-between">
                            <div className="w-10 h-10 rounded-2xl bg-white shadow-sm border border-slate-100 flex items-center justify-center">
                              <source.icon className="w-4 h-4 text-slate-950" />
                            </div>
                            <span className="text-[9px] font-black text-slate-300 uppercase tracking-[0.2em]">
                              {source.platform}
                            </span>
                          </div>
                          <p className="text-sm font-medium text-slate-800 leading-relaxed italic tracking-tight">
                            &ldquo;{source.data}&rdquo;
                          </p>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-12">
                {/* Best Prices Around You */}
                <div className="glass-panel overflow-hidden">
                  <div className="p-6 md:p-16 space-y-10 md:space-y-12">
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-8 pb-10 md:pb-12 border-b border-black/5">
                      <div className="space-y-4">
                        <div className="flex items-center gap-3">
                          <Tag className="w-5 h-5 text-accent" />
                          <h3 className="text-xs font-bold uppercase tracking-[0.3em] text-slate-500 font-mono">
                            Where to Buy & Stock Check
                          </h3>
                        </div>
                        <p className="text-3xl md:text-4xl font-black tracking-tight text-slate-900 font-display">
                          Current Best Prices
                        </p>
                      </div>
                      <div className="flex items-center gap-6 bg-slate-50 p-6 rounded-3xl border border-slate-100 shadow-sm">
                        <div className="text-left md:text-right">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2 font-mono">
                            Is this a Good Deal?
                          </span>
                          <div className="flex items-baseline md:justify-end gap-2 mb-2">
                            <span className="text-4xl sm:text-5xl font-black text-slate-900 font-display tracking-tighter">
                              {result?.priceIntegrity?.dealScore ?? 0}
                            </span>
                            <span className="text-sm font-bold text-slate-400">
                              / 100
                            </span>
                          </div>
                          <div
                            className={cn(
                              "inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border shadow-sm",
                              (result?.priceIntegrity?.dealScore ?? 0) >= 80
                                ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                                : (result?.priceIntegrity?.dealScore ?? 0) >= 60
                                  ? "text-sky-700 bg-sky-50 border-sky-200"
                                  : "text-rose-700 bg-rose-50 border-rose-200",
                            )}
                          >
                            {(result?.priceIntegrity?.dealScore ?? 0) >= 80
                              ? "Excellent Deal - Buy Now!"
                              : (result?.priceIntegrity?.dealScore ?? 0) >= 60
                                ? "Good Fair Price"
                                : "Expensive - Better to Wait!"}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 md:gap-16">
                      {/* Live Price Comparison */}
                      <div className="space-y-8">
                        <span className="section-heading">
                          Price Comparison
                        </span>
                        <div className="space-y-4">
                          {(result?.priceIntegrity?.procurementLinks ?? []).map(
                            (link, i) => {
                              // Client-side link self-healing and resolving mechanism for absolute reliability
                              let resolvedUrl = link.url || "";
                              const prodName = result?.productName || "product";
                              const cleanQuery =
                                simplifyProductNameForSearch(prodName);
                              const encodedProdName = encodeURIComponent(
                                cleanQuery || prodName,
                              );

                              if (resolvedUrl) {
                                resolvedUrl = resolvedUrl
                                  .replace(
                                    /\[urlencoded_product_name\]/gi,
                                    encodedProdName,
                                  )
                                  .replace(
                                    /%5Burlencoded_product_name%5D/gi,
                                    encodedProdName,
                                  )
                                  .replace(
                                    /urlencoded_product_name/gi,
                                    encodedProdName,
                                  );

                                // 1. Strip Google redirect/ad trackers of ALL kinds (including /url, /aclk, /shopping, /adurl, etc.)
                                if (
                                  resolvedUrl.includes("google.com") ||
                                  resolvedUrl.includes("google.co.in") ||
                                  resolvedUrl.includes("google.ad")
                                ) {
                                  try {
                                    const urlObj = new URL(resolvedUrl);
                                    const redirectKeys = [
                                      "adurl",
                                      "url",
                                      "q",
                                      "gpush",
                                      "gurl",
                                    ];
                                    let foundRedirect = "";

                                    for (const key of redirectKeys) {
                                      const val = urlObj.searchParams.get(key);
                                      if (
                                        val &&
                                        (val.startsWith("http://") ||
                                          val.startsWith("https://"))
                                      ) {
                                        foundRedirect = val;
                                        break;
                                      }
                                    }

                                    if (!foundRedirect) {
                                      const adurlRegex =
                                        /[?&](adurl|url|q)=([^&]+)/;
                                      const match =
                                        resolvedUrl.match(adurlRegex);
                                      if (match && match[2]) {
                                        const decoded = decodeURIComponent(
                                          match[2],
                                        );
                                        if (
                                          decoded.startsWith("http://") ||
                                          decoded.startsWith("https://")
                                        ) {
                                          foundRedirect = decoded;
                                        }
                                      }
                                    }

                                    if (foundRedirect) {
                                      resolvedUrl = foundRedirect.trim();
                                    }
                                  } catch (e) {
                                    const regexPatterns = [
                                      /[?&]adurl=([^&]+)/,
                                      /[?&]url=([^&]+)/,
                                      /[?&]q=([^&]+)/,
                                    ];
                                    for (const pattern of regexPatterns) {
                                      const match = resolvedUrl.match(pattern);
                                      if (match && match[1]) {
                                        try {
                                          const decoded = decodeURIComponent(
                                            match[1],
                                          );
                                          if (
                                            decoded.startsWith("http://") ||
                                            decoded.startsWith("https://")
                                          ) {
                                            resolvedUrl = decoded;
                                            break;
                                          }
                                        } catch (err) {}
                                      }
                                    }
                                  }
                                }

                                // 2. Clear out trailing bug-prone tracking/UTM parameters
                                if (resolvedUrl.startsWith("http")) {
                                  try {
                                    const targetObj = new URL(resolvedUrl);
                                    const paramsToClean = [
                                      "utm_source",
                                      "utm_medium",
                                      "utm_campaign",
                                      "gclid",
                                      "gsearch",
                                      "amp",
                                      "click_id",
                                      "affiliate",
                                      "affid",
                                      "tag",
                                    ];
                                    let altered = false;
                                    paramsToClean.forEach((p) => {
                                      if (targetObj.searchParams.has(p)) {
                                        targetObj.searchParams.delete(p);
                                        altered = true;
                                      }
                                    });
                                    if (altered) {
                                      resolvedUrl = targetObj.toString();
                                    }
                                  } catch (e) {
                                    // Ignore
                                  }
                                }
                              }

                              const platformLower = (
                                link.platform || ""
                              ).toLowerCase();

                              // Check link mismatches or if it's pointing to google.com instead of direct platform
                              const isGoogleLink =
                                resolvedUrl.includes("google.com") ||
                                resolvedUrl.includes("google.co.in");
                              let isGeneric = !resolvedUrl || isGoogleLink;

                              // Client-side placeholder/hallucinated URL shield
                              const isPlaceholderUrl =
                                resolvedUrl.includes("B0CXXYZ") ||
                                resolvedUrl.includes("12345") ||
                                resolvedUrl.includes("searchB") ||
                                resolvedUrl.includes("itm12345") ||
                                resolvedUrl.includes("example.com");

                              if (isPlaceholderUrl) {
                                isGeneric = true;
                              }

                              if (!isGeneric) {
                                try {
                                  const parsedUrl = new URL(resolvedUrl);
                                  const host = parsedUrl.hostname.toLowerCase();
                                  const path = parsedUrl.pathname.toLowerCase();

                                  // Platform domain mismatch validation
                                  let platformDomainMatch = true;
                                  if (
                                    platformLower.includes("amazon") &&
                                    !host.includes("amazon.in") &&
                                    !host.includes("amazon.com")
                                  ) {
                                    platformDomainMatch = false;
                                  } else if (
                                    platformLower.includes("flipkart") &&
                                    !host.includes("flipkart.com")
                                  ) {
                                    platformDomainMatch = false;
                                  } else if (
                                    platformLower.includes("croma") &&
                                    !host.includes("croma.com")
                                  ) {
                                    platformDomainMatch = false;
                                  } else if (
                                    platformLower.includes("reliance") &&
                                    !host.includes("reliancedigital.in") &&
                                    !host.includes("reliancedigital.com")
                                  ) {
                                    platformDomainMatch = false;
                                  } else if (
                                    platformLower.includes("myntra") &&
                                    !host.includes("myntra.com")
                                  ) {
                                    platformDomainMatch = false;
                                  } else if (
                                    platformLower.includes("ajio") &&
                                    !host.includes("ajio.com")
                                  ) {
                                    platformDomainMatch = false;
                                  }

                                  if (!platformDomainMatch) {
                                    isGeneric = true;
                                  } else {
                                    // Belong to correct platform. Define generic landing/cart/checkout pages as generic
                                    const genericPaths = [
                                      "",
                                      "/",
                                      "/index.html",
                                      "/index.php",
                                      "/login",
                                      "/signup",
                                      "/register",
                                      "/cart",
                                      "/checkout",
                                    ];
                                    if (genericPaths.includes(path)) {
                                      isGeneric = true;
                                    }
                                  }
                                } catch (e) {
                                  // Fallback: Check if pointing to naked home domain
                                  const cleanUrlStr = resolvedUrl
                                    .replace(/^(https?:\/\/)?(www\.)?/, "")
                                    .toLowerCase();
                                  const nakedDomains = [
                                    "amazon.in",
                                    "amazon.in/",
                                    "flipkart.com",
                                    "flipkart.com/",
                                    "croma.com",
                                    "croma.com/",
                                    "reliancedigital.in",
                                    "reliancedigital.in/",
                                    "myntra.com",
                                    "myntra.com/",
                                    "ajio.com",
                                    "ajio.com/",
                                  ];
                                  if (
                                    nakedDomains.includes(cleanUrlStr) ||
                                    cleanUrlStr.length < 5
                                  ) {
                                    isGeneric = true;
                                  }
                                }
                              }

                              const isOutOfStock = link.price === "Out of Stock" || String(link.stockStatus || "").toLowerCase().includes("out of stock");

                              if (isOutOfStock) {
                                resolvedUrl = "";
                                isGeneric = false; // Prevent fallback synthesis
                              } else if (isGeneric) {
                                const encodedPlusProdName = encodedProdName.replace(/%20/g, "+");
                                if (platformLower.includes("amazon")) {
                                  resolvedUrl = `https://www.amazon.in/s?k=${encodedProdName}`;
                                } else if (platformLower.includes("flipkart")) {
                                  resolvedUrl = `https://www.flipkart.com/search?q=${encodedProdName}`;
                                } else if (platformLower.includes("croma")) {
                                  resolvedUrl = `https://www.croma.com/search/?text=${encodedPlusProdName}`;
                                } else if (platformLower.includes("reliance")) {
                                  resolvedUrl = `https://www.reliancedigital.in/search?q=${encodedPlusProdName}`;
                                } else if (platformLower.includes("myntra")) {
                                  resolvedUrl = `https://www.myntra.com/search?q=${encodedPlusProdName}`;
                                } else if (platformLower.includes("ajio")) {
                                  resolvedUrl = `https://www.ajio.com/search/?text=${encodedPlusProdName}`;
                                } else if (!resolvedUrl) {
                                  resolvedUrl = `https://www.google.com/search?q=${encodedProdName}`;
                                }
                              }

                              if (
                                resolvedUrl &&
                                !resolvedUrl.startsWith("http://") &&
                                !resolvedUrl.startsWith("https://")
                              ) {
                                resolvedUrl = "https://" + resolvedUrl;
                              }

                              const isAnchor = !!resolvedUrl && !isOutOfStock;
                              const Comp = isAnchor ? "a" : "div";
                              const extraProps = isAnchor
                                ? {
                                    href: resolvedUrl,
                                    target: "_blank",
                                    rel: "noopener noreferrer",
                                    title: `Open product or search live on ${link.platform}`,
                                  }
                                : {};

                              return (
                                <Comp
                                  key={i}
                                  {...extraProps}
                                  className={cn(
                                    "flex items-center justify-between p-6 rounded-3xl border transition-all text-left w-full",
                                    isAnchor ? "group cursor-pointer" : "opacity-60 grayscale cursor-not-allowed",
                                    link.isBestDeal
                                      ? "bg-slate-950 border-slate-900 text-white"
                                      : "bg-slate-50 border-slate-100",
                                    isAnchor && !link.isBestDeal && "opacity-70 hover:opacity-100 hover:bg-slate-100/50 hover:border-slate-200",
                                    isAnchor && link.isBestDeal && "hover:bg-slate-900"
                                  )}
                                >
                                  <div className="flex items-center gap-5">
                                    <div
                                      className={cn(
                                        "w-12 h-12 rounded-full flex items-center justify-center font-black text-xs shrink-0",
                                        link.isBestDeal
                                          ? "bg-white text-slate-950"
                                          : "bg-white border border-slate-200 text-slate-400",
                                      )}
                                    >
                                      {link.platform.charAt(0)}
                                    </div>
                                    <div>
                                      <div className="flex items-center gap-2 mb-1">
                                        <span
                                          className={cn(
                                            "text-[9px] font-black uppercase tracking-widest block",
                                            link.isBestDeal
                                              ? "text-white/40"
                                              : "text-slate-400",
                                          )}
                                        >
                                          {link.platform}
                                        </span>

                                        {/* High-Integrity Stock Badge */}
                                        <span
                                          className={cn(
                                            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider border",
                                            link.isBestDeal
                                              ? String(
                                                  link.stockStatus ||
                                                    "In Stock",
                                                )
                                                  .toLowerCase()
                                                  .includes("out")
                                                ? "text-rose-300 bg-rose-950/40 border-rose-900/40"
                                                : String(
                                                      link.stockStatus ||
                                                        "In Stock",
                                                    )
                                                      .toLowerCase()
                                                      .includes("low") ||
                                                    String(
                                                      link.stockStatus ||
                                                        "In Stock",
                                                    )
                                                      .toLowerCase()
                                                      .includes("few") ||
                                                    String(
                                                      link.stockStatus ||
                                                        "In Stock",
                                                    )
                                                      .toLowerCase()
                                                      .includes("only")
                                                  ? "text-amber-300 bg-amber-950/40 border-amber-900/40"
                                                  : "text-emerald-300 bg-emerald-950/40 border-emerald-900/40"
                                              : String(
                                                    link.stockStatus ||
                                                      "In Stock",
                                                  )
                                                    .toLowerCase()
                                                    .includes("out")
                                                ? "text-rose-600 bg-rose-50 border-rose-100"
                                                : String(
                                                      link.stockStatus ||
                                                        "In Stock",
                                                    )
                                                      .toLowerCase()
                                                      .includes("low") ||
                                                    String(
                                                      link.stockStatus ||
                                                        "In Stock",
                                                    )
                                                      .toLowerCase()
                                                      .includes("few") ||
                                                    String(
                                                      link.stockStatus ||
                                                        "In Stock",
                                                    )
                                                      .toLowerCase()
                                                      .includes("only")
                                                  ? "text-amber-600 bg-amber-50 border-amber-100 animate-pulse"
                                                  : "text-emerald-600 bg-emerald-50 border-emerald-100",
                                          )}
                                        >
                                          <span
                                            className={cn(
                                              "w-1 h-1 rounded-full",
                                              String(
                                                link.stockStatus || "In Stock",
                                              )
                                                .toLowerCase()
                                                .includes("out")
                                                ? "bg-rose-500"
                                                : String(
                                                      link.stockStatus ||
                                                        "In Stock",
                                                    )
                                                      .toLowerCase()
                                                      .includes("low") ||
                                                    String(
                                                      link.stockStatus ||
                                                        "In Stock",
                                                    )
                                                      .toLowerCase()
                                                      .includes("few") ||
                                                    String(
                                                      link.stockStatus ||
                                                        "In Stock",
                                                    )
                                                      .toLowerCase()
                                                      .includes("only")
                                                  ? "bg-amber-500"
                                                  : "bg-emerald-500",
                                            )}
                                          />
                                          {link.stockStatus || "In Stock"}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                        <span
                                          className={cn(
                                            "text-sm font-black tracking-tight",
                                            link.isBestDeal
                                              ? "text-white"
                                              : "text-slate-900",
                                          )}
                                        >
                                          {isOutOfStock ? `${link.platform} (Unavailable)` : link.label}
                                        </span>
                                        {isAnchor && (
                                          <ArrowUpRight
                                            className={cn(
                                              "w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 shrink-0",
                                              link.isBestDeal
                                                ? "text-white/60"
                                                : "text-slate-400",
                                            )}
                                          />
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <span
                                      className={cn(
                                        "text-lg font-black block tracking-tighter",
                                        link.isBestDeal
                                          ? "text-white"
                                          : "text-slate-950",
                                      )}
                                    >
                                      {link.price}
                                    </span>
                                    {link.isBestDeal ? (
                                      <div className="flex flex-col items-end">
                                        <span className="text-[9px] font-black text-emerald-400 uppercase tracking-widest flex items-center gap-1 justify-end">
                                          ★ BEST VALUE
                                        </span>
                                        {isAnchor && (
                                          <span className="text-[8px] font-bold text-white/50 uppercase tracking-wider block mt-0.5 group-hover:underline">
                                            Click to open store
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      isAnchor && (
                                        <div className="flex flex-col items-end">
                                          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">
                                            Compare
                                          </span>
                                          <span className="text-[8px] font-bold text-accent uppercase tracking-wider block mt-0.5 group-hover:underline">
                                            Click to check stock
                                          </span>
                                        </div>
                                      )
                                    )}
                                  </div>
                                </Comp>
                              );
                            },
                          )}
                        </div>
                        <div className="p-6 bg-slate-50 rounded-3xl border border-slate-100 space-y-1.5">
                          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                            Shopping Tip from Vetto
                          </p>
                          <p className="text-xs font-semibold text-slate-700 leading-relaxed italic">
                            &ldquo;{result?.priceIntegrity?.discountStrategy || ""}
                            &rdquo;
                          </p>
                          <p className="text-[10px] font-medium text-slate-400 mt-1">
                            💡 Tap any store name above to check if they have
                            the item in stock and confirm today's live price
                            before buying.
                          </p>
                        </div>
                      </div>

                      {/* Price History Chart */}
                      <div className="space-y-8">
                        <div className="flex justify-between items-center px-2">
                          <span className="section-heading mb-0">
                            Price Trends (Past 6 Months)
                          </span>
                          <div className="flex items-center gap-2">
                            <Activity className="w-3 h-3 text-slate-300" />
                            <span className="text-[9px] font-mono font-bold text-slate-300 uppercase tracking-widest">
                              Past Prices
                            </span>
                          </div>
                        </div>
                        <div className="h-72 w-full bg-slate-50 rounded-[2rem] border border-slate-100 p-8 overflow-hidden relative">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart
                              data={result?.priceIntegrity?.priceHistory ?? []}
                            >
                              <defs>
                                <linearGradient
                                  id="colorPrice"
                                  x1="0"
                                  y1="0"
                                  x2="0"
                                  y2="1"
                                >
                                  <stop
                                    offset="5%"
                                    stopColor="#0F172A"
                                    stopOpacity={0.05}
                                  />
                                  <stop
                                    offset="95%"
                                    stopColor="#0F172A"
                                    stopOpacity={0}
                                  />
                                </linearGradient>
                              </defs>
                              <CartesianGrid
                                strokeDasharray="3 3"
                                vertical={false}
                                stroke="#E2E8F0"
                              />
                              <XAxis
                                dataKey="month"
                                axisLine={false}
                                tickLine={false}
                                tick={{
                                  fontSize: 9,
                                  fill: "#64748B",
                                  fontWeight: 800,
                                }}
                                dy={10}
                              />
                              <YAxis hide />
                              <Tooltip
                                content={({ active, payload }) => {
                                  if (active && payload && payload.length) {
                                    return (
                                      <div className="bg-slate-950 text-white p-4 rounded-2xl shadow-2xl border border-white/10">
                                        <span className="text-[9px] font-black uppercase tracking-widest opacity-40 block mb-1">
                                          {payload[0].payload.month}
                                        </span>
                                        <span className="text-lg font-black tracking-tighter">
                                          ₹{payload[0].value?.toLocaleString()}
                                        </span>
                                      </div>
                                    );
                                  }
                                  return null;
                                }}
                              />
                              <Area
                                type="monotone"
                                dataKey="price"
                                stroke="#0F172A"
                                strokeWidth={4}
                                fillOpacity={1}
                                fill="url(#colorPrice)"
                                animationDuration={3000}
                              />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="space-y-1.5 px-2">
                          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                            Our Honest Price Analysis
                          </p>
                          <p className="text-xs font-semibold text-slate-700 leading-relaxed italic">
                            &ldquo;{result?.priceIntegrity?.historicalContext || ""}
                            &rdquo;
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Buying Safety Check */}
                <div className="bg-white border border-slate-100 rounded-[2rem] md:rounded-[2.5rem] p-6 md:p-16 space-y-8 md:space-y-12 relative overflow-hidden group shadow-sm text-slate-900">
                  {/* Advanced Grid Background */}
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(0,113,227,0.02),transparent_50%)]" />

                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-8 relative z-10 border-b border-slate-100 pb-12">
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-2xl bg-slate-50 border border-slate-150 flex items-center justify-center">
                          <Lock className="w-5 h-5 text-slate-700" />
                        </div>
                        <div className="space-y-0.5">
                          <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400">
                            Is it Safe to Buy?
                          </h3>
                          <p className="text-2xl md:text-3xl font-black tracking-tighter text-slate-950">
                            Shopping Safety{" "}
                            <span className="text-slate-800">
                              Check
                            </span>
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">
                        Safety Score
                      </span>
                      <div className="flex items-end gap-2 justify-end">
                        <span className="text-6xl font-black text-slate-900 leading-none tracking-tighter font-display">
                          {result?.platformWarShield?.truthResilienceScore ?? 0}
                        </span>
                        <span className="text-lg font-bold text-slate-400 mb-1">
                          /100
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 relative z-10">
                    <div className="p-10 bg-slate-50/60 border border-slate-150 rounded-[2rem] flex flex-col justify-between h-full hover:bg-slate-50 transition-all group/card">
                      <div className="space-y-6">
                        <div className="flex items-center gap-4">
                          {result?.platformWarShield?.hasMarketingSilos ? (
                            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center group-hover/card:scale-110 transition-transform">
                              <EyeOff className="w-4 h-4 text-red-600" />
                            </div>
                          ) : (
                            <div className="w-10 h-10 rounded-xl bg-green-50 flex items-center justify-center group-hover/card:scale-110 transition-transform">
                              <ShieldCheck className="w-4 h-4 text-green-600" />
                            </div>
                          )}
                          <div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
                              Market Signal
                            </span>
                            <span className="text-sm font-black text-slate-900 uppercase tracking-tight">
                              {result?.platformWarShield?.hasMarketingSilos
                                ? "Ad Trap Active"
                                : "Honest Market"}
                            </span>
                          </div>
                        </div>
                        <p className="text-xs text-slate-700 leading-relaxed font-semibold transition-colors">
                          {result?.platformWarShield?.siloExposure || ""}
                        </p>
                      </div>
                    </div>

                    <div className="p-10 bg-slate-50/60 border border-slate-150 rounded-[2rem] flex flex-col justify-between h-full hover:bg-slate-50 transition-all group/card">
                      <div className="space-y-6">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center group-hover/card:scale-110 transition-transform">
                            <Network className="w-4 h-4 text-slate-700" />
                          </div>
                          <div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
                              How We Checked
                            </span>
                            <span className="text-sm font-black text-slate-900 uppercase tracking-tight">
                              Deep Truth Scan
                            </span>
                          </div>
                        </div>
                        <div className="p-4 bg-slate-100/70 rounded-2xl border border-slate-200 font-mono text-[10px] text-slate-800 leading-relaxed italic">
                          &ldquo;{result?.platformWarShield?.bypassStrategyUsed || ""}
                          &rdquo;
                        </div>
                      </div>

                      {/* Technical Nodes */}
                      <div className="pt-4 border-t border-slate-200 space-y-4">
                        {result?.technicalNode && (
                          <div className="flex items-center gap-3">
                            <Cpu className="w-3 h-3 text-slate-400" />
                            <span className="text-[9px] font-mono text-slate-600 uppercase truncate">
                              Key Feature: {result.technicalNode}
                            </span>
                          </div>
                        )}
                        {result?.resaleValueNode && (
                          <div className="flex items-center gap-3">
                            <TrendingUp className="w-3 h-3 text-slate-400" />
                            <span className="text-[9px] font-mono text-slate-600 uppercase truncate">
                              Resale value: {result.resaleValueNode}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="p-10 bg-white shadow-2xl rounded-[2rem] flex flex-col justify-between text-slate-900 relative overflow-hidden group/card hover:-translate-y-1 transition-all h-full">
                      <div className="absolute top-0 right-0 p-6 opacity-5 group-hover/card:scale-110 transition-transform duration-1000">
                        <Fingerprint className="w-24 h-24" />
                      </div>
                      <div className="space-y-6 relative z-10">
                        <h4 className="text-2xl font-black leading-[1.1] tracking-tighter">
                          Your Financial Shield.
                        </h4>
                        <p className="text-xs font-bold leading-relaxed text-slate-500">
                          Vetto cross-checks marketing claims against 1,400
                          real-world data points to keep your money safe.
                        </p>
                      </div>
                      <div className="pt-8 relative z-10">
                        <div className="h-px bg-slate-100 mb-4" />
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] font-black uppercase tracking-[0.2em]">
                            Verified Integrity
                          </span>
                          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Simple Pros & Cons */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="glass-panel p-10 space-y-8 group hover:bg-slate-50 transition-colors border-slate-100 relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-700">
                    <ThumbsUp className="w-32 h-32 text-green-500" />
                  </div>
                  <div className="flex items-center gap-4 relative z-10">
                    <div className="w-12 h-12 rounded-2xl bg-green-50 border border-green-100 flex items-center justify-center">
                      <ThumbsUp className="w-5 h-5 text-green-500" />
                    </div>
                    <div className="space-y-0.5">
                      <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                        Good News
                      </span>
                      <h3 className="text-xl font-black text-slate-900">
                        Ground Truth Wins
                      </h3>
                    </div>
                  </div>
                  <ul className="space-y-4 relative z-10">
                    {(result?.pros || []).map((pro, i) => (
                      <li
                        key={i}
                        className="flex gap-4 text-sm font-medium text-slate-600 leading-relaxed"
                      >
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 mt-2 shrink-0 shadow-[0_0_8px_rgba(74,222,128,0.5)]" />
                        {pro}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="glass-panel p-10 space-y-8 group hover:bg-slate-50 transition-colors border-slate-100 relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-700">
                    <ThumbsDown className="w-32 h-32 text-red-500" />
                  </div>
                  <div className="flex items-center gap-4 relative z-10">
                    <div className="w-12 h-12 rounded-2xl bg-red-50 border border-red-100 flex items-center justify-center">
                      <ThumbsDown className="w-5 h-5 text-red-500" />
                    </div>
                    <div className="space-y-0.5">
                      <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                        Fair Warning
                      </span>
                      <h3 className="text-xl font-black text-slate-900">
                        Potential Risks
                      </h3>
                    </div>
                  </div>
                  <ul className="space-y-4 relative z-10">
                    {(result?.cons || []).map((con, i) => (
                      <li
                        key={i}
                        className="flex gap-4 text-sm font-medium text-slate-600 leading-relaxed"
                      >
                        <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 shrink-0 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
                        {con}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Key Features Analysis */}
              <div className="space-y-10">
                <div className="flex items-center justify-between px-4">
                  <span className="section-heading mb-0 text-zinc-500">
                    Feature Quality Check
                  </span>
                  <div className="px-4 py-2 bg-slate-900 border border-slate-800 text-white rounded-full flex items-center gap-2 shadow-inner">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)] animate-pulse" />
                    <span className="text-[10px] font-mono font-bold tracking-widest text-white">
                      Checking Every Detail
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {(result?.features || []).map((feature, i) => (
                    <motion.div
                      key={i}
                      whileHover={{ y: -5, scale: 1.02 }}
                      transition={{ type: "spring", stiffness: 400, damping: 25 }}
                      className="glass-panel p-8 flex flex-col justify-between h-full border border-slate-100 hover:border-slate-200 hover:shadow-[0_20px_40px_rgba(0,0,0,0.05)] transition-all bg-white"
                    >
                      <div className="space-y-6">
                        <div className="space-y-4">
                          <div className="flex items-center gap-3">
                            <div
                              className={cn(
                                "w-10 h-10 rounded-xl flex items-center justify-center border",
                                feature.score > 80
                                  ? "bg-green-50 border-green-100"
                                  : feature.score > 50
                                    ? "bg-amber-50 border-amber-100"
                                    : "bg-red-50 border-red-100",
                              )}
                            >
                              <Zap
                                className={cn(
                                  "w-5 h-5",
                                  feature.score > 80
                                    ? "text-green-500"
                                    : feature.score > 50
                                      ? "text-amber-500"
                                      : "text-red-500",
                                )}
                              />
                            </div>
                            <span className="text-sm font-black text-slate-900 truncate tracking-wide">
                              {feature.name}
                            </span>
                          </div>
                          <p className="text-xs text-slate-600 leading-relaxed font-medium">
                            {feature.details}
                          </p>
                        </div>
                      </div>
                      <div className="pt-5 border-t border-slate-100 flex items-center justify-between mt-6">
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">
                          Quality Level
                        </span>
                        <div className="flex items-center gap-3">
                          <div className="h-1.5 w-16 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all duration-1000",
                                feature.score > 80
                                  ? "bg-emerald-500"
                                  : feature.score > 50
                                    ? "bg-amber-500"
                                    : "bg-rose-500",
                              )}
                              style={{ width: `${feature.score}%` }}
                            />
                          </div>
                          <span className="text-[11px] font-black text-slate-900 font-mono">
                            {feature.score}%
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>

              {/* Smart Swap: Better Alternatives (if any) */}
              {/* Smart Swap: Better Alternatives (if any) */}
              {/* Smart Swap: Better Alternatives (if any) */}
              {result?.vettoContrast && (
                <div className="glass-panel p-8 md:p-16 relative overflow-hidden group/swap border border-amber-500/10">
                  <div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 to-transparent opacity-50" />
                  <div className="absolute top-0 right-0 p-12 opacity-[0.03] group-hover/swap:scale-110 group-hover/swap:rotate-12 transition-all duration-1000">
                    <RefreshCw className="w-64 h-64 text-amber-500" />
                  </div>

                  <div className="flex flex-col lg:flex-row gap-16 relative z-10">
                    <div className="space-y-8 flex-1">
                      <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-amber-500 flex items-center justify-center shadow-[0_0_30px_rgba(245,158,11,0.3)]">
                          <RefreshCw className="w-6 h-6 text-white animate-spin-slow" />
                        </div>
                        <div className="space-y-1">
                          <span className="text-[10px] font-black uppercase tracking-[0.5em] text-amber-500/70">
                            Smarter Alternative
                          </span>
                          <h3 className="text-2xl md:text-3xl font-black text-white tracking-tighter font-display">
                            Comparison Arena
                          </h3>
                        </div>
                      </div>

                      <div className="space-y-6">
                        <p className="text-4xl md:text-5xl font-black text-slate-900 tracking-tighter leading-none font-display">
                          Upgrade to:{" "}
                          <span className="text-slate-900 block mt-3 drop-shadow-sm">
                            {result?.vettoContrast?.alternativeName || ""}
                          </span>
                        </p>
                        <p className="text-xl md:text-2xl font-medium text-slate-700 leading-relaxed italic border-l-4 border-slate-300 pl-8">
                          &ldquo;{result?.vettoContrast?.whyContrast || ""}&rdquo;
                        </p>
                      </div>

                      {/* Interactive Side-by-Side Scorecard */}
                      <div className="bg-white rounded-3xl border border-black/5 p-8 space-y-5 shadow-xl backdrop-blur-md">
                        <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block font-mono">
                          Side-by-Side Scorecard
                        </span>

                        <div className="grid grid-cols-3 gap-4 text-center items-center py-3 border-b border-black/5">
                          <span className="text-[10px] font-bold text-slate-400 uppercase text-left tracking-wider">
                            Metrics
                          </span>
                          <span className="text-xs font-black text-slate-600 truncate">
                            {result?.productName || ""}
                          </span>
                          <span className="text-xs font-black text-slate-900 truncate">
                            {result?.vettoContrast?.alternativeName || ""}
                          </span>
                        </div>

                        {/* Row 1: PVI */}
                        <div className="grid grid-cols-3 gap-4 items-center py-4 border-b border-black/5">
                          <span className="text-xs font-bold text-slate-500 font-mono">
                            Value Score
                          </span>
                          <span className="text-sm font-black text-rose-500 text-center">
                            {result?.paisaVasoolIndex ?? 0} / 100
                          </span>
                          <span className="text-sm font-black text-emerald-600 text-center font-mono">
                            {Math.min(
                              100,
                              (result?.paisaVasoolIndex ?? 0) +
                                (result?.vettoContrast?.pviBoost ?? 0),
                            )}{" "}
                            / 100
                          </span>
                        </div>

                        {/* Row 2: Status Penalty Tax */}
                        <div className="grid grid-cols-3 gap-4 items-center py-4 border-b border-black/5">
                          <span className="text-xs font-bold text-slate-500 font-mono">
                            Brand Surcharge
                          </span>
                          <span className="text-sm font-black text-rose-500 text-center">
                            ₹{(result?.statusTax ?? 0).toLocaleString()}
                          </span>
                          <span className="text-sm font-black text-emerald-600 text-center flex flex-col items-center">
                            <span>₹0</span>
                            <span className="text-[9px] text-green-500/60 font-sans mt-0.5">
                              (Pure Utility)
                            </span>
                          </span>
                        </div>

                        {/* Row 3: Target Price */}
                        <div className="grid grid-cols-3 gap-4 items-center py-4">
                          <span className="text-xs font-bold text-slate-500 font-mono">
                            Cost Target
                          </span>
                          <span className="text-sm font-black text-slate-400 text-center line-through decoration-rose-500/50">
                            {(() => {
                              const numPrice = getNumericPrice(result);
                              if (numPrice > 0) return `₹${numPrice.toLocaleString()}`;
                              const history = result?.priceIntegrity?.priceHistory;
                              if (Array.isArray(history) && history.length > 0) {
                                const lastPrice = history[history.length - 1]?.price;
                                if (typeof lastPrice === 'number' && lastPrice > 0) {
                                  return `₹${lastPrice.toLocaleString()}`;
                                }
                              }
                              return "Out of Stock";
                            })()}
                          </span>
                          <span className="text-sm font-black text-slate-900 text-center font-mono bg-slate-50 py-1 rounded-md border border-slate-200">
                            {result?.vettoContrast?.fairPriceTarget || ""}
                          </span>
                        </div>
                      </div>

                      {/* Direct Live Swap Button */}
                      <div className="space-y-3 pt-4">
                        <button
                          type="button"
                          onClick={() => {
                            const altName = result?.vettoContrast?.alternativeName;
                            if (altName) {
                              triggerAuditForAlternative(altName);
                            }
                          }}
                          className="w-full bg-accent hover:bg-accent-dark text-white p-6 rounded-2xl font-black uppercase text-[11px] tracking-widest flex items-center justify-center gap-3 transition-all hover:scale-[1.02] active:scale-[0.98]"
                        >
                          <RefreshCw className="w-5 h-5 animate-spin-slow text-amber-500" />
                          Compare & Check Alternate Instantly
                        </button>
                        <p className="text-[9px] font-mono text-center text-zinc-500 uppercase tracking-widest">
                          Clicking immediately re-routes Vetto to check this
                          recommended alternative.
                        </p>
                      </div>
                    </div>

                    <div className="w-full lg:w-96 shrink-0">
                      <div className="p-10 bg-white border border-black/5 rounded-[2.5rem] space-y-8 flex flex-col h-full shadow-xl relative overflow-hidden group/tip">
                        <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent opacity-0 group-hover/tip:opacity-100 transition-opacity duration-500" />
                        <div className="flex items-center gap-3 relative z-10">
                          <ShieldCheck className="w-5 h-5 text-zinc-500" />
                          <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">
                            Expert Tip
                          </span>
                        </div>
                        <p className="text-sm font-medium text-zinc-300 leading-relaxed italic relative z-10">
                          &ldquo;{result?.vettoContrast?.procurementGuidance || ""}
                          &rdquo;
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Final Plan */}
              <div className="bg-white text-slate-900 rounded-[2.5rem] p-8 md:p-16 space-y-16 overflow-hidden relative border border-black/5 shadow-2xl">
                <motion.div
                  animate={{ scale: [1, 1.2, 1], opacity: [0.03, 0.06, 0.03] }}
                  transition={{ duration: 10, repeat: Infinity }}
                  className="absolute top-0 right-0 p-12 pointer-events-none"
                >
                  <CircuitBoard className="w-96 h-96 text-slate-300" />
                </motion.div>

                <div className="relative z-10 space-y-12">
                  <div className="flex items-center gap-4">
                    <div className="px-5 py-2 bg-slate-50 border border-slate-100 rounded-full shadow-sm">
                      <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500 font-mono">
                        Our Final Advice on {result?.productName || ""}
                      </span>
                    </div>
                    <div className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse shadow-[0_0_10px_rgba(0,113,227,0.4)]" />
                  </div>

                  <h2 className="text-4xl md:text-6xl font-black leading-[1.1] tracking-tighter max-w-4xl font-display text-slate-900">
                    &ldquo;<span className="text-accent">{result?.whyBest || ""}</span>&rdquo;
                  </h2>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-12 pt-16 border-t border-slate-100">
                    {[
                      {
                        label: "When to Buy",
                        icon: Timer,
                        val: result?.strategicRoadmap?.immediateAction || "",
                      },
                      {
                        label: "How long it lasts",
                        icon: RotateCcw,
                        val: result?.strategicRoadmap?.peakUtilityAge || "",
                      },
                      {
                        label: "When to Sell",
                        icon: LogOut,
                        val: result?.strategicRoadmap?.exitStrategy || "",
                      },
                    ].map((step, i) => (
                      <div key={i} className="space-y-6 group/step bg-slate-50 p-8 rounded-3xl border border-black/5 hover:border-black/10 transition-colors">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 rounded-2xl bg-white border border-slate-200 flex items-center justify-center group-hover/step:border-accent transition-colors shadow-sm">
                            <step.icon className="w-6 h-6 text-slate-400 group-hover/step:text-accent transition-colors" />
                          </div>
                          <span className="text-xs font-bold text-slate-500 uppercase tracking-[0.2em] font-mono">
                            {step.label}
                          </span>
                        </div>
                        <p className="text-xl font-bold text-slate-800 leading-snug">
                          {step.val}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="pt-16 flex flex-col lg:flex-row gap-12 items-stretch">
                    <div className="p-10 bg-white shadow-[0_12px_32px_rgba(0,0,0,0.04)] rounded-[2.5rem] flex-1 hover:-translate-y-1 transition-transform border border-black/5 group/rec">
                      <span className="text-xs font-bold text-accent uppercase block mb-6 tracking-widest font-mono">
                        Personalized Recommendation
                      </span>
                      <p className="text-2xl font-bold leading-relaxed font-serif text-slate-800 group-hover/rec:text-slate-900 transition-colors">
                        &ldquo;{result?.personalizedInsight || ""}&rdquo;
                      </p>
                      <div className="mt-10 pt-8 border-t border-slate-100 flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest font-mono">
                          {result?.postOutputHook || ""}
                        </span>
                        <Fingerprint className="w-6 h-6 text-slate-300" />
                      </div>
                    </div>
                    <div className="lg:w-80 flex flex-col justify-center space-y-6 p-10 bg-slate-50 border border-black/5 rounded-[2.5rem]">
                      <p className="text-xl font-bold text-slate-800 leading-snug italic tracking-tight font-serif">
                        "{result?.socialHook || ""}"
                      </p>
                      <div className="h-px bg-slate-200 w-full" />
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-[0.2em] font-mono">
                        Vetto Shopping Guard
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Final Conclusion & Action Buttons */}
              <div className="space-y-8 pt-12">
                <div className="bg-white text-slate-900 rounded-[2.5rem] p-10 md:p-14 relative overflow-hidden group border border-black/5 shadow-xl">
                  <div className="absolute top-0 right-0 p-8 opacity-[0.03] group-hover:scale-110 group-hover:rotate-6 transition-transform duration-1000">
                    <ShieldCheck className="w-48 h-48 text-accent" />
                  </div>

                  <div className="relative z-10 space-y-10">
                    <div className="space-y-4">
                      <h3 className="text-3xl md:text-4xl font-black tracking-tight font-display text-slate-900">
                        Our Recommendation for{" "}
                        <span className="text-accent font-serif italic drop-shadow-sm">
                          {result?.productName || ""}
                        </span>
                      </h3>
                      <p className="text-xl md:text-2xl font-bold leading-relaxed text-slate-700">
                        &ldquo;{result?.finalDecision || ""}&rdquo;
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-4 items-center pt-4">
                      <button
                        onClick={() => {
                          try {
                            const separator =
                              "=====================================================================";
                            const innerLine =
                              "---------------------------------------------------------------------";
                            const docContent = [
                              separator,
                              "             VETTO (THE FOUNDER'S TRUTH ENGINE) - AUDIT REPORT        ",
                              `                      Date: ${new Date().toLocaleDateString()}                     `,
                              separator,
                              "",
                              ` PRODUCT NAME : ${result?.productName || ""}`,
                              ` VERDICT      : ${result?.marketTiming || ""}`,
                              ` PAISA VASOOL : ${result?.paisaVasoolIndex ?? 0}/100`,
                              ` DECISION     : ${result?.finalDecision || ""}`,
                              "",
                              separator,
                              "                          AAM AADMI VERDICT                          ",
                              separator,
                              result?.aamAadmiSummary || "",
                              "",
                              separator,
                              "                           PRICE INTEGRITY                           ",
                              separator,
                              ` Deal Score : ${result?.priceIntegrity?.dealScore ?? 0}/100`,
                              ` Rating     : ${result?.priceIntegrity?.currentPriceAudit || "N/A"}`,
                              ` History    : ${result?.priceIntegrity?.historicalContext || "N/A"}`,
                              ` Strategy   : ${result?.priceIntegrity?.discountStrategy || "N/A"}`,
                              "",
                              innerLine,
                              "Procurement Rates Detected:",
                              ...(
                                result?.priceIntegrity?.procurementLinks || []
                              ).map(
                                (link: any) =>
                                  ` - ${link?.platform || ""} (${link?.label || ""}): ${link?.price || ""} ${link?.isBestDeal ? "[BEST DEAL]" : ""}`,
                              ),
                              "",
                              separator,
                              "                         SMARTER SWAP RECOMMEND                         ",
                              separator,
                              ` Suggested Upgrade : ${result?.vettoContrast?.alternativeName || "None"}`,
                              ` Upgrade Delta     : ${result?.vettoContrast?.priceDelta || "N/A"}`,
                              ` Target Fair Price : ${result?.vettoContrast?.fairPriceTarget || "N/A"}`,
                              ` Advantage         : ${result?.vettoContrast?.strategicAdvantage || "N/A"}`,
                              ` Guidance          : ${result?.vettoContrast?.procurementGuidance || "N/A"}`,
                              "",
                              separator,
                              "                          STRATEGIC ROADMAP                          ",
                              separator,
                              ` Action Window     : ${result?.strategicRoadmap?.immediateAction || "N/A"}`,
                              ` Life Expectancy   : ${result?.strategicRoadmap?.peakUtilityAge || "N/A"}`,
                              ` Exit Strategy     : ${result?.strategicRoadmap?.exitStrategy || "N/A"}`,
                              "",
                              separator,
                              "                         PERSONALIZED INSIGHT                        ",
                              separator,
                              result?.personalizedInsight || "N/A",
                              "",
                              separator,
                              "           Generated via Vetto (The Founder's Truth Engine)          ",
                              "               Empowering Honest Buying Choices                    ",
                              separator,
                            ].join("\n");

                            const blob = new Blob([docContent], {
                              type: "text/plain;charset=utf-8",
                            });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${(result?.productName || "product").toLowerCase().replace(/[^a-z0-9]+/g, "_")}_vetto_truth_report.txt`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            showToast(
                              "Report download initiated successfully!",
                              "success",
                            );
                          } catch (err) {
                            console.error(
                              "Failed to generate download report file",
                              err,
                            );
                            window.print();
                          }
                        }}
                        className="px-6 py-3 bg-blue-600 text-white rounded-xl font-black uppercase tracking-widest text-[9px] hover:bg-blue-700 hover:scale-105 transition-all flex items-center gap-2"
                      >
                        <Download className="w-3.5 h-3.5" /> Download Report
                      </button>
                      <button
                        onClick={async () => {
                          const text = `🔍 Vetto Truth Audit: ${result?.productName || ""}\n\n🏆 Verdict: ${result?.marketTiming || ""}\n💰 Paisa Vasool Index: ${result?.paisaVasoolIndex ?? 0}/100\n\n"${result?.aamAadmiSummary || ""}"\n\nSee full honest audit at: ${window.location.href}`;

                          if (navigator.share) {
                            try {
                              await navigator.share({
                                title: `Vetto Audit: ${result.productName}`,
                                text: text,
                                url: window.location.href,
                              });
                            } catch (err: any) {
                              if (err.name !== "AbortError") {
                                const copied = await copyToClipboard(text);
                                if (copied)
                                  showToast(
                                    "Audit verdict & link copied to clipboard!",
                                    "success",
                                  );
                              }
                            }
                          } else {
                            const copied = await copyToClipboard(text);
                            if (copied)
                              showToast(
                                "Audit verdict & link copied to clipboard!",
                                "success",
                              );
                          }
                        }}
                        className="px-6 py-3 bg-white/10 text-white rounded-xl font-black uppercase tracking-widest text-[9px] hover:bg-white/20 hover:scale-105 transition-all flex items-center gap-2"
                      >
                        <Share2 className="w-3.5 h-3.5" /> Share Truth
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-6 justify-center sm:justify-start">
                  <button
                    onClick={() => {
                      setResult(null);
                      setQuery("");
                    }}
                    className="px-10 py-5 glass-panel text-slate-950 font-black rounded-2xl hover:scale-105 transition-all text-[11px] uppercase tracking-widest flex items-center gap-3"
                  >
                    <CircleDashed className="w-4 h-4 animate-spin-slow" /> Reset
                    Loop
                  </button>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="h-full min-h-[500px] md:min-h-[700px] flex flex-col items-center justify-center text-center p-8 md:p-24 relative overflow-hidden"
            >
              {/* Background ambient lighting */}
              <div className="ambient-glow" />
              
              <div className="relative mb-20">
                <motion.div 
                  whileHover={{ scale: 1.05 }}
                  transition={{ type: "spring", stiffness: 300, damping: 20 }}
                  className="w-48 h-48 rounded-full glass-panel flex items-center justify-center relative overflow-hidden group shadow-2xl"
                >
                  <div className="absolute inset-0 bg-accent/5 opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
                  <div className="absolute -inset-1 bg-accent/10 blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
                  <Cpu className="w-20 h-20 text-accent/30 group-hover:text-accent transition-all duration-1000 rotate-12 group-hover:rotate-0 drop-shadow-[0_0_15px_rgba(229,193,88,0.3)]" />
                </motion.div>
                <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 px-6 py-2 glass-panel rounded-full border border-accent/20 backdrop-blur-xl">
                  <span className="font-mono text-[9px] uppercase tracking-[0.5em] text-accent font-black">
                    Vetto Engine Live
                  </span>
                </div>
              </div>

              <motion.h3 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1, duration: 0.8 }}
                className="text-white font-display font-black text-5xl sm:text-7xl lg:text-[5.5rem] mb-10 leading-[1.05] tracking-tighter max-w-4xl px-4 md:px-0 drop-shadow-sm"
              >
                Filter the noise. <br />
                <span className="text-gradient">Find Real Value.</span>
              </motion.h3>

              <motion.p 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.8 }}
                className="max-w-2xl text-xl sm:text-3xl font-serif italic text-zinc-400 leading-relaxed mb-16 md:mb-24 px-4 md:px-0 font-medium"
              >
                Bypass modern marketing traps. We translate complex specs into
                the singular truth of savings.
              </motion.p>

              <motion.div 
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.8 }}
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 w-full max-w-6xl pb-16 relative z-10"
              >
                {[
                  {
                    icon: Cpu,
                    title: "Consumer Electronics",
                    tag: "Performance Check",
                    desc: "Bypassing marketing hype. We check processing power, storage longevity, and software update dates.",
                  },
                  {
                    icon: Car,
                    title: "Automotive Tech",
                    tag: "Reliability Focus",
                    desc: "Moving beyond safety ratings. Our system scans mechanical reliability and calculates the 5-year resale value.",
                  },
                  {
                    icon: ShoppingBag,
                    title: "Apparel & Lifestyle",
                    tag: "Quality Check",
                    desc: "Fabric verification and durability analysis. We distinguish between fast fashion traps and quality items.",
                  },
                  {
                    icon: ShieldCheck,
                    title: "Financial Integrity",
                    tag: "Savings Advisor",
                    desc: "Unmasking the hidden 'Status Taxes' and 'Marketing Traps' that erode household savings.",
                  },
                ].map((node, i) => (
                  <motion.div
                    key={node.title}
                    whileHover={{ y: -8, scale: 1.02 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className="p-8 glass-card transition-all group hover:bg-slate-50/60 relative overflow-hidden text-left bg-white border-black/5 shadow-md hover:shadow-xl flex flex-col justify-between min-h-[280px]"
                  >
                    <node.icon className="absolute -right-8 -bottom-8 w-40 h-40 text-white/5 group-hover:text-accent/10 transition-all duration-700 group-hover:scale-110 group-hover:rotate-6" />
                    <div className="relative z-10 space-y-6">
                      <div className="flex items-center justify-between">
                        <node.icon className="w-6 h-6 text-accent/60 group-hover:text-accent transition-colors" />
                        <span className="font-mono text-[8px] font-black uppercase tracking-[0.4em] border border-white/10 rounded-full px-3 py-1 text-zinc-500 group-hover:text-accent group-hover:border-accent/30 transition-colors backdrop-blur-sm">
                          {node.tag}
                        </span>
                      </div>
                      <div>
                        <h4 className="text-sm font-black text-white mb-3 uppercase tracking-widest leading-tight">
                          {node.title}
                        </h4>
                        <p className="text-xs font-medium text-zinc-400 leading-relaxed group-hover:text-zinc-300 transition-colors">
                          {node.desc}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </motion.div>

              <div className="w-full max-w-lg pt-16 border-t border-white/5 grid grid-cols-2 gap-8 opacity-80">
                <div className="text-left space-y-3">
                  <div className="font-mono text-[9px] text-accent tracking-[0.4em] uppercase font-black flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                    Status
                  </div>
                  <div className="font-mono text-[11px] text-zinc-300 font-medium">
                    99.9% Logic Stability
                  </div>
                </div>
                <div className="text-right space-y-3">
                  <div className="font-mono text-[9px] text-accent tracking-[0.4em] uppercase font-black">
                    Community
                  </div>
                  <div className="font-mono text-[11px] text-zinc-300 font-medium">
                    1,400+ Data Points
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <footer className="bg-white border-t border-black/5 py-32 mt-32 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent opacity-30" />
          <div className="ambient-glow opacity-30 right-0 top-0 translate-x-1/2 -translate-y-1/2" />
          
          <div className="max-w-7xl mx-auto px-8 relative z-10">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-16 lg:gap-24 items-center">
              <div className="space-y-12">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-white/10 flex items-center justify-center p-2.5 shadow-[inset_0_2px_10px_rgba(255,255,255,0.05)]">
                    <ShieldCheck className="w-full h-full text-accent" />
                  </div>
                  <h2 className="text-3xl font-black text-white uppercase tracking-tighter">
                    Vetto
                  </h2>
                </div>
                <div className="space-y-6">
                  <h3 className="text-4xl md:text-5xl lg:text-6xl font-black text-white leading-[1.05] tracking-tighter font-display">
                    Stop overpaying for{" "}
                    <span className="text-gradient">marketing hype.</span>
                  </h3>
                  <p className="text-lg md:text-xl text-zinc-400 font-medium max-w-lg leading-relaxed font-serif italic">
                    Every day, we are pushed to buy overpriced, low-quality
                    products backed by sponsored reviews. Vetto helps you bypass
                    the marketing premium to protect your hard-earned savings.
                  </p>
                </div>
              </div>

              <div className="flex flex-col md:items-end gap-12">
                <div className="grid grid-cols-2 gap-6 w-full md:w-auto">
                  <div className="p-8 bg-zinc-900/40 rounded-[2rem] text-center border border-white/5 space-y-3 backdrop-blur-sm hover:bg-zinc-900/60 transition-colors">
                    <div className="text-5xl font-black text-white font-display">0%</div>
                    <div className="text-[10px] font-black text-accent uppercase tracking-[0.4em]">
                      Affiliate Bias
                    </div>
                  </div>
                  <div className="p-8 bg-zinc-900/40 rounded-[2rem] text-center border border-white/5 space-y-3 backdrop-blur-sm hover:bg-zinc-900/60 transition-colors">
                    <div className="text-5xl font-black text-white font-display">
                      100%
                    </div>
                    <div className="text-[10px] font-black text-accent uppercase tracking-[0.4em]">
                      Real Truth
                    </div>
                  </div>
                </div>

                <div className="space-y-4 text-center md:text-right pt-8 border-t border-white/5 md:border-none md:pt-0 w-full md:w-auto">
                  <p className="text-[11px] font-black text-zinc-300 uppercase tracking-[0.5em]">
                    Designed for 1.4 Billion Indians
                  </p>
                  <p className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest leading-none">
                    © 2026 Vetto • Built to Protect.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </footer>
      </div>
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className={cn(
              "fixed bottom-8 right-8 z-[200] max-w-sm w-full p-4 rounded-3xl shadow-2xl flex items-center gap-3 border backdrop-blur-md bg-slate-900/95 text-white border-slate-800",
            )}
          >
            <div className="shrink-0 w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-accent">
              {toast.type === "error" ? (
                <ShieldAlert className="w-4 h-4 text-red-500" />
              ) : toast.type === "info" ? (
                <HelpCircle className="w-4 h-4 animate-pulse text-blue-400" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-green-400 animate-bounce" />
              )}
            </div>
            <div className="flex-1 text-xs font-semibold leading-normal">
              {toast.message}
            </div>
            <button
              onClick={() => setToast(null)}
              className="text-white/60 hover:text-white p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
