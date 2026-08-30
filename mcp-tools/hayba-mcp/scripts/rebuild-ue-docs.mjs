#!/usr/bin/env node

// The implementation lives under src/ and is compiled with the server so its budgets, atomic
// publisher and tests cannot drift from query_ue_docs. Run `npm run build:server` first in a source
// checkout; packaged distributions already contain dist/.
import { runUeDocsRebuildCli } from '../dist/tools/docs/rebuild-ue-docs-cli.js';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => controller.abort());
}

process.exitCode = await runUeDocsRebuildCli(process.argv.slice(2), undefined, controller.signal);
