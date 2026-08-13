// ============================================================
// API 集成测试（node:test + 本地文件存储，不依赖外部网络）
// 运行：npm test
// ============================================================
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 使用独立的临时存储文件，避免污染真实 data/store.json
const STORE = path.join(os.tmpdir(), `thailand-trip-test-${process.pid}-${Date.now()}.json`);
process.env.LOCAL_STORE_FILE = STORE;
delete process.env.JSONBIN_API_KEY;
delete process.env.JSONBIN_BIN_ID;

const app = require("../server.js");

let server;
let base;

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("泰国行程 API", () => {
  before(async () => {
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    try { fs.unlinkSync(STORE); } catch (e) { /* ignore */ }
  });

  it("健康检查：本地存储模式", async () => {
    const { status, json } = await api("GET", "/api/health");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.storage, "local");
  });

  it("初始数据：8 段航班", async () => {
    const { json } = await api("GET", "/api/data");
    assert.equal(json.flights.length, 8);
    assert.ok(json.version >= 0);
  });

  it("空 budgetCNY 保持为空（不再复活初始账单）", async () => {
    const before = await api("GET", "/api/data");
    const payload = {
      version: before.json.version,
      flights: before.json.flights,
      todos: before.json.todos,
      days: before.json.days,
      locations: [],
      budgetCNY: [],
      budgetTHB: []
    };
    const put = await api("PUT", "/api/data", payload);
    assert.equal(put.status, 200);
    assert.equal(put.json.ok, true);
    const after = await api("GET", "/api/data");
    assert.equal(after.json.budgetCNY.length, 0);
    assert.equal(after.json.version, before.json.version + 1);
  });

  it("新增待办并持久化到本地文件", async () => {
    const before = await api("GET", "/api/data");
    const post = await api("POST", "/api/todos", { text: "测试待办", category: "其他", version: before.json.version });
    assert.equal(post.status, 200);
    assert.ok(post.json.id);
    // 落盘验证：数据已写入本地文件
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8"));
    assert.ok(raw.todos.some((t) => t.id === post.json.id && t.text === "测试待办"));
    // 重新读取（等价于重启后的恢复）
    const after = await api("GET", "/api/data");
    assert.ok(after.json.todos.some((t) => t.id === post.json.id));
  });

  it("版本冲突返回 409，不静默覆盖", async () => {
    const before = await api("GET", "/api/data");
    const staleVersion = before.json.version;
    // 另一个人先改（version +1）
    await api("POST", "/api/todos", { text: "别人改的", category: "其他", version: before.json.version });
    // 用旧 version 再改 → 409
    const conflict = await api("POST", "/api/todos", { text: "我的改", category: "其他", version: staleVersion });
    assert.equal(conflict.status, 409);
  });

  it("不带 version 也可以写（兼容旧客户端）", async () => {
    const post = await api("POST", "/api/flights", { route: "无版本新增" });
    assert.equal(post.status, 200);
    assert.equal(post.json.ok, true);
  });

  it("航班更新：非法字段被过滤、长度被限制、非法状态被忽略", async () => {
    const before = await api("GET", "/api/data");
    const f = before.json.flights[0];
    const post = await api("POST", `/api/flights/${f.id}`, {
      version: before.json.version,
      route: "A".repeat(1000),
      status: "乱写的状态",
      hacked: "x"
    });
    assert.equal(post.status, 200);
    const after = await api("GET", "/api/data");
    const updated = after.json.flights.find((x) => x.id === f.id);
    assert.equal(updated.route.length, 200);      // 被截断
    assert.equal(updated.hacked, undefined);      // 非法字段被过滤
    assert.equal(updated.status, "已订");          // 非法状态被忽略，保留原值
  });

  it("位置 upsert + 过期自动清理", async () => {
    const post = await api("POST", "/api/locations", { id: "user_测试", name: "测试", lat: 13.7, lng: 100.5, accuracy: 10, color: "#0D7D6B" });
    assert.equal(post.status, 200);
    let list = await api("GET", "/api/locations");
    assert.equal(list.json.length, 1);

    // 把 updatedAt 改成 11 分钟前 → GET 应过滤掉
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8"));
    raw.locations[0].updatedAt = Date.now() - 11 * 60 * 1000;
    fs.writeFileSync(STORE, JSON.stringify(raw));
    list = await api("GET", "/api/locations");
    assert.equal(list.json.length, 0);
  });

  it("预算新增/删除只影响当前币种", async () => {
    const before = await api("GET", "/api/data");
    const add = await api("POST", "/api/budget/thb", { item: "测试泰铢", spend: 100, paid: 50, version: before.json.version });
    assert.equal(add.status, 200);
    const thb = await api("GET", "/api/budget/thb");
    assert.ok(thb.json.some((b) => b.id === add.json.id));
    const cny = await api("GET", "/api/budget/cny");
    assert.ok(!cny.json.some((b) => b.id === add.json.id)); // 不影响 ¥ 表
    const del = await api("DELETE", `/api/budget/thb/${add.json.id}?version=${add.json.version}`);
    assert.equal(del.status, 200);
    const after = await api("GET", "/api/budget/thb");
    assert.ok(!after.json.some((b) => b.id === add.json.id));
  });
});
