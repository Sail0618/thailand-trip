// ============================================================
// EdgeOne Pages Functions — 泰国行程 API 核心逻辑
// 部署平台：腾讯云 EdgeOne Pages（免费版，国内节点可访问）
//
// 说明：
//  - 本文件实现全部 /api/* 接口（与 server.js 行为一致），
//    存储使用 EdgeOne KV（绑定变量名 THAILAND_KV，key = "data"）。
//  - 仅使用标准 Web API（fetch / Request / Response / URL），
//    无 Node 内置模块，可在 Edge Functions（V8）环境运行。
//  - KV 为空时：只初始化内置模板（绝不自动从 JSONBin 覆盖，避免旧快照覆盖新数据）。
//    需要从 JSONBin 迁移请手动调用 POST /api/migrate（需 confirm:true，覆盖前先备份）。
//  - 每次写入前自动把被替换的旧版本存入 KV key "data_history"（保留最近 20 份），
//    可通过 GET /api/data/history 查询，防止覆盖/误删无法找回。
//  - 测试：node --test test/edgeone-functions.test.js
// ============================================================

import { initialData } from "./initial-data.mjs";

// ---------- 常量（与 server.js 保持一致） ----------
const STATUS_OPTIONS = ["已订", "待定", "已取消"];
const DATA_KEY = "data";
const HISTORY_KEY = "data_history";
const HISTORY_LIMIT = 20; // 历史快照最多保留份数
const LOCATIONS_KEY = "locations";          // 位置独立存储（KV key）
const LOCATIONS_BLOB_KEY = "trip_locations"; // 位置独立存储（Blob key，无 KV 时用）
const FX_KEY = "fx_live";
const STALE_LOCATION_MS = 10 * 60 * 1000; // 10 分钟
const FX_API_URL = "https://open.er-api.com/v6/latest/CNY";
const FX_LIVE_CACHE_MS = 10 * 60 * 1000; // 实时汇率缓存 10 分钟
const JSONBIN_URL = "https://api.jsonbin.io/v3/b";
const GEO_API = "https://api.bigdatacloud.net/data/reverse-geocode-client";
const GEO_CACHE_TTL_MS = 30 * 60 * 1000;

// ---------- 小工具 ----------
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function cleanStr(v, max = 500) {
  if (v === undefined || v === null) return "";
  return String(v).slice(0, max);
}

function cleanNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function pickPatch(body, allow) {
  const patch = {};
  for (const k of allow) if (k in (body || {})) patch[k] = body[k];
  return patch;
}

// 操作变更记录：追加一条"谁·做了什么·什么时候"（最多保留 60 条）
function logAction(data, user, action) {
  const list = Array.isArray(data.changelog) ? data.changelog : [];
  list.push({
    id: genId("c"),
    user: cleanStr(user, 50) || "匿名",
    action: cleanStr(action, 200),
    at: Date.now()
  });
  while (list.length > 60) list.shift();
  data.changelog = list;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// ---------- 数据读取 / 保存（KV） ----------
function resolveKv(env) {
  return (env && (env.THAILAND_KV || env.kv)) || globalThis.THAILAND_KV;
}

async function kvGet(kv, key) {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error("KV 读取失败：" + (e && e.message));
    return null;
  }
}

