const CACHE_NAME = 'kaay-64-v9';
const LOCAL_ASSETS_TO_CACHE = [
  './',
  './index.html',
  './auth.js',
  './fitness-plus.js',
  './coach.js',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './favicon.png',
  './kaay_symbol.png',
  './kaay_emblem.png',
  './kaay_notice.jpg',
  './manifest.json'
];
const CDN_ASSETS_TO_CACHE = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 1. 핵심 로컬 에셋 우선 캐시
      await cache.addAll(LOCAL_ASSETS_TO_CACHE);
      // 2. 고정 버전 CDN 라이브러리 캐시 시도 (오프라인 지원)
      for (const cdnUrl of CDN_ASSETS_TO_CACHE) {
        try {
          await cache.add(cdnUrl);
        } catch (err) {
          console.warn('[SW] CDN 에셋 캐시 건너뜀:', cdnUrl, err);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 1. Supabase API 요청(*.supabase.co)은 절대 캐시하지 않고 항상 네트워크로 직행
  if (url.hostname.endsWith('supabase.co')) {
    return;
  }

  // 2. 같은 출처의 앱 스크립트(.js · config.js 포함)와 manifest 는 네트워크 우선
  //    (업데이트 직후 새 화면 + 옛 스크립트가 섞이지 않도록). 받아오면 캐시를 갱신하고, 오프라인일 때만 캐시 사용
  if (url.origin === self.location.origin && /\.(js|json)$/.test(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
    return;
  }

  // 3. Navigation 요청 (PWA 부팅 / 페이지 이동)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
          return caches.match('./');
        })
    );
    return;
  }

  // 4. 일반 정적 에셋: Cache first, stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }
      return fetch(event.request);
    })
  );
});
