/**
 * Prompt construction for AI optimization proposals, ported from upstream
 * `scalene-gui/optimizations.ts` (`proposeOptimization`, `optimizeCode`,
 * `generateScaleneOptimizedCodeRequest`) and the proposal-eligibility rules of
 * `scalene-gui.ts` `makeProfileLine`. Pure functions over plain profile data:
 * no DOM, no network.
 *
 * Prompt strings are reproduced verbatim, including upstream quirks (marked
 * "sic") so that results stay comparable with the old GUI.
 */

/** Per-line statistics the prompt cites. Structurally a subset of the profile's LineData. */
export interface LineStats {
  n_cpu_percent_python: number;
  n_cpu_percent_c: number;
  n_sys_percent: number;
  /** Fraction 0..1 (absent in very old profiles). */
  n_core_utilization?: number;
  n_peak_mb: number;
  n_python_fraction: number;
  n_copy_mb_s: number;
  n_gpu_percent: number;
}

/** One source line as found in `profile.files[name].lines`. */
export interface ProfileLine extends LineStats {
  lineno: number;
  /** Source text, normally ending in "\n"; may contain `\uXXXX` escapes. */
  line: string;
  /** Narrowest enclosing loop/function region (inclusive). Defaults to `lineno`. */
  start_region_line?: number;
  end_region_line?: number;
}

export type ProposalMode = "line" | "region";
export type OptimizationTarget = "performance" | "memory";

/**
 * Which prompt to send.
 *  - "insights": upstream's actual behaviour. `optimizeCode` builds the
 *    performance and memory prompts but then overrides them with
 *    `prompt = bigPrompt` ("Just use big prompt maybe FIXME"), so the
 *    optimization-target radio had no effect.
 *  - "targeted": the performance or memory prompt, by `target`.
 *  - "auto" (default): "insights" for performance, the memory prompt for
 *    memory, so the target choice matters while performance prompts stay
 *    identical to upstream.
 */
export type PromptStyle = "auto" | "insights" | "targeted";

/** Upstream `maxLinesPerRegion`: no region proposals for regions longer than this. */
export const MAX_LINES_PER_REGION = 50;

/** Libraries always suggested by the insights prompt. */
export const DEFAULT_HIGH_PERFORMANCE_LIBRARIES: readonly string[] = [
  "NumPy",
  "Scikit-learn",
  "Pandas",
  "TensorFlow",
  "PyTorch",
];

// ---------------------------------------------------------------------------
// Small helpers (upstream utils.ts)
// ---------------------------------------------------------------------------

/** Turn literal `\uXXXX` sequences (as Scalene writes `<` etc.) back into characters. */
export function unescapeUnicode(s: string): string {
  return s.replace(/\\u([\dA-F]{4})/gi, (_m, p1: string) => String.fromCharCode(parseInt(p1, 16)));
}

/** Upstream `countSpaces`: length of the leading whitespace run. */
export function countLeadingSpaces(s: string): number {
  const m = s.match(/^\s+/);
  return m ? m[0].length : 0;
}

/** python + native + system CPU percent of a line. */
export function totalCpuPercent(s: LineStats): number {
  return s.n_cpu_percent_python + s.n_cpu_percent_c + s.n_sys_percent;
}

/** Region bounds of a line, defaulting to the line itself. */
export function regionOf(line: ProfileLine): { start: number; end: number } {
  return {
    start: line.start_region_line || line.lineno,
    end: line.end_region_line || line.lineno,
  };
}

/** Look a line up by number. Lines are dense in current profiles (index = lineno - 1); old ones may be sparse. */
export function findLine(lines: readonly ProfileLine[], lineno: number): ProfileLine | undefined {
  const guess = lines[lineno - 1];
  if (guess && guess.lineno === lineno) return guess;
  return lines.find((l) => l.lineno === lineno);
}

