// Chrome supplies Web Locks. Node 22, used by CI, needs an in-process stand-in.
if (!navigator.locks) {
  const pending = new Map();
  Object.defineProperty(navigator, "locks", { value: {
    async request(name, options, callback) {
      if (typeof options === "function") return this.request(name, {}, options);
      const previous = pending.get(name);
      if (previous && options.ifAvailable) return callback(null);
      const { promise, resolve } = Promise.withResolvers();
      pending.set(name, promise);
      try {
        await previous;
        return await callback({ name, mode: "exclusive" });
      } finally {
        if (pending.get(name) === promise) pending.delete(name);
        resolve();
      }
    },
  } });
}
