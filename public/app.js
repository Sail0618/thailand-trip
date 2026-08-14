// ============================================================
// 泰国行程 · 前端逻辑
// - 组件化渲染（航班/位置/行程/待办/预算）
// - 可上下拖拽排序组件
// - 航班/待办/预算的编辑交互
// - 轮询实时同步（兼容 Vercel serverless）
// - 所有用户可写字段渲染前统一 HTML 转义（防 XSS）
// - 写操作携带 version 乐观锁，冲突(409)时自动刷新
// ============================================================

// ============================================================
// 数据安全
// - ?export=1：只读本地缓存导出页（不联网、不改缓存），数据找回用
// - 服务器数据 version 比本地缓存旧时，保留本地缓存并提示一键恢复线上
//   （防止服务器被旧快照覆盖后，客户端又用旧快照覆盖本机好数据）
// ============================================================
const EXPORT_MODE = new URLSearchParams(location.search).has("export");
let restoreBannerShown = false;   // 恢复提示只弹一次
let acceptServerOverride = false; // 用户点"暂不"后，接受服务器数据并恢复正常同步

// 注册 PWA Service Worker（离线缓存页面外壳；导出页不注册）
if ("serviceWorker" in navigator && !EXPORT_MODE) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// ============================================================
// 添加到桌面/主屏幕（等 $ 定义后再初始化，避免 TDZ）
// ============================================================
function setupInstallFeature() {
// ============================================================
// 添加到桌面/主屏幕
// - Chrome/Android/Edge：拦截 beforeinstallprompt，一键调用系统安装
// - iOS Safari：无安装 API，点击弹出"分享→添加到主屏幕"引导
// - 已安装（standalone）时自动隐藏按钮
// ============================================================
let deferredPrompt = null;
function isStandaloneApp() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
}
function showInstallBtn() {
  const b = $("btn-install");
  if (!b) return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  // 已安装隐藏；仅当"可安装(Chrome/Android)"或"iOS Safari"时显示
  const show = !isStandaloneApp() && (deferredPrompt || isIOS);
  b.style.display = show ? "inline-block" : "none";
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallBtn();
});
window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  const b = $("btn-install");
  if (b) b.style.display = "none";
  toast("✅ 已安装到桌面");
});
$("btn-install").addEventListener("click", async () => {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (deferredPrompt) {
    // 一键调用系统安装（Chrome/Android/Edge）
    try {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice.catch(() => ({}));
      deferredPrompt = null;
      if (choice && choice.outcome === "accepted") {
        const b = $("btn-install");
        if (b) b.style.display = "none";
        toast("✅ 已安装到桌面");
      }
    } catch (e) { /* 用户取消或浏览器不支持 */ }
  } else if (isIOS) {
    // iOS Safari：展示引导
    $("modal-install-overlay").style.display = "flex";
  } else {
    // 桌面端不支持一键安装：引导用手机打开
    toast("请用手机 Safari 打开本站，再添加到主屏幕", "err");
  }
});
$("btn-install-close").addEventListener("click", () => { $("modal-install-overlay").style.display = "none"; });
$("modal-install-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) $("modal-install-overlay").style.display = "none"; });
}

// 服务器数据是否应覆盖本地缓存
// 判定"被回滚"：①服务器 version 低于缓存 ②缓存有退税小票/勾选待办但服务器没有（防旧快照覆盖）
function freshShouldWin(cached, fresh) {
  if (!cached) return true;
  if (acceptServerOverride) return true;
  if ((Number(fresh && fresh.version) || 0) < (Number(cached.version) || 0)) return false;
  const cRecs = (cached.receipts || []).length;
  const fRecs = (fresh && Array.isArray(fresh.receipts) ? fresh.receipts : []).length;
  const cDone = (cached.todos || []).filter((t) => t.done).length;
  const fDone = (fresh && Array.isArray(fresh.todos) ? fresh.todos : []).filter((t) => t.done).length;
  if (cRecs > 0 && fRecs === 0) return false;
  if (cDone > 0 && fDone === 0) return false;
  return true;
}

