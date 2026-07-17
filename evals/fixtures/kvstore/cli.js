#!/usr/bin/env node
import { Store } from "./store.js";

const file = process.env.KV_FILE ?? "kv.json";
const store = new Store(file);
const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "get": {
    const value = store.get(args[0]);
    if (value === undefined) {
      console.error(`no such key: ${args[0]}`);
      process.exit(1);
    }
    console.log(value);
    break;
  }
  case "set": {
    store.set(args[0], args[1]);
    break;
  }
  case "del": {
    store.delete(args[0]);
    break;
  }
  case "list": {
    for (const key of store.keys()) console.log(key);
    break;
  }
  default: {
    console.error("usage: kv <get|set|del|list> [key] [value]   (store file: $KV_FILE, default kv.json)");
    process.exit(2);
  }
}
