// 로컬 개발용 설정 템플릿
// 1) 이 파일을 config.js 로 복사:  cp config.example.js config.js
// 2) Supabase 대시보드 > Project Settings > API 에서 값을 채움
//    - SUPABASE_URL      : Project URL
//    - SUPABASE_ANON_KEY : anon / public 키 (service_role 키는 절대 넣지 마세요)
// config.js 는 .gitignore 에 등록되어 커밋되지 않습니다.
// 배포(Vercel)에서는 scripts/build.mjs 가 환경변수로 config.js 를 자동 생성합니다.
window.KAAY_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: ''
};
