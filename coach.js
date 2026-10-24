/* =====================================================================
   KAAY 64기 · 11주 체력 코치 플랜 (coach.js)
   ---------------------------------------------------------------------
   docs/체력_기록단축_계획서.md 의 처방을 앱 안에서 날짜별로 계산해 보여준다.
     - 주차/페이즈: 플랜 시작일(W1 월요일)부터 11주, 가입교 D-Day
     - 기준값: W1 끝까지의 마지막 측정 기록 → 없으면 '임시 기준값'(설정)
     - 참조값: 오늘까지의 최신 측정 기록 → W4·W8 측정 후 페이스·세트 수 자동 갱신
     - 근거 상한: 3km 11주 −7% (Esfarjani & Laursen 2007, 10주 −7.3%)
                  횟수 11주 +30% (설계 가정 · 근거 약함)
   fitness-plus.js(KAAYFit) 다음에 로드되어야 한다.
   ===================================================================== */
(function () {
  'use strict';

  const F = window.KAAYFit;
  if (!F) { console.warn('[Coach] fitness-plus.js 가 먼저 로드되어야 합니다.'); return; }
  const { MODES, MODE_LABEL, GRADE_BADGE, $, esc } = F;

  /* ---------- 1. 설정 ---------- */
  const SETTINGS_KEY = 'KAAY_COACH_SETTINGS';
  const DEFAULT_SETTINGS = {
    planStart: '2026-10-26',     // W1 월요일
    enrollDate: '2027-01-11',    // 64기 가입교
    targets: { run: '특급', pushup: '특급', situp: '특급' },
    provisional: { run: null, pushup: null, situp: null },   // 측정 전 임시 기준값 (3km 초 / 2분 횟수)
    updatedAt: null
  };

  function getSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      targets: { ...DEFAULT_SETTINGS.targets, ...(saved.targets || {}) },
      provisional: { ...DEFAULT_SETTINGS.provisional, ...(saved.provisional || {}) }
    };
  }

  function writeSettings(next, { upload = true } = {}) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch (e) { console.warn('[Coach] 설정 저장 실패:', e); }
    const auth = window.KAAYAuth;
    if (upload && auth && typeof auth.uploadSettings === 'function') auth.uploadSettings(next);
  }

  function saveSettings(next) {
    next.updatedAt = new Date().toISOString();
    writeSettings(next);
    window.renderFitnessUI();   // 종합 현황·주간 처방 카드와 코치 화면을 함께 갱신
  }

  /* ---------- 2. 상수: 근거 상한 · 페이스 비율 · 중간 점검 ---------- */
  const TOTAL_WEEKS = 11;
  const RUN_CAP = 0.07;          // 3km 11주 단축 상한
  const REPS_CAP = 0.30;         // 횟수 11주 증가 상한
  const PACE_RATIO = { E: [1.30, 1.45], T: 1.09, I: 1.00, R: 0.93 };   // 3km 페이스(P3) 대비 (Daniels 표 근사)
  const CHECKPOINTS = [
    { week: 4, runCut: 0.025, repShare: 0.35 },   // W4: 3km −2.5% / 횟수 격차의 35%
    { week: 8, runCut: 0.05, repShare: 0.70 }     // W8: 3km −5%   / 횟수 격차의 70%
  ];
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const DAY_KO = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };

  /* ---------- 3. 주차별 처방 데이터 (계획서 §5-3 · §6-2 · §7-2 · §8) ---------- */
  const E = (min, strides) => ({ kind: 'E', min, strides });                           // 이지런
  const I = (reps, dist, rest, pace = 'I', extra) => ({ kind: 'I', reps, dist, rest, pace, extra });   // 인터벌
  const T = (blocks, rest) => ({ kind: 'T', blocks, rest });                           // 역치
  const L = (min) => ({ kind: 'L', min });                                             // 장거리 이지
  const OFF = { kind: 'OFF' };
  const TT = { kind: 'TT' };                                                           // 3km 측정
  const REH = { kind: 'REH' };                                                         // 3종목 리허설
  const OT = (note) => ({ kind: 'OT', note });
  const S = (sets, sec, rest) => ({ kind: 'S', sets, sec, rest });                     // 페이스 세트
  const TEST = { kind: 'TEST' };                                                       // 2분 최대 측정
  const SIM = { kind: 'SIM' };                                                         // 2분 시뮬레이션

  // push.s2 = 수요일 총량(M의 배수) · push.gtg = [횟수, M 비율] · sit.emom = [분, M 비율]
  const PLAN = {
    1: { run: { mon: E(35, 6), tue: I(5, 800, '회복 조깅 400m'), wed: E(25), thu: T([15]), fri: E(25, 6), sat: L(50) },
      push: { s1: S(4, 30, '3:00'), s2: 1.8, gtg: [4, 0.40] }, sit: { s1: S(4, 30, '4:00'), emom: [8, 0.30], s3: 'base' }, legs: 'p1' },
    2: { run: { mon: E(35, 6), tue: I(6, 800, '회복 조깅 400m'), wed: E(25), thu: T([18]), fri: E(25, 6), sat: L(55) },
      push: { s1: S(5, 30, '2:30'), s2: 2.0, gtg: [4, 0.40] }, sit: { s1: S(5, 30, '3:00'), emom: [10, 0.30], s3: 'base' }, legs: 'p1' },
    3: { run: { mon: E(35, 6), tue: I(4, 1000, '조깅 3분'), wed: E(25), thu: T([12, 12], '2분'), fri: E(25, 6), sat: L(60) },
      push: { s1: S(5, 30, '2:00'), s2: 2.2, gtg: [4, 0.40] }, sit: { s1: S(5, 30, '2:00'), emom: [12, 0.30], s3: 'base' }, legs: 'p1' },
    4: { run: { mon: E(30), tue: I(3, 1000, '조깅 3분 · 가볍게'), wed: E(20), thu: E(25, 4), fri: OFF, sat: TT },
      push: { s1: TEST, s2: 1.2, gtg: [3, 0.40] }, sit: { s1: TEST, emom: [6, 0.30], s3: 'light' }, legs: 'deload' },
    5: { run: { mon: E(35, 6), tue: I(5, 1000, '조깅 2분 30초'), wed: E(25), thu: T([20]), fri: L(40), sat: OT('1차 OT · 쉬기') },
      push: { s1: S(6, 30, '1:30'), s2: 2.4, gtg: [5, 0.45] }, sit: { s1: S(6, 30, '1:30'), emom: [12, 0.35], s3: 'plus' }, legs: 'p2' },
    6: { run: { mon: E(35, 6), tue: I(6, 1000, '조깅 2분 30초'), wed: E(25), thu: T([10, 10, 10], '1분 30초'), fri: E(25, 6), sat: L(60) },
      push: { s1: S(4, 60, '2:00'), s2: 2.6, gtg: [5, 0.45] }, sit: { s1: S(4, 60, '2:00'), emom: [14, 0.35], s3: 'plus' }, legs: 'p2' },
    7: { run: { mon: E(35, 6), tue: I(4, 1200, '조깅 3분 30초'), wed: E(25), thu: T([25]), fri: E(25, 6), sat: L(60) },
      push: { s1: S(4, 60, '1:30'), s2: 2.8, gtg: [5, 0.45] }, sit: { s1: S(4, 60, '1:30'), emom: [14, 0.35], s3: 'plus' }, legs: 'p2' },
    8: { run: { mon: E(30), tue: I(4, 800, '조깅 400m · 가볍게', 'I', true), wed: E(20), thu: TT, fri: OFF, sat: OT('2차 OT · 20분 조깅만') },
      push: { s1: TEST, s2: 1.5, gtg: [3, 0.40] }, sit: { s1: TEST, emom: [8, 0.30], emomDay: 'fri', s3: 'light' }, legs: 'deload' },
    9: { run: { mon: E(35, 6), tue: I(5, 1000, '조깅 2분', 'g'), wed: E(25), thu: T([15, 15], '2분'), fri: E(25, 6), sat: L(60) },
      push: { s1: SIM, s2: 2.6, gtg: [4, 0.45] }, sit: { s1: SIM, emom: [12, 0.30], s3: 'base' }, legs: 'half' },
    10: { run: { mon: E(30), tue: I(3, 1000, '조깅 2분', 'g', true), wed: E(20), thu: T([12]), fri: OFF, sat: REH },
      push: { s1: S(3, 30, '2:00'), s2: 1.5, gtg: [3, 0.40] }, sit: { s1: S(3, 30, '2:00'), emom: [8, 0.30], s3: 'light' }, legs: 'light' },
    11: { run: { mon: E(20, 4), tue: I(2, 1000, '조깅 2분', 'g', true), wed: E(15), thu: E(15, 4), fri: OFF, sat: E(12, 3) },
      push: { s1: S(2, 30, '2:00'), s2: null, gtg: [2, 0.40] }, sit: { s1: S(2, 30, '2:00'), emom: null, s3: null }, legs: null }
  };

  const LEGS = {
    p1: {
      a: '배낭/고블릿 스쿼트 3×10 (하강 3초) · 불가리안 스플릿 스쿼트 3×8/다리 · 싱글레그 힙브릿지 3×10 · 싱글레그 카프레이즈 3×15 · 플랭크·데드버그',
      b: '포고점프 3×15 · 스쿼트점프 3×6 · 스키핑/바운딩 3×20m'
    },
    p2: {
      a: '배낭 스쿼트 4×6 (증량) · 스플릿 스쿼트 4×6 · 싱글레그 RDL 3×8 · 카프레이즈 4×8 (하중, 느리게) · 사이드플랭크 3×30초',
      b: '포고 3×20 · 계단/박스 점프 4×5 · 바운딩 4×25m · 한 발 점프 3×5/다리'
    },
    deload: { a: '지난주 하체 운동을 세트 수 절반으로', b: '포고점프 2×15만' },
    half: { a: '강화 단계 하체 운동을 세트 수 절반으로 · 중량은 유지', b: '강화 단계 플라이오를 절반으로' },
    light: { a: '가볍게 2세트씩', b: '포고점프 2×15' }
  };

  const SIT_CORE = {
    base: '레그레이즈 3×12 · 플랭크 3×45~60초 · 백익스텐션 3×12 (허리 균형) · 30초 페이스 세트 2회',
    plus: '레그레이즈 3×12 · 플랭크 3×60~75초 · 백익스텐션 3×12 (허리 균형) · 30초 페이스 세트 2회',
    light: '플랭크 2×45초 · 백익스텐션 2×12 (가볍게)'
  };

  function phaseOf(week) {
    if (week <= 0) return { name: '기준 측정', desc: '3종목 기준 기록부터 잽니다' };
    if (week <= 3) return { name: '기초', desc: '유산소 기반 · 자세와 목표 페이스 익히기' };
    if (week === 4) return { name: '디로드 + 측정①', desc: '가볍게 회복하고 3종목 측정 → 페이스·세트 자동 갱신' };
    if (week <= 7) return { name: '강화', desc: '인터벌·역치 볼륨 상승 · 하체 부하와 플라이오' };
    if (week === 8) return { name: '디로드 + 측정②', desc: '회복 후 재측정 → 페이스 갱신' };
    if (week === 9) return { name: '특이성', desc: '목표 페이스 훈련 · 시험 형식 연습' };
    if (week === 10) return { name: '테이퍼', desc: '훈련량 약 −35% · 강도 유지 · 토요일 전체 리허설' };
    if (week === 11) return { name: '테이퍼', desc: '훈련량 약 −55% · 강도 유지 · 가입교 준비' };
    return { name: '플랜 완료', desc: '가입교 이후에는 기초훈련 일정에 맞춰 컨디션 유지' };
  }

  /* ---------- 4. 주차 · 기준값 · 목표 계산 ---------- */
  function weekOf(dateStr, s = getSettings()) {
    const days = getDaysDiff(dateStr, s.planStart);   // dateStr − planStart
    if (days < 0) return 0;
    return Math.min(TOTAL_WEEKS + 1, Math.floor(days / 7) + 1);
  }
  function weekStart(week, s) { return F.addDays(s.planStart, (week - 1) * 7); }

  const testRecords = (mode) => F.recordsOf(mode).filter((r) => F.sourceOf(r) !== 'set');

  /* 기준값: W1 끝까지의 마지막 측정 → 임시 기준값 → 플랜 시작 후 첫 측정 */
  function baseline(mode, s = getSettings()) {
    const recs = testRecords(mode);
    const early = recs.filter((r) => r.date <= F.addDays(s.planStart, 6));
    if (early.length) {
      const r = early[early.length - 1];
      return { value: r.numericVal, date: r.date, provisional: false };
    }
    const p = s.provisional[mode];
    if (p != null && p > 0) return { value: p, date: null, provisional: true };
    if (recs.length) return { value: recs[0].numericVal, date: recs[0].date, provisional: false };
    return null;
  }

  /* 참조값: 오늘까지의 최신 측정 (처방 숫자의 근거) */
  function reference(mode, s = getSettings()) {
    const recs = testRecords(mode).filter((r) => r.date <= F.today());
    if (recs.length) {
      const r = recs[recs.length - 1];
      return { value: r.numericVal, date: r.date, provisional: false };
    }
    return baseline(mode, s);
  }

  function verdictOf(mode, need) {
    if (need <= 0) return { label: '이미 달성', tone: 'good' };
    const [sure, stretch] = mode === 'run' ? [RUN_CAP, 0.10] : [0.20, REPS_CAP];
    if (need <= sure) return { label: mode === 'run' ? '근거 범위 안' : '확실권', tone: 'good' };
    if (need <= stretch) return { label: '도전', tone: 'warn' };
    return { label: '이번 11주엔 어려움', tone: 'bad' };
  }

  /* 목표: 고른 등급의 기준값. 근거 상한을 넘으면 훈련용 목표(train)는 상한으로 */
  function goal(mode, s = getSettings()) {
    const grade = s.targets[mode];
    const target = F.thresholds(mode)[grade];
    const base = baseline(mode, s);
    if (!base) return { grade, target, train: target, need: null, verdict: null, capped: false, base: null };

    let need;
    let limit;
    if (mode === 'run') {
      need = (base.value - target) / base.value;
      limit = Math.round(base.value * (1 - RUN_CAP));
    } else {
      need = (target - base.value) / base.value;
      limit = Math.round(base.value * (1 + REPS_CAP));
    }
    const capped = F.isBetter(mode, target, limit);
    return { grade, target, train: capped ? limit : target, need, verdict: verdictOf(mode, need), capped, base };
  }

  /* 페이스: P3 = 최신 3km ÷ 3. g = 목표 페이스 (W9부터, W8 측정이 −5%에 못 미치면 현재 페이스) */
  function paces(s = getSettings(), week = weekOf(F.today(), s)) {
    const ref = reference('run', s);
    if (!ref) return null;
    const base = baseline('run', s);
    const P = ref.value / 3;
    let g = Math.min(goal('run', s).train / 3, P);
    if (week >= 9 && base && ref.value > base.value * 0.95) g = P;
    return {
      ref, P, g,
      E: [P * PACE_RATIO.E[0], P * PACE_RATIO.E[1]],
      T: P * PACE_RATIO.T,
      I: P * PACE_RATIO.I,
      R: P * PACE_RATIO.R
    };
  }

  const split = (pacePerKm, meters) => F.fmtTime((pacePerKm * meters) / 1000);

  /* ---------- 5. 중간 점검 (W4 · W8) ---------- */
  const CP_STATE = {
    hit: { label: '달성', tone: 'good', action: '계획대로 진행 · 페이스와 세트 수가 새 기록으로 갱신됐어요' },
    near: { label: '조금 미달', tone: 'warn', action: '직전 주 내용을 1주 더 반복하고 재측정 · 수면·식사 점검' },
    miss: { label: '미달', tone: 'bad', action: '볼륨 20% 줄이고 쉬는 날 하루 추가 · 통증·피로 점검' },
    flat: { label: '변화 없음', tone: 'bad', action: '볼륨 20% 줄이기 · 쉬운 날이 정말 쉬운지, 인터벌이 너무 빠르지 않은지 점검' },
    pending: { label: '예정', tone: 'muted', action: '' },
    skipped: { label: '측정 없음', tone: 'muted', action: '이 주에 측정 기록이 없어요. 가능한 빨리 측정하세요' }
  };

  function checkpoint(cp, mode, s = getSettings()) {
    const base = baseline(mode, s);
    if (!base) return null;
    const G = goal(mode, s).train;
    // 중간 목표는 최종 목표보다 어렵게 잡지 않고, 이미 목표를 넘었으면 기준값 유지가 목표
    const target = mode === 'run'
      ? Math.min(base.value, Math.max(Math.round(base.value * (1 - cp.runCut)), G))
      : (G > base.value ? Math.round(base.value + (G - base.value) * cp.repShare) : base.value);
    const start = weekStart(cp.week, s);
    const end = F.addDays(start, 6);
    const inWindow = testRecords(mode).filter((r) => r.date >= start && r.date <= end);
    if (!inWindow.length) return { target, state: F.today() > end ? 'skipped' : 'pending', start, end };

    const result = F.bestValue(mode, inWindow.map((r) => r.numericVal));
    const gained = mode === 'run' ? base.value - result : result - base.value;
    const required = mode === 'run' ? base.value - target : target - base.value;
    let state = 'miss';
    if (result === target || F.isBetter(mode, result, target)) state = 'hit';
    else if (gained <= 0) state = 'flat';
    else if (gained >= required / 2) state = 'near';
    return { target, result, state, start, end };
  }

  // W4 팔굽혀펴기가 중간 목표에 못 미치면 W5~W9 금요일에 근력 세션(S3)을 추가
  function needsPushStrength(s) {
    const cp = checkpoint(CHECKPOINTS[0], 'pushup', s);
    return !!cp && ['near', 'miss', 'flat'].includes(cp.state);
  }

  /* ---------- 6. 하루 처방 ---------- */
  function paceOrHint(pc, fn) { return pc ? fn(pc) : '3km 기준값을 입력하면 페이스가 계산됩니다'; }

  function runItem(sess, pc) {
    switch (sess.kind) {
      case 'E':
        return {
          title: `이지런 ${sess.min}분`,
          detail: [
            paceOrHint(pc, (p) => `${F.fmtTime(p.E[0])}~${F.fmtTime(p.E[1])}/km · 대화 가능한 속도`),
            sess.strides ? `끝나고 스트라이드 20초 × ${sess.strides}` : null
          ]
        };
      case 'I': {
        const usesGoal = sess.pace === 'g';
        return {
          title: `인터벌 ${sess.dist}m × ${sess.reps}`,
          detail: [
            paceOrHint(pc, (p) => {
              const pace = usesGoal ? p.g : p.I;
              return `${sess.dist}m당 ${split(pace, sess.dist)} (${F.fmtPace(pace)})${usesGoal ? ' · 목표 페이스' : ''}`;
            }),
            `반복 사이 ${sess.rest}`,
            sess.extra ? paceOrHint(pc, (p) => `이어서 200m × 4 빠르게 (200m당 ${split(p.R, 200)})`) : null,
            '워밍업 10분 + 드릴 · 쿨다운 5~10분 · 마지막 반복까지 같은 페이스'
          ]
        };
      }
      case 'T':
        return {
          title: sess.blocks.length === 1 ? `역치 템포 ${sess.blocks[0]}분` : `역치 ${sess.blocks.length} × ${sess.blocks[0]}분`,
          detail: [
            paceOrHint(pc, (p) => `${F.fmtPace(p.T)} · "편하게 힘든" 속도`),
            sess.rest ? `블록 사이 휴식 ${sess.rest}` : null,
            '워밍업 10분 · 쿨다운 5~10분'
          ]
        };
      case 'L':
        return {
          title: `장거리 이지 ${sess.min}분`,
          detail: [paceOrHint(pc, (p) => `${F.fmtTime(p.E[0])}~${F.fmtTime(p.E[1])}/km · 숨이 가쁘면 늦춘다`)]
        };
      case 'TT':
        return {
          title: '3km 측정',
          test: true,
          detail: [
            '워밍업 15분 후 전력 · 첫 400m는 과속 금지',
            pc ? `지금 기준 ${F.fmtTime(pc.ref.value)} · 1km 구간을 고르게` : null,
            '측정 후 기록을 저장하면 페이스가 자동으로 갱신됩니다'
          ]
        };
      case 'REH':
        return {
          title: '3종목 전체 리허설',
          test: true,
          detail: ['실제 순서대로: 팔굽혀펴기 2분 → 윗몸 2분 → 3km', '휴식 시간도 실제와 같게 · 결과를 측정 기록으로 저장']
        };
      case 'OT':
        return { title: sess.note, detail: ['공식 일정 우선 · 근력 훈련은 쉬고, 피곤하면 완전 휴식'] };
      default:
        return { title: '달리기 쉬는 날', detail: ['가벼운 스트레칭만'] };
    }
  }

  function paceSetItem(mode, s1, G) {
    const name = mode === 'pushup' ? '팔굽혀펴기' : '윗몸';
    if (s1.kind === 'TEST') {
      return { title: `${name} 2분 최대 측정`, test: true, detail: ['공식 자세 기준 · 컨디션 좋은 시간에', '결과를 측정 기록으로 저장하면 세트 수가 자동 갱신됩니다'] };
    }
    if (!G) return { title: `${name} 페이스 세트`, detail: ['2분 기준값을 입력하면 세트 개수가 계산됩니다'] };
    if (s1.kind === 'SIM') {
      return {
        title: `${name} 2분 시뮬레이션 + 60초 × 2`,
        detail: [`2분 동안 목표 ${G}회 속도 (30초마다 ${Math.round(G / 4)}회)`, `5분 쉬고 60초 세트 2회 (${Math.round(G / 2)}회씩)`]
      };
    }
    const reps = Math.round(s1.sec === 30 ? G / 4 : G / 2);
    return {
      title: `${name} 페이스 세트 ${s1.sec}초 × ${s1.sets}`,
      detail: [`${s1.sec}초 안에 ${reps}회 (목표 ${G}회 속도)`, `세트 사이 휴식 ${s1.rest}`]
    };
  }

  function dayItems(dateStr, s = getSettings()) {
    const week = weekOf(dateStr, s);
    const dow = DAY_KEYS[F.parseDate(dateStr).getDay()];
    if (week === 0) return measurementItems(s);
    if (week > TOTAL_WEEKS) return [{ area: 'info', title: '11주 플랜 완료', detail: [phaseOf(week).desc] }];
    if (dow === 'sun') return [{ area: 'rest', title: '완전 휴식', detail: ['허리·햄스트링·고관절 모빌리티 15분'] }];

    const w = PLAN[week];
    const pc = paces(s, week);
    const run = w.run[dow];
    const items = [{ area: 'run', mode: 'run', ...runItem(run, pc) }];

    // 3km 측정·리허설 날은 다른 근력 훈련을 쉰다
    if (run.kind === 'TT' || run.kind === 'REH') {
      items.push({ area: 'info', title: '오늘은 측정에 집중', detail: ['다른 근력 훈련은 쉰다'] });
      return items;
    }
    // OT(공식 일정) 날은 가벼운 조깅 외에 쉰다
    if (run.kind === 'OT') return items;

    const refPush = reference('pushup', s);
    const refSit = reference('situp', s);
    const M = { pushup: refPush && refPush.value, situp: refSit && refSit.value };
    const G = { pushup: refPush ? goal('pushup', s).train : null, situp: refSit ? goal('situp', s).train : null };
    const per = (mode, frac) => (M[mode] ? `${Math.round(M[mode] * frac)}개` : '(기준값 필요)');

    if (dow === 'mon') {
      items.push({ area: 'pushup', mode: 'pushup', ...paceSetItem('pushup', w.push.s1, G.pushup) });
      items.push({ area: 'situp', mode: 'situp', ...paceSetItem('situp', w.sit.s1, G.situp) });
    }
    if ((dow === 'tue' || dow === 'sat') && w.push.gtg) {
      const [times, frac] = w.push.gtg;
      items.push({ area: 'pushup', mode: 'pushup', title: `팔굽혀펴기 GTG ${times}회`, detail: [`한 번에 ${per('pushup', frac)} · 간격 90분 이상 · 실패 지점 금지`] });
    }
    if (dow === 'wed') {
      if (w.push.s2) {
        const total = M.pushup ? `${Math.round(M.pushup * w.push.s2)}회` : '(기준값 필요)';
        items.push({ area: 'pushup', mode: 'pushup', title: `팔굽혀펴기 볼륨 총 ${total}`, detail: [`세트당 ${per('pushup', 0.3)}~${per('pushup', 0.5)} · 휴식 60초 · 실패 직전에서 멈춘다`] });
      }
      if (w.legs) items.push({ area: 'legs', title: '하체 근력 A + 코어', detail: [LEGS[w.legs].a] });
    }
    if (w.sit.emom && dow === (w.sit.emomDay || 'thu')) {
      const [min, frac] = w.sit.emom;
      items.push({ area: 'situp', mode: 'situp', title: `윗몸 EMOM ${min}분`, detail: [`매분 정각에 ${per('situp', frac)} → 남은 시간은 휴식`] });
    }
    if (dow === 'fri') {
      if (w.legs) items.push({ area: 'legs', title: '하체 B 플라이오', detail: [LEGS[w.legs].b, '근육통이 심하면 이것부터 줄인다'] });
      if (week >= 5 && week <= 9 && needsPushStrength(s)) {
        items.push({ area: 'pushup', mode: 'pushup', title: '팔굽혀펴기 근력 (추가)', detail: [`배낭 푸시업 5×5~6 · 템포 푸시업 3×${per('pushup', 0.3)}`, 'W4 중간 목표 미달로 추가된 세션'] });
      }
    }
    if (dow === 'sat' && w.sit.s3) {
      items.push({ area: 'situp', mode: 'situp', title: '윗몸 코어 보강', detail: [SIT_CORE[w.sit.s3]] });
    }
    return items;
  }

  /* 플랜 시작 전(W0): 기준 측정 */
  function measurementItems(s) {
    const done = (mode) => testRecords(mode).some((r) => r.date >= F.addDays(s.planStart, -14));
    return [
      { area: 'pushup', mode: 'pushup', test: true, done: done('pushup'), title: '팔굽혀펴기 2분 최대 측정', detail: ['공식 자세 기준 · 끝나면 10분 휴식'] },
      { area: 'situp', mode: 'situp', test: true, done: done('situp'), title: '윗몸일으키기 2분 최대 측정', detail: ['팔굽혀펴기 10분 뒤 · 같은 날 측정'] },
      { area: 'run', mode: 'run', test: true, done: done('run'), title: '3km 전력 측정 (다른 날)', detail: ['워밍업 15분 · 첫 1km 과속 금지 · 고른 페이스로'] }
    ];
  }

  /* ---------- 7. 화면 조각 ---------- */
  const AREA = {
    run: { label: '달리기', cls: 'bg-[#edf5ff] text-[#0043ce]' },
    pushup: { label: '팔굽혀펴기', cls: 'bg-[#defbe6] text-[#0e6027]' },
    situp: { label: '윗몸', cls: 'bg-[#fff8e1] text-[#8e6a00]' },
    legs: { label: '보강', cls: 'bg-[#f4f4f4] text-[#525252]' },
    rest: { label: '휴식', cls: 'bg-[#f4f4f4] text-[#525252]' },
    info: { label: '안내', cls: 'bg-[#f4f4f4] text-[#525252]' }
  };
  const TONE = {
    good: 'bg-[#defbe6] text-[#0e6027]',
    warn: 'bg-[#fff8e1] text-[#8e6a00]',
    bad: 'bg-[#fff1f1] text-[#a2191f]',
    muted: 'bg-[#f4f4f4] text-[#525252]'
  };

  function card(title, right, body) {
    return `
      <div class="bg-white carbon-border">
        <div class="p-3.5 flex items-center justify-between gap-2 border-b border-[#e0e0e0]">
          <span class="text-xs font-semibold text-[#161616]">${title}</span>
          ${right || ''}
        </div>
        ${body}
      </div>`;
  }

  function headerHtml(s, week) {
    const phase = phaseOf(week);
    const dday = getDaysDiff(s.enrollDate);
    const ddayText = dday > 0 ? `가입교 D-${dday}` : (dday === 0 ? '가입교 D-DAY' : '가입교 이후');
    const range = week >= 1 && week <= TOTAL_WEEKS
      ? `${F.shortDate(weekStart(week, s))}(월) ~ ${F.shortDate(F.addDays(weekStart(week, s), 6))}(일)`
      : (week === 0 ? `W1은 ${F.shortDate(s.planStart)}(월) 시작` : `${F.shortDate(s.planStart)} 시작 · 11주 완료`);
    const bars = Array.from({ length: TOTAL_WEEKS }, (_, i) => {
      const n = i + 1;
      const color = n < week ? '#0f62fe' : (n === week ? '#f1c21b' : '#393939');
      const mark = n === 4 || n === 8 ? 'outline outline-1 outline-[#8c8c8c]' : '';
      return `<div class="flex-1 h-1.5 ${mark}" style="background:${color}" title="W${n}"></div>`;
    }).join('');
    return `
      <div class="bg-[#161616] text-white p-4 carbon-border space-y-2">
        <div class="flex justify-between items-center text-[10px] font-mono text-[#8c8c8c]">
          <span>KAAY COACH · 11주 플랜</span><span class="text-[#f1c21b]">${ddayText}</span>
        </div>
        <div class="text-xl font-light">W${week > TOTAL_WEEKS ? '·' : week} · ${phase.name}</div>
        <div class="text-[11px] text-[#c6c6c6]">${range} · ${phase.desc}</div>
        <div class="flex gap-0.5 pt-1" aria-label="11주 진행 상황">${bars}</div>
        <div class="flex justify-between text-[9px] font-mono text-[#8c8c8c]">
          <span>W1 ${F.shortDate(s.planStart)}</span><span>W4·W8 측정</span><span>W11 ${F.shortDate(F.addDays(s.planStart, 7 * TOTAL_WEEKS - 1))}</span>
        </div>
      </div>`;
  }

  function itemHtml(item, todayStr) {
    const area = AREA[item.area] || AREA.info;
    const loggedToday = item.mode && (
      F.findLog(item.mode, todayStr) || testRecords(item.mode).some((r) => r.date === todayStr)
    );
    const done = item.done || loggedToday;
    const detail = (item.detail || []).filter(Boolean);
    const action = item.mode
      ? `<button type="button" data-coach-act="record" data-mode="${item.mode}" data-target="${item.test ? 'form' : 'workout'}" class="text-[11px] text-[#0f62fe] font-medium">${item.test ? '측정 기록 입력 →' : '훈련 기록하기 →'}</button>`
      : '';
    return `
      <div class="p-3.5 space-y-1.5">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0 flex-wrap">
            <span class="text-[10px] px-1.5 py-0.5 font-semibold ${area.cls}">${area.label}</span>
            <span class="text-sm font-semibold text-[#161616]">${esc(item.title)}</span>
          </div>
          ${done ? '<span class="text-[10px] text-[#24a148] font-semibold whitespace-nowrap">기록 ✓</span>' : ''}
        </div>
        ${detail.length ? `<ul class="text-[11px] text-[#525252] space-y-0.5 leading-relaxed">${detail.map((d) => `<li>· ${esc(d)}</li>`).join('')}</ul>` : ''}
        ${action}
      </div>`;
  }

  function todayHtml(s, todayStr) {
    const items = dayItems(todayStr, s);
    return card(
      '오늘의 처방',
      `<span class="text-[10px] font-mono text-[#525252]">${todayStr} (${F.weekdayKo(todayStr)})</span>`,
      `<div class="divide-y divide-[#e0e0e0]">${items.map((it) => itemHtml(it, todayStr)).join('')}</div>`
    );
  }

  let settingsOpen = false;

  function goalBlockHtml(mode, s) {
    const g = goal(mode, s);
    const ref = reference(mode, s);
    const options = ['특급', '1급', '2급', '3급']
      .map((gr) => `<option value="${gr}" ${gr === g.grade ? 'selected' : ''}>${gr}</option>`).join('');
    const select = `
      <label class="flex items-center gap-1 text-[11px] text-[#525252]">목표
        <select data-coach-target="${mode}" class="carbon-input py-1 px-1.5 text-xs font-semibold text-[#161616]">${options}</select>
      </label>`;

    if (!g.base) {
      return `
        <div class="p-3.5 space-y-1.5">
          <div class="flex justify-between items-center"><span class="text-xs font-semibold text-[#161616]">${MODE_LABEL[mode]}</span>${select}</div>
          <p class="text-[11px] text-[#8e6a00]">기준 기록이 없습니다. 측정 기록을 저장하거나 ‘기준값·일정 설정’에서 임시값을 입력하세요.</p>
        </div>`;
    }

    const fmt = (v) => F.fmtShortValue(mode, v);
    const baseNote = g.base.provisional
      ? '<span class="text-[10px] px-1 bg-[#fff8e1] text-[#8e6a00]">임시값</span>'
      : `<span class="text-[10px] text-[#8c8c8c]">(${F.shortDate(g.base.date)} 측정)</span>`;
    const needText = g.need <= 0 ? '달성' : `${mode === 'run' ? '−' : '+'}${(g.need * 100).toFixed(1)}%`;

    // 지금 기록에서 가입교까지 주당 얼마씩
    const weeksLeft = Math.max(1, getDaysDiff(s.enrollDate) / 7);
    const remain = mode === 'run' ? ref.value - g.target : g.target - ref.value;
    const perWeek = remain <= 0
      ? '목표 등급은 이미 달성했어요'
      : (mode === 'run'
        ? `가입교까지 주당 약 ${F.fmtGapSec(remain / weeksLeft)}씩 단축`
        : `가입교까지 주당 약 ${(remain / weeksLeft).toFixed(1)}회씩 증가`);

    return `
      <div class="p-3.5 space-y-1.5">
        <div class="flex justify-between items-center"><span class="text-xs font-semibold text-[#161616]">${MODE_LABEL[mode]}</span>${select}</div>
        <div class="text-[11px] text-[#525252] flex items-center gap-1 flex-wrap">
          기준 <strong class="font-mono text-[#161616]">${fmt(g.base.value)}</strong> ${baseNote}
          → 현재 <strong class="font-mono text-[#161616]">${fmt(ref.value)}</strong>
          → 목표 <strong class="font-mono text-[#161616]">${fmt(g.target)}</strong>
        </div>
        <div class="flex items-center justify-between text-[11px] text-[#525252]">
          <span>기준 대비 필요 변화 <strong class="font-mono text-[#161616]">${needText}</strong></span>
          <span class="px-1.5 py-0.5 text-[10px] font-semibold ${TONE[g.verdict.tone]}">${g.verdict.label}</span>
        </div>
        <div class="text-[10px] text-[#525252]">${perWeek}</div>
        ${g.capped ? `<div class="text-[10px] text-[#8e6a00]">근거 상한(${mode === 'run' ? '11주 −7%' : '11주 +30%'})을 넘어서 훈련 목표는 ${fmt(g.train)}로 잡았어요</div>` : ''}
      </div>`;
  }

  function settingsFormHtml(s) {
    const run = s.provisional.run;
    const num = (v) => (v == null ? '' : v);
    return `
      <div class="p-3.5 border-t border-[#e0e0e0] bg-[#f4f4f4] space-y-2.5">
        <div class="text-[11px] font-semibold text-[#161616]">측정 전 임시 기준값</div>
        <div class="grid grid-cols-3 gap-2 text-[11px] text-[#525252]">
          <div>
            <span class="block mb-1">3km</span>
            <div class="flex items-center gap-0.5">
              <input type="number" id="coach-prov-run-min" min="5" max="30" value="${run ? Math.floor(run / 60) : ''}" placeholder="15" aria-label="3km 분" class="carbon-input w-full p-1.5 text-xs text-center font-mono">:
              <input type="number" id="coach-prov-run-sec" min="0" max="59" value="${run ? run % 60 : ''}" placeholder="00" aria-label="3km 초" class="carbon-input w-full p-1.5 text-xs text-center font-mono">
            </div>
          </div>
          <label><span class="block mb-1">팔굽혀펴기 2분</span>
            <input type="number" id="coach-prov-pushup" min="0" max="200" value="${num(s.provisional.pushup)}" placeholder="회" class="carbon-input w-full p-1.5 text-xs text-center font-mono"></label>
          <label><span class="block mb-1">윗몸 2분</span>
            <input type="number" id="coach-prov-situp" min="0" max="200" value="${num(s.provisional.situp)}" placeholder="회" class="carbon-input w-full p-1.5 text-xs text-center font-mono"></label>
        </div>
        <div class="text-[11px] font-semibold text-[#161616] pt-1">일정</div>
        <div class="grid grid-cols-2 gap-2 text-[11px] text-[#525252]">
          <label><span class="block mb-1">플랜 시작 (W1 월요일)</span>
            <input type="date" id="coach-plan-start" value="${s.planStart}" class="carbon-input w-full p-1.5 text-xs font-mono"></label>
          <label><span class="block mb-1">가입교</span>
            <input type="date" id="coach-enroll" value="${s.enrollDate}" class="carbon-input w-full p-1.5 text-xs font-mono"></label>
        </div>
        <button type="button" data-coach-act="save-settings" class="carbon-blue-btn w-full py-2 text-xs font-medium">설정 저장</button>
        <p class="text-[10px] text-[#8c8c8c]">측정 기록이 저장되면 임시값 대신 측정값을 씁니다. 시작일은 월요일로 맞춰집니다.</p>
      </div>`;
  }

  function goalsHtml(s) {
    const toggle = `<button type="button" data-coach-act="toggle-settings" class="text-[11px] text-[#0f62fe] underline" aria-expanded="${settingsOpen}">기준값·일정 설정</button>`;
    return card(
      '기준 · 목표',
      toggle,
      `<div class="divide-y divide-[#e0e0e0]">${MODES.map((m) => goalBlockHtml(m, s)).join('')}</div>${settingsOpen ? settingsFormHtml(s) : ''}`
    );
  }

  function paceHtml(s, week) {
    const pc = paces(s, week);
    if (!pc) {
      return card('내 페이스표', '', '<p class="p-3.5 text-[11px] text-[#8e6a00]">3km 기록이나 임시 기준값을 넣으면 페이스표가 만들어집니다.</p>');
    }
    const source = pc.ref.provisional ? '임시값' : `${F.shortDate(pc.ref.date)} 측정`;
    const rows = [
      ['이지 E', `${F.fmtTime(pc.E[0])}~${F.fmtTime(pc.E[1])}`, '쉬운 날 · 대화 가능'],
      ['역치 T', F.fmtTime(pc.T), `1km ${F.fmtTime(pc.T)} · 편하게 힘든`],
      ['인터벌 I', F.fmtTime(pc.I), `800m ${split(pc.I, 800)} · 1000m ${split(pc.I, 1000)} · 1200m ${split(pc.I, 1200)}`],
      ['반복 R', F.fmtTime(pc.R), `200m ${split(pc.R, 200)} · 400m ${split(pc.R, 400)}`],
      ['목표 g', F.fmtTime(pc.g), `3km ${F.fmtTime(pc.g * 3)} · 400m ${split(pc.g, 400)}`]
    ];
    const body = `
      <table class="w-full text-xs">
        <tbody class="divide-y divide-[#e0e0e0]">${rows.map(([name, pace, note]) => `
          <tr>
            <td class="px-3.5 py-2 text-[#161616] font-medium whitespace-nowrap">${name}</td>
            <td class="px-2 py-2 font-mono font-semibold whitespace-nowrap">${pace}<span class="text-[10px] text-[#8c8c8c] font-normal">/km</span></td>
            <td class="px-3.5 py-2 text-[10px] text-[#525252]">${note}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p class="px-3.5 py-2 text-[10px] text-[#8c8c8c] border-t border-[#e0e0e0]">W4·W8 측정 기록을 저장하면 자동으로 다시 계산됩니다 · 비율은 Daniels 표 근사값</p>`;
    return card('내 페이스표', `<span class="text-[10px] font-mono text-[#525252]">3km ${F.fmtTime(pc.ref.value)} 기준 (${source})</span>`, body);
  }

  function weekHtml(s, week, todayStr) {
    const shown = week === 0 ? 1 : week;
    if (shown > TOTAL_WEEKS) return '';
    const start = weekStart(shown, s);
    const days = Array.from({ length: 7 }, (_, i) => F.addDays(start, i));
    const rows = days.map((d) => {
      const titles = dayItems(d, s).map((it) => it.title).join(' · ');
      const isToday = d === todayStr;
      return `
        <div class="px-3.5 py-2 flex gap-3 text-[11px] ${isToday ? 'bg-[#edf5ff]' : ''}">
          <span class="w-12 flex-shrink-0 font-mono ${isToday ? 'text-[#0f62fe] font-semibold' : 'text-[#525252]'}">${F.weekdayKo(d)} ${F.shortDate(d)}</span>
          <span class="text-[#161616] leading-relaxed">${esc(titles)}</span>
        </div>`;
    }).join('');
    return `
      <details class="bg-white carbon-border" open>
        <summary class="p-3.5 text-xs font-semibold text-[#161616] cursor-pointer border-b border-[#e0e0e0]">
          ${week === 0 ? '다음 주(W1) 미리보기' : `이번 주 전체 (W${shown})`}
        </summary>
        <div class="divide-y divide-[#e0e0e0]">${rows}</div>
      </details>`;
  }

  function checkpointHtml(s) {
    const blocks = CHECKPOINTS.map((cp) => {
      const rows = MODES.map((mode) => {
        const c = checkpoint(cp, mode, s);
        if (!c) return `<div class="text-[11px] text-[#8c8c8c]">${MODE_LABEL[mode]} · 기준값이 없어 계산할 수 없어요</div>`;
        const st = CP_STATE[c.state];
        const result = c.result != null ? ` · 결과 <strong class="font-mono text-[#161616]">${F.fmtShortValue(mode, c.result)}</strong>` : '';
        return `
          <div class="space-y-0.5">
            <div class="flex items-center justify-between gap-2 text-[11px]">
              <span class="text-[#525252]">${MODE_LABEL[mode]} · 목표 <strong class="font-mono text-[#161616]">${F.fmtShortValue(mode, c.target)}</strong>${result}</span>
              <span class="px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ${TONE[st.tone]}">${st.label}</span>
            </div>
            ${st.action ? `<div class="text-[10px] text-[#525252]">→ ${st.action}</div>` : ''}
          </div>`;
      }).join('');
      return `
        <div class="p-3.5 space-y-2">
          <div class="text-[11px] font-semibold text-[#161616]">W${cp.week} 측정 (${F.shortDate(weekStart(cp.week, s))} 주)</div>
          ${rows}
        </div>`;
    }).join('');

    // 두 번 연속 미달이면 목표 하향 권장
    const twiceMissed = MODES.filter((mode) => CHECKPOINTS.every((cp) => {
      const c = checkpoint(cp, mode, s);
      return c && ['miss', 'flat'].includes(c.state);
    }));
    const warn = twiceMissed.length
      ? `<p class="px-3.5 py-2 text-[11px] text-[#a2191f] bg-[#fff1f1] border-t border-[#e0e0e0]">${twiceMissed.map((m) => MODE_LABEL[m]).join(', ')}: 두 번 연속 미달 → 목표 등급을 한 단계 낮추는 걸 권장해요</p>`
      : '';
    return card('중간 점검', '<span class="text-[10px] text-[#525252]">W4 · W8 자동 판정</span>',
      `<div class="divide-y divide-[#e0e0e0]">${blocks}</div>${warn}`);
  }

  function roadmapHtml(s, week) {
    const rows = Array.from({ length: TOTAL_WEEKS }, (_, i) => {
      const n = i + 1;
      const w = PLAN[n];
      const key = ['tue', 'thu', 'sat']
        .map((d) => `${DAY_KO[d]} ${runItem(w.run[d], null).title}`)
        .join(' · ');
      const current = n === week;
      return `
        <div class="px-3.5 py-2 text-[11px] space-y-0.5 ${current ? 'bg-[#edf5ff]' : ''}">
          <div class="flex justify-between">
            <span class="font-semibold ${current ? 'text-[#0f62fe]' : 'text-[#161616]'}">W${n} · ${phaseOf(n).name}</span>
            <span class="font-mono text-[#8c8c8c]">${F.shortDate(weekStart(n, s))}~</span>
          </div>
          <div class="text-[#525252]">${esc(key)}</div>
        </div>`;
    }).join('');
    return `
      <details class="bg-white carbon-border">
        <summary class="p-3.5 text-xs font-semibold text-[#161616] cursor-pointer">11주 로드맵 한눈에 보기</summary>
        <div class="divide-y divide-[#e0e0e0] border-t border-[#e0e0e0]">${rows}</div>
      </details>`;
  }

  function principlesHtml() {
    const items = [
      '쉬운 날은 정말 쉽게: 달리기 시간의 75~80%는 대화 가능한 속도 (Esteve-Lanao 2007)',
      '센 달리기는 화(인터벌)·목(역치) 주 2회만 · 마지막 반복까지 같은 페이스',
      '하체 근력·플라이오는 달리기 경제성을 2~8% 개선 (Blagrove 2018)',
      '세트는 실패 직전에서 멈춘다 · 목표 2분 페이스를 몸에 익히는 게 목적',
      '마지막 2주는 훈련량 41~60% 감소, 강도는 유지 (Bosquet 2007)',
      '통증 3/10 이상·절뚝거림 → 그 종목 중단 · 이틀 지나도 남으면 전문가 확인',
      '한파·빙판: 워밍업 5분 추가, 실내(러닝머신·계단)로 대체',
      '근거 한계: 2분 팔굽혀펴기·윗몸 프로그램 비교 연구는 찾지 못함 → W4·W8 측정으로 보완'
    ];
    return `
      <details class="bg-white carbon-border">
        <summary class="p-3.5 text-xs font-semibold text-[#161616] cursor-pointer">훈련 원칙 · 안전 수칙</summary>
        <ul class="px-3.5 pb-3.5 pt-2.5 space-y-1 text-[11px] text-[#525252] leading-relaxed border-t border-[#e0e0e0]">
          ${items.map((t) => `<li>· ${t}</li>`).join('')}
        </ul>
      </details>`;
  }

  /* ---------- 8. 렌더링 · 이벤트 ---------- */
  function render() {
    const pane = $('fit-pane-coach');
    if (!pane || pane.classList.contains('hidden')) return;   // 보일 때만 그린다 (showFitnessPane 이 다시 호출)
    const s = getSettings();
    const todayStr = F.today();
    const week = weekOf(todayStr, s);
    pane.innerHTML = [
      headerHtml(s, week),
      todayHtml(s, todayStr),
      goalsHtml(s),
      paceHtml(s, week),
      weekHtml(s, week, todayStr),
      checkpointHtml(s),
      roadmapHtml(s, week),
      principlesHtml()
    ].join('');
  }

  /* 기록·분석 화면의 '이번 주 코치 처방' 카드 내용 (종목별) */
  function modeSummaryHtml(mode) {
    const s = getSettings();
    const week = weekOf(F.today(), s);
    const phase = phaseOf(week);
    let lines;
    if (week === 0) {
      lines = [`이번 주는 기준 측정 주예요. ${mode === 'run' ? '3km 전력 측정' : '2분 최대 측정'}부터 하세요.`, `W1은 ${F.shortDate(s.planStart)}(월)에 시작합니다.`];
    } else if (week > TOTAL_WEEKS) {
      lines = ['11주 플랜이 끝났어요. 기초훈련 일정에 맞춰 컨디션을 유지하세요.'];
    } else {
      const start = weekStart(week, s);
      const days = Array.from({ length: 7 }, (_, i) => F.addDays(start, i));
      lines = [];
      days.forEach((d) => {
        dayItems(d, s)
          .filter((it) => it.mode === mode && !(mode === 'run' && /^이지런/.test(it.title)))
          .forEach((it) => {
            const first = (it.detail || []).filter(Boolean)[0];
            lines.push(`${F.weekdayKo(d)} ${it.title}${first ? ` — ${first}` : ''}`);
          });
      });
      if (mode === 'run') lines.push('그 외 요일은 이지런 (대화 가능한 속도)');
    }
    return `
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium text-[#161616]">W${week > TOTAL_WEEKS ? '·' : week} · ${phase.name}</span>
        <button type="button" onclick="showFitnessPane('coach')" class="text-[11px] text-[#0f62fe] underline whitespace-nowrap">코치 플랜 전체 →</button>
      </div>
      <ul class="space-y-1 mt-1.5">${lines.map((l) => `<li>· ${esc(l)}</li>`).join('')}</ul>`;
  }

  function saveSettingsFromForm() {
    const s = getSettings();
    const intOrNull = (id) => {
      const v = parseInt(($(id) || {}).value, 10);
      return isNaN(v) || v <= 0 ? null : v;
    };
    const runMin = intOrNull('coach-prov-run-min');
    const runSec = parseInt(($('coach-prov-run-sec') || {}).value, 10) || 0;
    if (runSec < 0 || runSec > 59) { alert("3km '초'는 0~59 사이로 입력해 주세요."); return; }

    s.provisional = {
      run: runMin ? runMin * 60 + runSec : null,
      pushup: intOrNull('coach-prov-pushup'),
      situp: intOrNull('coach-prov-situp')
    };
    const start = ($('coach-plan-start') || {}).value;
    const enroll = ($('coach-enroll') || {}).value;
    if (start) s.planStart = F.mondayOf(start);
    if (enroll) s.enrollDate = enroll;
    settingsOpen = false;
    saveSettings(s);
    F.toast('코치 설정을 저장했습니다.', 'success');
  }

  function bind() {
    const pane = $('fit-pane-coach');
    if (!pane) return;
    pane.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-coach-act]');
      if (!btn) return;
      const act = btn.dataset.coachAct;
      if (act === 'record') F.focusRecordEntry(btn.dataset.mode, btn.dataset.target);
      else if (act === 'toggle-settings') { settingsOpen = !settingsOpen; render(); }
      else if (act === 'save-settings') saveSettingsFromForm();
    });
    pane.addEventListener('change', (e) => {
      const select = e.target.closest('[data-coach-target]');
      if (!select) return;
      const s = getSettings();
      s.targets[select.dataset.coachTarget] = select.value;
      saveSettings(s);
      F.toast(`${MODE_LABEL[select.dataset.coachTarget]} 목표를 ${select.value}(으)로 바꿨습니다.`, 'info');
    });
  }

  /* ---------- 9. 공개 API ---------- */
  window.KAAYCoach = {
    render,
    modeSummaryHtml,
    getSettings,
    weekOf,
    // 백업 복원 · 클라우드 동기화에서 받은 설정을 적용 (업로드는 상황에 따라)
    importSettings(data, { upload = true } = {}) {
      if (!data || typeof data !== 'object') return;
      const merged = { ...getSettings(), ...data };
      writeSettings(merged, { upload });
      window.renderFitnessUI();
    }
  };

  bind();
  render();
})();
