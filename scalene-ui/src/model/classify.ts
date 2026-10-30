/**
 * Stack classification: GC / I/O & waits / GIL (DESIGN.md §4.0.6).
 *
 * Ported verbatim from upstream `classifyFrame` / `classifyStack`
 * (scalene-gui.ts), including its quirks: no stripping of `@@GLIBC` version
 * suffixes, `[await]` synthetic frames and blocking waits count as I/O, and
 * GIL overrides I/O. Every view reads these results through the model; no
 * view re-implements them.
 */

import type { CombinedFrame } from "../types";

export type FrameClass = "gc" | "io" | "gil" | "other";

// Native symbols are typically `prefix_root_suffix` (`_io_FileIO_read`,
// `os_read`), so `_` is treated as a token separator on both sides.
const GC_NAME_PATTERNS: readonly RegExp[] = [
  /(?:\b|_)gc[._]collect(?:_|\b)/i,
  /(?:\b|_)PyGC(?:_|\b)/,
  /(?:\b|_)_PyGC_/,
  /(?:\b|_)gc_collect_main(?:_|\b)/,
  /(?:\b|_)gc_collect_region(?:_|\b)/,
  /(?:\b|_)deallocate(?:_|\b)/,
  /(?:\b|_)collect_with_callback(?:_|\b)/,
  /(?:\b|_)subtract_refs(?:_|\b)/,
  /(?:\b|_)move_unreachable(?:_|\b)/,
  /(?:\b|_)untrack_tuples(?:_|\b)/,
  /(?:\b|_)untrack_dicts(?:_|\b)/,
  /(?:\b|_)deduce_unreachable(?:_|\b)/,
  /(?:\b|_)delete_garbage(?:_|\b)/,
  /(?:\b|_)handle_weakrefs(?:_|\b)/,
  /(?:\b|_)invoke_gc_callback(?:_|\b)/,
  /(?:\b|_)move_legacy_finalizers?(?:_|\b)/,
];

const IO_NAME_PATTERNS: readonly RegExp[] = [
  /^\[await\]/,
  /^read$/,
  /^write$/,
  /^pread(?:64)?$/,
  /^pwrite(?:64)?$/,
  /^readv$/,
  /^writev$/,
  /^recv$/,
  /^recvfrom$/,
  /^recvmsg$/,
  /^send$/,
  /^sendto$/,
  /^sendmsg$/,
  /^select$/,
  /^pselect$/,
  /^poll$/,
  /^ppoll$/,
  /^epoll_wait$/,
  /^epoll_pwait$/,
  /^kevent$/,
  /^accept$/,
  /^accept4$/,
  /^connect$/,
  /^open$/,
  /^openat$/,
  /^close$/,
  /^fsync$/,
  /^fdatasync$/,
  /^fread$/,
  /^fwrite$/,
  /^lseek$/,
  /^__(?:read|write|pread|pwrite|recv|send|select|poll|open|close)$/,
  /^_(?:read|write|pread|pwrite|recv|send|select|poll|open|close)$/,
  /^pthread_cond_wait$/,
  /^pthread_cond_timedwait$/,
  /^__psynch_cvwait$/,
  /^_io_FileIO_read(?:all|into)?$/,
  /^_io_FileIO_write$/,
  /^_io_BufferedReader_read/,
  /^_io_BufferedWriter_write/,
];

const GIL_NAME_PATTERNS: readonly RegExp[] = [/^take_gil$/, /^_PyEval_LockGIL$/, /^PyGILState_Ensure$/];

const IO_FILE_PATTERNS: readonly RegExp[] = [
  /\b_io\b/,
  /\bsocket\.py$/,
  /\bselectors\.py$/,
  /\bselector_events\.py$/,
  /\basyncio\b/,
  /\bsubprocess\.py$/,
];

/** Human-readable list for the "I/O & waits" tooltip. */
export const IO_CATEGORIES = [
  "awaiting coroutines ([await])",
  "file and socket I/O (read, write, recv, send, open, close, fsync …)",
  "polling (select, poll, epoll_wait, kevent)",
  "blocking waits (pthread_cond_wait, pthread_cond_timedwait)",
  "Python I/O modules (_io, socket, selectors, asyncio, subprocess)",
] as const;

/** Upstream `classifyFrame`, verbatim. */
export function classifyFrame(f: CombinedFrame): FrameClass {
  const name = f.display_name ?? "";
  for (const re of GC_NAME_PATTERNS) if (re.test(name)) return "gc";
  for (const re of GIL_NAME_PATTERNS) if (re.test(name)) return "gil";
  for (const re of IO_NAME_PATTERNS) if (re.test(name)) return "io";
  if (f.kind === "py") {
    for (const re of IO_FILE_PATTERNS) if (re.test(f.filename_or_module ?? "")) return "io";
  }
  return "other";
}

export interface StackClass {
  gc: boolean;
  io: boolean;
  gil: boolean;
}

/** Upstream `classifyStack`: any frame decides; GIL overrides I/O. */
export function classifyStack(stack: readonly CombinedFrame[]): StackClass {
  return fromBits(stackBits(stack, classifyFrame));
}

// ── Bit-packed, cached classification for whole profiles ───────────────────

export const CLS_GC = 1;
export const CLS_IO = 2;
export const CLS_GIL = 4;

function fromBits(b: number): StackClass {
  return { gc: (b & CLS_GC) !== 0, io: (b & CLS_IO) !== 0, gil: (b & CLS_GIL) !== 0 };
}

function stackBits(stack: readonly CombinedFrame[], cls: (f: CombinedFrame) => FrameClass): number {
  let bits = 0;
  for (const f of stack) {
    const c = cls(f);
    if (c === "gc") bits |= CLS_GC;
    else if (c === "gil") bits |= CLS_GIL;
    else if (c === "io") bits |= CLS_IO;
    if (bits === (CLS_GC | CLS_IO | CLS_GIL)) break;
  }
  return bits & CLS_GIL ? bits & ~CLS_IO : bits;
}

/**
 * Classify every stack once, as a bit mask per stack index
 * (`CLS_GC | CLS_IO | CLS_GIL`). Frame results are memoised by
 * (kind, name, file), which keeps huge profiles (3k stacks) to a few ms.
 */
export function classifyStacks(stacks: readonly (readonly [readonly CombinedFrame[], number])[]): Uint8Array {
  const memo = new Map<string, FrameClass>();
  const cached = (f: CombinedFrame): FrameClass => {
    const key = f.kind === "py" ? `p\u0000${f.display_name}\u0000${f.filename_or_module}` : `n\u0000${f.display_name}`;
    let c = memo.get(key);
    if (c === undefined) {
      c = classifyFrame(f);
      memo.set(key, c);
    }
    return c;
  };
  const out = new Uint8Array(stacks.length);
  for (let i = 0; i < stacks.length; i++) out[i] = stackBits(stacks[i][0], cached);
  return out;
}

/** Synthetic async frame: `[await] fetch (Task-3)`. */
export function isAwaitFrame(f: CombinedFrame): boolean {
  return f.kind === "py" && f.display_name.startsWith("[await]");
}
