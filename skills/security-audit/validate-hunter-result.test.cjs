const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { canonicalCoverageId } = require("./validate-coverage-ledger.cjs");
const { validateResultDocument } = require("./validate-hunter-result.cjs");

const validatorPath = path.join(__dirname, "validate-hunter-result.cjs");
const AGENT = "hunter-1";
const CONTROL_BYTES = [Buffer.from([0x1b]), Buffer.from([0x07]), Buffer.from("\u0085"), Buffer.from("\u202e")];

function ledgerUnit(surface, overrides = {}) {
  const canonicalRefs = {
    surface,
    boundary: "src/authz.ts#requireOwner",
    subsystem: "packages/api",
    attack_class: "ATTACK-CLASSES.md#Access control",
  };
  return {
    coverage_id: canonicalCoverageId(canonicalRefs),
    canonical_refs: canonicalRefs,
    surface,
    boundary: "Object ownership",
    subsystem: "API",
    attack_class: "Access control",
    starting_paths: ["src/router.ts", "src/authz.ts"],
    ordinary_attack_class_block: "ATTACK-CLASSES.md#Access control",
    selected_companion_blocks: [],
    excluded_blocks: [],
    prior_status: "new",
    attempts: [],
    wave: 1,
    status: "in_progress",
    agent_id: AGENT,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: [],
    ...overrides,
  };
}

function check(overrides = {}) {
  return {
    agent_id: AGENT,
    reviewed_paths: ["src/router.ts"],
    invariant: "The route checks object ownership.",
    method: "source",
    result: "The owner check applies before the update.",
    artifact: null,
    ...overrides,
  };
}

function unitResult(coverageId, disposition = "covered", overrides = {}) {
  return {
    coverage_id: coverageId,
    disposition,
    reviewed_paths: ["src/router.ts"],
    checks: [check()],
    candidate_fingerprints: [],
    unresolved: [],
    ...overrides,
  };
}

function candidate(fingerprint = "src-handler-missing-check") {
  return {
    proposed_verdict: "needs_validation",
    fingerprint,
    title: "Missing ownership check",
    description: "An attacker may reach another object's operation.",
    claimed_root_cause: "The handler omits the ownership check.",
    trace: [{ kind: "entrypoint", file: "src/handler.c", line: 10, scope: "handle", description: "Attacker-controlled input arrives." }],
    evidence: [{ file: "src/handler.c", line: 12, description: "The operation has no owner check." }],
    blockers: ["The bounded local observation is unavailable."],
    validation_plan: { local: "Use a dummy owner and a bounded local fixture." },
  };
}

function fixture() {
  const ledger = [
    ledgerUnit("src/covered.ts#covered"),
    ledgerUnit("src/candidate.ts#candidate"),
    ledgerUnit("src/blocked.ts#blocked"),
  ];
  const result = {
    units: [
      unitResult(ledger[0].coverage_id),
      unitResult(ledger[1].coverage_id, "candidate", { candidate_fingerprints: ["src-handler-missing-check"] }),
      unitResult(ledger[2].coverage_id, "blocked", { unresolved: ["Deployment policy is unavailable."] }),
    ],
    candidates: [candidate()],
    hardening: ["Document the existing control."],
    uncovered: [],
  };
  ledger.sort((left, right) => left.coverage_id.localeCompare(right.coverage_id));
  return { ledger, result };
}

function errorsFor(ledger, result) {
  return validateResultDocument(ledger, AGENT, result);
}

