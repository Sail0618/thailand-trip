// ============================================================
// 泰国 11 日行程 · 在线共享编辑应用 — 后端服务（Vercel 适配版）
// Node.js + Express
//
// 适配 Vercel serverless：
//  1. 存储：纯 JSONBin 云存储（Vercel 文件系统只读，无法本地持久化）
//  2. 实时同步：改用前端轮询（serverless 不支持 SSE 长连接）
//  3. 导出 app 供 Vercel 使用（同时保留本地 node server.js 运行能力）
//
// 环境变量：
//  JSONBIN_API_KEY  （必填，云存储主 Key）
//  JSONBIN_BIN_ID   （可选，已有 bin 的 ID；留空则首次创建）
//  JSONBIN_PRIVATE  （可选，默认 false）
//  PORT             （本地运行端口，默认 8080）
// ============================================================

const express = require("express");
const path = require("path");

const { initialData } = require("./data/schema");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

// 状态枚举
const STATUS_OPTIONS = ["已订", "待定", "已取消"];

// ============================================================
// JSONBin 云存储
// ============================================================
const JSONBIN_URL = "https://api.jsonbin.io/v3/b";

async function cloudLoad() {
  const binId = process.env.JSONBIN_BIN_ID;
  if (binId) {
    try {
      const res = await fetch(`${JSONBIN_URL}/${binId}/latest`, {
        headers: { "X-Master-Key": process.env.JSONBIN_API_KEY }
      });
      if (res.ok) {
        const json = await res.json();
        return json.record;
      }
      console.error("JSONBin 读取失败，状态码：", res.status);
    } catch (e) {
      console.error("JSONBin 读取异常：", e.message);
    }
  }
  return JSON.parse(JSON.stringify(initialData));
}

