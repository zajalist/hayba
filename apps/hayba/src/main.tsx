import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./global.css";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

// Splash fade once React has mounted + paint cycles run.
function dismissSplash() {
  const splash = document.getElementById("hayba-splash");
  if (!splash) return;
  splash.classList.add("fading");
  setTimeout(() => splash.remove(), 500);
}
window.addEventListener("load", () => setTimeout(dismissSplash, 350));
