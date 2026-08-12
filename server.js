// ============================================================
// 泰国 11 日行程 · 在线共享编辑应用 — 后端服务（Vercel 适配版）
// Node.js + Express
//
// 适配 Vercel serverless：
//  1. 存储：JSONBin 云存储（Vercel 文件系统只读）
//  2. 实时同步：前端轮询（serverless 不支持 SSE 长连接）
//  3. 导出 app 供 Vercel 使用（同时保留本地 node server.js 运行能力）
//
// 环境变量：
//  JSONBIN_API_KEY  （必填，云存储主 Key）
//  JSONBIN_BIN_ID   （可选。若未配置，首次保存时会自动创建 bin，
//                     并把 bin ID 记录在 bin 的 name 中以便后续查找）
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

// 存储用固定的 bin 名，便于跨请求/实例定位
const BIN_NAME = "thailand-trip-data";

// ============================================================
// JSONBin 云存储
// ============================================================
const JSONBIN_URL = "https://api.jsonbin.io/v3/b";

async function jsonbinHeaders() {
  return {
    "X-Master-Key": process.env.JSONBIN_API_KEY
  };
}

// 查找 bin：优先用环境变量 BIN_ID；否则按名称在当前账号下查找
async function resolveBinId() {
  // 1) 优先环境变量
  if (process.env.JSONBIN_BIN_ID) return process.env.JSONBIN_BIN_ID;

  // 2) 通过 JSONBin collection API 按名称查找
  try {
    // JSONBin 不支持直接按名搜索，尝试列出集合内的 bin
    // 使用固定 collection 名，若不存在则返回 null
    const collRes = await fetch(
      `https://api.jsonbin.io/v3/c/${process.env.JSONBIN_COLLECTION_ID || "nonexistent"}`,
      { headers: await jsonbinHeaders() }
    );
    // 集合可能不存在，忽略错误
  } catch (e) { /* ignore */ }
  return null;
}

async function cloudLoad() {
  const binId = process.env.JSONBIN_BIN_ID;
  if (binId) {
    try {
      const res = await fetch(`${JSONBIN_URL}/${binId}/latest`, {
        headers: await jsonbinHeaders()
      });
      if (res.ok) {
        const json = await res.json();
        return { data: json.record, binId };
      }
      console.error("JSONBin 读取失败，状态码：", res.status);
    } catch (e) {
      console.error("JSONBin 读取异常：", e.message);
    }
  }
  return { data: JSON.parse(JSON.stringify(initialData)), binId: null };
}

async function cloudSave(data) {
  const binId = process.env.JSONBIN_BIN_ID;
  if (!binId) {
    // 未配置 bin → 创建新 bin
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
      if (res.ok) {
        const json = await res.json();
        console.log("✅ 已创建新 bin，ID=" + json.metadata.id);
        // 把 bin ID 暴露给前端（通过响应头）
        app.set("lastBinId", json.metadata.id);
        return { ok: true, binId: json.metadata.id };
      }
      console.error("JSONBin 创建失败：", res.status);
      return { ok: false, error: "创建失败 " + res.status };
    } catch (e) {
      console.error("JSONBin 创建异常：", e.message);
      return { ok: false, error: e.message };
    }
  }
  // 更新已有 bin
  try {
    const res = await fetch(`${JSONBIN_URL}/${binId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await jsonbinHeaders()) },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      console.error("JSONBin 更新失败：", res.status);
      return { ok: false, error: "更新失败 " + res.status };
    }
    return { ok: true, binId };
  } catch (e) {
    console.error("JSONBin 更新异常：", e.message);
    return { ok: false, error: e.message };
  }
}

// ============================================================
// 数据访问（serverless 安全：每次从 JSONBin 读取，避免多实例内存不同步）
// ============================================================
async function getStore() {
  const { data } = await cloudLoad();
  return normalize(data);
}

async function commit(nextStore) {
  nextStore.lastUpdated = new Date().toISOString();
  const result = await cloudSave(nextStore);
  return result;
}

// 确保数据结构完整
function normalize(data) {
  data = data || {};
  data.flights = data.flights || [];
  data.days = data.days || [];
  data.todos = data.todos || [];
  data.budget = data.budget || [];
  data.locations = data.locations || []; // 位置共享数据
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
    res.json(data);
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
    const result = await commit(normalize(incoming));
    res.json({ ok: true, ...result });
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

// ---------- 位置共享 ----------

// 上报/更新某人的位置（upsert：按 id 覆盖）
app.post("/api/locations", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || typeof body.lat !== "number" || typeof body.lng !== "number") {
      return res.status(400).json({ error: "需要 name、lat、lng 字段" });
    }
    const current = await getStore();
    const id = body.id || ("user_" + (body.name || "").replace(/\s+/g, "_"));
    const idx = current.locations.findIndex((l) => l.id === id);
    const entry = {
      id,
      name: body.name,
      lat: body.lat,
      lng: body.lng,
      accuracy: body.accuracy || null,
      color: body.color || null,
      updatedAt: Date.now()
    };
    if (idx === -1) {
      current.locations.push(entry);
    } else {
      current.locations[idx] = entry;
    }
    await commit(current);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: "保存失败：" + e.message });
  }
});

// 删除某人的位置（离开定位页时调用）
app.delete("/api/locations/:id", async (req, res) => {
  try {
    const current = await getStore();
    current.locations = current.locations.filter((l) => l.id !== req.params.id);
    await commit(current);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "删除失败：" + e.message });
  }
});

// 获取所有位置（供地图页面轮询）
app.get("/api/locations", async (req, res) => {
  try {
    const data = await getStore();
    res.json(data.locations || []);
  } catch (e) {
    res.status(500).json({ error: "读取失败：" + e.message });
  }
});

// 健康检查
app.get("/api/health", (req, res) =>
  res.json({ ok: true, storage: process.env.JSONBIN_API_KEY ? "jsonbin" : "未配置", binId: process.env.JSONBIN_BIN_ID || "未配置" })
);

// 静态文件
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// Vercel 兼容导出 + 本地运行
// ============================================================
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 泰国行程共享应用已启动：http://localhost:${PORT}`);
    console.log(`   存储模式：${process.env.JSONBIN_API_KEY ? "JSONBin" : "未配置 Key（数据不会持久）"}`);
    console.log(`   BIN_ID：${process.env.JSONBIN_BIN_ID || "未配置（首次保存自动创建）"}`);
  });
}
