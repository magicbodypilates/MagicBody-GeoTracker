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
  const store: { runs: Row[]; workspaces: Row[]; brandYoutubeVideos: Row[] } = {
    runs: [],
    workspaces: [],
    brandYoutubeVideos: [],
  };
  type TableName = "runs" | "workspaces" | "brandYoutubeVideos";

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
    let rows = store[table.__table as TableName].filter((r) => match(r, where));
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
          const rows = store[table.__table as TableName];
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
      "citedOwnedVideoIds",
      "citedPressDomains",
      "citedSocialDomains",
    ]),
    workspaces: mkTable("workspaces", ["id", "brandConfig", "isProduction"]),
    // __table 은 store 의 프로퍼티 키(camelCase)와 일치해야 한다 — runSelect/updateBuilder 가
    // store[table.__table] 로 조회하기 때문이다(runs·workspaces 도 이 관례를 따른다).
    brandYoutubeVideos: mkTable("brandYoutubeVideos", ["id", "workspaceId", "videoId", "isActive"]),
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
    store.brandYoutubeVideos = [];
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
import { _clearOwnedVideoCache } from "@/lib/server/brand-youtube-videos";
// 결함 D2 동치 테스트(파일 끝) 전용 — 수집 경로 채점을 진짜 함수로 돌린다.
import { buildAutoRunValues, buildScoringContext, type AutoRunTarget } from "@/lib/server/automation-runner";
import type { BrandConfig, ScoringSetSwitchValue } from "@/drizzle/schema";
import type { LlmClassification } from "@/lib/server/llm-sentiment";

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
  hasPressCitation: false,
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
  /** v15(소유 유튜브·언론) 테스트 전용 — 기본은 빈 배열. */
  citations?: { url?: string | null; domain?: string | null; title?: string | null; description?: string | null }[];
  /**
   * v16(reproFromStoredEvidence) 테스트 전용 — "그때 이미 저장된 증거"를 직접 시드한다.
   * 기본은 빈 배열(DB NOT NULL DEFAULT '{}' 와 동일 계약).
   */
  citedOwnedVideoIds?: string[];
  citedPressDomains?: string[];
  citedSocialDomains?: string[];
};

function seedRun(n: number, opts: SeedOpts = {}) {
  const row = {
    id: id(n),
    workspaceId: opts.workspaceId ?? WS_PROD,
    promptText: opts.promptText ?? GEN_PROMPT,
    provider: opts.provider ?? "google_ai",
    answer: opts.answer ?? GEN_ANSWER,
    citations: opts.citations ?? ([] as unknown[]),
    sentiment: opts.sentiment ?? "neutral",
    visibilityScore: opts.score ?? STORED_V10,
    scoreVersion: opts.version ?? 10,
    isAuto: opts.isAuto ?? true,
    parseQuality: "high",
    createdAt: opts.createdAt ?? inWindowAt(n),
    citedOwnedVideoIds: opts.citedOwnedVideoIds ?? [],
    citedPressDomains: opts.citedPressDomains ?? [],
    citedSocialDomains: opts.citedSocialDomains ?? [],
    ...(opts.createdAtUs ? { createdAtUs: opts.createdAtUs } : {}),
  };
  H.store.runs.push(row);
  return row;
}

function seedWorkspaces() {
  H.store.workspaces.push({ id: WS_PROD, brandConfig: BRAND_CONFIG, isProduction: true });
  H.store.workspaces.push({ id: WS_TEST, brandConfig: BRAND_CONFIG, isProduction: false });
}

