/**
 * route.test.ts — /api/internal/visibility-rescore 실행 경로 계약 테스트.
 *
 * 순수 함수(세트 계산기·역산·selector)는 각자 테스트가 있지만 라우트 자체
 * (인증 게이트·selector 실행·커서·3중 CAS·트랜잭션·preflight·dry-run)는 여기서만 덮인다.
 *
 * 검증 방식(저장소 컨벤션 = route.test.ts 모듈 모킹):
 *   - @/lib/server/db : in-memory fake db + fake schema(컬럼 토큰). 실제 postgres 미사용.
 *   - drizzle-orm     : and/or/not/eq/gt/gte/lt/inArray/ilike/asc/sql 을 "술어 서술자" 로
 *                       바꿔 fake db 가 조건을 **실제로 평가**한다(selector·커서 검증 가능).
 *   - 그 외(세트 계산기·역산·잡 레지스트리·selector·citation-utils·date-kst)는 진짜 함수.
 *
 * 덮는 계약(계획 S4 표 a~n):
 *   a dry-run 무쓰기 / b selector 불변 표본 / c 커서 전진 / d 3중 CAS /
 *   e 전량 anomaly 에서 잔여 감소 / f preflight clean / g v8·v10 혼재 배치 /
 *   h branded·수동 미선택 / i 인증·입력 게이트 / j sentiment 미변경 /
 *   k 교차 진단 skip / l 배치 예외 시 전량 롤백 / m 실행 식별자 / n 멱등
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

/* ============================================================
 * in-memory fake db + drizzle 술어 서술자
 * ============================================================ */

