export class LoginLimiter {
  #entries = new Map();

  constructor(limit = 8, windowMs = 60_000, maxEntries = 300) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }

  get size() { return this.#entries.size; }

  blocked(code, now) {
    const entry = this.#entries.get(code);
    if (entry && entry.until <= now) {
      this.#entries.delete(code);
      return false;
    }
    return !!entry && entry.count >= this.limit;
  }

  failure(code, now) {
    if (!/^[A-F0-9]{16}$/.test(code)) return;
    for (const [key, entry] of this.#entries) {
      if (entry.until <= now) this.#entries.delete(key);
    }
    const current = this.#entries.get(code);
    if (current) {
      current.count++;
      return;
    }
    if (this.#entries.size >= this.maxEntries) this.#entries.delete(this.#entries.keys().next().value);
    this.#entries.set(code, { count: 1, until: now + this.windowMs });
  }

  success(code) { this.#entries.delete(code); }
}