function runCli(ledger, result, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "validate-hunter-result-"));
  const ledgerPath = path.join(directory, "coverage-ledger.json");
  const resultPath = path.join(directory, "result.json");
  const ledgerText = typeof ledger === "string" ? ledger : JSON.stringify(ledger);
  const resultText = typeof result === "string" ? result : JSON.stringify(result);
  fs.writeFileSync(ledgerPath, ledgerText);
  fs.writeFileSync(resultPath, resultText);
  try {
    const completed = spawnSync(process.execPath, [validatorPath, ledgerPath, AGENT, resultPath], {
      encoding: "utf8",
      timeout: options.timeout || 5000,
    });
    return { completed, ledgerText, resultText, afterText: fs.readFileSync(resultPath, "utf8") };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

test("accepts covered, candidate, and blocked units", () => {
  const { ledger, result } = fixture();
  assert.deepEqual(errorsFor(ledger, result), []);
});

test("rejects missing, duplicate, and unexpected coverage IDs", () => {
  const missing = fixture();
  missing.result.units.shift();
  assert(errorsFor(missing.ledger, missing.result).some((error) => error.includes("missing assigned coverage ID")));

  const duplicate = fixture();
  duplicate.result.units.push(duplicate.result.units[0]);
  assert(errorsFor(duplicate.ledger, duplicate.result).some((error) => error.includes("duplicate assignment")));

  const unexpected = fixture();
  unexpected.result.units[0].coverage_id = "unexpected";
  assert(errorsFor(unexpected.ledger, unexpected.result).some((error) => error.includes("absent from this hunter's assignments")));
});

test("rejects wrong check owners and unsafe artifacts", () => {
  const wrongOwner = fixture();
  wrongOwner.result.units[0].checks[0].agent_id = "hunter-2";
  assert(errorsFor(wrongOwner.ledger, wrongOwner.result).some((error) => error.includes("expected hunter")));

  const sourceArtifact = fixture();
  sourceArtifact.result.units[0].checks[0].artifact = "agents/hunter-1/artifacts/result.txt";
  assert(errorsFor(sourceArtifact.ledger, sourceArtifact.result).some((error) => error.includes("source check must use null")));

  const wrongLocalOwner = fixture();
  wrongLocalOwner.result.units[0].checks[0].method = "local";
  wrongLocalOwner.result.units[0].checks[0].artifact = "agents/hunter-2/artifacts/result.txt";
  assert(errorsFor(wrongLocalOwner.ledger, wrongLocalOwner.result).some((error) => error.includes("parent-promoted artifact")));
});

test("rejects reviewed-path union mismatches and unsafe paths", () => {
  const missingOwner = fixture();
  missingOwner.result.units[0].reviewed_paths.push("src/authz.ts");
  assert(errorsFor(missingOwner.ledger, missingOwner.result).some((error) => error.includes("has no owning check")));

  const missingAggregate = fixture();
  missingAggregate.result.units[0].checks[0].reviewed_paths.push("src/authz.ts");
  assert(errorsFor(missingAggregate.ledger, missingAggregate.result).some((error) => error.includes("is absent")));

  const unsafe = fixture();
  unsafe.result.units[0].checks[0].reviewed_paths = ["../secret"];
  unsafe.result.units[0].reviewed_paths = ["../secret"];
  assert(errorsFor(unsafe.ledger, unsafe.result).some((error) => error.includes("repository-relative path")));
});

test("enforces covered, candidate, and blocked invariants", () => {
  const covered = fixture();
  covered.result.units[0].candidate_fingerprints = ["src-handler-missing-check"];
  assert(errorsFor(covered.ledger, covered.result).some((error) => error.includes("covered unit must be empty")));

  const blocked = fixture();
  blocked.result.units[2].unresolved = [];
  assert(errorsFor(blocked.ledger, blocked.result).some((error) => error.includes("blocked unit must not be empty")));

  const noFingerprint = fixture();
  noFingerprint.result.units[1].candidate_fingerprints = [];
  assert(errorsFor(noFingerprint.ledger, noFingerprint.result).some((error) => error.includes("candidate unit must not be empty")));
});

test("rejects missing, orphan, and duplicate candidate records", () => {
  const missing = fixture();
  missing.result.candidates = [];
  assert(errorsFor(missing.ledger, missing.result).some((error) => error.includes("missing record")));

  const orphan = fixture();
  orphan.result.candidates.push(candidate("src-orphan"));
  assert(errorsFor(orphan.ledger, orphan.result).some((error) => error.includes("not linked by any candidate unit")));

  const duplicate = fixture();
  duplicate.result.candidates.push(duplicate.result.candidates[0]);
  assert(errorsFor(duplicate.ledger, duplicate.result).some((error) => error.includes("duplicate candidate")));
});

test("rejects malformed candidate schema and trace kinds", () => {
  const malformed = fixture();
  malformed.result.candidates[0].trace = [
    { kind: "entrypoint", file: "src/a.c", line: 1, scope: "a", description: "Input." },
    { kind: "sink", file: "src/b.c", line: 2, scope: "b", description: "Middle." },
    { kind: "sink", file: "src/c.c", line: 3, scope: "c", description: "Effect." },
  ];
  assert(errorsFor(malformed.ledger, malformed.result).some((error) => error.includes('must be "propagation"')));
});

test("rejects invalid uncovered entries, hardening, and wrapper fields", () => {
  const invalid = fixture();
  invalid.result.hardening = [42];
  invalid.result.uncovered = [{ surface: "x", boundary: "y", subsystem: "z", attack_class: "w", starting_paths: ["../x"], reason: "gap" }];
  invalid.result.normalized = true;
  const errors = errorsFor(invalid.ledger, invalid.result);
  assert(errors.some((error) => error.includes("missing or unexpected fields")));
  assert(errors.some((error) => error.includes("visible text")));
  assert(errors.some((error) => error.includes("repository-relative path")));
});

test("CLI accepts a valid result and rejects malformed JSON", () => {
  const valid = fixture();
  const accepted = runCli(valid.ledger, valid.result);
  assert.equal(accepted.completed.status, 0, output(accepted.completed));
  assert.match(accepted.completed.stdout, /PASS: 3 hunter units and 1 candidates valid/);

  const invalid = runCli(valid.ledger, "{not json");
  assert.notEqual(invalid.completed.status, 0);
  assert.match(output(invalid.completed), /invalid JSON|Failed to parse|malformed JSON/);
});

test("CLI rejects without normalizing the input and escapes diagnostics", () => {
  const invalid = fixture();
  invalid.result.units[0].reviewed_paths.push("src/unowned-\u001b.ts");
  const { completed, resultText, afterText } = runCli(invalid.ledger, invalid.result);
  assert.notEqual(completed.status, 0);
  assert.equal(afterText, resultText);
  for (const marker of CONTROL_BYTES) {
    assert.equal(Buffer.from(output(completed)).indexOf(marker), -1);
  }
});
