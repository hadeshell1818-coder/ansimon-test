# AI 오류 처리 변경 (2026-10-13)

로컬 코드 수정이며 운영 배포는 별도 확인이 필요하다. 기존 신고 파일, 사진, 음성, 귀국보고, 평가 이력의 초기화·이관·일괄 정정은 수행하지 않는다.

## 처리 범위

- `ai-json.cjs`: 응답 잘림 및 JSON 오류에만 출력 한도를 늘려 한 번 재시도. 인증·요청 오류·연결 오류는 단계별 안내를 반환한다. 저장·발송 요청은 재시도하지 않는다.
- `safety-knowledge.cjs`: 기본 GPT-4.1 검색 옵션 호환성, 공식기관 URL 검증, 검색 장애와 근거 부재 구분, 무근거 초안 중단, 승인된 내부 근거 우선 사용, 사용자별 서버 근거 세션 재사용.
- `public/risk.html`: 장애/근거 없음/담당자 검토 필요를 구분하고 기존 위험요인 문장을 자동 변경하지 않는다. 검토 대화의 수정안은 담당자가 반영한다. 새로운 근거를 다시 검색하는 선택 제공.
- `server.js`, `public/safety.html`: 안전알림 및 신규 신고 사진 해석의 JSON 처리 보완. 소통실은 AI 실패 시 원본 확인 안내와 규칙 기반 문구를 제공하며 발송 실패 시 편집 내용과 대상 선택을 유지한다.

## 검증

가상 OpenAI 응답과 격리된 테스트 자료로 검증하며 실데이터나 API 사용료를 발생시키는 호출은 하지 않는다.

```powershell
node tests/ai-resilience.cjs
node tests/risk-advice-workflow.cjs
node tests/risk-critical-clarification.cjs
node tests/risk-api-output.cjs
node tests/safety-knowledge.cjs
# Playwright가 설치된 런타임의 NODE_PATH를 설정한 후 실행
node tests/ai-error-ui.cjs
node tests/risk-advice-ui.cjs
```

운영 반영 시 기존 데이터 디렉터리/볼륨을 유지한다. 앱을 새로 초기화하거나 샘플 씨딩으로 데이터를 대체하지 않는다. `ai-json.cjs`도 배포 파일에 포함한다. 위험성평가 샘플 삭제는 RA번호와 원문을 확인한 후 해당 한 건만 대상으로 한다. 현재 코드의 삭제 API는 원본 신고와 연결되지 않은 담당자 직접 등록 항목에만 허용되어 있다.
