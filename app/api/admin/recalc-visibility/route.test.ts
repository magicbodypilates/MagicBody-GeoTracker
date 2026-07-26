/**
 * route.test.ts — /api/admin/recalc-visibility 백필 route 실행 경로 계약 테스트.
 *
 * 배경(reviewer M-1): 순수함수(resolveBackfillScore·visibilityPhaseLevel·calcVisibility)는
 *   40케이스로 green 이지만 route 자체(selector·keyset·CAS·preflight·dry-run)는 자동 테스트 0건이었다.
 *   이 파일이 그 실행 경로를 실제 DB 없이 덮는다.
 *
 * 검증 방식(저장소 컨벤션 = route.test.ts 모듈 모킹):
 *   - @/lib/server/db      : in-memory fake db + fake schema(컬럼 토큰). 실제 postgres·drizzle 미사용.
 *   - drizzle-orm          : and/eq/gt/gte/lte/asc/sql 등을 "술어 서술자(predicate descriptor)"로
 *                            바꿔, fake db 가 조건을 실제로 평가(selector·keyset 검증 가능).
 *   - @/lib/server/auth-guard : getSession 주입 + requireAdmin 순수 재현(401/403/null).
 *   - 나머지(calcVisibility·resolveBackfillScore·visibilityPhaseLevel·toKstDateKey·buildBrandTerms·
 *     citation-utils)는 실제 함수 그대로 → 경계일 예상 점수를 §3 배점표(=calcVisibility)로 self-check.
 *
 * 덮는 항목(계획 §7 Hard Gate / reviewer M-1):
 *   (a) dry-run 은 DB write 를 안 함
 *   (b) selector = score_version=8 AND created_at≥FROZEN 만 선택(07-14 이전·다른 버전 미선택)
 *   (c) keyset 커서가 anomaly row 도 전진
 *   (d) CAS(WHERE score_version=8)로 중복/동시 실행 시 이중 적용 안 됨(멱등)
 *   (e) 전량 anomaly batch 에서 stalled 오탐 없음(nextCursor 전진 기준)
 *   (f) preflight 가 v8 외 버전 분포 있을 때 clean=false(중단 게이트)
 *   + 경계일(07-13/14/16/18/20) 표본 dry-run 점수가 배점표와 일치, 07-14 이전 표본 불변.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ── in-memory fake db + drizzle 술어 서술자 (hoisted: vi.mock 팩토리보다 먼저 존재) ──
const H = vi.hoisted(() => {
  const store: { runs: Record<string, unknown>[]; workspaces: Record<string, unknown>[] } = {
    runs: [],
    workspaces: [],
  };
  const conflictIds = new Set<string>(); // 동시 버전 bump 시뮬레이션(선택된 뒤 CAS 실패)

  const isDate = (v: unknown): v is Date => v instanceof Date;
  const norm = (v: unknown) => (isDate(v) ? v.getTime() : v);
  const cmp = (a: unknown, b: unknown): number => {
    const av = norm(a) as number | string;
    const bv = norm(b) as number | string;
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  };
  const nameOf = (c: { name?: string } | undefined) => c?.name;

  type Pred = { __pred?: true; __sql?: true; op?: string; [k: string]: unknown };
  const match = (row: Record<string, unknown>, pred: Pred | undefined): boolean => {
    if (!pred) return true;
    if (pred.__sql) return true; // 해석하지 않는 sql 조건은 match-all(테스트는 eq 경로만 사용)
    const col = pred.col as { name?: string } | undefined;
    const val = pred.val;
    switch (pred.op) {
      case "and":
        return (pred.preds as Pred[]).every((p) => match(row, p));
      case "or":
        return (pred.preds as Pred[]).some((p) => match(row, p));
      case "not":
        return !match(row, pred.pred as Pred);
      case "eq":
        return cmp(row[nameOf(col)!], val) === 0;
      case "ne":
        return cmp(row[nameOf(col)!], val) !== 0;
      case "gt":
        return cmp(row[nameOf(col)!], val) > 0;
      case "gte":
        return cmp(row[nameOf(col)!], val) >= 0;
      case "lt":
        return cmp(row[nameOf(col)!], val) < 0;
      case "lte":
        return cmp(row[nameOf(col)!], val) <= 0;
      case "inArray":
        return (pred.vals as unknown[]).some((v) => cmp(row[nameOf(col)!], v) === 0);
      case "isNull":
        return row[nameOf(col)!] == null;
      case "ilike": {
        const hay = String(row[nameOf(col)!] ?? "").toLowerCase();
        const needle = String(val).toLowerCase().replace(/%/g, "");
        return hay.includes(needle);
      }
      default:
        return true;
    }
  };

  type Proj = Record<string, { __col?: true; __sql?: true; name?: string }>;
  const projectRow = (row: Record<string, unknown>, proj: Proj, aggCount = 0) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(proj)) {
      if (v && v.__sql) out[k] = aggCount;
      else if (v && v.__col) out[k] = row[v.name!];
      else out[k] = undefined;
    }
    return out;
  };

  type Order = { col: { name?: string }; dir: "asc" | "desc" };
  const runSelect = (
    proj: Proj,
    table: { __table: string },
    where: Pred | undefined,
    order: Order | null,
    groupCol: { name?: string } | null,
    limit: number | undefined,
  ) => {
    let rows = store[table.__table as "runs" | "workspaces"].filter((r) => match(r, where));
    const hasAgg = Object.values(proj).some((v) => v && v.__sql);

    if (groupCol) {
      const gname = groupCol.name!;
      const groups = new Map<unknown, Record<string, unknown>[]>();
      for (const r of rows) {
        const key = r[gname];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      let result = [...groups.values()].map((grp) => projectRow(grp[0], proj, grp.length));
      if (order) {
        const oname = order.col.name!;
        result = result.sort((a, b) => cmp(a[oname], b[oname]) * (order.dir === "desc" ? -1 : 1));
      }
      return result;
    }

    if (hasAgg) {
      return [projectRow(rows[0] ?? {}, proj, rows.length)];
    }

    if (order) {
      const oname = order.col.name!;
      rows = [...rows].sort((a, b) => cmp(a[oname], b[oname]) * (order.dir === "desc" ? -1 : 1));
    }
    if (typeof limit === "number") rows = rows.slice(0, limit);
    return rows.map((r) => projectRow(r, proj));
  };

  const selectBuilder = (proj: Proj) => {
    const st: {
      table: { __table: string } | null;
      where: Pred | undefined;
      order: Order | null;
      groupCol: { name?: string } | null;
      limit: number | undefined;
    } = { table: null, where: undefined, order: null, groupCol: null, limit: undefined };
    const api = {
      from(t: { __table: string }) {
        st.table = t;
        return api;
      },
      where(w: Pred) {
        st.where = w;
        return api;
      },
      groupBy(c: { name?: string }) {
        st.groupCol = c;
        return api;
      },
      orderBy(o: Order) {
        st.order = o;
        return api;
      },
      limit(n: number) {
        st.limit = n;
        return api;
      },
      then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
        try {
          res(runSelect(proj, st.table!, st.where, st.order, st.groupCol, st.limit));
        } catch (e) {
          if (rej) rej(e);
          else throw e;
        }
      },
    };
    return api;
  };

  const updateBuilder = (table: { __table: string }) => {
    const st: { vals: Record<string, unknown> | null; where: Pred | undefined; ret: Proj | null } = {
      vals: null,
      where: undefined,
      ret: null,
    };
    const api = {
      set(v: Record<string, unknown>) {
        st.vals = v;
        return api;
      },
      where(w: Pred) {
        st.where = w;
        return api;
      },
      returning(proj: Proj) {
        st.ret = proj;
        return api;
      },
      then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
        try {
          const rows = store[table.__table as "runs" | "workspaces"];
          // conflictIds = 선택 이후 다른 writer 가 v9 로 bump 한 상황 → CAS(WHERE v8) 실패 재현.
          const matched = rows.filter((r) => match(r, st.where) && !conflictIds.has(r.id as string));
          for (const r of matched) Object.assign(r, st.vals);
          res(matched.map((r) => projectRow(r, st.ret ?? {})));
        } catch (e) {
          if (rej) rej(e);
          else throw e;
        }
      },
    };
    return api;
  };

  const db = {
    select: (proj: Proj) => selectBuilder(proj),
    update: (table: { __table: string }) => updateBuilder(table),
  };

  const col = (table: string, name: string) => ({ __col: true as const, table, name });
  const mkTable = (name: string, cols: string[]) => {
    const t: Record<string, unknown> = { __table: name };
    for (const c of cols) t[c] = col(name, c);
    return t;
  };
  const schema = {
    runs: mkTable("runs", [
      "id",
      "workspaceId",
      "promptText",
      "answer",
      "citations",
      "sentiment",
      "visibilityScore",
      "createdAt",
      "scoreVersion",
    ]),
    workspaces: mkTable("workspaces", ["id", "brandConfig"]),
  };

  const P = (op: string, extra: Record<string, unknown>) => ({ __pred: true as const, op, ...extra });
  const sqlTag = Object.assign(() => ({ __sql: true as const }), {
    join: () => ({ __sql: true as const }),
    raw: () => ({ __sql: true as const }),
    placeholder: () => ({ __sql: true as const }),
  });
  const ops = {
    and: (...p: unknown[]) => P("and", { preds: p.filter(Boolean) }),
    or: (...p: unknown[]) => P("or", { preds: p.filter(Boolean) }),
    not: (p: unknown) => P("not", { pred: p }),
    eq: (c: unknown, val: unknown) => P("eq", { col: c, val }),
    ne: (c: unknown, val: unknown) => P("ne", { col: c, val }),
    gt: (c: unknown, val: unknown) => P("gt", { col: c, val }),
    gte: (c: unknown, val: unknown) => P("gte", { col: c, val }),
    lt: (c: unknown, val: unknown) => P("lt", { col: c, val }),
    lte: (c: unknown, val: unknown) => P("lte", { col: c, val }),
    inArray: (c: unknown, vals: unknown[]) => P("inArray", { col: c, vals }),
    isNull: (c: unknown) => P("isNull", { col: c }),
    ilike: (c: unknown, val: unknown) => P("ilike", { col: c, val }),
    asc: (c: unknown) => ({ __order: true, dir: "asc", col: c }),
    desc: (c: unknown) => ({ __order: true, dir: "desc", col: c }),
    sql: sqlTag,
  };

  const reset = () => {
    store.runs = [];
    store.workspaces = [];
    conflictIds.clear();
  };

  return { store, conflictIds, db, schema, ops, reset };
});

// getSession 은 케이스별 주입, requireAdmin 은 원본과 동일 분기(순수).
const authState = vi.hoisted(() => ({ session: { kind: "admin", role: 0 } as unknown }));

vi.mock("@/lib/server/db", () => ({ db: H.db, schema: H.schema }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...H.ops };
});

vi.mock("@/lib/server/auth-guard", () => ({
  getSession: async () => authState.session,
  requireAdmin: (s: { kind?: string } | null) => {
    if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (s.kind !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return null;
  },
}));

// 모킹 이후 import (route 는 위 모듈에 의존).
import { POST } from "./route";
import { calcVisibility } from "@/lib/server/automation-runner";

// ── 공통 픽스처 ──
const WS_ID = "11111111-1111-1111-1111-111111111111";
// 일반 검색(informational): prompt 에 brand 별칭 없음.
const GEN_PROMPT = "필라테스 학원 추천";
// answer: "요가원" 이 정확히 1회, 위치 210(≥200 → 상단 보너스 없음, <500 → L3/L4 중단 보너스 대상).
const GEN_ANSWER = "가".repeat(210) + "요가원 좋아요";
const BRAND_CONFIG = { brandName: "요가원", brandAliases: "", websites: [] as string[] };

/** 실제 배점 함수로 계산한, 일반·중립·단일언급 run 의 레벨별 기대 점수(topRanked=false). */
const expectedScore = (level: 0 | 1 | 2 | 3 | 4) =>
  calcVisibility(GEN_ANSWER, ["요가원"], false, false, "neutral", false, false, false, level);

