// ============================================================
// 泰国行程 · 在线共享编辑应用 — 后端服务
// Node.js + Express
//
// 存储策略（自动选择）：
//  1. 配置了 JSONBIN_API_KEY → JSONBin 云存储（生产环境）
//  2. 未配置 → 本地文件 data/store.json（本地/自建部署，重启不丢）
//
// 并发控制：
//  所有写接口支持乐观锁。请求携带当前 version（body 或 ?version=），
//  若与服务器最新 version 不一致则返回 409，前端立即刷新，避免多人覆盖。
//
// 环境变量：
//  JSONBIN_API_KEY   （可选，云存储主 Key）
//  JSONBIN_BIN_ID    （可选。未配置时首次保存自动创建 bin 并固定）
//  JSONBIN_PRIVATE   （可选，默认 false）
//  PORT              （本地运行端口，默认 8080）
//  LOCAL_STORE_FILE  （可选，本地存储路径，测试用）
// ============================================================

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const { initialData } = require("./data/schema");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

// 状态枚举
const STATUS_OPTIONS = ["已订", "待定", "已取消"];

// 存储用固定的 bin 名，便于跨请求/实例定位
const BIN_NAME = "thailand-trip-data";
const JSONBIN_URL = "https://api.jsonbin.io/v3/b";

// 本地文件存储路径（可用环境变量覆盖，便于测试）
const LOCAL_STORE_FILE =
  process.env.LOCAL_STORE_FILE || path.join(__dirname, "data", "store.json");

// 位置共享：超过该时长未更新的位置视为过期（幽灵成员清理）
const STALE_LOCATION_MS = 10 * 60 * 1000; // 10 分钟

// 逆地理编码（地址解析）：BigDataCloud 免费服务，支持中文、全球覆盖
// 仅在 GET /api/locations 时按需解析，内存缓存 30 分钟避免重复请求
const GEO_ENABLED = process.env.DISABLE_GEOCODING !== "1";
const GEO_API = "https://api.bigdatacloud.net/data/reverse-geocode-client";
const GEO_CACHE_TTL_MS = 30 * 60 * 1000;
const geoCache = new Map(); // "lat,lng" -> { address, at }

// 从 BigDataCloud 返回中拼接中文地址（泰国 → 曼谷 → 区）
function buildAddress(d) {
  const parts = [];
  if (d && d.countryName) parts.push(d.countryName);
  const region = d && d.principalSubdivision && d.principalSubdivision !== d.countryName ? d.principalSubdivision : "";
  const city = d && d.city && d.city !== d.principalSubdivision ? d.city : "";
  const loc = d && d.locality && d.locality !== city && d.locality !== d.principalSubdivision ? d.locality : "";
  parts.push(region, city, loc);
  return parts.filter(Boolean).join(" ");
}

async function resolveAddress(lat, lng) {
  if (!GEO_ENABLED) return "";
  const key = Number(lat).toFixed(4) + "," + Number(lng).toFixed(4);
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_CACHE_TTL_MS) return hit.address;
  try {
    const url = `${GEO_API}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&localityLanguage=zh`;
    const res = await fetch(url, {
      headers: { "User-Agent": "thailand-trip-shared/1.0" },
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const d = await res.json();
      const addr = buildAddress(d);
      if (addr) {
        geoCache.set(key, { address: addr, at: Date.now() });
        return addr;
      }
    }
  } catch (e) { /* 解析失败返回空，前端显示占位 */ }
  return "";
}

async function withAddresses(list) {
  return Promise.all(list.map(async (l) => ({ ...l, address: await resolveAddress(l.lat, l.lng) })));
}

// GET 读缓存：轮询每 4s 一次，命中缓存可大幅减少 JSONBin 请求（配额保护）
const CACHE_TTL_MS = 2500;

