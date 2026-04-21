# MagicBody GEO/AEO Tracker — 서버 배포 가이드

## 개요

- **도메인**: `https://cms.magicbodypilates.co.kr/geo-tracker`
- **내부 포트**: 8040 (컨테이너 3000 → 호스트 8040)
- **컨테이너명**: `mbd-geo-tracker`
- **이미지 저장소**: GHCR (`ghcr.io/magicbodypilates/magicbody-geo-tracker`)
- **인증 방식**: GHCR 는 GitHub 내장 `GITHUB_TOKEN` 사용 → ACR 관련 시크릿 불필요

## 1. GitHub Secrets (필요한 것만)

GHCR 전환으로 **레지스트리 시크릿 3개 제거**. SSH 관련 4개만 설정하면 됨.

| Secret | 용도 |
|---|---|
| `AZURE_DEV_HOST` | dev VM 접속 주소 |
| `AZURE_DEV_PORT` | dev VM SSH 포트 (`2222`) |
| `AZURE_DEV_USER` | dev VM 접속 계정 |
| `AZURE_DEV_SSH_KEY` | dev VM SSH 개인키 |

> 기존 MagicBody-Web repo 에 설정된 동일 시크릿 4개를 `MagicBody-GeoTracker` repo 에도 그대로 복사.
> GitHub 웹 → Settings → Secrets and variables → Actions → New repository secret.

### 1-1. GHCR 관련 1회 작업 (서버에서)

첫 배포 전에 **서버에서 1회** GHCR 로그인 필요 (private 이미지 pull 권한).

1. **GitHub Personal Access Token (classic) 발급**
   - https://github.com/settings/tokens → Generate new token (classic)
   - 권한: `read:packages` 만 체크
   - 생성된 토큰을 안전한 곳에 임시 저장

2. **서버에서 docker login**
   ```bash
   ssh <AZURE_DEV_USER>@<AZURE_DEV_HOST> -p 2222
   echo "<PAT>" | docker login ghcr.io -u magicbodypilates --password-stdin
   # 성공: "Login Succeeded" 메시지
   # 인증 정보는 ~/.docker/config.json 에 저장 → 서버 재시작해도 유지
   ```

3. (선택) 이미지를 public 으로 전환하면 서버 측 로그인 자체가 불필요
   - GitHub → 프로필 → Packages → `magicbody-geo-tracker` → Package settings → Change visibility → Public

## 2. 서버 최초 설정 (1회만)

SSH로 개발서버 접속 후:

```bash
# 1) 앱 디렉토리 생성
sudo mkdir -p /appdata/apps/geo-tracker
sudo chown $USER:$USER /appdata/apps/geo-tracker
cd /appdata/apps/geo-tracker

# 2) docker-compose.yml 생성 (아래 "3. 서버 docker-compose.yml" 내용 복사)
nano docker-compose.yml

# 3) .env 파일 생성 (실제 코드가 읽는 변수명 기준)
cat > .env <<'EOF'
# Bright Data (필수)
BRIGHT_DATA_KEY=<<여기에 Bright Data API 토큰 입력>>
BRIGHT_DATA_DATASET_CHATGPT=<<ChatGPT 스크래퍼 Dataset ID>>
BRIGHT_DATA_DATASET_PERPLEXITY=<<Perplexity 스크래퍼 Dataset ID>>
BRIGHT_DATA_DATASET_COPILOT=<<Copilot 스크래퍼 Dataset ID>>
BRIGHT_DATA_DATASET_GEMINI=<<Gemini 스크래퍼 Dataset ID>>
BRIGHT_DATA_DATASET_GOOGLE_AI=<<Google AI Overview 스크래퍼 Dataset ID>>
BRIGHT_DATA_DATASET_GROK=<<Grok 스크래퍼 Dataset ID>>
BRIGHT_DATA_SERP_ZONE=serp_n8n
BRIGHT_DATA_UNLOCKER_ZONE=web_unlocker1

# OpenRouter (선택: AEO 감사 / SRO 분석 / 사이트 컨텍스트 자동 추출)
OPENROUTER_KEY=<<선택: OpenRouter 키 입력>>

# Gemini (선택: Grounding 직접 호출)
GEMINI_API_KEY=<<선택: Gemini 키 입력>>

# ============== 인증 (필수) ==============
# 최고관리자 자체 로그인 비밀번호 (bcrypt 해시)
# 생성: node -e "require('bcryptjs').hash('원하는비밀번호',10).then(console.log)"
# 반드시 작은따옴표로 감쌀 것 — $ 가 env 변수 참조로 해석되는 것 방지
ADMIN_PASSWORD_HASH='<<bcrypt 해시 입력>>'

# 세션 쿠키 서명 시크릿 (32바이트 랜덤 hex, 64자)
# 생성: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=<<64자 hex 입력>>

# CMS API (일반관리자 role 조회)
CMS_API_DOMAIN=https://api.magicbodypilates.co.kr
CMS_API_APP_ID=<<CMS common.js 의 AppID>>
CMS_API_APP_KEY=<<CMS common.js 의 AppKey>>

# Firebase Admin SDK (ID 토큰 검증)
# Firebase 콘솔 → classnaom 프로젝트 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성
# 받은 JSON 전체를 한 줄로 만들어서 아래에 붙여넣기
FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON=<<서비스 계정 JSON 한 줄로>>

# 개발/테스트 편의 — CMS 세션 검증을 우회하고 아무 로그인도 통과시킴
# 초기 배포 검증용. 실제 운영에선 false 또는 제거.
DEV_AUTH_BYPASS=true
EOF

chmod 600 .env

# 4) 외부 네트워크 확인 (기존 nginx-proxy-network 재사용)
docker network ls | grep nginx-proxy-network

# 5) GHCR 로그인 (1-1 항목 참조 — 1회만)
# echo "<PAT>" | docker login ghcr.io -u magicbodypilates --password-stdin
```

