// بورصة سمارت PRO V18 — Production-grade Hosted EGXpilot proxy
// Node.js 18+
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const DATA_PROVIDER = String(process.env.DATA_PROVIDER || "auto").trim().toLowerCase();
const EGXAPI_BASE = (process.env.EGXAPI_BASE || "https://api.egxapi.com").replace(/\/+$/, "");
const EGXAPI_KEY = process.env.EGXAPI_KEY || "";
const EGXAPI_ENV = process.env.EGXAPI_ENV || "live";
const EGXAPI_QUOTE_PATH = process.env.EGXAPI_QUOTE_PATH || "/v2/market-data/quotes";
const EGXAPI_BARS_PATH = process.env.EGXAPI_BARS_PATH || "/v2/market-data/bars";
const EGXPILOT_BASE = (process.env.EGXPILOT_BASE || "https://egxpilot.com").replace(/\/+$/, "");
const EGXPILOT_MCP_URL = process.env.EGXPILOT_MCP_URL || "https://egxpilot.com/api/mcp";
const QUOTE_CACHE_TTL_MS = Number(process.env.QUOTE_CACHE_TTL_MS || 15000);
const HISTORY_CACHE_ENABLED = String(process.env.HISTORY_CACHE_ENABLED || "true").toLowerCase() !== "false";

const API_KEY = process.env.EGXPILOT_API_KEY || "";
const AUTH_HEADER = process.env.EGXPILOT_AUTH_HEADER || "Authorization";
const AUTH_SCHEME = process.env.EGXPILOT_AUTH_SCHEME ?? "Bearer";
const PUBLIC_DIR = __dirname;
const DATA_DIR = __dirname;
const MARKET_CACHE_FILE = path.join(DATA_DIR, "market_cache.json");
const ANALYSIS_DB_FILE = path.join(DATA_DIR, "analysis_history.json");

const CACHE_TTL_MS = Number(process.env.EGXPILOT_CACHE_TTL_MS || 15000);
const RATE_WINDOW_MS = 60000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 120);
const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const MCP_CONNECT_TIMEOUT_MS = Number(process.env.MCP_CONNECT_TIMEOUT_MS || 15000);
const MCP_RETRIES = Number(process.env.MCP_RETRIES || 2);
const MCP_CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS || 15000);
const cache = new Map();
const rate = new Map();

let baseUrl;
let egxApiUrl;
try {
  egxApiUrl = new URL(EGXAPI_BASE + "/");
  if (!["https:", "http:"].includes(egxApiUrl.protocol)) throw new Error("EGXAPI_BASE must use HTTP(S)");
} catch {
  throw new Error("Invalid EGXAPI_BASE");
}
try {
  baseUrl = new URL(EGXPILOT_BASE + "/");
  if (!["https:", "http:"].includes(baseUrl.protocol)) throw new Error("EGXPILOT_BASE must use HTTP(S)");
} catch {
  throw new Error("Invalid EGXPILOT_BASE");
}

const allowedPrefixes = [
  "/api/stocks/all",
  "/api/stocks/",
  "/api/v2/st/",
  "/api/stockanalysis/",
  "/api/golden-stocks-v2/",
  "/api/news/",
  "/api/stats/",
];

function allowedPath(p) {
  return allowedPrefixes.some(prefix => p === prefix || p.startsWith(prefix));
}

function clientKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}
function rateAllowed(req) {
  const now=Date.now(), key=clientKey(req), old=rate.get(key);
  if(!old || now-old.start>=RATE_WINDOW_MS){rate.set(key,{start:now,count:1});return true;}
  old.count++; return old.count<=RATE_LIMIT;
}
function cacheKey(target){return target.toString();}
function trimCache(){if(cache.size<=100)return;const oldest=[...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts).slice(0,cache.size-100);for(const [k] of oldest)cache.delete(k);}

function pruneRate(){const cutoff=Date.now()-RATE_WINDOW_MS*2;for(const [k,v] of rate){if(v.start<cutoff)rate.delete(k)}}
setInterval(pruneRate, RATE_WINDOW_MS).unref();

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...extra,
  });
  res.end(body);
}

function json(res, status, obj, extra = {}) {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", extra);
}


function pickTimestamp(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(String(value));
  return Number.isFinite(d) ? d : null;
}