// 实时汇率：open.er-api.com 免费 API（无需 Key，CNY 为基准返回 THB 等币种）
const FX_API_URL = "https://open.er-api.com/v6/latest/CNY";
const FX_AUTO_REFRESH_MS = 6 * 60 * 60 * 1000; // 每 6 小时自动更新一次
const FX_LIVE_CACHE_MS = 10 * 60 * 1000;        // 实时汇率缓存 10 分钟

// 运行期固定的 bin ID（一旦确定，进程内不再改变）
let runtimeBinId = null;

// ------------------------------------------------------------
// JSONBin 云存储
// ------------------------------------------------------------
async function jsonbinHeaders() {
  return { "X-Master-Key": process.env.JSONBIN_API_KEY };
}

// 确定当前使用的 bin ID（固定，不随请求变化）
function getBinId() {
  if (runtimeBinId) return runtimeBinId;
  if (process.env.JSONBIN_BIN_ID) {
    runtimeBinId = process.env.JSONBIN_BIN_ID;
    return runtimeBinId;
  }
  return null;
}

async function cloudLoad() {
  const binId = getBinId();
  if (binId) {
    // 已配置 bin：读取失败必须抛错，绝不能静默回退初始数据
    // （否则下一次保存会用初始数据整包覆盖真实云数据）
    const res = await fetch(`${JSONBIN_URL}/${binId}/latest`, {
      headers: await jsonbinHeaders()
    });
    if (!res.ok) {
      throw new Error(`云存储读取失败（HTTP ${res.status}）`);
    }
    const json = await res.json();
    return { data: json.record, source: "jsonbin" };
  }
  // 未配置 bin：无 Key 时回退本地文件
  if (!process.env.JSONBIN_API_KEY) {
    const local = await localLoad();
    if (local) return { data: local, source: "local" };
  }
  return { data: JSON.parse(JSON.stringify(initialData)), source: "new" };
}

