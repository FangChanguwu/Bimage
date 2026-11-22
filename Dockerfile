FROM node:26-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:26-alpine AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/contracts ./contracts
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine
WORKDIR /app/backend
ENV NODE_ENV=production PORT=6768 DATA_DIR=/app/data BIMAGE_FRONTEND_DIR=/app/frontend/dist
COPY --from=backend-build /app/backend/package.json ./package.json
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/contracts ./contracts
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
EXPOSE 6768
CMD ["node", "dist/launcher.js"]
