import { test } from "node:test";
import assert from "node:assert/strict";
import { vetReadOnlyCommand } from "./permissions.js";

function allowed(command: string) {
  const v = vetReadOnlyCommand(command);
  assert.equal(v.ok, true, `expected allowed: ${command}${v.ok ? "" : ` (denied: ${v.reason})`}`);
}

function denied(command: string) {
  const v = vetReadOnlyCommand(command);
  assert.equal(v.ok, false, `expected denied: ${command}`);
}

test("allows read and inspection commands", () => {
  allowed("git diff");
  allowed("git diff --stat abc123");
  allowed("git status --porcelain");
  allowed("git log --oneline -20");
  allowed("git -C sub diff");
  allowed("grep -rn TODO src");
  allowed("ls -la");
  allowed("cat package.json | head -50");
  allowed("find . -name '*.ts'");
});

test("allows running tests and builds", () => {
  allowed("npm test");
  allowed("npm run build");
  allowed("npx vitest run");
  allowed("pytest tests/ -k empty_input");
  allowed("cargo test");
  allowed("node dist/index.js --help 2>&1 | head");
});

test("denies git subcommands that write", () => {
  denied("git add .");
  denied("git commit -m done");
  denied("git checkout .");
  denied("git restore src/a.ts");
  denied("git reset --hard");
  denied("git stash");
  denied("git push origin main");
  denied("git clean -fd");
  denied("git -C sub add .");
  denied("git config user.name evil"); // write form
  allowed("git config user.name"); // read form
});

test("denies file mutation commands", () => {
  denied("rm -rf dist");
  denied("mv a.ts b.ts");
  denied("cp a.ts b.ts");
  denied("touch marker");
  denied("mkdir -p out");
  denied("chmod +x script.sh");
  denied("sed -i s/a/b/ file.ts");
  allowed("sed s/a/b/ file.ts"); // non-in-place sed only prints
  denied("/bin/rm x"); // path prefix doesn't hide the command
  denied("git diff && rm x"); // every chained segment is vetted
});

test("denies output redirection except fd dups and the null device", () => {
  denied("echo hi > file.txt");
  denied("git diff >> notes.md");
  allowed("npm test 2>&1");
  allowed("npm test > /dev/null");
  allowed("git status 2>/dev/null");
});

test("denies dependency mutation and network fetches", () => {
  denied("npm install lodash");
  denied("npm i");
  denied("pnpm add zod");
  denied("pip install requests");
  denied("curl https://example.com");
  denied("wget https://example.com/x.sh");
  allowed("npm ls zod");
});
