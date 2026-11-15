import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
export const { Pool } = require("pg");
export const base = process.env.TEST_URL || "http://127.0.0.1:3000";
export async function request(
  path,
  {
    method = "GET",
    body,
    cookie,
    origin = process.env.TEST_ORIGIN || "http://localhost:3000",
  } = {},
) {
  const response = await fetch(base + "/api/v1/" + path, {
    method,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { response, data };
}
export const sessionCookie = (response) =>
  response.headers
    .getSetCookie()
    .find((c) => c.startsWith("orvyn_session="))
    ?.split(";")[0];
export async function waitForMail(email, subject) {
  const mailbox = process.env.TEST_MAIL_URL || "http://127.0.0.1:8025";
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const { messages } = await (
      await fetch(mailbox + "/api/v1/messages")
    ).json();
    const message = messages.find(
      (m) => m.To.some((t) => t.Address === email) && m.Subject === subject,
    );
    if (message)
      return await (
        await fetch(mailbox + "/api/v1/message/" + message.ID)
      ).json();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail("Expected SMTP message was not delivered");
}
export function emailToken(message) {
  const link = message.Text.match(/http[^\s]+/)[0];
  return new URLSearchParams(new URL(link).hash.slice(1)).get("token");
}
