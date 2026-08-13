// ============================================================
// 泰国 11 日行程 · 前端逻辑
// - 加载数据并渲染
// - 航班/待办/预算的编辑交互
// - SSE 实时同步（其他朋友改动自动刷新）
// ============================================================

let data = null;               // 当前数据快照
let editingFlightId = null;    // 正在编辑的航班 id
let editingBudgetId = null;    // 正在编辑的预算 id

const $ = (id) => document.getElementById(id);

const STATUS_CLASS = { "已订": "confirmed", "待定": "pending", "已取消": "cancelled" };
const CAT_COLOR = { "机票": "#1976D2", "船票": "#00796B", "住宿": "#F57C00", "活动": "#8E24AA", "其他": "#757575" };

// ============================================================
// 数据加载 & 渲染
// ============================================================
async function fetchData() {
  const res = await fetch("/api/data");
  if (!res.ok) throw new Error("加载失败");
  data = await res.json();
  renderAll();
}

function renderAll() {
  if (!data) return;
  renderMeta();
  renderAlert();
  renderFlights();
  renderDays();
  renderTodos();
  renderBudget();
}

function renderMeta() {
  $("hero-title").textContent = data.meta?.title || "🇹🇭 泰国 11 日完整行程";
  $("hero-sub").textContent = data.meta?.subtitle || "";
  $("meta-date").textContent = "📅 " + (data.meta?.dateRange || "");
  $("meta-group").textContent = "👥 " + (data.meta?.group || "");
}

function renderAlert() {
  const box = $("alert-box");
  const a = data.alert;
  if (!a) { box.style.display = "none"; return; }
  box.style.display = "block";
  $("alert-title").textContent = a.title || "";
  $("alert-text").textContent = a.text || "";
  $("alert-options").innerHTML = (a.options || []).map((o) =>
    `<div class="option"><b>${o.name}：</b>${o.desc}</div>`
  ).join("");
}

function renderFlights() {
  const tbody = $("flight-body");
  tbody.innerHTML = (data.flights || []).map((f) => {
    const cls = STATUS_CLASS[f.status] || "pending";
    return `<tr class="${cls}" data-id="${f.id}">
      <td>${f.date}</td>
      <td class="route">${f.route}</td>
      <td>${f.dep}</td>
      <td>${f.arr}</td>
      <td>${f.flightNo}</td>
      <td>${f.bookingNo}</td>
      <td><span class="status-pill ${cls}">${f.status}</span></td>
      <td>
        <button class="btn-icon" data-act="edit" title="编辑">✏️</button>
        <button class="btn-icon" data-act="del" title="删除">🗑️</button>
      </td>
    </tr>`;
  }).join("");
}

function renderDays() {
  const container = $("days-container");
  container.innerHTML = (data.days || []).map((d, i) => `
    <div class="day-card" style="border-left-color:${d.color}">
      <div class="day-header" data-day="${d.id}">
        <div class="left">
          <div class="day-badge" style="background:${d.color}">
            <span class="d">${d.date}</span><span class="m">${d.month}</span>
          </div>
          <div>
            <div class="day-title">${d.title}</div>
            <div class="day-sub">${d.sub} · ${d.weekday}</div>
          </div>
        </div>
        <span class="day-tag" style="background:${d.color}">${d.tag}</span>
      </div>
      <div class="day-body" id="day-body-${d.id}">
        <div class="timeline">
          ${(d.items || []).map((it) => `
            <div class="tl-item">
              <div class="tl-dot" style="background:${d.color}">${it.dot}</div>
              <div class="tl-time">${it.time}</div>
              <div class="tl-title">${it.title}</div>
              <div class="tl-desc"><ul>${(it.desc || []).map((x) => `<li>${x}</li>`).join("")}</ul></div>
            </div>`).join("")}
        </div>
      </div>
    </div>`).join("");

  // 绑定折叠
  document.querySelectorAll(".day-header").forEach((h) => {
    h.addEventListener("click", () => {
      const body = document.getElementById("day-body-" + h.dataset.day);
      body.classList.toggle("open");
    });
  });
}

