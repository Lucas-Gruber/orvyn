export interface RollupDependencySummary {
  pageId: string;
  digest: string | null;
  weight: number;
  poll: boolean;
}
/** Dense graphs use permission-checked refreshes instead of an unbounded live watch. */
export function rollupDependencyState(summaries: RollupDependencySummary[]) {
  const polling =
    summaries.some((summary) => summary.poll) ||
    summaries.reduce((sum, summary) => sum + summary.weight, 0) > 10000;
  if (polling) return { token: "poll", polling: true };
  const dependencies = summaries
    .filter((summary) => summary.digest)
    .map((summary) => [summary.pageId, summary.digest])
    .sort((left, right) =>
      left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0,
    );
  return {
    token: dependencies.length ? JSON.stringify(dependencies) : undefined,
    polling: false,
  };
}
