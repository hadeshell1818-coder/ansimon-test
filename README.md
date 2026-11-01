# ansimon-test

## 읍면별 집배원 구성
소통실의 구역·집배원 관리에서 '읍면별 프로토타입 명부 적용'을 누르면 집배원1~6과 읍면별 집배구를 등록합니다. 기존 신고와 과거 보고는 보존됩니다. jip11~jip16은 로그인 가능하며 기본적으로 기존 PW_JIP 비밀번호를 사용합니다. PW_JIP11~PW_JIP16 환경변수를 설정하면 각각 다른 비밀번호를 사용할 수 있습니다.
집배원 등록·수정은 통상구와 읍면을 각각 선택합니다. 안전알림은 선택한 읍면의 등록 계정에만 연결되며 발송 전에 대상 이름을 표시합니다.
9월 29일~10월 2일 4일간의 공지 4개·안전알림 10개·귀국보고는 통계·증빙의 프로토타입 예시입니다. 실제 발송이나 확인 기록으로 저장되지 않습니다. 상세·녹음은 펼친 항목만 출력됩니다. 서버의 자동 예시 생성은 기본적으로 꺼져 있으며 SAFETY_DEMO=on일 때만 활성화됩니다.


## 테스트
```bash
npm test
```
UI 테스트는 기본 Chromium으로 실행됩니다. Edge 등 다른 브라우저는 `PLAYWRIGHT_CHANNEL=msedge`로 지정합니다.

## scripts/ (직접 실행하는 도구, 서버에서 호출하지 않음)
원본 자료와 생성 결과는 모두 `local-import/`(Git 제외)에 둡니다. 만들어진 SQL은 담당자가 검토한 뒤 Supabase에 적용합니다.

| 파일 | 용도 |
|---|---|
| `ocr-checklist.ps1` | (Windows) 점검표 이미지 OCR → 텍스트 |
| `build-postal-hazard-controls.cjs` | OCR 텍스트 → `postal-hazard-controls-review.json`·CSV 검토본 |
| `prepare-approved-postal-controls.cjs` | 검토본 → 우체국 작업 위험요인·개선대책 SQL |
| `prepare-approved-jangheung.cjs` | 검토본 중 장흥우체국 위험성평가 → SQL |
| `prepare-approved-postal-accident-cases.cjs <xlsx>` | 우체국 사고사례 엑셀(업로드용 시트) → SQL |
| `prepare-approved-sif.cjs <xlsx>` | 승인된 SIF 아카이브 엑셀 → SQL |
| `prepare-official-laws-from-web.cjs [제목…]` | Open API 없이 국가법령정보센터 공개 페이지에서 법령·고시 조문을 읽어 SQL 생성 (Playwright 필요). 파일은 300KB 이하로 나뉘며 `-01`, `-02` 순서대로 Supabase SQL Editor에서 실행. `--from-sql 파일…`은 이전 형식 SQL을 다시 받지 않고 새 형식으로 변환 |
| `prepare-kosha-guides.cjs [out.sql]` | 산업안전포털(portal.kosha.or.kr)의 현행 KOSHA GUIDE 목록에서 우체국 시설·작업 관련 60건 PDF를 받아 글을 추출하고 `4.2 제목` 단위로 나눈 SQL 생성 (`curl`, `pdftotext` 필요; `KOSHA_PDF_DIR`로 받은 PDF 재사용). 그림으로만 된 PDF는 건너뛰고 실패로 표시. 월 1회 개정 검토 때 다시 실행 |
| `preview-control.cjs`, `preview-safety.cjs` | 저장·발송 없는 소통실/위험성평가 화면 미리보기 |

## 안드로이드 앱(APK)

`android/`는 집배원 화면(`/report.html`)을 앱으로 여는 Trusted Web Activity입니다. 화면·기능은 웹과 같고 설치 파일만 제공합니다.

1. GitHub Actions의 「안심ON 안드로이드 앱(APK)」이 `android/` 변경 시 또는 수동 실행 시 APK를 만들어 저장소 Releases의 `android-latest`에 `ansimon.apk`로 올립니다(수동 실행 시 운영 주소를 바꿀 수 있음).
2. 휴대폰에서 Releases 페이지를 열어 `ansimon.apk`를 내려받아 설치합니다(출처를 알 수 없는 앱 설치 허용 필요).
3. 주소창 없이 전체 화면으로 열리게 하려면 릴리스 설명의 SHA-256 지문을 서버 환경변수 `ANDROID_SHA256_FINGERPRINTS`에 넣습니다(`/.well-known/assetlinks.json`).
4. 저장소 비밀값 `ANDROID_KEYSTORE_BASE64`·`ANDROID_KEYSTORE_PASSWORD`가 없으면 빌드마다 임시 서명 키를 써서, 새 버전 설치 시 기존 앱을 지우고 다시 설치해야 하고 지문도 바뀝니다. 시범운영 전 고정 키를 비밀값으로 등록하세요.

## 의미 검색 설정

