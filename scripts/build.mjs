#!/usr/bin/env node
// Vercel 빌드 스크립트 (의존성 없음, Node 18+)
// - 공개할 정적 파일만 dist/ 로 복사 (scripts/, supabase/ 등은 배포되지 않음)
// - 환경변수 SUPABASE_URL / SUPABASE_ANON_KEY 로 dist/config.js 생성
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

const PUBLIC_ENTRIES = [
  'index.html',
  'auth.js',
  'sw.js',
  'manifest.json',
  'kaay_symbol.png',
  'kaay_emblem.png',
  'kaay_notice.jpg',
  'fitness_criteria.jpg',
  'toeic_files'
];

const url = (process.env.SUPABASE_URL || '').trim();
const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!url || !anonKey) {
  console.error('[build] SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다. Vercel > Settings > Environment Variables 에 등록하세요.');
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
  console.error('[build] SUPABASE_URL 형식이 올바르지 않습니다. 예: https://abcd1234.supabase.co');
  process.exit(1);
}
// service_role 키 실수 방지: JWT payload 의 role 확인
try {
  const payload = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url').toString('utf8'));
  if (payload.role === 'service_role') {
    console.error('[build] SUPABASE_ANON_KEY 에 service_role 키가 들어 있습니다. anon(public) 키로 바꾸세요.');
    process.exit(1);
  }
} catch {
  // 새 형식(sb_publishable_...) 키는 JWT 가 아니므로 통과. secret 키는 차단.
  if (anonKey.startsWith('sb_secret_')) {
    console.error('[build] secret 키가 들어 있습니다. publishable(anon) 키로 바꾸세요.');
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const entry of PUBLIC_ENTRIES) {
  const src = join(root, entry);
  if (!existsSync(src)) {
    console.warn(`[build] 건너뜀 (없음): ${entry}`);
    continue;
  }
  cpSync(src, join(out, entry), { recursive: true });
}

writeFileSync(
  join(out, 'config.js'),
  `window.KAAY_CONFIG = ${JSON.stringify({ SUPABASE_URL: url.replace(/\/$/, ''), SUPABASE_ANON_KEY: anonKey })};\n`
);

console.log('[build] dist/ 생성 완료 (config.js 포함)');
