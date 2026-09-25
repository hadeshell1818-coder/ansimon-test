/* =========================================================================
 * 집배원 생활안전·복지 신고 시스템 — 파일럿 서버
 * 하나의 서버가 (1) 집배원 폰앱 /report.html  (2) 대시보드 /dashboard.html 를 서비스.
 * 신고·사진·상태를 저장하고, WebSocket으로 모든 접속자에게 실시간 반영.
 *
 * 🔐 개인정보 보호 강화:
 *   - 비밀번호 bcrypt 해시, HTTPS, 세션 만료, 요청 제한, 서명형 사진 URL 적용.
 *   - 안전·환경 사진은 클라이언트에서 얼굴을 자동 마스킹한 뒤 서버로 전송하며 원본은 저장하지 않음.
 *   - 복지 신고는 외부 AI에 전송하지 않고, 저장 시 AES-256-GCM 암호화 및 역할별 비식별 조회를 적용.
 * ========================================================================= */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: false,
}));
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const UP_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });

/* ===================== 복지 개인정보 암호화 ===================== */
const WELFARE_KEY_SOURCE = process.env.WELFARE_DATA_KEY || process.env.PHOTO_SIGNING_KEY || '';
if (WELFARE_KEY_SOURCE.length < 32) {
  throw new Error('Railway Variables에 WELFARE_DATA_KEY 또는 32자 이상의 PHOTO_SIGNING_KEY를 설정하세요.');
}
const WELFARE_KEY = crypto.createHash('sha256').update(WELFARE_KEY_SOURCE).digest();
function encryptPrivate(value) {
  if (value == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', WELFARE_KEY, iv);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') };
}
function decryptPrivate(blob) {
  if (!blob || typeof blob !== 'object' || !blob.data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', WELFARE_KEY, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch (e) { console.error('welfare decrypt fail', e.message); return null; }
}
function maskName(name) {
  const t = String(name || '').trim();
  if (!t || t === '(미기재)') return '(미기재)';
  if (t.length === 1) return t + '○';
  return t[0] + '○'.repeat(Math.max(1, t.length - 1));
}
function coarseAddress(addr, region) {
  const a = String(addr || '').trim();
  if (!a) return region || '';
  const parts = a.split(/\s+/);
  if (parts.length >= 3) return parts.slice(0, 3).join(' ') + ' 이하 비공개';
  return (region || parts[0] || '') + ' 상세주소 비공개';
}
function canViewWelfarePII(user, report) {
  if (!user || !report) return false;
  if (user.kind === 'carrier' && report.carrierId === user.id) return true;
  if (user.kind === 'dept' && user.type === 'welfare' && user.region === report.region) return true;
  return false;
}

/* ===================== 계정 =====================
 * 아이디 체계: jip=집배원 · jip2=직원 · jip3=관제실
 *   지자체: {지역}1=교통과 · {지역}2=환경과 · {지역}3=복지과
 *   지역: jang=장흥군 · kwang=광주광역시 · bo=보성군
 * 비밀번호는 Railway Variables(PW_*)로 관리 — 각 10자 이상 필수.
 */
function requiredPassword(envName) {
  const value = process.env[envName];
  if (!value) throw new Error(`Railway Variables에 ${envName}을 설정하세요.`);
  if (value.length < 10) throw new Error(`${envName}은 10자 이상으로 설정하세요.`);
  return bcrypt.hashSync(value, 12);
}
const USERS = {
  jip3:   { pwHash: requiredPassword('PW_JIP3'),   kind: 'control', name: '전남지방우정청 관제실', org: '전남지방우정청',     region: null,      type: null,      role: '관제실' },

  jang1:  { pwHash: requiredPassword('PW_JANG1'),  kind: 'dept', name: '이교통', org: '장흥군 교통과',     region: '장흥군',     type: 'safe',    role: '지자체 · 교통과' },
  jang2:  { pwHash: requiredPassword('PW_JANG2'),  kind: 'dept', name: '박환경', org: '장흥군 환경과',     region: '장흥군',     type: 'env',     role: '지자체 · 환경과' },
  jang3:  { pwHash: requiredPassword('PW_JANG3'),  kind: 'dept', name: '최복지', org: '장흥군 복지과',     region: '장흥군',     type: 'welfare', role: '지자체 · 복지과' },

  kwang1: { pwHash: requiredPassword('PW_KWANG1'), kind: 'dept', name: '김교통', org: '광주광역시 교통과', region: '광주광역시', type: 'safe',    role: '지자체 · 교통과' },
  kwang2: { pwHash: requiredPassword('PW_KWANG2'), kind: 'dept', name: '정환경', org: '광주광역시 환경과', region: '광주광역시', type: 'env',     role: '지자체 · 환경과' },
  kwang3: { pwHash: requiredPassword('PW_KWANG3'), kind: 'dept', name: '윤복지', org: '광주광역시 복지과', region: '광주광역시', type: 'welfare', role: '지자체 · 복지과' },

  bo1:    { pwHash: requiredPassword('PW_BO1'),    kind: 'dept', name: '한교통', org: '보성군 교통과',     region: '보성군',     type: 'safe',    role: '지자체 · 교통과' },
  bo2:    { pwHash: requiredPassword('PW_BO2'),    kind: 'dept', name: '오환경', org: '보성군 환경과',     region: '보성군',     type: 'env',     role: '지자체 · 환경과' },
  bo3:    { pwHash: requiredPassword('PW_BO3'),    kind: 'dept', name: '노복지', org: '보성군 복지과',     region: '보성군',     type: 'welfare', role: '지자체 · 복지과' },

  jip:    { pwHash: requiredPassword('PW_JIP'),    kind: 'carrier', name: '김철수', org: '장흥우체국',        zone: '장흥3구', region: '장흥군', type: null, role: '집배원' },
  jip2:   { pwHash: requiredPassword('PW_JIP2'),   kind: 'carrier', name: '박영희', org: '장흥우체국 영업과',                  region: '장흥군', type: null, role: '직원' },
};
/* 우체국 안전관제(총괄국 소통팀장) — 집배원 내부 안전신고만 모이는 별도 관제 계정.
 * 전남지방우정청 관제실(jip3)은 기존대로 외부 신고(안전·환경·복지)만 다룬다.
 * PW_JIP4가 없으면 계정을 만들지 않고 서버는 그대로 기동한다(기존 배포 보호). */
if (process.env.PW_JIP4) {
  USERS.jip4 = { pwHash: requiredPassword('PW_JIP4'), kind: 'safety', name: '소통팀장', org: '장흥우체국', region: '장흥군', type: null, role: '우체국 안전관제' };
} else {
  console.warn('⚠️ PW_JIP4 미설정 — 우체국 안전관제(jip4) 계정이 비활성화됩니다.');
}
if (process.env.PW_JIP5) {
  USERS.jip5 = { pwHash: requiredPassword('PW_JIP5'), kind: 'safety_mgr', name: '안전보건담당자', org: '장흥우체국', region: '장흥군', type: null, role: '안전보건담당자' };
} else {
  console.warn('⚠️ PW_JIP5 미설정 — 안전보건담당자(jip5) 계정이 비활성화됩니다.');
}
function publicUser(id) { const u = USERS[id]; if (!u) return null;
  return { id, kind: u.kind, name: u.name, org: u.org, zone: u.zone || null, region: u.region, type: u.type, role: u.role }; }

/* ===================== 세션(토큰) ===================== */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
function makeToken(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { uid, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function tokenFromReq(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function sessionFromToken(token) {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}
function userFromReq(req) {
  const session = sessionFromToken(tokenFromReq(req));
  return session ? { id: session.uid, ...USERS[session.uid] } : null;
}
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
}, 10 * 60 * 1000).unref();

// ⚠️ 데모/시연 기간 한정: 로그인 IP 제한 비활성화. 같은 네트워크·같은 IP에서
//    여러 계정으로 연달아 시연할 수 있도록 임시로 풀어둔 것.
//    실서비스 전환 시 아래 주석 처리된 rateLimit으로 반드시 복구할 것.
// const loginLimiter = rateLimit({
//   windowMs: 10 * 60 * 1000,
//   limit: 8,
//   standardHeaders: true,
//   legacyHeaders: false,
//   message: { error: '로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요.' },
// });
const loginLimiter = (req, res, next) => next(); // no-op (데모 기간 한정)

const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '신고 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
});

/* ===================== 신고 데이터 ===================== */
let reports = [];
let SEQ = 1000;
const CAT_DEPT = { safe: '교통과', env: '환경과', welfare: '복지과' };

function serializeForDisk(r) {
  const copy = { ...r };
  if (copy.type === 'welfare') {
    copy._welfareEnc = encryptPrivate(copy.welfare || null);
    copy._addrEnc = encryptPrivate(copy.addr || '');
    copy.welfare = null;
    copy.addr = '[ENCRYPTED_WELFARE_ADDRESS]';
  }
  return copy;
}
function deserializeFromDisk(r) {
  const copy = { ...r };
  if (copy.type === 'welfare' && copy._welfareEnc) {
    copy.welfare = decryptPrivate(copy._welfareEnc) || null;
    copy.addr = decryptPrivate(copy._addrEnc) || copy.region || '';
    delete copy._welfareEnc; delete copy._addrEnc;
  }
  return copy;
}
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(reports.map(serializeForDisk))); }
  catch (e) { console.error('save fail', e); }
}
function load() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      reports = raw.map(deserializeFromDisk);
      SEQ = reports.reduce((m, r) => Math.max(m, +String(r.id).replace('R', '') || 0), 1000);
      return true;
    } catch (e) { console.error('load fail', e); }
  }
  return false;
}

/* ---- 시드(최초 실행 시 데모 데이터) ---- */
const GEO = {
  '장흥군':     { lat: 34.6816, lng: 126.9072 },
  '강진군':     { lat: 34.6417, lng: 126.7672 },
  '광주광역시': { lat: 35.1595, lng: 126.8526 },
  '보성군':     { lat: 34.7715, lng: 127.2166 },
};
const jit = b => ({ lat: b.lat + (Math.random() - .5) * 0.02, lng: b.lng + (Math.random() - .5) * 0.02 });
const rpick = a => a[Math.floor(Math.random() * a.length)];
const HITEMS = {
  safe: ['도로위험', '시설물 파손·고장', '기타 안전위험요소'],
  env: ['쓰레기·폐기물', '기타 환경위험'],
  welfare: ['복지 위기 (독거노인)', '복지 위기 (장애인)', '복지 위기 (노인부부)', '복지 위기 (기타)'],
};
function daysAgoISO(d) { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(9 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60)); return t.toISOString(); }
function newReport(o) {
  const g = jit(GEO[o.region]);
  return Object.assign({
    id: 'R' + (++SEQ), lat: g.lat, lng: g.lng, status: 'received', reason: '', photo: false, photoUrl: null,
    memo: '', welfare: null, urgent: null, urgentNote: null, carrierUrgent: false, aiMode: 'na', subtype: null,
    createdAt: daysAgoISO(o.age || 0), carrier: '김철수(장흥3구)', carrierId: 'jip', reporterOrg: '장흥우체국', edited: false, editedAt: null, cancelledAt: null, cancelledBy: null,
    photoMosaic: false, mosaicBy: null, mosaicAt: null, mergedInto: null, dupDismissed: [], invalidReport: false,
  }, o);
  }

/* ---- 시드용 샘플 사진 ----
 * road/road2/road3/crack/facility/safeOther/waste/envOther는 seed-assets/의
 * 실제(가상) 현장사진을 사용하고, 아직 사진이 없는 drop만 색상 플레이스홀더로 대체한다.
 * road는 사진이 3장 있어 같은 사진이 반복 노출되지 않도록 신고마다 돌아가며 배정한다.
 * uploads/는 배포마다 초기화될 수 있어 서버 부팅 시마다 매번 다시 만들어 둔다. */
