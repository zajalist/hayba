/**
 * Maps element id → generator function. Hand-authored — adding a new element
 * type requires both adding a .ts file here AND registering it in this map.
 */
import type { ElementBinding } from '../../schema.js';
import type { Mesh } from '../types.js';
import { columnGraph } from './column.js';
import { corniceGraph } from './cornice.js';
import { finialGraph } from './finial.js';

export type ElementGenerator = (b: ElementBinding) => Mesh;

export const ELEMENT_GENERATORS: Readonly<Record<string, ElementGenerator>> = {
  column: columnGraph,
  cornice: corniceGraph,
  finial: finialGraph,
};