async function cloudSave(data) {
  const binId = getBinId();
  if (!binId) {
    // 未配置 bin 且尚未固定 → 创建新 bin 并固定
    try {
      const res = await fetch(JSONBIN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await jsonbinHeaders()),
          "X-Bin-Name": BIN_NAME,
          "X-Bin-Private": process.env.JSONBIN_PRIVATE || "false"
        },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        return { ok: false, error: `云存储创建失败（HTTP ${res.status}）` };
      }
      const json = await res.json();
      runtimeBinId = json.metadata.id; // 固定，后续请求都用这个 bin
      console.log("✅ 已固定 bin，ID=" + runtimeBinId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "云存储创建异常：" + e.message };
    }
  }
  // 更新已有 bin
  try {
    const res = await fetch(`${JSONBIN_URL}/${binId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await jsonbinHeaders()) },
      body: JSON.stringify(data)
    });
    if (!res.ok) return { ok: false, error: `云存储更新失败（HTTP ${res.status}）` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "云存储更新异常：" + e.message };
  }
}

// ------------------------------------------------------------
// 本地文件存储（未配置 JSONBin 时的持久化回退）
// ------------------------------------------------------------
async function localLoad() {
  try {
    const raw = await fsp.readFile(LOCAL_STORE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    console.error("本地存储读取失败：", e.message);
    return null;
  }
}

async function localSave(data) {
  try {
    await fsp.mkdir(path.dirname(LOCAL_STORE_FILE), { recursive: true });
    // 保存前自动备份旧文件到 data/backups/（保留最近 10 份，防止误删/损坏丢数据）
    if (process.env.DISABLE_BACKUP !== "1") {
      try {
        const exists = await fsp.access(LOCAL_STORE_FILE).then(() => true).catch(() => false);
        if (exists) {
          const bakDir = path.join(path.dirname(LOCAL_STORE_FILE), "backups");
          await fsp.mkdir(bakDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const bakFile = path.join(bakDir, "store-" + stamp + ".json");
          await fsp.copyFile(LOCAL_STORE_FILE, bakFile);
          const files = (await fsp.readdir(bakDir))
            .filter((f) => f.startsWith("store-") && f.endsWith(".json"))
            .sort();
          while (files.length > 10) {
            const old = files.shift();
            await fsp.unlink(path.join(bakDir, old)).catch(() => {});
          }
        }
      } catch (e) { /* 备份失败不影响主流程 */ }
    }
    await fsp.writeFile(LOCAL_STORE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    if (process.env.VERCEL) {
      throw new Error("本地存储不可用（Vercel 文件系统只读），请配置 JSONBIN_API_KEY");
    }
    throw new Error("本地存储写入失败：" + e.message);
  }
}

// 统一保存入口：按是否配置云 Key 选择存储后端；失败一律抛错（绝不静默）
async function saveStore(data) {
  if (process.env.JSONBIN_API_KEY) {
    const result = await cloudSave(data);
    if (!result.ok) throw new Error(result.error);
    return;
  }
  await localSave(data);
}

// ------------------------------------------------------------
// 数据访问与结构规范化
// ------------------------------------------------------------
async function getStore() {
  const { data } = await cloudLoad();
  return normalize(data);
}

async function commit(nextStore) {
  nextStore.lastUpdated = new Date().toISOString();
  nextStore.version = (Number(nextStore.version) || 0) + 1;
  pruneStaleLocations(nextStore);
  await saveStore(nextStore);
  invalidateCache();
  return nextStore;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// 确保数据结构完整
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

  // 预算迁移：旧版单个 budget 数组 → budgetCNY
  if (Array.isArray(data.budget) && !Array.isArray(data.budgetCNY)) {
    data.budgetCNY = data.budget.map((b) => {
      if (!("spend" in b)) {
        return {
          id: b.id, item: b.item || "账单", detail: b.detail || "",
          spend: Number(b.spendCNY ?? b.amount) || 0,
          paid:  Number(b.paidCNY  ?? b.amount) || 0
        };
      }
      return { id: b.id, item: b.item, detail: b.detail || "", spend: Number(b.spend) || 0, paid: Number(b.paid) || 0 };
    });
  }

  // 全新数据（三个预算字段都不存在）→ 注入初始账单；
  // 空数组保留（允许用户清空 ¥ / ฿ 表，不再自动复活初始数据）
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

// 清理过期位置（防止“幽灵成员”）
function pruneStaleLocations(data) {
  if (!Array.isArray(data.locations)) return;
  const now = Date.now();
  data.locations = data.locations.filter((l) => now - (l.updatedAt || 0) < STALE_LOCATION_MS);
}

// ------------------------------------------------------------
// 读缓存（仅缓存 GET，写操作后失效）
// ------------------------------------------------------------
let cache = { key: null, data: null, at: 0 };
function cacheGet(key) {
  if (cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  return null;
}
function cacheSet(key, data) {
  cache = { key, data, at: Date.now() };
}
function invalidateCache() {
  cache = { key: null, data: null, at: 0 };
}

// ------------------------------------------------------------
// 输入清洗与乐观锁辅助
// ------------------------------------------------------------
function cleanStr(v, max = 500) {
  if (v === undefined || v === null) return "";
  return String(v).slice(0, max);
}

function cleanNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

// 从 body 或 query 中取出客户端携带的 version
function expectedVersion(req) {
  const v =
    req.body && req.body.version !== undefined ? req.body.version : req.query.version;
  return v === undefined ? undefined : Number(v);
}

// 版本不一致时抛 409，由 route() 统一转成响应
function assertVersion(current, expected) {
  if (expected !== undefined && Number(current.version || 0) !== expected) {
    const err = new Error("数据已被他人更新，请刷新后重试");
    err.status = 409;
    throw err;
  }
}

// 路由包装器：统一 try/catch + 错误码映射
function route(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ error: e.message });
      res.status(500).json({ error: e.message || "服务器错误" });
    }
  };
}

// 从请求体中提取 patch，并按白名单过滤（防止写入非法字段）
function pickPatch(body, allow) {
  const patch = {};
  for (const k of allow) if (k in (body || {})) patch[k] = body[k];
  return patch;
}

// 干净的航班字段（用于新增/更新）
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

// ------------------------------------------------------------
// 路由：数据
// ------------------------------------------------------------

// 获取全量数据
app.get("/api/data", route(async (req, res) => {
  const cached = cacheGet("data");
  if (cached) return res.json(cached);
  const data = await getStore();
  cacheSet("data", data);
  res.json(data);
}));

// 覆盖式更新（带乐观锁）
app.put("/api/data", route(async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "无效的数据格式" });
  }
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const saved = await commit(normalize(incoming));
  res.json({ ok: true, version: saved.version });
}));

// ------------------------------------------------------------
// 路由：航班
// ------------------------------------------------------------
app.get("/api/flights", route(async (req, res) => {
  const data = await getStore();
  res.json(data.flights || []);
}));

// 更新单个航班
app.post("/api/flights/:id", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const idx = current.flights.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "航班不存在" });
  current.flights[idx] = { ...current.flights[idx], ...cleanFlight(req.body) };
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// 新增航班
app.post("/api/flights", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const body = req.body || {};
  const f = cleanFlight(body);
  current.flights.push({
    id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: f.status || "待定",
    date: f.date, route: f.route, dep: f.dep, arr: f.arr,
    flightNo: f.flightNo, bookingNo: f.bookingNo, note: f.note
  });
  const saved = await commit(current);
  res.json({ ok: true, id: current.flights[current.flights.length - 1].id, version: saved.version });
}));

// 删除航班
app.delete("/api/flights/:id", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  current.flights = current.flights.filter((f) => f.id !== req.params.id);
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// ------------------------------------------------------------
// 路由：待办
// ------------------------------------------------------------
app.get("/api/todos", route(async (req, res) => {
  const data = await getStore();
  res.json(data.todos || []);
}));

app.post("/api/todos/:id", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const idx = current.todos.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "待办不存在" });
  const patch = pickPatch(req.body, ["done", "text", "category", "date"]);
  if ("done" in patch) patch.done = !!patch.done;
  if ("text" in patch) patch.text = cleanStr(patch.text, 500);
  if ("category" in patch) patch.category = cleanStr(patch.category, 50) || "其他";
  if ("date" in patch) patch.date = cleanStr(patch.date, 20);
  current.todos[idx] = { ...current.todos[idx], ...patch };
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

app.post("/api/todos", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const body = req.body || {};
  const todo = {
    id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    category: cleanStr(body.category, 50) || "其他",
    text: cleanStr(body.text, 500) || "新待办",
    date: cleanStr(body.date, 20),
    done: false
  };
  current.todos.push(todo);
  const saved = await commit(current);
  res.json({ ok: true, id: todo.id, version: saved.version });
}));

app.delete("/api/todos/:id", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  current.todos = current.todos.filter((t) => t.id !== req.params.id);
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// ------------------------------------------------------------
// 路由：每日行程
// ------------------------------------------------------------
// 更新某一天的行程（白名单字段 + items 清洗）
app.post("/api/days/:id", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const idx = current.days.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "行程不存在" });
  const patch = pickPatch(req.body, ["date", "month", "weekday", "title", "sub", "color", "tag", "items"]);
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
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// 新增一天
app.post("/api/days", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const body = req.body || {};
  const day = {
    id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: cleanStr(body.date, 20) || "?",
    month: cleanStr(body.month, 20) || "",
    weekday: cleanStr(body.weekday, 20) || "",
    title: cleanStr(body.title, 200) || "新的一天",
    sub: cleanStr(body.sub, 200),
    color: cleanStr(body.color, 20) || "#0F766E",
    tag: cleanStr(body.tag, 50),
    items: []
  };
  current.days.push(day);
  const saved = await commit(current);
  res.json({ ok: true, id: day.id, version: saved.version });
}));

// 删除一天
app.delete("/api/days/:id", route(async (req, res) => {
  const current = await getStore();
  current.days = current.days.filter((d) => d.id !== req.params.id);
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// ------------------------------------------------------------
// 路由：退税小票（按上传人分组；图片存本地目录或 EdgeOne Blob）
// ------------------------------------------------------------
const RECEIPTS_IMAGE_DIR = path.join(__dirname, "data", "receipts-images");

// 小票列表
app.post("/api/receipts/image-url", route(async (req, res) => {
  const b = req.body || {};
  const ext = /^\.[a-z0-9]{1,5}$/i.test(b.ext) ? b.ext : ".jpg";
  const key = "receipts/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext;
  res.json({ url: `/api/receipts/local-upload?key=${encodeURIComponent(key)}`, key });
}));

// 本地接收图片字节（生产环境走 EdgeOne Blob，此接口仅本地/自建用）
app.put("/api/receipts/local-upload", async (req, res) => {
  try {
    await fsp.mkdir(RECEIPTS_IMAGE_DIR, { recursive: true });
    const key = req.query.key || ("receipts/" + Date.now() + ".jpg");
    const safeKey = path.basename(key);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await fsp.writeFile(path.join(RECEIPTS_IMAGE_DIR, safeKey), Buffer.concat(chunks));
    res.json({ ok: true, key });
  } catch (e) {
    res.status(500).json({ error: "图片保存失败：" + e.message });
  }
});

// 读取本地图片
app.get("/api/receipts/image", async (req, res) => {
  try {
    const safeKey = path.basename(req.query.key || "");
    const file = path.join(RECEIPTS_IMAGE_DIR, safeKey);
    const data = await fsp.readFile(file);
    const ext = path.extname(safeKey).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
    res.set("Content-Type", type);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(data);
  } catch (e) {
    res.status(404).json({ error: "图片不存在" });
  }
});

app.post("/api/receipts/:id", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const idx = current.receipts.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "小票不存在" });
  const patch = pickPatch(req.body, ["user", "store", "amount", "refund", "date", "note", "imageKey"]);
  if ("user" in patch) patch.user = cleanStr(patch.user, 50) || "匿名";
  if ("store" in patch) patch.store = cleanStr(patch.store, 200);
  if ("amount" in patch) patch.amount = cleanNum(patch.amount);
  if ("refund" in patch) patch.refund = cleanNum(patch.refund);
  if ("date" in patch) patch.date = cleanStr(patch.date, 20);
  if ("note" in patch) patch.note = cleanStr(patch.note, 500);
  if ("imageKey" in patch) patch.imageKey = cleanStr(patch.imageKey, 300);
  current.receipts[idx] = { ...current.receipts[idx], ...patch };
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// 删除小票
app.delete("/api/receipts/:id", route(async (req, res) => {
  const current = await getStore();
  current.receipts = current.receipts.filter((r) => r.id !== req.params.id);
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// 签发图片上传 URL（本地：返回本地接收端点；生产 EdgeOne 用 Blob 预签名 URL）
app.get("/api/receipts", route(async (req, res) => {
  const data = await getStore();
  res.json(data.receipts || []);
}));

// 新增小票
app.post("/api/receipts", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const b = req.body || {};
  const receipt = {
    id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
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
  const saved = await commit(current);
  res.json({ ok: true, id: receipt.id, version: saved.version });
}));

// 更新小票
// ------------------------------------------------------------
// 路由：预算（¥ 人民币 / ฿ 泰铢 两套独立，互不影响）
// ------------------------------------------------------------
function budgetList(current, type) {
  return type === "thb" ? current.budgetTHB : current.budgetCNY;
}

app.get("/api/budget/:type", route(async (req, res) => {
  const type = req.params.type === "thb" ? "thb" : "cny";
  const data = await getStore();
  res.json(budgetList(data, type));
}));

// 更新某一项金额/名称
app.post("/api/budget/:type/:id", route(async (req, res) => {
  const type = req.params.type === "thb" ? "thb" : "cny";
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const list = budgetList(current, type);
  const idx = list.findIndex((b) => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "预算项不存在" });
  const patch = pickPatch(req.body, ["spend", "paid", "item", "detail"]);
  if ("spend" in patch) patch.spend = cleanNum(patch.spend);
  if ("paid" in patch) patch.paid = cleanNum(patch.paid);
  if ("item" in patch) patch.item = cleanStr(patch.item, 200);
  if ("detail" in patch) patch.detail = cleanStr(patch.detail, 500);
  list[idx] = { ...list[idx], ...patch };
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// 新增一项
app.post("/api/budget/:type", route(async (req, res) => {
  const type = req.params.type === "thb" ? "thb" : "cny";
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const list = budgetList(current, type);
  const body = req.body || {};
  const item = {
    id: (type === "thb" ? "bt" : "bc") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    item: cleanStr(body.item, 200) || "新账单",
    detail: cleanStr(body.detail, 500),
    spend: cleanNum(body.spend),
    paid: cleanNum(body.paid)
  };
  list.push(item);
  const saved = await commit(current);
  res.json({ ok: true, id: item.id, version: saved.version });
}));

// 删除某一项
app.delete("/api/budget/:type/:id", route(async (req, res) => {
  const type = req.params.type === "thb" ? "thb" : "cny";
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const list = budgetList(current, type);
  const idx = list.findIndex((b) => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "预算项不存在" });
  list.splice(idx, 1);
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// 更新汇率（1 元 = rate 泰铢，团内共享）
app.post("/api/fx", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const rate = Number(req.body?.rate);
  if (!isFinite(rate) || rate <= 0) {
    return res.status(400).json({ error: "汇率需为正数" });
  }
  current.fxRate = rate;
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// ------------------------------------------------------------
// 实时汇率（自动抓取，open.er-api.com）
// ------------------------------------------------------------
let fxLive = { rate: null, source: null, fetchedAt: null, error: null };

// 抓取实时汇率（1 元 = ? 泰铢）；命中缓存直接返回；失败时若有过期值则降级返回
async function fetchLiveFxRate() {
  if (fxLive.rate && fxLive.fetchedAt && Date.now() - fxLive.fetchedAt < FX_LIVE_CACHE_MS) {
    return { rate: fxLive.rate, source: fxLive.source, fetchedAt: fxLive.fetchedAt };
  }
  try {
    const res = await fetch(FX_API_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error("汇率 API HTTP " + res.status);
    const json = await res.json();
    const rate = Number(json?.rates?.THB);
    if (!isFinite(rate) || rate <= 0) throw new Error("汇率数据异常");
    fxLive = { rate, source: json.provider || "open.er-api.com", fetchedAt: Date.now(), error: null };
    return { rate, source: fxLive.source, fetchedAt: fxLive.fetchedAt };
  } catch (e) {
    fxLive.error = e.message;
    if (fxLive.rate) {
      // 有历史值：降级使用（标记 stale）
      return { rate: fxLive.rate, source: fxLive.source, fetchedAt: fxLive.fetchedAt, stale: true, error: e.message };
    }
    throw new Error("获取实时汇率失败：" + e.message);
  }
}

// 抓取并应用实时汇率（自动更新用，失败不抛到上层）
async function applyLiveFxRate() {
  const live = await fetchLiveFxRate();
  const current = await getStore();
  if (Math.abs(Number(current.fxRate) - live.rate) < 0.0001) {
    return { rate: live.rate, source: live.source, applied: false };
  }
  current.fxRate = live.rate;
  await commit(current);
  return { rate: live.rate, source: live.source, applied: true };
}

async function autoRefreshFx() {
  try {
    const r = await applyLiveFxRate();
    console.log(`📈 实时汇率自动更新：1 元 = ${r.rate} 泰铢${r.applied ? "" : "（无变化）"}`);
  } catch (e) {
    console.error("⚠️ 实时汇率自动更新失败：", e.message);
  }
}

// 查询实时汇率（不写入）
app.get("/api/fx/live", route(async (req, res) => {
  try {
    const live = await fetchLiveFxRate();
    res.json({ ok: true, ...live });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
}));

// 抓取实时汇率并应用（带乐观锁）
app.post("/api/fx/refresh", route(async (req, res) => {
  const current = await getStore();
  assertVersion(current, expectedVersion(req));
  const live = await fetchLiveFxRate();
  current.fxRate = live.rate;
  const saved = await commit(current);
  res.json({ ok: true, rate: live.rate, source: live.source, fetchedAt: live.fetchedAt, version: saved.version });
}));

// 状态选项
app.get("/api/status-options", (req, res) => res.json(STATUS_OPTIONS));

// ------------------------------------------------------------
// 路由：位置共享
// ------------------------------------------------------------
const LOCATION_FIELDS = ["name", "lat", "lng", "accuracy", "color", "id"];

// 上报/更新某人的位置（upsert：按 id 覆盖）
app.post("/api/locations", route(async (req, res) => {
  const body = req.body || {};
  const name = cleanStr(body.name, 50);
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!name || !isFinite(lat) || !isFinite(lng)) {
    return res.status(400).json({ error: "需要 name、lat、lng 字段" });
  }
  const current = await getStore();
  const id =
    cleanStr(body.id, 100) ||
    "user_" + name.replace(/\s+/g, "_").slice(0, 30) + "_" + Math.random().toString(36).slice(2, 8);
  const idx = current.locations.findIndex((l) => l.id === id);
  const entry = {
    id,
    name,
    lat,
    lng,
    accuracy: isFinite(Number(body.accuracy)) ? Number(body.accuracy) : null,
    color: cleanStr(body.color, 20) || null,
    updatedAt: Date.now()
  };
  if (idx === -1) current.locations.push(entry);
  else current.locations[idx] = entry;
  const saved = await commit(current);
  res.json({ ok: true, id, version: saved.version });
}));

// 删除某人的位置（离开定位页时调用）
app.delete("/api/locations/:id", route(async (req, res) => {
  const current = await getStore();
  current.locations = current.locations.filter((l) => l.id !== req.params.id);
  const saved = await commit(current);
  res.json({ ok: true, version: saved.version });
}));

// 获取所有位置（仅返回未过期成员，附逆地理编码地址）
app.get("/api/locations", route(async (req, res) => {
  const data = await getStore();
  const now = Date.now();
  const list = (data.locations || []).filter((l) => now - (l.updatedAt || 0) < STALE_LOCATION_MS);
  res.json(await withAddresses(list));
}));

// ------------------------------------------------------------
// 健康检查 & 静态文件
// ------------------------------------------------------------
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    storage: process.env.JSONBIN_API_KEY ? "jsonbin" : "local",
    binId: getBinId() || "未固定",
    version: cache.data ? cache.data.version : null
  })
);

app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------------------------
// Vercel 兼容导出 + 本地运行
// ------------------------------------------------------------
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 泰国行程共享应用已启动：http://localhost:${PORT}`);
    console.log(`   存储模式：${process.env.JSONBIN_API_KEY ? "JSONBin" : "本地文件 data/store.json"}`);
    console.log(`   当前 bin ID：${getBinId() || "未固定（首次保存自动创建并固定）"}`);
    if (process.env.JSONBIN_API_KEY && !process.env.JSONBIN_BIN_ID) {
      console.log("   ⚠️ 提示：建议配置 JSONBIN_BIN_ID 环境变量，避免多实例各自建 bin");
    }
    // 实时汇率：启动 3 秒后抓取一次，之后每 6 小时自动更新
    setTimeout(autoRefreshFx, 3000);
    setInterval(autoRefreshFx, FX_AUTO_REFRESH_MS);
  });
}
