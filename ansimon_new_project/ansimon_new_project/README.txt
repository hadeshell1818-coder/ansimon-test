안심ON 새 GitHub/Railway 테스트 프로젝트

1. 이 ZIP을 압축 해제하고 ansimon_new_project 폴더 안의 파일/폴더 전체를 새 GitHub 저장소 최상위에 업로드하세요. ZIP 파일 자체를 GitHub에 올리지 마세요.
2. Railway > New Project > Deploy from GitHub repo 에서 해당 저장소를 연결하세요. 시작 명령: npm start (package.json에 포함).
3. Railway Variables에 아래 값을 직접 입력하세요. 실제 비밀번호/키는 GitHub에 업로드하지 마세요.
   필수: PW_JIP, PW_JIP2, PW_JIP3, PW_JANG1, PW_JANG2, PW_JANG3, PW_KWANG1, PW_KWANG2, PW_KWANG3, PW_BO1, PW_BO2, PW_BO3 (각각 10자 이상)
   추가 권장: PW_JIP4 (소통실), PW_JIP5 (안전관리담당자), PHOTO_SIGNING_KEY (32자 이상), WELFARE_DATA_KEY (별도 긴 무작위 문자열)
   선택: OPENAI_API_KEY, KAKAO_JS_KEY, SAFETY_CALL_NUMBER. PORT는 Railway가 자동 설정합니다.
4. 접속 주소: /report.html, /safety.html, /risk.html, /dashboard.html
5. 아이콘은 새로 만든 임시 ON 아이콘입니다. 기관 공식 로고가 아닙니다. 기존 PWA 기능 중 서비스워커는 포함되지 않습니다.
6. 서버는 파일 기반 시연 구조입니다. Railway 재배포/재시작 시 데이터 지속성이 보장되지 않으며, 실제 안전지식 검색/Supabase 연결 및 운영용 인증·권한·보안 검증은 완료되지 않았습니다. 실제 운영용으로 사용하지 마세요.
