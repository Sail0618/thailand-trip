// ============================================================
// EdgeOne Pages Functions 入口：接管全部 /api/* 请求
// 路由映射：/functions/api/[[default]].js → /api/*
// 说明：functions 目录由平台按 ESM 构建，本地测试请直接测 core.mjs
// ============================================================
import { onRequest } from "./core.mjs";

export { onRequest };
