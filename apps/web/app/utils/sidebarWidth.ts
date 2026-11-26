export const sidebarMinWidth = 220;
export const sidebarMaxWidth = 480;

export function preferredSidebarWidth(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, Math.round(value)))
    : null;
}

export function sidebarWidthLimit(viewport: number) {
  return Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, viewport - 360));
}

export function resolvedSidebarWidth(
  preferred: number | null,
  viewport: number,
) {
  const fallback = viewport > 0 && viewport <= 1050 ? 230 : 252;
  return Math.max(
    sidebarMinWidth,
    Math.min(sidebarWidthLimit(viewport || 1440), preferred ?? fallback),
  );
}
