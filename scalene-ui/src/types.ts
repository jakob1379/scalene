/**
 * Types for the Scalene profile JSON consumed by the GUI.
 *
 * Mirrors `ScaleneJSONSchema` / `FileDetail` / `LineDetail` / `FunctionDetail` /
 * `LeakInfo` / `CombinedStackFrame` / `CombinedStackTimelineEvent` in upstream
 * `scalene/scalene_json.py` (Scalene 2.4.0), plus the fields added by
 * `merge_scalene_neuron_profiles.py`. Full semantics, invariants and examples:
 * notes/schema.md.
 *
 * Optional markers follow reality: a field is optional when some profile
 * version still in the wild lacks it (the very old `example-profile.js` and
 * the mid-age `profile.json` samples are the evidence). Current emitters
 * always write every non-Neuron field. Use the `Normalized*` types after
 * filling defaults (see the "Defaults" notes on each field).
 *
 * Wire facts worth knowing up front:
 *  - The JSON is written with `sort_keys=True`: `files` and `leaks` are in
 *    alphabetical key order, NOT by importance. Sort in the UI.
 *  - Memory sample times are relative nanoseconds since profiling start;
 *    `cpu_samples_list` holds absolute `perf_counter` seconds; timeline
 *    `t_sec` is seconds since the first timeline run.
 *  - "MB" everywhere means MiB (2^20 bytes).
 *
 * Types only: this module emits no runtime code.
 */

// ---------------------------------------------------------------------------
// Documentation aliases (all plain numbers at runtime).
// ---------------------------------------------------------------------------

/** Seconds (float). */
export type Seconds = number;
/** Nanoseconds (integer as float). */
export type Nanoseconds = number;
/** Mebibytes (2^20 bytes); Scalene calls these "MB". */
export type MiB = number;
/** Percentage in [0, 100]. */
export type Percent = number;
/** Fraction in [0, 1]. */
export type Fraction = number;
/** 1-based source line number. */
export type LineNo = number;
/** Python thread identifier (`threading.get_ident()`), < 2^53 in practice. */
export type ThreadId = number;

/**
 * One memory-footprint sample: `[t, footprint]`.
 *  - `t`: nanoseconds since profiling start (`time.monotonic_ns() - start`).
 *    May slightly exceed `elapsed_time_sec * 1e9` (different clocks); use
 *    `max(elapsed*1e9, lastT)` as the axis max.
 *  - `footprint`: the GLOBAL program footprint in MiB at that moment (also for
 *    per-line samples: it is the program footprint when that line allocated
 *    or freed, not the line's own footprint). Always <= `max_footprint_mb`.
 * Sorted by `t`. Usually <= 100 points (reservoir), old profiles may have
 * thousands.
 */
export type MemorySample = [t: Nanoseconds, footprint: MiB];

/**
 * Accelerator label. `"GPU"` = NVIDIA (NVML) or Apple Silicon (MPS);
 * `"Neuron"` = AWS Inferentia/Trainium; `""` = none. Use only as a label:
 * gate GPU UI on `Profile.gpu`. Typed open-ended for forward compatibility.
 */
export type GpuDevice = "GPU" | "Neuron" | "" | (string & {});

// ---------------------------------------------------------------------------
// Per-line / per-function metrics
// ---------------------------------------------------------------------------

/**
 * Metrics shared by source lines and function summaries
 * (upstream `FunctionDetail`). All values cover the whole run.
 * "Program-wide" means the denominator is the whole program (all files),
 * not the file.
 */
export interface LineMetrics {
  /**
   * Lines: 1-based line number. Functions: the function's first line
   * (`co_firstlineno`: the `def` line, or its first decorator).
   */
  lineno: LineNo;
  /**
   * Lines: raw source text INCLUDING the trailing "\n", with `&`, `<`, `>`
   * replaced by the 6-character literals `&`, `<`, `>`
   * (backslash included). Unescape before display.
   * Functions: the qualified function name (e.g. "Model.forward"), unescaped.
   */
  line: string;

  // -- CPU ------------------------------------------------------------------

