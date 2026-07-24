import "core-js/stable";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "@/client/components/App";
import AppInteractionGuard from "@/client/components/AppInteractionGuard";
import globalCss from "@/client/global.css?inline";
import { configureClientRuntime } from "@/client/api/runtime";
import { transport } from "@/client/lib/remote/transport";
import { updateBundle } from "@/client/lib/bundle";
import { ensureEndpointsReady } from "@/client/lib/loadBalancer";

declare const __BUILD_ID__: string;

async function bootstrap(): Promise<void> {
  const buildId = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
  configureClientRuntime({ buildId });

  // Do not connect or render the stale application until its production
  // bundle has either been confirmed current or replaced and activated.
  await updateBundle(buildId);

  const style = document.createElement("style");
  style.textContent = globalCss;
  document.head.append(style);

  let root = document.getElementById("root");
  if (!root) {
    root = document.createElement("div");
    root.id = "root";
    while (document.body.firstChild)
      document.body.removeChild(document.body.firstChild);
    document.body.appendChild(root);
  }

  transport.start();
  void ensureEndpointsReady();

  createRoot(root).render(
    <React.Fragment>
      <AppInteractionGuard />
      <App />
    </React.Fragment>,
  );
}

void bootstrap();
