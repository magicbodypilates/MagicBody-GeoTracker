import { useState } from "react";
import type { Competitor } from "@/components/dashboard/types";
import type { NaverAiBriefingResult } from "@/lib/server/sro-types";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type NaverAiTabProps = {
  brandName: string;
  brandAliases: string;
  websites: string[];
  competitors: Competitor[];
};

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^www\./, "");
  }
}

export function NaverAiTab({
  brandName,
  brandAliases,
  websites,
  competitors,
}: NaverAiTabProps) {
  const [keyword, setKeyword] = useState<string>("");
  const [result, setResult] = useState<NaverAiBriefingResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");

  async function runQuery() {
    if (!keyword.trim()) {
      setMessage("키워드를 입력하세요.");
      return;
    }
    setBusy(true);
    setMessage("NAVER AI 브리핑 조회 중... (10~20초 소요)");
    try {
      const brandDomains = websites
        .map((w) => extractHostname(w))
        .filter((h) => h.length > 0);
      const aliases = [
        brandName,
        ...brandAliases.split(",").map((a) => a.trim()),
      ].filter((a) => a.length > 0);
      const competitorNames = competitors
        .flatMap((c) => [c.name, ...c.aliases])
        .filter((n) => n.trim().length > 0);

      const r = await fetch(BP + "/api/naver/ai-briefing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: keyword.trim(),
          brandDomains,
          brandAliases: aliases,
          competitors: competitorNames,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "조회 실패");
      setResult(data as NaverAiBriefingResult);
      if (!data.exists) {
        if (data.error) {
          setMessage(`감지 실패: ${data.error} · 아래 브라우저 확인 링크로 실제 네이버 결과를 대조해보세요.`);
        } else if (data.markdownPreview) {
          setMessage(
            "응답은 정상이나 'AI 브리핑' 블록을 찾지 못함. 해당 키워드에 AI 브리핑이 생성되지 않았거나, NAVER 블록명이 변경되었을 수 있습니다. 아래 프리뷰 확인하세요."
          );
        } else {
          setMessage(
            "AI 브리핑이 감지되지 않았습니다. (정보성 키워드일 때만 생성됨)"
          );
        }
      } else {
        setMessage(
          `AI 브리핑 감지됨 · 출처 ${data.sources.length}개 · 브랜드 ${
            data.brandCited
              ? "인용"
              : data.brandMentioned
                ? `멘션 ${data.mentionCount}회`
                : "미등장"
          }`
        );
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "조회 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-base font-semibold text-th-text">
          NAVER AI 브리핑 추적
        </div>
        <p className="mb-0 text-sm leading-relaxed text-th-text-muted">
          한국 사용자의 NAVER 검색 결과 상단에 생성되는 AI 브리핑 블록을 추적하여
          브랜드가 인용되는지 모니터링합니다. Bright Data Web Unlocker 기반 스크래핑.
        </p>
      </div>

      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-3">
            <label className="mb-1 block text-xs uppercase tracking-wider text-th-text-muted">
              키워드
            </label>
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={
                brandName ? `예: ${brandName} 후기` : "예: 필라테스 자격증 추천"
              }
              className="bd-input w-full rounded-lg p-2 text-sm"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={runQuery}
              disabled={busy || !keyword.trim()}
              className="bd-btn-primary w-full rounded-lg px-4 py-2 text-sm"
            >
              {busy ? "조회 중..." : "AI 브리핑 조회"}
            </button>
          </div>
        </div>
        {message && (
          <div className="mt-3 rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
            {message}
          </div>
        )}
      </div>

      {result && !result.exists && (
        <div className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
          <a
            href={result.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-th-text-accent hover:underline"
          >
            ↗ 네이버에서 "{result.keyword}" 직접 확인
          </a>
          <span className="ml-2 text-th-text-muted">
            브라우저에서 AI 브리핑이 실제로 노출되는지 대조하세요. 노출되지 않으면 네이버 측 생성 누락이며 파서 문제는 아닙니다.
          </span>
        </div>
      )}

      {result && !result.exists && result.markdownPreview && (
        <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
          <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-th-text-muted">
            <span>스크래핑 응답 프리뷰 (최대 5000자)</span>
            <span className="font-normal normal-case text-th-text-muted">
              {result.markdownPreview.length.toLocaleString()}자
            </span>
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs text-th-text-secondary">
            {result.markdownPreview}
          </pre>
        </div>
      )}

      {result && result.exists && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <MiniStat label="AI 브리핑" value="생성됨" accent />
            <MiniStat
              label="브랜드 멘션"
              value={result.brandMentioned ? `${result.mentionCount}회` : "없음"}
              accent={result.brandMentioned}
            />
            <MiniStat
              label="브랜드 인용"
              value={result.brandCited ? "있음" : "없음"}
              accent={result.brandCited}
            />
            <MiniStat
              label="총 출처"
              value={result.sources.length.toString()}
            />
          </div>

          {result.snippet && (
            <div className="rounded-lg border border-th-border bg-th-card-alt p-3 text-sm text-th-text leading-relaxed whitespace-pre-wrap">
              {result.snippet}
            </div>
          )}

          {result.sources.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-th-border">
              <table className="w-full text-sm">
                <thead className="bg-th-card-alt text-xs uppercase tracking-wider text-th-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">도메인</th>
                    <th className="px-3 py-2 text-left">제목/URL</th>
                    <th className="px-3 py-2 text-right">브랜드</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-th-border">
                  {result.sources.map((s, i) => (
                    <tr key={i} className="bg-th-card">
                      <td className="px-3 py-2 text-th-text-muted">{i + 1}</td>
                      <td className="px-3 py-2 text-th-text">{s.domain}</td>
                      <td className="px-3 py-2 text-th-text-secondary">
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                        >
                          {s.title || s.url}
                        </a>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {s.isBrand ? (
                          <span className="rounded bg-th-accent/20 px-2 py-0.5 text-xs text-th-text-accent">
                            자사
                          </span>
                        ) : (
                          <span className="text-xs text-th-text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.competitorsMentioned.length > 0 && (
            <div className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
              경쟁사 멘션: {result.competitorsMentioned.join(", ")}
            </div>
          )}

          <div className="text-xs text-th-text-muted">
            키워드: {result.keyword} · 조회 시각:{" "}
            {new Date(result.fetchedAt).toLocaleString()} ·{" "}
            <a
              href={result.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              NAVER 검색 원본 열기
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
      <div className="text-xs uppercase tracking-wider text-th-text-muted">
        {label}
      </div>
      <div
        className={`mt-0.5 text-base font-semibold ${
          accent ? "text-th-text-accent" : "text-th-text"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
