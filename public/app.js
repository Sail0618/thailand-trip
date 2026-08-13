// ============================================================
// 泰国行程 · 前端逻辑
// - 组件化渲染（航班/位置/行程/待办/预算）
// - 可上下拖拽排序组件
// - 航班/待办/预算的编辑交互
// - 轮询实时同步（兼容 Vercel serverless）
// - 所有用户可写字段渲染前统一 HTML 转义（防 XSS）
// - 写操作携带 version 乐观锁，冲突(409)时自动刷新
// ============================================================

let data = null;               // 当前数据快照
let editingFlightId = null;    // 正在编辑的航班 id
let editingBudgetId = null;    // 正在编辑的预算 id

const $ = (id) => document.getElementById(id);

// HTML 转义：所有用户可写字段插入 innerHTML 前必须经过此函数
function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

const STATUS_CLASS = { "已订": "confirmed", "待定": "pending", "已取消": "cancelled" };
const CAT_COLOR = { "机票": "#1976D2", "船票": "#00796B", "住宿": "#F57C00", "活动": "#8E24AA", "其他": "#757575" };

// ============================================================
// 组件定义（决定顺序，可拖拽调整）
// ============================================================
const COMPONENTS = [
  { id: "flights",   title: "航班总览",   color: "flight",  hint: "点击卡片可编辑 · 实时同步", order: 0, addBtn: "btn-add-flight" },
  { id: "location",  title: "位置共享",    color: "location", hint: "授权后自动展示队友位置", order: 1 },
  { id: "days",      title: "每日行程",    color: "tip",     hint: "共 11 天 · 点击展开", order: 2 },
  { id: "todos",     title: "待办事项",    color: "alert",   hint: "点击勾选 · 多人同步", order: 3, addBtn: "btn-add-todo" },
  { id: "budget",    title: "实际账单",    color: "budget",  hint: "¥ / ฿ 双币统计 · 点击修改", order: 4, addBtn: "btn-add-bill" }
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
  // 各编辑中的控件不重渲染，避免轮询打断输入
  if (!editingTodoDateId) renderTodos();
  if (!editingBudgetId) renderBudget();
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
          <div class="section-body">
            <div id="flight-list" class="flight-list"></div>
            <p class="hint-note">💡 点击航班卡片即可修改，改动会实时同步给所有打开此页面的朋友。未订票航班请及时预订。</p>
          </div>`;
        break;
      case "location":
        bodyContent = `
          <div class="section-body" style="padding:0">
            <iframe src="/location.html" class="loc-iframe" id="loc-iframe"
              style="width:100%;border:none;border-radius:0 0 14px 14px"
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
              <div class="budget-panel-title">¥ 人民币</div>
              <div class="bill-list" id="budget-list-cny"></div>
              <div class="bill-totals" id="budget-totals-cny"></div>
            </div>
            <div class="budget-panel thb">
              <div class="budget-panel-title">฿ 泰铢</div>
              <div class="bill-list" id="budget-list-thb"></div>
              <div class="bill-totals" id="budget-totals-thb"></div>
            </div>
          </div>
          <p class="hint-note">💡 ¥ 与 ฿ 分开独立统计，互不折算。点击金额即可修改；「实收 − 支出」为结余。删除按钮 🗑️ 只删除当前币种下的该条记录。</p>`;
        break;
    }

    return `
      <div class="section component-card" data-comp="${escapeHtml(c.id)}">
        <div class="section-header ${c.color} comp-header">
          <span class="drag-handle" title="拖动排序" draggable="true">⋮⋮</span>
          ${escapeHtml(c.title)} <span class="section-hint">${escapeHtml(c.hint)}</span>
          <span class="comp-actions">
            ${c.addBtn ? `<button class="add-btn" id="${c.addBtn}" title="新增" aria-label="新增">＋ 新增</button>` : ""}
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
// 顶部信息渲染
// ============================================================
function renderMeta() {
  $("hero-title").textContent = data.meta?.title || "🇹🇭 泰国完整行程";
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
  const list = $("flight-list");
  if (!list) return;
  const flights = data.flights || [];
  const dash = (v) => escapeHtml(v || "—");
  const cards = flights.map((f) => {
    const cls = STATUS_CLASS[f.status] || "pending";
    const hasNo = f.flightNo && f.flightNo !== "—";
    const dur = flightDuration(f.dep, f.arr);
    const depTxt = f.dep && f.dep !== "待定" ? escapeHtml(f.dep) : null;
    const arrTxt = f.arr && f.arr !== "待定" ? escapeHtml(f.arr) : null;
    return `
      <div class="flight-card ${cls}" data-id="${escapeHtml(f.id)}">
        <div class="fc-top">
          <span class="fc-no ${hasNo ? "" : "empty"}">✈ ${hasNo ? escapeHtml(f.flightNo) : "—"}</span>
          <span class="fc-right">
            <span class="status-pill ${cls}">${escapeHtml(f.status || "待定")}</span>
            <span class="fc-actions">
              <button class="btn-icon" data-act="edit" title="编辑">✏️</button>
              <button class="btn-icon" data-act="del" title="删除">🗑️</button>
            </span>
          </span>
        </div>
        <div class="fc-times">
          <span class="fc-time ${depTxt ? "" : "pending"}">${depTxt || "待定"}</span>
          <span class="fc-track">
            <span class="fc-dur">${dur ? escapeHtml(dur) : "—"}</span>
            <span class="fc-line"></span>
          </span>
          <span class="fc-time ${arrTxt ? "" : "pending"}">${arrTxt || "待定"}</span>
        </div>
        <div class="fc-route">${dash(f.route)}</div>
        <div class="fc-meta">
          <span>📅 ${dash(f.date)}</span>
          ${f.note ? `<span class="fc-note">${escapeHtml(f.note)}</span>` : ""}
        </div>
      </div>`;
  }).join("");

  if (!cards) {
    list.innerHTML = `<div class="fc-empty">暂无航班，点上方 ＋ 新增</div>`;
  } else {
    list.innerHTML = cards + `
      <div class="fc-add-row" id="fc-add-row">＋ 新增航班</div>`;
    const addRow = $("fc-add-row");
    if (addRow) addRow.addEventListener("click", openNewFlightModal);
  }
}

// ============================================================
// 每日行程渲染
// ============================================================
function renderDays() {
  const container = $("days-container");
  if (!container) return;
  container.innerHTML = (data.days || []).map((d) => `
    <div class="day-card" style="--dayc:${escapeHtml(d.color)};--dayl:${escapeHtml(d.color)}1A">
      <div class="day-header" data-day="${escapeHtml(d.id)}" role="button" tabindex="0" aria-expanded="false">
        <div class="left">
          <div class="day-badge" title="${escapeHtml(d.date)} ${escapeHtml(d.month)}">${escapeHtml(d.date)}</div>
          <div>
            <div class="day-title">${escapeHtml(d.title)}</div>
            <div class="day-sub">${escapeHtml(d.sub)} · ${escapeHtml(d.weekday)}</div>
          </div>
        </div>
        <span class="day-tag">${escapeHtml(d.tag)}</span>
        <span class="day-chevron" aria-hidden="true">▾</span>
      </div>
      <div class="day-body" id="day-body-${escapeHtml(d.id)}">
        <div class="timeline">
          ${(d.items || []).map((it) => `
            <div class="tl-item">
              <div class="tl-dot">${escapeHtml(it.dot)}</div>
              <div class="tl-time">${escapeHtml(it.time)}</div>
              <div class="tl-title">${escapeHtml(it.title)}</div>
              <div class="tl-desc"><ul>${(it.desc || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>
            </div>`).join("")}
        </div>
      </div>
    </div>`).join("");

  document.querySelectorAll(".day-header").forEach((h) => {
    const toggle = () => {
      const body = document.getElementById("day-body-" + h.dataset.day);
      if (!body) return;
      const open = body.classList.toggle("open");
      h.setAttribute("aria-expanded", open ? "true" : "false");
    };
    h.addEventListener("click", toggle);
    h.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });
}

// ============================================================
// 待办渲染
// ============================================================
function renderTodos() {
  const container = $("todos-container");
  if (!container) return;
  container.innerHTML = `<div class="todos-list">` + (data.todos || []).map((t) => `
    <div class="todo-item ${t.done ? "done" : ""}" data-id="${escapeHtml(t.id)}">
      <div class="checkbox">✓</div>
      <div class="todo-main">
        <div class="txt">${escapeHtml(t.text)}</div>
        <div class="todo-meta">
          <span class="cat" style="background:${CAT_COLOR[t.category] || CAT_COLOR["其他"]}">${escapeHtml(t.category)}</span>
          <span class="todo-date" data-edit-date title="点击设置日期">${t.date ? escapeHtml(fmtDate(t.date)) : "＋日期"}</span>
        </div>
      </div>
      <button class="btn-icon" data-act="del-todo" title="删除">🗑️</button>
    </div>`).join("") + `</div>`;

  container.querySelectorAll(".todo-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="del-todo"]')) return;
      if (e.target.closest('[data-edit-date]')) return; // 日期点击单独处理
      const id = item.dataset.id;
      const todo = data.todos.find((t) => t.id === id);
      if (!todo) return;
      todo.done = !todo.done;
      renderTodos();
      apiPost(`/api/todos/${id}`, { done: todo.done, version: data.version });
    });
    const delBtn = item.querySelector('[data-act="del-todo"]');
    if (delBtn) delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm("删除这条待办？")) {
        data.todos = data.todos.filter((t) => t.id !== item.dataset.id);
        renderTodos();
        apiDelete(`/api/todos/${item.dataset.id}`);
      }
    });
    const dateEl = item.querySelector('[data-edit-date]');
    if (dateEl) dateEl.addEventListener("click", (e) => {
      e.stopPropagation();
      startTodoDateEdit(item.dataset.id, dateEl);
    });
  });
}