function renderTodos() {
  const container = $("todos-container");
  container.innerHTML = `<div class="todos-list">` + (data.todos || []).map((t) => `
    <div class="todo-item ${t.done ? "done" : ""}" data-id="${t.id}">
      <div class="checkbox">✓</div>
      <span class="cat" style="background:${CAT_COLOR[t.category] || CAT_COLOR["其他"]}">${t.category}</span>
      <span class="txt">${t.text}</span>
      <button class="btn-icon" data-act="del-todo" title="删除">🗑️</button>
    </div>`).join("") + `</div>`;

  // 绑定勾选 & 删除
  container.querySelectorAll(".todo-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="del-todo"]')) return;
      const id = item.dataset.id;
      const todo = data.todos.find((t) => t.id === id);
      // 乐观更新：立即切换本地状态并重渲染，获得即时反馈
      todo.done = !todo.done;
      renderTodos();
      // 后台同步到服务器
      apiPost(`/api/todos/${id}`, { done: todo.done });
    });
    item.querySelector('[data-act="del-todo"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm("删除这条待办？")) {
        apiDelete(`/api/todos/${item.dataset.id}`);
      }
    });
  });
}

function renderBudget() {
  const tbody = $("budget-body");
  const items = data.budget || [];
  const total = items.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  tbody.innerHTML = items.map((b) => `
    <tr data-id="${b.id}">
      <td>${b.item}</td>
      <td style="text-align:left;padding-left:14px">${b.detail}</td>
      <td class="editable" data-act="edit-budget">${fmtMoney(b.amount)}</td>
    </tr>`).join("") + `
    <tr class="total"><td colspan="2">合计（人均）</td><td>${fmtMoney(total)}</td></tr>
    <tr class="total" style="background:var(--blue-l)"><td colspan="2" style="font-weight:600">8 人总计</td><td style="font-weight:600">${fmtMoney(total * 8)}</td></tr>`;

  tbody.querySelectorAll('[data-act="edit-budget"]').forEach((td) => {
    td.addEventListener("click", () => {
      const id = td.closest("tr").dataset.id;
      startBudgetEdit(id, td);
    });
  });
}

function fmtMoney(n) {
  return "¥" + Number(n).toLocaleString();
}

// ============================================================
// 航班编辑（弹窗）
// ============================================================
function openFlightModal(id) {
  const f = data.flights.find((x) => x.id === id);
  if (!f) return;
  editingFlightId = id;
  $("f-date").value = f.date;
  $("f-route").value = f.route;
  $("f-dep").value = f.dep;
  $("f-arr").value = f.arr;
  $("f-flightNo").value = f.flightNo;
  $("f-bookingNo").value = f.bookingNo;
  $("f-status").value = f.status;
  $("f-note").value = f.note || "";
  $("btn-del-flight").style.display = "inline-block";
  $("modal-overlay").style.display = "flex";
}

function openNewFlightModal() {
  editingFlightId = null;
  $("f-date").value = ""; $("f-route").value = ""; $("f-dep").value = ""; $("f-arr").value = "";
  $("f-flightNo").value = ""; $("f-bookingNo").value = ""; $("f-status").value = "待定"; $("f-note").value = "";
  $("btn-del-flight").style.display = "none";
  $("modal-overlay").style.display = "flex";
}

function closeModal() {
  $("modal-overlay").style.display = "none";
  $("modal-todo-overlay").style.display = "none";
}

