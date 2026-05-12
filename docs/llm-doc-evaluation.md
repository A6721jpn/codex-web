# LLM Documentation Evaluation

Use this rubric to check whether a no-context LLM can read the repository without wasting context or inventing missing rationale.

## Procedure

1. Start a fresh agent with no conversation context.
2. Tell it to read only `README.md`, `AGENTS.md`, and `docs/agent-reading-guide.md` first.
3. Ask it to answer as much as possible from that initial set and record the initial word count.
4. Let it open only the docs named by the reading guide for each remaining question.
5. Record files read, rough word count, score, missing facts, and any guesses.

## Evaluation Questions

Ask the agent:

1. What is codex-web building, for whom, and under what host/runtime assumptions?
2. What are the core invariants?
3. Which files own auth, active connection, workspace metadata, thread index, app-server communication, chat runtime, approvals, and SQLite?
4. What is implemented through the current milestone and what is deferred?
5. Which ADRs would you read before changing approval behavior, app-server routing, persistence, or connection leasing?
6. Name three design decisions with clear rationale and three areas that still need decisions.
7. If asked to implement a feature, what is the smallest doc/source set you would read first?

## Scoring Rubric

Score each category from 0 to 5.

| Category | 5 | 3 | 1 |
| --- | --- | --- | --- |
| Orientation | Agent can state product, user, host, and current milestone from entry docs. | Agent knows the product but misses host, user, or milestone. | Agent must infer the project from source files. |
| Architecture understanding | Agent can name the BFF boundary, app-server role, lease model, persistence policy, and approval model. | Agent understands the BFF but misses one or two invariants. | Agent treats the app as a generic web UI. |
| Decision rationale | Agent can link important constraints to ADRs and consequences. | Agent finds rationale in milestone history but not direct decision records. | Agent guesses why rules exist. |
| Progressive disclosure | Agent reads a small entry set, then opens only task-specific docs. | Agent reads most docs to answer simple questions. | Agent must scan the whole repo. |
| Implementation readiness | Agent can name likely source files and tests before editing. | Agent can name modules but not tests or ownership boundaries. | Agent must search broadly before any change. |
| Context efficiency | Agent reaches a useful model in under 2,500 words of docs before source reading. | Agent needs 2,500-6,000 words. | Agent needs more than 6,000 words or full milestone history. |

## Baseline Result Before LLM Guide

An initial no-context agent reading `README.md`, `AGENTS.md`, the main design doc, and milestone docs consumed roughly 6,900 words.

Scores:

- Orientation: 4/5
- Architecture understanding: 4/5
- Decision rationale: 3/5
- Progressive disclosure: 4/5
- Implementation readiness: 3/5

Observed gaps:

- Exact source ownership was not available from docs.
- ADR-style rationale was mixed into milestone history.
- Approval changes required reading design and M4 docs, then searching for source files.
- Some operational decisions, such as HTTPS boundary, permission profile mapping, and schema enforcement timing, remained open or hard to find.

## Target

After adding the documentation spine, a no-context agent should:

- reach orientation and architecture scores of at least 4/5;
- reach decision rationale and implementation readiness scores of at least 4/5;
- identify the relevant source files for a focused change without scanning the whole repo;
- keep initial orientation docs under about 2,500 words before opening task-specific files.

## Post-Spine Evaluation

Fresh no-context agents evaluated the new spine after adding the reading guide, current architecture overview, ADRs, milestone table, security model, runbook, generated-doc warning, and decision backlog.

Observed scores:

| Category | Score |
| --- | ---: |
| Orientation | 5/5 |
| Architecture understanding | 5/5 |
| Decision rationale | 4-5/5 |
| Progressive disclosure | 5/5 |
| Implementation readiness | 4/5 |
| Context efficiency | 4-5/5 |

Initial orientation set was roughly 1,850 words: `README.md`, `AGENTS.md`, and `docs/agent-reading-guide.md`.

Remaining known gaps:

- M5/M6/M7 are active/contract-stage areas; keep docs and test status clearly labeled until they are promoted to stable baseline.
- Some high-risk future decisions remain in `docs/adr/backlog.md`.
- If README grows, move milestone command details into `docs/runbook.md` or milestone docs.