const SEED_ASSETS_DIR = path.join(__dirname, 'seed-assets');
const SAMPLE_PHOTOS = {
  road2:     { file: 'road2.jpg' },
  road3:     { file: 'road3.jpg' },
  crack:     { file: 'crack.jpg' },
  drop:      { file: 'drop.jpg' },
  facility:  { file: 'facility.jpg' },
  safeOther: { file: 'safe_other.jpg' },
  waste:     { file: 'waste.jpg' },
  envOther:  { file: 'env_other.jpg' },
};
function ensureSamplePhotos() {
  for (const key in SAMPLE_PHOTOS) {
    const { file, placeholder } = SAMPLE_PHOTOS[key];
    const dest = path.join(UP_DIR, file);
    if (placeholder) {
      const { color, label } = placeholder;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <rect width="640" height="480" fill="${color}"/>
  <rect x="16" y="16" width="608" height="448" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2"/>
  <text x="50%" y="46%" font-family="sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">📷 ${label}</text>
  <text x="50%" y="57%" font-family="sans-serif" font-size="15" fill="rgba(255,255,255,.75)" text-anchor="middle">데모용 예시 이미지 · 실제 현장사진 아님</text>
</svg>`;
      try { fs.writeFileSync(dest, svg); } catch (e) { console.error('sample photo write fail', e); }
    } else {
      try { fs.copyFileSync(path.join(SEED_ASSETS_DIR, file), dest); } catch (e) { console.error('sample photo copy fail', e); }
    }
  }
}
function samplePhoto(key) { return { photo: true, photoUrl: '/uploads/' + SAMPLE_PHOTOS[key].file }; }

/* ---- 광주광역시: 교통과·환경과·복지과 시연용 샘플 ----
 * seed()에서 최초 씨딩 시 포함되고, 기존 데이터가 있는데 광주 샘플만 없는
 * 경우(운영 중 별도 추가)에도 이 함수를 그대로 재사용한다. */
function gwangjuSeed() {
  return [
    newReport({ region: '광주광역시', type: 'safe', item: '도로위험', subtype: '파임', addr: '광주광역시 동구 금남로 118', status: 'received', age: 1, urgent: true, urgentNote: '차로 중앙 파임, 야간 사고 위험', memo: '편도2차로 중 1차로 중앙에 깊은 파임 발생.', carrierId: null, carrier: '이광주(동구1구)', reporterOrg: '광주동구우체국', ...samplePhoto('road2') }),
    newReport({ region: '광주광역시', type: 'safe', item: '도로위험', subtype: '낙하물', addr: '광주광역시 서구 상무대로 312', status: 'received', age: 1, memo: '가로수 가지 도로 위 낙하.', carrierId: null, carrier: '정민지(서구2구)', reporterOrg: '광주서구우체국', ...samplePhoto('drop') }),
    newReport({ region: '광주광역시', type: 'safe', item: '시설물 파손·고장', addr: '광주광역시 남구 서문대로 419', status: 'checking', age: 2, memo: '가로등 2기 연속 소등, 야간 통행 위험.', carrierId: null, carrier: '한도윤(남구1구)', reporterOrg: '광주남구우체국', ...samplePhoto('facility') }),
    newReport({ region: '광주광역시', type: 'safe', item: '도로위험', subtype: '심한 균열', addr: '광주광역시 북구 우치로 120', status: 'checking', age: 2, memo: '횡단보도 앞 아스팔트 균열 확산 중.', carrierId: null, carrier: '서지훈(북구2구)', reporterOrg: '광주북구우체국', ...samplePhoto('crack') }),
    newReport({ region: '광주광역시', type: 'safe', item: '기타 안전위험요소', addr: '광주광역시 광산구 첨단과학로 208', status: 'hold', age: 5, reason: '현장 확인 완료, 정식 정비는 예산 미확보로 다음 분기 편성 예정.', carrierId: null, carrier: '오하은(광산구1구)', reporterOrg: '광주광산구우체국', ...samplePhoto('safeOther') }),
    newReport({ region: '광주광역시', type: 'safe', item: '시설물 파손·고장', addr: '광주광역시 서구 화정로 65', status: 'done', age: 6, reason: '가로등 안정기 교체 완료.', carrierId: null, carrier: '정민지(서구2구)', reporterOrg: '광주서구우체국', ...samplePhoto('facility') }),
    newReport({ region: '광주광역시', type: 'safe', item: '도로위험', subtype: '파임', addr: '광주광역시 동구 제봉로 22', status: 'noaction', age: 4, reason: '현장 확인 결과 경미한 표면 손상으로 조치 불요.', carrierId: null, carrier: '이광주(동구1구)', reporterOrg: '광주동구우체국', ...samplePhoto('road3') }),

    newReport({ region: '광주광역시', type: 'env', item: '쓰레기·폐기물', addr: '광주광역시 서구 치평동 상무자유로 44', status: 'received', age: 1, memo: '대형폐기물 무단 투기 3건.', carrierId: null, carrier: '정민지(서구2구)', reporterOrg: '광주서구우체국', ...samplePhoto('waste') }),
    newReport({ region: '광주광역시', type: 'env', item: '기타 환경위험', addr: '광주광역시 북구 설죽로 산책로', status: 'received', age: 1, urgent: true, urgentNote: '하천 악취·변색, 주민 민원 다수', memo: '하천 수질 변색 및 악취 심함.', carrierId: null, carrier: '서지훈(북구2구)', reporterOrg: '광주북구우체국', ...samplePhoto('envOther') }),
    newReport({ region: '광주광역시', type: 'env', item: '쓰레기·폐기물', addr: '광주광역시 광산구 하남산단로 9', status: 'checking', age: 2, memo: '산업단지 인근 생활폐기물 방치.', carrierId: null, carrier: '오하은(광산구1구)', reporterOrg: '광주광산구우체국', ...samplePhoto('waste') }),
    newReport({ region: '광주광역시', type: 'env', item: '기타 환경위험', addr: '광주광역시 남구 백운로 264', status: 'checking', age: 3, memo: '공사장 인근 분진 민원.', carrierId: null, carrier: '한도윤(남구1구)', reporterOrg: '광주남구우체국', ...samplePhoto('envOther') }),
    newReport({ region: '광주광역시', type: 'env', item: '쓰레기·폐기물', addr: '광주광역시 동구 대인로 5', status: 'hold', age: 5, reason: '수거 업체 배정 지연으로 보류, 이번 주 내 처리 예정.', carrierId: null, carrier: '이광주(동구1구)', reporterOrg: '광주동구우체국', ...samplePhoto('waste') }),
    newReport({ region: '광주광역시', type: 'env', item: '쓰레기·폐기물', addr: '광주광역시 서구 회재로 8', status: 'done', age: 7, reason: '수거 완료.', carrierId: null, carrier: '정민지(서구2구)', reporterOrg: '광주서구우체국', ...samplePhoto('waste') }),
    newReport({ region: '광주광역시', type: 'env', item: '기타 환경위험', addr: '광주광역시 북구 동문대로 45', status: 'noaction', age: 4, reason: '확인 결과 사유지 내 문제로 관할 아님, 소유주 안내 완료.', carrierId: null, carrier: '서지훈(북구2구)', reporterOrg: '광주북구우체국', ...samplePhoto('envOther') }),

    newReport({ region: '광주광역시', type: 'welfare', item: '복지 위기 (독거노인)', addr: '광주광역시 동구 대인동', status: 'received', age: 1, carrierId: null, carrier: '이광주(동구1구)', reporterOrg: '광주동구우체국',
      welfare: { name: '김OO', age: '80대', household: '독거노인', action: '안부확인', reason: '우편물 적체, 인기척 없음' } }),
    newReport({ region: '광주광역시', type: 'welfare', item: '복지 위기 (장애인)', addr: '광주광역시 서구 치평동', status: 'received', age: 1, carrierId: null, carrier: '정민지(서구2구)', reporterOrg: '광주서구우체국',
      welfare: { name: '이OO', age: '40대', household: '장애인', action: '돌봄 및 보호', reason: '거동 불편, 방문 요청 있었음' } }),
    newReport({ region: '광주광역시', type: 'welfare', item: '복지 위기 (노인부부)', addr: '광주광역시 남구 봉선동', status: 'checking', age: 2, carrierId: null, carrier: '한도윤(남구1구)', reporterOrg: '광주남구우체국',
      welfare: { name: '최OO', age: '70대', household: '노인부부', action: '안부확인', reason: '배우자 병환으로 돌봄 부담 호소' } }),
    newReport({ region: '광주광역시', type: 'welfare', item: '복지 위기 (독거노인)', addr: '광주광역시 북구 운암동', status: 'checking', age: 2, carrierId: null, carrier: '서지훈(북구2구)', reporterOrg: '광주북구우체국',
      welfare: { name: '박OO', age: '80대', household: '독거노인', action: '돌봄 및 보호', reason: '거동 불편, 정기 방문 필요' } }),
    newReport({ region: '광주광역시', type: 'welfare', item: '복지 위기 (기타)', addr: '광주광역시 광산구 신창동', status: 'hold', age: 4, reason: '자녀 연락 시도 중, 회신 대기로 보류.', carrierId: null, carrier: '오하은(광산구1구)', reporterOrg: '광주광산구우체국',
      welfare: { name: '정OO', age: '60대', household: '기타', action: '안부확인', reason: '자녀와 연락 두절 상태 확인 필요' } }),
    newReport({ region: '광주광역시', type: 'welfare', item: '복지 위기 (독거노인)', addr: '광주광역시 동구 산수동', status: 'done', age: 6, reason: '방문 안부확인 완료, 이상 없음 확인.', carrierId: null, carrier: '이광주(동구1구)', reporterOrg: '광주동구우체국',
      welfare: { name: '윤OO', age: '80대', household: '독거노인', action: '안부확인', reason: '정기 안부확인 요청' } }),
    newReport({ region: '광주광역시', type: 'welfare', item: '복지 위기 (노인부부)', addr: '광주광역시 서구 화정동', status: 'noaction', age: 5, reason: '자녀 동거 확인되어 조치 불요.', carrierId: null, carrier: '정민지(서구2구)', reporterOrg: '광주서구우체국',
      welfare: { name: '조OO', age: '70대', household: '노인부부', action: '안부확인', reason: '생활반응 없음 의심 신고' } }),
  ];
}

/* ---- 보성군: 교통과·환경과·복지과 시연용 샘플 ---- */
function boseongSeed() {
  return [
    newReport({ region: '보성군', type: 'safe', item: '도로위험', subtype: '파임', addr: '전남 보성군 보성읍 송재로 24', status: 'received', age: 1, memo: '보성읍 진입로 중앙에 파임 발생, 야간 시야 확보 어려움.', carrierId: null, carrier: '문보성(보성읍1구)', reporterOrg: '보성우체국', ...samplePhoto('road2') }),
    newReport({ region: '보성군', type: 'safe', item: '도로위험', subtype: '낙하물', addr: '전남 보성군 벌교읍 벌교로 88', status: 'received', age: 0, urgent: true, urgentNote: '고속화도로 차로 위 낙하물 다수, 2차 사고 위험', memo: '주행 차로 위에 정체불명 낙하물 여러 개 흩어져 있음.', carrierId: null, carrier: '장벌교(벌교읍2구)', reporterOrg: '보성우체국', ...samplePhoto('drop') }),
    newReport({ region: '보성군', type: 'safe', item: '시설물 파손·고장', addr: '전남 보성군 회천면 회령리 인근', status: 'checking', age: 2, memo: '가로등 소등, 야간 통행 위험.', carrierId: null, carrier: '박회천(회천면1구)', reporterOrg: '보성우체국', ...samplePhoto('facility') }),
    newReport({ region: '보성군', type: 'safe', item: '도로위험', subtype: '심한 균열', addr: '전남 보성군 득량면 예당로 15', status: 'checking', age: 2, memo: '농로 진입부 아스팔트 균열 확산 중.', carrierId: null, carrier: '문보성(보성읍1구)', reporterOrg: '보성우체국', ...samplePhoto('crack') }),
    newReport({ region: '보성군', type: 'safe', item: '기타 안전위험요소', addr: '전남 보성군 조성면 조성리 인근', status: 'hold', age: 5, reason: '현장 확인 완료, 정식 정비는 예산 미확보로 다음 분기 편성 예정.', carrierId: null, carrier: '장벌교(벌교읍2구)', reporterOrg: '보성우체국', ...samplePhoto('safeOther') }),
    newReport({ region: '보성군', type: 'safe', item: '시설물 파손·고장', addr: '전남 보성군 보성읍 우체국로 3', status: 'done', age: 6, reason: '가로등 안정기 교체 완료.', carrierId: null, carrier: '문보성(보성읍1구)', reporterOrg: '보성우체국', ...samplePhoto('facility') }),
    newReport({ region: '보성군', type: 'safe', item: '도로위험', subtype: '파임', addr: '전남 보성군 웅치면 대산로 9', status: 'noaction', age: 4, reason: '현장 확인 결과 경미한 표면 손상으로 조치 불요.', carrierId: null, carrier: '박회천(회천면1구)', reporterOrg: '보성우체국', ...samplePhoto('road3') }),

    newReport({ region: '보성군', type: 'env', item: '쓰레기·폐기물', addr: '전남 보성군 벌교읍 벌교시장길 7', status: 'received', age: 1, memo: '시장 인근 대형폐기물 무단 투기.', carrierId: null, carrier: '장벌교(벌교읍2구)', reporterOrg: '보성우체국', ...samplePhoto('waste') }),
    newReport({ region: '보성군', type: 'env', item: '기타 환경위험', addr: '전남 보성군 회천면 율포해변 인근', status: 'received', age: 1, memo: '해안가 인근 배수로 악취 신고.', carrierId: null, carrier: '박회천(회천면1구)', reporterOrg: '보성우체국', ...samplePhoto('envOther') }),
    newReport({ region: '보성군', type: 'env', item: '쓰레기·폐기물', addr: '전남 보성군 노동면 노동로 21', status: 'checking', age: 2, memo: '농로 인근 생활폐기물 방치.', carrierId: null, carrier: '문보성(보성읍1구)', reporterOrg: '보성우체국', ...samplePhoto('waste') }),
    newReport({ region: '보성군', type: 'env', item: '기타 환경위험', addr: '전남 보성군 득량면 다전길 12', status: 'checking', age: 3, memo: '농경지 인근 오수 방류 의심.', carrierId: null, carrier: '장벌교(벌교읍2구)', reporterOrg: '보성우체국', ...samplePhoto('envOther') }),
    newReport({ region: '보성군', type: 'env', item: '쓰레기·폐기물', addr: '전남 보성군 조성면 조성리 5', status: 'hold', age: 5, reason: '수거 업체 배정 지연으로 보류, 이번 주 내 처리 예정.', carrierId: null, carrier: '박회천(회천면1구)', reporterOrg: '보성우체국', ...samplePhoto('waste') }),
    newReport({ region: '보성군', type: 'env', item: '쓰레기·폐기물', addr: '전남 보성군 보성읍 녹차로 40', status: 'done', age: 7, reason: '수거 완료.', carrierId: null, carrier: '문보성(보성읍1구)', reporterOrg: '보성우체국', ...samplePhoto('waste') }),
    newReport({ region: '보성군', type: 'env', item: '기타 환경위험', addr: '전남 보성군 웅치면 대산로 20', status: 'noaction', age: 4, reason: '확인 결과 사유지 내 문제로 관할 아님, 소유주 안내 완료.', carrierId: null, carrier: '장벌교(벌교읍2구)', reporterOrg: '보성우체국', ...samplePhoto('envOther') }),

    newReport({ region: '보성군', type: 'welfare', item: '복지 위기 (독거노인)', addr: '전남 보성군 보성읍 성동리', status: 'received', age: 1, carrierId: null, carrier: '문보성(보성읍1구)', reporterOrg: '보성우체국',
      welfare: { name: '이OO', age: '80대', household: '독거노인', action: '안부확인', reason: '우편물 적체, 인기척 없음' } }),
    newReport({ region: '보성군', type: 'welfare', item: '복지 위기 (장애인)', addr: '전남 보성군 벌교읍 벌교리', status: 'received', age: 1, carrierId: null, carrier: '장벌교(벌교읍2구)', reporterOrg: '보성우체국',
      welfare: { name: '김OO', age: '50대', household: '장애인', action: '돌봄 및 보호', reason: '거동 불편, 방문 요청 있었음' } }),
    newReport({ region: '보성군', type: 'welfare', item: '복지 위기 (노인부부)', addr: '전남 보성군 회천면 화죽리', status: 'checking', age: 2, carrierId: null, carrier: '박회천(회천면1구)', reporterOrg: '보성우체국',
      welfare: { name: '최OO', age: '70대', household: '노인부부', action: '안부확인', reason: '배우자 병환으로 돌봄 부담 호소' } }),
    newReport({ region: '보성군', type: 'welfare', item: '복지 위기 (독거노인)', addr: '전남 보성군 득량면 예당리', status: 'checking', age: 2, carrierId: null, carrier: '문보성(보성읍1구)', reporterOrg: '보성우체국',
      welfare: { name: '박OO', age: '80대', household: '독거노인', action: '돌봄 및 보호', reason: '거동 불편, 정기 방문 필요' } }),
    newReport({ region: '보성군', type: 'welfare', item: '복지 위기 (기타)', addr: '전남 보성군 조성면 조성리', status: 'hold', age: 4, reason: '자녀 연락 시도 중, 회신 대기로 보류.', carrierId: null, carrier: '장벌교(벌교읍2구)', reporterOrg: '보성우체국',
      welfare: { name: '정OO', age: '60대', household: '기타', action: '안부확인', reason: '자녀와 연락 두절 상태 확인 필요' } }),
    newReport({ region: '보성군', type: 'welfare', item: '복지 위기 (독거노인)', addr: '전남 보성군 웅치면 대산리', status: 'done', age: 6, reason: '방문 안부확인 완료, 이상 없음 확인.', carrierId: null, carrier: '박회천(회천면1구)', reporterOrg: '보성우체국',
      welfare: { name: '윤OO', age: '80대', household: '독거노인', action: '안부확인', reason: '정기 안부확인 요청' } }),
    newReport({ region: '보성군', type: 'welfare', item: '복지 위기 (노인부부)', addr: '전남 보성군 노동면 마곡리', status: 'noaction', age: 5, reason: '자녀 동거 확인되어 조치 불요.', carrierId: null, carrier: '문보성(보성읍1구)', reporterOrg: '보성우체국',
      welfare: { name: '조OO', age: '70대', household: '노인부부', action: '안부확인', reason: '생활반응 없음 의심 신고' } }),
  ];
}

function seed() {
  reports = [
    newReport({ region: '장흥군', type: 'safe', item: '도로위험', subtype: '파임', addr: '전남 장흥군 장흥읍 흥성로 45', status: 'received', age: 11, memo: '편도1차로 가운데 지름 40cm 파임. 야간 위험.', carrierId: 'jip', carrier: '김철수(장흥3구)', reporterOrg: '장흥우체국', ...samplePhoto('road2') }),
    newReport({ region: '장흥군', type: 'env', item: '쓰레기·폐기물', addr: '전남 장흥군 장흥읍 예양로 88', status: 'received', age: 1, memo: '폐가전·건축폐기물 5~6점 상시 방치.', carrierId: 'jip', carrier: '김철수(장흥3구)', reporterOrg: '장흥우체국', ...samplePhoto('waste') }),
    newReport({ region: '장흥군', type: 'env', item: '기타 환경위험', addr: '전남 장흥군 부산면 부산로 33', status: 'received', age: 2, memo: '하천 인근 악취 신고.', carrierId: 'jip2', carrier: '박영희·장흥우체국 영업과', reporterOrg: '장흥우체국 영업과', ...samplePhoto('envOther') }),
    newReport({ region: '장흥군', type: 'welfare', item: '복지 위기 (장애인)', addr: '전남 장흥군 장흥읍 중앙로 21', status: 'received', age: 2, carrierId: null, carrier: '정민수(장흥1구)', reporterOrg: '장흥우체국',
      welfare: { name: '이OO', age: '50대', household: '장애인', action: '돌봄 및 보호', reason: '거동 불편, 우편함 방치 확인' } }),

    newReport({ region: '장흥군', type: 'safe', item: '시설물 파손·고장', addr: '전남 장흥군 안양면 해안로 210', status: 'checking', age: 1, memo: '해안로 가로등 3기 연속 소등.', carrierId: 'jip', carrier: '김철수(장흥3구)', reporterOrg: '장흥우체국', ...samplePhoto('facility') }),
    newReport({ region: '장흥군', type: 'welfare', item: '복지 위기 (독거노인)', addr: '전남 장흥군 장흥읍 물레방앗간길 7', status: 'checking', age: 1, carrierId: 'jip', carrier: '김철수(장흥3구)', reporterOrg: '장흥우체국',
      welfare: { name: '김OO', age: '80대', household: '독거노인', action: '안부확인', reason: '우편물 3일치 적체, 인기척 없음' } }),
    newReport({ region: '장흥군', type: 'safe', item: '시설물 파손·고장', addr: '전남 장흥군 대덕읍 소화전 인근', status: 'checking', age: 3, memo: '소화전 캡 파손, 노출 상태.', carrierId: 'jip2', carrier: '박영희·장흥우체국 영업과', reporterOrg: '장흥우체국 영업과', ...samplePhoto('facility') }),
    newReport({ region: '장흥군', type: 'env', item: '쓰레기·폐기물', addr: '전남 장흥군 관산읍 산단로 14', status: 'checking', age: 4, carrierId: null, carrier: '최은비(장흥2구)', reporterOrg: '장흥우체국', ...samplePhoto('waste') }),

    newReport({ region: '장흥군', type: 'safe', item: '도로위험', subtype: '파임', addr: '전남 장흥군 대덕읍 대덕로 12', status: 'hold', age: 7, reason: '경미한 파임으로 안전조치(라바콘) 완료, 정식 보수는 예산 미확보로 다음 분기 편성 예정.', carrierId: 'jip', carrier: '김철수(장흥3구)', reporterOrg: '장흥우체국', ...samplePhoto('road3') }),

    newReport({ region: '강진군', type: 'env', item: '쓰레기·폐기물', addr: '전남 강진군 강진읍 탐진로 12', status: 'done', age: 3, reason: '수거 완료.', carrierId: 'jip', carrier: '김철수(장흥3구)', reporterOrg: '장흥우체국', ...samplePhoto('waste') }),
    newReport({ region: '강진군', type: 'safe', item: '시설물 파손·고장', addr: '전남 강진군 성전면 국도변', status: 'done', age: 4, reason: '가로등 안정기 교체 완료.', carrierId: null, carrier: '최은비(장흥2구)', reporterOrg: '장흥우체국', ...samplePhoto('facility') }),
    newReport({ region: '장흥군', type: 'safe', item: '도로위험', subtype: '낙하물', addr: '전남 장흥군 관산읍 국도 23호선', status: 'done', age: 6, reason: '한국도로공사 협조로 낙하물 제거 완료.', carrierId: 'jip', carrier: '김철수(장흥3구)', reporterOrg: '장흥우체국', ...samplePhoto('drop') }),
    newReport({ region: '장흥군', type: 'env', item: '쓰레기·폐기물', addr: '전남 장흥군 유치면 유치로 9', status: 'done', age: 8, reason: '지자체 수거 완료.', carrierId: 'jip2', carrier: '박영희·장흥우체국 영업과', reporterOrg: '장흥우체국 영업과', ...samplePhoto('waste') }),

    newReport({ region: '장흥군', type: 'welfare', item: '복지 위기 (기타)', addr: '전남 장흥군 용산면 용산로 5', status: 'noaction', age: 6, reason: '현장 확인, 자녀 동거 확인되어 조치 불요.', carrierId: 'jip', carrier: '김철수(장흥3구)', reporterOrg: '장흥우체국',
      welfare: { name: '박OO', age: '70대', household: '기타', action: '돌봄 및 보호', reason: '생활반응 없음 의심' } }),

    ...gwangjuSeed(),
    ...boseongSeed(),
  ];
  const CLOSED = ['done', 'done', 'done', 'noaction'];
  const REPORTERS = [
    { id: 'jip',  carrier: '김철수(장흥3구)',        org: '장흥우체국' },
    { id: 'jip',  carrier: '김철수(장흥3구)',        org: '장흥우체국' },
    { id: 'jip',  carrier: '김철수(장흥3구)',        org: '장흥우체국' },
    { id: null,   carrier: '정민수(장흥1구)',        org: '장흥우체국' },
    { id: null,   carrier: '최은비(장흥2구)',        org: '장흥우체국' },
    { id: 'jip2', carrier: '박영희·장흥우체국 영업과', org: '장흥우체국 영업과' },
  ];
  const genHist = (year, upTo) => {
    for (let m = 1; m <= upTo; m++) {
      const n = 8 + Math.floor(Math.random() * 9);
      for (let i = 0; i < n; i++) {
        const type = rpick(['safe', 'safe', 'env', 'env', 'welfare']);
        const region = rpick(['장흥군', '장흥군', '장흥군', '강진군']);
        const dt = new Date(year, m - 1, 1 + Math.floor(Math.random() * 27), 9 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60));
        const g = jit(GEO[region]); const st = rpick(CLOSED);
        const household = rpick(['독거노인', '노인부부', '장애인', '기타']);
        const rep = rpick(REPORTERS);
        const item = type === 'welfare' ? `복지 위기 (${household})` : rpick(HITEMS[type]);
        const r = {
          id: 'R' + (++SEQ), type, region, item,
          addr: `전남 ${region} ${rpick(['읍내로', '해안로', '국도변', '중앙로', '산단로'])} ${1 + Math.floor(Math.random() * 200)}`,
          lat: g.lat, lng: g.lng, status: st, reason: '처리 완료', photo: false, photoUrl: null, memo: '',
          welfare: null, urgent: null, urgentNote: null, carrierUrgent: false, aiMode: 'na',
          subtype: item === '도로위험' ? rpick(['파임', '낙하물', '심한 균열', '기타']) : null,
          createdAt: dt.toISOString(), carrier: rep.carrier, carrierId: rep.id, reporterOrg: rep.org, edited: false, editedAt: null, cancelledAt: null, cancelledBy: null,
        };
        if (st === 'done' && type !== 'welfare' && Math.random() < 0.28) r.reason = '타 기관 이관 후 처리 완료';
        if (type === 'welfare') r.welfare = { name: '○○○', age: rpick(['60대', '70대', '80대']), household, action: rpick(['안부확인', '돌봄 및 보호']), reason: '현장 확인' };
        reports.push(r);
      }
    }
  };
  genHist(2025, 12);
  genHist(2026, new Date().getMonth());
  save();
}
ensureSamplePhotos();
const loaded = load();
const stale = loaded && reports.length > 0 && reports.some(r => r.reporterOrg === undefined);
if (!loaded || stale) { console.log(stale ? '▶ 이전 버전 데이터 감지 → 재씨딩' : '▶ 최초 씨딩'); seed(); }
else {
  // 기존 데이터는 그대로 두고, 새로 추가된 지역 샘플만 없으면 보충한다.
  const TOPUPS = [['광주광역시', gwangjuSeed], ['보성군', boseongSeed]];
  let added = false;
  for (const [region, seedFn] of TOPUPS) {
    if (!reports.some(r => r.region === region)) {
      console.log(`▶ 기존 데이터 유지 + ${region} 샘플만 추가`);
      reports.push(...seedFn());
      added = true;
    }
  }
  // 이전 버전에서는 샘플 사진이 SVG 플레이스홀더였다. 그때 이미 생성된 신고는
  // 그 파일명을 그대로 들고 있는데, 지금은 그 SVG를 더 안 만들기 때문에 그대로
  // 두면 사진이 깨진다. 실제 사진 파일로 참조를 갱신해 준다.
  // road.jpg는 배경 누끼(투명 처리)가 깨진 채로 올라가 있던 파일이라 완전히
  // 폐기하고, 기존에 그 파일을 참조하던 신고도 road2/road3로 재배정한다.
  const PHOTO_MIGRATIONS = {
    '/uploads/sample-road.svg': '/uploads/road2.jpg',
    '/uploads/road.jpg': '/uploads/road2.jpg',
    '/uploads/sample-facility.svg': '/uploads/facility.jpg',
    '/uploads/sample-safe.svg': '/uploads/safe_other.jpg',
    '/uploads/sample-waste.svg': '/uploads/waste.jpg',
    '/uploads/sample-env.svg': '/uploads/env_other.jpg',
    '/uploads/sample-crack.svg': '/uploads/crack.jpg',
    '/uploads/sample-drop.svg': '/uploads/drop.jpg',
  };
  for (const r of reports) {
    if (r.photoUrl && PHOTO_MIGRATIONS[r.photoUrl]) {
      r.photoUrl = PHOTO_MIGRATIONS[r.photoUrl];
      added = true;
    }
  }
  // 도로파임 신고끼리 같은 사진이 반복 노출되지 않도록 주소 기준으로 road2/road3를
  // 번갈아 재배정한다(기존 배포 데이터·위 마이그레이션으로 새로 배정된 데이터 모두 대상).
  const ROAD_REASSIGN = {
    '광주광역시 동구 금남로 118': '/uploads/road2.jpg',
    '광주광역시 동구 제봉로 22': '/uploads/road3.jpg',
    '전남 보성군 보성읍 송재로 24': '/uploads/road2.jpg',
    '전남 보성군 웅치면 대산로 9': '/uploads/road3.jpg',
    '전남 장흥군 장흥읍 흥성로 45': '/uploads/road2.jpg',
    '전남 장흥군 대덕읍 대덕로 12': '/uploads/road3.jpg',
  };
  for (const r of reports) {
    if (r.item === '도로위험' && r.subtype === '파임' && ROAD_REASSIGN[r.addr] && r.photoUrl !== ROAD_REASSIGN[r.addr]) {
      r.photoUrl = ROAD_REASSIGN[r.addr];
      added = true;
    }
  }
  // 낙하물 실제 사진 시연용으로, 보성 벌교로 88 신고를 상황관제 목록 맨 위(긴급·최신순)로
  // 끌어올린다. 이미 배포된 데이터도 동일하게 승격시킨다.
  const boseongDrop = reports.find(r => r.addr === '전남 보성군 벌교읍 벌교로 88');
  if (boseongDrop && !boseongDrop.urgent) {
    boseongDrop.urgent = true;
    boseongDrop.urgentNote = '고속화도로 차로 위 낙하물 다수, 2차 사고 위험';
    boseongDrop.createdAt = new Date().toISOString();
    added = true;
  }
  if (added) save();
}

/* ===================== 역할별 조회 필터 ===================== */
function visibleReports(user) {
  if (user.kind === 'control') return reports;
  if (user.kind === 'dept') return reports.filter(r => r.region === user.region && r.type === user.type);
  if (user.kind === 'carrier') return reports.filter(r => r.carrierId === user.id);
  return [];
}

/* ===================== 중복신고 후보 탐지 =====================
 * 같은 분야·같은 항목이고, 위치가 가깝고(200m 이내), 접수 시각이 가깝고(72시간 이내),
 * 둘 다 아직 처리 중(접수·확인중·보류)인 신고끼리만 "유사 신고"로 묶어 제안한다.
 * 자동으로 합치지 않고 관제실·지자체 담당자가 화면에서 직접 병합 여부를 판단한다. */
const DUP_RADIUS_M = 200;
const DUP_WINDOW_MS = 72 * 60 * 60 * 1000;
const DUP_OPEN_STATUSES = ['received', 'checking', 'hold'];
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
/* pool은 호출부에서 이미 '아직 열려 있는 상태'로 한 번 걸러서 넘겨준다(성능) —
 * 신고 이력이 아무리 쌓여도 이 비교는 항상 "현재 미처리 신고 수"에만 비례한다.
 * 상태 체크를 여기서도 유지하는 건, 언젠가 다른 곳에서 이 함수가 안 걸러진
 * pool로 호출되더라도 결과가 틀리지 않도록 하는 안전장치일 뿐이다. */
function findDupCandidates(report, pool) {
  if (!DUP_OPEN_STATUSES.includes(report.status)) return [];
  if (report.lat == null || report.lng == null) return [];
  const dismissed = report.dupDismissed || [];
  const t = new Date(report.createdAt).getTime();
  return pool.filter(o => o.id !== report.id
    && !dismissed.includes(o.id)
    && DUP_OPEN_STATUSES.includes(o.status)
    && o.type === report.type && o.item === report.item
    && o.lat != null && o.lng != null
    && Math.abs(new Date(o.createdAt).getTime() - t) <= DUP_WINDOW_MS
    && haversineMeters(report.lat, report.lng, o.lat, o.lng) <= DUP_RADIUS_M
  ).map(o => ({ id: o.id, addr: o.addr, carrier: o.carrier, createdAt: o.createdAt, photo: o.photo }));
}

/* ===================== 사진 저장 (base64 → 파일) ===================== */
function savePhoto(id, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('허용되지 않는 이미지 형식입니다.');
  const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new Error('사진은 8MB 이하만 가능합니다.');
  const magicOk =
    (ext === 'jpg' && buf[0] === 0xff && buf[1] === 0xd8) ||
    (ext === 'png' && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (ext === 'webp' && buf.subarray(0,4).toString() === 'RIFF' && buf.subarray(8,12).toString() === 'WEBP');
  if (!magicOk) throw new Error('실제 이미지 파일이 아닙니다.');
  const fn = `${id}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UP_DIR, fn), buf, { mode: 0o600 });
  return '/uploads/' + fn;
}
function canViewReport(user, report) {
  if (!user || !report) return false;
  if (user.kind === 'control') return true;
  if (user.kind === 'dept') return report.region === user.region && report.type === user.type;
  if (user.kind === 'carrier') return report.carrierId === user.id;
  return false;
}
const PHOTO_SIGNING_KEY = process.env.PHOTO_SIGNING_KEY;
if (!PHOTO_SIGNING_KEY || PHOTO_SIGNING_KEY.length < 32) {
  throw new Error('Railway Variables에 32자 이상의 PHOTO_SIGNING_KEY를 설정하세요.');
}
function signedPhotoUrl(reportId) {
  const exp = Date.now() + 5 * 60 * 1000;
  const payload = `${reportId}.${exp}`;
  const sig = crypto.createHmac('sha256', PHOTO_SIGNING_KEY).update(payload).digest('hex');
  return `/api/reports/${encodeURIComponent(reportId)}/photo?exp=${exp}&sig=${sig}`;
}
function validPhotoSignature(reportId, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', PHOTO_SIGNING_KEY).update(`${reportId}.${exp}`).digest('hex');
  const a = Buffer.from(String(sig)); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function publicReport(user, report) {
  const copy = { ...report };
  copy.photoUrl = (copy.photo && copy.photoUrl && canViewReport(user, report)) ? signedPhotoUrl(report.id) : null;

  // 중복신고로 병합된 신고는 '취소'로 접수 대기열에서는 빠지지만, 원 신고자 입장에서는
  // 자기 신고가 그냥 무시된 게 아니라는 걸 알아야 한다. 병합 대상 신고의 현재 처리
  // 상태만(전체 내용은 아님 — 다른 집배원의 신고일 수 있어 권한 밖) 함께 내려준다.
  if (report.mergedInto) {
    const target = reports.find(x => x.id === report.mergedInto);
    if (target) { copy.mergedIntoStatus = target.status; copy.mergedIntoReason = target.reason || null; }
  }

  // 관제실·지자체는 이 신고로 병합되어 들어온 중복신고들을, 병합 판단이 실제로
  // 맞았는지 사진과 함께 바로 확인할 수 있게 작은 미리보기 목록으로 붙여서 받는다.
  // 사진 열람 권한은 병합된 신고 자신의 region/type이 아니라 "이 원본 신고를 볼 수
  // 있는가"로 판단한다 — 지오코딩 오차 등으로 원본과 자신의 region이 미세하게
  // 어긋나 있어도, 이미 원본을 보고 있는 담당자라면 병합된 사진도 볼 수 있어야 한다.
  if (user && (user.kind === 'control' || user.kind === 'dept')) {
    const children = reports.filter(x => x.mergedInto === report.id);
    if (children.length) {
      const canViewMerged = canViewReport(user, report);
      copy.mergedChildren = children.map(x => ({
        id: x.id, item: x.item, subtype: x.subtype, addr: x.addr, carrier: x.carrier,
        createdAt: x.createdAt, status: x.status, photo: !!x.photo,
        photoUrl: (x.photo && x.photoUrl && canViewMerged) ? signedPhotoUrl(x.id) : null,
      }));
    }
  }

  if (copy.type === 'welfare' && copy.welfare) {
    if (canViewWelfarePII(user, report)) {
      copy.privacyLevel = 'full';
    } else {
      copy.welfare = {
        ...copy.welfare,
        name: maskName(copy.welfare.name),
        reason: '상세 사유는 권한 있는 복지 담당자만 열람 가능'
      };
      copy.addr = coarseAddress(copy.addr, copy.region);
      copy.privacyLevel = 'masked';
    }
  }
  return copy;
}

/* ===================== 라우트 ===================== */
const BUILD_TAG = 'v20260924-02-risk';
app.get('/api/config', (req, res) => res.json({ kakaoKey: process.env.KAKAO_JS_KEY || '', build: BUILD_TAG }));

app.post('/api/login', loginLimiter, async (req, res) => {
  const { id, pw } = req.body || {};
  const u = USERS[id];
  const ok = !!u && typeof pw === 'string' && await bcrypt.compare(pw, u.pwHash);
  if (!ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  res.json({ token: makeToken(id), user: publicUser(id), expiresIn: SESSION_TTL_MS / 1000 });
});

app.post('/api/logout', (req, res) => {
  const token = tokenFromReq(req);
  if (token) sessions.delete(token);
  res.status(204).end();
});

app.get('/api/me', (req, res) => {
  const u = userFromReq(req); if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: publicUser(u.id) });
});

