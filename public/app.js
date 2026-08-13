// ============================================================
// 泰国 11 日行程 · 前端逻辑
// - 组件化渲染（航班/位置/行程/待办/预算）
// - 可上下拖拽排序组件
// - 航班/待办/预算的编辑交互
// - 轮询实时同步（兼容 Vercel serverless）
// ============================================================

let data = null;               // 当前数据快照
let editingFlightId = null;    // 正在编辑的航班 id
let editingBudgetId = null;    // 正在编辑的预算 id

const $ = (id) => document.getElementById(id);

const STATUS_CLASS = { "已订": "confirmed", "待定": "pending", "已取消": "cancelled" };
const CAT_COLOR = { "机票": "#1976D2", "船票": "#00796B", "住宿": "#F57C00", "活动": "#8E24AA", "其他": "#757575" };

// ============================================================
// 组件定义（决定顺序，可拖拽调整）
// ============================================================
const COMPONENTS = [
  { id: "flights",   title: "✈️ 航班总览",   color: "flight",  hint: "（点击可编辑，实时同步）", order: 0 },
  { id: "location",  title: "📍 位置共享",    color: "location", hint: "（授权后自动展示队友位置）", order: 1 },
  { id: "days",      title: "🗓️ 每日行程",    color: "tip",     hint: "（11 天）", order: 2 },
  { id: "todos",     title: "⏳ 待办事项",    color: "alert",   hint: "（点击勾选，多人同步）", order: 3 },
  { id: "budget",    title: "💰 实际账单",    color: "budget",  hint: "（¥ / ฿ 双币统计，点击修改）", order: 4 }
];

const ORDER_KEY = "trip_comp_order"; // localStorage 存储拖拽顺序

// 读取排序（优先本地存储，否则默认）
function getOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(ORDER_KEY));
    if (Array.isArray(saved) && saved.length === COMPONENTS.length) return saved;
  } catch (e) { /* ignore */ }
  return COMPONENTS.map((c) => c.id);
}
function saveOrder(order) {
  localStorage.setItem(ORDER_KEY, JSON.stringify(order));
}

// ============================================================
// 数据加载 & 渲染
// ============================================================
async function fetchData() {
  const res = await fetch("/api/data");
  if (!res.ok) throw new Error("加载失败");
  data = await res.json();
  renderAll();
}

let componentsBuilt = false; // 组件骨架是否已构建

function renderAll() {
  if (!data) return;
  renderMeta();
  renderAlert();
  if (!componentsBuilt) {
    renderComponents(); // 首次构建骨架（含 iframe）
    componentsBuilt = true;
  }
  renderContent();
}

// 只更新组件内部内容，不重建骨架（避免 iframe 重载闪烁）
function renderContent() {
  renderFlights();
  renderDays();
  renderTodos();
  renderBudget();
}