  /**
   * % of program-wide sampled time spent in the Python interpreter on this
   * line, already multiplied by the mean CPU utilization `u`. 0..100.
   */
  n_cpu_percent_python: Percent;
  /**
   * % of program-wide sampled time in native code (C extensions, libraries,
   * time inside a call), multiplied by `u`. For JIT lines with no signal
   * samples this may instead carry PyTorch-profiler time. 0..100.
   */
  n_cpu_percent_c: Percent;
  /**
   * "System" %: `(raw_python + raw_native) * (1 - u)`. This is time not
   * spent in user mode (syscalls, I/O, blocking). 0..100. The line's total
   * time share is `python + c + sys`. Per line and per file the sum is
   * <= 100, and a file's line sum ~= `FileData.percent_cpu_time`.
   */
  n_sys_percent: Percent;
  /**
   * Mean share of ALL cores busy while this line ran:
   * `(user / wall) / available_cpus`. 0..1.
   * Absent in very old profiles. Default 0.
   */
  n_core_utilization?: Fraction;
  /**
   * Absolute `time.perf_counter()` seconds of main-thread CPU samples
   * attributed here (sorted reservoir, <= 500). Relative time:
   * `v - Profile.start_time_perf`. Always `[]` for functions and for
   * unprofiled lines. Absent before ~2024 profiles. Default [].
   */
  cpu_samples_list?: Seconds[];

  // -- Memory (all 0 / [] when Profile.memory is false) ---------------------

  /**
   * Cumulative MiB allocated (sampled) here over the run. This is a volume,
   * so it can far exceed any footprint.
   */
  n_malloc_mb: MiB;
  /**
   * Number of allocation episodes: times the line's high-water mark was
   * finalized. Repeated mallocs within one execution of the line count once.
   */
  n_mallocs: number;
  /**
   * Peak live MiB attributed to this line (its malloc-free running total,
   * maxed), clamped to <= `Profile.max_footprint_mb`.
   */
  n_peak_mb: MiB;
  /** Deprecated alias: always equals `n_peak_mb`. */
  n_growth_mb: MiB;
  /** Average of the line's per-episode high-water marks. <= `n_peak_mb`. */
  n_avg_mb: MiB;
  /**
   * Share of this line's allocated MiB that came from Python objects (vs
   * native). 0..1; 0 when nothing was allocated.
   */
  n_python_fraction: Fraction;
  /**
   * This line's share of ALL sampled allocation volume in the program:
   * `n_malloc_mb / total_malloc_mb`. 0..1. Summed over every line of every
   * file it is ~1. Upstream's "memory activity" pie, shown when >= 0.01.
   */
  n_usage_fraction: Fraction;
  /**
   * Average memcpy/strcpy bandwidth attributed here:
   * bytes / 2^20 / elapsed_time_sec. MiB/s.
   * (Upstream's `n_copy_mb` is never emitted.)
   */
  n_copy_mb_s: number;
  /**
   * Sparkline: program footprint at moments this line allocated or freed.
   * See `MemorySample`. [] when there was no activity.
   */
  memory_samples: MemorySample[];

  // -- GPU (meaningful only when Profile.gpu) -------------------------------

  /**
   * Time-weighted MEAN device utilization while this line ran. 0..100.
   * This is not a share of total GPU time, and it does not sum to 100
   * across lines. For Neuron it is NeuronCore utilization.
   */
  n_gpu_percent: Percent;
  /**
   * Mean device memory used by the process at this line's samples, MiB.
   * Absent in very old profiles. Default 0.
   */
  n_gpu_avg_memory_mb?: MiB;
  /**
   * Peak device memory used by the process at this line's samples, MiB.
   * >= avg. Absent in very old profiles. Default 0.
   */
  n_gpu_peak_memory_mb?: MiB;

  // -- Async (meaningful only when Profile.async_profile) -------------------
  // All absent in pre-async profiles, then always present (zeros) even
  // without --async.

  /**
   * Share of all await time attributed to coroutines suspended at this
   * line. 0..100; sums to ~100 across lines. Default 0.
   */
  n_async_await_percent?: Percent;
  /**
   * Mean number of program-wide suspended tasks in samples where a task
   * awaited here. Default 0.
   */
  n_async_concurrency_mean?: number;
  /** Peak number of suspended tasks in those samples. Default 0. */
  n_async_concurrency_peak?: number;
  /**
   * Sorted names of tasks seen suspended here ("Task-1", ...), <= 100.
   * Default [].
   */
  async_task_names?: string[];
  /** The enclosing function is an `async def`. Default false. */
  is_coroutine?: boolean;
}

