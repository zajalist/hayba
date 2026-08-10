#!/usr/bin/env node

// Keep this executable boundary intentionally tiny. ESM evaluates every
// static dependency before a module body, so installing the console wrapper in
// index.ts alone cannot protect import-time diagnostics from the rest of the
// server graph. This module imports only the redactor, installs it, and then
// starts the application through a dynamic import.
import { installConsoleSecretRedaction } from './security/secret-redaction.js';

installConsoleSecretRedaction();
await import('./index.js');
