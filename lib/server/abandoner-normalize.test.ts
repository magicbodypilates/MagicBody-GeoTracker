/**
 * abandoner-normalize.test.ts — 이탈자 정규화 순수함수 회귀 테스트
 *   task_id: magicbody-abandoner-view-2026-07-17 (plan-v2 §4-5)
 *
 * 핵심 회귀(K5): **.NET 이 email 컬럼을 추가해도 응답에 안 나온다.**
 *   화이트리스트 픽을 누가 스프레드(`...row`)로 바꾸면 이 테스트가 깨진다.
 *
 * ⚠️ SQL fixture 통합 테스트는 여기 없다(plan-v2 H7 — 로컬이 운영 DB 를 그대로 봐서 fixture 환경이 없다).
 *    쿼리 정확성은 게이트 G1·G3·G7·G8(운영 DB 읽기 전용 실행)이 담당한다.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeSnapshot,
  normalizeList,
  normalizeHealth,
  ABANDONER_BUCKETS,
  ABANDONER_STEPS,
  ABANDONER_SIDE_METRICS,
} from "./abandoner-normalize";

describe("normalizeList — PII 화이트리스트", () => {
  it(".NET 이 새 식별자 컬럼을 추가해도 응답에 새지 않는다 (스프레드 금지 회귀)", () => {
    const raw = {
      items: [
        {
          useruid: "u-1",
          name: "홍길동",
          phone: "01012345678",
          signupAtKst: "2026-07-01",
          firstViewAt: "2026-07-10T01:00:00.000Z",
          lastViewAt: "2026-07-12T02:00:00.000Z",
          viewCount: 3,
          bucket: "B3",
          consent: true,
          contentsId: "be34274b-cca4-4",
          title: "재활 정규과정",
          // ↓ 미래에 .NET DTO 가 실수로 추가할 수 있는 식별자들
          email: "leak@example.com",
          socno: "900101",
          client_ip: "1.2.3.4",
          session_id: "sess-abc",
          send_token: "tok-xyz",
          attr_token: "attr-xyz",
        },
      ],
      truncated: false,
      limit: 500,
      asOfUtc: "2026-07-17T03:00:00.000Z",
    };

    const out = normalizeList(raw as never, { segment: "B3", consentOnly: false });
    const row = out.rows[0];
    const serialized = JSON.stringify(out);

    // 의도된 노출 (사장님 2026-07-17 결정)
    expect(row.name).toBe("홍길동");
    expect(row.phone).toBe("01012345678");

    // 절대 새면 안 되는 것들 — 키로도, 값으로도 없어야 한다.
    for (const k of ["email", "socno", "client_ip", "session_id", "send_token", "attr_token", "useruid"]) {
      expect(Object.hasOwn(row as object, k)).toBe(false);
    }
    for (const v of ["leak@example.com", "900101", "1.2.3.4", "sess-abc", "tok-xyz", "attr-xyz"]) {
      expect(serialized).not.toContain(v);
    }
    // useruid 는 .NET 이 G3 대조용으로 내려주지만 브라우저까지 내보내지 않는다.
    expect(serialized).not.toContain("u-1");
  });

  it("버킷 어휘가 아닌 행은 버린다 (표 오염 방지)", () => {
    const raw = {
      items: [
        { name: "A", bucket: "B1" },
        { name: "B", bucket: "ZZZ" },
        { name: "C", bucket: null },
        { name: "D", bucket: "b2" }, // 대소문자는 정규화해 살린다
      ],
    };
    const out = normalizeList(raw as never, { segment: "B1", consentOnly: false });
    expect(out.rows.map((r) => r.name)).toEqual(["A", "D"]);
    expect(out.rows[1].bucket).toBe("B2");
  });

  it("빈·비정상 입력에도 터지지 않는다", () => {
    for (const raw of [null, undefined, {}, { items: null }, { items: "nope" }]) {
      const out = normalizeList(raw as never, { segment: "B1", consentOnly: true });
      expect(out.rows).toEqual([]);
      expect(out.view).toBe("list");
      expect(out.consentOnly).toBe(true);
    }
  });

  it("형식 불량 시각은 빈 문자열 — 잘못된 날짜를 화면에 그리지 않는다", () => {
    const raw = { items: [{ name: "A", bucket: "B1", firstViewAt: "not-a-date", lastViewAt: null }] };
    const out = normalizeList(raw as never, { segment: "B1", consentOnly: false });
    expect(out.rows[0].firstViewAt).toBe("");
    expect(out.rows[0].lastViewAt).toBe("");
  });

  it("음수·NaN 횟수는 0 으로 clamp", () => {
    const raw = { items: [{ name: "A", bucket: "B1", viewCount: -5 }] };
    const out = normalizeList(raw as never, { segment: "B1", consentOnly: false });
    expect(out.rows[0].viewCount).toBe(0);
  });

  it("consent 는 엄격 boolean — truthy 문자열에 속지 않는다", () => {
    const raw = { items: [{ name: "A", bucket: "B1", consent: "true" }] };
    const out = normalizeList(raw as never, { segment: "B1", consentOnly: false });
    expect(out.rows[0].consent).toBe(false);
  });
});

describe("normalizeSnapshot", () => {
  it("버킷·진단 화이트리스트 + 진단 표준 순서 정렬", () => {
    const raw = {
      asOfUtc: "2026-07-17T03:00:00.000Z",
      buckets: [
        { contentsId: "c1", title: "정규", bucket: "B1", total: 10, sendable: 5 },
        { contentsId: "c1", title: "정규", bucket: "NOPE", total: 99, sendable: 99 },
      ],
      a0: [{ contentsId: "c1", title: "정규", total: 3, sendable: 1 }],
      diagnostics: [
        { step: "bucketed", people: 4 },
        { step: "viewedIdentified", people: 10 },
        { step: "unknownStep", people: 1 },
      ],
    };
    const out = normalizeSnapshot(raw as never);
    expect(out.buckets).toHaveLength(1);
    expect(out.buckets[0].bucket).toBe("B1");
    expect(out.a0[0].total).toBe(3);
    // 사다리는 순서가 의미다 — .NET UNION ALL 순서에 의존하지 않는다.
    expect(out.diagnostics.map((d) => d.step)).toEqual(["viewedIdentified", "bucketed"]);
  });

  it("빈 입력에도 안전한 기본 구조를 준다", () => {
    const out = normalizeSnapshot(null);
    expect(out.buckets).toEqual([]);
    expect(out.a0).toEqual([]);
    expect(out.diagnostics).toEqual([]);
    expect(out.health.verdict).toBe("idle");
    // 5개 scope 가 항상 0 으로 존재 — UI 가 undefined 를 만나지 않는다.
    expect(out.peopleTotals.A0).toEqual({ total: 0, sendable: 0 });
    expect(out.peopleTotals.B4).toEqual({ total: 0, sendable: 0 });
    expect(out.sideMetrics).toEqual({ consent: 0, checkoutOnly: 0 });
  });
});

/*
 * HIGH-1·M-2 회귀 — "N명"은 과정별 행의 합이 아니라 서버가 준 실인원이어야 한다.
 *   원래 결함: 한 회원이 과정 3개를 보면 a0 가 세 행이 되고, UI 가 그걸 더해 헤드라인에 3명이라고 적었다.
 */