app.get('/api/reports', (req, res) => {
  const u = userFromReq(req); if (!u) return res.status(401).json({ error: 'unauthorized' });
  const vis = visibleReports(u);
  const showDup = u.kind === 'control' || u.kind === 'dept';
  // 신고 이력 전체가 아니라 '아직 열려 있는 신고'만 후보 비교 대상으로 미리 추려서
  // 넘긴다 — 신고가 수만 건 쌓여도 중복 비교량은 항상 현재 미처리 건수에만 비례한다.
  const dupPool = showDup ? vis.filter(r => DUP_OPEN_STATUSES.includes(r.status)) : [];
  res.json({ reports: vis.map(r => ({ ...publicReport(u, r), dupCandidates: showDup ? findDupCandidates(r, dupPool) : [] })) });
});

app.post('/api/reports', reportLimiter, (req, res) => {
  const u = userFromReq(req); if (!u || u.kind !== 'carrier') return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const id = 'R' + (++SEQ);
  let photoUrl = null;
  if (b.photoBase64) { try { photoUrl = savePhoto(id, b.photoBase64); } catch (e) { console.error(e); } }
  const carrierUrgent = !!b.carrierUrgent;
  const needsClassification = !b.type;
  const r = {
    id, type: b.type || null, item: b.item || null, subtype: null, region: b.region || u.region || '장흥군',
    addr: b.addr || '', lat: b.lat ?? null, lng: b.lng ?? null,
    status: 'received', reason: '', memo: b.memo || '',
    photo: !!photoUrl, photoUrl, welfare: b.welfare || null,
    photoPrivacy: photoUrl ? (b.photoPrivacy || 'client-mask-unknown') : null,
    carrierUrgent, urgent: carrierUrgent, urgentNote: carrierUrgent ? '집배원이 현장에서 긴급으로 지정' : null,
    aiMode: needsClassification ? null : 'na',
    createdAt: new Date().toISOString(),
    carrier: u.zone ? `${u.name}(${u.zone})` : `${u.name}·${u.org}`, carrierId: u.id,
    reporterOrg: u.org || null,
    edited: false, editedAt: null, cancelledAt: null, cancelledBy: null,
    photoMosaic: false, mosaicBy: null, mosaicAt: null, mergedInto: null, dupDismissed: [], invalidReport: false,
  };
  reports.unshift(r); save(); broadcast();
  res.json({ report: publicReport(u, r) });

  if (needsClassification && photoUrl) {
    classifyReport(r, b.photoBase64).catch(e => console.error('classify fail', e));
  }
});

