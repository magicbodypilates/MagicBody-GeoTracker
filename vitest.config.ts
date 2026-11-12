import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * 결제 통계 정규화 순수함수 단위 테스트용 vitest 설정 (경량).
 * 계획 geotracker-payment-stats-v3 §S5 ① — route transform/auth 순수함수 + week 재집계 helper.
 * tsconfig 의 "@/*" → 프로젝트 루트 별칭을 재현.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
      // server-only 는 서버 환경 표시가 없으면 오류를 던진다. 시험(node)에서는 빈 모듈로 대체.
      "server-only": resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
  },
});
