# resource-dashboard — `opt-SolutionDashboard`

IAM 거버넌스 파이프라인의 **승인 화면**과 **실패 조회 화면**. EC2 인스턴스에서 돌고, 인스턴스
프로파일로 역할을 받는다.

## 무엇이 바뀌었나

이전에는 브라우저에서만 도는 화면이었다. `npm run dev`로 로컬에서 띄우고, Vite 개발 서버가
`/api/*`를 존재하지 않는 FastAPI 프로세스로 넘겼다. **호출할 백엔드가 없었으므로 어떤 화면도 실제
데이터를 보여준 적이 없다.**

이제 대시보드가 스스로 권한을 갖는다. 그러려면 **AWS를 호출하는 주체가 브라우저가 아니어야 한다** —
브라우저에 자격 증명을 두지 않는다는 것이 이 솔루션의 전제이기 때문이다. 그래서 이 저장소에 서버
프로세스가 생겼다.

| | 이전 | 지금 |
|---|---|---|
| 실행 위치 | 관리자 노트북 | EC2 인스턴스 |
| 자격 증명 | 없음 (호출할 곳도 없음) | 인스턴스 프로파일 `opt-SolutionDashboard` |
| AWS 호출 주체 | — | 서버 프로세스. 브라우저는 S3를 모른다 |
| `/api` | 있지도 않은 FastAPI로 프록시 | 같은 프로세스가 응답 |
| 정적 파일 | Vite 개발 서버 | 같은 프로세스가 `dist/` 제공 |
| 데이터 모형 | `role_name`·`policy_arns`·RAG 분석 (아무도 만들지 않음) | 마커 버킷과 상태 버킷에 실제로 있는 것 |

**한 오리진, 한 프로세스.** 화면을 주는 쪽과 `/api`에 답하는 쪽이 같으므로 완화할 CORS도, 맞춰
둘 두 번째 호스트도 없다.

---

## 하는 일

```
                    ┌─ s3://opt-solution-markers/inspector/*   읽기
브라우저 ─ HTTP ─ 서버 ├─ s3://opt-solution-markers/applier/*     읽기 + 쓰기
                    └─ s3://opt-org-policy-terraform-state/plans/*  읽기
```

### 1. 승인

상태 버킷의 `plans/<request_id>/`를 훑어 계획을 목록으로 만든다. 하나를 고르면 `plan.txt`와
`main.tf.json`, 그리고 `plan.json`에서 뽑은 변경 목록을 보여준다.

승인하면 **객체 하나를 쓰는 것이 전부다** — `applier/<request_id>.json`. 적용기를 직접 실행하지
않는다. 이 역할에는 `ecs:RunTask`도 `iam:PassRole`도 없고, 그것이 사람이 로그인하는 표면에 대한
제약이다. 그 객체가 생기는 이벤트로 적용기가 시작된다.

승인 마커에는 **그때 본 계획의 sha256이 들어간다.** 적용기의 첫 번째 일은 버킷에 있는 계획이
아직 그 계획인지 확인하는 것이다 — 다이제스트가 다르면 결정과 실행 사이에 산출물이 바뀐 것이고,
어떤 승인도 지금 그 안에 있는 것을 승인한 적이 없다.

### 2. 실패

마커는 **그 작업이 완료되지 않았음**을 뜻한다. 정상 종료하는 모든 경로가 마커를 지우므로, 남아
있다는 것은 실행 중이거나 죽었다는 것이다.

이것이 이 화면이 있어야 하는 이유다. **이미지를 받지 못한 경우, 경로 없는 서브넷, 메모리 부족,
시작 전 중지는 로그도 종료 코드도 남기지 못한다.** 남기는 것은 마커뿐이다.

마커가 유예 기간(기본 15분)보다 어리면 **실행 중**으로 표시한다. terraform init을 막 시작한 작업을
"실패"라고 부르면 아무도 이 목록을 보지 않게 된다.

### 3. 조회 주기

서버는 **시작할 때 한 번, 그리고 24시간마다** 두 버킷을 훑는다. 이것이 알림 경로를 진실 원천으로
삼지 않아도 되게 만든다 — 람다 호출이 유실되어도 객체는 그대로 있고, 인스턴스가 교체돼도 뜨자마자
정확하다. 화면의 "버킷 다시 조회" 버튼으로 즉시 돌릴 수도 있다.

브라우저의 15초 폴링은 **서버가 마지막에 본 것**을 묻는 것이고 S3를 부르지 않는다.

### 알려진 한계 — 화면에도 적어 두었다

