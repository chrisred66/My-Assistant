import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import UsageBall from "./UsageBall";
import DesktopPet from "./DesktopPet";
import { applyTheme, getTheme } from "./lib/theme";

// The desktop usage ball and the desktop pet are extra windows loading index.html#ball / #pet (see tauri.conf.json).
const isBall = window.location.hash === "#ball";
const isPet = window.location.hash === "#pet";
if (isBall) document.documentElement.classList.add("ball-window");
else if (isPet) document.documentElement.classList.add("pet-window");
else applyTheme(getTheme()); // before the first render, so the chosen theme shows without a flash

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isBall ? <UsageBall /> : isPet ? <DesktopPet /> : <App />}</React.StrictMode>,
);