const CATEGORY_MAP = {
  road:       { type: 'safe', item: '도로위험' },
  facility:   { type: 'safe', item: '시설물 파손·고장' },
  safe_other: { type: 'safe', item: '기타 안전위험요소' },
  waste:      { type: 'env',  item: '쓰레기·폐기물' },
  env_other:  { type: 'env',  item: '기타 환경위험' },
};
async function classifyReport(r, photoBase64) {
  const key = process.env.OPENAI_API_KEY;
  let mapped = null, subtype = null, aiMode;
  const cats = Object.keys(CATEGORY_MAP);
  if (!key) {
    aiMode = 'stub';
    const cat = Math.random() < 0.1 ? 'invalid' : cats[Math.floor(Math.random() * cats.length)];
    if (cat === 'invalid') { aiMode = 'invalid'; }
    else { mapped = CATEGORY_MAP[cat]; if (cat === 'road') subtype = ['파임', '낙하물', '심한 균열', '기타'][Math.floor(Math.random() * 4)]; }
  } else {
    try {
      const prompt = `이 사진은 우체국 집배원이 "안전·환경 위험 신고"를 위해 촬영한 사진입니다.
먼저 사진이 실제로 도로·시설물·환경 문제를 보여주는지 판단하세요. 사람 신체 일부, 얼굴, 하늘, 실내, 문서, 음식, 동물 등 안전·환경 위험과 무관한 내용이면 invalid로 분류하세요.

실제 안전·환경 문제가 보이면 다음 중 하나로 분류하세요:
- road: 도로위험 (파임·낙하물·심한 균열 등)
- facility: 시설물 파손·고장 (신호등·가로등·소화전·공원시설 등)
- safe_other: 위 두 가지에 해당하지 않는 기타 안전위험요소
- waste: 쓰레기·폐기물 방치
- env_other: 위에 해당하지 않는 기타 환경위험
- invalid: 안전·환경 문제와 무관한 사진

road로 분류한 경우에만 세부유형도 판단하세요: 파임 / 낙하물 / 심한 균열 / 기타

JSON만 답하세요: {"category":"road|facility|safe_other|waste|env_other|invalid","subtype":"파임|낙하물|심한 균열|기타 또는 null"}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      let resp;
      try {
        resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: photoBase64 } },
            ] }],
            response_format: { type: 'json_object' },
            max_tokens: 60,
          }),
        });
      } finally { clearTimeout(timer); }

      const data = await resp.json();
      if (!resp.ok || !data.choices || !data.choices[0]) {
        console.error('classify AI error:', resp.status, data.error?.message || JSON.stringify(data).slice(0, 200));
        aiMode = 'error';
      } else {
        const parsed = JSON.parse(data.choices[0].message.content);
        if (parsed.category === 'invalid') {
          aiMode = 'invalid';
        } else if (cats.includes(parsed.category)) {
          mapped = CATEGORY_MAP[parsed.category];
          if (parsed.category === 'road' && ['파임', '낙하물', '심한 균열', '기타'].includes(parsed.subtype)) subtype = parsed.subtype;
          aiMode = 'openai';
        } else {
          aiMode = 'error';
        }
      }
    } catch (e) {
      console.error('classify AI fail:', e.name === 'AbortError' ? '응답 시간 초과(12초)' : e.message);
      aiMode = 'error';
    }
  }
  const live = reports.find(x => x.id === r.id);
  if (!live) return;
  if (mapped) { live.type = mapped.type; live.item = mapped.item; live.subtype = subtype; }
  live.aiMode = aiMode;
  save(); broadcast();
}

app.patch('/api/reports/:id', (req, res) => {
  const u = userFromReq(req); if (!u || (u.kind !== 'dept' && u.kind !== 'control')) return res.status(403).json({ error: 'forbidden' });
  const r = reports.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'not found' });
  if (u.kind === 'dept' && (r.region !== u.region || r.type !== u.type)) return res.status(403).json({ error: '관할 아님' });
  const b = req.body || {};
  if (b.status) {
    r.status = b.status;
    if (b.status === 'cancelled') { r.cancelledAt = new Date().toISOString(); r.cancelledBy = u.kind; }
  }
  if (typeof b.reason === 'string') r.reason = b.reason;
  if (u.kind === 'control' && b.category && CATEGORY_MAP[b.category]) {
    const m = CATEGORY_MAP[b.category];
    r.type = m.type; r.item = m.item;
    r.subtype = (b.category === 'road' && ['파임', '낙하물', '심한 균열', '기타'].includes(b.subtype)) ? b.subtype : null;
    r.aiMode = 'manual';
  }
  r.updatedAt = new Date().toISOString();
  save(); broadcast();
  res.json({ report: publicReport(u, r) });
});

/* 중복신고 병합: 자동으로 지우지 않고, 후보로 제시된 신고 중 담당자가 고른 것만
 * 취소·종결 처리하면서 어느 신고로 합쳐졌는지 기록해 둔다. */
app.patch('/api/reports/:id/merge', (req, res) => {
  const u = userFromReq(req); if (!u || (u.kind !== 'dept' && u.kind !== 'control')) return res.status(403).json({ error: 'forbidden' });
  const r = reports.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'not found' });
  if (u.kind === 'dept' && (r.region !== u.region || r.type !== u.type)) return res.status(403).json({ error: '관할 아님' });
  const intoId = (req.body || {}).intoId;
  const into = reports.find(x => x.id === intoId);
  if (!into) return res.status(400).json({ error: '병합 대상 신고를 찾을 수 없습니다.' });
  if (into.id === r.id) return res.status(400).json({ error: '같은 신고로는 병합할 수 없습니다.' });
  r.status = 'cancelled';
  r.reason = `중복신고로 판단해 ${into.id}(으)로 병합 처리함`;
  r.cancelledAt = new Date().toISOString();
  r.cancelledBy = u.kind;
  r.mergedInto = into.id;
  save(); broadcast();
  res.json({ report: publicReport(u, r) });
});

/* 유사신고 후보였지만 담당자가 실제로는 서로 다른 사건이라고 확인한 경우.
 * 이 판단을 기억해 두지 않으면 두 신고가 계속 열려 있는 동안(며칠이 걸리는
 * 사안이라도) 새로고침될 때마다 똑같은 후보 배지가 계속 다시 뜬다.
 * 어느 쪽 신고에서 봐도 다시 후보로 뜨지 않도록 양쪽 모두에 서로를 기록한다. */
app.patch('/api/reports/:id/dismiss-dup', (req, res) => {
  const u = userFromReq(req); if (!u || (u.kind !== 'dept' && u.kind !== 'control')) return res.status(403).json({ error: 'forbidden' });
  const r = reports.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'not found' });
  if (u.kind === 'dept' && (r.region !== u.region || r.type !== u.type)) return res.status(403).json({ error: '관할 아님' });
  const other = reports.find(x => x.id === (req.body || {}).otherId);
  if (!other) return res.status(400).json({ error: '대상 신고를 찾을 수 없습니다.' });
  r.dupDismissed = r.dupDismissed || [];
  other.dupDismissed = other.dupDismissed || [];
  if (!r.dupDismissed.includes(other.id)) r.dupDismissed.push(other.id);
  if (!other.dupDismissed.includes(r.id)) other.dupDismissed.push(r.id);
  save(); broadcast();
  res.json({ report: publicReport(u, r) });
});

/* 미분류 신고가 실제로는 위험사진이 아니거나 오조작인 경우, 그냥 일반 취소로
 * 처리하면 집배원 자진취소·중복병합취소 등 다른 취소 사유와 한 덩어리로 섞여버려
 * "오탐을 얼마나 걸러냈는지" 실적으로 따로 잡을 수 없다. 별도 표식을 남겨서
 * 이력·실적에서 오신고만 걸러볼 수 있게 한다. */
app.patch('/api/reports/:id/dismiss-invalid', (req, res) => {
  const u = userFromReq(req); if (!u || (u.kind !== 'dept' && u.kind !== 'control')) return res.status(403).json({ error: 'forbidden' });
  const r = reports.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'not found' });
  if (u.kind === 'dept' && (r.region !== u.region || r.type !== u.type)) return res.status(403).json({ error: '관할 아님' });
  r.status = 'cancelled';
  r.reason = `${u.kind === 'control' ? '관제실' : (u.org || u.role)}이 무관한 신고(오조작·해당없음)로 판단해 종결 처리함`;
  r.cancelledAt = new Date().toISOString();
  r.cancelledBy = u.kind;
  r.invalidReport = true;
  save(); broadcast();
  res.json({ report: publicReport(u, r) });
});

/* 수동 모자이크: 관제실·담당 부서가 사진 속 얼굴·번호판 등 개인정보로 보이는
 * 부분을 직접 가린 뒤, 원본을 그 처리된 사진으로 교체한다. 이후에는 이 신고의
 * 서명 URL이 항상 모자이크된 사진만 가리키게 된다(옛 서명 URL도 재발급 시점의
 * 최신 photoUrl을 그대로 조회하므로 원본이 새로 노출될 경로가 없다). */
app.patch('/api/reports/:id/mosaic', (req, res) => {
  const u = userFromReq(req); if (!u || (u.kind !== 'dept' && u.kind !== 'control')) return res.status(403).json({ error: 'forbidden' });
  const r = reports.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'not found' });
  if (u.kind === 'dept' && (r.region !== u.region || r.type !== u.type)) return res.status(403).json({ error: '관할 아님' });
  if (!r.photo || !r.photoUrl) return res.status(400).json({ error: '사진이 없는 신고입니다.' });
  const b = req.body || {};
  if (!b.photoBase64) return res.status(400).json({ error: '모자이크 처리된 사진이 필요합니다.' });
  let newUrl;
  try { newUrl = savePhoto(r.id + '-mosaic-' + Date.now(), b.photoBase64); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  r.photoUrl = newUrl;
  r.photoMosaic = true;
  r.mosaicBy = u.kind === 'control' ? '상황관제실' : (u.org || u.role);
  r.mosaicAt = new Date().toISOString();
  save(); broadcast();
  res.json({ report: publicReport(u, r) });
});

const LOCKED_STATUSES = ['done', 'noaction', 'cancelled'];
app.patch('/api/reports/:id/edit', (req, res) => {
  const u = userFromReq(req); if (!u || u.kind !== 'carrier') return res.status(403).json({ error: 'forbidden' });
  const r = reports.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'not found' });
  if (r.carrierId !== u.id) return res.status(403).json({ error: '본인이 접수한 신고만 수정할 수 있습니다.' });
  if (LOCKED_STATUSES.includes(r.status)) return res.status(409).json({ error: '이미 처리 완료되어 수정할 수 없습니다.' });

  const b = req.body || {};
  if (typeof b.addr === 'string') r.addr = b.addr;
  if (b.lat != null) r.lat = b.lat;
  if (b.lng != null) r.lng = b.lng;
  if (typeof b.memo === 'string') r.memo = b.memo;
  if (r.type !== 'welfare' && b.category && CATEGORY_MAP[b.category]) {
    const m = CATEGORY_MAP[b.category];
    r.type = m.type; r.item = m.item;
    r.subtype = (b.category === 'road' && ['파임', '낙하물', '심한 균열', '기타'].includes(b.subtype)) ? b.subtype : null;
    r.aiMode = 'manual';
  }
  if (r.type === 'welfare' && b.welfare && typeof b.welfare === 'object') {
    const w = b.welfare;
    r.welfare = {
      name: (typeof w.name === 'string' && w.name.trim()) ? w.name.trim() : '(미기재)',
      age: (typeof w.age === 'string' && w.age.trim()) ? w.age.trim() : '-',
      household: w.household || r.welfare.household,
      action: w.action || r.welfare.action,
      reason: typeof w.reason === 'string' ? w.reason : r.welfare.reason,
    };
    r.item = `복지 위기 (${r.welfare.household})`;
  }

  let photoChanged = false;
  if (b.photoBase64) {
    try {
      const url = savePhoto(r.id + '-e' + Date.now(), b.photoBase64);
      if (url) { r.photo = true; r.photoUrl = url; r.photoPrivacy = b.photoPrivacy || 'client-mask-unknown'; photoChanged = true; }
    } catch (e) { console.error('edit photo save fail', e); }
  }

  r.edited = true;
  r.editedAt = new Date().toISOString();
  save(); broadcast();
  res.json({ report: publicReport(u, r) });

  if (photoChanged && r.aiMode !== 'na') {
    r.aiMode = null;
    save(); broadcast();
    classifyReport(r, b.photoBase64).catch(e => console.error('classify(edit) fail', e));
  }
});

app.patch('/api/reports/:id/cancel', (req, res) => {
  const u = userFromReq(req); if (!u || u.kind !== 'carrier') return res.status(403).json({ error: 'forbidden' });
  const r = reports.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'not found' });
  if (r.carrierId !== u.id) return res.status(403).json({ error: '본인이 접수한 신고만 취소할 수 있습니다.' });
  if (LOCKED_STATUSES.includes(r.status)) return res.status(409).json({ error: '이미 처리 완료(또는 취소)되어 취소할 수 없습니다.' });
  r.status = 'cancelled';
  r.reason = (r.reason ? r.reason + ' · ' : '') + '집배원이 신고를 취소함';
  r.cancelledAt = new Date().toISOString();
  r.cancelledBy = 'carrier';
  save(); broadcast();
  res.json({ report: publicReport(u, r) });
});

app.get('/api/reports/:id/photo', (req, res) => {
  if (!validPhotoSignature(req.params.id, req.query.exp, req.query.sig)) {
    return res.status(403).json({ error: '사진 링크가 만료되었거나 올바르지 않습니다.' });
  }
  const r = reports.find(x => x.id === req.params.id);
  if (!r || !r.photoUrl) return res.status(404).json({ error: 'not found' });
  const fileName = path.basename(r.photoUrl);
  const fullPath = path.join(UP_DIR, fileName);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(fullPath);
});

/* =========================================================================
 * 집배원 안전 모드 — 우체국 안전관제(총괄국 소통팀장)
 *   ① 음성 위험신고: 집배원이 한마디 녹음 → 음성 변환 → AI가 알림 초안·긴급도·대상 구역 추천
 *      → 소통팀장이 수정 또는 그대로 확인 → 해당 구역 집배원에게 전파
 *   ② 관제실 전화: PDA 버튼으로 전화 연결 + "누가·언제·어디서" 통화 기록 자동 남김
 *   ③ 안전 알림: 긴급(확인 필수) / 주의 / 전달말씀(확인 없음)
 *   ④ 업무종료 이상유무 보고: 본인 보고 + 관제 확인 수정(수정 이력 보존)
 * 외부 신고(reports)와 데이터·권한을 완전히 분리한다(safety.json 별도 저장).
 * ========================================================================= */
const SAFETY_FILE = path.join(__dirname, 'safety.json');
const SAFETY_OFFICE = '장흥우체국';
const SAFETY_CALL_NUMBER = process.env.SAFETY_CALL_NUMBER || '061-000-0000'; // 소통팀장 사무실 번호로 교체
const LEVELS = { urgent: '긴급', caution: '주의', notice: '전달말씀' };
const kstDate = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

/* 집배 구역·명부 — ⚠️ 시연용 예시 데이터. 실제 집배구·인원·PDA 번호로 교체할 것.
 * places: 음성 속 지명을 구역으로 매칭할 때 쓰는 키워드 / near: 인접 구역 */
let ZONES = [
  { id: 'jh1', name: '장흥1구',   area: '장흥읍 북부',     places: ['건산', '기양', '장흥읍 북'],      near: ['jh2', 'jh3', 'by'],       lat: 34.692, lng: 126.905 },
  { id: 'jh2', name: '장흥2구',   area: '장흥읍 동부',     places: ['평화', '순지', '장흥읍 동'],      near: ['jh1', 'jh3', 'ay', 'ys'], lat: 34.683, lng: 126.925 },
  { id: 'jh3', name: '장흥3구',   area: '장흥읍 남부',     places: ['예양', '원도', '흥성로', '장흥읍'], near: ['jh1', 'jh2', 'ay', 'ys'], lat: 34.672, lng: 126.905 },
  { id: 'ay',  name: '안양구',    area: '안양면',          places: ['안양', '해안로', '수문'],         near: ['jh2', 'jh3', 'ys'],       lat: 34.660, lng: 126.990 },
  { id: 'ys',  name: '용산구',    area: '용산면',          places: ['용산', '어산', '운주'],           near: ['jh2', 'jh3', 'ay', 'gs'], lat: 34.640, lng: 126.950 },
  { id: 'gs',  name: '관산구',    area: '관산읍',          places: ['관산', '방촌', '천관산', '23번'], near: ['ys', 'dd'],               lat: 34.590, lng: 126.960 },
  { id: 'dd',  name: '대덕구',    area: '대덕읍·회진면',   places: ['대덕', '회진', '신리', '노력도'], near: ['gs'],                     lat: 34.540, lng: 126.880 },
  { id: 'by',  name: '부산·유치구', area: '부산면·유치면', places: ['부산면', '유치', '보림사', '탐진댐'], near: ['jh1'],                 lat: 34.740, lng: 126.890 },
];
let ROSTER = [ // id가 로그인 계정 id와 같으면 해당 계정과 연결된다(jip = 김철수)
  { id: 'jip', name: '김철수', zone: 'jh3', phone: '010-0000-0003' },
  { id: 'c01', name: '정민수', zone: 'jh1', phone: '010-0000-0001' },
  { id: 'c02', name: '최은비', zone: 'jh2', phone: '010-0000-0002' },
  { id: 'c03', name: '윤서진', zone: 'ay',  phone: '010-0000-0004' },
  { id: 'c04', name: '한지우', zone: 'ys',  phone: '010-0000-0005' },
  { id: 'c05', name: '오태민', zone: 'gs',  phone: '010-0000-0006' },
  { id: 'c06', name: '강도현', zone: 'dd',  phone: '010-0000-0007' },
  { id: 'c07', name: '임재원', zone: 'by',  phone: '010-0000-0008' },
];
const zoneById = id => ZONES.find(z => z.id === id);
const rosterById = id => ROSTER.find(r => r.id === id);
const carrierLabel = r => r ? `${r.name}(${zoneById(r.zone)?.name || r.zone})` : '-';
const isSafetyCtl = u => !!u && u.kind === 'safety' && u.org === SAFETY_OFFICE;
const safetyCarrier = u => (u && u.kind === 'carrier') ? rosterById(u.id) : null;

let SAFE = { seq: 1, hazards: [], calls: [], alerts: [], shifts: {}, returns: {}, notices: [], zones: null, roster: null };
function saveSafety() {
  try { fs.writeFileSync(SAFETY_FILE, JSON.stringify(SAFE)); } catch (e) { console.error('safety save fail', e); }
}
function loadSafety() {
  if (!fs.existsSync(SAFETY_FILE)) return false;
  try { SAFE = Object.assign(SAFE, JSON.parse(fs.readFileSync(SAFETY_FILE, 'utf8'))); if (Array.isArray(SAFE.zones) && SAFE.zones.length) ZONES = SAFE.zones; if (Array.isArray(SAFE.roster) && SAFE.roster.length) ROSTER = SAFE.roster; return true; }
  catch (e) { console.error('safety load fail', e); return false; }
}
const nextSafeId = p => p + (SAFE.seq++);

/* 업무종료 보고의 통증·부상 메모는 건강정보라 복지 정보와 같은 AES-256-GCM으로 암호화 저장 */
const encMemo = t => (t && String(t).trim()) ? encryptPrivate(String(t).trim().slice(0, 200)) : null;
const decMemo = b => b ? (decryptPrivate(b) || '') : '';

/* 시연용: 오늘 날짜 보고가 비어 있으면 일부 집배원 보고를 채워 집계 화면이 비지 않게 한다.
 * 실제 운영 시 SAFETY_DEMO=off 로 끈다. */
function ensureDemoDay() {
  if (process.env.SAFETY_DEMO === 'off') return;
  const d = kstDate();
  if (SAFE.shifts[d]) return;
  const at = new Date().toISOString();
  SAFE.shifts[d] = {
    c01: { status: 'ok', memo: null, source: 'self', at, history: [] },
    c02: { status: 'ok', memo: null, source: 'self', at, history: [] },
    c03: { status: 'ok', memo: null, source: 'self', at, history: [] },
    c05: { status: 'pain', memo: encMemo('오른쪽 무릎 시큰거림, 계단 배달 많았음'), source: 'self', at, history: [] },
    c06: { status: 'ok', memo: null, source: 'self', at, history: [] },
  };
  if (!SAFE.hazards.some(h => kstDate(new Date(h.createdAt).getTime()) === d)) {
    const h = {
      id: nextSafeId('S'), carrierId: 'c05', createdAt: at, lat: 34.592, lng: 126.958,
      audioFile: null, photoFile: null, demo: true,
      transcript: '관산 23번 국도 방촌 다리 앞에 결빙 구간 있습니다. 오토바이 미끄러질 뻔했어요.',
      sttMode: 'demo', draft: null, status: 'pending',
    };
    h.draft = stubDraft(h.transcript, h);
    SAFE.hazards.unshift(h);
  }
  saveSafety();
}

/* ---------- 파일(녹음·사진) 저장과 서명 URL ---------- */
const AUDIO_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
function parseAudio(dataUrl) {
  const m = /^data:(audio\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/s.exec(dataUrl || '');
  if (!m || !AUDIO_EXT[m[1]]) throw new Error('지원하지 않는 녹음 형식입니다.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 500) throw new Error('녹음이 너무 짧습니다.');
  if (buf.length > 6 * 1024 * 1024) throw new Error('녹음은 6MB 이하만 가능합니다.');
  return { mime: m[1], ext: AUDIO_EXT[m[1]], buf };
}
function saveSafetyFile(prefix, ext, buf) {
  const fn = `${prefix}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UP_DIR, fn), buf, { mode: 0o600 });
  return fn;
}
function signedSafetyUrl(hid, kind) {
  const exp = Date.now() + 5 * 60 * 1000;
  const sig = crypto.createHmac('sha256', PHOTO_SIGNING_KEY).update(`safety.${hid}.${kind}.${exp}`).digest('hex');
  return `/api/safety/files/${encodeURIComponent(hid)}/${kind}?exp=${exp}&sig=${sig}`;
}
function validSafetySig(hid, kind, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', PHOTO_SIGNING_KEY).update(`safety.${hid}.${kind}.${exp}`).digest('hex');
  const a = Buffer.from(String(sig)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- AI: 음성 변환 + 알림 초안 ---------- */
const URGENT_WORDS = ['사고', '결빙', '빙판', '블랙아이스', '낙석', '산사태', '침수', '전복', '화재', '붕괴', '싱크홀', '맹견'];
function matchZones(text) {
  const t = String(text || '');
  return ZONES.filter(z => z.places.some(p => t.includes(p))).map(z => z.id);
}
function nearestZone(lat, lng) {
  if (lat == null || lng == null) return null;
  let best = null, bd = Infinity;
  for (const z of ZONES) { const d = haversineMeters(lat, lng, z.lat, z.lng); if (d < bd) { bd = d; best = z.id; } }
  return best;
}
function withNeighbors(ids) {
  const set = new Set(ids);
  ids.forEach(id => (zoneById(id)?.near || []).forEach(n => set.add(n)));
  return ZONES.map(z => z.id).filter(id => set.has(id));
}
/* API 키가 없을 때의 규칙 기반 초안: 말 속 지명 → 없으면 신고자 구역 → 없으면 GPS 최근접 구역,
 * 거기에 인접 구역을 더한다. (집배원이 이미 지나온 곳을 신고할 수 있어 지명을 GPS보다 우선) */
function stubDraft(text, h) {
  const t = String(text || '').trim();
  let base = matchZones(t);
  if (!base.length) { const r = rosterById(h.carrierId); if (r) base = [r.zone]; }
  if (!base.length) { const n = nearestZone(h.lat, h.lng); if (n) base = [n]; }
  const level = URGENT_WORDS.some(w => t.includes(w)) ? 'urgent' : 'caution';
  const body = t ? t.replace(/\s+/g, ' ').slice(0, 80).replace(/[.!?]*$/, '.') : '현장 위험 신고가 접수되었습니다.';
  return { text: `${body} 해당 구간 서행·주의 바랍니다.`, level, zones: withNeighbors(base), mode: 'rule' };
}
async function openaiTranscribe(buf, mime, ext) {
  const key = process.env.OPENAI_API_KEY; if (!key) return null;
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), 'voice.' + ext);
  fd.append('model', process.env.OPENAI_STT_MODEL || 'whisper-1');
  fd.append('language', 'ko');
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd, signal: ctrl.signal });
    const j = await r.json();
    if (!r.ok) { console.error('STT error', r.status, j.error?.message); return null; }
    return (j.text || '').trim() || null;
  } catch (e) { console.error('STT fail', e.message); return null; }
  finally { clearTimeout(timer); }
}
async function openaiDraft(text, h) {
  const key = process.env.OPENAI_API_KEY; if (!key || !text) return null;
  const reporter = rosterById(h.carrierId);
  const zoneList = ZONES.map(z => `${z.id}: ${z.name}(${z.area}) 지명:${z.places.join(',')} 인접:${z.near.join(',')}`).join('\n');
  const prompt = `우체국 집배원이 배달 중 발견한 위험을 음성으로 신고했습니다. 같은 우체국 집배원들에게 보낼 안전 알림 초안을 만드세요.
신고 내용: "${text}"
신고자 담당 구역: ${reporter ? reporter.zone : '알 수 없음'}
집배 구역 목록:
${zoneList}

규칙:
- text: 운전 중에도 한눈에 읽히는 60자 이내 한국어 문장. 장소 + 위험 + 행동 요령(서행/우회 등). 신고자 이름은 넣지 말 것.
- level: 사고·결빙·낙석·침수처럼 즉시 부상 위험이면 "urgent", 그 밖에는 "caution".
- zones: 위험 장소가 속한 구역과 그 인접 구역의 id 배열. 말 속 지명을 우선하고, 지명이 없으면 신고자 구역 기준.
JSON만 답하세요: {"text":"...","level":"urgent|caution","zones":["..."]}`;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 200 }),
    });
    const j = await r.json();
    if (!r.ok || !j.choices?.[0]) { console.error('draft error', r.status, j.error?.message); return null; }
    const p = JSON.parse(j.choices[0].message.content);
    const zones = Array.isArray(p.zones) ? p.zones.filter(id => zoneById(id)) : [];
    if (!p.text || !zones.length) return null;
    return { text: String(p.text).slice(0, 120), level: p.level === 'urgent' ? 'urgent' : 'caution', zones, mode: 'openai' };
  } catch (e) { console.error('draft fail', e.message); return null; }
  finally { clearTimeout(timer); }
}
async function processVoice(hid, audio) {
  const h = SAFE.hazards.find(x => x.id === hid); if (!h) return;
  let text = null;
  if (audio) text = await openaiTranscribe(audio.buf, audio.mime, audio.ext);
  if (text) { h.transcript = text; h.sttMode = 'openai'; }
  else h.sttMode = h.transcript ? 'device' : 'none'; // device = PDA 브라우저 음성인식 결과
  h.draft = (await openaiDraft(h.transcript, h)) || stubDraft(h.transcript, h);
  saveSafety(); broadcastSafety();
}

