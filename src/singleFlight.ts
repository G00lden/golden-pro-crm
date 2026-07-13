/**
 * Coalesces concurrent reads into one request without caching the result.
 *
 * React StrictMode intentionally mounts effects twice in development. Read
 * endpoints that call a remote dependency should not turn that diagnostic
 * behaviour into duplicate upstream traffic, so callers share only the
 * currently pending promise. A later explicit refresh always starts a new
 * request after the previous one settles.
 */
export function singleFlight<T>(load: () => Promise<T>) {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (inFlight) return inFlight;

    let request: Promise<T>;
    try {
      request = Promise.resolve(load());
    } catch (error) {
      request = Promise.reject(error);
    }
    let shared: Promise<T>;
    shared = request.finally(() => {
      if (inFlight === shared) inFlight = null;
    });
    inFlight = shared;
    return shared;
  };
}

/** Keeps coalescing isolated by identity, so two signed-in users never share a response. */
export function singleFlightByKey<Key, Value>(load: (key: Key) => Promise<Value>) {
  const inFlight = new Map<Key, Promise<Value>>();

  return (key: Key) => {
    const pending = inFlight.get(key);
    if (pending) return pending;

    let request: Promise<Value>;
    try {
      request = Promise.resolve(load(key));
    } catch (error) {
      request = Promise.reject(error);
    }
    let shared: Promise<Value>;
    shared = request.finally(() => {
      if (inFlight.get(key) === shared) inFlight.delete(key);
    });
    inFlight.set(key, shared);
    return shared;
  };
}
