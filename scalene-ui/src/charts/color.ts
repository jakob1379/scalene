import { alpha } from "../core/canvas";

/**
 * Alpha for resolved token colours on canvas (tokens are `#rrggbb`, `#rgb`
 * or `rgb(r g b / a)` strings from `theme.tokens()`): the token's own alpha
 * times `a` (clamped to 0..1). Unknown formats are returned unchanged;
 * callers then fall back to `globalAlpha`.
 */
export function withAlpha(color: string, a: number): string {
  return alpha(color, Math.min(1, Math.max(0, a)));
}
