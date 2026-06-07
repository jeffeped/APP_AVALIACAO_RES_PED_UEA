// ResidPed UEA – Service Worker
// Versão do cache: incrementar ao fazer atualizações
const CACHE_NAME = 'residped-uea-v1';
const OFFLINE_URL = './index.html';

// Arquivos essenciais para funcionar offline
const ASSETS_TO_CACHE = [
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&family=Montserrat+Alternates:wght@700&display=swap'
];

// ──────────────────────────────────────────
// INSTALL – pré-cache dos assets essenciais
// ──────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Instalando ResidPed UEA v1...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Cacheando assets essenciais');
      return cache.addAll(ASSETS_TO_CACHE.map(url => new Request(url, { cache: 'reload' })));
    }).then(() => {
      console.log('[SW] Instalação concluída');
      return self.skipWaiting(); // Ativa imediatamente
    }).catch(err => {
      console.warn('[SW] Erro no install (possivelmente offline):', err);
      return self.skipWaiting();
    })
  );
});

// ──────────────────────────────────────────
// ACTIVATE – limpa caches antigos
// ──────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Ativando...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Removendo cache antigo:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      console.log('[SW] Ativo e controlando todas as abas');
      return self.clients.claim();
    })
  );
});

// ──────────────────────────────────────────
// FETCH – estratégia Cache First + Network Fallback
// ──────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora requests não-GET e cross-origin não-essenciais
  if (request.method !== 'GET') return;
  if (url.origin !== location.origin && !url.href.includes('fonts.goog')) return;

  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        // Retorna do cache E atualiza em background (stale-while-revalidate)
        const fetchPromise = fetch(request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const cloned = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, cloned));
          }
          return networkResponse;
        }).catch(() => {}); // Silencia erros de rede
        return cachedResponse;
      }

      // Não está no cache – busca na rede
      return fetch(request).then(networkResponse => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'error') {
          return networkResponse;
        }
        // Cacheia para uso offline futuro
        const cloned = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, cloned));
        return networkResponse;
      }).catch(() => {
        // Offline e não está no cache – retorna o app principal
        return caches.match(OFFLINE_URL);
      });
    })
  );
});

// ──────────────────────────────────────────
// MESSAGE – comunicação com o app
// ──────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
});
