// mcp_server/src/cli/exit-codes.ts
/**
 * Exit code contract for `hayba-cli`. A CI job's only signal is the process
 * exit code — stdout/stderr are for humans, the code is for the pipeline.
 * Keep these stable; a CI script may branch on the numeric value.
 */

/** Spec ran to completion; every step reported success. */
export const EXIT_OK = 0;

/** The spec file could not be read or parsed, or failed structural
 *  validation (missing/empty `steps`, a step without a `cmd`, etc). Nothing
 *  was sent to UE — this is a pure input-shape failure caught before any
 *  connection attempt. */
export const EXIT_SPEC_ERROR = 1;

/** The spec was valid but UE could not be reached before the first step
 *  ran. Distinct from EXIT_STEP_FAILED so CI can tell "our script is wrong"
 *  apart from "the environment wasn't ready". */
export const EXIT_UE_UNREACHABLE = 2;

/** UE was reached, but a step in the spec returned a failure (UE responded
 *  `ok: false`, or the transport dropped mid-run). Execution stops at the
 *  first failing step — later steps are not attempted. */
export const EXIT_STEP_FAILED = 3;

/** Anything that reached the top-level catch unclassified — a bug in the
 *  CLI itself, not a spec or UE problem. Kept distinct from EXIT_SPEC_ERROR
 *  so "the CLI crashed" is never confused with "your spec is malformed". */
export const EXIT_UNEXPECTED_ERROR = 4;
