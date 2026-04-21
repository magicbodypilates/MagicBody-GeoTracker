# syntax=docker/dockerfile:1.7

# ---- 1단계: deps (의존성 설치) ----
FROM node:20-alpine AS deps
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---- 2단계: builder (Next.js 빌드) ----
FROM node:20-alpine AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* 변수는 빌드 시점에 클라이언트 번들에 박혀야 하므로 ARG로 받아 ENV로 노출.
# Firebase Web API key 등은 공개값이지만, 여기서 기본값을 두면 빌드 인자 없이도 빌드는 가능.
ARG NEXT_PUBLIC_FIREBASE_API_KEY=""
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="classnaom.firebaseapp.com"
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID="classnaom"
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="classnaom.appspot.com"
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=""
ARG NEXT_PUBLIC_FIREBASE_APP_ID=""
ARG NEXT_PUBLIC_CMS_LOGIN_URL="https://cms.magicbodypilates.co.kr/Account/Login"

ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_PUBLIC_CMS_LOGIN_URL=$NEXT_PUBLIC_CMS_LOGIN_URL

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ---- 3단계: runner (프로덕션 실행) ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Phase 5A — 마이그레이션 파일 + 실행 스크립트
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
# postgres 드라이버를 standalone node_modules 에 포함 (마이그레이션 스크립트가 require)
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/postgres ./node_modules/postgres
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
