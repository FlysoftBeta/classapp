export const STEALTH_INIT_SCRIPT = String.raw`
(() => {
  const defineGetter = (object, name, value) => {
    try {
      Object.defineProperty(object, name, {
        configurable: true,
        get: () => value,
      });
    } catch (_) {}
  };

  try { delete Navigator.prototype.webdriver; } catch (_) {}
  defineGetter(Navigator.prototype, "platform", "Win32");
  defineGetter(Navigator.prototype, "languages", ["zh-CN", "zh", "en-US", "en"]);
  defineGetter(Navigator.prototype, "hardwareConcurrency", 8);
  defineGetter(Navigator.prototype, "deviceMemory", 8);
  defineGetter(Navigator.prototype, "vendor", "Google Inc.");

  const makePlugin = (name, filename, description, mimeTypes) => {
    const plugin = { name, filename, description, length: mimeTypes.length };
    mimeTypes.forEach((mime, index) => {
      plugin[index] = mime;
      plugin[mime.type] = mime;
    });
    plugin.item = (index) => plugin[index] || null;
    plugin.namedItem = (name) => plugin[name] || null;
    plugin[Symbol.iterator] = function* () {
      for (let index = 0; index < plugin.length; index += 1) yield plugin[index];
    };
    Object.defineProperty(plugin, Symbol.toStringTag, { value: "Plugin" });
    return plugin;
  };
  const pdfMimes = [
    { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
    { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" },
  ];
  pdfMimes.forEach((mime) => {
    Object.defineProperty(mime, Symbol.toStringTag, { value: "MimeType" });
  });
  const pluginList = [
    makePlugin("PDF Viewer", "internal-pdf-viewer", "Portable Document Format", pdfMimes),
    makePlugin("Chrome PDF Viewer", "internal-pdf-viewer", "Portable Document Format", pdfMimes),
    makePlugin("Chromium PDF Viewer", "internal-pdf-viewer", "Portable Document Format", pdfMimes),
    makePlugin("Microsoft Edge PDF Viewer", "internal-pdf-viewer", "Portable Document Format", pdfMimes),
    makePlugin("WebKit built-in PDF", "internal-pdf-viewer", "Portable Document Format", pdfMimes),
  ];
  const pluginArray = {
    length: pluginList.length,
    item: (index) => pluginList[index] || null,
    namedItem: (name) => pluginList.find((plugin) => plugin.name === name) || null,
    refresh: () => undefined,
    [Symbol.iterator]: function* () { yield* pluginList; },
  };
  pluginList.forEach((plugin, index) => {
    pluginArray[index] = plugin;
    pluginArray[plugin.name] = plugin;
  });
  Object.defineProperty(pluginArray, Symbol.toStringTag, { value: "PluginArray" });
  const mimeArray = {
    length: pdfMimes.length,
    item: (index) => pdfMimes[index] || null,
    namedItem: (name) => pdfMimes.find((mime) => mime.type === name) || null,
    [Symbol.iterator]: function* () { yield* pdfMimes; },
  };
  pdfMimes.forEach((mime, index) => {
    mimeArray[index] = mime;
    mimeArray[mime.type] = mime;
  });
  Object.defineProperty(mimeArray, Symbol.toStringTag, { value: "MimeTypeArray" });
  defineGetter(Navigator.prototype, "plugins", pluginArray);
  defineGetter(Navigator.prototype, "mimeTypes", mimeArray);

  defineGetter(window, "outerWidth", 1365);
  defineGetter(window, "outerHeight", 980);
  defineGetter(Screen.prototype, "availWidth", 1920);
  defineGetter(Screen.prototype, "availHeight", 1040);

  if (!window.chrome) {
    Object.defineProperty(window, "chrome", {
      configurable: true,
      value: { app: {}, runtime: {} },
    });
  } else if (!window.chrome.runtime) {
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: {},
    });
  }

  if (navigator.permissions && navigator.permissions.query) {
    const nativeQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (parameters) => {
      if (parameters && parameters.name === "notifications") {
        return Promise.resolve({ state: Notification.permission });
      }
      return nativeQuery(parameters);
    };
  }

  const patchWebGL = (prototype) => {
    if (!prototype || !prototype.getParameter) return;
    const nativeGetParameter = prototype.getParameter;
    Object.defineProperty(prototype, "getParameter", {
      configurable: true,
      value(parameter) {
        if (parameter === 37445) return "Google Inc. (Intel)";
        if (parameter === 37446) {
          return "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)";
        }
        return nativeGetParameter.call(this, parameter);
      },
    });
  };
  patchWebGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchWebGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();
`;