/* ---------- 조회 가공 ---------- */
const OPEN_HAZ = ['pending', 'dispatched'];
function dupHints(h) {
  if (!OPEN_HAZ.includes(h.status)) return [];
  const t = new Date(h.createdAt).getTime();
  const myZones = new Set(h.draft?.zones?.slice(0, 1) || []);
  return SAFE.hazards.filter(o => o.id !== h.id && OPEN_HAZ.includes(o.status)
    && Math.abs(new Date(o.createdAt).getTime() - t) <= 6 * 3600e3
    && ((h.lat != null && o.lat != null && haversineMeters(h.lat, h.lng, o.lat, o.lng) <= 500)
      || (o.draft?.zones?.[0] && myZones.has(o.draft.zones[0]) && matchZones(o.transcript).some(z => matchZones(h.transcript).includes(z)))))
    .map(o => ({ id: o.id, carrier: carrierLabel(rosterById(o.carrierId)), createdAt: o.createdAt, status: o.status }));
}
function hazardForCtl(h) {
  return {
    ...h, carrier: carrierLabel(rosterById(h.carrierId)),
    audioUrl: h.audioFile ? signedSafetyUrl(h.id, 'audio') : null,
    photoUrl: h.photoFile ? signedSafetyUrl(h.id, 'photo') : null,
    audioFile: undefined, photoFile: undefined, dups: dupHints(h),
  };
}
function alertTargets(zones) {
  return ROSTER.filter(r => zones === 'all' || (Array.isArray(zones) && zones.includes(r.zone))).map(r => r.id);
}
function shiftRows(d) {
  const day = SAFE.shifts[d] || {};
  return ROSTER.map(r => {
    const s = day[r.id];
    return {
      id: r.id, name: r.name, zone: r.zone, zoneName: zoneById(r.zone)?.name, phone: r.phone,
      status: s ? s.status : 'none', memo: s ? decMemo(s.memo) : '', source: s ? s.source : null,
      at: s ? s.at : null, by: s ? s.by || null : null, note: s ? s.note || '' : '', history: s ? s.history || [] : [],
    };
  });
}
const isToday = iso => kstDate(new Date(iso).getTime()) === kstDate();

