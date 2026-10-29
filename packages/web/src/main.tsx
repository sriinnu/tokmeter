import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyMotion, initialMotion } from "./lib/motion.js";
import { applyTheme, initialResolvedTheme } from "./lib/theme.js";

// Stamp theme and motion before the first render so an explicit choice never
// flashes the opposite palette or plays an animation the user turned off.
applyTheme(initialResolvedTheme());
applyMotion(initialMotion());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
