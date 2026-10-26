# security-audit

> [!NOTE]
> **This is a personal fork of [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill). Cloudflare does not maintain or endorse it.**
>
> The fork adapts the skill for long, unattended full audits on harnesses with rolling usage limits, mainly Kimi Code. Upstream starts every agent in a wave at once, which can use up a 5-hour usage window in minutes. When the run stops, someone has to come back and type "continue".
>
> This fork adds [UNATTENDED.md](skills/security-audit/UNATTENDED.md) and a scratch-cleanup script, so the skill now:
>
> - runs at most five agents at a time, with the same coverage as upstream; runs just take longer
> - resumes from the run files after a usage limit or session end, and schedules an hourly resume check when the harness supports it
> - never stops or defers work because of a five-hour session, usage-window reset, or large candidate count
> - asks all its questions at setup, then runs without asking
> - cleans up its scratch with simple commands that approval guards allow
> - rejects malformed hunter evidence before consolidation instead of repairing it
>
> Upstream's audit workflow and evidence rules retain their full depth. Session windows change only pacing and resumption, never the end result. To install this fork instead of upstream:
>
> ```bash
> npx skills add https://github.com/Jasonvdb/security-audit-skill --skill security-audit --global
> ```

A coding-agent skill that turns your agent into a security auditor. It orchestrates isolated agents through reconnaissance, coverage-led hunting, candidate validation, structured output, independent record verification, and target-neutral reporting.

This is the skill that seeded Cloudflare's vulnerability discovery harness, described in [Build your own vulnerability harness](https://blog.cloudflare.com/build-your-own-vulnerability-harness). The harness grew into a multi-stage, fleet-wide system; this skill is the single-repo starting point it evolved from.

## What it does

The skill runs a structured audit in six phases:

1. **Reconnaissance** -- map architecture, trust boundaries, input surfaces, prior evidence, and deterministic coverage in `architecture.md` and `coverage-ledger.json`.
2. **Coverage-led hunting** -- assign isolated hunters from ledger units, record their checks, and use coverage critics to find gaps.
3. **Candidate validation** -- give every unique candidate to a fresh verifier that tries to disprove it.
4. **Structured output** -- write `confirmed`, `needs_validation`, and `rejected` records to `findings.json` and validate them against `report-schema.json`.
5. **Independent record verification** -- fresh agents verify final source claims. Material replacements receive another independent verifier.
6. **Target-neutral reporting** -- derive `REPORT.md`, `FINDINGS-DETAIL.md`, and `NEEDS-VALIDATION.md` from the verified records and coverage ledger.

The parent runs `validate-coverage-ledger.cjs` after creating the ledger and after each later ledger update. It runs `validate-findings.cjs` in Phase 4 and again after every Phase 5 replacement.

The verdicts are distinct: `confirmed` has a complete source trace and bounded observed result, `needs_validation` has an exact unresolved fact and no severity, and `rejected` records a disproved candidate.

Multiple runs against the same repo are additive. The skill uses prior ledgers and findings to target gaps, revalidate changed source, and carry forward current-source evidence without treating stale or unresolved work as covered.

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Setup, core principles, platform terminology, workflow overview, and audit anti-patterns |
| `RECONNAISSANCE.md` | Phase 1 reconnaissance prompts and synthesis instructions |
| `HUNTING.md` | Phase 2 orchestration, hunting methodology, and validation rules |
| `ATTACK-CLASSES.md` | Core, wildcard, and obvious-things attack prompts |
| `MEMORY-SAFETY-AND-BINARY.md` | Memory-safety, binary, and kernel hunting classes for native targets |
| `AI-AND-LLM.md` | Prompt-injection, agent/tool, and output-handling hunting classes for LLM-backed targets |
| `WEB-PROTOCOL-AND-AUTH.md` | HTTP request-framing, cache, and authentication-protocol hunting classes for HTTP-protocol and auth targets |
| `CLIENT-SIDE.md` | DOM-injection, messaging-trust, UI-redress, and prototype-pollution hunting classes for client-side/browser targets |
| `SUPPLY-CHAIN-AND-RELEASE.md` | Dependency, CI, release, signing, update, plugin, and extension hunting classes |
| `CLOUD-AND-DEPLOYMENT.md` | IAM, infrastructure-as-code, container, serverless, ingress, and runtime-configuration hunting classes |
| `PROTOCOLS-RPC-AND-MESSAGING.md` | RPC, serialization, queue, broker, webhook, and streaming-protocol hunting classes |
| `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` | Shared resource, quota, queue, worker, and operator-spend hunting classes |
| `DATA-ISOLATION-AND-LIFECYCLE.md` | Tenant isolation, cache, search, export, backup, migration, deletion, and restore hunting classes |
| `DESKTOP-MOBILE-AND-LOCAL-IPC.md` | Native app, deep-link, webview, exported-component, helper, daemon, and local-IPC hunting classes |
| `VALIDATION-AND-REPORTING.md` | Phases 3–6 candidate validation, structured output, record verification, and reporting |
| `UNATTENDED.md` | Setup decisions, concurrent-agent batches, interruptions, resuming from run files, scheduled resume checks, and cleanup for long or unattended runs |
| `report-schema.json` | JSON schema for all three `findings.json` verdicts |
| `validate-findings.cjs` | Zero-dependency validator for `findings.json` in Phases 4 and 5 |
| `validate-findings.test.cjs` | Findings-validator tests and producer-compatible fixture checks |
| `validate-coverage-ledger.cjs` | Zero-dependency validator for `coverage-ledger.json` in Phases 1–5 |
| `validate-coverage-ledger.test.cjs` | Coverage-ledger validator tests |
| `validate-hunter-result.cjs` | Zero-dependency pre-consolidation validator for exact hunter assignments, evidence ownership, and candidate shape |
| `validate-hunter-result.test.cjs` | Hunter-result validator and no-normalization regression tests |
| `cleanup-agent-scratch.cjs` | Zero-dependency, symlink-refusing cleanup of one finished agent's scratch directory |
| `cleanup-agent-scratch.test.cjs` | Scratch-cleanup tests |

