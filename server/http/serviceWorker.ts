export function renderServiceWorker(): string {
  return `"use strict";
var SHELL_URL = "/";
var META_CACHE = "classapp-runtime-meta";
var META_URL = "/__classapp_shell_build__";
var SHELL_CACHE_PREFIX = "classapp-shell-";

function shellCache(buildId) {
  return SHELL_CACHE_PREFIX + buildId;
}

function readActiveBuild() {
  return caches.open(META_CACHE).then(function (cache) {
    return cache.match(META_URL);
  }).then(function (response) {
    return response ? response.text() : null;
  });
}

function stageShell(buildId, response) {
  return caches.open(shellCache(buildId)).then(function (cache) {
    return cache.put(SHELL_URL, response);
  });
}

function activateShell(buildId) {
  return caches.open(shellCache(buildId)).then(function (cache) {
    return cache.match(SHELL_URL);
  }).then(function (response) {
    if (!response) throw new Error("staged shell not found: " + buildId);
    return caches.open(META_CACHE);
  }).then(function (cache) {
    return cache.put(META_URL, new Response(buildId));
  }).then(function () {
    return caches.keys();
  }).then(function (names) {
    return Promise.all(names.map(function (name) {
      if (name.indexOf(SHELL_CACHE_PREFIX) === 0 && name !== shellCache(buildId))
        return caches.delete(name);
    }));
  });
}

function fetchInitialShell() {
  return fetch("/app/manifest.json", { cache: "no-store" })
    .then(function (response) {
      if (!response.ok) throw new Error("manifest " + response.status);
      return response.json();
    })
    .then(function (manifest) {
      if (!manifest.buildId || !manifest.shell || !manifest.shell.url)
        throw new Error("manifest malformed");
      return fetch(manifest.shell.url, { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) throw new Error("shell " + response.status);
          return stageShell(manifest.buildId, response);
        })
        .then(function () { return activateShell(manifest.buildId); });
    });
}

self.addEventListener("install", function (event) {
  event.waitUntil(fetchInitialShell().then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", function (event) {
  var data = event.data || {};
  var reply = function (value) {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(value);
  };
  if (data.type === "classapp:get-shell-build") {
    event.waitUntil(readActiveBuild().then(function (buildId) {
      reply({ ok: true, buildId: buildId });
    }, function (error) {
      reply({ ok: false, error: String(error) });
    }));
    return;
  }
  if (data.type === "classapp:stage-shell") {
    if (typeof data.buildId !== "string" || !data.buildId || typeof data.body !== "string") {
      reply({ ok: false, error: "invalid stage-shell message" });
      return;
    }
    event.waitUntil(stageShell(
      data.buildId,
      new Response(data.body, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    ).then(function () {
      reply({ ok: true });
    }, function (error) {
      reply({ ok: false, error: String(error) });
    }));
    return;
  }
  if (data.type === "classapp:activate-shell") {
    if (typeof data.buildId !== "string" || !data.buildId) {
      reply({ ok: false, error: "invalid activate-shell message" });
      return;
    }
    event.waitUntil(activateShell(data.buildId).then(function () {
      reply({ ok: true });
    }, function (error) {
      reply({ ok: false, error: String(error) });
    }));
  }
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  if (event.request.mode !== "navigate" || url.origin !== self.location.origin)
    return;
  event.respondWith(
    readActiveBuild().then(function (buildId) {
      if (!buildId) return null;
      return caches.open(shellCache(buildId)).then(function (cache) {
        return cache.match(SHELL_URL);
      });
    }).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request);
    }).catch(function () {
      return new Response(
        "<!doctype html><meta charset=utf-8><title>ClassApp</title>" +
          "<p>应用尚未完成离线安装，请联网后重试。</p>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    })
  );
});
`;
}
