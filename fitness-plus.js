/* =====================================================================
   KAAY 64기 · 체력 관리실 강화 모듈 (fitness-plus.js)
   ---------------------------------------------------------------------
   index.html 인라인 스크립트(FITNESS_CRITERIA · getSavedRecords · saveRecords
   · currentFitnessMode 등) 다음에 실행되며, 아래 전역 함수를 교체한다.
     renderFitnessUI · drawActualFitnessChart · saveActualFitnessRecord
     deleteRecord · clearMyData · updateMyPageMatrix
     exportBackupData · importBackupData

   기능
     1. 등급 경계값 추출 → 다음 등급까지 격차, 3종목 종합 등급(가장 낮은 등급)
     2. 측정 기록: 메모 · 수정 · 개인 최고(PB)/등급 상승 알림 · 현재 프로필로 재판정
     3. 훈련 세트 일지: 세트 추가/빼기, 세트 최대값을 등급 기록에 자동 반영
     4. 그래프: 실제 등급 기준선 · 기간 필터 · 터치 상세 · 최근 14일 훈련량
     5. 주간 통계, 백업/복원 확장, 기록·분석 / 코치 플랜 화면 전환
   ===================================================================== */
(function () {
  'use strict';

  /* ---------- 1. 상수 ---------- */
  const MODES = ['run', 'pushup', 'situp'];          // 등급을 판정하는 3종목
  const MODE_LABEL = { run: '3km 달리기', pushup: '팔굽혀펴기', situp: '윗몸일으키기' };
  // 3km 탭에서 함께 기록하는 다른 거리 달리기: 종목 키 'run_<미터>' (예: run_5000, run_800) · 등급 판정 없음
  const CUSTOM_RUN_BADGE = 'bg-[#525252]';
  const RIEGEL_EXP = 1.06;                            // 거리 환산: T2 = T1 × (D2/D1)^1.06
  const RIEGEL_RANGE = [1500, 42195];                 // 3km 환산을 보여 줄 거리 범위 (m)
  const GRADES = ['특급', '1급', '2급', '3급', '불합격'];
  const GRADE_BADGE = {
    '특급': 'bg-[#24a148] text-white',
    '1급': 'bg-[#0f62fe] text-white',
    '2급': 'bg-[#f1c21b] text-black',
    '3급': 'bg-[#8c8c8c] text-white',
    '불합격': 'bg-[#da1e28] text-white'
  };
  // 흰 배경용 / 홈 화면 어두운 배경용 등급 색
  const GRADE_COLOR = { '특급': '#24a148', '1급': '#0f62fe', '2급': '#b28600', '3급': '#6f6f6f', '불합격': '#da1e28' };
  const GRADE_COLOR_DARK = { '특급': '#42be65', '1급': '#78a9ff', '2급': '#f1c21b', '3급': '#c6c6c6', '불합격': '#fa4d56' };
  const SOURCE_LABEL = { test: '측정', set: '세트' };
  const WORKOUT_KEY = 'KAAY_64_WORKOUT_LOGS';
  const PANE_KEY = 'KAAY_FIT_PANE';
  const STANDING_DAYS = 30;            // 종합 현황은 최근 30일 최고 기록 기준
  const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
  const FONT = "'IBM Plex Sans KR', 'IBM Plex Sans', sans-serif";

  /* ---------- 2. 공통 유틸 ---------- */
  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtTime(sec) { const s = Math.round(sec); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; }
  function fmtTimeKo(sec) { const s = Math.round(sec); return `${Math.floor(s / 60)}분 ${pad2(s % 60)}초`; }
  function fmtGapSec(sec) {
    const s = Math.round(Math.abs(sec));
    return s >= 60 ? `${Math.floor(s / 60)}분 ${pad2(s % 60)}초` : `${s}초`;
  }
  const isCustomRun = (mode) => /^run_\d+$/.test(mode);
  const isRunMode = (mode) => mode === 'run' || isCustomRun(mode);
  const metersOf = (mode) => (mode === 'run' ? 3000 : parseInt(mode.slice(4), 10));
  const kmOf = (mode) => metersOf(mode) / 1000;
  const runModeFor = (meters) => (meters === 3000 ? 'run' : `run_${meters}`);   // 3km는 등급 판정 종목으로
  function fmtDistance(meters) { return meters >= 1000 ? `${Number((meters / 1000).toFixed(2))}km` : `${meters}m`; }
  function labelOf(mode) { return MODE_LABEL[mode] || (isCustomRun(mode) ? `${fmtDistance(metersOf(mode))} 달리기` : mode); }
  // 다른 거리 기록으로 3km 기록을 추정 (Riegel 공식, 참고용 · 너무 짧거나 긴 거리는 제외)
  const canConvertTo3km = (mode) => metersOf(mode) >= RIEGEL_RANGE[0] && metersOf(mode) <= RIEGEL_RANGE[1];
  const to3km = (mode, sec) => sec * Math.pow(3000 / metersOf(mode), RIEGEL_EXP);

  function fmtValue(mode, v) { return isRunMode(mode) ? fmtTimeKo(v) : `${v}회`; }
  function fmtShortValue(mode, v) { return isRunMode(mode) ? fmtTime(v) : `${v}회`; }
  function fmtPace(secPerKm) { return `${fmtTime(secPerKm)}/km`; }
  function fmtGap(mode, diff) { return mode === 'run' ? `−${fmtGapSec(diff)}` : `+${diff}회`; }

  function today() { return getTodayKSTString(); }
  function parseDate(str) { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); }
  function toDateStr(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
  function addDays(str, n) { const d = parseDate(str); d.setDate(d.getDate() + n); return toDateStr(d); }
  function mondayOf(str) { const d = parseDate(str); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toDateStr(d); }
  function shortDate(str) { const [, m, d] = str.split('-'); return `${Number(m)}/${Number(d)}`; }
  function weekdayKo(str) { return WEEKDAY_KO[parseDate(str).getDay()]; }

  // 달리기는 시간이 짧을수록, 나머지는 횟수가 많을수록 좋은 기록
  function isBetter(mode, a, b) { return isRunMode(mode) ? a < b : a > b; }
  function bestValue(mode, values) {
    return values.reduce((best, v) => (best == null || isBetter(mode, v, best) ? v : best), null);
  }

  // auth.js(KAAYAuth) 가 있으면 클라우드에도 반영
  function cloud(method, ...args) {
    const auth = window.KAAYAuth;
    if (auth && typeof auth[method] === 'function') auth[method](...args);
  }

  /* ---------- 3. 등급 판정 ---------- */
  function profile() { return getCadetProfile(); }

  function criteriaFor(mode, prof = profile()) {
    const byGender = FITNESS_CRITERIA[prof.gender];
    return (byGender && byGender[prof.age] && byGender[prof.age][mode]) || FITNESS_CRITERIA.male['25under'][mode];
  }
  function judge(mode, value, prof = profile()) { return criteriaFor(mode, prof).calc(value); }   // { grade, badgeClass }
  // 저장용 판정: 장거리는 등급 대신 '기록'
  function resultFor(mode, value, prof = profile()) {
    return isCustomRun(mode) ? { grade: '기록', badgeClass: CUSTOM_RUN_BADGE } : judge(mode, value, prof);
  }
  // 알림에 붙일 꼬리말: 3종목은 등급, 장거리는 페이스
  function resultText(mode, value) {
    return isCustomRun(mode) ? fmtPace(value / kmOf(mode)) : gradeOf(mode, value);
  }
  function gradeOf(mode, value, prof) { return judge(mode, value, prof).grade; }
  function rankOf(grade) { const i = GRADES.indexOf(grade); return i < 0 ? GRADES.length : i; }

  /* 기준표 calc 함수를 훑어 등급별 경계값을 구한다 (기준표 데이터를 두 번 적지 않기 위해).
     달리기: 그 등급을 받는 가장 느린 기록(초) / 횟수: 그 등급을 받는 최소 횟수 */
  const thresholdCache = {};
  function thresholds(mode, prof = profile()) {
    const key = `${prof.gender}|${prof.age}|${mode}`;
    if (thresholdCache[key]) return thresholdCache[key];
    const calc = criteriaFor(mode, prof).calc;
    const result = {};
    if (mode === 'run') {
      for (let sec = 300; sec <= 3600; sec++) {
        const g = calc(sec).grade;
        if (g !== '불합격') result[g] = sec;
      }
    } else {
      for (let reps = 300; reps >= 0; reps--) {
        const g = calc(reps).grade;
        if (g !== '불합격') result[g] = reps;
      }
    }
    thresholdCache[key] = result;
    return result;
  }

  function gapTo(mode, value, grade, prof = profile()) {
    const target = thresholds(mode, prof)[grade];
    const diff = mode === 'run' ? value - target : target - value;
    return { grade, target, diff: Math.max(0, diff), reached: diff <= 0 };
  }

  /* 다음 등급까지 격차 + 현재 등급 구간 안에서의 진행률(0~1) */
  function gapInfo(mode, value, prof = profile()) {
    const th = thresholds(mode, prof);
    const grade = gradeOf(mode, value, prof);
    const rank = rankOf(grade);
    const toTop = gapTo(mode, value, '특급', prof);
    if (rank === 0) return { grade, next: null, toTop };

    const next = GRADES[rank - 1];
    const target = th[next];
    // 불합격 구간은 3급 구간과 같은 폭이라고 보고 진행률을 그린다
    const width = Math.abs(th['3급'] - th['2급']);
    const floor = grade === '불합격' ? (mode === 'run' ? th['3급'] + width : th['3급'] - width) : th[grade];
    const span = Math.abs(floor - target) || 1;
    const done = mode === 'run' ? floor - value : value - floor;
    return {
      grade, next, target, floor, toTop,
      diff: mode === 'run' ? value - target : target - value,
      progress: Math.max(0, Math.min(1, done / span))
    };
  }

  /* ---------- 4. 측정 기록 조회 ---------- */
  const sourceOf = (r) => r.source || 'test';

  function recordsOf(mode) {
    return getSavedRecords()
      .filter((r) => r.mode === mode)
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  }

  function personalBest(mode, excludeId) {
    let best = null;
    recordsOf(mode).forEach((r) => {
      if (excludeId != null && String(r.id) === String(excludeId)) return;
      if (!best || isBetter(mode, r.numericVal, best.numericVal)) best = r;
    });
    return best;
  }

  /* 종목별 현재 실력 = 최근 30일 최고 기록 (없으면 가장 최근 기록 + '오래됨' 표시) */
  function standing(mode, prof = profile()) {
    const recs = recordsOf(mode);
    if (!recs.length) return null;
    const since = addDays(today(), -STANDING_DAYS);
    const recent = recs.filter((r) => r.date >= since);
    const pool = recent.length ? recent : [recs[recs.length - 1]];
    const record = pool.reduce((best, r) => (isBetter(mode, r.numericVal, best.numericVal) ? r : best));
    return { record, value: record.numericVal, grade: gradeOf(mode, record.numericVal, prof), stale: !recent.length };
  }

  /* 종합 등급 = 세 종목 중 가장 낮은 등급 (평균이 아님) */
  function overall(prof = profile()) {
    const per = {};
    MODES.forEach((m) => { per[m] = standing(m, prof); });
    const measured = MODES.filter((m) => per[m]);
    if (!measured.length) return { per, grade: null, weakest: null, count: 0 };

    let weakest = measured[0];
    measured.forEach((m) => {
      const a = rankOf(per[m].grade);
      const b = rankOf(per[weakest].grade);
      const lessProgress = gapInfo(m, per[m].value, prof).progress < gapInfo(weakest, per[weakest].value, prof).progress;
      if (a > b || (a === b && lessProgress)) weakest = m;
    });
    return { per, grade: per[weakest].grade, weakest, count: measured.length };
  }

  /* ---------- 5. 알림 토스트 ---------- */
  const TOAST_TONE = { info: '#0f62fe', success: '#24a148', pb: '#f1c21b', warn: '#da1e28' };

  function toast(message, tone = 'info') {
    let wrap = $('fit-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'fit-toast-wrap';
      wrap.setAttribute('role', 'status');
      wrap.setAttribute('aria-live', 'polite');
      wrap.className = 'fixed left-0 right-0 bottom-16 z-[70] pointer-events-none flex flex-col items-center gap-2 px-4';
      document.body.appendChild(wrap);
    }
    const item = document.createElement('div');
    item.className = 'w-full max-w-[408px] bg-[#161616] text-white text-xs leading-relaxed px-3.5 py-2.5 border-l-4 transition-opacity duration-300';
    item.style.borderLeftColor = TOAST_TONE[tone] || TOAST_TONE.info;
    item.style.whiteSpace = 'pre-line';
    item.textContent = message;
    wrap.appendChild(item);
    setTimeout(() => {
      item.style.opacity = '0';
      setTimeout(() => item.remove(), 320);
    }, 3600);
  }

  /* ---------- 6. 측정 기록 저장 · 수정 · 삭제 ---------- */
  function buildRecord(mode, date, value, extra = {}) {
    const prof = profile();
    const res = resultFor(mode, value, prof);
    return {
      id: Date.now(),
      mode,
      date,
      valDisplay: fmtValue(mode, value),
      numericVal: value,
      grade: res.grade,
      badgeClass: res.badgeClass,
      gender: prof.gender,
      age: prof.age,
      memo: extra.memo || '',
      source: extra.source || 'test',
      updatedAt: new Date().toISOString()
    };
  }

  function addRecord(record) {
    const prevBest = personalBest(record.mode);
    const prevStanding = isCustomRun(record.mode) ? null : standing(record.mode);
    const records = getSavedRecords();
    records.push(record);
    saveRecords(records);
    cloud('uploadRecord', record);
    announceRecord(record, prevBest, prevStanding);
  }

  /* 개인 최고 기록 경신 · 등급 상승이면 강조 알림 */
  function announceRecord(record, prevBest, prevStanding) {
    const { mode } = record;
    const value = fmtValue(mode, record.numericVal);
    const grade = resultText(mode, record.numericVal);
    const kind = record.source === 'set' ? (isRunMode(mode) ? '전력 기록' : '세트 최대') : '기록';

    if (!prevBest) {
      toast(`${labelOf(mode)} 첫 ${kind} 저장: ${value} (${grade})`, 'success');
      return;
    }
    const lines = [];
    if (isBetter(mode, record.numericVal, prevBest.numericVal)) {
      lines.push(`${labelOf(mode)} 개인 최고 기록 경신! ${fmtValue(mode, prevBest.numericVal)} → ${value}`);
    }
    const now = isCustomRun(mode) ? null : standing(mode);
    if (prevStanding && now && rankOf(now.grade) < rankOf(prevStanding.grade)) {
      lines.push(`${labelOf(mode)} 등급 상승: ${prevStanding.grade} → ${now.grade}`);
    }
    if (lines.length) toast(lines.join('\n'), 'pb');
    else toast(`[${shortDate(record.date)}] ${labelOf(mode)} ${value} (${grade}) ${kind} 저장 완료`, 'success');
  }

  function readFormValue(mode) {
    if (isRunMode(mode)) {
      const min = parseInt($('run-min').value, 10) || 0;
      const sec = parseInt($('run-sec').value, 10) || 0;
      if (sec < 0 || sec > 59) { alert("'초'는 0~59 사이로 입력해 주세요."); return null; }
      if (min * 60 + sec <= 0) { alert(`${fmtDistance(metersOf(mode))} 기록(분·초)을 입력해 주세요. (예: 12분 40초)`); return null; }
      return min * 60 + sec;
    }
    const reps = parseInt($('reps-val').value, 10);
    if (isNaN(reps) || reps < 0) { alert('측정 횟수를 입력해 주세요.'); return null; }
    return reps;
  }

  /* ---------- 6-1. ① 기록하기 카드: 측정 / 훈련 · 달리기 거리 ---------- */
  let entryKind = 'test';        // 'test' = 측정(등급·거리별 기록) / 'train' = 훈련(일지)
  let distanceChoice = '3k';     // 달리기 거리: '3k' / 'custom'

  const KIND_LABEL = {
    run: { test: '측정 (전력)', train: '훈련' },
    reps: { test: '2분 측정', train: '훈련 세트' }
  };
  const kindLabels = (mode) => KIND_LABEL[mode === 'run' ? 'run' : 'reps'];

  function entryDate() { return ($('fitness-input-date') || {}).value || today(); }

  // 직접 입력한 거리 → 종목 키 (잘못된 값이면 null)
  function customDistanceMode() {
    const value = parseFloat(($('fit-dist-value') || {}).value);
    const unit = ($('fit-dist-unit') || {}).value || 'km';
    const meters = Math.round(unit === 'km' ? value * 1000 : value);
    if (!value || meters < 100 || meters > 100000) return null;
    return runModeFor(meters);
  }

  function selectedRunMode() {
    if (distanceChoice === '3k') return 'run';
    const mode = customDistanceMode();
    if (!mode) alert('거리를 100m ~ 100km 사이로 입력해 주세요. (예: 5 km, 800 m)');
    return mode;
  }

  /* 안내 문구: 3km·2분 측정은 원래 기준 안내(updateFitnessHint) 그대로, 직접 입력·훈련은 덮어쓴다 */
  function paintEntryHint() {
    const hint = $('criteria-hint');
    if (!hint) return;
    const mode = currentFitnessMode;
    if (entryKind === 'train') {
      hint.textContent = mode === 'run'
        ? '[훈련] 등급에 반영되지 않고 주간 통계·훈련량에 쌓여요'
        : '[훈련 세트] 최대 세트가 그날 측정보다 많으면 등급 기록(세트)에 반영';
    } else if (mode === 'run' && distanceChoice === 'custom') {
      hint.textContent = customDistanceMode() === 'run'
        ? '[3km] 3km는 등급 판정 기록으로 저장됩니다'
        : '[직접 입력] 등급 판정 없음 · 페이스와 3km 환산(참고)';
    }
  }

  function paintDistanceChoice() {
    const custom = distanceChoice === 'custom';
    [['fit-dist-3k', !custom], ['fit-dist-custom', custom]].forEach(([id, active]) => {
      const b = $(id);
      if (!b) return;
      b.className = `py-1.5 ${active ? 'bg-[#161616] text-white font-semibold' : 'bg-white text-[#525252]'}`;
      b.setAttribute('aria-pressed', String(active));
    });
    const box = $('fit-dist-custom-box');
    if (box) box.classList.toggle('hidden', !custom);
    // 장거리는 30분을 넘을 수 있으니 '분' 입력 상한을 푼다
    const minInput = $('run-min');
    if (minInput) { if (custom) minInput.removeAttribute('max'); else minInput.setAttribute('max', '30'); }

    const mode = custom ? customDistanceMode() : 'run';
    const label = $('run-input-label');
    if (label) {
      const dist = custom ? (mode ? fmtDistance(metersOf(mode)) : '입력한 거리') : '3km';
      label.textContent = entryKind === 'train' ? `${dist} 한 번 기록 시간` : `${dist} 달리기 시간`;
    }
    paintEntryHint();
  }

  function paintEntryCard() {
    const mode = currentFitnessMode;
    const isRun = mode === 'run';
    const train = entryKind === 'train';
    const labels = kindLabels(mode);

    const title = $('fit-entry-title');
    if (title) title.textContent = isRun ? '달리기 기록하기' : `${labelOf(mode)} 기록하기`;
    [['fit-kind-test', !train, labels.test], ['fit-kind-train', train, labels.train]].forEach(([id, active, text]) => {
      const b = $(id);
      if (!b) return;
      b.textContent = text;
      b.className = `py-2 ${active ? 'tab-active' : 'tab-inactive'}`;
      b.setAttribute('aria-pressed', String(active));
    });

    const show = (id, visible) => { const el = $(id); if (el) el.classList.toggle('hidden', !visible); };
    show('run-input-group', isRun);
    show('fit-run-reps-box', isRun && train);
    show('count-input-group', !isRun && !train);
    show('fit-set-editor', !isRun && train);
    if (isRun) paintDistanceChoice();
    else paintEntryHint();
    if (!isRun && train) renderSetEditor(mode);

    const memo = $('fitness-input-memo');
    if (memo && memo.dataset.fromDraft && (isRun || !train)) {
      memo.value = '';
      delete memo.dataset.fromDraft;
    }
    if (memo) memo.placeholder = train ? '메모 (선택) 예: 마지막 세트에서 자세 무너짐' : '메모 (선택) 예: 컨디션 좋음, 바람 강함';
    const save = $('fit-entry-save');
    if (save) {
      save.textContent = !train ? '측정 기록 저장'
        : (isRun ? '훈련 기록 추가' : (draft && draft.saved ? '훈련 세트 수정 저장' : '훈련 세트 저장'));
    }
    const note = $('fit-entry-note');
    if (note) {
      note.textContent = !train
        ? (isRun ? '3km는 등급으로 판정되고, 다른 거리는 아래 ‘내 달리기 기록’에 거리별로 모여요.' : '2분 동안 공식 자세로 한 개수를 넣으세요.')
        : (isRun ? '인터벌은 한 번 기록과 반복 수를 넣으면 돼요. (예: 800 m · 3분 40초 × 5)' : '2분 제한 측정이 아니어서 세트 최대값은 실제 시험보다 후하게 나올 수 있어요.');
    }
  }

  // 프로필·탭 변경 때 원래 기준 안내가 먼저 쓰고, 직접 입력·훈련 안내로 다시 덮는다
  const originalUpdateHint = window.updateFitnessHint;
  window.updateFitnessHint = function () {
    originalUpdateHint();
    paintEntryHint();
  };

  function setEntryKind(kind) {
    if (kind === entryKind) return;
    if (draft && draft.dirty && !confirm('저장하지 않은 훈련 세트가 있습니다. 전환할까요?')) return;
    entryKind = kind;
    if (kind === 'train' && currentFitnessMode !== 'run') loadDraft(currentFitnessMode, entryDate());
    originalUpdateHint();
    paintEntryCard();
  }

  /* 측정 기록 저장 (3km·2분 측정은 등급, 직접 입력 거리는 거리별 기록) */
  function saveTestRecord() {
    const mode = currentFitnessMode === 'run' ? selectedRunMode() : currentFitnessMode;
    if (!mode) return;
    const value = readFormValue(mode);
    if (value == null) return;
    const memoEl = $('fitness-input-memo');
    viewMode = mode;   // 저장한 거리의 기록이 '내 기록'에 바로 보이게
    addRecord(buildRecord(mode, entryDate(), value, { memo: memoEl ? memoEl.value.trim() : '' }));
    if (memoEl) memoEl.value = '';
  }
  window.saveActualFitnessRecord = saveTestRecord;   // 예전 이름으로 부르는 곳 호환

  /* 달리기 훈련: 그날 일지에 한 줄(반복이면 여러 줄) 추가. 등급에는 반영하지 않는다 */
  function saveRunTraining() {
    const mode = selectedRunMode();
    if (!mode) return;
    const sec = readFormValue(mode);
    if (sec == null) return;
    const meters = metersOf(mode);
    const reps = Math.min(30, Math.max(1, parseInt(($('fit-run-reps') || {}).value, 10) || 1));
    const unit = distanceChoice === 'custom' && ($('fit-dist-unit') || {}).value === 'm' ? 'm' : 'km';
    const date = entryDate();
    const memoEl = $('fitness-input-memo');
    const memo = memoEl ? memoEl.value.trim() : '';
    const entries = Array.from({ length: reps }, () => ({ km: meters / 1000, sec, max: false, unit }));

    const logs = getWorkoutLogs();
    const idx = logs.findIndex((l) => l.mode === 'run' && l.date === date);
    const prev = idx >= 0 ? logs[idx] : null;
    const log = {
      id: prev ? prev.id : newLogId('run', date),
      date,
      mode: 'run',
      sets: (prev ? prev.sets : []).concat(entries),
      note: memo || (prev ? prev.note || '' : ''),
      updatedAt: new Date().toISOString()
    };
    if (prev) logs[idx] = log; else logs.push(log);
    setWorkoutLogs(logs);
    cloud('uploadWorkout', log);

    ['run-min', 'run-sec'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
    const repsEl = $('fit-run-reps');
    if (repsEl) repsEl.value = '1';
    if (memoEl) memoEl.value = '';
    toast(`${shortDate(date)} 훈련 추가: ${fmtDistance(meters)}${reps > 1 ? ` × ${reps}` : ''} · ${fmtTime(sec)} (${fmtPace(sec / (meters / 1000))})\n그날 합계 ${logSummaryText('run', log)}`, 'success');
    expandedRunLog = date;
    window.renderFitnessUI();
  }

  function saveEntry() {
    if (entryKind === 'test') saveTestRecord();
    else if (currentFitnessMode === 'run') saveRunTraining();
    else saveWorkout();
  }

  function bindEntryCard() {
    const on = (id, type, fn) => { const el = $(id); if (el) el.addEventListener(type, fn); };
    on('fit-kind-test', 'click', () => setEntryKind('test'));
    on('fit-kind-train', 'click', () => setEntryKind('train'));
    on('fit-entry-save', 'click', saveEntry);
    on('fit-dist-3k', 'click', () => { distanceChoice = '3k'; originalUpdateHint(); paintDistanceChoice(); });
    on('fit-dist-custom', 'click', () => {
      distanceChoice = 'custom';
      paintDistanceChoice();
      const v = $('fit-dist-value');
      if (v) v.focus();
    });
    on('fit-dist-value', 'input', paintDistanceChoice);
    on('fit-dist-unit', 'input', paintDistanceChoice);
    on('fitness-input-date', 'change', (e) => {
      if (entryKind === 'train' && currentFitnessMode !== 'run') switchDraftDate(e.target.value);
    });
    on('fitness-input-memo', 'input', (e) => {
      if (entryKind !== 'train' || currentFitnessMode === 'run' || !draft) return;
      draft.note = e.target.value;
      draft.dirty = true;
      refreshSetSummary();
    });
    bindSetEditor();
  }

  function removeRecordById(id) {
    const key = String(id);   // 클라우드에서 온 기록은 id 가 문자열이라 문자열로 비교
    saveRecords(getSavedRecords().filter((r) => String(r.id) !== key));
    cloud('deleteRecord', key);
  }

  window.deleteRecord = function (id) {
    if (!confirm('이 기록을 삭제하시겠습니까?')) return;
    removeRecordById(id);
    toast('기록을 삭제했습니다.', 'info');
  };

  /* 기록 수정 모달 */
  let editingId = null;

  function ensureEditModal() {
    if ($('fit-edit-modal')) return;
    const el = document.createElement('div');
    el.id = 'fit-edit-modal';
    el.className = 'fixed inset-0 bg-black/70 z-50 hidden items-end sm:items-center justify-center';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'fit-edit-title');
    el.innerHTML = `
      <div class="bg-white w-full max-w-[440px] carbon-border p-4 space-y-3">
        <div class="flex justify-between items-center">
          <span id="fit-edit-title" class="text-sm font-semibold text-[#161616]">기록 수정</span>
          <button type="button" data-edit-act="cancel" class="text-sm text-[#525252] px-2" aria-label="닫기">✕</button>
        </div>
        <label class="block text-[11px] font-medium text-[#525252]">측정 일자
          <input type="date" id="fit-edit-date" class="carbon-input w-full p-2 text-xs font-mono mt-1">
        </label>
        <div id="fit-edit-value"></div>
        <label class="block text-[11px] font-medium text-[#525252]">메모
          <input type="text" id="fit-edit-memo" maxlength="60" class="carbon-input w-full p-2 text-xs mt-1" placeholder="예: 컨디션 좋음">
        </label>
        <p id="fit-edit-source" class="text-[10px] text-[#8c8c8c]"></p>
        <div class="grid grid-cols-3 gap-2 pt-1">
          <button type="button" data-edit-act="delete" class="py-2.5 text-xs font-medium border border-[#da1e28] text-[#da1e28]">삭제</button>
          <button type="button" data-edit-act="cancel" class="py-2.5 text-xs font-medium carbon-border bg-[#f4f4f4] text-[#161616]">취소</button>
          <button type="button" data-edit-act="save" class="carbon-blue-btn py-2.5 text-xs font-medium">저장</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-edit-act]');
      if (e.target === el || (act && act.dataset.editAct === 'cancel')) closeEditModal();
      else if (act && act.dataset.editAct === 'save') saveEdit();
      else if (act && act.dataset.editAct === 'delete' && confirm('이 기록을 삭제하시겠습니까?')) {
        removeRecordById(editingId);
        closeEditModal();
        toast('기록을 삭제했습니다.', 'info');
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editingId) closeEditModal(); });
  }

  function openEditModal(id) {
    const rec = getSavedRecords().find((r) => String(r.id) === String(id));
    if (!rec) return;
    ensureEditModal();
    editingId = String(rec.id);

    $('fit-edit-title').textContent = `${labelOf(rec.mode)} 기록 수정`;
    $('fit-edit-date').value = rec.date;
    $('fit-edit-memo').value = rec.memo || '';
    $('fit-edit-value').innerHTML = isRunMode(rec.mode)
      ? `<span class="block text-[11px] font-medium text-[#525252] mb-1">${fmtDistance(metersOf(rec.mode))} 기록</span>
         <div class="grid grid-cols-2 gap-2">
           <label class="flex items-center gap-1"><input type="number" id="fit-edit-min" min="0" value="${Math.floor(rec.numericVal / 60)}" class="carbon-input w-full p-2 text-sm text-center font-mono"><span class="text-xs text-[#525252]">분</span></label>
           <label class="flex items-center gap-1"><input type="number" id="fit-edit-sec" min="0" max="59" value="${rec.numericVal % 60}" class="carbon-input w-full p-2 text-sm text-center font-mono"><span class="text-xs text-[#525252]">초</span></label>
         </div>`
      : `<label class="block text-[11px] font-medium text-[#525252]">횟수
           <span class="flex items-center gap-2 mt-1"><input type="number" id="fit-edit-reps" min="0" max="300" value="${rec.numericVal}" class="carbon-input w-full p-2 text-sm font-mono"><span class="text-xs text-[#525252]">회</span></span>
         </label>`;
    $('fit-edit-source').textContent = sourceOf(rec) !== 'set'
      ? '직접 입력한 측정 기록입니다.'
      : (isRunMode(rec.mode)
        ? '달리기 훈련 일지의 전력 측정에서 자동 반영된 기록입니다. 일지를 고치면 다시 계산됩니다.'
        : '훈련 세트 최대값에서 자동 반영된 기록입니다. 세트 일지를 고치면 다시 계산됩니다.');

    const modal = $('fit-edit-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function closeEditModal() {
    const modal = $('fit-edit-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    editingId = null;
  }

  function saveEdit() {
    const records = getSavedRecords();
    const rec = records.find((r) => String(r.id) === editingId);
    if (!rec) { closeEditModal(); return; }

    let value;
    if (isRunMode(rec.mode)) {
      const min = parseInt($('fit-edit-min').value, 10) || 0;
      const sec = parseInt($('fit-edit-sec').value, 10) || 0;
      if (sec < 0 || sec > 59 || min * 60 + sec <= 0) { alert('기록을 올바르게 입력해 주세요. (초는 0~59)'); return; }
      value = min * 60 + sec;
    } else {
      value = parseInt($('fit-edit-reps').value, 10);
      if (isNaN(value) || value < 0) { alert('횟수를 입력해 주세요.'); return; }
    }

    const prof = profile();
    const res = resultFor(rec.mode, value, prof);
    const prevBest = personalBest(rec.mode, rec.id);
    const currentBest = personalBest(rec.mode);
    const wasPB = currentBest && String(currentBest.id) === String(rec.id);
    Object.assign(rec, {
      date: $('fit-edit-date').value || rec.date,
      numericVal: value,
      valDisplay: fmtValue(rec.mode, value),
      grade: res.grade,
      badgeClass: res.badgeClass,
      gender: prof.gender,
      age: prof.age,
      memo: $('fit-edit-memo').value.trim(),
      updatedAt: new Date().toISOString()
    });
    saveRecords(records);
    cloud('uploadRecord', rec);
    closeEditModal();

    const becamePB = !wasPB && prevBest && isBetter(rec.mode, value, prevBest.numericVal);
    toast(becamePB
      ? `수정 완료 · 개인 최고 기록이 되었습니다 (${rec.valDisplay})`
      : `수정 완료: ${rec.date} ${rec.valDisplay} (${resultText(rec.mode, value)})`, becamePB ? 'pb' : 'success');
  }

  /* ---------- 7. 훈련 일지 ---------- */
  function getWorkoutLogs() {
    try {
      const raw = localStorage.getItem(WORKOUT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function setWorkoutLogs(logs) {
    try { localStorage.setItem(WORKOUT_KEY, JSON.stringify(logs)); } catch (e) { console.warn('[Workout] 저장 실패:', e); }
  }
  function findLog(mode, date) { return getWorkoutLogs().find((l) => l.mode === mode && l.date === date) || null; }
  function newLogId(mode, date) { return `${mode}_${date}_${Math.random().toString(36).slice(2, 8)}`; }

  function setStats(sets) {
    const valid = sets.map(Number).filter((n) => n > 0);
    const total = valid.reduce((a, b) => a + b, 0);
    return {
      total,
      count: valid.length,
      max: valid.length ? Math.max(...valid) : 0,
      avg: valid.length ? Math.round(total / valid.length) : 0
    };
  }
  function runStats(runs) {
    const valid = runs.filter((r) => r.km > 0 && r.sec > 0);
    const km = Math.round(valid.reduce((a, r) => a + Number(r.km), 0) * 10) / 10;
    const sec = valid.reduce((a, r) => a + r.sec, 0);
    return { km, sec, pace: km ? sec / km : 0, count: valid.length };
  }
  function logSummaryText(mode, log) {
    if (mode === 'run') {
      const st = runStats(log.sets);
      return `${st.km}km · ${fmtTime(st.sec)} · ${st.pace ? fmtPace(st.pace) : '-'}`;
    }
    const st = setStats(log.sets);
    return `${st.count}세트 · 총 ${st.total}회 · 최대 ${st.max}`;
  }

  /* 팔굽혀펴기·윗몸 훈련 세트 편집 상태 (저장 전) */
  let draft = null;

  function loadDraft(mode, date) {
    const log = findLog(mode, date);
    draft = { mode, date, dirty: false, saved: !!log, note: log ? log.note || '' : '', sets: log ? log.sets.slice() : [] };
    const memo = $('fitness-input-memo');
    if (memo && entryKind === 'train' && mode !== 'run') {
      memo.value = draft.note;
      memo.dataset.fromDraft = '1';   // 세트 일지에서 불러온 메모 표시 (다른 입력으로 넘어가면 비운다)
    }
  }

  function setRowsHtml() {
    if (!draft.sets.length) {
      return '<p class="text-[11px] text-[#8c8c8c] text-center py-2">아직 세트가 없습니다. ‘+ 세트 추가’를 눌러 시작하세요.</p>';
    }
    return draft.sets.map((v, i) => `
      <div class="flex items-center gap-2 py-1">
        <span class="w-11 text-[11px] font-mono text-[#525252]">${i + 1}세트</span>
        <button type="button" data-act="dec" data-i="${i}" class="w-9 h-9 carbon-border bg-[#f4f4f4] text-base leading-none" aria-label="${i + 1}세트 1개 줄이기">−</button>
        <input type="number" data-set="${i}" inputmode="numeric" min="0" max="300" value="${v}" aria-label="${i + 1}세트 개수" class="carbon-input w-16 h-9 text-center text-sm font-mono">
        <button type="button" data-act="inc" data-i="${i}" class="w-9 h-9 carbon-border bg-[#f4f4f4] text-base leading-none" aria-label="${i + 1}세트 1개 늘리기">+</button>
        <span class="text-xs text-[#525252]">회</span>
        <button type="button" data-act="del-set" data-i="${i}" class="ml-auto text-[11px] text-[#8c8c8c] hover:text-[#da1e28] px-1.5 py-1">삭제</button>
      </div>`).join('');
  }

  function setSummaryHtml() {
    const st = setStats(draft.sets);
    const cell = (label, value) => `
      <div><div class="text-[9px] text-[#a8a8a8]">${label}</div><div class="text-sm font-mono font-semibold">${value}</div></div>`;
    return cell('총 개수', st.total) + cell('세트', st.count) + cell('최대', st.max || '-') + cell('평균', st.avg || '-');
  }

  function renderSetEditor(mode) {
    const box = $('fit-set-editor');
    if (!box) return;
    const date = entryDate();
    if (draft && draft.mode === mode && draft.dirty && draft.date !== date) {
      // 저장 전 세트가 있으면 그 세트의 날짜를 유지한다 (날짜 칸이 바깥에서 바뀐 경우)
      const input = $('fitness-input-date');
      if (input) input.value = draft.date;
    } else if (!draft || draft.mode !== mode || draft.date !== date || !draft.dirty) {
      // 다른 종목·날짜이거나 저장 전 변경이 없으면 저장된 일지로 다시 불러온다 (클라우드 동기화 반영)
      loadDraft(mode, date);
    }
    box.innerHTML = `
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-semibold text-[#525252]">세트별 개수</span>
          <span id="fit-wo-dirty" class="text-[10px] text-[#da1e28] ${draft.dirty ? '' : 'hidden'}">● 저장 전</span>
        </div>
        <div id="fit-wo-rows">${setRowsHtml()}</div>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" data-act="add-set" class="carbon-border bg-[#f4f4f4] py-2 text-xs font-medium text-[#0f62fe]">+ 세트 추가</button>
          <button type="button" data-act="pop-set" class="carbon-border bg-[#f4f4f4] py-2 text-xs text-[#525252]">− 마지막 세트 빼기</button>
        </div>
        <div id="fit-wo-summary" class="bg-[#161616] text-white p-3 grid grid-cols-4 gap-1 text-center">${setSummaryHtml()}</div>
      </div>`;
  }

  /* 행만 다시 그린다 (날짜·메모 입력은 그대로) */
  function refreshSetRows() {
    const rows = $('fit-wo-rows');
    if (rows) rows.innerHTML = setRowsHtml();
    refreshSetSummary();
  }
  function refreshSetSummary() {
    const summary = $('fit-wo-summary');
    if (summary) summary.innerHTML = setSummaryHtml();
    const dirty = $('fit-wo-dirty');
    if (dirty) dirty.classList.toggle('hidden', !draft.dirty);
  }

  function switchDraftDate(date) {
    if (!date || (draft && date === draft.date)) return;
    if (draft && draft.dirty && !confirm('저장하지 않은 훈련 세트가 있습니다. 다른 날짜로 이동할까요?')) {
      const input = $('fitness-input-date');
      if (input) input.value = draft.date;
      return;
    }
    loadDraft(currentFitnessMode, date);
    paintEntryCard();
  }

  function bindSetEditor() {
    const box = $('fit-set-editor');
    if (!box) return;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !draft) return;
      const i = Number(btn.dataset.i);
      const lastSet = draft.sets.length ? Number(draft.sets[draft.sets.length - 1]) || 0 : 20;
      switch (btn.dataset.act) {
        case 'add-set': draft.sets.push(lastSet); break;
        case 'pop-set': draft.sets.pop(); break;
        case 'dec': draft.sets[i] = Math.max(0, (Number(draft.sets[i]) || 0) - 1); break;
        case 'inc': draft.sets[i] = (Number(draft.sets[i]) || 0) + 1; break;
        case 'del-set': draft.sets.splice(i, 1); break;
        default: return;
      }
      draft.dirty = true;
      refreshSetRows();
    });
    box.addEventListener('input', (e) => {
      const t = e.target;
      if (!draft || t.dataset.set == null) return;
      draft.sets[Number(t.dataset.set)] = Math.max(0, parseInt(t.value, 10) || 0);
      draft.dirty = true;
      refreshSetSummary();
    });
  }

  /* 세트 최대값(또는 예전 일지의 '전력 측정' 달리기)을 그날 기록에 반영한다.
     그날 직접 측정한 기록보다 좋을 때만 '세트' 기록으로 남기고, 아니면 기존 세트 기록을 지운다. */
  function reflectToRecord(mode, date, value) {
    const records = getSavedRecords();
    const sameDay = records.filter((r) => r.mode === mode && r.date === date);
    const setRec = sameDay.find((r) => sourceOf(r) === 'set');
    const testBest = bestValue(mode, sameDay.filter((r) => sourceOf(r) !== 'set').map((r) => r.numericVal));
    const shouldReflect = value != null && (testBest == null || isBetter(mode, value, testBest));

    if (shouldReflect && setRec) {
      if (setRec.numericVal === value) return 'same';
      const prof = profile();
      const res = resultFor(mode, value, prof);
      Object.assign(setRec, {
        numericVal: value, valDisplay: fmtValue(mode, value), grade: res.grade, badgeClass: res.badgeClass,
        gender: prof.gender, age: prof.age, updatedAt: new Date().toISOString()
      });
      saveRecords(records);
      cloud('uploadRecord', setRec);
      return 'updated';
    }
    if (shouldReflect) {
      const memo = isRunMode(mode) ? `훈련 일지 · ${fmtDistance(metersOf(mode))} 전력` : '훈련 세트 최대';
      addRecord(buildRecord(mode, date, value, { source: 'set', memo }));
      return 'added';
    }
    if (setRec) { removeRecordById(setRec.id); return 'removed'; }
    return 'none';
  }

  /* 일지 한 건이 반영될 수 있는 [종목, 값] 목록
     달리기: 거리별로 '전력 측정'에 체크된(예전 일지) 가장 빠른 기록 / 세트: 최대 개수 */
  function reflectTargets(mode, sets, date) {
    if (mode !== 'run') return [[mode, sets.length ? Math.max(...sets) : null]];
    const modeOfRun = (r) => runModeFor(Math.round(r.km * 1000));
    // 이번 일지의 거리들 + 그날 이미 반영돼 있던 거리들 (체크를 풀었으면 지우기 위해)
    const modes = new Set(sets.map(modeOfRun));
    getSavedRecords()
      .filter((r) => r.date === date && sourceOf(r) === 'set' && isRunMode(r.mode))
      .forEach((r) => modes.add(r.mode));
    return [...modes].map((m) => {
      const full = sets.filter((r) => r.max && modeOfRun(r) === m);
      return [m, full.length ? Math.min(...full.map((r) => r.sec)) : null];
    });
  }

  /* 팔굽혀펴기·윗몸 훈련 세트 저장 */
  function saveWorkout() {
    if (!draft || draft.mode !== currentFitnessMode) loadDraft(currentFitnessMode, entryDate());
    const { mode, date } = draft;
    const sets = draft.sets.map((n) => parseInt(n, 10)).filter((n) => n > 0);
    const logs = getWorkoutLogs();
    const idx = logs.findIndex((l) => l.mode === mode && l.date === date);

    // 세트를 모두 지우고 저장하면 그날 일지를 삭제
    if (!sets.length) {
      if (idx < 0) { alert('세트 개수를 입력해 주세요.'); return; }
      const [removed] = logs.splice(idx, 1);
      setWorkoutLogs(logs);
      cloud('deleteWorkout', removed.id);
      reflectTargets(mode, [], date).forEach(([m]) => reflectToRecord(m, date, null));
      loadDraft(mode, date);
      window.renderFitnessUI();
      toast(`${shortDate(date)} ${labelOf(mode)} 훈련 기록을 삭제했습니다.`, 'info');
      return;
    }

    const log = {
      id: idx >= 0 ? logs[idx].id : newLogId(mode, date),
      date,
      mode,
      sets,
      note: (draft.note || '').trim(),
      updatedAt: new Date().toISOString()
    };
    if (idx >= 0) logs[idx] = log; else logs.push(log);
    setWorkoutLogs(logs);
    cloud('uploadWorkout', log);

    toast(`${shortDate(date)} 훈련 기록 저장: ${logSummaryText(mode, log)}`, 'success');
    const results = reflectTargets(mode, sets, date).map(([m, v]) => reflectToRecord(m, date, v));
    if (results.includes('updated')) toast('세트 최대값으로 그날 등급 기록을 갱신했습니다.', 'info');
    loadDraft(mode, date);
    window.renderFitnessUI();
  }

  /* 달리기 일지에서 한 줄 지우기 */
  function deleteRunEntry(date, index) {
    const logs = getWorkoutLogs();
    const idx = logs.findIndex((l) => l.mode === 'run' && l.date === date);
    if (idx < 0) return;
    const log = logs[idx];
    const sets = log.sets.filter((_, i) => i !== index);
    if (sets.length) {
      logs[idx] = { ...log, sets, updatedAt: new Date().toISOString() };
      cloud('uploadWorkout', logs[idx]);
    } else {
      logs.splice(idx, 1);
      cloud('deleteWorkout', log.id);
    }
    setWorkoutLogs(logs);
    reflectTargets('run', sets, date).forEach(([m, v]) => reflectToRecord(m, date, v));
    window.renderFitnessUI();
    toast('훈련 기록 한 줄을 삭제했습니다.', 'info');
  }

  /* ---------- 8. 카드 렌더링: 종합 현황 · ② 내 기록 ---------- */
  function overviewRowHtml(mode, o) {
    const s = o.per[mode];
    if (!s) {
      return `
        <button type="button" data-goto="${mode}" class="w-full text-left p-3 flex items-center justify-between hover:bg-[#f4f4f4]">
          <span class="text-xs font-medium text-[#161616]">${labelOf(mode)}</span>
          <span class="text-[11px] text-[#8c8c8c]">기록 없음 · 측정 후 입력 →</span>
        </button>`;
    }
    const isWeak = o.count > 1 && o.weakest === mode && o.grade !== '특급';
    const gap = gapInfo(mode, s.value);
    const pct = gap.next ? Math.round(gap.progress * 100) : 100;
    const gapText = gap.next
      ? `${gap.next}까지 <strong class="text-[#161616]">${fmtGap(mode, gap.diff)}</strong>`
      : '<strong class="text-[#24a148]">최고 등급 달성</strong>';
    return `
      <button type="button" data-goto="${mode}" class="w-full text-left p-3 space-y-1.5 hover:bg-[#f4f4f4] ${isWeak ? 'bg-[#fff8e1]' : ''}">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-[#161616] flex items-center gap-1.5">
            ${labelOf(mode)}
            ${isWeak ? '<span class="text-[9px] px-1 py-px bg-[#da1e28] text-white font-semibold">약점</span>' : ''}
          </span>
          <span class="flex items-center gap-2">
            <span class="font-mono text-xs font-semibold text-[#161616]">${fmtShortValue(mode, s.value)}</span>
            <span class="px-1.5 py-0.5 text-[10px] font-semibold ${GRADE_BADGE[s.grade]}">${s.grade}</span>
          </span>
        </div>
        <div class="flex items-center gap-2">
          <div class="flex-1 h-1.5 bg-[#e0e0e0]"><div class="h-1.5" style="width:${pct}%;background:${GRADE_COLOR[gap.next || '특급']}"></div></div>
          <span class="text-[10px] text-[#525252] whitespace-nowrap">${gapText}</span>
        </div>
        ${s.stale ? `<div class="text-[10px] text-[#8e6a00]">${STANDING_DAYS}일 넘은 기록(${s.record.date}) · 새로 측정해 보세요</div>` : ''}
      </button>`;
  }

  function renderOverview() {
    const box = $('fit-overview');
    if (!box) return;
    const o = overall();
    const badge = o.grade
      ? `<span class="px-2.5 py-1 text-sm font-bold whitespace-nowrap ${GRADE_BADGE[o.grade]}">종합 ${o.grade}</span>`
      : '<span class="px-2.5 py-1 text-xs font-semibold bg-[#e0e0e0] text-[#525252] whitespace-nowrap">기록 없음</span>';
    const sub = o.count === 3
      ? '가장 낮은 종목의 등급이 종합 등급'
      : (o.count ? `종합 미완성 (${o.count}/3종목 측정)` : '세 종목을 측정하면 종합 등급이 나옵니다');
    box.innerHTML = `
      <div class="p-3.5 flex items-center justify-between gap-2 border-b border-[#e0e0e0]">
        <div class="min-w-0">
          <div class="text-xs font-semibold text-[#161616]">3종목 종합 현황</div>
          <div class="text-[10px] text-[#525252]">${sub} · 최근 ${STANDING_DAYS}일 최고 기록 기준</div>
        </div>
        ${badge}
      </div>
      <div class="divide-y divide-[#e0e0e0]">${MODES.map((m) => overviewRowHtml(m, o)).join('')}</div>`;
  }

  /* ② 내 기록: 보고 있는 종목(달리기는 거리 칩) · 펼친 달리기 일지 날짜 */
  let viewMode = null;
  let expandedRunLog = null;

  function customRunModes() {
    const modes = new Set(getSavedRecords().filter((r) => isCustomRun(r.mode)).map((r) => r.mode));
    return [...modes].sort((a, b) => metersOf(a) - metersOf(b));
  }

  function chipsHtml() {
    if (currentFitnessMode !== 'run') return '';
    const modes = ['run'].concat(customRunModes());
    if (modes.length === 1) return '';   // 3km뿐이면 칩을 숨긴다
    return modes.map((m) => {
      const active = m === viewMode;
      return `<button type="button" data-view="${m}" aria-pressed="${active}" class="px-2.5 py-1 text-[11px] font-mono border ${active ? 'bg-[#161616] text-white border-[#161616]' : 'bg-white text-[#525252] border-[#c6c6c6]'}">${m === 'run' ? '3km' : fmtDistance(metersOf(m))}</button>`;
    }).join('');
  }

  function gradedSummaryHtml(mode, recs) {
    if (!recs.length) {
      return `<p class="text-[11px] text-[#8c8c8c]">아직 측정 기록이 없습니다. 위에서 ‘${kindLabels(mode).test}’을 고르고 첫 기록을 저장해 보세요.</p>`;
    }
    const latest = recs[recs.length - 1];
    const pb = personalBest(mode);
    const gap = gapInfo(mode, latest.numericVal);
    const head = `
      <div class="flex items-end justify-between gap-2">
        <div class="min-w-0">
          <div class="text-[10px] text-[#525252]">최근 기록 · ${latest.date}${sourceOf(latest) === 'set' ? ' · 세트' : ''}</div>
          <div class="text-xl font-mono font-semibold text-[#161616] leading-tight">${fmtShortValue(mode, latest.numericVal)}</div>
        </div>
        <div class="text-right">
          <span class="px-2 py-0.5 text-xs font-semibold ${GRADE_BADGE[gap.grade]}">${gap.grade}</span>
          <div class="text-[10px] text-[#525252] mt-1">개인 최고 <span class="font-mono text-[#161616]">${fmtShortValue(mode, pb.numericVal)}</span></div>
        </div>
      </div>`;
    if (!gap.next) {
      return `${head}<p class="text-[11px] text-[#24a148] font-semibold">특급 기준 달성! 페이스를 유지하며 부상 관리에 집중하세요.</p>`;
    }
    const failNote = gap.grade === '불합격' ? '<strong class="text-[#da1e28]">불합격 구간</strong> · ' : '';
    const top = gap.next !== '특급' ? ` · 특급까지 ${fmtGap(mode, gap.toTop.diff)}` : '';
    return `${head}
      <div class="space-y-1">
        <div class="text-[11px] text-[#525252]">${failNote}${gap.next}까지 <strong class="text-[#161616]">${fmtGap(mode, gap.diff)}</strong>${top}</div>
        <div class="h-2 bg-[#e0e0e0]"><div class="h-2" style="width:${Math.round(gap.progress * 100)}%;background:${GRADE_COLOR[gap.next]}"></div></div>
        <div class="flex justify-between text-[10px] font-mono text-[#8c8c8c]">
          <span>${gap.grade} ${fmtShortValue(mode, gap.floor)}</span><span>${gap.next} ${fmtShortValue(mode, gap.target)}</span>
        </div>
      </div>`;
  }

  function customSummaryHtml(mode) {
    const pb = personalBest(mode);
    const est = canConvertTo3km(mode) ? Math.round(to3km(mode, pb.numericVal)) : null;
    const estGrade = est ? gradeOf('run', est) : null;
    const cell = (label, value) => `
      <div><div class="text-[9px] text-[#525252]">${label}</div><div class="text-xs font-mono font-semibold text-[#161616]">${value}</div></div>`;
    return `
      <div class="grid grid-cols-3 gap-1 text-center bg-[#f4f4f4] p-2">
        ${cell('개인 최고', fmtTime(pb.numericVal))}
        ${cell('평균 페이스', fmtPace(pb.numericVal / kmOf(mode)))}
        ${cell('3km 환산', est ? `${fmtTime(est)} <span class="text-[9px] px-1 ${GRADE_BADGE[estGrade]}">${estGrade}</span>` : '-')}
      </div>
      <p class="text-[10px] text-[#8c8c8c] leading-relaxed">등급 판정 없음 · 3km 환산은 Riegel 공식 참고값(1.5km 이상만)이고, 등급은 실제 3km 기록으로만 판정해요.</p>`;
  }

  function historyRowHtml(r, pb) {
    const graded = MODES.includes(r.mode);
    const isPB = pb && String(pb.id) === String(r.id);
    const right = graded
      ? `<span class="px-1.5 py-0.5 text-[10px] font-semibold ${GRADE_BADGE[gradeOf(r.mode, r.numericVal)]}">${gradeOf(r.mode, r.numericVal)}</span>`
      : `<span class="text-[10px] font-mono text-[#525252]">${fmtPace(r.numericVal / kmOf(r.mode))}</span>`;
    return `
      <div class="px-3.5 py-2 flex items-start justify-between gap-2 hover:bg-[#f4f4f4]">
        <div class="min-w-0 space-y-0.5">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-mono text-[11px] text-[#525252]">${r.date}</span>
            <span class="font-semibold text-xs text-[#161616]">${fmtValue(r.mode, r.numericVal)}</span>
            ${sourceOf(r) === 'set' ? '<span class="text-[9px] px-1 border border-[#8c8c8c] text-[#525252]">세트</span>' : ''}
            ${isPB ? '<span class="text-[9px] px-1 bg-[#161616] text-[#f1c21b] font-semibold">PB</span>' : ''}
          </div>
          ${r.memo ? `<p class="text-[11px] text-[#8c8c8c] truncate">${esc(r.memo)}</p>` : ''}
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          ${right}
          <button type="button" data-edit="${esc(r.id)}" class="text-[11px] text-[#0f62fe] underline">수정</button>
        </div>
      </div>`;
  }

  function recentTrainingHtml(mode) {
    const isRun = mode === 'run';
    const logs = getWorkoutLogs()
      .filter((l) => l.mode === mode)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5);
    const head = `
      <div class="px-3.5 pt-2.5 pb-1 flex justify-between items-center">
        <span class="text-[11px] font-semibold text-[#525252]">최근 훈련</span>
        <span class="text-[10px] text-[#8c8c8c]">${isRun ? '눌러서 펼치기' : '눌러서 고치기'}</span>
      </div>`;
    if (!logs.length) {
      return `${head}<p class="px-3.5 pb-3 text-[11px] text-[#8c8c8c]">아직 훈련 기록이 없어요. 위에서 ‘${kindLabels(mode).train}’을 골라 기록해 보세요.</p>`;
    }
    const rows = logs.map((l) => {
      const open = isRun && expandedRunLog === l.date;
      const line = `
        <button type="button" ${isRun ? `data-runlog="${l.date}"` : `data-setlog="${l.date}"`} aria-expanded="${open}" class="w-full text-left px-3.5 py-2 flex justify-between items-center gap-2 text-[11px] hover:bg-[#f4f4f4]">
          <span class="font-mono text-[#525252]">${shortDate(l.date)}(${weekdayKo(l.date)})</span>
          <span class="text-[#161616] text-right">${logSummaryText(mode, l)}${isRun ? ` ${open ? '▴' : '▾'}` : ' ✎'}</span>
        </button>`;
      if (!open) return line;
      const entries = l.sets.map((r, i) => `
        <div class="pl-6 pr-3.5 py-1.5 flex justify-between items-center gap-2 text-[11px] bg-[#f4f4f4]">
          <span class="text-[#161616]">${fmtDistance(Math.round(r.km * 1000))} · ${fmtTime(r.sec)} · ${fmtPace(r.sec / r.km)}${r.max ? ' · 전력' : ''}</span>
          <button type="button" data-del-entry="${l.date}|${i}" class="text-[#8c8c8c] hover:text-[#da1e28]" aria-label="이 줄 삭제">삭제</button>
        </div>`).join('');
      return line + entries + (l.note ? `<p class="pl-6 pr-3.5 pb-2 text-[10px] text-[#8c8c8c] bg-[#f4f4f4]">${esc(l.note)}</p>` : '');
    }).join('');
    return `${head}<div class="divide-y divide-[#e0e0e0]">${rows}</div>`;
  }

  function renderMyRecords() {
    const mode = viewMode;
    const recs = recordsOf(mode);
    const title = $('fit-my-title');
    if (title) title.textContent = currentFitnessMode === 'run' ? '내 달리기 기록' : `내 ${labelOf(currentFitnessMode)} 기록`;
    const count = $('history-count');
    if (count) count.textContent = `${currentFitnessMode === 'run' ? (mode === 'run' ? '3km' : fmtDistance(metersOf(mode))) + ' ' : ''}${recs.length}건`;

    const chips = $('fit-dist-chips');
    if (chips) {
      chips.innerHTML = chipsHtml();
      chips.classList.toggle('hidden', !chips.innerHTML);
    }
    const summary = $('fit-my-summary');
    if (summary) summary.innerHTML = MODES.includes(mode) ? gradedSummaryHtml(mode, recs) : customSummaryHtml(mode);

    drawRecordChart(mode);

    const list = $('history-list');
    if (list) {
      const pb = personalBest(mode);
      list.innerHTML = recs.length
        ? recs.slice().reverse().map((r) => historyRowHtml(r, pb)).join('')
        : '<div class="px-3.5 py-3 text-[11px] text-[#8c8c8c]">등록된 기록이 없습니다.</div>';
    }
    const recent = $('fit-recent-train');
    if (recent) recent.innerHTML = recentTrainingHtml(currentFitnessMode);
  }

  /* 최근 훈련에서 세트 일지를 누르면: 위 기록하기 카드에 그 날짜 세트를 불러온다 */
  function openSetLog(date) {
    if (draft && draft.dirty && !confirm('저장하지 않은 훈련 세트가 있습니다. 이 날짜를 불러올까요?')) return;
    entryKind = 'train';
    const input = $('fitness-input-date');
    if (input) { input.value = date; input.dataset.userModified = 'true'; }
    loadDraft(currentFitnessMode, date);
    originalUpdateHint();
    paintEntryCard();
    const card = $('fit-entry-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function bindMyRecords() {
    const card = $('fit-myrecords-card');
    if (!card) return;
    card.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-view]');
      if (chip) { viewMode = chip.dataset.view; renderMyRecords(); return; }
      const edit = e.target.closest('[data-edit]');
      if (edit) { openEditModal(edit.dataset.edit); return; }
      const del = e.target.closest('[data-del-entry]');
      if (del) {
        const [date, i] = del.dataset.delEntry.split('|');
        if (confirm('이 훈련 기록 한 줄을 삭제할까요?')) deleteRunEntry(date, Number(i));
        return;
      }
      const runLog = e.target.closest('[data-runlog]');
      if (runLog) {
        expandedRunLog = expandedRunLog === runLog.dataset.runlog ? null : runLog.dataset.runlog;
        const recent = $('fit-recent-train');
        if (recent) recent.innerHTML = recentTrainingHtml('run');
        return;
      }
      const setLog = e.target.closest('[data-setlog]');
      if (setLog) openSetLog(setLog.dataset.setlog);
    });
  }

  function renderRoutineBox(mode) {
    const box = $('routine-box');
    if (!box) return;
    const coach = window.KAAYCoach;
    box.innerHTML = coach && typeof coach.modeSummaryHtml === 'function'
      ? coach.modeSummaryHtml(mode)
      : '<p>코치 플랜을 불러오는 중입니다.</p>';
  }

  /* ---------- 9. 그래프 ---------- */
  let chartRange = 'all';
  let chartPoints = [];

  /* 고해상도 화면에서도 선명하게: CSS 크기 × devicePixelRatio */
  function setupCanvas(canvas, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 360;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.height = `${cssHeight}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, cssHeight);
    return { ctx, w: width, h: cssHeight };
  }

  function drawRecordChart(mode) {
    const canvas = $('fitnessChart');
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(canvas, 190);
    // 3종목은 등급 기준선을 함께 그리고, 직접 입력 거리는 기록만 그린다
    const graded = MODES.includes(mode);
    const th = graded ? thresholds(mode) : {};
    const gradeLines = graded ? ['특급', '1급', '2급', '3급'].map((g) => ({ grade: g, value: th[g] })) : [];

    const all = recordsOf(mode);
    const recs = chartRange === 'all' ? all : all.filter((r) => r.date >= addDays(today(), -Number(chartRange)));

    const pad = { l: 10, r: graded ? 58 : 14, t: 14, b: 24 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const values = recs.map((r) => r.numericVal).concat(gradeLines.map((l) => l.value));
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const margin = (hi - lo) * 0.08 || 5;
    lo -= margin;
    hi += margin;
    // 위로 갈수록 좋은 기록 (달리기는 짧은 시간이 위)
    const yOf = (v) => (isRunMode(mode)
      ? pad.t + ((v - lo) / (hi - lo)) * ph
      : pad.t + ((hi - v) / (hi - lo)) * ph);

    // 특급 이상 구간 음영
    if (graded) {
      const topY = yOf(th['특급']);
      ctx.fillStyle = 'rgba(36,161,72,0.07)';
      ctx.fillRect(pad.l, pad.t, pw, Math.max(0, topY - pad.t));
    }

    // 등급 기준선 + 오른쪽 라벨 (라벨이 겹치면 아래로 민다)
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let lastLabelY = -Infinity;
    gradeLines.forEach(({ grade, value }) => {
      const y = Math.round(yOf(value)) + 0.5;
      ctx.strokeStyle = GRADE_COLOR[grade];
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const labelY = Math.max(y, lastLabelY + 11);
      lastLabelY = labelY;
      ctx.fillStyle = GRADE_COLOR[grade];
      ctx.fillText(`${grade} ${mode === 'run' ? fmtTime(value) : value}`, pad.l + pw + 5, labelY);
    });

    chartPoints = [];
    const hint = $('chart-hint-text');
    if (!recs.length) {
      ctx.fillStyle = '#8c8c8c';
      ctx.textAlign = 'center';
      ctx.fillText(all.length ? '선택한 기간에 기록이 없습니다' : '기록을 입력하면 등급 기준선 위에 그려집니다', pad.l + pw / 2, pad.t + ph / 2);
      if (hint) hint.textContent = '점선 = 등급 기준선 · 위로 갈수록 좋은 기록';
      return;
    }

    // x축: 날짜 간격대로 배치 (모두 같은 날이면 순서대로)
    const t0 = parseDate(recs[0].date).getTime();
    const t1 = parseDate(recs[recs.length - 1].date).getTime();
    const xOf = (r, i) => (t1 === t0
      ? pad.l + (recs.length === 1 ? pw / 2 : 8 + ((pw - 16) * i) / (recs.length - 1))
      : pad.l + 8 + ((parseDate(r.date).getTime() - t0) / (t1 - t0)) * (pw - 16));
    const pts = recs.map((r, i) => ({ x: xOf(r, i), y: yOf(r.numericVal), rec: r }));

    ctx.strokeStyle = '#0f62fe';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();

    const pb = personalBest(mode);
    const isPB = (p) => pb && String(pb.id) === String(p.rec.id);
    pts.forEach((p) => {
      ctx.fillStyle = sourceOf(p.rec) === 'set' ? '#ffffff' : '#0f62fe';   // ■ 측정 / □ 세트
      ctx.strokeStyle = '#0f62fe';
      ctx.lineWidth = 1.5;
      ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
      ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
      if (isPB(p)) {
        ctx.strokeStyle = '#24a148';
        ctx.lineWidth = 2;
        ctx.strokeRect(p.x - 6.5, p.y - 6.5, 13, 13);
      }
    });

    // 값 라벨: 기록이 적으면 전부, 많으면 마지막과 개인 최고만
    ctx.fillStyle = '#161616';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    pts.forEach((p, i) => {
      if (pts.length > 6 && i !== pts.length - 1 && !isPB(p)) return;
      const labelY = p.y - 10 < pad.t + 2 ? p.y + 18 : p.y - 10;
      ctx.fillText(fmtShortValue(mode, p.rec.numericVal), Math.min(Math.max(p.x, pad.l + 16), pad.l + pw - 16), labelY);
    });

    ctx.fillStyle = '#8c8c8c';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(shortDate(recs[0].date), pad.l, h - pad.b + 7);
    if (recs.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(shortDate(recs[recs.length - 1].date), pad.l + pw, h - pad.b + 7);
    }

    chartPoints = pts;
    if (hint) hint.textContent = `${recs.length}건 · ■ 측정 □ 세트 최대 · 초록 테두리 = 개인 최고 · 위로 갈수록 좋은 기록`;
  }

  function drawVolumeChart(mode) {
    const canvas = $('fitnessVolumeChart');
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(canvas, 90);
    const unit = $('fit-volume-unit');
    if (unit) unit.textContent = mode === 'run' ? '일별 총 거리 (km)' : '일별 총 개수 (회)';

    const days = [];
    for (let i = 13; i >= 0; i--) days.push(addDays(today(), -i));
    const logs = getWorkoutLogs().filter((l) => l.mode === mode);
    const vals = days.map((d) => logs
      .filter((l) => l.date === d)
      .reduce((sum, l) => sum + (mode === 'run' ? runStats(l.sets).km : setStats(l.sets).total), 0));
    const max = Math.max(...vals);

    ctx.font = `9px ${FONT}`;
    ctx.textAlign = 'center';
    if (!max) {
      ctx.fillStyle = '#8c8c8c';
      ctx.textBaseline = 'middle';
      ctx.fillText('최근 14일 훈련 기록이 없습니다', w / 2, h / 2);
      return;
    }

    const pad = { l: 4, r: 4, t: 14, b: 16 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const slot = pw / days.length;
    const bw = Math.max(4, slot * 0.62);
    ctx.strokeStyle = '#e0e0e0';
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + ph + 0.5);
    ctx.lineTo(pad.l + pw, pad.t + ph + 0.5);
    ctx.stroke();

    vals.forEach((v, i) => {
      const x = pad.l + slot * i + (slot - bw) / 2;
      const bh = v ? Math.max(2, (v / max) * ph) : 0;
      const isToday = days[i] === today();
      ctx.fillStyle = isToday ? '#0f62fe' : '#a6c8ff';
      ctx.fillRect(x, pad.t + ph - bh, bw, bh);
      if (v && (v === max || isToday)) {
        ctx.fillStyle = '#161616';
        ctx.textBaseline = 'bottom';
        ctx.fillText(mode === 'run' ? v.toFixed(1) : String(v), x + bw / 2, pad.t + ph - bh - 2);
      }
      if (i % 7 === 0 || i === days.length - 1) {
        ctx.fillStyle = '#8c8c8c';
        ctx.textBaseline = 'top';
        ctx.fillText(shortDate(days[i]), x + bw / 2, pad.t + ph + 3);
      }
    });
  }

  function paintRangeButtons() {
    document.querySelectorAll('#fit-chart-range [data-range]').forEach((b) => {
      const active = b.dataset.range === chartRange;
      b.className = `px-2 py-1 ${active ? 'bg-[#161616] text-white' : 'bg-white text-[#525252]'}`;
      b.setAttribute('aria-pressed', String(active));
    });
  }

  function bindChart() {
    const canvas = $('fitnessChart');
    if (canvas) {
      canvas.addEventListener('click', (e) => {
        const tip = $('fit-chart-tip');
        if (!chartPoints.length || !tip) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        let nearest = null;
        let dist = Infinity;
        chartPoints.forEach((p) => {
          const d = Math.hypot(p.x - x, (p.y - y) * 0.5);
          if (d < dist) { dist = d; nearest = p; }
        });
        if (!nearest || dist > 40) return;
        const r = nearest.rec;
        tip.innerHTML = `<span class="font-mono">${r.date}</span> · <strong>${fmtValue(r.mode, r.numericVal)}</strong>`
          + ` · ${resultText(r.mode, r.numericVal)} · ${SOURCE_LABEL[sourceOf(r)]}${r.memo ? ` · ${esc(r.memo)}` : ''}`;
      });
    }
    const range = $('fit-chart-range');
    if (range) {
      range.addEventListener('click', (e) => {
        const b = e.target.closest('[data-range]');
        if (!b) return;
        chartRange = b.dataset.range;
        paintRangeButtons();
        drawRecordChart(viewMode || currentFitnessMode);
      });
    }
  }

  /* ---------- 10. 주간 통계 ---------- */
  function weekTotals(monday) {
    const end = addDays(monday, 6);
    const inWeek = (d) => d >= monday && d <= end;
    const logs = getWorkoutLogs().filter((l) => inWeek(l.date));
    const tests = getSavedRecords().filter((r) => inWeek(r.date) && sourceOf(r) !== 'set');
    const days = new Set(logs.map((l) => l.date).concat(tests.map((r) => r.date)));
    const reps = (mode) => logs.filter((l) => l.mode === mode).reduce((a, l) => a + setStats(l.sets).total, 0);
    const km = logs.filter((l) => l.mode === 'run').reduce((a, l) => a + runStats(l.sets).km, 0);
    return { days: days.size, pushup: reps('pushup'), situp: reps('situp'), km: Math.round(km * 10) / 10, tests: tests.length };
  }

  function renderWeeklyStats() {
    const box = $('fit-weekly-stats');
    if (!box) return;
    const thisMon = mondayOf(today());
    const cur = weekTotals(thisMon);
    const prev = weekTotals(addDays(thisMon, -7));
    const rows = [
      ['훈련한 날', cur.days, prev.days, '일'],
      ['팔굽혀펴기 총 개수', cur.pushup, prev.pushup, '회'],
      ['윗몸일으키기 총 개수', cur.situp, prev.situp, '회'],
      ['달리기 거리', cur.km, prev.km, 'km'],
      ['측정 기록', cur.tests, prev.tests, '건']
    ];
    const delta = (a, b) => {
      const d = Math.round((a - b) * 10) / 10;
      if (!d) return '<span class="text-[#8c8c8c]">±0</span>';
      return d > 0 ? `<span class="text-[#24a148]">+${d}</span>` : `<span class="text-[#da1e28]">${d}</span>`;
    };
    box.innerHTML = `
      <div class="p-3.5 flex justify-between items-center border-b border-[#e0e0e0]">
        <span class="text-xs font-semibold text-[#161616]">주간 훈련 통계</span>
        <span class="text-[10px] font-mono text-[#525252]">이번 주 ${shortDate(thisMon)} ~ ${shortDate(addDays(thisMon, 6))}</span>
      </div>
      <table class="w-full text-xs">
        <thead>
          <tr class="text-[10px] text-[#525252] bg-[#f4f4f4]">
            <th class="text-left font-medium px-3.5 py-1.5">항목</th>
            <th class="text-right font-medium px-2 py-1.5">이번 주</th>
            <th class="text-right font-medium px-2 py-1.5">지난주</th>
            <th class="text-right font-medium px-3.5 py-1.5">증감</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-[#e0e0e0]">${rows.map(([label, a, b, unit]) => `
          <tr>
            <td class="px-3.5 py-2 text-[#161616]">${label}</td>
            <td class="px-2 py-2 text-right font-mono font-semibold">${a}${unit}</td>
            <td class="px-2 py-2 text-right font-mono text-[#525252]">${b}${unit}</td>
            <td class="px-3.5 py-2 text-right font-mono">${delta(a, b)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  /* ---------- 11. 전역 함수 교체 ---------- */
  window.renderFitnessUI = function () {
    const mode = currentFitnessMode;
    // ② 내 기록에서 볼 종목: 탭이 바뀌었거나, 보던 직접 입력 거리 기록이 사라졌으면 기본(3km·해당 종목)으로
    const sameTab = viewMode && (mode === 'run' ? isRunMode(viewMode) : viewMode === mode);
    if (!sameTab || (isCustomRun(viewMode) && !recordsOf(viewMode).length)) viewMode = mode;

    renderOverview();        // 3종목 종합 현황
    paintEntryCard();        // ① 기록하기
    renderMyRecords();       // ② 내 기록 (요약 · 그래프 · 목록 · 최근 훈련)
    renderRoutineBox(mode);  // ③ 이번 주 코치 처방
    renderWeeklyStats();     // ④ 주간 통계
    drawVolumeChart(mode);   //    + 최근 14일 훈련량
    if (window.KAAYCoach && typeof window.KAAYCoach.render === 'function') window.KAAYCoach.render();
  };

  window.drawActualFitnessChart = function () { drawRecordChart(viewMode || currentFitnessMode); };

  const originalUpdateMatrix = window.updateMyPageMatrix;
  window.updateMyPageMatrix = function () {
    originalUpdateMatrix();
    // 저장 당시 등급 대신 현재 프로필(성별·연령) 기준으로 다시 판정
    MODES.forEach((m) => {
      const best = personalBest(m);
      const badge = $(`my-best-${m}-badge`);
      if (best && badge) badge.textContent = gradeOf(m, best.numericVal);
    });
    const home = $('home-best-status');
    const o = overall();
    if (home && o.grade) {
      home.textContent = o.count === 3 ? `종합 ${o.grade}` : `종합 ${o.grade} (${o.count}/3종목)`;
      home.className = 'font-semibold text-sm';
      home.style.color = GRADE_COLOR_DARK[o.grade];
    }
  };

  window.clearMyData = function () {
    if (!confirm('정말로 모든 체력 기록을 초기화하시겠습니까?\n측정 기록과 훈련 세트 일지 모두, 클라우드 보관분까지 삭제됩니다.')) return;
    localStorage.removeItem(STORAGE_KEY);
    syncToIndexedDB([]);
    setWorkoutLogs([]);
    cloud('clearRecords');
    cloud('clearWorkouts');
    draft = null;
    window.updateMyPageMatrix();
    window.renderFitnessUI();
    toast('체력 기록을 모두 초기화했습니다.', 'info');
  };

  window.exportBackupData = function () {
    const records = getSavedRecords();
    const workoutLogs = getWorkoutLogs();
    if (!records.length && !workoutLogs.length) {
      alert('저장된 체력 기록이 없습니다. 먼저 기록을 작성해 주세요.');
      return;
    }
    const data = {
      app: 'KAAY_64',
      version: 2,
      timestamp: new Date().toISOString(),
      records,
      workoutLogs,
      coachSettings: window.KAAYCoach ? window.KAAYCoach.getSettings() : null
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `KAAY_체력기록백업_${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  window.importBackupData = function (event) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (!parsed || !Array.isArray(parsed.records)) { alert('올바른 백업 파일 형식이 아닙니다.'); return; }
        const logs = Array.isArray(parsed.workoutLogs) ? parsed.workoutLogs : [];
        saveRecords(parsed.records);
        if (logs.length) setWorkoutLogs(logs);
        if (parsed.coachSettings && window.KAAYCoach) window.KAAYCoach.importSettings(parsed.coachSettings);
        draft = null;
        window.renderFitnessUI();
        // 로그인 상태면 복원한 기록을 클라우드와 바로 맞춘다
        const auth = window.KAAYAuth;
        if (auth && auth.getCurrentUser && auth.getCurrentUser()) {
          auth.syncFitnessCloud(auth.getCurrentUser());
          if (auth.syncWorkouts) auth.syncWorkouts();
        }
        alert(`복구 완료: 측정 기록 ${parsed.records.length}건, 훈련 일지 ${logs.length}건`);
      } catch (err) {
        alert('파일을 읽는 중 오류가 발생했습니다.');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  };

  /* ---------- 12. 화면 전환: 기록·분석 / 코치 플랜 ---------- */
  function showPane(name) {
    const isCoach = name === 'coach';
    const records = $('fit-pane-records');
    const coach = $('fit-pane-coach');
    if (records) records.classList.toggle('hidden', isCoach);
    if (coach) coach.classList.toggle('hidden', !isCoach);
    [['fit-seg-records', !isCoach], ['fit-seg-coach', isCoach]].forEach(([id, active]) => {
      const b = $(id);
      if (!b) return;
      b.className = `py-2.5 ${active ? 'tab-active' : 'tab-inactive'}`;
      b.setAttribute('aria-pressed', String(active));
    });
    try { localStorage.setItem(PANE_KEY, isCoach ? 'coach' : 'records'); } catch (e) { /* 저장 불가 환경 무시 */ }

    if (isCoach) {
      if (window.KAAYCoach) window.KAAYCoach.render();
    } else {
      // 숨겨져 있던 캔버스는 폭이 0이라 보일 때 다시 그린다
      drawRecordChart(viewMode || currentFitnessMode);
      drawVolumeChart(currentFitnessMode);
    }
  }

  /* 코치 화면 등에서 '기록하기'를 눌렀을 때: 해당 종목의 입력 위치로 이동 */
  function focusRecordEntry(mode, target = 'form') {
    showPane('records');
    entryKind = target === 'workout' ? 'train' : 'test';
    if (mode && mode !== currentFitnessMode) selectFitnessTab(mode);
    else window.renderFitnessUI();
    const card = $('fit-entry-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function bindOverviewAndHistory() {
    const overview = $('fit-overview');
    if (overview) {
      overview.addEventListener('click', (e) => {
        const row = e.target.closest('[data-goto]');
        if (!row) return;
        if (row.dataset.goto !== currentFitnessMode) selectFitnessTab(row.dataset.goto);
        const mine = $('fit-myrecords-card');
        if (mine) mine.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  // 캘린더 '이 날짜에 체력 기록 추가': 그 날짜로 측정 입력을 연다
  window.goToFitnessWithDate = function (dateStr) {
    switchTab('fitness');
    showPane('records');
    const input = $('fitness-input-date');
    if (input) { input.value = dateStr; input.dataset.userModified = 'true'; }
    entryKind = 'test';
    window.renderFitnessUI();
    const card = $('fit-entry-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function bindPaneButtons() {
    const recordsBtn = $('fit-seg-records');
    const coachBtn = $('fit-seg-coach');
    if (recordsBtn) recordsBtn.addEventListener('click', () => showPane('records'));
    if (coachBtn) coachBtn.addEventListener('click', () => showPane('coach'));
  }

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const screen = $('screen-fitness');
      if (screen && !screen.classList.contains('hidden')) {
        drawRecordChart(viewMode || currentFitnessMode);
        drawVolumeChart(currentFitnessMode);
      }
    }, 150);
  }

  function init() {
    bindEntryCard();
    bindMyRecords();
    bindOverviewAndHistory();
    bindChart();
    bindPaneButtons();
    paintRangeButtons();
    window.addEventListener('resize', onResize);
    let pane = 'records';
    try { pane = localStorage.getItem(PANE_KEY) || 'records'; } catch (e) { /* 기본값 사용 */ }
    showPane(pane);
  }

  /* ---------- 13. 다른 모듈(coach.js · auth.js)용 공개 API ---------- */
  window.showFitnessPane = showPane;
  window.KAAYFit = {
    MODES, MODE_LABEL, GRADES, GRADE_BADGE, GRADE_COLOR, WORKOUT_KEY, labelOf,
    $, esc, toast,
    fmtTime, fmtTimeKo, fmtGapSec, fmtValue, fmtShortValue, fmtPace, fmtGap,
    today, parseDate, addDays, mondayOf, shortDate, weekdayKo,
    isBetter, bestValue, thresholds, gradeOf, gapInfo, gapTo,
    recordsOf, sourceOf, personalBest, standing, overall,
    getWorkoutLogs, findLog, focusRecordEntry
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
