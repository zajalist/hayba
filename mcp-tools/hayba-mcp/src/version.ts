import { createRequire } from 'node:module';

// Both src and dist sit directly below the package root.
export const HAYBA_VERSION: string = createRequire(import.meta.url)('../package.json').version;
