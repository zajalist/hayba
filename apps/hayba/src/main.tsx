import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Bundled fonts — ship with the binary so Tauri doesn't depend on Google
// Fonts CDN reachability at runtime.
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

import "./global.css";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

function dismissSplash() {
  const splash = document.getElementById("hayba-splash");
  if (!splash) return;
  splash.classList.add("fading");
  setTimeout(() => splash.remove(), 500);
}
window.addEventListener("load", () => setTimeout(dismissSplash, 350));