// 独立编辑待办日期（原生日期选择器）
function startTodoDateEdit(id, el) {
  if (editingTodoDateId) return;
  const todo = data.todos.find((t) => t.id === id);
  if (!todo) return;
  editingTodoDateId = id;
  const input = document.createElement("input");
  input.type = "date";
  input.className = "todo-date-input";
  if (todo.date && /^\d{4}-\d{2}-\d{2}$/.test(todo.date)) input.value = todo.date;
  el.textContent = "";
  el.appendChild(input);
  el.classList.add("editing");
  input.focus();

  const done = (val) => {
    if (editingTodoDateId !== id) return;
    editingTodoDateId = null;
    if (val !== (todo.date || "")) {
      todo.date = val;
      renderTodos();
      apiPost(`/api/todos/${id}`, { date: val, version: data.version });
    } else {
      renderTodos();
    }
  };
  input.addEventListener("change", () => done(input.value));
  input.addEventListener("blur", () => {
    if (editingTodoDateId === id) { editingTodoDateId = null; renderTodos(); }
  });
}

// ============================================================
// 预算渲染
// ============================================================
function renderBudget() {
  const listCNY = $("budget-list-cny");
  const listTHB = $("budget-list-thb");
  const totalCNY = $("budget-totals-cny");
  const totalTHB = $("budget-totals-thb");
  if (!listCNY && !listTHB) return;
  const GROUP_SIZE = 8; // 8 人团

  // 单货币渲染器（¥ / ฿ 各自独立，行布局不横向滚动）
  const renderOne = (listEl, totalEl, list, sym) => {
    if (!listEl) return;
    const items_ = list || [];
    const spendTotal = items_.reduce((s,b)=>s+(Number(b.spend)||0),0);
    const paidTotal  = items_.reduce((s,b)=>s+(Number(b.paid)||0),0);
    const bal = paidTotal - spendTotal;
    const cls = bal < 0 ? "deficit" : "surplus";

    if (!items_.length) {
      listEl.innerHTML = `<div class="bills-empty">暂无账单，点组件右上角 ＋ 新增</div>`;
    } else {
      listEl.innerHTML = items_.map((b) => `
        <div class="bill-row" data-id="${escapeHtml(b.id)}">
          <div class="br-main">
            <div class="br-item">${escapeHtml(b.item)}${b.detail ? `<span class="br-detail"> · ${escapeHtml(b.detail)}</span>` : ""}</div>
            <div class="br-nums">
              <div class="br-num"><label>支出</label><span class="editable" data-field="spend" data-act="edit-budget">${fmtMoney(b.spend, sym)}</span></div>
              <div class="br-num"><label>实收</label><span class="editable" data-field="paid" data-act="edit-budget">${fmtMoney(b.paid, sym)}</span></div>
            </div>
          </div>
          <button class="btn-icon" data-act="del-bill" title="删除该账单">🗑️</button>
        </div>`).join("");
    }

    if (totalEl) {
      totalEl.innerHTML = `
        <div class="bill-total"><span>总计</span><b>${fmtMoney(spendTotal, sym)}</b></div>
        <div class="bill-total"><span>人均</span><b>${fmtMoney(spendTotal/GROUP_SIZE, sym)}</b></div>
        <div class="bill-total balance ${cls}"><span>结余</span><b>${fmtMoney(bal, sym)}</b></div>`;
    }
  };

  renderOne(listCNY, totalCNY, data.budgetCNY, "¥");
  renderOne(listTHB, totalTHB, data.budgetTHB, "฿");

  // 绑定编辑（span 可点击，行内替换为输入框）
  document.querySelectorAll("[data-act='edit-budget']").forEach((el) => {
    el.addEventListener("click", () => {
      const row = el.closest(".bill-row");
      if (!row) return;
      const type = el.closest(".budget-panel.cny") ? "cny" : "thb";
      startBudgetEdit(type, row.dataset.id, el, el.dataset.field);
    });
  });
}

