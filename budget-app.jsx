import { useState, useEffect, useRef } from "react";
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend } from "recharts";
import "bootstrap-icons/font/bootstrap-icons.css";

// ─── Supabase Config ──────────────────────────────────────────────────────────
// Fill in your project values from: Supabase Dashboard → Project Settings → API
const SUPABASE_URL      = "https://svaozzitkajgqzacldur.supabase.co"; // ← replace
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2YW96eml0a2FqZ3F6YWNsZHVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgyMDY1NDMsImV4cCI6MjA3Mzc4MjU0M30.zn50Iw8ib-wTt2Z0gQuKnJbDSe8qr-H-tRvkW2THiKQ";                  // ← replace

// ─── Minimal Supabase Client (no npm install required) ───────────────────────
// Implements auth + PostgREST queries using only fetch() and localStorage.
function createSupabaseClient(projectUrl, apiKey) {
  const AUTH_URL   = `${projectUrl}/auth/v1`;
  const DB_URL     = `${projectUrl}/rest/v1`;
  const STORE_KEY  = "sb-auth-token";
  let   _session   = null;
  const _listeners = [];

  function _readSession() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
  }
  function _writeSession(s) {
    _session = s;
    if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
    else   localStorage.removeItem(STORE_KEY);
    _listeners.forEach(fn => fn(s ? "SIGNED_IN" : "SIGNED_OUT", s));
  }
  function _token() {
    const s = _session || _readSession();
    return s?.access_token || apiKey;
  }
  function _hdrs(extra = {}) {
    return { "Content-Type":"application/json", "apikey":apiKey, "Authorization":`Bearer ${_token()}`, ...extra };
  }
  async function _authPost(path, body, tok) {
    const res = await fetch(`${AUTH_URL}${path}`, {
      method:"POST",
      headers:{ "Content-Type":"application/json","apikey":apiKey,...(tok?{Authorization:`Bearer ${tok}`}:{}) },
      body:JSON.stringify(body),
    });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) return { data:null, error:{ message: d.error_description||d.msg||d.error||"Auth error" } };
    return { data:d, error:null };
  }
  async function _refreshSession() {
    const s = _readSession();
    if (!s?.refresh_token) return null;
    const { data, error } = await _authPost("/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
    if (error || !data?.access_token) { _writeSession(null); return null; }
    const ns = { access_token:data.access_token, refresh_token:data.refresh_token||s.refresh_token,
                 expires_at:Math.floor(Date.now()/1000)+(data.expires_in||3600), user:data.user||s.user };
    _writeSession(ns); return ns;
  }

  // ── PostgREST query builder ──
  function from(table) {
    const st = { method:"GET", body:null, filters:[], cols:"*", orderBy:null, justOne:false, upsert:false };
    function _run() {
      const isRead  = st.method === "GET";
      const parts   = isRead ? [`select=${st.cols}`, ...st.filters] : [...st.filters];
      if (isRead && st.orderBy) parts.push(`order=${st.orderBy}`);
      const qs      = parts.length ? "?" + parts.join("&") : "";
      const headers = _hdrs();
      if (st.justOne) headers["Range"] = "0-0";
      if (st.method === "POST") headers["Prefer"] = st.upsert
        ? "return=minimal,resolution=merge-duplicates"
        : "return=minimal";
      else if (st.method !== "GET") headers["Prefer"] = "return=minimal";
      return fetch(`${DB_URL}/${table}${qs}`, {
        method:st.method, headers, body:st.body ? JSON.stringify(st.body) : undefined,
      }).then(async res => {
        if (!res.ok) { const m = await res.text().catch(()=>""); return { data:null, error:{ message:m, status:res.status } }; }
        if (st.method !== "GET") return { data:null, error:null };
        const rows = await res.json();
        return { data: st.justOne ? (rows[0] ?? null) : rows, error:null };
      }).catch(err => ({ data:null, error:{ message:String(err) } }));
    }
    const b = {
      then(res,rej)    { return _run().then(res,rej); },
      catch(rej)       { return _run().catch(rej); },
      select(cols)     { st.cols=cols; return b; },
      eq(col,val)      { st.filters.push(`${col}=eq.${encodeURIComponent(String(val))}`); return b; },
      order(col,o={})  { st.orderBy=`${col}.${o.ascending===false?"desc":"asc"}`; return b; },
      maybeSingle()    { st.justOne=true; return b; },
      insert(rows)     { st.method="POST"; st.body=Array.isArray(rows)?rows:[rows]; return b; },
      upsert(rows)     { st.method="POST"; st.body=Array.isArray(rows)?rows:[rows]; st.upsert=true; return b; },
      update(changes)  { st.method="PATCH"; st.body=changes; return b; },
      delete()         { st.method="DELETE"; return b; },
    };
    return b;
  }

  // ── Auth ──
  const auth = {
    async getSession() {
      if (!_session) _session = _readSession();
      if (_session?.expires_at && Date.now()/1000 > _session.expires_at - 60) {
        const refreshed = await _refreshSession();
        return { data:{ session:refreshed }, error:null };
      }
      return { data:{ session:_session }, error:null };
    },
    onAuthStateChange(cb) {
      _listeners.push(cb);
      const s = _session || _readSession(); _session = s;
      setTimeout(()=>cb("INITIAL_SESSION", s), 0);
      return { data:{ subscription:{ unsubscribe() { const i=_listeners.indexOf(cb); if(i>=0)_listeners.splice(i,1); } } } };
    },
    async signInWithPassword({ email, password }) {
      const { data, error } = await _authPost("/token?grant_type=password", { email, password });
      if (error) return { data:null, error };
      const s = { access_token:data.access_token, refresh_token:data.refresh_token,
                  expires_at:Math.floor(Date.now()/1000)+(data.expires_in||3600), user:data.user };
      _writeSession(s);
      return { data:{ session:s, user:data.user }, error:null };
    },
    async signUp({ email, password }) {
      const { data, error } = await _authPost("/signup", { email, password });
      if (error) return { data:null, error };
      if (data.access_token) {
        const s = { access_token:data.access_token, refresh_token:data.refresh_token,
                    expires_at:Math.floor(Date.now()/1000)+(data.expires_in||3600), user:data.user };
        _writeSession(s);
      }
      return { data, error:null };
    },
    async signInWithOtp({ email }) {
      const { data, error } = await _authPost("/otp", { email });
      return { data:error?null:data, error };
    },
    async signOut() {
      const tok = _session?.access_token;
      _writeSession(null);
      if (tok) await _authPost("/logout", {}, tok).catch(()=>{});
      return { error:null };
    },
  };

  _session = _readSession();
  return { auth, from };
}

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Categories ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: "groceries",      label: "Groceries",      icon: "cart3",                color: "#065f46" },
  { id: "restaurant",     label: "Restaurant",     icon: "cup-hot",              color: "#0f766e" },
  { id: "housing",        label: "Housing",        icon: "house-door",           color: "#92400e" },
  { id: "transportation", label: "Transportation", icon: "truck",                color: "#1e40af" },
  { id: "utilities",      label: "Utilities",      icon: "lightning-charge",     color: "#6b21a8" },
  { id: "health",         label: "Health",         icon: "heart-pulse",          color: "#be123c" },
  { id: "entertainment",  label: "Entertainment",  icon: "controller",           color: "#b45309" },
  { id: "savings",        label: "Savings",        icon: "piggy-bank",           color: "#134e4a" },
  { id: "retail",         label: "Retail",         icon: "bag",                  color: "#7c3aed" },
  { id: "giving",         label: "Giving",         icon: "gift",                 color: "#0369a1" },
  { id: "clothing",       label: "Clothing",       icon: "scissors",             color: "#9333ea" },
  { id: "subscriptions",  label: "Subscriptions",  icon: "phone",                color: "#0e7490" },
  { id: "sports",         label: "Sports",         icon: "trophy",               color: "#16a34a" },
  { id: "education",      label: "Education",      icon: "book",                 color: "#ca8a04" },
  { id: "toiletries",     label: "Toiletries",     icon: "droplet",              color: "#c026d3" },
  { id: "insurance",      label: "Insurance",      icon: "shield-check",         color: "#475569" },
  { id: "taxes",          label: "Taxes",          icon: "building",             color: "#64748b" },
  { id: "transfers",      label: "Transfers",      icon: "arrow-left-right",     color: "#0f766e" },
  { id: "banking",        label: "Banking",        icon: "bank",                 color: "#475569" },
  { id: "vacation",       label: "Vacation",       icon: "suitcase2",            color: "#f59e0b" },
  { id: "income",         label: "Income",         icon: "cash-stack",           color: "#166534" },
  { id: "other",          label: "Other",          icon: "three-dots",           color: "#4b5563" },
];

const REIMBURSABLE_CATEGORY = { id: "reimbursable", label: "Reimbursed", icon: "arrow-counterclockwise", color: "#0f766e" };
if (!CATEGORIES.some(c => c.id === REIMBURSABLE_CATEGORY.id)) {
  const incomeIndex = CATEGORIES.findIndex(c => c.id === "income");
  CATEGORIES.splice(incomeIndex >= 0 ? incomeIndex : CATEGORIES.length, 0, REIMBURSABLE_CATEGORY);
}

const EXPENSE_CATS = CATEGORIES.filter(c => c.id !== "income");
const MONTHLY_BUDGET_CATS = EXPENSE_CATS.filter(c => !["taxes","transfers","banking","reimbursable"].includes(c.id));

// ─── Keywords — built from your real TransactionMap ──────────────────────────
const DEFAULT_KEYWORDS = {
  groceries:      ["aldi","c fresh market","fareway","sams club.com","samsclub","samsclub #6979","samsclub.com","wal-mart","wheatsfield"],
  restaurant:     ["agave azteca","americana","amigo mexican","b-bops","bandit burrito","big head burger","buffalo phil","burger shed","cancun grill","charleys philly","charter patagon","chick-fil-a","chocolaterie stam","coldstone","cornbred barbecue","culvers","culvers n ankeny","daylight donuts","district 36","doordash","dumpling","dumpling empire","gdp*the creamery","gdp*uptown dairy","gracies","h mart","hidalgo mexican","hy-vee","hy-vee johnston","i love pad thai","iowa taproom","j's smokehouse","jethro","jimmy johns","laking","mai pho","main street cafe","misfit island cafe","olive garden","orchard","pad thai","panera","panera bread","parkway pizza","pizza ranch","qdoba","raisin canes","raising canes","red chillez","sam\u2019s","siam table","slim chickens","smokey d","smokey row","sonic","star drug store","starbucks","the cellar","the creamery","ubereats","uep*hokkaido ramen","victoria kebab","wendy","yagas","yagas cafe"],
  housing:        ["ankeny hardware","fleet farm","home depot","homedepot.com","in *the shredder","lowes","rasmussen lawn care","roof iowa","rsm lawn","swimming pool supply","tru green","us bank home mtg"],
  transportation: ["airport parking","caseys","dsm parking","dsm parking tiba","enterprise","keck parking","kum&go","kwik star","kwik trip","napa store","parkwhiz","qt","shade tree auto","vioc"],
  utilities:      ["ankeny sanitation","cinergy metronet","metro fibernet","metronet","midamerican","sanitation","verizon","verizon wireless"],
  health:         ["ames chiropractic","balanced health","capital orthopaedics","central iowa orthodont","designed 2 move","doc* iowa derm","doc*iowa derm","focus family eye","iowa ent center","iowa radiology","unitypoint","uph dm ank pharm","walgreens","ww","ww int'l"],
  entertainment:  ["adventureland park","backpocket","cinemark","city of ankeny","civic center","des moines perf. arts","iowa events center","ls dungeons gate","mnhuntfish","old school pinball","valve","wells fargo arena"],
  savings:        ["uncommon wealth","retirement fund","isave 529","transfer to savings","electronic deposit lpl","electronic deposit qube"],
  retail:         ["abebooks","affordable company","amazon mktpl","amazon.com","beeline","bookemon","dollar tree","dollartree","dunhams","etsy","hobby lobby","hobbylobby","ls bel pri jewelry","ls bike country","michael\u2019s","michaels","orca","store","target","tozo","ua fh des moines","walmart","walmart.com","wintersong","wm superc","wm supercenter"],
  giving:         ["compass","compassion","go fund me","gofndme","keystone church","teamup"],
  clothing:       ["kohl's","kohls","mercari","nike","nike.com","scheels","shein","the childrens place","thechildrensplace","tj maxx"],
  subscriptions:  ["adobe","amazon","apple services","chatgpt","cleverbridge","hp *instant ink","hp instant ink","microsoft","openai *chatgpt","panera sip club","qustodio","spotify","warner media direct"],
  sports:         ["ankeny jaguars","ankenyjrfootball","drive with cops","iowa rush soccer"],
  education:      ["bb tuition mgmt","do cpr","grand view christian","grandview christian","gvcsa","jfi* iowa rush","official sports","smjexq-ussf lc","ussf learning","ymca"],
  toiletries:     [],
  insurance:      ["penn mutual life","usaa p&c"],
  taxes:          ["irs","polk county trea"],
  transfers:      ["electronic withdrawal","electronic deposit","mobile banking transfer","internet/mobile banking transfer","web authorized pmt","customer withdrawal","venmo","paypal","check"],
  banking:        ["monthly maintenance fee","reversed sales tax","sales tax"],
  reimbursable:   ["reimbursable","reimbursement","reimbursed","paid for someone"],
  vacation:       ["breckenridge sport","buc-ee's","butchart gardens","city-market","eg*trvl","fishingbooker","glacier canyon","glacier canyon ecomm","grand superior","hilton","lake ann","maritime communication","online passport fees","park hyatt","projectexpedition","reatatravelstop","royal caribbean","saylorville","shore excursions","skagway mercantile","snow.com","uber","uber trip","yukon suspension","zelle instant"],
  income:         ["electronic deposit adp totalsource","electronic deposit raker rhodes","interest paid this period"],
  other:          ["jostens","dylan industries"],
};

// ─── Vendor splits — Walmart/Target/Amazon span multiple categories ───────────
const VENDOR_SPLITS = {
  walmart: { groceries:0.35, toiletries:0.40, housing:0.10, retail:0.05, clothing:0.05, giving:0.05 },
  target:  { groceries:0.35, toiletries:0.40, housing:0.10, retail:0.05, clothing:0.05, giving:0.05 },
  amazon:  { retail:0.40, housing:0.25, clothing:0.10, health:0.10, toiletries:0.10, giving:0.05 },
};

function isSplitVendor(description) {
  const desc = (description || "").toLowerCase();
  for (const v of Object.keys(VENDOR_SPLITS)) {
    if (desc.includes(v)) return v;
  }
  return null;
}

const BUDGET_CAT_MAP = {
  groceries:"groceries","food & dining":"groceries",food:"groceries",grocery:"groceries",
  restaurant:"restaurant",restaurants:"restaurant",dining:"restaurant",
  entertainment:"entertainment",retail:"retail",shopping:"retail",
  housing:"housing",rent:"housing",mortgage:"housing",
  transport:"transportation",transportation:"transportation",gas:"transportation",auto:"transportation",
  health:"health",medical:"health",healthcare:"health",pharmacy:"health",
  utilities:"utilities",utility:"utilities",savings:"savings",
  giving:"giving",charitable:"giving",clothing:"clothing",
  subscriptions:"subscriptions",subscription:"subscriptions",
  sports:"sports",education:"education",toiletries:"toiletries",
  insurance:"insurance",taxes:"taxes",vacation:"vacation",income:"income",
  transfer:"transfers",transfers:"transfers",
  banking:"banking",bank:"banking",
  reimbursable:"reimbursable",reimbursement:"reimbursable",reimbursed:"reimbursable",
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const now = new Date();

// ─── Default budgets ──────────────────────────────────────────────────────────
const defaultBudgets = {
  groceries:375, restaurant:50, housing:940, transportation:300,
  utilities:480, health:250, entertainment:20, savings:2250,
  retail:380, giving:1210, clothing:60, subscriptions:69,
  sports:270, education:81, toiletries:145, insurance:91,
  taxes:30, vacation:104, other:100,
};

const SUB_BUDGET_TEMPLATES = {
  giving: [
    { id:"tithing", label:"Tithing" },
    { id:"gifts",   label:"Gifts" },
  ],
};

function makeDefaultSubBudgets() {
  return Object.fromEntries(
    Object.entries(SUB_BUDGET_TEMPLATES).map(([catId, items]) => [
      catId,
      items.map(item => ({ ...item, amount:0, envelopeOn:false })),
    ])
  );
}

const DEFAULT_SUB_BUDGETS = makeDefaultSubBudgets();

function normalizeSubBudgets(subBudgets) {
  const normalized = makeDefaultSubBudgets();
  if (!subBudgets || typeof subBudgets !== "object") return normalized;
  Object.entries(subBudgets).forEach(([catId, source]) => {
    if (!Array.isArray(source)) {
      // Backward compatibility: old shape was { giving: { tithing: 10, gifts: 20 } }
      if (source && typeof source === "object" && normalized[catId]) {
        normalized[catId] = normalized[catId].map(item => {
          const raw = Number(source[item.id]);
          return { ...item, amount:Number.isFinite(raw) && raw >= 0 ? raw : 0 };
        });
      }
      return;
    }
    normalized[catId] = source
      .map(item => {
        if (!item || typeof item !== "object") return null;
        const id = String(item.id || "").trim();
        const label = String(item.label || "").trim();
        if (!id || !label) return null;
        const amount = Number(item.amount);
        return {
          id,
          label,
          amount: Number.isFinite(amount) && amount >= 0 ? amount : 0,
          envelopeOn: Boolean(item.envelopeOn),
        };
      })
      .filter(Boolean);
  });
  return normalized;
}

const DEFAULT_ENVELOPE_CATEGORY_IDS = MONTHLY_BUDGET_CATS.map(c => c.id);

function normalizeEnvelopeCategoryIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return DEFAULT_ENVELOPE_CATEGORY_IDS;
  const validIds = new Set(DEFAULT_ENVELOPE_CATEGORY_IDS);
  const normalized = ids.filter(id => validIds.has(id));
  return normalized.length > 0 ? normalized : DEFAULT_ENVELOPE_CATEGORY_IDS;
}

// ─── Kids Ledger ─────────────────────────────────────────────────────────────
const DEFAULT_CHORES = [
  { id:"ch1",  name:"Bathroom Floor",         rate:1.00 },
  { id:"ch2",  name:"Bathroom Sink",          rate:0.50 },
  { id:"ch3",  name:"Bathroom Mirror",        rate:0.50 },
  { id:"ch4",  name:"Bathroom Bathtub",       rate:1.00 },
  { id:"ch5",  name:"Bathroom Toilet",        rate:1.00 },
  { id:"ch6",  name:"Laundry",                rate:2.00 },
  { id:"ch7",  name:"Mowing",                 rate:10.00 },
  { id:"ch8",  name:"Weed Eating",            rate:5.00 },
];

const LEGACY_DEFAULT_CHORE_NAMES = [
  "Dishes",
  "Vacuuming",
  "Laundry (fold)",
  "Trash",
  "Bathroom",
  "Yard work",
  "General tidying",
];

function makeDefaultChores() {
  return DEFAULT_CHORES.map(c=>({...c,completed:false,completedCount:0}));
}

function isLegacyDefaultChoreSet(chores) {
  if (!Array.isArray(chores) || chores.length !== LEGACY_DEFAULT_CHORE_NAMES.length) return false;
  return LEGACY_DEFAULT_CHORE_NAMES.every((name, idx) => chores[idx]?.name === name);
}

function normalizeChores(chores) {
  if (!Array.isArray(chores) || chores.length === 0) return makeDefaultChores();
  if (isLegacyDefaultChoreSet(chores)) return makeDefaultChores();
  return chores.map(chore => {
    const completedCount = typeof chore.completedCount === "number"
      ? Math.max(0, Math.floor(chore.completedCount))
      : chore.completed ? 1 : 0;
    return {
      ...chore,
      completedCount,
      completed: completedCount > 0,
    };
  });
}

function normalizeKidsData(kids) {
  if (!Array.isArray(kids) || kids.length === 0) return DEFAULT_KIDS;
  return kids.map(kid => ({
    ...kid,
    chores: normalizeChores(kid.chores),
  }));
}