// ============================================================
// 组件容器渲染 + 拖拽
// ============================================================
function renderComponents() {
  const order = getOrder();
  const container = $("components");

  container.innerHTML = order.map((cid) => {
    const c = COMPONENTS.find((x) => x.id === cid);
    if (!c) return "";
    const bodyId = `comp-body-${c.id}`;
    let bodyContent = "";
    switch (c.id) {
      case "flights":
        bodyContent = `
          <div class="section-body" style="overflow-x:auto">
            <table class="flight-table" id="flight-table">
              <thead><tr><th>日期</th><th>航线</th><th>出发</th><th>到达</th><th>航班号</th><th>预订号</th><th>状态</th><th>操作</th></tr></thead>
              <tbody id="flight-body"></tbody>
            </table>
            <p class="hint-note">💡 点击任意单元格即可修改，改动会实时同步给所有打开此页面的朋友。未订票航班请及时预订。</p>
          </div>`;
        break;
      case "location":
        bodyContent = `
          <div class="section-body" style="padding:0">
            <iframe src="/location.html" class="loc-iframe" id="loc-iframe"
              style="width:100%;height:520px;border:none;border-radius:0 0 14px 14px"
              title="位置共享"></iframe>
          </div>`;
        break;
      case "days":
        bodyContent = `<div class="section-body"><div id="days-container"></div></div>`;
        break;
      case "todos":
        bodyContent = `<div class="section-body"><div id="todos-container"></div></div>`;
        break;
      case "budget":
        bodyContent = `
          <div class="budget-dual">
            <div class="budget-panel cny">
              <h4 class="budget-panel-title">¥ 人民币</h4>
              <div class="budget-scroll">
                <table class="budget-table" id="budget-table-cny">
                  <thead><tr><th style="width:62%;text-align:left;padding-left:8px">事项</th><th>支出</th><th>实收</th><th style="width:9%"></th></tr></thead>
                  <tbody id="budget-body-cny"></tbody>
                </table>
              </div>
            </div>
            <div class="budget-panel thb">
              <h4 class="budget-panel-title">฿ 泰铢</h4>
              <div class="budget-scroll">
                <table class="budget-table" id="budget-table-thb">
                  <thead><tr><th style="width:62%;text-align:left;padding-left:8px">事项</th><th>支出</th><th>实收</th><th style="width:9%"></th></tr></thead>
                  <tbody id="budget-body-thb"></tbody>
                </table>
              </div>
            </div>
          </div>
          <p class="hint-note">💡 ¥ 与 ฿ 分开独立统计，互不折算。点击单元格修改金额；「实收 − 支出」为结余，负数变红表示超支。删除按钮 🗑️ 会同时删掉该事项的 ¥ 和 ฿ 记录。</p>`;
        break;
    }

    return `
      <div class="section component-card" data-comp="${c.id}">
        <div class="section-header ${c.color} comp-header">
          <span class="drag-handle" title="拖动排序" draggable="true">⋮⋮</span>
          ${c.title} <span class="section-hint">${c.hint}</span>
          <span class="comp-actions">
            <button class="sort-btn" data-sort="up" title="上移" aria-label="上移">↑</button>
            <button class="sort-btn" data-sort="down" title="下移" aria-label="下移">↓</button>
          </span>
        </div>
        <div id="${bodyId}">${bodyContent}</div>
      </div>`;
  }).join("");

  setupDragSort(container);
  setupSortButtons(container);
}

// ============================================================
// 拖拽排序（HTML5 拖拽）
// ============================================================
function setupDragSort(container) {
  const cards = container.querySelectorAll(".component-card");
  let dragSrc = null;
  let scrollRAF = null; // 自动滚动动画帧
  let autoScrollDir = 0; // -1 上 / 1 下 / 0 停

  // 自动滚动循环（拖拽到视口边缘时，页面跟随滚动）
  function scrollLoop() {
    if (autoScrollDir === 0) { scrollRAF = null; return; }
    const step = 18; // 每帧滚动像素
    window.scrollBy(0, autoScrollDir * step);
    scrollRAF = requestAnimationFrame(scrollLoop);
  }

  // 根据鼠标 Y 坐标判断是否需要自动滚动（边缘 90px 触发）
  function updateAutoScroll(clientY) {
    const edge = 90;
    let dir = 0;
    if (clientY < edge) dir = -1;
    else if (clientY > window.innerHeight - edge) dir = 1;
    if (dir !== autoScrollDir) {
      autoScrollDir = dir;
      if (dir !== 0) {
        if (!scrollRAF) scrollRAF = requestAnimationFrame(scrollLoop);
      } else if (scrollRAF) {
        cancelAnimationFrame(scrollRAF);
        scrollRAF = null;
      }
    }
  }

  // 在 document 层监听 dragover，实时计算自动滚动方向。
  // 拖到 iframe（位置组件）上时局部 dragover 会失效，document 层最稳妥。
  document.addEventListener("dragover", (e) => {
    if (dragSrc) updateAutoScroll(e.clientY);
  });
  document.addEventListener("dragend", () => {
    autoScrollDir = 0;
    if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null; }
  });

  cards.forEach((card) => {
    const handle = card.querySelector(".drag-handle");
    handle.addEventListener("dragstart", (e) => {
      dragSrc = card;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.comp);
      // 拖拽期间让 iframe 穿透鼠标事件，否则跨过位置组件时拖拽会断
      document.querySelectorAll(".loc-iframe").forEach((f) => f.classList.add("drag-passthrough"));
    });
    handle.addEventListener("dragend", () => {
      dragSrc = null;
      autoScrollDir = 0;
      if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null; }
      cards.forEach((c) => c.classList.remove("dragging"));
      document.querySelectorAll(".loc-iframe").forEach((f) => f.classList.remove("drag-passthrough"));
    });

    // 允许放置
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      const target = card;
      if (!dragSrc || dragSrc === target) return;
      // 交换顺序：将 dragSrc 移到 target 之前
      const siblings = Array.from(container.querySelectorAll(".component-card"));
      const fromIdx = siblings.indexOf(dragSrc);
      const toIdx = siblings.indexOf(target);
      if (fromIdx < toIdx) {
        container.insertBefore(dragSrc, target.nextSibling);
      } else {
        container.insertBefore(dragSrc, target);
      }
      // 保存新顺序
      const newOrder = Array.from(container.querySelectorAll(".component-card"))
        .map((c) => c.dataset.comp);
      saveOrder(newOrder);
      // 记录本次顺序变化，但不重新渲染（避免 iframe 闪烁）
      const ids = new Set(newOrder);
      // 校验顺序完整
      if (ids.size === COMPONENTS.length) saveOrder(newOrder);
    });
  });
}

