#!/usr/bin/env node

/**
 * Validates one hunter result against its current in-progress ledger assignments.
 * Usage: node validate-hunter-result.cjs <coverage-ledger.json> <agent-id> <result.json>
 */

const {
  LIMITS,
  UNSAFE_DIAGNOSTIC_CHARACTER,
  hasVisibleProse,
  isSafeAgentId,
  isSafeRelativePath,
  preflightJsonText,
  readFileWithinLimit,
  safeQuote,
  validateDocument: validateLedger,
} = require("./validate-coverage-ledger.cjs");
const { validateDocument: validateFindings } = require("./validate-findings.cjs");
const schema = require("./report-schema.json");

const FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const RESULT_FIELDS = ["units", "candidates", "hardening", "uncovered"];
const UNIT_FIELDS = ["coverage_id", "disposition", "reviewed_paths", "checks", "candidate_fingerprints", "unresolved"];
const CHECK_FIELDS = ["agent_id", "reviewed_paths", "invariant", "method", "result", "artifact"];
const UNCOVERED_FIELDS = ["surface", "boundary", "subsystem", "attack_class", "starting_paths", "reason"];
const MAX_ERRORS = 100;

function escapeDiagnostic(value) {
  return String(value).replace(UNSAFE_DIAGNOSTIC_CHARACTER, (character) => {
    const point = character.codePointAt(0);
    return point <= 0xffff ? `\\u${point.toString(16).padStart(4, "0")}` : `\\u{${point.toString(16)}}`;
  });
}

function createErrors() {
  const errors = [];
  Object.defineProperty(errors, "push", {
    value(...messages) {
      const remaining = MAX_ERRORS - this.length;
      if (remaining > 0) Array.prototype.push.apply(this, messages.slice(0, remaining).map(escapeDiagnostic));
      return this.length;
    },
  });
  return errors;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFields(value, fields) {
  return isObject(value) && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field)) &&
    Object.keys(value).every((field) => fields.includes(field));
}

function validateStringArray(value, location, errors, options = {}) {
  const { allowEmpty = true, paths = false, fingerprints = false } = options;
  if (!Array.isArray(value)) {
    errors.push(`${location}: expected array`);
    return;
  }
  if (!allowEmpty && value.length === 0) errors.push(`${location}: must not be empty`);
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    const entryLocation = `${location}[${index}]`;
    if (paths ? !isSafeRelativePath(entry) : typeof entry !== "string" || !hasVisibleProse(entry)) {
      errors.push(`${entryLocation}: invalid ${paths ? "repository-relative path" : "visible text"}`);
    }
    if (fingerprints && (typeof entry !== "string" || !FINGERPRINT_PATTERN.test(entry))) {
      errors.push(`${entryLocation}: invalid fingerprint`);
    }
    if (typeof entry === "string" && seen.has(entry)) errors.push(`${entryLocation}: duplicate entry`);
    if (typeof entry === "string") seen.add(entry);
  }
}

function validateChecks(unit, agentId, location, errors) {
  if (!Array.isArray(unit.checks) || unit.checks.length === 0) {
    errors.push(`${location}.checks: must not be empty`);
    return new Set();
  }
  const ownedPaths = new Set();
  unit.checks.forEach((check, index) => {
    const base = `${location}.checks[${index}]`;
    if (!hasOnlyFields(check, CHECK_FIELDS)) {
      errors.push(`${base}: missing or unexpected fields`);
      return;
    }
    if (check.agent_id !== agentId) errors.push(`${base}.agent_id: expected hunter ${safeQuote(agentId)}`);
    if (!isSafeAgentId(check.agent_id)) errors.push(`${base}.agent_id: invalid canonical agent ID`);
    validateStringArray(check.reviewed_paths, `${base}.reviewed_paths`, errors, { allowEmpty: false, paths: true });
    if (Array.isArray(check.reviewed_paths)) {
      for (const path of check.reviewed_paths) {
        if (isSafeRelativePath(path)) ownedPaths.add(path);
      }
    }
    if (!hasVisibleProse(check.invariant)) errors.push(`${base}.invariant: invalid text`);
    if (!hasVisibleProse(check.result)) errors.push(`${base}.result: invalid text`);
    if (check.method !== "source" && check.method !== "local") errors.push(`${base}.method: expected source or local`);
    if (check.method === "source" && check.artifact !== null) errors.push(`${base}.artifact: source check must use null`);
    if (check.method === "local") {
      const prefix = `agents/${agentId}/artifacts/`;
      if (typeof check.artifact !== "string" || !isSafeRelativePath(check.artifact) || !check.artifact.startsWith(prefix) || check.artifact.length === prefix.length) {
        errors.push(`${base}.artifact: local check requires a parent-promoted artifact owned by ${safeQuote(agentId)}`);
      }
    }
  });
  return ownedPaths;
}

