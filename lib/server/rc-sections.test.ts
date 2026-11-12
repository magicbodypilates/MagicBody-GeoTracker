import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetRcSectionsCache, getRcSections, labelTitle, parseRcSections } from "./rc-sections";

const HTML = `
<section class="hero" data-screen-label="01 히어로" id="hero" aria-labelledby="t">x</section>
<!-- <section id="old" data-screen-label="99 옛것"></section> -->
<section id="no-label">x</section>
<section data-screen-label="06-1 재활 &amp; 특화" id="rehab-curriculum">x</section>
<section id="Bad_ID" data-screen-label="02 형식 밖">x</section>
<section id="hero" data-screen-label="01 중복">x</section>
<section id='faq' data-screen-label='19 FAQ'>x</section>
`;

describe("parseRcSections", () => {
  it("이름표 붙은 섹션만 등장 순서로 · 주석·형식 밖·중복 제외 · 앞 번호 떼기", () => {
    expect(parseRcSections(HTML)).toEqual([
      { id: "hero", title: "히어로" },
      { id: "rehab-curriculum", title: "재활 & 특화" },
      { id: "faq", title: "FAQ" },
    ]);
  });
  it("labelTitle — 번호만 있으면 그대로", () => {
    expect(labelTitle("20 최종 CTA")).toBe("최종 CTA");
    expect(labelTitle("07")).toBe("07");
  });
});

describe("getRcSections — 한 시간 보관 · 실패하면 지난 결과", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetRcSectionsCache();
  });
  it("성공하면 보관하고, 한 시간 안에는 다시 가져오지 않는다", async () => {
    const f = vi.fn(async () => new Response(HTML, { status: 200 }));
    vi.stubGlobal("fetch", f);
    const t0 = Date.now();
    expect((await getRcSections(t0)).sections?.length).toBe(3);
    await getRcSections(t0 + 30 * 60 * 1000);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("처음부터 실패하면 null, 보관 뒤 실패하면 지난 결과(stale)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect(await getRcSections()).toEqual({ sections: null, stale: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(HTML, { status: 200 })));
    await getRcSections();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const r = await getRcSections(Date.now() + 2 * 60 * 60 * 1000);
    expect(r.stale).toBe(true);
    expect(r.sections?.map((s) => s.id)).toEqual(["hero", "rehab-curriculum", "faq"]);
  });
});
