const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { CleanupError, cleanupAgentScratch } = require("./cleanup-agent-scratch.cjs");

const cleanupPath = path.join(__dirname, "cleanup-agent-scratch.cjs");
const CLI_TIMEOUT_MS = 5000;

function makeRun(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-agent-scratch-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "run-1");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "run-metadata.json"), "{}\n");
  const victim = path.join(root, "victim");
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, "precious.txt"), "keep\n");
  return { root, outputDir, victim };
}

function makeAgent(outputDir, agentId) {
  const agentDir = path.join(outputDir, "agents", agentId);
  const scratch = path.join(agentDir, "scratch");
  const artifacts = path.join(agentDir, "artifacts");
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, "evidence.txt"), "retained\n");
  return { agentDir, scratch, artifacts };
}

function runCli(args) {
  return spawnSync(process.execPath, [cleanupPath, ...args], { encoding: "utf8", timeout: CLI_TIMEOUT_MS });
}

test("empties scratch and keeps the scratch directory and artifacts", (t) => {
  const { outputDir } = makeRun(t);
  const { scratch, artifacts } = makeAgent(outputDir, "hunter-01");
  fs.mkdirSync(path.join(scratch, "target", "debug"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "target", "debug", "build.log"), "x\n");
  fs.writeFileSync(path.join(scratch, "notes.txt"), "x\n");
  const readOnly = path.join(scratch, "target", "readonly.bin");
  fs.writeFileSync(readOnly, "x\n");
  fs.chmodSync(readOnly, 0o444);

  const result = cleanupAgentScratch(outputDir, "hunter-01");
  assert.equal(result.removed, 2);
  assert.deepEqual(fs.readdirSync(scratch), []);
  assert.deepEqual(fs.readdirSync(artifacts), ["evidence.txt"]);
});

test("removes a planted symlink without touching its target", (t) => {
  const { outputDir, victim } = makeRun(t);
  const { scratch } = makeAgent(outputDir, "hunter-01");
  fs.symlinkSync(victim, path.join(scratch, "link"));
  fs.mkdirSync(path.join(scratch, "nested"));
  fs.symlinkSync(victim, path.join(scratch, "nested", "link"));

  cleanupAgentScratch(outputDir, "hunter-01");
  assert.deepEqual(fs.readdirSync(scratch), []);
  assert.deepEqual(fs.readdirSync(victim), ["precious.txt"]);
});

test("refuses a symlinked scratch, agent, or agents directory", (t) => {
  for (const linked of ["scratch", "agent", "agents"]) {
    const { outputDir, victim } = makeRun(t);
    if (linked === "agents") {
      fs.symlinkSync(victim, path.join(outputDir, "agents"));
    } else if (linked === "agent") {
      fs.mkdirSync(path.join(outputDir, "agents"));
      fs.symlinkSync(victim, path.join(outputDir, "agents", "hunter-01"));
    } else {
      fs.mkdirSync(path.join(outputDir, "agents", "hunter-01"), { recursive: true });
      fs.symlinkSync(victim, path.join(outputDir, "agents", "hunter-01", "scratch"));
    }
    fs.mkdirSync(path.join(victim, "hunter-01", "scratch"), { recursive: true });
    fs.mkdirSync(path.join(victim, "scratch"), { recursive: true });

    assert.throws(() => cleanupAgentScratch(outputDir, "hunter-01"), CleanupError, linked);
    assert(fs.readdirSync(victim).includes("precious.txt"), linked);
  }
});

test("rejects unsafe agent IDs", (t) => {
  const { outputDir } = makeRun(t);
  for (const agentId of ["", "../victim", "Hunter", "con", "a/b", "-x", "a".repeat(65), ".", ".."]) {
    assert.throws(() => cleanupAgentScratch(outputDir, agentId), CleanupError, JSON.stringify(agentId));
  }
});

test("rejects unsafe output directories", (t) => {
  const { root, outputDir } = makeRun(t);
  const cases = [
    "",
    "relative/run-1",
    `${outputDir}/`,
    `${outputDir}/../run-1`,
    `${root}/./run-1`,
    path.parse(root).root,
    path.join(root, "missing"),
    root,
  ];
  for (const candidate of cases) {
    assert.throws(() => cleanupAgentScratch(candidate, "hunter-01"), CleanupError, JSON.stringify(candidate));
  }
});

test("is a no-op when the agent or its scratch does not exist", (t) => {
  const { outputDir } = makeRun(t);
  assert.equal(cleanupAgentScratch(outputDir, "never-created").removed, 0);
  fs.mkdirSync(path.join(outputDir, "agents", "no-scratch"), { recursive: true });
  assert.equal(cleanupAgentScratch(outputDir, "no-scratch").removed, 0);
});

test("CLI reports success, failure, and usage", (t) => {
  const { outputDir, victim } = makeRun(t);
  const { scratch } = makeAgent(outputDir, "verifier-02");
  fs.writeFileSync(path.join(scratch, "out.txt"), "x\n");

  const ok = runCli([outputDir, "verifier-02"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^PASS: removed 1 entry from /);

  const bad = runCli([victim, "verifier-02"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^FAIL: output directory has no regular run-metadata\.json/);

  const usage = runCli([outputDir]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^Usage: /);
});
