/**
 * brightdata-notready.test.ts — Bright Data not-ready placeholder 감지 순수함수 단위 테스트.
 *
 * `isNotReadyPayload` 가 placeholder(예: `{message:"Dataset is not ready yet, try again in 30s"}`)를
 * 정상 답변과 구별하는지 검증한다(외부 의존 없음, mock 불필요).
 *
 * 오탐 방지(R2)가 최우선 — 진짜 답변이 있으면(string·object·array 어느 형태든)
 * 본문에 "try again"·"not ready" 가 들어 있어도 false 여야 한다.
 */

import { describe, it, expect } from "vitest";
import { isNotReadyPayload } from "@/lib/server/brightdata-scraper";

describe("isNotReadyPayload — 긍정(true): 답변 필드 전무 + not-ready 패턴", () => {
  it("Bright Data 대표 fixture — Dataset is not ready (답변 필드 전무 전제)", () => {
    expect(
      isNotReadyPayload({ message: "Dataset is not ready yet, try again in 30s" }),
    ).toBe(true);
  });

  it("warning: still building (답변 필드 전무 전제)", () => {
    expect(isNotReadyPayload({ warning: "still building" })).toBe(true);
  });

  it("status: queued — 단일 상태 payload (답변 필드 전무 전제)", () => {
    // 전제: 답변 후보 키가 전무하고 상태성 키만 있는 placeholder.
    expect(isNotReadyPayload({ status: "queued" })).toBe(true);
  });

  it("패턴 변형 — processing / not completed / snapshot not ready / dataset is empty", () => {
    expect(isNotReadyPayload({ status: "processing" })).toBe(true);
    expect(isNotReadyPayload({ message: "job not completed" })).toBe(true);
    expect(isNotReadyPayload({ detail: "snapshot not ready" })).toBe(true);
    expect(isNotReadyPayload({ error: "dataset is empty" })).toBe(true);
  });

  it("배열 payload — 첫 record 만 평가(단일 record 계약)", () => {
    expect(
      isNotReadyPayload([{ message: "not ready, try again later" }]),
    ).toBe(true);
  });

  it("output:[''] 빈 문자열만 담은 array 답변 후보는 '답변 없음' — message not-ready 면 true (M2 false-negative 보강)", () => {
    // length>0 만 보던 과거엔 빈 문자열 array 가 답변으로 오인돼 not-ready 를 놓쳤다.
    expect(
      isNotReadyPayload({ output: [""], message: "Dataset is not ready yet" }),
    ).toBe(true);
  });

  it("output:['  '] 공백만 담은 array 답변 후보도 '답변 없음' — message try again 이면 true (M2 false-negative 보강)", () => {
    expect(
      isNotReadyPayload({ output: ["  "], message: "still building, try again" }),
    ).toBe(true);
  });
});

describe("isNotReadyPayload — 오탐(false, R2 핵심): 답변이 존재하면 not-ready 아님", () => {
  it("답변 string 이 'try again' 을 포함해도 false", () => {
    expect(
      isNotReadyPayload({ answer_text: "다시 시도해보세요(try again)..." }),
    ).toBe(false);
  });

  it("답변 string 이 있고 message 가 not-ready 패턴이어도 false", () => {
    // status 텍스트와 무관 — 답변이 있으면 not-ready 아님.
    expect(
      isNotReadyPayload({ answer: "정상 답변입니다.", message: "still building" }),
    ).toBe(false);
  });

  it("답변이 object(구조화)이고 status=running 이어도 false (M1 — object 타입)", () => {
    expect(
      isNotReadyPayload({ output: { sections: ["a", "b"] }, status: "running" }),
    ).toBe(false);
  });

  it("답변이 array 이고 status=running 이어도 false (M1 — array 타입)", () => {
    expect(
      isNotReadyPayload({ content: ["문단1", "문단2"], status: "running" }),
    ).toBe(false);
  });

  it("실제 답변이 담긴 array + message not-ready 여도 false (M2 회귀 — 진짜 답변 보호)", () => {
    // 빈 문자열 조이기가 진짜 답변까지 not-ready 로 오판하지 않는지 회귀 보장.
    expect(
      isNotReadyPayload({ output: ["실제 답변"], message: "Dataset is not ready yet" }),
    ).toBe(false);
  });
});

describe("isNotReadyPayload — 경계(false)", () => {
  it("빈 객체는 false (답변 없음 + 상태 패턴 없음 → 파싱 실패 별도 경로 처리)", () => {
    expect(isNotReadyPayload({})).toBe(false);
  });

  it("빈 배열은 false", () => {
    expect(isNotReadyPayload([])).toBe(false);
  });

  it("null·undefined·non-object 는 false", () => {
    expect(isNotReadyPayload(null)).toBe(false);
    expect(isNotReadyPayload(undefined)).toBe(false);
    expect(isNotReadyPayload("문자열")).toBe(false);
    expect(isNotReadyPayload(42)).toBe(false);
  });

  it("답변 없음 + not-ready 패턴 아닌 정상 안내 message 는 false", () => {
    expect(isNotReadyPayload({ message: "정상 안내 메시지" })).toBe(false);
  });

  it("빈 문자열 답변 + 상태 패턴 없으면 false", () => {
    // 답변 필드가 빈 문자열이면 '답변 없음'이지만 상태 패턴도 없으므로 not-ready 아님.
    expect(isNotReadyPayload({ answer_text: "   ", note: "ok" })).toBe(false);
  });

  it("빈 object 답변 후보는 '답변 없음'으로 취급 — 상태 패턴 있으면 true", () => {
    // output:{} 는 비어있어 답변으로 안 침. status 패턴 충족 → true.
    expect(isNotReadyPayload({ output: {}, status: "pending" })).toBe(true);
  });
});
