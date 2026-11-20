// GFM-style anchors must reserve generated suffixes as well as authored names.
// Import and export share this state so repeated labels cannot retarget links.
export function markdownSlugger() {
  const used = new Set<string>(),
    counts = new Map<string, number>();
  return (value: string) => {
    const base = value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    let index = counts.get(base) || 0,
      candidate = index ? base + "-" + index : base;
    while (used.has(candidate)) candidate = base + "-" + ++index;
    counts.set(base, index + 1);
    used.add(candidate);
    return candidate;
  };
}
