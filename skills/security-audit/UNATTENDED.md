# Unattended and Long-Running Runs

Full audits outlast one sitting. Harnesses enforce usage windows, sessions end, contexts compact, and nobody may be watching. This file makes a full audit resumable from its run files, paces delegated agents so one wave cannot exhaust a usage window, keeps cleanup commands simple enough for approval guards, and schedules a resume check when the harness can.

These rules apply in full audit mode. They change pacing and recovery, never coverage, independence, or the evidence bar: every unit, critic, and verifier the workflow requires still runs. Capabilities are named by role; the [harness mapping](#harness-mapping) at the end lists known equivalents. When a harness lacks a capability, skip only the rule that depends on it.

## Settle decisions at setup

An unattended run must not stop to ask. During full audit setup, resolve everything the run will need (mode, profile, scope, output directory, budget, and `max_concurrent_agents`) from the request and the documented defaults. Ask only about what neither settles, and ask all such questions together before launching the first agent. After that point, do not ask the user anything. Where the workflow says to propose or ask mid-run, for example when the wave-1 estimate shows the budget cannot cover the plan, record the facts in `run-metadata.json`, apply the documented default (priority order, `deferred` units, or an incomplete status), and disclose it in the report.

Add these fields to `run-metadata.json`:

- `max_concurrent_agents`: the most delegated agents running at once. Default `5`. A user or harness limit can lower it; nothing raises it silently.
- `resume_schedule_id`: the harness ID of the scheduled resume check, or `null` when none exists.
- `agent_handles`: a map from each canonical `agent_id` to the harness's own handle for that agent, recorded at launch and used to resume an interrupted agent.
- `interrupted_invocations`: a count of agent invocations that ended without a result. Initialize it to `0`.

## Concurrent-agent cap

`budget` limits how many agents a run uses in total. `max_concurrent_agents` limits how many run at the same time. The cap spreads the same work over more wall-clock time: it never defers, merges, or drops a unit, and it never changes a prompt.

The parent dispatches every delegated agent in every phase, including reconnaissance agents, hunters, critics, and Phase 3 and Phase 5 verifiers, as batches of at most `max_concurrent_agents`:

1. Before a phase or wave's first batch, fix its complete dispatch list: each canonical `agent_id`, its coverage IDs or fingerprint, its peer-owned exclusions, and its batch number. Assign batches in the workflow's priority order, ties broken by `coverage_id` or fingerprint. Write the list to the parent-owned `dispatch-plan.json` in the output directory.
2. Build every prompt in the list from the state at that fixed point. A later batch never receives an earlier batch's candidates, conclusions, or `uncovered` entries. Each agent receives exactly what it would have received had all launched at once.
3. Immediately before launching a batch, set its units `in_progress` with their owners, create their directories, and record their handles in `agent_handles`. Launch the batch in the foreground, so the coordinating turn waits for it. If the harness runs agents only in the background, wait for them inside the same turn instead of ending it.
4. After each batch returns, consolidate each result into the ledger as usual, validate the ledger, clean each finished agent's scratch (see [Cleanup](#cleanup)), and mark the batch `done` in `dispatch-plan.json`.
5. Queue `uncovered` entries and critic proposals for the next wave as the workflow already requires. The post-wave critic launches only after every batch in the wave has finished.

A batch is a checkpoint. When a usage limit interrupts the run, at most one batch of work is lost, and the run files show exactly where to resume.

`dispatch-plan.json` holds an array of entries, each with `phase`, `wave` (or `null` outside hunting), `batch`, `agent_id`, `role`, the `coverage_ids` or `fingerprint` it owns, and `state` (`queued`, `launched`, `done`, or `interrupted`). It is parent-owned bookkeeping like `run-metadata.json`; agents never read or write it.

## Interruptions

An invocation is interrupted when it ends without a structured result because of a usage or quota limit, a rate limit, a harness timeout, a cancelled session, or a crash. An interruption is not a malformed result: do not discard it as one, do not count it against `budget`, and do not set the run incomplete because of it. Increment `interrupted_invocations` for every interruption, and report the total in `REPORT.md`. The unit's `interruptions` bookkeeping field counts only the interruptions that step 3 below counts.

An interrupted agent's unit is still `in_progress` in the ledger. Recover it as follows:

1. If the harness can resume that exact agent by its recorded handle, with its context, resume it: same `agent_id`, same scratch, same prompt.
2. Otherwise, reset the unit to `planned` with a null owner and empty live evidence, keeping its current `wave`. Assign it to a fresh canonical `agent_id` (for example `<old-id>-r2`) in a new batch, and clean the abandoned agent's scratch once no process of it remains.
3. Usage, quota, and rate limits, cancellations, and session ends say nothing about the unit. Always recover a unit interrupted for those reasons, however often it happens, and do not count those interruptions in its `interruptions` field. Count only harness timeouts and crashes. When a unit has two counted interruptions in a row, do not dispatch it again in this run: set it `deferred`, null owner, empty evidence, with the reason `interrupted_repeatedly: <what ended each attempt>`. A unit that keeps hitting a harness timeout is likely too large; the next run should split it.

A verifier or critic that is interrupted is re-run with a fresh agent that satisfies the same independence rules. Never reuse an interrupted verifier's partial output.

## Resuming a run

A run resumes from its files, not from conversation memory. When a scheduled check fires, when the user says "continue", or when a new session picks up a run, the parent:

1. Reads `<output-dir>/run-metadata.json`. If `run_status` is not `in_progress`, deletes the scheduled resume check if one is recorded, then stops.
2. Checks whether any delegated agent from this run is still running. If one is, changes nothing and ends the turn; that agent's result will arrive normally.
3. Reads `coverage-ledger.json`, `findings.json` if it exists, and `dispatch-plan.json`, then runs `validate-coverage-ledger.cjs`.
4. Recovers every dispatch entry still in `launched` state as an interruption (see [Interruptions](#interruptions)).
5. Continues from the first unfinished batch of the current phase, keeping every rule of that phase.

## Scheduled resume check

When the harness can inject a scheduled prompt into this session, create one recurring hourly check during setup, after `run-metadata.json` exists and before the first agent launches. Avoid minute `:00` and `:30`; for example, use minute `17`. Record its ID in `resume_schedule_id`. Use this prompt, with the absolute paths filled in:

```text
Scheduled resume check for the security audit at <output-dir>.
Load the security-audit skill at <skill-dir>/SKILL.md and follow "Resuming a run" in
<skill-dir>/UNATTENDED.md. If any agent from this run is still running, or
<output-dir>/run-metadata.json does not show run_status "in_progress", change nothing
except deleting this schedule when the run has ended, and end the turn.
```

The check resumes the run after a usage window resets, after the harness ended a turn early, and after the parent stopped mid-phase by mistake. When the run is still blocked, the check fails or does nothing, and the next hourly check tries again.

Delete the check as soon as the run reaches either terminal state defined in `SKILL.md`. Harness schedules expire: if the harness reports that the check expired or is about to, and the run is still `in_progress`, create a new one and update `resume_schedule_id`. Schedules are bound to the session: if the user resumes the run in a new session, create a fresh check there.

When the harness has no scheduler, set `resume_schedule_id` to `null`. The run still resumes from its files when the user says "continue".

## Cleanup

Clean a finished agent's scratch to save disk space, using a simple command that approval guards allow:

```text
node <skill-dir>/cleanup-agent-scratch.cjs <output-dir> <agent-id>
```

Run it only after that agent, its sandbox, and every process it started have terminated, and after the parent has consolidated the agent's result and promoted its artifacts. Never run it for an agent that may still be resumed. The script requires an absolute output directory containing `run-metadata.json` and a canonical agent ID. It refuses any symlinked `agents/`, agent, or `scratch/` directory, removes only the direct children of that agent's `scratch/` without following links, and keeps `artifacts/` and the empty `scratch/` directory. It is safe to run twice. A `FAIL` result means nothing was deleted, or deletion stopped part-way; record the reason and leave the remaining scratch alone.

Delete nothing else. When the script cannot run, use this fallback, which is also the rule for any delegated agent that must free space in its own scratch during a task:

```text
## Scratch cleanup rule

Delete only a direct child of your own scratch directory, never a deeper path: a
symlinked parent component can redirect a deeper path outside scratch. Use one
command per deletion, of exactly this form:

    rm -r <absolute-scratch-dir>/<entry-name>

Never add -f, a trailing slash, globs, variables, ~, command substitution, cd,
pipes, ;, &&, find -delete, or xargs. Never delete while a target-controlled
process may still be running. Never delete a file on your promotion allowlist,
any file your result cites, or anything a check you still plan to run depends
on. Never delete artifacts/, shared run files, target
source, or anything outside your scratch directory. If a deletion fails, stop
deleting and report it.
```

These forms matter in two ways. A trailing slash makes `rm` act on a symlink's target directory instead of the link, and target code controls what scratch contains. Harness approval guards also stop compound or forced recursive deletions, which halts an unattended run until a person approves them. The script's path checks, not the guard, are what keep cleanup inside scratch.

## Harness mapping

| Role | Kimi Code | Claude Code |
|---|---|---|
| One delegated agent | `Agent`, foreground | `Agent` tool, foreground |
| One batch of agents | One `AgentSwarm` call with at most `max_concurrent_agents` items (only one `AgentSwarm` per response), or that many `Agent` calls in one response | That many `Agent` calls in one message |
| Check for still-running agents | `TaskList` | The session's background agent list |
| Resume an interrupted agent | `Agent` with `resume`, or `AgentSwarm` with `resume_agent_ids` | Not relied on; assign a fresh agent |
| Scheduled resume check | `CronCreate`, `CronList`, `CronDelete`; bound to the session, kept across `kimi --session`, expires after 7 days | `CronCreate`, `CronList`, `CronDelete`; session-only, fires only when idle, expires after 7 days |
| Wait for background work in-turn | `WaitFor` | Foreground agents; no separate wait needed |

For other harnesses, use the equivalent capability or skip the dependent rule.

### Operator notes

These are settings for the person starting the run; the agent should not change them itself.

- **Kimi Code:** set `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` to the same value as `max_concurrent_agents` (for example `export KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY=5` in the shell profile). The harness then enforces the cap even when a response ignores it. Without it, `AgentSwarm` starts five agents and adds one every 0.7 seconds, with no upper limit.
- **Permission mode:** prefer a mode that runs routine commands without asking but still guards dangerous commands and sensitive files. Kimi Code's Ask When Needed mode does this. A mode that approves everything also lets the agent read `.env` files and keys without asking while it handles an untrusted repository.
- **Paid overflow:** if the account has paid overflow usage enabled, a usage window running out does not stop the run; it starts billing. Check this before leaving a full audit unattended.
