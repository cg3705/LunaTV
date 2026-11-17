/* MTV 离线 Service Worker
 * - 缓存 /offline 页面及其引用的 /_next/static 脚本、样式（文件名带哈希，可长期缓存）
 * - 没有网络时，打开任何页面都跳到 /offline（离线视频列表）
 * - 不缓存接口和视频；离线视频本身存在 IndexedDB 里
 */
const SHELL_CACHE = 'mtv-offline-shell-v1';
const OFFLINE_PATH = '/offline';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function cacheOfflineShell() {
  const res = await fetch(OFFLINE_PATH, { credentials: 'include', cache: 'no-store' });
  if (!res.ok || res.redirected) return; // 未登录会被重定向到登录页，不缓存
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/html')) return;
  const html = await res.clone().text();
  const assets = Array.from(
    new Set((html.match(/\/_next\/static\/[^"'\s)]+/g) || []).map((u) => u.replace(/\\$/, '')))
  );
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(OFFLINE_PATH, res);
  const keep = new Set([new URL(OFFLINE_PATH, self.location.origin).href]);
  await Promise.all(
    assets.map(async (path) => {
      const url = new URL(path, self.location.origin).href;
      keep.add(url);
      if (await cache.match(url)) return;
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (r.ok) await cache.put(url, r);
      } catch (e) {
        // 忽略单个文件失败
      }
    })
  );
  // 清理旧版本的静态文件
  for (const req of await cache.keys()) {
    if (!keep.has(req.url)) await cache.delete(req);
  }
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'cache-offline-shell') {
    event.waitUntil(cacheOfflineShell().catch(() => undefined));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 带哈希的静态文件：先读缓存
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(req.url);
        return hit || fetch(req);
      })
    );
    return;
  }

  // 页面：优先联网；联网失败时跳到离线页
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          // 在线打开离线页时顺便更新缓存
          if (url.pathname === OFFLINE_PATH && res.ok && !res.redirected) {
            cacheOfflineShell().catch(() => undefined);
          }
          return res;
        } catch (e) {
          const cache = await caches.open(SHELL_CACHE);
          const offline = await cache.match(OFFLINE_PATH);
          if (!offline) throw e;
          if (url.pathname !== OFFLINE_PATH) return Response.redirect(OFFLINE_PATH, 302);
          return offline;
        }
      })()
    );
  }
});
