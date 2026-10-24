const C='donkey-v1',F=['/','/index.html','/manifest.json','/icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(F))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x))))));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||e.request.url.includes('/config.js'))return;
e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)))});