function validateUnit(unit, assigned, agentId, location, candidateFingerprints, errors) {
  if (!hasOnlyFields(unit, UNIT_FIELDS)) {
    errors.push(`${location}: missing or unexpected fields`);
    return;
  }
  if (unit.coverage_id !== assigned.coverage_id) errors.push(`${location}.coverage_id: assignment mismatch`);
  if (!["covered", "candidate", "blocked"].includes(unit.disposition)) errors.push(`${location}.disposition: invalid value`);
  validateStringArray(unit.reviewed_paths, `${location}.reviewed_paths`, errors, { allowEmpty: false, paths: true });
  const ownedPaths = validateChecks(unit, agentId, location, errors);
  if (Array.isArray(unit.reviewed_paths)) {
    const aggregate = new Set(unit.reviewed_paths.filter(isSafeRelativePath));
    for (const path of aggregate) {
      if (!ownedPaths.has(path)) errors.push(`${location}.reviewed_paths: ${safeQuote(path)} has no owning check`);
    }
    for (const path of ownedPaths) {
      if (!aggregate.has(path)) errors.push(`${location}.reviewed_paths: owned path ${safeQuote(path)} is absent`);
    }
  }
  validateStringArray(unit.candidate_fingerprints, `${location}.candidate_fingerprints`, errors, { fingerprints: true });
  validateStringArray(unit.unresolved, `${location}.unresolved`, errors);
  const fingerprints = Array.isArray(unit.candidate_fingerprints) ? unit.candidate_fingerprints : [];
  if (unit.disposition === "covered") {
    if (fingerprints.length > 0) errors.push(`${location}.candidate_fingerprints: covered unit must be empty`);
    if (!Array.isArray(unit.unresolved) || unit.unresolved.length > 0) errors.push(`${location}.unresolved: covered unit must be empty`);
  } else if (unit.disposition === "candidate") {
    if (fingerprints.length === 0) errors.push(`${location}.candidate_fingerprints: candidate unit must not be empty`);
    for (const fingerprint of fingerprints) candidateFingerprints.add(fingerprint);
  } else if (unit.disposition === "blocked") {
    if (fingerprints.length > 0) errors.push(`${location}.candidate_fingerprints: blocked unit must be empty`);
    if (!Array.isArray(unit.unresolved) || unit.unresolved.length === 0) errors.push(`${location}.unresolved: blocked unit must not be empty`);
  }
}

function validateUncovered(entries, errors) {
  if (!Array.isArray(entries)) {
    errors.push("$.uncovered: expected array");
    return;
  }
  entries.forEach((entry, index) => {
    const base = `$.uncovered[${index}]`;
    if (!hasOnlyFields(entry, UNCOVERED_FIELDS)) {
      errors.push(`${base}: missing or unexpected fields`);
      return;
    }
    for (const field of ["surface", "boundary", "subsystem", "attack_class", "reason"]) {
      if (!hasVisibleProse(entry[field])) errors.push(`${base}.${field}: invalid text`);
    }
    validateStringArray(entry.starting_paths, `${base}.starting_paths`, errors, { allowEmpty: false, paths: true });
  });
}