/**
 * Enclosing-block info for a source line, from AST analysis. All ranges are
 * 1-based and INCLUSIVE `[start, end]`. Absent in very old profiles. The
 * function bounds are also absent in mid-age ones.
 */
export interface LineRegionFields {
  /**
   * Narrowest enclosing region: the innermost for/while loop, else the
   * innermost (sync) def, else the innermost class, else the line itself.
   * Default `lineno`.
   */
  start_region_line?: LineNo;
  /** End of the narrowest enclosing region (inclusive). Default `lineno`. */
  end_region_line?: LineNo;
  /**
   * Outermost enclosing loop within the current def/class/module scope, or
   * a compound-statement header's own block, else the line itself.
   * Unused by upstream. Default `lineno`.
   */
  start_outermost_loop?: LineNo;
  /** End of `start_outermost_loop`'s block (inclusive). Default `lineno`. */
  end_outermost_loop?: LineNo;
  /**
   * Innermost enclosing def, async def OR class; 0 at module level.
   * Default 0.
   */
  start_function_line?: number;
  /** End of that def/class (inclusive); 0 at module level. Default 0. */
  end_function_line?: number;
}

/**
 * A Neuron Runtime `nrt_execute` event (from the Neuron merge tool).
 * `timestamp` is epoch nanoseconds.
 */
export interface NeuronRuntimeEvent {
  name: string;
  duration_ns: number;
  duration_ms: number;
  timestamp: Nanoseconds;
  process_id?: number | string | null;
  thread_id?: number | string | null;
}

/** A NeuronCore `nc_exec_running` event (from the Neuron merge tool). */
export interface NeuronCoreEvent extends NeuronRuntimeEvent {
  exec_id?: number | string | null;
}

/**
 * Per-line fields added post hoc by `merge_scalene_neuron_profiles.py`.
 * They appear on `lines` only, never on `functions`. Upstream sets
 * `hasNeuronData` when any line has `nrt_time_ms > 0 || nc_time_ms > 0 ||
 * nrt_percent > 0`.
 */
export interface NeuronLineFields {
  /** On every line once merged: CPU samples overlapping NeuronCore execution. */
  cpu_samples_nc_overlap_count?: number;
  /** On every line once merged: `cpu_samples_list.length`. */
  cpu_samples_total_count?: number;
  /**
   * On every line once merged: % of this line's CPU samples during which a
   * NeuronCore was executing. Upstream shows `100 - this` as "unused device %".
   */
  cpu_samples_nc_overlap_percent?: Percent;
  /** Kernel lines only: sum of nrt_execute durations, ms. */
  nrt_time_ms?: number;
  /** Kernel lines only: share of total NRT time (~100 across lines). */
  nrt_percent?: Percent;
  /** Kernel lines only: number of nrt_execute events. */
  nrt_execute_count?: number;
  /** Kernel lines only: the nrt_execute events. */
  nrt_events?: NeuronRuntimeEvent[];
  /** Kernel lines only: kernel name. */
  nrt_source_code?: string;
  /** Kernel lines only: sum of nc_exec_running durations, ms. */
  nc_time_ms?: number;
  /** Kernel lines only: share of total NC time. */
  nc_percent?: Percent;
  /** Kernel lines only: number of nc_exec_running events. */
  nc_execute_count?: number;
  /** Kernel lines only: the nc_exec_running events. */
  nc_events?: NeuronCoreEvent[];
  /** Kernel lines only: `nc_time_ms / nrt_time_ms`. */
  nc_nrt_ratio?: number;
  /** Kernel lines only: legacy alias of `nrt_time_ms`. */
  neuron_time_ms?: number;
}

/**
 * One source line of a profiled file (upstream `LineDetail`).
 *
 * Current emitters write one entry for EVERY source line, in order
 * (`lines[i].lineno === i + 1`). Old profiles are sparse, so always look
 * up by `lineno`. Unprofiled lines carry all-zero metrics.
 */
export interface LineData extends LineMetrics, LineRegionFields, NeuronLineFields {}

/**
 * Per-function aggregate (upstream `FunctionDetail`).
 * `line` is the qualified name and `lineno` is the first line. There are no
 * region fields, and `cpu_samples_list` is always []. Lambdas and
 * comprehensions roll up into the enclosing named function, and
 * module-level code is excluded. Sorted by `lineno`.
 */
