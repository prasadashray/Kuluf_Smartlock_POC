# Build context: repository root.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json
RUN npm ci --workspace dashboard
COPY dashboard dashboard
RUN npm run build --workspace dashboard

FROM nginx:1.27-alpine
COPY dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dashboard/dist /usr/share/nginx/html
