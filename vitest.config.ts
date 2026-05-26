import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * 결제 통계 정규화 순수함수 단위 테스트용 vitest 설정 (경량).
 * 계획 geotracker-payment-stats-v3 §S5 ① — route transform/auth 순수함수 + week 재집계 helper.
 * tsconfig 의 "@/*" → 프로젝트 루트 별칭을 재현.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
  },
});
