-- 010: 직원 명단·계정 (AGENTS.md 1-1절, 다시 실행해도 안전)
-- 이름·휴대폰 번호가 든 개인정보이므로 서버만 서비스 키로 읽고 쓴다. RLS를 켜고 정책을 두지 않아 브라우저(anon 키)로는
-- 읽을 수 없다. 사번은 없고 사람은 id로 구분한다. 비밀번호는 bcrypt 해시만 저장한다(2단계 인증은 나중에).
-- 엑셀 칸: 우체국명 | 부서 | 이름 | 전화번호 | 담당업무 | 배달구역 | 팀이름 (배달구역이 있으면 외근).

create table if not exists public.staff (
  id bigint generated always as identity primary key,
  office_code text not null,
  office_name text not null,
  dept text not null default '',
  name text not null,
  phone text not null,                       -- 숫자만(01012345678)
  duty text not null default '',             -- 담당업무
  zone text not null default '',             -- 배달구역(있으면 외근)
  team text not null default '',             -- 팀이름(집배 팀, 소통실 알림·공지 묶음)
  login_id text,                             -- 이름(동명이인은 "이름(국)")
  pw_hash text,                              -- 가입 전·초기화 뒤에는 비어 있음
  joined_at timestamptz,
  join_device text not null default '',
  consent_at timestamptz,                    -- 개인정보 수집·이용 동의 시각
  last_login_at timestamptz,
  failed_count int not null default 0,       -- 5번 틀리면 30분 잠금
  locked_until timestamptz,
  disabled boolean not null default false,   -- 전출·퇴직·휴직: 지우지 않고 사용 중지
  roles jsonb not null default '{}'::jsonb,  -- {control: 소통실, admin: 명단 관리자, risk: 위험성평가 역할}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists staff_name_phone on public.staff (name, phone);
create unique index if not exists staff_login_id on public.staff (login_id) where login_id is not null and not disabled;

create table if not exists public.staff_changes (
  id bigint generated always as identity primary key,
  staff_id bigint references public.staff(id) on delete set null,
  staff_name text not null default '',
  action text not null,                      -- added·changed·updated·disabled·signup·reset·unlock·locked·login_id·risk_role
  detail jsonb not null default '{}'::jsonb,
  by_name text not null default '',
  by_id text not null default '',
  at timestamptz not null default now()
);
create index if not exists staff_changes_staff on public.staff_changes (staff_id);

alter table public.staff enable row level security;
alter table public.staff_changes enable row level security;
revoke all on public.staff, public.staff_changes from anon, authenticated;