describe("normalizeSnapshot — 실인원(peopleTotals)은 과정별 합과 다르다", () => {
  it("과정별 행을 더한 값이 아니라 서버가 준 scope 실인원을 그대로 싣는다", () => {
    const raw = {
      // 같은 회원 1명이 과정 2개를 본 상황 — 과정별로는 1+1=2 행이지만 실인원은 1명이다.
      a0: [
        { contentsId: "c1", title: "정규", total: 1, sendable: 1 },
        { contentsId: "c2", title: "골프", total: 1, sendable: 1 },
      ],
      buckets: [
        { contentsId: "c1", title: "정규", bucket: "B4", total: 1, sendable: 0 },
        { contentsId: "c2", title: "골프", bucket: "B4", total: 1, sendable: 0 },
      ],
      peopleTotals: [
        { scope: "A0", total: 1, sendable: 1 },
        { scope: "B4", total: 1, sendable: 0 },
      ],
    };
    const out = normalizeSnapshot(raw as never);

    // 과정별 행의 합(=2)에 속으면 안 된다.
    const naiveA0Sum = out.a0.reduce((s, r) => s + r.total, 0);
    const naiveB4Sum = out.buckets.reduce((s, r) => s + r.total, 0);
    expect(naiveA0Sum).toBe(2);
    expect(naiveB4Sum).toBe(2);

    expect(out.peopleTotals.A0).toEqual({ total: 1, sendable: 1 });
    expect(out.peopleTotals.B4).toEqual({ total: 1, sendable: 0 });
  });

  it("서버가 안 보낸 scope 는 0 · 어휘 밖 scope 는 버린다", () => {
    const raw = { peopleTotals: [{ scope: "B1", total: 7, sendable: 3 }, { scope: "NOPE", total: 99 }] };
    const out = normalizeSnapshot(raw as never);
    expect(out.peopleTotals.B1).toEqual({ total: 7, sendable: 3 });
    expect(out.peopleTotals.B2).toEqual({ total: 0, sendable: 0 });
    expect(Object.keys(out.peopleTotals).sort()).toEqual([...ABANDONER_BUCKETS].sort());
  });
});