## 3. 서버 docker-compose.yml

파일 경로: `/appdata/apps/geo-tracker/docker-compose.yml`

내용은 [server-docker-compose.yml](./server-docker-compose.yml) 참조.

## 4. 최초 이미지 배포

로컬에서 코드를 dev 브랜치에 push하면 GitHub Actions가 자동으로:
1. 도커 이미지 빌드 → GHCR push (`ghcr.io/magicbodypilates/magicbody-geo-tracker`)
2. SSH로 서버 접속 → `docker pull` → `docker compose up -d --force-recreate mbd-geo-tracker`

```bash
# GitHub 웹에서 수동 트리거도 가능:
# Actions → "Deployment to development" → Run workflow
```

## 5. Nginx Proxy Manager 라우팅 추가

NPM 웹 UI (`http://<서버IP>:81`) 접속 후:

### 기존 `cms.magicbodypilates.co.kr` 호스트 편집

1. Proxy Hosts → `cms.magicbodypilates.co.kr` → Edit
2. **Custom locations** 탭 → Add location
3. 다음 설정 입력:
   - **Location**: `/geo-tracker`
   - **Scheme**: `http`
   - **Forward Hostname/IP**: `mbd-geo-tracker`
   - **Forward Port**: `3000`
4. ⚙️ 기어 아이콘 → **Custom Nginx Configuration**:

```nginx
# WebSocket/스트리밍 지원 + Next.js basePath 유지
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 600s;
proxy_send_timeout 600s;
```

5. Save

> ⚠️ Next.js `basePath: '/geo-tracker'` 설정 때문에 앱이 `/geo-tracker`로 시작하는 경로를 자기 자신의 루트로 인식합니다. 따라서 NPM에서 path rewrite는 **불필요** (그대로 전달).

## 6. 접속 확인

```bash
# 서버에서 직접 컨테이너 확인
docker ps | grep mbd-geo-tracker
docker logs -f mbd-geo-tracker

# 서버 내부에서 curl 테스트
curl -I http://localhost:8040/geo-tracker
```

브라우저에서:
- https://cms.magicbodypilates.co.kr/geo-tracker → GEO/AEO Tracker 대시보드

## 7. 인증 구조 (두 경로 분리)

### 경로별 동작
- **`/geo-tracker`** (일반관리자): CMS Firebase 로그인 세션 필요. 비로그인 시 CMS 로그인 페이지로 리다이렉트. 일반관리자(role > 0)는 12개 탭만 노출.
- **`/geo-tracker/admin`** (최고관리자): 자체 비밀번호 로그인. CMS와 무관하게 항상 접속 가능. 전체 18개 탭 노출.

### Firebase 콘솔 설정 (1회)
1. [Firebase Console](https://console.firebase.google.com) → `classnaom` 프로젝트 선택
2. Authentication → Settings → Authorized domains → Add domain
   - `cms.magicbodypilates.co.kr` 추가 (없으면 CMS 세션 감지 실패)
3. 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성" → JSON 파일 다운로드
   - JSON 전체를 한 줄로 만들어 서버 `.env` 의 `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON` 에 입력
   - 예: `jq -c . service-account.json` 으로 한 줄 변환

### 최고관리자 비밀번호 변경
```bash
# 1) 새 해시 생성
node -e "require('bcryptjs').hash('새비밀번호',10).then(console.log)"

# 2) 서버에서 .env 편집
sudo nano /appdata/apps/geo-tracker/.env
# ADMIN_PASSWORD_HASH='<새 해시>' 로 교체

# 3) 컨테이너 재시작
cd /appdata/apps/geo-tracker && docker compose restart mbd-geo-tracker
```

### DEV_AUTH_BYPASS 전환 절차
초기 테스트서버 배포는 `DEV_AUTH_BYPASS=true` 로 시작해 최고관리자 경로만 먼저 검증 → Firebase 서비스 계정 설정 후 `false` 로 전환:
```bash
sudo nano /appdata/apps/geo-tracker/.env
# DEV_AUTH_BYPASS=false 로 수정
docker compose restart mbd-geo-tracker
```

### GitHub Actions 빌드 변수 (선택 — override 필요 시)
Firebase Web SDK 설정은 기본값이 Dockerfile/workflow 에 하드코딩되어 있음 (`classnaom` 프로젝트 공개값).
다른 Firebase 프로젝트로 바꾸려면 GitHub repo 의 Settings → Variables → Actions 에 아래 항목 추가:
- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

## 8. 운영 배포 (추후)

dev 브랜치 테스트 완료 후 운영 배포용 워크플로우는 `deployment-production.yml`를 추가로 작성해야 합니다. (운영 도메인은 추후 결정)

## 롤백

```bash
# 서버 SSH 접속 후
cd /appdata/apps/geo-tracker
IMAGE_REPO="ghcr.io/magicbodypilates/magicbody-geo-tracker"
docker pull ${IMAGE_REPO}:<이전 dev-SHA>
docker tag ${IMAGE_REPO}:<이전 dev-SHA> ${IMAGE_REPO}:latest
docker compose up -d --force-recreate mbd-geo-tracker
```