const DEFAULT_KIDS = [
  {
    id:"jaden", name:"Jaden", icon:"person-fill", color:"#1e40af",
    balances:{ wallet:0, savings:0, christmas:0, tithe:0 },
    chores: makeDefaultChores(),
    history:[],
  },
  {
    id:"kyden", name:"Kyden", icon:"person-fill", color:"#065f46",
    balances:{ wallet:0, savings:0, christmas:0, tithe:0 },
    chores: makeDefaultChores(),
    history:[],
  },
  {
    id:"elsie", name:"Elsie", icon:"person-fill", color:"#9333ea",
    balances:{ wallet:0, savings:0, christmas:0, tithe:0 },
    chores: makeDefaultChores(),
    history:[],
  },
];

// ─── Tax Tasker default items ─────────────────────────────────────────────────
const TAX_GROUPS = ["Income Documents","Deductions & Expenses","Investments & Assets","Other"];

const DEFAULT_TAX_ITEMS = [
  { id:"tx1",  group:"Income Documents",      title:"W-2 — Chris (JTSI)",                       description:"Wage & Tax Statement · arrives by mail",                                    status:"pending", notes:"", source:"Mail",    custom:false },
  { id:"tx2",  group:"Income Documents",      title:"W-2 — Annie (Raker Rhodes Engineering)",   description:"Wage & Tax Statement · arrives by mail",                                    status:"pending", notes:"", source:"Mail",    custom:false },
  { id:"tx3",  group:"Deductions & Expenses", title:"1098 Mortgage Interest (US Bank)",          description:"Log in to US Bank to download",                                             status:"pending", notes:"", source:"Online",  custom:false },
  { id:"tx4",  group:"Deductions & Expenses", title:"Bank Interest — 1099-INT (US Bank)",        description:"Log in to US Bank · interest earned on savings/checking",                  status:"pending", notes:"", source:"Online",  custom:false },
  { id:"tx5",  group:"Deductions & Expenses", title:"Property Taxes",                            description:"County/city · check online; ~$5,300 annually",                             status:"pending", notes:"", source:"Online",  custom:false },
  { id:"tx6",  group:"Deductions & Expenses", title:"Charitable Donations — Keystone Church",    description:"Annual giving statement · arrives by mail",                                  status:"pending", notes:"", source:"Mail",    custom:false },
  { id:"tx7",  group:"Deductions & Expenses", title:"Charitable Donations — Grand View Schools", description:"Annual giving statement · arrives by mail",                                  status:"pending", notes:"", source:"Mail",    custom:false },
  { id:"tx8",  group:"Deductions & Expenses", title:"Charitable Donations — Compassion Intl",    description:"Annual statement · check online at compassion.com",                          status:"pending", notes:"", source:"Online",  custom:false },
  { id:"tx9",  group:"Deductions & Expenses", title:"Medical Expenses",                          description:"Out-of-pocket only; deductible if they exceed 7.5% of AGI and you itemize", status:"pending", notes:"", source:"Records", custom:false },
  { id:"tx10", group:"Deductions & Expenses", title:"Vehicle Registration & Taxes",              description:"~$285 (Sienna) + ~$3 (Camry) = ~$288 · keep receipts",                     status:"pending", notes:"", source:"Records", custom:false },
  { id:"tx11", group:"Investments & Assets",  title:"Investment Account Docs (Uncommon Wealth)", description:"Contact Uncommon Wealth Partners for 1099 / tax summary",                   status:"pending", notes:"", source:"Contact", custom:false },
  { id:"tx12", group:"Investments & Assets",  title:"401(k) Statement (Uncommon Wealth)",        description:"Contact Uncommon Wealth Partners for annual 401(k) tax docs",               status:"pending", notes:"", source:"Contact", custom:false },
  { id:"tx13", group:"Investments & Assets",  title:"529 Contributions — 1099-Q (529 Iowa)",     description:"Contribution letter for each beneficiary · arrives by mail",                status:"pending", notes:"", source:"Mail",    custom:false },
  { id:"tx14", group:"Other",                 title:"Prior Year Tax Return (2024)",              description:"Federal & State PDFs · keep on file for reference and carry-forwards",      status:"pending", notes:"", source:"Records", custom:false },
  { id:"tx15", group:"Other",                 title:"Driver's License — Annie",                  description:"Photo copy for accountant ID verification",                                 status:"pending", notes:"", source:"Records", custom:false },
  { id:"tx16", group:"Other",                 title:"Driver's License — Chris",                  description:"Photo copy for accountant ID verification",                                 status:"pending", notes:"", source:"Records", custom:false },
  { id:"tx17", group:"Other",                 title:"Send Package to Heather (Accountant)",      description:"Email via encyro.com/moments once all documents are gathered",               status:"pending", notes:"", source:"Online",  custom:false },
];

// ─── Sample transactions ──────────────────────────────────────────────────────
const SAMPLE_TX = [
  { id:"s1",  date:"2026-03-01", category:"housing",        description:"Mortgage Payment",       amount:896.81,  type:"expense", source:"manual" },
  { id:"s2",  date:"2026-03-03", category:"groceries",      description:"Hy-Vee Groceries",       amount:87.42,   type:"expense", source:"manual" },
  { id:"s3",  date:"2026-03-05", category:"restaurant",     description:"Thai Flavors",            amount:34.18,   type:"expense", source:"manual" },
  { id:"s4",  date:"2026-03-07", category:"transportation", description:"Kwik Star Gas",           amount:55.00,   type:"expense", source:"manual" },
  { id:"s5",  date:"2026-03-10", category:"utilities",      description:"MidAmerican Electric",   amount:112.00,  type:"expense", source:"manual" },
  { id:"s6",  date:"2026-03-06", category:"giving",         description:"Keystone Church Tithe",  amount:1060.00, type:"expense", source:"manual" },
  { id:"s7",  date:"2026-03-12", category:"retail",         description:"Amazon Order",            amount:42.00,   type:"expense", source:"manual" },
  { id:"s8",  date:"2026-03-07", category:"savings",        description:"Retirement Fund",         amount:1125.00, type:"expense", source:"manual" },
  { id:"s9",  date:"2026-03-07", category:"income",         description:"ADP — Chris",             amount:2132.00, type:"income",  source:"manual" },
  { id:"s10", date:"2026-03-21", category:"income",         description:"ADP — Chris",             amount:2132.00, type:"income",  source:"manual" },
  { id:"s11", date:"2026-03-28", category:"income",         description:"Raker Rhodes — Annie",    amount:5400.00, type:"income",  source:"manual" },
  { id:"s12", date:"2026-02-03", category:"groceries",      description:"Fareway Groceries",       amount:94.11,   type:"expense", source:"manual" },
  { id:"s13", date:"2026-02-07", category:"transportation", description:"Shell Gas",               amount:62.00,   type:"expense", source:"manual" },
  { id:"s14", date:"2026-02-01", category:"housing",        description:"Mortgage Payment",        amount:896.81,  type:"expense", source:"manual" },
  { id:"s15", date:"2026-02-07", category:"income",         description:"ADP — Chris",             amount:2132.00, type:"income",  source:"manual" },
  { id:"s16", date:"2026-02-21", category:"income",         description:"ADP — Chris",             amount:2132.00, type:"income",  source:"manual" },
  { id:"s17", date:"2026-02-28", category:"income",         description:"Raker Rhodes — Annie",    amount:5400.00, type:"income",  source:"manual" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n??0);
}
function genId() { return "t"+Date.now()+Math.random().toString(36).slice(2,6); }

function Bi({ name, style }) {
  return <i className={`bi bi-${name}`} aria-hidden="true" style={style} />;
}

function autoCategory(description, keywords) {
  const desc = description.toLowerCase();
  for (const [cat,words] of Object.entries(keywords)) {
    if (words.some(w => desc.includes(w.toLowerCase()))) return cat;
  }
  return "other";
}

function inferKeywordFromDescription(description) {
  const stopWords = new Set([
    "web","authorized","pmt","payment","electronic","deposit","withdrawal","mobile","banking","transfer",
    "pos","debit","card","check","purchase","purchases","inc","llc","co","corp","the","from","to","at",
    "online","visa","mastercard","amex","ach","txn","recurring"
  ]);
  const clean = String(description || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  const words = clean
    .split(" ")
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !stopWords.has(w));
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  return `${words[0]} ${words[1]}`.trim();
}

