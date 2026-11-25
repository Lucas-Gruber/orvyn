/** A profile label is presentation only. Authentication always uses the user ID. */
export interface Person {
  id: string;
  displayName: string | null;
}

export function profileName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 320) return null;
  const name = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (
    !name ||
    [...name].length > 80 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) ||
    /\S+@\S+/u.test(name)
  )
    return null;
  return name;
}

export function generatedProfileName(email: string): string {
  return (
    profileName([...email.split("@")[0]!].slice(0, 80).join("")) || "Member"
  );
}

export function oidcProfileName(
  claims: Record<string, unknown>,
): string | null {
  return profileName(claims.name) || profileName(claims.preferred_username);
}
