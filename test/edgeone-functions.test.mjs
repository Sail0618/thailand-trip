// ============================================================
// EdgeOne Pages Functions 逻辑测试（node:test，不依赖外部网络）
// 运行：npm test
// ============================================================
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/core.mjs";

// 内存 KV 模拟器（模拟 EdgeOne KV 的 get/put）
class MockKV {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed));
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
}

const originalFetch = globalThis.fetch;
let kv;

async function api(method, path, body, env) {
  const req = new Request("http://localhost" + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const res = await onRequest({ request: req, env: { THAILAND_KV: kv, ...(env || {}) } });
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, json };
}

describe("EdgeOne Pages Functions", () => {
  let jsonbinRecord = null;

  before(() => {
    // mock 汇率接口：1 CNY = 5 THB；mock JSONBin 读写
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("open.er-api.com")) {
        return new Response(JSON.stringify({
          provider: "mock", rates: { THB: 5 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("bigdatacloud.net")) {
        return new Response(JSON.stringify({
          countryName: "泰国", principalSubdivision: "曼谷", city: "曼谷", locality: "哒叻裕区"
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("api.jsonbin.io")) {
        if (opts && opts.method === "PUT") {
          jsonbinRecord = JSON.parse(String(opts.body));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (jsonbinRecord) {
          return new Response(JSON.stringify({ record: jsonbinRecord }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return new Response(JSON.stringify({ error: "mock 404" }), { status: 404 });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("KV 为空时返回初始数据（8 段航班 + 默认汇率）", async () => {
    kv = new MockKV();
    const { status, json } = await api("GET", "/api/data");
    assert.equal(status, 200);
    assert.equal(json.flights.length, 8);
    assert.ok(json.version >= 0);
    assert.ok(json.fxRate > 0);
  });

  it("写入后 version +1，乐观锁校验（版本不匹配返回 409）", async () => {
    kv = new MockKV();
    const first = await api("GET", "/api/data");
    const v0 = first.json.version;

    const put = await api("PUT", "/api/data", { version: v0, ...first.json });
    assert.equal(put.status, 200);
    assert.equal(put.json.version, v0 + 1);

    const conflict = await api("PUT", "/api/data", { version: v0, ...first.json });
    assert.equal(conflict.status, 409);
  });

  it("新增/更新/删除待办", async () => {
    kv = new MockKV();
    const created = await api("POST", "/api/todos", { text: "测试待办", category: "活动", date: "10/1" });
    assert.equal(created.status, 200);
    assert.ok(created.json.id);

    const id = created.json.id;
    const { json: list } = await api("GET", "/api/todos");
    assert.equal(list.length, 15); // 初始 14 条 + 新增 1 条
    assert.ok(list.some((t) => t.text === "测试待办"));

    const updated = await api("POST", `/api/todos/${id}`, { done: true, version: created.json.version });
    assert.equal(updated.status, 200);
    const { json: list2 } = await api("GET", "/api/todos");
    assert.equal(list2.find((t) => t.id === id).done, true);

    const del = await api("DELETE", `/api/todos/${id}`, undefined, undefined);
    assert.equal(del.status, 200);
    const { json: list3 } = await api("GET", "/api/todos");
    assert.equal(list3.length, 14); // 回到初始 14 条
  });

  it("预算：新增 ¥ 项并查询，删除 ฿ 项", async () => {
    kv = new MockKV();
    const add = await api("POST", "/api/budget/cny", { item: "🍜 吃饭", spend: 100, paid: 100 });
    assert.equal(add.status, 200);
    const { json: cny } = await api("GET", "/api/budget/cny");
    assert.equal(cny.length, 4); // 初始 3 条 + 新增 1 条
    assert.ok(cny.some((b) => b.item === "🍜 吃饭"));

    const del = await api("DELETE", `/api/budget/thb/${add.json.id}`);
    assert.equal(del.status, 200); // thb 表没有该项也能删
  });

  it("航班：更新 flightNo / 状态", async () => {
    kv = new MockKV();
    const data = await api("GET", "/api/data");
    const f1 = data.json.flights.find((f) => f.id === "f1");
    const upd = await api("POST", "/api/flights/f1", {
      version: data.json.version,
      flightNo: "CX963",
      status: "已订",
      date: f1.date,
      route: f1.route,
      dep: f1.dep,
      arr: f1.arr,
      bookingNo: f1.bookingNo,
      note: f1.note
    });
    assert.equal(upd.status, 200);
    const { json: flights } = await api("GET", "/api/flights");
    assert.equal(flights.find((f) => f.id === "f1").flightNo, "CX963");
  });

  it("汇率：手动设置 + 实时抓取（mock）", async () => {
    kv = new MockKV();
    const data = await api("GET", "/api/data");
    const set = await api("POST", "/api/fx", { version: data.json.version, rate: 4.8 });
    assert.equal(set.status, 200);

    const live = await api("GET", "/api/fx/live");
    assert.equal(live.status, 200);
    assert.equal(live.json.rate, 5);

    const refresh = await api("POST", "/api/fx/refresh", { version: set.json.version });
    assert.equal(refresh.status, 200);
    assert.equal(refresh.json.rate, 5);
  });

  it("位置共享：上报 → 查询 → 删除", async () => {
    kv = new MockKV();
    const post = await api("POST", "/api/locations", { name: "小明", lat: 13.7, lng: 100.5 });
    assert.equal(post.status, 200);
    const { json: list } = await api("GET", "/api/locations");
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "小明");
    assert.equal(list[0].address, "泰国 曼谷 哒叻裕区");
    const del = await api("DELETE", `/api/locations/${post.json.id}`);
    assert.equal(del.status, 200);
    const { json: list2 } = await api("GET", "/api/locations");
    assert.equal(list2.length, 0);
  });

  it("无 KV 时回退 JSONBin 存储（读写）", async () => {
    kv = null;
    jsonbinRecord = { flights: [{ id: "x1", route: "测试航线" }], version: 3 };
    const env = { JSONBIN_BIN_ID: "bin123", JSONBIN_API_KEY: "key123" };

    const got = await api("GET", "/api/data", undefined, env);
    assert.equal(got.status, 200);
    assert.equal(got.json.flights.length, 1);
    assert.equal(got.json.flights[0].route, "测试航线");

    const put = await api("PUT", "/api/data", { version: 3, ...got.json }, env);
    assert.equal(put.status, 200);
    assert.equal(put.json.version, 4);
    assert.equal(jsonbinRecord.version, 4);
  });

  it("KV 里是初始模板时，绝不被 JSONBin 自动覆盖（修复覆盖丢失）", async () => {
    // 模拟 KV 被重置为初始模板（fxRate=5, version=0）
    kv = new MockKV({ data: JSON.stringify({ flights: [], fxRate: 5, version: 0, lastUpdated: null }) });
    // JSONBin 里存的是旧快照
    jsonbinRecord = { flights: [{ id: "x1", route: "旧快照航线" }], fxRate: 4.897237, version: 22, lastUpdated: "2026-08-13T08:41:33Z" };
    const env = { JSONBIN_BIN_ID: "bin123", JSONBIN_API_KEY: "key123" };

    const got = await api("GET", "/api/data", undefined, env);
    assert.equal(got.status, 200);
    // 保持 KV 现有数据，不被 JSONBin 旧快照覆盖
    assert.equal(got.json.fxRate, 5);
    assert.equal(got.json.version, 0);
    assert.equal(got.json.flights.length, 0);

    // KV 未被覆盖
    const stored = JSON.parse(kv.map.get("data"));
    assert.equal(stored.fxRate, 5);
    assert.equal(stored.version, 0);
  });

  it("每次写入自动保留历史备份，可查询 /api/data/history", async () => {
    kv = new MockKV();
    const first = await api("GET", "/api/data");
    const v0 = first.json.version;
    const put = await api("PUT", "/api/data", { version: v0, ...first.json });
    assert.equal(put.status, 200);

    const hist = await api("GET", "/api/data/history");
    assert.equal(hist.status, 200);
    assert.ok(Array.isArray(hist.json));
    assert.ok(hist.json.length >= 1);
    assert.equal(hist.json[hist.json.length - 1].version, v0);
    assert.ok(hist.json[hist.json.length - 1].data);
    assert.ok(hist.json[hist.json.length - 1].savedAt);
  });

  it("手动迁移：需显式确认，覆盖前保留历史", async () => {
    kv = new MockKV();
    const first = await api("GET", "/api/data");
    await api("PUT", "/api/data", { version: first.json.version, ...first.json });

    jsonbinRecord = { flights: [{ id: "x1", route: "手动迁移航线" }], fxRate: 4.8, version: 100, lastUpdated: "2026-08-14T00:00:00Z" };
    const env = { JSONBIN_BIN_ID: "bin123", JSONBIN_API_KEY: "key123" };

    // 未显式确认 → 拒绝
    const bad = await api("POST", "/api/migrate", { source: "jsonbin" }, env);
    assert.equal(bad.status, 400);

    // 显式确认 → 迁移成功
    const ok = await api("POST", "/api/migrate", { source: "jsonbin", confirm: true }, env);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.version, 100);

    const got = await api("GET", "/api/data", undefined, env);
    assert.equal(got.json.flights[0].route, "手动迁移航线");

    // 覆盖前已有历史备份（含原始航班数据）
    const hist = await api("GET", "/api/data/history", undefined, env);
    assert.ok(hist.json.some((h) => h.data && h.data.flights && h.data.flights.length > 0));
  });

  it("健康检查与未知接口", async () => {
    kv = new MockKV();
    const health = await api("GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.storage, "edgeone-kv");

    const nf = await api("GET", "/api/nope");
    assert.equal(nf.status, 404);
  });
});
