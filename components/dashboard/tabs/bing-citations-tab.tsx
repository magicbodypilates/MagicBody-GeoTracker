"use client";

import { useEffect, useRef, useState } from "react";
import { get, set } from "idb-keyval";
import type { BingCsvParseResult, BingCsvRow } from "@/lib/server/sro-types";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const STORAGE_KEY = "sovereign-bing-citations-v1";

type SavedReport = {
  id: string;
  fileName: string;
  uploadedAt: string;
  result: BingCsvParseResult;
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function BingCitationsTab() {
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const saved = await get<SavedReport[]>(STORAGE_KEY);
        if (saved && saved.length > 0) {
          setReports(saved);
          setActiveId(saved[0].id);
        }
      } catch {
        /* 무시 */
      }
    })();
  }, []);

  async function persist(next: SavedReport[]) {
    try {
      await set(STORAGE_KEY, next);
    } catch (e) {
      setMessage(
        "로컬 저장 실패: " + (e instanceof Error ? e.message : "unknown")
      );
    }
  }

  async function handleFile(file: File) {
    setBusy(true);
    setMessage(`"${file.name}" 업로드 중...`);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(BP + "/api/bing/upload", {
        method: "POST",
        body: fd,
      });
      const data: BingCsvParseResult = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data.error ?? "파싱 실패");
      }
      const newReport: SavedReport = {
        id: Date.now().toString(36),
        fileName: file.name,
        uploadedAt: data.uploadedAt,
        result: data,
      };
      const next = [newReport, ...reports].slice(0, 10);
      setReports(next);
      setActiveId(newReport.id);
      await persist(next);
      setMessage(
        `완료: ${data.rows.length}행 파싱 · 클릭 ${data.totals.clicks.toLocaleString()} · 노출 ${data.totals.impressions.toLocaleString()} · 인용 ${data.totals.citations.toLocaleString()}`
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "업로드 실패");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function removeReport(id: string) {
    const next = reports.filter((r) => r.id !== id);
    setReports(next);
    if (activeId === id) setActiveId(next[0]?.id ?? null);
    await persist(next);
  }

  const active = reports.find((r) => r.id === activeId) ?? null;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-base font-semibold text-th-text">
          Bing Webmaster Tools — AI 인용 CSV 업로드
        </div>
        <p className="text-sm leading-relaxed text-th-text-muted">
          Bing Webmaster Tools → 성과 보고서/AI Performance에서 내보낸 CSV를 업로드하면
          쿼리·페이지·클릭·노출·CTR·순위·인용 수를 자동 파싱해 요약과 테이블로 보여줍니다.
          데이터는 이 브라우저의 IndexedDB에 최대 10개까지 보관됩니다.
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-th-border bg-th-card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
            disabled={busy}
            className="block text-sm text-th-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-th-accent file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-th-accent-hover disabled:opacity-50"
          />
          <span className="text-xs text-th-text-muted">
            최대 10MB · UTF-8 / CP949 CSV / TSV 지원
          </span>
        </div>
        {message && (
          <div className="mt-3 rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
            {message}
          </div>
        )}
      </div>

      {reports.length > 0 && (
        <div className="rounded-lg border border-th-border bg-th-card p-4">
          <div className="mb-2 text-sm font-semibold text-th-text">업로드 이력</div>
          <div className="flex flex-wrap gap-2">
            {reports.map((r) => (
              <button
                key={r.id}
                onClick={() => setActiveId(r.id)}
                className={`group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                  r.id === activeId
                    ? "border-th-accent bg-th-accent/10 text-th-text"
                    : "border-th-border bg-th-card-alt text-th-text-secondary hover:bg-th-card-hover"
                }`}
              >
                <span>{r.fileName}</span>
                <span className="text-th-text-muted">
                  ({r.result.rows.length}행)
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeReport(r.id);
                  }}
                  className="ml-1 rounded px-1 text-th-text-muted hover:bg-th-card-hover hover:text-th-text"
                  aria-label="삭제"
                >
                  ×
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {active && <ReportView report={active} />}
    </div>
  );
}

function ReportView({ report }: { report: SavedReport }) {
  const { result } = report;
  const mappedHeaders = Object.entries(result.headerMap).filter(
    ([, v]) => v !== null
  );
  const unmappedHeaders = result.headers.filter(
    (h) => !mappedHeaders.some(([, v]) => v === h)
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <Kpi label="총 클릭" value={result.totals.clicks.toLocaleString()} />
        <Kpi
          label="총 노출"
          value={result.totals.impressions.toLocaleString()}
        />
        <Kpi
          label="총 인용"
          value={result.totals.citations.toLocaleString()}
          accent={result.totals.citations > 0}
        />
        <Kpi
          label="평균 CTR · 순위"
          value={`${(result.avgCtr * 100).toFixed(2)}% · ${result.avgPosition.toFixed(1)}`}
        />
      </div>

      <div className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-secondary">
        <span className="text-th-text">파일:</span> {report.fileName} ·{" "}
        <span className="text-th-text">업로드:</span>{" "}
        {formatDate(report.uploadedAt)}
        {result.dateRange.start && result.dateRange.end && (
          <>
            {" · "}
            <span className="text-th-text">기간:</span>{" "}
            {result.dateRange.start} ~ {result.dateRange.end}
          </>
        )}
      </div>

      {unmappedHeaders.length > 0 && (
        <div className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs text-th-text-muted">
          인식하지 못한 컬럼 (참고용 extra 저장):{" "}
          {unmappedHeaders.join(", ")}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-th-border">
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-th-card-alt text-xs uppercase tracking-wider text-th-text-muted">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">쿼리</th>
                <th className="px-3 py-2 text-left">페이지</th>
                <th className="px-3 py-2 text-right">클릭</th>
                <th className="px-3 py-2 text-right">노출</th>
                <th className="px-3 py-2 text-right">CTR</th>
                <th className="px-3 py-2 text-right">순위</th>
                <th className="px-3 py-2 text-right">인용</th>
                <th className="px-3 py-2 text-left">날짜</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-th-border">
              {result.rows.slice(0, 500).map((r: BingCsvRow, i: number) => (
                <tr key={i} className="bg-th-card">
                  <td className="px-3 py-1.5 text-th-text-muted">{i + 1}</td>
                  <td className="px-3 py-1.5 text-th-text">{r.keyword || "—"}</td>
                  <td className="px-3 py-1.5 text-th-text-secondary">
                    {r.page ? (
                      <a
                        href={r.page}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {r.page.replace(/^https?:\/\//, "").slice(0, 60)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right text-th-text">
                    {r.clicks.toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-right text-th-text-secondary">
                    {r.impressions.toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-right text-th-text-secondary">
                    {(r.ctr * 100).toFixed(2)}%
                  </td>
                  <td className="px-3 py-1.5 text-right text-th-text-secondary">
                    {r.position ? r.position.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {r.citations > 0 ? (
                      <span className="rounded bg-th-accent/20 px-2 py-0.5 text-xs text-th-text-accent">
                        {r.citations.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-th-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-th-text-muted">
                    {r.date || "—"}
                  </td>
                </tr>
              ))}
              {result.rows.length > 500 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-2 text-center text-xs text-th-text-muted"
                  >
                    ... 500행까지만 표시 (총 {result.rows.length}행)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <div className="text-xs uppercase tracking-wider text-th-text-muted">
        {label}
      </div>
      <div
        className={`mt-1 text-xl font-semibold ${
          accent ? "text-th-text-accent" : "text-th-text"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