// ============================================================
// 汇率换算（¥ ⇄ ฿）
// ============================================================
let editingTodoDateId = null; // 待办日期输入中（轮询不重建）

// 日期显示：ISO → "9/30 周三"
function fmtDate(v) {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-");
    const week = ["周日","周一","周二","周三","周四","周五","周六"][new Date(y, m - 1, d).getDay()];
    return `${Number(m)}/${Number(d)} ${week}`;
  }
  return v;
}

// 计算飞行时长（"19:45"→"22:20" → "2小时35分"；跨天按 +24h 处理）
function flightDuration(dep, arr) {
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  };
  const a = toMin(dep), b = toMin(arr);
  if (a === null || b === null) return "";
  let diff = b - a;
  if (diff < 0) diff += 24 * 60;
  const h = Math.floor(diff / 60), m = diff % 60;
  if (h === 0) return m + "分";
  return m ? `${h}小时${m}分` : `${h}小时`;
}

// 生成与后端一致的 id（前缀 + 时间戳36进制 + 随机）
function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

let fxFocused = false;   // 汇率输入框聚焦中（轮询不重建）
let fxCny = "";          // 保留输入值，避免轮询重渲染清空
let fxThb = "";
let fxLiveText = "";     // 最近一次实时汇率提示（轮询重渲染时保留）

