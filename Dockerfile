FROM node:26-alpine AS build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/contracts ./contracts
RUN npm run build && npm prune --omit=dev
FROM node:26-alpine
WORKDIR /app/backend
ENV NODE_ENV=production PORT=6768 DATA_DIR=/app/data
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/contracts ./contracts
EXPOSE 6768
CMD ["node", "dist/index.js"]