function parseCSV(text, keywords) {
  const lines = text.trim().split("\n").map(l=>l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const cols = lines[0].replace(/"/g,"").split(",").map(c=>c.trim().toLowerCase());

  const findCol = (...names) => {
    for (const n of names) {
      const i = cols.findIndex(c=>c.includes(n));
      if (i !== -1) return i;
    }
    return -1;
  };

  const dateIdx=findCol("transaction date","trans date","date","posted");
  const descIdx=findCol("description","name","payee","merchant","transaction","expense","memo");
  const amtIdx=findCol("amount","debit","charge");
  const typeIdx=findCol("type");
  const budgetIdx=findCol("budget");
  const incAmtIdx=findCol("income ($)","income($)");
  const expAmtIdx=findCol("expense ($)","expense($)");

  if (dateIdx===-1||descIdx===-1) return null;
  if (amtIdx===-1&&(incAmtIdx===-1||expAmtIdx===-1)) return null;

  const results=[];
  for (let i=1;i<lines.length;i++) {
    const parts=[];
    let cur="",inQ=false;
    for (const ch of lines[i]) {
      if (ch==='"'){inQ=!inQ;continue;}
      if (ch===","&&!inQ){parts.push(cur.trim());cur="";}
      else cur+=ch;
    }
    parts.push(cur.trim());

    const dateRaw=parts[dateIdx]||"";
    const desc=parts[descIdx]||"";
    let rawAmt,isIncome;

    if (incAmtIdx!==-1&&expAmtIdx!==-1) {
      const inc=parseFloat((parts[incAmtIdx]||"0").replace(/[$,]/g,""))||0;
      const exp=parseFloat((parts[expAmtIdx]||"0").replace(/[$,]/g,""))||0;
      if (inc>0){rawAmt=inc;isIncome=true;}else{rawAmt=exp;isIncome=false;}
    } else {
      const amtRaw=parts[amtIdx]||"0";
      const typeRaw=typeIdx!==-1?(parts[typeIdx]||"").toLowerCase():"";
      rawAmt=parseFloat(amtRaw.replace(/[$,]/g,""));
      isIncome=rawAmt>0||typeRaw==="credit"||typeRaw==="payment"||typeRaw==="return";
    }

    const amount=Math.abs(rawAmt);
    if (!amount||!desc) continue;

    let dateParsed=dateRaw;
    const dp=new Date(dateRaw);
    if (!isNaN(dp)) dateParsed=dp.toISOString().slice(0,10);

    let cat;
    if (isIncome) {
      cat="income";
    } else if (budgetIdx!==-1&&parts[budgetIdx]) {
      const bv=parts[budgetIdx].toLowerCase().trim();
      cat=BUDGET_CAT_MAP[bv]||autoCategory(desc,keywords);
    } else {
      cat=autoCategory(desc,keywords);
    }

    results.push({id:genId(),date:dateParsed,description:desc,amount,type:isIncome?"income":"expense",category:cat,source:"csv"});
  }
  return results;
}

// ─── App ──────────────────────────────────────────────────────────────────────
function FinanceApp({ session }) {
  const userId = session.user.id;

  const [view,setView]                   = useState("envelopes");
  const [transactions,setTransactions]   = useState([]);
  const [budgets,setBudgets]             = useState(defaultBudgets);
  const [income,setIncome]               = useState(9664);
  const [keywords,setKeywords]           = useState(DEFAULT_KEYWORDS);
  const [taxItems,setTaxItems]           = useState(DEFAULT_TAX_ITEMS);
  const [kids,setKids]                   = useState(DEFAULT_KIDS);
  const [envelopeCategoryIds,setEnvelopeCategoryIds] = useState(DEFAULT_ENVELOPE_CATEGORY_IDS);
  const [subBudgets,setSubBudgets]       = useState(DEFAULT_SUB_BUDGETS);
  const [selectedMonth,setSelectedMonth] = useState(now.getMonth());
  const [selectedYear,setSelectedYear]   = useState(now.getFullYear());
  const [toast,setToast]                 = useState(null);
  const [loaded,setLoaded]               = useState(false);
  const [form,setForm]                   = useState({date:now.toISOString().slice(0,10),category:"groceries",description:"",amount:"",type:"expense"});
  const [importPreview,setImportPreview] = useState(null);
  const fileRef = useRef();

  // ─── Load all data from Supabase on mount ────────────────────────────────
  useEffect(()=>{
    (async()=>{
      try {
        // ── Settings ──
        const { data: settings } = await supabase
          .from("user_settings").select("*").eq("user_id", userId).maybeSingle();

        if (settings) {
          if (settings.budgets && Object.keys(settings.budgets).length)
            setBudgets(settings.budgets);
          if (typeof settings.income === "number") setIncome(settings.income);
          if (settings.keywords && Object.keys(settings.keywords).length)
            setKeywords(settings.keywords);
          setEnvelopeCategoryIds(normalizeEnvelopeCategoryIds(settings.envelope_category_ids || []));
          setSubBudgets(normalizeSubBudgets(settings.sub_budgets || {}));
          if (Array.isArray(settings.kids_data) && settings.kids_data.length)
            setKids(normalizeKidsData(settings.kids_data));
        } else {
          // First-time user: seed default settings.
          // upsert (not insert) so this is safe even if the DB trigger
          // already created a bare row when the auth user was created.
          await supabase.from("user_settings").upsert({
            user_id:               userId,
            income:                9664,
            budgets:               defaultBudgets,
            keywords:              DEFAULT_KEYWORDS,
            envelope_category_ids: DEFAULT_ENVELOPE_CATEGORY_IDS,
            sub_budgets:           DEFAULT_SUB_BUDGETS,
            kids_data:             DEFAULT_KIDS,
          });
        }

        // ── Transactions ──
        const { data: txData } = await supabase
          .from("transactions")
          .select("id, date, description, amount, type, category, source")
          .eq("user_id", userId);
        if (txData) setTransactions(txData);

        // ── Tax Items ──
        const { data: taxData } = await supabase
          .from("tax_items").select("*").eq("user_id", userId).order("sort_order");

        if (taxData && taxData.length > 0) {
          setTaxItems(taxData.map(({ grp, user_id:_u, sort_order:_s, created_at:_c, ...rest }) =>
            ({ ...rest, group: grp })
          ));
        } else {
          // Seed default tax items for new user (prefix ID to avoid cross-user PK collisions)
          const prefix = userId.slice(0, 8);
          await supabase.from("tax_items").insert(
            DEFAULT_TAX_ITEMS.map((item, idx) => ({
              id:          `${prefix}_${item.id}`,
              user_id:     userId,
              grp:         item.group,
              title:       item.title,
              description: item.description || "",
              status:      item.status,
              notes:       item.notes || "",
              source:      item.source,
              custom:      item.custom,
              sort_order:  idx,
            }))
          );
          setTaxItems(DEFAULT_TAX_ITEMS.map(item =>
            ({ ...item, id: `${userId.slice(0,8)}_${item.id}` })
          ));
        }
      } catch(err) { console.error("Load error:", err); }
      setLoaded(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[userId]);

  // ─── Supabase persistence helpers ────────────────────────────────────────
  // Saves all budget/settings in one upsert
  function saveSettings(bud, inc, kw, envIds, subb) {
    supabase.from("user_settings").upsert({
      user_id:               userId,
      budgets:               bud,
      income:                inc,
      keywords:              kw,
      envelope_category_ids: envIds,
      sub_budgets:           subb,
      updated_at:            new Date().toISOString(),
    }).then(({ error }) => { if (error) console.error("saveSettings:", error); });
  }

  // Updates only kids_data (avoids overwriting other settings columns)
  function updateKids(updated) {
    setKids(updated);
    supabase.from("user_settings")
      .update({ kids_data: updated, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .then(({ error }) => { if (error) console.error("saveKids:", error); });
  }

  const showToast=(msg)=>{setToast(msg);setTimeout(()=>setToast(null),2500);};

  const monthTx = transactions.filter(t=>{
    const d=new Date(t.date);
    return d.getMonth()===selectedMonth&&d.getFullYear()===selectedYear;
  }).sort((a,b)=>new Date(b.date)-new Date(a.date));

  const expenses    = monthTx.filter(t=>t.type==="expense");
  const incomes     = monthTx.filter(t=>t.type==="income");
  const envelopeTx  = monthTx.filter(t=>t.type==="expense" && t.source==="manual");
  const totalSpent  = expenses.reduce((s,t)=>s+t.amount,0);
  const totalIncome = incomes.reduce((s,t)=>s+t.amount,0)||income;
  const remaining   = totalIncome-totalSpent;

  const spentByCat={};
  CATEGORIES.forEach(c=>{spentByCat[c.id]=0;});
  expenses.forEach(t=>{spentByCat[t.category]=(spentByCat[t.category]||0)+t.amount;});

  const envelopeSpentByCat={};
  CATEGORIES.forEach(c=>{envelopeSpentByCat[c.id]=0;});
  envelopeTx.forEach(t=>{envelopeSpentByCat[t.category]=(envelopeSpentByCat[t.category]||0)+t.amount;});

  const pieData=CATEGORIES
    .filter(c=>c.id!=="income"&&spentByCat[c.id]>0)
    .map(c=>({name:c.label,value:parseFloat(spentByCat[c.id].toFixed(2)),color:c.color}));

  const barData=Array.from({length:6},(_,i)=>{
    const offset=selectedMonth-5+i;
    const m=((offset%12)+12)%12;
    const y=offset<0?selectedYear-1:selectedYear;
    const txm=transactions.filter(t=>{
      const d=new Date(t.date);
      return d.getMonth()===m&&d.getFullYear()===y&&t.type==="expense";
    });
    return {month:MONTHS[m],spent:parseFloat(txm.reduce((s,t)=>s+t.amount,0).toFixed(2))};
  });

  function addTransactionDirect(catId, amount, description) {
    const newTx={id:genId(),date:now.toISOString().slice(0,10),category:catId,description,amount:parseFloat(amount),type:"expense",source:"manual"};
    setTransactions(prev=>[newTx,...prev]);
    supabase.from("transactions").insert({ ...newTx, user_id:userId })
      .then(({ error })=>{ if (error) console.error("addTx:", error); });
    showToast(`${fmt(amount)} logged to ${CATEGORIES.find(c=>c.id===catId)?.label} ✓`);
  }

  function updateCategory(id,newCat){
    setTransactions(prev=>prev.map(t=>t.id===id?{...t,category:newCat}:t));
    supabase.from("transactions").update({ category:newCat }).eq("id",id).eq("user_id",userId)
      .then(({ error })=>{ if (error) console.error("updateCat:", error); });
  }

  function learnCategoryEditsFromCsv() {
    const nextKeywords = JSON.parse(JSON.stringify(keywords));
    let learned = 0;
    const txToLearn = transactions.filter(t => t.source === "csv" && t.type === "expense");

    txToLearn.forEach(tx => {
      if (!tx.category || tx.category === "other" || !nextKeywords[tx.category]) return;
      const predicted = autoCategory(tx.description, keywords);
      if (predicted === tx.category) return;
      const inferredKeyword = inferKeywordFromDescription(tx.description);
      if (!inferredKeyword) return;

      Object.keys(nextKeywords).forEach(catId => {
        nextKeywords[catId] = (nextKeywords[catId] || []).filter(word => word !== inferredKeyword);
      });

      if (!nextKeywords[tx.category].includes(inferredKeyword)) {
        nextKeywords[tx.category].push(inferredKeyword);
        learned++;
      }
    });

    if (learned === 0) {
      showToast("No new category edits to learn");
      return;
    }

    setKeywords(nextKeywords);
    saveSettings(budgets, income, nextKeywords, envelopeCategoryIds, subBudgets);
    showToast(`Learned ${learned} keyword${learned===1?"":"s"} from Reconcile edits`);
  }

  function deleteTransaction(id){
    setTransactions(prev=>prev.filter(t=>t.id!==id));
    supabase.from("transactions").delete().eq("id",id).eq("user_id",userId)
      .then(({ error })=>{ if (error) console.error("deleteTx:", error); });
    showToast("Deleted");
  }

  function updateTransactionDesc(id, newDesc){
    setTransactions(prev=>prev.map(t=>t.id===id?{...t,description:newDesc}:t));
    supabase.from("transactions").update({ description:newDesc }).eq("id",id).eq("user_id",userId)
      .then(({ error })=>{ if (error) console.error("updateDesc:", error); });
    showToast("Note updated ✓");
  }

  function addTransaction(){
    if(!form.description||!form.amount) return;
    const newTx={...form,id:genId(),amount:parseFloat(form.amount),source:"manual"};
    setTransactions(prev=>[newTx,...prev]);
    supabase.from("transactions").insert({ ...newTx, user_id:userId })
      .then(({ error })=>{ if (error) console.error("addTx:", error); });
    setForm({date:now.toISOString().slice(0,10),category:"groceries",description:"",amount:"",type:"expense"});
    setView("envelopes");
    showToast("Transaction added ✓");
  }

  function handleFile(file){
    if(!file) return;
    const reader=new FileReader();
    reader.onload=e=>{
      const parsed=parseCSV(e.target.result,keywords);
      if(!parsed||parsed.length===0){showToast("Could not parse CSV — check format");return;}
      setImportPreview(parsed);
      setView("import");
    };
    reader.readAsText(file);
  }

  function confirmImport(newTx){
    setTransactions(prev=>[...newTx,...prev]);
    supabase.from("transactions").insert(newTx.map(t=>({ ...t, user_id:userId })))
      .then(({ error })=>{ if (error) console.error("importTx:", error); });
    setImportPreview(null);
    setView("reconcile");
    showToast(`Imported ${newTx.length} transactions ✓`);
  }

  function updateTaxItem(id,changes){
    setTaxItems(prev=>prev.map(t=>t.id===id?{...t,...changes}:t));
    // Map "group" → "grp" for PostgREST (group is a reserved SQL word)
    const dbChanges = { ...changes };
    if ("group" in dbChanges) { dbChanges.grp = dbChanges.group; delete dbChanges.group; }
    supabase.from("tax_items").update(dbChanges).eq("id",id).eq("user_id",userId)
      .then(({ error })=>{ if (error) console.error("updateTaxItem:", error); });
  }

  function addTaxItem(item){
    setTaxItems(prev=>[...prev,item]);
    const { group:_g, ...rest } = item;
    supabase.from("tax_items").insert({ ...rest, grp:_g||"Other", user_id:userId, sort_order:taxItems.length })
      .then(({ error })=>{ if (error) console.error("addTaxItem:", error); });
  }

  function deleteTaxItem(id){
    setTaxItems(prev=>prev.filter(t=>t.id!==id));
    supabase.from("tax_items").delete().eq("id",id).eq("user_id",userId)
      .then(({ error })=>{ if (error) console.error("deleteTaxItem:", error); });
    showToast("Item removed");
  }

  if (!loaded) return null;

  return (
    <div style={{minHeight:"100vh",background:"#faf7f2",fontFamily:"system-ui,sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=DM+Mono:wght@300;400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        .pf{font-family:'Playfair Display',Georgia,serif;}
        .mono{font-family:'DM Mono',monospace;}
        .btn{border:none;border-radius:6px;cursor:pointer;font-family:'DM Mono',monospace;font-size:0.78rem;letter-spacing:.04em;transition:all .15s;padding:8px 16px;}
        .btn-amber{background:#b45309;color:#fef3c7;}
        .btn-amber:hover{background:#92400e;}
        .btn-ghost{background:transparent;color:#78716c;border:1.5px solid #d6d3d1;}
        .btn-ghost:hover{border-color:#b45309;color:#b45309;}
        .btn-sm{padding:5px 12px;font-size:0.72rem;}
        .btn-del{background:none;border:none;color:#d6d3d1;cursor:pointer;font-size:0.85rem;padding:2px 5px;border-radius:4px;transition:color .15s;}
        .btn-del:hover{color:#be123c;}
        .nav-bar{position:sticky;top:0;z-index:50;background:#fff;border-bottom:1px solid #e7e5e4;padding:0 4px;display:flex;align-items:center;overflow-x:auto;gap:0;}
        .nav-item{padding:10px 14px;cursor:pointer;font-family:'DM Mono',monospace;font-size:0.72rem;letter-spacing:.06em;text-transform:uppercase;color:#a8a29e;border:none;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;background:transparent;display:flex;align-items:center;justify-content:center;gap:8px;flex-shrink:0;}
        .nav-item.active{color:#b45309;border-bottom-color:#b45309;}
        .nav-item:hover{color:#1c1917;}
        .nav-label{display:none;}
        @media (min-width: 768px){
          .nav-bar{justify-content:center;overflow-x:visible;padding:0 12px;}
          .nav-item{padding:11px 16px;}
          .nav-label{display:inline;}
        }
        .card{background:#fff;border:1px solid #e7e5e4;border-radius:10px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.04);}
        .pbar{background:#f5f0eb;border-radius:99px;height:5px;overflow:hidden;}
        .pbar-fill{height:100%;border-radius:99px;transition:width .5s;}
        input,select{width:100%;border:1.5px solid #d6d3d1;border-radius:6px;padding:9px 11px;font-family:'DM Mono',monospace;font-size:0.82rem;background:#faf7f2;color:#1c1917;outline:none;transition:border-color .15s;}
        input:focus,select:focus{border-color:#b45309;background:#fff;}
        label{font-family:'DM Mono',monospace;font-size:0.68rem;letter-spacing:.07em;color:#78716c;display:block;margin-bottom:5px;text-transform:uppercase;}
        .tx-row{display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid #f5f0eb;}
        .tx-row:last-child{border-bottom:none;}
        .month-pill{cursor:pointer;padding:4px 11px;border-radius:99px;font-family:'DM Mono',monospace;font-size:0.7rem;letter-spacing:.03em;border:1.5px solid #e7e5e4;background:transparent;color:#78716c;transition:all .15s;}
        .month-pill.active{background:#b45309;color:#fef3c7;border-color:#b45309;}
        .month-pill:hover:not(.active){border-color:#b45309;color:#b45309;}
        .cat-sel{border:1.5px solid #e7e5e4;border-radius:5px;padding:4px 8px;font-family:'DM Mono',monospace;font-size:0.72rem;background:#faf7f2;color:#1c1917;cursor:pointer;outline:none;}
        .cat-sel:focus{border-color:#b45309;}
        .stat-card{background:#fff;border-radius:10px;border:1px solid #e7e5e4;padding:16px;}
        .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1c1917;color:#fef3c7;padding:10px 22px;border-radius:99px;font-family:'DM Mono',monospace;font-size:0.78rem;letter-spacing:.05em;z-index:999;animation:fadeUp .2s ease;box-shadow:0 4px 20px rgba(0,0,0,.2);}
        @keyframes fadeUp{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        .tag{border-radius:4px;padding:1px 6px;font-size:0.64rem;letter-spacing:.04em;font-family:'DM Mono',monospace;margin-left:5px;}
        .tag-csv{background:#fef3c7;color:#92400e;}
        .tag-manual{background:#f0fdf4;color:#166534;}
        /* Envelope styles */
        .envelope-card{background:#fff;border:1.5px solid #e7e5e4;border-radius:12px;padding:16px;cursor:pointer;transition:all .18s;position:relative;overflow:hidden;}
        .envelope-card:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.09);border-color:#d6d3d1;}
        .envelope-card.active{border-color:#b45309;box-shadow:0 0 0 3px rgba(180,83,9,.12);}
        .envelope-card.over{border-color:#be123c;}
        .env-flap{position:absolute;top:0;left:0;right:0;height:28px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:4px;}
        /* Tax styles */
        .tax-item{border:1px solid #f0ede8;border-radius:8px;padding:12px 14px;background:#fff;transition:all .15s;margin-bottom:8px;}
        .tax-item:hover{border-color:#e7e5e4;box-shadow:0 1px 4px rgba(0,0,0,.06);}
        .tax-status-btn{width:22px;height:22px;border-radius:50%;border:2px solid #d6d3d1;background:none;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s;font-size:0.7rem;}
        .tax-status-btn.ready{background:#16a34a;border-color:#16a34a;color:#fff;}
        .tax-status-btn.na{background:#e7e5e4;border-color:#d6d3d1;color:#a8a29e;}
        .group-pill{cursor:pointer;padding:4px 12px;border-radius:99px;font-family:'DM Mono',monospace;font-size:0.69rem;letter-spacing:.04em;border:1.5px solid #e7e5e4;background:transparent;color:#78716c;transition:all .15s;}
        .group-pill.active{background:#1e40af;color:#dbeafe;border-color:#1e40af;}
        .group-pill:hover:not(.active){border-color:#1e40af;color:#1e40af;}
        .source-badge{font-family:'DM Mono',monospace;font-size:0.6rem;letter-spacing:.05em;border-radius:4px;padding:1px 6px;border:1px solid;}
        .src-mail{background:#fef3c7;color:#92400e;border-color:#fde68a;}
        .src-online{background:#dbeafe;color:#1e40af;border-color:#bfdbfe;}
        .src-contact{background:#f0fdf4;color:#166534;border-color:#bbf7d0;}
        .src-records{background:#f3f0ff;color:#6b21a8;border-color:#ddd6fe;}
        /* Reconcile */
        .match-ok{background:#f0fdf4;border-left:3px solid #16a34a;}
        .match-flag{background:#fff7ed;border-left:3px solid #f59e0b;}
      `}</style>

      {/* Hidden file input — always available */}
      <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>{handleFile(e.target.files[0]);e.target.value="";}} />

      {/* Minimal sticky nav — used on all pages */}
      <div className="nav-bar">
        {[
          ["envelopes","envelope-paper","Envelopes"],
          ["dashboard","bar-chart","Dashboard"],
          ["reconcile","arrow-repeat","Reconcile"],
          ["budgets","cash-stack","Budgets"],
          ["tax","building","Tax"],
          ["kids","people-fill","Kids"],
          ["keywords","key-fill","Keywords"],
        ].map(([v,icon,label])=>(
          <button key={v} type="button" className={`nav-item ${view===v?"active":""}`} onClick={()=>setView(v)}>
            <Bi name={icon} style={{fontSize:"1rem"}} />
            <span className="nav-label">{label}</span>
          </button>
        ))}
        {/* Sign out — pushed to far right */}
        <div style={{flex:1}} />
        <button
          type="button"
          title="Sign out"
          onClick={()=>supabase.auth.signOut()}
          style={{
            padding:"10px 14px",cursor:"pointer",fontFamily:"'DM Mono',monospace",
            fontSize:"0.72rem",letterSpacing:".06em",textTransform:"uppercase",
            color:"#a8a29e",border:"none",borderBottom:"2px solid transparent",
            background:"transparent",display:"flex",alignItems:"center",gap:6,flexShrink:0,
            transition:"all .15s",
          }}
        >
          <Bi name="box-arrow-right" style={{fontSize:"1rem"}} />
          <span className="nav-label">Sign Out</span>
        </button>
      </div>

      <main style={{maxWidth:1020,margin:"0 auto",padding:"12px 12px 80px"}}>
        {/* Month Picker — compact prev/next on envelopes, full strip elsewhere */}
        {view !== "tax" && view !== "envelopes" && (
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:20}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <button onClick={()=>setSelectedYear(y=>y-1)} style={{background:"none",border:"1px solid #e7e5e4",borderRadius:6,cursor:"pointer",fontSize:"0.85rem",color:"#78716c",padding:"3px 10px",lineHeight:1.4}}>‹ Prev</button>
              <span className="mono" style={{fontSize:"0.82rem",fontWeight:700,color:"#1c1917",minWidth:42,textAlign:"center"}}>{selectedYear}</span>
              <button onClick={()=>setSelectedYear(y=>y+1)} disabled={selectedYear>=now.getFullYear()} style={{background:"none",border:"1px solid #e7e5e4",borderRadius:6,cursor:selectedYear>=now.getFullYear()?"not-allowed":"pointer",fontSize:"0.85rem",color:selectedYear>=now.getFullYear()?"#d4cfcb":"#78716c",padding:"3px 10px",lineHeight:1.4}}>Next ›</button>
            </div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {MONTHS.map((m,i)=>(
                <button key={m} className={`month-pill ${selectedMonth===i?"active":""}`} onClick={()=>setSelectedMonth(i)}>{m}</button>
              ))}
            </div>
          </div>
        )}
        {view === "envelopes" && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <button onClick={()=>setSelectedMonth(m=>(m+11)%12)} style={{background:"none",border:"none",cursor:"pointer",fontSize:"1.1rem",color:"#a8a29e",padding:"2px 6px",lineHeight:1}}>‹</button>
            <span className="mono" style={{fontSize:"0.72rem",letterSpacing:".1em",color:"#78716c",minWidth:36,textAlign:"center"}}>{MONTHS[selectedMonth]}</span>
            <button onClick={()=>setSelectedMonth(m=>(m+1)%12)} style={{background:"none",border:"none",cursor:"pointer",fontSize:"1.1rem",color:"#a8a29e",padding:"2px 6px",lineHeight:1}}>›</button>
          </div>
        )}

        {/* ENVELOPES */}
        {view==="envelopes" && (
          <EnvelopesView
            categories={MONTHLY_BUDGET_CATS}
            budgets={budgets}
            envelopeCategoryIds={envelopeCategoryIds}
            subBudgets={subBudgets}
            spentByCat={envelopeSpentByCat}
            month={MONTHS[selectedMonth]}
            monthTx={envelopeTx}
            onSpend={addTransactionDirect}
            onDelete={deleteTransaction}
            onUpdateDesc={updateTransactionDesc}
          />
        )}

        {/* DASHBOARD */}
        {view==="dashboard" && (
          <DashboardView
            totalIncome={totalIncome} totalSpent={totalSpent} remaining={remaining}
            budgets={budgets} spentByCat={spentByCat} pieData={pieData} barData={barData}
            monthTx={monthTx} onViewAll={()=>setView("reconcile")}
            allTransactions={transactions} selectedYear={selectedYear} selectedMonth={selectedMonth}
            monthlyIncome={income}
          />
        )}

        {/* RECONCILE (transactions + CSV import result) */}
        {view==="reconcile" && (
          <ReconcileView
            transactions={monthTx} allTransactions={transactions}
            selectedMonth={selectedMonth} selectedYear={selectedYear}
            onUpdateCat={updateCategory} onDelete={deleteTransaction}
            month={MONTHS[selectedMonth]} spentByCat={spentByCat} budgets={budgets}
            onImportCSV={()=>fileRef.current?.click()}
            onLearnCategoryEdits={learnCategoryEditsFromCsv}
          />
        )}

        {/* BUDGETS */}
        {view==="budgets" && (
          <BudgetsView budgets={budgets} income={income} spentByCat={spentByCat} envelopeCategoryIds={envelopeCategoryIds} subBudgets={subBudgets}
            onSave={(b,inc,envIds,subb)=>{
              const normEnv=normalizeEnvelopeCategoryIds(envIds);
              const normSub=normalizeSubBudgets(subb);
              setBudgets(b);setIncome(inc);setEnvelopeCategoryIds(normEnv);setSubBudgets(normSub);
              saveSettings(b,inc,keywords,normEnv,normSub);
              showToast("Budgets saved ✓");
            }} />
        )}

        {/* TAX TASKER */}
        {view==="tax" && (
          <TaxTaskerView items={taxItems} onUpdateItem={updateTaxItem}
            onAddItem={addTaxItem} onDeleteItem={deleteTaxItem} taxYear={selectedYear-1} />
        )}

        {/* KIDS LEDGER */}
        {view==="kids" && (
          <KidsLedgerView kids={kids} onUpdateKids={updateKids} />
        )}

        {/* KEYWORDS */}
        {view==="keywords" && (
          <KeywordsView keywords={keywords}
            onSave={(kw)=>{
              setKeywords(kw);
              saveSettings(budgets,income,kw,envelopeCategoryIds,subBudgets);
              showToast("Keywords saved");
            }}
            onImportMap={(kw,meta)=>{
              setKeywords(kw);
              const prev=transactions;
              const updated=prev.map(t=>t.source==="csv"?{...t,category:t.type==="income"?"income":autoCategory(t.description,kw)}:t);
              setTransactions(updated);
              saveSettings(budgets,income,kw,envelopeCategoryIds,subBudgets);
              // Push any category changes to DB
              updated.forEach(t=>{
                const orig=prev.find(o=>o.id===t.id);
                if(orig&&orig.category!==t.category)
                  supabase.from("transactions").update({category:t.category}).eq("id",t.id).eq("user_id",userId)
                    .then(({error})=>{if(error)console.error("reclassify:",error);});
              });
              showToast(`Imported ${meta.imported} keywords (${meta.skipped} skipped) and reclassified CSV`);
            }}
            onReclassify={()=>{
              const prev=transactions;
              const updated=prev.map(t=>t.source==="csv"?{...t,category:t.type==="income"?"income":autoCategory(t.description,keywords)}:t);
              setTransactions(updated);
              updated.forEach(t=>{
                const orig=prev.find(o=>o.id===t.id);
                if(orig&&orig.category!==t.category)
                  supabase.from("transactions").update({category:t.category}).eq("id",t.id).eq("user_id",userId)
                    .then(({error})=>{if(error)console.error("reclassify:",error);});
              });
              showToast("Re-classified ✓");
            }}
          />
        )}

        {/* ADD */}
        {view==="add" && (
          <div className="card" style={{maxWidth:480,margin:"0 auto"}}>
            <h2 className="pf" style={{fontSize:"1.15rem",marginBottom:22,fontStyle:"italic"}}>New Transaction</h2>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div><label>Type</label>
                <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}>
                  <option value="expense">Expense</option><option value="income">Income</option>
                </select>
              </div>
              <div><label>Description</label>
                <input value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} placeholder="e.g. Hy-Vee Groceries" />
              </div>
              <div><label>Amount ($)</label>
                <input type="number" min="0" step="0.01" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} placeholder="0.00" />
              </div>
              <div><label>Category</label>
                <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>
                  {CATEGORIES.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
              <div><label>Date</label>
                <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
              </div>
              <div style={{display:"flex",gap:10,marginTop:6}}>
                <button className="btn btn-amber" style={{flex:1,padding:"11px"}} onClick={addTransaction}>Add Transaction</button>
                <button className="btn btn-ghost" onClick={()=>setView("envelopes")}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* IMPORT PREVIEW */}
        {view==="import" && importPreview && (
          <ImportPreview
            transactions={importPreview}
            onConfirm={confirmImport}
            onCancel={()=>{setImportPreview(null);setView("envelopes");}}
            onUpdateCat={(id,cat)=>setImportPreview(prev=>prev.map(t=>t.id===id?{...t,category:cat}:t))}
          />
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ─── EnvelopesView ────────────────────────────────────────────────────────────
// Designed for one-handed, in-store use: tap envelope → type amount → LOG IT
function EnvelopesView({ categories, budgets, envelopeCategoryIds, subBudgets, spentByCat, month, monthTx, onSpend, onDelete, onUpdateDesc }) {
  const [activeEnv,   setActiveEnv]   = useState(null);
  const [spendAmt,    setSpendAmt]    = useState("");
  const [spendNote,   setSpendNote]   = useState("");
  const [recentCats,  setRecentCats]  = useState(["groceries","restaurant","transportation","retail"]);
  const [editingTxId, setEditingTxId] = useState(null);
  const [editingDesc, setEditingDesc] = useState("");
  const amtRef  = useRef();
  const noteRef = useRef();

  const visibleEnvelopeIds = new Set(normalizeEnvelopeCategoryIds(envelopeCategoryIds));
  const baseEnvelopes = categories
    .filter(c => visibleEnvelopeIds.has(c.id))
    .map(c => ({ ...c, budget: budgets[c.id] || 0, isSub:false }));
  const subEnvelopes = Object.entries(subBudgets || {}).flatMap(([parentId, items]) =>
    (Array.isArray(items) ? items : [])
      .filter(item => item && item.envelopeOn)
      .map(item => ({
        id: `sub:${parentId}:${item.id}`,
        label: item.label,
        icon: "Sub",
        color: (categories.find(c=>c.id===parentId)?.color || "#78716c"),
        budget: item.amount || 0,
        isSub:true,
        parentId,
        subId:item.id,
      }))
  );
  // Only envelopes that have a budget set and are enabled for quick spending
  const budgetedCats  = [...baseEnvelopes, ...subEnvelopes].filter(c => (c.budget||0) > 0);

  function matchesEnvelopeTx(tx, cat) {
    if (tx.type !== "expense") return false;
    if (!cat.isSub) return tx.category===cat.id && !new RegExp(`^\\[sub:${cat.id}:`).test(String(tx.description || ""));
    const prefix = `[sub:${cat.parentId}:${cat.subId}]`;
    return tx.category===cat.parentId && String(tx.description || "").startsWith(prefix);
  }

  function getEnvelopeSpent(cat) {
    return monthTx.filter(t=>matchesEnvelopeTx(t,cat)).reduce((s,t)=>s+(t.amount||0),0);
  }

  function getEnvelopeLastTx(cat) {
    return monthTx.find(t=>matchesEnvelopeTx(t,cat));
  }

  const totalBudgeted = budgetedCats.reduce((s,c)=>s+(c.budget||0),0);
  const totalSpent    = budgetedCats.reduce((s,c)=>s+getEnvelopeSpent(c),0);
  const leftTotal     = totalBudgeted - totalSpent;
  const envsOver      = budgetedCats.filter(c=>getEnvelopeSpent(c)>(c.budget||0)).length;

  function openEnvelope(catId) {
    if (activeEnv === catId) { setActiveEnv(null); return; }
    setActiveEnv(catId);
    setSpendAmt("");
    setSpendNote("");
    setEditingTxId(null);
    setTimeout(()=>amtRef.current?.focus(), 60);
  }

  function handleSpend(catId) {
    const amt = parseFloat(spendAmt);
    if (!amt || amt <= 0) return;
    const cat = budgetedCats.find(c=>c.id===catId);
    if (!cat) return;
    const desc = spendNote.trim() || `${cat.label} purchase`;
    const taggedDesc = cat.isSub ? `[sub:${cat.parentId}:${cat.subId}] ${desc}` : desc;
    onSpend(cat.isSub ? cat.parentId : catId, amt, taggedDesc);
    setSpendAmt("");
    setSpendNote("");
    setActiveEnv(null);
    setRecentCats(prev => [catId, ...prev.filter(id=>id!==catId)].slice(0,4));
  }

  function startEdit(tx) {
    setEditingTxId(tx.id);
    setEditingDesc(tx.description);
  }

  function saveEdit(txId) {
    if (editingDesc.trim()) onUpdateDesc(txId, editingDesc.trim());
    setEditingTxId(null);
    setEditingDesc("");
  }

  function colorWithAlpha(hex, alpha) {
    const raw = String(hex || "").replace("#", "");
    if (raw.length !== 6) return `rgba(107,114,128,${alpha})`;
    const r = parseInt(raw.slice(0,2), 16);
    const g = parseInt(raw.slice(2,4), 16);
    const b = parseInt(raw.slice(4,6), 16);
    if ([r,g,b].some(Number.isNaN)) return `rgba(107,114,128,${alpha})`;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // Single envelope card — compact for iPhone
  function EnvCard({ cat }) {
    const budget = cat.budget||0;
    const spent  = getEnvelopeSpent(cat);
    const left   = budget - spent;
    const pct    = budget > 0 ? Math.min(spent/budget,1) : 0;
    const over   = spent > budget && budget > 0;
    const isOpen = activeEnv === cat.id;
    const lastTx = getEnvelopeLastTx(cat);

    const accentColor = over ? "#be123c" : colorWithAlpha(cat.color, 0.75);
    const barColor    = over ? "#be123c" : colorWithAlpha(cat.color, 0.6);

    return (
      <div style={{display:"flex",flexDirection:"column"}}>
        {/* Tap target */}
        <div
          onClick={()=>openEnvelope(cat.id)}
          style={{
            background: isOpen ? "#fffbf5" : "#fff",
            border: `1.5px solid ${isOpen ? "#b45309" : over ? "#fca5a5" : "#e7e5e4"}`,
            borderRadius: isOpen ? "12px 12px 0 0" : 12,
            overflow: "hidden",
            cursor: "pointer",
            transition: "all .15s",
            userSelect: "none",
            boxShadow: isOpen ? "0 2px 12px rgba(0,0,0,.07)" : "0 1px 3px rgba(0,0,0,.04)",
          }}
        >
          {/* Thin accent bar at top — neutral unless over budget */}
          <div style={{height:3,background:barColor}} />

          <div style={{padding:"10px 11px 10px",display:"grid",gridTemplateColumns:"48px 1fr",alignItems:"center",columnGap:10}}>
            <span style={{display:"flex",alignItems:"center",justifyContent:"center",height:36}}>
              <Bi name={cat.icon} style={{fontSize:"1.7rem",color:over?"#be123c":"#a8a29e",lineHeight:1}} />
            </span>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,textAlign:"center"}}>
              <p style={{
                fontSize:"1.3rem",fontFamily:"'Playfair Display',serif",fontWeight:700,
                color: over ? "#be123c" : "#1c1917", lineHeight:1,
              }}>
                {budget>0 ? fmt(Math.abs(left)) : "—"}
              </p>
              <p style={{fontSize:"0.66rem",fontWeight:600,color:"#78716c",letterSpacing:"-.01em",lineHeight:1}}>{cat.label}</p>
            </div>
          </div>
        </div>

        {/* Spend form */}
        {isOpen && (
          <div style={{
            background:"#fffbf5",border:"1.5px solid #b45309",borderTop:"none",
            borderRadius:"0 0 12px 12px",padding:"10px 11px 12px",
            boxShadow:"0 4px 12px rgba(0,0,0,.06)",
          }}>
            {/* Title + balance detail — lives here when open */}
            <div style={{marginBottom:10,paddingBottom:9,borderBottom:"1px solid #f0ece8"}}>
              <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontSize:"0.82rem",fontWeight:700,color:"#b45309",letterSpacing:"-.01em"}}>{cat.label}</span>
                <span className="mono" style={{fontSize:"0.58rem",color:over?"#be123c":"#065f46",fontWeight:600}}>
                  {budget>0 ? (over ? `OVER ${fmt(spent-budget)}` : `${fmt(left)} left`) : "no budget"}
                </span>
              </div>
              {budget>0 && (
                <>
                  <div style={{background:"#f0ece8",borderRadius:99,height:4,overflow:"hidden",marginBottom:3}}>
                    <div style={{width:`${pct*100}%`,height:"100%",background:accentColor,borderRadius:99,transition:"width .4s"}} />
                  </div>
                  <p className="mono" style={{fontSize:"0.5rem",color:"#c9c5c0",textAlign:"right"}}>
                    {fmt(spent)} spent · {fmt(budget)} budget
                  </p>
                </>
              )}
            </div>

            {/* Amount */}
            <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:7}}>
              <span style={{fontSize:"1.3rem",fontFamily:"'Playfair Display',serif",color:"#a8a29e",flexShrink:0,lineHeight:1}}>$</span>
              <input
                ref={amtRef}
                type="number" inputMode="decimal" min="0" step="0.01"
                value={spendAmt}
                onChange={e=>setSpendAmt(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Enter") noteRef.current?.focus(); if(e.key==="Escape") setActiveEnv(null); }}
                placeholder="0.00"
                style={{
                  fontSize:"1.8rem",padding:"2px 4px",textAlign:"right",
                  border:"none",borderBottom:"2px solid #b45309",borderRadius:0,
                  background:"transparent",fontFamily:"'DM Mono',monospace",
                  fontWeight:500,color:"#1c1917",outline:"none",width:"100%",
                }}
              />
            </div>

            {/* Note */}
            <input
              ref={noteRef}
              type="text" value={spendNote}
              onChange={e=>setSpendNote(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter") handleSpend(cat.id); if(e.key==="Escape") setActiveEnv(null); }}
              placeholder="note (optional)"
              style={{
                width:"100%",fontSize:"0.78rem",padding:"5px 8px",marginBottom:8,
                border:"1px solid #e7e5e4",borderRadius:6,background:"#fff",
                color:"#1c1917",outline:"none",fontFamily:"DM Mono,monospace",
                boxSizing:"border-box",
              }}
            />

            {/* Last transaction — undo / edit note */}
            {lastTx && (
              <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:8,padding:"5px 8px",background:"#f5f0eb",borderRadius:6}}>
                <div style={{flex:1,minWidth:0}}>
                  {editingTxId===lastTx.id ? (
                    <input
                      autoFocus value={editingDesc}
                      onChange={e=>setEditingDesc(e.target.value)}
                      onKeyDown={e=>{ if(e.key==="Enter") saveEdit(lastTx.id); if(e.key==="Escape") setEditingTxId(null); }}
                      style={{
                        width:"100%",fontSize:"0.7rem",padding:"2px 4px",
                        border:"1px solid #b45309",borderRadius:4,
                        background:"#fff",fontFamily:"DM Mono,monospace",outline:"none",
                      }}
                    />
                  ) : (
                    <>
                      <p className="mono" style={{fontSize:"0.65rem",color:"#78716c",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{String(lastTx.description||"").replace(/^\[sub:[^\]]+\]\s*/,"")}</p>
                      <p className="mono" style={{fontSize:"0.56rem",color:"#a8a29e"}}>{lastTx.date} · {fmt(lastTx.amount)}</p>
                    </>
                  )}
                </div>
                {editingTxId===lastTx.id ? (
                  <button onClick={()=>saveEdit(lastTx.id)} style={{background:"#b45309",color:"#fff",border:"none",borderRadius:4,padding:"3px 8px",cursor:"pointer",fontFamily:"DM Mono,monospace",fontSize:"0.65rem",flexShrink:0}}>✓</button>
                ) : (
                  <>
                    <button onClick={e=>{e.stopPropagation();startEdit(lastTx);}} title="Edit note" style={{background:"none",border:"none",cursor:"pointer",fontSize:"0.85rem",padding:"2px",lineHeight:1,color:"#78716c",flexShrink:0}}><Bi name="pencil" /></button>
                    <button onClick={e=>{e.stopPropagation();onDelete(lastTx.id);}} title="Undo last" style={{background:"none",border:"none",cursor:"pointer",fontSize:"0.85rem",padding:"2px",lineHeight:1,color:"#be123c",flexShrink:0}}>↩</button>
                  </>
                )}
              </div>
            )}

            {/* LOG IT */}
            <button
              onClick={()=>handleSpend(cat.id)}
              style={{
                width:"100%",padding:"13px",
                background: parseFloat(spendAmt)>0?"#b45309":"#e7e5e4",
                color: parseFloat(spendAmt)>0?"#fef3c7":"#a8a29e",
                border:"none",borderRadius:8,cursor:"pointer",
                fontFamily:"DM Mono,monospace",fontSize:"0.9rem",letterSpacing:".08em",
                fontWeight:500,transition:"all .15s",
              }}
            >
              {parseFloat(spendAmt)>0?`LOG  ${fmt(parseFloat(spendAmt))}  ✓`:"LOG IT ✓"}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Quick Tap: most recently used, but only if they have a budget
  const budgetedIds   = new Set(budgetedCats.map(c=>c.id));
  const recentSet     = new Set(recentCats.filter(id => budgetedIds.has(id)));
  const quickTapCats  = recentCats.filter(id=>budgetedIds.has(id)).map(id=>budgetedCats.find(c=>c.id===id)).filter(Boolean);
  // All other budgeted cats — in EXPENSE_CATS order (matching Budget tab)
  const otherCats     = budgetedCats.filter(c => !recentSet.has(c.id));

  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>

      {/* Single-line summary strip */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"2px 0 4px"}}>
        <span className="pf" style={{fontSize:"1.1rem",fontWeight:700,color:leftTotal<0?"#be123c":"#065f46",lineHeight:1}}>{fmt(leftTotal)}</span>
        <span className="mono" style={{fontSize:"0.56rem",color:"#a8a29e",letterSpacing:".06em"}}>left · {month}</span>
        {envsOver>0 && <span className="mono" style={{fontSize:"0.56rem",color:"#be123c",letterSpacing:".05em",marginLeft:2}}>{envsOver} over budget</span>}
      </div>

      {budgetedCats.length === 0 && (
        <div className="card" style={{padding:"16px 18px"}}>
          <p className="mono" style={{fontSize:"0.7rem",color:"#78716c",lineHeight:1.7}}>
            No budget categories are currently enabled for Envelopes. Open the Budgets tab and switch categories from `Fixed / Hidden` to `Envelope On`.
          </p>
        </div>
      )}


      {/* Quick Tap — 2 col grid for iPhone */}
      {quickTapCats.length > 0 && (
        <div>
          <p className="mono" style={{fontSize:"0.56rem",color:"#a8a29e",letterSpacing:".08em",textTransform:"uppercase",marginBottom:5}}>Quick Tap</p>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7}}>
            {quickTapCats.map(cat=><EnvCard key={cat.id} cat={cat} />)}
          </div>
        </div>
      )}

      {/* All budgeted envelopes — same order as Budget tab */}
      {otherCats.length > 0 && (
        <div>
          <p className="mono" style={{fontSize:"0.56rem",color:"#a8a29e",letterSpacing:".08em",textTransform:"uppercase",marginBottom:5}}>All Envelopes</p>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            {otherCats.map(cat=><EnvCard key={cat.id} cat={cat} />)}
          </div>
        </div>
      )}

    </div>
  );
}

// ─── DashboardView ────────────────────────────────────────────────────────────
function DashboardView({ totalIncome,totalSpent,remaining,budgets,spentByCat,pieData,barData,monthTx,onViewAll,allTransactions,selectedYear,selectedMonth,monthlyIncome }) {
  const [dashMode,setDashMode] = useState("monthly"); // "monthly" | "yearly"
  const nowDate = new Date();

  // ── Yearly stats ──
  const yearTx     = (allTransactions||[]).filter(t=>new Date(t.date).getFullYear()===selectedYear);
  const yearExp    = yearTx.filter(t=>t.type==="expense");
  const yearInc    = yearTx.filter(t=>t.type==="income");
  const yearSpent  = yearExp.reduce((s,t)=>s+t.amount,0);
  const yearIncome = yearInc.reduce((s,t)=>s+t.amount,0)||(monthlyIncome*12);
  const yearRemain = yearIncome - yearSpent;

  const yearSpentByCat={};
  CATEGORIES.forEach(c=>{yearSpentByCat[c.id]=0;});
  yearExp.forEach(t=>{yearSpentByCat[t.category]=(yearSpentByCat[t.category]||0)+t.amount;});

  const yearBarData = MONTHS.map((m,i)=>{
    const txm=(allTransactions||[]).filter(t=>{const d=new Date(t.date);return d.getMonth()===i&&d.getFullYear()===selectedYear&&t.type==="expense";});
    return {month:m,spent:parseFloat(txm.reduce((s,t)=>s+t.amount,0).toFixed(2))};
  });

  // ── Trend predictions (last 3 complete months) ──
  const predictions = (() => {
    const samples=[];
    for(let i=1;i<=3;i++){
      const offset=selectedMonth-i;
      const m=((offset%12)+12)%12;
      const y=offset<0?selectedYear-1:selectedYear;
      const txm=(allTransactions||[]).filter(t=>{const d=new Date(t.date);return d.getMonth()===m&&d.getFullYear()===y&&t.type==="expense";});
      samples.push(txm.reduce((s,t)=>s+t.amount,0));
    }
    const avgMonthly=samples.reduce((a,b)=>a+b,0)/samples.length;
    const monthsLeft=selectedYear===nowDate.getFullYear()?Math.max(0,11-nowDate.getMonth()):0;
    const projectedYearEnd=yearSpent+avgMonthly*monthsLeft;
    const catAvgs={};
    MONTHLY_BUDGET_CATS.forEach(cat=>{
      let total=0;
      for(let i=1;i<=3;i++){
        const offset=selectedMonth-i;
        const m=((offset%12)+12)%12;
        const y=offset<0?selectedYear-1:selectedYear;
        total+=(allTransactions||[]).filter(t=>{const d=new Date(t.date);return d.getMonth()===m&&d.getFullYear()===y&&t.type==="expense"&&t.category===cat.id;}).reduce((s,t)=>s+t.amount,0);
      }
      catAvgs[cat.id]=total/3;
    });
    return {avgMonthly,monthsLeft,projectedYearEnd,catAvgs,hasSamples:samples.some(s=>s>0)};
  })();

  return (
    <div style={{display:"flex",flexDirection:"column",gap:18}}>

      {/* Tab toggle */}
      <div style={{display:"flex",gap:6}}>
        {[["monthly","Monthly"],["yearly","Yearly"]].map(([mode,label])=>(
          <button key={mode} onClick={()=>setDashMode(mode)}
            style={{padding:"5px 16px",borderRadius:7,border:"1px solid #e7e5e4",background:dashMode===mode?"#1c1917":"#fff",color:dashMode===mode?"#fff":"#78716c",cursor:"pointer",fontSize:"0.78rem",fontFamily:"DM Mono,monospace",fontWeight:dashMode===mode?600:400}}>
            {label}
          </button>
        ))}
      </div>

      {/* ══ MONTHLY VIEW ══ */}
      {dashMode==="monthly" && (<>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:12}}>
          {[
            {label:"Income",    value:fmt(totalIncome), sub:"this month",                                                        accent:"#065f46"},
            {label:"Spent",     value:fmt(totalSpent),  sub:`${totalIncome?Math.round(totalSpent/totalIncome*100):0}% of income`, accent:totalSpent>totalIncome?"#be123c":"#1c1917"},
            {label:"Remaining", value:fmt(remaining),   sub:remaining>=0?"available":"over budget",                              accent:remaining>=0?"#065f46":"#be123c"},
            {label:"Budgeted",  value:fmt(Object.values(budgets).reduce((a,b)=>a+b,0)), sub:"allocated",                        accent:"#1c1917"},
          ].map(s=>(
            <div key={s.label} className="stat-card">
              <p className="mono" style={{fontSize:"0.64rem",color:"#a8a29e",letterSpacing:".08em",textTransform:"uppercase",marginBottom:7}}>{s.label}</p>
              <p className="pf"   style={{fontSize:"1.4rem",fontWeight:700,color:s.accent}}>{s.value}</p>
              <p className="mono" style={{fontSize:"0.65rem",color:"#78716c",marginTop:3}}>{s.sub}</p>
            </div>
          ))}
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <div className="card">
            <p className="pf" style={{fontSize:"0.95rem",fontStyle:"italic",marginBottom:12}}>Spending by Category</p>
            {pieData.length>0 ? (
              <ResponsiveContainer width="100%" height={210}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" outerRadius={78} innerRadius={32} dataKey="value" paddingAngle={2}>
                    {pieData.map((e,i)=><Cell key={i} fill={e.color} />)}
                  </Pie>
                  <Tooltip formatter={(v)=>fmt(v)} contentStyle={{fontFamily:"DM Mono,monospace",fontSize:"0.72rem",border:"1px solid #e7e5e4",borderRadius:6}} />
                  <Legend iconType="circle" iconSize={7} wrapperStyle={{fontFamily:"DM Mono,monospace",fontSize:"0.67rem"}} />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className="mono" style={{color:"#a8a29e",fontSize:"0.76rem"}}>No expenses yet.</p>}
          </div>
          <div className="card">
            <p className="pf" style={{fontSize:"0.95rem",fontStyle:"italic",marginBottom:12}}>6-Month Spending</p>
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={barData} margin={{top:4,right:4,bottom:0,left:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f5f0eb" />
                <XAxis dataKey="month" tick={{fontFamily:"DM Mono,monospace",fontSize:9}} />
                <YAxis tick={{fontFamily:"DM Mono,monospace",fontSize:9}} tickFormatter={v=>`$${v}`} width={55} />
                <Tooltip formatter={(v)=>fmt(v)} contentStyle={{fontFamily:"DM Mono,monospace",fontSize:"0.72rem",border:"1px solid #e7e5e4",borderRadius:6}} />
                <Bar dataKey="spent" fill="#b45309" radius={[4,4,0,0]} name="Spent" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h2 className="pf" style={{fontSize:"1rem",marginBottom:16,fontStyle:"italic"}}>Budget vs. Actual</h2>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {MONTHLY_BUDGET_CATS.map(cat=>{
              const spent=spentByCat[cat.id]||0;
              const budget=budgets[cat.id]||0;
              if(!spent&&!budget) return null;
              const pct=budget>0?Math.min(spent/budget,1):0;
              const over=spent>budget&&budget>0;
              return (
                <div key={cat.id}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{display:"flex",alignItems:"center",gap:7,fontSize:"0.84rem"}}>
                      <Bi name={cat.icon} style={{color:cat.color,fontSize:"0.85rem"}} /><span>{cat.label}</span>
                    </span>
                    <span className="mono" style={{fontSize:"0.75rem",color:over?"#be123c":"#78716c"}}>
                      {fmt(spent)} / {fmt(budget)}{over&&<span style={{color:"#be123c",marginLeft:5,fontSize:"0.65rem"}}>▲</span>}
                    </span>
                  </div>
                  <div className="pbar"><div className="pbar-fill" style={{width:`${pct*100}%`,background:over?"#be123c":cat.color}} /></div>
                </div>
              );
            }).filter(Boolean)}
          </div>
        </div>

        {/* Trend Predictions */}
        {predictions.hasSamples && (
          <div className="card">
            <h2 className="pf" style={{fontSize:"1rem",marginBottom:4,fontStyle:"italic"}}>Spending Forecast</h2>
            <p className="mono" style={{fontSize:"0.67rem",color:"#a8a29e",marginBottom:14}}>Based on your 3-month average · {fmt(predictions.avgMonthly)}/mo</p>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:12,marginBottom:16}}>
              <div className="stat-card">
                <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:6}}>Avg / Month</p>
                <p className="pf" style={{fontSize:"1.2rem",fontWeight:700,color:"#b45309"}}>{fmt(predictions.avgMonthly)}</p>
                <p className="mono" style={{fontSize:"0.63rem",color:"#78716c",marginTop:3}}>last 3 months</p>
              </div>
              {selectedYear===nowDate.getFullYear()&&(
                <div className="stat-card">
                  <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:6}}>Projected Year-End</p>
                  <p className="pf" style={{fontSize:"1.2rem",fontWeight:700,color:predictions.projectedYearEnd>yearIncome?"#be123c":"#065f46"}}>{fmt(predictions.projectedYearEnd)}</p>
                  <p className="mono" style={{fontSize:"0.63rem",color:"#78716c",marginTop:3}}>{predictions.monthsLeft} months left</p>
                </div>
              )}
              <div className="stat-card">
                <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:6}}>Next Month Est.</p>
                <p className="pf" style={{fontSize:"1.2rem",fontWeight:700,color:"#1c1917"}}>{fmt(predictions.avgMonthly)}</p>
                <p className="mono" style={{fontSize:"0.63rem",color:"#78716c",marginTop:3}}>if trend holds</p>
              </div>
            </div>
            <p className="pf" style={{fontSize:"0.84rem",marginBottom:10,color:"#78716c"}}>Category forecasts (next month):</p>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {MONTHLY_BUDGET_CATS.filter(cat=>predictions.catAvgs[cat.id]>0).sort((a,b)=>predictions.catAvgs[b.id]-predictions.catAvgs[a.id]).slice(0,8).map(cat=>{
                const avg=predictions.catAvgs[cat.id];
                const budget=budgets[cat.id]||0;
                const pct=budget>0?Math.min(avg/budget,1):0;
                const over=avg>budget&&budget>0;
                return (
                  <div key={cat.id}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <span style={{display:"flex",alignItems:"center",gap:6,fontSize:"0.82rem"}}>
                        <Bi name={cat.icon} style={{color:cat.color,fontSize:"0.82rem"}} /><span>{cat.label}</span>
                      </span>
                      <span className="mono" style={{fontSize:"0.73rem",color:over?"#be123c":"#78716c"}}>
                        {fmt(avg)} est{budget>0?` / ${fmt(budget)} budget`:""}
                        {over&&<span style={{color:"#be123c",marginLeft:5,fontSize:"0.63rem"}}>▲</span>}
                      </span>
                    </div>
                    {budget>0&&<div className="pbar"><div className="pbar-fill" style={{width:`${pct*100}%`,background:over?"#be123c":cat.color,opacity:0.65}} /></div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:13}}>
            <h2 className="pf" style={{fontSize:"1rem",fontStyle:"italic"}}>Recent Transactions</h2>
            <button className="btn btn-ghost btn-sm" onClick={onViewAll}>View All →</button>
          </div>
          {monthTx.slice(0,6).map(t=><TxRow key={t.id} t={t} compact />)}
          {monthTx.length===0 && <p className="mono" style={{color:"#a8a29e",fontSize:"0.76rem"}}>No transactions this month.</p>}
        </div>
      </>)}

      {/* ══ YEARLY VIEW ══ */}
      {dashMode==="yearly" && (<>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:12}}>
          {[
            {label:"Annual Income", value:fmt(yearIncome),  sub:`${selectedYear}`,                                                          accent:"#065f46"},
            {label:"Annual Spent",  value:fmt(yearSpent),   sub:`${yearIncome?Math.round(yearSpent/yearIncome*100):0}% of income`,           accent:yearSpent>yearIncome?"#be123c":"#1c1917"},
            {label:"Annual Net",    value:fmt(yearRemain),  sub:yearRemain>=0?"saved this year":"over budget",                              accent:yearRemain>=0?"#065f46":"#be123c"},
            {label:"Monthly Avg",   value:fmt(yearSpent/Math.max(1,yearBarData.filter(r=>r.spent>0).length)), sub:"avg monthly spend",      accent:"#b45309"},
          ].map(s=>(
            <div key={s.label} className="stat-card">
              <p className="mono" style={{fontSize:"0.64rem",color:"#a8a29e",letterSpacing:".08em",textTransform:"uppercase",marginBottom:7}}>{s.label}</p>
              <p className="pf"   style={{fontSize:"1.4rem",fontWeight:700,color:s.accent}}>{s.value}</p>
              <p className="mono" style={{fontSize:"0.65rem",color:"#78716c",marginTop:3}}>{s.sub}</p>
            </div>
          ))}
        </div>

        <div className="card">
          <p className="pf" style={{fontSize:"0.95rem",fontStyle:"italic",marginBottom:12}}>Monthly Spending — {selectedYear}</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={yearBarData} margin={{top:4,right:4,bottom:0,left:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f5f0eb" />
              <XAxis dataKey="month" tick={{fontFamily:"DM Mono,monospace",fontSize:9}} />
              <YAxis tick={{fontFamily:"DM Mono,monospace",fontSize:9}} tickFormatter={v=>`$${v}`} width={55} />
              <Tooltip formatter={(v)=>fmt(v)} contentStyle={{fontFamily:"DM Mono,monospace",fontSize:"0.72rem",border:"1px solid #e7e5e4",borderRadius:6}} />
              <Bar dataKey="spent" fill="#b45309" radius={[4,4,0,0]} name="Spent" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <div className="card">
            <p className="pf" style={{fontSize:"0.95rem",fontStyle:"italic",marginBottom:12}}>Annual Spending by Category</p>
            {CATEGORIES.filter(c=>c.id!=="income"&&yearSpentByCat[c.id]>0).length>0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={CATEGORIES.filter(c=>c.id!=="income"&&yearSpentByCat[c.id]>0).map(c=>({name:c.label,value:parseFloat(yearSpentByCat[c.id].toFixed(2)),color:c.color}))}
                    cx="50%" cy="50%" outerRadius={80} innerRadius={34} dataKey="value" paddingAngle={2}>
                    {CATEGORIES.filter(c=>c.id!=="income"&&yearSpentByCat[c.id]>0).map((c,i)=><Cell key={i} fill={c.color} />)}
                  </Pie>
                  <Tooltip formatter={(v)=>fmt(v)} contentStyle={{fontFamily:"DM Mono,monospace",fontSize:"0.72rem",border:"1px solid #e7e5e4",borderRadius:6}} />
                  <Legend iconType="circle" iconSize={7} wrapperStyle={{fontFamily:"DM Mono,monospace",fontSize:"0.67rem"}} />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className="mono" style={{color:"#a8a29e",fontSize:"0.76rem"}}>No data for {selectedYear}.</p>}
          </div>
          <div className="card">
            <p className="pf" style={{fontSize:"0.95rem",fontStyle:"italic",marginBottom:12}}>Annual Budget vs. Actual</p>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {MONTHLY_BUDGET_CATS.map(cat=>{
                const spent=yearSpentByCat[cat.id]||0;
                const annualBudget=(budgets[cat.id]||0)*12;
                if(!spent&&!annualBudget) return null;
                const pct=annualBudget>0?Math.min(spent/annualBudget,1):0;
                const over=spent>annualBudget&&annualBudget>0;
                return (
                  <div key={cat.id}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <span style={{display:"flex",alignItems:"center",gap:6,fontSize:"0.81rem"}}>
                        <Bi name={cat.icon} style={{color:cat.color,fontSize:"0.81rem"}} /><span>{cat.label}</span>
                      </span>
                      <span className="mono" style={{fontSize:"0.71rem",color:over?"#be123c":"#78716c"}}>
                        {fmt(spent)} / {fmt(annualBudget)}{over&&<span style={{color:"#be123c",marginLeft:4,fontSize:"0.63rem"}}>▲</span>}
                      </span>
                    </div>
                    <div className="pbar"><div className="pbar-fill" style={{width:`${pct*100}%`,background:over?"#be123c":cat.color}} /></div>
                  </div>
                );
              }).filter(Boolean)}
            </div>
          </div>
        </div>

        {/* Year-end forecast */}
        {predictions.hasSamples && selectedYear===nowDate.getFullYear() && (
          <div className="card">
            <h2 className="pf" style={{fontSize:"1rem",marginBottom:4,fontStyle:"italic"}}>Year-End Forecast</h2>
            <p className="mono" style={{fontSize:"0.67rem",color:"#a8a29e",marginBottom:14}}>Projection based on {fmt(predictions.avgMonthly)}/mo average · {predictions.monthsLeft} months remaining</p>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:12}}>
              <div className="stat-card">
                <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:6}}>Spent So Far</p>
                <p className="pf" style={{fontSize:"1.2rem",fontWeight:700,color:"#1c1917"}}>{fmt(yearSpent)}</p>
                <p className="mono" style={{fontSize:"0.63rem",color:"#78716c",marginTop:3}}>{MONTHS[nowDate.getMonth()]} {selectedYear}</p>
              </div>
              <div className="stat-card">
                <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:6}}>Projected Total</p>
                <p className="pf" style={{fontSize:"1.2rem",fontWeight:700,color:predictions.projectedYearEnd>yearIncome?"#be123c":"#065f46"}}>{fmt(predictions.projectedYearEnd)}</p>
                <p className="mono" style={{fontSize:"0.63rem",color:"#78716c",marginTop:3}}>by Dec {selectedYear}</p>
              </div>
              <div className="stat-card">
                <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:6}}>Projected Surplus</p>
                <p className="pf" style={{fontSize:"1.2rem",fontWeight:700,color:yearIncome-predictions.projectedYearEnd>=0?"#065f46":"#be123c"}}>{fmt(Math.abs(yearIncome-predictions.projectedYearEnd))}</p>
                <p className="mono" style={{fontSize:"0.63rem",color:"#78716c",marginTop:3}}>{yearIncome-predictions.projectedYearEnd>=0?"on track":"projected over"}</p>
              </div>
            </div>
          </div>
        )}
      </>)}
    </div>
  );
}

// ─── ReconcileView ────────────────────────────────────────────────────────────
// Shows all transactions for the month + envelope vs. actual comparison.
// This is where you upload your credit card CSV to verify spending matches envelopes.
function ReconcileViewLegacy({ transactions, onUpdateCat, onDelete, month, spentByCat, budgets, onImportCSV, onLearnCategoryEdits }) {
  const [filter,setFilter] = useState("all");
  const visible = filter==="all" ? transactions : transactions.filter(t=>t.category===filter);

  const csvTx     = transactions.filter(t=>t.source==="csv");
  const manualTx  = transactions.filter(t=>t.source==="manual"&&t.type==="expense");
  const csvTotal  = csvTx.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0);
  const envTotal  = manualTx.reduce((s,t)=>s+t.amount,0);
  const diff      = Math.abs(csvTotal - envTotal);
  const inSync    = diff < 1;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Reconciliation summary */}
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,gap:10,flexWrap:"wrap"}}>
          <h2 className="pf" style={{fontSize:"1.05rem",fontStyle:"italic"}}>Reconciliation — {month}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onImportCSV}>⬆ Import CSV</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:14}}>
          <div>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:4}}>Envelope Logged</p>
            <p className="pf" style={{fontSize:"1.3rem",fontWeight:700,color:"#1e40af"}}>{fmt(envTotal)}</p>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",marginTop:2}}>{manualTx.length} manual entries</p>
          </div>
          <div>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:4}}>Card Actual (CSV)</p>
            <p className="pf" style={{fontSize:"1.3rem",fontWeight:700,color:"#92400e"}}>{fmt(csvTotal)}</p>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",marginTop:2}}>{csvTx.length} imported entries</p>
          </div>
          <div>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:4}}>Difference</p>
            <p className="pf" style={{fontSize:"1.3rem",fontWeight:700,color:inSync?"#16a34a":"#be123c"}}>{inSync?"✓ In sync":fmt(diff)}</p>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",marginTop:2}}>
              {csvTx.length===0?"upload CSV to compare":inSync?"envelopes match card":"review transactions below"}
            </p>
          </div>
        </div>
        {csvTx.length===0 && (
          <p className="mono" style={{fontSize:"0.71rem",color:"#78716c",background:"#fef3c7",borderRadius:6,padding:"8px 12px",border:"1px solid #fde68a"}}>
            Use the ⬆ Import CSV button to upload your credit card CSV and compare your envelope totals against what actually hit your card.
          </p>
        )}
      </div>

      {/* Transaction list */}
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
          <h2 className="pf" style={{fontSize:"1.05rem",fontStyle:"italic"}}>All Transactions — {month}</h2>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span className="mono" style={{fontSize:"0.67rem",color:"#a8a29e"}}>{visible.length} entries</span>
            <select className="cat-sel" value={filter} onChange={e=>setFilter(e.target.value)} style={{width:"auto"}}>
              <option value="all">All Categories</option>
              {CATEGORIES.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
        </div>
        {visible.length===0&&<p className="mono" style={{color:"#a8a29e",fontSize:"0.76rem"}}>No transactions found.</p>}
        {visible.map(t=><TxRow key={t.id} t={t} onUpdateCat={onUpdateCat} onDelete={onDelete} />)}
      </div>
    </div>
  );
}

// ─── TxRow ────────────────────────────────────────────────────────────────────
function ReconcileView({ transactions, allTransactions, selectedMonth, selectedYear, onUpdateCat, onDelete, month, spentByCat, budgets, onImportCSV, onLearnCategoryEdits }) {
  const [filter,setFilter]     = useState("all");
  const [viewMode,setViewMode] = useState("month"); // "month" | "ytd" | "year"
  const selectedMonthIndex = Math.max(0, MONTHS.indexOf(selectedMonth));

  // When viewMode=ytd/year, pull all transactions for selected year
  const baseTx = viewMode==="month"
    ? transactions
    : (allTransactions||[])
        .filter(t=>{
          const d=new Date(t.date);
          if(d.getFullYear()!==selectedYear) return false;
          if(viewMode==="ytd") return d.getMonth()<=selectedMonthIndex;
          return true;
        })
        .sort((a,b)=>new Date(b.date)-new Date(a.date));

  const visible = filter==="all" ? baseTx : baseTx.filter(t=>t.category===filter);

  const csvTx    = baseTx.filter(t=>t.source==="csv");
  const manualTx = baseTx.filter(t=>t.source==="manual"&&t.type==="expense");
  const csvTotal = csvTx.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0);
  const envTotal = manualTx.reduce((s,t)=>s+t.amount,0);
  const diff     = Math.abs(csvTotal - envTotal);
  const inSync   = diff < 1;

  const viewLabel = viewMode==="year"
    ? `All of ${selectedYear}`
    : viewMode==="ytd"
      ? `YTD ${selectedYear} (${MONTHS[0]}-${selectedMonth})`
      : month;

  // For ytd/year view: group totals by month
  const monthlyBreakdown = (viewMode==="year" || viewMode==="ytd") ? MONTHS.map((m,i)=>{
    if (viewMode==="ytd" && i>selectedMonthIndex) return null;
    const mtx = baseTx.filter(t=>new Date(t.date).getMonth()===i);
    const spent = mtx.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0);
    const inc   = mtx.filter(t=>t.type==="income").reduce((s,t)=>s+t.amount,0);
    return {month:m, spent, income:inc, count:mtx.length};
  }).filter(Boolean).filter(r=>r.count>0) : null;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>

      {/* View mode toggle */}
      <div style={{display:"flex",gap:6,alignItems:"center"}}>
        <span className="mono" style={{fontSize:"0.67rem",color:"#a8a29e",marginRight:4}}>View:</span>
        <button
          onClick={()=>setViewMode("month")}
          style={{padding:"4px 12px",borderRadius:6,border:"1px solid #e7e5e4",background:viewMode==="month"?"#1c1917":"#fff",color:viewMode==="month"?"#fff":"#78716c",cursor:"pointer",fontSize:"0.78rem",fontFamily:"DM Mono,monospace"}}>
          {month}
        </button>
        <button
          onClick={()=>setViewMode("ytd")}
          style={{padding:"4px 12px",borderRadius:6,border:"1px solid #e7e5e4",background:viewMode==="ytd"?"#1c1917":"#fff",color:viewMode==="ytd"?"#fff":"#78716c",cursor:"pointer",fontSize:"0.78rem",fontFamily:"DM Mono,monospace"}}>
          YTD {selectedYear}
        </button>
        <button
          onClick={()=>setViewMode("year")}
          style={{padding:"4px 12px",borderRadius:6,border:"1px solid #e7e5e4",background:viewMode==="year"?"#1c1917":"#fff",color:viewMode==="year"?"#fff":"#78716c",cursor:"pointer",fontSize:"0.78rem",fontFamily:"DM Mono,monospace"}}>
          All of {selectedYear}
        </button>
      </div>

      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,gap:10,flexWrap:"wrap"}}>
          <h2 className="pf" style={{fontSize:"1.05rem",fontStyle:"italic"}}>Reconciliation — {viewLabel}</h2>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            {viewMode==="month"&&<button className="btn btn-ghost btn-sm" onClick={onLearnCategoryEdits}>Learn Category Edits</button>}
            {viewMode==="month"&&<button className="btn btn-ghost btn-sm" onClick={onImportCSV}>Import CSV</button>}
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:14}}>
          <div>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:4}}>Envelope Logged</p>
            <p className="pf" style={{fontSize:"1.3rem",fontWeight:700,color:"#1e40af"}}>{fmt(envTotal)}</p>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",marginTop:2}}>{manualTx.length} manual entries</p>
          </div>
          <div>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:4}}>Card Actual (CSV)</p>
            <p className="pf" style={{fontSize:"1.3rem",fontWeight:700,color:"#92400e"}}>{fmt(csvTotal)}</p>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",marginTop:2}}>{csvTx.length} imported entries</p>
          </div>
          <div>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em",marginBottom:4}}>Difference</p>
            <p className="pf" style={{fontSize:"1.3rem",fontWeight:700,color:inSync?"#16a34a":"#be123c"}}>{inSync?"In sync":fmt(diff)}</p>
            <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",marginTop:2}}>
              {csvTx.length===0?"upload CSV to compare":inSync?"envelopes match card":"review transactions below"}
            </p>
          </div>
        </div>
        {viewMode==="month"&&csvTx.length===0 && (
          <p className="mono" style={{fontSize:"0.71rem",color:"#78716c",background:"#fef3c7",borderRadius:6,padding:"8px 12px",border:"1px solid #fde68a"}}>
            Use Import CSV to upload your card data and compare totals.
          </p>
        )}
      </div>

      {/* Year view: monthly summary table */}
      {(viewMode==="year" || viewMode==="ytd") && monthlyBreakdown && monthlyBreakdown.length>0 && (
        <div className="card">
          <h2 className="pf" style={{fontSize:"1rem",fontStyle:"italic",marginBottom:12}}>
            Monthly Summary — {viewMode==="ytd" ? `YTD ${selectedYear}` : selectedYear}
          </h2>
          <div style={{display:"grid",gridTemplateColumns:"auto 1fr 1fr auto",gap:"6px 14px",alignItems:"center"}}>
            <span className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase"}}>Month</span>
            <span className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase",textAlign:"right"}}>Income</span>
            <span className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase",textAlign:"right"}}>Spent</span>
            <span className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",textTransform:"uppercase",textAlign:"right"}}>Txns</span>
            {monthlyBreakdown.map(r=>{
              const net=r.income-r.spent;
              return [
                <span key={r.month+"m"} className="mono" style={{fontSize:"0.78rem",color:"#1c1917",fontWeight:600}}>{r.month}</span>,
                <span key={r.month+"i"} className="mono" style={{fontSize:"0.78rem",color:"#065f46",textAlign:"right"}}>{fmt(r.income)}</span>,
                <span key={r.month+"s"} className="mono" style={{fontSize:"0.78rem",color:r.spent>r.income&&r.income>0?"#be123c":"#92400e",textAlign:"right"}}>{fmt(r.spent)}</span>,
                <span key={r.month+"c"} className="mono" style={{fontSize:"0.72rem",color:"#a8a29e",textAlign:"right"}}>{r.count}</span>,
              ];
            })}
          </div>
        </div>
      )}

      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
          <h2 className="pf" style={{fontSize:"1.05rem",fontStyle:"italic"}}>All Transactions — {viewLabel}</h2>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span className="mono" style={{fontSize:"0.67rem",color:"#a8a29e"}}>{visible.length} entries</span>
            <select className="cat-sel" value={filter} onChange={e=>setFilter(e.target.value)} style={{width:"auto"}}>
              <option value="all">All Categories</option>
              {CATEGORIES.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
        </div>
        {visible.length===0&&<p className="mono" style={{color:"#a8a29e",fontSize:"0.76rem"}}>No transactions found.</p>}
        {visible.map(t=><TxRow key={t.id} t={t} onUpdateCat={onUpdateCat} onDelete={onDelete} />)}
      </div>
    </div>
  );
}

function TxRow({ t, onUpdateCat, onDelete, compact }) {
  const cat=CATEGORIES.find(c=>c.id===t.category);
  return (
    <div className="tx-row">
      <div style={{width:7,height:7,borderRadius:"50%",background:cat?.color||"#ccc",flexShrink:0}} />
      {cat && <Bi name={cat.icon} style={{fontSize:"0.85rem",color:cat.color,flexShrink:0}} />}
      <div style={{flex:1,minWidth:0}}>
        <p style={{fontSize:"0.84rem",fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
          {t.description}
          {!compact&&<span className={`tag tag-${t.source}`}>{t.source}</span>}
        </p>
        <p className="mono" style={{fontSize:"0.65rem",color:"#a8a29e"}}>{t.date}</p>
      </div>
      {!compact&&onUpdateCat&&(
        <select className="cat-sel" value={t.category} onChange={e=>onUpdateCat(t.id,e.target.value)} style={{flexShrink:0,width:155}}>
          {CATEGORIES.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      )}
      <span className="mono" style={{fontSize:"0.86rem",fontWeight:500,color:t.type==="income"?"#065f46":"#1c1917",flexShrink:0,minWidth:74,textAlign:"right"}}>
        {t.type==="income"?"+":"-"}{fmt(t.amount)}
      </span>
      {onDelete&&<button className="btn-del" onClick={()=>onDelete(t.id)}>✕</button>}
    </div>
  );
}

// ─── BudgetsView ──────────────────────────────────────────────────────────────
function BudgetsView({ budgets, income, spentByCat, envelopeCategoryIds, subBudgets, onSave }) {
  const [lb,setLb]=useState({...budgets});
  const [li,setLi]=useState(income);
  const [le,setLe]=useState(normalizeEnvelopeCategoryIds(envelopeCategoryIds));
  const [lsb,setLsb]=useState(normalizeSubBudgets(subBudgets));
  const [newSubByCat,setNewSubByCat]=useState({});
  const [expandedBudgetIds,setExpandedBudgetIds]=useState({});
  const [newBudgetName,setNewBudgetName]=useState("");
  const [newBudgetAmount,setNewBudgetAmount]=useState("");
  const [newBudgetEnvelopeOn,setNewBudgetEnvelopeOn]=useState(true);

  const baseBudgetIdSet = new Set(MONTHLY_BUDGET_CATS.map(c=>c.id));
  const customBudgetCats = Object.keys(lb)
    .filter(id => id !== "income" && !baseBudgetIdSet.has(id))
    .sort((a,b) => a.localeCompare(b))
    .map(id => ({
      id,
      label: id
        .split(/[-_]+/)
        .map(part => part ? part.charAt(0).toUpperCase() + part.slice(1) : "")
        .join(" ")
        .trim() || id,
      icon: "•",
      color: "#6b7280",
      isCustom: true,
    }));
  const budgetCats = [
    ...MONTHLY_BUDGET_CATS.map(cat => ({ ...cat, isCustom:false })),
    ...customBudgetCats,
  ];

  const total=budgetCats.reduce((sum, cat)=>sum+(lb[cat.id]||0),0);
  const surplus=li-total;

  useEffect(() => {
    setLb({ ...budgets });
    setLi(income);
    setLe(normalizeEnvelopeCategoryIds(envelopeCategoryIds));
    setLsb(normalizeSubBudgets(subBudgets));
    setNewSubByCat({});
    setExpandedBudgetIds({});
    setNewBudgetName("");
    setNewBudgetAmount("");
    setNewBudgetEnvelopeOn(true);
  }, [budgets, income, envelopeCategoryIds, subBudgets]);

  function toggleEnvelopeCategory(catId) {
    setLe(current => current.includes(catId)
      ? current.filter(id => id !== catId)
      : [...current, catId]
    );
  }

  function updateSubBudget(catId, subId, value) {
    const amount = Math.max(0, parseFloat(value) || 0);
    setLsb(current => ({
      ...current,
      [catId]: (current[catId] || []).map(item => item.id===subId ? { ...item, amount } : item),
    }));
  }

  function toggleSubBudgetEnvelope(catId, subId) {
    setLsb(current => ({
      ...current,
      [catId]: (current[catId] || []).map(item => item.id===subId ? { ...item, envelopeOn: !item.envelopeOn } : item),
    }));
  }

  function addSubBudget(catId) {
    const raw = String(newSubByCat[catId] || "").trim();
    if (!raw) return;
    const id = raw.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
    if (!id) return;
    setLsb(current => {
      const existing = current[catId] || [];
      if (existing.some(item => item.id === id)) return current;
      return {
        ...current,
        [catId]: [...existing, { id, label: raw, amount:0, envelopeOn:false }],
      };
    });
    setNewSubByCat(current => ({ ...current, [catId]:"" }));
  }

  function deleteSubBudget(catId, subId) {
    setLsb(current => ({
      ...current,
      [catId]: (current[catId] || []).filter(item => item.id !== subId),
    }));
  }

  function toggleBudgetExpanded(catId) {
    setExpandedBudgetIds(current => ({ ...current, [catId]: !current[catId] }));
  }

  function makeBudgetId(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g,"-")
      .replace(/^-+|-+$/g,"");
  }

  function addBudgetItem() {
    const rawName = String(newBudgetName || "").trim();
    const id = makeBudgetId(rawName);
    if (!id) return;
    if (baseBudgetIdSet.has(id) || Object.prototype.hasOwnProperty.call(lb, id)) return;
    const amount = Math.max(0, parseFloat(newBudgetAmount) || 0);
    setLb(current => ({ ...current, [id]: amount }));
    if (newBudgetEnvelopeOn) {
      setLe(current => current.includes(id) ? current : [...current, id]);
    }
    setNewBudgetName("");
    setNewBudgetAmount("");
    setNewBudgetEnvelopeOn(true);
  }

  function deleteBudgetItem(catId) {
    if (baseBudgetIdSet.has(catId)) return;
    setLb(current => {
      const next = { ...current };
      delete next[catId];
      return next;
    });
    setLe(current => current.filter(id => id !== catId));
    setLsb(current => {
      const next = { ...current };
      delete next[catId];
      return next;
    });
    setNewSubByCat(current => {
      const next = { ...current };
      delete next[catId];
      return next;
    });
  }

  function colorWithAlpha(hex, alpha) {
    const raw = String(hex || "").replace("#", "");
    if (raw.length !== 6) return `rgba(107,114,128,${alpha})`;
    const r = parseInt(raw.slice(0,2), 16);
    const g = parseInt(raw.slice(2,4), 16);
    const b = parseInt(raw.slice(4,6), 16);
    if ([r,g,b].some(Number.isNaN)) return `rgba(107,114,128,${alpha})`;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  return (
    <div style={{maxWidth:540,margin:"0 auto"}}>
      <div className="card">
        <h2 className="pf" style={{fontSize:"1.05rem",marginBottom:18,fontStyle:"italic"}}>Monthly Budgets</h2>
        <div style={{marginBottom:16}}><label>Monthly Income (base)</label>
          <input type="number" value={li} onChange={e=>setLi(parseFloat(e.target.value)||0)} />
        </div>
        <p className="mono" style={{fontSize:"0.66rem",color:"#78716c",marginBottom:14,lineHeight:1.6}}>
          Choose which budget categories show up in Envelopes. Use `Fixed / Hidden` for bills or categories you do not need quick-spend cards for.
        </p>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {budgetCats.map(cat=>{
            const spent=spentByCat[cat.id]||0;
            const subItems = lsb[cat.id] || [];
            const subTotal = subItems.reduce((sum, item)=>sum+(item.amount||0),0);
            const budget=lb[cat.id]||0;
            const over=spent>budget&&budget>0;
            return (
              <div
                key={cat.id}
                style={{
                  border: "1px solid #e7e5e4",
                  borderTop: `3px solid ${colorWithAlpha(cat.color, 0.65)}`,
                  borderRadius: 10,
                  padding: "10px 10px 8px",
                }}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <Bi name={cat.icon} style={{fontSize:"0.9rem",color:cat.color,width:20,flexShrink:0}} />
                  <button
                    type="button"
                    onClick={()=>toggleBudgetExpanded(cat.id)}
                    style={{
                      flex:1,
                      background:"none",
                      border:"none",
                      padding:0,
                      margin:0,
                      textAlign:"left",
                      cursor:"pointer",
                      color:"#1c1917",
                      fontSize:"0.84rem",
                    }}>
                    {cat.label}
                    <span className="mono" style={{marginLeft:6,fontSize:"0.62rem",color:"#a8a29e"}}>
                      {expandedBudgetIds[cat.id] ? "hide sub" : "sub budgets"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={()=>toggleEnvelopeCategory(cat.id)}
                    style={{
                      border:"1px solid",
                      borderColor:le.includes(cat.id) ? "#b45309" : "#d6d3d1",
                      background:le.includes(cat.id) ? "#fff7ed" : "#fff",
                      color:le.includes(cat.id) ? "#b45309" : "#78716c",
                      borderRadius:99,
                      padding:"4px 8px",
                      cursor:"pointer",
                      fontFamily:"DM Mono,monospace",
                      fontSize:"0.6rem",
                      letterSpacing:".04em",
                      flexShrink:0,
                    }}>
                    {le.includes(cat.id) ? "Envelope On" : "Fixed / Hidden"}
                  </button>
                  <input type="number" min="0" style={{width:108,textAlign:"right"}}
                    value={budget}
                    onChange={e=>setLb(b=>({...b,[cat.id]:parseFloat(e.target.value)||0}))} />
                  {cat.isCustom && (
                    <button className="btn-del" onClick={()=>deleteBudgetItem(cat.id)} title="Delete budget item">×</button>
                  )}
                </div>
                {budget>0&&(
                  <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4,paddingLeft:30}}>
                    <div style={{flex:1,background:"#f5f0eb",borderRadius:99,height:4,overflow:"hidden"}}>
                      <div style={{width:`${Math.min(spent/budget,1)*100}%`,height:"100%",background:over?"#be123c":cat.color,borderRadius:99}} />
                    </div>
                    <span className="mono" style={{fontSize:"0.64rem",color:over?"#be123c":"#a8a29e",whiteSpace:"nowrap"}}>
                      {fmt(spent)} / {fmt(budget)}
                    </span>
                  </div>
                )}
                {(expandedBudgetIds[cat.id] || subItems.length > 0) && (
                  <div style={{marginTop:8,paddingLeft:30,display:"flex",flexDirection:"column",gap:6}}>
                    <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",letterSpacing:".04em",textTransform:"uppercase"}}>
                      Sub-budgets ({fmt(subTotal)} of {fmt(budget)})
                    </p>
                    {subItems.map(item=>(
                      <div key={item.id} style={{display:"flex",alignItems:"center",gap:8}}>
                        <span className="mono" style={{flex:1,fontSize:"0.74rem",color:"#78716c"}}>{item.label}</span>
                        <button
                          type="button"
                          onClick={()=>toggleSubBudgetEnvelope(cat.id, item.id)}
                          style={{
                            border:"1px solid",
                            borderColor:item.envelopeOn ? "#b45309" : "#d6d3d1",
                            background:item.envelopeOn ? "#fff7ed" : "#fff",
                            color:item.envelopeOn ? "#b45309" : "#78716c",
                            borderRadius:99,
                            padding:"3px 8px",
                            cursor:"pointer",
                            fontFamily:"DM Mono,monospace",
                            fontSize:"0.58rem",
                            letterSpacing:".04em",
                            flexShrink:0,
                          }}>
                          {item.envelopeOn ? "Envelope On" : "Fixed / Hidden"}
                        </button>
                        <input
                          type="number"
                          min="0"
                          style={{width:108,textAlign:"right"}}
                          value={item.amount ?? 0}
                          onChange={e=>updateSubBudget(cat.id, item.id, e.target.value)}
                        />
                        <button className="btn-del" onClick={()=>deleteSubBudget(cat.id, item.id)} title="Delete sub budget">×</button>
                      </div>
                    ))}
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <input
                        type="text"
                        placeholder="Add sub budget (e.g. Church Camp)"
                        value={newSubByCat[cat.id] || ""}
                        onChange={e=>setNewSubByCat(current=>({ ...current, [cat.id]:e.target.value }))}
                        onKeyDown={e=>{ if (e.key==="Enter") addSubBudget(cat.id); }}
                        style={{flex:1}}
                      />
                      <button className="btn btn-ghost btn-sm" onClick={()=>addSubBudget(cat.id)}>Add</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{marginTop:14,paddingTop:14,borderTop:"1px dashed #e7e5e4",display:"flex",flexDirection:"column",gap:8}}>
          <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",letterSpacing:".04em",textTransform:"uppercase"}}>Add Budget Item</p>
          <div style={{display:"grid",gridTemplateColumns:"1fr 110px auto auto",gap:8,alignItems:"center"}}>
            <input
              type="text"
              placeholder="Name (e.g. Home Repairs)"
              value={newBudgetName}
              onChange={e=>setNewBudgetName(e.target.value)}
              onKeyDown={e=>{ if (e.key==="Enter") addBudgetItem(); }}
            />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={newBudgetAmount}
              onChange={e=>setNewBudgetAmount(e.target.value)}
              onKeyDown={e=>{ if (e.key==="Enter") addBudgetItem(); }}
              style={{textAlign:"right"}}
            />
            <button
              type="button"
              onClick={()=>setNewBudgetEnvelopeOn(v=>!v)}
              style={{
                border:"1px solid",
                borderColor:newBudgetEnvelopeOn ? "#b45309" : "#d6d3d1",
                background:newBudgetEnvelopeOn ? "#fff7ed" : "#fff",
                color:newBudgetEnvelopeOn ? "#b45309" : "#78716c",
                borderRadius:99,
                padding:"4px 8px",
                cursor:"pointer",
                fontFamily:"DM Mono,monospace",
                fontSize:"0.58rem",
                letterSpacing:".04em",
                whiteSpace:"nowrap",
              }}
            >
              {newBudgetEnvelopeOn ? "Envelope On" : "Fixed / Hidden"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={addBudgetItem}>Add</button>
          </div>
          <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e"}}>
            Built-in categories cannot be deleted. Custom categories can be removed with the × button.
          </p>
        </div>
        <div style={{marginTop:18,paddingTop:14,borderTop:"1px solid #f5f0eb",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <p className="mono" style={{fontSize:"0.65rem",color:"#a8a29e",textTransform:"uppercase",letterSpacing:".07em"}}>Total Budgeted</p>
            <p className="mono" style={{fontSize:"1.05rem",fontWeight:500}}>{fmt(total)}</p>
            <p className="mono" style={{fontSize:"0.7rem",color:surplus>=0?"#065f46":"#be123c",marginTop:2}}>
              {surplus>=0?"+":""}{fmt(surplus)} unallocated
            </p>
          </div>
          <button className="btn btn-amber" onClick={()=>onSave(lb,li,le,lsb)}>Save Budgets</button>
        </div>
      </div>
    </div>
  );
}

function splitCSVLine(line) {
  const parts = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQ && line[i + 1] === "\"") {
        cur += "\"";
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (ch === "," && !inQ) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function parseKeywordMapCSV(text) {
  const lines = text.trim().split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const header = splitCSVLine(lines[0]).map(h => h.toLowerCase());
  const keywordIdx = header.findIndex(h => h === "keyword");
  const labelIdx = header.findIndex(h => h.includes("suggested budget label"));
  const deleteIdx = header.findIndex(h => h === "delete");
  if (keywordIdx === -1 || labelIdx === -1 || deleteIdx === -1) return null;

  const parsed = Object.fromEntries(Object.keys(DEFAULT_KEYWORDS).map(k => [k, []]));
  let imported = 0;
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    const keyword = (cols[keywordIdx] || "").toLowerCase().trim();
    const label = (cols[labelIdx] || "").toLowerCase().trim();
    const del = (cols[deleteIdx] || "").toLowerCase().trim();
    if (!keyword || del === "true") continue;
    const cat = BUDGET_CAT_MAP[label];
    if (!cat || !(cat in parsed)) {
      skipped++;
      continue;
    }
    parsed[cat].push(keyword);
    imported++;
  }

  Object.keys(parsed).forEach(cat => {
    parsed[cat] = [...new Set(parsed[cat])];
  });

  return { keywords: parsed, imported, skipped };
}

// ─── TaxTaskerView ────────────────────────────────────────────────────────────
function TaxTaskerView({ items, onUpdateItem, onAddItem, onDeleteItem, taxYear }) {
  const [groupFilter,setGroupFilter] = useState("All");
  const [expandedNotes,setExpandedNotes] = useState({});
  const [addForm,setAddForm] = useState(false);
  const [newItem,setNewItem] = useState({title:"",group:"Other",description:"",source:"Records"});

  const readyCount = items.filter(i=>i.status==="ready").length;
  const naCount    = items.filter(i=>i.status==="na").length;
  const pct        = items.length>0 ? Math.round(readyCount/items.length*100) : 0;
  const visible    = groupFilter==="All" ? items : items.filter(i=>i.group===groupFilter);
  const srcClass   = {Mail:"src-mail",Online:"src-online",Contact:"src-contact",Records:"src-records"};

  function cycleStatus(item){
    const next={pending:"ready",ready:"na",na:"pending"};
    onUpdateItem(item.id,{status:next[item.status]});
  }

  function handleAdd(){
    if(!newItem.title.trim()) return;
    onAddItem({id:"tx"+Date.now(),...newItem,status:"pending",notes:"",custom:true});
    setNewItem({title:"",group:"Other",description:"",source:"Records"});
    setAddForm(false);
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Header */}
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
          <div>
            <h2 className="pf" style={{fontSize:"1.2rem",fontStyle:"italic"}}>Tax Tasker</h2>
            <p className="mono" style={{fontSize:"0.68rem",color:"#78716c",marginTop:3}}>
              {taxYear} tax year · gather documents for Heather
            </p>
          </div>
          <div style={{textAlign:"right"}}>
            <p className="mono" style={{fontSize:"1.3rem",fontWeight:500,color:pct===100?"#16a34a":"#1c1917"}}>
              {readyCount} <span style={{color:"#a8a29e",fontSize:"0.9rem"}}>/ {items.length} ready</span>
            </p>
            {naCount>0&&<p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",marginTop:2}}>{naCount} marked N/A</p>}
          </div>
        </div>
        <div style={{marginTop:14}}>
          <div style={{background:"#f5f0eb",borderRadius:99,height:6,overflow:"hidden"}}>
            <div style={{width:`${pct}%`,height:"100%",background:pct===100?"#16a34a":"#1e40af",borderRadius:99,transition:"width .5s"}} />
          </div>
          <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",marginTop:5}}>{pct}% complete</p>
        </div>
        <div style={{display:"flex",gap:16,marginTop:12}}>
          {[{label:"○  Pending",color:"#d6d3d1"},{label:"✓  Ready",color:"#16a34a"},{label:"—  N/A",color:"#a8a29e"}].map(l=>(
            <span key={l.label} className="mono" style={{fontSize:"0.65rem",color:l.color}}>{l.label}</span>
          ))}
          <span className="mono" style={{fontSize:"0.65rem",color:"#78716c",marginLeft:"auto"}}>Click circle to cycle status</span>
        </div>
      </div>

      {/* Group filter */}
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {["All",...TAX_GROUPS].map(g=>{
          const count=g==="All"?items.length:items.filter(i=>i.group===g).length;
          const ready=g==="All"?readyCount:items.filter(i=>i.group===g&&i.status==="ready").length;
          return (
            <button key={g} className={`group-pill ${groupFilter===g?"active":""}`} onClick={()=>setGroupFilter(g)}>
              {g} · {ready}/{count}
            </button>
          );
        })}`r`n        </div>

      {/* Items */}
      <div>
        {visible.map(item=>{
          const notesOpen=expandedNotes[item.id];
          return (
            <div key={item.id} className="tax-item">
              <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                <button
                  className={`tax-status-btn ${item.status==="ready"?"ready":item.status==="na"?"na":""}`}
                  onClick={()=>cycleStatus(item)} title="Click to cycle: Pending → Ready → N/A"
                  style={{marginTop:2}}
                >
                  {item.status==="ready"?"✓":item.status==="na"?"—":""}
                </button>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                    <p style={{fontSize:"0.88rem",fontWeight:500,textDecoration:item.status==="na"?"line-through":"none",color:item.status==="na"?"#a8a29e":"#1c1917"}}>
                      {item.title}
                    </p>
                    <span className={`source-badge ${srcClass[item.source]||"src-records"}`}>{item.source}</span>
                    {item.custom&&<span style={{fontSize:"0.58rem",color:"#b45309",fontFamily:"DM Mono,monospace",letterSpacing:".04em"}}>CUSTOM</span>}
                  </div>
                  <p className="mono" style={{fontSize:"0.69rem",color:"#78716c",marginTop:3,lineHeight:1.5}}>{item.description}</p>
                  <div style={{marginTop:7}}>
                    <button onClick={()=>setExpandedNotes(p=>({...p,[item.id]:!p[item.id]}))}
                      style={{background:"none",border:"none",cursor:"pointer",fontFamily:"DM Mono,monospace",fontSize:"0.65rem",color:"#a8a29e",padding:0,letterSpacing:".03em"}}>
                      {notesOpen?"hide notes":`+ ${item.notes?"edit notes":"add notes"}`}
                      {item.notes&&!notesOpen&&<span style={{marginLeft:8,color:"#78716c"}}>"{item.notes.slice(0,40)}{item.notes.length>40?"…":""}"</span>}
                    </button>
                    {notesOpen&&(
                      <textarea
                        value={item.notes}
                        onChange={e=>onUpdateItem(item.id,{notes:e.target.value})}
                        placeholder="Add notes, account numbers, where to find it, etc."
                        rows={3} autoFocus
                        style={{display:"block",marginTop:6,width:"100%",border:"1.5px solid #e7e5e4",borderRadius:6,padding:"8px 10px",fontFamily:"DM Mono,monospace",fontSize:"0.75rem",background:"#faf7f2",color:"#1c1917",outline:"none",resize:"vertical",lineHeight:1.7}}
                      />
                    )}
                  </div>
                </div>
                {item.custom&&<button className="btn-del" onClick={()=>onDeleteItem(item.id)} style={{flexShrink:0,marginTop:2}}>✕</button>}
              </div>
            </div>
          );
        })}
        {visible.length===0&&<p className="mono" style={{color:"#a8a29e",fontSize:"0.76rem",padding:"16px 0"}}>No items in this group.</p>}
      </div>

      {/* Add custom */}
      {!addForm ? (
        <button className="btn btn-ghost" style={{alignSelf:"flex-start"}} onClick={()=>setAddForm(true)}>+ Add Custom Item</button>
      ) : (
        <div className="card" style={{borderColor:"#bfdbfe"}}>
          <h3 className="pf" style={{fontSize:"0.95rem",fontStyle:"italic",marginBottom:14}}>New Tax Item</h3>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div><label>Title</label>
              <input value={newItem.title} onChange={e=>setNewItem(n=>({...n,title:e.target.value}))} placeholder="e.g. HSA Contributions (Form 5498-SA)" autoFocus />
            </div>
            <div><label>Description (optional)</label>
              <input value={newItem.description} onChange={e=>setNewItem(n=>({...n,description:e.target.value}))} placeholder="Where to get it, why you need it, etc." />
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div><label>Group</label>
                <select value={newItem.group} onChange={e=>setNewItem(n=>({...n,group:e.target.value}))}>
                  {TAX_GROUPS.map(g=><option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div><label>Source</label>
                <select value={newItem.source} onChange={e=>setNewItem(n=>({...n,source:e.target.value}))}>
                  <option value="Mail">Mail</option><option value="Online">Online</option>
                  <option value="Contact">Contact</option><option value="Records">Records</option>
                </select>
              </div>
            </div>
            <div style={{display:"flex",gap:10,marginTop:4}}>
              <button className="btn btn-amber btn-sm" onClick={handleAdd}>Add Item</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>setAddForm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── KeywordsView ─────────────────────────────────────────────────────────────
function KeywordsView({ keywords, onSave, onReclassify, onImportMap }) {
  const [lk,setLk]=useState(Object.fromEntries(Object.entries(keywords).map(([k,v])=>[k,v.join(", ")])));
  const [active,setActive]=useState("groceries");
  const mapFileRef = useRef();

  useEffect(() => {
    setLk(Object.fromEntries(Object.entries(keywords).map(([k,v])=>[k,v.join(", ")])));
  }, [keywords]);

  function doSave(){
    const parsed=Object.fromEntries(Object.entries(lk).map(([k,v])=>[k,v.split(",").map(s=>s.trim()).filter(Boolean)]));
    onSave(parsed);
  }

  function importKeywordMapFile(file){
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const parsed = parseKeywordMapCSV(String(e.target?.result || ""));
      if (!parsed) return;
      onImportMap(parsed.keywords, { imported: parsed.imported, skipped: parsed.skipped });
    };
    reader.readAsText(file);
  }

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div>
          <h2 className="pf" style={{fontSize:"1.05rem",fontStyle:"italic"}}>Auto-Categorization Keywords</h2>
          <p className="mono" style={{fontSize:"0.68rem",color:"#78716c",marginTop:3}}>Matched against transaction descriptions when importing CSV.</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <input
            ref={mapFileRef}
            type="file"
            accept=".csv,text/csv"
            style={{display:"none"}}
            onChange={e=>{importKeywordMapFile(e.target.files?.[0]); e.target.value="";}}
          />
          <button className="btn btn-ghost btn-sm" onClick={()=>mapFileRef.current?.click()}>Import TransactionMap CSV</button>
          <button className="btn btn-ghost btn-sm" onClick={onReclassify}>Re-classify CSV Transactions</button>
          <button className="btn btn-amber btn-sm" onClick={doSave}>Save Keywords</button>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"160px 1fr",gap:14,alignItems:"start"}}>
        <div className="card" style={{padding:"10px 0"}}>
          {CATEGORIES.map(cat=>(
            <div key={cat.id} onClick={()=>setActive(cat.id)}
              style={{padding:"8px 14px",cursor:"pointer",fontSize:"0.82rem",display:"flex",alignItems:"center",gap:7,
                background:active===cat.id?"#fff8f0":"transparent",
                borderLeft:active===cat.id?"3px solid #b45309":"3px solid transparent",
                color:active===cat.id?"#b45309":"#1c1917",transition:"all .1s"}}>
              <Bi name={cat.icon} style={{fontSize:"0.78rem",flexShrink:0}} />
              <span>{cat.label}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
            {CATEGORIES.find(c=>c.id===active) && <Bi name={CATEGORIES.find(c=>c.id===active).icon} style={{fontSize:"1rem",color:CATEGORIES.find(c=>c.id===active).color}} />}
            <h3 className="pf" style={{fontSize:"1.05rem",fontStyle:"italic"}}>{CATEGORIES.find(c=>c.id===active)?.label}</h3>
          </div>
          <p className="mono" style={{fontSize:"0.68rem",color:"#a8a29e",marginBottom:10,lineHeight:1.7}}>
            Comma-separated keywords. Transaction descriptions are checked for these strings (case-insensitive).
          </p>
          <textarea
            value={lk[active]||""}
            onChange={e=>setLk(k=>({...k,[active]:e.target.value}))}
            rows={7}
            style={{width:"100%",border:"1.5px solid #d6d3d1",borderRadius:6,padding:"10px 12px",fontFamily:"DM Mono,monospace",fontSize:"0.78rem",background:"#faf7f2",color:"#1c1917",outline:"none",resize:"vertical",lineHeight:1.8}}
            placeholder="e.g. hy-vee, grocery, aldi, fareway"
          />
          <p className="mono" style={{fontSize:"0.65rem",color:"#a8a29e",marginTop:8}}>
            {(lk[active]||"").split(",").filter(s=>s.trim()).length} keywords defined
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── ImportPreview ────────────────────────────────────────────────────────────
function ImportPreview({ transactions, onConfirm, onCancel, onUpdateCat }) {
  const expenses=transactions.filter(t=>t.type==="expense");
  const total=expenses.reduce((s,t)=>s+t.amount,0);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div className="card" style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <div>
          <h2 className="pf" style={{fontSize:"1.1rem",fontStyle:"italic"}}>Review Import</h2>
          <p className="mono" style={{fontSize:"0.7rem",color:"#78716c",marginTop:4}}>
            {transactions.length} transactions · {expenses.length} expenses · {fmt(total)} total
          </p>
          <p className="mono" style={{fontSize:"0.67rem",color:"#0369a1",marginTop:6}}>
            After import, head to Reconcile to compare against your envelope logs.
          </p>
        </div>
        <div style={{display:"flex",gap:10}}>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
          <button className="btn btn-amber btn-sm" onClick={()=>onConfirm(transactions)}>Import All →</button>
        </div>
      </div>
      <div className="card">
        <p className="mono" style={{fontSize:"0.67rem",color:"#a8a29e",marginBottom:13,letterSpacing:".06em",textTransform:"uppercase"}}>Adjust categories before importing</p>
        {transactions.map(t=>{
          const cat=CATEGORIES.find(c=>c.id===t.category);
          const sv=isSplitVendor(t.description);
          const splits=sv?VENDOR_SPLITS[sv]:null;
          return (
            <div key={t.id} style={{borderBottom:"1px solid #f5f5f4"}}>
              <div className="tx-row" style={{borderBottom:"none"}}>
                {cat && <Bi name={cat.icon} style={{fontSize:"0.85rem",color:cat.color,flexShrink:0}} />}
                <div style={{flex:1,minWidth:0}}>
                  <p style={{fontSize:"0.82rem",fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                    {sv && <span style={{fontSize:"0.65rem",background:"#fef3c7",color:"#92400e",borderRadius:4,padding:"1px 5px",marginRight:5,fontWeight:600}}>SPLIT</span>}
                    {t.description}
                  </p>
                  <p className="mono" style={{fontSize:"0.65rem",color:"#a8a29e"}}>{t.date}</p>
                </div>
                <select className="cat-sel" value={t.category} onChange={e=>onUpdateCat(t.id,e.target.value)} style={{width:155,flexShrink:0}}>
                  {CATEGORIES.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                <span className="mono" style={{fontSize:"0.84rem",fontWeight:500,color:t.type==="income"?"#065f46":"#1c1917",flexShrink:0,minWidth:72,textAlign:"right"}}>
                  {t.type==="income"?"+":"-"}{fmt(t.amount)}
                </span>
              </div>
              {splits && (
                <div style={{paddingLeft:28,paddingBottom:8,display:"flex",flexWrap:"wrap",gap:6}}>
                  {Object.entries(splits).map(([cat,pct])=>(
                    <span key={cat} className="mono" style={{fontSize:"0.62rem",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:4,padding:"2px 6px",color:"#78350f"}}>
                      {cat} {Math.round(pct*100)}% · {fmt(t.amount*pct)}
                    </span>
                  ))}
                  <span className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",alignSelf:"center"}}>— adjust category manually</span>
                </div>
              )}
            </div>
          );
        })}`r`n        </div>
    </div>
  );
}

// ─── KidsLedgerView ────────────────────────────────────────────────────────────
function KidsLedgerView({ kids, onUpdateKids }) {
  const [activeKid, setActiveKid] = useState(kids[0]?.id);
  const [addChoreForm, setAddChoreForm] = useState(false);
  const [newChore, setNewChore] = useState({ name:"", rate:"" });
  const [editingChoreId, setEditingChoreId] = useState(null);
  const [editingChoreRate, setEditingChoreRate] = useState("");
  const [bucketAction, setBucketAction] = useState(null);
  const [bucketAmt, setBucketAmt] = useState("");
  const [bucketDesc, setBucketDesc] = useState("");

  const kid = kids.find(k=>k.id===activeKid);

  useEffect(() => {
    setEditingChoreId(null);
    setEditingChoreRate("");
    setBucketAction(null);
    setBucketAmt("");
    setBucketDesc("");
  }, [activeKid]);

  if (!kid) return null;

  function updateKid(kidId, changes) {
    const updated = kids.map(k=>k.id===kidId ? {...k,...changes} : k);
    onUpdateKids(updated);
  }

  function roundMoney(value) {
    return parseFloat((Number(value || 0)).toFixed(2));
  }

  function getHistoryDelta(tx, key) {
    const explicit = Number(tx?.[key]);
    if (Number.isFinite(explicit)) return explicit;
    if (tx?.type === "bucketAction" && tx.bucket === key) return Number(tx.gross) || 0;
    if ((tx?.type === "gift" || tx?.type === "withdrawal") && key === "wallet") return Number(tx.gross) || 0;
    return 0;
  }

  function recalculateBalances(history) {
    return history.reduce((balances, tx) => ({
      wallet: roundMoney(balances.wallet + getHistoryDelta(tx, "wallet")),
      savings: roundMoney(balances.savings + getHistoryDelta(tx, "savings")),
      christmas: roundMoney(balances.christmas + getHistoryDelta(tx, "christmas")),
      tithe: roundMoney(balances.tithe + getHistoryDelta(tx, "tithe")),
    }), { wallet:0, savings:0, christmas:0, tithe:0 });
  }

  function getDefaultBucketAction(bucket) {
    return {
      wallet: "spent",
      savings: "transfer",
      christmas: "spent",
      tithe: "given",
    }[bucket] || "spent";
  }

  function getChoreCount(chore) {
    if (typeof chore.completedCount === "number") return Math.max(0, chore.completedCount);
    return chore.completed ? 1 : 0;
  }

  function updateChoreCount(choreId, nextCount) {
    const safeCount = Math.max(0, Math.floor(nextCount));
    const updated = kid.chores.map(c=>c.id===choreId ? {...c,completedCount:safeCount,completed:safeCount>0} : c);
    updateKid(kid.id, { chores: updated });
  }

  function toggleChore(choreId) {
    const chore = kid.chores.find(c=>c.id===choreId);
    if (!chore) return;
    updateChoreCount(choreId, getChoreCount(chore) > 0 ? 0 : 1);
  }

  function adjustChoreCount(choreId, delta) {
    const chore = kid.chores.find(c=>c.id===choreId);
    if (!chore) return;
    updateChoreCount(choreId, getChoreCount(chore) + delta);
  }

  function startEditingChoreRate(chore) {
    setEditingChoreId(chore.id);
    setEditingChoreRate(String(chore.rate));
  }

  function cancelEditingChoreRate() {
    setEditingChoreId(null);
    setEditingChoreRate("");
  }

  function saveChoreRate(choreId) {
    const rate = parseFloat(editingChoreRate);
    if (Number.isNaN(rate) || rate < 0) return;
    const updated = kid.chores.map(c=>c.id===choreId ? {...c,rate} : c);
    updateKid(kid.id, { chores: updated });
    cancelEditingChoreRate();
  }

  function openBucketAction(key) {
    const config = {
      wallet: { action: "spent", defaultDesc: "Spent from wallet" },
      savings: { action: "transfer", defaultDesc: "Transferred to savings account" },
      tithe: { action: "given", defaultDesc: "Given to church" },
      christmas: { action: "spent", defaultDesc: "Christmas money spent" },
    }[key];
    if (!config) return;
    setBucketAction({ key, ...config });
    setBucketAmt("");
    setBucketDesc(config.defaultDesc);
  }

  function cancelBucketAction() {
    setBucketAction(null);
    setBucketAmt("");
    setBucketDesc("");
  }

  function setWalletActionMode(action) {
    if (!bucketAction || bucketAction.key !== "wallet") return;
    const defaultDesc = action === "gift" ? "Gift to wallet" : "Spent from wallet";
    setBucketAction({ ...bucketAction, action, defaultDesc });
    setBucketDesc(prev => {
      const current = prev.trim();
      if (!current || current === bucketAction.defaultDesc) return defaultDesc;
      return prev;
    });
  }

  function submitBucketAction() {
    if (!bucketAction) return;
    const amt = parseFloat(bucketAmt);
    if (!amt || amt <= 0) return;
    const isWalletGift = bucketAction.key === "wallet" && bucketAction.action === "gift";
    if (!isWalletGift && amt > kid.balances[bucketAction.key]) {
      alert(`Not enough in ${bucketAction.key}!`);
      return;
    }
    const delta = isWalletGift ? amt : -amt;
    const nextBalances = {
      ...kid.balances,
      [bucketAction.key]: parseFloat((kid.balances[bucketAction.key] + delta).toFixed(2)),
    };
    const tx = {
      id:"k"+Date.now(),
      date:new Date().toISOString().slice(0,10),
      type:"bucketAction",
      bucket:bucketAction.key,
      action:bucketAction.action,
      description:bucketDesc.trim() || bucketAction.defaultDesc,
      gross:delta,
      wallet:bucketAction.key==="wallet" ? delta : 0,
      savings:bucketAction.key==="savings" ? delta : 0,
      christmas:bucketAction.key==="christmas" ? delta : 0,
      tithe:bucketAction.key==="tithe" ? delta : 0,
    };
    updateKid(kid.id, {
      balances: nextBalances,
      history:[tx, ...kid.history],
    });
    cancelBucketAction();
  }

  function deleteHistoryEntry(txId) {
    const updatedHistory = kid.history
      .filter(tx => tx.id !== txId)
      .sort((a,b) => {
        const dateDiff = new Date(b.date) - new Date(a.date);
        if (dateDiff !== 0) return dateDiff;
        return String(b.id).localeCompare(String(a.id));
      });
    const nextBalances = recalculateBalances(updatedHistory);
    if (Object.values(nextBalances).some(value => value < -0.009)) {
      alert("Cannot delete this entry because it would make a balance go below zero.");
      return;
    }

    updateKid(kid.id, {
      history: updatedHistory,
      balances: nextBalances,
    });
  }

  function payWeek() {
    const completedChores = kid.chores
      .map(c=>({ ...c, count:getChoreCount(c) }))
      .filter(c=>c.count>0);
    if (completedChores.length===0) return;
    const gross = completedChores.reduce((s,c)=>s+(c.rate*c.count), 0);
    const wallet   = parseFloat((gross * 0.50).toFixed(2));
    const savings  = parseFloat((gross * 0.20).toFixed(2));
    const christmas= parseFloat((gross * 0.20).toFixed(2));
    const tithe    = parseFloat((gross * 0.10).toFixed(2));

    const tx = {
      id:"k"+Date.now(),
      date: new Date().toISOString().slice(0,10),
      type:"chores",
      description:`Chores: ${completedChores.map(c=>c.count>1 ? `${c.name} x${c.count}` : c.name).join(", ")}`,
      gross,wallet,savings,christmas,tithe,
    };

    const newBalances = {
      wallet:   parseFloat((kid.balances.wallet   + wallet).toFixed(2)),
      savings:  parseFloat((kid.balances.savings  + savings).toFixed(2)),
      christmas:parseFloat((kid.balances.christmas+ christmas).toFixed(2)),
      tithe:    parseFloat((kid.balances.tithe    + tithe).toFixed(2)),
    };

    // reset chores
    const resetChores = kid.chores.map(c=>({...c,completed:false,completedCount:0}));
    updateKid(kid.id, {
      balances: newBalances,
      history: [tx, ...kid.history],
      chores: resetChores,
    });
  }

  function addChore() {
    if (!newChore.name.trim()||!newChore.rate) return;
    const chore = { id:"c"+Date.now(), name:newChore.name.trim(), rate:parseFloat(newChore.rate), completed:false, completedCount:0 };
    updateKid(kid.id, { chores:[...kid.chores, chore] });
    setNewChore({name:"",rate:""}); setAddChoreForm(false);
  }

  function deleteChore(choreId) {
    if (editingChoreId === choreId) cancelEditingChoreRate();
    updateKid(kid.id, { chores: kid.chores.filter(c=>c.id!==choreId) });
  }

  const earnableThisWeek = kid.chores.reduce((s,c)=>s+(c.rate*getChoreCount(c)),0);
  const totalBalance = kid.balances.wallet+kid.balances.savings+kid.balances.christmas+kid.balances.tithe;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Kid selector tabs */}
      <div style={{display:"flex",gap:0,background:"#fff",borderRadius:10,border:"1px solid #e7e5e4",overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.04)"}}>
        {kids.map(k=>(
          <button key={k.id} onClick={()=>setActiveKid(k.id)}
            style={{flex:1,padding:"14px 10px",border:"none",cursor:"pointer",fontFamily:"'DM Mono',monospace",
              fontSize:"0.78rem",letterSpacing:".05em",transition:"all .15s",
              background:activeKid===k.id?k.color:"transparent",
              color:activeKid===k.id?"#fff":"#78716c",
              borderRight:"1px solid #e7e5e4",
            }}>
            <Bi name={k.icon} style={{marginRight:5}} /> {k.name}
          </button>
        ))}
      </div>
      {/* Balances */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(145px,1fr))",gap:12}}>
        {[
          {label:"Wallet",    icon:"wallet2",    key:"wallet",    sub:"free to spend",   color:kid.color},
          {label:"Savings",   icon:"bank2",      key:"savings",   sub:"20% of earnings", color:"#065f46"},
          {label:"Christmas", icon:"gift-fill",  key:"christmas", sub:"20% of earnings", color:"#be123c"},
          {label:"Tithe",     icon:"heart-fill", key:"tithe",     sub:"10% of earnings", color:"#0369a1"},
        ].map(b=>(
          <button
            key={b.key}
            type="button"
            className="stat-card"
            onClick={()=>openBucketAction(b.key)}
            style={{
              textAlign:"left",
              cursor:"pointer",
              border:bucketAction?.key===b.key ? `1.5px solid ${b.color}` : undefined,
            }}>
            <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e",letterSpacing:".06em",textTransform:"uppercase",marginBottom:6,display:"flex",alignItems:"center",gap:6}}>
              <Bi name={b.icon} style={{fontSize:"0.8rem"}} />
              <span>{b.label}</span>
            </p>
            <p className="pf" style={{fontSize:"1.35rem",fontWeight:700,color:b.color}}>{fmt(kid.balances[b.key])}</p>
            <p className="mono" style={{fontSize:"0.6rem",color:"#a8a29e",marginTop:2}}>
              {b.key==="wallet" ? "tap to spend or gift" : `${b.sub} - tap to record`}
            </p>
          </button>
        ))}
      </div>

      {bucketAction && (
        <div
          className="card"
          style={{
            maxWidth:420,
            borderColor:
              bucketAction.key==="wallet" ? kid.color :
              bucketAction.key==="savings" ? "#bbf7d0" :
              bucketAction.key==="christmas" ? "#fca5a5" :
              "#93c5fd",
          }}>
          <p
            className="mono"
            style={{
              fontSize:"0.65rem",
              letterSpacing:".06em",
              marginBottom:10,
              color:
                bucketAction.key==="wallet" ? kid.color :
                bucketAction.key==="savings" ? "#065f46" :
                bucketAction.key==="christmas" ? "#be123c" :
                "#0369a1",
            }}>
            {bucketAction.action.toUpperCase()} {bucketAction.key.toUpperCase()} (balance: {fmt(kid.balances[bucketAction.key])})
          </p>
          {bucketAction.key==="wallet" && (
            <div style={{display:"flex",gap:8,marginBottom:10}}>
              <button
                className={`btn btn-sm ${bucketAction.action==="spent" ? "btn-amber" : "btn-ghost"}`}
                onClick={()=>setWalletActionMode("spent")}>
                Spend
              </button>
              <button
                className={`btn btn-sm ${bucketAction.action==="gift" ? "btn-amber" : "btn-ghost"}`}
                onClick={()=>setWalletActionMode("gift")}>
                Gift To Wallet
              </button>
            </div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <span className="mono" style={{color:"#78716c",flexShrink:0}}>$</span>
              <input type="number" min="0" step="0.01" value={bucketAmt} onChange={e=>setBucketAmt(e.target.value)} placeholder="0.00" autoFocus />
            </div>
            <input type="text" value={bucketDesc} onChange={e=>setBucketDesc(e.target.value)} placeholder="Description" />
            <div style={{display:"flex",gap:8}}>
              <button className="btn btn-amber btn-sm" onClick={submitBucketAction}>Save</button>
              <button className="btn btn-ghost btn-sm" onClick={cancelBucketAction}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Chores */}
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
          <div>
            <h2 className="pf" style={{fontSize:"1.05rem",fontStyle:"italic"}}>Weekly Chores</h2>
            <p className="mono" style={{fontSize:"0.64rem",color:"#a8a29e",marginTop:2}}>
              Tap once for normal chores, use +/- for repeats, then click Pay Week · Income splits 50/20/20/10
            </p>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {earnableThisWeek>0&&(
              <span className="mono" style={{fontSize:"0.73rem",color:"#065f46",background:"#f0fdf4",padding:"4px 10px",borderRadius:99,border:"1px solid #bbf7d0"}}>
                +{fmt(earnableThisWeek)} ready
              </span>
            )}
            <button className="btn btn-amber btn-sm" onClick={payWeek} disabled={earnableThisWeek===0}
              style={{opacity:earnableThisWeek===0?0.4:1}}>
              Pay Week
            </button>
          </div>
        </div>

        {kid.chores.map(chore=>{
          const choreCount = getChoreCount(chore);
          const isCompleted = choreCount > 0;
          return (
          <div key={chore.id} style={{display:"flex",alignItems:"center",gap:12,padding:"9px 0",borderBottom:"1px solid #f5f0eb"}}>
            <button
              onClick={()=>toggleChore(chore.id)}
              style={{
                width:22,height:22,borderRadius:5,border:"2px solid",flexShrink:0,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:"0.7rem",transition:"all .15s",
                borderColor:isCompleted?kid.color:"#d6d3d1",
                background:isCompleted?kid.color:"transparent",
                color:"#fff",
              }}
            >
              {isCompleted?"✓":""}
            </button>
            <span style={{flex:1,fontSize:"0.86rem",textDecoration:isCompleted?"line-through":"none",color:isCompleted?"#a8a29e":"#1c1917"}}>
              {chore.name}
            </span>
            <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
              <button className="btn-del" onClick={()=>adjustChoreCount(chore.id,-1)} title="One less">−</button>
              <span className="mono" style={{fontSize:"0.75rem",minWidth:22,textAlign:"center",color:isCompleted?kid.color:"#78716c"}}>
                {choreCount}
              </span>
              <button className="btn-del" onClick={()=>adjustChoreCount(chore.id,1)} title="One more">+</button>
            </div>
            {editingChoreId === chore.id ? (
              <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                <span className="mono" style={{fontSize:"0.78rem",color:"#78716c"}}>$</span>
                <input
                  type="number"
                  min="0"
                  step="0.25"
                  value={editingChoreRate}
                  onChange={e=>setEditingChoreRate(e.target.value)}
                  onKeyDown={e=>{
                    if (e.key === "Enter") saveChoreRate(chore.id);
                    if (e.key === "Escape") cancelEditingChoreRate();
                  }}
                  style={{width:78,padding:"6px 8px"}}
                  autoFocus
                />
                <button className="btn btn-amber btn-sm" onClick={()=>saveChoreRate(chore.id)}>Save</button>
                <button className="btn btn-ghost btn-sm" onClick={cancelEditingChoreRate}>Cancel</button>
              </div>
            ) : (
              <>
                <span className="mono" style={{fontSize:"0.78rem",color:"#78716c",minWidth:50,textAlign:"right"}}>{fmt(chore.rate)}</span>
                <button className="btn-del" onClick={()=>startEditingChoreRate(chore)} title="Edit rate"><Bi name="pencil" /></button>
              </>
            )}
            <button className="btn-del" onClick={()=>deleteChore(chore.id)}>✕</button>
          </div>
        )})}

        {addChoreForm ? (
          <div style={{paddingTop:12,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <input value={newChore.name} onChange={e=>setNewChore(n=>({...n,name:e.target.value}))}
              placeholder="Chore name" style={{flex:1,minWidth:120}} autoFocus />
            <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
              <span className="mono" style={{color:"#78716c"}}>$</span>
              <input type="number" min="0" step="0.25" value={newChore.rate}
                onChange={e=>setNewChore(n=>({...n,rate:e.target.value}))}
                placeholder="Rate" style={{width:80}} />
            </div>
            <button className="btn btn-amber btn-sm" onClick={addChore}>Add</button>
            <button className="btn btn-ghost btn-sm" onClick={()=>{setAddChoreForm(false);setNewChore({name:"",rate:""});}}>Cancel</button>
          </div>
        ) : (
          <button className="btn btn-ghost btn-sm" style={{marginTop:12}} onClick={()=>setAddChoreForm(true)}>+ Add Chore</button>
        )}
      </div>

      {/* Earning breakdown preview */}
      {earnableThisWeek>0&&(
        <div className="card" style={{background:"#fffbf5",borderColor:"#fde68a"}}>
          <p className="mono" style={{fontSize:"0.65rem",color:"#b45309",letterSpacing:".06em",marginBottom:10}}>EARNING BREAKDOWN (when you pay week)</p>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
            {[
              {label:"Wallet 50%",  amt:earnableThisWeek*0.50},
              {label:"Savings 20%", amt:earnableThisWeek*0.20},
              {label:"Christmas 20%",amt:earnableThisWeek*0.20},
              {label:"Tithe 10%",   amt:earnableThisWeek*0.10},
            ].map(b=>(
              <div key={b.label} style={{textAlign:"center"}}>
                <p className="mono" style={{fontSize:"0.6rem",color:"#a8a29e",marginBottom:3}}>{b.label}</p>
                <p className="mono" style={{fontSize:"0.9rem",fontWeight:500,color:"#1c1917"}}>{fmt(b.amt)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History */}
      {kid.history.length>0&&(
        <div className="card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:12,marginBottom:14,flexWrap:"wrap"}}>
            <h2 className="pf" style={{fontSize:"1.05rem",fontStyle:"italic"}}>History</h2>
            <p className="mono" style={{fontSize:"0.62rem",color:"#a8a29e"}}>Delete entries here if one was added by mistake.</p>
          </div>
          {kid.history.slice(0,20).map(tx=>{
            const typeStyle={
              chores:{icon:"check2-square",color:"#065f46"},
              gift:{icon:"gift-fill",color:"#0369a1"},
              withdrawal:{icon:"dash-circle-fill",color:"#be123c"},
            }[tx.type]||{icon:"dot",color:"#78716c"};
            const historyDetail = tx.type==="chores"
              ? `wallet +${fmt(tx.wallet)} | savings +${fmt(tx.savings)} | christmas +${fmt(tx.christmas)} | tithe +${fmt(tx.tithe)}`
              : tx.type==="bucketAction"
                ? `${tx.bucket} ${tx.action} | ${fmt(Math.abs(tx.gross))}`
                : null;
            const historyStyle = tx.type==="bucketAction"
              ? {
                  icon: tx.bucket==="wallet" ? "wallet2" : tx.bucket==="savings" ? "bank2" : tx.bucket==="christmas" ? "gift-fill" : "heart-fill",
                  color: tx.bucket==="wallet" ? kid.color : tx.bucket==="savings" ? "#065f46" : tx.bucket==="christmas" ? "#be123c" : "#0369a1",
                }
              : typeStyle;
            return (
              <div key={tx.id} style={{padding:"8px 0",borderBottom:"1px solid #f5f0eb"}}>
                <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                  <span style={{fontSize:"0.9rem",flexShrink:0,marginTop:2}}>
                    <Bi name={historyStyle.icon} style={{color:historyStyle.color}} />
                  </span>
                  <div style={{flex:1,minWidth:0}}>
                    <p style={{fontSize:"0.83rem",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tx.description}</p>
                    <p className="mono" style={{fontSize:"0.63rem",color:"#a8a29e",marginTop:2}}>{tx.date}</p>
                    {historyDetail&&(
                      <p className="mono" style={{fontSize:"0.62rem",color:"#78716c",marginTop:3}}>{historyDetail}</p>
                    )}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                    <span className="mono" style={{fontSize:"0.86rem",fontWeight:500,color:historyStyle.color}}>
                      {tx.gross>=0?"+":""}{fmt(tx.gross)}
                    </span>
                    <button className="btn-del" onClick={()=>deleteHistoryEntry(tx.id)} title="Delete history entry">
                      ×
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ─── AuthView ─────────────────────────────────────────────────────────────────
function AuthView() {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [mode,     setMode]     = useState("login"); // "login" | "signup" | "magic"
  const [loading,  setLoading]  = useState(false);
  const [message,  setMessage]  = useState("");

  async function handleSubmit() {
    if (!email.trim()) { setMessage("Please enter your email."); return; }
    setLoading(true); setMessage("");
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setMessage(error.message);
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) setMessage(error.message);
        else setMessage("Check your email to confirm your account, then sign in.");
      } else {
        const { error } = await supabase.auth.signInWithOtp({ email });
        if (error) setMessage(error.message);
        else setMessage("Magic link sent — check your email.");
      }
    } finally { setLoading(false); }
  }

  const isSuccess = message.toLowerCase().includes("check") || message.toLowerCase().includes("sent");
  return (
    <div style={{minHeight:"100vh",background:"#faf7f2",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=DM+Mono:wght@300;400;500&display=swap');
        .pf{font-family:'Playfair Display',Georgia,serif;}
        .mono{font-family:'DM Mono',monospace;}
        *{box-sizing:border-box;margin:0;padding:0;}
      `}</style>
      <div style={{width:"100%",maxWidth:400,padding:"0 20px"}}>
        <div style={{background:"#fff",border:"1px solid #e7e5e4",borderRadius:12,padding:"36px 32px",boxShadow:"0 4px 20px rgba(0,0,0,.06)"}}>
          <h1 className="pf" style={{fontSize:"1.7rem",fontWeight:700,fontStyle:"italic",marginBottom:5,color:"#1c1917"}}>The Ledger</h1>
          <p className="mono" style={{fontSize:"0.68rem",color:"#a8a29e",marginBottom:28,letterSpacing:".06em"}}>
            family finance · {mode==="login"?"sign in":mode==="signup"?"create account":"magic link"}
          </p>
          <div style={{display:"flex",gap:5,marginBottom:20}}>
            {[["login","Sign In"],["signup","Sign Up"],["magic","Magic Link"]].map(([m,label])=>(
              <button key={m} onClick={()=>{setMode(m);setMessage("");}}
                style={{flex:1,padding:"6px 4px",borderRadius:6,border:"1px solid",
                  borderColor:mode===m?"#b45309":"#e7e5e4",background:mode===m?"#fff7ed":"#fff",
                  color:mode===m?"#b45309":"#78716c",cursor:"pointer",
                  fontFamily:"DM Mono,monospace",fontSize:"0.67rem",letterSpacing:".04em"}}>
                {label}
              </button>
            ))}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:13}}>
            <div>
              <label style={{fontFamily:"DM Mono,monospace",fontSize:"0.67rem",letterSpacing:".07em",color:"#78716c",display:"block",marginBottom:5,textTransform:"uppercase"}}>Email</label>
              <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter")handleSubmit();}}
                placeholder="your@email.com" autoFocus
                style={{width:"100%",border:"1.5px solid #d6d3d1",borderRadius:6,padding:"9px 11px",fontFamily:"DM Mono,monospace",fontSize:"0.82rem",background:"#faf7f2",color:"#1c1917",outline:"none"}}
              />
            </div>
            {mode !== "magic" && (
              <div>
                <label style={{fontFamily:"DM Mono,monospace",fontSize:"0.67rem",letterSpacing:".07em",color:"#78716c",display:"block",marginBottom:5,textTransform:"uppercase"}}>Password</label>
                <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
                  onKeyDown={e=>{if(e.key==="Enter")handleSubmit();}}
                  placeholder="••••••••"
                  style={{width:"100%",border:"1.5px solid #d6d3d1",borderRadius:6,padding:"9px 11px",fontFamily:"DM Mono,monospace",fontSize:"0.82rem",background:"#faf7f2",color:"#1c1917",outline:"none"}}
                />
              </div>
            )}
            <button onClick={handleSubmit} disabled={loading}
              style={{padding:"11px",background:loading?"#e7e5e4":"#b45309",color:loading?"#a8a29e":"#fef3c7",
                border:"none",borderRadius:6,cursor:loading?"not-allowed":"pointer",
                fontFamily:"DM Mono,monospace",fontSize:"0.82rem",letterSpacing:".05em",marginTop:4}}>
              {loading?"…":mode==="login"?"Sign In →":mode==="signup"?"Create Account →":"Send Magic Link →"}
            </button>
            {message && (
              <p style={{fontSize:"0.72rem",fontFamily:"DM Mono,monospace",
                color:isSuccess?"#065f46":"#be123c",padding:"8px 10px",
                background:isSuccess?"#f0fdf4":"#fff1f2",borderRadius:6,
                border:"1px solid",borderColor:isSuccess?"#bbf7d0":"#fecdd3",lineHeight:1.6}}>
                {message}
              </p>
            )}
          </div>
        </div>
        <p style={{fontFamily:"DM Mono,monospace",fontSize:"0.63rem",color:"#a8a29e",textAlign:"center",marginTop:14,letterSpacing:".04em"}}>
          Your data is encrypted and stored in the cloud.
        </p>
      </div>
    </div>
  );
}

// ─── App (root export) ────────────────────────────────────────────────────────
export default function App() {
  const [session,     setSession]     = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(()=>{
    supabase.auth.getSession().then(({ data:{ session } })=>{
      setSession(session);
      setAuthLoading(false);
    });
    const { data:{ subscription } } = supabase.auth.onAuthStateChange((_event, session)=>{
      setSession(session);
      setAuthLoading(false);
    });
    return ()=>subscription.unsubscribe();
  },[]);

  if (authLoading) return (
    <div style={{minHeight:"100vh",background:"#faf7f2",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <p style={{fontFamily:"DM Mono,monospace",fontSize:"0.78rem",color:"#a8a29e",letterSpacing:".08em"}}>loading…</p>
    </div>
  );

  if (!session) return <AuthView />;
  return <FinanceApp session={session} />;
}
