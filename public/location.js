// ============================================================
// 泰国行程 · 实时位置共享（高德地图）
// - 输入名字 → 授权定位 → 定时(15s)上传位置
// - 高德地图显示所有共享成员的位置点
// - 每 15s 拉取一次全员位置，实时刷新
// - 成员名字/颜色渲染前 HTML 转义（防 XSS）
// ============================================================

const AMAP_KEY = (window.AMAP_CONFIG && window.AMAP_CONFIG.key) || "AMAP_KEY_PLACEHOLDER";
const AMAP_SECURITY = (window.AMAP_CONFIG && window.AMAP_CONFIG.securityCode) || "AMAP_SECURITY_CODE";

let map = null;
let markers = {};           // 高德 Marker 集合 { id: marker }
let myId = null;            // 当前用户 id
let myName = localStorage.getItem("trip_user_name") || "";
let myColor = null;
let sharing = false;
let shareInterval = null;   // 上传定时器
let refreshInterval = null; // 拉取定时器
let watcherId = null;       // 浏览器定位 watcher
let lastPos = null;

// HTML 转义：名字/颜色等用户可写字段插入 innerHTML 前必须经过
function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// 预定义颜色（按序号分配）
const COLORS = ["#E85D4E", "#0D7D6B", "#1976D2", "#8E24AA", "#F57C00", "#43A047", "#C2185B", "#6D4C41"];

const $ = (id) => document.getElementById(id);

// ============================================================
// 高德地图初始化
// ============================================================
function loadAmap() {
  return new Promise((resolve, reject) => {
    if (window.AMap) return resolve();
    if (AMAP_KEY.startsWith("AMAP_KEY")) {
      reject(new Error("NO_KEY"));
      return;
    }
    window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY };
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(AMAP_KEY)}`;
    script.onload = () => {
      // 等待 AMap 就绪
      if (window.AMap) resolve();
      else setTimeout(() => window.AMap ? resolve() : reject(new Error("AMap 未加载")), 3000);
    };
    script.onerror = () => reject(new Error("高德脚本加载失败"));
    document.head.appendChild(script);
  });
}

async function initMap() {
  try {
    await loadAmap();
    map = new AMap.Map("map", {
      zoom: 11,
      center: [100.5, 13.75], // 泰国中部，可被实时定位覆盖
      viewMode: "2D"
    });
    // 定位到我的位置
    if (lastPos) {
      map.setCenter([lastPos.lng, lastPos.lat]);
      map.setZoom(14);
    }
    setMapReady(true);
  } catch (e) {
    if (e.message === "NO_KEY") {
      showMapError("未配置高德地图 Key。请在 config.js 里填入你的高德 JS API Key。");
    } else {
      showMapError("地图加载失败：" + e.message);
    }
  }
}

function showMapError(msg) {
  $("map").innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-l)">
    <p style="font-size:1.2em;margin-bottom:10px">🗺️ 无法加载地图</p>
    <p style="font-size:.9em;line-height:1.8">${escapeHtml(msg)}</p>
    <p style="font-size:.8em;margin-top:16px;color:#888">配置方法见 public/config.js 文件</p>
  </div>`;
}

function setMapReady(ready) {
  $("loc-status").textContent = ready ? "地图就绪" : "未开始共享";
  $("loc-status").className = "loc-status " + (ready ? "on" : "off");
}

// ============================================================
// 位置上报
// ============================================================
async function uploadPosition() {
  if (!lastPos) return;
  try {
    const res = await fetch("/api/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: myId,
        name: myName,
        lat: lastPos.lat,
        lng: lastPos.lng,
        accuracy: lastPos.accuracy,
        color: myColor
      })
    });
    if (res.ok) refreshMembers();
  } catch (e) { /* 忽略 */ }
}

// ============================================================
// 拉取全员位置并渲染
// ============================================================
async function refreshMembers() {
  if (!map) return;
  try {
    const res = await fetch("/api/locations", { cache: "no-store" });
    if (!res.ok) return;
    const list = await res.json();
    renderMarkers(list);
    renderMemberList(list);
  } catch (e) { /* 忽略 */ }
}

