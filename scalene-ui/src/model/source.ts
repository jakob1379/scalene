/**
 * Source lookup for stack frames (upstream `makeFileSourceLookup`, §7.5):
 * `(filename, 1-based line)` → the unescaped, right-trimmed source text, or
 * "" when the file is not in the profile or the line is out of range. Sparse
 * files work because the model indexes lines by number.
 */

import type { Model } from "./model";

export type SourceLookup = (filename: string, line: number) => string;

export function makeFileSourceLookup(model: Pick<Model, "fileByName">): SourceLookup {
  return (filename: string, line: number): string => {
    const row = model.fileByName.get(filename)?.byNo.get(line);
    return row ? row.text.trimEnd() : "";
  };
}

/** True when frames of `filename` can jump to source. */
export function hasSource(model: Pick<Model, "fileByName">, filename: string): boolean {
  return model.fileByName.has(filename);
}
