import { startApplication } from "./startup.js";
void startApplication("worker", () => import("./maintenance.js"));