// 저장값(레벨0 기준). topRanked=true 는 50 을 내므로 오직 topRanked=false 조합만 재현 → 목표 유일.
const STORED = expectedScore(0); // = 35

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** KST 경계일 정오(UTC = KST-9h). 07-13 은 frozenBefore(2026-07-13T15:00Z) 이전이라 창 밖. */
const KST = {
  d0713: "2026-07-13T03:00:00Z", // KST 07-13 12:00 → frozen 이전(미선택)
  d0714: "2026-07-14T03:00:00Z", // L1
  d0716: "2026-07-16T03:00:00Z", // L2
  d0718: "2026-07-18T03:00:00Z", // L3
  d0720: "2026-07-20T03:00:00Z", // L4
};

function seedGenRun(
  n: number,
  createdIso: string,
  storedScore: number,
  opts: { version?: number } = {},
): Record<string, unknown> {
  const row = {
    id: id(n),
    workspaceId: WS_ID,
    promptText: GEN_PROMPT,
    answer: GEN_ANSWER,
    citations: [] as unknown[],
    sentiment: "neutral",
    visibilityScore: storedScore,
    createdAt: new Date(createdIso),
    scoreVersion: opts.version ?? 8,
  };
  H.store.runs.push(row);
  return row;
}

function seedWorkspace() {
  H.store.workspaces.push({ id: WS_ID, brandConfig: BRAND_CONFIG });
}

