#pragma once

/**
 * The one number the two halves of the install agree to speak.
 *
 * The UE plugin and the npm server ship separately and version separately —
 * this plugin is on 0.3.0 while the npm package is on 1.0.0, and neither
 * number says anything about whether they can talk to each other. Comparing
 * those two reports skew on every healthy install.
 *
 * This is not a product version. It changes ONLY when the wire contract
 * changes in a way that breaks an older peer:
 *
 *   BUMP for      — a command removed or renamed; a required parameter added;
 *                   a response field a caller depends on removed or retyped.
 *   DO NOT bump   — a command added; an optional parameter added; a response
 *                   field added. An older peer keeps working through all of
 *                   those, and bumping would make every such release look
 *                   like a breaking one.
 *
 * Kept in step by hand with mcp-tools/hayba-mcp/src/protocol-version.ts. Two
 * constants rather than one generated from the other, because the alternative
 * is a build-time dependency between an npm package and a UE plugin that are
 * deliberately independent — and a mismatch here is exactly what the check is
 * for.
 */
#define HAYBA_PROTOCOL_VERSION 1