/*
 * M-1 회귀 — 사다리(단조)와 별도 지표를 갈라 담는다.
 *   원래 결함: consent 가 사다리 한가운데 있는데 아랫줄(unpaid·bucketed)은 수신동의를 안 걸어
 *   "동의 54명 → 미결제 95명"처럼 아래가 더 큰 표가 나왔다.
 */
describe("normalizeSnapshot — 사다리와 별도 지표 분리 (M-1)", () => {
  it("consent·checkoutOnly 는 사다리에서 빠지고 sideMetrics 로 간다", () => {
    const raw = {
      diagnostics: [
        { step: "viewedIdentified", people: 100 },
        { step: "userJoined", people: 100 },
        { step: "consent", people: 54 },
        { step: "unpaid", people: 95 },
        { step: "bucketed", people: 95 },
        { step: "checkoutOnly", people: 8 },
      ],
    };
    const out = normalizeSnapshot(raw as never);

    expect(out.diagnostics.map((d) => d.step)).toEqual(["viewedIdentified", "userJoined", "unpaid", "bucketed"]);
    expect(out.sideMetrics).toEqual({ consent: 54, checkoutOnly: 8 });

    // 사다리는 단조 감소여야 한다 — consent(54)가 섞였다면 unpaid(95)에서 다시 커져 깨진다.
    const people = out.diagnostics.map((d) => d.people);
    for (let i = 1; i < people.length; i++) expect(people[i]).toBeLessThanOrEqual(people[i - 1]);
  });

  it("두 어휘는 겹치지 않는다 (한 값이 사다리와 지표에 동시에 들어가지 않게)", () => {
    const overlap = (ABANDONER_STEPS as readonly string[]).filter((s) =>
      (ABANDONER_SIDE_METRICS as readonly string[]).includes(s),
    );
    expect(overlap).toEqual([]);
  });
});

describe("normalizeHealth — 판정 (자기 기준선 대비)", () => {
  it("조회 자체가 없으면 idle — 고장이 아니다", () => {
    expect(normalizeHealth({ views24h: 0, identified24h: 0 }).verdict).toBe("idle");
  });

  it("조회는 있는데 식별이 0 이면 check", () => {
    expect(normalizeHealth({ views24h: 100, identified24h: 0 }).verdict).toBe("check");
  });

  it("식별률이 기준선의 1/3 미만 + 표본 30 이상이면 check", () => {
    const h = normalizeHealth({
      views24h: 100,
      identified24h: 5, // 5%
      viewsBaseline: 700,
      identifiedBaseline: 420, // 60% → 1/3 = 20%
    });
    expect(h.verdict).toBe("check");
  });

  it("표본이 30 미만이면 비율이 낮아도 판정하지 않는다 (우연 배제)", () => {
    const h = normalizeHealth({
      views24h: 10,
      identified24h: 1,
      viewsBaseline: 700,
      identifiedBaseline: 420,
    });
    expect(h.verdict).toBe("ok");
  });

  it("기준선과 비슷하면 ok", () => {
    const h = normalizeHealth({
      views24h: 100,
      identified24h: 55,
      viewsBaseline: 700,
      identifiedBaseline: 420,
    });
    expect(h.verdict).toBe("ok");
    expect(h.rate24h).toBeCloseTo(0.55);
    expect(h.rateBaseline).toBeCloseTo(0.6);
  });

  it("분모가 0 이면 비율은 null — 0 으로 만들면 고장처럼 보인다", () => {
    const h = normalizeHealth({ views24h: 0, identified24h: 0, viewsBaseline: 0, identifiedBaseline: 0 });
    expect(h.rate24h).toBeNull();
    expect(h.rateBaseline).toBeNull();
  });
});

describe("어휘 SoT", () => {
  it("버킷 어휘는 .NET 분류 CASE 와 1:1 이다", () => {
    expect([...ABANDONER_BUCKETS]).toEqual(["A0", "B1", "B2", "B3", "B4"]);
  });

  it("사다리 어휘·순서는 .NET diagSql 과 1:1 이고 밑변이 같은 네 줄만 들어간다", () => {
    expect([...ABANDONER_STEPS]).toEqual(["viewedIdentified", "userJoined", "unpaid", "bucketed"]);
  });

  it("별도 지표 어휘는 .NET diagSql 과 1:1 이다", () => {
    expect([...ABANDONER_SIDE_METRICS]).toEqual(["consent", "checkoutOnly"]);
  });
});