async function kvPut(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

// 数据结构规范化（与 server.js normalize 保持一致）
function normalize(data) {
  data = data || {};
  data.flights = Array.isArray(data.flights) ? data.flights : [];
  data.days = Array.isArray(data.days) ? data.days : [];
  data.todos = (Array.isArray(data.todos) ? data.todos : []).map((t) => ({ date: t.date || "", ...t }));
  data.locations = Array.isArray(data.locations) ? data.locations : [];
  data.meta = data.meta || clone(initialData.meta);
  const fx = Number(data.fxRate);
  data.fxRate = isFinite(fx) && fx > 0 ? fx : 5;
  if (!data.alert) data.alert = null;
  data.lastUpdated = data.lastUpdated || null;
  data.version = Number(data.version) || 0;

  if (Array.isArray(data.budget) && !Array.isArray(data.budgetCNY)) {
    data.budgetCNY = data.budget.map((b) => {
      if (!("spend" in b)) {
        return {
          id: b.id, item: b.item || "账单", detail: b.detail || "",
          spend: Number(b.spendCNY ?? b.amount) || 0,
          paid: Number(b.paidCNY ?? b.amount) || 0
        };
      }
      return { id: b.id, item: b.item, detail: b.detail || "", spend: Number(b.spend) || 0, paid: Number(b.paid) || 0 };
    });
  }

  if (data.budgetCNY === undefined && data.budget === undefined && data.budgetTHB === undefined) {
    data.budgetCNY = clone(initialData.budgetCNY);
    data.budgetTHB = [];
  }
  if (!Array.isArray(data.budgetCNY)) data.budgetCNY = [];
  if (!Array.isArray(data.budgetTHB)) data.budgetTHB = [];
  data.receipts = Array.isArray(data.receipts) ? data.receipts : [];
  delete data.budget;

  return data;
}

function pruneStaleLocations(data) {
  if (!Array.isArray(data.locations)) return;
  const now = Date.now();
  data.locations = data.locations.filter((l) => now - (l.updatedAt || 0) < STALE_LOCATION_MS);
}

// JSONBin 直连读写（KV 未绑定时的回退存储；读写均需 Master Key）
async function jsonbinLoad(env) {
  const binId = env && env.JSONBIN_BIN_ID;
  const key = env && env.JSONBIN_API_KEY;
  if (!binId || !key) return null;
  const res = await fetch(`${JSONBIN_URL}/${binId}/latest`, {
    headers: { "X-Master-Key": key },
    signal: timeoutSignal(8000)
  });
  if (!res.ok) throw new Error("JSONBin 读取失败 HTTP " + res.status);
  const payload = await res.json();
  return payload && payload.record ? payload.record : null;
}

async function jsonbinSave(env, data) {
  const binId = env && env.JSONBIN_BIN_ID;
  const key = env && env.JSONBIN_API_KEY;
  if (!binId || !key) throw new Error("未配置 JSONBIN_BIN_ID / JSONBIN_API_KEY，无法写入 JSONBin");
  const res = await fetch(`${JSONBIN_URL}/${binId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": key },
    body: JSON.stringify(data),
    signal: timeoutSignal(8000)
  });
  if (!res.ok) throw new Error("JSONBin 写入失败 HTTP " + res.status);
}

// 从 JSONBin 一次性迁移（只允许手动触发，绝不自动覆盖 KV）
async function migrateFromJsonbin(env) {
  try {
    return await jsonbinLoad(env);
  } catch (e) {
    console.error("JSONBin 迁移失败：" + (e && e.message));
    return null;
  }
}

// 保存历史快照：把将被替换的旧数据追加到 data_history（保留最近 HISTORY_LIMIT 份）
async function pushHistory(kv, prevData) {
  if (!kv) return;
  try {
    const history = (await kvGet(kv, HISTORY_KEY)) || [];
    history.push({
      version: Number(prevData && prevData.version) || 0,
      lastUpdated: (prevData && prevData.lastUpdated) || null,
      savedAt: Date.now(),
      data: clone(prevData)
    });
    while (history.length > HISTORY_LIMIT) history.shift();
    await kvPut(kv, HISTORY_KEY, history);
  } catch (e) {
    console.error("历史备份失败：" + (e && e.message));
  }
}

async function load(kv, env) {
  if (kv) {
    let data = await kvGet(kv, DATA_KEY);
    if (!data) {
      // KV 为空：只初始化内置模板。
      // 绝不自动从 JSONBin 覆盖 —— 曾因"模板自动重迁移"用旧快照覆盖真实数据导致丢数据。
      // 需要迁移请手动调用 POST /api/migrate。
      data = clone(initialData);
      await kvPut(kv, DATA_KEY, data);
    }
    return normalize(data);
  }
  // KV 未绑定 → 先用 Blob 缓存（快、不消耗 JSONBin 配额），再回退 JSONBin
  const blob = await blobCacheRead();
  if (blob) { degradedReadOnly = false; return normalize(blob.data); } // 有缓存：直接用，不打 JSONBin

  const binId = env && env.JSONBIN_BIN_ID;
  const apiKey = env && env.JSONBIN_API_KEY;
  if (!binId || !apiKey) {
    // 未配置云存储：只能使用内置初始数据
    degradedReadOnly = false;
    return normalize(clone(initialData));
  }
  try {
    const data = await jsonbinLoad(env);
    if (data) {
      degradedReadOnly = false;
      await blobCacheWrite(data);                  // 写入 Blob 缓存，后续读取不再打 JSONBin
      return normalize(data);
    }
  } catch (e) {
    console.error("JSONBin 读取失败：" + (e && e.message));
    // 无缓存且 JSONBin 失败 → 降级只读（返回初始数据给前端展示缓存，
    // 并禁止写入，防止模板覆盖真实云数据）
    degradedReadOnly = true;
    return normalize(clone(initialData));
  }
  degradedReadOnly = false;
  return normalize(clone(initialData));
}

async function save(kv, env, data) {
  if (kv) return kvPut(kv, DATA_KEY, data);
  // 降级只读态禁止写入（防止模板覆盖真实云数据）
  if (degradedReadOnly) throw new Error("数据源暂不可用，请稍后再试");
  // 无 KV：写 Blob（主，快），JSONBin 作备份（失败不阻塞——避免 JSONBin 限流时无法编辑）
  let ok = false;
  try {
    await blobCacheWrite(data);
    ok = true;
  } catch (e) { /* 忽略 */ }
  try {
    await jsonbinSave(env, data);
    ok = true;
  } catch (e) {
    console.error("JSONBin 备份失败：" + (e && e.message));
  }
  if (!ok) throw new Error("数据保存失败，请稍后重试");
}

async function commit(kv, env, nextStore) {
  // 先把被替换前的旧版本存入历史（防覆盖/误删丢失）
  if (kv) {
    try {
      const prev = await kvGet(kv, DATA_KEY);
      if (prev) await pushHistory(kv, prev);
    } catch (e) { /* 历史备份失败不影响主流程 */ }
  }
  nextStore.lastUpdated = new Date().toISOString();
  nextStore.version = (Number(nextStore.version) || 0) + 1;
  pruneStaleLocations(nextStore);
  await save(kv, env, nextStore);
  // 异步备份一份到 JSONBin（如已配置），防 KV 命名空间被清空/重建后无据可依
  if (kv && env && env.JSONBIN_BIN_ID && env.JSONBIN_API_KEY) {
    jsonbinSave(env, nextStore).catch((e) => console.error("JSONBin 备份失败：" + (e && e.message)));
  }
  return nextStore;
}

// ---------- 乐观锁 ----------
function expectedVersion(query, body) {
  const v = body && body.version !== undefined ? body.version : query.get("version");
  // 未传版本时返回 undefined（不做乐观锁校验），而不是 Number(null)=0 误判 409
  return (v === undefined || v === null || v === "") ? undefined : Number(v);
}

function assertVersion(current, expected) {
  if (expected !== undefined && Number(current.version || 0) !== expected) {
    const err = new Error("数据已被他人更新，请刷新后重试");
    err.status = 409;
    throw err;
  }
}

// ---------- 实时汇率 ----------
// 逆地理编码：BigDataCloud 免费服务，支持中文、全球覆盖；KV 缓存 30 分钟
function buildAddress(d) {
  const parts = [];
  if (d && d.countryName) parts.push(d.countryName);
  const region = d && d.principalSubdivision && d.principalSubdivision !== d.countryName ? d.principalSubdivision : "";
  const city = d && d.city && d.city !== d.principalSubdivision ? d.city : "";
  const loc = d && d.locality && d.locality !== city && d.locality !== d.principalSubdivision ? d.locality : "";
  parts.push(region, city, loc);
  return parts.filter(Boolean).join(" ");
}

async function resolveAddress(kv, env, lat, lng) {
  const key = "geo_" + Number(lat).toFixed(4) + "_" + Number(lng).toFixed(4);
  if (kv) {
    try {
      const cached = await kvGet(kv, key);
      if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) return cached.address;
    } catch (e) { /* ignore */ }
  }
  try {
    const url = `${GEO_API}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&localityLanguage=zh`;
    const res = await fetch(url, {
      headers: { "User-Agent": "thailand-trip-shared/1.0" },
      signal: timeoutSignal(5000)
    });
    if (res.ok) {
      const d = await res.json();
      const addr = buildAddress(d);
      if (addr && kv) await kvPut(kv, key, { address: addr, at: Date.now() }).catch(() => {});
      return addr;
    }
  } catch (e) { /* 解析失败返回空 */ }
  return "";
}

async function withAddresses(kv, env, list) {
  return Promise.all(list.map(async (l) => ({ ...l, address: await resolveAddress(kv, env, l.lat, l.lng) })));
}

function timeoutSignal(ms) {
  // Edge Functions 环境若支持 AbortSignal.timeout 则用之，否则用 Promise.race
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

async function fetchLiveFxRate(kv, env) {
  let cached = null;
  if (kv) cached = await kvGet(kv, FX_KEY);
  if (cached && cached.rate && cached.fetchedAt && Date.now() - cached.fetchedAt < FX_LIVE_CACHE_MS) {
    return { rate: cached.rate, source: cached.source, fetchedAt: cached.fetchedAt };
  }
  try {
    const res = await fetch(FX_API_URL, {
      headers: { Accept: "application/json" },
      signal: timeoutSignal(8000)
    });
    if (!res.ok) throw new Error("汇率 API HTTP " + res.status);
    const payload = await res.json();
    const rate = Number(payload && payload.rates && payload.rates.THB);
    if (!isFinite(rate) || rate <= 0) throw new Error("汇率数据异常");
    const live = { rate, source: payload.provider || "open.er-api.com", fetchedAt: Date.now() };
    if (kv) await kvPut(kv, FX_KEY, live).catch(() => {});
    return live;
  } catch (e) {
    if (cached && cached.rate) {
      return { rate: cached.rate, source: cached.source, fetchedAt: cached.fetchedAt, stale: true, error: e.message };
    }
    throw new Error("获取实时汇率失败：" + (e && e.message));
  }
}

// ---------- 业务路由 ----------
function cleanFlight(body) {
  const b = body || {};
  const status = STATUS_OPTIONS.includes(b.status) ? b.status : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    date: cleanStr(b.date, 100),
    route: cleanStr(b.route, 200) || "新航线",
    dep: cleanStr(b.dep, 50),
    arr: cleanStr(b.arr, 50),
    flightNo: cleanStr(b.flightNo, 100),
    bookingNo: cleanStr(b.bookingNo, 100),
    note: cleanStr(b.note, 500)
  };
}

function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function budgetList(current, type) {
  return type === "thb" ? current.budgetTHB : current.budgetCNY;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

// EdgeOne Blob 图片存储（惰性加载；本地/测试环境不可用时返回 null）
let _blobStorePromise = null;
function getBlobStore() {
  if (_blobStorePromise) return _blobStorePromise;
  _blobStorePromise = (async () => {
    try {
      const sdk = await import("@edgeone/pages-blob");
      return sdk.getStore("thailand-receipts");
    } catch (e) {
      console.error("Blob 不可用：" + (e && e.message));
      return null;
    }
  })();
  return _blobStorePromise;
}

// EdgeOne Blob 数据缓存（KV 未审批时用）：读写走 Blob（快、不消耗 JSONBin 配额），JSONBin 仅作备份
const DATA_CACHE_KEY = "trip_data_cache";
const DATA_CACHE_TTL_MS = 300 * 1000; // 缓存 5 分钟
let degradedReadOnly = false; // JSONBin 不可达且无缓存时进入降级只读态，禁止写入防止覆盖真实数据

async function blobCacheRead() {
  try {
    const store = await getBlobStore();
    if (!store) return null;
    const raw = await store.get(DATA_CACHE_KEY, { type: "text" });
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const data = obj && obj.data ? obj.data : null;
    if (!data) return null;
    // 过期缓存仍可兜底（JSONBin 失败时用），返回时带上时间戳
    return { data, cachedAt: obj.savedAt || 0 };
  } catch (e) {
    return null;
  }
}

async function blobCacheWrite(data) {
  try {
    const store = await getBlobStore();
    if (!store) return;
    await store.set(DATA_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch (e) { /* 缓存写入失败不影响主流程 */ }
}

// 位置独立读写：位置更新不 bump 主数据版本，避免所有在线客户端整页重渲染
async function loadLocations(kv) {
  if (kv) {
    const raw = await kvGet(kv, LOCATIONS_KEY);
    return Array.isArray(raw) ? raw : [];
  }
  try {
    const store = await getBlobStore();
    if (!store) return [];
    // 位置用强一致读取：确保自己刚上报的位置立刻可见（避免最终一致延迟）
    const raw = await store.get(LOCATIONS_BLOB_KEY, { type: "text", consistency: "strong" });
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
async function saveLocations(kv, list) {
  if (kv) {
    await kvPut(kv, LOCATIONS_KEY, list);
    return;
  }
  const store = await getBlobStore();
  if (!store) throw new Error("位置服务不可用");
  await store.set(LOCATIONS_BLOB_KEY, JSON.stringify(list));
}

async function handleApi(method, pathname, query, body, kv, env, user) {
  const seg = pathname.split("/").filter(Boolean).map(safeDecode); // ["api", "data", ...]

  // /api/data/history（读取历史备份，用于数据找回；仅 KV 模式）
  if (seg[1] === "data" && seg[2] === "history" && seg.length === 3 && method === "GET") {
    if (!kv) return json({ error: "仅 KV 模式支持历史备份" }, 400);
    const history = (await kvGet(kv, HISTORY_KEY)) || [];
    return json(history);
  }

  // /api/migrate（手动从 JSONBin 一次性迁移，需显式确认；默认绝不自动覆盖）
  if (seg[1] === "migrate" && seg.length === 2 && method === "POST") {
    const b = body || {};
    if (b.source !== "jsonbin" || b.confirm !== true) {
      return json({ error: '需要 { "source": "jsonbin", "confirm": true }' }, 400);
    }
    const migrated = await migrateFromJsonbin(env);
    if (!migrated) {
      return json({ error: "JSONBin 无可用数据，或未配置 JSONBIN_BIN_ID / JSONBIN_API_KEY" }, 400);
    }
    // 覆盖前先备份当前 KV 数据
    if (kv) {
      const prev = await kvGet(kv, DATA_KEY);
      if (prev) await pushHistory(kv, prev);
      await kvPut(kv, DATA_KEY, migrated);
    } else {
      await jsonbinSave(env, migrated);
    }
    return json({ ok: true, version: Number(migrated.version) || 0 });
  }

  // /api/data
  if (seg[1] === "data" && seg.length === 2) {
    if (method === "GET") return json(await load(kv, env));
    if (method === "PUT") {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "无效的数据格式" }, 400);
      }
      const current = await load(kv, env);
      assertVersion(current, expectedVersion(query, body));
      const next = normalize(body);
      logAction(next, user, "恢复了线上数据");
      const saved = await commit(kv, env, next);
      return json({ ok: true, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }

  // /api/health
  if (seg[1] === "health" && seg.length === 2 && method === "GET") {
    const data = await load(kv, env);
    return json({ ok: true, storage: "edgeone-kv", version: data.version });
  }

  // /api/status-options
  if (seg[1] === "status-options" && seg.length === 2 && method === "GET") {
    return json(STATUS_OPTIONS);
  }

  // /api/fx
  if (seg[1] === "fx" && seg.length === 2 && method === "POST") {
    const current = await load(kv, env);
    assertVersion(current, expectedVersion(query, body));
    const rate = Number(body && body.rate);
    if (!isFinite(rate) || rate <= 0) return json({ error: "汇率需为正数" }, 400);
    current.fxRate = rate;
    logAction(current, user, `更新汇率 → ${rate}`);
    const saved = await commit(kv, env, current);
    return json({ ok: true, version: saved.version });
  }

  // /api/fx/live
  if (seg[1] === "fx" && seg[2] === "live" && seg.length === 3 && method === "GET") {
    try {
      const live = await fetchLiveFxRate(kv, env);
      return json({ ok: true, ...live });
    } catch (e) {
      return json({ ok: false, error: e.message }, 502);
    }
  }

  // /api/fx/refresh
  if (seg[1] === "fx" && seg[2] === "refresh" && seg.length === 3 && method === "POST") {
    const current = await load(kv, env);
    assertVersion(current, expectedVersion(query, body));
    const live = await fetchLiveFxRate(kv, env);
    current.fxRate = live.rate;
    logAction(current, user, `更新汇率 → ${live.rate}（实时）`);
    const saved = await commit(kv, env, current);
    return json({ ok: true, rate: live.rate, source: live.source, fetchedAt: live.fetchedAt, version: saved.version });
  }

  // /api/flights
  if (seg[1] === "flights" && seg.length === 2) {
    const current = await load(kv, env);
    if (method === "GET") return json(current.flights || []);
    if (method === "POST") {
      assertVersion(current, expectedVersion(query, body));
      const f = cleanFlight(body);
      const flight = {
        id: genId("f"),
        status: f.status || "待定",
        date: f.date, route: f.route, dep: f.dep, arr: f.arr,
        flightNo: f.flightNo, bookingNo: f.bookingNo, note: f.note
      };
      current.flights.push(flight);
      logAction(current, user, `新增航班「${flight.route || "未填航线"}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, id: flight.id, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }
  if (seg[1] === "flights" && seg.length === 3) {
    const id = seg[2];
    const current = await load(kv, env);
    const idx = current.flights.findIndex((f) => f.id === id);
    if (method === "POST") {
      if (idx === -1) return json({ error: "航班不存在" }, 404);
      assertVersion(current, expectedVersion(query, body));
      const mergedFlight = { ...current.flights[idx], ...cleanFlight(body) };
      current.flights[idx] = mergedFlight;
      logAction(current, user, `更新航班「${mergedFlight.route || ""}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    if (method === "DELETE") {
      const removedFlight = current.flights.find((f) => f.id === id);
      current.flights = current.flights.filter((f) => f.id !== id);
      logAction(current, user, `删除航班「${(removedFlight && removedFlight.route) || ""}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }

  // /api/todos
  if (seg[1] === "todos" && seg.length === 2) {
    const current = await load(kv, env);
    if (method === "GET") return json(current.todos || []);
    if (method === "POST") {
      assertVersion(current, expectedVersion(query, body));
      const todo = {
        id: genId("t"),
        category: cleanStr(body && body.category, 50) || "其他",
        text: cleanStr(body && body.text, 500) || "新待办",
        date: cleanStr(body && body.date, 20),
        done: false
      };
      current.todos.push(todo);
      logAction(current, user, `新增待办「${todo.text}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, id: todo.id, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }
  if (seg[1] === "todos" && seg.length === 3) {
    const id = seg[2];
    const current = await load(kv, env);
    const idx = current.todos.findIndex((t) => t.id === id);
    if (method === "POST") {
      if (idx === -1) return json({ error: "待办不存在" }, 404);
      assertVersion(current, expectedVersion(query, body));
      const patch = pickPatch(body, ["done", "text", "category", "date"]);
      if ("done" in patch) patch.done = !!patch.done;
      if ("text" in patch) patch.text = cleanStr(patch.text, 500);
      if ("category" in patch) patch.category = cleanStr(patch.category, 50) || "其他";
      if ("date" in patch) patch.date = cleanStr(patch.date, 20);
      const beforeTodo = current.todos[idx];
      const afterTodo = { ...beforeTodo, ...patch };
      current.todos[idx] = afterTodo;
      const todoAct = patch.done !== undefined
        ? (patch.done ? `勾选待办「${afterTodo.text}」` : `取消勾选待办「${afterTodo.text}」`)
        : `更新待办「${afterTodo.text}」`;
      logAction(current, user, todoAct);
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    if (method === "DELETE") {
      const removedTodo = current.todos.find((t) => t.id === id);
      current.todos = current.todos.filter((t) => t.id !== id);
      logAction(current, user, `删除待办「${(removedTodo && removedTodo.text) || ""}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }

  // /api/days/:id（更新某一天）
  if (seg[1] === "days" && seg.length === 3 && method === "POST") {
    const id = seg[2];
    const current = await load(kv, env);
    const idx = current.days.findIndex((d) => d.id === id);
    if (idx === -1) return json({ error: "行程不存在" }, 404);
    assertVersion(current, expectedVersion(query, body));
    const patch = pickPatch(body, ["date", "month", "weekday", "title", "sub", "color", "tag", "items"]);
    for (const k of ["date", "month", "weekday", "title", "sub", "color", "tag"]) {
      if (k in patch) patch[k] = cleanStr(patch[k], 200);
    }
    if ("items" in patch) {
      patch.items = Array.isArray(patch.items)
        ? patch.items.slice(0, 50).map((it) => ({
            dot: cleanStr(it && it.dot, 20),
            time: cleanStr(it && it.time, 100),
            title: cleanStr(it && it.title, 300) || "行程项",
            desc: Array.isArray(it && it.desc) ? it.desc.slice(0, 20).map((x) => cleanStr(x, 500)) : []
          }))
        : [];
    }
    const afterDay = { ...current.days[idx], ...patch };
    current.days[idx] = afterDay;
    logAction(current, user, `更新行程「${afterDay.title || afterDay.date || ""}」`);
    const saved = await commit(kv, env, current);
    return json({ ok: true, version: saved.version });
  }

  // /api/days/:id（删除一天）
  if (seg[1] === "days" && seg.length === 3 && method === "DELETE") {
    const id = seg[2];
    const current = await load(kv, env);
    const removedDay = current.days.find((d) => d.id === id);
    current.days = current.days.filter((d) => d.id !== id);
    logAction(current, user, `删除行程「${(removedDay && (removedDay.title || removedDay.date)) || ""}」`);
    const saved = await commit(kv, env, current);
    return json({ ok: true, version: saved.version });
  }

  // /api/days（新增一天）
  if (seg[1] === "days" && seg.length === 2 && method === "POST") {
    const current = await load(kv, env);
    assertVersion(current, expectedVersion(query, body));
    const b = body || {};
    const day = {
      id: genId("d"),
      date: cleanStr(b.date, 20) || "?",
      month: cleanStr(b.month, 20) || "",
      weekday: cleanStr(b.weekday, 20) || "",
      title: cleanStr(b.title, 200) || "新的一天",
      sub: cleanStr(b.sub, 200),
      color: cleanStr(b.color, 20) || "#0F766E",
      tag: cleanStr(b.tag, 50),
      items: []
    };
    current.days.push(day);
    logAction(current, user, `新增行程「${day.title || day.date || ""}」`);
    const saved = await commit(kv, env, current);
    return json({ ok: true, id: day.id, version: saved.version });
  }

  // /api/receipts/image（读取小票图片）
  if (seg[1] === "receipts" && seg[2] === "image" && seg.length === 3 && method === "GET") {
    const store = await getBlobStore();
    const key = query.get("key") || "";
    if (!store || !key) return json({ error: "图片不存在" }, 404);
    try {
      const data = await store.get(key, { type: "blob" });
      if (!data) return json({ error: "图片不存在" }, 404);
      return new Response(data, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" }
      });
    } catch (e) {
      return json({ error: "图片读取失败" }, 500);
    }
  }

  // /api/receipts/image-url（签发 Blob 预签名上传 URL）
  if (seg[1] === "receipts" && seg[2] === "image-url" && seg.length === 3 && method === "POST") {
    const store = await getBlobStore();
    if (!store) return json({ error: "图片服务不可用" }, 503);
    try {
      const b = body || {};
      const ext = /^\.[a-z0-9]{1,5}$/i.test(b.ext) ? b.ext : ".jpg";
      const key = "receipts/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext;
      const { url } = await store.createUploadUrl(key, {
        contentType: "image/jpeg",
        expireSeconds: 3600
      });
      return json({ url, key });
    } catch (e) {
      return json({ error: "签发上传地址失败：" + (e && e.message) }, 500);
    }
  }

  // /api/receipts
  if (seg[1] === "receipts" && seg.length === 2) {
    const current = await load(kv, env);
    if (method === "GET") return json(current.receipts || []);
    if (method === "POST") {
      assertVersion(current, expectedVersion(query, body));
      const b = body || {};
      const receipt = {
        id: genId("r"),
        user: cleanStr(b.user, 50) || "匿名",
        store: cleanStr(b.store, 200),
        amount: cleanNum(b.amount),
        refund: cleanNum(b.refund),
        date: cleanStr(b.date, 20),
        note: cleanStr(b.note, 500),
        imageKey: cleanStr(b.imageKey, 300),
        createdAt: Date.now()
      };
      current.receipts.push(receipt);
      logAction(current, user, `上传小票「${receipt.store || "未填店名"}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, id: receipt.id, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }

  // /api/receipts/:id
  if (seg[1] === "receipts" && seg.length === 3) {
    const id = seg[2];
    const current = await load(kv, env);
    const idx = current.receipts.findIndex((r) => r.id === id);
    if (method === "POST") {
      if (idx === -1) return json({ error: "小票不存在" }, 404);
      assertVersion(current, expectedVersion(query, body));
      const patch = pickPatch(body, ["user", "store", "amount", "refund", "date", "note", "imageKey"]);
      if ("user" in patch) patch.user = cleanStr(patch.user, 50) || "匿名";
      if ("store" in patch) patch.store = cleanStr(patch.store, 200);
      if ("amount" in patch) patch.amount = cleanNum(patch.amount);
      if ("refund" in patch) patch.refund = cleanNum(patch.refund);
      if ("date" in patch) patch.date = cleanStr(patch.date, 20);
      if ("note" in patch) patch.note = cleanStr(patch.note, 500);
      if ("imageKey" in patch) patch.imageKey = cleanStr(patch.imageKey, 300);
      const afterReceipt = { ...current.receipts[idx], ...patch };
      current.receipts[idx] = afterReceipt;
      logAction(current, user, `更新小票「${afterReceipt.store || ""}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    if (method === "DELETE") {
      const removedReceipt = current.receipts.find((r) => r.id === id);
      current.receipts = current.receipts.filter((r) => r.id !== id);
      logAction(current, user, `删除小票「${(removedReceipt && removedReceipt.store) || ""}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }

  // /api/budget/:type
  if (seg[1] === "budget" && seg.length === 3) {
    const type = seg[2] === "thb" ? "thb" : "cny";
    const current = await load(kv, env);
    if (method === "GET") return json(budgetList(current, type));
    if (method === "POST") {
      assertVersion(current, expectedVersion(query, body));
      const item = {
        id: genId(type === "thb" ? "bt" : "bc"),
        item: cleanStr(body && body.item, 200) || "新账单",
        detail: cleanStr(body && body.detail, 500),
        spend: cleanNum(body && body.spend),
        paid: cleanNum(body && body.paid)
      };
      budgetList(current, type).push(item);
      logAction(current, user, `新增账单「${item.item}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, id: item.id, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }
  if (seg[1] === "budget" && seg.length === 4) {
    const type = seg[2] === "thb" ? "thb" : "cny";
    const id = seg[3];
    const current = await load(kv, env);
    const list = budgetList(current, type);
    const idx = list.findIndex((b) => b.id === id);
    if (method === "POST") {
      if (idx === -1) return json({ error: "预算项不存在" }, 404);
      assertVersion(current, expectedVersion(query, body));
      const patch = pickPatch(body, ["spend", "paid", "item", "detail"]);
      if ("spend" in patch) patch.spend = cleanNum(patch.spend);
      if ("paid" in patch) patch.paid = cleanNum(patch.paid);
      if ("item" in patch) patch.item = cleanStr(patch.item, 200);
      if ("detail" in patch) patch.detail = cleanStr(patch.detail, 500);
      const afterBill = { ...list[idx], ...patch };
      list[idx] = afterBill;
      logAction(current, user, `更新账单「${afterBill.item || ""}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    if (method === "DELETE") {
      const removedBill = list[idx];
      list.splice(idx, 1);
      logAction(current, user, `删除账单「${(removedBill && removedBill.item) || ""}」`);
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }

  // /api/locations
  if (seg[1] === "locations" && seg.length === 2) {
    if (method === "GET") {
      const now = Date.now();
      const list = (await loadLocations(kv)).filter((l) => now - (l.updatedAt || 0) < STALE_LOCATION_MS);
      return json(await withAddresses(kv, env, list));
    }
    if (method === "POST") {
      const name = cleanStr(body && body.name, 50);
      const lat = Number(body && body.lat);
      const lng = Number(body && body.lng);
      if (!name || !isFinite(lat) || !isFinite(lng)) {
        return json({ error: "需要 name、lat、lng 字段" }, 400);
      }
      const id = cleanStr(body && body.id, 100) ||
        "user_" + name.replace(/\s+/g, "_").slice(0, 30) + "_" + Math.random().toString(36).slice(2, 8);
      const list = await loadLocations(kv);
      const idx = list.findIndex((l) => l.id === id);
      const entry = {
        id, name, lat, lng,
        accuracy: isFinite(Number(body && body.accuracy)) ? Number(body.accuracy) : null,
        color: cleanStr(body && body.color, 20) || null,
        updatedAt: Date.now()
      };
      if (idx === -1) list.push(entry);
      else list[idx] = entry;
      await saveLocations(kv, list); // 独立存储：不 bump 主数据版本
      return json({ ok: true, id });
    }
    return json({ error: "不支持的方法" }, 405);
  }
  if (seg[1] === "locations" && seg.length === 3 && method === "DELETE") {
    const id = seg[2];
    const list = await loadLocations(kv);
    await saveLocations(kv, list.filter((l) => l.id !== id));
    return json({ ok: true });
  }

  return json({ error: "接口不存在" }, 404);
}

// ---------- 入口 ----------
export async function onRequest(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    let body = null;
    if (method !== "GET" && method !== "HEAD" && request.body) {
      try {
        body = await request.json();
      } catch (e) { /* 无 body 或非 JSON */ }
    }
    const kv = resolveKv(env);
    const user = safeDecode(cleanStr(request.headers.get("x-user"), 50));
    // KV 未绑定时允许回退 JSONBin（需配置 JSONBIN_BIN_ID / JSONBIN_API_KEY）
    return await handleApi(method, url.pathname, url.searchParams, body, kv, env, user);
  } catch (e) {
    if (e && e.status === 409) return json({ error: e.message }, 409);
    return json({ error: (e && e.message) || "服务器错误" }, 500);
  }
}