function findFreshnessTimestamp(obj) {
  const keys = ["timestamp","time","updatedAt","updated_at","lastUpdate","last_updated","asOf","as_of","date","datetime"];
  const seen = new Set();
  function walk(v, depth = 0) {
    if (depth > 4 || v == null || seen.has(v)) return null;
    if (typeof v === "object") seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 20)) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof v !== "object") return null;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(v, key)) {
        const ts = pickTimestamp(v[key]);
        if (ts) return ts;
      }
    }
    for (const value of Object.values(v).slice(0, 30)) {
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return walk(obj);
}


function liveHeaders(provider="egxapi") {
  const headers = { Accept: "application/json", "User-Agent": "BorsaSmartPRO-V18-Live/2.0" };
  if (provider === "egxapi" && EGXAPI_KEY) {
    headers.Authorization = `Bearer ${EGXAPI_KEY}`;
    headers["X-EGX-Env"] = EGXAPI_ENV;
  } else if (provider === "egxpilot" && API_KEY) {
    headers[AUTH_HEADER] = AUTH_SCHEME ? `${AUTH_SCHEME} ${API_KEY}` : API_KEY;
  }
  return headers;
}
function makeProviderUrl(base, route, params={}) {
  const u = new URL(route, base + "/");
  for (const [k,v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, String(v));
  return u;
}
function extractRows(body) {
  const roots=[body?.data,body?.results,body?.quotes,body?.items,body?.rows,body?.stocks,body?.marketWatch,body];
  for(const r of roots){ if(Array.isArray(r)) return r; if(r&&typeof r==='object'){ for(const k of ['data','items','results','quotes','stocks']) if(Array.isArray(r[k])) return r[k]; }}
  return [];
}
function normalizeQuote(raw, fallbackSymbol) {
  const candidates = [
    raw?.data?.quote, raw?.quote, raw?.data, raw?.result?.quote, raw?.result,
    raw?.structuredContent?.quote, raw?.structuredContent, raw
  ].filter(v => v && typeof v === "object");
  const x = candidates.find(v => ["price","last","lastPrice","close","c"].some(k => Number.isFinite(Number(v?.[k])))) || candidates[0] || {};
  const n=(...keys)=>{for(const k of keys){const v=Number(x?.[k]);if(Number.isFinite(v))return v}return null};
  const symbol=String(x.symbol??x.ticker??x.code??fallbackSymbol).toUpperCase();
  const price=n('price','last','lastPrice','close','c');
  const prev=n('previousClose','prevClose','previous_close','pc');
  const change=n('change','changePercent','changePct','pctChange','percentChange');
  const pct=change!=null && Math.abs(change)>10 && prev!=null && price!=null ? ((price-prev)/prev)*100 : change;
  return {symbol, name:x.name??x.companyName??x.company??symbol, price, last:price, previousClose:prev, changePct:pct, change:pct, open:n('open','o'), high:n('high','h'), low:n('low','l'), volume:n('volume','v'), value:n('value','turnover','turnoverValue'), timestamp:findFreshnessTimestamp(bodySafe(x))};
}
function bodySafe(x){return x&&typeof x==='object'?x:{}}
async function fetchJsonUrl(url, headers, timeoutMs=REQUEST_TIMEOUT_MS) {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try { const r=await fetch(url,{headers,signal:controller.signal,redirect:'error'}); const text=await r.text(); let body=null; try{body=JSON.parse(text)}catch{} return {status:r.status,ok:r.ok,contentType:r.headers.get('content-type')||'',body,text}; }
  finally{clearTimeout(timer)}
}

let mcpClientPromise = null;

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out after ${timeoutMs}ms`);
          err.code = "MCP_TIMEOUT";
          reject(err);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getMcpClient() {
  if (mcpClientPromise) return mcpClientPromise;
  mcpClientPromise = (async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "BorsaSmartPRO", version: "19.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(EGXPILOT_MCP_URL));
    try {
      await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, "EGXpilot MCP connect");
      return client;
    } catch (err) {
      try { await transport.close?.(); } catch (_) {}
      throw err;
    }
  })().catch(err => { mcpClientPromise = null; throw err; });
  return mcpClientPromise;
}

async function mcpCallWithRetry(name, args) {
  let last;
  for (let attempt = 0; attempt <= MCP_RETRIES; attempt++) {
    try { return await mcpTool(name, args); }
    catch (e) {
      last = e;
      if (attempt < MCP_RETRIES) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw last;
}


function loadAnalysisDb(){
  try{
    if(!fs.existsSync(ANALYSIS_DB_FILE)) return {version:1,records:[]};
    const x=JSON.parse(fs.readFileSync(ANALYSIS_DB_FILE,"utf8"));
    return x&&Array.isArray(x.records)?x:{version:1,records:[]};
  }catch(_){return {version:1,records:[]}}
}
function saveAnalysisDb(db){
  const tmp=ANALYSIS_DB_FILE+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(db,null,2),"utf8");
  fs.renameSync(tmp,ANALYSIS_DB_FILE);
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let data="",size=0;
    req.on("data",chunk=>{size+=chunk.length;if(size>MAX_BODY_BYTES){reject(new Error("Body too large"));req.destroy();return}data+=chunk});
    req.on("end",()=>resolve(data));req.on("error",reject);
  });
}
async function analysisHistory(req,res,u){
  if(!rateAllowed(req)) return json(res,429,{ok:false,error:"Too many requests"});
  const db=loadAnalysisDb();
  if(req.method==="GET"){
    const symbol=safeSymbol(u.searchParams.get("symbol"));
    const limit=Math.min(200,Math.max(1,Number(u.searchParams.get("limit")||50)));
    let records=db.records;
    if(symbol)records=records.filter(r=>r.symbol===symbol);
    return json(res,200,{ok:true,version:db.version,count:records.length,records:records.slice(-limit)});
  }
  if(req.method==="POST"){
    try{
      const raw=await readBody(req), body=JSON.parse(raw||"{}"), symbol=safeSymbol(body.symbol);
      if(!symbol) return json(res,400,{ok:false,error:"Invalid symbol"});
      const record={
        id:Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8),
        createdAt:new Date().toISOString(),symbol,
        price:Number.isFinite(Number(body.price))?Number(body.price):null,
        score:Number.isFinite(Number(body.score))?Number(body.score):null,
        confidence:Number.isFinite(Number(body.confidence))?Number(body.confidence):null,
        status:String(body.status||"").slice(0,40),
        regime:String(body.regime||"").slice(0,40),
        historicalWinRate:Number.isFinite(Number(body.historicalWinRate))?Number(body.historicalWinRate):null,
        historicalTrades:Number.isFinite(Number(body.historicalTrades))?Number(body.historicalTrades):null
      };
      db.records.push(record);
      if(db.records.length>5000)db.records=db.records.slice(-5000);
      saveAnalysisDb(db);
      return json(res,201,{ok:true,record});
    }catch(e){return json(res,400,{ok:false,error:"Invalid analysis record",detail:String(e.message||e)})}
  }
  return json(res,405,{ok:false,error:"Method not allowed"},{Allow:"GET, POST"});
}

function loadQuoteCache() {
  try {
    if (!fs.existsSync(MARKET_CACHE_FILE)) return {};
    const obj = JSON.parse(fs.readFileSync(MARKET_CACHE_FILE, "utf8"));
    return obj && typeof obj === "object" ? obj : {};
  } catch (_) { return {}; }
}
function saveQuoteCache(cacheObj) {
  try {
    const tmp = MARKET_CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cacheObj, null, 2), "utf8");
    fs.renameSync(tmp, MARKET_CACHE_FILE);
  } catch (_) {}
}
function cacheQuote(q, source="egxpilot-mcp") {
  if (!q?.symbol || q.price == null) return;
  const c = loadQuoteCache();
  c[q.symbol] = { ...q, source, cachedAt: new Date().toISOString() };
  saveQuoteCache(c);
}
function cachedQuote(symbol) {
  const c = loadQuoteCache()[symbol];
  if (!c || c.price == null) return null;
  return c;
}
function localLastClose(symbol) {
  try {
    const rows = loadLocalHistory(symbol);
    if (!Array.isArray(rows) || !rows.length) return null;
    const last = rows[rows.length - 1];
    if (last?.c == null) return null;
    return {
      symbol, price: Number(last.c), last: Number(last.c),
      previousClose: rows.length > 1 ? Number(rows[rows.length-2].c) : null,
      changePct: rows.length > 1 ? ((Number(last.c)-Number(rows[rows.length-2].c))/Number(rows[rows.length-2].c))*100 : null,
      change: rows.length > 1 ? ((Number(last.c)-Number(rows[rows.length-2].c))/Number(rows[rows.length-2].c))*100 : null,
      open: Number(last.o), high: Number(last.h), low: Number(last.l), volume: Number(last.v),
      timestamp: pickTimestamp(last.t)
    };
  } catch (_) { return null; }
}
function mcpText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.filter(x => x?.type === "text").map(x => x.text).join("\n");
  if (result?.structuredContent) return result.structuredContent;
  if (!text) return result?.data ?? result;
  try { return JSON.parse(text); } catch (_) { return { text }; }
}
async function mcpTool(name, args) {
  const client = await getMcpClient();
  try {
    const result = await withTimeout(
      client.callTool({ name, arguments: args || {} }),
      MCP_CALL_TIMEOUT_MS,
      `EGXpilot MCP tool ${name}`
    );
    return mcpText(result);
  } catch (e) {
    mcpClientPromise = null;
    try { await client.close?.(); } catch (_) {}
    throw e;
  }
}
async function mcpSnapshot(symbol) {
  const body = await mcpCallWithRetry("get_stock_snapshot", { symbol });
  const q = normalizeQuote(body, symbol);
  if (q.price == null) throw new Error("EGXpilot MCP snapshot has no price");
  return { provider: "egxpilot-mcp", quote: q, raw: body, status: 200 };
}

async function liveQuote(symbol) {
  const errors = [];
  const providers = DATA_PROVIDER === "auto"
    ? ["egxpilot-mcp", "egxapi", "egxpilot"]
    : [DATA_PROVIDER];

  for (const provider of providers) {
    try {
      if (provider === "egxpilot-mcp") {
        const r = await mcpSnapshot(symbol);
        cacheQuote(r.quote, r.provider);
        return r;
      }
      if (provider === "egxpilot") {
        const u = makeProviderUrl(EGXPILOT_BASE, `/api/stocks/${encodeURIComponent(symbol)}`);
        const r = await fetchJsonUrl(u, liveHeaders("egxpilot"));
        if (!r.ok) throw new Error(`EGXpilot ${r.status}`);
        const q = normalizeQuote(r.body, symbol);
        if (q.price == null) throw new Error("EGXpilot response has no price");
        cacheQuote(q, "egxpilot-rest");
        return { provider: "egxpilot-rest", quote: q, raw: r.body, status: r.status };
      }
      if (provider === "egxapi") {
        if (!EGXAPI_KEY) throw new Error("EGXAPI_KEY is not configured");
        const u = makeProviderUrl(EGXAPI_BASE, EGXAPI_QUOTE_PATH, { symbol });
        const r = await fetchJsonUrl(u, liveHeaders("egxapi"));
        if (!r.ok) throw new Error(`EGXAPI ${r.status}`);
        const q = normalizeQuote(r.body, symbol);
        if (q.price == null) throw new Error("EGXAPI response has no price");
        cacheQuote(q, "egxapi");
        return { provider: "egxapi", quote: q, raw: r.body, status: r.status };
      }
      throw new Error(`Unknown provider: ${provider}`);
    } catch (e) { errors.push(`${provider}: ${e.message}`); }
  }

  // Closed-market / upstream outage fallback: keep the last successful quote.
  const cached = cachedQuote(symbol);
  if (cached) return {
    provider: cached.source || "local-cache",
    quote: { ...cached, stale: true, cacheAgeMs: Date.now() - (Date.parse(cached.cachedAt) || Date.now()) },
    raw: cached, status: 200, stale: true
  };

  const local = localLastClose(symbol);
  if (local) return { provider: "bundled-history", quote: { ...local, stale: true }, raw: local, status: 200, stale: true };

  const err = new Error(errors.join(" | ") || "No market data available");
  err.code = "LIVE_PROVIDER_FAILED";
  throw err;
}

async function marketDiagnostic(req,res,u){
  if(!rateAllowed(req)) return json(res,429,{ok:false,error:'Too many requests',retryAfterSeconds:60});
  const symbol=safeSymbol(u.searchParams.get('symbol'))||'COMI';
  const configured = DATA_PROVIDER === "egxpilot-mcp" || DATA_PROVIDER === "auto"
    ? true : (DATA_PROVIDER==="egxapi" ? Boolean(EGXAPI_KEY) : true);
  const result={ok:false,server:'Borsa Smart PRO V19',provider:DATA_PROVIDER,configured,reachable:false,authenticated:null,liveData:false,symbol,checkedAt:new Date().toISOString(),latencyMs:null};
  const started=Date.now();
  try{const r=await liveQuote(symbol);result.ok=true;result.reachable=true;result.authenticated=true;result.liveData=true;result.provider=r.provider;result.quote=r.quote;result.upstreamStatus=r.status;result.latencyMs=Date.now()-started;result.message='Live market data returned successfully.';}
  catch(e){result.latencyMs=Date.now()-started;result.message=e.message;result.authenticated=/401|403/.test(e.message)?false:null;}
  return json(res,200,result);
}

async function liveMarket(req,res,u){
  if(!rateAllowed(req)) return json(res,429,{ok:false,error:'Too many requests',retryAfterSeconds:60});
  const symbol=safeSymbol(u.searchParams.get('symbol'));
  if(!symbol) return json(res,400,{ok:false,error:'Invalid symbol'});
  try{ const result=await liveQuote(symbol); return json(res,200,{ok:true,source:result.provider,live:true,checkedAt:new Date().toISOString(),quote:result.quote,raw:result.raw}); }
  catch(e){ return json(res,502,{ok:false,live:false,error:'Live market data unavailable',detail:e.message,provider:DATA_PROVIDER}); }
}
async function liveQuotes(req,res,u){
  if(!rateAllowed(req)) return json(res,429,{ok:false,error:'Too many requests',retryAfterSeconds:60});
  const configured=String(process.env.EGX_SYMBOLS||'COMI,SWDY,ABUK,CPCI,CICH,ETEL,FWRY,ORAS,HRHO,TMGH,EAST,AMOC,EFID,EMFD,ADIB,PHDC,ORWE,SKPC,JUFO,ISPH').split(',').map(s=>safeSymbol(s)).filter(Boolean);
  const requested=String(u.searchParams.get('symbols')||'').split(',').map(s=>safeSymbol(s)).filter(Boolean);
  const symbols=[...new Set((requested.length?requested:configured))].slice(0,50);
  const quotes=[]; const errors=[];
  for(const symbol of symbols){try{const r=await liveQuote(symbol);quotes.push(r.quote)}catch(e){errors.push({symbol,error:e.message})}}
  if(!quotes.length) return json(res,502,{ok:false,live:false,error:'No live quotes returned',errors,provider:DATA_PROVIDER});
  return json(res,200,{ok:true,live:true,source:DATA_PROVIDER,checkedAt:new Date().toISOString(),count:quotes.length,quotes,errors});
}

async function liveHistory(req,res,u){
  if(!rateAllowed(req)) return json(res,429,{ok:false,error:'Too many requests',retryAfterSeconds:60});
  const symbol=safeSymbol(u.searchParams.get('symbol')); if(!symbol) return json(res,400,{ok:false,error:'Invalid symbol'});
  try {
    const ohlcv = loadLocalHistory(symbol);
    if (!ohlcv) return json(res,404,{ok:false,error:'Historical OHLCV not found',symbol});
    return json(res,200,{
      ok:true, source:"bundled-historical-fallback", live:false, symbol,
      count:ohlcv.length, bars:ohlcv,
      note:"Historical daily OHLCV is bundled locally. Intraday candles are not fabricated."
    });
  } catch(e) {
    return json(res,500,{ok:false,error:'Historical data unavailable',detail:String(e?.message||e)});
  }
}

async function diagnosticRequest(targetPath) {
  const target = new URL(targetPath, EGXPILOT_BASE + "/");
  if (target.origin !== baseUrl.origin || !allowedPath(target.pathname)) {
    return { status: 0, ok: false, ms: 0, error: "Endpoint not allowed" };
  }
  const headers = { Accept: "application/json", "User-Agent": "BorsaSmartPRO-V15-Diagnostic/1.0" };
  if (API_KEY) headers[AUTH_HEADER] = AUTH_SCHEME ? `${AUTH_SCHEME} ${API_KEY}` : API_KEY;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const started = Date.now();
  try {
    const upstream = await fetch(target, { method: "GET", headers, signal: controller.signal, redirect: "error" });
    const text = await upstream.text();
    let jsonBody = null;
    try { jsonBody = JSON.parse(text); } catch (_) {}
    return {
      status: upstream.status,
      ok: upstream.ok,
      ms: Date.now() - started,
      contentType: upstream.headers.get("content-type") || "",
      body: jsonBody,
      bytes: Buffer.byteLength(text),
    };
  } catch (e) {
    return {
      status: 0,
      ok: false,
      ms: Date.now() - started,
      error: e?.name === "AbortError" ? "timeout" : String(e?.message || e),
    };
  } finally { clearTimeout(timeout); }
}

async function liveDiagnostic(req, res, u) {
  if (!rateAllowed(req)) return json(res,429,{ok:false,error:"Too many requests",retryAfterSeconds:60});
  const symbol = safeSymbol(u.searchParams.get("symbol")) || "COMI";
  const started = Date.now();
  const result = {
    ok:false, server:"Borsa Smart PRO V19", provider:DATA_PROVIDER,
    upstream: EGXPILOT_MCP_URL, configured:true, reachable:false,
    authenticated:null, liveData:null, symbol,
    checkedAt:new Date().toISOString(), latencyMs:null, probes:{}
  };
  try {
    const client = await getMcpClient();
    const listed = await withTimeout(client.listTools(), MCP_CALL_TIMEOUT_MS, "EGXpilot MCP listTools");
    const toolNames = Array.isArray(listed?.tools) ? listed.tools.map(t => t.name).filter(Boolean) : [];
    result.reachable = true; result.authenticated = true;
    result.probes.tools = { status:200, ok:true, count:toolNames.length, names:toolNames.slice(0,50) };
    const r = await mcpSnapshot(symbol);
    result.liveData = true;
    result.probes.snapshot = { status:200, ok:true, hasPrice:r.quote.price != null, stale:false };
    result.quote = r.quote;
    result.ok = true;
    result.message = "EGXpilot MCP connection, tool discovery, and live snapshot succeeded.";
  } catch(e) {
    result.message = String(e?.message||e);
    result.errorCode = e?.code || e?.cause?.code || null;
  }
  result.latencyMs = Date.now()-started;
  return json(res,200,result);
}

async function proxy(req, res, targetPath) {
  if (req.method !== "GET") return json(res, 405, { ok:false, error:"Method not allowed" }, { "Allow": "GET" });
  if (!rateAllowed(req)) return json(res, 429, { ok:false, error:"Too many requests", retryAfterSeconds:60 });
  const target = new URL(targetPath, EGXPILOT_BASE + "/");
  // Never follow a path outside the configured EGXpilot origin.
  if (target.origin !== baseUrl.origin || !allowedPath(target.pathname)) {
    return json(res, 404, { ok: false, error: "Endpoint not allowed by V15 proxy" });
  }

  const headers = {
    Accept: "application/json",
    "User-Agent": "BorsaSmartPRO-V11/1.0",
  };
  if (API_KEY) {
    headers[AUTH_HEADER] = AUTH_SCHEME ? `${AUTH_SCHEME} ${API_KEY}` : API_KEY;
  }

  const key=cacheKey(target), cached=cache.get(key), now=Date.now();
  if(cached && now-cached.ts<CACHE_TTL_MS){
    return send(res, cached.status, cached.body, cached.contentType, {"X-BorsaSmart-Cache":"HIT"});
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(target, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error",
    });

    const contentType = upstream.headers.get("content-type") || "";
    const text = await upstream.text();

    // The app expects JSON; reject HTML/error pages masquerading as successful API responses.
    if (!contentType.toLowerCase().includes("json")) {
      return json(res, 502, {
        ok: false,
        error: "EGXpilot returned a non-JSON response",
        upstreamStatus: upstream.status,
      });
    }

    if(upstream.ok){cache.set(key,{ts:now,status:upstream.status,body:text,contentType});trimCache();}
    send(res, upstream.status, text, contentType, { "X-BorsaSmart-Proxy": "EGXpilot", "X-BorsaSmart-Cache": upstream.ok ? "MISS" : "BYPASS" });
  } catch (e) {
    const message = e?.name === "AbortError"
      ? "EGXpilot request timed out"
      : String(e?.message || e);
    json(res, 502, { ok: false, error: "EGXpilot upstream unavailable", detail: message });
  } finally {
    clearTimeout(timeout);
  }
}


function safeSymbol(symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  return /^[A-Z0-9._-]{1,20}$/.test(s) ? s : null;
}

function csvField(v) {
  const s = String(v ?? "").trim();
  const n = Number(s);
  return Number.isFinite(n) && s !== "" ? n : (s === "" ? null : s);
}

function loadLocalHistory(symbol) {
  const safe = safeSymbol(symbol);
  if (!safe) return null;

  // Compact GitHub/Render-friendly fallback dataset.
  const compactFile = path.join(DATA_DIR, "legacy_history.json");
  if (fs.existsSync(compactFile)) {
    try {
      const all = JSON.parse(fs.readFileSync(compactFile, "utf8"));
      if (Array.isArray(all[safe])) return all[safe];
    } catch (_) {}
  }

  // Optional legacy raw CSV fallback for older local installations.
  const rawDir = path.join(DATA_DIR, "raw");
  if (!fs.existsSync(rawDir)) return null;
  const dirs = fs.readdirSync(rawDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith(safe + "_"));
  if (!dirs.length) return null;
  const file = path.join(DATA_DIR, "raw", dirs[0].name, safe + ".csv");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  const ix = Object.fromEntries(headers.map((h, i) => [h.trim(), i]));
  return lines.slice(1).map(line => {
    const cols = line.split(",");
    return {
      t: cols[ix.Date] || null,
      o: csvField(cols[ix.Open]),
      h: csvField(cols[ix.High]),
      l: csvField(cols[ix.Low]),
      c: csvField(cols[ix.Close]),
      v: csvField(cols[ix.Volume])
    };
  }).filter(x => Number.isFinite(x.c) && Number.isFinite(x.h) && Number.isFinite(x.l));
}

async function localHistory(req, res, u) {
  if (!rateAllowed(req)) return json(res, 429, { ok: false, error: "Too many requests", retryAfterSeconds: 60 });
  const symbol = safeSymbol(u.searchParams.get("symbol"));
  if (!symbol) return json(res, 400, { ok: false, error: "Invalid symbol" });
  try {
    const ohlcv = loadLocalHistory(symbol);
    if (!ohlcv) return json(res, 404, { ok: false, error: "Local history not found", symbol });
    return json(res, 200, { ok: true, source: "bundled-historical-fallback", symbol, count: ohlcv.length, ohlcv });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Local history read failed", detail: String(e?.message || e) });
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // V11 ships only the public dashboard asset. This also blocks traversal and hidden-file access.
  if (!["index.html"].includes(rel)) return false;

  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && u.pathname === "/api/egx/diagnostic") {
      return liveDiagnostic(req, res, u);
    }

    if (req.method === "GET" && u.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        server: "Borsa Smart PRO V19",
        egxpilot: baseUrl.origin,
        apiKeyConfigured: false, mcpConfigured: DATA_PROVIDER === "egxpilot-mcp" || DATA_PROVIDER === "auto",
        dataProvider: DATA_PROVIDER,
        egxapi: egxApiUrl.origin,
        time: new Date().toISOString(),
      });
    }

    if (req.method === "GET" && u.pathname === "/api/market/diagnostic") return marketDiagnostic(req,res,u);
    if (req.method === "GET" && u.pathname === "/api/market/quote") return liveMarket(req,res,u);
    if (req.method === "GET" && u.pathname === "/api/market/quotes") return liveQuotes(req,res,u);
    if (req.method === "GET" && u.pathname === "/api/market/history") return liveHistory(req,res,u);

    if (u.pathname === "/api/analysis/history" && (req.method === "GET" || req.method === "POST")) return analysisHistory(req,res,u);

    if (req.method === "GET" && u.pathname === "/api/local/history") {
      return localHistory(req, res, u);
    }

    if (req.method === "GET" && u.pathname.startsWith("/api/egx/")) {
      const targetPath = u.pathname.slice("/api/egx".length) + u.search;
      if (!allowedPath(u.pathname.slice("/api/egx".length))) {
        return json(res, 404, { ok: false, error: "Endpoint not allowed by V15 proxy" });
      }
      return proxy(req, res, targetPath);
    }

    if (req.method === "GET" && serveStatic(res, u.pathname)) return;

    return json(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Server error", detail: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Borsa Smart PRO V19 listening on http://localhost:${PORT}`);
  console.log(`Live provider: ${DATA_PROVIDER}`);
  console.log(`MCP endpoint: ${EGXPILOT_MCP_URL}`);
});
