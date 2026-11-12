/**
 * 사이드바 바로가기 링크 목록 — 서버에서만 import 한다.
 *
 * 주소는 클라이언트 번들에 상수로 두지 않는다. 세션을 확인한 서버 컴포넌트가
 * 이 함수의 결과를 prop 으로 넘길 때만 그 응답에 실린다.
 * 클라이언트 컴포넌트에서 import 하면 `server-only` 때문에 빌드가 실패한다.
 *
 * 주소는 CMS_CONSOLE_URL 환경변수가 우선이고, 없거나 무효하면 실행 환경별 기본값을 쓴다.
 * 허용: https + 허용 호스트, 개발 실행에서만 http://localhost. 사용자 정보가 든 주소는 거부.
 */
import "server-only";

export type ConsoleLink = { label: string; href: string };

export type ConsoleLinkSessionKind = "admin" | "user" | null;

const PROD_CMS_CONSOLE_URL = "https://cms.magicbodypilates.co.kr/BoardAdmin/Gate";
const DEV_CMS_CONSOLE_URL = "http://localhost:5045/BoardAdmin/Gate";

const ALLOWED_HOSTS: readonly string[] = ["cms.magicbodypilates.co.kr", "localhost"];

type Env = Record<string, string | undefined>;

type Logger = (message: string) => void;

const defaultLogger: Logger = (message) => console.warn(message);

/** 허용 규칙을 통과한 주소면 정규화된 문자열, 아니면 null. */
export function validateCmsConsoleUrl(value: string, isDev: boolean): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (!ALLOWED_HOSTS.includes(u.hostname)) return null;
  if (u.protocol === "https:") return u.toString();
  if (u.protocol === "http:" && isDev && u.hostname === "localhost") return u.toString();
  return null;
}

/** CMS 관리 화면 주소. 환경변수 값이 무효하면 경고 한 줄(값은 남기지 않음) 후 기본값. */
export function resolveCmsConsoleUrl(env: Env = process.env, log: Logger = defaultLogger): string {
  const isDev = env.NODE_ENV === "development";
  const fallback = isDev ? DEV_CMS_CONSOLE_URL : PROD_CMS_CONSOLE_URL;
  const configured = (env.CMS_CONSOLE_URL ?? "").trim();
  if (!configured) return fallback;
  const valid = validateCmsConsoleUrl(configured, isDev);
  if (valid) return valid;
  log("[console-links] CMS_CONSOLE_URL 값이 무효해 기본 주소를 사용합니다");
  return fallback;
}

/** kind="admin" 세션에만 링크를 돌려준다. 그 외(일반 세션·비로그인)는 빈 배열. */
export function consoleLinksFor(
  kind: ConsoleLinkSessionKind,
  env: Env = process.env,
  log: Logger = defaultLogger,
): ConsoleLink[] {
  if (kind !== "admin") return [];
  return [{ label: "CMS 관리 화면", href: resolveCmsConsoleUrl(env, log) }];
}