function post(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/recalc-visibility", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(() => {
  H.reset();
  authState.session = { kind: "admin", role: 0 };
  seedWorkspace();
});

describe("배점표 self-check (전제)", () => {
  it("저장값·레벨별 기대 점수가 §3 배점표와 일치(회귀 앵커)", () => {
    expect(STORED).toBe(35); // L0 baseline
    expect(expectedScore(1)).toBe(35); // L1: mid 0, neutral 5
    expect(expectedScore(2)).toBe(35); // L2: mid 0, neutral 5
    expect(expectedScore(3)).toBe(45); // L3: mid +10
    expect(expectedScore(4)).toBe(48); // L4: mid +10, neutral 8
  });
});

describe("(a)(b) dry-run: 무쓰기 + selector + 경계일 점수 + 07-14 이전 불변", () => {
  it("v8·frozen 이후만 선택하고, dry-run 은 write 없이 배점표 점수를 산출", async () => {
    const r1 = seedGenRun(1, KST.d0714, STORED); // L1
    const r2 = seedGenRun(2, KST.d0716, STORED); // L2
    const r3 = seedGenRun(3, KST.d0718, STORED); // L3
    const r4 = seedGenRun(4, KST.d0720, STORED); // L4
    const rFrozen = seedGenRun(5, KST.d0713, STORED); // frozen 이전 → 미선택
    const rV7 = seedGenRun(6, KST.d0716, STORED, { version: 7 }); // 다른 버전 → 미선택
    const rV9 = seedGenRun(7, KST.d0716, STORED, { version: 9 }); // 다른 버전 → 미선택

    const res = await POST(post({ dryRun: true, batchSize: 200 }));
    expect(res.status).toBe(200);
    const body = await res.json();

    // (a) dry-run: write 없음
    expect(body.dryRun).toBe(true);
    expect(body.updated).toBe(0);
    expect(body.anomalyRemaining).toBeNull();

    // (b) selector: v8 AND created_at≥frozen 만(4건). frozen 이전·v7·v9 제외.
    expect(body.processed).toBe(4);
    const sampleIds = (body.samples as { id: string }[]).map((s) => s.id).sort();
    expect(sampleIds).toEqual([r1.id, r2.id, r3.id, r4.id].sort());
    expect(sampleIds).not.toContain(rFrozen.id);
    expect(sampleIds).not.toContain(rV7.id);
    expect(sampleIds).not.toContain(rV9.id);

    // 경계일별 예상 점수(§3 배점표 = calcVisibility) 일치
    const byId = new Map(
      (body.samples as { id: string; after: number; phaseLevel: number }[]).map((s) => [s.id, s]),
    );
    expect(byId.get(r1.id)).toMatchObject({ after: 35, phaseLevel: 1 });
    expect(byId.get(r2.id)).toMatchObject({ after: 35, phaseLevel: 2 });
    expect(byId.get(r3.id)).toMatchObject({ after: 45, phaseLevel: 3 });
    expect(byId.get(r4.id)).toMatchObject({ after: 48, phaseLevel: 4 });

    // (a) 실제 store 는 전혀 변하지 않음(버전·점수 유지). 07-14 이전 표본도 불변.
    for (const r of [r1, r2, r3, r4, rFrozen, rV7, rV9]) {
      const stored = H.store.runs.find((x) => x.id === r.id)!;
      expect(stored.scoreVersion).toBe(r.scoreVersion);
      expect(stored.visibilityScore).toBe(STORED);
    }
  });
});

