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

## 공식 법령 적재 설정
근거자료실의 「공식 법령 최신본 적재」는 국가법령정보센터 Open API를 씁니다.
1. open.law.go.kr에서 Open API 사용을 신청해 OC 값(신청 시 정한 아이디)을 받습니다.
2. 신청 화면에 운영 서버의 IP 주소·도메인을 등록합니다. 등록하지 않은 서버에서 호출하면 "사용자 정보 검증에 실패하였습니다"로 거부됩니다.
3. 서버 환경변수 `LAW_API_OC`에 OC 값을 넣습니다. 비어 있으면 `test`로 호출되어 실패합니다.
