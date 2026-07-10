import { test } from "node:test";
import assert from "node:assert/strict";
import { vetExecuteCommand, vetReadOnlyCommand, vetResearchCommand } from "./permissions.js";

function allowed(command: string) {
  const v = vetReadOnlyCommand(command);
  assert.equal(v.ok, true, `expected allowed: ${command}${v.ok ? "" : ` (denied: ${v.reason})`}`);
}

function denied(command: string) {
  const v = vetReadOnlyCommand(command);
  assert.equal(v.ok, false, `expected denied: ${command}`);
}

const SCRATCH = "/tmp/pej-research-abc123";

function allowedResearch(command: string) {
  const v = vetResearchCommand(command, SCRATCH);
  assert.equal(v.ok, true, `expected research allowed: ${command}${v.ok ? "" : ` (denied: ${v.reason})`}`);
}

function deniedResearch(command: string) {
  const v = vetResearchCommand(command, SCRATCH);
  assert.equal(v.ok, false, `expected research denied: ${command}`);
}

function allowedExecute(command: string) {
  const v = vetExecuteCommand(command);
  assert.equal(v.ok, true, `expected execute allowed: ${command}${v.ok ? "" : ` (denied: ${v.reason})`}`);
}

function deniedExecute(command: string) {
  const v = vetExecuteCommand(command);
  assert.equal(v.ok, false, `expected execute denied: ${command}`);
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

test("research policy allows clones and downloads only into the scratch dir", () => {
  allowedResearch(`git clone --depth=1 https://github.com/a/b ${SCRATCH}/b`);
  allowedResearch(`git clone https://github.com/a/b ${SCRATCH}/repos/b && grep -rn TODO ${SCRATCH}/repos/b`);
  deniedResearch("git clone https://github.com/a/b"); // no dest -> clones into the target tree
  deniedResearch("git clone https://github.com/a/b b"); // relative dest is outside the scratch dir
  deniedResearch("git clone https://github.com/a/b /home/user/b");
  deniedResearch(`git clone https://github.com/a/b ${SCRATCH}/../escape`); // normalizes outside

  allowedResearch(`curl -L -o ${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
  allowedResearch(`curl -L --output=${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
  deniedResearch("curl https://example.com/spec.pdf"); // no output file
  deniedResearch("curl -o /etc/cron.d/x https://example.com/x");
  deniedResearch("curl -O https://example.com/spec.pdf"); // writes into the shell cwd
  deniedResearch(`curl --output-dir ${SCRATCH} -O https://example.com/spec.pdf`);
  allowedResearch(`wget -O ${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
  deniedResearch("wget https://example.com/spec.pdf"); // writes into the shell cwd
  deniedResearch(`wget -P ${SCRATCH} https://example.com/spec.pdf`);

  allowedResearch(`mkdir -p ${SCRATCH}/repos`);
  deniedResearch("mkdir -p out");
});

test("research policy keeps every other mutation rule", () => {
  deniedResearch("rm -rf dist");
  deniedResearch("git add .");
  deniedResearch("git commit -m done");
  deniedResearch("npm install lodash");
  deniedResearch("sed -i s/a/b/ file.ts");
  deniedResearch(`echo hi > ${SCRATCH}/notes.txt`); // redirection stays denied, even into scratch
  deniedResearch(`git clone https://x ${SCRATCH}/b && rm -rf src`); // chained segments still vetted
  allowedResearch("git log --oneline -20");
  allowedResearch("npm test");
});

test("read-only and execute policies still deny fetches even with scratch-dir paths", () => {
  denied(`git clone https://github.com/a/b ${SCRATCH}/b`);
  denied(`curl -o ${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
  deniedExecute(`git clone https://github.com/a/b ${SCRATCH}/b`);
  deniedExecute(`curl -o ${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
});

test("execute Bash policy allows checks but denies shell mutation", () => {
  for (const command of ["git diff", "git status", "npm test", "npm run build", "npx vitest run", "pytest", "cargo test"]) {
    allowedExecute(command);
  }

  for (const command of [
    "git add .",
    "git commit -m done",
    "git checkout .",
    "git stash",
    "npm install",
    "curl https://example.com",
    "rm -rf dist",
    "sed -i s/a/b/ file.ts",
    "echo hi > file.txt",
  ]) {
    deniedExecute(command);
  }
});