describe("(d) live 적용 + CAS 멱등(중복 실행 이중 적용 없음)", () => {
  it("1회차: v8 4건을 배점표 점수로 갱신하고 v9 로 승격", async () => {
    seedGenRun(1, KST.d0714, STORED);
    seedGenRun(2, KST.d0716, STORED);
    seedGenRun(3, KST.d0718, STORED);
    seedGenRun(4, KST.d0720, STORED);

    const res = await POST(post({ batchSize: 200 }));
    const body = await res.json();
    expect(body.updated).toBe(4);
    expect(body.conflicted).toBe(0);
    expect(body.processableRemaining).toBe(0);

    const s = (n: number) => H.store.runs.find((x) => x.id === id(n))!;
    expect(s(3).visibilityScore).toBe(45);
    expect(s(4).visibilityScore).toBe(48);
    for (const n of [1, 2, 3, 4]) expect(s(n).scoreVersion).toBe(9);
  });

  it("2회차(동일 커서): 남은 v8 없음 → 무처리, 점수 이중 적용 안 됨(멱등)", async () => {
    seedGenRun(3, KST.d0718, STORED);
    seedGenRun(4, KST.d0720, STORED);

    await POST(post({ batchSize: 200 })); // 1회차
    const before = H.store.runs.map((r) => ({ id: r.id, v: r.visibilityScore }));

    const res = await POST(post({ batchSize: 200 })); // 2회차
    const body = await res.json();
    expect(body.processed).toBe(0); // WHERE score_version=8 → 이미 v9 라 선택 0
    expect(body.updated).toBe(0);
    expect(body.processableRemaining).toBe(0);

    const after = H.store.runs.map((r) => ({ id: r.id, v: r.visibilityScore }));
    expect(after).toEqual(before); // 점수가 두 번 이동하지 않음
    expect(H.store.runs.find((x) => x.id === id(3))!.visibilityScore).toBe(45);
    expect(H.store.runs.find((x) => x.id === id(4))!.visibilityScore).toBe(48);
  });

  it("CAS 충돌(동시 v9 bump): 선택됐어도 갱신 실패 → conflicted 로 집계, 원값 보존", async () => {
    seedGenRun(1, KST.d0714, STORED);
    seedGenRun(2, KST.d0716, STORED); // 이 row 가 update 직전에 v9 로 bump 됐다고 가정
    seedGenRun(3, KST.d0718, STORED);
    seedGenRun(4, KST.d0720, STORED);
    H.conflictIds.add(id(2));

    const res = await POST(post({ batchSize: 200 }));
    const body = await res.json();
    expect(body.updated).toBe(3);
    expect(body.conflicted).toBe(1);

    const r2 = H.store.runs.find((x) => x.id === id(2))!;
    expect(r2.scoreVersion).toBe(8); // 갱신 안 됨
    expect(r2.visibilityScore).toBe(STORED); // 원값 보존
    // 커서 이하로 남은 v8(=재시도 대상) 1건 집계
    expect(body.anomalyRemaining).toBe(1);
  });
});

