import { expect as playwrightExpect } from "@playwright/test";
export { chromium } from "@playwright/test";

// Node's test runner does not load a Playwright project configuration. Allow
// functional assertions to include authenticated synchronization and API work
// on shared CI. Explicit timeouts still define tests with tighter deadlines.
export const expect = playwrightExpect.configure({ timeout: 12000 });
