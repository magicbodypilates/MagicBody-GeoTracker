import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 토큰 파일 경로 — 재빌드 시 유실되지 않도록 절대경로 권장.
 * 우선순위: GSC_TOKEN_FILE (절대경로) → cwd/.gsc-tokens.json (개발 모드 기본)
 *
 * Next.js standalone 모드로 실행할 경우 process.cwd() 가 .next/standalone
 * 아래가 되어 재빌드 시 토큰이 삭제됨. 운영 환경에서는 반드시 GSC_TOKEN_FILE
 * 를 프로젝트 루트의 절대경로로 지정할 것.
 */
const TOKEN_FILE = process.env.GSC_TOKEN_FILE
  ? path.resolve(process.env.GSC_TOKEN_FILE)
  : path.join(process.cwd(), ".gsc-tokens.json");
/**
 * OAuth scope — GSC(Search Console)와 GA4 Data API를 한 번의 인증으로 함께 사용.
 * 두 API 모두 readonly 권한만 요청.
 */
export const GSC_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];

type StoredTokens = {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
  token_type?: string | null;
  siteUrl?: string | null;
};

function getRedirectUri(): string {
  const explicit = process.env.GSC_REDIRECT_URI;
  if (explicit) return explicit;
  const base = process.env.GSC_PUBLIC_ORIGIN ?? "http://localhost:3000";
  const bp = process.env.NEXT_PUBLIC_BASE_PATH ?? "/geo-tracker";
  return `${base}${bp}/api/gsc/callback`;
}

export function createOAuthClient(): OAuth2Client {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET 가 .env.local 에 설정되지 않았습니다.");
  }
  return new google.auth.OAuth2(id, secret, getRedirectUri());
}

export async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    const envRefresh = process.env.GOOGLE_REFRESH_TOKEN;
    const envSite = process.env.GSC_SITE_URL;
    if (envRefresh) {
      return { refresh_token: envRefresh, siteUrl: envSite ?? null };
    }
    return null;
  }
}

export async function saveTokens(patch: Partial<StoredTokens>): Promise<void> {
  const existing = (await loadTokens()) ?? {};
  const next: StoredTokens = { ...existing, ...patch };
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(next, null, 2), "utf8");
}

/** Return an authenticated OAuth2 client ready to call GSC API. */
export async function getAuthedClient(): Promise<OAuth2Client> {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("GSC 인증이 필요합니다. /api/gsc/auth 에서 최초 1회 승인을 진행하세요.");
  }
  const oauth = createOAuthClient();
  oauth.setCredentials({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
  });
  oauth.on("tokens", (t) => {
    void saveTokens({
      access_token: t.access_token ?? null,
      expiry_date: t.expiry_date ?? null,
      scope: t.scope ?? null,
      token_type: t.token_type ?? null,
      ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    });
  });
  return oauth;
}

export function getAuthUrl(state?: string): string {
  const oauth = createOAuthClient();
  return oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GSC_SCOPES,
    state,
  });
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const oauth = createOAuthClient();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("refresh_token 이 응답에 포함되지 않았습니다. Google 계정 연결을 해제 후 다시 시도하세요.");
  }
  await saveTokens({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token ?? null,
    expiry_date: tokens.expiry_date ?? null,
    scope: tokens.scope ?? null,
    token_type: tokens.token_type ?? null,
  });
}

/** Convenience: Search Analytics query. */
export async function gscSearchAnalytics(params: {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: Array<"query" | "page" | "device" | "country" | "date">;
  rowLimit?: number;
  startRow?: number;
}) {
  const auth = await getAuthedClient();
  const webmasters = google.webmasters({ version: "v3", auth });
  const response = await webmasters.searchanalytics.query({
    siteUrl: params.siteUrl,
    requestBody: {
      startDate: params.startDate,
      endDate: params.endDate,
      dimensions: params.dimensions ?? ["query"],
      rowLimit: params.rowLimit ?? 100,
      startRow: params.startRow ?? 0,
    },
  });
  return response.data;
}

export async function gscListSites(): Promise<string[]> {
  const auth = await getAuthedClient();
  const webmasters = google.webmasters({ version: "v3", auth });
  const { data } = await webmasters.sites.list();
  return (data.siteEntry ?? [])
    .filter((s) => s.permissionLevel && s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => s.siteUrl!)
    .filter(Boolean);
}

export async function getSavedSiteUrl(): Promise<string | null> {
  const tokens = await loadTokens();
  return tokens?.siteUrl ?? null;
}

export async function setSavedSiteUrl(siteUrl: string): Promise<void> {
  await saveTokens({ siteUrl });
}

export async function isAuthed(): Promise<boolean> {
  const t = await loadTokens();
  return Boolean(t?.refresh_token);
}