function round2(n) {
  return Math.round(n * 100) / 100;
}

function renderFx() {
  const box = $("fx-box");
  if (!box) return;
  const rate = Number(data.fxRate) || 5;
  box.innerHTML = `
    <div class="fx-rate-row">
      <span class="fx-rate-label">汇率</span>
      <span class="fx-rate-eq">1 元 =</span>
      <input class="fx-rate-input" id="fx-rate" inputmode="decimal" value="${rate}">
      <span class="fx-rate-unit">泰铢</span>
      <button class="fx-refresh" id="fx-refresh" title="获取实时汇率并应用" aria-label="获取实时汇率">↻</button>
    </div>
    <p class="fx-note">汇率全团共享 · 每 6 小时自动更新，也可点 ↻ 立即刷新</p>
    <p class="fx-live" id="fx-live">${escapeHtml(fxLiveText)}</p>
    <div class="fx-convert">
      <div class="fx-row">
        <span class="fx-label">¥ 人民币</span>
        <input class="fx-input" id="fx-cny" inputmode="decimal" placeholder="输入金额" value="${escapeHtml(fxCny)}">
      </div>
      <div class="fx-row">
        <span class="fx-label">฿ 泰铢</span>
        <input class="fx-input" id="fx-thb" inputmode="decimal" placeholder="输入金额" value="${escapeHtml(fxThb)}">
      </div>
    </div>`;

  const rateInput = $("fx-rate");
  const cny = $("fx-cny");
  const thb = $("fx-thb");

  const getRate = () => {
    const r = parseFloat(rateInput.value);
    return isFinite(r) && r > 0 ? r : 0;
  };

  const convert = (from) => {
    const r = getRate();
    if (!r) return;
    if (from === "cny") {
      const v = parseFloat(cny.value);
      thb.value = isNaN(v) ? "" : String(round2(v * r));
    } else {
      const v = parseFloat(thb.value);
      cny.value = isNaN(v) ? "" : String(round2(v / r));
    }
  };

  cny.addEventListener("input", () => { fxCny = cny.value; convert("cny"); });
  thb.addEventListener("input", () => { fxThb = thb.value; convert("thb"); });

  rateInput.addEventListener("input", () => { if (fxCny !== "") convert("cny"); });
  rateInput.addEventListener("change", () => {
    const r = getRate();
    if (!r) {
      rateInput.value = Number(data.fxRate) || 5;
      return;
    }
    apiPost("/api/fx", { rate: r, version: data.version }).then((ok) => {
      if (ok) { data.fxRate = r; fxCny = cny.value; fxThb = thb.value; }
    });
  });

  const refreshBtn = $("fx-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.classList.add("spinning");
      refreshBtn.disabled = true;
      try {
        const res = await fetch("/api/fx/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: data ? data.version : undefined })
        });
        if (res.status === 409) {
          setSync("offline", "数据已更新，正在刷新…");
          poll();
          return;
        }
        const json = await res.json().catch(() => ({}));
        if (json.ok) {
          if (data) {
            if (typeof json.version === "number") data.version = json.version;
            data.fxRate = json.rate;
          }
          const t = new Date(json.fetchedAt);
          fxLiveText = `实时汇率：1 元 = ${json.rate} 泰铢 · ${t.toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新`;
          renderFx();
          setSync("online", "已应用实时汇率");
        } else {
          setSync("offline", (json && json.error) || "获取实时汇率失败");
        }
      } catch (e) {
        setSync("offline", "获取实时汇率失败");
      } finally {
        refreshBtn.classList.remove("spinning");
        refreshBtn.disabled = false;
      }
    });
  }

  [cny, thb, rateInput].forEach((el) => {
    el.addEventListener("focus", () => { fxFocused = true; });
    el.addEventListener("blur", () => { fxFocused = false; fxCny = cny.value; fxThb = thb.value; });
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
  $("modal-fx-overlay").style.display = "none";
}

// ============================================================
// 预算单元格编辑
// ============================================================
function startBudgetEdit(type, id, td, field) {
  if (editingBudgetId) return;
  editingBudgetId = id;
  const list = type === "thb" ? data.budgetTHB : data.budgetCNY;
  const b = list.find((x) => x.id === id);
  if (!b) { editingBudgetId = null; return; }
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
  input.style.fontSize = "1rem"; // 16px，避免 iOS 聚焦输入时自动放大页面
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();

  let finished = false; // 防止 blur 与 Escape 双重触发
  const finish = (save) => {
    if (finished) return;
    finished = true;
    editingBudgetId = null;
    if (save) {
      const val = parseFloat(input.value);
      if (!isNaN(val) && val !== oldVal) {
        const b = list.find((x) => x.id === id);
        if (b) b[field] = val;
        renderBudget();
        apiPost(`/api/budget/${type}/${id}`, { [field]: val, version: data.version });
      }
    }
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { finish(false); renderBudget(); }
  });
}