function renderMarkers(list) {
  const seen = new Set();
  list.forEach((loc, i) => {
    seen.add(loc.id);
    const pos = [loc.lng, loc.lat];
    if (markers[loc.id]) {
      markers[loc.id].setPosition(pos);
    } else {
      // 创建自定义样式 marker（圆点 + 名字）
      const content = document.createElement("div");
      content.style.cssText = `
        display:flex;align-items:center;gap:4px;background:rgba(255,255,255,.95);
        padding:3px 8px;border-radius:20px;border:2px solid ${escapeHtml(loc.color) || "#0D7D6B"};
        font-size:12px;font-weight:600;color:#333;box-shadow:0 1px 4px rgba(0,0,0,.3);white-space:nowrap`;
      content.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:${escapeHtml(loc.color) || "#0D7D6B"};display:inline-block"></span>${escapeHtml(loc.name)}`;
      const marker = new AMap.Marker({ position: pos, content, offset: new AMap.Pixel(-40, -18) });
      marker.setMap(map);
      markers[loc.id] = marker;
      // 我的位置标记，用不同样式并自动适配地图
      if (loc.id === myId) {
        const myContent = document.createElement("div");
        myContent.style.cssText = `
          display:flex;align-items:center;gap:4px;background:#0D7D6B;color:#fff;
          padding:4px 10px;border-radius:20px;border:2px solid #fff;
          font-size:13px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.4);white-space:nowrap`;
        myContent.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:#fff;display:inline-block"></span>我 (${escapeHtml(loc.name)})`;
        marker.setContent(myContent);
        map.setCenter(pos);
      }
    }
  });
  // 移除已不存在的成员
  Object.keys(markers).forEach((id) => {
    if (!seen.has(id)) {
      markers[id].setMap(null);
      delete markers[id];
    }
  });
}

// 更新时间：相对时间 + 具体时分
function fmtUpdated(ts) {
  const diff = Date.now() - (ts || Date.now());
  const mins = Math.round(diff / 60000);
  let rel;
  if (mins <= 1) rel = "刚刚";
  else if (mins < 60) rel = mins + " 分钟前";
  else rel = Math.floor(mins / 60) + " 小时前";
  let clock = "";
  try {
    clock = new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch (e) { /* ignore */ }
  return clock ? rel + " · " + clock : rel;
}

// 复制位置到剪贴板（带降级方案）+ 轻提示
function showToast(msg) {
  const t = $("loc-toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 1600);
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-999px;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    showToast("✅ 位置已复制");
    return true;
  } catch (e) {
    showToast("复制失败，请长按选择");
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

async function copyLocation(btn) {
  const text = btn.dataset.copy || "";
  if (!text) return;
  let ok = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      ok = fallbackCopy(text);
    }
  } else {
    ok = fallbackCopy(text);
  }
  if (ok) {
    btn.classList.add("copied");
    btn.textContent = "已复制";
    setTimeout(() => { btn.classList.remove("copied"); btn.textContent = "复制"; }, 1200);
  }
}

// ============ 拉起地图 APP ============
let navLoc = null;

// WGS-84 → GCJ-02（国内地图加密坐标；境外坐标高德/腾讯不加密，直接用 WGS-84）
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0, ee = 0.00669342162296594323;
  const dLat = transformLat(lng - 105.0, lat - 35.0);
  const dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dl = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  const dn = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dl, lng: lng + dn };
}
function transformLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}
function transformLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}
// 中国境内转 GCJ-02，境外（如泰国）用 WGS-84
// 判断：基本中国框（含南海 lat 3+）再排除东南亚（泰国/老挝/柬埔寨/越南大部）
function toLocalCoord(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  const inBasic = lat > 3 && lat < 54 && lng > 73 && lng < 136;
  if (!inBasic) return { lat, lng };
  const isSEAsia = lat < 21 && lng > 97 && lng < 108; // 泰国/老挝/柬埔寨/越南大部
  if (isSEAsia) return { lat, lng };
  const g = wgs84ToGcj02(lat, lng);
  return { lat: g.lat, lng: g.lng };
}

