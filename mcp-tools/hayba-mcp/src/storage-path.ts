import { isAbsolute, relative, resolve, sep } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_STEM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/i;

export class StorageIdentifierError extends Error {
  readonly code = 'invalid_storage_identifier';

  constructor(label: string) {
    super(`${label} is not a valid storage identifier`);
    this.name = 'StorageIdentifierError';
  }
}

export function isStorageUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function requireStorageUuid(value: unknown, label: string): string {
  if (!isStorageUuid(value)) throw new StorageIdentifierError(label);
  return value;
}

/** A portable filename stem: no separators, dot segments, devices, or ADS. */
export function requireStorageFileStem(value: unknown, label: string): string {
  if (typeof value !== 'string' || !FILE_STEM.test(value) || WINDOWS_DEVICE.test(value)) {
    throw new StorageIdentifierError(label);
  }
  return value;
}

/**
 * Resolve only strict child paths. This is a second boundary behind the
 * identifier allowlists: a future caller cannot make a traversal safe merely
 * by forgetting which segment validator it needed.
 */
export function resolveStorageChild(root: string, ...segments: string[]): string {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, ...segments);
  const fromRoot = relative(absoluteRoot, candidate);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new StorageIdentifierError('storage path');
  }
  return candidate;
}
