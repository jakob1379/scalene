// CSS lints: class ownership (run by build.mjs) and the radius scale (run by
// tools/check-tokens.mjs); both unit-tested in tests/unit/css-ownership.test.mjs.
/**
 * Package stylesheets (10-… to 90-…) each own their class names. A bare class selector
 * (`.name`, optionally with pseudo-classes or attributes, no combinator) defined in two package
 * files is a collision: the later file silently restyles the other package's component (round 1:
 * the shortcuts dialog's `.sc-row` broke the scope readout card). Shared files (00-04) may be
 * extended by packages; contextual overrides (`.short .name`, `.card .name`) are allowed.
 */
export function cssClassCollisions(files) {
  const owners = new Map();
  for (const [name, text] of files) {
    if (!/^[1-9]\d-/.test(name)) continue;
    const body = text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of body.matchAll(/([^{}]+)\{/g)) {
      const sel = m[1].trim();
      if (sel.startsWith("@")) continue;
      for (const part of sel.split(",")) {
        const bare = /^\.([A-Za-z_][\w-]*)(?:[:[][^\s>+~]*)?$/.exec(part.trim());
        if (!bare) continue;
        const set = owners.get(bare[1]) ?? new Set();
        set.add(name);
        owners.set(bare[1], set);
      }
    }
  }
  return [...owners].filter(([, set]) => set.size > 1).map(([cls, set]) => `.${cls} is defined in ${[...set].join(" and ")}`);
}

/** Off-scale `border-radius` literals (§3.2 radius tokens; ≤ 2 px hairlines, 0 and 50% allowed). */
export function radiusViolations(name, text) {
  const out = [];
  const body = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  for (const m of body.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;}]+)/g)) {
    const value = m[1].trim();
    for (const part of value.replace(/var\(--r-[\w-]+\)|calc\([^)]*var\(--r-[\w-]+\)[^)]*\)/g, "").split(/[\s/]+/).filter(Boolean)) {
      if (part === "0" || part === "50%" || part === "inherit" || part === "!important") continue;
      const px = /^(\d+(?:\.\d+)?)px$/.exec(part);
      if (px && Number(px[1]) <= 2) continue;
      const line = body.slice(0, m.index).split("\n").length;
      out.push(`${name}:${line}: border-radius ${value} is off the --r-* scale (3/6/8/12/16/999)`);
      break;
    }
  }
  return out;
}
