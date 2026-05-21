import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./global.css";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

function dismissSplash() {
  const splash = document.getElementById("hayba-splash");
  if (!splash) return;
  splash.classList.add("fading");
  setTimeout(() => splash.remove(), 500);
}
// Minimal splash — just the logo + shine. Hold long enough for one
// shine pass (~600ms) then fade out.
window.addEventListener("load", () => setTimeout(dismissSplash, 600));

// Wire up the --hayba-range-progress CSS var on every <input type="range">
// so the track shows a fill from min → current value. WebKit has no native
// equivalent of ::-moz-range-progress, so we emulate via a gradient driven
// by this var. Bound globally via a delegated input listener + a periodic
// rescan for newly-mounted sliders.
function syncRangeProgress(el: HTMLInputElement) {
  const min = parseFloat(el.min || "0");
  const max = parseFloat(el.max || "100");
  const val = parseFloat(el.value || "0");
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--hayba-range-progress", `${pct}%`);
}
function syncAllRanges() {
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(syncRangeProgress);
}
document.addEventListener("input", (e) => {
  const t = e.target as HTMLElement | null;
  if (t && t instanceof HTMLInputElement && t.type === "range") syncRangeProgress(t);
});
// React updates the DOM in microtasks; rAF after mount is enough to catch
// the initial value. Re-run on a slow interval to catch slider remounts.
requestAnimationFrame(syncAllRanges);
setInterval(syncAllRanges, 500);
