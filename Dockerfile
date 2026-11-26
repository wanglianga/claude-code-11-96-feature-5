# 多阶段构建：Node 编译静态资源，Nginx 提供 SPA 服务
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# 国内镜像源加速依赖安装；如在境外网络构建可删除此行
RUN npm config set registry https://registry.npmmirror.com && npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