function initExportPage() {
  const cache = (() => { try { return localStorage.getItem("trip_data_cache_v1"); } catch (e) { return null; } })();
  let parsed = null;
  try { parsed = cache ? JSON.parse(cache) : null; } catch (e) { parsed = null; }
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;z-index:99999;background:#F6F5F2;overflow:auto;padding:28px 16px calc(28px + env(safe-area-inset-bottom));font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif;color:#1F2A27";
  let html = `<div style="max-width:540px;margin:0 auto">
    <h1 style="font-size:20px;margin:0 0 6px">📤 导出本地数据</h1>
    <p style="font-size:13px;color:#6E7470;margin:0 0 18px;line-height:1.7">本页面<b>不会联网、不会修改你的缓存</b>，只把当前设备浏览器里保存的行程数据导出来。<br>如果你是在别的手机/电脑上使用过，请到那台设备打开本页面。</p>`;
  if (!parsed) {
    html += `<div style="background:#fff;border:1px solid #ECEAE5;border-radius:14px;padding:24px;text-align:center;color:#6E7470;font-size:14px;line-height:1.8">本机没有找到数据缓存。<br>（可能这台设备没打开过行程页，或缓存已被覆盖）</div>`;
  } else {
    const done = (parsed.todos || []).filter((t) => t.done).length;
    const recs = (parsed.receipts || []).length;
    html += `<div style="background:#fff;border:1px solid #ECEAE5;border-radius:14px;padding:16px;margin-bottom:12px;font-size:13px;line-height:2">
      <div>📅 数据版本：<b>${esc(parsed.version)}</b> · 更新于 ${esc(parsed.lastUpdated || "—")}</div>
      <div>✅ 已勾选待办：<b>${done}</b> 项</div>
      <div>🧾 退税小票：<b>${recs}</b> 条</div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:14px">
      <button id="exp-copy" style="flex:1;padding:13px;border:none;border-radius:12px;background:#0D7D6B;color:#fff;font-size:15px;font-weight:600">📋 复制 JSON</button>
      <button id="exp-dl" style="flex:1;padding:13px;border:none;border-radius:12px;background:#1976D2;color:#fff;font-size:15px;font-weight:600">⬇️ 下载文件</button>
    </div>
    <pre style="background:#fff;border:1px solid #ECEAE5;border-radius:14px;padding:14px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:48vh;overflow:auto">${esc(cache)}</pre>`;
  }
  html += `<p style="text-align:center;margin-top:18px;font-size:12px;color:#A6ABA8"><a href="/" style="color:#0F766E">← 返回行程主页</a></p></div>`;
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  const copyBtn = document.getElementById("exp-copy");
  const dlBtn = document.getElementById("exp-dl");
  if (copyBtn && cache) {
    copyBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(cache); }
      catch (e) {
        const ta = document.createElement("textarea");
        ta.value = cache; ta.style.cssText = "position:fixed;top:-999px;opacity:0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (e2) {}
        document.body.removeChild(ta);
      }
      copyBtn.textContent = "✅ 已复制";
    });
  }
  if (dlBtn && cache) {
    dlBtn.addEventListener("click", () => {
      const blob = new Blob([cache], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "thailand-trip-cache.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }
}

// 服务器数据被旧快照覆盖时，提示用本机缓存恢复线上（需用户确认）
function showRestoreBanner(cached, fresh) {
  if (!cached || restoreBannerShown) return;
  restoreBannerShown = true;
  const done = (cached.todos || []).filter((t) => t.done).length;
  const recs = (cached.receipts || []).length;
  const bar = document.createElement("div");
  bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:998;background:#FFF8E1;border-top:1px solid #F0E0A0;padding:14px 16px calc(14px + env(safe-area-inset-bottom));box-shadow:0 -4px 16px rgba(0,0,0,.08)";
  bar.innerHTML = `<div style="max-width:560px;margin:0 auto;font-size:13px;line-height:1.7">
    <b>⚠️ 检测到本机缓存比线上新</b>（缓存 v${escapeHtml(cached.version)} · 线上 v${escapeHtml(fresh ? fresh.version : "?")}）<br>
    缓存里还有 <b>${done}</b> 项勾选待办、<b>${recs}</b> 条小票，要<b>用本机数据恢复线上</b>吗？
    <div style="display:flex;gap:10px;margin-top:10px">
      <button id="rb-yes" style="flex:1;padding:11px;border:none;border-radius:10px;background:#0D7D6B;color:#fff;font-size:14px;font-weight:600">恢复线上数据</button>
      <button id="rb-no" style="flex:1;padding:11px;border:none;border-radius:10px;background:#fff;color:#6E7470;font-size:14px;border:1px solid #E0DDD6">暂不</button>
    </div></div>`;
  document.body.appendChild(bar);
  const close = () => bar.remove();
  document.getElementById("rb-no").addEventListener("click", () => {
    acceptServerOverride = true; // 用户选择不用本机覆盖：恢复正常同步
    close();
    poll();
  });
  document.getElementById("rb-yes").addEventListener("click", async () => {
    document.getElementById("rb-yes").textContent = "恢复中…";
    try {
      const res = await fetch("/api/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-User": encodeURIComponent(getUserName()) },
        body: JSON.stringify({ ...cached, version: (fresh && fresh.version) })
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        data = { ...cached, version: j.version || cached.version };
        saveCache(data);
        renderAll();
        setSync("online", "✅ 已用本机数据恢复线上");
        close();
      } else if (res.status === 409) {
        setSync("offline", "数据已被他人更新，正在刷新…");
        close();
        poll();
      } else {
        setSync("offline", "恢复失败，请重试");
        const yesBtn = document.getElementById("rb-yes");
        if (yesBtn) yesBtn.textContent = "重试恢复";
      }
    } catch (e) {
      setSync("offline", "恢复失败，请重试");
      const yesBtn = document.getElementById("rb-yes");
      if (yesBtn) yesBtn.textContent = "重试恢复";
    }
  });
}

if (EXPORT_MODE) initExportPage();

// 确认弹窗按钮（静态元素，直接绑定一次）
document.addEventListener("DOMContentLoaded", () => {
  $("confirm-yes").addEventListener("click", () => {
    closeConfirmDialog();
    const cb = confirmCallback; confirmCallback = null;
    if (cb) cb();
  });
  $("confirm-no").addEventListener("click", closeConfirmDialog);
  $("modal-confirm-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeConfirmDialog(); });
});

// ============================================================
// 全局用户名：首次进入输入一次，用于位置共享/退税小票等所有功能
// ============================================================
const USER_KEY = "trip_user_name";

// ============================================================
// 操作日志：入口 + 管理员密码（SHA-256 校验，不存明文）
// ============================================================
const ADMIN_PASSWORD_HASH = "102f41444cd745e414917d4eed6ab1af4330e02ec3dfc315837741eeea8e7636"; // 595792
async function sha256hex(str) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(str)));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    return String(str); // 非 https/不支持时退化为原文比较
  }
}

// ============================================================
// 左滑删除（通用助手）
// - setupSwipeRow(row, onDelete)：左滑露出红色删除按钮，点删除执行 onDelete
// - 同一时间只允许一行处于打开状态；已打开时点击行内任意位置先关闭
// ============================================================
let swipeOpenRow = null;
function closeSwipeRow() {
  if (swipeOpenRow) {
    const c = swipeOpenRow.querySelector(".swipe-content");
    if (c) c.style.transform = "";
    swipeOpenRow.classList.remove("swipe-open");
    swipeOpenRow = null;
  }
}
function setupSwipeRow(row, onDelete) {
  const content = row.querySelector(".swipe-content");
  if (!content) return row;
  let startX = 0, startY = 0, dx = 0, dy = 0, active = false, moved = false, wasOpen = false;
  row.addEventListener("pointerdown", (e) => {
    wasOpen = row.classList.contains("swipe-open");
    startX = e.clientX; startY = e.clientY; dx = 0; dy = 0; active = true; moved = false;
  });
  row.addEventListener("pointermove", (e) => {
    if (!active) return;
    dx = e.clientX - startX; dy = e.clientY - startY;
    if (!moved && Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
      moved = true;
      content.style.transition = "none";
      if (wasOpen) {
        // 已打开：内容跟随手指（从 -82 开始），右滑可恢复，左滑保持打开
        content.style.transform = `translateX(${Math.min(0, -82 + dx)}px)`;
      } else if (dx < 0) {
        // 未打开：只响应左滑
        content.style.transform = `translateX(${Math.max(-82, dx)}px)`;
      }
    }
  });
  const end = () => {
    if (!active) return;
    active = false;
    content.style.transition = "";
    // 吞掉本次滑动/关闭触发的 click，避免误开编辑/查看（删除按钮不受影响；超时自动解除）
    const stop = (ev) => {
      document.removeEventListener("click", stop, true);
      if (ev.target && ev.target.closest && ev.target.closest(".swipe-del")) return; // 允许点删除
      if (row.contains(ev.target)) { ev.stopPropagation(); ev.preventDefault(); }
    };
    if (wasOpen) {
      if (moved && dx > 45) {
        // 右滑 → 恢复原状
        content.style.transform = "";
        row.classList.remove("swipe-open");
        if (swipeOpenRow === row) swipeOpenRow = null;
        document.addEventListener("click", stop, true);
        setTimeout(() => document.removeEventListener("click", stop, true), 400);
      } else {
        content.style.transform = "translateX(-82px)"; // 左滑/未动 → 保持打开
      }
    } else if (moved && dx < -45) {
      closeSwipeRow();
      content.style.transform = "translateX(-82px)";
      row.classList.add("swipe-open");
      swipeOpenRow = row;
      document.addEventListener("click", stop, true);
      setTimeout(() => document.removeEventListener("click", stop, true), 400);
    } else {
      content.style.transform = "";
      row.classList.remove("swipe-open");
      if (swipeOpenRow === row) swipeOpenRow = null;
    }
  };
  row.addEventListener("pointerup", end);
  row.addEventListener("pointercancel", end);
  // 已打开时：点击行内先关闭，不再触发行内其它操作
  row.addEventListener("click", (e) => {
    if (row.classList.contains("swipe-open")) {
      closeSwipeRow();
      e.stopPropagation();
      e.preventDefault();
    }
  });
  const del = row.querySelector(".swipe-del");
  if (del) del.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (onDelete) onDelete();
  });
  return row;
}
// ============================================================
// 通用确认弹窗 + 轻提示（替代原生 confirm/alert）
// ============================================================
let confirmCallback = null;
function confirmDialog(message, onYes, opts) {
  confirmCallback = onYes || null;
  $("confirm-msg").textContent = message;
  const yesBtn = $("confirm-yes");
  yesBtn.textContent = (opts && opts.yesText) || "确认";
  yesBtn.className = "btn " + (opts && opts.danger === false ? "btn-primary" : "btn-danger");
  $("modal-confirm-overlay").style.display = "flex";
}
function closeConfirmDialog() {
  $("modal-confirm-overlay").style.display = "none";
  confirmCallback = null;
}
let toastTimer = null;
function toast(msg, type) {
  const el = $("app-toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "app-toast show" + (type === "err" ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

// 弹窗内按回车保存（textarea 不触发）
function modalEnterToSave(overlayId, saveBtnId) {
  const ov = $(overlayId);
  if (!ov) return;
  ov.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key === "Enter" && t && t.tagName !== "TEXTAREA" && t.tagName !== "BUTTON") {
      e.preventDefault();
      const btn = $(saveBtnId);
      if (btn) btn.click();
    }
  });
}

