import React from "react";

// Real SVG files live in src/assets/icons/Icon*.svg — open them in Illustrator
// / Figma / a text editor to edit shapes directly. This module imports them
// as URLs (Vite default for static assets) and renders via <img>.
//
// Visual language matches the UE plugin's HaybaMCPToolkit/Resources/ — 64x64
// viewBox with distinct per-icon palettes (no uniform stamp).

import sphereUrl from "../assets/icons/IconSphere.svg";
import platesUrl from "../assets/icons/IconPlates.svg";
import seedUrl   from "../assets/icons/IconSeed.svg";
import brushUrl  from "../assets/icons/IconBrush.svg";
import rerollUrl from "../assets/icons/IconReroll.svg";
import clearUrl  from "../assets/icons/IconClear.svg";
import bakeUrl   from "../assets/icons/IconBake.svg";
import eraseUrl  from "../assets/icons/IconErase.svg";
import rotateUrl from "../assets/icons/IconRotate.svg";
import zoomUrl   from "../assets/icons/IconZoom.svg";
import panUrl    from "../assets/icons/IconPan.svg";
import recenterUrl from "../assets/icons/IconRecenter.svg";
import boundaryUrl from "../assets/icons/IconBoundary.svg";
import playUrl from "../assets/icons/IconPlay.svg";
import pauseUrl from "../assets/icons/IconPause.svg";
import categoryComposeUrl from "../assets/icons/IconCategoryCompose.svg";
import categoryBoundariesUrl from "../assets/icons/IconCategoryBoundaries.svg";
import categoryDensitiesUrl from "../assets/icons/IconCategoryDensities.svg";
import categorySimulateUrl from "../assets/icons/IconCategorySimulate.svg";
import categorySettingsUrl from "../assets/icons/IconCategorySettings.svg";
import logoUrl from "../assets/logo.svg";

export interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

function img(src: string, alt: string, { size = 18, className, title }: IconProps) {
  return (
    <img
      src={src}
      alt={alt}
      title={title ?? alt}
      width={size}
      height={size}
      className={className}
      style={{ display: "block", flexShrink: 0 }}
      draggable={false}
    />
  );
}

export const IconSphere = (p: IconProps = {}) => img(sphereUrl, "sphere", p);
export const IconPlates = (p: IconProps = {}) => img(platesUrl, "plates", p);
export const IconSeed   = (p: IconProps = {}) => img(seedUrl,   "seed",   p);
export const IconBrush  = (p: IconProps = {}) => img(brushUrl,  "brush",  p);
export const IconReroll = (p: IconProps = {}) => img(rerollUrl, "reroll", p);
export const IconClear  = (p: IconProps = {}) => img(clearUrl,  "clear",  p);
export const IconBake   = (p: IconProps = {}) => img(bakeUrl,   "bake",   p);
export const IconErase  = (p: IconProps = {}) => img(eraseUrl,  "erase",  p);
export const IconRotate = (p: IconProps = {}) => img(rotateUrl, "rotate", p);
export const IconZoom   = (p: IconProps = {}) => img(zoomUrl,   "zoom",   p);
export const IconPan    = (p: IconProps = {}) => img(panUrl,    "pan",    p);
export const IconRecenter = (p: IconProps = {}) => img(recenterUrl, "recenter", p);
export const IconBoundary = (p: IconProps = {}) => img(boundaryUrl, "boundary", p);
export const IconPlay     = (p: IconProps = {}) => img(playUrl,     "play",     p);
export const IconPause    = (p: IconProps = {}) => img(pauseUrl,    "pause",    p);
export const IconCategoryCompose = (p: IconProps = {}) => img(categoryComposeUrl, "compose", p);
export const IconCategoryBoundaries = (p: IconProps = {}) => img(categoryBoundariesUrl, "boundaries", p);
export const IconCategoryDensities = (p: IconProps = {}) => img(categoryDensitiesUrl, "densities", p);
export const IconCategorySimulate = (p: IconProps = {}) => img(categorySimulateUrl, "simulate", p);
export const IconCategorySettings = (p: IconProps = {}) => img(categorySettingsUrl, "settings", p);
export const Logo = (p: IconProps = {}) => img(logoUrl, "logo", p);

export const ICON_URLS = {
  sphere: sphereUrl,
  plates: platesUrl,
  seed:   seedUrl,
  brush:  brushUrl,
  reroll: rerollUrl,
  clear:  clearUrl,
  bake:   bakeUrl,
  erase:  eraseUrl,
  rotate: rotateUrl,
  zoom:   zoomUrl,
  pan:    panUrl,
  recenter: recenterUrl,
  boundary: boundaryUrl,
  play:     playUrl,
  pause:    pauseUrl,
  categoryCompose: categoryComposeUrl,
  categoryBoundaries: categoryBoundariesUrl,
  categoryDensities: categoryDensitiesUrl,
  categorySimulate: categorySimulateUrl,
  categorySettings: categorySettingsUrl,
  logo: logoUrl,
};
