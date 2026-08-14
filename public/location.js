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
let myName = localStorage.getItem("trip_myname") || "";
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
    return `<div class="member-card">
      <span class="dot" style="background:${escapeHtml(loc.color) || "#0D7D6B"}"></span>
      <div class="mc-main">
        <div class="mc-name">${escapeHtml(loc.name)}${me}<span class="mc-time">${escapeHtml(fmtUpdated(loc.updatedAt))}</span></div>
        <div class="mc-addr">${addrTxt}</div>
      </div>
    </div>`;
  });
  el.innerHTML = rows.join("");
}

// ============================================================
// 共享控制
// ============================================================
function startSharing() {
  myName = $("my-name").value.trim();
  if (!myName) {
    alert("请先输入你的名字");
    $("my-name").focus();
    return;
  }
  if (!("geolocation" in navigator)) {
    alert("你的浏览器不支持定位功能");
    return;
  }
  localStorage.setItem("trip_myname", myName);
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
  // 恢复上次名字
  if (myName) $("my-name").value = myName;
  $("btn-toggle").addEventListener("click", () => {
    if (sharing) stopSharing();
    else startSharing();
  });
  // 页面离开时停止（避免后台继续请求）
  window.addEventListener("beforeunload", () => { if (sharing) stopSharing(); });

  initMap();
  // 地图就绪后先拉一次成员
  setTimeout(refreshMembers, 2500);

  // === 自动开始：如果浏览器已授权定位 且 记住了名字，进入即自动共享 ===
  autoStartIfPermitted();
});

// 检查浏览器定位授权状态，已授权则自动开始共享
async function autoStartIfPermitted() {
  // 没有记住名字则不自动开始（仍需用户输入名字）
  if (!localStorage.getItem("trip_myname")) return;

  try {
    // 查询定位权限状态
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: "geolocation" });
      if (status.state === "granted") {
        // 已授权 → 自动开始共享（地图就绪后）
        waitForMapThenStart();
      } else {
        $("loc-status").textContent = '请点"开始共享位置"授权定位';
      }
      // 监听权限变化：用户授权时自动开始
      status.onchange = () => {
        if (status.state === "granted" && !sharing) waitForMapThenStart();
      };
    } else {
      // 浏览器不支持 permissions API，尝试直接开始
      waitForMapThenStart();
    }
  } catch (e) {
    // permissions API 不支持，走手动
    $("loc-status").textContent = '请点"开始共享位置"';
  }
}

// 等待地图初始化完成后再自动开始共享
function waitForMapThenStart() {
  let attempts = 0;
  const MAX_WAIT = 15; // 最多等 15 次（约 12 秒），地图还没就绪就放弃自动开始
  const tryStart = () => {
    if (sharing) return;
    // 名字从 localStorage 恢复
    const saved = localStorage.getItem("trip_myname");
    if (!saved) return;
    $("my-name").value = saved;
    // 如果地图还没就绪，等待（带超时，避免地图加载失败时无限循环）
    if (!map) {
      attempts++;
      if (attempts > MAX_WAIT) {
        $("loc-status").textContent = '地图未就绪，请手动点"开始共享位置"';
        return;
      }
      setTimeout(tryStart, 800);
      return;
    }
    startSharing();
  };
  tryStart();
}