// 预算单元格内联编辑
function startBudgetEdit(id, td) {
  if (editingBudgetId) return;
  editingBudgetId = id;
  const b = data.budget.find((x) => x.id === id);
  const oldVal = b.amount;
  const input = document.createElement("input");
  input.type = "number";
  input.value = oldVal;
  input.style.width = "80px";
  input.style.padding = "4px 6px";
  input.style.border = "1.5px solid var(--primary)";
  input.style.borderRadius = "6px";
  input.style.textAlign = "center";
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();

  const finish = () => {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val !== oldVal) {
      apiPost(`/api/budget/${id}`, { amount: val });
    }
    editingBudgetId = null;
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { editingBudgetId = null; renderBudget(); }
  });
}

// ============================================================
// API 辅助
// ============================================================
async function apiPost(url, body) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    setSync("offline", "保存失败，请重试");
  }
}

async function apiDelete(url) {
  try {
    await fetch(url, { method: "DELETE" });
  } catch (e) {
    setSync("offline", "删除失败");
  }
}

// ============================================================
// 实时同步（轮询方式，兼容 Vercel serverless）
// 每 4 秒拉取一次最新数据，实现多端共同编辑
// ============================================================
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch("/api/data", { cache: "no-store" });
    if (!res.ok) throw new Error("加载失败");
    const fresh = await res.json();
    const freshKey = JSON.stringify(fresh.lastUpdated) + fresh.flights?.length;
    const curKey = JSON.stringify(data?.lastUpdated) + data?.flights?.length;
    if (!data || freshKey !== curKey) {
      data = fresh;
      renderAll();
    }
    setSync("online", "实时同步中");
  } catch (e) {
    setSync("offline", "连接中断，重试中…");
  } finally {
    polling = false;
  }
}
function setupSSE() {
  // 立即轮询一次，然后定时轮询
  poll();
  setInterval(poll, 4000);
}

function setSync(state, text) {
  const el = $("sync-status");
  el.className = "sync-status " + state;
  $("sync-text").textContent = text;
}

function fmtTime(iso) {
  if (!iso) return "刚刚";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

// ============================================================
// 事件绑定
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  // 航班行操作
  $("flight-body").addEventListener("click", (e) => {
    const row = e.target.closest("tr");
    if (!row) return;
    const id = row.dataset.id;
    const actBtn = e.target.closest("[data-act]");
    if (actBtn) {
      if (actBtn.dataset.act === "edit") openFlightModal(id);
      if (actBtn.dataset.act === "del" && confirm("删除这段航班？")) apiDelete(`/api/flights/${id}`);
    } else if (e.target.closest(".route")) {
      openFlightModal(id);
    }
  });

  // 新增航班
  $("btn-add-flight").addEventListener("click", openNewFlightModal);
  $("btn-cancel").addEventListener("click", closeModal);
  $("btn-save-flight").addEventListener("click", () => {
    const body = {
      date: $("f-date").value, route: $("f-route").value, dep: $("f-dep").value,
      arr: $("f-arr").value, flightNo: $("f-flightNo").value,
      bookingNo: $("f-bookingNo").value, status: $("f-status").value, note: $("f-note").value
    };
    if (editingFlightId) {
      apiPost(`/api/flights/${editingFlightId}`, body);
    } else {
      fetch("/api/flights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    closeModal();
  });
  $("btn-del-flight").addEventListener("click", () => {
    if (editingFlightId && confirm("删除这段航班？")) {
      apiDelete(`/api/flights/${editingFlightId}`);
      closeModal();
    }
  });

  // 新增待办
  $("btn-add-todo").addEventListener("click", () => {
    $("t-text").value = "";
    $("modal-todo-overlay").style.display = "flex";
  });
  $("btn-cancel-todo").addEventListener("click", closeModal);
  $("btn-save-todo").addEventListener("click", () => {
    const text = $("t-text").value.trim();
    const category = $("t-category").value;
    if (!text) return;
    fetch("/api/todos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, category }) });
    closeModal();
  });

  // 点击遮罩关闭
  $("modal-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });
  $("modal-todo-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });

  // 初始化
  fetchData().catch((e) => setSync("offline", "加载失败，请刷新"));
  setupSSE();
});