function buildMapLinks(loc) {
  const c = toLocalCoord(loc.lat, loc.lng);
  const lat = c.lat.toFixed(6), lng = c.lng.toFixed(6);
  const name = encodeURIComponent(loc.name || "位置");
  return [
    { app: "高德地图", logo: "/img/maps/gaode.jpg", url: `https://uri.amap.com/marker?position=${lng},${lat}&name=${name}` },
    { app: "苹果地图", logo: "/img/maps/apple.jpg", url: `http://maps.apple.com/?ll=${lat},${lng}&q=${name}` },
    { app: "百度地图", logo: "/img/maps/baidu.jpg", url: `https://api.map.baidu.com/marker?location=${lat},${lng}&title=${name}&output=html&coord_type=wgs84` },
    { app: "Google 地图", logo: "/img/maps/google.png", url: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` }
  ];
}

function openMapSheet(loc) {
  navLoc = loc;
  $("ms-name").textContent = loc.name || "";
  $("ms-list").innerHTML = buildMapLinks(loc).map((m) =>
    `<a class="map-sheet-item" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">` +
      `<img class="map-logo" src="${escapeHtml(m.logo)}" alt="${escapeHtml(m.app)}" loading="lazy">` +
      `<span>${escapeHtml(m.app)}</span>` +
    `</a>`
  ).join("");
  $("map-sheet").style.display = "flex";
}
function closeMapSheet() {
  $("map-sheet").style.display = "none";
  navLoc = null;
}

function renderMemberList(list) {
  const el = $("member-list");
  if (!list.length) {
    el.innerHTML = `<p class="loc-empty">暂无共享位置的成员。让大家打开本页面并点"开始共享位置"。</p>`;
    return;
  }
  // 最新更新的排前面
  const sorted = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const rows = sorted.map((loc) => {
    const me = loc.id === myId ? "（我）" : "";
    const addrTxt = loc.address
      ? `📍 ${escapeHtml(loc.address)}`
      : `<span class="mc-addr-unknown">地址解析中…</span>`;
    const copyVal = loc.address
      ? `${loc.name}：${loc.address}`
      : `${loc.name}：${Number(loc.lat).toFixed(6)}, ${Number(loc.lng).toFixed(6)}`;
    return `<div class="member-card">
      <span class="dot" style="background:${escapeHtml(loc.color) || "#0D7D6B"}"></span>
      <div class="mc-main">
        <div class="mc-name">${escapeHtml(loc.name)}${me}<span class="mc-time">${escapeHtml(fmtUpdated(loc.updatedAt))}</span></div>
        <div class="mc-addr">${addrTxt}</div>
      </div>
      <span class="mc-btns">
        <button class="mc-nav" data-nav="${escapeHtml(loc.id)}" title="用地图打开" aria-label="用地图打开">导航</button>
        <button class="mc-copy" data-copy="${escapeHtml(copyVal)}" title="复制位置" aria-label="复制位置">复制</button>
      </span>
    </div>`;
  });
  el.innerHTML = rows.join("");
  // 复制按钮（委托）
  el.querySelectorAll(".mc-copy").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyLocation(btn);
    });
  });
  // 导航按钮（委托）
  el.querySelectorAll(".mc-nav").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const loc = list.find((x) => x.id === btn.dataset.nav);
      if (loc) openMapSheet(loc);
    });
  });
}

