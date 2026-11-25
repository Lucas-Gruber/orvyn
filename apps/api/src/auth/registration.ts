import { domainToASCII } from "node:url";
import { RuntimeConfigurationError } from "@orvyn/shared/server";

export interface RegistrationPolicy {
  enabled: boolean;
  allowedEmailDomains: string[];
}
export class RegistrationConfigurationError extends RuntimeConfigurationError {
  constructor(message: string) {
    super("REGISTRATION_CONFIGURATION_INVALID", message);
  }
}

function canonicalDomain(value: string): string {
  if (/[\s/@:#?\\*%\[\]\u0000-\u001f\u007f]/u.test(value)) return "";
  const domain = domainToASCII(value).toLowerCase();
  if (!domain || domain.length > 253) return "";
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  )
    return "";
  return domain;
}

export function readRegistrationPolicy(
  env: NodeJS.ProcessEnv = process.env,
): RegistrationPolicy {
  const enabled = env.ORVYN_REGISTRATION_ENABLED ?? "true";
  if (enabled !== "true" && enabled !== "false")
    throw new RegistrationConfigurationError(
      "ORVYN_REGISTRATION_ENABLED must be true or false.",
    );
  const configured = env.ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS ?? "";
  const entries = configured === "" ? [] : configured.split(",");
  if (entries.length > 20)
    throw new RegistrationConfigurationError(
      "At most 20 local registration email domains may be configured.",
    );
  const domains = entries.map((entry) => canonicalDomain(entry.trim()));
  if (domains.some((domain) => !domain))
    throw new RegistrationConfigurationError(
      "ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS must contain comma-separated DNS domains without wildcards or URLs.",
    );
  return {
    enabled: enabled === "true",
    allowedEmailDomains: [...new Set(domains)],
  };
}

export function registrationAllowsEmail(
  policy: RegistrationPolicy,
  email: string,
): boolean {
  if (!policy.enabled) return false;
  if (
    email.lastIndexOf("@") < 1 ||
    email.indexOf("@") !== email.lastIndexOf("@")
  )
    return false;
  if (!policy.allowedEmailDomains.length) return true;
  const domain = canonicalDomain(email.slice(email.lastIndexOf("@") + 1));
  return !!domain && policy.allowedEmailDomains.includes(domain);
}