**적용이 끝난 계획도 목록에 남는다.** 적용기가 끝나면서 자기 마커를 지우고 그 자리에 아무것도 쓰지
않으므로, 아직 아무도 보지 않은 계획과 이미 적용된 계획을 구별할 수단이 없다. 이미 적용된 계획을
다시 승인해도 저장된 계획 파일이 낡았으므로 적용 단계에서 실패한다 — 피해는 거기서 멈춘다.

고치는 자리는 적용기다(같은 접두사에 종결 객체를 하나 쓰면 된다). `event_pipeline`의
`code/README.md`에 미결정으로 기록되어 있다.

---

## 인증에 대해 정직하게

`X-API-Key` 하나다. 이것은 **문지기이지 신원이 아니다.** 호출자가 비밀값을 가지고 이 기계에
닿았다는 것만 말하고, 누구인지는 말하지 않는다. 따라서 결정에 기록되는 **검토자 이름은
자기 신고다.**

그 간극을 메우려면 이 서버 앞에 사람을 확인하는 것이 있어야 한다 — OIDC를 수행하는 애플리케이션
로드 밸런서나 Identity Center. 그때까지는 결정에 적힌 이름과 CloudTrail이 기록하는 역할 사이에
간극이 있고, **그 사실을 아는 편이 안심시키는 것보다 낫다.**

서버는 32자 미만의 키를 거부한다. 강도 측정이 아니라, 이 시스템에서 승인을 쓸 수 있는 유일한
주체 앞에 서 있는 값이 손으로 타이핑한 것이어서는 안 되기 때문이다.

---

## 배포

### 0. 사전 조건

| 항목 | 확인 방법 |
|---|---|
| `opt-stack-dashboard-host` 스택 배포 완료 | `opt-SolutionDashboard` 역할과 같은 이름의 인스턴스 프로파일이 있다 |
| 마커 버킷 `opt-solution-markers` 존재 | 버전 관리 비활성, 수명 주기 규칙 없음 |
| 상태 버킷 `opt-org-policy-terraform-state` 존재 | `plans/` 접두사에 계획이 쌓인다 |
| EC2 인스턴스 | Amazon Linux 2023 또는 Ubuntu 22.04 이상. **인스턴스 프로파일로 `opt-SolutionDashboard`를 지정해 시작** |
| 인스턴스에 Node 20 이상 | 아래 1단계 |

인스턴스 프로파일은 **시작할 때 지정한다.** 나중에 붙일 수도 있지만, 붙이기 전에 설치를 끝내면
서버가 자격 증명 오류로 조회에 실패하고 그 로그를 읽느라 시간을 쓴다.

### 1. 인스턴스 준비 — 한 번만

```bash
# Amazon Linux 2023
sudo dnf install -y nodejs npm
node --version                      # v20 이상인지 확인

# 배포판 패키지가 낮으면 NodeSource
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo dnf install -y nodejs
```

```bash
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
```

환경 변수 파일을 만든다. **깃허브 액션은 이 파일을 만들지 않는다** — 배포가 자격 증명을 덮어쓰는
경로를 두지 않기 위해서다.

```bash
sudo mkdir -p /etc/opt-dashboard
sudo curl -o /etc/opt-dashboard/dashboard.env \
  https://raw.githubusercontent.com/<owner>/resource-dashboard/main/deploy/dashboard.env.example
# 또는 저장소를 한 번 내려받아 deploy/dashboard.env.example 를 복사

openssl rand -hex 32                # 키를 만든다. 지어내지 않는다.
sudo vi /etc/opt-dashboard/dashboard.env      # OPT_DASHBOARD_API_KEY 채우기
sudo chmod 0640 /etc/opt-dashboard/dashboard.env
```

배포 사용자에게 필요한 `sudo` 권한은 두 가지다 — `install.sh` 실행과 `systemctl restart`.

`install.sh`는 이 파일이 없으면 **아무것도 설치하기 전에** 멈춘다. 예제를 그대로 복사해 쓰는
경로를 남겨 두면 서버가 뜨고, 서비스가 active를 보고하고, 배포가 성공을 보고하고, 화면은 빈 목록을
보여준다 — 그리고 **빈 목록은 아무 문제 없는 시스템과 똑같이 생겼다.**

### 2. 깃허브 액션

`.github/workflows/deploy-dashboard.yml`. `main`에 밀면 `src/`·`server/`·`deploy/`·빌드 설정이
바뀐 경우에만 돈다. Actions → **deploy dashboard** → Run workflow로 직접 돌릴 수도 있다(사유 입력
필수 — 커밋이 설명해 주지 않는 배포이므로 실행 제목에 남는다).

두 작업으로 나뉜다.

