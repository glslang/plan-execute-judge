import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * JSON-file-backed key-value store. The file holds a flat object of
 * key -> string value; a missing file reads as an empty store.
 */
export class Store {
  constructor(file) {
    this.file = file;
  }

  read() {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, "utf-8"));
  }

  write(data) {
    writeFileSync(this.file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  get(key) {
    const data = this.read();
    return Object.hasOwn(data, key) ? data[key] : undefined;
  }

  set(key, value) {
    const data = this.read();
    data[key] = value;
    this.write(data);
  }

  delete(key) {
    const data = this.read();
    const existed = Object.hasOwn(data, key);
    delete data[key];
    this.write(data);
    return existed;
  }

  keys() {
    return Object.keys(this.read()).sort();
  }
}