export interface FunctionData extends LineMetrics {}

/**
 * A suspected memory leak at one line. Reported only when the leak detector
 * is on, the footprint went above 100 MiB, and `Profile.growth_rate >= 1`.
 */
export interface LeakInfo {
  /** Rule-of-succession leak likelihood. In [0.95, 1). */
  likelihood: number;
  /**
   * Heuristic leak rate in MiB/s: the line's average per-episode footprint
   * divided by `elapsed_time_sec`.
   */
  velocity_mb_s: number;
}

/** One profiled source file (upstream `FileDetail`). */
export interface FileData {
  /**
   * The file's share of ALL sampled time in the program, 0..100.
   * Summed over files it is <= 100. ~= the sum of its lines'
   * python + c + sys.
   */
  percent_cpu_time: Percent;
  /** Source lines, in line order (dense now, sparse in old profiles). */
  lines: LineData[];
  /** Function summaries, sorted by first line; often []. */
  functions: FunctionData[];
  /**
   * Import statements for native modules only, e.g. "import numpy as np"
   * (used as AI-prompt context).
   */
  imports: string[];
  /**
   * Suspected leaks keyed by `String(lineno)`. Keys arrive sorted as
   * strings, so re-sort by likelihood. Absent in very old profiles.
   * Default {}.
   */
  leaks?: Record<string, LeakInfo>;
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

/**
 * A Python frame in a stitched stack.
 * `display_name` is the qualified name for CPU stacks (`co_qualname`, e.g.
 * "A.run", "<module>"). Synthetic async frames look like
 * "[await] fetch (Task-3)". In `memory_stacks` it is the bare enclosing
 * `def` name or "<module>".
 */
export interface PyFrame {
  kind: "py";
  display_name: string;
  /** Source filename. Same spelling as `Profile.files` keys, but it may be absent from `files`. */
  filename_or_module: string;
  /** Current line in this frame (1-based). */
  line: LineNo;
  ip: null;
  offset: null;
  /**
   * Legacy only: source text of `line`. New profiles omit it, so look it up
   * in `files[filename_or_module].lines` by `lineno`.
   */
  code_line?: string;
}

/**
 * A native (C/C++) frame in a stitched stack, after IP resolution and
 * C++ demangling. When unresolved, `display_name` and `filename_or_module`
 * are "" and `offset` is 0, so display `0x${ip.toString(16)}`.
 */
export interface NativeFrame {
  kind: "native";
  /** Demangled symbol, e.g. "cblas_dgemm", "std::vector<int>::push_back"; "" if unresolved. */
  display_name: string;
  /** Shared-object path, e.g. "/usr/lib/libopenblas.so.0"; "" if unresolved. */
  filename_or_module: string;
  line: null;
  /** Instruction pointer (user-space address, < 2^47). */
  ip: number;
  /** `ip - symbol start`, >= 0. */
  offset: number;
}

/** Upstream `CombinedStackFrame`: discriminate on `kind`. */
export type CombinedFrame = PyFrame | NativeFrame;

/**
 * One entry of `Profile.combined_stacks`.
 *  - `frames`: ROOT-FIRST (outermost -> leaf). The Python segment comes
 *    first, then the native segment; a py frame never follows a native one.
 *  - `hits`: number of CPU samples with exactly this stack (integer). It can
 *    slightly over-estimate (Space-Saving cap of 10 000 stacks).
 * Entries are not sorted.
 */
export type CombinedStackEntry = [frames: CombinedFrame[], hits: number];

/** Frames of `Profile.memory_stacks` are always Python frames. */
export type MemoryStackFrame = PyFrame;

/**
 * One entry of `Profile.memory_stacks`.
 *  - `frames`: ROOT-FIRST Python frames; the leaf is the allocating line.
 *  - `mb`: MiB of sampled allocations attributed to this stack (> 0,
 *    cumulative volume, like `n_malloc_mb`).
 */
export type MemoryStackEntry = [frames: MemoryStackFrame[], mb: MiB];

/**
 * One run-length-encoded entry of `Profile.combined_stacks_timeline`:
 * starting at `t_sec`, the next `count` consecutive samples of thread
 * `thread_id` all hit `combined_stacks[stack_index]`. Events are in
 * chronological order. Threads interleave and may share a `t_sec`.
 * Duration is not emitted. Derive it from the same thread's next event,
 * else use `count * 0.01` s (the default sampling interval).
 */
export interface CombinedStackTimelineEvent {
  /** Seconds since the FIRST timeline run (not profile start), >= 0, 1 µs precision. */
  t_sec: Seconds;
  /** Index into `Profile.combined_stacks`. */
  stack_index: number;
  /** Number of consecutive samples in this run, >= 1. */
  count: number;
  /**
   * Python thread id of the sampled thread. Main-thread events carry
   * `Profile.main_thread_id`, not null. null or missing occurs only in
   * legacy profiles (unknown thread). Default null.
   */
  thread_id?: ThreadId | null;
}

/**
 * Legacy Python-only stack statistics (`Profile.stacks`). The time fields
 * are fractions (0..1) of total CPU samples.
 */
export interface LegacyStackStats {
  count: number;
  python_time: Fraction;
  c_time: Fraction;
  cpu_samples: Fraction;
}

/**
 * One entry of the legacy `Profile.stacks`: root-first frame strings
 * formatted `"<filename> <qualname>:<line>;"`, plus stats (very old builds
 * may have emitted a bare count). Upstream never renders it.
 */
export type LegacyStackEntry = [frames: string[], stats: LegacyStackStats | number];

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** Core fields of a non-empty profile (upstream `ScaleneJSONSchema`). */
export interface ProfileCore {
  // -- run identity ---------------------------------------------------------