// 名字同时存 localStorage + cookie（双保险）：iOS 独立模式/隐私模式等环境下
// 即使 localStorage 被清，cookie 仍在；读取时自动迁移回 localStorage
function getUserName() {
  try {
    const v = (localStorage.getItem(USER_KEY) || "").trim();
    if (v) return v;
  } catch (e) { /* ignore */ }
  try {
    const m = document.cookie.match(/(?:^|;\s*)trip_user_name=([^;]+)/);
    if (m) {
      const v = decodeURIComponent(m[1]).trim();
      if (v) {
        try { localStorage.setItem(USER_KEY, v); } catch (e2) { /* ignore */ }
        return v;
      }
    }
  } catch (e) { /* ignore */ }
  return "";
}
function setUserName(name) {
  const v = String(name || "").trim();
  try { localStorage.setItem(USER_KEY, v); } catch (e) { /* ignore */ }
  try {
    document.cookie = USER_KEY + "=" + encodeURIComponent(v) + "; max-age=31536000; path=/; SameSite=Lax";
  } catch (e) { /* ignore */ }
}

let data = null;               // 当前数据快照
let editingFlightId = null;    // 正在编辑的航班 id
let editingBudgetId = null;    // 正在编辑的预算 id

const $ = (id) => document.getElementById(id);
setupInstallFeature(); // 初始化"添加到桌面"按钮（元素为静态 HTML，此时已可用）

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
  { id: "budget",    title: "团队账单",    color: "budget",  hint: "¥ / ฿ 双币统计 · 点击修改", order: 0, addBtn: "btn-add-bill" },
  { id: "days",      title: "每日行程",    color: "tip",     hint: "共 11 天 · 点击展开", order: 1 },
  { id: "receipts",  title: "退税小票",    color: "receipt",  hint: "拍照上传 · 按人分组", order: 2, addBtn: "btn-add-receipt" },
  { id: "location",  title: "位置共享",    color: "location", hint: "授权后自动展示队友位置", order: 3 },
  { id: "flights",   title: "航班总览",   color: "flight",  hint: "点击卡片可编辑 · 实时同步", order: 4, addBtn: "btn-add-flight" },
  { id: "todos",     title: "待办事项",    color: "alert",   hint: "点击可编辑 · 按日期排序", order: 5, addBtn: "btn-add-todo" }
];

// 排序存储 key 加版本号：让新的默认顺序对已有用户生效（旧的自定义排序作废一次）
const ORDER_KEY = "trip_comp_order_v2";

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
// 本地缓存：首次加载后存 localStorage，再次进入先显示缓存再后台更新（秒开）
const CACHE_KEY = "trip_data_cache_v1";

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : null;
  } catch (e) { return null; }
}

function saveCache(d) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) { /* 存储满等忽略 */ }
}

async function fetchData() {
  // 1) 有本地缓存 → 立即渲染（秒开），随后后台拉最新
  const cached = loadCache();
  if (cached) {
    data = cached;
    renderAll();
    setSync("online", "已加载本地缓存");
  } else {
    setSync("offline", "加载中…");
  }
  // 2) 拉取服务器最新
  try {
    const res = await fetch("/api/data");
    if (!res.ok) throw new Error("加载失败");
    const fresh = await res.json();
    const same = data && data.version === fresh.version && data.lastUpdated === fresh.lastUpdated;
    if (cached && !freshShouldWin(cached, fresh)) {
      // 服务器数据比本地缓存旧（服务器被旧快照覆盖/回滚）：
      // 保留本地缓存，避免把还带勾选状态/小票的数据覆盖掉，并提示可恢复
      setSync("offline", "⚠️ 服务器数据较旧，已保留本机缓存");
      if (cached) { data = cached; renderAll(); }
      showRestoreBanner(cached, fresh);
    } else {
      data = fresh;
      saveCache(fresh);
      if (same) {
        setSync("online", "实时同步中");
      } else {
        renderAll();
        setSync("online", "实时同步中");
      }
    }
  } catch (e) {
    if (!data) {
      setSync("offline", "加载失败，请刷新");
      throw e;
    }
    setSync("offline", "网络异常，展示缓存数据");
  }
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
  if (!editingReceiptId) renderReceipts();
}

// ============================================================
// 操作变更记录（页面底部）
// ============================================================
function fmtChangeTime(ts) {
  const diff = Date.now() - (Number(ts) || Date.now());
  const mins = Math.round(diff / 60000);
  if (mins <= 1) return "刚刚";
  if (mins < 60) return mins + " 分钟前";
  if (mins < 1440) return Math.floor(mins / 60) + " 小时前";
  return Math.floor(mins / 1440) + " 天前";
}

