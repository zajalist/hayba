import React from "react";

// Hayba Explorer iconography — visual language ported from the UE plugin
// resources at HaybaMCPToolkit/Resources/. Each icon is:
//   - a cream-body filled shape (`uFill`)
//   - bound by a 2-weight accent stroke (`uStroke`)
//   - sometimes accented with a deeper hue for the "active" element
// 24x24 viewBox keeps geometric detail crisp when rendered at 14-16px.

export interface IconProps {
  size?: number;
  fill?: string;
  stroke?: string;
  className?: string;
}

const FILL_DEFAULT   = "#DED4C3"; // matches the UE-plugin cream body
const STROKE_DEFAULT = "#B56A1D"; // Hayba filled accent

function frame(props: IconProps, paths: React.ReactNode) {
  const { size = 16, fill = FILL_DEFAULT, stroke = STROKE_DEFAULT, className } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={1.6}
      strokeLinejoin="miter"
      strokeLinecap="square"
      className={className}
      style={{ flexShrink: 0, color: stroke }}
    >
      <g data-fill={fill}>{paths}</g>
    </svg>
  );
}

/** Two stacked dice — the "roll a new seed" affordance. */
export function IconReroll(props: IconProps) {
  const fill = props.fill ?? FILL_DEFAULT;
  const stroke = props.stroke ?? STROKE_DEFAULT;
  return frame(props, (
    <>
      <rect x="3.5" y="9.5" width="10" height="10" fill={fill} stroke={stroke} />
      <circle cx="6.5" cy="12.5" r="0.9" fill={stroke} stroke="none" />
      <circle cx="10.5" cy="16.5" r="0.9" fill={stroke} stroke="none" />
      <rect x="11.5" y="3.5" width="9" height="9" fill={fill} stroke={stroke} />
      <circle cx="16" cy="8" r="0.9" fill={stroke} stroke="none" />
    </>
  ));
}

/** Trash can — clear continents. */
export function IconClear(props: IconProps) {
  const fill = props.fill ?? FILL_DEFAULT;
  const stroke = props.stroke ?? STROKE_DEFAULT;
  return frame(props, (
    <>
      <path d="M5 8 L19 8 L17.5 20 L6.5 20 Z" fill={fill} stroke={stroke} />
      <line x1="3" y1="5.5" x2="21" y2="5.5" stroke={stroke} />
      <path d="M9 4 L9 5 L15 5 L15 4" fill="none" stroke={stroke} />
      <line x1="10" y1="11" x2="10" y2="17" stroke={stroke} />
      <line x1="14" y1="11" x2="14" y2="17" stroke={stroke} />
    </>
  ));
}

/** Hayba spark — echoes the sun-ray crown on the logo. The "bake" mark. */
export function IconBake(props: IconProps) {
  const fill = props.fill ?? FILL_DEFAULT;
  const stroke = props.stroke ?? STROKE_DEFAULT;
  return frame(props, (
    <>
      <path
        d="M12 2 L13.6 9 L21 10.4 L15.4 14.4 L17.2 22 L12 17.8 L6.8 22 L8.6 14.4 L3 10.4 L10.4 9 Z"
        fill={fill}
        stroke={stroke}
      />
      <circle cx="12" cy="12" r="1.6" fill={stroke} stroke="none" />
    </>
  ));
}

/** Flat-edge brush — used in the Continents section heading. */
export function IconBrush(props: IconProps) {
  const fill = props.fill ?? FILL_DEFAULT;
  const stroke = props.stroke ?? STROKE_DEFAULT;
  return frame(props, (
    <>
      <path d="M3.5 17.5 L9 12 L13 16 L7.5 21 Z" fill={fill} stroke={stroke} />
      <path d="M9 12 L17 4 L21 8 L13 16 Z" fill={fill} stroke={stroke} />
      <line x1="7.5" y1="21" x2="3.5" y2="21" stroke={stroke} />
    </>
  ));
}

/** Icosphere — globe with meridian + equator. */
export function IconSphere(props: IconProps) {
  const fill = props.fill ?? FILL_DEFAULT;
  const stroke = props.stroke ?? STROKE_DEFAULT;
  return frame(props, (
    <>
      <circle cx="12" cy="12" r="9" fill={fill} stroke={stroke} />
      <ellipse cx="12" cy="12" rx="9" ry="3.5" fill="none" stroke={stroke} />
      <line x1="12" y1="3" x2="12" y2="21" stroke={stroke} />
    </>
  ));
}

/** Globe with a tectonic seam — divergent boundary suggestion. */
export function IconPlates(props: IconProps) {
  const fill = props.fill ?? FILL_DEFAULT;
  const stroke = props.stroke ?? STROKE_DEFAULT;
  return frame(props, (
    <>
      <circle cx="12" cy="12" r="9" fill={fill} stroke={stroke} />
      <path d="M3.5 10 Q8 14 12 10 T20.5 13" fill="none" stroke={stroke} strokeWidth={1.8} />
      <circle cx="8" cy="11.2" r="0.8" fill={stroke} stroke="none" />
      <circle cx="16" cy="11.6" r="0.8" fill={stroke} stroke="none" />
    </>
  ));
}

/** Hash — seed glyph. Crosshatched grid evokes the determinism contract. */
export function IconSeed(props: IconProps) {
  const fill = props.fill ?? FILL_DEFAULT;
  const stroke = props.stroke ?? STROKE_DEFAULT;
  return frame(props, (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" fill={fill} stroke={stroke} />
      <line x1="9" y1="4" x2="9" y2="20" stroke={stroke} />
      <line x1="15" y1="4" x2="15" y2="20" stroke={stroke} />
      <line x1="4" y1="9" x2="20" y2="9" stroke={stroke} />
      <line x1="4" y1="15" x2="20" y2="15" stroke={stroke} />
    </>
  ));
}