function broadcastSafety() {
  const msg = JSON.stringify({ type: 'safety' });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

/* ---------- 라우트 ---------- */
app.get('/api/safety/state', (req, res) => {
  const u = userFromReq(req); if (!u) return res.status(401).json({ error: 'unauthorized' });
  ensureDemoDay();
  const today = kstDate();
  if (isSafetyCtl(u)) {
    return res.json({
      role: 'control', today, callNumber: SAFETY_CALL_NUMBER, zones: ZONES, roster: ROSTER, levels: LEVELS,
      hazards: SAFE.hazards.filter(h => h.status === 'pending' || isToday(h.createdAt)).map(hazardForCtl),
      calls: SAFE.calls.filter(c => isToday(c.at)).map(c => ({ ...c, carrier: carrierLabel(rosterById(c.carrierId)) })),
      alerts: SAFE.alerts.filter(a => isToday(a.createdAt)),
      shifts: shiftRows(today),
    });
  }
  const me = safetyCarrier(u);
  if (!me) return res.json({ role: 'none' });
  const day = (SAFE.shifts[today] || {})[me.id];
  res.json({
    role: 'carrier', today, callNumber: SAFETY_CALL_NUMBER, me: { id: me.id, name: me.name, zone: me.zone, zoneName: zoneById(me.zone)?.name },
    alerts: SAFE.alerts.filter(a => isToday(a.createdAt) && a.targets.includes(me.id))
      .map(a => ({ id: a.id, level: a.level, text: a.text, createdAt: a.createdAt, sender: a.sender, acked: !!(a.acks || {})[me.id] })),
    myHazards: SAFE.hazards.filter(h => h.carrierId === me.id && isToday(h.createdAt))
      .map(h => ({ id: h.id, createdAt: h.createdAt, transcript: h.transcript, status: h.status })),
    shift: day ? { status: day.status, source: day.source, at: day.at } : null,
  });
});

app.post('/api/safety/voice', reportLimiter, (req, res) => {
  const u = userFromReq(req); const me = safetyCarrier(u);
  if (!me) return res.status(403).json({ error: '집배원 계정만 신고할 수 있습니다.' });
  const b = req.body || {};
  let audio = null;
  try { if (b.audioBase64) audio = parseAudio(b.audioBase64); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!audio && !String(b.clientText || '').trim()) return res.status(400).json({ error: '녹음 또는 내용이 필요합니다.' });
  const id = nextSafeId('S');
  let photoFile = null;
  if (b.photoBase64) { try { photoFile = path.basename(savePhoto(id, b.photoBase64)); } catch (e) { return res.status(400).json({ error: e.message }); } }
  const h = {
    id, carrierId: me.id, createdAt: new Date().toISOString(),
    lat: typeof b.lat === 'number' ? b.lat : null, lng: typeof b.lng === 'number' ? b.lng : null,
    audioFile: audio ? saveSafetyFile(id, audio.ext, audio.buf) : null, photoFile,
    transcript: String(b.clientText || '').trim().slice(0, 500), sttMode: 'pending', draft: null, status: 'pending',
  };
  SAFE.hazards.unshift(h); saveSafety(); broadcastSafety();
  res.json({ ok: true, id });
  processVoice(id, audio).catch(e => console.error('processVoice', e));
});

app.post('/api/safety/hazards/:id/dispatch', (req, res) => {
  const u = userFromReq(req); if (!isSafetyCtl(u)) return res.status(403).json({ error: 'forbidden' });
  const h = SAFE.hazards.find(x => x.id === req.params.id); if (!h) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const a = createAlert(u, b);
  if (a.error) return res.status(400).json(a);
  a.fromHazard = h.id;
  h.status = 'dispatched'; h.alertId = a.id; h.handledBy = u.name; h.handledAt = a.createdAt;
  saveSafety(); broadcastSafety();
  res.json({ ok: true, alert: a });
});

app.post('/api/safety/hazards/:id/close', (req, res) => {
  const u = userFromReq(req); if (!isSafetyCtl(u)) return res.status(403).json({ error: 'forbidden' });
  const h = SAFE.hazards.find(x => x.id === req.params.id); if (!h) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  h.status = 'closed';
  h.closeReason = b.dupOf ? `중복 신고(${b.dupOf})로 병합` : (b.reason === 'invalid' ? '해당 없음·오조작' : '전파 불필요');
  h.dupOf = b.dupOf || null; h.handledBy = u.name; h.handledAt = new Date().toISOString();
  saveSafety(); broadcastSafety();
  res.json({ ok: true });
});

function createAlert(u, b) {
  const level = LEVELS[b.level] ? b.level : null;
  const text = String(b.text || '').trim().slice(0, 200);
  const zones = b.zones === 'all' ? 'all' : (Array.isArray(b.zones) ? b.zones.filter(id => zoneById(id)) : []);
  if (!level || !text) return { error: '알림 단계와 내용을 입력하세요.' };
  if (zones !== 'all' && !zones.length) return { error: '대상 구역을 하나 이상 선택하세요.' };
  const a = {
    id: nextSafeId('A'), level, text, zones, targets: alertTargets(zones),
    createdAt: new Date().toISOString(), sender: `${u.org} ${u.name}`, acks: {},
  };
  SAFE.alerts.unshift(a);
  return a;
}
app.post('/api/safety/alerts', (req, res) => {
  const u = userFromReq(req); if (!isSafetyCtl(u)) return res.status(403).json({ error: 'forbidden' });
  const a = createAlert(u, req.body || {});
  if (a.error) return res.status(400).json(a);
  const callId = (req.body || {}).fromCall;
  const call = callId && SAFE.calls.find(c => c.id === callId);
  if (call) { call.alertId = a.id; a.fromCall = call.id; }
  saveSafety(); broadcastSafety();
  res.json({ ok: true, alert: a });
});

/* 수신확인은 긴급 알림만. 주의·전달말씀은 확인 버튼 자체가 없다. */
app.post('/api/safety/alerts/:id/ack', (req, res) => {
  const me = safetyCarrier(userFromReq(req)); if (!me) return res.status(403).json({ error: 'forbidden' });
  const a = SAFE.alerts.find(x => x.id === req.params.id);
  if (!a || !a.targets.includes(me.id)) return res.status(404).json({ error: 'not found' });
  if (a.level !== 'urgent') return res.status(400).json({ error: '긴급 알림만 수신확인합니다.' });
  a.acks = a.acks || {};
  if (!a.acks[me.id]) { a.acks[me.id] = new Date().toISOString(); saveSafety(); broadcastSafety(); }
  res.json({ ok: true });
});

app.post('/api/safety/calls', (req, res) => {
  const me = safetyCarrier(userFromReq(req)); if (!me) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const c = { id: nextSafeId('C'), carrierId: me.id, at: new Date().toISOString(),
    lat: typeof b.lat === 'number' ? b.lat : null, lng: typeof b.lng === 'number' ? b.lng : null, note: '', alertId: null };
  SAFE.calls.unshift(c); saveSafety(); broadcastSafety();
  res.json({ ok: true, callNumber: SAFETY_CALL_NUMBER });
});
app.post('/api/safety/calls/:id/note', (req, res) => {
  const u = userFromReq(req); if (!isSafetyCtl(u)) return res.status(403).json({ error: 'forbidden' });
  const c = SAFE.calls.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
  c.note = String((req.body || {}).note || '').trim().slice(0, 300); c.notedBy = u.name; c.notedAt = new Date().toISOString();
  saveSafety(); broadcastSafety();
  res.json({ ok: true });
});
/* 통화 메모로 알림 초안 만들기: 소통팀장이 통화 후 적은 한 줄을 AI가 알림 문구·구역으로 정리 */
app.post('/api/safety/calls/:id/draft', async (req, res) => {
  const u = userFromReq(req); if (!isSafetyCtl(u)) return res.status(403).json({ error: 'forbidden' });
  const c = SAFE.calls.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'not found' });
  const note = String((req.body || {}).note || c.note || '').trim();
  if (!note) return res.status(400).json({ error: '통화 메모를 먼저 입력하세요.' });
  const pseudo = { carrierId: c.carrierId, lat: c.lat, lng: c.lng };
  res.json({ draft: (await openaiDraft(note, pseudo)) || stubDraft(note, pseudo) });
});

const SHIFT_ST = ['ok', 'pain', 'injury'];
app.post('/api/safety/shift', (req, res) => {
  const me = safetyCarrier(userFromReq(req)); if (!me) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  if (!SHIFT_ST.includes(b.status)) return res.status(400).json({ error: '보고 항목을 선택하세요.' });
  const d = kstDate(); SAFE.shifts[d] = SAFE.shifts[d] || {};
  const prev = SAFE.shifts[d][me.id];
  SAFE.shifts[d][me.id] = {
    status: b.status, memo: b.status === 'ok' ? null : encMemo(b.memo), source: 'self', at: new Date().toISOString(),
    history: prev ? [...(prev.history || []), { status: prev.status, source: prev.source, by: prev.by || null, at: prev.at }] : [],
  };
  saveSafety(); broadcastSafety();
  res.json({ ok: true });
});
/* 관제 확인 수정: 본인 보고를 지우지 않고 이력으로 남긴 뒤 "관제 확인" 상태로 덮어쓴다 */
app.patch('/api/safety/shift/:cid', (req, res) => {
  const u = userFromReq(req); if (!isSafetyCtl(u)) return res.status(403).json({ error: 'forbidden' });
  const r = rosterById(req.params.cid); if (!r) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (!SHIFT_ST.includes(b.status)) return res.status(400).json({ error: '상태를 선택하세요.' });
  const d = kstDate(); SAFE.shifts[d] = SAFE.shifts[d] || {};
  const prev = SAFE.shifts[d][r.id];
  SAFE.shifts[d][r.id] = {
    status: b.status, memo: prev ? prev.memo : null, source: 'control', by: u.name,
    note: String(b.note || '전화 확인').trim().slice(0, 100), at: new Date().toISOString(),
    history: prev ? [...(prev.history || []), { status: prev.status, source: prev.source, by: prev.by || null, at: prev.at }] : [],
  };
  saveSafety(); broadcastSafety();
  res.json({ ok: true });
});

app.get('/api/safety/files/:hid/:kind', (req, res) => {
  const { hid, kind } = req.params;
  if (!['audio', 'photo'].includes(kind) || !validSafetySig(hid, kind, req.query.exp, req.query.sig)) {
    return res.status(403).json({ error: '링크가 만료되었거나 올바르지 않습니다.' });
  }
  const h = SAFE.hazards.find(x => x.id === hid);
  const fn = h && (kind === 'audio' ? h.audioFile : h.photoFile);
  if (!fn) return res.status(404).json({ error: 'not found' });
  const full = path.join(UP_DIR, path.basename(fn));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(full);
});


/* ===== 안심ON v2: 귀국보고(건강+장비), 공지, 구역/집배원 기준정보 ===== */
function ensureSafetyCollections(){
  SAFE.returns = SAFE.returns || {}; SAFE.notices = SAFE.notices || [];
  SAFE.zones = ZONES; SAFE.roster = ROSTER;
}
function returnRows(d){
  ensureSafetyCollections(); const day=SAFE.returns[d]||{};
  return ROSTER.map(r=>({id:r.id,name:r.name,zone:r.zone,zoneName:zoneById(r.zone)?.name||r.zone,phone:r.phone||'',report:day[r.id]||null}));
}
function returnSummary(rows){
  const reported=rows.filter(r=>r.report).length, body=rows.filter(r=>r.report?.bodyIssue).length, equipment=rows.filter(r=>r.report?.equipmentIssue).length;
  const issue=rows.filter(r=>r.report&&(r.report.bodyIssue||r.report.equipmentIssue)).length;
  const actionPending=rows.filter(r=>r.report&&(r.report.bodyIssue||r.report.equipmentIssue)&&r.report.action?.status!=='done').length;
  return {target:rows.length,reported,missing:rows.length-reported,body,equipment,issue,actionPending,ok:reported-issue};
}
app.get('/api/on/return/me',(req,res)=>{
  const me=safetyCarrier(userFromReq(req)); if(!me)return res.status(403).json({error:'집배원 계정만 이용할 수 있습니다.'});
  const d=kstDate(); ensureSafetyCollections(); res.json({date:d,report:(SAFE.returns[d]||{})[me.id]||null});
});
app.post('/api/on/return',(req,res)=>{
  const me=safetyCarrier(userFromReq(req)); if(!me)return res.status(403).json({error:'집배원 계정만 이용할 수 있습니다.'});
  const b=req.body||{}; if(b.returned!==true)return res.status(400).json({error:'귀국 확인이 필요합니다.'});
  const bodyIssue=!!b.bodyIssue,equipmentIssue=!!b.equipmentIssue;
  const bodyDetail=String(b.bodyDetail||'').trim().slice(0,300),equipmentDetail=String(b.equipmentDetail||'').trim().slice(0,300);
  if(bodyIssue&&!bodyDetail)return res.status(400).json({error:'건강 이상 내용을 간단히 적어주세요.'});
  if(equipmentIssue&&!equipmentDetail)return res.status(400).json({error:'장비 이상 내용을 간단히 적어주세요.'});
  const d=kstDate(); ensureSafetyCollections(); SAFE.returns[d]=SAFE.returns[d]||{}; const prev=SAFE.returns[d][me.id];
  SAFE.returns[d][me.id]={returned:true,bodyIssue,equipmentIssue,bodyDetail:bodyIssue?bodyDetail:'',equipmentDetail:equipmentIssue?equipmentDetail:'',at:new Date().toISOString(),action:prev?.action||null};
  saveSafety(); broadcastSafety(); res.json({ok:true});
});
app.get('/api/on/returns',(req,res)=>{
  const u=userFromReq(req); if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'}); const d=String(req.query.date||kstDate()).slice(0,10); const rows=returnRows(d);
  res.json({date:d,rosterSource:'등록 집배원 명부',summary:returnSummary(rows),rows});
});
app.post('/api/on/returns/:cid/action',(req,res)=>{
  const u=userFromReq(req); if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'}); const d=String((req.body||{}).date||kstDate()).slice(0,10);
  ensureSafetyCollections(); const r=(SAFE.returns[d]||{})[req.params.cid]; if(!r)return res.status(404).json({error:'보고 내역이 없습니다.'});
  r.action={detail:String((req.body||{}).detail||'').trim().slice(0,300),owner:String((req.body||{}).owner||u.name).trim().slice(0,50),status:['pending','in_progress','done'].includes((req.body||{}).status)?(req.body||{}).status:'in_progress',at:new Date().toISOString(),by:u.name};
  saveSafety(); broadcastSafety(); res.json({ok:true});
});
app.get('/api/on/notices',(req,res)=>{
  const u=userFromReq(req); if(!u)return res.status(401).json({error:'unauthorized'}); ensureSafetyCollections(); const me=safetyCarrier(u);
  let list=SAFE.notices; if(me) list=list.filter(n=>n.targets.includes(me.id));
  res.json({notices:list.map(n=>({...n,acked:me?!!(n.acks||{})[me.id]:undefined}))});
});
app.post('/api/on/notices',(req,res)=>{
  const u=userFromReq(req); if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'}); const b=req.body||{},title=String(b.title||'').trim().slice(0,80),body=String(b.body||'').trim().slice(0,500);
  const targets=Array.isArray(b.targets)?b.targets.filter(id=>rosterById(id)):[]; if(!title||!body||!targets.length)return res.status(400).json({error:'제목·내용·대상을 확인하세요.'});
  ensureSafetyCollections(); SAFE.notices.unshift({id:nextSafeId('N'),title,body,targets,acks:{},sender:u.name,createdAt:new Date().toISOString()}); saveSafety(); broadcastSafety(); res.json({ok:true});
});
app.post('/api/on/notices/:id/ack',(req,res)=>{
  const me=safetyCarrier(userFromReq(req)); if(!me)return res.status(403).json({error:'forbidden'}); const n=SAFE.notices.find(x=>x.id===req.params.id); if(!n||!n.targets.includes(me.id))return res.status(404).json({error:'not found'});
  n.acks=n.acks||{}; n.acks[me.id]=n.acks[me.id]||new Date().toISOString(); saveSafety(); broadcastSafety(); res.json({ok:true});
});
app.get('/api/safety/history',(req,res)=>{
  const u=userFromReq(req); if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'}); ensureSafetyCollections();
  res.json({hazards:SAFE.hazards.map(hazardForCtl),calls:SAFE.calls.map(c=>({...c,carrier:carrierLabel(rosterById(c.carrierId))})),alerts:SAFE.alerts});
});

