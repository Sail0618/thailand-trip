// ============================================================
// 生成 EdgeOne Pages Functions 用的初始数据模块（ESM）
// 用法：node scripts/gen-edgeone-initial.js
// 输出：functions/api/initial-data.mjs
// ============================================================
const fs = require("fs");
const path = require("path");
const { initialData } = require("../data/schema.js");

const out = path.join(__dirname, "..", "functions", "api", "initial-data.mjs");
const json = JSON.stringify(initialData, null, 2);
const src =
  "// ============================================================\n" +
  "// 由 scripts/gen-edgeone-initial.js 自动生成，请勿手动编辑。\n" +
  "// 数据源：data/schema.js 的 initialData\n" +
  "// ============================================================\n" +
  "export const initialData = " + json + ";\n";

fs.writeFileSync(out, src, "utf8");
console.log("✅ 已生成 " + out + "（" + src.length + " 字节）");
