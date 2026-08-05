// Marker bodies this process already has, so the sweep does not fetch them again.
//
// The sweep answers two questions and they have different costs. Which markers still exist is one
// ListObjectsV2. What each one is about was a GetObject per marker - and that single fact is where
// the body-read cap, the "read 200 of 340 marker bodies" warning and the body_read flag all came
// from. None of those were about correctness; they were about a call being expensive in bulk.
//
// Two of the three writers hand this process the body for free:
//
//   inspector markers   the listener announces them, body included, at the moment it dispatches
//   applier markers     THIS process writes them. It has always known their contents and was
//                       reading them back out of S3 on the next sweep anyway
//
// So the split becomes:
//
//   presence   the listing decides, exactly as before, and it is still what is authoritative
//   contents   this cache, and a GetObject only for what is not in it
//
// A cache miss is a slower answer, never a wrong one. That is what keeps the announcement from
// becoming load-bearing: lose every push and the sweep behaves exactly as it did before this
// existed.
//
// Bounded, because bodies are not small - ten kilobytes is ordinary and a burst is larger. At the
// default of 200 entries the worst case is a few megabytes, and eviction costs one GetObject.

export function makeMarkerBodies({ limit = 200 } = {}) {
  const entries = new Map();

  function key(kind, requestId) {
    return `${kind}:${requestId}`;
  }

  /** Remember a body. Callers pass what they already hold - nothing here fetches. */
  function put(kind, requestId, body, source) {
    const id = key(kind, requestId);
    // Delete before set so insertion order is recency, which is what makes eviction "oldest".
    entries.delete(id);
    entries.set(id, { body, source, at: Date.now() });
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }

  /** The body, or null. Null means fetch it - it does not mean the marker is not there. */
  function get(kind, requestId) {
    return entries.get(key(kind, requestId))?.body ?? null;
  }

  function has(kind, requestId) {
    return entries.has(key(kind, requestId));
  }

  return { put, get, has, size: () => entries.size };
}