describe("(c)(e) keyset 커서 전진 + anomaly + 전량 anomaly stalled 오탐 없음", () => {
  it("anomaly row 를 지나 커서가 전진하고, 뒤의 정상 row 를 처리", async () => {
    const rAnom = seedGenRun(1, KST.d0716, 999); // 어떤 조합으로도 재현 불가 → no-candidate
    const rOk = seedGenRun(2, KST.d0718, STORED); // L3 → 45

    const res = await POST(post({ batchSize: 200 }));
    const body = await res.json();
    expect(body.processed).toBe(2);
    expect(body.updated).toBe(1);
    expect(body.anomalies).toHaveLength(1);
    expect(body.anomalies[0].id).toBe(rAnom.id);
    // (c) 커서는 마지막 방문 row(정상)까지 전진
    expect(body.nextCursor).toBe(rOk.id);
    expect(H.store.runs.find((x) => x.id === rOk.id)!.visibilityScore).toBe(45);
    // anomaly row 는 v8 유지
    expect(H.store.runs.find((x) => x.id === rAnom.id)!.scoreVersion).toBe(8);
  });

  it("(e) 전량 anomaly batch 에서도 nextCursor 전진 → stalled=false", async () => {
    seedGenRun(1, KST.d0716, 999);
    seedGenRun(2, KST.d0718, 999);

    const res = await POST(post({ batchSize: 200 }));
    const body = await res.json();
    expect(body.processed).toBe(2);
    expect(body.updated).toBe(0);
    expect(body.anomalies).toHaveLength(2);
    expect(body.nextCursor).toBe(id(2)); // 입력 커서(null) 대비 전진
    expect(body.stalled).toBe(false); // 정체 오탐 없음
    expect(body.processableRemaining).toBe(0);
  });
});