function renderChangelog() {
  const el = $("log-list");
  if (!el) return;
  const list = (data && data.changelog) || [];
  if (!list.length) {
    el.innerHTML = `<div class="chg-empty">暂无操作记录，大家改了什么会显示在这里</div>`;
    return;
  }
  const myName = getUserName();
  const rows = list.slice().reverse().map((c) => `
    <div class="chg-item">
      <span class="chg-user">${escapeHtml(c.user)}</span>
      <span class="chg-action">${escapeHtml(c.action)}</span>
      <span class="chg-time">${escapeHtml(fmtChangeTime(c.at))}</span>
    </div>`).join("");
  el.innerHTML = rows;
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
            <iframe data-src="/location.html" class="loc-iframe" id="loc-iframe"
              style="width:100%;border:none;border-radius:0 0 14px 14px;background:var(--bg)"
              title="位置共享"></iframe>
            <div class="loc-loading" id="loc-loading" style="text-align:center;padding:28px 16px;color:var(--text-3);font-size:.86em">📍 展开后自动加载位置共享 · 首次请允许定位</div>
          </div>`;
        break;
      case "days":
        bodyContent = `<div class="section-body"><div id="days-container"></div></div>`;
        break;
      case "todos":
        bodyContent = `<div class="section-body"><div id="todos-container"></div></div>`;
        break;
      case "receipts":
        bodyContent = `<div class="section-body"><div id="receipts-container"></div></div>`;
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
          <p class="hint-note">💡 ¥ 与 ฿ 分开独立统计，互不折算。点击金额即可修改；「实收 − 支出」为结余。左滑账单可删除。</p>`;
        break;
    }

    return `
      <div class="section component-card" data-comp="${escapeHtml(c.id)}">
        <div class="section-header ${c.color} comp-header" role="button" tabindex="0" aria-expanded="false" title="点击展开/收起">
          <span class="drag-handle" title="拖动排序" draggable="true">⋮⋮</span>
          <span class="hdr-bar" aria-hidden="true"></span>
          <span class="hdr-title">${escapeHtml(c.title)}</span>
          <span class="section-hint">${escapeHtml(c.hint)}</span>
          <span class="comp-actions">
            ${c.addBtn ? `<button class="add-btn" id="${c.addBtn}" title="新增" aria-label="新增">＋ 新增</button>` : ""}
          </span>
          <span class="comp-chevron" aria-hidden="true"></span>
        </div>
        <div id="${bodyId}" class="comp-body">${bodyContent}</div>
      </div>`;
  }).join("");

  setupDragSort(container);
  setupTouchDrag(container);
  setupComponentToggle(container);
}

// ============================================================
// 触屏拖拽排序（手机：长按 ⋮⋮ 手柄拖动换序，替代原 ↑↓ 按钮）
// ============================================================
function setupTouchDrag(container) {
  if (!("ontouchstart" in window)) return;
  container.querySelectorAll(".drag-handle").forEach((handle) => {
    let dragCard = null;
    handle.addEventListener("touchstart", (e) => {
      const card = handle.closest(".component-card");
      if (!card) return;
      dragCard = card;
      card.classList.add("dragging");
      e.preventDefault();
    }, { passive: false });

    handle.addEventListener("touchmove", (e) => {
      if (!dragCard) return;
      const y = e.touches[0].clientY;
      const cards = Array.from(container.querySelectorAll(".component-card"));
      const over = cards.find((c) => {
        if (c === dragCard) return false;
        const r = c.getBoundingClientRect();
        return y >= r.top && y <= r.bottom;
      });
      if (over) {
        const r = over.getBoundingClientRect();
        const before = y < r.top + r.height / 2;
        container.insertBefore(dragCard, before ? over : over.nextSibling);
      }
      e.preventDefault();
    }, { passive: false });

    const end = () => {
      if (!dragCard) return;
      dragCard.classList.remove("dragging");
      const newOrder = Array.from(container.querySelectorAll(".component-card"))
        .map((c) => c.dataset.comp);
      if (new Set(newOrder).size === COMPONENTS.length) saveOrder(newOrder);
      dragCard = null;
    };
    handle.addEventListener("touchend", end);
    handle.addEventListener("touchcancel", end);
  });
}

// ============================================================
// 组件折叠：默认收起，点击标题栏展开/收起
// ============================================================
function setupComponentToggle(container) {
  container.querySelectorAll(".comp-header").forEach((h) => {
    const card = h.closest(".component-card");
    const body = card ? card.querySelector(".comp-body") : null;
    if (!body) return;
    const toggle = (force) => {
      const open = force !== undefined ? force : !body.classList.contains("open");
      body.classList.toggle("open", open);
      h.setAttribute("aria-expanded", open ? "true" : "false");
      // 位置共享组件：展开时才加载 iframe（避免进入页面即请求定位）
      if (open) {
        const card = h.closest(".component-card");
        const iframe = card && card.querySelector("iframe[data-src]");
        if (iframe && !iframe.src) iframe.src = iframe.dataset.src;
      }
    };
    h.addEventListener("click", (e) => {
      // 点击拖拽手柄 / 新增按钮时不切换折叠
      if (e.target.closest(".drag-handle, .add-btn")) return;
      toggle();
    });
    h.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  });
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
      <div class="swipe-row">
        <button class="swipe-del" type="button">删除</button>
        <div class="swipe-content flight-card ${cls}" data-id="${escapeHtml(f.id)}">
          <div class="fc-top">
            <span class="fc-no ${hasNo ? "" : "empty"}">✈ ${hasNo ? escapeHtml(f.flightNo) : "—"}</span>
            <span class="fc-right">
              <span class="status-pill ${cls}">${escapeHtml(f.status || "待定")}</span>
              <span class="fc-actions">
                <button class="btn-icon" data-act="edit" title="编辑">✏️</button>
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
    // 左滑删除航班
    list.querySelectorAll(".swipe-row").forEach((row) => {
      const card = row.querySelector(".flight-card");
      setupSwipeRow(row, () => {
        const id = card.dataset.id;
        confirmDialog("删除这段航班？", () => {
          data.flights = data.flights.filter((f) => f.id !== id);
          renderFlights();
          apiDelete(`/api/flights/${id}`);
        });
      });
    });
  }
}

