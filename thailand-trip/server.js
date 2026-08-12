// ============================================================
// 泰国 11 日行程 · 在线共享编辑应用 — 后端服务
// Node.js + Express + SSE 实时推送
//
// 数据持久化策略（Storage 抽象）：
//  1. 若配置了 JSONBIN_API_KEY → 使用云 JSON 存储（免费，重启不丢，适合托管平台）
//  2. 否则 → 回退到本地文件 data/store.json（本地开发测试用）
//
// 使用：
//  node server.js
//  环境变量：PORT（默认 8080）、JSONBIN_API_KEY、JSONBIN_BIN_ID、JSONBIN_PRIVATE
// ============================================================

const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");

const { initialData } = require("./data/schema");

const app = express();
app.use(express.json({ limit: "2mb" }));
const server = http.createServer(app);

const PORT = process.env.PORT || 8080;

// ============================================================
// 内存状态
// ============================================================
let store = JSON.parse(JSON.stringify(initialData)); // 当前数据（深拷贝）
let writeQueue = Promise.resolve();                    // 串行化写操作，避免并发覆盖
let sseClients = new Set();                            // SSE 连接集合

// 状态枚举（前端可选项）
const STATUS_OPTIONS = ["已订", "待定", "已取消"];

// ============================================================
// Storage 抽象：云 JSON 存储 / 本地文件回退
// ============================================================
const LOCAL_FILE = path.join(__dirname, "data", "store.json");

const storage = {
  isCloud() {
    return !!process.env.JSONBIN_API_KEY;
  },

  // 读取
  async load() {
    if (this.isCloud()) {
      return this._cloudLoad();
    }
    // 本地回退
    try {
      if (fs.existsSync(LOCAL_FILE)) {
        const raw = fs.readFileSync(LOCAL_FILE, "utf-8");
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error("本地读取失败，使用初始数据：", e.message);
    }
    return JSON.parse(JSON.stringify(initialData));
  },

  // 写入
  async save(data) {
    if (this.isCloud()) {
      return this._cloudSave(data);
    }
    try {
      fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
      fs.writeFileSync(LOCAL_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.error("本地写入失败：", e.message);
    }
  },

  // ---- 云 JSONBin.io ----
  async _cloudLoad() {
    const binId = process.env.JSONBIN_BIN_ID;
    if (binId) {
      const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
        headers: { "X-Master-Key": process.env.JSONBIN_API_KEY }
      });
      if (res.ok) {
        const json = await res.json();
        return json.record;
      }
      console.error("JSONBin 读取失败，状态码：", res.status);
    }
    // 没有 bin 或读取失败，返回初始数据（后续 save 时会创建 bin）
    return JSON.parse(JSON.stringify(initialData));
  },

  async _cloudSave(data) {
    let binId = process.env.JSONBIN_BIN_ID;
    if (!binId) {
      // 创建新 bin
      const res = await fetch("https://api.jsonbin.io/v3/b", {
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
        binId = json.metadata.id;
        // 把新 bin id 记录下来（写入一个本地文件提示用户更新环境变量）
        fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
        fs.writeFileSync(
          path.join(__dirname, "data", "BIN_ID.txt"),
          `JSONBIN_BIN_ID=${binId}\n请将以上值加入你的托管平台环境变量，避免重复创建 bin。`,
          "utf-8"
        );
        console.log("已在 JSONBin 创建新 bin：", binId);
      } else {
        console.error("JSONBin 创建失败：", res.status, await res.text());
      }
      return;
    }
    // 更新已有 bin
    const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Master-Key": process.env.JSONBIN_API_KEY
      },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      console.error("JSONBin 更新失败：", res.status);
    }
  }
};

// ============================================================
// 工具函数
// ============================================================
// 广播数据变更给所有 SSE 客户端
function broadcast() {
  const payload = `data: ${JSON.stringify({ type: "update", data: store })}\n\n`;
  sseClients.forEach((res) => {
    try {
      res.write(payload);
    } catch (e) {
      sseClients.delete(res);
    }
  });
}

// 串行写：保证并发请求不互相覆盖
function commit(nextStore) {
  store = nextStore;
  store.lastUpdated = new Date().toISOString();
  writeQueue = writeQueue.then(() => storage.save(store)).catch((e) => console.error("持久化失败：", e.message));
  broadcast();
}

// ============================================================
// REST API
// ============================================================

// 获取全量数据
app.get("/api/data", (req, res) => {
  res.json(store);
});

