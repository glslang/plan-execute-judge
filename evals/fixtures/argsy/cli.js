#!/usr/bin/env node
import { parse } from "./src/parse.js";

console.log(JSON.stringify(parse(process.argv.slice(2))));
