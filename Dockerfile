# ============================================================
# Koyeb 部署用 Dockerfile
# 用法：koyeb 会读取 Dockerfile 构建镜像并运行
# ============================================================
FROM node:18-slim

WORKDIR /app

# 先复制依赖清单，利用缓存
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# 复制源码
COPY server.js ./
COPY data ./data
COPY public ./public
COPY koyeb.yaml ./

# 暴露端口（koyeb 会用 PORT 环境变量覆盖）
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
