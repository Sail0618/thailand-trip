# 🇹🇭 泰国 11 日行程 · 在线共享编辑应用

把原 HTML 静态行程改造成一个**Web 应用**，8 人团的朋友通过分享链接即可实时共同编辑航班、待办、预算。无需登录，拿到链接就能改。

## ✨ 功能

| 功能 | 说明 |
|---|---|
| **✈️ 航班总览**（核心） | 在线编辑日期/航线/时间/航班号/预订号/状态，实时同步 |
| **🗓️ 每日行程** | 11 天行程卡片，按主题色区分，可折叠展开 |
| **⏳ 待办事项** | 多人共享勾选，新增/删除任务 |
| **💰 预算估算** | 金额单元格点击即可修改，自动汇总（¥ / ฿ 独立两表） |
| **📍 位置共享** | 高德地图实时显示团友位置（每 15s 更新，超 10 分钟自动过期） |
| **🔄 实时同步** | 前端 4s 轮询 + 服务端读缓存，一个朋友改动，其他人页面自动刷新 |

## 🛠 技术栈

- **后端**：Node.js + Express
- **存储**：云 JSONBin.io（生产，跨设备共享）+ 本地文件 `data/store.json` 自动回退
- **前端**：原生 HTML / CSS / JS，零依赖

## 🚀 本地运行

```bash
cd thailand-trip
npm install
node server.js
```

启动后访问 http://localhost:8080 ，把 URL 发给朋友即可（在同一个局域网下）。

> 本地模式下数据自动写入 `data/store.json`，重启不丢。未配置 JSONBin Key 时保存接口若失败会明确返回错误（不会再静默丢失）。

## ☁️ 部署到免费托管平台（推荐）

由于免费托管平台（Railway、Render 等）的本地文件是临时性的，重启会丢失，所以生产环境需要配置 **JSONBin.io**（免费云 JSON 数据库）。

### 1. 注册 JSONBin（免费）

1. 打开 https://jsonbin.io ，免费注册一个账号
2. 进入 **API Keys** 页面，新建一个 Master Key 并复制（形如 `$2b$10$xxxxxxx...`）

### 2. 部署到 Render（推荐，免费）

1. 把项目推送到 GitHub 仓库
2. 打开 https://render.com ，用 GitHub 登录
3. 点 **New + → Web Service**
4. 选择你的仓库
5. 配置：
   - **Build Command**：`npm install`
   - **Start Command**：`node server.js`
   - **Instance Type**：Free
6. 在 **Environment Variables** 添加（不要手动设置 `PORT`，Render 会自动注入）：
   - `JSONBIN_API_KEY` = 你的 Master Key
   - `JSONBIN_PRIVATE` = `false`（公开 bin，方便直接读）
7. 点 **Create Web Service**
8. 部署完成后，Render 会给你一个形如 `https://xxx.onrender.com` 的 URL，**把链接发给朋友即可**

> **重要**：首次启动时，应用会自动在 JSONBin 创建一个 bin 并固定其 ID。建议把该 ID 填到环境变量 `JSONBIN_BIN_ID`（避免每次启动都新建一个空 bin，也避免多实例各建各的导致数据分散）。可通过 `GET /api/health` 查看当前 bin ID。

### 3. 部署到 Railway

1. 打开 https://railway.app
2. **New Project → Deploy from GitHub repo**
3. 选择仓库，Railway 自动识别 Node.js
4. 点进 **Variables** 添加：
   - `JSONBIN_API_KEY` = 你的 Master Key
   - `JSONBIN_PRIVATE` = `false`
   - `PORT` Railway 会自动设置
5. 部署完成，复制 Railway 给的域名发给朋友

### 4. 部署到 Vercel（serverless）

已内置 `vercel.json` 适配。注意：Vercel 文件系统只读，**必须配置 `JSONBIN_API_KEY`**，否则保存会报错。

## 📁 项目结构

```
thailand-trip/
├── server.js           # Express 后端 + REST API + 本地/云双存储
├── package.json        # 依赖
├── data/
│   ├── schema.js       # 初始行程数据
│   ├── store.json      # 本地持久化（自动生成，已 gitignore）
│   └── BIN_ID.txt      # （旧版云模式遗留，已不再使用）
└── public/
    ├── index.html      # 前端界面
    ├── style.css       # 样式（沿用原 HTML 主题色）
    ├── app.js          # 渲染 + 编辑 + 轮询同步
    ├── location.html   # 位置共享页（iframe 内嵌）
    ├── location.js     # 高德地图位置共享逻辑
    └── config.js       # 高德地图 Key 配置
```

## 🔌 API 接口

| Method | URL | 说明 |
|---|---|---|
| GET | `/api/data` | 获取全量数据（带读缓存） |
| PUT | `/api/data` | 覆盖式更新（带乐观锁） |
| GET | `/api/flights` | 获取航班列表 |
| POST | `/api/flights/:id` | 更新单个航班 |
| POST | `/api/flights` | 新增航班 |
| DELETE | `/api/flights/:id` | 删除航班 |
| GET | `/api/todos` | 获取待办列表 |
| POST | `/api/todos/:id` | 更新待办（done/text/category） |
| POST | `/api/todos` | 新增待办 |
| DELETE | `/api/todos/:id` | 删除待办 |
| GET | `/api/budget/:type` | 获取预算列表（type = cny / thb） |
| POST | `/api/budget/:type/:id` | 更新预算项 |
| POST | `/api/budget/:type` | 新增预算项 |
| DELETE | `/api/budget/:type/:id` | 删除预算项（只删当前币种） |
| POST | `/api/fx` | 更新汇率（1 元 = rate 泰铢，团内共享） |
| GET | `/api/fx/live` | 获取实时汇率（open.er-api.com，免费无需 Key） |
| POST | `/api/fx/refresh` | 抓取实时汇率并应用 |
| GET | `/api/status-options` | 航班状态选项 |
| GET/POST/DELETE | `/api/locations` | 位置共享（上报/删除/获取，自动清理过期） |
| GET | `/api/health` | 健康检查 |

### 汇率自动更新

- 服务端启动 3 秒后自动抓取一次实时汇率（1 元 = ? 泰铢，来源 open.er-api.com，免费无需 Key），之后**每 6 小时**自动更新
- 前端汇率组件提供 **↻ 刷新**按钮可随时手动抓取并应用
- 抓取失败时自动沿用上次的汇率（不报错、不影响使用），汇率仍可手动修改

### 并发与冲突

所有**写接口**都支持乐观锁：请求中携带当前 `version`（POST 放 body，DELETE 放 `?version=`）。若服务器数据已被他人更新，接口返回 `409`，前端会自动刷新并提示"数据已更新"。因此多人同时编辑时，后保存者不会静默覆盖先保存者的改动。

## 💡 使用建议

- 把链接发给 8 位团友，告诉他们"点任意地方就能改"
- 9/30 和 10/1 的待定航班，有人订票后立即更新状态
- 待办事项勾选后，所有人都会看到
- 实际花销变化后，预算表的数字单元格直接点击改；删除账单只影响当前币种（¥ 或 ฿）

享受旅程！🎉
