import { startApplication } from "./startup.js";
void startApplication("api", () => import("./application.js"));