// ============================================================
// 触屏排序按钮（iPhone 等不支持 HTML5 拖拽，用 ↑↓ 按钮代替）
// ============================================================
function setupSortButtons(container) {
  function refreshBtnState() {
    const cards = Array.from(container.querySelectorAll(".component-card"));
    cards.forEach((card, idx) => {
      const up = card.querySelector('[data-sort="up"]');
      const down = card.querySelector('[data-sort="down"]');
      if (up) up.disabled = idx === 0;
      if (down) down.disabled = idx === cards.length - 1;
    });
  }

  container.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".component-card");
      const cards = Array.from(container.querySelectorAll(".component-card"));
      const idx = cards.indexOf(card);
      const dir = btn.dataset.sort === "up" ? -1 : 1;
      const toIdx = idx + dir;
      if (toIdx < 0 || toIdx >= cards.length) return;
      // 交换 DOM 位置
      const target = cards[toIdx];
      if (dir < 0) container.insertBefore(card, target);
      else container.insertBefore(card, target.nextSibling);
      // 保存顺序
      const newOrder = Array.from(container.querySelectorAll(".component-card"))
        .map((c) => c.dataset.comp);
      if (new Set(newOrder).size === COMPONENTS.length) saveOrder(newOrder);
      refreshBtnState();
    });
  });

  refreshBtnState();
}

// ============================================================
// 位置组件 iframe 初始化（延迟加载，避免抢占主页面加载）
// ============================================================
function initLocationFrame() {
  const frame = document.getElementById("loc-iframe");
  if (frame && frame.getAttribute("data-loaded") !== "1") {
    // iframe 已通过 src 直接加载；这里仅做懒加载优化
  }
}

function renderMeta() {
  $("hero-title").textContent = data.meta?.title || "🇹🇭 泰国 11 日完整行程";
  $("hero-sub").textContent = data.meta?.subtitle || "";
  $("meta-date").textContent = "📅 " + (data.meta?.dateRange || "");
  $("meta-group").textContent = "👥 " + (data.meta?.group || "");
}

function renderAlert() {
  // 已移除警告/冲突提示框（不再渲染，也不读取数据）
  const box = $("alert-box");
  if (box) box.style.display = "none";
}