현장 표현과 법령 표현은 단어가 잘 겹치지 않습니다(예: "바닥이 젖어 미끄러움" ↔ "전도의 방지"). 의미 검색은 조문·사례마다 뜻을 벡터로 저장해 두고 신고 문장과 뜻이 가까운 근거를 찾으며, 단어 검색 결과와 합쳐 AI에 전달합니다.

1. Supabase SQL Editor에서 `supabase/006_semantic_search.sql`을 실행합니다(pgvector 확장·벡터 칸·검색 함수).
2. 서버 환경변수 `OPENAI_API_KEY`가 있어야 합니다. 모델은 `SAFETY_EMBEDDING_MODEL`(기본 `text-embedding-3-small`, 1536차원)로 바꿀 수 있고, 실제 초안에는 `SAFETY_SEMANTIC_SEARCH=on`일 때만 의미 검색을 씁니다(기본 꺼짐, 인용 정확도 확인 전까지). `off`이면 색인·점검에서도 쓰지 않습니다.
3. 위험성평가 화면 → 근거자료실 → 「의미 검색 색인 만들기」를 누릅니다. 벡터가 없는 조문·승인된 사례만 채우며 끝날 때까지 자동으로 이어집니다. 새 자료를 올리거나 조문 본문이 바뀌면(바뀐 조문은 벡터가 자동으로 비워짐) 다시 누릅니다.
4. AI에 넘기는 근거는 단어 검색이 고른 조문을 그대로 두고 의미 검색만 찾은 조문을 덧붙입니다(법령 최대 4개·지침 최대 3개). 그래서 의미 검색을 켜도 단어 검색이 찾은 근거는 빠지지 않습니다.
5. 「검색 정확도 점검」은 우체국 사례 175건(접수·발착·집배실·시설물·운송·사무후생·공사도급·비상 등, `seed-assets/search-evaluation-cases.json`)으로 단어 검색만 / 의미 검색 덧붙이기(현재) / 순위 섞기(비교용) 세 방식이 기대 근거를 AI에 넘기는 수와, 의미 검색으로 새로 찾은 근거·밀려난 근거를 운영 자료로 보여 줍니다.

## 근거 재순위(Cohere) 설정

AI 초안의 근거는 RAG 표준 순서로 고릅니다. ① 담당자 문장에서 검색어를 뽑고(AI), ② 단어 검색(`supabase/008_ranked_word_search.sql`)과 의미 검색(HyDE: 법령 문체의 가상 문장을 함께 넣어 검색)으로 후보를 약 50개 모은 뒤, ③ **Cohere Rerank API**가 후보마다 관련도를 매겨 순서를 다시 정합니다. 초안에는 상위 법령 6개와 지침 4개가 그 순서로 넘어갑니다.

1. https://dashboard.cohere.com 에서 **Production** API 키를 만듭니다(결제 정보 등록 필요, 체험 키는 분당 10회 제한·운영 불가).
2. Railway 서비스 Variables에 `COHERE_API_KEY`를 넣고 재배포합니다. 키가 있으면 재순위가 기본으로 켜집니다(`SAFETY_EVIDENCE_MODE=words`로 끌 수 있음).
3. 선택 설정: `SAFETY_RERANK_MODEL`(기본 `rerank-v3.5`), `SAFETY_RERANK_TIMEOUT_MS`(기본 3000), `SAFETY_RERANK_LAWS`·`SAFETY_RERANK_GUIDES`(기본 6·4).
4. Cohere가 실패하거나 제한 시간을 넘기면 검색 순서 그대로 초안을 만들고, 초안 화면의 「근거자료·검색 결과」에 "근거 순위: …"로 사용 여부·사유를 표시합니다.
5. 비용: 초안 1건 = 재순위 1회(검색 1회). 공개 요금 기준 검색 1,000회에 약 2달러라 월 수백 건이면 몇백 원 수준입니다(가입 시 공식 요금표 확인).

검증(2026-11-01, 198사례·같은 후보·같은 판정): 상위 4개(법령 2+지침 2) 안에 맞는 근거가 있는 사례 검색 순서 70%·79% → Cohere 90%·87%, 직접 실행한 bge-reranker-v2-m3 91%·89%와 같은 수준이며 응답 0.3~0.6초(bge CPU 약 56초). 과정은 `docs/evidence-simulation-2026-11.md`에 있습니다.

## 공식 법령 적재 설정
근거자료실의 「공식 법령 최신본 적재」는 국가법령정보센터 Open API를 씁니다.
1. open.law.go.kr에서 Open API 사용을 신청해 OC 값(신청 시 정한 아이디)을 받습니다.
2. 신청 화면에 운영 서버의 IP 주소·도메인을 등록합니다. 등록하지 않은 서버에서 호출하면 "사용자 정보 검증에 실패하였습니다"로 거부됩니다.
3. 서버 환경변수 `LAW_API_OC`에 OC 값을 넣습니다. 비어 있으면 `test`로 호출되어 실패합니다.