| 작업 | 하는 일 | 환경 |
|---|---|---|
| `build` | `npm ci` → `npm run check`(16개) → `npm run build` → `dist`+`server`+`deploy`+lock 파일을 묶음 | 없음 — **그래서 아래 비밀값에 닿을 수 없다** |
| `deploy` | 묶음을 SSH로 보내고 `install.sh` 실행, 재시작, `/api/health` 확인 | `dashboard` |

**인스턴스에서 빌드하지 않는다.** 승인 화면을 서비스하는 기계에 TypeScript 컴파일러와
devDependencies를 두는 것은 그 일에 필요한 것보다 많은 소프트웨어다. `node_modules`는 묶음에
넣지 않는다 — 호스트에서 같은 lock 파일로 `npm ci --omit=dev`를 돌리므로, 런타임 의존성은 호스트
아키텍처에 맞게 다시 해석된다.

#### 등록해야 하는 것

Settings → Environments → **New environment** → 이름 `dashboard`. 그 환경의 **Environment
secrets**에 넣는다(Repository secrets가 아니다 — 환경에 두어야 `build` 작업이 닿지 못한다).

| 비밀값 | 값 | 얻는 방법 |
|---|---|---|
| `DASHBOARD_SSH_HOST` | 인스턴스 주소 | 퍼블릭 IP 또는 DNS 이름 |
| `DASHBOARD_SSH_USER` | `ec2-user` 또는 `ubuntu` | 이미지에 따라 |
| `DASHBOARD_SSH_KEY` | 개인 키 **전문** | `-----BEGIN ...` 줄부터 마지막 줄까지 그대로 |
| `DASHBOARD_SSH_KNOWN_HOSTS` | 호스트 키 | **신뢰할 수 있는 기계에서** `ssh-keyscan -H <주소>` |
| `DASHBOARD_SSH_PORT` | (선택) 22가 아니면 | |

`DASHBOARD_SSH_KNOWN_HOSTS`는 선택이 아니다. 비어 있으면 워크플로가 멈춘다. 대안으로 손이 가는
`StrictHostKeyChecking=no`는 **그 주소에서 응답하는 무엇이든 받아들이는 것**이고, 이 작업은 그
다음에 호스트 `sudo` 권한이 있는 키를 건넨다.

환경에 **Required reviewers**를 걸면 이 파일을 고치지 않고도 배포에 승인 단계가 생긴다.

#### 배포가 성공을 어떻게 판정하는가

`systemctl is-active`만 보면 **뜨고 죽고 systemd가 다시 띄우는 것을 성공으로 읽는다.** 그래서
재시작 횟수를 배포 전후로 비교하고, 12초를 기다린 뒤(`RestartSec=5`를 두 번 덮는다) 다시 센다.
그 다음 호스트 안에서 `/api/health`를 부른다 — 서버가 루프백에만 바인딩하므로 러너에서 부르면
네트워크 경로를 검사하는 것이지 배포를 검사하는 것이 아니다.

이 판정이 실제로 잡는 실패가 하나 있다. **`OPT_DASHBOARD_API_KEY`가 비었거나 짧으면 서버는 매번
종료 코드 2로 죽는다.** 재시작 횟수가 늘어나므로 배포가 실패로 끝난다.

### 3. 손으로 배포 — 액션을 쓰지 않을 때

```bash
# 빌드한 곳에서
npm ci && npm run check && npm run build
rsync -av --delete --exclude node_modules --exclude .git \
  ./ ec2-user@<인스턴스>:/tmp/resource-dashboard/

# 인스턴스에서
cd /tmp/resource-dashboard
sudo OPT_RELEASE=$(git rev-parse --short HEAD) ./deploy/install.sh
sudo systemctl restart opt-dashboard
```

`install.sh`가 하는 일: `opt-dashboard` 사용자 생성 → `/opt/opt-dashboard`에 `server/`와 `dist/`
배치 → `npm ci --omit=dev`(AWS SDK 하나) → systemd 유닛 설치·활성화. 재실행해도 안전하고,
`server/`와 `dist/`를 **합치지 않고 통째로 교체한다** — 이전 버전에서 남은 모듈은 여전히
import되고, 이전 빌드에서 남은 자산은 여전히 서비스된다.

### 4. 확인

```bash
sudo systemctl status opt-dashboard
curl -s localhost:8080/api/health
journalctl -u opt-dashboard -n 50 --no-pager
```

기동 직후 로그에 이 두 줄이 있어야 한다.

```
INFO  listening on 127.0.0.1:8080 release=... markers=s3://... state=s3://... region=...
INFO  sweep reason="startup" failed=0 running=0 awaiting=1 errors=0 took=412ms
```