// ============================================================
// API 辅助（携带版本乐观锁；409 时自动刷新）
// ============================================================
async function apiPost(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.status === 409) {
      setSync("offline", "数据已更新，正在刷新…");
      poll();
      return false;
    }
    if (!res.ok) { setSync("offline", "保存失败，请重试"); return false; }
    const json = await res.json().catch(() => ({}));
    if (data && typeof json.version === "number") data.version = json.version;
    return true;
  } catch (e) {
    setSync("offline", "保存失败，请重试");
    return false;
  }
}

async function apiDelete(url) {
  try {
    const version = data ? data.version : undefined;
    const sep = url.includes("?") ? "&" : "?";
    const full = version !== undefined ? `${url}${sep}version=${encodeURIComponent(version)}` : url;
    const res = await fetch(full, { method: "DELETE" });
    if (res.status === 409) {
      setSync("offline", "数据已更新，正在刷新…");
      poll();
      return false;
    }
    if (!res.ok) { setSync("offline", "删除失败，请重试"); return false; }
    const json = await res.json().catch(() => ({}));
    if (data && typeof json.version === "number") data.version = json.version;
    return true;
  } catch (e) {
    setSync("offline", "删除失败");
    return false;
  }
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
    const freshKey = JSON.stringify(fresh.lastUpdated) + "|" + (fresh.version || 0) + "|" + fresh.flights?.length;
    const curKey = JSON.stringify(data?.lastUpdated) + "|" + (data?.version || 0) + "|" + data?.flights?.length;
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
  // 汇率换算：顶部按钮 → 弹窗
  $("btn-fx").addEventListener("click", () => {
    renderFx();
    $("modal-fx-overlay").style.display = "flex";
  });
  $("btn-cancel-fx").addEventListener("click", closeModal);
  $("modal-fx-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });

  // 航班行操作（委托）：点击任意单元格打开编辑弹窗
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".flight-card");
    if (card) {
      const id = card.dataset.id;
      const actBtn = e.target.closest("[data-act]");
      if (actBtn) {
        if (actBtn.dataset.act === "edit") openFlightModal(id);
        if (actBtn.dataset.act === "del" && confirm("删除这段航班？")) {
          data.flights = data.flights.filter((f) => f.id !== id);
          renderFlights();
          apiDelete(`/api/flights/${id}`);
        }
      } else {
        openFlightModal(id);
      }
    }
  });

  // 新增按钮（动态渲染进组件头部）→ 用事件委托，不依赖渲染时机
  document.addEventListener("click", (e) => {
    const addBtn = e.target.closest("#btn-add-flight, #btn-add-todo, #btn-add-bill");
    if (!addBtn) return;
    if (addBtn.id === "btn-add-flight") openNewFlightModal();
    else if (addBtn.id === "btn-add-todo") {
      $("t-text").value = "";
      $("t-date").value = "";
      $("modal-todo-overlay").style.display = "flex";
    } else if (addBtn.id === "btn-add-bill") {
      $("b-item").value = "";
      $("b-detail").value = "";
      $("b-spend").value = 0;
      $("b-paid").value = 0;
      $("modal-bill-overlay").style.display = "flex";
    }
  });

  $("btn-cancel").addEventListener("click", closeModal);
  $("btn-save-flight").addEventListener("click", () => {
    const body = {
      date: $("f-date").value, route: $("f-route").value, dep: $("f-dep").value,
      arr: $("f-arr").value, flightNo: $("f-flightNo").value,
      bookingNo: $("f-bookingNo").value, status: $("f-status").value, note: $("f-note").value,
      version: data ? data.version : undefined
    };
    // 乐观更新：立即回显，不等服务端/轮询
    if (editingFlightId) {
      const f = data.flights.find((x) => x.id === editingFlightId);
      if (f) Object.assign(f, { date: body.date, route: body.route, dep: body.dep, arr: body.arr, flightNo: body.flightNo, bookingNo: body.bookingNo, status: body.status, note: body.note });
      renderFlights();
      apiPost(`/api/flights/${editingFlightId}`, body);
    } else {
      data.flights.push({ id: genId("f"), date: body.date, route: body.route, dep: body.dep, arr: body.arr, flightNo: body.flightNo, bookingNo: body.bookingNo, status: body.status, note: body.note });
      renderFlights();
      apiPost("/api/flights", body);
    }
    closeModal();
  });
  $("btn-del-flight").addEventListener("click", () => {
    if (editingFlightId && confirm("删除这段航班？")) {
      data.flights = data.flights.filter((f) => f.id !== editingFlightId);
      renderFlights();
      apiDelete(`/api/flights/${editingFlightId}`);
      closeModal();
    }
  });

  $("btn-cancel-todo").addEventListener("click", closeModal);
  $("btn-save-todo").addEventListener("click", () => {
    const text = $("t-text").value.trim();
    const category = $("t-category").value;
    const date = $("t-date").value;
    if (!text) return;
    data.todos.push({ id: genId("t"), category, text, date, done: false });
    renderTodos();
    apiPost("/api/todos", { text, category, date, version: data ? data.version : undefined });
    closeModal();
  });

  $("modal-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });
  $("modal-todo-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });
  $("modal-bill-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });

  // 币种切换时更新支出/实收标签的颜色
  $("b-type").addEventListener("change", () => {
    const isTHB = $("b-type").value === "thb";
    $("b-spend-label").style.color = isTHB ? "#5D4037" : "#2E7D32";
    $("b-paid-label").style.color = isTHB ? "#5D4037" : "#2E7D32";
  });
  $("btn-cancel-bill").addEventListener("click", closeModal);
  $("btn-save-bill").addEventListener("click", () => {
    const item = $("b-item").value.trim() || "新账单";
    const type = $("b-type").value === "thb" ? "thb" : "cny";
    const detail = $("b-detail").value.trim();
    const spend = Number($("b-spend").value) || 0;
    const paid =  Number($("b-paid").value)  || 0;
    const list = type === "thb" ? data.budgetTHB : data.budgetCNY;
    list.push({ id: genId(type === "thb" ? "bt" : "bc"), item, detail, spend, paid });
    renderBudget();
    apiPost(`/api/budget/${type}`, { item, detail, spend, paid, version: data ? data.version : undefined });
    closeModal();
  });

  // 删除账单按钮（委托，按所在表判断币种）
  document.addEventListener("click", (e) => {
    const delBtn = e.target.closest('[data-act="del-bill"]');
    if (delBtn) {
      const row = delBtn.closest(".bill-row");
      const type = delBtn.closest(".budget-panel.cny") ? "cny" : "thb";
      if (row && confirm("删除该账单？")) {
        const list = type === "thb" ? data.budgetTHB : data.budgetCNY;
        const idx = list.findIndex((b) => b.id === row.dataset.id);
        if (idx >= 0) list.splice(idx, 1);
        renderBudget();
        apiDelete(`/api/budget/${type}/${row.dataset.id}`);
      }
    }
  });

  fetchData().catch((e) => setSync("offline", "加载失败，请刷新"));
  setupPolling();
});
