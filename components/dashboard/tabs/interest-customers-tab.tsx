/**
 * 관심 고객 탭 (상위 권한 전용) — 하위 구분 3개를 묶는 껍데기
 *   task_id: magicbody-preview-ebook-click-2026-08-09
 *
 *   ├ 결제 전 이탈 — 과정 상세를 봤지만 결제하지 않은 회원  (기존 화면 그대로 · RetargetAbandonerTab)
 *   ├ 가입 전 이탈 — 맛보기·전자책을 눌렀는데 아직 가입하지 않은 사람 (신규)
 *   └ 가입 전환   — 그 경로로 가입까지 간 회원 명단             (신규)
 *
 * ⭐ 탭 식별 키는 그대로 "Abandoners" 다 — **보이는 제목만** "관심 고객"으로 바꿨다.
 *    키를 바꾸면 권한별 숨김 목록(types.ts REGULAR_ADMIN_HIDDEN_TABS)과 저장된 화면 상태(localStorage
 *    activeTab)가 **조용히** 깨진다. 화면에 아무 오류도 안 뜨고 탭만 안 열리는 형태라 알아채기 어렵다.
 *
 * ⚠️ 이 탭은 이름을 표시하므로 권한별 숨김 목록에서 절대 빼지 말 것(types.ts 주석 참조).
 *
 * ⭐ 하위 구분을 바꿔도 조회 기간은 **유지**한다(아래 lookbackDays 를 여기서 들고 있는 이유).
 *    "60일로 보다가 화면만 바꿨는데 기간이 되돌아가는" 일을 막는다. 다만 '결제 전 이탈'은 자기 필터를
 *    이미 갖고 있어 건드리지 않는다 — 기존 화면 무변경 원칙(기능·수치·문구 그대로).
 */

"use client";

import { useState } from "react";
import { RetargetAbandonerTab } from "@/components/dashboard/tabs/retarget-abandoner-tab";
import {
  CardClickPreSignupView,
  CardClickSignupView,
} from "@/components/dashboard/tabs/card-click-views";

type SubTab = "abandon" | "preSignup" | "signup";

const SUB_TABS: { key: SubTab; label: string; hint: string }[] = [
  {
    key: "abandon",
    label: "결제 전 이탈",
    hint: "과정 상세페이지를 봤지만 결제하지 않은 회원",
  },
  {
    key: "preSignup",
    label: "가입 전 이탈",
    hint: "맛보기 영상·전자책을 눌렀는데 아직 회원가입하지 않은 사람",
  },
  {
    key: "signup",
    label: "가입 전환",
    hint: "맛보기 영상·전자책을 보고 회원가입까지 간 회원 명단",
  },
];

export function InterestCustomersTab() {
  /** 기본은 기존 화면 — 지금까지 이 탭에서 보시던 것이 그대로 먼저 열린다. */
  const [sub, setSub] = useState<SubTab>("abandon");
  /** 새 두 화면이 함께 쓰는 조회 기간(일). 하위 구분을 오가도 유지된다. */
  const [lookbackDays, setLookbackDays] = useState(60);

  return (
    <div className="space-y-5">
      {/* ── 하위 구분 전환 ── */}
      <div className="flex flex-wrap gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setSub(t.key)}
            title={t.hint}
            aria-current={sub === t.key ? "page" : undefined}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              sub === t.key
                ? "bg-th-accent text-th-text-inverse"
                : "text-th-text-secondary hover:bg-th-card-hover"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-th-text-muted">
        {SUB_TABS.find((t) => t.key === sub)?.hint}
      </p>

      {sub === "abandon" && <RetargetAbandonerTab />}
      {sub === "preSignup" && (
        <CardClickPreSignupView lookbackDays={lookbackDays} onLookbackDaysChange={setLookbackDays} />
      )}
      {sub === "signup" && (
        <CardClickSignupView lookbackDays={lookbackDays} onLookbackDaysChange={setLookbackDays} />
      )}
    </div>
  );
}
