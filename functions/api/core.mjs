// ============================================================
// EdgeOne Pages Functions — 泰国行程 API 核心逻辑
// 部署平台：腾讯云 EdgeOne Pages（免费版，国内节点可访问）
//
// 说明：
//  - 本文件实现全部 /api/* 接口（与 server.js 行为一致），
//    存储使用 EdgeOne KV（绑定变量名 THAILAND_KV，key = "data"）。
//  - 仅使用标准 Web API（fetch / Request / Response / URL），
//    无 Node 内置模块，可在 Edge Functions（V8）环境运行。
//  - KV 为空时：若配置了 JSONBIN_BIN_ID / JSONBIN_API_KEY 环境变量，
//    则自动从 JSONBin 一次性迁移现有数据；否则使用初始数据。
//  - 测试：node --test test/edgeone-functions.test.js
// ============================================================

import { initialData } from "./initial-data.mjs";

// ---------- 常量（与 server.js 保持一致） ----------
const STATUS_OPTIONS = ["已订", "待定", "已取消"];
const DATA_KEY = "data";
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

// 从 JSONBin 一次性迁移（仅当 KV 为空且配置了 JSONBIN 环境变量时）
async function migrateFromJsonbin(env) {
  try {
    return await jsonbinLoad(env);
  } catch (e) {
    console.error("JSONBin 迁移失败：" + (e && e.message));
    return null;
  }
}

// 判断是否为"未初始化模板"（内置初始数据，尚无真实写入）
// 特征：version <= 0 且 lastUpdated 为空。真实保存过的数据 version>=1 且带时间戳。
function isUninitializedTemplate(data) {
  return !data || (Number(data.version) <= 0 && !data.lastUpdated);
}

async function load(kv, env) {
  if (kv) {
    let data = await kvGet(kv, DATA_KEY);
    if (!data) {
      data = (await migrateFromJsonbin(env)) || clone(initialData);
      await kvPut(kv, DATA_KEY, data);
    } else if (isUninitializedTemplate(data) && env && env.JSONBIN_BIN_ID) {
      // KV 里还是初始模板，但已配置 JSONBin → 重新拉取真实数据覆盖（修复历史误初始化）
      const migrated = await migrateFromJsonbin(env);
      if (migrated) {
        data = migrated;
        await kvPut(kv, DATA_KEY, data);
      }
    }
    return normalize(data);
  }
  // KV 未绑定 → JSONBin 直连回退；再不行用初始数据
  try {
    const data = await jsonbinLoad(env);
    if (data) return normalize(data);
  } catch (e) {
    console.error("JSONBin 读取失败，使用初始数据：" + (e && e.message));
  }
  return normalize(clone(initialData));
}

async function save(kv, env, data) {
  if (kv) return kvPut(kv, DATA_KEY, data);
  await jsonbinSave(env, data);
}

async function commit(kv, env, nextStore) {
  nextStore.lastUpdated = new Date().toISOString();
  nextStore.version = (Number(nextStore.version) || 0) + 1;
  pruneStaleLocations(nextStore);
  await save(kv, env, nextStore);
  return nextStore;
}

// ---------- 乐观锁 ----------
function expectedVersion(query, body) {
  const v = body && body.version !== undefined ? body.version : query.get("version");
  return v === undefined ? undefined : Number(v);
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

async function handleApi(method, pathname, query, body, kv, env) {
  const seg = pathname.split("/").filter(Boolean).map(safeDecode); // ["api", "data", ...]

  // /api/data
  if (seg[1] === "data" && seg.length === 2) {
    if (method === "GET") return json(await load(kv, env));
    if (method === "PUT") {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "无效的数据格式" }, 400);
      }
      const current = await load(kv, env);
      assertVersion(current, expectedVersion(query, body));
      const saved = await commit(kv, env, normalize(body));
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
      current.flights[idx] = { ...current.flights[idx], ...cleanFlight(body) };
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    if (method === "DELETE") {
      current.flights = current.flights.filter((f) => f.id !== id);
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
      current.todos[idx] = { ...current.todos[idx], ...patch };
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    if (method === "DELETE") {
      current.todos = current.todos.filter((t) => t.id !== id);
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
    current.days[idx] = { ...current.days[idx], ...patch };
    const saved = await commit(kv, env, current);
    return json({ ok: true, version: saved.version });
  }

  // /api/days/:id（删除一天）
  if (seg[1] === "days" && seg.length === 3 && method === "DELETE") {
    const id = seg[2];
    const current = await load(kv, env);
    current.days = current.days.filter((d) => d.id !== id);
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
      current.receipts[idx] = { ...current.receipts[idx], ...patch };
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    if (method === "DELETE") {
      current.receipts = current.receipts.filter((r) => r.id !== id);
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
      list[idx] = { ...list[idx], ...patch };
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    if (method === "DELETE") {
      list.splice(idx, 1);
      const saved = await commit(kv, env, current);
      return json({ ok: true, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }

  // /api/locations
  if (seg[1] === "locations" && seg.length === 2) {
    const current = await load(kv, env);
    if (method === "GET") {
      const now = Date.now();
      const list = (current.locations || []).filter((l) => now - (l.updatedAt || 0) < STALE_LOCATION_MS);
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
      const idx = current.locations.findIndex((l) => l.id === id);
      const entry = {
        id, name, lat, lng,
        accuracy: isFinite(Number(body && body.accuracy)) ? Number(body.accuracy) : null,
        color: cleanStr(body && body.color, 20) || null,
        updatedAt: Date.now()
      };
      if (idx === -1) current.locations.push(entry);
      else current.locations[idx] = entry;
      const saved = await commit(kv, env, current);
      return json({ ok: true, id, version: saved.version });
    }
    return json({ error: "不支持的方法" }, 405);
  }
  if (seg[1] === "locations" && seg.length === 3 && method === "DELETE") {
    const id = seg[2];
    const current = await load(kv, env);
    current.locations = current.locations.filter((l) => l.id !== id);
    const saved = await commit(kv, env, current);
    return json({ ok: true, version: saved.version });
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
    // KV 未绑定时允许回退 JSONBin（需配置 JSONBIN_BIN_ID / JSONBIN_API_KEY）
    return await handleApi(method, url.pathname, url.searchParams, body, kv, env);
  } catch (e) {
    if (e && e.status === 409) return json({ error: e.message }, 409);
    return json({ error: (e && e.message) || "服务器错误" }, 500);
  }
}