/*
 * ⭐ 2026-07-21 추가 (reviewer M-4) — 비용이 매우 낮은데 회귀 보호가 없던 세 분기.
 *   셋 다 "화면이 없는 고장을 신고하게 만드는" 경로라, 조용히 깨지면 사장님이 그 신고를 하시게 된다.
 */
describe("normalizeSnapshot — a0PathsPresent 는 '필드 부재'와 '빈 배열'을 가른다", () => {
  it("필드 자체가 없으면 false — 화면이 경로 패널과 합 경고를 아예 그리지 않는다", () => {
    // 구버전 .NET(미배포) 상황. 0 으로 채운 기본값 때문에 "합(0) ≠ 전체(N)" 경고가 뜨면
    // 아무 문제도 없는데 고장으로 읽힌다.
    const s = normalizeSnapshot({ peopleTotals: [{ scope: "A0", total: 3, sendable: 2 }] });
    expect(s.a0PathsPresent).toBe(false);
    expect(s.a0Paths.identified).toEqual({ total: 0, sendable: 0 });
  });

  it("빈 배열이면 true — 서버가 '경로가 하나도 없다'고 말한 것이라 화면이 그려야 한다", () => {
    const s = normalizeSnapshot({ a0Paths: [] });
    expect(s.a0PathsPresent).toBe(true);
  });

  it("값이 있으면 true 이고 화이트리스트 밖 경로는 버린다(합이 어긋나 화면이 경고한다)", () => {
    const s = normalizeSnapshot({
      a0Paths: [
        { path: "identified", total: 2, sendable: 1 },
        { path: "unknown", total: 5, sendable: 5 },
      ],
    });
    expect(s.a0PathsPresent).toBe(true);
    expect(s.a0Paths.identified).toEqual({ total: 2, sendable: 1 });
    expect(s.a0Paths.signupHistory).toEqual({ total: 0, sendable: 0 });
  });
});

describe("normalizeSnapshot — 커버리지 비율은 분모가 0 이면 null", () => {
  it("crossCheckRate: 표본 0 이면 null (0 으로 만들면 '정합률 0% = 고장'처럼 보인다)", () => {
    const s = normalizeSnapshot({
      signupCoverage: { crossCheckBase30d: 0, crossCheckMatch30d: 0 },
    });
    expect(s.signupCoverage.crossCheckRate).toBeNull();
    expect(s.signupCoverage.crossCheckOverRate).toBeNull();
  });

  it("표본이 있으면 비율을 계산한다(④ 정합률 · ⑤ 초과 주장률)", () => {
    const s = normalizeSnapshot({
      signupCoverage: { crossCheckBase30d: 4, crossCheckMatch30d: 3, crossCheckOver30d: 1 },
    });
    expect(s.signupCoverage.crossCheckRate).toBeCloseTo(0.75);
    expect(s.signupCoverage.crossCheckOverRate).toBeCloseTo(0.25);
  });

  it("byProviderPresent: 사업자 칸이 없으면 false — '네이버 0건 = 고장' 오독을 막는다", () => {
    const s = normalizeSnapshot({ signupCoverage: { newMembers30d: 10 } });
    expect(s.signupCoverage.byProviderPresent).toBe(false);
    expect(s.signupCoverage.byProvider.naver.signups30d).toBe(0);
  });

  it("byProviderPresent: 한쪽만 와도 true 이고 비율이 계산된다", () => {
    const s = normalizeSnapshot({
      signupCoverage: {
        kakaoSignups30d: 4,
        kakaoWithHistory30d: 2,
        kakaoCrossCheckBase30d: 2,
        kakaoCrossCheckMatch30d: 1,
        naverSignups30d: 0,
      },
    });
    expect(s.signupCoverage.byProviderPresent).toBe(true);
    expect(s.signupCoverage.byProvider.kakao.historyRate).toBeCloseTo(0.5);
    expect(s.signupCoverage.byProvider.kakao.crossCheckRate).toBeCloseTo(0.5);
    expect(s.signupCoverage.byProvider.naver.historyRate).toBeNull();
  });
});

describe("normalizeSnapshot — 화이트리스트 밖 진단 단계는 버린다", () => {
  it("모르는 step 은 사다리에도 별도 지표에도 안 들어간다(합 불일치로 드러난다)", () => {
    const s = normalizeSnapshot({
      diagnostics: [
        { step: "unpaid", people: 5 },
        { step: "somethingNew", people: 99 },
        { step: "consent", people: 3 },
      ],
    });
    expect(s.diagnostics.map((d) => d.step)).toEqual(["unpaid"]);
    expect(s.sideMetrics).toEqual({ consent: 3, checkoutOnly: 0 });
  });
});
