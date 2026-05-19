/** Cap the long side to `max`, preserving the source aspect, integer,
 *  always >= 1. Equirect WIND is 2:1 but this works for any aspect. */
export function windFlowSize(
  srcW: number,
  srcH: number,
  max: number,
): { w: number; h: number } {
  const long = Math.max(srcW, srcH);
  const scale = long > max ? max / long : 1;
  return {
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale)),
  };
}