describe("(b)(c) keyset 페이지네이션: batchSize 제한 + nextCursor 로 다음 페이지", () => {
  it("2건씩 두 페이지로 전량 처리(커서 전진 실측)", async () => {
    seedGenRun(1, KST.d0714, STORED);
    seedGenRun(2, KST.d0716, STORED);
    seedGenRun(3, KST.d0718, STORED);
    seedGenRun(4, KST.d0720, STORED);

    const res1 = await POST(post({ batchSize: 2 }));
    const b1 = await res1.json();
    expect(b1.processed).toBe(2);
    expect(b1.nextCursor).toBe(id(2));
    expect(b1.processableRemaining).toBe(2); // id>커서 남은 v8

    const res2 = await POST(post({ batchSize: 2, cursor: b1.nextCursor }));
    const b2 = await res2.json();
    expect(b2.processed).toBe(2);
    expect(b2.nextCursor).toBe(id(4));
    expect(b2.processableRemaining).toBe(0);

    // 전량 v9 승격, 각 배점표 점수
    expect(H.store.runs.find((x) => x.id === id(3))!.visibilityScore).toBe(45);
    expect(H.store.runs.find((x) => x.id === id(4))!.visibilityScore).toBe(48);
    for (const n of [1, 2, 3, 4]) expect(H.store.runs.find((x) => x.id === id(n))!.scoreVersion).toBe(9);
  });
});

describe("(f) preflight 분포 게이트", () => {
  it("창 안에 v8 외 버전 있으면 clean=false, targetCount 는 v8 만", async () => {
    seedGenRun(1, KST.d0714, STORED); // v8
    seedGenRun(2, KST.d0716, STORED); // v8
    seedGenRun(3, KST.d0716, STORED, { version: 7 }); // v7
    seedGenRun(4, KST.d0716, STORED, { version: 9 }); // v9
    seedGenRun(5, KST.d0713, STORED); // frozen 이전 v8 → 창 밖(분포 제외)

    const res = await POST(post({ preflight: true }));
    const body = await res.json();
    expect(body.preflight).toBe(true);
    expect(body.targetCount).toBe(2); // frozen 이전 v8 은 제외 → 3 아님 2
    expect(body.clean).toBe(false); // v7·v9 존재
    const dist = body.distribution as { scoreVersion: number; count: number }[];
    expect(dist.find((d) => d.scoreVersion === 8)!.count).toBe(2);
    expect(dist.find((d) => d.scoreVersion === 7)!.count).toBe(1);
    expect(dist.find((d) => d.scoreVersion === 9)!.count).toBe(1);
  });

  it("창 안이 전부 v8 이면 clean=true", async () => {
    seedGenRun(1, KST.d0714, STORED);
    seedGenRun(2, KST.d0716, STORED);

    const res = await POST(post({ preflight: true }));
    const body = await res.json();
    expect(body.clean).toBe(true);
    expect(body.targetCount).toBe(2);
  });
});

describe("입력·권한 게이트", () => {
  it("잘못된 커서 → 400 invalid_cursor", async () => {
    const res = await POST(post({ cursor: "not-a-uuid" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_cursor");
  });

  it("미인증(session=null) → 401", async () => {
    authState.session = null;
    const res = await POST(post({}));
    expect(res.status).toBe(401);
  });

  it("권한 부족(kind=user) → 403", async () => {
    authState.session = { kind: "user", role: 1 };
    const res = await POST(post({}));
    expect(res.status).toBe(403);
  });
});
