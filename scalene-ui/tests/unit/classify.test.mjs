// §4.0.6 classification: verbatim upstream rules and the shared lane totals
// (ml-training GC 0.6 %, I/O & waits 2.8 %, GIL 0.9 %; huge 2.1 / 4.0 / 1.6;
// async-server I/O & waits 95.7 %).
import assert from "node:assert/strict";
import { mod, r1, test, withModel } from "./_harness.mjs";

const c = mod("model/classify");
const nat = (display_name, filename_or_module = "/lib/x.so") => ({ kind: "native", display_name, filename_or_module, line: null, ip: 1, offset: 0 });
const py = (display_name, filename_or_module = "/app/x.py", line = 1) => ({ kind: "py", display_name, filename_or_module, line, ip: null, offset: null });

test("classifyFrame: GC, GIL, I/O names and Python I/O files", () => {
  const cases = [
    [nat("gc_collect_main"), "gc"],
    [nat("_PyGC_Collect"), "gc"],
    [nat("PyGC_Collect"), "gc"],
    [nat("GC_Collect"), "gc"], // first pattern is case-insensitive
    [nat("subtract_refs"), "gc"],
    [nat("move_legacy_finalizers"), "gc"],
    [nat("take_gil"), "gil"],
    [nat("_PyEval_LockGIL"), "gil"],
    [nat("PyGILState_Ensure"), "gil"],
    [nat("pthread_cond_wait"), "io"],
    [nat("pthread_cond_timedwait"), "io"],
    [nat("__psynch_cvwait"), "io"],
    [nat("epoll_wait"), "io"],
    [nat("__read"), "io"],
    [nat("_write"), "io"],
    [nat("pread64"), "io"],
    [nat("_io_FileIO_readinto"), "io"],
    [nat("_io_BufferedReader_read_generic"), "io"],
    [py("[await] fetch (Task-3)"), "io"],
    [py("run_once", "/usr/lib/python3.12/asyncio/base_events.py"), "io"],
    [py("recv_into", "/usr/lib/python3.12/socket.py"), "io"],
    [py("select", "/usr/lib/python3.12/selectors.py"), "io"],
    [py("communicate", "/usr/lib/python3.12/subprocess.py"), "io"],
    // No @@GLIBC stripping (upstream parity) and no loose matches.
    [nat("pthread_cond_wait@@GLIBC_2.3.2"), "other"],
    [nat("os_read"), "other"],
    [nat("readme"), "other"],
    [nat("cudaStreamSynchronize"), "other"],
    [nat(""), "other"],
    [py("train", "/home/dev/llm-train/train.py"), "other"],
    [nat("recv", "/usr/lib/libc.so"), "io"],
    [py("recv", "/app/x.py"), "io"], // names apply to py frames too
  ];
  for (const [f, want] of cases) assert.equal(c.classifyFrame(f), want, f.display_name || f.filename_or_module);
});

test("classifyStack: any frame decides; GIL overrides I/O", () => {
  assert.deepEqual(c.classifyStack([py("main"), nat("take_gil"), nat("pthread_cond_wait")]), { gc: false, io: false, gil: true });
  assert.deepEqual(c.classifyStack([py("main"), nat("gc_collect_main"), nat("read")]), { gc: true, io: true, gil: false });
  assert.deepEqual(c.classifyStack([py("main")]), { gc: false, io: false, gil: false });
  const bits = c.classifyStacks([
    [[py("a"), nat("take_gil")], 3],
    [[py("a"), nat("epoll_wait")], 1],
    [[py("a"), nat("gc_collect_main")], 1],
    [[py("a")], 1],
  ]);
  assert.deepEqual(Array.from(bits), [c.CLS_GIL, c.CLS_IO, c.CLS_GC, 0]);
  assert.equal(c.isAwaitFrame(py("[await] x (Task-1)")), true);
  assert.equal(c.isAwaitFrame(nat("[await] x")), false);
});

const LANES = {
  "ml-training": [0.6, 2.8, 0.9],
  huge: [2.1, 4.0, 1.6],
  "async-server": [0.1, 95.7, 0.0],
  "cpu-only": [0, 0, 0],
};

for (const [name, [gc, io, gil]] of Object.entries(LANES)) {
  withModel(name, "lane totals (% of samples), one set for every view", async (m) => {
    const lanes = m.sampling.laneTotals;
    assert.deepEqual([r1(lanes.gc), r1(lanes.io), r1(lanes.gil)], [gc, io, gil]);
    const tl = await m.timeline();
    assert.equal(tl.laneTotals, lanes, "the timeline shares the same object");
  });
}

withModel("neuron", "no stacks → no lane totals", (m) => {
  assert.equal(m.sampling.laneTotals, null);
});