function validateResultDocument(ledger, agentId, result) {
  const errors = createErrors();
  if (!isSafeAgentId(agentId)) {
    errors.push("agent-id: invalid canonical agent ID");
    return errors;
  }
  if (!Array.isArray(ledger)) {
    errors.push("ledger: expected array");
    return errors;
  }
  const assigned = ledger.filter((unit) => isObject(unit) && unit.status === "in_progress" && unit.agent_id === agentId);
  if (assigned.length === 0) errors.push(`agent-id ${safeQuote(agentId)}: no in-progress ledger assignments`);
  const assignedById = new Map(assigned.map((unit) => [unit.coverage_id, unit]));
  if (!hasOnlyFields(result, RESULT_FIELDS)) {
    errors.push("$: missing or unexpected fields");
  }
  if (!Array.isArray(result.units)) {
    errors.push("$.units: expected array");
  } else {
    const seen = new Set();
    const candidateFingerprints = new Set();
    result.units.forEach((unit, index) => {
      const base = `$.units[${index}]`;
      if (!isObject(unit) || typeof unit.coverage_id !== "string") {
        errors.push(`${base}: expected object with coverage_id`);
        return;
      }
      if (seen.has(unit.coverage_id)) errors.push(`${base}.coverage_id: duplicate assignment`);
      seen.add(unit.coverage_id);
      if (!assignedById.has(unit.coverage_id)) {
        errors.push(`${base}.coverage_id: absent from this hunter's assignments`);
      } else {
        validateUnit(unit, assignedById.get(unit.coverage_id), agentId, base, candidateFingerprints, errors);
      }
    });
    for (const coverageId of assignedById.keys()) {
      if (!seen.has(coverageId)) errors.push(`$.units: missing assigned coverage ID ${safeQuote(coverageId)}`);
    }
    if (!Array.isArray(result.candidates)) {
      errors.push("$.candidates: expected array");
    } else {
      const records = [];
      const recordFingerprints = new Set();
      result.candidates.forEach((candidate, index) => {
        const base = `$.candidates[${index}]`;
        if (!isObject(candidate) || typeof candidate.fingerprint !== "string") {
          errors.push(`${base}: expected candidate with fingerprint`);
          return;
        }
        if (!FINGERPRINT_PATTERN.test(candidate.fingerprint)) errors.push(`${base}.fingerprint: invalid fingerprint`);
        if (recordFingerprints.has(candidate.fingerprint)) errors.push(`${base}.fingerprint: duplicate candidate`);
        recordFingerprints.add(candidate.fingerprint);
        if (!candidateFingerprints.has(candidate.fingerprint)) errors.push(`${base}.fingerprint: not linked by any candidate unit`);
        if (candidate.proposed_verdict !== "confirmed" && candidate.proposed_verdict !== "needs_validation") {
          errors.push(`${base}.proposed_verdict: expected confirmed or needs_validation`);
          return;
        }
        const { proposed_verdict: proposedVerdict, ...fields } = candidate;
        records.push({ verdict: proposedVerdict, ...fields });
      });
      for (const fingerprint of candidateFingerprints) {
        if (!recordFingerprints.has(fingerprint)) errors.push(`$.candidates: missing record for ${safeQuote(fingerprint)}`);
      }
      if (records.length > 0) {
        for (const message of validateFindings(records, schema)) errors.push(`candidate schema: ${message}`);
      }
    }
  }
  validateStringArray(result.hardening, "$.hardening", errors);
  validateUncovered(result.uncovered, errors);
  return errors;
}

function parseJson(contents, label) {
  preflightJsonText(contents);
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label}: invalid JSON syntax`);
  }
}

function run(ledgerPath, agentId, resultPath) {
  if (!ledgerPath || !agentId || !resultPath) {
    console.error("Usage: node validate-hunter-result.cjs <coverage-ledger.json> <agent-id> <result.json>");
    return 1;
  }
  let ledger;
  let result;
  try {
    ledger = parseJson(readFileWithinLimit(ledgerPath), "coverage ledger");
    result = parseJson(readFileWithinLimit(resultPath), "hunter result");
  } catch (error) {
    console.error(`Failed to read input: ${escapeDiagnostic(error.message)}`);
    return 1;
  }
  const ledgerErrors = validateLedger(ledger);
  if (ledgerErrors.length > 0) {
    console.error("Failed to validate coverage ledger before hunter consolidation:");
    for (const message of ledgerErrors) console.error("ERROR:", escapeDiagnostic(message));
    return 1;
  }
  const errors = validateResultDocument(ledger, agentId, result);
  for (const message of errors) console.error("ERROR:", message);
  if (errors.length > 0) {
    console.error(`FAIL: ${errors.length} validation error(s)${errors.length === MAX_ERRORS ? "; output capped at 100" : ""}`);
    return 1;
  }
  console.log(`PASS: ${result.units.length} hunter units and ${result.candidates.length} candidates valid for ${agentId}`);
  return 0;
}

module.exports = { LIMITS, validateResultDocument };

if (require.main === module) process.exit(run(process.argv[2], process.argv[3], process.argv[4]));
