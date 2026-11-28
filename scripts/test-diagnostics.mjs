/** CI failures must remain useful without exposing runtime URLs or session tokens. */
export function redactTestDiagnostics(input, env = process.env) {
  const secrets = new Set();
  const remember = (value) => {
    if (typeof value === "string" && value.length >= 6) secrets.add(value);
  };
  for (const [key, value] of Object.entries(env)) {
    if (
      !/PASSWORD|SECRET|TOKEN|(^|_)KEY($|_)|DATABASE_URL|REDIS_URL|SMTP_URL/i.test(
        key,
      )
    )
      continue;
    remember(value);
    try {
      const url = new URL(value);
      remember(url.password);
      remember(decodeURIComponent(url.password));
    } catch {}
  }
  let text = String(input);
  for (const value of [...secrets].sort((a, b) => b.length - a.length))
    text = text.replaceAll(value, "[redacted]");
  // Sessions, integration credentials and invitation receipts can be generated
  // during the test rather than supplied by env.
  return text.replace(/\b(?:orvyn_agent_)?[a-f0-9]{64}\b/gi, "[redacted]");
}
