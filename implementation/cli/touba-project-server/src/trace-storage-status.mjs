export function projectTraceStorageStatus(store, generatedAt = new Date().toISOString()) {
  const base = { schema_version: "touba-trace-storage-status-v1", generated_at: generatedAt };
  if (typeof store?.statistics !== "function") return { ...base, status: "unavailable", storage: null, exports: [] };
  const stats = store.statistics();
  return { ...base, status: stats.bytes >= stats.maxBytes ? "at_limit" : "available",
    storage: { kind: "sqlite", retained_bytes: stats.bytes, limit_bytes: stats.maxBytes,
      segments: stats.segments, events: stats.events },
    exports: stats.exports.map(item => ({ name: item.name, pending_events: item.pendingEvents,
      status: item.pendingEvents ? "pending" : "caught_up" })),
  };
}
