/**
 * 페이지·클릭 통계 — 「어떤 기기로 보나」 카드 · 기기 전환 단추 (상위 권한 전용 화면의 일부)
 *   task_id: device-tracking_261112 (plan-v2 §5-2)
 *
 * 계산은 lib/client/page-analytics-device.ts 에 있다. 여기서는 그 결과를 화면으로만 옮긴다.
 * 구글 칸은 우리 통계와 따로 불러오며, 기간을 빠르게 바꿔도 마지막 요청의 응답만 그린다(옛 요청은 취소).
 */

"use client";

import { useEffect, useRef, useState } from "react";
import {
  createGa4Loader,
  ga4PanelState,
  ga4ViewFor,
  gaDeviceSlices,
  ourDeviceSlices,
  type DeviceFilter,
  type DeviceRow,
  type DeviceSlice,
  type Ga4ClientFailure,
  type Ga4PanelState,
  type Ga4Response,
  type Ga4View,
} from "@/lib/client/page-analytics-device";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function fmtInt(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("ko-KR");
}

function fmtShare(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

/** 100% 가로 막대 + 범례(막대 위). */
function ShareBar({ slices, label }: { slices: DeviceSlice[]; label: string }) {
  const shown = slices.filter((s) => (s.share ?? 0) > 0);
  return (
    <div>
      <ul className="mb-1.5 flex flex-wrap gap-x-3 gap-y-1 text-sm text-th-text-secondary" aria-label={`${label} 범례`}>
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden />
            {s.label} {fmtShare(s.share)}
          </li>
        ))}
      </ul>
      <div className="flex h-3 w-full overflow-hidden rounded bg-th-card-alt" role="img" aria-label={label}>
        {shown.map((s) => (
          <div key={s.key} style={{ width: `${(s.share ?? 0) * 100}%`, backgroundColor: s.color }} />
        ))}
      </div>
    </div>
  );
}