function sourceText(lines: readonly ProfileLine[], from: number, to: number): string {
  let out = "";
  for (let n = from; n <= to; n++) {
    const l = findLine(lines, n);
    if (!l) continue;
    const text = unescapeUnicode(l.line);
    out += text.endsWith("\n") ? text : text + "\n";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which lines offer proposals
// ---------------------------------------------------------------------------

export interface ProposalAvailability {
  /** Show the line (lightning) button. */
  line: boolean;
  /** Show the region (explosion) button here, for lines `start..end`. */
  region: { start: number; end: number } | null;
}

/**
 * Upstream eligibility, computed for a whole file's lines in order:
 *  - A line in a one-line region (start == end) gets a line proposal when its
 *    own CPU time (python + native + system) is >= 1%.
 *  - A line inside a multi-line region gets a line proposal when the REGION's
 *    CPU time is >= 1% (summed over lines start+1..end, as upstream does),
 *    regardless of the line's own time.
 *  - The region proposal appears once per region: on the first line (in file
 *    order) carrying that region, only if the line proposal is available there
 *    and the region spans at most `maxLinesPerRegion` lines (end - start).
 * Only the file listing offers proposals; function summaries never do.
 */
export function computeProposalAvailability(
  lines: readonly ProfileLine[],
  maxLinesPerRegion: number = MAX_LINES_PER_REGION,
): Map<number, ProposalAvailability> {
  const result = new Map<number, ProposalAvailability>();
  const seenRegions = new Set<string>();
  for (const line of lines) {
    const { start, end } = regionOf(line);
    let regionTime = 0;
    for (let n = start + 1; n <= end; n++) {
      const l = findLine(lines, n);
      if (l) regionTime += totalCpuPercent(l);
    }
    let propose = true;
    if (start === end) {
      if (totalCpuPercent(line) < 1.0) propose = false;
    } else if (regionTime < 1.0) {
      propose = false;
    }

    let showRegion = false;
    const key = `${start - 1},${end}`;
    if (start !== end && !seenRegions.has(key)) {
      seenRegions.add(key);
      showRegion = true;
    }
    showRegion = showRegion && end - start <= maxLinesPerRegion;

    result.set(line.lineno, {
      line: propose,
      region: propose && showRegion ? { start, end } : null,
    });
  }
  return result;
}

/**
 * Statistics for a region proposal, aggregated the way upstream's
 * `makeProfileLine` builds its `newLine`: a copy of the anchor line plus the
 * sums over lines start+1..end of python/native/system/GPU percent, the peak
 * memory (and its Python fraction) of the hungriest line, and core
 * utilization accumulated as (python + native) * utilization (sic, mixed units).
 *
 * Deviation: upstream derived `n_copy_mb_s` from a field (`n_copy_mb`) that
 * profiles never contain, which made it NaN and silently dropped the memcpy
 * line from region prompts. Here it is the region's summed copy rate.
 */
export function aggregateRegionStats(lines: readonly ProfileLine[], anchor: ProfileLine): LineStats {
  const { start, end } = regionOf(anchor);
  const agg: LineStats = {
    n_cpu_percent_python: anchor.n_cpu_percent_python,
    n_cpu_percent_c: anchor.n_cpu_percent_c,
    n_sys_percent: anchor.n_sys_percent,
    n_core_utilization: anchor.n_core_utilization ?? 0,
    n_peak_mb: anchor.n_peak_mb,
    n_python_fraction: anchor.n_python_fraction,
    n_copy_mb_s: anchor.n_copy_mb_s,
    n_gpu_percent: anchor.n_gpu_percent,
  };
  for (let n = start + 1; n <= end; n++) {
    const l = findLine(lines, n);
    if (!l) continue;
    agg.n_cpu_percent_python += l.n_cpu_percent_python;
    agg.n_cpu_percent_c += l.n_cpu_percent_c;
    agg.n_sys_percent += l.n_sys_percent;
    agg.n_gpu_percent += l.n_gpu_percent;
    agg.n_copy_mb_s += l.n_copy_mb_s;
    if (l.n_peak_mb > agg.n_peak_mb) {
      agg.n_peak_mb = l.n_peak_mb;
      agg.n_python_fraction = l.n_python_fraction;
    }
    agg.n_core_utilization =
      (agg.n_core_utilization ?? 0) + (l.n_cpu_percent_python + l.n_cpu_percent_c) * (l.n_core_utilization ?? 0);
  }
  return agg;
}

// ---------------------------------------------------------------------------
// Code + context selection
// ---------------------------------------------------------------------------

export interface ProposalContext {
  mode: ProposalMode;
  /** The code to optimize ("Start of code" .. "End of code"). */
  code: string;
  /** Up to 9 lines preceding the code, given as context. */
  context: string;
  /** Line range the proposal replaces (inclusive). */
  startLine: number;
  endLine: number;
  /** Stats cited in the insights prompt (the line's, or the region aggregate). */
  stats: LineStats;
  /** Leading whitespace of the clicked line; upstream indents the answer by this (+ 2 icon widths). */
  leadingSpaces: number;
}

/**
 * Select the code and context for a proposal, as upstream `proposeOptimization`:
 *  - line:   code = the line; context = the 9 lines before it.
 *  - region: code = lines start..end of the clicked line's region; context =
 *            the 9 lines before `start`. Stats are `aggregateRegionStats`.
 */
export function buildProposalContext(
  lines: readonly ProfileLine[],
  lineno: number,
  mode: ProposalMode,
): ProposalContext {
  const target = findLine(lines, lineno);
  if (!target) throw new Error(`Line ${lineno} is not in the profile.`);
  const { start, end } = regionOf(target);
  const leadingSpaces = countLeadingSpaces(unescapeUnicode(target.line));
  if (mode === "region") {
    return {
      mode,
      code: sourceText(lines, start, end),
      context: sourceText(lines, Math.max(1, start - 9), start - 1),
      startLine: start,
      endLine: end,
      stats: aggregateRegionStats(lines, target),
      leadingSpaces,
    };
  }
  return {
    mode,
    code: sourceText(lines, lineno, lineno),
    context: sourceText(lines, Math.max(1, lineno - 9), lineno - 1),
    startLine: lineno,
    endLine: lineno,
    stats: target,
    leadingSpaces,
  };
}

// ---------------------------------------------------------------------------
// Prompts (verbatim from upstream optimizations.ts)
// ---------------------------------------------------------------------------

function fmtPercent(value: number, total: number): string {
  // Deviation: upstream divides unguarded and prints "NaN%" for a zero-CPU line
  // that qualifies through its hot region; we print "0.00%".
  return total === 0 ? (0).toFixed(2) : ((100 * value) / total).toFixed(2);
}

/**
 * Upstream `generateScaleneOptimizedCodeRequest`: the prompt that upstream
 * actually sends (the "insights" prompt).
 */
export function generateScaleneOptimizedCodeRequest(
  context: string,
  sourceCode: string,
  line: LineStats,
  recommendedLibraries: readonly string[] = [],
  includeGpuOptimizations = false,
  GPUdeviceName = "GPU",
): string {
  const highPerformanceLibraries = [...new Set([...DEFAULT_HIGH_PERFORMANCE_LIBRARIES, ...recommendedLibraries])];

  const promptParts: string[] = [
    "Optimize the following Python code to make it more efficient WITHOUT CHANGING ITS RESULTS.\n\n",
    context.trim(),
    "\n# Start of code\n",
    sourceCode.trim(),
    "\n# End of code\n\n",
    "Rewrite the above Python code from 'Start of code' to 'End of code', aiming for clear and simple optimizations. ",
    "Your output should consist only of valid Python code, with brief explanatory comments prefaced with #. ",
    "Include a detailed explanatory comment before the code, starting with '# Proposed optimization:'. ",
    `Leverage high-performance native libraries, especially those utilizing ${GPUdeviceName}, for significant performance improvements. `,
    "Consider using the following other libraries, if appropriate:\n",
    highPerformanceLibraries.map((e) => "  import " + e).join("\n") + "\n",
    "Eliminate as many for loops, while loops, and list or dict comprehensions as possible, replacing them with vectorized equivalents. ",
    "Quantify the expected speedup in terms of orders of magnitude if possible. ",
    "Fix any errors in the optimized code. ",
  ];

  if (includeGpuOptimizations) {
    promptParts.push(`Use ${GPUdeviceName}-accelerated libraries whenever it would substantially increase performance. `);
  }

  promptParts.push("Consider the following insights gathered from the Scalene profiler for optimization:\n");
  const total = totalCpuPercent(line);
  promptParts.push(`- CPU time: percent spent in the Python interpreter: ${fmtPercent(line.n_cpu_percent_python, total)}%\n`);
  promptParts.push(`- CPU time: percent spent executing native code: ${fmtPercent(line.n_cpu_percent_c, total)}%\n`);
  promptParts.push(`- CPU time: percent of system time: ${fmtPercent(line.n_sys_percent, total)}%\n`);
  // (sic) upstream divides a 0..1 fraction (times 100) by the CPU percent.
  promptParts.push(`- Core utilization: ${fmtPercent(line.n_core_utilization ?? 0, total)}%\n`);
  promptParts.push(
    `- Peak memory usage: ${line.n_peak_mb.toFixed(0)}MB (${(100 * line.n_python_fraction).toFixed(2)}% Python memory)\n`,
  );
  if (line.n_copy_mb_s > 1) {
    promptParts.push(`- Megabytes copied per second by memcpy/strcpy: ${line.n_copy_mb_s.toFixed(2)}\n`);
  }
  if (includeGpuOptimizations) {
    // (sic) n_gpu_percent is already a percentage; upstream multiplies by 100 again.
    promptParts.push(`- GPU percent utilization: ${(100 * line.n_gpu_percent).toFixed(2)}%\n`);
  }
  promptParts.push(`Optimized code:`);
  return promptParts.join("");
}

export interface TargetedPromptInput {
  context: string;
  code: string;
  /** Native-module imports of the file (`profile.files[f].imports`). */
  imports: readonly string[];
  useGpu: boolean;
  gpuDeviceName: string;
}

function lineOf(code: string): string {
  return code.split("\n").length <= 2 ? " line of " : " ";
}

function suggestedLibraries(useGpu: boolean): string {
  return "import sklearn" + (useGpu ? "\nimport cupy" : "\nimport numpy as np");
}

/** Upstream `optimizePerformancePrompt` (built but unused upstream; see PromptStyle). */
export function buildPerformancePrompt(p: TargetedPromptInput): string {
  const lo = lineOf(p.code);
  const imports = p.imports.join("\n");
  const libraries = suggestedLibraries(p.useGpu);
  const useGPUstring = p.useGpu ? ` or ${p.gpuDeviceName}-optimizations ` : " ";
  return `Optimize the following${lo}Python code:\n\n${p.context}\n\n# Start of code\n\n${p.code}\n\n# End of code\n\nRewrite the above Python code only from "Start of code" to "End of code", to make it more efficient WITHOUT CHANGING ITS RESULTS. Assume the code has already executed all these imports; do NOT include them in the optimized code:\n\n${imports}\n\nUse native libraries if that would make it faster than pure Python. Consider using the following other libraries, if appropriate:\n\n${libraries}\n\nYour output should only consist of valid Python code. Output the resulting Python with brief explanations only included as comments prefaced with #. Include a detailed explanatory comment before the code, starting with the text "# Proposed optimization:". Make the code as clear and simple as possible, while also making it as fast and memory-efficient as possible. Use vectorized operations${useGPUstring}whenever it would substantially increase performance, and quantify the speedup in terms of orders of magnitude. Eliminate as many for loops, while loops, and list or dict comprehensions as possible, replacing them with vectorized equivalents. If the performance is not likely to increase, leave the code unchanged. Fix any errors in the optimized code. Optimized${lo}code:`;
}

/** Upstream `memoryEfficiencyPrompt` (built but unused upstream; see PromptStyle). */
export function buildMemoryPrompt(p: TargetedPromptInput): string {
  const lo = lineOf(p.code);
  const imports = p.imports.join("\n");
  const libraries = suggestedLibraries(p.useGpu);
  // (sic) "following${lo} Python" yields a double space for single lines, as upstream.
  return `Optimize the following${lo} Python code:\n\n${p.context}\n\n# Start of code\n\n${p.code}\n\n\n# End of code\n\nRewrite the above Python code only from "Start of code" to "End of code", to make it more memory-efficient WITHOUT CHANGING ITS RESULTS. Assume the code has already executed all these imports; do NOT include them in the optimized code:\n\n${imports}\n\nUse native libraries if that would make it more space efficient than pure Python. Consider using the following other libraries, if appropriate:\n\n${libraries}\n\nYour output should only consist of valid Python code. Output the resulting Python with brief explanations only included as comments prefaced with #. Include a detailed explanatory comment before the code, starting with the text "# Proposed optimization:". Make the code as clear and simple as possible, while also making it as fast and memory-efficient as possible. Use native libraries whenever possible to reduce memory consumption; invoke del on variables and array elements as soon as it is safe to do so. If the memory consumption is not likely to be reduced, leave the code unchanged. Fix any errors in the optimized code. Optimized${lo}code:`;
}

export interface PromptOptions {
  target: OptimizationTarget;
  useGpu: boolean;
  /** Accelerator label: `profile.gpu_device` when `profile.gpu`, else "GPU". */
  gpuDeviceName: string;
  style: PromptStyle;
  imports: readonly string[];
}

/** Resolve the prompt kind actually used for these options. */
export function effectivePromptKind(style: PromptStyle, target: OptimizationTarget): "insights" | OptimizationTarget {
  if (style === "insights") return "insights";
  if (style === "targeted") return target;
  return target === "memory" ? "memory" : "insights";
}

/** Build the prompt for a proposal. */
export function buildOptimizationPrompt(ctx: ProposalContext, opts: PromptOptions): string {
  const kind = effectivePromptKind(opts.style, opts.target);
  if (kind === "insights") {
    // Upstream: recommendedLibraries = ["sklearn", useGPUs ? "cupy" : "numpy"].
    const recommended = ["sklearn", opts.useGpu ? "cupy" : "numpy"];
    return generateScaleneOptimizedCodeRequest(
      ctx.context,
      ctx.code,
      ctx.stats,
      recommended,
      opts.useGpu,
      opts.gpuDeviceName || "GPU",
    );
  }
  const input: TargetedPromptInput = {
    context: ctx.context,
    code: ctx.code,
    imports: opts.imports,
    useGpu: opts.useGpu,
    gpuDeviceName: opts.gpuDeviceName || "GPU",
  };
  return kind === "memory" ? buildMemoryPrompt(input) : buildPerformancePrompt(input);
}