// 覆盖式更新（前端做增量合并后整包提交）
app.put("/api/data", (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== "object") {
    return res.status(400).json({ error: "无效的数据格式" });
  }
  commit(incoming);
  res.json({ ok: true, lastUpdated: store.lastUpdated });
});

// 更新单个航班
app.post("/api/flights/:id", (req, res) => {
  const id = req.params.id;
  const patch = req.body;
  const idx = store.flights.findIndex((f) => f.id === id);
  if (idx === -1) return res.status(404).json({ error: "航班不存在" });
  const next = JSON.parse(JSON.stringify(store));
  next.flights[idx] = { ...next.flights[idx], ...patch };
  commit(next);
  res.json({ ok: true });
});

// 新增航班
app.post("/api/flights", (req, res) => {
  const body = req.body || {};
  const next = JSON.parse(JSON.stringify(store));
  const newFlight = {
    id: "f" + Date.now(),
    date: body.date || "",
    route: body.route || "新航线",
    dep: body.dep || "",
    arr: body.arr || "",
    flightNo: body.flightNo || "",
    bookingNo: body.bookingNo || "",
    status: STATUS_OPTIONS.includes(body.status) ? body.status : "待定",
    note: body.note || ""
  };
  next.flights.push(newFlight);
  commit(next);
  res.json({ ok: true, id: newFlight.id });
});

// 删除航班
app.delete("/api/flights/:id", (req, res) => {
  const id = req.params.id;
  const next = JSON.parse(JSON.stringify(store));
  next.flights = next.flights.filter((f) => f.id !== id);
  commit(next);
  res.json({ ok: true });
});

// 待办：切换勾选 / 更新
app.post("/api/todos/:id", (req, res) => {
  const id = req.params.id;
  const patch = req.body || {};
  const next = JSON.parse(JSON.stringify(store));
  const idx = next.todos.findIndex((t) => t.id === id);
  if (idx === -1) return res.status(404).json({ error: "待办不存在" });
  next.todos[idx] = { ...next.todos[idx], ...patch };
  commit(next);
  res.json({ ok: true });
});

// 预算：更新金额
app.post("/api/budget/:id", (req, res) => {
  const id = req.params.id;
  const patch = req.body || {};
  const next = JSON.parse(JSON.stringify(store));
  const idx = next.budget.findIndex((b) => b.id === id);
  if (idx === -1) return res.status(404).json({ error: "预算项不存在" });
  next.budget[idx] = { ...next.budget[idx], ...patch };
  commit(next);
  res.json({ ok: true });
});

// 添加待办
app.post("/api/todos", (req, res) => {
  const body = req.body || {};
  const next = JSON.parse(JSON.stringify(store));
  const newTodo = {
    id: "t" + Date.now(),
    category: body.category || "其他",
    text: body.text || "新待办",
    done: false
  };
  next.todos.push(newTodo);
  commit(next);
  res.json({ ok: true, id: newTodo.id });
});

// 删除待办
app.delete("/api/todos/:id", (req, res) => {
  const id = req.params.id;
  const next = JSON.parse(JSON.stringify(store));
  next.todos = next.todos.filter((t) => t.id !== id);
  commit(next);
  res.json({ ok: true });
});

// ============================================================
// SSE 实时推送
// ============================================================
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);
  // 连接建立后立即推一次当前数据
  res.write(`data: ${JSON.stringify({ type: "hello", data: store })}\n\n`);

  req.on("close", () => sseClients.delete(res));
});

// 状态选项
app.get("/api/status-options", (req, res) => {
  res.json(STATUS_OPTIONS);
});

// ============================================================
// 静态文件
// ============================================================
app.use(express.static(path.join(__dirname, "public")));

// 健康检查
app.get("/api/health", (req, res) => res.json({ ok: true, cloud: storage.isCloud() }));

// ============================================================
// 启动
// ============================================================
async function start() {
  try {
    store = await storage.load();
    // 兼容旧数据：确保必备字段存在
    store.flights = store.flights || [];
    store.days = store.days || [];
    store.todos = store.todos || [];
    store.budget = store.budget || [];
    store.meta = store.meta || initialData.meta;
    if (!store.alert) store.alert = initialData.alert;
    store.lastUpdated = store.lastUpdated || null;
    console.log("数据已加载。存储模式：", storage.isCloud() ? "云端 JSONBin" : "本地文件");
  } catch (e) {
    console.error("启动加载失败，使用初始数据：", e.message);
  }

  server.listen(PORT, () => {
    console.log(`✅ 泰国行程共享应用已启动：http://localhost:${PORT}`);
    console.log(`   分享给朋友时，提供完整 URL 即可共同编辑（无需登录）`);
  });
}

start();