// ============================================================
// 航班渲染
// ============================================================
function renderFlights() {
  const tbody = $("flight-body");
  if (!tbody) return;
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
  if (!container) return;
  container.innerHTML = (data.days || []).map((d) => `
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

  document.querySelectorAll(".day-header").forEach((h) => {
    h.addEventListener("click", () => {
      const body = document.getElementById("day-body-" + h.dataset.day);
      if (body) body.classList.toggle("open");
    });
  });
}

function renderTodos() {
  const container = $("todos-container");
  if (!container) return;
  container.innerHTML = `<div class="todos-list">` + (data.todos || []).map((t) => `
    <div class="todo-item ${t.done ? "done" : ""}" data-id="${t.id}">
      <div class="checkbox">✓</div>
      <span class="cat" style="background:${CAT_COLOR[t.category] || CAT_COLOR["其他"]}">${t.category}</span>
      <span class="txt">${t.text}</span>
      <button class="btn-icon" data-act="del-todo" title="删除">🗑️</button>
    </div>`).join("") + `</div>`;

  container.querySelectorAll(".todo-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="del-todo"]')) return;
      const id = item.dataset.id;
      const todo = data.todos.find((t) => t.id === id);
      todo.done = !todo.done;
      renderTodos();
      apiPost(`/api/todos/${id}`, { done: todo.done });
    });
    const delBtn = item.querySelector('[data-act="del-todo"]');
    if (delBtn) delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm("删除这条待办？")) apiDelete(`/api/todos/${item.dataset.id}`);
    });
  });
}

function renderBudget() {
  const bodyCNY = $("budget-body-cny");
  const bodyTHB = $("budget-body-thb");
  if (!bodyCNY && !bodyTHB) return;
  const items = data.budget || [];
  const GROUP_SIZE = 8; // 8 人团

  // 单货币表格渲染器
  const renderOne = (tbody, fieldSpend, fieldPaid, sym) => {
    if (!tbody) return;
    const items_ = data.budget || [];
    const spendTotal = items_.reduce((s,b)=>s+(Number(b[fieldSpend])||0),0);
    const paidTotal  = items_.reduce((s,b)=>s+(Number(b[fieldPaid])||0),0);
    const bal = paidTotal - spendTotal;
    const cls = bal < 0 ? "is-deficit" : "is-surplus";
    tbody.innerHTML = items_.map((b) => `
      <tr data-id="${b.id}">
        <td style="text-align:left;padding-left:8px">${b.item}${b.detail ? `<span style="color:var(--text-l);font-weight:400"> · ${b.detail}</span>` : ""}</td>
        <td class="editable" data-field="${fieldSpend}" data-act="edit-budget">${fmtMoney(b[fieldSpend], sym)}</td>
        <td class="editable" data-field="${fieldPaid}"  data-act="edit-budget">${fmtMoney(b[fieldPaid], sym)}</td>
        <td style="padding:4px"><button class="btn-icon" data-act="del-bill" title="删除该账单">🗑️</button></td>
      </tr>`).join("") + `
      <tr class="budget-total"><td style="text-align:left;padding-left:8px">总计</td><td>${fmtMoney(spendTotal, sym)}</td><td>${fmtMoney(paidTotal, sym)}</td><td></td></tr>
      <tr class="budget-total" style="background:var(--blue-l)"><td style="text-align:left;padding-left:8px;font-weight:600">人均</td><td style="font-weight:600">${fmtMoney(spendTotal/GROUP_SIZE, sym)}</td><td style="font-weight:600">${fmtMoney(paidTotal/GROUP_SIZE, sym)}</td><td></td></tr>
      <tr class="budget-total budget-balance ${cls}"><td style="text-align:left;padding-left:8px;font-weight:600">结余</td><td colspan="2" style="font-weight:600">${fmtMoney(bal, sym)}</td><td></td></tr>`;
  };

  renderOne(bodyCNY, "spendCNY", "paidCNY", "¥");
  renderOne(bodyTHB, "spendTHB", "paidTHB", "฿");

  // 绑定编辑
  document.querySelectorAll("#budget-body-cny [data-act='edit-budget'], #budget-body-thb [data-act='edit-budget']").forEach((td) => {
    td.addEventListener("click", () => {
      const id = td.closest("tr").dataset.id;
      startBudgetEdit(id, td, td.dataset.field);
    });
  });
}

// 金额缩略展示：超过一位小数的值，展示时四舍五入到 1 位小数（计算仍用完整精度）
function fmtMoney(n, sym) {
  const v = Number(n || 0);
  const hasFrac = v % 1 !== 0;
  // 保留 1 位小数（缩略），整数不带小数，无千分位逗号
  const rounded = hasFrac ? Math.round(v * 10) / 10 : v;
  return sym + String(rounded);
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
  $("modal-bill-overlay").style.display = "none";
}

function startBudgetEdit(id, td, field) {
  if (editingBudgetId) return;
  editingBudgetId = id;
  const b = data.budget.find((x) => x.id === id);
  const oldVal = Number(b[field]) || 0;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.01";
  input.value = oldVal;
  input.style.width = "78px";
  input.style.padding = "4px 6px";
  input.style.border = "1.5px solid var(--primary)";
  input.style.borderRadius = "6px";
  input.style.textAlign = "center";
  input.style.fontSize = "0.95em";
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();
  const finish = () => {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val !== oldVal) apiPost(`/api/budget/${id}`, { [field]: val });
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
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { setSync("offline", "保存失败，请重试"); }
}
async function apiDelete(url) {
  try { await fetch(url, { method: "DELETE" }); } catch (e) { setSync("offline", "删除失败"); }
}

// ============================================================
// 实时同步（轮询）
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
      // 只更新内容，不重建骨架 → iframe 位置组件不闪烁、拖拽顺序不丢
      data = fresh;
      renderContent();
    }
    setSync("online", "实时同步中");
  } catch (e) {
    setSync("offline", "连接中断，重试中…");
  } finally {
    polling = false;
  }
}
function setupPolling() {
  poll();
  setInterval(poll, 4000);
}

function setSync(state, text) {
  const el = $("sync-status");
  el.className = "sync-status " + state;
  $("sync-text").textContent = text;
}

// ============================================================
// 事件绑定
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  // 航班行操作（委托）
  document.addEventListener("click", (e) => {
    const editRow = e.target.closest("#flight-body tr");
    if (editRow) {
      const id = editRow.dataset.id;
      const actBtn = e.target.closest("[data-act]");
      if (actBtn) {
        if (actBtn.dataset.act === "edit") openFlightModal(id);
        if (actBtn.dataset.act === "del" && confirm("删除这段航班？")) apiDelete(`/api/flights/${id}`);
      } else if (e.target.closest(".route")) {
        openFlightModal(id);
      }
    }
  });

  $("btn-add-flight").addEventListener("click", openNewFlightModal);
  $("btn-cancel").addEventListener("click", closeModal);
  $("btn-save-flight").addEventListener("click", () => {
    const body = {
      date: $("f-date").value, route: $("f-route").value, dep: $("f-dep").value,
      arr: $("f-arr").value, flightNo: $("f-flightNo").value,
      bookingNo: $("f-bookingNo").value, status: $("f-status").value, note: $("f-note").value
    };
    if (editingFlightId) apiPost(`/api/flights/${editingFlightId}`, body);
    else fetch("/api/flights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    closeModal();
  });
  $("btn-del-flight").addEventListener("click", () => {
    if (editingFlightId && confirm("删除这段航班？")) { apiDelete(`/api/flights/${editingFlightId}`); closeModal(); }
  });

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

  $("modal-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });
  $("modal-todo-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });
  $("modal-bill-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });

  // 新增账单按钮
  $("btn-add-bill").addEventListener("click", () => {
    $("b-item").value = "";
    $("b-detail").value = "";
    $("b-spendCNY").value = 0;
    $("b-paidCNY").value = 0;
    $("b-spendTHB").value = 0;
    $("b-paidTHB").value = 0;
    $("modal-bill-overlay").style.display = "flex";
  });
  $("btn-cancel-bill").addEventListener("click", closeModal);
  $("btn-save-bill").addEventListener("click", () => {
    const item = $("b-item").value.trim() || "新账单";
    const body = {
      item,
      detail: $("b-detail").value.trim(),
      spendCNY: Number($("b-spendCNY").value) || 0,
      paidCNY:  Number($("b-paidCNY").value)  || 0,
      spendTHB: Number($("b-spendTHB").value) || 0,
      paidTHB:  Number($("b-paidTHB").value)  || 0
    };
    fetch("/api/budget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    closeModal();
  });

  // 删除账单按钮（委托）
  document.addEventListener("click", (e) => {
    const delBtn = e.target.closest('[data-act="del-bill"]');
    if (delBtn) {
      const tr = delBtn.closest("tr");
      if (tr && confirm("删除该账单？")) apiDelete(`/api/budget/${tr.dataset.id}`);
    }
  });

  fetchData().catch((e) => setSync("offline", "加载失败，请刷新"));
  setupPolling();
});