`sweep FAILED`가 보이면 **권한이나 버킷 이름 문제이지 코드 문제가 아니다.** 메시지가 어느 버킷의
어느 접두사에서 실패했는지 말한다.

### 5. 접속

서버는 기본적으로 **루프백에만 바인딩한다.** 평문 HTTP이고 인증서를 갖지 않으므로, 라우팅 가능한
주소에 붙이면 API 키가 모든 요청마다 평문으로 네트워크를 지난다.

**바로 쓰려면 — SSH 터널**

```bash
ssh -L 8080:127.0.0.1:8080 ec2-user@<인스턴스>
# 브라우저에서 http://localhost:8080
```

**계속 쓰려면 — nginx + TLS**

```nginx
server {
  listen 443 ssl;
  server_name dashboard.example.internal;

  ssl_certificate     /etc/ssl/certs/dashboard.pem;
  ssl_certificate_key /etc/ssl/private/dashboard.key;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

이 경우에도 `OPT_BIND_ADDRESS`는 `127.0.0.1`로 둔다 — nginx가 같은 기계에서 붙는다. 보안 그룹은
443만 연다.

`OPT_BIND_ADDRESS=0.0.0.0`은 한 줄이지만 **결정이지 기본값이 아니다.** 서버가 기동 로그에 경고를
남긴다.

---

## 문제 해결

| 증상 | 원인 | 확인 |
|---|---|---|
| `configuration: missing configuration: ...` 후 종료 코드 2 | 환경 변수 파일이 비었거나 없다 | `sudo cat /etc/opt-dashboard/dashboard.env` |
| `OPT_DASHBOARD_API_KEY must be at least 32 characters` | 키가 짧다 | `openssl rand -hex 32` |
| 액션이 `restarted N time(s)`로 실패 | 서버가 뜨자마자 죽고 있다 | 위 두 줄이 대부분이다 |
| `sweep FAILED ... AccessDenied` | 인스턴스 프로파일이 없거나 다른 역할이다 | `curl -s http://169.254.169.254/latest/meta-data/iam/info` |
| `sweep FAILED ... list s3://.../plans/ failed` | 상태 버킷 `ListBucket`의 `s3:prefix` 조건 | 스택의 `ListPlanArtifacts` 문 확인 |
| 화면은 뜨는데 401 | 브라우저에 키를 저장하지 않았다 | 우측 상단 입력란 → 저장 |
| 목록이 비었고 오류도 없다 | 버킷 이름이 틀렸다 (조회는 성공하고 결과가 없다) | 기동 로그의 `markers=s3://...` 줄과 실제 버킷 이름 대조 |
| `the page has not been built` | `dist/`가 없다 | 액션의 `build` 작업 로그 확인 |
| 승인 시 `AccessDenied` | 역할의 `PutObject`가 `applier/*`로 한정되어 있다 | 키가 `applier/`로 시작하는지 로그에서 확인 |
| 액션 `prepare ssh`에서 멈춤 | `DASHBOARD_SSH_KNOWN_HOSTS`가 비었다 | 신뢰할 수 있는 기계에서 `ssh-keyscan -H <주소>` |

로그는 전부 journal로 간다.

```bash
journalctl -u opt-dashboard -f
journalctl -u opt-dashboard --since '1 hour ago' | grep -E 'ERROR|WARN'
journalctl -u opt-dashboard | grep 'decision '     # 누가 무엇을 결정했는지
```

---

## 개발

인스턴스 없이 돌리려면 서버에 자격 증명이 필요하다. `opt-SolutionDashboard`를 수임한 세션을
환경에 넣는다.

```bash
# 1) 서버
export OPT_MARKER_BUCKET=opt-solution-markers
export OPT_STATE_BUCKET=opt-org-policy-terraform-state
export OPT_DASHBOARD_API_KEY=$(openssl rand -hex 32)
export AWS_REGION=us-east-1
npm run server

# 2) 다른 터미널에서 화면
npm run dev        # http://localhost:5173, /api 를 127.0.0.1:8080 으로 프록시
```

`npm run check`는 AWS를 부르지 않는다 — 조회 로직과 설정 거부를 가짜 클라이언트로 검사한다.

```
server/config.js   환경 변수. 추측할 수 없는 값에 기본값을 두지 않는다
server/s3.js       S3 호출 전부
server/sweep.js    버킷 내용 -> 화면이 보는 것
server/api.js      라우트, 인증, 승인 마커 본문
server/static.js   빌드된 화면 제공
server/index.js    기동, 조회 주기, 종료
```
