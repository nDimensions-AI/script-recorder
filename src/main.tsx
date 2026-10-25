import React from "react";
import { createRoot } from "react-dom/client";
import { WebinarApp } from "./webinar/App";
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
document.body.dataset.route = "webinar";
createRoot(root).render(
  <React.StrictMode>
    <WebinarApp />
  </React.StrictMode>,
);
