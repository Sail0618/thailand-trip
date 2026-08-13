// ============================================================
// 泰国 11 日行程 · 初始数据 schema
// 由现有 HTML 行程提取，作为云数据库的初始化内容
// ============================================================

const initialData = {
  meta: {
    title: "🇹🇭 泰国 11 日完整行程",
    subtitle: "曼谷 · 芭提雅 · 清迈 · 皮皮岛 · 甲米",
    dateRange: "2026.09.24 → 10.04",
    group: "8 人团",
    note: "分享链接即可共同编辑，无需登录"
  },

  // ---------- 航班总览（核心，可在线编辑） ----------
  flights: [
    { id: "f1", date: "9/24 周四", route: "杭州 T4 → 香港 T1", dep: "19:45", arr: "22:20", flightNo: "—", bookingNo: "—", status: "已订", note: "国际段第一程" },
    { id: "f2", date: "9/25 周五", route: "香港 T1 → 曼谷 BKK", dep: "08:00", arr: "10:00", flightNo: "—", bookingNo: "—", status: "已订", note: "抵达曼谷" },
    { id: "f3", date: "9/28 周一", route: "曼谷 BKK → 清迈 CNX", dep: "12:25", arr: "13:50", flightNo: "越捷 VZ110", bookingNo: "—", status: "已订", note: "" },
    { id: "f4", date: "9/30 周三", route: "清迈 CNX → 曼谷 BKK", dep: "待定", arr: "待定", flightNo: "—", bookingNo: "—", status: "待定", note: "建议选 18:00-22:00 出发" },
    { id: "f5", date: "10/1 周四", route: "曼谷 BKK → 甲米 KBV", dep: "待定", arr: "待定", flightNo: "—", bookingNo: "—", status: "待定", note: "建议选早班机" },
    { id: "f6", date: "10/3 周六", route: "甲米 KBV → 曼谷 BKK", dep: "20:35", arr: "22:05", flightNo: "—", bookingNo: "JF87V5", status: "已订", note: "" },
    { id: "f7", date: "10/4 周日", route: "曼谷 BKK → 香港 T1", dep: "11:00", arr: "15:05", flightNo: "—", bookingNo: "—", status: "已订", note: "国际段返程" },
    { id: "f8", date: "10/4 周日", route: "香港 T1 → 杭州 T4", dep: "16:00", arr: "18:30", flightNo: "—", bookingNo: "—", status: "已订", note: "回国" }
  ],

  // ---------- 每日行程（11 天，只读参考，可后续扩展编辑） ----------
  days: [
    {
      id: "d1", date: "9/24", month: "9月", weekday: "周四",
      title: "出发日 · 杭州 → 香港", sub: "周四 · 国际段第一程", color: "#607D8B",
      tag: "✈️ 转机", items: [
        { dot: "✈", time: "19:45 → 22:20", title: "杭州萧山 T4 → 香港 T1", desc: ["北京时间出发，飞行约 2.5h", "抵达香港后机场过夜，次日早班机飞曼谷"] }
      ]
    },
    {
      id: "d2", date: "9/25", month: "9月", weekday: "周五",
      title: "抵达曼谷 · 自由活动", sub: "周五 · 曼谷第 1 天", color: "#FF9800",
      tag: "🏙️ 曼谷", items: [
        { dot: "✈", time: "08:00 → 10:00", title: "香港 T1 → 曼谷素万那普 (BKK)", desc: ["当地时间抵达，比北京时间慢 1h", "出关取行李后，可打车或 BTS 进市区"] },
        { dot: "🏨", time: "中午", title: "入住曼谷酒店（建议素坤逸/暹罗区）", desc: ["BTS 沿线方便出行，8 人建议订 2-3 间房或民宿", "明天去芭提雅，建议住靠近东站 (Ekkamai) 附近"] },
        { dot: "🎯", time: "下午 — 晚上", title: "曼谷自由活动", desc: ["暹罗商圈逛街 / Big C 采购 / 按摩放松", "晚餐：建兴酒家（咖喱蟹）或 Terminal 21 美食层"] }
      ]
    },
    {
      id: "d3", date: "9/26", month: "9月", weekday: "周六",
      title: "芭提雅 Day 1 · 海天盛筵 + 夜市", sub: "周六 · 曼谷 → 芭提雅", color: "#E91E63",
      tag: "🏖️ 芭提雅", items: [
        { dot: "🚗", time: "12:30 → 14:30", title: "曼谷 → Suksabai Villa 民宿（包车 1.5-2h）", desc: ["地址：Suksabai Villa 2 Soi 1 388/268, 芭堤雅市, 春武里 20150", "8 人包车建议提前订 Van，人均约 100-150 泰铢"] },
        { dot: "🏖", time: "15:30 → 15:40", title: "民宿 → 芭提雅海滩（打车 10min）", desc: ["打车软件：Bolt / Grab", "海滩自由活动，拍照散步"] },
        { dot: "🛥", time: "17:00 → 17:10", title: "海滩 → 海天盛筵男模餐厅（Bali Hai Pier）", desc: ["换票：提前 30 分钟到 Walking Street 交界的 Anytime Coffee 凭护照换票", "男模餐厅 18:00-19:30", "门票 328 元 / VIP 互动票 478 元（含自助餐）"] },
        { dot: "🏙", time: "20:00 → 20:30", title: "海天盛筵 → Thepprasit 夜市（打车 10min）", desc: ["夜市 17:00-23:00", "各类小吃、海鲜、水果冰沙"] },
        { dot: "🚗", time: "20:30 → 20:40", title: "夜市 → Suksabai Villa 民宿", desc: ["选去：民宿附近马杀鸡"] }
      ]
    },
    {
      id: "d4", date: "9/27", month: "9月", weekday: "周日",
      title: "芭提雅 Day 2 · 格兰岛 + 99 Show", sub: "周日 · 海岛跳岛 + 成人秀", color: "#E91E63",
      tag: "🏝️ 格兰岛", items: [
        { dot: "🏯", time: "上午（选去）", title: "真理寺（Sanctuary of Truth）", desc: ["穿着要求：不得露肩膀，短裤需过膝", "需跟随导游游览", "可早起去真理寺 10:00 回民宿集合，或直接出发格兰岛"] },
        { dot: "🚗", time: "10:00 → 10:10", title: "民宿 → Bali Hai Pier 码头", desc: ["快艇 150 泰铢/人 | 轮渡 30 泰铢/人", "售票窗口买票，只能现金！"] },
        { dot: "🏝", time: "10:10 → 10:30", title: "Bali Hai Pier → 格兰岛（快艇15min/轮渡40min）", desc: ["岛内交通：摩托车 150-300 泰铢/天，双条车 20-40 泰铢/次", "摩托车租车前车况拍照，不要押护照！", "靠左行驶，有危险性。交警可砍价至 500 泰铢", "海上项目四合一可砍到 800 泰铢", "8 人团体租 2-3 辆摩托车或包双条车"] },
        { dot: "🚢", time: "16:00 → 16:40", title: "格兰岛 → Bali Hai Pier（17:00 前到码头）", desc: ["可自行返回，注意末班船时间"] },
        { dot: "🛍", time: "17:00 → 17:30", title: "码头 → Terminal 21", desc: ["吃饭逛商场，各楼层不同国家主题"] },
        { dot: "💃", time: "19:00 → 19:10", title: "Terminal 21 → 99 Show Pattaya（步行）", desc: ["19:00 在 99 Show 门口集合", "成人秀线下票 1500 泰铢，线上购票去 20 号窗口取票（需护照）", "18:30-22:30 循环演出，中途不清场"] },
        { dot: "🚗", time: "20:30 → 21:00", title: "99 Show → Suksabai Villa 民宿", desc: ["选去：民宿附近马杀鸡"] }
      ]
    },
    {
      id: "d5", date: "9/28", month: "9月", weekday: "周一",
      title: "芭提雅 → 曼谷 → 清迈", sub: "周一 · 芭提雅最后一天 → 飞清迈", color: "#7B1FA2",
      tag: "🏘️ 清迈", items: [
        { dot: "🚗", time: "08:30 → 10:30", title: "民宿 → 素万那普机场（包车 1.5-2h）", desc: ["8:30 必须出发，航班 12:25 起飞，需提前 2h 到机场"] },
        { dot: "✈", time: "12:25 → 13:50", title: "曼谷素万那普 (BKK) → 清迈 (CNX)", desc: ["越捷航空 VZ110", "机场可吃饭购物"] },
        { dot: "🚗", time: "14:30 → 15:00", title: "清迈机场 → 52 Bann Sao Hin 民宿", desc: ["民宿简单休整", "机场打车建议用 Grab 或 Bolt，8 人分 2 辆车"] },
        { dot: "🛍", time: "15:30 → 15:50", title: "民宿 → 瓦落落市场 Warorot Market", desc: ["逛市集，购买伴手礼（芒果干、泰茶、手工艺品）"] },
        { dot: "🦐", time: "17:00 → 17:20", title: "瓦落落市场 → NEW YORK 钓虾场", desc: ["钓虾 100 泰铢/h，付费加工 70 泰铢", "旁边有商场，可吃饭"] },
        { dot: "🏙", time: "19:30 → 20:00", title: "钓虾场 → 清迈大学后门夜市", desc: ["学生夜市，22:00 关门", "价格便宜，小吃多"] },
        { dot: "🚗", time: "21:30 → 22:00", title: "夜市 → 52 Bann Sao Hin 民宿", desc: ["选去：民宿附近马杀鸡，可预约上门"] }
      ]
    },
    {
      id: "d6", date: "9/29", month: "9月", weekday: "周二",
      title: "清迈 Day 2 · 大象营 + 黏黏瀑布", sub: "周二 · 包车一日游", color: "#7B1FA2",
      tag: "🐘 清迈", items: [
        { dot: "🚗", time: "上午出发", title: "民宿 → Doodoi 大象营（包车 1.5h）", desc: ["包车 8h 2300 泰铢，超时 200 泰铢/h，行程结束后付款", "Doodoi 大象营地 1300 泰铢/人（1.5-2h）", "8 人包一辆 Van，分摊约 288 泰铢/人"] },
        { dot: "💦", time: "下午", title: "大象营 → Bua Tong 黏黏瀑布", desc: ["不要踩深色石头（比较滑），攀爬时抓紧绳索", "穿溯溪鞋，泳衣/速干衣/短袖短裤", "浅色部分石面有矿物质附着不滑"] },
        { dot: "🏰", time: "选去", title: "蓝庙 Wat Ban Den", desc: ["穿着要求：不得露肩膀，短裤需过膝", "门口有卖长裤、披肩 20 元/件"] },
        { dot: "🚗", time: "傍晚", title: "瀑布 → 民宿", desc: ["选去：大象便便造纸公园 150 泰铢/人", "选去：Elelycafy 有很多狗", "选去：民宿附近马杀鸡"] }
      ]
    },
    {
      id: "d7", date: "9/30", month: "9月", weekday: "周三",
      title: "清迈 Day 3 · 厨艺课/射击 + 飞曼谷", sub: "周三 · 清迈最后一天", color: "#7B1FA2",
      tag: "🧑‍🍳 清迈", items: [
        { dot: "🧑‍🍳", time: "08:20 → 14:00", title: "Zabbelee 厨艺课（学校接送）", desc: ["1200 泰铢×6 人（做饭）+ 600 泰铢×2 人（陪同）÷ 8 = 1050 泰铢/人", "含接送 + 午餐", "此项目选去，不去则自行安排"] },
        { dot: "🎯", time: "下午（选去）", title: "射击场", desc: ["此项目选去，不去则自行安排"] },
        { dot: "✈", time: "晚上（建议 18:00-22:00）", title: "清迈 CNX → 曼谷 BKK（待定航班）", desc: ["尚未订票！建议选 18:00-22:00 出发", "到曼谷后需住素万那普机场附近酒店（推荐 Grand Palazzo）", "次日早班机飞甲米"] }
      ]
    },
    {
      id: "d8", date: "10/1", month: "10月", weekday: "周四",
      title: "皮皮岛 Day 1 · 前往海岛度假", sub: "周四 · 曼谷 → 甲米 → 皮皮岛", color: "#00BCD4",
      tag: "🏝️ 皮皮岛", items: [
        { dot: "✈", time: "上午（建议早班机）", title: "曼谷 BKK → 甲米 KBV（待定航班）", desc: ["尚未订票！建议选早班机，下午有时间上岛", "飞行约 1h20min"] },
        { dot: "🚗🚢", time: "上午 — 下午", title: "甲米机场 → 科龙吉拉德码头 → 通塞码头", desc: ["机场 → 码头打车约 30-40min", "码头 → 皮皮岛坐船约 1.5-2h", "8 人建议提前预订船票+接送套餐（Klook/KKday）"] },
        { dot: "🏠", time: "下午", title: "入住皮皮岛酒店", desc: ["两晚住皮皮岛，主打度假出片", "8 人建议订 3-4 间房，选通塞码头附近"] },
        { dot: "🏖", time: "下午", title: "沙滩度假 + 长尾船出海", desc: ["坐长尾船去沙滩、浮潜、拍照", "选皮皮北或长滩路线，避免重复", "长尾船包船约 2000 泰铢/3h（2-6 人），拼船 300 泰铢/人", "8 人正好包 1-2 艘长尾船"] },
        { dot: "🔥", time: "晚上", title: "海边酒吧烟火秀", desc: ["Freedom Bar，无低消", "19:30 烟火秀，早去挑好位置"] }
      ]
    },
    {
      id: "d9", date: "10/2", month: "10月", weekday: "周五",
      title: "皮皮岛 Day 2 · 海盗船出海", sub: "周五 · 小皮皮岛路线", color: "#00BCD4",
      tag: "🏴‍☠️ 海盗船", items: [
        { dot: "☕", time: "上午", title: "皮皮岛上逛逛，吃早餐", desc: ["通塞码头附近早餐店、咖啡店", "准备好防晒、浮潜装备"] },
        { dot: "🏴‍☠️", time: "11:30 登船", title: "通塞码头 Relax Bar 登海盗船", desc: ["11:30 准时登船，不要迟到！", "路线：猴子→维京洞穴→玛雅沙滩→皮划艇→浮潜→钟乳石洞穴→落日 Party", "提前在 Klook/KKday 预订海盗船票，含午餐和浮潜装备"] },
        { dot: "🌅", time: "19:00", title: "海盗船返回通塞码头", desc: ["在皮皮岛吃晚餐", "饭后可以去酒吧玩玩", "最后一个完整夜晚，享受海岛氛围"] }
      ]
    },
    {
      id: "d10", date: "10/3", month: "10月", weekday: "周六",
      title: "皮皮岛 Day 3 · 休闲游 + 返曼谷", sub: "周六 · 皮皮岛 → 甲米 → 曼谷", color: "#00BCD4",
      tag: "✈️ 返程", items: [
        { dot: "☀", time: "上午", title: "起床收拾行李，吃饭", desc: ["最后享受一下海岛早晨", "退房，寄存行李"] },
        { dot: "🚢🚗✈", time: "下午", title: "皮皮岛 → 甲米机场 → 曼谷", desc: ["方案 A（推荐）：通塞码头→坐船回甲米 Klong Jirad 码头(约1.5h)→打车去甲米机场(约30min)→20:35 飞曼谷", "预计路上总耗时约 3h，建议 15:00 前从皮皮岛出发", "方案 B：改走普吉路线，需退改 JF87V5 机票"] },
        { dot: "✈", time: "20:35 → 22:05", title: "甲米 KBV → 曼谷 BKK（预订号 JF87V5）", desc: ["飞行 1h30min", "到曼谷后住素万那普机场附近酒店（推荐 Grand Palazzo）"] }
      ]
    },
    {
      id: "d11", date: "10/4", month: "10月", weekday: "周日",
      title: "回国日 · 曼谷 → 香港 → 杭州", sub: "周日 · 行程结束 🎉", color: "#607D8B",
      tag: "🏠 返程", items: [
        { dot: "✈", time: "11:00 → 15:05", title: "曼谷 BKK → 香港 T1", desc: ["当地时间出发", "飞行约 3h"] },
        { dot: "✈", time: "16:00 → 18:30", title: "香港 T1 → 杭州萧山 T4", desc: ["北京时间到达", "到家！行程圆满结束"] }
      ]
    }
  ],

  // ---------- 待办事项（可在线勾选） ----------
  todos: [
    { id: "t1", category: "机票", text: "9/30 清迈→曼谷 订票（建议18-22点）", done: false },
    { id: "t2", category: "机票", text: "10/1 曼谷→甲米 订票（建议早班机）", done: false },
    { id: "t3", category: "船票", text: "10/1 甲米→皮皮岛 船票+接送", done: false },
    { id: "t4", category: "船票", text: "10/2 海盗船（务必提前订）", done: false },
    { id: "t5", category: "船票", text: "10/3 皮皮岛→甲米 返程船票", done: false },
    { id: "t6", category: "住宿", text: "曼谷 9/25-26（2晚）", done: false },
    { id: "t7", category: "住宿", text: "芭提雅 Suksabai Villa 9/26-28", done: false },
    { id: "t8", category: "住宿", text: "清迈 52 Bann Sao Hin 9/28-30", done: false },
    { id: "t9", category: "住宿", text: "曼谷机场酒店 9/30 & 10/3", done: false },
    { id: "t10", category: "住宿", text: "皮皮岛酒店 10/1-3（2晚）", done: false },
    { id: "t11", category: "活动", text: "海天盛筵男模餐厅（线上购票）", done: false },
    { id: "t12", category: "活动", text: "99 Show Pattaya（线上购票）", done: false },
    { id: "t13", category: "活动", text: "Doodoi 大象营（提前预约）", done: false },
    { id: "t14", category: "活动", text: "Zabbelee 厨艺课（提前预约）", done: false }
  ],

  // ---------- 实际账单（¥ 人民币 / ฿ 泰铢） ----------
  // ¥ 人民币为实际录入账单；฿ 泰铢暂空（如需记录泰铢花销再填入）
  budget: [
    { id: "b1", item: "🏨 芭提雅 2 晚住宿", detail: "", spendCNY: 3107.28, paidCNY: 3107.28, spendTHB: 0, paidTHB: 0 },
    { id: "b2", item: "🏨 清迈 2 晚住宿",   detail: "", spendCNY: 2850.05, paidCNY: 4075.08, spendTHB: 0, paidTHB: 0 },
    { id: "b3", item: "⛵ 海盗船定金",       detail: "", spendCNY: 484,     paidCNY: 484,     spendTHB: 0, paidTHB: 0 }
  ],

  // 警告/冲突提示（已移除）
  alert: null,

  lastUpdated: null
};

module.exports = { initialData };
