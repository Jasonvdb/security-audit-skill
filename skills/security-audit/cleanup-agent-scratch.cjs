#!/usr/bin/env node

/**
 * Empties one finished agent's scratch directory inside a full-audit output directory.
 * Usage: node cleanup-agent-scratch.cjs <absolute-output-dir> <agent-id>
 *
 * Run it only after the agent, its sandbox, and every target-controlled process have
 * terminated and the parent has promoted that agent's artifacts. It removes the direct
 * children of <output-dir>/agents/<agent-id>/scratch/, keeps the empty scratch directory,
 * and never touches artifacts/, shared run files, or anything outside that scratch root.
 */

const fs = require("node:fs");
const path = require("node:path");
const { isSafeAgentId } = require("./validate-coverage-ledger.cjs");

const RUN_METADATA_FILE = "run-metadata.json";

class CleanupError extends Error {}

function isRealDirectory(stats) {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// The output directory comes from the parent, so it may sit under a symlinked
// prefix such as macOS /tmp. Everything below it must be a real directory.
function resolveOutputDir(outputDir) {
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    throw new CleanupError("output directory is required");
  }
  if (!path.isAbsolute(outputDir)) throw new CleanupError("output directory must be an absolute path");
  const segments = outputDir.split(/[\\/]+/);
  if (segments.includes("..") || segments.includes(".")) {
    throw new CleanupError("output directory must not contain . or .. components");
  }
  if (/[\\/]$/.test(outputDir)) throw new CleanupError("output directory must not end with a path separator");

  let realOutputDir;
  try {
    realOutputDir = fs.realpathSync(outputDir);
  } catch {
    throw new CleanupError("output directory does not exist");
  }
  if (realOutputDir === path.parse(realOutputDir).root) {
    throw new CleanupError("output directory must not be a filesystem root");
  }
  if (!fs.statSync(realOutputDir).isDirectory()) throw new CleanupError("output directory is not a directory");

  const metadata = lstatOrNull(path.join(realOutputDir, RUN_METADATA_FILE));
  if (metadata === null || !metadata.isFile()) {
    throw new CleanupError(`output directory has no regular ${RUN_METADATA_FILE}; refusing to treat it as an audit run`);
  }
  return realOutputDir;
}

function cleanupAgentScratch(outputDir, agentId) {
  if (!isSafeAgentId(agentId)) throw new CleanupError("agent ID is not a canonical lowercase agent ID");
  const realOutputDir = resolveOutputDir(outputDir);

  // Walk agents/<agent-id>/scratch one component at a time and refuse symlinks,
  // so a planted link cannot redirect the delete outside the scratch root.
  let current = realOutputDir;
  for (const component of ["agents", agentId, "scratch"]) {
    current = path.join(current, component);
    const stats = lstatOrNull(current);
    if (stats === null) return { scratchDir: current, removed: 0 };
    if (!isRealDirectory(stats)) throw new CleanupError(`${path.relative(realOutputDir, current)} is not a real directory`);
  }
  const scratchDir = current;
  if (fs.realpathSync(scratchDir) !== scratchDir) throw new CleanupError("scratch directory resolves through a symlink");

  // fs.rmSync removes a symlinked entry itself and never follows links while recursing.
  const entries = fs.readdirSync(scratchDir);
  for (const entry of entries) {
    fs.rmSync(path.join(scratchDir, entry), { recursive: true, force: false, maxRetries: 2 });
  }
  return { scratchDir, removed: entries.length };
}

function run(args) {
  if (args.length !== 2) {
    console.error("Usage: node cleanup-agent-scratch.cjs <absolute-output-dir> <agent-id>");
    return 1;
  }
  try {
    const { scratchDir, removed } = cleanupAgentScratch(args[0], args[1]);
    console.log(`PASS: removed ${removed} entr${removed === 1 ? "y" : "ies"} from ${scratchDir}`);
    return 0;
  } catch (error) {
    const reason = error instanceof CleanupError ? error.message : `unexpected error (${error.code || "unknown"})`;
    console.error(`FAIL: ${reason}`);
    return 1;
  }
}

module.exports = {
  CleanupError,
  cleanupAgentScratch,
};

if (require.main === module) process.exit(run(process.argv.slice(2)));