const H = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const store: { runs: Row[]; workspaces: Row[] } = { runs: [], workspaces: [] };

  /** 트랜잭션 진입 직후 1회 실행 — 조회와 UPDATE 사이의 제3자 변경 재현. */
  let beforeTransaction: (() => void) | null = null;
  /** 이 id 를 UPDATE 하려 하면 예외 — 배치 중간 실패 재현. */
  let throwOnUpdateId: string | null = null;
  /** UPDATE 의 SET 절에 실제로 들어간 키(들). */
  const updateSetKeys: string[][] = [];

  const isDate = (v: unknown): v is Date => v instanceof Date;
  const norm = (v: unknown) => (isDate(v) ? v.getTime() : v);

  /* ──────────────────────────────────────────────────────────────
   * created_at 의 마이크로초 재현
   *
   * postgres 의 timestamptz 는 마이크로초 해상도인데 JS `Date` 에는 그 자리가 없다.
   * 저장소를 Date 로만 채우면 "커서가 밀리초로 잘려 자기 행을 다시 고른다" 는 결함을
   * 하네스가 **구조적으로 재현할 수 없다**(운영에서만 드러난 이유가 이것이다).
   * 그래서 행은 선택적으로 `createdAtUs`(마이크로초 텍스트)를 들고, created_at 관련
   * 비교·정렬·투영은 전부 마이크로초 단위로 한다.
   * ────────────────────────────────────────────────────────────── */
  const MICRO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/;
  const microsOfText = (t: string): number => {
    const m = MICRO_RE.exec(t);
    if (!m) return Date.parse(t) * 1000;
    return Date.parse(`${m[1]}.000Z`) * 1000 + Number(m[2]);
  };
  /** 행의 created_at 을 마이크로초 정수로. */
  const rowMicros = (row: Row): number =>
    typeof row.createdAtUs === "string"
      ? microsOfText(row.createdAtUs)
      : (row.createdAt as Date).getTime() * 1000;
  /** 행의 created_at 을 마이크로초 텍스트로 (to_char 투영 재현). */
  const rowMicroText = (row: Row): string =>
    typeof row.createdAtUs === "string"
      ? row.createdAtUs
      : `${(row.createdAt as Date).toISOString().slice(0, -1)}000Z`;
  /** 비교 대상 값을 마이크로초 정수로 — Date · 마이크로초 텍스트 · `?::timestamptz` 조각. */
  const valueMicros = (v: unknown): number => {
    if (isDate(v)) return v.getTime() * 1000;
    if (typeof v === "string") return microsOfText(v);
    const frag = v as { __sql?: true; values?: unknown[] };
    if (frag?.__sql) {
      const bound = frag.values?.[0];
      if (typeof bound === "string") return microsOfText(bound);
      if (isDate(bound)) return bound.getTime() * 1000;
    }
    return NaN;
  };
  const isCreatedAt = (c: { name?: string } | undefined) => c?.name === "createdAt";
  const cmp = (a: unknown, b: unknown): number => {
    const av = norm(a) as number | string;
    const bv = norm(b) as number | string;
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  };
  const nameOf = (c: { name?: string } | undefined) => c?.name;

  /**
   * ILIKE 를 실제 LIKE 의미로 평가한다 — `%`(임의 문자열) · `_`(임의 1글자) ·
   * 백슬래시 이스케이프. 별칭 이스케이프가 실제로 와일드카드를 죽이는지 보려면
   * 하네스가 이 의미를 흉내 내야 한다(패턴에서 `%` 를 지우는 근사로는 알 수 없다).
   */
  const likeMatch = (hay: string, pattern: string): boolean => {
    let re = "";
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i];
      if (c === "\\") {
        const next = pattern[i + 1];
        if (next !== undefined) {
          re += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          i += 1;
        }
        continue;
      }
      if (c === "%") re += "[\\s\\S]*";
      else if (c === "_") re += "[\\s\\S]";
      else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`).test(hay);
  };

  type Pred = { __pred?: true; __sql?: true; op?: string; [k: string]: unknown };
  const match = (row: Row, pred: Pred | undefined): boolean => {
    if (!pred) return true;
    if (pred.__sql) {
      // 리터럴 불리언 조각은 실제로 평가한다. workspaceScopeCondition 이 범위
      // 워크스페이스 0개일 때 내보내는 `sql`false`` 분기가 여기서 실효 검증된다.
      const raw = String(pred.raw ?? "").trim().toLowerCase();
      if (raw === "false") return false;
      if (raw === "true") return true;
      return true; // 그 밖의 원시 sql 은 해석하지 않고 match-all
    }
    const col = pred.col as { name?: string } | undefined;
    const val = pred.val;
    // created_at 은 밀리초로 뭉개지 않고 마이크로초로 비교한다(커서 정확도의 핵심).
    if (isCreatedAt(col) && ["eq", "ne", "gt", "gte", "lt", "lte"].includes(pred.op ?? "")) {
      const a = rowMicros(row);
      const b = valueMicros(val);
      switch (pred.op) {
        case "eq":
          return a === b;
        case "ne":
          return a !== b;
        case "gt":
          return a > b;
        case "gte":
          return a >= b;
        case "lt":
          return a < b;
        default:
          return a <= b;
      }
    }
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
      case "ilike":
        return likeMatch(
          String(row[nameOf(col)!] ?? "").toLowerCase(),
          String(val).toLowerCase(),
        );
      default:
        return true;
    }
  };

  type Proj = Record<string, { __col?: true; __sql?: true; name?: string; raw?: string }>;
  /** 집계 투영인가 — to_char 같은 스칼라 sql 투영과 갈라야 한다. */
  const isAggProj = (v: { __sql?: true; raw?: string } | undefined) =>
    !!v?.__sql && String(v.raw ?? "").includes("count(");

  const projectRow = (row: Row, proj: Proj, aggCount = 0) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(proj)) {
      if (isAggProj(v)) out[k] = aggCount;
      // 커서 투영(to_char) — 마이크로초 텍스트를 실제로 만들어 준다.
      else if (v && v.__sql && String(v.raw ?? "").includes("to_char(")) out[k] = rowMicroText(row);
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
    orders: Order[],
    limit: number | undefined,
  ) => {
    let rows = store[table.__table as "runs" | "workspaces"].filter((r) => match(r, where));
    const hasAgg = Object.values(proj).some((v) => isAggProj(v));
    if (hasAgg) return [projectRow(rows[0] ?? {}, proj, rows.length)];

    if (orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const o of orders) {
          const c =
            (isCreatedAt(o.col)
              ? Math.sign(rowMicros(a) - rowMicros(b))
              : cmp(a[o.col.name!], b[o.col.name!])) * (o.dir === "desc" ? -1 : 1);
          if (c !== 0) return c;
        }
        return 0;
      });
    }
    if (typeof limit === "number") rows = rows.slice(0, limit);
    return rows.map((r) => projectRow(r, proj));
  };

  const selectBuilder = (proj: Proj) => {
    const st: {
      table: { __table: string } | null;
      where: Pred | undefined;
      orders: Order[];
      limit: number | undefined;
    } = { table: null, where: undefined, orders: [], limit: undefined };
    const api = {
      from(t: { __table: string }) {
        st.table = t;
        return api;
      },
      where(w: Pred) {
        st.where = w;
        return api;
      },
      orderBy(...o: Order[]) {
        st.orders = o;
        return api;
      },
      limit(n: number) {
        st.limit = n;
        return api;
      },
      then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
        try {
          res(runSelect(proj, st.table!, st.where, st.orders, st.limit));
        } catch (e) {
          if (rej) rej(e);
          else throw e;
        }
      },
    };
    return api;
  };

  const updateBuilder = (table: { __table: string }) => {
    const st: { vals: Row | null; where: Pred | undefined; ret: Proj | null } = {
      vals: null,
      where: undefined,
      ret: null,
    };
    const api = {
      set(v: Row) {
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
          updateSetKeys.push(Object.keys(st.vals ?? {}));
          const rows = store[table.__table as "runs" | "workspaces"];
          const matched = rows.filter((r) => match(r, st.where));
          if (throwOnUpdateId && matched.some((r) => r.id === throwOnUpdateId)) {
            throw new Error("배치 중간 실패 재현");
          }
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

  const dbApi = {
    select: (proj: Proj) => selectBuilder(proj),
    update: (table: { __table: string }) => updateBuilder(table),
  };

  const db = {
    ...dbApi,
    /** 실제 트랜잭션과 같은 성질: 콜백이 던지면 그 배치의 변경이 전부 사라진다. */
    async transaction<T>(fn: (tx: typeof dbApi) => Promise<T>): Promise<T> {
      if (beforeTransaction) {
        beforeTransaction();
        beforeTransaction = null;
      }
      const snapshot = store.runs.map((r) => ({ ...r }));
      try {
        return await fn(dbApi);
      } catch (e) {
        store.runs = snapshot;
        throw e;
      }
    },
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
      "provider",
      "answer",
      "citations",
      "sentiment",
      "visibilityScore",
      "scoreVersion",
      "isAuto",
      "parseQuality",
      "createdAt",
    ]),
    workspaces: mkTable("workspaces", ["id", "brandConfig", "isProduction"]),
  };

  const P = (op: string, extra: Record<string, unknown>) => ({ __pred: true as const, op, ...extra });
  // 태그드 템플릿의 원문을 붙들어 둔다 — `sql`false`` 같은 리터럴 조각을 평가하기 위해서다.
  const sqlTag = Object.assign(
    (strings?: TemplateStringsArray, ...values: unknown[]) => ({
      __sql: true as const,
      raw: strings ? Array.from(strings).join("") : "",
      // 보간된 값을 붙들어 둔다 — `${cursorTs}::timestamptz` 같은 조각을 실제로 평가한다.
      values,
    }),
    {
      join: () => ({ __sql: true as const, raw: "" }),
      raw: (v: unknown) => ({ __sql: true as const, raw: String(v) }),
      placeholder: () => ({ __sql: true as const, raw: "" }),
    },
  );
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
    beforeTransaction = null;
    throwOnUpdateId = null;
    updateSetKeys.length = 0;
  };

  return {
    store,
    db,
    schema,
    ops,
    reset,
    updateSetKeys,
    setBeforeTransaction: (fn: () => void) => {
      beforeTransaction = fn;
    },
    setThrowOnUpdateId: (id: string | null) => {
      throwOnUpdateId = id;
    },
  };
});

vi.mock("@/lib/server/db", () => ({ db: H.db, schema: H.schema }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...H.ops };
});

// 모킹 이후 import.
import { POST } from "./route";
import { RESCORE_JOBS, jobHash, promptKey } from "@/lib/server/visibility-rescore-jobs";
import { SCORE_SETS, calcVisibilityWithSet } from "@/lib/server/visibility-score-sets";

/* ============================================================
 * 픽스처
 * ============================================================ */

const SECRET = "test-internal-cron-secret";
const WS_PROD = "11111111-1111-1111-1111-111111111111";
const WS_TEST = "33333333-3333-3333-3333-333333333333";

/** 일반 검색 프롬프트 — 브랜드 별칭("요가원") 미포함. */
const GEN_PROMPT = "필라테스 학원 추천";
/** 브랜드 질의 프롬프트. */
const BRANDED_PROMPT = "요가원 어때요";
/** "요가원" 이 위치 210 에 1회 → 중단 노출·단일 언급. */
const GEN_ANSWER = "가".repeat(210) + "요가원 좋아요";

const BRAND_CONFIG = { brandName: "요가원", brandAliases: "", websites: [] as string[] };

const genInputs = (isTopRanked: boolean) => ({
  mentions: 1,
  firstPos: 210,
  hasBodyUrl: false,
  hasCitationOnly: false,
  sentiment: "neutral" as const,
  isTopRanked,
  isStronglyRecommended: false,
  isBrandedQuery: false,
});

/** 저장 점수 앵커 — 손계산과 계산기가 일치하는지 테스트가 먼저 확인한다. */
const STORED_V8 = calcVisibilityWithSet(genInputs(false), SCORE_SETS.legacy8); // 30+0+5 = 35
const STORED_V10 = calcVisibilityWithSet(genInputs(false), SCORE_SETS.full10); // 30+14+12 = 56
const TARGET_LOW60 = calcVisibilityWithSet(genInputs(false), SCORE_SETS.low60); // 18+0+3 = 21

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** v11 창 안(KST 7/15 12:00). n 을 분 단위로 흘려 createdAt 을 서로 다르게 만든다. */
const inWindowAt = (minutes: number) =>
  new Date(new Date("2026-07-15T03:00:00.000Z").getTime() + minutes * 60_000);

type SeedOpts = {
  version?: number;
  score?: number;
  createdAt?: Date;
  provider?: string;
  isAuto?: boolean;
  promptText?: string;
  workspaceId?: string;
  sentiment?: string;
  answer?: string;
  /** 마이크로초까지 있는 created_at — 실 DB 의 해상도를 재현할 때만 준다. */
  createdAtUs?: string;
};

function seedRun(n: number, opts: SeedOpts = {}) {
  const row = {
    id: id(n),
    workspaceId: opts.workspaceId ?? WS_PROD,
    promptText: opts.promptText ?? GEN_PROMPT,
    provider: opts.provider ?? "google_ai",
    answer: opts.answer ?? GEN_ANSWER,
    citations: [] as unknown[],
    sentiment: opts.sentiment ?? "neutral",
    visibilityScore: opts.score ?? STORED_V10,
    scoreVersion: opts.version ?? 10,
    isAuto: opts.isAuto ?? true,
    parseQuality: "high",
    createdAt: opts.createdAt ?? inWindowAt(n),
    ...(opts.createdAtUs ? { createdAtUs: opts.createdAtUs } : {}),
  };
  H.store.runs.push(row);
  return row;
}

function seedWorkspaces() {
  H.store.workspaces.push({ id: WS_PROD, brandConfig: BRAND_CONFIG, isProduction: true });
  H.store.workspaces.push({ id: WS_TEST, brandConfig: BRAND_CONFIG, isProduction: false });
}

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/internal/visibility-rescore", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      "x-cron-secret": SECRET,
      ...headers,
    },
    body: JSON.stringify(body ?? {}),
  });
}

const ORIGINAL_SECRET = process.env.INTERNAL_CRON_SECRET;
const ORIGINAL_PORT = process.env.PORT;

beforeEach(() => {
  H.reset();
  process.env.INTERNAL_CRON_SECRET = SECRET;
  process.env.PORT = "3000";
  seedWorkspaces();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_SECRET === undefined) delete process.env.INTERNAL_CRON_SECRET;
  else process.env.INTERNAL_CRON_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;
});

/* ============================================================
 * 앵커 자기 점검
 * ============================================================ */

describe("점수 앵커 self-check (전제)", () => {
  it("v8 35 · v10 56 · low60 21", () => {
    expect(STORED_V8).toBe(35);
    expect(STORED_V10).toBe(56);
    expect(TARGET_LOW60).toBe(21);
  });
});

/* ============================================================
 * (i) 인증 · 도달 · 입력 게이트
 * ============================================================ */

/**
 * ⚠️ 이 하네스의 구조적 한계 — 반드시 알고 읽을 것.
 *
 * `new NextRequest(...)` 는 Next 서버 계층을 **건너뛴다.** 실제 서버는 모든 요청에
 * `x-forwarded-host`·`x-forwarded-port`·`x-forwarded-proto`·`x-forwarded-for` 를 스스로
 * 채워 넣는데, 여기서는 그 주입이 일어나지 않는다. 그래서 "헤더가 없는 요청이 통과한다"는
 * 테스트는 **운영에서의 안전을 보증하지 못한다.**
 *
 * 그 공백을 두 가지로 메운다.
 *   ① 아래 "Next 가 주입한 헤더" 묶음이 서버가 채우는 값을 **손으로 재현**해 200 을 확인한다.
 *   ② 배포 후 컨테이너 안에서 preflight 를 실제로 한 번 돌려 확인한다(계획 S8).
 */
describe("(i) 도달 제어·인증 게이트", () => {
  /** 실제 Next 서버가 loopback 직접 호출에 채워 넣는 값. */
  const NEXT_INJECTED = {
    "x-forwarded-host": "127.0.0.1:3000",
    "x-forwarded-port": "3000",
    "x-forwarded-proto": "http",
    "x-forwarded-for": "127.0.0.1",
  };

  it("시크릿 미설정 → 503", async () => {
    delete process.env.INTERNAL_CRON_SECRET;
    const res = await POST(post({ job: "v11", meta: true }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("not_configured");
  });

  it("시크릿 불일치 → 403 (도달 제어 실패와 같은 응답 — 유효성 오라클 없음)", async () => {
    const res = await POST(post({ job: "v11", meta: true }, { "x-cron-secret": "wrong" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("시크릿 헤더 없음 → 403", async () => {
    const req = new NextRequest("http://127.0.0.1:3000/api/internal/visibility-rescore", {
      method: "POST",
      headers: { "content-type": "application/json", host: "127.0.0.1:3000" },
      body: JSON.stringify({ job: "v11", meta: true }),
    });
    expect((await POST(req)).status).toBe(403);
  });

  it("외부 요청은 시크릿이 맞든 틀리든 같은 응답을 받는다", async () => {
    const external = { host: "cms.example.co.kr", "x-real-ip": "203.0.113.9" };
    const good = await POST(post({ job: "v11", meta: true }, external));
    const bad = await POST(post({ job: "v11", meta: true }, { ...external, "x-cron-secret": "wrong" }));
    expect(good.status).toBe(403);
    expect(bad.status).toBe(403);
    expect(await good.json()).toEqual(await bad.json());
  });

  // 이 여섯은 Next 가 주입하지 않는다 — 존재 자체가 프록시 흔적이다.
  for (const header of [
    "x-real-ip",
    "forwarded",
    "x-forwarded-server",
    "x-original-forwarded-for",
    "cf-connecting-ip",
    "true-client-ip",
  ]) {
    it(`프록시 전용 헤더 ${header} 존재 → 403`, async () => {
      const res = await POST(post({ job: "v11", meta: true }, { [header]: "203.0.113.9" }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("forbidden");
    });
  }

  it("⭐ Next 가 스스로 채우는 X-Forwarded-* 4종이 붙어도 200 (존재 검사였다면 전부 403)", async () => {
    const res = await POST(post({ job: "v11", meta: true }, NEXT_INJECTED));
    expect(res.status).toBe(200);
  });

  it("⭐ Next 주입 헤더가 붙은 실제 스윕도 정상 처리된다", async () => {
    seedRun(1);
    const res = await POST(post({ job: "v11", apply: true, batchSize: 200 }, NEXT_INJECTED));
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(1);
  });

  it("⭐ 리버스 프록시를 흉내 낸 헤더 조합은 403", async () => {
    // NPM(nginx) 이 실제로 붙이는 모양 — 공개 도메인 Host · 공인 IP · https · 443.
    const viaProxy = {
      host: "cms.magicbodypilates.co.kr",
      "x-forwarded-host": "cms.magicbodypilates.co.kr",
      "x-forwarded-proto": "https",
      "x-forwarded-port": "443",
      "x-forwarded-for": "203.0.113.9",
    };
    expect((await POST(post({ job: "v11", meta: true }, viaProxy))).status).toBe(403);
  });

  it("⭐ Host 만 위조하고 나머지를 loopback 으로 맞춰도 값 검사에 걸린다", async () => {
    const forged = {
      ...NEXT_INJECTED,
      host: "127.0.0.1:3000",
      // nginx 계열은 X-Forwarded-For 를 덧붙이므로 콤마가 남는다.
      "x-forwarded-for": "127.0.0.1, 203.0.113.9",
    };
    expect((await POST(post({ job: "v11", meta: true }, forged))).status).toBe(403);
  });

  for (const [header, value] of [
    ["x-forwarded-host", "cms.magicbodypilates.co.kr"],
    ["x-forwarded-port", "443"],
    ["x-forwarded-proto", "https"],
    ["x-forwarded-for", "203.0.113.9"],
  ]) {
    it(`X-Forwarded 값이 loopback 이 아니면 403 — ${header}`, async () => {
      const res = await POST(
        post({ job: "v11", meta: true }, { ...NEXT_INJECTED, [header]: value }),
      );
      expect(res.status).toBe(403);
    });
  }

  it("Host 가 loopback 이 아니면 403", async () => {
    const res = await POST(
      post({ job: "v11", meta: true }, { host: "cms.example.co.kr" }),
    );
    expect(res.status).toBe(403);
  });

  it("Host 포트가 앱 포트와 다르면 403", async () => {
    const res = await POST(post({ job: "v11", meta: true }, { host: "127.0.0.1:8080" }));
    expect(res.status).toBe(403);
  });

  it("localhost·[::1] 은 허용", async () => {
    expect((await POST(post({ job: "v11", meta: true }, { host: "localhost:3000" }))).status).toBe(
      200,
    );
    expect((await POST(post({ job: "v11", meta: true }, { host: "[::1]:3000" }))).status).toBe(200);
  });

  it("없는 잡 id → 400", async () => {
    expect((await POST(post({ job: "v15" }))).status).toBe(400);
    expect((await POST(post({ job: "v14t" }))).status).toBe(400);
    expect((await POST(post({ job: "v13t" }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ job: 11 }))).status).toBe(400);
  });

  // `in` 연산자로 검사하면 프로토타입 속성이 전부 통과한다.
  for (const key of ["toString", "__proto__", "constructor", "valueOf", "hasOwnProperty"]) {
    it(`프로토타입 키 "${key}" 는 잡 id 가 아니다 → 400`, async () => {
      const res = await POST(post({ job: key, meta: true }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_job");
    });
  }

  it("잘못된 커서 → 400", async () => {
    expect((await POST(post({ job: "v11", cursor: { createdAt: "x", id: id(1) } }))).status).toBe(
      400,
    );
    expect(
      (await POST(post({ job: "v11", cursor: { createdAt: "2026-07-15T03:00:00Z", id: "nope" } })))
        .status,
    ).toBe(400);
    expect((await POST(post({ job: "v11", cursor: { id: id(1) } }))).status).toBe(400);
  });

  it("batchSize 범위 밖 → 400", async () => {
    expect((await POST(post({ job: "v11", batchSize: 0 }))).status).toBe(400);
    expect((await POST(post({ job: "v11", batchSize: 201 }))).status).toBe(400);
    expect((await POST(post({ job: "v11", batchSize: 1.5 }))).status).toBe(400);
  });

  it("operationId·codeSha 형식 오류 → 400", async () => {
    expect((await POST(post({ job: "v11", operationId: "not-uuid" }))).status).toBe(400);
    expect((await POST(post({ job: "v11", codeSha: "bad sha!" }))).status).toBe(400);
  });
});

/* ============================================================
 * 쓰기는 명시적 opt-in
 * ============================================================ */

describe("쓰기는 apply:true 를 받았을 때만 한다", () => {
  it("잡 id 만 보내면 계산만 한다 — 저장소 무변화", async () => {
    seedRun(1);
    const b = await (await POST(post({ job: "v11" }))).json();
    expect(b.dryRun).toBe(true);
    expect(b.updated).toBe(0);
    expect(b.changes).toHaveLength(1); // 계산 결과는 나온다
    expect(H.updateSetKeys).toHaveLength(0);
    expect(H.store.runs[0].scoreVersion).toBe(10);
  });

  it("apply:true 면 실제로 저장한다", async () => {
    seedRun(1);
    const b = await (await POST(post({ job: "v11", apply: true }))).json();
    expect(b.dryRun).toBe(false);
    expect(b.updated).toBe(1);
    expect(H.store.runs[0].scoreVersion).toBe(11);
  });

  it("apply 와 dryRun 을 함께 보내면 400", async () => {
    const res = await POST(post({ job: "v11", apply: true, dryRun: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("conflicting_mode");
  });

  it("dryRun:false 로는 쓸 수 없다 → 400", async () => {
    seedRun(1);
    const res = await POST(post({ job: "v11", dryRun: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_dry_run");
    expect(H.store.runs[0].scoreVersion).toBe(10);
  });

  it("apply 가 불리언이 아니면 400", async () => {
    const res = await POST(post({ job: "v11", apply: "yes" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_apply");
  });
});

/* ============================================================
 * meta
 * ============================================================ */

describe("meta 모드 — DB 접근 없이 잡 정의 반환", () => {
  it("창 경계·소스 버전·목표가 레지스트리와 일치", async () => {
    const res = await POST(post({ job: "v11", meta: true }));
    const body = await res.json();
    expect(body.mode).toBe("meta");
    expect(body.windowFromUtc).toBe(RESCORE_JOBS.v11.fromUtc);
    expect(body.windowToUtc).toBe(RESCORE_JOBS.v11.toUtc);
    expect(body.sourceVersions).toEqual([8, 10]);
    expect(body.targetVersion).toBe(11);
    expect(body.targetSet).toBe("low60");
    expect(body.jobHash).toBe(jobHash("v11"));
  });

  it("v13 은 v11 과 같은 창·소스 버전을 쓰고 목표만 다르다", async () => {
    const body = await (await POST(post({ job: "v13", meta: true }))).json();
    expect(body.mode).toBe("meta");
    expect(body.windowFromUtc).toBe(RESCORE_JOBS.v11.fromUtc);
    expect(body.windowToUtc).toBe(RESCORE_JOBS.v11.toUtc);
    expect(body.providers).toEqual(["google_ai"]);
    expect(body.sourceVersions).toEqual([8, 10]);
    expect(body.informationalOnly).toBe(true);
    expect(body.workspaceScope).toBe("production");
    expect(body.targetVersion).toBe(13);
    expect(body.targetSet).toBe("full83");
    expect(body.jobHash).toBe(jobHash("v13"));
    expect(body.jobHash).not.toBe(jobHash("v11"));
  });
});

/* ============================================================
 * (a)(b)(g)(h) dry-run · selector
 * ============================================================ */

describe("(a)(b)(g)(h) dry-run selector", () => {
  it("창 안 · google_ai · 자동 · 일반 검색 · v8/v10 만 선택하고 쓰지 않는다", async () => {
    const rV8 = seedRun(1, { version: 8, score: STORED_V8 });
    const rV10 = seedRun(2, { version: 10, score: STORED_V10 });
    const outBefore = seedRun(3, { createdAt: new Date("2026-06-25T14:00:00.000Z") });
    const outAfter = seedRun(4, { createdAt: new Date("2026-08-05T03:00:00.000Z") });
    const outProvider = seedRun(5, { provider: "gemini" });
    const outBranded = seedRun(6, { promptText: BRANDED_PROMPT });
    const outManual = seedRun(7, { isAuto: false });
    const outVersion = seedRun(8, { version: 11 });
    const outWorkspace = seedRun(9, { workspaceId: WS_TEST });

    const res = await POST(post({ job: "v11", dryRun: true, batchSize: 200 }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.dryRun).toBe(true);
    expect(body.updated).toBe(0);
    expect(body.processed).toBe(2);

    const ids = (body.changes as { id: string }[]).map((c) => c.id).sort();
    expect(ids).toEqual([rV8.id, rV10.id].sort());
    for (const r of [outBefore, outAfter, outProvider, outBranded, outManual, outVersion, outWorkspace]) {
      expect(ids).not.toContain(r.id);
    }

    // (g) v8·v10 이 각각 자기 세트로 역산돼 둘 다 low60 목표 21 을 얻는다.
    const byId = new Map((body.changes as { id: string }[]).map((c) => [c.id, c]));
    expect(byId.get(rV8.id)).toMatchObject({
      before: STORED_V8,
      after: TARGET_LOW60,
      fromVersion: 8,
      toVersion: 11,
    });
    expect(byId.get(rV10.id)).toMatchObject({
      before: STORED_V10,
      after: TARGET_LOW60,
      fromVersion: 10,
      toVersion: 11,
    });

    // (a)(h) 저장소는 전혀 변하지 않는다.
    for (const r of H.store.runs) {
      const seeded = [rV8, rV10, outBefore, outAfter, outProvider, outBranded, outManual, outVersion, outWorkspace].find(
        (x) => x.id === r.id,
      )!;
      expect(r.scoreVersion).toBe(seeded.scoreVersion);
      expect(r.visibilityScore).toBe(seeded.visibilityScore);
    }
    expect(H.updateSetKeys).toHaveLength(0);
  });

  it("보류 구간(8/1~8/11)의 행은 v11·v12 어디서도 선택되지 않는다", async () => {
    seedRun(1, { createdAt: new Date("2026-08-01T03:00:00.000Z") });
    seedRun(2, { createdAt: new Date("2026-08-11T14:00:00.000Z") });

    const v11 = await (await POST(post({ job: "v11", dryRun: true, batchSize: 200 }))).json();
    expect(v11.processed).toBe(0);
    const v12 = await (await POST(post({ job: "v12", dryRun: true, batchSize: 200 }))).json();
    expect(v12.processed).toBe(0);
  });

  it("비운영 워크스페이스 행은 v12 에서 미선택 · v12t 에서만 선택", async () => {
    seedRun(1, {
      workspaceId: WS_TEST,
      createdAt: new Date("2026-08-15T03:00:00.000Z"),
    });
    seedRun(2, { createdAt: new Date("2026-08-15T03:10:00.000Z") }); // 운영

    const v12 = await (await POST(post({ job: "v12", dryRun: true, batchSize: 200 }))).json();
    expect((v12.changes as { id: string }[]).map((c) => c.id)).toEqual([id(2)]);

    const v12t = await (await POST(post({ job: "v12t", dryRun: true, batchSize: 200 }))).json();
    expect((v12t.changes as { id: string }[]).map((c) => c.id)).toEqual([id(1)]);
  });
});

/* ============================================================
 * (c)(e) 커서
 * ============================================================ */

describe("(c)(e) 커서 전진", () => {
  it("배치 경계에서 nextCursor 로 이어 처리 (createdAt, id) 순", async () => {
    seedRun(1, { createdAt: inWindowAt(1) });
    seedRun(2, { createdAt: inWindowAt(2) });
    seedRun(3, { createdAt: inWindowAt(3) });
    seedRun(4, { createdAt: inWindowAt(4) });

    const b1 = await (await POST(post({ job: "v11", apply: true, batchSize: 2 }))).json();
    expect(b1.processed).toBe(2);
    expect(b1.updated).toBe(2);
    expect(b1.nextCursor.id).toBe(id(2));
    expect(b1.remainingAfterCursor).toBe(2);

    const b2 = await (
      await POST(post({ job: "v11", apply: true, batchSize: 2, cursor: b1.nextCursor }))
    ).json();
    expect(b2.processed).toBe(2);
    expect(b2.nextCursor.id).toBe(id(4));
    expect(b2.remainingAfterCursor).toBe(0);
    expect(b2.residualTotal).toBe(0);

    for (const n of [1, 2, 3, 4]) {
      const r = H.store.runs.find((x) => x.id === id(n))!;
      expect(r.visibilityScore).toBe(TARGET_LOW60);
      expect(r.scoreVersion).toBe(11);
    }
  });

  it("createdAt 이 같은 행은 id 로 갈라 커서가 멈추지 않는다", async () => {
    const same = inWindowAt(5);
    seedRun(1, { createdAt: same });
    seedRun(2, { createdAt: same });
    seedRun(3, { createdAt: same });

    const b1 = await (await POST(post({ job: "v11", apply: true, batchSize: 1 }))).json();
    expect(b1.nextCursor.id).toBe(id(1));
    const b2 = await (
      await POST(post({ job: "v11", apply: true, batchSize: 1, cursor: b1.nextCursor }))
    ).json();
    expect(b2.processed).toBe(1);
    expect(b2.nextCursor.id).toBe(id(2));
    const b3 = await (
      await POST(post({ job: "v11", apply: true, batchSize: 1, cursor: b2.nextCursor }))
    ).json();
    expect(b3.nextCursor.id).toBe(id(3));
    expect(b3.remainingAfterCursor).toBe(0);
  });

  /* ────────────────────────────────────────────────────────────
   * 마이크로초 커서 회귀 (운영 dry-run 에서만 드러난 결함)
   *
   * 운영 실측: 배치당 감소폭이 100 이 아니라 99 였고, 마지막 1건이 영원히 남아
   * 배치 상한(1000)에 걸렸다. manifest 가 2,790 줄이 아니라 3,786 줄로 나왔다.
   *
   * 원인은 `created_at` 의 마이크로초 자리다. 드라이버가 JS Date 로 옮기며 밀리초로
   * 자르면 커서가 자기 행보다 작아져 그 행이 다음 배치에 다시 걸린다.
   * 종전 하네스는 저장소를 Date 로만 채워 이 결함을 **재현할 수 없었다**.
   * ──────────────────────────────────────────────────────────── */
  describe("마이크로초 커서 — 배치 경계 중복 없음", () => {
    /** 같은 밀리초 안에서 마이크로초만 다른 시각. */
    const usAt = (minutes: number, micros: number) => {
      const base = inWindowAt(minutes).toISOString().slice(0, -1); // ...T03:mm:00.000
      return `${base}${String(micros).padStart(3, "0")}Z`;
    };

    // ⚠️ dry-run 으로 확인한다. apply 모드는 처리한 행의 score_version 이 바뀌어 대상에서
    //    빠지므로 재선택 중복이 **가려진다**(운영에서도 dry-run 에서만 드러난 이유다).
    it("마이크로초를 가진 행들을 3배치로 훑어도 id 집합이 정확히 disjoint 하다", async () => {
      const total = 6;
      for (let n = 1; n <= total; n += 1) {
        seedRun(n, { createdAt: inWindowAt(n), createdAtUs: usAt(n, n * 137) });
      }

      const seen: string[][] = [];
      let cursor: unknown = null;
      for (let batch = 0; batch < 3; batch += 1) {
        const b = await (await POST(post({ job: "v11", batchSize: 2, cursor }))).json();
        expect(b.processed).toBe(2);
        seen.push(b.changes.map((c: { id: string }) => c.id));
        cursor = b.nextCursor;
        expect(b.remainingAfterCursor).toBe(total - 2 * (batch + 1));
      }

      const flat = seen.flat();
      // 중복 0 · 누락 0 — 배치별 집합이 서로 겹치지 않고 전량을 덮는다.
      expect(new Set(flat).size).toBe(total);
      expect(flat.sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => id(n)).sort());
    });

    it("마지막 행에서 잔여가 0 으로 떨어진다(정체 없음)", async () => {
      seedRun(1, { createdAt: inWindowAt(1), createdAtUs: usAt(1, 11) });
      seedRun(2, { createdAt: inWindowAt(2), createdAtUs: usAt(2, 985) });

      const b1 = await (
        await POST(post({ job: "v11", apply: true, batchSize: 1 }))
      ).json();
      expect(b1.remainingAfterCursor).toBe(1);
      expect(b1.nextCursor.createdAtUs).toBe(usAt(1, 11));

      const b2 = await (
        await POST(post({ job: "v11", apply: true, batchSize: 1, cursor: b1.nextCursor }))
      ).json();
      expect(b2.processed).toBe(1);
      expect(b2.changes[0].id).toBe(id(2));
      // 종전 코드에서는 여기가 1 로 굳어 스윕이 끝나지 않았다.
      expect(b2.remainingAfterCursor).toBe(0);
    });

    it("dry-run 도 커서가 끝까지 전진한다(행을 바꾸지 않아 잔여가 스스로 줄지 않는다)", async () => {
      for (let n = 1; n <= 3; n += 1) {
        seedRun(n, { createdAt: inWindowAt(n), createdAtUs: usAt(n, 999) });
      }

      let cursor: unknown = null;
      const ids: string[] = [];
      for (let batch = 0; batch < 3; batch += 1) {
        const b = await (await POST(post({ job: "v11", batchSize: 1, cursor }))).json();
        expect(b.dryRun).toBe(true);
        expect(b.processed).toBe(1);
        ids.push(b.changes[0].id);
        cursor = b.nextCursor;
      }
      expect(new Set(ids).size).toBe(3);
      // dry-run 이라 창 전체 잔여는 그대로지만 커서 뒤 잔여는 0 이어야 끝난다.
      const lastRemaining = await (
        await POST(post({ job: "v11", batchSize: 1, cursor }))
      ).json();
      expect(lastRemaining.processed).toBe(0);
      expect(lastRemaining.remainingAfterCursor).toBe(0);
    });

    it("밀리초까지만 담긴 커서는 거절한다(잘린 커서 재유입 차단)", async () => {
      const res = await POST(
        post({ job: "v11", cursor: { createdAtUs: "2026-07-15T03:01:00.000Z", id: id(1) } }),
      );
      expect(res.status).toBe(400);
    });
  });

  it("(e) 전량 anomaly 배치에서도 커서가 전진하고 잔여가 감소한다", async () => {
    seedRun(1, { score: 999, createdAt: inWindowAt(1) });
    seedRun(2, { score: 998, createdAt: inWindowAt(2) });

    const b = await (await POST(post({ job: "v11", apply: true, batchSize: 200 }))).json();
    expect(b.processed).toBe(2);
    expect(b.updated).toBe(0);
    expect(b.anomalies).toHaveLength(2);
    expect(b.anomalyCounts["no-candidate"]).toBe(2);
    expect(b.nextCursor.id).toBe(id(2));
    expect(b.remainingAfterCursor).toBe(0);
    // 잔여(창 전체)는 anomaly 로 남은 2건 — 종료 후 postcondition 확인용
    expect(b.residualTotal).toBe(2);
    for (const n of [1, 2]) {
      expect(H.store.runs.find((x) => x.id === id(n))!.scoreVersion).toBe(10);
    }
  });

  it("anomaly 행을 지나 뒤의 정상 행을 처리한다", async () => {
    seedRun(1, { score: 999, createdAt: inWindowAt(1) });
    seedRun(2, { createdAt: inWindowAt(2) });

    const b = await (await POST(post({ job: "v11", apply: true, batchSize: 200 }))).json();
    expect(b.updated).toBe(1);
    expect(b.anomalies[0].id).toBe(id(1));
    expect(H.store.runs.find((x) => x.id === id(2))!.visibilityScore).toBe(TARGET_LOW60);
    expect(H.store.runs.find((x) => x.id === id(1))!.visibilityScore).toBe(999);
  });
});

/* ============================================================
 * (d)(j)(l)(n) 적용 · CAS · 트랜잭션
 * ============================================================ */

describe("(d) 3중 CAS", () => {
  it("조회 이후 점수가 바뀐 행은 conflicted 로만 집계되고 덮어쓰지 않는다", async () => {
    seedRun(1, { createdAt: inWindowAt(1) });
    seedRun(2, { createdAt: inWindowAt(2) });

    // 조회와 UPDATE 사이에 제3자가 2번 행의 점수만 바꾼 상황.
    H.setBeforeTransaction(() => {
      const r = H.store.runs.find((x) => x.id === id(2))!;
      r.visibilityScore = 77;
    });

    const b = await (await POST(post({ job: "v11", apply: true, batchSize: 200 }))).json();
    expect(b.updated).toBe(1);
    expect(b.conflicted).toBe(1);
    expect((b.changes as { id: string }[]).map((c) => c.id)).toEqual([id(1)]);

    const r2 = H.store.runs.find((x) => x.id === id(2))!;
    expect(r2.visibilityScore).toBe(77); // 덮어쓰지 않음
    expect(r2.scoreVersion).toBe(10); // 버전도 그대로
  });

  it("버전만 바뀐 경우에도 CAS 로 걸러진다", async () => {
    seedRun(1, { createdAt: inWindowAt(1) });
    H.setBeforeTransaction(() => {
      H.store.runs.find((x) => x.id === id(1))!.scoreVersion = 12;
    });
    const b = await (await POST(post({ job: "v11", apply: true, batchSize: 200 }))).json();
    expect(b.updated).toBe(0);
    expect(b.conflicted).toBe(1);
    expect(H.store.runs[0].scoreVersion).toBe(12);
  });
});

describe("(j) sentiment 는 UPDATE 대상이 아니다", () => {
  it("SET 절 키가 visibilityScore·scoreVersion 둘뿐", async () => {
    seedRun(1, { sentiment: "neutral" });
    await POST(post({ job: "v11", apply: true, batchSize: 200 }));
    expect(H.updateSetKeys.length).toBeGreaterThan(0);
    for (const keys of H.updateSetKeys) {
      expect(keys.sort()).toEqual(["scoreVersion", "visibilityScore"]);
      expect(keys).not.toContain("sentiment");
    }
    expect(H.store.runs[0].sentiment).toBe("neutral");
  });
});

describe("(l) 배치 중간 예외 → 그 배치 전량 롤백", () => {
  it("앞 행이 이미 갱신됐어도 예외 시 전부 되돌아간다", async () => {
    seedRun(1, { createdAt: inWindowAt(1) });
    seedRun(2, { createdAt: inWindowAt(2) });
    seedRun(3, { createdAt: inWindowAt(3) });
    H.setThrowOnUpdateId(id(3));

    const res = await POST(post({ job: "v11", apply: true, batchSize: 200 }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
    expect(body.nextCursor).toBeNull(); // 이 배치는 처음부터 재개

    for (const n of [1, 2, 3]) {
      const r = H.store.runs.find((x) => x.id === id(n))!;
      expect(r.scoreVersion).toBe(10);
      expect(r.visibilityScore).toBe(STORED_V10);
    }
  });
});

describe("(n) 멱등", () => {
  it("같은 스윕을 두 번 돌리면 두 번째는 대상 0 · 점수 이중 이동 없음", async () => {
    seedRun(1, { createdAt: inWindowAt(1) });
    seedRun(2, { createdAt: inWindowAt(2) });

    const b1 = await (await POST(post({ job: "v11", apply: true, batchSize: 200 }))).json();
    expect(b1.updated).toBe(2);
    const after1 = H.store.runs.map((r) => ({ id: r.id, v: r.visibilityScore, ver: r.scoreVersion }));

    const b2 = await (await POST(post({ job: "v11", apply: true, batchSize: 200 }))).json();
    expect(b2.processed).toBe(0);
    expect(b2.updated).toBe(0);
    expect(b2.residualTotal).toBe(0);

    const after2 = H.store.runs.map((r) => ({ id: r.id, v: r.visibilityScore, ver: r.scoreVersion }));
    expect(after2).toEqual(after1);
  });
});

/* ============================================================
 * (k) 교차 진단
 * ============================================================ */

describe("(k) 재현 불가·모호 행은 점수가 변하지 않는다", () => {
  it("선언 세트로 재현되지 않으면 no-candidate 로 skip", async () => {
    // v8 로 선언됐지만 저장값이 v10 세트 값(56) — legacy8 로는 재현 불가.
    seedRun(1, { version: 8, score: STORED_V10 });
    const b = await (await POST(post({ job: "v11", apply: true, batchSize: 200 }))).json();
    expect(b.updated).toBe(0);
    expect(b.anomalies[0]).toMatchObject({ reason: "no-candidate" });
    const r = H.store.runs[0];
    expect(r.visibilityScore).toBe(STORED_V10);
    expect(r.scoreVersion).toBe(8);
  });

  it("resolved 행에는 재현한 세트 목록이 함께 나온다", async () => {
    seedRun(1, { version: 10, score: STORED_V10 });
    const b = await (await POST(post({ job: "v11", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes).toHaveLength(1);
  });
});

/* ============================================================
 * SQL / JS 판정 불일치 방어
 * ============================================================ */

describe("SQL 이 고른 행을 JS 가 거부하면 아무것도 적용하지 않고 중단한다", () => {
  it("409 selector_mismatch — 저장소 변화 0", async () => {
    // SQL 은 고르지만 JS 판정은 거부하는 상황을 재현한다.
    // (실제로는 ILIKE 의 와일드카드·이스케이프 해석이 JS includes 와 갈릴 때 발생한다.)
    seedRun(1, { createdAt: inWindowAt(1) });
    const mismatched = seedRun(2, { createdAt: inWindowAt(2) });
    (mismatched as unknown as { isAuto: unknown }).isAuto = 1; // boolean 이 아님 → JS 는 거부

    const res = await POST(post({ job: "v11", apply: true, batchSize: 200 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("selector_mismatch");
    expect(body.mismatchTotal).toBe(1);
    expect(body.mismatchCounts).toEqual({ "manual-jsmismatch": 1 });
    expect(body.mismatches[0].id).toBe(id(2));

    for (const r of H.store.runs) {
      expect(r.scoreVersion).toBe(10);
      expect(r.visibilityScore).toBe(STORED_V10);
    }
    expect(H.updateSetKeys).toHaveLength(0);
  });

  /**
   * 이스케이프 회귀 — 별칭에 LIKE 와일드카드가 있어도 SQL·JS 판정이 갈리지 않아야 한다.
   *
   * 이스케이프 이전에는 `요가%원` 이 ILIKE 에서 "요가"+임의문자열+"원" 으로 넓게 매칭돼
   * 브랜드 질의로 잡혔지만, JS `includes("요가%원")` 은 리터럴이라 안 잡혔다.
   */
  for (const alias of ["요가%원", "요가_원"]) {
    it(`별칭에 와일드카드(${alias})가 있어도 SQL·JS 브랜드 판정이 일치한다`, async () => {
      H.store.workspaces.length = 0;
      H.store.workspaces.push({
        id: WS_PROD,
        brandConfig: { brandName: alias, brandAliases: "", websites: [] },
        isProduction: true,
      });
      seedRun(1, { promptText: "요가원 어때요" }); // 와일드카드로만 매칭되던 프롬프트
      seedRun(2, { promptText: GEN_PROMPT });

      const b = await (await POST(post({ job: "v11", preflight: true }))).json();
      expect(b.brandedParityOk).toBe(true);
      expect(b.sqlInformationalCount).toBe(2);
      expect(b.jsInformationalCount).toBe(2);
    });
  }

  it("별칭이 리터럴로 들어 있으면 여전히 브랜드 질의로 잡힌다", async () => {
    H.store.workspaces.length = 0;
    H.store.workspaces.push({
      id: WS_PROD,
      brandConfig: { brandName: "요가%원", brandAliases: "", websites: [] },
      isProduction: true,
    });
    seedRun(1, { promptText: "요가%원 어때요" });
    seedRun(2, { promptText: GEN_PROMPT });

    const b = await (await POST(post({ job: "v11", preflight: true }))).json();
    expect(b.brandedParityOk).toBe(true);
    expect(b.sqlInformationalCount).toBe(1);
    expect(b.jsInformationalCount).toBe(1);
  });
});

/* ============================================================
 * 별칭 파싱 이원화 방어 (termParity)
 * ============================================================ */

describe("preflight 는 수집 경로와 재산출 경로의 별칭 파싱을 대조한다", () => {
  const setWorkspace = (brandAliases: string) => {
    H.store.workspaces.length = 0;
    H.store.workspaces.push({
      id: WS_PROD,
      brandConfig: { brandName: "요가원", brandAliases, websites: [] },
      isProduction: true,
    });
  };

  it("쉼표만 쓰면 두 파싱이 같다 → termParityOk", async () => {
    setWorkspace("매직바디, MagicBody");
    seedRun(1);
    const b = await (await POST(post({ job: "v11", preflight: true }))).json();
    expect(b.termParityOk).toBe(true);
    expect(b.termCount).toBe(3); // 본명 + 별칭 2
    expect(b.termDiffSample).toEqual([]);
  });

  it("별칭에 세미콜론이 섞이면 파싱이 갈린다 → termParityOk=false", async () => {
    // 수집 경로는 쉼표만 자르므로 "A;B" 를 한 덩어리로 본다.
    setWorkspace("매직바디;MagicBody");
    seedRun(1);
    const b = await (await POST(post({ job: "v11", preflight: true }))).json();
    expect(b.termParityOk).toBe(false);
    expect(b.termDiffSample[0].workspaceId).toBe(WS_PROD);
    expect(b.termDiffSample[0].onlyInCollectionPath).toEqual(["매직바디;magicbody"]);
    expect(b.termDiffSample[0].onlyInRescorePath.sort()).toEqual(["magicbody", "매직바디"]);
  });

  it("별칭에 줄바꿈이 섞여도 갈린다", async () => {
    setWorkspace("매직바디\nMagicBody");
    seedRun(1);
    const b = await (await POST(post({ job: "v11", preflight: true }))).json();
    expect(b.termParityOk).toBe(false);
  });
});

/* ============================================================
 * 범위 워크스페이스 0개
 * ============================================================ */

describe("범위 안 워크스페이스가 없으면 아무 행도 고르지 않는다", () => {
  it("비운영 워크스페이스가 없으면 v12t 대상은 0 (sql`false` 분기)", async () => {
    // 운영 워크스페이스만 남긴다 — v12t 는 비운영 범위라 조회 결과가 빈다.
    H.store.workspaces = H.store.workspaces.filter((w) => w.isProduction === true);
    seedRun(1, { workspaceId: WS_TEST, createdAt: new Date("2026-08-15T03:00:00.000Z") });
    seedRun(2, { createdAt: new Date("2026-08-15T03:10:00.000Z") });

    const b = await (await POST(post({ job: "v12t", apply: true, batchSize: 200 }))).json();
    expect(b.workspaceCount ?? 0).toBe(0);
    expect(b.processed).toBe(0);
    expect(b.residualTotal).toBe(0);
    expect(H.updateSetKeys).toHaveLength(0);
  });

  it("preflight 도 0 을 보고한다", async () => {
    H.store.workspaces = H.store.workspaces.filter((w) => w.isProduction === true);
    seedRun(1, { workspaceId: WS_TEST, createdAt: new Date("2026-08-15T03:00:00.000Z") });

    const b = await (await POST(post({ job: "v12t", preflight: true }))).json();
    expect(b.workspaceCount).toBe(0);
    expect(b.windowTotal).toBe(0);
    expect(b.targetCount).toBe(0);
  });
});

/* ============================================================
 * (m) 실행 식별자
 * ============================================================ */

describe("(m) 실행 식별자·설정 지문", () => {
  it("응답에 operationId·jobHash·codeSha·cfgFingerprint 가 실린다", async () => {
    seedRun(1);
    const op = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const b = await (
      await POST(post({ job: "v11", dryRun: true, operationId: op, codeSha: "abc123" }))
    ).json();
    expect(b.operationId).toBe(op);
    expect(b.codeSha).toBe("abc123");
    expect(b.jobHash).toBe(jobHash("v11"));
    expect(b.cfgFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(b.job).toBe("v11");
  });

  it("manifest 한 줄에 저장소 밖 기대값과 대조할 좌표(kstDate·provider·promptKey)가 실린다", async () => {
    seedRun(1, { createdAt: new Date("2026-07-15T15:30:00.000Z") }); // KST 7/16
    const b = await (await POST(post({ job: "v11", dryRun: true }))).json();
    const change = (b.changes as {
      id: string;
      kstDate: string;
      provider: string;
      promptKey: string;
    }[])[0];
    expect(change.kstDate).toBe("2026-07-16");
    expect(change.provider).toBe("google_ai");
    expect(change.promptKey).toBe(promptKey(GEN_PROMPT));
  });

  it("live 로 실제 적용된 줄에도 같은 좌표가 실린다", async () => {
    seedRun(1, { createdAt: new Date("2026-07-15T15:30:00.000Z") });
    const b = await (await POST(post({ job: "v11", apply: true }))).json();
    expect(b.updated).toBe(1);
    expect((b.changes as { promptKey: string }[])[0].promptKey).toBe(promptKey(GEN_PROMPT));
  });
});

/* ============================================================
 * (f) preflight
 * ============================================================ */

describe("(f) preflight", () => {
  it("소스·목표 버전 밖 자동 수집 행이 있으면 clean=false", async () => {
    seedRun(1, { version: 10 });
    seedRun(2, { version: 8, score: STORED_V8 });
    seedRun(3, { version: 9, score: 40 }); // 매핑 없는 버전

    const b = await (await POST(post({ job: "v11", preflight: true }))).json();
    expect(b.mode).toBe("preflight");
    expect(b.clean).toBe(false);
    expect(b.outOfScopeCount).toBe(1);
    expect(b.targetCount).toBe(2);
  });

  it("창 안이 소스·목표 버전뿐이면 clean=true (재개 가능)", async () => {
    seedRun(1, { version: 10 });
    seedRun(2, { version: 11, score: TARGET_LOW60 }); // 이미 처리된 행
    const b = await (await POST(post({ job: "v11", preflight: true }))).json();
    expect(b.clean).toBe(true);
    expect(b.targetCount).toBe(1);
  });

  it("수동 수집 비율과 브랜드 판정 정합을 보고한다", async () => {
    seedRun(1); // 자동·일반
    seedRun(2); // 자동·일반
    seedRun(3, { isAuto: false }); // 수동·일반
    seedRun(4, { promptText: BRANDED_PROMPT }); // 브랜드 질의 — 창 밖(일반 검색 잡)

    const b = await (await POST(post({ job: "v11", preflight: true }))).json();
    expect(b.windowTotal).toBe(3); // 브랜드 질의 제외
    expect(b.manualCount).toBe(1);
    expect(b.manualRatio).toBeCloseTo(0.3333, 3);
    expect(b.brandedParityOk).toBe(true);
    expect(b.sqlInformationalCount).toBe(3);
    expect(b.jsInformationalCount).toBe(3);
  });

  it("KST 일자 × 버전 × 수집경로 분포를 반환한다", async () => {
    // KST 7/16 00:30 (UTC 7/15 15:30) — UTC 일자로 자르면 7/15 로 밀리는 경계
    seedRun(1, { createdAt: new Date("2026-07-15T15:30:00.000Z") });
    seedRun(2, { createdAt: new Date("2026-07-15T03:00:00.000Z") });

    const b = await (await POST(post({ job: "v11", preflight: true }))).json();
    const dates = (b.versionByDate as { kstDate: string }[]).map((d) => d.kstDate).sort();
    expect(dates).toEqual(["2026-07-15", "2026-07-16"]);
  });

  it("워크스페이스 분포는 범위 안 워크스페이스만 담는다", async () => {
    seedRun(1);
    seedRun(2, { workspaceId: WS_TEST });
    const b = await (await POST(post({ job: "v11", preflight: true }))).json();
    expect(b.workspaceDistribution).toEqual([{ workspaceId: WS_PROD, count: 1 }]);
    expect(b.workspaceCount).toBe(1);
  });
});

/* ============================================================
 * report
 * ============================================================ */

describe("report 모드 — 차트와 같은 필터로 창별 평균", () => {
  it("저품질·수동·브랜드 질의를 제외하고 KST 일자 × provider 로 묶는다", async () => {
    seedRun(1, { createdAt: inWindowAt(1), score: 60 });
    seedRun(2, { createdAt: inWindowAt(2), score: 40 });
    const low = seedRun(3, { createdAt: inWindowAt(3), score: 100 });
    (low as unknown as { parseQuality: string }).parseQuality = "low";
    seedRun(4, { createdAt: inWindowAt(4), score: 100, isAuto: false });
    seedRun(5, { createdAt: inWindowAt(5), score: 100, promptText: BRANDED_PROMPT });

    const b = await (await POST(post({ job: "v11", report: true }))).json();
    expect(b.mode).toBe("report");
    type ReportWindow = {
      key: string;
      total: number;
      overallAvg: number | null;
      byProvider: { provider: string; count: number; avg: number }[];
      byProviderDate: { kstDate: string; provider: string }[];
    };
    const target = (b.windows as ReportWindow[]).find((w) => w.key === "target")!;
    expect(target.total).toBe(2);
    expect(target.overallAvg).toBe(50);
    expect(target.byProvider).toEqual([{ provider: "google_ai", count: 2, avg: 50 }]);
    expect(target.byProviderDate[0].kstDate).toBe("2026-07-15");
  });

  it("불변 창(보류·창 이전·다른 provider)이 함께 나온다", async () => {
    seedRun(1, { createdAt: new Date("2026-08-05T03:00:00.000Z"), score: 30 }); // 보류 구간
    seedRun(2, { createdAt: new Date("2026-06-20T03:00:00.000Z"), score: 20 }); // 창 이전
    seedRun(3, { createdAt: inWindowAt(1), provider: "gemini", score: 10 }); // 잡 밖 provider

    const b = await (await POST(post({ job: "v11", report: true }))).json();
    const byKey = new Map(
      (b.windows as { key: string; total: number; overallAvg: number | null }[]).map((w) => [
        w.key,
        w,
      ]),
    );
    expect(byKey.get("holdout")).toMatchObject({ total: 1, overallAvg: 30 });
    expect(byKey.get("before-target")).toMatchObject({ total: 1, overallAvg: 20 });
    expect(byKey.get("other-providers")).toMatchObject({ total: 1, overallAvg: 10 });
    expect(byKey.get("target")).toMatchObject({ total: 0, overallAvg: null });
  });

  it("report 는 쓰기를 하지 않는다", async () => {
    seedRun(1);
    await POST(post({ job: "v11", report: true }));
    expect(H.updateSetKeys).toHaveLength(0);
    expect(H.store.runs[0].scoreVersion).toBe(10);
  });
});

/* ============================================================
 * v12 잡
 * ============================================================ */

describe("v12 잡 — 전 provider · 브랜드 질의 포함", () => {
  const v12At = (m: number) =>
    new Date(new Date("2026-08-15T03:00:00.000Z").getTime() + m * 60_000);

  it("provider 무관하게 선택하고 목표 세트는 v12b", async () => {
    seedRun(1, { createdAt: v12At(1), provider: "gemini" });
    seedRun(2, { createdAt: v12At(2), provider: "chatgpt" });

    const b = await (await POST(post({ job: "v12", apply: true, batchSize: 200 }))).json();
    expect(b.processed).toBe(2);
    expect(b.targetSet).toBe("v12b");
    const expected = calcVisibilityWithSet(genInputs(false), SCORE_SETS.v12b); // 50+11+13 = 74
    expect(expected).toBe(74);
    for (const n of [1, 2]) {
      const r = H.store.runs.find((x) => x.id === id(n))!;
      expect(r.visibilityScore).toBe(74);
      expect(r.scoreVersion).toBe(12);
    }
  });

  it("브랜드 질의 행도 대상이며 브랜드 분기 상수가 그대로라 점수가 유지된다", async () => {
    // 브랜드 분기: 긍정 34 + 참고자료 없음 → full10 34, v12b 34 (동일)
    seedRun(1, {
      createdAt: v12At(1),
      promptText: BRANDED_PROMPT,
      sentiment: "positive",
      score: 34,
    });
    const b = await (await POST(post({ job: "v12", apply: true, batchSize: 200 }))).json();
    expect(b.processed).toBe(1);
    const r = H.store.runs[0];
    expect(r.visibilityScore).toBe(34); // 값 불변
    expect(r.scoreVersion).toBe(12); // 버전만 전진
  });
});
