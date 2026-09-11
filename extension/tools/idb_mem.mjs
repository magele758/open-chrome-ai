/** In-memory IndexedDB stub for Node tests (put/get/delete + upgrade). */

export function installMemoryIndexedDB(global = globalThis) {
  const dbs = new Map();

  function request(result) {
    const r = { result, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => r.onsuccess?.());
    return r;
  }

  function storeFor(data) {
    return {
      get(key) {
        return request(data.get(key));
      },
      put(value, key) {
        data.set(key, typeof structuredClone === "function" ? structuredClone(value) : value);
        return request(undefined);
      },
      delete(key) {
        data.delete(key);
        return request(undefined);
      },
      getAllKeys() {
        return request([...data.keys()]);
      },
    };
  }

  global.indexedDB = {
    open(name) {
      const first = !dbs.has(name);
      if (first) dbs.set(name, new Map());
      const data = dbs.get(name);
      const db = {
        objectStoreNames: { contains: (n) => n === "kv" && !first },
        createObjectStore() {
          return storeFor(data);
        },
        transaction() {
          const tx = {
            oncomplete: null,
            onerror: null,
            objectStore() {
              return storeFor(data);
            },
          };
          queueMicrotask(() => tx.oncomplete?.());
          return tx;
        },
        close() {},
      };
      const r = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        if (first) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };

  return {
    get(key, db = "pagelens-data") {
      return dbs.get(db)?.get(key);
    },
    has(key, db = "pagelens-data") {
      return dbs.get(db)?.has(key) === true;
    },
    keys(prefix = "", db = "pagelens-data") {
      return [...(dbs.get(db)?.keys() || [])].filter((k) => String(k).startsWith(prefix));
    },
  };
}
