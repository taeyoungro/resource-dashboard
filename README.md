# resource-dashboard

`event_pipeline` (IAM 이벤트 파이프라인)의 **관리자 승인 단계**를 브라우저에서
처리하기 위한 프론트엔드 대시보드.

기존 파이프라인은 `Pipeline._prompt_admin_approval()`에서 서버의 `/dev/tty` 에
배너를 출력하고 `y/N` 입력을 기다리는 구조였다. 이 대시보드는 그 자리를
대체해서 — 관리자가 웹 UI에서 "승인" 버튼을 누르면 백엔드의 await 중인
승인 코루틴이 깨어나 `TerraformRunner.apply_plan()`이 호출되도록 한다.

## 스택

- Vite + React 18 + TypeScript
- 빌드 산출물은 `dist/`. dev에서는 `/api/*` 를 `VITE_PIPELINE_URL` (기본
  `http://localhost:8000`)로 프록시.

## 화면

- **왼쪽 사이드바**: pending 승인 요청 목록 (5초 폴링)
  - 액션 배지 (`ATTACH` / `REFRESH` / `DELETE`), 상태 배지, role 이름,
    계정 ID, 요청자 IIC user, 마지막 이벤트 시간.
- **상세 패널**:
  - `request_id`, 대상 계정 목록, 상태 등 메타
  - RAG 정책 분석 표 (`policy_details`의 `is_necessary` / `confidence` /
    `reason` — `policy_fetcher.py` 흐름과 동일)
  - 저장된 approval report 원문
  - `terraform plan` 출력 tail
  - **승인 / 거부 액션** (Reviewer ID 필수, 거부 시 사유 필수)

API 키는 `X-API-Key` 헤더로 전송(파이프라인 서버의 `/webhook` 키와 동일한
체계). 사이드바 입력란에 저장하면 `localStorage`에 보관된다.

## 백엔드(event_pipeline) 측이 추가로 노출해야 할 엔드포인트

이 프론트는 다음 3개 엔드포인트를 호출한다. 현재 `src/iam_pipeline/codegen/server.py`
에는 존재하지 않으므로 별도 PR로 추가 필요:

| Method | Path | 설명 |
| ------ | ---- | ---- |
| `GET`  | `/approvals` | pending/recent 요청 목록 (`ApprovalSummary[]`) |
| `GET`  | `/approvals/{request_id}` | 상세 (`ApprovalDetail`: policy_details, plan tail, report 본문 포함) |
| `POST` | `/approvals/{request_id}/decision` | `{ decision: "approve"\|"deny", reviewer, comment? }` |

구현 가이드:

1. `Pipeline._prompt_admin_approval`을 `asyncio.Future` 기반으로 교체.
   `request_id`를 키로 하는 `pending_decisions: dict[str, Future[bool]]`을
   `BufferManager`(또는 `Pipeline`)에 둔다.
2. `/approvals/{id}/decision` 핸들러는 해당 Future를 `set_result(True/False)`
   로 깨운다. 그러면 코루틴이 깨어나 `runner.apply_plan(...)` 또는 cleanup.
3. `/approvals`는 `pending_decisions` 키 + 디스크의 `<request_id>.json`
   (`settings.approval_report_dir`)을 머지해서 응답.

## 개발

```bash
npm install
VITE_PIPELINE_URL=http://localhost:8000 npm run dev
# http://localhost:5173
```

빌드:

```bash
npm run build   # dist/
npm run preview
```

배포 시에는 nginx 등에서 `/api/*` 를 파이프라인 FastAPI(`uvicorn` 8000)
프로세스로 프록시하면 된다.
