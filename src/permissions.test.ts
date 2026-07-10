import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
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

// A real directory: isUnder canonicalizes existing ancestors, so the scratch
// dir must exist for the research policy to approve anything.
const SCRATCH = mkdtempSync(join(tmpdir(), "pej-vet-scratch-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "pej-vet-outside-"));

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

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
  deniedResearch(`git clone --separate-git-dir /home/user/leak.git https://github.com/a/b ${SCRATCH}/b`);
  deniedResearch(`git clone --separate-git-dir=${SCRATCH}/g https://github.com/a/b ${SCRATCH}/b`); // denied outright

  // Clone flags are allow-listed: config/transport overrides can execute
  // commands before the fetch, and pseudo-URLs invoke remote helpers.
  allowedResearch(`git clone -b main --single-branch https://github.com/a/b ${SCRATCH}/b`);
  deniedResearch(`git clone -c core.sshCommand=touch git@example.com:a/b.git ${SCRATCH}/b`);
  deniedResearch(`git -c core.sshCommand=touch clone https://github.com/a/b ${SCRATCH}/b`); // global opts too
  deniedResearch(`git clone --upload-pack=touch https://github.com/a/b ${SCRATCH}/b`);
  deniedResearch(`git clone ext::evil ${SCRATCH}/b`);
  deniedResearch(`git clone /home/user/somerepo ${SCRATCH}/b`); // local-path source: not a fetch URL

  allowedResearch(`curl -L -o ${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
  allowedResearch(`curl -L --output=${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
  deniedResearch("curl https://example.com/spec.pdf"); // no output file
  deniedResearch("curl -o /etc/cron.d/x https://example.com/x");
  deniedResearch("curl -O https://example.com/spec.pdf"); // writes into the shell cwd
  deniedResearch(`curl --output-dir ${SCRATCH} -O https://example.com/spec.pdf`);
  allowedResearch(`wget -O ${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
  deniedResearch("wget https://example.com/spec.pdf"); // writes into the shell cwd
  deniedResearch(`wget -P ${SCRATCH} https://example.com/spec.pdf`);

  // Downloads are allow-listed: only known non-writing flags pass, so every
  // file-writing flag curl/wget grows is denied by default.
  allowedResearch(`curl -sSL --retry 3 -H 'Accept: application/pdf' -o ${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
  deniedResearch(`curl -o ${SCRATCH}/spec.pdf -D /home/user/headers.txt https://example.com/spec.pdf`);
  deniedResearch(`curl -o ${SCRATCH}/spec.pdf -D ${SCRATCH}/headers.txt https://example.com/x`); // not on the allow-list, even into scratch
  deniedResearch(`curl -o ${SCRATCH}/spec.pdf --trace /home/user/trace.log https://example.com/spec.pdf`);
  deniedResearch(`curl -o ${SCRATCH}/spec.pdf --libcurl /home/user/leak.c https://example.com/spec.pdf`);
  deniedResearch(`curl -o ${SCRATCH}/spec.pdf --stderr /home/user/err.log https://example.com/spec.pdf`);
  deniedResearch(`curl -OJ -o ${SCRATCH}/ok https://example.com/x`); // clustered remote-name flags
  deniedResearch(`curl -o/home/user/evil -o ${SCRATCH}/ok https://example.com/x`); // attached short form
  allowedResearch(`wget -q -O ${SCRATCH}/spec.pdf https://example.com/spec.pdf`);
  deniedResearch(`wget -O ${SCRATCH}/spec.pdf -o /home/user/wget.log https://example.com/spec.pdf`);
  deniedResearch(`wget -o ${SCRATCH}/wget.log https://example.com/spec.pdf`); // log flag isn't the download output

  allowedResearch(`mkdir -p ${SCRATCH}/repos`);
  deniedResearch("mkdir -p out");
});

test("denies command and process substitution in every policy", () => {
  denied("cat $(touch /tmp/x)");
  denied("git log `id`");
  denied("diff <(sort a.txt) <(sort b.txt)");
  deniedExecute("npm test $(rm -rf dist)");
  deniedResearch(`curl -o ${SCRATCH}/f 'https://host/$(touch /tmp/pwned)'`);
});

test("research policy denies env-var prefixes on fetch-capable commands", () => {
  // GIT_TRACE and friends write files wherever the env var points, before
  // the vetted command's own output handling is even reached.
  deniedResearch(`GIT_TRACE=/home/user/leak git clone https://github.com/a/b ${SCRATCH}/b`);
  deniedResearch(`env git clone https://github.com/a/b ${SCRATCH}/b`);
  deniedResearch("GIT_TRACE=/home/user/leak git status"); // read subcommands too
  deniedResearch(`SSLKEYLOGFILE=/home/user/keys.log curl -o ${SCRATCH}/f https://example.com/x`);
  allowedResearch("NODE_ENV=test npm test"); // non-fetch commands keep env prefixes
});

test("research policy denies scratch writes chained after a clone in the same command", () => {
  // All segments are vetted before the first runs, so a clone could plant a
  // symlink that a same-command download would then write through.
  deniedResearch(`git clone https://github.com/a/b ${SCRATCH}/repo && curl -o ${SCRATCH}/repo/docs/spec.pdf https://example.com/spec.pdf`);
  deniedResearch(`git clone https://github.com/a/b ${SCRATCH}/a; git clone https://github.com/c/d ${SCRATCH}/a/sub`);
  deniedResearch(`git clone https://github.com/a/b ${SCRATCH}/repo && mkdir -p ${SCRATCH}/repo/x`);
  // Read-only segments after a clone are fine, as are writes before it.
  allowedResearch(`git clone --depth=1 https://github.com/a/b ${SCRATCH}/b && grep -rn TODO ${SCRATCH}/b`);
  allowedResearch(`mkdir -p ${SCRATCH}/dl && curl -o ${SCRATCH}/dl/spec.pdf https://example.com/spec.pdf`);
});

test("research policy denies writes through symlinks that escape the scratch dir", () => {
  symlinkSync(OUTSIDE, join(SCRATCH, "leak"));
  deniedResearch(`curl -o ${SCRATCH}/leak/spec.pdf https://example.com/spec.pdf`);
  // A not-yet-existing subdirectory of the scratch dir is still fine.
  allowedResearch(`curl -o ${SCRATCH}/newdir/spec.pdf https://example.com/spec.pdf`);
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