/* 안전활동 통계·증빙 조회 — 기간별 음성신고/통화/알림/업무종료 원자료와 집계 */
app.get('/api/safety/evidence',(req,res)=>{
  const u=userFromReq(req); if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'}); ensureSafetyCollections();
  const end=String(req.query.end||kstDate()).slice(0,10), start=String(req.query.start||end).slice(0,10);
  const inRange=t=>{ const d=kstDate(new Date(t).getTime()); return d>=start&&d<=end; };
  const hazards=SAFE.hazards.filter(h=>inRange(h.createdAt)).map(hazardForCtl);
  const calls=SAFE.calls.filter(c=>inRange(c.at)).map(c=>({...c,carrier:carrierLabel(rosterById(c.carrierId))}));
  const alerts=SAFE.alerts.filter(a=>inRange(a.createdAt));
  const returns=[];
  Object.keys(SAFE.returns||{}).filter(d=>d>=start&&d<=end).sort().forEach(date=>{
    returnRows(date).forEach(r=>returns.push({date,...r}));
  });
  const reports=returns.filter(r=>r.report), body=reports.filter(r=>r.report.bodyIssue), equipment=reports.filter(r=>r.report.equipmentIssue);
  res.json({start,end,summary:{voice:hazards.length,calls:calls.length,alerts:alerts.length,returnReports:reports.length,bodyIssues:body.length,equipmentIssues:equipment.length,normalReturns:reports.filter(r=>!r.report.bodyIssue&&!r.report.equipmentIssue).length},hazards,calls,alerts,returns});
});
app.get('/api/safety/config',(req,res)=>{const u=userFromReq(req);if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'});res.json({zones:ZONES,roster:ROSTER});});
app.post('/api/safety/config/zones',(req,res)=>{
 const u=userFromReq(req);if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'});const b=req.body||{},name=String(b.name||'').trim();if(!name)return res.status(400).json({error:'구역명을 입력하세요.'});
 const id=String(b.id||('z'+Date.now())).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,30);if(zoneById(id))return res.status(409).json({error:'이미 있는 구역 ID입니다.'});
 ZONES.push({id,name,area:String(b.area||'').trim().slice(0,80),places:[],near:[],lat:null,lng:null});ensureSafetyCollections();saveSafety();broadcastSafety();res.json({ok:true});
});
app.patch('/api/safety/config/zones/:id',(req,res)=>{const u=userFromReq(req);if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'});const z=zoneById(req.params.id);if(!z)return res.status(404).json({error:'not found'});const b=req.body||{};if(b.name!=null)z.name=String(b.name).trim().slice(0,50);if(b.area!=null)z.area=String(b.area).trim().slice(0,80);ensureSafetyCollections();saveSafety();broadcastSafety();res.json({ok:true});});
app.delete('/api/safety/config/zones/:id',(req,res)=>{const u=userFromReq(req);if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'});if(ROSTER.some(r=>r.zone===req.params.id))return res.status(409).json({error:'이 구역에 등록된 집배원을 먼저 이동 또는 삭제하세요.'});ZONES=ZONES.filter(z=>z.id!==req.params.id);ensureSafetyCollections();saveSafety();broadcastSafety();res.json({ok:true});});
app.post('/api/safety/config/roster',(req,res)=>{const u=userFromReq(req);if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'});const b=req.body||{},id=String(b.id||'').trim(),name=String(b.name||'').trim();if(!id||!name||!zoneById(b.zone))return res.status(400).json({error:'계정 ID·이름·구역을 확인하세요.'});if(rosterById(id))return res.status(409).json({error:'이미 등록된 계정 ID입니다.'});ROSTER.push({id,name,zone:b.zone,phone:String(b.phone||'').trim().slice(0,30)});ensureSafetyCollections();saveSafety();broadcastSafety();res.json({ok:true});});
app.patch('/api/safety/config/roster/:id',(req,res)=>{const u=userFromReq(req);if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'});const r=rosterById(req.params.id);if(!r)return res.status(404).json({error:'not found'});const b=req.body||{};if(b.name!=null)r.name=String(b.name).trim().slice(0,50);if(b.phone!=null)r.phone=String(b.phone).trim().slice(0,30);if(b.zone&&zoneById(b.zone))r.zone=b.zone;ensureSafetyCollections();saveSafety();broadcastSafety();res.json({ok:true});});
app.delete('/api/safety/config/roster/:id',(req,res)=>{const u=userFromReq(req);if(!isSafetyCtl(u))return res.status(403).json({error:'forbidden'});ROSTER=ROSTER.filter(r=>r.id!==req.params.id);ensureSafetyCollections();saveSafety();broadcastSafety();res.json({ok:true});});

loadSafety();

/* =========================================================================
 * 위험성평가 모드 — 안전보건담당자 (총괄국)
 *   현장 사진(구조위험) → 판별 대기함 → 위험성평가표(교재 서식) → 개선조치 → 청 누적보고
 *   AI: 공정 추정·유해위험요인 문구·중대성 초안, 빈도는 누적 데이터(RA_HISTORY, 향후 Supabase) 근거와 함께 제시
 *   소통팀장 ↔ 안전보건담당자 이관(음성→평가), 역이관(사진→긴급전파)
 * 데이터는 risk.json 별도 저장. 외부 신고(reports)·즉시위험(SAFE)과 분리.
 * ========================================================================= */
const RISK_FILE = path.join(__dirname, 'risk.json');
const isSafetyMgr = u => !!u && u.kind === 'safety_mgr' && u.org === SAFETY_OFFICE;

/* 공정: 교재 서식은 소포 공정 예시. 장흥우체국 실제 공정으로 교체 예정(값은 예시). */
const PROCESSES = [
  { id: 'parcel',  name: '소포',   dept: '우편기계계' },
  { id: 'mail',    name: '통상',   dept: '우편물류계' },
  { id: 'deliv',   name: '집배',   dept: '집배실' },
  { id: 'counter', name: '창구·영업', dept: '영업과' },
  { id: 'support', name: '지원',   dept: '지원총괄계' },
];
const procById = id => PROCESSES.find(p => p.id === id);

/* 위험유형: 사진 AI 분류 결과 → 중대성 기본값·문구 초안·감소대책 우선순위 매핑.
 * 중대성(강도)은 위험유형으로 어느 정도 추정 가능(교재 이미지2 기준). 빈도는 누적데이터로 별도 산정. */
const HAZARD_TYPES = {
  pinch:    { label: '끼임',   proc: 'parcel', factor: '롤파렛·컨베이어 구동부에 신체 끼임 위험',   severity: 4, controls: ['구동부 방호덮개 설치(공학적)', '정기 점검·주의표지(관리적)', '끼임방지 장갑 지급(보호구)'] },
  cut:      { label: '베임·찔림', proc: 'parcel', factor: '파손된 철망·모서리에 긁히거나 찔릴 위험', severity: 3, controls: ['파렛 정기점검·수리센터 운영(관리적)', '손보호 장갑 지급(보호구)'] },
  fall:     { label: '넘어짐·전도', proc: 'parcel', factor: '적재·이동 중 파렛 전도 및 낙하물 위험', severity: 3, controls: ['적재 높이 제한·구획 표시(관리적)', '안전화 지급(보호구)'] },
  msds:     { label: '근골격계', proc: 'parcel', factor: '중량물 반복 취급으로 허리·어깨 근골격계 질환 위험', severity: 3, controls: ['작업대 높이 조정·리프트 도입(공학적)', '작업 전 스트레칭·순환배치(관리적)', '허리보호대 지급(보호구)'] },
  elec:     { label: '감전',   proc: 'support', factor: '노출 배선·전기설비 접촉으로 감전 위험',   severity: 4, controls: ['배선 정리·커버 설치(공학적)', '누전차단기 점검(관리적)'] },
  collision:{ label: '충돌',   proc: 'deliv',  factor: '전동차·지게차 주행 중 근로자와 충돌 위험', severity: 4, controls: ['주행 경보·경광등 설치(공학적)', '보행자 통로 분리(관리적)'] },
  slip:     { label: '미끄러짐', proc: 'support', factor: '바닥 물기·기름으로 미끄러져 넘어질 위험', severity: 2, controls: ['미끄럼방지 바닥재·즉시 청소(관리적)', '미끄럼방지 안전화(보호구)'] },
  other:    { label: '기타',   proc: 'parcel', factor: '기타 안전보건 위험요인',                 severity: 2, controls: ['현장 점검 후 대책 수립(관리적)'] },
};
const SEV_TEXT = { 1: '경미(1일~1주 미만 휴업)', 2: '소(1~4주 휴업)', 3: '중(4~12주 휴업)', 4: '대(12~24주 휴업)', 5: '최대(사망·24주 이상)' };
const FREQ_TEXT = { 1: '거의 없음', 2: '낮음', 3: '보통', 4: '높음', 5: '매우 높음' };
const RISK_THRESHOLD = 9; // 위험성 이 값 이상이면 허용불가(교재 예시: 9=허용불가, 6=허용)

let RISK = { seq: 1, items: [] };
function saveRisk() { try { fs.writeFileSync(RISK_FILE, JSON.stringify(RISK)); } catch (e) { console.error('risk save fail', e); } }
function loadRisk() { if (!fs.existsSync(RISK_FILE)) return false;
  try { RISK = Object.assign(RISK, JSON.parse(fs.readFileSync(RISK_FILE, 'utf8'))); return true; } catch (e) { console.error('risk load fail', e); return false; } }
const nextRiskId = () => 'RA' + (RISK.seq++);

/* ---------- 누적 데이터 (빈도 산정 근거) ----------
 * 지금은 앱에 심은 샘플 + 실제 접수분으로 계산한다. 추후 Supabase로 교체:
 *   RA_SOURCE=supabase 이면 fetchFreqHistory()가 Supabase REST를 호출(SUPABASE_URL/KEY 필요).
 * 아래 RA_HISTORY_SEED는 "과거 유사 신고" 시연용 씨앗(공정·위험유형·발생일). */
const RA_HISTORY_SEED = (() => {
  const rows = []; const now = Date.now(); const D = 864e5;
  const add = (proc, hz, ago, n = 1) => { for (let i = 0; i < n; i++) rows.push({ proc, hazard: hz, at: new Date(now - (ago + i * 3) * D).toISOString() }); };
  add('parcel', 'cut', 12, 9);      // 소포 베임·찔림 최근 3개월 다수 → 빈도 근거
  add('parcel', 'pinch', 20, 4);
  add('parcel', 'msds', 8, 6);
  add('deliv', 'collision', 40, 2);
  add('support', 'slip', 15, 3);
  add('parcel', 'fall', 55, 2);
  return rows;
})();
async function fetchFreqHistory() {
  if (process.env.RA_SOURCE === 'supabase' && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/hazard_history?select=proc,hazard,at`, {
        headers: { apikey: process.env.SUPABASE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_KEY },
      });
      if (r.ok) return await r.json();
    } catch (e) { console.error('supabase freq fail', e.message); }
  }
  // 폴백: 씨앗 + 실제 등록된 평가항목 이력
  const live = RISK.items.filter(it => it.proc && it.hazard).map(it => ({ proc: it.proc, hazard: it.hazard, at: it.createdAt }));
  return RA_HISTORY_SEED.concat(live);
}
/* 최근 6개월 같은 공정·같은 위험유형 건수 → 빈도 점수(교재 이미지2 구간 근사) */
function freqScore(n) { return n >= 24 ? 5 : n >= 12 ? 4 : n >= 4 ? 3 : n >= 1 ? 2 : 1; }
async function estimateFrequency(proc, hazard) {
  const hist = await fetchFreqHistory();
  const since = Date.now() - 182 * 864e5;
  const n = hist.filter(h => h.proc === proc && h.hazard === hazard && new Date(h.at).getTime() >= since).length;
  const score = freqScore(n);
  const reason = n > 0
    ? `최근 6개월 ${procById(proc)?.name || proc} 공정 '${HAZARD_TYPES[hazard]?.label || hazard}' 유사 신고 ${n}건 → 빈도 ${score}`
    : `누적 데이터 없음 → 담당자 판단 필요(기본 ${score})`;
  return { score, count: n, reason, hasData: n > 0 };
}

/* ---------- AI: 사진 분류 → 위험유형 ---------- */
async function classifyHazardPhoto(item, photoBase64) {
  const key = process.env.OPENAI_API_KEY;
  const types = Object.keys(HAZARD_TYPES);
  let hazard = null, aiMode;
  if (!key || !photoBase64) {
    aiMode = key ? 'no-photo' : 'stub';
    hazard = item.hazard || 'cut'; // 시연 기본값
  } else {
    try {
      const prompt = `우체국 물류 현장에서 근로자가 신고한 "구조적 안전위험" 사진입니다. 다음 중 가장 맞는 위험유형 하나로 분류하세요.
${Object.entries(HAZARD_TYPES).map(([k, v]) => `- ${k}: ${v.label} (${v.factor})`).join('\n')}
JSON만: {"hazard":"pinch|cut|fall|msds|elec|collision|slip|other"}`;
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: 'gpt-4o-mini', response_format: { type: 'json_object' }, max_tokens: 30,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: photoBase64 } }] }] }),
      }).finally(() => clearTimeout(timer));
      const j = await r.json();
      const p = JSON.parse(j.choices[0].message.content);
      hazard = types.includes(p.hazard) ? p.hazard : 'other'; aiMode = 'openai';
    } catch (e) { console.error('hazard classify fail', e.message); hazard = item.hazard || 'other'; aiMode = 'error'; }
  }
  const live = RISK.items.find(x => x.id === item.id); if (!live) return;
  const t = HAZARD_TYPES[hazard];
  live.hazard = hazard; live.aiMode = aiMode;
  if (!live.proc) live.proc = t.proc;
  live.aiDraft = {
    factor: t.factor, severity: t.severity, severityText: SEV_TEXT[t.severity],
    controls: t.controls, hazardLabel: t.label,
  };
  const f = await estimateFrequency(live.proc, hazard);
  live.aiDraft.frequency = f.score; live.aiDraft.frequencyReason = f.reason; live.aiDraft.frequencyHasData = f.hasData;
  saveRisk(); broadcastRisk();
}

function broadcastRisk() {
  const msg = JSON.stringify({ type: 'risk' });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

/* ---------- 조회 가공 ---------- */
function riskCalc(freq, sev) {
  if (freq == null || sev == null) return { risk: null, allow: null };
  const risk = freq * sev;
  return { risk, allow: risk < RISK_THRESHOLD };
}
function itemForMgr(it) {
  const c = riskCalc(it.frequency, it.severity);
  return {
    ...it,
    procName: procById(it.proc)?.name || null,
    hazardLabel: it.hazard ? HAZARD_TYPES[it.hazard]?.label : null,
    photoUrl: it.photoFile ? signedRiskUrl(it.id, "photo") : null,
    beforePhotoUrl: it.beforePhotoFile ? signedRiskUrl(it.id, "before") : null,
    afterPhotoUrl: it.afterPhotoFile ? signedRiskUrl(it.id, "after") : null,
    riskValue: c.risk, allow: c.allow,
    photoFile: undefined, beforePhotoFile: undefined, afterPhotoFile: undefined,
  };
}
/* 이미지 서명 URL은 hazard(SAFE)와 별개 저장소이므로 risk 전용 파일 라우트를 따로 둔다 */
function signedRiskUrl(id, kind) {
  const exp = Date.now() + 5 * 60 * 1000;
  const sig = crypto.createHmac('sha256', PHOTO_SIGNING_KEY).update(`risk.${id}.${kind}.${exp}`).digest('hex');
  return `/api/risk/files/${encodeURIComponent(id)}/${kind}?exp=${exp}&sig=${sig}`;
}

/* ---------- 라우트 ---------- */
app.get('/api/risk/state', async (req, res) => {
  const u = userFromReq(req); if (!isSafetyMgr(u)) return res.status(403).json({ error: 'forbidden' });
  ensureRiskDemo();
  res.json({
    role: 'safety_mgr', processes: PROCESSES, hazardTypes: HAZARD_TYPES,
    sevText: SEV_TEXT, freqText: FREQ_TEXT, threshold: RISK_THRESHOLD,
    inbox: RISK.items.filter(it => it.status === 'inbox').map(itemForMgr),
    registered: RISK.items.filter(it => it.status !== 'inbox').map(itemForMgr),
  });
});

/* 현장 사진신고 접수 — 내근직원(바로 대기열) / 집배원(판별 후) 구분해 status 결정 */
function intakeRiskPhoto(u, b, viaTransfer) {
  const id = nextRiskId();
  let photoFile = null;
  if (b.photoBase64) { try { photoFile = path.basename(savePhoto('risk-' + id, b.photoBase64)); } catch (e) { throw e; } }
  const fromCarrier = u.kind === 'carrier' && !!(rosterById && rosterById(u.id));
  const it = {
    id, status: 'inbox',
    source: viaTransfer ? 'transfer' : (fromCarrier ? 'carrier' : 'staff'),
    reporter: u.name, reporterOrg: u.org || null, reporterZone: u.zone || null,
    createdAt: new Date().toISOString(),
    lat: typeof b.lat === 'number' ? b.lat : null, lng: typeof b.lng === 'number' ? b.lng : null,
    note: String(b.note || b.transcript || '').slice(0, 300),
    photoFile, proc: b.proc || null, hazard: null, aiMode: 'pending', aiDraft: null,
    // 평가값(담당자 확정)
    factor: null, currentControl: null, frequency: null, severity: null,
    reduction: null, afterRisk: null, dueDate: null, dept: null, owner: null,
    beforePhotoFile: photoFile, afterPhotoFile: null, doneAt: null, transferNote: b.transferNote || null,
  };
  RISK.items.unshift(it); saveRisk(); broadcastRisk();
  if (photoFile) classifyHazardPhoto(it, b.photoBase64).catch(e => console.error('classify', e));
  else classifyHazardPhoto(it, null).catch(() => {});
  return it;
}
app.post('/api/risk/report', reportLimiter, (req, res) => {
  const u = userFromReq(req);
  if (!u || (u.kind !== 'carrier' && u.kind !== 'staff' && !isStaffLike(u))) return res.status(403).json({ error: '신고 권한이 없습니다.' });
  try { const it = intakeRiskPhoto(u, req.body || {}, false); res.json({ ok: true, id: it.id }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* 소통팀장 → 위험성평가 이관: 음성신고를 구조위험으로 판단해 넘김 */
app.post('/api/safety/hazards/:id/to-risk', (req, res) => {
  const u = userFromReq(req); if (!isSafetyCtl(u)) return res.status(403).json({ error: 'forbidden' });
  const h = SAFE.hazards.find(x => x.id === req.params.id); if (!h) return res.status(404).json({ error: 'not found' });
  const it = {
    id: nextRiskId(), status: 'inbox', source: 'transfer',
    reporter: carrierLabel(rosterById(h.carrierId)), reporterOrg: SAFETY_OFFICE, reporterZone: null,
    createdAt: new Date().toISOString(), lat: h.lat, lng: h.lng,
    note: h.transcript || '', photoFile: null, proc: (req.body || {}).proc || null,
    hazard: null, aiMode: 'pending', aiDraft: null, factor: null, currentControl: null,
    frequency: null, severity: null, reduction: null, afterRisk: null, dueDate: null, dept: null, owner: null,
    beforePhotoFile: null, afterPhotoFile: null, doneAt: null,
    transferNote: `소통팀장 이관: ${(req.body || {}).note || h.transcript || ''}`.slice(0, 300), fromHazard: h.id,
  };
  RISK.items.unshift(it);
  h.status = 'closed'; h.closeReason = '위험성평가로 이관'; h.handledBy = u.name; h.handledAt = it.createdAt; h.toRisk = it.id;
  saveRisk(); saveSafety(); broadcastRisk(); broadcastSafety();
  classifyHazardPhoto(it, null).catch(() => {});
  res.json({ ok: true, id: it.id });
});

/* 안전보건담당자 → 소통팀장 긴급전파 요청(역이관): 사진 사안이 지금 위험할 때 */
app.post('/api/risk/items/:id/to-urgent', (req, res) => {
  const u = userFromReq(req); if (!isSafetyMgr(u)) return res.status(403).json({ error: 'forbidden' });
  const it = RISK.items.find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const a = createAlert({ org: SAFETY_OFFICE, name: '안전보건담당자' }, { level: b.level || 'caution', text: b.text || it.note || '현장 위험 주의', zones: b.zones || 'all' });
  if (a.error) return res.status(400).json(a);
  a.fromRisk = it.id; it.urgentAlertId = a.id;
  saveSafety(); saveRisk(); broadcastSafety(); broadcastRisk();
  res.json({ ok: true, alert: a });
});

/* 판별: 대기함 → 위험성평가 대기열 승격 / 외부신고 회부 / 오신고 폐기 */
app.post('/api/risk/items/:id/triage', (req, res) => {
  const u = userFromReq(req); if (!isSafetyMgr(u)) return res.status(403).json({ error: 'forbidden' });
  const it = RISK.items.find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: 'not found' });
  const dec = (req.body || {}).decision;
  if (dec === 'promote') it.status = 'assessing';
  else if (dec === 'external') { it.status = 'discarded'; it.discardReason = '외부(지자체) 사안으로 회부'; }
  else if (dec === 'invalid') { it.status = 'discarded'; it.discardReason = '오신고·해당없음'; }
  else return res.status(400).json({ error: 'decision 오류' });
  it.triagedBy = u.name; it.triagedAt = new Date().toISOString();
  saveRisk(); broadcastRisk();
  res.json({ ok: true });
});

/* 위험성평가 저장(담당자 확정) */
app.patch('/api/risk/items/:id', (req, res) => {
  const u = userFromReq(req); if (!isSafetyMgr(u)) return res.status(403).json({ error: 'forbidden' });
  const it = RISK.items.find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const str = (k, max = 300) => { if (typeof b[k] === 'string') it[k] = b[k].slice(0, max); };
  if (b.proc && procById(b.proc)) it.proc = b.proc;
  if (b.hazard && HAZARD_TYPES[b.hazard]) it.hazard = b.hazard;
  str('factor'); str('currentControl'); str('reduction', 500); str('dept', 100); str('owner', 60); str('dueDate', 20); str('workContent', 200);
  const num = (k) => { if (b[k] === null) it[k] = null; else if (b[k] != null) { const n = +b[k]; if (n >= 1 && n <= 5) it[k] = n; } };
  num('frequency'); num('severity'); num('afterRisk');
  if (it.status === 'assessing' && it.frequency && it.severity) it.status = 'assessed';
  it.updatedAt = new Date().toISOString(); it.assessedBy = u.name;
  saveRisk(); broadcastRisk();
  res.json({ ok: true, item: itemForMgr(it) });
});

/* 개선조치 완료(개선 후 사진·위험성) → 이행결과서 생성 근거 */
app.post('/api/risk/items/:id/improve', (req, res) => {
  const u = userFromReq(req); if (!isSafetyMgr(u)) return res.status(403).json({ error: 'forbidden' });
  const it = RISK.items.find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (b.afterPhotoBase64) { try { it.afterPhotoFile = path.basename(savePhoto('risk-after-' + it.id, b.afterPhotoBase64)); } catch (e) { return res.status(400).json({ error: e.message }); } }
  if (b.afterRisk != null) { const n = +b.afterRisk; if (n >= 1 && n <= 25) it.afterRisk = n; }
  if (typeof b.reduction === 'string') it.reduction = b.reduction.slice(0, 500);
  it.status = 'done'; it.doneAt = new Date().toISOString(); it.improvedBy = u.name;
  saveRisk(); broadcastRisk();
  res.json({ ok: true });
});

/* 청 누적보고: 기간 집계 */
app.get('/api/risk/report-summary', (req, res) => {
  const u = userFromReq(req);
  if (!isSafetyMgr(u) && !(u && u.kind === 'control')) return res.status(403).json({ error: 'forbidden' });
  const days = Math.min(365, Math.max(1, +req.query.days || 30));
  const since = Date.now() - days * 864e5;
  const inRange = RISK.items.filter(it => it.status !== 'inbox' && it.status !== 'discarded' && new Date(it.createdAt).getTime() >= since);
  const assessed = inRange.filter(it => it.frequency && it.severity);
  const highRisk = assessed.filter(it => it.frequency * it.severity >= RISK_THRESHOLD);
  const done = highRisk.filter(it => it.status === 'done');
  const byProc = PROCESSES.map(p => ({ proc: p.name, count: inRange.filter(it => it.proc === p.id).length })).filter(x => x.count);
  const improved = inRange.filter(it => it.status === 'done' && it.afterRisk != null && it.frequency && it.severity)
    .map(it => ({ id: it.id, before: it.frequency * it.severity, after: it.afterRisk, factor: it.factor, proc: procById(it.proc)?.name }));
  res.json({
    days, office: SAFETY_OFFICE, generatedAt: new Date().toISOString(),
    total: inRange.length, assessed: assessed.length,
    highRisk: highRisk.length, highRiskDone: done.length,
    actionRate: highRisk.length ? Math.round(done.length / highRisk.length * 100) : null,
    pending: inRange.filter(it => it.status === 'assessing' || it.status === 'assessed').length,
    byProc, improved,
    dataSource: process.env.RA_SOURCE === 'supabase' ? 'supabase' : 'sample',
  });
});

app.get('/api/risk/files/:id/:kind', (req, res) => {
  const { id, kind } = req.params;
  const okSig = validSafetySig && crypto.createHmac; // guard
  const exp = req.query.exp, sig = req.query.sig;
  const expected = crypto.createHmac('sha256', PHOTO_SIGNING_KEY).update(`risk.${id}.${kind}.${exp}`).digest('hex');
  const a = Buffer.from(String(sig || '')), bexp = Buffer.from(expected);
  if (!exp || Number(exp) < Date.now() || a.length !== bexp.length || !crypto.timingSafeEqual(a, bexp)) {
    return res.status(403).json({ error: '링크가 만료되었거나 올바르지 않습니다.' });
  }
  const it = RISK.items.find(x => x.id === id);
  const fn = it && (kind === 'after' ? it.afterPhotoFile : (kind === 'before' ? it.beforePhotoFile : it.photoFile));
  if (!fn) return res.status(404).json({ error: 'not found' });
  const full = path.join(UP_DIR, path.basename(fn));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Cache-Control', 'private, no-store'); res.sendFile(full);
});

/* 내근직원 판정 헬퍼: carrier 외 우체국 소속 계정(jip2=영업과 직원 등)도 사진신고 허용 */
function isStaffLike(u) { return u && (u.kind === 'carrier' || (u.org && String(u.org).includes(SAFETY_OFFICE))); }

/* itemForMgr는 signedSafetyUrl을 쓰지 않고 risk 전용 URL을 쓰도록 교정 */
function fixRiskUrls(it) {}

/* 시연용 위험성평가 샘플: 대기함 1건 + 평가중 1건 + 완료 1건 */
function ensureRiskDemo() {
  if (process.env.RA_DEMO === 'off') return;
  if (RISK.items.length) return;
  const now = Date.now();
  const mk = o => Object.assign({ id: nextRiskId(), createdAt: new Date(now - (o.ago || 0) * 864e5).toISOString(),
    lat: 34.681, lng: 126.907, note: '', photoFile: null, beforePhotoFile: null, afterPhotoFile: null,
    aiMode: 'demo', factor: null, currentControl: null, frequency: null, severity: null,
    reduction: null, afterRisk: null, dueDate: null, dept: null, owner: null, source: 'staff', reporter: '내근직원' }, o);
  const cut = HAZARD_TYPES.cut, msds = HAZARD_TYPES.msds;
  // 대기함(집배원 사진, 판별 전) — AI 초안만 있음
  const a = mk({ status: 'inbox', source: 'carrier', reporter: '김철수(장흥3구)', ago: 0, proc: 'parcel', hazard: 'cut',
    note: '분류장 롤파렛 철망 찢어져 있음', workContent: '롤파렛 취급',
    aiDraft: { factor: cut.factor, severity: 3, severityText: SEV_TEXT[3], controls: cut.controls, hazardLabel: cut.label,
      frequency: 3, frequencyReason: '최근 6개월 소포 공정 \'베임·찔림\' 유사 신고 9건 → 빈도 3', frequencyHasData: true } });
  // 평가 중(승격됨) — 담당자 입력 대기
  const b = mk({ status: 'assessing', source: 'staff', reporter: '박영희·영업과', ago: 2, proc: 'parcel', hazard: 'pinch',
    workContent: '롤파렛 취급', factor: HAZARD_TYPES.pinch.factor, currentControl: '- 안전화 지급 착용\n- 안전교육',
    aiDraft: { factor: HAZARD_TYPES.pinch.factor, severity: 4, severityText: SEV_TEXT[4], controls: HAZARD_TYPES.pinch.controls, hazardLabel: '끼임',
      frequency: 3, frequencyReason: '최근 6개월 소포 공정 \'끼임\' 유사 신고 4건 → 빈도 3', frequencyHasData: true } });
  // 완료 — 개선 전/후 있음(이행결과서 시연)
  const c = mk({ status: 'done', source: 'staff', reporter: '박영희·영업과', ago: 20, proc: 'parcel', hazard: 'msds',
    workContent: '슈트작업', factor: '평파렛에 랩을 싸는 과정에서 허리·어깨 등에 근골격계 질환 위험',
    currentControl: '- 안전교육\n- 작업 전 스트레칭', frequency: 4, severity: 3,
    reduction: '- 허리보호대 지급 및 사용\n- 랩 손잡이 지급 및 사용', afterRisk: 4, dueDate: '6.30', dept: '지원총괄계', owner: '정영희',
    doneAt: new Date(now - 5 * 864e5).toISOString() });
  RISK.items.push(a, b, c); saveRisk();
}

loadRisk();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/dashboard.html'));

/* ===================== WebSocket (실시간 반영) ===================== */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
function broadcast() {
  const msg = JSON.stringify({ type: 'changed' });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const session = sessionFromToken(url.searchParams.get('token') || '');
    if (!session) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } catch { socket.destroy(); }
});
wss.on('connection', ws => { ws.send(JSON.stringify({ type: 'hello' })); });

server.listen(PORT, () => console.log(`▶ 생활안전·복지 신고 서버 실행 :${PORT}`));
