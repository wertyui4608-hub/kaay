/* ==========================================================================
   KAAY 64기 계정 모듈 (로그인 / 회원가입 / 자동 로그인 / 로그아웃)
   - Supabase Auth 사용. 아이디는 내부적으로 `{아이디}@kaay-id.app` 형태로만 변환되며
     화면·오류 문구 어디에도 이메일 개념을 노출하지 않는다.
   - 비밀번호는 Supabase SDK 호출 인자로만 사용한다. 저장·로그·별도 전송 금지.
   - 체력/토익 기록(localStorage + IndexedDB)은 이 모듈이 건드리지 않는다.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- 상수 ---------- */
  var AUTH_EMAIL_DOMAIN = 'kaay-id.app';
  var AUTH_STORAGE_KEY = 'kaay-auth';            // Supabase 세션 저장 키 (접두어)
  var AUTO_LOGIN_FLAG_KEY = 'kaay_auto_login';   // '1' = localStorage 유지, 그 외 = sessionStorage
  var SAVED_USERNAME_KEY = 'kaay_saved_username';
  var USERNAME_RE = /^[a-z0-9_]{4,20}$/;
  var PASSWORD_MIN = 8;
  var PASSWORD_MAX_BYTES = 72;                   // Supabase(bcrypt) 상한
  var NAME_MAX = 20;

  var MSG = {
    loginFailed: '아이디 또는 비밀번호가 올바르지 않습니다',
    duplicateId: '이미 사용 중인 아이디입니다',
    network: '네트워크 연결을 확인한 뒤 다시 시도해 주세요.',
    rateLimited: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    signupGeneric: '가입 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    noLib: '로그인 모듈을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요.',
    noConfig: '서버 설정이 없어 로그인할 수 없습니다. 관리자에게 문의해 주세요.'
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 안전한 Web Storage 접근 (사파리 개인정보 보호 모드 대비) ---------- */
  function safeGet(st, k) { try { return st.getItem(k); } catch (_) { return null; } }
  function safeSet(st, k, v) { try { st.setItem(k, v); } catch (_) { /* noop */ } }
  function safeRemove(st, k) { try { st.removeItem(k); } catch (_) { /* noop */ } }

  function isAutoLoginEnabled() { return safeGet(localStorage, AUTO_LOGIN_FLAG_KEY) === '1'; }

  /* ---------- 자동 로그인용 저장소 라우팅 어댑터 ----------
     로그인 직전에 기록한 AUTO_LOGIN_FLAG 에 따라 세션(refresh token 포함)을
     localStorage(앱을 다시 열어도 유지) 또는 sessionStorage(브라우저 닫으면 삭제)에 쓴다. */
  var routedAuthStorage = {
    getItem: function (key) {
      var v = safeGet(sessionStorage, key);
      return v !== null ? v : safeGet(localStorage, key);
    },
    setItem: function (key, value) {
      if (isAutoLoginEnabled()) {
        safeSet(localStorage, key, value);
        safeRemove(sessionStorage, key);
      } else {
        safeSet(sessionStorage, key, value);
        safeRemove(localStorage, key);
      }
    },
    removeItem: function (key) {
      safeRemove(sessionStorage, key);
      safeRemove(localStorage, key);
    }
  };

  function clearAuthStorage() {
    [window.localStorage, window.sessionStorage].forEach(function (st) {
      try {
        var keys = [];
        for (var i = 0; i < st.length; i++) {
          var k = st.key(i);
          if (k && k.indexOf(AUTH_STORAGE_KEY) === 0) keys.push(k);
        }
        keys.forEach(function (k) { st.removeItem(k); });
      } catch (_) { /* noop */ }
    });
  }

  function readStoredUser() {
    try {
      var raw = routedAuthStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return (obj && (obj.user || (obj.currentSession && obj.currentSession.user))) || null;
    } catch (_) { return null; }
  }

  /* ---------- Supabase 클라이언트 ---------- */
  var cfg = window.KAAY_CONFIG || {};
  var hasConfig = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  var hasLib = !!(window.supabase && typeof window.supabase.createClient === 'function');
  var client = null;

  if (hasConfig && hasLib) {
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: {
        storage: routedAuthStorage,
        storageKey: AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
  }

  function toAuthEmail(username) { return username + '@' + AUTH_EMAIL_DOMAIN; }

  /* ---------- 상태 ---------- */
  var busy = false;
  var appEntered = false;
  var suppressSignOutEvent = false;
  var currentUser = null;
  var signupTouched = {};

  /* ---------- 검증 ---------- */
  function byteLength(s) {
    try { return new TextEncoder().encode(s).length; } catch (_) { return s.length; }
  }
  function validateUsername(v) {
    if (!v) return '아이디를 입력해 주세요.';
    if (!USERNAME_RE.test(v)) return '아이디는 영문 소문자, 숫자, 밑줄(_)만 사용해 4~20자로 입력해 주세요.';
    return '';
  }
  function validatePassword(v) {
    if (!v) return '비밀번호를 입력해 주세요.';
    if (v.length < PASSWORD_MIN) return '비밀번호는 8자 이상이어야 합니다.';
    if (byteLength(v) > PASSWORD_MAX_BYTES) return '비밀번호가 너무 깁니다. 더 짧게 입력해 주세요.';
    return '';
  }
  function validateConfirm(pw, confirm) {
    if (!confirm) return '비밀번호를 한 번 더 입력해 주세요.';
    if (pw !== confirm) return '비밀번호가 일치하지 않습니다.';
    return '';
  }
  function validateName(v) {
    var len = Array.from(v).length;
    if (!len) return '이름을 입력해 주세요.';
    if (len > NAME_MAX) return '이름은 20자 이하로 입력해 주세요.';
    return '';
  }

  /* ---------- 오류 분류 ---------- */
  function isNetworkError(err) {
    if (!err) return false;
    if (err.name === 'AuthRetryableFetchError') return true;
    if (err.status === 0) return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return /failed to fetch|network|load failed/i.test(err.message || '');
  }
  function isRateLimited(err) {
    return !!err && (err.status === 429 || /rate limit/i.test(err.code || '') || /rate limit/i.test(err.message || ''));
  }
  function isDuplicateError(err) {
    if (!err) return false;
    var code = String(err.code || '');
    var msg = String(err.message || '').toLowerCase();
    return code === 'user_already_exists' || code === 'email_exists' ||
      msg.indexOf('already registered') !== -1 || msg.indexOf('already exists') !== -1 ||
      msg.indexOf('database error saving new user') !== -1 || msg.indexOf('duplicate') !== -1;
  }
  function loginErrorMessage(err) {
    if (isNetworkError(err)) return MSG.network;
    if (isRateLimited(err)) return MSG.rateLimited;
    return MSG.loginFailed; // 아이디 존재 여부와 무관하게 단일 문구
  }
  function signupErrorMessage(err) {
    if (isNetworkError(err)) return MSG.network;
    if (isRateLimited(err)) return MSG.rateLimited;
    if (err && err.code === 'weak_password') return '비밀번호가 너무 단순합니다. 다른 비밀번호를 사용해 주세요.';
    if (err && err.code === 'signup_disabled') return '현재 회원가입이 중단되어 있습니다.';
    return MSG.signupGeneric; // 서버 원문(이메일 언급 가능)은 노출하지 않음
  }

  /* ---------- UI 헬퍼 ---------- */
  function setFieldError(inputId, message) {
    var input = $(inputId), err = $(inputId + '-error'), hint = $(inputId + '-hint');
    if (input) {
      input.classList.toggle('is-invalid', !!message);
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
    if (err) { err.textContent = message || ''; err.hidden = !message; }
    if (hint) hint.hidden = !!message;
  }
  function showFormError(id, message) { var el = $(id); if (el) { el.textContent = message; el.hidden = false; } }
  function hideFormError(id) { var el = $(id); if (el) { el.textContent = ''; el.hidden = true; } }

  function setButtonLoading(btn, loading, loadingText) {
    if (!btn) return;
    if (loading) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<span class="kaay-spinner" aria-hidden="true"></span><span></span>';
      btn.lastChild.textContent = loadingText;
    } else {
      btn.removeAttribute('aria-busy');
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  var toastTimer = null;
  function showToast(message) {
    var el = $('kaay-toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    // reflow 후 애니메이션
    void el.offsetWidth;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-visible');
      setTimeout(function () { el.hidden = true; }, 250);
    }, 2600);
  }

  /* ---------- 화면 전환 ---------- */
  var VIEWS = { splash: 'auth-splash', login: 'auth-login-view', signup: 'auth-signup-view' };

  function showView(name) {
    Object.keys(VIEWS).forEach(function (key) {
      var el = $(VIEWS[key]);
      if (el) el.hidden = key !== name;
    });
    var gate = $('auth-gate');
    if (gate) gate.scrollTop = 0;
  }

  function appViewport() { return document.querySelector('.app-viewport'); }

  function showGate(view) {
    var gate = $('auth-gate');
    var app = appViewport();
    if (gate) gate.classList.remove('auth-hidden');
    if (app) { app.inert = true; app.setAttribute('aria-hidden', 'true'); }
    document.body.style.overflow = 'hidden';
    showView(view);
  }

  function hideGate() {
    var gate = $('auth-gate');
    var app = appViewport();
    if (gate) gate.classList.add('auth-hidden');
    if (app) { app.inert = false; app.removeAttribute('aria-hidden'); }
    document.body.style.overflow = '';
  }

  function prepareLoginView(prefillUsername) {
    var savedId = safeGet(localStorage, SAVED_USERNAME_KEY);
    var idInput = $('login-username');
    if (idInput) idInput.value = prefillUsername || savedId || '';
    var pw = $('login-password');
    if (pw) { pw.value = ''; pw.type = 'password'; }
    resetToggle('login-password');
    var saveId = $('login-save-id');
    if (saveId) saveId.checked = !!savedId;
    var auto = $('login-auto');
    if (auto) auto.checked = isAutoLoginEnabled();
    hideFormError('login-error');
  }

  function focusLogin() {
    var idInput = $('login-username');
    var pw = $('login-password');
    if (idInput && idInput.value) { if (pw) pw.focus(); } else if (idInput) { idInput.focus(); }
  }

  function resetSignupForm() {
    var form = $('signup-form');
    if (form) form.reset();
    signupTouched = {};
    ['signup-username', 'signup-password', 'signup-password-confirm', 'signup-name'].forEach(function (id) {
      setFieldError(id, '');
    });
    resetToggle('signup-password');
    resetToggle('signup-password-confirm');
    hideFormError('signup-error');
    updateSignupButton();
  }

  function updateSignupButton() {
    var btn = $('signup-submit');
    var consent = $('signup-consent');
    if (!btn || btn.getAttribute('aria-busy') === 'true') return;
    btn.disabled = busy || !(consent && consent.checked);
  }

  /* ---------- 비밀번호 보기/숨기기 ---------- */
  function resetToggle(inputId) {
    var btn = document.querySelector('[data-pw-target="' + inputId + '"]');
    var input = $(inputId);
    if (input) input.type = 'password';
    if (btn) {
      btn.textContent = '보기';
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', '비밀번호 보기');
    }
  }
  function onTogglePassword(e) {
    var btn = e.currentTarget;
    var input = $(btn.getAttribute('data-pw-target'));
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '숨기기' : '보기';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    btn.setAttribute('aria-label', show ? '비밀번호 숨기기' : '비밀번호 보기');
    input.focus();
  }

  /* ---------- 마이 탭 계정 정보 ---------- */
  function renderAccount(user, profile) {
    var meta = (user && user.user_metadata) || {};
    var email = (user && user.email) || '';
    var username = (profile && profile.username) || meta.username || email.split('@')[0] || '-';
    var name = (profile && profile.name) || meta.name || '-';
    var nameEl = $('account-name');
    var idEl = $('account-username');
    if (nameEl) nameEl.textContent = name;     // textContent: XSS 방지
    if (idEl) idEl.textContent = '@' + username;
  }

  function loadProfile(user) {
    if (!client || !user || navigator.onLine === false) return;
    client.from('profiles').select('username, name').eq('id', user.id).maybeSingle()
      .then(function (res) {
        if (!res.error && res.data && currentUser && currentUser.id === user.id) renderAccount(user, res.data);
      })
      .catch(function () { /* user_metadata 로 이미 표시됨 */ });
  }

  function enterApp(user, opts) {
    currentUser = user;
    appEntered = true;
    renderAccount(user, null);
    hideGate();
    if (opts && opts.goHome && typeof window.switchTab === 'function') {
      window.switchTab('home');
      window.scrollTo(0, 0);
    }
    loadProfile(user);
    syncFitnessCloud(user);
  }

  function returnToLogin(prefillUsername) {
    appEntered = false;
    currentUser = null;
    renderAccount(null, null);
    prepareLoginView(prefillUsername);
    showGate('login');
    focusLogin();
  }

  /* ---------- 로그인 ---------- */
  function handleLogin(e) {
    e.preventDefault();
    if (busy) return;
    hideFormError('login-error');

    if (!client) { showFormError('login-error', hasLib ? MSG.noConfig : MSG.noLib); return; }

    var idInput = $('login-username');
    var pwInput = $('login-password');
    var username = idInput.value.trim().toLowerCase();
    var password = pwInput.value;
    if (!username || !password) {
      showFormError('login-error', '아이디와 비밀번호를 입력해 주세요.');
      (username ? pwInput : idInput).focus();
      return;
    }

    var autoLogin = $('login-auto').checked;
    var saveId = $('login-save-id').checked;
    var btn = $('login-submit');

    busy = true;
    setButtonLoading(btn, true, '로그인 중…');

    // 로그인 시점의 체크 여부로 세션 저장소 결정
    safeSet(localStorage, AUTO_LOGIN_FLAG_KEY, autoLogin ? '1' : '0');
    clearAuthStorage();

    client.auth.signInWithPassword({ email: toAuthEmail(username), password: password })
      .then(function (res) {
        if (res.error || !res.data || !res.data.session) {
          console.warn('[auth] signIn failed:', res.error);
          showFormError('login-error', loginErrorMessage(res.error));
          pwInput.value = '';
          pwInput.focus();
          return;
        }
        if (saveId) safeSet(localStorage, SAVED_USERNAME_KEY, username);
        else safeRemove(localStorage, SAVED_USERNAME_KEY);

        // 폼이 사라지는 시점에 브라우저 비밀번호 관리자가 저장 제안을 띄우므로
        // 입력값은 화면 전환 이후에 비운다.
        enterApp(res.data.session.user, { goHome: true });
        setTimeout(function () { pwInput.value = ''; }, 1500);
      })
      .catch(function (err) {
        console.warn('[auth] signIn exception:', err);
        showFormError('login-error', loginErrorMessage(err));
      })
      .then(function () {
        busy = false;
        setButtonLoading(btn, false);
      });
  }

  /* ---------- 회원가입 ---------- */
  function readSignupValues() {
    return {
      username: $('signup-username').value.trim().toLowerCase(),
      password: $('signup-password').value,
      confirm: $('signup-password-confirm').value,
      name: $('signup-name').value.trim()
    };
  }

  function validateSignupField(id) {
    var v = readSignupValues();
    var msg = '';
    if (id === 'signup-username') msg = validateUsername(v.username);
    else if (id === 'signup-password') msg = validatePassword(v.password);
    else if (id === 'signup-password-confirm') msg = validateConfirm(v.password, v.confirm);
    else if (id === 'signup-name') msg = validateName(v.name);
    setFieldError(id, msg);
    return msg;
  }

  function handleSignup(e) {
    e.preventDefault();
    if (busy) return;
    hideFormError('signup-error');

    var ids = ['signup-username', 'signup-password', 'signup-password-confirm', 'signup-name'];
    var firstInvalid = null;
    ids.forEach(function (id) {
      signupTouched[id] = true;
      if (validateSignupField(id) && !firstInvalid) firstInvalid = id;
    });
    if (firstInvalid) { $(firstInvalid).focus(); return; }

    if (!$('signup-consent').checked) {
      showFormError('signup-error', '개인정보 수집·이용에 동의해 주세요.');
      return;
    }
    if (!client) { showFormError('signup-error', hasLib ? MSG.noConfig : MSG.noLib); return; }

    var v = readSignupValues();
    var btn = $('signup-submit');
    busy = true;
    setButtonLoading(btn, true, '가입 처리 중…');

    // 가입 직후 생기는 임시 세션은 탭 메모리(sessionStorage)에만 두었다가 즉시 제거
    safeSet(localStorage, AUTO_LOGIN_FLAG_KEY, '0');
    suppressSignOutEvent = true;

    client.auth.signUp({
      email: toAuthEmail(v.username),
      password: v.password,
      options: { data: { username: v.username, name: v.name } }
    })
      .then(function (res) {
        var duplicated = isDuplicateError(res.error) ||
          (!res.error && res.data && res.data.user && Array.isArray(res.data.user.identities) && res.data.user.identities.length === 0);

        if (duplicated) {
          setFieldError('signup-username', MSG.duplicateId);
          $('signup-username').focus();
          return null;
        }
        if (res.error) {
          console.warn('[auth] signUp failed:', res.error.code || res.error.status || 'unknown');
          showFormError('signup-error', signupErrorMessage(res.error));
          return null;
        }
        // 가입 성공 → 자동 로그인 방지
        return client.auth.signOut()
          .catch(function () { /* 네트워크 실패해도 로컬 세션은 아래에서 제거 */ })
          .then(function () {
            clearAuthStorage();
            var username = v.username;
            resetSignupForm();
            showToast('가입이 완료되었습니다');
            prepareLoginView(username);
            showView('login');
            focusLogin();
          });
      })
      .catch(function (err) {
        showFormError('signup-error', signupErrorMessage(err));
      })
      .then(function () {
        busy = false;
        suppressSignOutEvent = false;
        setButtonLoading(btn, false);
        updateSignupButton();
      });
  }

  /* ---------- 체력 기록 클라우드 실시간 동기화 (폰 ⇄ PC 멀티 디바이스 연동) ---------- */
  function syncFitnessCloud(user) {
    if (!client || !user || navigator.onLine === false) return;
    var badgeEl = $('cloud-sync-status');
    if (badgeEl) badgeEl.innerText = "동기화 중…";

    client.from('fitness_records').select('*').eq('user_id', user.id).order('date', { ascending: true })
      .then(function (res) {
        if (res.error) {
          console.warn('[CloudSync] fetch error:', res.error);
          if (badgeEl) badgeEl.innerText = "동기화 대기";
          return;
        }

        var cloudRecords = res.data || [];
        var localRecords = [];
        try {
          var raw = localStorage.getItem('KAAY_64_FITNESS_RECORDS');
          localRecords = raw ? JSON.parse(raw) : [];
        } catch (_) {}

        var cloudIdMap = {};
        cloudRecords.forEach(function (r) { cloudIdMap[String(r.id)] = true; });

        // 1. 로컬에만 있는 기록이 있다면 클라우드로 즉시 업로드 (최초 가입 또는 오프라인 기록 보존)
        var unSynced = localRecords.filter(function (lr) {
          return !cloudIdMap[String(lr.id)];
        });

        if (unSynced.length > 0) {
          var toInsert = unSynced.map(function (item) {
            return {
              id: String(item.id),
              user_id: user.id,
              mode: item.mode,
              date: item.date,
              val_display: item.valDisplay,
              numeric_val: item.numericVal,
              grade: item.grade,
              badge_class: item.badgeClass,
              gender: item.gender || null,
              age: item.age || null
            };
          });

          client.from('fitness_records').upsert(toInsert).then(function (upRes) {
            if (upRes.error) console.warn('[CloudSync] local-to-cloud upload error:', upRes.error);
            else console.log('[CloudSync] local records uploaded to cloud:', unSynced.length);
          });
        }

        // 2. 클라우드 레코드를 로컬 포맷으로 변환 및 병합
        var mergedMap = {};
        localRecords.forEach(function (r) { mergedMap[String(r.id)] = r; });
        cloudRecords.forEach(function (r) {
          mergedMap[String(r.id)] = {
            id: r.id,
            mode: r.mode,
            date: r.date,
            valDisplay: r.val_display,
            numericVal: Number(r.numeric_val),
            grade: r.grade,
            badgeClass: r.badge_class,
            gender: r.gender,
            age: r.age
          };
        });

        var finalRecords = Object.values(mergedMap);
        finalRecords.sort(function (a, b) {
          return a.date.localeCompare(b.date);
        });

        // 3. 로컬 캐시 & IndexedDB & UI 일괄 최신화
        try {
          localStorage.setItem('KAAY_64_FITNESS_RECORDS', JSON.stringify(finalRecords));
          if (typeof window.syncToIndexedDB === 'function') window.syncToIndexedDB(finalRecords);
          if (typeof window.updateMyPageMatrix === 'function') window.updateMyPageMatrix();
          if (typeof window.renderFitnessUI === 'function') window.renderFitnessUI();
          if (typeof window.renderCalendarGrid === 'function') window.renderCalendarGrid();
        } catch (_) {}

        if (badgeEl) {
          badgeEl.innerText = "클라우드 동기화 완료";
          badgeEl.className = "px-2 py-0.5 text-[10px] bg-[#0f62fe] text-white font-semibold whitespace-nowrap";
        }
      })
      .catch(function (err) {
        console.warn('[CloudSync] exception:', err);
      });
  }

  function uploadFitnessRecordToCloud(record) {
    if (!client || !currentUser || navigator.onLine === false) return;
    client.from('fitness_records').upsert({
      id: String(record.id),
      user_id: currentUser.id,
      mode: record.mode,
      date: record.date,
      val_display: record.valDisplay,
      numeric_val: record.numericVal,
      grade: record.grade,
      badge_class: record.badgeClass,
      gender: record.gender || null,
      age: record.age || null
    }).then(function (res) {
      if (res.error) console.warn('[CloudSync] upsert error:', res.error);
      else console.log('[CloudSync] record uploaded:', record.id);
    });
  }

  function deleteFitnessRecordFromCloud(recordId) {
    if (!client || !currentUser || navigator.onLine === false) return;
    client.from('fitness_records').delete().eq('id', String(recordId)).eq('user_id', currentUser.id)
      .then(function (res) {
        if (res.error) console.warn('[CloudSync] delete error:', res.error);
        else console.log('[CloudSync] record deleted:', recordId);
      });
  }

  function clearFitnessRecordsFromCloud() {
    if (!client || !currentUser || navigator.onLine === false) return;
    client.from('fitness_records').delete().eq('user_id', currentUser.id)
      .then(function (res) {
        if (res.error) console.warn('[CloudSync] clear error:', res.error);
        else console.log('[CloudSync] all records cleared for user');
      });
  }

  /* ---------- 로그아웃 ---------- */
  function handleLogout() {
    if (busy) return;
    var btn = $('logout-btn');
    busy = true;
    suppressSignOutEvent = true;
    setButtonLoading(btn, true, '로그아웃 중…');

    var done = function () {
      clearAuthStorage();
      // 체력 기록 로컬 캐시 초기화 (계정 간 프라이버시 보호)
      try {
        localStorage.removeItem('KAAY_64_FITNESS_RECORDS');
        if (typeof window.syncToIndexedDB === 'function') window.syncToIndexedDB([]);
        if (typeof window.updateMyPageMatrix === 'function') window.updateMyPageMatrix();
        if (typeof window.renderFitnessUI === 'function') window.renderFitnessUI();
        if (typeof window.renderCalendarGrid === 'function') window.renderCalendarGrid();
      } catch (_) {}

      busy = false;
      suppressSignOutEvent = false;
      setButtonLoading(btn, false);
      returnToLogin();
    };
    if (!client) { done(); return; }
    client.auth.signOut().then(done, done);
  }

  /* ---------- 이벤트 바인딩 ---------- */
  function bindEvents() {
    var loginForm = $('login-form');
    var signupForm = $('signup-form');
    if (loginForm) loginForm.addEventListener('submit', handleLogin);
    if (signupForm) signupForm.addEventListener('submit', handleSignup);

    document.querySelectorAll('[data-auth-view]').forEach(function (el) {
      el.addEventListener('click', function () {
        var view = el.getAttribute('data-auth-view');
        if (busy) return;
        if (view === 'signup') { resetSignupForm(); showView('signup'); $('signup-username').focus(); }
        else { prepareLoginView(); showView('login'); focusLogin(); }
      });
    });

    document.querySelectorAll('[data-pw-target]').forEach(function (btn) {
      btn.addEventListener('click', onTogglePassword);
    });

    ['signup-username', 'signup-password', 'signup-password-confirm', 'signup-name'].forEach(function (id) {
      var input = $(id);
      if (!input) return;
      input.addEventListener('blur', function () {
        if (input.value) signupTouched[id] = true;
        if (signupTouched[id]) validateSignupField(id);
      });
      input.addEventListener('input', function () {
        if (signupTouched[id]) validateSignupField(id);
        if (id === 'signup-password' && signupTouched['signup-password-confirm']) {
          validateSignupField('signup-password-confirm');
        }
      });
    });

    var consent = $('signup-consent');
    if (consent) consent.addEventListener('change', function () {
      if (consent.checked) hideFormError('signup-error');
      updateSignupButton();
    });

    var saveId = $('login-save-id');
    if (saveId) saveId.addEventListener('change', function () {
      if (!saveId.checked) safeRemove(localStorage, SAVED_USERNAME_KEY); // 해제 즉시 삭제
    });

    var logoutBtn = $('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
  }

  /* ---------- 부팅 ---------- */
  function boot() {
    bindEvents();
    prepareLoginView();
    updateSignupButton();
    showGate('splash');

    if (!client) {
      showGate('login');
      showFormError('login-error', hasLib ? MSG.noConfig : MSG.noLib);
      return;
    }

    client.auth.onAuthStateChange(function (event) {
      // 토큰 만료·타 기기 강제 로그아웃 등으로 세션이 사라지면 로그인 화면으로
      if (event === 'SIGNED_OUT' && appEntered && !suppressSignOutEvent) returnToLogin();
    });

    client.auth.getSession()
      .then(function (res) {
        var session = res && res.data && res.data.session;
        if (session && session.user) return enterApp(session.user);
        if (res && res.error && isNetworkError(res.error)) return offlineFallback();
        showGate('login');
        focusLogin();
      })
      .catch(offlineFallback);
  }

  // 오프라인이라 토큰 갱신을 못 한 경우: 기기에 남아 있는 세션으로 입장 (기록은 어차피 기기 로컬)
  function offlineFallback() {
    var user = readStoredUser();
    if (user) return enterApp(user);
    showGate('login');
    if (navigator.onLine === false) showFormError('login-error', '인터넷 연결 후 로그인해 주세요.');
    focusLogin();
  }

  window.KAAYAuth = {
    getClient: function () { return client; },
    getCurrentUser: function () { return currentUser; },
    logout: handleLogout,
    syncFitnessCloud: syncFitnessCloud,
    uploadRecord: uploadFitnessRecordToCloud,
    deleteRecord: deleteFitnessRecordFromCloud,
    clearRecords: clearFitnessRecordsFromCloud
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
