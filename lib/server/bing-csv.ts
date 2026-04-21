import type { BingCsvRow, BingCsvParseResult } from "./sro-types";

/** RFC 4180 스타일 CSV 한 줄을 필드 배열로 파싱 (따옴표 안 콤마/줄바꿈 허용) */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === "," || c === "\t") {
        out.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** CSV 본문을 행 배열로 쪼갠다 (BOM 제거, CRLF/LF 모두 처리, 빈 줄 스킵) */
function splitCsvRows(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  // 따옴표 안 줄바꿈 처리를 위해 상태 기반 분할
  const rows: string[][] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      cur += c;
    } else if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      if (cur.trim().length > 0) rows.push(parseCsvLine(cur));
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim().length > 0) rows.push(parseCsvLine(cur));
  return rows;
}

/** 헤더명 정규화 — 대소문자/공백 제거, 한글 공백 제거 */
function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "").replace(/[_-]/g, "");
}

/**
 * 각 BingCsvRow 필드에 매칭될 수 있는 헤더 키워드.
 * Bing은 영문/한글 리포트 둘 다 내보내므로 양쪽 모두 수용.
 */
const HEADER_CANDIDATES: Record<keyof Omit<BingCsvRow, "extra">, string[]> = {
  keyword: ["query", "keyword", "queries", "쿼리", "검색어", "키워드"],
  page: ["page", "url", "landingpage", "pageurl", "페이지", "링크", "url주소"],
  clicks: ["clicks", "click", "클릭", "클릭수"],
  impressions: ["impressions", "impression", "노출", "노출수"],
  ctr: ["ctr", "클릭률"],
  position: [
    "avgposition",
    "averageposition",
    "position",
    "rank",
    "avgrank",
    "평균순위",
    "평균위치",
    "순위",
  ],
  citations: ["citations", "citation", "인용", "인용수", "aicitations"],
  date: ["date", "day", "날짜", "일자"],
};

function findHeaderMap(headers: string[]): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  const normalized = headers.map(normalizeHeader);
  for (const [field, candidates] of Object.entries(HEADER_CANDIDATES)) {
    const idx = normalized.findIndex((h) =>
      candidates.includes(h)
    );
    map[field] = idx >= 0 ? headers[idx] : null;
  }
  return map;
}

function parseNumber(v: string | undefined): number {
  if (!v) return 0;
  const cleaned = v
    .replace(/,/g, "")
    .replace(/%/g, "")
    .replace(/[^\d.\-]/g, "");
  const n = parseFloat(cleaned);
  if (!isFinite(n)) return 0;
  // CTR이 퍼센트로 들어올 수 있음 — 1 초과면 /100
  return n;
}

function parseCtr(v: string | undefined): number {
  const n = parseNumber(v);
  if (n > 1) return n / 100;
  return n;
}

/**
 * Bing Webmaster Tools에서 내보낸 성과 CSV를 파싱한다.
 * 알려진 헤더(영/한)를 자동 인식하고, 인식 못한 컬럼은 extra에 보관.
 */
export function parseBingCsv(
  csvText: string,
  fileName: string
): BingCsvParseResult {
  const uploadedAt = new Date().toISOString();
  const base: Omit<BingCsvParseResult, "ok"> = {
    headers: [],
    headerMap: {},
    rows: [],
    totals: { clicks: 0, impressions: 0, citations: 0 },
    avgCtr: 0,
    avgPosition: 0,
    dateRange: { start: null, end: null },
    uploadedAt,
    fileName,
  };

  try {
    const rows = splitCsvRows(csvText);
    if (rows.length < 2) {
      return {
        ok: false,
        error: "CSV에 데이터 행이 없습니다.",
        ...base,
      };
    }

    const headers = rows[0];
    const headerMap = findHeaderMap(headers);
    const idx: Record<string, number> = {};
    for (const [field, originalName] of Object.entries(headerMap)) {
      idx[field] = originalName ? headers.indexOf(originalName) : -1;
    }

    const parsedRows: BingCsvRow[] = [];
    let totalClicks = 0;
    let totalImp = 0;
    let totalCites = 0;
    let ctrSum = 0;
    let ctrCount = 0;
    let posSum = 0;
    let posCount = 0;
    let minDate: string | null = null;
    let maxDate: string | null = null;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (row.length === 0 || row.every((v) => v.trim() === "")) continue;

      const extra: Record<string, string> = {};
      for (let c = 0; c < headers.length; c++) {
        const field = Object.keys(headerMap).find(
          (k) => headerMap[k] === headers[c]
        );
        if (!field) extra[headers[c]] = row[c] ?? "";
      }

      const clicks = parseNumber(row[idx.clicks] ?? "");
      const impressions = parseNumber(row[idx.impressions] ?? "");
      const ctr = idx.ctr >= 0 ? parseCtr(row[idx.ctr]) : impressions > 0 ? clicks / impressions : 0;
      const position = parseNumber(row[idx.position] ?? "");
      const citations = parseNumber(row[idx.citations] ?? "");
      const date = (row[idx.date] ?? "").trim();

      const parsed: BingCsvRow = {
        keyword: (row[idx.keyword] ?? "").trim(),
        page: (row[idx.page] ?? "").trim(),
        clicks,
        impressions,
        ctr,
        position,
        citations,
        date,
        extra,
      };
      parsedRows.push(parsed);

      totalClicks += clicks;
      totalImp += impressions;
      totalCites += citations;
      if (ctr > 0) {
        ctrSum += ctr;
        ctrCount++;
      }
      if (position > 0) {
        posSum += position;
        posCount++;
      }
      if (date) {
        if (!minDate || date < minDate) minDate = date;
        if (!maxDate || date > maxDate) maxDate = date;
      }
    }

    return {
      ok: true,
      ...base,
      headers,
      headerMap,
      rows: parsedRows,
      totals: {
        clicks: totalClicks,
        impressions: totalImp,
        citations: totalCites,
      },
      avgCtr: ctrCount > 0 ? ctrSum / ctrCount : 0,
      avgPosition: posCount > 0 ? posSum / posCount : 0,
      dateRange: { start: minDate, end: maxDate },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...base,
    };
  }
}