/** v15 테스트 전용 — 소유 유튜브 영상 시드(brand_youtube_videos). */
function seedOwnedVideo(workspaceId: string, videoId: string, isActive = true) {
  H.store.brandYoutubeVideos.push({
    id: `owned-${videoId}`,
    workspaceId,
    videoId,
    isActive,
  });
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
  // getOwnedYoutubeVideoIds 는 모듈 레벨 TTL 캐시(60s)를 쓴다 — 비우지 않으면 이전 테스트의
  // 소유 영상 Set 이 다음 테스트로 새어 들어간다(브랜드 워크스페이스 id 는 매번 같으므로).
  _clearOwnedVideoCache();
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
    // ⛔ D0-b(계획 §5 Step 6) — v15 는 이제 등록된 잡이다. 2026-09-23 개정으로 v16 도,
    // 2026-09-24 개정으로 v17 도 등록됐다. 존재하지 않는 잡 id 예시는 v18 로.
    expect((await POST(post({ job: "v18" }))).status).toBe(400);
    expect((await POST(post({ job: "v14t" }))).status).toBe(400);
    expect((await POST(post({ job: "v13t" }))).status).toBe(400);
    expect((await POST(post({ job: "v15t" }))).status).toBe(400);
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

/* ============================================================
 * v15 잡 — 계획 geotracker-youtube-press-scoring-260923 §5 Step 6
 *
 * v11~v14 와 달리 v15 는 job.applyOwnedCitationJudgment=true 라 targetBase 가 reproBase 와
 * 갈린다(D0). 이 블록은 그 새 판정이 실제로 라우트를 관통해 (a) 점수를 바꾸고 (b) 증거
 * 컬럼을 동시 백필하고 (c) 언론은 점수를 안 바꾸면서도 증거는 남기고 (d) 스위치가 꺼진
 * 잡(v14)은 owned-video 데이터가 있어도 전혀 영향받지 않는지를 검증한다.
 * ============================================================ */

describe("v15 잡 — 소스 버전 14 하나 · v14a → v15a", () => {
  // 2026-09-23 개정 — v15 의 대상 창 하한이 KST 2026-09-21 00:00(= UTC 2026-09-20T15:00)으로
  // 바뀌었다. 옛 하한(8/24) 기준 시드는 더 이상 v15 대상에 안 걸리므로 새 하한 기준으로 옮긴다.
  const v15At = (m: number) => new Date(new Date("2026-09-21T03:00:00.000Z").getTime() + m * 60_000);
  const OWNED_ID = "dQw4w9WgXcQ";

  it("meta: 소스 버전 14 · 목표 v15a · jobHash 가 v14 와 다르다(D0-b 회귀 없음)", async () => {
    const body = await (await POST(post({ job: "v15", meta: true }))).json();
    expect(body.mode).toBe("meta");
    expect(body.sourceVersions).toEqual([14]);
    expect(body.targetVersion).toBe(15);
    expect(body.targetSet).toBe("v15a");
    expect(body.jobHash).toBe(jobHash("v15"));
    expect(body.jobHash).not.toBe(jobHash("v14"));
  });

  it("소유 유튜브 인용도 언론 인용도 없으면 v15a 출력이 v14a 와 완전히 같다(동작 변화 0)", async () => {
    // 일반 검색·언급 0·URL 신호 전혀 없음 — 옛 판정·새 판정이 똑같이 0 을 만든다.
    seedRun(1, { version: 14, score: 0, createdAt: v15At(1), answer: "무관한 답변" });
    const b = await (await POST(post({ job: "v15", apply: true, batchSize: 200 }))).json();
    expect(b.processed).toBe(1);
    expect(b.updated).toBe(1);
    const r = H.store.runs[0];
    expect(r.visibilityScore).toBe(0);
    expect(r.scoreVersion).toBe(15);
    expect(r.citedOwnedVideoIds).toEqual([]);
    expect(r.citedPressDomains).toEqual([]);
    expect(r.citedSocialDomains).toEqual([]);
  });

  it("소유 유튜브 영상 인용 — hasCitationOnly 로 접혀 점수가 45 로 뛰고 증거가 백필된다", async () => {
    seedOwnedVideo(WS_PROD, OWNED_ID);
    seedRun(1, {
      version: 14,
      score: 0,
      createdAt: v15At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citations: [{ url: `https://youtu.be/${OWNED_ID}` }],
    });

    const b = await (await POST(post({ job: "v15", dryRun: true, batchSize: 200 }))).json();
    expect(b.processed).toBe(1);
    expect(b.anomalies).toHaveLength(0);
    const change = b.changes[0];
    expect(change.before).toBe(0);
    expect(change.after).toBe(45); // v14a·v15a genNoMentionCitation
    expect(change.citedOwnedVideoIds).toEqual([OWNED_ID]);
    expect(change.citedPressDomains).toEqual([]);
    expect(change.citedSocialDomains).toEqual([]);

    // apply 로도 동일하게 적용되는지 별도 확인
    const applied = await (await POST(post({ job: "v15", apply: true, batchSize: 200 }))).json();
    expect(applied.updated).toBe(1);
    const r = H.store.runs[0];
    expect(r.visibilityScore).toBe(45);
    expect(r.scoreVersion).toBe(15);
    expect(r.citedOwnedVideoIds).toEqual([OWNED_ID]);
  });

  it("소유 영상이 아닌 유튜브 인용은 여전히 미판정(오탐 없음)", async () => {
    seedOwnedVideo(WS_PROD, OWNED_ID); // 다른 영상만 소유
    seedRun(1, {
      version: 14,
      score: 0,
      createdAt: v15At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citations: [{ url: "https://youtu.be/aBcD_eF-123" }], // 소유 아님
    });
    const b = await (await POST(post({ job: "v15", dryRun: true, batchSize: 200 }))).json();
    expect(b.changes[0].after).toBe(0); // 점수 불변
    expect(b.changes[0].citedOwnedVideoIds).toEqual([]);
  });

  it("언론(제3자) 인용 — 증거는 백필되지만 배점이 0 이라 점수는 안 바뀐다(2026-09-23: 등록 도메인 개념 폐기)", async () => {
    // 매체 도메인 allowlist 를 없앴으므로(press-domain-match.ts) 워크스페이스 설정 오버라이드가
    // 필요 없다 — 브랜드 언급이 있고 우리 소유가 아니면 어떤 도메인이든 매칭된다.
    seedRun(1, {
      version: 14,
      score: 0,
      createdAt: v15At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citations: [
        { url: "https://press-wire.example/a", title: "요가원 관련 보도", description: null },
      ],
    });

    const b = await (await POST(post({ job: "v15", dryRun: true, batchSize: 200 }))).json();
    expect(b.changes[0].before).toBe(0);
    expect(b.changes[0].after).toBe(0); // 배점 0 — 점수 불변(계획 D4′)
    expect(b.changes[0].citedOwnedVideoIds).toEqual([]);
    expect(b.changes[0].citedPressDomains).toEqual(["press-wire.example"]);
    expect(b.changes[0].citedSocialDomains).toEqual([]);
  });

  it("⭐ 3차 개정 — 블로그·소셜 추천(제3자) 인용도 증거로 백필되지만 배점이 0 이라 점수는 안 바뀐다", async () => {
    // 직전(2차) 개정에서는 소셜 플랫폼을 통째로 제외해 이 시나리오가 citedPressDomains·
    // citedSocialDomains 어느 쪽에도 안 남았다. 3차 개정은 "블로그·소셜 추천"으로 분류해
    // citedSocialDomains 에 남긴다 — 언론과 같은 이유로 배점은 여전히 0 이다.
    seedRun(1, {
      version: 14,
      score: 0,
      createdAt: v15At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citations: [
        { url: "https://www.instagram.com/p/AbCdEfGhIjK/", title: "요가원 추천 게시물", description: null },
      ],
    });

    const b = await (await POST(post({ job: "v15", dryRun: true, batchSize: 200 }))).json();
    expect(b.changes[0].before).toBe(0);
    expect(b.changes[0].after).toBe(0); // 배점 0 — 점수 불변
    expect(b.changes[0].citedOwnedVideoIds).toEqual([]);
    expect(b.changes[0].citedPressDomains).toEqual([]);
    expect(b.changes[0].citedSocialDomains).toEqual(["instagram.com"]);
  });

  it("브랜드 언급이 없는 인용은 어떤 도메인이든 증거로 남지 않는다(언론·소셜 둘 다)", async () => {
    seedRun(1, {
      version: 14,
      score: 0,
      createdAt: v15At(1),
      answer: "무관한 답변",
      citations: [
        { url: "https://some-outlet.example/a", title: "브랜드와 무관한 기사" },
        { url: "https://www.instagram.com/p/UnrelatedPost/", title: "브랜드와 무관한 게시물" },
      ],
    });
    const b = await (await POST(post({ job: "v15", dryRun: true, batchSize: 200 }))).json();
    expect(b.changes[0].citedPressDomains).toEqual([]);
    expect(b.changes[0].citedSocialDomains).toEqual([]);
  });

  it("우리 공식 웹사이트 인용은 브랜드 언급이 있어도 언론 증거에서 제외된다(중복 계산 방지)", async () => {
    H.store.workspaces.length = 0;
    H.store.workspaces.push({
      id: WS_PROD,
      brandConfig: { ...BRAND_CONFIG, websites: ["https://mysite.example"] },
      isProduction: true,
    });
    // 이 인용은 websites 에도 등록된 우리 사이트라 citedBrandDomains(기존 메커니즘)에도 동시에
    // 잡혀 hasCitationOnly=true 가 된다 — 그래서 재현 점수(v14a genNoMentionCitation=45)로
    // 시드해야 reproduction 이 성립한다. 확인하려는 것은 점수가 아니라 citedPressDomains 다:
    // 우리 사이트는 "브랜드 공식 인용"으로 이미 분류되므로 "언론(제3자) 인용"에는 중복으로
    // 잡히면 안 된다.
    seedRun(1, {
      version: 14,
      score: 45,
      createdAt: v15At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citations: [{ url: "https://mysite.example/notice", title: "요가원 공지사항" }],
    });
    const b = await (await POST(post({ job: "v15", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes[0].after).toBe(45); // v15a 도 같은 이유로 동일 — 점수는 바뀌지 않는다
    expect(b.changes[0].citedPressDomains).toEqual([]);
    expect(b.changes[0].citedSocialDomains).toEqual([]);
  });

  it("소유 유튜브 영상 인용은 citedOwnedVideoIds 로 잡히고 citedPressDomains·citedSocialDomains 로는 이중 계산되지 않는다", async () => {
    seedOwnedVideo(WS_PROD, OWNED_ID);
    seedRun(1, {
      version: 14,
      score: 0,
      createdAt: v15At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citations: [
        { url: `https://youtu.be/${OWNED_ID}`, title: "요가원 소개 영상" }, // 우리 영상 — 언론·소셜 증거 제외 대상
        { url: "https://press-wire.example/a", title: "요가원 관련 보도" }, // 제3자 언론 — 남아야 함
        { url: "https://www.instagram.com/p/AbCdEfGhIjK/", title: "요가원 추천 게시물" }, // 제3자 소셜 — 남아야 함
      ],
    });
    const b = await (await POST(post({ job: "v15", dryRun: true, batchSize: 200 }))).json();
    expect(b.changes[0].citedOwnedVideoIds).toEqual([OWNED_ID]);
    expect(b.changes[0].citedPressDomains).toEqual(["press-wire.example"]);
    expect(b.changes[0].citedSocialDomains).toEqual(["instagram.com"]);
  });

  it("응답에 cfgFingerprint·ownedVideoFingerprint 가 실린다(v15 만 소유 영상 지문 계산)", async () => {
    seedOwnedVideo(WS_PROD, OWNED_ID);
    seedRun(1, { version: 14, createdAt: v15At(1), score: 0, answer: "무관" });
    const b = await (await POST(post({ job: "v15", dryRun: true }))).json();
    expect(b.cfgFingerprint).toMatch(/^[0-9a-f]{12}$/);
    // 2026-09-23 제거 — 매체 도메인 allowlist 설정 자체가 없어져 지문을 낼 대상이 없다.
    expect(b.pressCfgFingerprint).toBeUndefined();
    expect(b.ownedVideoFingerprint).toMatchObject({ count: 1 });
    expect(b.ownedVideoFingerprint.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("v14 잡은 소유 영상 데이터가 있어도 전혀 영향받지 않는다(스위치 꺼짐 · ownedVideoFingerprint null)", async () => {
    seedOwnedVideo(WS_PROD, OWNED_ID);
    // v14 의 소스는 버전 12 — 같은 소유 영상을 인용해도 v14 는 옛 판정만 쓴다.
    seedRun(1, {
      version: 12,
      score: 0,
      createdAt: new Date("2026-08-24T03:00:00.000Z"),
      answer: "무관한 답변(브랜드 미언급)",
      citations: [{ url: `https://youtu.be/${OWNED_ID}` }],
    });
    const b = await (await POST(post({ job: "v14", dryRun: true, batchSize: 200 }))).json();
    expect(b.changes[0].before).toBe(0);
    expect(b.changes[0].after).toBe(0); // 소유 영상이 있어도 v14 는 절대 반영하지 않는다
    expect(b.changes[0].citedOwnedVideoIds).toBeUndefined();
    expect(b.changes[0].citedPressDomains).toBeUndefined();
    expect(b.changes[0].citedSocialDomains).toBeUndefined();
    expect(b.ownedVideoFingerprint).toBeNull();
  });

  it("apply 시에도 v14 는 증거 컬럼을 건드리지 않는다(UPDATE SET 절에서 제외)", async () => {
    seedOwnedVideo(WS_PROD, OWNED_ID);
    seedRun(1, {
      version: 12,
      score: 0,
      createdAt: new Date("2026-08-24T03:00:00.000Z"),
      answer: "무관한 답변",
      citations: [{ url: `https://youtu.be/${OWNED_ID}` }],
    });
    await POST(post({ job: "v14", apply: true, batchSize: 200 }));
    for (const keys of H.updateSetKeys) {
      expect(keys).not.toContain("citedOwnedVideoIds");
      expect(keys).not.toContain("citedPressDomains");
      expect(keys).not.toContain("citedSocialDomains");
    }
  });
});

/* ============================================================
 * v16 잡 — 2026-09-23 제3자 인용 판정 재설계(사장님 배점 확정)
 *
 * v15 와 달리 v16 의 소스 행(버전 15)은 **이미 새 판정으로 계산돼 있다.** 이 블록의 핵심은
 * (a) 저장된 증거 컬럼만으로 v15a 재현·v16a 목표를 계산하고 (b) 소유 영상 목록이 그 사이
 * 바뀌어도(주 2회 동기화) 영향받지 않으며 (c) 언론·소셜 배점(35)이 실제로 반영되고
 * (d) 증거 컬럼 자체는 다시 쓰지 않는지를 검증한다.
 * ============================================================ */

describe("v16 잡 — 소스 버전 15 하나 · v15a → v16a(reproFromStoredEvidence)", () => {
  // v15 와 완전히 같은 창(대상 창 하한 KST 2026-09-21 00:00).
  const v16At = (m: number) => new Date(new Date("2026-09-21T03:00:00.000Z").getTime() + m * 60_000);
  const OWNED_ID = "dQw4w9WgXcQ";

  it("meta: 소스 버전 15 · 목표 v16a · jobHash 가 v15 와 다르다(D0-b 회귀 없음)", async () => {
    const body = await (await POST(post({ job: "v16", meta: true }))).json();
    expect(body.mode).toBe("meta");
    expect(body.sourceVersions).toEqual([15]);
    expect(body.targetVersion).toBe(16);
    expect(body.targetSet).toBe("v16a");
    expect(body.jobHash).toBe(jobHash("v16"));
    expect(body.jobHash).not.toBe(jobHash("v15"));
  });

  it("증거가 전혀 없으면 점수는 그대로(0)지만 버전만 16으로 전진한다", async () => {
    seedRun(1, {
      version: 15,
      score: 0,
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
    });
    const b = await (await POST(post({ job: "v16", apply: true, batchSize: 200 }))).json();
    expect(b.processed).toBe(1);
    expect(b.updated).toBe(1);
    const r = H.store.runs[0];
    expect(r.visibilityScore).toBe(0);
    expect(r.scoreVersion).toBe(16);
  });

  it("저장된 언론 증거만 있으면 v16a 배점(35)이 실제로 반영된다(v15a 에선 0 이었다)", async () => {
    seedRun(1, {
      version: 15,
      score: 0, // v15a 시점: 언론 배점 0 이라 증거가 있어도 점수는 0 이었다.
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedPressDomains: ["press-wire.example"], // v15 채점 시점에 이미 저장된 증거.
    });
    const b = await (await POST(post({ job: "v16", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes[0].before).toBe(0);
    expect(b.changes[0].after).toBe(35); // v16a.genNoMentionPress
  });

  it("저장된 소셜 증거만 있으면 v16a 배점(35)이 실제로 반영된다", async () => {
    seedRun(1, {
      version: 15,
      score: 0,
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedSocialDomains: ["instagram.com"],
    });
    const b = await (await POST(post({ job: "v16", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes[0].before).toBe(0);
    expect(b.changes[0].after).toBe(35); // v16a.genNoMentionSocial
  });

  it("우리 채널 인용(citedOwnedVideoIds)만 있으면 점수는 그대로 45 — 배점을 건드리지 않았다", async () => {
    seedRun(1, {
      version: 15,
      score: 45, // v15a.genNoMentionCitation — v15 채점 시점에 이미 이 값으로 저장됨.
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedOwnedVideoIds: [OWNED_ID],
    });
    const b = await (await POST(post({ job: "v16", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes[0].before).toBe(45);
    expect(b.changes[0].after).toBe(45); // "우리 채널 인용 45점, 기존 그대로" — 사장님 지시
  });

  /**
   * ⭐⭐ 핵심 — 소유 영상 목록 드리프트 안전성(위험 ⓔ의 실제 검증).
   *
   * v15 가 이 행을 채점한 시점에는 OWNED_ID 가 소유 목록에 있어 citedOwnedVideoIds 로
   * 저장됐다(그래서 storedScore=45). 그런데 이 테스트는 seedOwnedVideo 를 **호출하지
   * 않는다** — v16 이 지금 돌 때는 그 영상이 더는 "라이브" 소유 목록에 없는 상황을
   * 시뮬레이션한다(주 2회 동기화 사이 비활성화·목록 갱신 등). deriveNewJudgmentRowInputs
   * (citations·라이브 목록에서 다시 판정)를 썼다면 hasCitationOnly 가 false 로 뒤집혀
   * v15a 재현이 0 을 만들고, storedScore(45) 와 어긋나 no-candidate 가 됐을 것이다.
   * deriveStoredEvidenceRowInputs 는 저장된 citedOwnedVideoIds 를 그대로 읽으므로 목록이
   * 바뀌어도 재현이 깨지지 않는다 — 이 테스트가 그 사실을 직접 증명한다.
   */
  it("소유 영상 목록이 v15 채점 이후 바뀌어도(테스트에서 재등록하지 않음) 재현이 깨지지 않는다", async () => {
    // seedOwnedVideo(WS_PROD, OWNED_ID) 를 의도적으로 호출하지 않는다.
    seedRun(1, {
      version: 15,
      score: 45,
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedOwnedVideoIds: [OWNED_ID], // v15 채점 시점의 저장된 증거만 있다.
    });
    const b = await (await POST(post({ job: "v16", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0); // no-candidate 가 아니다 — 라이브 목록과 무관하게 재현된다.
    expect(b.changes[0].before).toBe(45);
    expect(b.changes[0].after).toBe(45);
  });

  it("소유 영상 + 언론 증거가 섞여 있어도 각각 올바르게 반영된다(45 는 그대로, 언론은 없던 배점이 생김)", async () => {
    // 본문 URL 없음 + 브랜드 도메인 인용 없음 + 소유 영상 인용 있음 → hasCitationOnly=true
    // → v15a·v16a 모두 genNoMentionCitation(45) 분기로 먼저 빠진다(우선순위: URL > 인용 >
    // 언론/소셜, calcVisibilityWithSet 참조) — 언론 증거가 있어도 45 를 넘어서지 않는다.
    seedRun(1, {
      version: 15,
      score: 45,
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedOwnedVideoIds: [OWNED_ID],
      citedPressDomains: ["press-wire.example"],
    });
    const b = await (await POST(post({ job: "v16", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes[0].after).toBe(45); // 참고자료(45) 가 언론(35) 보다 우선
  });

  it("apply 로도 dry-run 과 동일하게 적용된다", async () => {
    seedRun(1, {
      version: 15,
      score: 0,
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedPressDomains: ["press-wire.example"],
    });
    const applied = await (await POST(post({ job: "v16", apply: true, batchSize: 200 }))).json();
    expect(applied.updated).toBe(1);
    const r = H.store.runs[0];
    expect(r.visibilityScore).toBe(35);
    expect(r.scoreVersion).toBe(16);
  });

  it("v16 은 증거 컬럼을 다시 쓰지 않는다(UPDATE SET 절에서 제외) — 이미 맞는 증거를 그대로 둔다", async () => {
    seedRun(1, {
      version: 15,
      score: 0, // v15a 시점 저장값(언론 배점 0) — v16 이 35 로 올리는 대상.
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedPressDomains: ["press-wire.example"],
    });
    await POST(post({ job: "v16", apply: true, batchSize: 200 }));
    expect(H.updateSetKeys.length).toBeGreaterThan(0);
    expect(H.store.runs[0].visibilityScore).toBe(35); // 점수는 실제로 올라간다.
    for (const keys of H.updateSetKeys) {
      expect(keys).not.toContain("citedOwnedVideoIds");
      expect(keys).not.toContain("citedPressDomains");
      expect(keys).not.toContain("citedSocialDomains");
      // 그래도 점수·버전은 갱신 대상이다.
      expect(keys).toContain("visibilityScore");
      expect(keys).toContain("scoreVersion");
    }
    // 값 자체도 시드한 그대로 보존된다(다시 계산해서 덮어쓰지 않았다는 방증).
    expect(H.store.runs[0].citedPressDomains).toEqual(["press-wire.example"]);
  });

  it("아직 버전 14인 행은 v16 대상이 아니다(소스 버전이 15 하나뿐)", async () => {
    seedRun(1, {
      version: 14,
      score: 0,
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
    });
    const b = await (await POST(post({ job: "v16", dryRun: true, batchSize: 200 }))).json();
    expect(b.processed).toBe(0); // selector 가 버전 15 만 골라내므로 이 행은 애초에 안 걸린다.
  });

  it("응답에 cfgFingerprint 가 실린다 · ownedVideoFingerprint 는 null(라이브 소유 목록을 조회하지 않는다)", async () => {
    seedRun(1, { version: 15, createdAt: v16At(1), score: 0, answer: "무관" });
    const b = await (await POST(post({ job: "v16", dryRun: true }))).json();
    expect(b.cfgFingerprint).toMatch(/^[0-9a-f]{12}$/);
    // v16 은 reproFromStoredEvidence 라 applyOwnedCitationJudgment 를 쓰지 않고, 그래서
    // 라이브 소유 영상 목록을 조회하지 않는다(저장된 증거만 읽는다) — v14 와 같은 이유로 null.
    expect(b.ownedVideoFingerprint).toBeNull();
  });

  /**
   * ⭐⭐ 결함 수정(2026-09-24) — cited_social_domains 는 이번 마이그레이션(0007)에서 새로
   * 생긴 컬럼이라, v16 소스 행(score_version 15)중 이 컬럼이 생기기 전에 이미 채점된 행은
   * DEFAULT '{}' 로 전부 비어 있다(citedOwnedVideoIds·citedPressDomains 는 v15 채점
   * 시점에 이미 컬럼이 있어 실제 값으로 저장됐던 것과 대비된다 — 위 다른 테스트들이 이
   * 둘을 직접 시드하는 이유). 그 행이 채점된 시점(v15)의 판정은 소셜 플랫폼을 통째로
   * 제외하던 2차 개정이라, "이 인용이 소셜 추천이었다"는 사실 자체가 어디에도 남지 않는다.
   *
   * 이 테스트는 citedSocialDomains 를 일부러 시드하지 않고(= 마이그레이션 이전 행 재현)
   * citations 에만 실제 소셜 추천을 넣는다 — 저장값을 그대로 읽는 수정 전 코드에서는
   * after 가 0(=citedSocialDomains 재현이 안 됨)으로 남아 이 테스트가 실패하고, citations
   * 에서 다시 분류하는 수정 후 코드에서는 35(v16a.genNoMentionSocial)로 반영돼 통과한다.
   */
  it("⭐ 결함 수정 — citedSocialDomains 가 비어 있는(마이그레이션 이전) 행도 citations 에서 소셜 증거를 다시 분류한다", async () => {
    seedRun(1, {
      version: 15,
      score: 0, // v15 채점 시점: 소셜 컬럼 자체가 없어 어떤 값으로도 반영되지 않았다.
      createdAt: v16At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citations: [
        { url: "https://www.instagram.com/p/AbCdEfGhIjK/", title: "요가원 추천 게시물", description: null },
      ],
      // citedSocialDomains 를 의도적으로 생략 — seedRun 기본값([])이 마이그레이션 이전 행의
      // DEFAULT '{}' 를 재현한다.
    });
    const b = await (await POST(post({ job: "v16", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes[0].before).toBe(0);
    expect(b.changes[0].after).toBe(35); // v16a.genNoMentionSocial — citations 재분류가 잡아야 한다.
  });
});

/* ============================================================
 * v17 잡 — 2026-09-24 언론 게재 배점 인상(사장님 지시: 35 → 45)
 *
 * v16 과 소스·구조가 같다(reproFromStoredEvidence — 저장된 증거 컬럼만으로 v16a 재현·
 * v17a 목표를 계산). 이 블록의 핵심은 (a) 언론 배점만 45 로 오르고 블로그·소셜(35)은
 * 그대로인지 (b) v16a 자신이 브랜드 분기에서 cap(100)에 걸리는 세트인데도 그 cap-hit
 * 행을 재현 대상(소스)으로 삼을 때 no-candidate·ambiguous-target 없이 실제로 라우트를
 * 통과하는지(순수 함수 전수 테스트는 visibility-rescore-anomaly-space.test.ts, 이 블록은
 * DB 경로까지 포함한 end-to-end 확인) 를 검증한다.
 * ============================================================ */

describe("v17 잡 — 소스 버전 16 하나 · v16a → v17a(reproFromStoredEvidence, 언론 배점 인상)", () => {
  // v15·v16 과 완전히 같은 창(대상 창 하한 KST 2026-09-21 00:00).
  const v17At = (m: number) => new Date(new Date("2026-09-21T03:00:00.000Z").getTime() + m * 60_000);
  const OWNED_ID = "dQw4w9WgXcQ";

  it("meta: 소스 버전 16 · 목표 v17a · jobHash 가 v16 과 다르다(D0-b 회귀 없음)", async () => {
    const body = await (await POST(post({ job: "v17", meta: true }))).json();
    expect(body.mode).toBe("meta");
    expect(body.sourceVersions).toEqual([16]);
    expect(body.targetVersion).toBe(17);
    expect(body.targetSet).toBe("v17a");
    expect(body.jobHash).toBe(jobHash("v17"));
    expect(body.jobHash).not.toBe(jobHash("v16"));
  });

  it("증거가 전혀 없으면 점수는 그대로(0)지만 버전만 17로 전진한다", async () => {
    seedRun(1, {
      version: 16,
      score: 0,
      createdAt: v17At(1),
      answer: "무관한 답변(브랜드 미언급)",
    });
    const b = await (await POST(post({ job: "v17", apply: true, batchSize: 200 }))).json();
    expect(b.processed).toBe(1);
    expect(b.updated).toBe(1);
    const r = H.store.runs[0];
    expect(r.visibilityScore).toBe(0);
    expect(r.scoreVersion).toBe(17);
  });

  it("저장된 언론 증거가 있으면 v17a 배점(45)이 실제로 반영된다(v16a 에선 35 였다)", async () => {
    seedRun(1, {
      version: 16,
      score: 35, // v16a 시점: 언론 배점 35 로 이미 저장돼 있었다.
      createdAt: v17At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedPressDomains: ["press-wire.example"], // v16 채점 시점에 이미 저장된 증거.
    });
    const b = await (await POST(post({ job: "v17", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes[0].before).toBe(35);
    expect(b.changes[0].after).toBe(45); // v17a.genNoMentionPress
  });

  it("저장된 소셜 증거가 있으면 v17a 에서도 배점은 그대로 35다 — 언론만 오르고 소셜은 안 오른다", async () => {
    seedRun(1, {
      version: 16,
      score: 35,
      createdAt: v17At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedSocialDomains: ["instagram.com"],
    });
    const b = await (await POST(post({ job: "v17", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes[0].before).toBe(35);
    expect(b.changes[0].after).toBe(35); // v17a.genNoMentionSocial — 그대로.
  });

  it("우리 채널 인용(citedOwnedVideoIds)만 있으면 점수는 그대로 45 — 배점을 건드리지 않았다", async () => {
    seedRun(1, {
      version: 16,
      score: 45, // v16a.genNoMentionCitation — v16 채점 시점에 이미 이 값으로 저장됨.
      createdAt: v17At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedOwnedVideoIds: [OWNED_ID],
    });
    const b = await (await POST(post({ job: "v17", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes[0].before).toBe(45);
    expect(b.changes[0].after).toBe(45); // "우리 채널 인용 45점, 기존 그대로" — 사장님 지시(v16 과 동일)
  });

  /**
   * ⭐⭐ 핵심 — v16a 자신이 브랜드 분기에서 cap(100)에 걸리는 세트인데도, 그 cap-hit 행을
   * v17 이 재현 대상(선언 세트)으로 삼을 때 재현이 모호해지지 않는지 실제 라우트로 확인한다
   * (SCORE_SETS.ts 상단 docblock "v16a·v17a 는 예외다" 문단·이론적 근거는
   * visibility-rescore-anomaly-space.test.ts 의 "v17 잡 조합" 전수 테스트).
   *
   * 브랜드 질의 · 긍정 · 적극추천 · 언론 인용 — v16a 계산: 34+48+35=117 → cap 100. 이
   * storedScore(100)를 seedRun 으로 직접 시드해 "그때 실제로 이렇게 저장됐다"를 재현한다.
   * isStronglyRecommended 는 DB 에 없는 값이라(역산 대상) 라우트가 4개 조합을 전부 시도해
   * storedScore 를 재현하는 조합만 남기고 목표 점수를 계산한다 — 그 과정이 no-candidate나
   * ambiguous-target 없이 끝나야 이 테스트가 통과한다.
   */
  it("브랜드 질의 cap 충돌(v16a 34+48+35=117→100) 저장 행도 anomaly 없이 v17a(min(127,100)=100)로 해소된다", async () => {
    seedRun(1, {
      version: 16,
      score: 100, // v16a — 긍정+적극추천+언론 조합이 cap 에 걸려 실제로 100 으로 저장됐다.
      createdAt: v17At(1),
      promptText: BRANDED_PROMPT,
      sentiment: "positive",
      answer: GEN_ANSWER, // "요가원" 브랜드 언급 포함 — mentions >= 1.
      citedPressDomains: ["press-wire.example"],
    });
    const b = await (await POST(post({ job: "v17", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0); // no-candidate·ambiguous-target 이 아니다.
    expect(b.changes).toHaveLength(1);
    expect(b.changes[0].before).toBe(100);
    expect(b.changes[0].after).toBe(100); // 34+48+45=127 → 여전히 cap 100.
  });

  it("apply 로도 dry-run 과 동일하게 적용된다", async () => {
    seedRun(1, {
      version: 16,
      score: 35,
      createdAt: v17At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedPressDomains: ["press-wire.example"],
    });
    const applied = await (await POST(post({ job: "v17", apply: true, batchSize: 200 }))).json();
    expect(applied.updated).toBe(1);
    const r = H.store.runs[0];
    expect(r.visibilityScore).toBe(45);
    expect(r.scoreVersion).toBe(17);
  });

  it("v17 은 증거 컬럼을 다시 쓰지 않는다(UPDATE SET 절에서 제외) — 이미 맞는 증거를 그대로 둔다", async () => {
    seedRun(1, {
      version: 16,
      score: 35, // v16a 시점 저장값(언론 배점 35) — v17 이 45 로 올리는 대상.
      createdAt: v17At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citedPressDomains: ["press-wire.example"],
    });
    await POST(post({ job: "v17", apply: true, batchSize: 200 }));
    expect(H.updateSetKeys.length).toBeGreaterThan(0);
    expect(H.store.runs[0].visibilityScore).toBe(45); // 점수는 실제로 올라간다.
    for (const keys of H.updateSetKeys) {
      expect(keys).not.toContain("citedOwnedVideoIds");
      expect(keys).not.toContain("citedPressDomains");
      expect(keys).not.toContain("citedSocialDomains");
      expect(keys).toContain("visibilityScore");
      expect(keys).toContain("scoreVersion");
    }
    expect(H.store.runs[0].citedPressDomains).toEqual(["press-wire.example"]);
  });

  it("아직 버전 15인 행은 v17 대상이 아니다(소스 버전이 16 하나뿐)", async () => {
    seedRun(1, {
      version: 15,
      score: 0,
      createdAt: v17At(1),
      answer: "무관한 답변(브랜드 미언급)",
    });
    const b = await (await POST(post({ job: "v17", dryRun: true, batchSize: 200 }))).json();
    expect(b.processed).toBe(0); // selector 가 버전 16 만 골라내므로 이 행은 애초에 안 걸린다.
  });

  it("응답에 cfgFingerprint 가 실린다 · ownedVideoFingerprint 는 null(라이브 소유 목록을 조회하지 않는다)", async () => {
    seedRun(1, { version: 16, createdAt: v17At(1), score: 0, answer: "무관" });
    const b = await (await POST(post({ job: "v17", dryRun: true }))).json();
    expect(b.cfgFingerprint).toMatch(/^[0-9a-f]{12}$/);
    // v17 은 reproFromStoredEvidence 라 applyOwnedCitationJudgment 를 쓰지 않고, 그래서
    // 라이브 소유 영상 목록을 조회하지 않는다(저장된 증거만 읽는다) — v14·v16 과 같은 이유로 null.
    expect(b.ownedVideoFingerprint).toBeNull();
  });

  /**
   * v16 은 이 행을 채점할 때 이미 citations 재분류 구제 경로(deriveStoredEvidenceRowInputs)로
   * hasSocialCitation=true 를 잡아 35 를 저장했다 — 그러나 증거 컬럼 자체는 다시 쓰지
   * 않으므로(위 "v16 은 증거 컬럼을 다시 쓰지 않는다" 테스트) citedSocialDomains 는 버전이
   * 16 으로 올라간 뒤에도 여전히 비어 있을 수 있다. v17 이 이 행을 다시 처리할 때도 같은
   * 재분류 구제 경로가 필요하다 — 이 테스트가 v17 에서도 그 구제 경로가 여전히 동작하는지
   * 고정한다(재분류가 깨지면 reproBase 가 hasSocialCitation=false 로 잘못 판정해 v16a 로
   * 35 를 재현하지 못하고 no-candidate 가 난다).
   */
  it("citedSocialDomains 가 비어 있는 행도 v17 에서 citations 에서 소셜 증거를 다시 분류한다", async () => {
    seedRun(1, {
      version: 16,
      score: 35, // v16 채점 시점: citations 재분류로 hasSocialCitation=true 를 잡아 35 로 저장됨.
      createdAt: v17At(1),
      answer: "무관한 답변(브랜드 미언급)",
      citations: [
        { url: "https://www.instagram.com/p/AbCdEfGhIjK/", title: "요가원 추천 게시물", description: null },
      ],
      // citedSocialDomains 를 의도적으로 생략 — seedRun 기본값([])이 미저장 행을 재현한다.
    });
    const b = await (await POST(post({ job: "v17", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0); // 재분류가 깨지면 no-candidate 가 나 여기서 실패한다.
    expect(b.changes[0].before).toBe(35);
    expect(b.changes[0].after).toBe(35); // v17a.genNoMentionSocial 도 35 — 소셜은 안 올랐다.
  });
});

/* ============================================================
 * 2026-09-25 결함 D2 — 수집 시점 v17a 채점 = v17 재산출 잡 결과
 *
 * 운영 스위치가 v17a 인데 수집 선택자가 v14a 로 떨어져 새 응답이 버전 14 로 저장됐다. 고친 뒤에는
 * 수집 경로(buildAutoRunValues · v17a 프로파일)가 곧바로 17 을 저장한다. 그 값이 "같은 답·인용을
 * v16a 로 수집해 두었다가 v17 잡(reproFromStoredEvidence)으로 올린 값"과 같아야 두 경로로 쌓인
 * 행이 한 차트에서 섞여도 기준이 어긋나지 않는다. 수집은 진짜 buildAutoRunValues, 재산출은 진짜
 * 라우트(dry-run)로 같은 입력을 흘려 비교한다 — 감성 분류(LLM)만 가짜다.
 * ============================================================ */

describe("수집 시점 v17a 점수 = v17 재산출 잡 결과 (결함 D2 동치)", () => {
  const eqAt = (m: number) => new Date(new Date("2026-09-21T03:00:00.000Z").getTime() + m * 60_000);
  const OWNED_ID = "dQw4w9WgXcQ";
  const NO_MENTION = "초보자에게는 수업 인원이 적고 동작 설명이 자세한 곳이 좋습니다. 체험 수업을 먼저 들어 보세요.";
  const PRESS = { url: "https://press-wire.example/news/1", domain: "press-wire.example", title: "요가원 소식", description: "" };
  const BRAND: BrandConfig = { ...BRAND_CONFIG, industry: "", keywords: "", description: "" };

  type Case = {
    name: string;
    promptText: string;
    answer: string;
    citations: { url: string; domain: string; title: string; description: string }[];
    llm: LlmClassification | null;
    ownedIds?: string[];
    /** 사장님 배점 기준 기대값 — 두 경로가 우연히 같은 틀린 값으로 맞는 것을 막는다. */
    expectV16: number;
    expectV17: number;
  };

  const cases: Case[] = [
    {
      name: "브랜드 질의 · 브랜드 언급 + 언론 인용 → v16a 35 · v17a 45",
      promptText: BRANDED_PROMPT,
      answer: GEN_ANSWER,
      citations: [PRESS],
      llm: { sentiment: "neutral", isTopRanked: false, isStronglyRecommended: false },
      expectV16: 35,
      expectV17: 45,
    },
    {
      name: "일반 질의 · 언급 없음 + 소유 유튜브 인용 → 45(인용됨 칸 합류)",
      promptText: GEN_PROMPT,
      answer: NO_MENTION,
      citations: [{ url: `https://www.youtube.com/watch?v=${OWNED_ID}`, domain: "youtube.com", title: "영상", description: "" }],
      llm: null,
      ownedIds: [OWNED_ID],
      expectV16: 45,
      expectV17: 45,
    },
    {
      name: "일반 질의 · 언급 없음 + 블로그·소셜 추천 → 35(소셜은 그대로)",
      promptText: GEN_PROMPT,
      answer: NO_MENTION,
      citations: [{ url: "https://www.instagram.com/p/AbCdEfGhIjK/", domain: "instagram.com", title: "요가원 추천 게시물", description: "" }],
      llm: null,
      expectV16: 35,
      expectV17: 35,
    },
    {
      name: "일반 질의 · 언급 없음 + 언론 인용 → v16a 35 · v17a 45",
      promptText: GEN_PROMPT,
      answer: NO_MENTION,
      citations: [PRESS],
      llm: null,
      expectV16: 35,
      expectV17: 45,
    },
    {
      name: "브랜드 분기 상한 — 긍정·적극추천·언론 → 117·127 모두 100",
      promptText: BRANDED_PROMPT,
      answer: GEN_ANSWER,
      citations: [PRESS],
      llm: { sentiment: "positive", isTopRanked: false, isStronglyRecommended: true },
      expectV16: 100,
      expectV17: 100,
    },
  ];

  it.each(cases)("$name", async (c) => {
    const owned = new Set(c.ownedIds ?? []);
    const ctxOf = (sw: ScoringSetSwitchValue) =>
      buildScoringContext(WS_PROD, { brandConfig: { ...BRAND, scoringSetSwitch: sw }, competitors: [] }, owned);
    const target: AutoRunTarget = {
      workspaceId: WS_PROD,
      scheduleId: null,
      promptText: c.promptText,
      provider: "google_ai",
      intervalSlot: "2026-09-21T12",
      geolocation: null,
    };
    const result = { answer: c.answer, sources: [], citations: c.citations, cached: false };
    const classify = async () => c.llm;

    const v16 = await buildAutoRunValues(ctxOf("v16a"), target, result, 0, { classifySentiment: classify });
    const v17 = await buildAutoRunValues(ctxOf("v17a"), target, result, 0, { classifySentiment: classify });
    expect(v16.scoreVersion).toBe(16);
    expect(v17.scoreVersion).toBe(17);
    expect(v16.visibilityScore).toBe(c.expectV16);
    expect(v17.visibilityScore).toBe(c.expectV17);
    // 두 프로파일의 판정(증거)은 같고 배점만 다르다.
    expect(v17.citedOwnedVideoIds).toEqual(v16.citedOwnedVideoIds);
    expect(v17.citedPressDomains).toEqual(v16.citedPressDomains);
    expect(v17.citedSocialDomains).toEqual(v16.citedSocialDomains);

    // v16a 로 수집해 저장된 행 → v17 재산출
    seedRun(1, {
      version: 16,
      score: v16.visibilityScore,
      createdAt: eqAt(1),
      promptText: c.promptText,
      sentiment: v16.sentiment,
      answer: v16.answer ?? undefined,
      citations: v16.citations as SeedOpts["citations"],
      citedOwnedVideoIds: v16.citedOwnedVideoIds ?? [],
      citedPressDomains: v16.citedPressDomains ?? [],
      citedSocialDomains: v16.citedSocialDomains ?? [],
    });
    const b = await (await POST(post({ job: "v17", dryRun: true, batchSize: 200 }))).json();
    expect(b.anomalies).toHaveLength(0);
    expect(b.changes).toHaveLength(1);
    expect(b.changes[0].before).toBe(v16.visibilityScore);
    expect(b.changes[0].after).toBe(v17.visibilityScore);
  });

  /**
   * 결함 기간(9/24 저녁 이후)에 버전 14 로 잘못 저장된 행의 복구 경로 확인 — v15 → v16 → v17 을
   * 차례로 적용하면 같은 답·인용을 수집 시점에 v17a 로 채점한 값과 같아야 한다(증거 컬럼은 v15 가
   * 채운다). 소유 영상 목록은 수집 때와 재산출 때 같다고 둔다.
   */
  it.each(cases)("버전 14 로 잘못 저장된 행 → v15·v16·v17 순차 적용 = 수집 시점 v17a: $name", async (c) => {
    const owned = new Set(c.ownedIds ?? []);
    for (const vid of owned) seedOwnedVideo(WS_PROD, vid);
    const ctxOf = (sw: ScoringSetSwitchValue) =>
      buildScoringContext(WS_PROD, { brandConfig: { ...BRAND, scoringSetSwitch: sw }, competitors: [] }, owned);
    const target: AutoRunTarget = {
      workspaceId: WS_PROD,
      scheduleId: null,
      promptText: c.promptText,
      provider: "google_ai",
      intervalSlot: "2026-09-21T12",
      geolocation: null,
    };
    const result = { answer: c.answer, sources: [], citations: c.citations, cached: false };
    const classify = async () => c.llm;
    const v14 = await buildAutoRunValues(ctxOf("v14a"), target, result, 0, { classifySentiment: classify });
    const v17 = await buildAutoRunValues(ctxOf("v17a"), target, result, 0, { classifySentiment: classify });
    expect(v14.scoreVersion).toBe(14);
    expect(v14.citedOwnedVideoIds).toEqual([]); // 결함 증상 — v14a 는 소유 유튜브 판정을 하지 않는다

    seedRun(1, {
      version: 14,
      score: v14.visibilityScore,
      createdAt: eqAt(1),
      promptText: c.promptText,
      sentiment: v14.sentiment,
      answer: v14.answer ?? undefined,
      citations: v14.citations as SeedOpts["citations"],
      citedOwnedVideoIds: v14.citedOwnedVideoIds ?? [],
      citedPressDomains: v14.citedPressDomains ?? [],
      citedSocialDomains: v14.citedSocialDomains ?? [],
    });
    for (const job of ["v15", "v16", "v17"] as const) {
      const b = await (await POST(post({ job, apply: true, batchSize: 200 }))).json();
      expect(b.anomalies).toHaveLength(0);
      expect(b.updated).toBe(1);
    }
    const row = H.store.runs[0];
    expect(row.scoreVersion).toBe(17);
    expect(row.visibilityScore).toBe(v17.visibilityScore);
    expect(row.citedOwnedVideoIds).toEqual(v17.citedOwnedVideoIds);
  });

  /**
   * Codex 1차 검수 C3 — 운영 창에는 결함 행(14)과 이미 재산출된 행(17)이 함께 있다. preflight 가
   * 17 을 범위 밖으로 세면 정상 게이트가 복구를 막는다. preflight 를 포함한 정상 경로로
   * v15 → v16 → v17 을 차례로 돌려 복구되고, 이미 17 인 행은 그대로인지 본다.
   */
  it("버전 14(결함)와 17(이미 재산출)이 섞인 창 — preflight 포함 정상 경로로 v15→v16→v17 복구 · 17 행 불변 (C3)", async () => {
    const owned = new Set([OWNED_ID]);
    seedOwnedVideo(WS_PROD, OWNED_ID);
    const ctxOf = (sw: ScoringSetSwitchValue) =>
      buildScoringContext(WS_PROD, { brandConfig: { ...BRAND, scoringSetSwitch: sw }, competitors: [] }, owned);
    const target: AutoRunTarget = {
      workspaceId: WS_PROD,
      scheduleId: null,
      promptText: GEN_PROMPT,
      provider: "google_ai",
      intervalSlot: "2026-09-24T12",
      geolocation: null,
    };
    const result = {
      answer: NO_MENTION,
      sources: [],
      citations: [{ url: `https://www.youtube.com/watch?v=${OWNED_ID}`, domain: "youtube.com", title: "영상", description: "" }],
      cached: false,
    };
    const v14 = await buildAutoRunValues(ctxOf("v14a"), target, result, 0, { classifySentiment: async () => null });
    const v17 = await buildAutoRunValues(ctxOf("v17a"), target, result, 0, { classifySentiment: async () => null });
    expect(v14.visibilityScore).toBe(0); // 결함 증상 — 소유 유튜브 인용이 점수에 안 들어갔다
    expect(v17.visibilityScore).toBe(45);

    seedRun(1, {
      version: 14,
      score: v14.visibilityScore,
      createdAt: eqAt(1),
      sentiment: v14.sentiment,
      answer: v14.answer ?? undefined,
      citations: v14.citations as SeedOpts["citations"],
    });
    const already = seedRun(2, {
      version: 17,
      score: 45,
      createdAt: eqAt(2),
      sentiment: "not-mentioned",
      answer: NO_MENTION,
      citedPressDomains: ["press-wire.example"],
    });

    for (const job of ["v15", "v16", "v17"] as const) {
      const pre = await (await POST(post({ job, preflight: true }))).json();
      expect(pre.outOfScopeCount).toBe(0);
      expect(pre.clean).toBe(true);
      const b = await (await POST(post({ job, apply: true, batchSize: 200 }))).json();
      expect(b.anomalies).toHaveLength(0);
      expect(b.updated).toBe(1); // 결함 행 1건만 — 17 행은 소스 버전 밖이라 고르지 않는다
    }
    const recovered = H.store.runs.find((r) => r.id === id(1))!;
    expect(recovered.scoreVersion).toBe(17);
    expect(recovered.visibilityScore).toBe(v17.visibilityScore);
    expect(recovered.citedOwnedVideoIds).toEqual([OWNED_ID]);
    const untouched = H.store.runs.find((r) => r.id === already.id)!;
    expect(untouched.scoreVersion).toBe(17);
    expect(untouched.visibilityScore).toBe(45);
  });

  it("체인 밖 버전은 계속 차단한다 — v15 창의 미등록 버전 · v16 창에 남은 앞 단계 버전 14 (C3)", async () => {
    seedRun(1, { version: 14, score: 0, createdAt: eqAt(1), answer: NO_MENTION });
    seedRun(2, { version: 99, score: 0, createdAt: eqAt(2), answer: NO_MENTION });
    const v15pre = await (await POST(post({ job: "v15", preflight: true }))).json();
    expect(v15pre.outOfScopeCount).toBe(1); // 99
    expect(v15pre.clean).toBe(false);
    expect(v15pre.acceptedVersions).toEqual([14, 15, 16, 17]);
    const v16pre = await (await POST(post({ job: "v16", preflight: true }))).json();
    expect(v16pre.outOfScopeCount).toBe(2); // 14(v15 를 먼저 돌려야 함) · 99
    expect(v16pre.clean).toBe(false);
  });

  /**
   * Codex 2차 N2 — 뒤 버전은 그 행이 그 버전에 이르는 잡들의 선택 조건(날짜 창 등)을 만족할 때만
   * 정상이다. v12 창(KST 8/12～)의 8월 15일 행에 14·17 이 있으면 실제 잡 경로로는 만들 수 없는 값이라
   * 범위 밖이다(v14 는 8/24～, v15～v17 은 9/21～). 같은 v12 창이라도 9월 22일 행의 17 은 정상이다.
   */
  it("v12 창 — 8월 15일 행의 14·17 은 범위 밖, 9월 22일 행의 17 은 정상, 99 는 차단 (N2)", async () => {
    const aug15 = (m: number) => new Date(new Date("2026-08-15T03:00:00.000Z").getTime() + m * 60_000);
    seedRun(1, { version: 10, createdAt: aug15(1) }); // 소스 버전 — 정상
    seedRun(2, { version: 14, score: 0, createdAt: aug15(2), answer: NO_MENTION });
    seedRun(3, { version: 17, score: 0, createdAt: aug15(3), answer: NO_MENTION });
    seedRun(4, { version: 17, score: 0, createdAt: eqAt(4), answer: NO_MENTION }); // 9/21 12:04 KST
    seedRun(5, { version: 99, score: 0, createdAt: eqAt(5), answer: NO_MENTION });
    const b = await (await POST(post({ job: "v12", preflight: true }))).json();
    expect(b.outOfScopeCount).toBe(3); // 8/15 의 14 · 8/15 의 17 · 99
    expect(b.clean).toBe(false);
    expect(b.acceptedVersions).toEqual([10, 12, 14, 15, 16, 17]); // 표시용 목록 — 행별 판정은 따로

    // 문제 행을 빼면 9월 22일의 17 은 정상으로 남아 clean=true 가 된다.
    H.store.runs = H.store.runs.filter((r) => ![id(2), id(3), id(5)].includes(r.id as string));
    const b2 = await (await POST(post({ job: "v12", preflight: true }))).json();
    expect(b2.outOfScopeCount).toBe(0);
    expect(b2.clean).toBe(true);
  });

  it("수집 시점에 17 로 저장된 행은 v15·v16·v17 어느 잡도 다시 건드리지 않는다", async () => {
    seedRun(1, { version: 17, score: 45, createdAt: eqAt(1), answer: NO_MENTION, citedPressDomains: ["press-wire.example"] });
    for (const job of ["v15", "v16", "v17"] as const) {
      const b = await (await POST(post({ job, dryRun: true, batchSize: 200 }))).json();
      expect(b.processed).toBe(0);
    }
    const v17Preflight = await (await POST(post({ job: "v17", preflight: true }))).json();
    expect(v17Preflight.clean).toBe(true); // 목표 버전(17)이라 v17 기준으론 범위 밖 행이 아니다
  });
});