  /**
   * Program as invoked (script path). Jupyter cells appear as "[12]".
   * Absent in very old profiles.
   */
  program?: string;
  /** Directory of the entry script ("" with `-m`). Absent in very old profiles. */
  entrypoint_dir?: string;
  /**
   * MISNAMED: the program *directory* used to decide which files to profile
   * (`--program-path` or the script's dir). Absent in very old profiles.
   */
  filename?: string;
  /** Program arguments as passed to Scalene; may be null. Absent in very old profiles. */
  args?: string[] | null;

  // -- time -----------------------------------------------------------------

  /**
   * Wall-clock seconds profiled (summed over start/stop periods; the max
   * across subprocesses). Upstream convention: seconds ~= pct/100 * this.
   */
  elapsed_time_sec: Seconds;
  /**
   * Unix epoch seconds at (the last) profiling start. Absent before ~2024
   * profiles.
   */
  start_time_absolute?: Seconds;
  /**
   * `time.perf_counter()` at profiling start; the origin for
   * `cpu_samples_list`. Absent before ~2024 profiles.
   */
  start_time_perf?: Seconds;

  // -- feature flags --------------------------------------------------------

  /** Memory profiling was on. When false, all memory metrics are 0 and `samples` is []. */
  memory: boolean;
  /** An accelerator was detected and enabled. Gate GPU UI on this. */
  gpu: boolean;
  /**
   * Accelerator label ("GPU" | "Neuron" | ""). Absent in very old profiles,
   * so display "GPU" then.
   */
  gpu_device?: GpuDevice;
  /** `--async` was on, so show the await columns. Default false. */
  async_profile?: boolean;

  // -- memory summary -------------------------------------------------------

  /** Peak global footprint (MiB). Upper bound for all footprint values. */
  max_footprint_mb: MiB;
  /**
   * Python share of the allocation that set the peak. 0..1. Absent in very
   * old profiles.
   */
  max_footprint_python_fraction?: Fraction;
  /** File of the allocation that set the peak (null if none). Absent in very old profiles. */
  max_footprint_fname?: string | null;
  /** Line of that allocation (null if unknown). Absent in very old profiles. */
  max_footprint_lineno?: LineNo | null;
  /**
   * MiB allocated by native threads with no Python frame; not attributed to
   * any line. Default 0.
   */
  native_allocations_mb?: MiB;
  /**
   * % of allocated memory that stayed live:
   * 100 * net footprint growth / MiB allocated. Usually 0..100, so clamp it.
   * Leak reports require >= 1.
   */
  growth_rate: number;
  /**
   * Number of malloc/free sample records processed (an event count).
   * Absent in very old profiles.
   */
  alloc_samples?: number;
  /**
   * Global footprint timeline; see `MemorySample`. [] when memory is off.
   * Usually <= 100 points; old profiles may have thousands.
   */
  samples: MemorySample[];

