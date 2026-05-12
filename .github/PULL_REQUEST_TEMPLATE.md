## Summary

<!-- 1-3 sentences. What does this PR change and why? -->

## Type of change

- [ ] Bug fix
- [ ] New MCP tool
- [ ] New UE handler / command
- [ ] UI / Slate panel change
- [ ] Refactor (no behaviour change)
- [ ] Documentation only
- [ ] Build / CI / tooling

## Roadmap link

<!-- If this implements a market-research initiative, paste the issue #. Otherwise delete this section. -->
Closes #

## Checklist

- [ ] `npm run build` is clean.
- [ ] If a TS file was added, it's registered with the Zod schema registry.
- [ ] If a C++ command was added, it's listed in `GetCommands()` AND dispatched in `Handle()`.
- [ ] If destructive, it's classified in `IsDestructiveCommand()` so transactions wrap it.
- [ ] Spec doc updated if behaviour changes.
- [ ] CHANGELOG entry added under `[Unreleased]`.

## Test plan

<!-- How did you verify this? Include MCP tool calls if relevant. -->