function SliceTable({ slices, countLabel, viewLabel }: { slices: DeviceSlice[]; countLabel: string; viewLabel: string }) {
  return (
    <table className="mt-3 w-full text-sm">
      <thead>
        <tr className="border-b border-th-border text-left text-th-text-muted">
          <th className="py-1 pr-2 font-normal">기기</th>
          <th className="py-1 pr-2 text-right font-normal">{countLabel}</th>
          <th className="py-1 pr-2 text-right font-normal">비율</th>
          <th className="py-1 text-right font-normal">{viewLabel}</th>
        </tr>
      </thead>
      <tbody>
        {slices.map((s) => (
          <tr key={s.key} className="border-b border-th-border-subtle">
            <td className="py-1 pr-2 text-th-text">{s.label}</td>
            <td className="py-1 pr-2 text-right font-mono text-th-text">{fmtInt(s.count)}</td>
            <td className="py-1 pr-2 text-right font-mono text-th-text-secondary">{fmtShare(s.share)}</td>
            <td className="py-1 text-right font-mono text-th-text-secondary">{fmtInt(s.views)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const GA4_STATE_TEXT: Record<Exclude<Ga4PanelState, "ok">, string> = {
  loading: "불러오는 중입니다.",
  empty: "이 기간에는 구글 애널리틱스 기록이 없습니다.",
  not_connected: "구글 애널리틱스 연결이 끊겨 지금은 볼 수 없습니다. 연결을 다시 하면 바로 보입니다.",
  unavailable: "구글 애널리틱스를 잠시 불러오지 못했습니다.",
  app_login: "로그인이 끝나 구글 애널리틱스 칸을 불러오지 못했습니다. 다시 로그인하면 보입니다.",
  app_forbidden: "이 계정에는 구글 애널리틱스 칸을 볼 권한이 없습니다.",
  rate_limited: "조회가 몰려 잠시 쉬고 있습니다. 잠시 뒤 다시 열어 주세요.",
};

/** 카드 본체 — 불러오기와 분리한 그리기 전용(시험에서 그대로 그린다). */
export function DeviceCardView({
  devices,
  dataSource,
  ga,
  gaLoading,
  gaFailure = null,
}: {
  devices: DeviceRow[];
  dataSource: "detail" | "rollup";
  ga: Ga4Response | null;
  gaLoading: boolean;
  gaFailure?: Ga4ClientFailure | null;
}) {
  const ours = ourDeviceSlices(devices);
  const gaState = ga4PanelState(ga, gaLoading, gaFailure);
  const gaSlices = gaState === "ok" && ga && ga.status === "ok" ? gaDeviceSlices(ga.rows).slices : [];

  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <h3 className="text-base font-semibold text-th-text">어떤 기기로 보나</h3>

      <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section aria-label="우리 통계">
          <h4 className="mb-2 text-sm font-semibold text-th-text">우리 통계 · 방문 기준</h4>
          {ours.knownVisits > 0 || !ours.complete ? (
            <>
              {ours.complete ? (
                <ShareBar slices={ours.slices} label="우리 통계 기기 비율" />
              ) : (
                <p className="text-sm text-th-text-muted">기기별 숫자 일부를 확인할 수 없어 비율은 표시하지 않습니다.</p>
              )}
              <SliceTable slices={ours.slices} countLabel="방문 수" viewLabel="조회 수" />
            </>
          ) : (
            <p className="text-sm text-th-text-muted">이 기간 방문은 기기 정보가 없습니다(대부분 기기 기록을 시작하기 전 기록입니다).</p>
          )}
        </section>

        <section aria-label="구글 애널리틱스">
          <h4 className="mb-2 text-sm font-semibold text-th-text">구글 애널리틱스 · 세션 기준</h4>
          {gaState === "ok" ? (
            <>
              <ShareBar slices={gaSlices} label="구글 애널리틱스 기기 비율" />
              <SliceTable slices={gaSlices} countLabel="세션 수" viewLabel="화면 조회 수" />
            </>
          ) : (
            <p className={`text-sm ${gaState === "loading" || gaState === "empty" ? "text-th-text-muted" : "text-th-danger"}`} role="status">
              {GA4_STATE_TEXT[gaState]}
            </p>
          )}
        </section>
      </div>

      <ul className="mt-4 list-disc space-y-1 pl-5 text-sm leading-relaxed text-th-text-muted">
        <li>구글 애널리틱스는 광고 차단·추적 거부 브라우저를 세지 못해 우리 숫자보다 작게 나옵니다.</li>
        <li>방문을 세는 기준이 다릅니다 — 우리는 브라우저 탭 하나, 구글은 30분 동안 움직임이 없으면 끊기는 세션입니다.</li>
        <li>아이패드는 우리 통계에서 PC 로 잡힐 수 있습니다. 그래서 숫자 크기보다 비율을 견주어 보세요.</li>
        {ours.noneVisits !== null && ours.noneVisits > 0 && ours.knownVisits > 0 && (
          <li>
            이 기간 방문 <strong className="text-th-text">{fmtInt(ours.noneVisits)}건</strong>은 기기 정보가 없습니다(대부분
            기기 기록을 시작하기 전 기록입니다). 비율은 기기 정보가 있는 방문으로만 냅니다.
          </li>
        )}
        {dataSource === "rollup" && (
          <li>이 기간은 날짜별 요약 기준이라 방문 수가 날짜별 합계입니다(여러 날 오신 분은 여러 번 세어집니다).</li>
        )}
      </ul>
    </div>
  );
}

/** 카드 — 우리 통계는 받은 값으로 바로 그리고, 구글 칸은 따로 불러온다. */
export function DeviceCard({
  devices,
  dataSource,
  fromKst,
  toKst,
}: {
  devices: DeviceRow[];
  dataSource: "detail" | "rollup";
  fromKst: string;
  toKst: string;
}) {
  const [view, setView] = useState<Ga4View | null>(null);
  const loaderRef = useRef<ReturnType<typeof createGa4Loader> | null>(null);

  useEffect(() => {
    const loader = createGa4Loader({ fetchImpl: (u, init) => fetch(u, init), basePath: BP, onChange: setView });
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!fromKst || !toKst) return;
    void loaderRef.current?.load(fromKst, toKst);
  }, [fromKst, toKst]);

  // 저장된 결과가 지금 기간 것일 때만 그린다(기간을 바꾼 직후 옛 기간 숫자를 그리지 않는다).
  const g = ga4ViewFor(view, fromKst, toKst);
  return <DeviceCardView devices={devices} dataSource={dataSource} ga={g.res} gaLoading={g.loading} gaFailure={g.failure} />;
}

/** 섹션·소개영상 표의 「전체/모바일/PC」 전환. 쓸 수 없으면 단추를 끄고 이유를 적는다. */
export function DeviceSwitch({
  value,
  onChange,
  available,
  note,
}: {
  value: DeviceFilter;
  onChange: (v: DeviceFilter) => void;
  available: boolean;
  /** 쓸 수 없을 때 보일 이유(기본: 보관 기간 안내). */
  note?: string;
}) {
  const opts: { key: DeviceFilter; label: string }[] = [
    { key: "all", label: "전체" },
    { key: "m", label: "모바일" },
    { key: "d", label: "PC" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5" role="group" aria-label="기기별로 보기">
        {opts.map((o) => (
          <button
            key={o.key}
            type="button"
            disabled={!available && o.key !== "all"}
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
            className={`rounded px-2.5 py-1 text-sm transition-colors disabled:opacity-40 ${
              value === o.key ? "bg-th-accent text-th-text-inverse" : "text-th-text-secondary hover:bg-th-card-hover"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {!available && (
        <span className="text-sm text-th-text-muted">{note ?? "기기별은 최근 90일 안에서만 나눠 볼 수 있습니다."}</span>
      )}
    </div>
  );
}