## Installation

Install the skill with the [Skills CLI](https://skills.sh):

```bash
npx skills add https://github.com/cloudflare/security-audit-skill \
  --skill security-audit
```

Use `--global` for a user-level installation:

```bash
npx skills add https://github.com/cloudflare/security-audit-skill \
  --skill security-audit \
  --global
```

Run `npx skills --help` for agent-selection and non-interactive options.

## Usage

Start your coding agent in (or pointed at) the codebase you want to audit, then ask it to do a security audit:

```
security audit this codebase
```

```
find security vulnerabilities in ./src
```

```
do a security review, output to ~/audits/my-project
```

The skill activates automatically when the request matches its trigger (security audit, find vulnerabilities, pen-test the code, etc.). A direct codebase audit or pen-test request uses full audit mode. Security questions and focused vulnerability work use guidance mode unless you request report artifacts. In full audit mode, an unspecified output directory defaults to `~/security-audit-skill/<repo-name>/run-<N>`. The workflow writes inside the target repository only when you explicitly select a directory that version control ignores.

### Long and unattended runs

A full audit settles all of its questions before the first agent launches, then runs without asking. It dispatches agents in batches of at most five at a time (`max_concurrent_agents`), so a large wave doesn't use up a harness usage window in minutes. Coverage and independent verification stay the same; the run takes longer. A five-hour session, usage-window reset, or large candidate count suspends rather than reduces the audit. Only an explicit user-set strict invocation budget can make the result incomplete for budget reasons. When a usage limit or session end interrupts the run, it resumes from the files in the output directory with the same assignments and prompts. If the harness supports scheduled prompts, the run schedules an hourly resume check and deletes it when the audit finishes. See [UNATTENDED.md](skills/security-audit/UNATTENDED.md), including the operator notes for Kimi Code and Claude Code.

Before consolidating each hunter result, the parent runs:

```sh
node skills/security-audit/validate-hunter-result.cjs \
  <output-dir>/coverage-ledger.json <agent-id> <result.json>
```

Malformed results are rejected and reassigned without parent-side repair.

## Requirements

- A coding agent with a model that supports tool use and parallel sub-agents
- Node.js for the zero-dependency findings, coverage-ledger, and hunter-result validators and the scratch-cleanup script
- An OS-enforced sandbox for target-controlled builds, tests, processes, browsers, emulators, fuzzers, and fixtures. It must disable external networking, use a sanitized allowlisted environment, enforce resource limits, and allow writes only to assigned scratch paths. Without these controls, the workflow keeps the lead as `needs_validation` instead of executing target code.

## Design principles

- **Only confirm established boundary failures.** Keep a source-grounded blocked lead as `needs_validation` with its exact unresolved fact.
- **Adversarial validation.** The agent that checks a finding is never the agent that found it.
- **Severity requires impact.** Likelihood x impact, not deviation from a checklist.
- **Defense-in-depth gaps are not vulnerabilities.** If Layer A prevents the attack, the absence of Layer B is a hardening note.
- **Multiple runs improve coverage.** In our test runs, a single run found roughly half of the vulnerabilities that repeated runs found in total.

## Contact

Questions, feedback, or comparing notes on AI-driven security tooling: security-ai-research@cloudflare.com

## License

MIT -- see [LICENSE](LICENSE).
