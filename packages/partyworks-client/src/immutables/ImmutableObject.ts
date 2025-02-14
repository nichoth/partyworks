export class ImmutableObject<T extends object> {
  private cachedObject: T | undefined;
  private data: T;

  constructor(data: T) {
    this.data = Object.freeze(data);
  }

  private invalidateCache() {
    this.cachedObject = undefined;
  }

  private _toImmutable(): T {
    return this.data;
  }

  get current() {
    if (!this.cachedObject) this.cachedObject = this._toImmutable();
    return this.cachedObject;
  }

  //sub key level partial updates :/
  partialSet<K extends keyof T>(key: K, value: Partial<T[K]>) {
    // If the key doesn't exist in the object, create it with the provided value.
    if (!(key in this.data)) {
      const updatedData = { ...this.data, [key]: value } as T;
      this.data = Object.freeze(updatedData);
    } else {
      let subkeyData: any;

      if (
        typeof value === "number" ||
        typeof value === "string" ||
        typeof value === "boolean"
      ) {
        subkeyData = value;
      } else if (Array.isArray(value)) {
        if (Array.isArray(this.data[key])) {
          subkeyData = [...((this.data[key] || []) as any), ...value] as T[K];
        } else {
          subkeyData = value;
        }
      } else {
        // If the key exists, update the subkey(s) within it.
        subkeyData = { ...(this.data[key] || {}), ...value } as T[K];
      }

      const updatedData = { ...this.data, [key]: subkeyData } as T;
      this.data = Object.freeze(updatedData);
    }
    this.invalidateCache();
  }

  set(data: Partial<T>) {
    this.data = Object.freeze({ ...this.data, ...data });
    this.invalidateCache();
  }
}