async function cloudSave(data) {
  let binId = process.env.JSONBIN_BIN_ID;
  if (!binId) {
    // 创建新 bin
    try {
      const res = await fetch(JSONBIN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Master-Key": process.env.JSONBIN_API_KEY,
          "X-Bin-Private": process.env.JSONBIN_PRIVATE || "false"
        },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        const json = await res.json();
        console.log("✅ 已在 JSONBin 创建新 bin，ID：", json.metadata.id);
        console.log("⚠️ 请将以下值配置到平台环境变量 JSONBIN_BIN_ID：");
        console.log("   JSONBIN_BIN_ID=" + json.metadata.id);
        return json.metadata.id;
      }
      console.error("JSONBin 创建失败：", res.status);
    } catch (e) {
      console.error("JSONBin 创建异常：", e.message);
    }
    return null;
  }
  // 更新已有 bin
  try {
    const res = await fetch(`${JSONBIN_URL}/${binId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Master-Key": process.env.JSONBIN_API_KEY
      },
      body: JSON.stringify(data)
    });
    if (!res.ok) console.error("JSONBin 更新失败：", res.status);
  } catch (e) {
    console.error("JSONBin 更新异常：", e.message);
  }
  return binId;
}

// ============================================================
// 内存缓存（serverless 冷启动时快速返回，降低 JSONBin 请求）
// 注意：serverless 环境多实例不共享内存，但 JSONBin 是最终数据源
// ============================================================
let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5000; // 缓存 5 秒

async function getStore() {
  // 若内存有较新缓存，直接返回（本地/单一实例）
  if (cache && Date.now() - cacheTime < CACHE_TTL_MS) {
    return JSON.parse(JSON.stringify(cache));
  }
  const data = await cloudLoad();
  cache = data;
  cacheTime = Date.now();
  return JSON.parse(JSON.stringify(data));
}

async function commit(nextStore) {
  nextStore.lastUpdated = new Date().toISOString();
  cache = nextStore;          // 立即更新内存缓存
  cacheTime = Date.now();
  await cloudSave(nextStore); // 异步持久化到 JSONBin
  return nextStore;
}

// 确保数据结构完整
function normalize(data) {
  data.flights = data.flights || [];
  data.days = data.days || [];
  data.todos = data.todos || [];
  data.budget = data.budget || [];
  data.meta = data.meta || initialData.meta;
  if (!data.alert) data.alert = initialData.alert;
  data.lastUpdated = data.lastUpdated || null;
  return data;
}

// ============================================================
// API 路由
// ============================================================

// 获取全量数据
app.get("/api/data", async (req, res) => {
  try {
    const data = await getStore();
    res.json(normalize(data));
  } catch (e) {
    res.status(500).json({ error: "读取失败：" + e.message });
  }
});

// 覆盖式更新
app.put("/api/data", async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== "object") {
    return res.status(400).json({ error: "无效的数据格式" });
  }
  try {
    const next = await commit(normalize(incoming));
    res.json({ ok: true, lastUpdated: next.lastUpdated });
  } catch (e) {
    res.status(500).json({ error: "保存失败：" + e.message });
  }
});

// 更新单个航班
app.post("/api/flights/:id", async (req, res) => {
  try {
    const current = await getStore();
    const idx = current.flights.findIndex((f) => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "航班不存在" });
    current.flights[idx] = { ...current.flights[idx], ...(req.body || {}) };
    await commit(current);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "保存失败：" + e.message });
  }
});

// 新增航班
app.post("/api/flights", async (req, res) => {
  try {
    const current = await getStore();
    const body = req.body || {};
    current.flights.push({
      id: "f" + Date.now(),
      date: body.date || "", route: body.route || "新航线",
      dep: body.dep || "", arr: body.arr || "",
      flightNo: body.flightNo || "", bookingNo: body.bookingNo || "",
      status: STATUS_OPTIONS.includes(body.status) ? body.status : "待定",
      note: body.note || ""
    });
    await commit(current);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "保存失败：" + e.message });
  }
});

// 删除航班
app.delete("/api/flights/:id", async (req, res) => {
  try {
    const current = await getStore();
    current.flights = current.flights.filter((f) => f.id !== req.params.id);
    await commit(current);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "删除失败：" + e.message });
  }
});

// 待办
app.post("/api/todos/:id", async (req, res) => {
  try {
    const current = await getStore();
    const idx = current.todos.findIndex((t) => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "待办不存在" });
    current.todos[idx] = { ...current.todos[idx], ...(req.body || {}) };
    await commit(current);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "保存失败：" + e.message });
  }
});
app.post("/api/todos", async (req, res) => {
  try {
    const current = await getStore();
    const body = req.body || {};
    current.todos.push({ id: "t" + Date.now(), category: body.category || "其他", text: body.text || "新待办", done: false });
    await commit(current);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "保存失败：" + e.message });
  }
});
app.delete("/api/todos/:id", async (req, res) => {
  try {
    const current = await getStore();
    current.todos = current.todos.filter((t) => t.id !== req.params.id);
    await commit(current);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "删除失败：" + e.message });
  }
});

// 预算
app.post("/api/budget/:id", async (req, res) => {
  try {
    const current = await getStore();
    const idx = current.budget.findIndex((b) => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "预算项不存在" });
    current.budget[idx] = { ...current.budget[idx], ...(req.body || {}) };
    await commit(current);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "保存失败：" + e.message });
  }
});

// 状态选项
app.get("/api/status-options", (req, res) => res.json(STATUS_OPTIONS));

// 健康检查
app.get("/api/health", (req, res) =>
  res.json({ ok: true, storage: process.env.JSONBIN_API_KEY ? "jsonbin" : "未配置" })
);

// 静态文件
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// Vercel 兼容导出 + 本地运行
// ============================================================
module.exports = app; // Vercel 使用

if (require.main === module) {
  // 本地直接运行：node server.js
  app.listen(PORT, () => {
    console.log(`✅ 泰国行程共享应用已启动：http://localhost:${PORT}`);
    console.log(`   存储模式：${process.env.JSONBIN_API_KEY ? "JSONBin 云存储" : "未配置 Key（数据不会持久）"}`);
  });
}