// ============================================================
// 每日行程渲染
// ============================================================
function renderDays() {
  const container = $("days-container");
  if (!container) return;
  const cards = (data.days || []).map((d) => `
    <div class="day-card" style="--dayc:${escapeHtml(d.color)};--dayl:${escapeHtml(d.color)}1A">
      <div class="day-header" data-day="${escapeHtml(d.id)}" role="button" tabindex="0" aria-expanded="false">
        <div class="left">
          <div class="day-badge" title="${escapeHtml(d.date)} ${escapeHtml(d.month)}">${escapeHtml(d.date)}</div>
          <div>
            <div class="day-title">${escapeHtml(d.title)}</div>
            <div class="day-sub">${d.sub ? escapeHtml(d.sub) + " · " : ""}${escapeHtml(d.weekday)}</div>
          </div>
        </div>
        <span class="day-tag">${escapeHtml(d.tag)}</span>
        <button class="btn-icon day-edit" data-edit-day="${escapeHtml(d.id)}" title="编辑这天" aria-label="编辑这天">✏️</button>
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

  container.innerHTML = cards + `
    <button class="day-add-row" id="day-add-row" title="新增一天">＋ 新增一天</button>`;

  document.querySelectorAll(".day-header").forEach((h) => {
    const toggle = () => {
      const body = document.getElementById("day-body-" + h.dataset.day);
      if (!body) return;
      const open = body.classList.toggle("open");
      h.setAttribute("aria-expanded", open ? "true" : "false");
    };
    h.addEventListener("click", (e) => {
      // 点击编辑按钮不触发展开/收起
      if (e.target.closest("[data-edit-day]")) return;
      toggle();
    });
    h.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });
}

// ============================================================
// 每日行程编辑（弹窗）
// ============================================================
let editingDayId = null;
let dayColor = "#0F766E";

// 退税小票编辑状态
let editingReceiptId = null;
let pendingReceiptImage = null;   // 待上传的压缩图片 dataURL
let receiptImageKey = "";         // 当前小票已上传的图片 key
const DAY_COLORS = ["#0F766E", "#2563EB", "#B7791F", "#D64545", "#7C3AED", "#E91E63", "#3F51B5", "#607D8B"];

function openDayEditModal(id) {
  editingDayId = id;
  const day = id ? (data.days || []).find((d) => d.id === id) : null;
  $("day-modal-title").textContent = day ? "编辑行程" : "新增一天";
  $("d-date").value = day ? (day.date || "") : "";
  $("d-month").value = day ? (day.month || "") : "";
  $("d-weekday").value = day ? (day.weekday || "") : "";
  $("d-title").value = day ? (day.title || "") : "";
  $("d-sub").value = day ? (day.sub || "") : "";
  $("d-tag").value = day ? (day.tag || "") : "";
  dayColor = day && day.color ? day.color : DAY_COLORS[0];
  renderDayColors();
  renderDayItems(day ? (day.items || []) : []);
  $("btn-del-day").style.display = day ? "" : "none";
  $("modal-day-overlay").style.display = "flex";
}

function closeDayModal() {
  $("modal-day-overlay").style.display = "none";
  editingDayId = null;
}

function renderDayColors() {
  $("d-colors").innerHTML = DAY_COLORS.map((c) =>
    `<button type="button" class="dc-swatch ${c === dayColor ? "sel" : ""}" data-color="${c}" style="--sw:${c}" aria-label="颜色 ${c}"></button>`
  ).join("");
  document.querySelectorAll("#d-colors .dc-swatch").forEach((b) => {
    b.addEventListener("click", () => { dayColor = b.dataset.color; renderDayColors(); });
  });
}

function addDayItemRow(item) {
  const wrap = $("d-items");
  const row = document.createElement("div");
  row.className = "swipe-row";
  row.innerHTML = `
    <button class="swipe-del" type="button">删除</button>
    <div class="swipe-content di-item">
      <div class="di-grid">
        <input class="di-dot" value="${escapeHtml((item && item.dot) || "")}" placeholder="图标" maxlength="4">
        <input class="di-time" value="${escapeHtml((item && item.time) || "")}" placeholder="时间，如 08:00 → 10:00">
      </div>
      <input class="di-title" value="${escapeHtml((item && item.title) || "")}" placeholder="事项标题">
      <textarea class="di-desc" rows="2" placeholder="描述，每行一条">${escapeHtml((item && item.desc || []).join("\n"))}</textarea>
    </div>`;
  // 左滑删除该项（删除后保存时才生效）
  setupSwipeRow(row, () => row.remove());
  wrap.appendChild(row);
}

function renderDayItems(items) {
  const wrap = $("d-items");
  wrap.innerHTML = "";
  (items || []).forEach((it) => addDayItemRow(it));
}

function collectDayForm() {
  const items = [];
  document.querySelectorAll("#d-items .di-item").forEach((row) => {
    const title = row.querySelector(".di-title").value.trim();
    if (!title) return;
    items.push({
      dot: row.querySelector(".di-dot").value.trim(),
      time: row.querySelector(".di-time").value.trim(),
      title,
      desc: row.querySelector(".di-desc").value.split("\n").map((x) => x.trim()).filter(Boolean)
    });
  });
  return {
    date: $("d-date").value.trim(),
    month: $("d-month").value.trim(),
    weekday: $("d-weekday").value.trim(),
    title: $("d-title").value.trim() || "新的一天",
    sub: $("d-sub").value.trim(),
    color: dayColor,
    tag: $("d-tag").value.trim(),
    items
  };
}

function saveDay() {
  const form = collectDayForm();
  const body = { ...form, version: data ? data.version : undefined };
  if (editingDayId) {
    const d = (data.days || []).find((x) => x.id === editingDayId);
    if (d) Object.assign(d, form);
    renderDays();
    apiPost(`/api/days/${editingDayId}`, body);
  } else {
    (data.days || (data.days = [])).push({ id: genId("d"), ...form });
    renderDays();
    apiPost("/api/days", body);
  }
  closeDayModal();
}

function delDay() {
  if (!editingDayId) return;
  confirmDialog("删除这一天？此操作不可恢复。", () => {
    data.days = (data.days || []).filter((d) => d.id !== editingDayId);
    renderDays();
    apiDelete(`/api/days/${editingDayId}`);
    closeDayModal();
  });
}

// ============================================================
// 待办渲染
// ============================================================
function todoSortKey(t) {
  const s = String(t.date || "").trim();
  if (!s) return 9999; // 无日期排最后
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // 2026-09-30
  if (m) return Number(m[2]) * 100 + Number(m[3]);
  m = s.match(/(\d{1,2})[/\-.]\s*(\d{1,2})/); // 9/25-26 / 10/1 / 9/30 & 10/3
  if (m) return Number(m[1]) * 100 + Number(m[2]);
  return 9999;
}

function renderTodos() {
  const container = $("todos-container");
  if (!container) return;
  const sorted = [...(data.todos || [])].sort(
    (a, b) => todoSortKey(a) - todoSortKey(b) || String(a.text || "").localeCompare(String(b.text || ""), "zh")
  );
  container.innerHTML = `<div class="todos-list">` + sorted.map((t) => `
    <div class="swipe-row">
      <button class="swipe-del" type="button">删除</button>
      <div class="swipe-content todo-item ${t.done ? "done" : ""}" data-id="${escapeHtml(t.id)}" title="点击编辑待办">
        <div class="checkbox" data-act="toggle-todo">✓</div>
        <div class="todo-main">
          <div class="txt">${escapeHtml(t.text)}</div>
          <div class="todo-meta">
            <span class="cat" style="background:${CAT_COLOR[t.category] || CAT_COLOR["其他"]}">${escapeHtml(t.category)}</span>
            <span class="todo-date" data-edit-date title="点击设置日期">${t.date ? escapeHtml(fmtDate(t.date)) : "＋日期"}</span>
          </div>
        </div>
      </div>
    </div>`).join("") + `</div>`;

  container.querySelectorAll(".todo-item").forEach((item) => {
    const id = item.dataset.id;
    // 勾选：只点复选框切换完成状态
    const cb = item.querySelector('[data-act="toggle-todo"]');
    if (cb) cb.addEventListener("click", (e) => {
      e.stopPropagation();
      const todo = data.todos.find((t) => t.id === id);
      if (!todo) return;
      todo.done = !todo.done;
      renderTodos();
      apiPost(`/api/todos/${id}`, { done: todo.done, version: data.version });
    });
    // 点击卡片主体：打开编辑弹窗
    item.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="toggle-todo"]')) return;
      if (e.target.closest('[data-edit-date]')) return; // 日期点击单独处理
      openTodoModal(id);
    });
    const dateEl = item.querySelector('[data-edit-date]');
    if (dateEl) dateEl.addEventListener("click", (e) => {
      e.stopPropagation();
      startTodoDateEdit(id, dateEl);
    });
  });
  // 左滑删除待办
  container.querySelectorAll(".swipe-row").forEach((row) => {
    const card = row.querySelector(".todo-item");
    setupSwipeRow(row, () => {
      const id = card.dataset.id;
      confirmDialog("删除这条待办？", () => {
        data.todos = data.todos.filter((t) => t.id !== id);
        renderTodos();
        apiDelete(`/api/todos/${id}`);
      });
    });
  });
}

// 打开待办编辑/新增弹窗（id 为空=新增）
function openTodoModal(id) {
  editingTodoId = id || null;
  const todo = id ? data.todos.find((t) => t.id === id) : null;
  editingTodoOrigDate = todo ? (todo.date || "") : "";
  const isIso = /^\d{4}-\d{2}-\d{2}$/.test(editingTodoOrigDate);
  const title = document.querySelector("#modal-todo-overlay .modal-header");
  if (title) title.textContent = todo ? "编辑待办" : "新增待办";
  $("t-text").value = todo ? (todo.text || "") : "";
  $("t-category").value = todo ? (todo.category || "其他") : "其他";
  $("t-date").value = isIso ? editingTodoOrigDate : "";
  $("t-date").placeholder = (!isIso && editingTodoOrigDate) ? `当前：${editingTodoOrigDate}` : "";
  $("modal-todo-overlay").style.display = "flex";
  setTimeout(() => $("t-text").focus(), 60);
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
      const type = sym === "฿" ? "thb" : "cny";
      listEl.innerHTML = items_.map((b) => `
        <div class="swipe-row">
          <button class="swipe-del" type="button">删除</button>
          <div class="swipe-content bill-row" data-id="${escapeHtml(b.id)}">
            <div class="br-main">
              <div class="br-item">${escapeHtml(b.item)}${b.detail ? `<span class="br-detail"> · ${escapeHtml(b.detail)}</span>` : ""}</div>
              <div class="br-nums">
                <div class="br-num"><label>支出</label><span class="editable" data-field="spend" data-act="edit-budget">${fmtMoney(b.spend, sym)}</span></div>
                <div class="br-num"><label>实收</label><span class="editable" data-field="paid" data-act="edit-budget">${fmtMoney(b.paid, sym)}</span></div>
              </div>
            </div>
          </div>
        </div>`).join("");
      // 左滑删除账单
      listEl.querySelectorAll(".swipe-row").forEach((row) => {
        const bill = row.querySelector(".bill-row");
        setupSwipeRow(row, () => {
          const id = bill.dataset.id;
          confirmDialog("删除该账单？", () => {
            const listArr = type === "thb" ? data.budgetTHB : data.budgetCNY;
            const idx = listArr.findIndex((x) => x.id === id);
            if (idx >= 0) listArr.splice(idx, 1);
            renderBudget();
            apiDelete(`/api/budget/${type}/${id}`);
          });
        });
      });
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
let editingTodoId = null;      // 待办编辑弹窗中（null=新增，有值=编辑该条）
let editingTodoOrigDate = ""; // 编辑前原始日期（非 ISO 格式如 9/25-26 无法显示在 date 输入框，保存时保留）

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
          headers: { "Content-Type": "application/json", "X-User": encodeURIComponent(getUserName()) },
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
  editingTodoId = null; // 关闭待办弹窗时重置编辑态
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
// 退税小票
// ============================================================
const RC_COLORS = ["#0F766E", "#2563EB", "#B7791F", "#D64545", "#7C3AED", "#E91E63", "#3F51B5", "#C2185B"];
function rcColor(name) {
  let h = 0;
  const str = String(name || "");
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return RC_COLORS[h % RC_COLORS.length];
}
function fmtMoney(v) {
  const n = Number(v);
  return isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "0";
}

let activeReceiptTab = "all"; // 当前选中的上传人 tab

function receiptCard(r, showUser) {
  const thumb = r.imageKey
    ? `<img class="rc-thumb" src="/api/receipts/image?key=${encodeURIComponent(r.imageKey)}" alt="小票" loading="lazy">`
    : "";
  const refundTxt = Number(r.refund) > 0 ? ` · 💸 退税 ${escapeHtml(fmtMoney(r.refund))} ฿` : "";
  const userTag = showUser
    ? `<span class="rc-user"><i style="background:${rcColor(r.user)}"></i>${escapeHtml(r.user || "匿名")}</span>`
    : "";
  return `<div class="swipe-row">
    <button class="swipe-del" type="button">删除</button>
    <div class="swipe-content rc-card" data-id="${escapeHtml(r.id)}">
      ${thumb}
      <div class="rc-main">
        <div class="rc-store">${escapeHtml(r.store) || "未填写店名"}</div>
        <div class="rc-meta">📅 ${escapeHtml(r.date || "—")} · 💰 ${escapeHtml(fmtMoney(r.amount))} ฿${refundTxt}${userTag}</div>
        ${r.note ? `<div class="rc-note">📝 ${escapeHtml(r.note)}</div>` : ""}
      </div>
      <span class="rc-actions">
        <button class="btn-icon" data-act="edit-receipt" title="编辑">✏️</button>
      </span>
    </div>
  </div>`;
}

function renderReceipts() {
  const container = $("receipts-container");
  if (!container) return;
  const list = data.receipts || [];
  if (!list.length) {
    container.innerHTML = `<div class="rc-empty">还没有退税小票，点上方「＋ 新增」拍照上传</div>`;
    return;
  }
  // 上传人 tab 列表（"全部" + 每个有票的人）
  const users = [...new Set(list.map((r) => r.user || "匿名"))];
  if (activeReceiptTab !== "all" && !users.includes(activeReceiptTab)) activeReceiptTab = "all";
  const me = getUserName() || "";
  const tabsHtml = ["all", ...users].map((u) => {
    const count = u === "all" ? list.length : list.filter((r) => (r.user || "匿名") === u).length;
    const label = u === "all" ? "全部" : u + (u === me ? "（我）" : "");
    return `<button class="rc-tab ${activeReceiptTab === u ? "sel" : ""}" data-tab="${escapeHtml(u)}">${escapeHtml(label)}<span class="rc-tab-count">${count}</span></button>`;
  }).join("");

  const filtered = activeReceiptTab === "all" ? list : list.filter((r) => (r.user || "匿名") === activeReceiptTab);
  const showUser = activeReceiptTab === "all";
  const cardsHtml = filtered.map((r) => receiptCard(r, showUser)).join("");

  container.innerHTML = `
    <div class="rc-tabs">${tabsHtml}</div>
    <div class="rc-list">${cardsHtml || `<div class="rc-empty">该成员还没有小票</div>`}</div>`;

  // tab 切换
  container.querySelectorAll(".rc-tab").forEach((t) => {
    t.addEventListener("click", () => { activeReceiptTab = t.dataset.tab; renderReceipts(); });
  });
  // 点击缩略图 → 全屏查看
  container.querySelectorAll(".rc-thumb").forEach((img) => {
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      $("lightbox-img").src = img.src;
      $("lightbox").style.display = "flex";
      lockScroll(true);
    });
  });
  // 编辑（委托）
  container.querySelectorAll('[data-act="edit-receipt"]').forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); openReceiptModal(b.closest(".rc-card").dataset.id); });
  });
  // 左滑删除小票
  container.querySelectorAll(".rc-list .swipe-row").forEach((row) => {
    const card = row.querySelector(".rc-card");
    setupSwipeRow(row, () => {
      const id = card.dataset.id;
      confirmDialog("删除这张小票？", () => {
        data.receipts = (data.receipts || []).filter((r) => r.id !== id);
        renderReceipts();
        apiDelete(`/api/receipts/${id}`);
      });
    });
  });
}

// 图片压缩：最长边 1000px，JPEG 0.65
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.65));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 上传图片：签发 URL → 直传 → 返回 key
async function uploadReceiptImage(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const res = await fetch("/api/receipts/image-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "receipt", contentType: "image/jpeg", ext: ".jpg" })
    });
    const json = await res.json();
    if (!json.url) return { key: null, error: "图片服务不可用" };
    const up = await fetch(json.url, {
      method: "PUT",
      body: blob,
      headers: { "Content-Type": "image/jpeg" }
    });
    if (!up.ok) return { key: null, error: "图片上传失败" };
    return { key: json.key, error: null };
  } catch (e) {
    return { key: null, error: "网络异常：" + e.message };
  }
}

function openReceiptModal(id) {
  editingReceiptId = id || null;
  const r = id ? (data.receipts || []).find((x) => x.id === id) : null;
  $("receipt-modal-title").textContent = r ? "编辑小票" : "新增小票";
  const myName = getUserName() || "匿名";
  const userDisp = $("r-user-display");
  if (userDisp) userDisp.textContent = r ? (r.user || myName) : myName;
  $("r-store").value = r ? (r.store || "") : "";
  $("r-amount").value = r ? (r.amount || 0) : 0;
  $("r-refund").value = r ? (r.refund || 0) : 0;
  $("r-date").value = r ? (r.date || "") : "";
  $("r-note").value = r ? (r.note || "") : "";
  receiptImageKey = r ? (r.imageKey || "") : "";
  pendingReceiptImage = null;
  $("r-image").value = "";
  // 预览：已有图显示原图
  if (receiptImageKey) {
    $("r-preview-img").src = "/api/receipts/image?key=" + encodeURIComponent(receiptImageKey);
    $("r-preview").style.display = "flex";
  } else {
    $("r-preview").style.display = "none";
  }
  $("btn-del-receipt").style.display = r ? "" : "none";
  $("modal-receipt-overlay").style.display = "flex";
}

// 页面滚动锁定：弹窗/图片查看打开时禁止背景滚动（避免输入时晃动）
function lockScroll(lock) {
  document.body.classList.toggle("modal-open", lock);
}

// lightbox 关闭
function closeLightbox() {
  $("lightbox").style.display = "none";
  lockScroll(false);
}

function closeReceiptModal() {
  $("modal-receipt-overlay").style.display = "none";
  editingReceiptId = null;
  pendingReceiptImage = null;
  receiptImageKey = "";
}

async function saveReceipt() {
  const form = {
    user: getUserName() || "匿名",
    store: $("r-store").value.trim(),
    amount: Number($("r-amount").value) || 0,
    refund: Number($("r-refund").value) || 0,
    date: $("r-date").value,
    note: $("r-note").value.trim(),
    imageKey: receiptImageKey,
    version: data ? data.version : undefined
  };
  // 新选了图片 → 先上传拿 key
  if (pendingReceiptImage) {
    setSync("offline", "上传图片中…");
    const up = await uploadReceiptImage(pendingReceiptImage);
    if (up.error) { setSync("offline", "图片上传失败"); toast("图片上传失败：" + up.error, "err"); return; }
    form.imageKey = up.key;
    receiptImageKey = up.key;
  }
  if (editingReceiptId) {
    const r = (data.receipts || []).find((x) => x.id === editingReceiptId);
    if (r) Object.assign(r, { user: form.user, store: form.store, amount: form.amount, refund: form.refund, date: form.date, note: form.note, imageKey: form.imageKey });
    renderReceipts();
    apiPost(`/api/receipts/${editingReceiptId}`, form);
  } else {
    (data.receipts || (data.receipts = [])).push({
      id: genId("r"), user: form.user, store: form.store, amount: form.amount,
      refund: form.refund, date: form.date, note: form.note, imageKey: form.imageKey, createdAt: Date.now()
    });
    renderReceipts();
    apiPost("/api/receipts", form);
  }
  closeReceiptModal();
}

// ============================================================
// API 辅助（携带版本乐观锁；409 时自动刷新）
// ============================================================
async function apiPost(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User": encodeURIComponent(getUserName()) },
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
    const res = await fetch(full, { method: "DELETE", headers: { "X-User": encodeURIComponent(getUserName()) } });
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
    const cachedNow = loadCache();
    if (cachedNow && !freshShouldWin(cachedNow, fresh)) {
      // 服务器较旧：保留本地缓存
      setSync("offline", "⚠️ 服务器数据较旧，已保留本机缓存");
      if (!data || (Number(data.version) || 0) < (Number(cachedNow.version) || 0)) {
        data = cachedNow;
        renderContent();
      }
    } else if (!data || freshKey !== curKey) {
      // 只更新内容，不重建骨架 → iframe 位置组件不闪烁、拖拽顺序不丢
      data = fresh;
      saveCache(fresh);
      renderContent();
      setSync("online", "实时同步中");
    } else {
      setSync("online", "实时同步中");
    }
  } catch (e) {
    setSync("offline", "连接中断，重试中…");
  } finally {
    polling = false;
  }
}
let pollTimer = null;
function setupPolling() {
  // fetchData 已做首次拉取，这里只起定时器；后台标签页暂停，切回再立即同步
  pollTimer = setInterval(poll, 4000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      poll();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(poll, 4000);
    }
  });
}

function setSync(state, text) {
  const el = $("sync-status");
  el.className = "sync-status " + state;
  $("sync-text").textContent = text;
}

// ============================================================
// 事件绑定
// ============================================================
// 首次进入：必须先输入全局用户名，输入后才启动应用
function showNameGate() {
  const gate = $("name-gate");
  if (!gate) { bootApp(); return; }
  gate.style.display = "flex";
  const input = $("gate-name");
  // 老版本位置共享用过的名字作为预填（可选）
  try {
    const old = localStorage.getItem("trip_myname");
    if (old) input.value = old;
  } catch (e) { /* ignore */ }
  setTimeout(() => input.focus(), 120);
  const enter = () => {
    const name = input.value.trim();
    if (!name) {
      input.classList.add("shake");
      setTimeout(() => input.classList.remove("shake"), 400);
      input.focus();
      return;
    }
    setUserName(name);
    try { localStorage.removeItem("trip_myname"); } catch (e) { /* ignore */ }
    gate.style.display = "none";
    bootApp();
  };
  $("gate-enter").addEventListener("click", enter);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); enter(); } });
}

function bootApp() {
  if (EXPORT_MODE) return; // 导出模式不启动正常应用（避免联网覆盖缓存）
  // 汇率换算：顶部按钮 → 弹窗
  $("btn-fx").addEventListener("click", () => {
    renderFx();
    $("modal-fx-overlay").style.display = "flex";
  });
  $("btn-cancel-fx").addEventListener("click", closeModal);
  $("modal-fx-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });

  // 操作日志入口：先验证管理员密码
  $("btn-log").addEventListener("click", () => {
    $("pwd-input").value = "";
    $("pwd-err").style.display = "none";
    $("modal-pwd-overlay").style.display = "flex";
    setTimeout(() => $("pwd-input").focus(), 60);
  });
  $("btn-pwd-cancel").addEventListener("click", () => { $("modal-pwd-overlay").style.display = "none"; });
  $("modal-pwd-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) $("modal-pwd-overlay").style.display = "none"; });
  $("btn-pwd-ok").addEventListener("click", async () => {
    const val = $("pwd-input").value;
    const h = await sha256hex(val);
    if (h === ADMIN_PASSWORD_HASH) {
      $("modal-pwd-overlay").style.display = "none";
      renderChangelog();
      $("modal-log-overlay").style.display = "flex";
    } else {
      $("pwd-err").style.display = "block";
      $("pwd-input").value = "";
      $("pwd-input").focus();
    }
  });
  $("pwd-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("btn-pwd-ok").click(); }
  });
  $("btn-log-close").addEventListener("click", () => { $("modal-log-overlay").style.display = "none"; });
  $("modal-log-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) $("modal-log-overlay").style.display = "none"; });

  // 航班行操作（委托）：点击任意单元格打开编辑弹窗
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".flight-card");
    if (card) {
      const id = card.dataset.id;
      const actBtn = e.target.closest("[data-act]");
      if (actBtn) {
        if (actBtn.dataset.act === "edit") openFlightModal(id);
      } else {
        openFlightModal(id);
      }
    }
  });

  // 图片查看：点击遮罩/关闭按钮关闭
  $("lightbox").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeLightbox(); });
  $("lightbox-close").addEventListener("click", closeLightbox);

  // 统一滚动锁定：监听所有弹窗的显示状态，自动锁/解锁 body 滚动
  (() => {
    const apply = () => {
      const anyOpen = [...document.querySelectorAll(".modal-overlay, #lightbox")].some((o) => o.style.display === "flex");
      lockScroll(anyOpen);
    };
    const mo = new MutationObserver(apply);
    document.querySelectorAll(".modal-overlay, #lightbox").forEach((o) => mo.observe(o, { attributes: true, attributeFilter: ["style"] }));
    apply();
  })();

  // 退税小票弹窗
  $("btn-cancel-receipt").addEventListener("click", closeReceiptModal);
  $("btn-save-receipt").addEventListener("click", saveReceipt);
  $("btn-del-receipt").addEventListener("click", () => {
    if (!editingReceiptId) return;
    confirmDialog("删除这张小票？", () => {
      data.receipts = (data.receipts || []).filter((r) => r.id !== editingReceiptId);
      renderReceipts();
      apiDelete(`/api/receipts/${editingReceiptId}`);
      closeReceiptModal();
    });
  });
  $("modal-receipt-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeReceiptModal(); });
  // 选择照片 → 压缩 → 预览
  $("r-image").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await compressImageFile(file);
      pendingReceiptImage = dataUrl;
      $("r-preview-img").src = dataUrl;
      $("r-preview").style.display = "flex";
    } catch (err) {
      toast("图片处理失败，请换一张", "err");
    }
  });
  $("r-remove-img").addEventListener("click", () => {
    pendingReceiptImage = null;
    receiptImageKey = "";
    $("r-image").value = "";
    $("r-preview").style.display = "none";
  });

  // 每日行程：编辑某天 / 新增一天（委托）
  document.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit-day]");
    if (editBtn) { openDayEditModal(editBtn.dataset.editDay); return; }
    if (e.target.closest("#day-add-row")) { openDayEditModal(null); return; }
  });

  $("btn-cancel-day").addEventListener("click", closeDayModal);
  $("btn-save-day").addEventListener("click", saveDay);
  $("btn-del-day").addEventListener("click", delDay);
  $("d-add-item").addEventListener("click", () => addDayItemRow(null));
  $("modal-day-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeDayModal(); });

  // 新增按钮（动态渲染进组件头部）→ 用事件委托，不依赖渲染时机
  document.addEventListener("click", (e) => {
    const addBtn = e.target.closest("#btn-add-flight, #btn-add-todo, #btn-add-bill, #btn-add-receipt");
    if (!addBtn) return;
    if (addBtn.id === "btn-add-flight") openNewFlightModal();
    else if (addBtn.id === "btn-add-todo") {
      openTodoModal(null);
    } else if (addBtn.id === "btn-add-bill") {
      $("b-item").value = "";
      $("b-detail").value = "";
      $("b-spend").value = 0;
      $("b-paid").value = 0;
      $("modal-bill-overlay").style.display = "flex";
    } else if (addBtn.id === "btn-add-receipt") {
      openReceiptModal(null);
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
    if (!editingFlightId) return;
    confirmDialog("删除这段航班？", () => {
      data.flights = data.flights.filter((f) => f.id !== editingFlightId);
      renderFlights();
      apiDelete(`/api/flights/${editingFlightId}`);
      closeModal();
    });
  });

  modalEnterToSave("modal-todo-overlay", "btn-save-todo");
  modalEnterToSave("modal-overlay", "btn-save-flight");
  $("btn-cancel-todo").addEventListener("click", closeModal);
  $("btn-save-todo").addEventListener("click", () => {
    const text = $("t-text").value.trim();
    const category = $("t-category").value;
    const date = $("t-date").value;
    if (!text) return;
    if (editingTodoId) {
      const todo = data.todos.find((t) => t.id === editingTodoId);
      if (todo) {
        // 非 ISO 日期（如 9/25-26）无法在 date 输入框显示：未改动时保留原日期，避免被清空
        const finalDate = date || (editingTodoOrigDate && !/^\d{4}-\d{2}-\d{2}$/.test(editingTodoOrigDate) ? editingTodoOrigDate : "");
        Object.assign(todo, { text, category, date: finalDate });
        renderTodos();
        apiPost(`/api/todos/${editingTodoId}`, { text, category, date: finalDate, version: data ? data.version : undefined });
      }
    } else {
      data.todos.push({ id: genId("t"), category, text, date, done: false });
      renderTodos();
      apiPost("/api/todos", { text, category, date, version: data ? data.version : undefined });
    }
    editingTodoId = null;
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

  fetchData().catch((e) => setSync("offline", "加载失败，请刷新"));
  setupPolling();
}

document.addEventListener("DOMContentLoaded", () => {
  if (EXPORT_MODE) return; // 导出页不显示门槛
  // 首次进入：必须先输入用户名（之后自动记住，不再弹出）
  if (!getUserName()) {
    showNameGate();
    return;
  }
  bootApp();
});
