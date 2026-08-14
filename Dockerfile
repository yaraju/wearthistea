FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat

# 1. Install dependencies only when needed
FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN npm ci --include=optional

# 2. Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client and build Next.js
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# 3. Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Manually copy native dependencies that Next.js tracer might miss
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@img ./node_modules/@img
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@imgly ./node_modules/@imgly
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node

USER nextjs

EXPOSE 8080

ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