  // -- per-file data --------------------------------------------------------

  /**
   * Profiled files keyed by filename as Python saw it (absolute, relative
   * like "./test/x.py", "[12]" for Jupyter cells). Keys arrive in
   * ALPHABETICAL order. Sort by `percent_cpu_time` / memory in the UI.
   */
  files: Record<string, FileData>;

  // -- stacks ---------------------------------------------------------------

  /** Legacy Python-only stacks; unused by upstream. Absent in very old profiles. */
  stacks?: LegacyStackEntry[];
  /**
   * Stitched Python+native CPU stacks (root-first). [] without the native
   * unwinder or with --no-stacks. Absent before ~2025 profiles.
   */
  combined_stacks?: CombinedStackEntry[];
  /**
   * RLE per-sample timeline of `combined_stacks`. Absent before ~2025 profiles.
   */
  combined_stacks_timeline?: CombinedStackTimelineEvent[];
  /**
   * Allocation-weighted Python stacks for a memory flame graph. Present only
   * with --memory and stacks enabled. Absent before ~2025 profiles.
   */
  memory_stacks?: MemoryStackEntry[];
  /**
   * `threading.main_thread().ident`; matches main-thread timeline events.
   * Absent before ~2025 profiles. Default null.
   */
  main_thread_id?: ThreadId | null;
}

/** Top-level fields added by `merge_scalene_neuron_profiles.py` (all optional). */
export interface NeuronProfileFields {
  /** Sum of all nrt_execute durations, ms. */
  neuron_total_time_ms?: number;
  /** Sum of all nc_exec_running durations, ms. */
  neuron_total_nc_time_ms?: number;
  /** Number of nrt_execute events. */
  neuron_event_count?: number;
  /** Number of nc_exec_running events. */
  neuron_nc_event_count?: number;
  /** CPU samples (across lines) overlapping NeuronCore execution. */
  cpu_samples_total_with_nc_overlap?: number;
  /** CPU samples (across lines) considered for the overlap. */
  cpu_samples_total?: number;
  /** Overall overlap %. */
  cpu_samples_nc_overlap_percent_overall?: Percent;
}

/** A non-empty Scalene profile, as embedded by the template or loaded from a .json file. */
export interface Profile extends ProfileCore, NeuronProfileFields {}

/** Written when nothing was sampled: `{}`. Show the "load a profile" state. */
export type EmptyProfile = Record<string, never>;

/**
 * What `load()` may receive. The template inlines the file text as a JS
 * literal, so a missing file yields "" (demo mode), and a hand-picked file
 * may be anything. Validate before narrowing to `Profile`.
 */
export type ProfileInput = Profile | EmptyProfile;

// ---------------------------------------------------------------------------
// Normalized shapes: what a loader produces after filling defaults
// (numbers -> 0, arrays -> [], booleans -> false, region bounds -> lineno,
// function bounds -> 0, gpu_device -> "", thread ids -> null,
// leaks -> {}, n_peak_mb <- n_growth_mb). Neuron fields stay optional.
// ---------------------------------------------------------------------------

/** `LineMetrics` with every optional field filled. */
export type NormalizedLineMetrics = Required<LineMetrics>;

/** A line with all non-Neuron fields present. */
export type NormalizedLineData = NormalizedLineMetrics &
  Required<LineRegionFields> &
  NeuronLineFields;

/** A function summary with all fields present. */
export type NormalizedFunctionData = NormalizedLineMetrics;

/** A file whose lines and functions are normalized and whose leaks exist. */
export interface NormalizedFileData {
  percent_cpu_time: Percent;
  lines: NormalizedLineData[];
  functions: NormalizedFunctionData[];
  imports: string[];
  leaks: Record<string, LeakInfo>;
}

/** A timeline event with `thread_id` present (null = unknown). */
export type NormalizedTimelineEvent = Required<CombinedStackTimelineEvent>;

/** A profile with every non-Neuron field present. */
export type NormalizedProfile = Omit<
  Required<ProfileCore>,
  "files" | "combined_stacks_timeline"
> & {
  files: Record<string, NormalizedFileData>;
  combined_stacks_timeline: NormalizedTimelineEvent[];
} & NeuronProfileFields;