// ============================================================
// 共享控制
// ============================================================
function startSharing() {
  myName = localStorage.getItem("trip_user_name") || "";
  if (!myName) {
    $("loc-status").textContent = "请先在主页输入用户名";
    $("loc-status").className = "loc-status off";
    return;
  }
  if (!("geolocation" in navigator)) {
    alert("你的浏览器不支持定位功能");
    return;
  }
  // 分配颜色（按名字 hash 稳定分配）
  let h = 0;
  for (let i = 0; i < myName.length; i++) h = (h * 31 + myName.charCodeAt(i)) >>> 0;
  myColor = COLORS[h % COLORS.length];
  // 生成并持久化我的 id（刷新/换页保持同一 id，避免同名人互相覆盖位置）
  myId = getOrCreateMyId(myName);

  sharing = true;
  $("btn-toggle").textContent = "■ 停止共享";
  $("btn-toggle").className = "btn btn-stop";
  $("loc-status").textContent = "共享中";
  $("loc-status").className = "loc-status on";

  // 持续监听定位（页面前台时更新）
  watcherId = navigator.geolocation.watchPosition(
    (pos) => {
      lastPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      uploadPosition();
      if (map) map.setCenter([lastPos.lng, lastPos.lat]);
    },
    (err) => {
      console.error("定位失败:", err);
      $("loc-status").textContent = "定位失败，请开启定位权限";
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );

  // 定时上报（兜底，watchPosition 回调不稳定时）
  shareInterval = setInterval(uploadPosition, 15000);
  // 定时拉取全员
  refreshInterval = setInterval(refreshMembers, 15000);
}

// 生成并持久化用户 id：优先复用已保存的；否则按名字生成唯一 id
function getOrCreateMyId(name) {
  const saved = localStorage.getItem("trip_myid");
  if (saved) return saved;
  const safe = name.replace(/\s+/g, "_").slice(0, 30);
  const id = "user_" + safe + "_" + Math.random().toString(36).slice(2, 8);
  localStorage.setItem("trip_myid", id);
  return id;
}

function stopSharing() {
  sharing = false;
  if (watcherId !== null) navigator.geolocation.clearWatch(watcherId);
  if (shareInterval) clearInterval(shareInterval);
  if (refreshInterval) clearInterval(refreshInterval);
  watcherId = null; shareInterval = null; refreshInterval = null;

  // 移除我的标记
  if (myId && markers[myId]) { markers[myId].setMap(null); delete markers[myId]; }
  // 从服务器删除我的位置
  if (myId) {
    fetch("/api/locations/" + myId, { method: "DELETE" }).catch(() => {});
  }
  $("btn-toggle").textContent = "▶ 开始共享位置";
  $("btn-toggle").className = "btn btn-start";
  $("loc-status").textContent = "已停止共享";
  $("loc-status").className = "loc-status off";
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  // 显示全局用户名
  const nameLabel = $("my-name-label");
  if (nameLabel) nameLabel.textContent = myName || "未设置";
  // 地图 APP 选择面板：取消 + 点击遮罩关闭
  $("ms-cancel").addEventListener("click", closeMapSheet);
  $("map-sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeMapSheet(); });

  $("btn-toggle").addEventListener("click", () => {
    if (sharing) stopSharing();
    else startSharing();
  });
  // 页面离开时停止（避免后台继续请求）
  window.addEventListener("beforeunload", () => { if (sharing) stopSharing(); });

  initMap();
  // 地图就绪后先拉一次成员
  setTimeout(refreshMembers, 2500);

  // === 打开页面默认自动开始共享（无需点击） ===
  autoStartSharing();
});

// 默认自动开始：使用主页输入的全局用户名，地图就绪后直接开始
function autoStartSharing() {
  if (!myName) {
    $("loc-status").textContent = "请先在主页输入用户名";
    $("loc-status").className = "loc-status off";
    return;
  }
  waitForMapThenStart();
}

// 等待地图初始化完成后再自动开始共享
function waitForMapThenStart() {
  let attempts = 0;
  const MAX_WAIT = 15; // 最多等 15 次（约 12 秒），地图还没就绪就放弃自动开始
  const tryStart = () => {
    if (sharing) return;
    // 如果地图还没就绪，等待（带超时，避免地图加载失败时无限循环）
    if (!map) {
      attempts++;
      if (attempts > MAX_WAIT) {
        $("loc-status").textContent = '地图未就绪，请点"开始共享位置"重试';
        return;
      }
      setTimeout(tryStart, 800);
      return;
    }
    startSharing();
  };
  tryStart();
}
