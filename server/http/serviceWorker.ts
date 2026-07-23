export function renderServiceWorker(buildId: string): string {
  const cacheName = JSON.stringify(`classapp-shell-${buildId}`);
  return `"use strict";
var SHELL_CACHE = ${cacheName};
var SHELL_URL = "/";

self.addEventListener("install", function (event) {
  event.waitUntil(
    fetch(SHELL_URL, { cache: "reload" })
      .then(function (response) {
        if (!response.ok) throw new Error("shell " + response.status);
        return caches.open(SHELL_CACHE).then(function (cache) {
          return cache.put(SHELL_URL, response);
        });
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (name) {
          if (name.indexOf("classapp-shell-") === 0 && name !== SHELL_CACHE)
            return caches.delete(name);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  if (event.request.mode !== "navigate" || url.origin !== self.location.origin)
    return;
  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        if (response.ok) {
          var copy = response.clone();
          event.waitUntil(
            caches.open(SHELL_CACHE).then(function (cache) {
              return cache.put(SHELL_URL, copy);
            })
          );
        }
        return response;
      })
      .catch(function () {
        return caches.match(SHELL_URL).then(function (response) {
          if (response) return response;
          return new Response(
            "<!doctype html><meta charset=utf-8><title>ClassApp</title>" +
              "<p>应用尚未完成离线安装，请联网后重试。</p>",
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        });
      })
  );
});
`;
}
