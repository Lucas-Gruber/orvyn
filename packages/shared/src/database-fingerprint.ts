// This fingerprint detects stale rendered data at subscription time. It is not
// an authorization token; both records and relation targets are checked again.
export function databaseFingerprint(
  schemaVersion: number,
  records: { pageId: string; version: number }[],
  targets: { id: string; revision?: string }[],
  properties: string[],
) {
  const unique = new Map(
    targets.map((target) => [target.id, target.revision || ""]),
  );
  const value = JSON.stringify([
    schemaVersion,
    records
      .map((record) => [record.pageId, record.version])
      .sort((a, b) =>
        String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0,
      ),
    [...unique].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    [...properties].sort(),
  ]);
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    a = Math.imul(a ^ n, 16777619);
    b = Math.imul(b, 33) ^ n;
  }
  return (
    (a >>> 0).toString(16).padStart(8, "0") +
    (b >>> 0).toString(16).padStart(8, "0")
  );
}
