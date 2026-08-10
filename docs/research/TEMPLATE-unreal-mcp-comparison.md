# Unreal MCP comparison cycle — template

Use this template for each research cycle tracked by issue #372. A report is an
evidence inventory and decision record, not a feature-count leaderboard.

## Snapshot

- Research date and timezone:
- Hayba commit:
- Researcher:
- Trigger: scheduled / upstream release / incident / issue
- Prior report:

## Rules

1. Use primary sources: the repository at an exact commit, its releases/issues,
   official Unreal documentation/source, the MCP specification, and the SDK's
   own repository. Product marketing may identify a lead but cannot prove an
   implementation claim.
2. Record the default branch, inspected commit, commit date, latest release,
   license, and a maintenance signal. A popular repository with no recent code
   is a historical baseline, not a current design authority.
3. Separate evidence levels:
   - `source`: the behavior is present in inspected source or documentation;
   - `contract`: an automated test exercises the behavior without Unreal;
   - `built`: native code compiled and linked;
   - `live`: the behavior was observed in a disposable editor;
   - `claim`: upstream prose only; do not promote this to fact.
4. Compare architecture, transport, authentication, authorization, lifecycle,
   cancellation, atomicity, response contracts, tool ergonomics, test strategy,
   installation, and unique capabilities.
5. Check Hayba before calling something a gap. Search implementation, tests,
   issues, ADRs, and in-flight branches. Route an idea to an existing issue when
   its acceptance already covers it.
6. Prefer concepts and independently written implementations. Record license
   compatibility before adapting code or prose. Preserve required notices if
   code is ever copied.
7. Every adoption proposal needs a discriminating test and, when it touches the
   editor, a rung-5 live verification plan. “Competitor has it” is not value
   evidence.
8. Record explicit exclusions: duplicate, already better, unsafe, unverifiable,
   license-incompatible, or not applicable. This prevents research churn.

## Comparator record

Repeat for at least three maintained Unreal MCP projects.

### Repository name

- Repository:
- Default branch:
- Inspected commit/date:
- Latest release/date:
- License and compatibility with Hayba's MIT license:
- Maintenance signal:
- Architecture/transport:
- Authentication/authorization:
- Editor lifecycle and cancellation:
- Mutation/verification contract:
- Test evidence and admitted gaps:
- Unique capability:
- Hayba already has:
- Candidate gap:
- Decision: adopt / route to existing issue / defer / exclude
- Primary links:

## Official baselines

- Unreal MCP documentation/API version and links:
- Current MCP specification version and links:
- Current TypeScript SDK version and migration links:
- Applicable lifecycle, cancellation, safety, and compatibility constraints:

## Local checks

Record commands and summarized results. Suggested minimum:

```powershell
git rev-parse HEAD
gh issue list --state open --limit 100
npm ls @modelcontextprotocol/sdk --all
npm audit --omit=dev --json
npm outdated --long --json
rg -n "candidate-pattern" mcp-tools unreal docs
```

An audit result is time-sensitive. Record its date and do not present an
advisory as reachable until the importing code path is inspected.

## Decision table

| Finding | Evidence level | Hayba gap | Decision | Issue | Discriminating proof |
|---|---|---|---|---|---|
| | | | | | |

## Proposed issue shape

- Title:
- Source evidence:
- Hayba gap (with file/contract evidence):
- Non-duplicative outcome:
- Threat/failure model:
- Scope and explicit non-goals:
- Pure/contract tests:
- Native build tests:
- Rung-5 live-editor test:
- Cleanup and dirty-package assertions:
- License note:

## Revisit triggers

- Upstream stable release or security advisory:
- Epic engine minor release:
- MCP specification/SDK release:
- Hayba incident or architecture change:
- Next scheduled date:
