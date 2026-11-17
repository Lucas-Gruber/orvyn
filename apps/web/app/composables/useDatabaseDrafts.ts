import type { DatabaseRecord } from "@orvyn/shared";

export interface DatabaseDraft {
  record: DatabaseRecord;
  current: DatabaseRecord;
  values: Record<string, unknown>;
  baseline: Record<string, unknown>;
  ready: string[];
  saving: boolean;
  error: string;
  conflict: boolean;
  reviewed: Record<string, unknown>;
}
const copy = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function useDatabaseDrafts(options: {
  fetch: (id: string) => Promise<DatabaseRecord>;
  patch: (
    id: string,
    version: number,
    values: Record<string, unknown>,
  ) => Promise<DatabaseRecord>;
  saved: (record: DatabaseRecord) => void;
  unavailable: (id: string) => void;
}) {
  const drafts = reactive<Record<string, DatabaseDraft>>({});
  const entries = computed(() => Object.values(drafts));
  let job: Promise<void> | undefined,
    disposed = false;

  function stage(record: DatabaseRecord, values: Record<string, unknown>) {
    if (record.accessRank < 30 || disposed) return;
    const entry = (drafts[record.pageId] ||= {
      record: copy(record),
      current: copy(record),
      values: {},
      baseline: {},
      ready: [],
      saving: false,
      error: "",
      conflict: false,
      reviewed: {},
    });
    for (const [id, value] of Object.entries(values)) {
      if (!Object.hasOwn(entry.values, id))
        entry.baseline[id] = copy(entry.record.values[id]);
      entry.values[id] = copy(value);
      entry.ready = entry.ready.filter((key) => key !== id);
      if (!entry.saving && !entry.error && same(value, entry.baseline[id])) {
        delete entry.values[id];
        delete entry.baseline[id];
      }
    }
    if (!Object.keys(entry.values).length) delete drafts[record.pageId];
  }
  function commit(record: DatabaseRecord, values: Record<string, unknown>) {
    stage(record, values);
    const entry = drafts[record.pageId];
    if (!entry) return;
    entry.ready = [...new Set([...entry.ready, ...Object.keys(values)])];
    // Failed/conflicting writes require the explicit recovery action.
    if (!entry.error) void drain();
  }
  function unavailable(id: string, error: any) {
    if (![401, 404].includes(error.status || error.statusCode)) return false;
    delete drafts[id];
    options.unavailable(id);
    return true;
  }
  function conflict(entry: DatabaseDraft, current: DatabaseRecord) {
    entry.current = copy(current);
    entry.conflict = true;
    entry.reviewed = copy(current.values);
    entry.error =
      "This record changed elsewhere. Review the saved values before keeping your changes.";
  }
  function acknowledge(
    entry: DatabaseDraft,
    saved: DatabaseRecord,
    values: Record<string, unknown>,
  ) {
    entry.record = copy(saved);
    entry.current = copy(saved);
    for (const [id, value] of Object.entries(values)) {
      if (same(entry.values[id], value)) {
        delete entry.values[id];
        entry.ready = entry.ready.filter((key) => key !== id);
      }
    }
    for (const id of Object.keys(entry.values))
      entry.baseline[id] = copy(saved.values[id]);
    options.saved(saved);
    if (!Object.keys(entry.values).length) delete drafts[saved.pageId];
  }
  async function write(entry: DatabaseDraft) {
    entry.saving = true;
    let retries = 0;
    try {
      while (
        !disposed &&
        drafts[entry.record.pageId] === entry &&
        entry.ready.length
      ) {
        const values = Object.fromEntries(
          entry.ready.map((id) => [id, copy(entry.values[id])]),
        );
        try {
          const saved = await options.patch(
            entry.record.pageId,
            entry.record.version,
            values,
          );
          if (disposed || drafts[entry.record.pageId] !== entry) return;
          acknowledge(entry, saved, values);
          retries = 0;
        } catch (e: any) {
          if (unavailable(entry.record.pageId, e)) return;
          if ((e.status || e.statusCode) === 409 && retries++ < 2) {
            const current = await options.fetch(entry.record.pageId);
            if (disposed) return;
            if (
              Object.keys(values).every((id) =>
                same(current.values[id], values[id]),
              )
            ) {
              acknowledge(entry, current, values);
              continue;
            }
            if (
              Object.keys(values).every((id) =>
                same(current.values[id], entry.baseline[id]),
              )
            ) {
              entry.record = copy(current);
              entry.current = copy(current);
              continue;
            }
            conflict(entry, current);
            return;
          }
          throw e;
        }
      }
    } catch (e: any) {
      if (!unavailable(entry.record.pageId, e) && !disposed)
        entry.error =
          e.data?.message ||
          "Changes could not be saved. Your draft is still here.";
    } finally {
      entry.saving = false;
    }
  }
  function drain(): Promise<void> {
    if (job) return job;
    job = (async () => {
      // Yield once so job is assigned even when the queue is empty.
      await nextTick();
      while (!disposed) {
        const entry = entries.value.find(
          (entry) => entry.ready.length && !entry.error,
        );
        if (!entry) break;
        await write(entry);
      }
    })().finally(() => {
      job = undefined;
    });
    return job;
  }
  async function retry(id: string) {
    const entry = drafts[id];
    if (!entry || entry.saving) return;
    try {
      const current = await options.fetch(id);
      if (disposed || drafts[id] !== entry) return;
      const keys = Object.keys(entry.values);
      if (keys.every((key) => same(current.values[key], entry.values[key]))) {
        acknowledge(entry, current, copy(entry.values));
        return;
      }
      const comparison = entry.conflict ? entry.reviewed : entry.baseline;
      if (
        keys.some(
          (key) =>
            !same(current.values[key], comparison[key]) &&
            !same(current.values[key], entry.values[key]),
        )
      ) {
        conflict(entry, current);
        return;
      }
      if (current.accessRank < 30) {
        entry.current = copy(current);
        entry.error =
          "You no longer have permission to save this draft. You can discard it.";
        return;
      }
      entry.record = copy(current);
      entry.current = copy(current);
      for (const key of keys) entry.baseline[key] = copy(current.values[key]);
      entry.ready = keys;
      entry.error = "";
      entry.conflict = false;
      await drain();
    } catch (e: any) {
      if (!unavailable(id, e) && !disposed)
        entry.error =
          e.data?.message ||
          "The saved record could not be checked. Your draft is still here.";
    }
  }
  function discard(id: string) {
    const entry = drafts[id];
    if (!entry || entry.saving) return;
    options.saved(entry.current);
    delete drafts[id];
  }
  async function reconcile() {
    await Promise.all(
      entries.value.map(async (entry) => {
        try {
          const current = await options.fetch(entry.record.pageId);
          if (!disposed && drafts[current.pageId] === entry)
            entry.current = copy(current);
        } catch (e: any) {
          if (!disposed) unavailable(entry.record.pageId, e);
        }
      }),
    );
  }
  async function flush() {
    await nextTick();
    for (const entry of entries.value) entry.ready = Object.keys(entry.values);
    await drain();
    if (entries.value.length)
      throw new Error(
        "Some database changes have not been saved. Retry or discard your drafts before leaving.",
      );
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (!entries.value.length) return;
    event.preventDefault();
    event.returnValue = "";
  }
  onMounted(() => window.addEventListener("beforeunload", beforeUnload));
  onBeforeUnmount(() => {
    disposed = true;
    window.removeEventListener("beforeunload", beforeUnload);
  });
  return {
    drafts,
    entries,
    stage,
    commit,
    retry,
    discard,
    reconcile,
    flush,
    settled: async () => {
      while (job) await job;
    },
    clear: () => {
      for (const id of Object.keys(drafts)) delete drafts[id];
    },
    display: (record: DatabaseRecord): DatabaseRecord => ({
      ...record,
      values: { ...record.values, ...drafts[record.pageId]?.values },
    }),
  };
}
