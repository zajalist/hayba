export type JunctionType = 'PORTAL' | 'BOOLEAN_UNION' | 'CLASH';

export function junctionType(a: 'native' | 'imperial', b: 'native' | 'imperial'): JunctionType {
  if (a === 'imperial' && b === 'imperial') return 'PORTAL';
  if (a === 'native' && b === 'native') return 'BOOLEAN_UNION';
  return 'CLASH';
}
