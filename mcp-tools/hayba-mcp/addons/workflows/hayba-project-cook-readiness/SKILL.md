---
name: hayba-project-cook-readiness
description: Use when checking whether an Unreal project can cook for a named target and tracing asset, validation, or asynchronous cook failures.
metadata:
  category: release
  tags: cook, build, assets, validation
---

# Check cook readiness

## When to use

Use before a milestone build for a named platform and configuration. Record the exact target, expected maps and content, known baseline, and pass criteria. A successful cook is only one gate toward a shippable build.

## Tool routing

- Read project_get_info and project_get_settings for the target context. Run content_validate and validator_run on the relevant content, then inspect asset_get_dependencies for assets named in any warning or error. Fix the specific fault with focused tools and re-run that check.
- Read get_tool_signature for the platform and cook scope, then start build_cook only after the target is settled. It returns a background job identifier; poll build_status until it reaches a terminal result. Inspect exit code and diagnostic output, not just job creation. If the call's outcome is uncertain, query build_status for the same job before starting another cook.
- Where a code build is required, run build_project separately and poll its job through build_status. Preserve warnings and skipped validations in the report. This workflow does not package, sign, deploy, or certify a release.

## Evidence

Report platform/configuration, validation results, job identifier, terminal exit code, relevant errors and warnings, and unresolved assets. A zero-exit cook does not prove gameplay, frame rate, memory, console certification, or distributable packaging.
