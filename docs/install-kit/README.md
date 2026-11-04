# 안심ON 설치 안내 자료 (장흥우체국 시범운영)

| 파일 | 용도 |
|---|---|
| `안심ON_설치안내_1쪽.pdf` | 직원 배부용 A4 1쪽: QR, 로그인, 안드로이드·아이폰 홈 화면 설치, 알림 켜기, 주의사항. 하단 문의 전화와 "내 아이디" 칸은 손으로 적는다(비밀번호는 적지 않음) |
| `안심ON_설치_QR_게시용.pdf` | 게시판·휴게실 부착용 A4 큰 QR |
| `안심ON_설치_QR.png` | 메신저로 보낼 QR 이미지 |
| `guide.html`, `poster.html`, `qr.svg` | 원본. 고쳐서 다시 만들 때 사용 |

- QR 주소: `https://ansimon-test-production.up.railway.app/report.html` (`start_url`과 같은 집배원 화면). 주소가 바뀌면 QR을 다시 만든다.
- 다시 만드는 법: `qr.svg`는 파이썬 `segno`로 만들었다(오류 정정 Q). HTML을 크롬에서 열어 A4·여백 없음으로 PDF 인쇄하거나 Playwright `page.pdf({format:'A4', preferCSSPageSize:true})`로 출력한다. 글꼴은 Noto Sans KR(@fontsource, jsDelivr)이다.
- 설치 화면 문구는 `public/report.html`의 설치 안내(「앱 설치」, 공유 → 「홈 화면에 추가」, 「관제실 알림 켜기」)와 맞췄다. 화면 문구를 바꾸면 안내문도 함께 고친다.
