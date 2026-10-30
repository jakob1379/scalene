"""Scenario definitions for tools/gen_fixtures.py.

Each ``build_*`` function lays out one fictional program run on a Prog (see
fixturelib.py) and returns the profile dict. Durations are wall seconds; the
helpers ``ms()`` / ``jit()`` keep the schedules readable.
"""
from __future__ import annotations

import math
import random
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from fixturelib import Act, Key, NativeTail, Prog, Suspension, clamp, epoch, nat, prefixes, read_src

# ---------------------------------------------------------------------------
# Native libraries and common native call tails (outermost -> leaf)
# ---------------------------------------------------------------------------

VENV = "/home/dev/llm-train/.venv/lib/python3.12/site-packages"


class M:
    py = "/usr/bin/python3.12"
    libc = "/usr/lib/x86_64-linux-gnu/libc.so.6"
    stdcxx = "/usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.33"
    ld = "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"
    cuda = "/usr/lib/x86_64-linux-gnu/libcuda.so.1"
    crypto = "/usr/lib/x86_64-linux-gnu/libcrypto.so.3"
    json = "/usr/lib/python3.12/lib-dynload/_json.cpython-312-x86_64-linux-gnu.so"
    math = "/usr/lib/python3.12/lib-dynload/math.cpython-312-x86_64-linux-gnu.so"
    pickle = "/usr/lib/python3.12/lib-dynload/_pickle.cpython-312-x86_64-linux-gnu.so"
    hashlib = "/usr/lib/python3.12/lib-dynload/_hashlib.cpython-312-x86_64-linux-gnu.so"
    asyncio = "/usr/lib/python3.12/lib-dynload/_asyncio.cpython-312-x86_64-linux-gnu.so"
    select = "/usr/lib/python3.12/lib-dynload/select.cpython-312-x86_64-linux-gnu.so"
    tpy = VENV + "/torch/lib/libtorch_python.so"
    tcpu = VENV + "/torch/lib/libtorch_cpu.so"
    tcuda = VENV + "/torch/lib/libtorch_cuda.so"
    c10 = VENV + "/torch/lib/libc10.so"
    c10cuda = VENV + "/torch/lib/libc10_cuda.so"
    gomp = VENV + "/torch/lib/libgomp-a34b3233.so.1"
    cudart = VENV + "/nvidia/cuda_runtime/lib/libcudart.so.12"
    cublas = VENV + "/nvidia/cublas/lib/libcublas.so.12"
    cublaslt = VENV + "/nvidia/cublas/lib/libcublasLt.so.12"
    np = VENV + "/numpy/_core/_multiarray_umath.cpython-312-x86_64-linux-gnu.so"
    npgen = VENV + "/numpy/random/_generator.cpython-312-x86_64-linux-gnu.so"
    nppcg = VENV + "/numpy/random/_pcg64.cpython-312-x86_64-linux-gnu.so"
    nplapack = VENV + "/numpy.libs/libscipy_openblas64_-6bb31eeb.so"


def gil_wait(py: str = M.py, libc: str = M.libc) -> NativeTail:
    return nat(("PyEval_RestoreThread", py), ("take_gil", py),
               ("pthread_cond_timedwait@@GLIBC_2.3.2", libc), ("__futex_abstimed_wait_common", libc))


def gc_pass(py: str = M.py) -> NativeTail:
    return nat(("_Py_HandlePending", py), ("_Py_RunGC", py), ("gc_collect_main", py),
               ("deduce_unreachable", py), ("subtract_refs", py), ("dict_traverse", py))


LAUNCH = nat(("cudaLaunchKernel", M.cudart), ("", M.cuda), ("", M.cuda))


def torch_op(op: str, *rest: Tuple[str, str], method: bool = True) -> NativeTail:
    root = ("method_vectorcall_VARARGS_KEYWORDS", M.py) if method else ("cfunction_call", M.py)
    binding = (f"torch::autograd::THPVariable_{op}(_object*, _object*, _object*)", M.tpy)
    return (root, binding) + tuple(rest)


def gemm_tail(binding: str, kind: str = "mm") -> NativeTail:
    if kind == "bmm":
        mid = (
            ("at::_ops::matmul::call(at::Tensor const&, at::Tensor const&)", M.tcpu),
            ("at::autocast::WrapFunction_<at::autocast::CastPolicy::lower_precision_fp, c10::DeviceType::CUDA, at::Tensor (at::Tensor const&, at::Tensor const&), &at::matmul, at::Tensor, c10::guts::typelist::typelist<at::Tensor const&, at::Tensor const&> >::call(at::Tensor const&, at::Tensor const&)", M.tcpu),
            ("at::native::matmul(at::Tensor const&, at::Tensor const&)", M.tcpu),
            ("at::_ops::bmm::call(at::Tensor const&, at::Tensor const&)", M.tcpu),
            ("at::native::structured_bmm_out_cuda::impl(at::Tensor const&, at::Tensor const&, at::Tensor const&)", M.tcuda),
            ("void at::cuda::blas::bgemm<c10::BFloat16>(char, char, long, long, long, at::OpMathType<c10::BFloat16>::type, c10::BFloat16 const*, long, long, c10::BFloat16 const*, long, long, at::OpMathType<c10::BFloat16>::type, c10::BFloat16*, long, long, long)", M.tcuda),
            ("cublasGemmStridedBatchedEx", M.cublas),
        )
    else:
        mid = (
            ("at::_ops::linear::call(at::Tensor const&, at::Tensor const&, std::optional<at::Tensor> const&)", M.tcpu),
            ("at::autocast::WrapFunction_<at::autocast::CastPolicy::lower_precision_fp, c10::DeviceType::CUDA, at::Tensor (at::Tensor const&, at::Tensor const&, std::optional<at::Tensor> const&), &at::linear, at::Tensor, c10::guts::typelist::typelist<at::Tensor const&, at::Tensor const&, std::optional<at::Tensor> const&> >::call(at::Tensor const&, at::Tensor const&, std::optional<at::Tensor> const&)", M.tcpu),
            ("at::native::linear(at::Tensor const&, at::Tensor const&, std::optional<at::Tensor> const&)", M.tcpu),
            ("at::_ops::mm::call(at::Tensor const&, at::Tensor const&)", M.tcpu),
            ("at::native::structured_mm_out_cuda::impl(at::Tensor const&, at::Tensor const&, at::Tensor const&)", M.tcuda),
            ("void at::cuda::blas::gemm<c10::BFloat16>(char, char, long, long, long, at::OpMathType<c10::BFloat16>::type, c10::BFloat16 const*, long, c10::BFloat16 const*, long, at::OpMathType<c10::BFloat16>::type, c10::BFloat16*, long)", M.tcuda),
            ("cublasGemmEx", M.cublas),
        )
    return (("cfunction_call", M.py), (binding, M.tpy)) + mid + (("cublasLtMatmul", M.cublaslt),) + LAUNCH


CAST_BF16 = (
    ("at::_ops::_to_copy::call(at::Tensor const&, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>, bool, std::optional<c10::MemoryFormat>)", M.tcpu),
    ("at::native::_to_copy(at::Tensor const&, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>, bool, std::optional<c10::MemoryFormat>)", M.tcpu),
    ("at::native::copy_(at::Tensor&, at::Tensor const&, bool)", M.tcpu),
    ("at::native::copy_kernel_cuda(at::TensorIterator&, bool)", M.tcuda),
) + LAUNCH


def linear_variants(binding: str = "torch::autograd::THPVariable_linear(_object*, _object*, _object*)") -> List[Tuple[float, NativeTail]]:
    full = gemm_tail(binding)
    cast = full[:5] + CAST_BF16
    return prefixes(full, [(0, 0.34), (-2, 0.18), (-4, 0.1), (5, 0.08), (3, 0.05)]) + [(0.2, cast), (0.05, ())]


def elementwise(op: str, kernel: str, dispatch: str, method: bool = False) -> NativeTail:
    return torch_op(op, (dispatch, M.tcpu), (kernel, M.tcuda), method=method) + LAUNCH


def item_sync() -> NativeTail:
    return (("method_vectorcall_NOARGS", M.py),
            ("torch::autograd::THPVariable_item(_object*, _object*)", M.tpy),
            ("at::_ops::_local_scalar_dense::call(at::Tensor const&)", M.tcpu),
            ("at::native::_local_scalar_dense_cuda(at::Tensor const&)", M.tcuda),
            ("at::cuda::memcpy_and_sync(void*, void const*, long, cudaMemcpyKind, CUstream_st*)", M.tcuda),
            ("cudaStreamSynchronize", M.cudart), ("", M.cuda), ("", M.cuda), ("ioctl", M.libc))


def sync_variants() -> List[Tuple[float, NativeTail]]:
    t = item_sync()
    return [(0.46, t), (0.3, t[:-1]), (0.14, t[:-2]), (0.06, t[:6]), (0.04, ())]


def h2d(nonblocking: bool = True) -> NativeTail:
    return torch_op(
        "to",
        ("at::_ops::to_dtype_layout::call(at::Tensor const&, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>, bool, bool, std::optional<c10::MemoryFormat>)", M.tcpu),
        ("at::native::to(at::Tensor const&, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>, bool, bool, std::optional<c10::MemoryFormat>)", M.tcpu),
        ("at::native::_to_copy(at::Tensor const&, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>, bool, std::optional<c10::MemoryFormat>)", M.tcpu),
        ("at::native::copy_(at::Tensor&, at::Tensor const&, bool)", M.tcpu),
        ("at::native::copy_kernel_cuda(at::TensorIterator&, bool)", M.tcuda),
        ("cudaMemcpyAsync", M.cudart), ("", M.cuda),
    )


def foreach(op: str, kernel: str) -> NativeTail:
    return (("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py),
            (f"torch::autograd::THPVariable__foreach_{op}(_object*, _object*, _object*)", M.tpy),
            (f"at::_ops::_foreach_{op}::call(c10::ArrayRef<at::Tensor>, c10::Scalar const&)", M.tcpu),
            (kernel, M.tcuda),
            ("void at::native::(anonymous namespace)::multi_tensor_apply<2, at::native::(anonymous namespace)::BinaryOpScalarFunctor<float, 2, 1, 1>, std::multiplies<float>, float>(std::vector<std::vector<at::Tensor, std::allocator<at::Tensor> >, std::allocator<std::vector<at::Tensor, std::allocator<at::Tensor> > > >&, at::native::(anonymous namespace)::BinaryOpScalarFunctor<float, 2, 1, 1>, std::multiplies<float>, float)", M.tcuda),
            ) + LAUNCH


def ms(x: float) -> float:
    return x / 1000.0


def jit(rng: random.Random, x: float, spread: float = 0.15) -> float:
    return max(1e-6, x * (1.0 + rng.uniform(-spread, spread)))


# ---------------------------------------------------------------------------
# ml-training.json
# ---------------------------------------------------------------------------


def build_ml() -> Dict[str, Any]:
    root = "/home/dev/llm-train"
    T = f"{root}/train.py"
    LD = f"{root}/data/loader.py"
    TK = f"{root}/data/tokenizer.py"
    MD = f"{root}/model/transformer.py"
    MT = f"{root}/utils/metrics.py"
    AW = f"{VENV}/torch/optim/adamw.py"
    OPT = f"{VENV}/torch/optim/optimizer.py"  # traced (--profile-only torch/optim) but < 1%: not in `files`
    MAIN = 139872518063936
    WORKERS = [139871093122752, 139871084730048, 139871076337344]
    VALW = 139871067944640
    p = Prog(
        "ml-training",
        program=T,
        entrypoint_dir=root,
        program_path=root,
        args=[T, "--config", "configs/gpt-small.json", "--max-steps", "200"],
        start_time_absolute=epoch(2026, 10, 27, 14, 22, 17.318442),
        start_time_perf=418273.551204,
        main_tid=MAIN,
        memory=True,
        gpu=True,
        gpu_device="GPU",
        n_cpus=32,
    )
    rng = random.Random("ml-schedule")
    for path, rel in [(T, "ml/train.py"), (LD, "ml/data/loader.py"), (TK, "ml/data/tokenizer.py"),
                      (MD, "ml/model/transformer.py"), (MT, "ml/utils/metrics.py"),
                      (AW, "ml/site-packages/torch/optim/adamw.py")]:
        p.add_source(path, read_src(rel))
    p.add_source(OPT, read_src("ml/site-packages/torch/optim/optimizer.py"), reported=False)
    for tid in WORKERS + [VALW]:
        p.thread(tid)
    L = p.L

    # ---- call graph ---------------------------------------------------------
    entry = L(T, "train(parse_args())")
    p.call(T, "parse_args", entry)
    p.call(T, "train", entry)
    p.call(T, "get_lr", L(T, "lr = get_lr(step, cfg)"))
    p.call(T, "configure_optimizer", L(T, "optimizer = configure_optimizer(model, cfg)"))
    p.call(T, "evaluate", L(T, "val_loss = evaluate(model, val_loader, device, cfg)"))
    p.call(T, "save_checkpoint", L(T, "save_checkpoint(model, optimizer, cfg.max_steps, cfg)"))
    p.call(TK, "BPETokenizer.from_directory", L(T, "tokenizer = BPETokenizer.from_directory"))
    p.call(TK, "BPETokenizer.__init__", L(TK, "return cls(encoder, merges)"))
    p.call(TK, "bytes_to_unicode", L(TK, "self.byte_encoder = bytes_to_unicode()"))
    p.call(TK, "BPETokenizer.vocab_size", L(T, "vocab_size=tokenizer.vocab_size,"))
    train_set_call = L(T, "train_set = PackedTokenDataset(")
    val_set_call = L(T, "val_set = PackedTokenDataset(")
    p.call(LD, "PackedTokenDataset.__init__", train_set_call)
    p.call(LD, "PackedTokenDataset.__init__", val_set_call)
    train_loader_call = L(T, "train_loader = ThreadedPrefetcher(")
    val_loader_call = L(T, "val_loader = ThreadedPrefetcher(")
    p.call(LD, "ThreadedPrefetcher.__init__", train_loader_call)
    p.call(LD, "ThreadedPrefetcher.__init__", val_loader_call)
    next_train = L(T, "batch = next(train_loader)")
    next_eval = L(T, "batch = next(loader)")
    p.call(LD, "ThreadedPrefetcher.__next__", next_train, 25)
    p.call(LD, "ThreadedPrefetcher.__next__", next_eval, 1)
    p.call(LD, "ThreadedPrefetcher._next_indices", L(LD, "indices = self._next_indices()"))
    p.call(LD, "PackedTokenDataset.__getitem__", L(LD, "samples = [self.dataset[int(i)] for i in indices]"))
    p.call(LD, "PackedTokenDataset.__len__", L(LD, "return self._rng.integers(0, len(self.dataset)"))
    p.call(LD, "collate", L(LD, "batch = collate(samples)"))
    p.call(LD, "random_token_dropout", L(LD, "batch = random_token_dropout(batch"))
    p.call(LD, "ThreadedPrefetcher.close", L(T, "train_loader.close()"))
    p.call(LD, "ThreadedPrefetcher.close", L(T, "val_loader.close()"))
    p.call(MD, "GPT.__init__", L(T, "model = GPT(model_cfg)"))
    p.call(MD, "Block.__init__", L(MD, "h=nn.ModuleList([Block(cfg)"))
    p.call(MD, "CausalSelfAttention.__init__", L(MD, "self.attn = CausalSelfAttention(cfg)"))
    p.call(MD, "MLP.__init__", L(MD, "self.mlp = MLP(cfg)"))
    for needle in ("self.ln_1 = LayerNorm", "self.ln_2 = LayerNorm", "ln_f=LayerNorm"):
        p.call(MD, "LayerNorm.__init__", L(MD, needle))
    p.call(MD, "GPT._init_weights", L(MD, "self.apply(self._init_weights)"))
    p.call(MD, "GPT.num_parameters", L(T, "model.num_parameters()"))
    model_train = L(T, "logits = model(x)", func="train")
    model_eval = L(T, "logits = model(x)", func="evaluate")
    p.call(MD, "GPT.forward", model_train, 25)
    p.call(MD, "GPT.forward", model_eval, 1)
    p.call(MD, "Block.forward", L(MD, "x = block(x)"))
    attn_call = L(MD, "x = x + self.attn(self.ln_1(x))")
    mlp_call = L(MD, "x = x + self.mlp(self.ln_2(x))")
    lnf_call = L(MD, "x = self.transformer.ln_f(x)")
    p.call(MD, "CausalSelfAttention.forward", attn_call)
    p.call(MD, "MLP.forward", mlp_call)
    for c in (attn_call, mlp_call, lnf_call):
        p.call(MD, "LayerNorm.forward", c)
    p.call(MT, "MetricTracker.__init__", L(T, "tracker = MetricTracker(log_every=10)"))
    p.call(MT, "MetricTracker.update", L(T, "tracker.update(step, loss_value"))
    p.call(MT, "MetricTracker.log_eval", L(T, "tracker.log_eval(step, val_loss)"))
    p.call(MT, "perplexity", L(T, "ppl {perplexity(val_loss):.2f}"))
    p.call(MT, "perplexity", L(MT, '"val_ppl": perplexity(val_loss)'))
    p.call(MT, "MetricTracker.write_summary", L(T, "tracker.write_summary("))
    p.call(MT, "MetricTracker.summary", L(MT, '"summary": self.summary(),'))
    p.call(AW, "AdamW.__init__", L(T, "return torch.optim.AdamW(groups"))
    # optimizer.step is wrapped twice in torch/optim/optimizer.py (profile hook + grad mode)
    p.call(OPT, "Optimizer.profile_hook_step.<locals>.wrapper", L(T, "scaler.step(optimizer)"))
    p.call(OPT, "_use_grad_for_differentiable.<locals>._use_grad", L(OPT, "out = func(*args, **kwargs)"))
    p.call(AW, "AdamW.step", L(OPT, "ret = func(self, *args, **kwargs)"))
    p.call(OPT, "Optimizer.__init__", L(AW, "super().__init__(params, defaults)"))
    p.call(AW, "AdamW._init_group", L(AW, "self._init_group(group, params_with_grad"))
    p.call(AW, "adamw", L(AW, "adamw(", func="AdamW.step"))
    p.call(AW, "_multi_tensor_adamw", L(AW, "func(params, grads, exp_avgs"))

    TRAIN_PINS = {(MD, "GPT.forward"): model_train, (LD, "ThreadedPrefetcher.__next__"): next_train}
    EVAL_PINS = {(MD, "GPT.forward"): model_eval, (LD, "ThreadedPrefetcher.__next__"): next_eval}

    def A(key: Key, **kw: Any) -> Act:
        return Act(key, **kw)

    py_only = [(1.0, ())]

    # ---- startup acts --------------------------------------------------------
    import_np = A(L(T, "import numpy as np"), pyf=0.62, util=0.9, native=[
        (0.5, nat(("_imp_create_dynamic", M.py), ("_PyImport_LoadDynamicModuleWithSpec", M.py), ("dlopen@@GLIBC_2.34", M.libc),
                  ("_dl_open", M.ld), ("_dl_map_object_deps", M.ld), ("_dl_map_object", M.ld))),
        (0.5, ())])
    dl_torch = nat(("_imp_create_dynamic", M.py), ("_PyImport_LoadDynamicModuleWithSpec", M.py), ("dlopen@@GLIBC_2.34", M.libc),
                   ("_dl_open", M.ld), ("_dl_relocate_object", M.ld), ("_dl_lookup_symbol_x", M.ld), ("do_lookup_x", M.ld))
    init_torch = nat(("_imp_create_dynamic", M.py), ("PyInit__C", M.tpy), ("initModule()", M.tpy),
                     ("torch::autograd::initTorchFunctions(_object*)", M.tpy),
                     ("pybind11::cpp_function::initialize_generic(std::unique_ptr<pybind11::detail::function_record, pybind11::cpp_function::InitializingFunctionRecordDeleter>&&, char const*, std::type_info const* const*, unsigned long)", M.tpy))
    import_torch = A(L(T, "import torch\n"), pyf=0.46, util=0.86, core=0.034, native=[
        (0.22, dl_torch), (0.1, dl_torch[:5]), (0.14, init_torch), (0.06, gc_pass()),
        # C calling back into Python mid-stack: survives _trim_native_stack (which only trims the root end)
        (0.08, nat(("_imp_create_dynamic", M.py), ("PyInit__C", M.tpy), ("initModule()", M.tpy), ("PyImport_ImportModule", M.py),
                   ("PyImport_Import", M.py), ("PyObject_CallFunction", M.py), ("_PyEval_EvalFrameDefault", M.py),
                   ("PyUnicode_InternInPlace", M.py))),
        (0.4, ())])
    import_F = A(L(T, "import torch.nn.functional as F"), pyf=0.9, util=0.95, native=py_only)
    import_amp = A(L(T, "from torch.cuda.amp import GradScaler"), pyf=0.9, util=0.95, native=py_only)
    import_model = A(L(T, "from model.transformer import GPT, GPTConfig"), pyf=0.95, util=0.97, native=py_only)
    argparse_act = A(L(T, "args = parser.parse_args()"), pyf=0.97, util=0.98, native=py_only)
    json_cfg = A(L(T, "overrides = json.load(f)"), pyf=0.8, util=0.6, native=[(0.6, nat(("read", M.libc))), (0.4, ())])
    seed_act = A(L(T, "torch.manual_seed(cfg.seed)"), pyf=0.2, util=0.97, native=[
        (1.0, torch_op("manual_seed", ("at::CPUGeneratorImpl::set_current_seed(unsigned long)", M.c10), method=False))])
    tok_json = A(L(TK, "encoder = json.load(f)"), pyf=0.38, util=0.97, native=[
        (0.45, nat(("cfunction_vectorcall_O", M.py), ("scanner_call", M.json), ("scan_once_unicode", M.json),
                   ("_parse_object_unicode", M.json), ("PyDict_SetItem", M.py), ("insertdict", M.py))),
        (0.25, nat(("cfunction_vectorcall_O", M.py), ("scanner_call", M.json), ("scan_once_unicode", M.json), ("_parse_object_unicode", M.json),
                   ("scanstring_unicode", M.json), ("PyUnicode_New", M.py), ("_PyObject_Malloc", M.py))),
        (0.12, gc_pass()), (0.18, ())])
    tok_read = A(L(TK, 'lines = f.read().split("\\n")[1:-1]'), pyf=0.3, util=0.7, native=[
        (0.5, nat(("_io__TextIOWrapper_read", M.py), ("_io__Buffered_read", M.py), ("_Py_read", M.py), ("read", M.libc))),
        (0.5, nat(("method_vectorcall_FASTCALL_KEYWORDS", M.py), ("unicode_split", M.py), ("split", M.py)))])
    tok_merges = A(L(TK, "merges = [tuple(line.split()) for line in lines]"), pyf=0.88, util=0.98, native=[
        (0.6, ()), (0.25, nat(("unicode_split", M.py), ("PyList_Append", M.py))), (0.15, gc_pass())])
    tok_decoder = A(L(TK, "self.decoder = {v: k for k, v in encoder.items()}"), pyf=0.95, util=0.99, native=py_only)
    tok_ranks = A(L(TK, "self.bpe_ranks = dict(zip(merges, range(len(merges))))"), pyf=0.4, util=0.99, native=[
        (0.7, nat(("dict_new", M.py), ("dict_merge", M.py), ("insertdict", M.py), ("tuplehash", M.py))), (0.3, ())])
    tok_b2u = A(L(TK, "return dict(zip(bs, (chr(c) for c in cs)))"), pyf=0.95, util=0.99, native=py_only)
    fromfile_tail = nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py), ("array_fromfile", M.np), ("PyArray_FromFile", M.np),
                        ("array_fromfile_binary", M.np), ("fread", M.libc), ("_IO_file_xsgetn", M.libc), ("read", M.libc))
    fromfile_tr = A(L(LD, "self.tokens = np.fromfile(path, dtype=np.uint16)"), pyf=0.02, util=0.42, core=0.016,
                    pins={(LD, "PackedTokenDataset.__init__"): train_set_call},
                    native=prefixes(fromfile_tail, [(0, 0.74), (-1, 0.12), (-3, 0.1), (3, 0.04)]))
    fromfile_va = A(fromfile_tr.key, pyf=0.02, util=0.4, core=0.015, pins={(LD, "PackedTokenDataset.__init__"): val_set_call},
                    native=fromfile_tr.native)
    w_start = nat(("method_vectorcall_FASTCALL", M.py), ("thread_PyThread_start_new_thread", M.py), ("PyThread_start_new_thread", M.py),
                  ("pthread_create@@GLIBC_2.34", M.libc), ("__clone3", M.libc))
    start_tr = A(L(LD, "w.start()"), pyf=0.5, util=0.7, pins={(LD, "ThreadedPrefetcher.__init__"): train_loader_call},
                 native=[(0.6, w_start), (0.4, ())])
    start_va = A(start_tr.key, pyf=0.5, util=0.7, pins={(LD, "ThreadedPrefetcher.__init__"): val_loader_call}, native=start_tr.native)

    uniform_tail = nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py),
                       ("torch::autograd::THPVariable_kaiming_uniform_(_object*, _object*, _object*)", M.tpy),
                       ("at::_ops::uniform_::call(at::Tensor&, double, double, std::optional<at::Generator>)", M.tcpu),
                       ("at::native::uniform_(at::Tensor&, double, double, std::optional<at::Generator>)", M.tcpu),
                       ("void at::native::templates::cpu::uniform_kernel<at::CPUGeneratorImpl*>(at::TensorIteratorBase&, double, double, at::CPUGeneratorImpl*)", M.tcpu),
                       ("at::uniform_real_distribution<float>::operator()<at::CPUGeneratorImpl*>(at::CPUGeneratorImpl*)", M.tcpu),
                       ("at::mt19937_engine<624, 397, 31, 2567483615u, 2147483648u, 2147483647u>::operator()()", M.tcpu))
    alloc_tail = nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py), ("torch::autograd::THPVariable_empty(_object*, _object*, _object*)", M.tpy),
                     ("at::_ops::empty_memory_format::call(c10::ArrayRef<c10::SymInt>, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>, std::optional<c10::MemoryFormat>)", M.tcpu),
                     ("at::detail::empty_cpu(c10::ArrayRef<long>, c10::ScalarType, bool, std::optional<c10::MemoryFormat>)", M.tcpu),
                     ("c10::alloc_cpu(unsigned long)", M.c10), ("posix_memalign", M.libc), ("_int_memalign", M.libc))
    lin_init = [(0.55, uniform_tail), (0.2, uniform_tail[:-1]), (0.15, alloc_tail), (0.1, ())]
    mk_c_fc = A(L(MD, "self.c_fc = nn.Linear("), pyf=0.12, util=0.98, native=lin_init)
    mk_c_proj_mlp = A(L(MD, "self.c_proj = nn.Linear(4 * cfg.n_embd"), pyf=0.12, util=0.98, native=lin_init)
    mk_c_attn = A(L(MD, "self.c_attn = nn.Linear("), pyf=0.12, util=0.98, native=lin_init)
    mk_c_proj_att = A(L(MD, "self.c_proj = nn.Linear(cfg.n_embd, cfg.n_embd"), pyf=0.15, util=0.98, native=lin_init)
    mk_mask = A(L(MD, "mask = torch.tril(torch.ones(cfg.block_size, cfg.block_size))"), pyf=0.1, util=0.98, native=[
        (0.6, torch_op("tril", ("at::_ops::tril::call(at::Tensor const&, long)", M.tcpu),
                       ("at::native::structured_tril_cpu::impl(at::Tensor const&, long, at::Tensor const&)", M.tcpu), method=False)),
        (0.4, torch_op("ones", ("at::_ops::ones::call(c10::ArrayRef<c10::SymInt>, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>)", M.tcpu),
                       ("at::native::fill_(at::Tensor&, c10::Scalar const&)", M.tcpu), ("__memset_avx2_unaligned_erms", M.libc), method=False))])
    mk_ln = A(L(MD, "self.weight = nn.Parameter(torch.ones(ndim))"), pyf=0.6, util=0.98, native=py_only)
    mk_wte = A(L(MD, "wte=nn.Embedding(cfg.vocab_size, cfg.n_embd),"), pyf=0.05, util=0.99, native=[
        (0.7, nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py), ("torch::autograd::THPVariable_normal_(_object*, _object*, _object*)", M.tpy),
                  ("at::native::normal_(at::Tensor&, double, double, std::optional<at::Generator>)", M.tcpu),
                  ("void at::native::templates::cpu::normal_kernel<at::CPUGeneratorImpl*>(at::TensorBase const&, double, double, at::CPUGeneratorImpl*)", M.tcpu),
                  ("at::normal_distribution<double>::operator()<at::CPUGeneratorImpl*>(at::CPUGeneratorImpl*)", M.tcpu))),
        (0.3, alloc_tail)])
    mk_lm_head = A(L(MD, "self.lm_head = nn.Linear(cfg.n_embd, cfg.vocab_size, bias=False)"), pyf=0.04, util=0.99, native=lin_init)
    normal_tail = nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py), ("torch::autograd::THPVariable_normal_(_object*, _object*, _object*)", M.tpy),
                      ("at::_ops::normal_::call(at::Tensor&, double, double, std::optional<at::Generator>)", M.tcpu),
                      ("at::native::normal_(at::Tensor&, double, double, std::optional<at::Generator>)", M.tcpu),
                      ("void at::native::templates::cpu::normal_kernel<at::CPUGeneratorImpl*>(at::TensorBase const&, double, double, at::CPUGeneratorImpl*)", M.tcpu),
                      ("void at::native::(anonymous namespace)::normal_fill<float, at::CPUGeneratorImpl*>(at::TensorBase const&, float, float, at::CPUGeneratorImpl*)", M.tcpu),
                      ("at::normal_distribution<double>::operator()<at::CPUGeneratorImpl*>(at::CPUGeneratorImpl*)", M.tcpu))
    init_lin = A(L(MD, "torch.nn.init.normal_(module.weight, mean=0.0, std=0.02)", nth=0), pyf=0.03, util=0.99, core=0.031,
                 native=prefixes(normal_tail, [(0, 0.5), (-1, 0.3), (5, 0.12), (2, 0.08)]))
    init_emb = A(L(MD, "torch.nn.init.normal_(module.weight, mean=0.0, std=0.02)", nth=1), pyf=0.03, util=0.99, core=0.031,
                 native=init_lin.native)
    init_bias = A(L(MD, "torch.nn.init.zeros_(module.bias)"), pyf=0.5, util=0.99, native=py_only)
    init_isinst = A(L(MD, "if isinstance(module, nn.Linear):"), pyf=0.98, util=0.99, native=py_only)
    init_cproj = A(L(MD, "torch.nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt"), pyf=0.05, util=0.99, core=0.031, native=init_lin.native)
    init_names = A(L(MD, 'if name.endswith("c_proj.weight"):'), pyf=0.97, util=0.99, native=py_only)
    to_cuda_init = nat(("method_vectorcall_VARARGS_KEYWORDS", M.py), ("torch::utils::device_lazy_init(c10::DeviceType)", M.tpy),
                       ("torch::cuda::lazy_init()", M.tpy), ("c10::cuda::device_count()", M.c10cuda),
                       ("cudaGetDeviceCount", M.cudart), ("cuInit", M.cuda), ("", M.cuda), ("ioctl", M.libc))
    to_copy = h2d() + (("__memmove_avx_unaligned_erms", M.libc),)
    model_to = A(L(T, "model = model.to(device)"), pyf=0.08, util=0.55, core=0.02, copy_mb=396.0,
                 native=[(0.34, to_cuda_init), (0.16, to_cuda_init[:-2]), (0.32, to_copy), (0.12, to_copy[:-2]), (0.06, ())])
    optim_init = A(L(AW, "super().__init__(params, defaults)"), pyf=0.9, util=0.99, native=py_only)
    decay_loop = A(L(T, "if param.dim() >= 2:"), pyf=0.92, util=0.99, native=py_only)
    scaler_act = A(L(T, "scaler = GradScaler()"), pyf=0.7, util=0.99, native=py_only)
    tracker_init = A(L(T, "tracker = MetricTracker(log_every=10)"), pyf=0.97, util=0.99, native=py_only)
    nparams = A(L(MD, "n = sum(p.numel() for p in self.parameters())"), pyf=0.96, util=0.99, native=py_only)

    # ---- per-step acts (train context unless noted) -------------------------------
    def fwd_acts(pins: Dict) -> Dict[str, Act]:
        ln_pin = lambda c: {**pins, (MD, "LayerNorm.forward"): c}  # noqa: E731
        lnorm = elementwise("layer_norm", "at::native::(anonymous namespace)::LayerNormKernelImplInternal<c10::BFloat16, float>(at::Tensor const&, at::Tensor const&, at::Tensor const&, long, long, float, at::Tensor*, at::Tensor*, at::Tensor*)",
                            "at::native::layer_norm_symint(at::Tensor const&, c10::ArrayRef<c10::SymInt>, std::optional<at::Tensor> const&, std::optional<at::Tensor> const&, double, bool)")
        ln_v = [(0.5, lnorm), (0.2, lnorm[:-2]), (0.15, lnorm[:3]), (0.15, ())]
        softmax = torch_op("softmax", ("at::_ops::softmax_int::call(at::Tensor const&, long, std::optional<c10::ScalarType>)", M.tcpu),
                           ("at::native::softmax(at::Tensor const&, long, std::optional<c10::ScalarType>)", M.tcpu),
                           ("at::native::structured_softmax_cuda_out::impl(at::Tensor const&, long, bool, at::Tensor const&)", M.tcuda),
                           ("void at::native::(anonymous namespace)::host_softmax<at::native::(anonymous namespace)::SoftMaxForwardEpilogue, false>(at::Tensor const&, long, bool, at::Tensor const&)", M.tcuda),
                           method=False) + LAUNCH
        mfill = torch_op("masked_fill", ("at::_ops::masked_fill_Scalar::call(at::Tensor const&, at::Tensor const&, c10::Scalar const&)", M.tcpu),
                         ("at::native::masked_fill(at::Tensor const&, at::Tensor const&, c10::Scalar const&)", M.tcpu),
                         ("at::native::masked_fill__cuda(at::Tensor&, at::Tensor const&, c10::Scalar const&)", M.tcuda),
                         ("void at::native::gpu_kernel_impl<at::native::masked_fill_kernel(at::TensorIterator&, c10::Scalar const&)::{lambda()#1}::operator()() const::{lambda(float, bool)#1}>(at::TensorIteratorBase&, at::native::masked_fill_kernel(at::TensorIterator&, c10::Scalar const&)::{lambda()#1}::operator()() const::{lambda(float, bool)#1} const&)", M.tcuda)) + LAUNCH
        dropout = elementwise("dropout", "at::native::(anonymous namespace)::dropout_cuda<c10::BFloat16>(at::CUDAGeneratorImpl*, at::Tensor const&, double)",
                              "at::native::dropout(at::Tensor const&, double, bool)")
        gelu = elementwise("gelu", "at::native::GeluCUDAKernelImpl(at::TensorIteratorBase&, at::native::GeluType)",
                           "at::_ops::gelu::call(at::Tensor const&, c10::basic_string_view<char>)")
        view = torch_op("view", ("at::_ops::view::call(at::Tensor const&, c10::ArrayRef<c10::SymInt>)", M.tcpu),
                        ("at::native::view(at::Tensor const&, c10::ArrayRef<long>)", M.tcpu))
        contig = torch_op("contiguous", ("at::native::contiguous(at::Tensor const&, c10::MemoryFormat)", M.tcpu),
                          ("at::_ops::clone::call(at::Tensor const&, std::optional<c10::MemoryFormat>)", M.tcpu),
                          ("at::native::copy_kernel_cuda(at::TensorIterator&, bool)", M.tcuda)) + LAUNCH
        emb = torch_op("embedding", ("at::_ops::embedding::call(at::Tensor const&, at::Tensor const&, c10::SymInt, bool, bool)", M.tcpu),
                       ("at::native::embedding_symint(at::Tensor const&, at::Tensor const&, c10::SymInt, bool, bool)", M.tcpu),
                       ("at::native::index_select_out_cuda(at::Tensor const&, long, at::Tensor const&, at::Tensor&)", M.tcuda), method=False) + LAUNCH
        add = (("binary_op1", M.py), ("torch::autograd::TypeError_to_NotImplemented_<&torch::autograd::THPVariable_add>(_object*, _object*, _object*)", M.tpy),
               ("at::_ops::add_Tensor::call(at::Tensor const&, at::Tensor const&, c10::Scalar const&)", M.tcpu),
               ("at::native::(anonymous namespace)::wrapper_CUDA_add_Tensor(at::Tensor const&, at::Tensor const&, c10::Scalar const&)", M.tcuda),
               ("at::native::add_kernel(at::TensorIteratorBase&, c10::Scalar const&)", M.tcuda)) + LAUNCH
        bmm = gemm_tail("torch::autograd::THPVariable_matmul(_object*, _object*, _object*)", "bmm")
        bmm = (("binary_op1", M.py),) + bmm[1:]
        g = 0.8
        acts = {
            "pos": A(L(MD, "pos = torch.arange(0, T"), pyf=0.3, util=0.97, gpu=g, pins=pins, native=[(1.0, torch_op("arange", ("at::native::arange_cuda_out(c10::Scalar const&, c10::Scalar const&, c10::Scalar const&, at::Tensor&)", M.tcuda), method=False) + LAUNCH)]),
            "tok": A(L(MD, "tok_emb = self.transformer.wte(idx)"), pyf=0.25, util=0.97, gpu=g, pins=pins, native=[(0.7, emb), (0.3, emb[:4])]),
            "pemb": A(L(MD, "pos_emb = self.transformer.wpe(pos)"), pyf=0.3, util=0.97, gpu=g, pins=pins, native=[(0.7, emb), (0.3, ())]),
            "drop": A(L(MD, "x = self.transformer.drop(tok_emb + pos_emb)"), pyf=0.22, util=0.97, gpu=g, pins=pins, native=[(0.5, add), (0.5, dropout)]),
            "loop": A(L(MD, "for block in self.transformer.h:"), pyf=0.97, util=0.99, gpu=g, pins=pins, native=py_only),
            "ln1": A(L(MD, "return F.layer_norm("), pyf=0.18, util=0.97, gpu=g, pins=ln_pin(attn_call), native=ln_v),
            "size": A(L(MD, "B, T, C = x.size()"), pyf=0.8, util=0.98, gpu=g, pins=pins, native=py_only),
            "qkv": A(L(MD, "q, k, v = self.c_attn(x).split(self.n_embd, dim=2)"), pyf=0.12, util=0.97, gpu=g, pins=pins, native=linear_variants()),
            "q": A(L(MD, "q = q.view(B, T, self.n_head"), pyf=0.35, util=0.98, gpu=g, pins=pins, native=[(0.7, view), (0.3, ())]),
            "k": A(L(MD, "k = k.view(B, T, self.n_head"), pyf=0.35, util=0.98, gpu=g, pins=pins, native=[(0.7, view), (0.3, ())]),
            "v": A(L(MD, "v = v.view(B, T, self.n_head"), pyf=0.35, util=0.98, gpu=g, pins=pins, native=[(0.7, view), (0.3, ())]),
            "att": A(L(MD, "att = (q @ k.transpose(-2, -1)) * self.scale"), pyf=0.1, util=0.97, gpu=0.86, pins=pins,
                     native=prefixes(bmm, [(0, 0.4), (-2, 0.2), (-4, 0.12), (6, 0.1), (4, 0.08)]) + [(0.1, add)]),
            "mask": A(L(MD, "att = att.masked_fill("), pyf=0.15, util=0.97, gpu=0.86, pins=pins, native=[(0.6, mfill), (0.25, mfill[:-3]), (0.15, ())]),
            "softmax": A(L(MD, "att = F.softmax(att, dim=-1)"), pyf=0.12, util=0.97, gpu=0.88, pins=pins, native=[(0.62, softmax), (0.26, softmax[:-3]), (0.12, softmax[:3])]),
            "adrop": A(L(MD, "att = self.attn_dropout(att)"), pyf=0.2, util=0.97, gpu=0.86, pins=pins, native=[(0.7, dropout), (0.3, ())]),
            "yatt": A(L(MD, "y = att @ v"), pyf=0.1, util=0.97, gpu=0.88, pins=pins, native=prefixes(bmm, [(0, 0.5), (-2, 0.2), (6, 0.2), (3, 0.1)])),
            "ytr": A(L(MD, "y = y.transpose(1, 2).contiguous().view(B, T, C)"), pyf=0.2, util=0.97, gpu=0.86, pins=pins, native=[(0.7, contig), (0.3, view)]),
            "aproj": A(L(MD, "return self.resid_dropout(self.c_proj(y))"), pyf=0.12, util=0.97, gpu=0.86, pins=pins, native=linear_variants() + [(0.15, dropout)]),
            "res1": A(attn_call, pyf=0.3, util=0.98, gpu=0.85, pins=pins, native=[(0.8, add), (0.2, ())]),
            "ln2": A(L(MD, "return F.layer_norm("), pyf=0.18, util=0.97, gpu=g, pins=ln_pin(mlp_call), native=ln_v),
            "fc": A(L(MD, "x = self.c_fc(x)"), pyf=0.12, util=0.97, gpu=0.88, pins=pins, native=linear_variants()),
            "gelu": A(L(MD, 'x = F.gelu(x, approximate="tanh")'), pyf=0.15, util=0.97, gpu=0.88, pins=pins, native=[(0.7, gelu), (0.3, gelu[:3])]),
            "mproj": A(L(MD, "x = self.c_proj(x)"), pyf=0.12, util=0.97, gpu=0.88, pins=pins, native=linear_variants()),
            "mdrop": A(L(MD, "return self.dropout(x)"), pyf=0.2, util=0.97, gpu=0.86, pins=pins, native=[(0.7, dropout), (0.3, ())]),
            "res2": A(mlp_call, pyf=0.3, util=0.98, gpu=0.85, pins=pins, native=[(0.8, add), (0.2, ())]),
            "ret": A(L(MD, "return x", func="Block.forward"), pyf=0.99, util=0.99, gpu=0.85, pins=pins, native=py_only),
            "lnf": A(L(MD, "return F.layer_norm("), pyf=0.18, util=0.97, gpu=g, pins=ln_pin(lnf_call), native=ln_v),
            "head": A(L(MD, "return self.lm_head(x)"), pyf=0.05, util=0.97, gpu=0.9, gpu_mb=820.0, pins=pins, native=linear_variants()),
        }
        return acts

    def fwd_plan(acts: Dict[str, Act], scale: float) -> List[Tuple[Act, float]]:
        plan: List[Tuple[Act, float]] = []
        for name, d in (("pos", 0.12), ("tok", 0.35), ("pemb", 0.2), ("drop", 0.45)):
            plan.append((acts[name], ms(jit(rng, d * scale))))
        for _b in range(8):
            for name, d in (("loop", 0.02), ("ln1", 0.3), ("size", 0.02), ("qkv", 0.55), ("q", 0.1), ("k", 0.1),
                            ("v", 0.1), ("att", 0.42), ("mask", 0.33), ("softmax", 0.3), ("adrop", 0.22),
                            ("yatt", 0.28), ("ytr", 0.2), ("aproj", 0.45), ("res1", 0.08), ("ln2", 0.3),
                            ("fc", 0.5), ("gelu", 0.25), ("mproj", 0.45), ("mdrop", 0.2), ("res2", 0.08), ("ret", 0.01)):
                plan.append((acts[name], ms(jit(rng, d * scale))))
        plan.append((acts["lnf"], ms(jit(rng, 0.3 * scale))))
        plan.append((acts["head"], ms(jit(rng, 1.6 * scale))))
        return plan

    fwd_train = fwd_acts(TRAIN_PINS)
    fwd_eval = fwd_acts(EVAL_PINS)

    lr_act = A(L(T, "return cfg.min_lr + coeff * (cfg.lr - cfg.min_lr)"), pyf=0.99, util=0.99, gpu=0.85, native=py_only)
    lr_warm = A(L(T, "return cfg.lr * (step + 1) / cfg.warmup_steps"), pyf=0.99, util=0.99, gpu=0.6, native=py_only)
    group_act = A(L(T, 'group["lr"] = lr'), pyf=0.99, util=0.99, gpu=0.85, native=py_only)
    next_fast = A(L(LD, "return self.queue.get()"), pyf=0.85, util=0.9, gpu=0.6, pins=TRAIN_PINS, native=[
        (0.7, ()), (0.3, nat(("lock_PyThread_acquire_lock", M.py), ("PyThread_acquire_lock_timed", M.py)))])
    next_wait = A(next_fast.key, pyf=0.5, util=0.1, sleeping=True, pins=TRAIN_PINS)
    next_fast_ev = A(next_fast.key, pyf=0.85, util=0.9, gpu=0.5, pins=EVAL_PINS, native=next_fast.native)
    next_wait_ev = A(next_fast.key, pyf=0.5, util=0.1, sleeping=True, pins=EVAL_PINS)
    h2d_v = [(0.52, h2d()), (0.18, h2d()[:-2]), (0.12, h2d()[:4]), (0.1, gil_wait()), (0.08, ())]
    x_to = A(L(T, 'x = batch["input_ids"].to(device, non_blocking=True)', func="train"), pyf=0.12, util=0.93, gpu=0.62, native=h2d_v)
    y_to = A(L(T, 'y = batch["targets"].to(device, non_blocking=True)', func="train"), pyf=0.12, util=0.93, gpu=0.62, native=h2d_v)
    x_to_ev = A(L(T, 'x = batch["input_ids"].to(device, non_blocking=True)', func="evaluate"), pyf=0.12, util=0.93, gpu=0.6, native=h2d_v)
    y_to_ev = A(L(T, 'y = batch["targets"].to(device, non_blocking=True)', func="evaluate"), pyf=0.12, util=0.93, gpu=0.6, native=h2d_v)
    autocast_tr = A(L(T, "with torch.autocast(", func="train"), pyf=0.9, util=0.99, gpu=0.8, native=py_only)
    autocast_ev = A(L(T, "with torch.autocast(", func="evaluate"), pyf=0.9, util=0.99, gpu=0.8, native=py_only)
    xent = torch_op("cross_entropy_loss", ("at::_ops::cross_entropy_loss::call(at::Tensor const&, at::Tensor const&, std::optional<at::Tensor> const&, long, c10::SymInt, double)", M.tcpu),
                    ("at::native::cross_entropy_loss_symint(at::Tensor const&, at::Tensor const&, std::optional<at::Tensor> const&, long, c10::SymInt, double)", M.tcpu),
                    ("at::_ops::_log_softmax::call(at::Tensor const&, long, bool)", M.tcpu),
                    ("at::native::structured_log_softmax_cuda_out::impl(at::Tensor const&, long, bool, at::Tensor const&)", M.tcuda),
                    ("void at::native::(anonymous namespace)::host_softmax<at::native::(anonymous namespace)::LogSoftMaxForwardEpilogue, true>(at::Tensor const&, long, bool, at::Tensor const&)", M.tcuda),
                    method=False) + LAUNCH
    loss_tr = A(L(T, "loss = F.cross_entropy(", func="train"), pyf=0.1, util=0.97, gpu=0.9, gpu_mb=1640.0, native=[(0.6, xent), (0.25, xent[:5]), (0.15, ())])
    loss_ev = A(L(T, "loss = F.cross_entropy(", func="evaluate"), pyf=0.1, util=0.97, gpu=0.9, gpu_mb=820.0, native=loss_tr.native)

    bw_root = (("method_vectorcall_VARARGS_KEYWORDS", M.py),
               ("torch::autograd::THPEngine_run_backward(_object*, _object*, _object*)", M.tpy),
               ("torch::autograd::python::PythonEngine::execute(std::vector<torch::autograd::Edge, std::allocator<torch::autograd::Edge> > const&, std::vector<at::Tensor, std::allocator<at::Tensor> > const&, bool, bool, std::vector<torch::autograd::Edge, std::allocator<torch::autograd::Edge> > const&)", M.tpy),
               ("torch::autograd::Engine::execute(std::vector<torch::autograd::Edge, std::allocator<torch::autograd::Edge> > const&, std::vector<at::Tensor, std::allocator<at::Tensor> > const&, bool, bool, bool, std::vector<torch::autograd::Edge, std::allocator<torch::autograd::Edge> > const&)", M.tcpu))
    bw_wait = bw_root + (("torch::autograd::Engine::execute_with_graph_task(std::shared_ptr<torch::autograd::GraphTask> const&, std::shared_ptr<torch::autograd::Node>, torch::autograd::InputBuffer&&)", M.tcpu),
                         ("std::condition_variable::wait(std::unique_lock<std::mutex>&)", M.stdcxx),
                         ("pthread_cond_wait@@GLIBC_2.3.2", M.libc), ("__futex_abstimed_wait_common", M.libc))
    bw_eval = bw_root + (("torch::autograd::Engine::thread_main(std::shared_ptr<torch::autograd::GraphTask> const&)", M.tcpu),
                         ("torch::autograd::Engine::evaluate_function(std::shared_ptr<torch::autograd::GraphTask>&, torch::autograd::Node*, torch::autograd::InputBuffer&, std::shared_ptr<torch::autograd::ReadyQueue> const&)", M.tcpu),
                         ("torch::autograd::call_function(std::shared_ptr<torch::autograd::GraphTask>&, torch::autograd::Node*, torch::autograd::InputBuffer&)", M.tcpu))

    def bw_kernel(node: str, *k: Tuple[str, str]) -> NativeTail:
        return bw_eval + ((f"torch::autograd::generated::{node}::apply(std::vector<at::Tensor, std::allocator<at::Tensor> >&&)", M.tcpu),) + tuple(k) + LAUNCH

    backward = A(L(T, "scaler.scale(loss).backward()"), pyf=0.02, util=0.96, core=0.045, gpu=0.96, gpu_mb=2350.0, native=[
        (0.34, bw_wait), (0.08, bw_wait[:-1]),
        (0.14, bw_kernel("MmBackward0", ("at::_ops::mm::call(at::Tensor const&, at::Tensor const&)", M.tcpu),
                         ("at::native::structured_mm_out_cuda::impl(at::Tensor const&, at::Tensor const&, at::Tensor const&)", M.tcuda),
                         ("cublasGemmEx", M.cublas), ("cublasLtMatmul", M.cublaslt))),
        (0.08, bw_kernel("BmmBackward0", ("at::_ops::bmm::call(at::Tensor const&, at::Tensor const&)", M.tcpu),
                         ("cublasGemmStridedBatchedEx", M.cublas))),
        (0.07, bw_kernel("SoftmaxBackward0", ("at::_ops::_softmax_backward_data::call(at::Tensor const&, at::Tensor const&, long, c10::ScalarType)", M.tcpu),
                         ("at::native::structured_softmax_backward_cuda_out::impl(at::Tensor const&, at::Tensor const&, long, c10::ScalarType, at::Tensor const&)", M.tcuda))),
        (0.06, bw_kernel("GeluBackward0", ("at::native::GeluBackwardCUDAKernelImpl(at::TensorIteratorBase&, at::native::GeluType)", M.tcuda))),
        (0.06, bw_kernel("NativeLayerNormBackward0", ("at::native::layer_norm_backward_cuda(at::Tensor const&, at::Tensor const&, c10::ArrayRef<long>, at::Tensor const&, at::Tensor const&, std::optional<at::Tensor> const&, std::optional<at::Tensor> const&, std::array<bool, 3ul>)", M.tcuda))),
        (0.05, bw_kernel("NativeDropoutBackward0", ("at::native::masked_scale_cuda(at::Tensor const&, at::Tensor const&, double)", M.tcuda))),
        (0.04, bw_kernel("EmbeddingBackward0", ("at::native::embedding_dense_backward_cuda(at::Tensor const&, at::Tensor const&, long, long, bool)", M.tcuda),
                         ("at::native::embedding_backward_cuda_kernel(at::Tensor const&, at::Tensor const&, at::Tensor const&, long, long, long, bool, at::Tensor const&, at::Tensor const&, at::Tensor const&)", M.tcuda))),
        (0.05, bw_eval + (("torch::autograd::AccumulateGrad::apply(std::vector<at::Tensor, std::allocator<at::Tensor> >&&)", M.tcpu),
                          ("at::native::add_(at::Tensor&, at::Tensor const&, c10::Scalar const&)", M.tcpu)) + LAUNCH),
        (0.03, bw_root[:2]),
    ])
    unscale = A(L(T, "scaler.unscale_(optimizer)"), pyf=0.35, util=0.96, gpu=0.9, native=[
        (0.6, nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py),
                  ("torch::autograd::THPVariable__amp_foreach_non_finite_check_and_unscale_(_object*, _object*, _object*)", M.tpy),
                  ("at::native::_amp_foreach_non_finite_check_and_unscale_cuda_(c10::ArrayRef<at::Tensor>, at::Tensor&, at::Tensor const&)", M.tcuda)) + LAUNCH),
        (0.4, ())])
    clip = A(L(T, "grad_norm = torch.nn.utils.clip_grad_norm_("), pyf=0.3, util=0.96, gpu=0.9, native=[
        (0.45, nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py), ("torch::autograd::THPVariable__foreach_norm(_object*, _object*, _object*)", M.tpy),
                   ("at::_ops::_foreach_norm_Scalar::call(c10::ArrayRef<at::Tensor>, c10::Scalar const&, std::optional<c10::ScalarType>)", M.tcpu),
                   ("at::native::foreach_tensor_norm_cuda(c10::ArrayRef<at::Tensor>, c10::Scalar const&, std::optional<c10::ScalarType>)", M.tcuda)) + LAUNCH),
        (0.25, foreach("mul_", "at::native::foreach_tensor_mul_scalar_kernel_cuda_(c10::ArrayRef<at::Tensor>, c10::Scalar const&)")),
        (0.3, ())])
    scaler_step = A(L(T, "scaler.step(optimizer)"), pyf=0.25, util=0.6, gpu=0.93, native=sync_variants())
    scaler_upd = A(L(T, "scaler.update()"), pyf=0.4, util=0.95, gpu=0.9, native=[(0.5, ()), (0.5, torch_op("_amp_update_scale_", ("at::native::_amp_update_scale_cuda_(at::Tensor&, at::Tensor&, at::Tensor const&, double, double, long)", M.tcuda), method=False) + LAUNCH)])
    zero_grad = A(L(T, "optimizer.zero_grad(set_to_none=True)"), pyf=0.93, util=0.99, gpu=0.88, native=py_only)
    item_tr = A(L(T, "loss_value = loss.item()"), pyf=0.01, util=0.34, core=0.012, gpu=0.97, native=sync_variants())
    log_act = A(L(T, 'print(f"step {step:5d} | loss'), pyf=0.6, util=0.8, gpu=0.85, native=[
        (0.5, nat(("_io_TextIOWrapper_write", M.py), ("_io__Buffered_write", M.py), ("_bufferedwriter_raw_write", M.py), ("_Py_write", M.py), ("write", M.libc))),
        (0.5, ())])
    tps_act = A(L(T, "tokens_per_sec = (step + 1)"), pyf=0.99, util=0.99, gpu=0.85, native=py_only)

    init_group = A(L(AW, "state = self.state[p]"), pyf=0.97, util=0.99, gpu=0.9, native=py_only)
    init_group_append = A(L(AW, "grads.append(p.grad)"), pyf=0.97, util=0.99, gpu=0.9, native=py_only)
    zeros_like = A(L(AW, 'state["exp_avg"] = torch.zeros_like(p'), pyf=0.1, util=0.97, gpu=0.6, native=[(1.0, torch_op("zeros_like", ("at::native::zeros_like(at::Tensor const&, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>, std::optional<c10::MemoryFormat>)", M.tcpu), ("c10::cuda::CUDACachingAllocator::Native::DeviceCachingAllocator::malloc(signed char, unsigned long, CUstream_st*)", M.c10cuda), ("cudaMalloc", M.cudart), ("", M.cuda), method=False))])
    zeros_like2 = A(L(AW, 'state["exp_avg_sq"] = torch.zeros_like(p'), pyf=0.1, util=0.97, gpu=0.6, native=zeros_like.native)
    fe = {
        "steps": A(L(AW, "torch._foreach_add_(state_steps, 1)"), pyf=0.15, util=0.98, gpu=0.9, native=[(1.0, foreach("add_", "at::native::foreach_tensor_add_scalar_kernel_slow_(c10::ArrayRef<at::Tensor>, c10::Scalar const&)")[:4])]),
        "wd": A(L(AW, "torch._foreach_mul_(params, 1 - lr * weight_decay)"), pyf=0.08, util=0.97, gpu=0.92, native=[(0.8, foreach("mul_", "at::native::foreach_tensor_mul_scalar_kernel_cuda_(c10::ArrayRef<at::Tensor>, c10::Scalar const&)")), (0.2, ())]),
        "lerp": A(L(AW, "torch._foreach_lerp_(exp_avgs, grads, 1 - beta1)"), pyf=0.08, util=0.97, gpu=0.92, native=[(0.85, foreach("lerp_", "at::native::foreach_tensor_lerp_list_kernel_cuda_(c10::ArrayRef<at::Tensor>, c10::ArrayRef<at::Tensor>, c10::Scalar const&)")), (0.15, ())]),
        "mul": A(L(AW, "torch._foreach_mul_(exp_avg_sqs, beta2)"), pyf=0.08, util=0.97, gpu=0.92, native=[(0.85, foreach("mul_", "at::native::foreach_tensor_mul_scalar_kernel_cuda_(c10::ArrayRef<at::Tensor>, c10::Scalar const&)")), (0.15, ())]),
        "addcmul": A(L(AW, "torch._foreach_addcmul_(exp_avg_sqs, grads, grads, 1 - beta2)"), pyf=0.08, util=0.97, gpu=0.92, native=[(0.85, foreach("addcmul_", "at::native::foreach_tensor_addcmul_scalar_cuda_(c10::ArrayRef<at::Tensor>, c10::ArrayRef<at::Tensor>, c10::ArrayRef<at::Tensor>, c10::Scalar const&)")), (0.15, ())]),
        "bc1": A(L(AW, "bias_correction1 = [1 - beta1 ** _get_value(step) for step in state_steps]"), pyf=0.7, util=0.99, gpu=0.9, native=[(0.6, ()), (0.4, nat(("method_vectorcall_NOARGS", M.py), ("torch::autograd::THPVariable_item(_object*, _object*)", M.tpy), ("at::native::_local_scalar_dense_cpu(at::Tensor const&)", M.tcpu)))]),
        "bc2": A(L(AW, "bias_correction2 = [1 - beta2 ** _get_value(step) for step in state_steps]"), pyf=0.7, util=0.99, gpu=0.9, native=[(0.6, ()), (0.4, nat(("method_vectorcall_NOARGS", M.py), ("torch::autograd::THPVariable_item(_object*, _object*)", M.tpy), ("at::native::_local_scalar_dense_cpu(at::Tensor const&)", M.tcpu)))]),
        "ss": A(L(AW, "step_size = [(lr / bc) * -1 for bc in bias_correction1]"), pyf=0.99, util=0.99, gpu=0.9, native=py_only),
        "sqrt": A(L(AW, "exp_avg_sq_sqrt = torch._foreach_sqrt(exp_avg_sqs)"), pyf=0.08, util=0.97, gpu=0.92, native=[(0.85, foreach("sqrt", "at::native::foreach_tensor_sqrt_cuda(c10::ArrayRef<at::Tensor>)")), (0.15, ())]),
        "div": A(L(AW, "torch._foreach_div_(exp_avg_sq_sqrt, bias_correction2_sqrt)"), pyf=0.08, util=0.97, gpu=0.92, native=[(0.85, foreach("div_", "at::native::foreach_tensor_div_scalarlist_kernel_cuda_(c10::ArrayRef<at::Tensor>, c10::ArrayRef<c10::Scalar>)")), (0.15, ())]),
        "eps": A(L(AW, "torch._foreach_add_(exp_avg_sq_sqrt, eps)"), pyf=0.08, util=0.97, gpu=0.92, native=[(0.85, foreach("add_", "at::native::foreach_tensor_add_scalar_kernel_cuda_(c10::ArrayRef<at::Tensor>, c10::Scalar const&)")), (0.15, ())]),
        "addcdiv": A(L(AW, "torch._foreach_addcdiv_(params, exp_avgs, exp_avg_sq_sqrt, step_size)"), pyf=0.08, util=0.97, gpu=0.93, native=[(0.85, foreach("addcdiv_", "at::native::foreach_tensor_addcdiv_scalarlist_cuda_(c10::ArrayRef<at::Tensor>, c10::ArrayRef<at::Tensor>, c10::ArrayRef<at::Tensor>, c10::ArrayRef<c10::Scalar>)")), (0.15, ())]),
    }
    step_loop = A(L(AW, "for group in self.param_groups:", func="AdamW.step"), pyf=0.98, util=0.99, gpu=0.9, native=py_only)

    # metrics
    ema = A(L(MT, "self.ema_loss = self.ema_beta * self.ema_loss"), pyf=0.99, util=0.99, gpu=0.85, native=py_only)
    argmax = A(L(MT, "preds = logits.argmax(dim=-1)"), pyf=0.12, util=0.97, gpu=0.9, native=[
        (0.8, torch_op("argmax", ("at::_ops::argmax::call(at::Tensor const&, std::optional<long>, bool)", M.tcpu),
                       ("at::native::argmax_kernel_cuda(at::TensorIterator&)", M.tcuda),
                       ("void at::native::gpu_reduce_kernel<c10::BFloat16, long, 4, 4, at::native::ArgMaxOps<float>, double>(at::TensorIterator&, at::native::ArgMaxOps<float> const&, double, at::native::AccumulationBuffer*, long)", M.tcuda)) + LAUNCH),
        (0.2, ())])
    acc_item = A(L(MT, "accuracy = (preds == targets).float().mean().item()"), pyf=0.03, util=0.38, gpu=0.95, native=sync_variants())
    d2h = torch_op("cpu", ("at::_ops::_to_copy::call(at::Tensor const&, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>, bool, std::optional<c10::MemoryFormat>)", M.tcpu),
                   ("at::native::_to_copy(at::Tensor const&, std::optional<c10::ScalarType>, std::optional<c10::Layout>, std::optional<c10::Device>, std::optional<bool>, bool, std::optional<c10::MemoryFormat>)", M.tcpu),
                   ("at::native::copy_(at::Tensor&, at::Tensor const&, bool)", M.tcpu),
                   ("at::native::copy_kernel_cuda(at::TensorIterator&, bool)", M.tcuda),
                   ("cudaMemcpyAsync", M.cudart), ("", M.cuda), ("__memmove_avx_unaligned_erms", M.libc), method=True)
    leak_line = A(L(MT, "self.last_token_logits.append(logits[:, -1, :].detach().float().cpu())"), pyf=0.02, util=0.62,
                  gpu=0.9, copy_mb=3.07, native=[(0.5, d2h), (0.2, d2h[:-1]), (0.15, d2h[:-3]), (0.15, ())])
    hist = A(L(MT, 'self.history["grad_norm"].append(float(grad_norm))'), pyf=0.2, util=0.4, gpu=0.9, native=sync_variants())
    hist2 = A(L(MT, 'self.history["accuracy"].append(accuracy)'), pyf=0.99, util=0.99, gpu=0.9, native=py_only)

    # eval
    eval_item = A(L(T, "losses[i] = loss.item()"), pyf=0.02, util=0.3, gpu=0.96, native=sync_variants())
    eval_mean = A(L(T, "return losses.mean().item()"), pyf=0.3, util=0.95, gpu=0.6, native=py_only)
    eval_train = A(L(T, "model.train()", func="evaluate"), pyf=0.97, util=0.99, gpu=0.6, native=py_only)
    eval_print = A(L(T, 'print(f"step {step:5d} | val loss'), pyf=0.7, util=0.85, gpu=0.4, native=log_act.native)
    ppl = A(L(MT, "return math.exp(min(loss, 20.0))"), pyf=0.9, util=0.99, gpu=0.4, native=[(1.0, nat(("math_exp", M.math)))])
    log_eval = A(L(MT, "self.eval_history.append("), pyf=0.99, util=0.99, gpu=0.4, native=py_only)

    # checkpoint & shutdown
    ckpt_state = A(L(T, '"optimizer": optimizer.state_dict(),'), pyf=0.96, util=0.99, gpu=0.3, native=py_only)
    save_tail = (("cfunction_vectorcall_FASTCALL", M.py),
                 ("caffe2::serialize::PyTorchStreamWriter::writeRecord(std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> > const&, void const*, unsigned long, bool)", M.tcpu),
                 ("mz_zip_writer_add_mem_ex_v2", M.tcpu), ("mz_crc32", M.tcpu))
    save_write = (("cfunction_vectorcall_FASTCALL", M.py),
                  ("caffe2::serialize::PyTorchStreamWriter::writeRecord(std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> > const&, void const*, unsigned long, bool)", M.tcpu),
                  ("_IO_fwrite", M.libc), ("_IO_new_file_xsputn", M.libc), ("_IO_new_do_write", M.libc), ("write", M.libc))
    torch_save = A(L(T, "torch.save(state, path)"), pyf=0.12, util=0.55, gpu=0.25, copy_mb=1188.0, native=[
        (0.26, d2h), (0.12, d2h[:-2]), (0.24, save_tail), (0.26, save_write), (0.12, ())])
    json_dump = A(L(MT, "json.dump(payload, f, indent=2)"), pyf=0.91, util=0.93, gpu=0.0, native=[
        (0.7, ()), (0.15, nat(("_io_TextIOWrapper_write", M.py), ("_Py_write", M.py), ("write", M.libc))), (0.15, gc_pass())])
    summary_min = A(L(MT, 'best_val_loss": min('), pyf=0.99, util=0.99, native=py_only)
    join_act = A(L(LD, "w.join(timeout=1.0)"), pyf=0.5, util=0.05, sleeping=True)

    # workers
    w_lock = A(L(LD, "with self._lock:"), pyf=0.6, util=0.9, native=[(0.6, gil_wait()), (0.4, ())])
    w_ints = A(L(LD, "return self._rng.integers(0, len(self.dataset)"), pyf=0.25, util=0.97, native=[
        (0.7, nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py), ("__pyx_pw_5numpy_6random_10_generator_9Generator_17integers", M.npgen),
                   ("__pyx_f_5numpy_6random_17_bounded_integers__rand_int64", M.npgen), ("random_bounded_uint64_fill", M.npgen),
                   ("pcg64_next64", M.nppcg))),
        (0.3, ())])
    w_cache_chk = A(L(LD, "if idx in self._cache:"), pyf=0.97, util=0.99, native=[(0.7, ()), (0.3, gil_wait())])
    w_miss = A(L(LD, "self.misses += 1"), pyf=0.99, util=0.99, native=py_only)
    astype_tail = nat(("method_vectorcall_VARARGS_KEYWORDS", M.py), ("array_astype", M.np), ("PyArray_NewLikeArray", M.np),
                      ("PyArray_AssignArray", M.np), ("raw_array_assign_array", M.np), ("_aligned_contig_cast_ushort_to_long", M.np))
    w_chunk = A(L(LD, "chunk = self.tokens[start : start + self.block_size + 1].astype(np.int64)"), pyf=0.08, util=0.71,
                native=prefixes(astype_tail, [(0, 0.55), (-1, 0.15), (3, 0.1)]) + [
                    (0.08, nat(("method_vectorcall_VARARGS_KEYWORDS", M.py), ("array_astype", M.np), ("PyArray_NewLikeArray", M.np),
                               ("npy_alloc_cache", M.np), ("PyDataMem_UserNEW", M.np), ("malloc", M.libc), ("_int_malloc", M.libc))),
                    (0.12, gil_wait())])
    from_np = torch_op("from_numpy", ("torch::utils::tensor_from_numpy(_object*, bool)", M.tpy), method=False)
    w_in = A(L(LD, '"input_ids": torch.from_numpy(chunk[:-1]),'), pyf=0.3, util=0.98, native=[(0.7, from_np), (0.3, ())])
    w_tg = A(L(LD, '"targets": torch.from_numpy(chunk[1:]),'), pyf=0.3, util=0.98, native=[(0.7, from_np), (0.3, ())])
    w_store = A(L(LD, "self._cache[idx] = sample"), pyf=0.98, util=0.99, native=py_only)
    w_comp = A(L(LD, "samples = [self.dataset[int(i)] for i in indices]"), pyf=0.97, util=0.99, native=[(0.8, ()), (0.2, gil_wait())])
    stack_tail = torch_op("stack", ("at::_ops::stack::call(c10::ArrayRef<at::Tensor>, long)", M.tcpu),
                          ("at::native::stack(c10::ArrayRef<at::Tensor>, long)", M.tcpu),
                          ("at::native::structured_cat_out_cpu::impl(c10::IListRef<at::Tensor> const&, long, long, bool, bool, bool, at::Tensor const&)", M.tcpu),
                          ("void at::native::cat_serial_kernel_impl<long>(at::Tensor const&, c10::IListRef<at::Tensor> const&, long)", M.tcpu),
                          ("__memmove_avx_unaligned_erms", M.libc), method=False)
    w_stack_in = A(L(LD, '"input_ids": torch.stack([s["input_ids"] for s in samples]),'), pyf=0.15, util=0.97,
                   native=[(0.6, stack_tail), (0.2, stack_tail[:-1]), (0.2, gil_wait())])
    w_stack_tg = A(L(LD, '"targets": torch.stack([s["targets"] for s in samples]),'), pyf=0.15, util=0.97,
                   native=[(0.6, stack_tail), (0.2, stack_tail[:-1]), (0.2, gil_wait())])
    w_mask = A(L(LD, 'mask = rng.random(batch["input_ids"].shape) < rate'), pyf=0.12, util=0.98, native=[
        (0.5, nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py), ("__pyx_pw_5numpy_6random_10_generator_9Generator_5random", M.npgen),
                   ("random_standard_uniform_fill", M.npgen), ("pcg64_next64", M.nppcg))),
        (0.3, nat(("binary_op1", M.py), ("ufunc_generic_fastcall", M.np), ("DOUBLE_less", M.np))), (0.2, ())])
    w_setitem = A(L(LD, 'batch["input_ids"][torch.from_numpy(mask)] = 0'), pyf=0.15, util=0.98, native=[
        (0.8, nat(("PyObject_SetItem", M.py), ("torch::autograd::THPVariable_setitem(_object*, _object*, _object*)", M.tpy),
                   ("at::indexing::set_item(at::Tensor const&, std::initializer_list<at::indexing::TensorIndex> const&, c10::Scalar const&)", M.tpy),
                   ("at::native::index_put_(at::Tensor&, c10::List<std::optional<at::Tensor> > const&, at::Tensor const&, bool)", M.tcpu),
                   ("void at::native::(anonymous namespace)::cpu_masked_fill_kernel<long, bool>(at::TensorIterator&, long)", M.tcpu))),
        (0.2, ())])
    pin_tail = (("method_vectorcall_VARARGS_KEYWORDS", M.py),
                ("torch::autograd::THPVariable_pin_memory(_object*, _object*, _object*)", M.tpy),
                ("at::_ops::pin_memory::call(at::Tensor const&, std::optional<c10::Device>)", M.tcpu),
                ("at::native::_pin_memory(at::Tensor const&, std::optional<c10::Device>)", M.tcpu),
                ("at::cuda::(anonymous namespace)::CUDAHostAllocator::allocate(unsigned long)", M.tcuda),
                ("cudaHostAlloc", M.cudart), ("", M.cuda), ("ioctl", M.libc))
    pin_copy = pin_tail[:4] + (("at::native::copy_(at::Tensor&, at::Tensor const&, bool)", M.tcpu),
                               ("at::native::copy_kernel(at::TensorIteratorBase&, bool)", M.tcpu),
                               ("__memmove_avx_unaligned_erms", M.libc))
    w_pin = A(L(LD, "batch = {k: v.pin_memory() for k, v in batch.items()}"), pyf=0.05, util=0.55,
              native=[(0.3, pin_tail), (0.15, pin_tail[:-2]), (0.4, pin_copy), (0.15, gil_wait())])
    w_pin_cold = A(w_pin.key, pyf=0.03, util=0.35, native=[(0.7, pin_tail), (0.3, pin_tail[:-1])])
    w_put = A(L(LD, "self.queue.put(batch, timeout=0.1)"), pyf=0.6, util=0.2, native=[
        (0.6, nat(("lock_PyThread_acquire_lock", M.py), ("PyThread_acquire_lock_timed", M.py),
                  ("__new_sem_wait_slow64.constprop.0", M.libc), ("__futex_abstimed_wait_common", M.libc))),
        (0.4, ())])

    # ---- schedule ----------------------------------------------------------------
    t = 0.004
    t = p.seq(MAIN, t, [(import_np, 0.21), (import_torch, 2.41), (import_F, 0.13), (import_amp, 0.06), (import_model, 0.04),
                        (argparse_act, 0.012), (json_cfg, 0.006), (seed_act, 0.018)])
    t = p.seq(MAIN, t, [(tok_json, 0.66), (tok_read, 0.11), (tok_merges, 0.33), (tok_decoder, 0.06), (tok_b2u, 0.004), (tok_ranks, 0.09)])
    t = p.seq(MAIN, t, [(fromfile_tr, 0.87), (fromfile_va, 0.052)])
    t_loader = p.seq(MAIN, t, [(start_tr, 0.003)])
    t = p.seq(MAIN, t_loader, [(start_va, 0.001)])
    t_val_loader = t
    # model construction
    t = p.seq(MAIN, t, [(mk_wte, 0.21)])
    for _ in range(8):
        t = p.seq(MAIN, t, [(mk_ln, 0.002), (mk_c_attn, jit(rng, 0.092)), (mk_c_proj_att, jit(rng, 0.031)), (mk_mask, jit(rng, 0.019)),
                            (mk_ln, 0.002), (mk_c_fc, jit(rng, 0.12)), (mk_c_proj_mlp, jit(rng, 0.115))])
    t = p.seq(MAIN, t, [(mk_ln, 0.002), (mk_lm_head, 0.19)])
    for _ in range(24):
        t = p.seq(MAIN, t, [(init_isinst, 0.0006), (init_lin, jit(rng, 0.052))])
    t = p.seq(MAIN, t, [(init_emb, 0.31), (init_bias, 0.004)])
    for _ in range(16):
        t = p.seq(MAIN, t, [(init_names, 0.0004), (init_cproj, jit(rng, 0.0098))])
    t_to0 = t
    t = p.seq(MAIN, t, [(model_to, 1.94)])
    p.gpu_alloc(t_to0 + 0.62, 405.0)  # CUDA context
    p.gpu_alloc(t_to0 + 1.5, 396.0)  # fp32 parameters
    t_model_done = t
    t = p.seq(MAIN, t, [(decay_loop, 0.0042), (optim_init, 0.0031), (scaler_act, 0.0011), (tracker_init, 0.0004), (nparams, 0.0028)])

    # --- data pipeline bookkeeping: worker w produces batches b % 3 == w
    prod_dur = lambda b: ms(jit(rng, 21.5, 0.25)) + (ms(24.0) if b < 3 else 0.0)  # noqa: E731
    put_done: Dict[int, float] = {}
    consume: Dict[int, float] = {}
    worker_free = {w: t_loader + 0.002 + 0.0007 * i for i, w in enumerate(WORKERS)}

    def produce(tid: int, start: float, cold: bool) -> float:
        tt = start
        tt = p.seq(tid, tt, [(w_lock, ms(jit(rng, 0.03))), (w_ints, ms(jit(rng, 0.11)))])
        for _ in range(16):
            tt = p.seq(tid, tt, [(w_comp, ms(jit(rng, 0.012))), (w_cache_chk, ms(jit(rng, 0.008))), (w_miss, ms(0.003)),
                                 (w_chunk, ms(jit(rng, 0.92, 0.4))), (w_in, ms(jit(rng, 0.028))), (w_tg, ms(jit(rng, 0.026))),
                                 (w_store, ms(jit(rng, 0.007)))])
        tt = p.seq(tid, tt, [(w_stack_in, ms(jit(rng, 1.2))), (w_stack_tg, ms(jit(rng, 1.1))), (w_mask, ms(jit(rng, 0.7))),
                             (w_setitem, ms(jit(rng, 0.5))), (w_pin_cold if cold else w_pin, ms(jit(rng, 26.0 if cold else 2.8)))])
        return p.run(tid, tt, ms(jit(rng, 0.09)), w_put)

    def ensure_batch(b: int) -> float:
        """Time at which train batch b is in the queue."""
        for bb in range(len(put_done), b + 1):
            tid = WORKERS[bb % 3]
            start = worker_free[tid]
            end = produce(tid, start, cold=bb < 3)
            gate = consume.get(bb - 4, 0.0)  # the put blocks until a queue slot frees up
            put_done[bb] = max(end, gate)
            worker_free[tid] = put_done[bb] + ms(jit(rng, 0.05))
        return put_done[b]

    val_put: Dict[int, float] = {}
    val_consume: Dict[int, float] = {}
    val_free = [t_val_loader + 0.002]

    def ensure_val(b: int) -> float:
        for bb in range(len(val_put), b + 1):
            start = val_free[0]
            end = produce(VALW, start, cold=bb == 0)
            gate = val_consume.get(bb - 4, 0.0)
            val_put[bb] = max(end, gate)
            val_free[0] = val_put[bb] + ms(jit(rng, 0.05))
        return val_put[b]

    def take(tt: float, ready: float, fast: Act, wait: Act) -> float:
        if ready > tt:
            tt = p.run(MAIN, tt, ready - tt, wait)
        return p.run(MAIN, tt, ms(jit(rng, 0.14)), fast)

    leak_windows_act = leak_line
    val_idx = 0
    steps = 200
    first_bw_end = None
    for step in range(steps):
        t = p.run(MAIN, t, ms(0.012), lr_warm if step < 20 else lr_act)
        t = p.run(MAIN, t, ms(0.008), group_act)
        t = take(t, ensure_batch(step), next_fast, next_wait)
        consume[step] = t
        t = p.seq(MAIN, t, [(x_to, ms(jit(rng, 1.5))), (y_to, ms(jit(rng, 1.3))), (autocast_tr, ms(jit(rng, 0.09)))])
        t = p.seq(MAIN, t, fwd_plan(fwd_train, 0.72))
        t = p.run(MAIN, t, ms(jit(rng, 2.4)), loss_tr)
        t = p.run(MAIN, t, ms(jit(rng, 44.0, 0.1)), backward)
        if first_bw_end is None:
            first_bw_end = t
            p.gpu_alloc(t - 0.03, 396.0 + 3870.0)  # gradients + caching-allocator activations
        t = p.seq(MAIN, t, [(unscale, ms(jit(rng, 1.8))), (clip, ms(jit(rng, 6.2)))])
        t = p.run(MAIN, t, ms(jit(rng, 2.1)), scaler_step)
        t = p.run(MAIN, t, ms(jit(rng, 0.25)), step_loop)
        t = p.seq(MAIN, t, [(init_group, ms(jit(rng, 0.9))), (init_group_append, ms(jit(rng, 0.4)))])
        if step == 0:
            t = p.seq(MAIN, t, [(zeros_like, ms(48.0)), (zeros_like2, ms(46.0))])
            p.gpu_alloc(t - 0.05, 792.0)  # Adam moments
        t = p.seq(MAIN, t, [(fe[k], ms(jit(rng, d))) for k, d in (
            ("steps", 0.7), ("wd", 1.7), ("lerp", 2.1), ("mul", 1.5), ("addcmul", 2.2), ("bc1", 1.3), ("bc2", 1.3),
            ("ss", 0.15), ("sqrt", 1.9), ("div", 1.8), ("eps", 1.6), ("addcdiv", 2.4))])
        t = p.seq(MAIN, t, [(scaler_upd, ms(jit(rng, 0.9))), (zero_grad, ms(jit(rng, 1.4)))])
        t = p.run(MAIN, t, ms(jit(rng, 58.0, 0.12)), item_tr)
        t = p.seq(MAIN, t, [(ema, ms(0.01)), (argmax, ms(jit(rng, 0.6))), (acc_item, ms(jit(rng, 6.5))),
                            (leak_windows_act, ms(jit(rng, 5.2))), (hist, ms(jit(rng, 0.9))), (hist2, ms(0.01))])
        if step % 10 == 0:
            t = p.seq(MAIN, t, [(tps_act, ms(0.02)), (log_act, ms(jit(rng, 0.4)))])
        if step > 0 and step % 50 == 0:
            for i in range(8):
                t = take(t, ensure_val(val_idx), next_fast_ev, next_wait_ev)
                val_consume[val_idx] = t
                val_idx += 1
                t = p.seq(MAIN, t, [(x_to_ev, ms(jit(rng, 1.4))), (y_to_ev, ms(jit(rng, 1.2))), (autocast_ev, ms(0.08))])
                t = p.seq(MAIN, t, fwd_plan(fwd_eval, 0.6))
                t = p.seq(MAIN, t, [(loss_ev, ms(jit(rng, 2.0))), (eval_item, ms(jit(rng, 31.0)))])
            t = p.seq(MAIN, t, [(eval_mean, ms(0.05)), (eval_train, ms(0.4)), (eval_print, ms(0.3)), (ppl, ms(0.01)), (log_eval, ms(0.01))])
            if step == 50:
                p.gpu_alloc(t, 212.0)
    # make sure the val worker refills after the last eval
    ensure_val(val_idx + 3)
    t = p.seq(MAIN, t, [(ckpt_state, ms(3.1)), (torch_save, 2.64), (summary_min, ms(0.05)), (json_dump, 0.36), (join_act, 0.1), (join_act, 0.1)])
    p.elapsed = t + 0.0021

    # ---- memory ----------------------------------------------------------------------
    p.mem_hold(import_np, 21.4, 0.58, chunks=3)
    p.mem_hold(import_torch, 186.2, 0.38, chunks=14)
    p.mem_hold(import_F, 3.1, 0.9, chunks=1)
    p.mem_hold(tok_json, 38.6, 0.99, chunks=8)
    p.mem_temp(tok_read, 4.2, 0.98, chunks=1)
    p.mem_hold(tok_merges, 22.4, 1.0, chunks=5)
    p.mem_hold(tok_decoder, 4.6, 1.0, chunks=1)
    p.mem_hold(tok_ranks, 9.4, 0.97, chunks=2)
    p.mem_hold(fromfile_tr, 762.3, 0.0, chunks=12, window=0)
    p.mem_hold(fromfile_va, 38.1, 0.0, chunks=2, window=0)
    free_t = p.windows_of(model_to)[0][0] + 1.7
    weights = [(mk_wte, 98.25), (mk_lm_head, 98.25)]
    for act, mb in weights:
        p.mem_hold(act, mb, 0.0, chunks=2, free_at=free_t, free_act=model_to)
    for act, mb in ((mk_c_attn, 3.0), (mk_c_proj_att, 1.0), (mk_mask, 1.0), (mk_c_fc, 4.0), (mk_c_proj_mlp, 4.0)):
        for w in range(8):
            p.mem_hold(act, mb, 0.0, chunks=1, window=w, free_at=free_t + 0.01 * w, free_act=model_to)
    p.mem_temp(model_to, 2.0, 0.0, chunks=1)
    p.mem_grow(leak_line, 3.07 * steps, 0.0, leak=0.9968)
    p.mem_grow(w_chunk, 30.4, 0.0, leak=0.9615)
    p.mem_temp(w_stack_in, 0.0625, 0.0, chunks=1, life=0.35)
    p.mem_temp(w_stack_tg, 0.0625, 0.0, chunks=1, life=0.35)
    p.mem_temp(w_pin_cold, 4.0, 0.0, chunks=1)
    p.mem_hold(w_pin_cold, 8.0, 0.0, chunks=1, window=0)
    p.mem_temp(w_mask, 0.0625, 0.0, chunks=1)
    p.mem_temp(torch_save, 1188.4, 0.01, chunks=12)
    p.mem_temp(json_dump, 6.2, 0.97, chunks=2)
    p.mem_temp(log_act, 0.02, 1.0, chunks=1)
    for act in (hist, hist2, ema):
        p.mem_grow(act, 0.4, 1.0)
    # allocations inside untraced torch Python code and CUDA/NCCL helper threads
    for i, (t0, t1, _) in enumerate(p.windows_of(backward)):
        p.mem_raw(t0 + 0.001, 0.9, 0.85)
        p.mem_raw(t1, -0.9, 0.85)
    p.mem_raw(t_model_done - 0.4, 212.3, 0.0, tag="<native>")
    return p.build()


# ---------------------------------------------------------------------------
# async-server.json: a tiny discrete-event asyncio loop
# ---------------------------------------------------------------------------

import heapq  # noqa: E402
from collections import defaultdict, deque  # noqa: E402

from fixturelib import MemEvent  # noqa: E402


class SimTask:
    """A simulated asyncio Task: a generator plus its live coroutine frames."""

    def __init__(self, name: str, order: int):
        self.name = name
        self.order = order
        self.gen: Any = None
        self.frames: List[List[Any]] = []  # [filename, lineno, co_name], outermost first
        self.parent: Optional["SimTask"] = None
        self.gather_left = 0
        self.results: List[Any] = []
        self.result: Any = None
        self.done = False
        self.cancelled = False
        self.susp: Optional[Suspension] = None


class EventLoop:
    """Single-threaded event loop: CPU steps are serialized on the main
    thread; awaits suspend a task for a duration (I/O) or until woken
    (pool waiters, gather). Every suspension is recorded for the sampler."""

    def __init__(self, p: Prog, tid: int, t0: float, rng: random.Random, run_key: Key, idle: Act, busy: Act):
        self.p, self.tid, self.t, self.rng = p, tid, t0, rng
        self.run_key = run_key
        self.idle, self.busy = idle, busy
        self.ready: deque = deque()
        self.timers: List[Tuple[float, int, SimTask]] = []
        self.seq = 0
        self.counter = 0
        self.order = 0
        self.pending: Dict[int, Tuple[float, Key, tuple, SimTask]] = {}
        self.acts: Dict[Tuple[int, tuple], Act] = {}
        self.mem_counts: Dict[int, int] = defaultdict(int)

    def create(self, factory: Callable[[SimTask], Any], name: Optional[str] = None) -> SimTask:
        if name is None:
            self.counter += 1
            name = f"Task-{self.counter}"
        task = SimTask(name, self.order)
        self.order += 1
        task.gen = factory(task)
        self.ready.append(task)
        return task

    def _chain(self, task: SimTask) -> Tuple[Key, tuple]:
        chain = tuple((f, ln, fn) for f, ln, fn in task.frames)
        return (chain[0][0], chain[0][1]), chain

    def act_for(self, task: SimTask, tmpl: Act) -> Act:
        f, ln, _ = task.frames[-1]
        chain = ((self.run_key[0], "<module>", self.run_key[1]),) + tuple(
            (ff, self.p.sources[ff].scope[ll].qualname, ll) for ff, ll, _ in task.frames
        )
        k = (id(tmpl), chain)
        act = self.acts.get(k)
        if act is None:
            act = Act((f, ln), pyf=tmpl.pyf, util=tmpl.util, core=tmpl.core, native=tmpl.native, chain=chain)
            self.acts[k] = act
        return act

    def suspend_for(self, task: SimTask, dur: float) -> None:
        root, chain = self._chain(task)
        s = Suspension(self.t, self.t + dur, task.name, task.order, root, chain)
        self.p.suspensions.append(s)
        task.susp = s
        self.seq += 1
        heapq.heappush(self.timers, (s.t1, self.seq, task))

    def park(self, task: SimTask) -> None:
        root, chain = self._chain(task)
        self.pending[id(task)] = (self.t, root, chain, task)

    def wake(self, task: SimTask) -> None:
        t0, root, chain, _ = self.pending.pop(id(task))
        self.p.suspensions.append(Suspension(t0, self.t, task.name, task.order, root, chain))
        self.ready.append(task)

    def cancel(self, task: SimTask) -> None:
        task.cancelled = True
        if id(task) in self.pending:
            t0, root, chain, _ = self.pending.pop(id(task))
            self.p.suspensions.append(Suspension(t0, self.t, task.name, task.order, root, chain))
        if task.susp is not None and task.susp.t1 > self.t:
            task.susp.t1 = self.t

    def finish(self, task: SimTask) -> None:
        task.done = True
        par = task.parent
        if par is not None and not par.cancelled:
            par.gather_left -= 1
            if par.gather_left == 0:
                par.results = []
                self.wake(par)

    def mem(self, act: Act, tmpl: Act, spec: Tuple[float, float, Optional[float], int], t0: float, t1: float) -> None:
        mb, pyf, life, every = spec
        self.mem_counts[id(tmpl)] += 1
        if self.mem_counts[id(tmpl)] % every:
            return
        size = mb * every * (1.0 + self.rng.uniform(-0.1, 0.1))
        tm = (t0 + t1) / 2.0
        self.p.mem_events.append(MemEvent(tm, size, act.key, pyf, self.p._ep(), act))
        if life is not None:
            self.p.mem_events.append(MemEvent(tm + life, -size, act.key, pyf, None, act))

    def step(self, task: SimTask) -> None:
        val: Any = None
        while True:
            try:
                cmd = task.gen.send(val)
            except StopIteration as stop:
                task.result = stop.value
                self.finish(task)
                return
            val = None
            kind = cmd[0]
            if kind == "cpu":
                tmpl, dur = cmd[1], cmd[2]
                act = self.act_for(task, tmpl)
                t0 = self.t
                self.t = self.p.run(self.tid, self.t, dur, act)
                if len(cmd) > 3 and cmd[3]:
                    self.mem(act, tmpl, cmd[3], t0, self.t)
            elif kind == "now":
                val = self.t
            elif kind == "spawn":
                val = self.create(cmd[1], cmd[2])
            elif kind == "cancel":
                for x in cmd[1]:
                    self.cancel(x)
            elif kind == "await":
                self.suspend_for(task, cmd[1])
                return
            elif kind == "park":
                self.park(task)
                return
            elif kind == "gather":
                kids = [self.create(f) for f in cmd[1]]
                task.gather_left = len(kids)
                for kid in kids:
                    kid.parent = task
                self.park(task)
                return
            else:
                raise ValueError(kind)

    def run(self, main_task: SimTask) -> None:
        while not main_task.done:
            if self.ready:
                task = self.ready.popleft()
                if task.cancelled or task.done:
                    continue
                self.step(task)
                self.t = self.p.run(self.tid, self.t, ms(jit(self.rng, 0.011, 0.4)), self.busy)
            elif self.timers:
                tn, _, task = heapq.heappop(self.timers)
                if task.cancelled:
                    continue
                if tn > self.t:
                    self.t = self.p.run(self.tid, self.t, tn - self.t, self.idle)
                self.ready.append(task)
            else:
                raise RuntimeError("event loop deadlock")


class Pool:
    def __init__(self, loop: EventLoop, size: int):
        self.loop = loop
        self.free = size
        self.waiters: deque = deque()

    def acquire(self, task: SimTask):
        if self.free > 0:
            self.free -= 1
            return
        self.waiters.append(task)
        yield ("park",)

    def release(self) -> None:
        while self.waiters:
            nxt = self.waiters.popleft()
            if not nxt.cancelled:
                self.loop.wake(nxt)
                return
        self.free += 1


def build_async() -> Dict[str, Any]:
    root = "/srv/catalog-api"
    B = f"{root}/bench_server.py"
    H = f"{root}/catalog/handlers.py"
    D = f"{root}/catalog/db.py"
    C = f"{root}/catalog/cache.py"
    R = f"{root}/catalog/render.py"
    VENV2 = f"{root}/.venv/lib/python3.12/site-packages"
    ORJSON = f"{VENV2}/orjson/orjson.cpython-312-x86_64-linux-gnu.so"
    ASYNCPG = f"{VENV2}/asyncpg/protocol/protocol.cpython-312-x86_64-linux-gnu.so"
    AIOHTTP = f"{VENV2}/aiohttp/_http_parser.cpython-312-x86_64-linux-gnu.so"
    HIREDIS = f"{VENV2}/hiredis/hiredis.cpython-312-x86_64-linux-gnu.so"
    MULTIDICT = f"{VENV2}/multidict/_multidict.cpython-312-x86_64-linux-gnu.so"
    MAIN = 140093411968832
    p = Prog(
        "async-server",
        program=B,
        entrypoint_dir=root,
        program_path=root,
        args=[B, "--clients", "12", "--duration", "15"],
        start_time_absolute=epoch(2026, 10, 26, 9, 41, 3.882107),
        start_time_perf=1093822.120943,
        main_tid=MAIN,
        memory=True,
        gpu=False,
        gpu_device="",
        async_profile=True,
        n_cpus=8,
    )
    rng = random.Random("async-schedule")
    for path, rel in [(B, "async/bench_server.py"), (H, "async/catalog/handlers.py"), (D, "async/catalog/db.py"),
                      (C, "async/catalog/cache.py"), (R, "async/catalog/render.py")]:
        p.add_source(path, read_src(rel))
    L = p.L

    memo: Dict[Tuple[str, str, Optional[str], Optional[int]], int] = {}

    def ln(path: str, needle: str, func: Optional[str] = None, nth: Optional[int] = None) -> int:
        k = (path, needle, func, nth)
        if k not in memo:
            memo[k] = L(path, needle, func=func, nth=nth)[1]
        return memo[k]

    def T(pyf: float = 0.9, util: float = 0.98, native: Optional[List[Tuple[float, NativeTail]]] = None) -> Act:
        return Act(None, pyf=pyf, util=util, native=native or [(1.0, ())])

    # ---- native tails -----------------------------------------------------------
    epoll = nat(("select_epoll_poll_impl", M.select), ("epoll_wait", M.libc))
    pbkdf2 = nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", M.py), ("_hashlib_pbkdf2_hmac_impl", M.hashlib),
                 ("PKCS5_PBKDF2_HMAC", M.crypto), ("EVP_KDF_derive", M.crypto), ("kdf_pbkdf2_derive", M.crypto),
                 ("HMAC_Final", M.crypto), ("EVP_DigestFinal_ex", M.crypto), ("sha256_block_data_order_avx2", M.crypto))
    orjson_t = nat(("dumps", ORJSON),
                   ("<orjson::serialize::serializer::PyObjectSerializer as serde::ser::Serialize>::serialize", ORJSON),
                   ("<orjson::serialize::per_type::dict::Dict as serde::ser::Serialize>::serialize", ORJSON),
                   ("orjson::serialize::writer::byteswriter::BytesWriter::grow", ORJSON))
    pg_decode = nat(("__pyx_f_7asyncpg_8protocol_8protocol_12BaseProtocol__on_result", ASYNCPG),
                    ("__pyx_f_7asyncpg_8protocol_8protocol_17DataCodecConfig_decode_row", ASYNCPG),
                    ("__pyx_f_7asyncpg_7pgproto_7pgproto_text_decode", ASYNCPG), ("PyUnicode_DecodeUTF8", M.py))
    pg_send = nat(("__pyx_f_7asyncpg_8protocol_8protocol_12BaseProtocol__bind_execute", ASYNCPG),
                  ("__pyx_f_7asyncpg_8protocol_8protocol_17CoreProtocol__write", ASYNCPG), ("sock_sendmsg", M.py), ("send", M.libc))
    http_parse = nat(("__pyx_pw_7aiohttp_12_http_parser_10HttpParser_7feed_data", AIOHTTP), ("llhttp_execute", AIOHTTP),
                     ("llhttp__internal_execute", AIOHTTP))
    http_send = nat(("multidict_add", MULTIDICT), ("pair_list_add", MULTIDICT))
    redis_parse = nat(("Reader_gets", HIREDIS), ("redisReaderGetReply", HIREDIS), ("processItem", HIREDIS))
    sock_send = nat(("sock_send_impl", M.py), ("send", M.libc))
    pickle_dumps = nat(("_pickle_dumps", M.pickle), ("dump", M.pickle), ("save", M.pickle), ("save_dict", M.pickle), ("batch_dict_exact", M.pickle))
    pickle_loads = nat(("_pickle_loads", M.pickle), ("load", M.pickle), ("load_binunicode", M.pickle), ("PyUnicode_DecodeUTF8Stateful", M.py))
    escape = nat(("method_vectorcall_FASTCALL", M.py), ("unicode_replace", M.py), ("replace", M.py), ("ucs1lib_find_char", M.py))
    task_step = nat(("task_wakeup", M.asyncio), ("task_step", M.asyncio), ("task_step_impl", M.asyncio))
    urandom = nat(("os_urandom", M.py), ("_PyOS_URandom", M.py), ("getrandom", M.libc))

    def mix(*items: Tuple[float, NativeTail]) -> List[Tuple[float, NativeTail]]:
        return list(items)

    idle = Act(L(B, "asyncio.run(main(parser.parse_args()))"), pyf=0.3, util=0.05, idle_loop=True,
               native=mix((0.8, epoll), (0.2, epoll[:1])))
    busy = Act(idle.key, pyf=0.6, util=0.97, native=mix((0.45, task_step), (0.2, task_step[:2]), (0.1, gc_pass()), (0.25, ())))
    run_key = idle.key

    # ---- module import time (synchronous, before the loop starts) -------------------
    p.call(C, "<module>", L(B, "from catalog.cache import ResponseCache"))
    p.call(D, "<module>", L(B, "from catalog.db import Database"))
    p.call(H, "<module>", L(B, "from catalog.handlers import CatalogService"))
    p.call(R, "<module>", L(H, "from catalog.render import render_product"))
    imp = lambda key, pyf=0.7: Act(key, pyf=pyf, util=0.93, native=mix(  # noqa: E731
        (0.5, ()), (0.3, nat(("_imp_create_dynamic", M.py), ("_PyImport_LoadDynamicModuleWithSpec", M.py), ("dlopen@@GLIBC_2.34", M.libc),
                             ("_dl_open", M.ld), ("_dl_relocate_object", M.ld))), (0.2, gc_pass())))
    a_asyncio = imp(L(B, "import asyncio"), 0.95)
    a_stats = imp(L(B, "import statistics"), 0.95)
    a_redis = imp(L(C, "import redis.asyncio as redis"), 0.9)
    a_pg = imp(L(D, "import asyncpg"), 0.6)
    a_aiohttp = imp(L(H, "import aiohttp"), 0.75)
    a_orjson = imp(L(R, "import orjson"), 0.2)
    a_parse = Act(L(B, "asyncio.run(main(parser.parse_args()))"), pyf=0.97, util=0.99)
    t = 0.0031
    t = p.seq(MAIN, t, [(a_asyncio, 0.034), (a_stats, 0.006), (a_redis, 0.081), (a_pg, 0.052), (a_aiohttp, 0.118),
                        (a_orjson, 0.004), (a_parse, 0.0012)])
    for act, mb, pyf in ((a_asyncio, 2.1, 0.97), (a_stats, 0.4, 0.98), (a_redis, 7.9, 0.94), (a_pg, 5.6, 0.62),
                         (a_aiohttp, 11.8, 0.81), (a_orjson, 0.6, 0.08)):
        p.mem_hold(act, mb, pyf, chunks=3)

    loop = EventLoop(p, MAIN, t, rng, run_key, idle, busy)
    pool = Pool(loop, 8)
    U = rng.uniform

    def push(task: SimTask, path: str, co_name: str) -> int:
        task.frames.append([path, 0, co_name])
        return len(task.frames) - 1

    def pop(task: SimTask) -> None:
        task.frames.pop()

    def at(task: SimTask, idx: int, line: int) -> None:
        task.frames[idx][1] = line

    def cpu(task: SimTask, idx: int, line: int, tmpl: Act, dur_ms: float, mem: Any = None):
        at(task, idx, line)
        return ("cpu", tmpl, ms(jit(rng, dur_ms, 0.3)), mem)

    # templates
    t_py = T(0.97, 0.99)
    t_pbkdf2 = T(0.01, 0.99, mix((0.86, pbkdf2), (0.1, pbkdf2[:-1]), (0.04, ())))
    t_pg_wait = T(0.35, 0.92, mix((0.45, pg_decode), (0.25, pg_send), (0.3, ())))
    t_pg_decode = T(0.2, 0.97, mix((0.75, pg_decode), (0.1, pg_decode[:2]), (0.15, ())))
    t_http = T(0.55, 0.95, mix((0.3, http_parse), (0.2, http_send), (0.2, sock_send), (0.3, ())))
    t_redis = T(0.5, 0.95, mix((0.45, redis_parse), (0.25, sock_send), (0.3, ())))
    t_pickle_l = T(0.15, 0.98, mix((0.8, pickle_loads), (0.2, ())))
    t_pickle_d = T(0.2, 0.97, mix((0.5, pickle_dumps), (0.25, sock_send), (0.25, ())))
    t_orjson = T(0.08, 0.99, mix((0.85, orjson_t), (0.15, orjson_t[:2])))
    t_escape = T(0.35, 0.99, mix((0.7, escape), (0.3, ())))
    t_dict = T(0.6, 0.99, mix((0.6, ()), (0.4, nat(("dict_new", M.py), ("dict_merge", M.py), ("insertdict", M.py)))))
    t_rand = T(0.4, 0.98, mix((0.7, urandom), (0.3, ())))
    t_print = T(0.6, 0.9, mix((0.5, nat(("_io_TextIOWrapper_write", M.py), ("_Py_write", M.py), ("write", M.libc))), (0.5, ())))
    t_sort = T(0.25, 0.99, mix((0.6, nat(("list_sort_impl", M.py), ("count_run", M.py), ("unsafe_float_compare", M.py))), (0.4, ())))
    t_connect = T(0.3, 0.6, mix((0.4, nat(("__pyx_f_7asyncpg_8protocol_8protocol_12CoreProtocol__auth_password_message_sasl_continue", ASYNCPG),
                                         ("PKCS5_PBKDF2_HMAC", M.crypto), ("sha256_block_data_order_avx2", M.crypto))),
                               (0.3, nat(("SSL_do_handshake", "/usr/lib/x86_64-linux-gnu/libssl.so.3"), ("ossl_statem_connect", "/usr/lib/x86_64-linux-gnu/libssl.so.3"),
                                         ("tls_process_server_certificate", "/usr/lib/x86_64-linux-gnu/libssl.so.3"), ("X509_verify_cert", M.crypto))),
                               (0.3, ())))

    # ---- coroutine bodies ---------------------------------------------------------------
    def acquire(task: SimTask, idx: int, line: int):
        yield cpu(task, idx, line, t_pg_wait, 0.015)
        yield from pool.acquire(task)

    def release(task: SimTask, idx: int, line: int):
        yield cpu(task, idx, line, t_pg_wait, 0.012)
        pool.release()

    def remember(task: SimTask, mem_mb: float = 0.0):
        i = push(task, C, "_remember")
        yield cpu(task, i, ln(C, "self.local[key] = value"), t_dict, 0.0012,
                  (mem_mb, 0.95, U(0.6, 3.0), 4) if mem_mb else None)
        yield cpu(task, i, ln(C, "self.local.move_to_end(key)", func="ResponseCache._remember"), t_py, 0.0006)
        yield cpu(task, i, ln(C, "while len(self.local) > self.local_size:"), t_py, 0.0005)
        yield cpu(task, i, ln(C, "self.local.popitem(last=False)"), t_py, 0.0004)
        pop(task)

    def cache_get(task: SimTask, p_local: float, p_redis: float, size_kb: float):
        i = push(task, C, "get")
        yield cpu(task, i, ln(C, "if key in self.local:"), t_py, 0.0015)
        if rng.random() < p_local:
            yield cpu(task, i, ln(C, "self.local.move_to_end(key)", func="ResponseCache.get"), t_py, 0.0008)
            yield cpu(task, i, ln(C, "return self.local[key]"), t_py, 0.0004)
            pop(task)
            return True
        l_get = ln(C, "raw = await self.client.get(key)")
        yield cpu(task, i, l_get, t_redis, 0.024)
        yield ("await", ms(U(0.35, 1.4)))
        yield cpu(task, i, l_get, t_redis, 0.035, (size_kb / 1024.0, 0.9, U(0.0005, 0.003), 8))
        if rng.random() >= p_redis:
            yield cpu(task, i, ln(C, "self.misses += 1"), t_py, 0.0004)
            pop(task)
            return False
        yield cpu(task, i, ln(C, "value = pickle.loads(raw)"), t_pickle_l, 0.012 + size_kb * 0.0016,
                  (size_kb / 1024.0, 0.97, U(0.5, 4.0), 8))
        yield cpu(task, i, ln(C, "self._remember(key, value)", func="ResponseCache.get"), t_py, 0.0006)
        yield from remember(task)
        yield cpu(task, i, ln(C, "self.hits += 1", func="ResponseCache.get", nth=1), t_py, 0.0004)
        pop(task)
        return True

    def cache_set(task: SimTask, size_kb: float):
        i = push(task, C, "set")
        yield cpu(task, i, ln(C, "self._remember(key, value)", func="ResponseCache.set"), t_py, 0.0006)
        yield from remember(task, size_kb / 1024.0)
        l_set = ln(C, "await self.client.set(key, pickle.dumps(value), ex=self.ttl)")
        yield cpu(task, i, l_set, t_pickle_d, 0.014 + size_kb * 0.0014, (size_kb / 1024.0 * 1.05, 0.97, 0.0004, 8))
        yield ("await", ms(U(0.35, 1.3)))
        yield cpu(task, i, l_set, t_redis, 0.02)
        pop(task)

    def verify_token(task: SimTask):
        i = push(task, H, "verify_token")
        yield cpu(task, i, ln(H, "user = self._tokens.get(token)"), t_py, 0.0012)
        yield cpu(task, i, ln(H, "if user is None:"), t_py, 0.0003)
        yield cpu(task, i, ln(H, "digest = hashlib.pbkdf2_hmac("), t_pbkdf2, 0.62)
        yield cpu(task, i, ln(H, "if not hmac.compare_digest(digest[:4], digest[:4]):"), t_py, 0.0018)
        yield cpu(task, i, ln(H, "return user"), t_py, 0.0004)
        pop(task)

    def log(task: SimTask):
        i = push(task, H, "_log")
        yield cpu(task, i, ln(H, "self._request_log.append("), t_dict, 0.0024, (0.00025, 1.0, None, 64))
        yield cpu(task, i, ln(H, "self.requests += 1"), t_py, 0.0004)
        pop(task)

    def fetch_product(task: SimTask):
        i = push(task, D, "fetch_product")
        l_acq = ln(D, "async with self.pool.acquire() as conn:", func="Database.fetch_product")
        yield from acquire(task, i, l_acq)
        l_row = ln(D, "row = await conn.fetchrow(")
        yield cpu(task, i, l_row, t_pg_wait, 0.028)
        yield ("await", ms(U(1.8, 6.5)))
        yield cpu(task, i, l_row, t_pg_decode, 0.045, (0.0021, 0.35, U(0.001, 0.004), 32))
        yield from release(task, i, l_acq)
        yield cpu(task, i, ln(D, "self.queries += 1", func="Database.fetch_product"), t_py, 0.0004)
        yield cpu(task, i, ln(D, "return dict(row) if row is not None else None"), t_dict, 0.004, (0.0011, 1.0, U(0.002, 0.02), 32))
        pop(task)
        return rng.random() > 0.02

    def fetch_many(task: SimTask):
        i = push(task, D, "fetch_many")
        l_acq = ln(D, "async with self.pool.acquire() as conn:", func="Database.fetch_many")
        yield from acquire(task, i, l_acq)
        l_rows = ln(D, "rows = await conn.fetch(", func="Database.fetch_many")
        yield cpu(task, i, l_rows, t_pg_wait, 0.03)
        yield ("await", ms(U(2.2, 7.0)))
        yield cpu(task, i, l_rows, t_pg_decode, 0.07, (0.008, 0.35, U(0.001, 0.004), 16))
        yield from release(task, i, l_acq)
        yield cpu(task, i, ln(D, "self.queries += 1", func="Database.fetch_many"), t_py, 0.0004)
        yield cpu(task, i, ln(D, "return [dict(r) for r in rows]", func="Database.fetch_many"), t_dict, 0.012)
        pop(task)

    def search_products(task: SimTask):
        i = push(task, D, "search_products")
        yield cpu(task, i, ln(D, "sql = ("), t_py, 0.0015)
        l_acq = ln(D, "async with self.pool.acquire() as conn:", func="Database.search_products")
        yield from acquire(task, i, l_acq)
        l_rows = ln(D, "rows = await conn.fetch(sql, query, limit)")
        yield cpu(task, i, l_rows, t_pg_wait, 0.05)
        yield ("await", ms(U(11.0, 34.0)))
        yield cpu(task, i, l_rows, t_pg_decode, 0.31, (0.072, 0.3, U(0.002, 0.006), 2))
        yield from release(task, i, l_acq)
        yield cpu(task, i, ln(D, "self.queries += 1", func="Database.search_products"), t_py, 0.0004)
        yield cpu(task, i, ln(D, "return [dict(r) for r in rows]", func="Database.search_products"), t_dict, 0.07,
                  (0.046, 1.0, U(0.004, 0.02), 2))
        pop(task)

    def insert_order(task: SimTask):
        i = push(task, D, "insert_order")
        l_acq = ln(D, "async with self.pool.acquire() as conn:", func="Database.insert_order")
        yield from acquire(task, i, l_acq)
        l_tx = ln(D, "async with conn.transaction():")
        yield cpu(task, i, l_tx, t_pg_wait, 0.02)
        yield ("await", ms(U(0.4, 1.2)))
        l_val = ln(D, "order_id = await conn.fetchval(")
        yield cpu(task, i, l_val, t_pg_wait, 0.03)
        yield ("await", ms(U(1.2, 3.4)))
        yield cpu(task, i, l_val, t_pg_decode, 0.02)
        l_many = ln(D, "await conn.executemany(")
        yield cpu(task, i, l_many, t_pg_wait, 0.045)
        yield ("await", ms(U(1.6, 5.5)))
        yield cpu(task, i, l_many, t_pg_wait, 0.02)
        yield cpu(task, i, l_tx, t_pg_wait, 0.01)
        yield ("await", ms(U(0.9, 2.6)))
        yield from release(task, i, l_acq)
        yield cpu(task, i, ln(D, "self.queries += 2"), t_py, 0.0004)
        pop(task)

    def quote_price(task: SimTask, n: int):
        i = push(task, H, "quote_price")
        yield cpu(task, i, ln(H, "assert self.http is not None"), t_py, 0.0003)
        l_post = ln(H, "async with self.http.post(PRICING_URL")
        yield cpu(task, i, l_post, t_http, 0.13 + 0.002 * n, (0.0035, 0.8, 0.0006, 16))
        yield ("await", ms(U(7.5, 24.0)))
        yield cpu(task, i, l_post, t_http, 0.055)
        l_json = ln(H, "payload = await resp.json()")
        yield cpu(task, i, l_json, t_http, 0.01)
        yield ("await", ms(U(0.1, 0.8)))
        yield cpu(task, i, l_json, t_http, 0.03 + 0.001 * n, (0.003 + 0.0001 * n, 0.95, U(0.0002, 0.001), 16))
        yield cpu(task, i, l_post, t_http, 0.018)
        yield cpu(task, i, ln(H, "return {int(k): float(v) for k, v in payload"), t_py, 0.003 + 0.0006 * n)
        pop(task)

    def money(task: SimTask):
        i = push(task, R, "_money")
        yield cpu(task, i, ln(R, 'return f"{value:,.2f} {CURRENCY}"'), t_py, 0.0014)
        pop(task)

    def render_product(task: SimTask):
        i = push(task, R, "render_product")
        yield cpu(task, i, ln(R, '"in_stock": int(row["stock"]) > 0,'), t_py, 0.0012)
        yield cpu(task, i, ln(R, '"price": {"amount": round(price, 2)'), t_py, 0.002)
        yield from money(task)
        yield cpu(task, i, ln(R, '"images": [row["image_url"]'), t_escape, 0.0016)
        yield cpu(task, i, ln(R, "return orjson.dumps(doc, option=orjson.OPT_NON_STR_KEYS)"), t_orjson, 0.011,
                  (0.0014, 0.0, U(0.5, 3.0), 64))
        pop(task)

    def card(task: SimTask):
        i = push(task, R, "_card")
        yield cpu(task, i, ln(R, 'title = html.escape(str(row["title"]))'), t_escape, 0.0035)
        yield cpu(task, i, ln(R, 'desc = html.escape(str(row["description"])[:180])'), t_escape, 0.0048)
        yield cpu(task, i, ln(R, "return (", func="_card"), t_py, 0.0042)
        j = push(task, R, "_stars")
        yield cpu(task, j, ln(R, "full = int(rating)"), t_py, 0.0004)
        yield cpu(task, j, ln(R, "half = 1 if rating - full >= 0.5 else 0"), t_py, 0.0003)
        yield cpu(task, j, ln(R, 'return "&#9733;" * full'), t_py, 0.0009)
        pop(task)
        yield cpu(task, i, ln(R, "f'<span class=\"price\">{_money(price)}</span>'"), t_py, 0.0006)
        yield from money(task)
        pop(task)

    def render_search(task: SimTask, nrows: int):
        i = push(task, R, "render_search_page")
        yield cpu(task, i, ln(R, "parts = ["), t_escape, 0.004)
        l_for = ln(R, "for row in rows:")
        l_app = ln(R, 'parts.append(_card(row, prices.get(int(row["id"]), 0.0)))')
        for _ in range(nrows):
            yield cpu(task, i, l_for, t_py, 0.0004)
            yield cpu(task, i, l_app, t_py, 0.0016)
            yield from card(task)
        yield cpu(task, i, ln(R, 'parts.append("</ul></body></html>")'), t_py, 0.0004)
        yield cpu(task, i, ln(R, 'return "".join(parts).encode("utf-8")'), t_py, 0.028, (0.061, 0.0, U(0.3, 2.0), 4))
        pop(task)

    def get_product(task: SimTask):
        i = push(task, H, "get_product")
        yield cpu(task, i, ln(H, "started = time.perf_counter()", func="CatalogService.get_product"), t_py, 0.0006)
        at(task, i, ln(H, "await self.verify_token(token)", func="CatalogService.get_product"))
        yield from verify_token(task)
        at(task, i, ln(H, 'cached = await self.cache.get(f"product:{product_id}")'))
        hit = yield from cache_get(task, 0.004, 0.38, 1.4)
        if hit:
            at(task, i, ln(H, 'self._log("product", started)', nth=0))
            yield from log(task)
            yield cpu(task, i, ln(H, "return cached", func="CatalogService.get_product"), t_py, 0.0003)
            pop(task)
            return
        at(task, i, ln(H, "row = await self.db.fetch_product(product_id)"))
        found = yield from fetch_product(task)
        if not found:
            yield cpu(task, i, ln(H, 'return b\'{"error": "not found"}\''), t_py, 0.0004)
            pop(task)
            return
        at(task, i, ln(H, "price = await self.quote_price([product_id])"))
        yield from quote_price(task, 1)
        at(task, i, ln(H, "body = render_product(row, price[product_id])"))
        yield from render_product(task)
        at(task, i, ln(H, 'await self.cache.set(f"product:{product_id}", body)'))
        yield from cache_set(task, 1.4)
        at(task, i, ln(H, 'self._log("product", started)', nth=1))
        yield from log(task)
        pop(task)

    def search(task: SimTask):
        i = push(task, H, "search")
        yield cpu(task, i, ln(H, "started = time.perf_counter()", func="CatalogService.search"), t_py, 0.0006)
        at(task, i, ln(H, "await self.verify_token(token)", func="CatalogService.search"))
        yield from verify_token(task)
        yield cpu(task, i, ln(H, 'key = f"search:{query}:{limit}"'), t_py, 0.0008)
        at(task, i, ln(H, "cached = await self.cache.get(key)"))
        hit = yield from cache_get(task, 0.3, 0.55, 58.0)
        if hit:
            at(task, i, ln(H, 'self._log("search", started)', nth=0))
            yield from log(task)
            pop(task)
            return
        at(task, i, ln(H, "rows = await self.db.search_products(query, limit=limit)"))
        yield from search_products(task)
        yield cpu(task, i, ln(H, 'ids = [r["id"] for r in rows]'), t_py, 0.004)
        at(task, i, ln(H, "prices = await self.quote_price(ids)"))
        yield from quote_price(task, 40)
        at(task, i, ln(H, "body = render_search_page(query, rows, prices)"))
        yield from render_search(task, 40)
        at(task, i, ln(H, "await self.cache.set(key, body)"))
        yield from cache_set(task, 58.0)
        at(task, i, ln(H, 'self._log("search", started)', nth=1))
        yield from log(task)
        pop(task)

    def child_fetch_many(task: SimTask):
        yield from fetch_many(task)

    def child_quote(n: int):
        def gen(task: SimTask):
            yield from quote_price(task, n)
        return gen

    def checkout(task: SimTask):
        i = push(task, H, "checkout")
        yield cpu(task, i, ln(H, "started = time.perf_counter()", func="CatalogService.checkout"), t_py, 0.0006)
        at(task, i, ln(H, "user = await self.verify_token(token)"))
        yield from verify_token(task)
        n = rng.randint(1, 6)
        yield cpu(task, i, ln(H, "rows, prices = await asyncio.gather("), t_py, 0.024)
        yield ("gather", [child_fetch_many, child_quote(n)])
        yield cpu(task, i, ln(H, 'total = sum(prices.get(r["id"], 0.0) for r in rows)'), t_py, 0.003)
        at(task, i, ln(H, "order_id = await self.db.insert_order(user, cart, total)"))
        yield from insert_order(task)
        at(task, i, ln(H, 'self._log("checkout", started)'))
        yield from log(task)
        yield cpu(task, i, ln(H, 'return {"order_id": order_id'), t_dict, 0.002)
        pop(task)

    def issue_token(task: SimTask):
        i = push(task, H, "issue_token")
        yield cpu(task, i, ln(H, "nonce = secrets.token_hex(8)"), t_rand, 0.006)
        yield cpu(task, i, ln(H, "self._tokens[token] = user"), t_py, 0.0006)
        pop(task)

    def pick_route_sync(task: SimTask):
        i = push(task, B, "pick_route")
        yield cpu(task, i, ln(B, "x = rng.random()"), t_py, 0.0005)
        yield cpu(task, i, ln(B, "acc += weight"), t_py, 0.0006)
        yield cpu(task, i, ln(B, "if x < acc:"), t_py, 0.0005)
        pop(task)

    deadline = [0.0]

    def client(cid: int):
        def gen(task: SimTask):
            i = push(task, B, "client")
            yield cpu(task, i, ln(B, "rng = random.Random(client_id)"), t_py, 0.012)
            at(task, i, ln(B, 'token = service.issue_token(f"user-{client_id}")'))
            yield from issue_token(task)
            l_while = ln(B, "while time.monotonic() < deadline:")
            crng = random.Random(f"client-{cid}")
            while True:
                yield cpu(task, i, l_while, t_py, 0.0007)
                now = yield ("now",)
                if now >= deadline[0]:
                    break
                at(task, i, ln(B, "route = pick_route(rng)"))
                yield from pick_route_sync(task)
                yield cpu(task, i, ln(B, "started = time.perf_counter()", func="client"), t_py, 0.0005)
                x = crng.random()
                if x < 0.60:
                    yield cpu(task, i, ln(B, "await service.get_product(rng.randint(1, 50_000), token)"), t_py, 0.0018)
                    yield from get_product(task)
                elif x < 0.85:
                    yield cpu(task, i, ln(B, "await service.search(rng.choice(QUERIES), token)"), t_py, 0.0012)
                    yield from search(task)
                else:
                    yield cpu(task, i, ln(B, "cart = [rng.randint(1, 50_000)"), t_py, 0.004)
                    at(task, i, ln(B, "await service.checkout(cart, token)"))
                    yield from checkout(task)
                yield cpu(task, i, ln(B, "latencies[route].append("), t_py, 0.0012, (0.00002, 1.0, None, 512))
                yield cpu(task, i, ln(B, "sent += 1"), t_py, 0.0003)
                l_sleep = ln(B, "await asyncio.sleep(rng.uniform(0.005, 0.025))")
                yield cpu(task, i, l_sleep, t_py, 0.003)
                yield ("await", ms(crng.uniform(5.0, 25.0)))
            yield cpu(task, i, ln(B, "return sent"), t_py, 0.0003)
            pop(task)
        return gen

    def refresher(task: SimTask):
        i = push(task, C, "refresh_hot_keys")
        l_ids = ln(C, "ids = await db.hot_product_ids()")
        while True:
            at(task, i, l_ids)
            j = push(task, D, "hot_product_ids")
            l_acq = ln(D, "async with self.pool.acquire() as conn:", func="Database.hot_product_ids")
            yield from acquire(task, j, l_acq)
            l_rows = ln(D, "rows = await conn.fetch(", func="Database.hot_product_ids")
            yield cpu(task, j, l_rows, t_pg_wait, 0.03)
            yield ("await", ms(U(3.0, 6.0)))
            yield cpu(task, j, l_rows, t_pg_decode, 0.085)
            yield from release(task, j, l_acq)
            yield cpu(task, j, ln(D, 'return [r["product_id"] for r in rows]'), t_py, 0.02)
            pop(task)
            for _ in range(200):
                yield cpu(task, i, ln(C, "for product_id in ids:"), t_py, 0.0003)
                yield cpu(task, i, ln(C, 'if f"product:{product_id}" not in self.local:'), t_py, 0.0011)
                if rng.random() < 0.7:
                    at(task, i, ln(C, "row = await db.fetch_product(product_id)"))
                    found = yield from fetch_product(task)
                    if found:
                        yield cpu(task, i, ln(C, 'self._remember(f"product:{product_id}", row)'), t_py, 0.0006)
                        yield from remember(task, 0.0011)
            at(task, i, ln(C, "await asyncio.sleep(every)"))
            yield cpu(task, i, ln(C, "await asyncio.sleep(every)"), t_py, 0.004)
            yield ("await", 2.0)

    def flusher(task: SimTask):
        i = push(task, H, "flush_metrics")
        while True:
            yield cpu(task, i, ln(H, "await asyncio.sleep(every)"), t_py, 0.004)
            yield ("await", 1.0)
            yield cpu(task, i, ln(H, "window = self._request_log[-500:]"), t_py, 0.006, (0.004, 1.0, 0.001, 1))
            yield cpu(task, i, ln(H, 'mean_ms = sum(r["dt"] for r in window)'), t_py, 0.06)
            yield cpu(task, i, ln(H, 'print(f"[metrics] requests='), t_print, 0.025)

    def connect(task: SimTask):
        i = push(task, D, "connect")
        l_pool = ln(D, "pool = await asyncpg.create_pool(")
        yield cpu(task, i, l_pool, t_connect, 3.6)
        yield ("await", 0.142)
        yield cpu(task, i, l_pool, t_connect, 2.1, (4.2, 0.35, None, 1))
        yield ("await", 0.021)
        yield cpu(task, i, l_pool, t_pg_decode, 0.8)
        yield cpu(task, i, ln(D, "return cls(pool)"), t_py, 0.01)
        pop(task)

    def warm_up(task: SimTask):
        i = push(task, H, "warm_up")
        yield cpu(task, i, ln(H, "self.http = aiohttp.ClientSession("), t_http, 0.42, (0.8, 0.7, None, 1))
        at(task, i, ln(H, "categories = await self.db.fetch_categories()"))
        j = push(task, D, "fetch_categories")
        l_acq = ln(D, "async with self.pool.acquire() as conn:", func="Database.fetch_categories")
        yield from acquire(task, j, l_acq)
        l_rows = ln(D, 'rows = await conn.fetch("SELECT id, name, parent_id')
        yield cpu(task, j, l_rows, t_pg_wait, 0.04)
        yield ("await", ms(3.2))
        yield cpu(task, j, l_rows, t_pg_decode, 0.12, (0.06, 0.4, None, 1))
        yield from release(task, j, l_acq)
        yield cpu(task, j, ln(D, "return [dict(r) for r in rows]", func="Database.fetch_categories"), t_dict, 0.08, (0.03, 1.0, None, 1))
        pop(task)
        for _ in range(120):
            yield cpu(task, i, ln(H, "for category in categories:"), t_py, 0.0004)
            at(task, i, ln(H, "await self.cache.set(f\"category:{category['id']}\", category)"))
            yield from cache_set(task, 0.2)
        pop(task)

    def report_sync(task: SimTask):
        i = push(task, B, "report")
        yield cpu(task, i, ln(B, 'print(f"{total} requests in'), t_print, 0.03)
        for _ in range(3):
            yield cpu(task, i, ln(B, "for route, values in sorted(latencies.items()):"), t_py, 0.002)
            yield cpu(task, i, ln(B, "q = statistics.quantiles(values, n=100)"), t_sort, 3.4, (0.11, 0.9, 0.004, 1))
            yield cpu(task, i, ln(B, 'print(f"  {route:<22} n='), t_print, 0.02)
        pop(task)

    def main_coro(task: SimTask):
        i = push(task, B, "main")
        at(task, i, ln(B, "db = await Database.connect("))
        yield from connect(task)
        at(task, i, ln(B, "cache = ResponseCache(args.redis_url"))
        j = push(task, C, "__init__")
        yield cpu(task, j, ln(C, "self.client = redis.from_url(url, decode_responses=False)"), t_py, 0.4, (0.6, 0.9, None, 1))
        yield cpu(task, j, ln(C, 'self.local: "OrderedDict[str, Any]" = OrderedDict()'), t_py, 0.002)
        pop(task)
        at(task, i, ln(B, "service = CatalogService(db, cache)"))
        j = push(task, H, "__init__")
        yield cpu(task, j, ln(H, "self._secret = secrets.token_bytes(32)"), t_rand, 0.004)
        pop(task)
        at(task, i, ln(B, "await service.warm_up()"))
        yield from warm_up(task)
        yield cpu(task, i, ln(B, "refresher = asyncio.create_task("), t_py, 0.02)
        ref = yield ("spawn", refresher, "cache-refresher")
        yield cpu(task, i, ln(B, "flusher = asyncio.create_task("), t_py, 0.015)
        flu = yield ("spawn", flusher, "metrics-flusher")
        yield cpu(task, i, ln(B, "latencies: Dict[str, List[float]] = {route: []"), t_py, 0.002)
        now = yield ("now",)
        deadline[0] = now + 15.0
        yield cpu(task, i, ln(B, "deadline = time.monotonic() + args.duration"), t_py, 0.0008)
        yield cpu(task, i, ln(B, "counts = await asyncio.gather("), t_py, 0.05)
        yield ("gather", [client(c) for c in range(12)])
        yield cpu(task, i, ln(B, "elapsed = time.perf_counter() - started", func="main"), t_py, 0.0008)
        yield ("cancel", [ref, flu])
        yield cpu(task, i, ln(B, "refresher.cancel()"), t_py, 0.012)
        yield cpu(task, i, ln(B, "flusher.cancel()"), t_py, 0.009)
        j = push(task, D, "close")
        at(task, i, ln(B, "await db.close()"))
        yield cpu(task, j, ln(D, "await self.pool.close()"), t_pg_wait, 0.4)
        yield ("await", ms(11.8))
        yield cpu(task, j, ln(D, "await self.pool.close()"), t_pg_wait, 0.3)
        pop(task)
        at(task, i, ln(B, "report(latencies, elapsed, sum(counts))"))
        yield from report_sync(task)
        pop(task)

    main_task = loop.create(main_coro)
    loop.run(main_task)
    t = p.run(MAIN, loop.t, 0.0083, busy)  # asyncio.run teardown: shutdown_asyncgens, loop.close()
    p.elapsed = t + 0.0012
    return p.build()


# ---------------------------------------------------------------------------
# neuron.json: AWS Inferentia2 inference + merge_scalene_neuron_profiles.py
# ---------------------------------------------------------------------------


def calculate_cpu_sample_overlap(cpu_samples_list: List[float], nc_intervals: List[Tuple[float, float]],
                                 start_time_absolute: float, start_time_perf: float) -> Tuple[int, int, float]:
    """Verbatim logic of merge_scalene_neuron_profiles.calculate_cpu_sample_overlap."""
    if not cpu_samples_list or not nc_intervals:
        return 0, len(cpu_samples_list), 0.0
    overlap_count = 0
    total_count = len(cpu_samples_list)
    sorted_intervals = sorted(nc_intervals, key=lambda x: x[0])
    starts = [a for a, _ in sorted_intervals]
    import bisect as _b
    for cpu_sample_perf in cpu_samples_list:
        cpu_sample_absolute = start_time_absolute + (cpu_sample_perf - start_time_perf)
        # same predicate as the upstream linear scan, via bisect (intervals don't overlap)
        i = _b.bisect_right(starts, cpu_sample_absolute) - 1
        if i >= 0 and sorted_intervals[i][0] <= cpu_sample_absolute <= sorted_intervals[i][1]:
            overlap_count += 1
    overlap_percent = (overlap_count / total_count * 100) if total_count > 0 else 0.0
    return overlap_count, total_count, overlap_percent


def build_neuron() -> Dict[str, Any]:
    import json as _json

    root = "/home/ubuntu/neuron-bert"
    I = f"{root}/infer_bert.py"
    P = f"{root}/preprocess.py"
    MAIN = 140205373503296
    PID = 28411
    NEFF = "/var/tmp/neuron-cache/neuronxcc-2.15.128.0+56dc5a86/MODULE_7581902137744187612+d41d8cd9/model.neff"
    p = Prog(
        "neuron",
        program=I,
        entrypoint_dir=root,
        program_path=root,
        args=[I, "--batches", "1200", "--batch-size", "16"],
        start_time_absolute=epoch(2026, 10, 24, 18, 5, 44.270318),
        start_time_perf=73104.882553,
        main_tid=MAIN,
        memory=True,
        gpu=True,
        gpu_device="Neuron",
        n_cpus=32,
        stacks=False,  # run with --no-stacks
    )
    rng = random.Random("neuron-schedule")
    p.add_source(I, read_src("neuron/infer_bert.py"))
    p.add_source(P, read_src("neuron/preprocess.py"))
    L = p.L
    p.call(P, "<module>", L(I, "from preprocess import ReviewStream, encode_batch"))
    p.call(I, "main", L(I, "    main()"))
    p.call(I, "compile_model", L(I, "neuron_model = compile_model(model, tokenizer"))
    p.call(I, "softmax", L(I, "probs = softmax(logits.detach().numpy())"))
    p.call(P, "ReviewStream.__init__", L(I, 'stream = ReviewStream("data/reviews.jsonl"'))
    p.call(P, "ReviewStream.__next__", L(I, "texts = next(stream)"), 150)
    p.call(P, "ReviewStream.__next__", L(I, "warm = encode_batch(tokenizer, next(stream), SEQ_LEN)"), 1)
    p.call(P, "ReviewStream._read", L(P, "return [next(self._iter) for _ in range(self.batch_size)]"))
    p.call(P, "normalize", L(P, 'yield normalize(record["text"])'))
    p.call(P, "encode_batch", L(I, "enc = encode_batch(tokenizer, texts, SEQ_LEN)"), 150)
    p.call(P, "encode_batch", L(I, "warm = encode_batch(tokenizer, next(stream), SEQ_LEN)"), 1)

    def A(key: Key, pyf: float, util: float, gpu: float = 0.0, core: Optional[float] = None, pins: Optional[Dict] = None) -> Act:
        return Act(key, pyf=pyf, util=util, gpu=gpu, core=core, pins=pins)

    imp_np = A(L(I, "import numpy as np"), 0.6, 0.9)
    imp_torch = A(L(I, "import torch\n"), 0.45, 0.86, core=0.03)
    imp_nx = A(L(I, "import torch_neuronx"), 0.5, 0.74, core=0.025)
    imp_tf = A(L(I, "from transformers import AutoModelForSequenceClassification"), 0.88, 0.95)
    imp_pre = A(L(I, "from preprocess import ReviewStream, encode_batch"), 0.95, 0.98)
    pre_re = A(L(P, '_TAGS = re.compile(r"<[^>]+>")'), 0.8, 0.99)
    argp = A(L(I, "args = parser.parse_args()"), 0.97, 0.99)
    tok_load = A(L(I, "tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)"), 0.32, 0.8)
    model_load = A(L(I, "model = AutoModelForSequenceClassification.from_pretrained("), 0.18, 0.66, core=0.03)
    model_eval = A(L(I, "model.eval()"), 0.95, 0.99)
    exists = A(L(I, "if os.path.exists(path):"), 0.3, 0.6)
    jit_load = A(L(I, "return torch.jit.load(path)"), 0.06, 0.34, gpu=0.03, core=0.012)
    stream_init = A(L(I, 'stream = ReviewStream("data/reviews.jsonl"'), 0.95, 0.99)
    warm_loop = A(L(I, "for _ in range(8):"), 0.99, 0.99, gpu=0.25)
    loop_line = A(L(I, "for _ in range(args.batches):"), 0.99, 0.99, gpu=0.6)

    def stream_acts(gpu: float, pin: Key) -> Dict[str, Act]:
        pins = {(P, "ReviewStream.__next__"): pin}
        return {
            "next": A(L(P, "return [next(self._iter) for _ in range(self.batch_size)]"), 0.97, 0.99, gpu, pins=pins),
            "open": A(L(P, 'with open(self.path, encoding="utf-8") as f:'), 0.4, 0.7, gpu, pins=pins),
            "for": A(L(P, "for line in f:"), 0.55, 0.9, gpu, pins=pins),
            "loads": A(L(P, "record = json.loads(line)"), 0.35, 0.99, gpu, pins=pins),
            "lang": A(L(P, 'if record.get("lang", "en") != "en":'), 0.98, 0.99, gpu, pins=pins),
            "yield": A(L(P, 'yield normalize(record["text"])'), 0.97, 0.99, gpu, pins=pins),
            "tags": A(L(P, 'text = _TAGS.sub(" ", text)'), 0.25, 0.99, gpu, pins=pins),
            "nfkc": A(L(P, 'text = unicodedata.normalize("NFKC", text)'), 0.1, 0.99, gpu, pins=pins),
            "repl": A(L(P, 'text = text.replace("&amp;", "&")'), 0.5, 0.99, gpu, pins=pins),
            "spaces": A(L(P, 'return _SPACES.sub(" ", text).strip().lower()'), 0.3, 0.99, gpu, pins=pins),
        }

    warm_call = L(I, "warm = encode_batch(tokenizer, next(stream), SEQ_LEN)")
    loop_next = L(I, "texts = next(stream)")
    st_warm = stream_acts(0.25, warm_call)
    st_loop = stream_acts(0.6, loop_next)
    next_line = A(loop_next, 0.97, 0.99, 0.6)
    enc_warm = A(L(P, "enc = tokenizer("), 0.06, 0.97, 0.25, core=0.21, pins={(P, "encode_batch"): warm_call})
    enc_loop = A(L(P, "enc = tokenizer("), 0.06, 0.97, 0.6, core=0.21, pins={(P, "encode_batch"): L(I, "enc = encode_batch(tokenizer, texts, SEQ_LEN)")})
    enc_ret_w = A(L(P, 'return {"input_ids": enc["input_ids"]'), 0.9, 0.99, 0.25, pins={(P, "encode_batch"): warm_call})
    enc_ret_l = A(L(P, 'return {"input_ids": enc["input_ids"]'), 0.9, 0.99, 0.6, pins={(P, "encode_batch"): L(I, "enc = encode_batch(tokenizer, texts, SEQ_LEN)")})
    warm_exec = A(L(I, 'neuron_model(warm["input_ids"], warm["attention_mask"])'), 0.03, 0.13, gpu=0.3, core=0.005)
    infer = A(L(I, 'logits = neuron_model(enc["input_ids"], enc["attention_mask"])[0]'), 0.02, 0.14, gpu=0.62, core=0.005)
    sm_call = A(L(I, "probs = softmax(logits.detach().numpy())"), 0.6, 0.99, 0.6)
    sm_z = A(L(I, "z = logits - logits.max(axis=-1, keepdims=True)"), 0.3, 0.99, 0.6)
    sm_e = A(L(I, "e = np.exp(z)"), 0.3, 0.99, 0.6)
    sm_r = A(L(I, "return e / e.sum(axis=-1, keepdims=True)"), 0.3, 0.99, 0.6)
    pos_line = A(L(I, "positives += int((probs[:, 1] > 0.5).sum())"), 0.4, 0.99, 0.6)
    seen_line = A(L(I, "seen += len(texts)"), 0.99, 0.99, 0.6)
    final_print = A(L(I, 'print(f"{seen} reviews in'), 0.7, 0.9, 0.4)

    t = 0.0027
    t = p.seq(MAIN, t, [(imp_np, 0.16), (imp_torch, 2.05), (imp_nx, 1.62), (imp_tf, 2.41), (imp_pre, 0.0021), (pre_re, 0.0004),
                        (argp, 0.003), (tok_load, 0.41), (model_load, 1.32), (model_eval, 0.003), (exists, 0.0002)])
    t_load = t
    t = p.run(MAIN, t, 3.91, jit_load)
    p.gpu_alloc(t_load + 0.8, 412.0)   # runtime + NEFF instructions
    p.gpu_alloc(t_load + 3.2, 878.0)   # weights in HBM
    t = p.run(MAIN, t, 0.0004, stream_init)

    def read_batch(acts: Dict[str, Act], first: bool) -> float:
        nonlocal t
        if first:
            t = p.run(MAIN, t, ms(0.21), acts["open"])
        got = 0
        while got < 16:
            t = p.seq(MAIN, t, [(acts["for"], ms(jit(rng, 0.004))), (acts["loads"], ms(jit(rng, 0.018, 0.3))),
                                (acts["lang"], ms(0.0012))])
            if rng.random() < 0.07:
                continue
            t = p.seq(MAIN, t, [(acts["yield"], ms(0.0015)), (acts["tags"], ms(jit(rng, 0.011, 0.4))),
                                (acts["nfkc"], ms(jit(rng, 0.007, 0.4))), (acts["repl"], ms(0.0021)),
                                (acts["spaces"], ms(jit(rng, 0.014, 0.4))), (acts["next"], ms(0.0009))])
            got += 1
        return t

    nrt_windows: List[Tuple[float, float, Key]] = []
    for k in range(8):
        t = p.run(MAIN, t, ms(0.0006), warm_loop)
        read_batch(st_warm, first=(k == 0))
        t = p.seq(MAIN, t, [(enc_warm, ms(jit(rng, 2.9))), (enc_ret_w, ms(0.002))])
        d = ms(141.0) if k == 0 else ms(jit(rng, 8.3, 0.05))
        nrt_windows.append((t, t + d, warm_exec.key))
        t = p.run(MAIN, t, d, warm_exec)
    for k in range(1200):
        t = p.run(MAIN, t, ms(0.0005), loop_line)
        t = p.run(MAIN, t, ms(0.0011), next_line)
        read_batch(st_loop, first=False)
        t = p.seq(MAIN, t, [(enc_loop, ms(jit(rng, 2.6, 0.12))), (enc_ret_l, ms(0.002))])
        d = ms(jit(rng, 7.9, 0.06)) + (ms(rng.uniform(2.0, 9.0)) if rng.random() < 0.03 else 0.0)
        nrt_windows.append((t, t + d, infer.key))
        t = p.run(MAIN, t, d, infer)
        t = p.seq(MAIN, t, [(sm_call, ms(0.004)), (sm_z, ms(jit(rng, 0.006))), (sm_e, ms(jit(rng, 0.004))),
                            (sm_r, ms(jit(rng, 0.005))), (pos_line, ms(jit(rng, 0.009))), (seen_line, ms(0.0005))])
    t = p.run(MAIN, t, ms(0.06), final_print)
    p.elapsed = t + 0.0009

    # host memory
    for act, mb, pyf in ((imp_np, 19.2, 0.6), (imp_torch, 171.4, 0.4), (imp_nx, 58.3, 0.55), (imp_tf, 88.1, 0.86),
                         (tok_load, 21.2, 0.31), (model_load, 255.6, 0.02)):
        p.mem_hold(act, mb, pyf, chunks=6)
    p.mem_temp(jit_load, 118.5, 0.0, chunks=4)
    p.mem_hold(jit_load, 9.1, 0.1, chunks=1)
    p.mem_temp(enc_loop, 0.0313 * 8, 0.0, chunks=1, life=0.012, every=8)
    p.mem_temp(enc_warm, 0.0313, 0.0, chunks=1, life=0.012)
    p.mem_temp(st_loop["loads"], 0.0011 * 64, 1.0, chunks=1, life=0.002, every=64)
    p.mem_temp(st_loop["nfkc"], 0.0009 * 64, 1.0, chunks=1, life=0.002, every=64)
    p.mem_temp(sm_e, 0.00025 * 64, 0.0, chunks=1, life=0.001, every=64)

    prof = p.build()

    # ---- emulate merge_scalene_neuron_profiles.py ---------------------------------
    sd = _json.loads(_json.dumps(prof, sort_keys=True))  # it reads the sort_keys=True file back
    start_abs, start_perf = sd["start_time_absolute"], sd["start_time_perf"]
    nrt_events: List[Dict[str, Any]] = []
    nc_events: List[Dict[str, Any]] = []
    nc_intervals: List[Tuple[float, float]] = []
    exec_id = 3
    line_events: Dict[Key, List[Dict[str, Any]]] = {}
    line_nc: Dict[Key, List[Dict[str, Any]]] = {}
    for (t0, t1, key) in nrt_windows:
        ts = int(round((start_abs + t0) * 1e9))
        dur = int(round((t1 - t0) * 1e9))
        ev = {"name": "nrt_execute", "duration_ns": dur, "duration_ms": dur / 1000000, "timestamp": ts,
              "process_id": PID, "thread_id": PID}
        nc_ts = ts + int(rng.uniform(0.28, 0.42) * 1e6)
        nc_dur = dur - int(rng.uniform(0.75, 1.05) * 1e6) - (nc_ts - ts) // 4
        nev = {"name": "nc_exec_running", "duration_ns": nc_dur, "duration_ms": nc_dur / 1000000, "timestamp": nc_ts,
               "exec_id": exec_id, "process_id": PID, "thread_id": PID}
        exec_id += 1
        nrt_events.append(ev)
        nc_events.append(nev)
        nc_intervals.append((nc_ts / 1e9, (nc_ts + nc_dur) / 1e9))
        line_events.setdefault(key, []).append(ev)
        line_nc.setdefault(key, []).append(nev)
    total_neuron_time = sum(e["duration_ms"] for e in nrt_events)
    total_nc_time = sum(e["duration_ms"] for e in nc_events)
    tot_ov = tot_samples = 0
    for filename, file_data in sd["files"].items():
        for line_data in file_data["lines"]:
            lineno = line_data["lineno"]
            csl = line_data.get("cpu_samples_list", [])
            if csl and nc_intervals:
                ov, total, pct = calculate_cpu_sample_overlap(csl, nc_intervals, start_abs, start_perf)
                line_data["cpu_samples_nc_overlap_count"] = ov
                line_data["cpu_samples_total_count"] = total
                line_data["cpu_samples_nc_overlap_percent"] = pct
                tot_ov += ov
                tot_samples += total
            else:
                line_data["cpu_samples_nc_overlap_count"] = 0
                line_data["cpu_samples_total_count"] = len(csl)
                line_data["cpu_samples_nc_overlap_percent"] = 0.0
            key = (filename, lineno)
            if key in line_events:
                evs = line_events[key]
                ncs = line_nc.get(key, [])
                tms = sum(e["duration_ms"] for e in evs)
                ncms = sum(e["duration_ms"] for e in ncs)
                line_data["nrt_time_ms"] = tms
                line_data["nrt_percent"] = (tms / total_neuron_time) * 100 if total_neuron_time > 0 else 0
                line_data["nrt_execute_count"] = len(evs)
                line_data["nrt_events"] = evs
                line_data["nrt_source_code"] = NEFF
                line_data["nc_time_ms"] = ncms
                line_data["nc_percent"] = (ncms / total_nc_time) * 100 if total_nc_time > 0 else 0
                line_data["nc_execute_count"] = len(ncs)
                line_data["nc_events"] = ncs
                line_data["nc_nrt_ratio"] = ncms / tms if tms > 0 else 0
                line_data["neuron_time_ms"] = tms
    sd["neuron_total_time_ms"] = total_neuron_time
    sd["neuron_total_nc_time_ms"] = total_nc_time
    sd["neuron_event_count"] = len(nrt_events)
    sd["neuron_nc_event_count"] = len(nc_events)
    sd["cpu_samples_total_with_nc_overlap"] = tot_ov
    sd["cpu_samples_total"] = tot_samples
    sd["cpu_samples_nc_overlap_percent_overall"] = (tot_ov / tot_samples * 100) if tot_samples > 0 else 0.0
    return sd


# ---------------------------------------------------------------------------
# cpu-only.json: `scalene --cpu nbody.py 120 1500`
# ---------------------------------------------------------------------------


def build_cpu_only() -> Dict[str, Any]:
    root = "/home/ana/sim"
    N = f"{root}/nbody.py"
    MAIN = 139653201843008
    NPY = "/home/ana/.local/lib/python3.12/site-packages/numpy/_core/_multiarray_umath.cpython-312-x86_64-linux-gnu.so"
    p = Prog(
        "cpu-only",
        program=N,
        entrypoint_dir=root,
        program_path=root,
        args=[N, "120", "1500"],
        start_time_absolute=epoch(2026, 10, 25, 21, 13, 9.551027),
        start_time_perf=8812.335901,
        main_tid=MAIN,
        memory=False,
        gpu=False,
        gpu_device="",
        n_cpus=8,
    )
    rng = random.Random("cpu-schedule")
    p.add_source(N, read_src("cpu/nbody.py"))
    L = p.L
    main_call = L(N, "main(*args)")
    p.call(N, "main", main_call)
    p.call(N, "make_cluster", L(N, "bodies = make_cluster(n)"))
    p.call(N, "Body.__init__", L(N, "return [Body(*pos[i], *vel[i], mass[i]) for i in range(n)]"))
    p.call(N, "accelerations", L(N, "acc = accelerations(bodies)", func="main"), 1)
    p.call(N, "accelerations", L(N, "new_acc = accelerations(bodies)"), 1500)
    p.call(N, "step", L(N, "acc = step(bodies, acc, dt)"))
    p.call(N, "total_energy", L(N, "e0 = total_energy(bodies)"), 1)
    p.call(N, "total_energy", L(N, "drift = abs((total_energy(bodies) - e0) / e0)"), 3)
    float_ops = nat(("float_add", M.py))
    attr = nat(("member_get", M.py), ("PyMember_GetOne", M.py))
    sqrt = nat(("cfunction_vectorcall_O", M.py), ("math_sqrt", M.math))
    ufunc = lambda k: nat(("binary_op1", M.py), ("ufunc_generic_fastcall", NPY), (k, NPY))  # noqa: E731

    def A(needle: str, pyf: float = 0.98, native: Optional[List[Tuple[float, NativeTail]]] = None, func: Optional[str] = None,
          pins: Optional[Dict] = None, nth: Optional[int] = None) -> Act:
        return Act(L(N, needle, func=func, nth=nth), pyf=pyf, util=0.995, core=0.124, native=native or [(1.0, ())], pins=pins)

    imp = A("import numpy as np", 0.6, [(0.5, ()), (0.5, nat(("_imp_create_dynamic", M.py), ("_PyImport_LoadDynamicModuleWithSpec", M.py),
                                                              ("dlopen@@GLIBC_2.34", M.libc), ("_dl_open", M.ld), ("_dl_relocate_object", M.ld)))])
    mk = [A("rng = np.random.default_rng(seed)", 0.4), A("pos = rng.normal(0.0, 1.0e11", 0.3), A("vel = rng.normal(0.0, 3.0e3", 0.3),
          A("mass = rng.uniform(1.0e23", 0.3), A("return [Body(*pos[i], *vel[i], mass[i]) for i in range(n)]", 0.9),
          A("self.x, self.y, self.z = x, y, z", 0.99), A("self.vx, self.vy, self.vz = vx, vy, vz", 0.99)]

    def acc_acts(pin: Key) -> Dict[str, Act]:
        pins = {(N, "accelerations"): pin}
        mkA = lambda needle, pyf=0.98, native=None: A(needle, pyf, native, func="accelerations", pins=pins)  # noqa: E731
        return {
            "init": mkA("acc = [[0.0, 0.0, 0.0] for _ in range(n)]"),
            "fori": mkA("for i in range(n):"),
            "bi": mkA("bi = bodies[i]"),
            "zero": mkA("ax = ay = az = 0.0"),
            "forj": mkA("for j in range(n):", 0.97, [(0.85, ()), (0.15, nat(("rangeiter_next", M.py)))]),
            "ifij": mkA("if i == j:"),
            "bj": mkA("bj = bodies[j]"),
            "dx": mkA("dx = bj.x - bi.x", 0.97, [(0.75, ()), (0.25, attr)]),
            "dy": mkA("dy = bj.y - bi.y", 0.97, [(0.75, ()), (0.25, attr)]),
            "dz": mkA("dz = bj.z - bi.z", 0.97, [(0.75, ()), (0.25, attr)]),
            "r2": mkA("r2 = dx * dx + dy * dy + dz * dz + SOFTENING", 0.97, [(0.8, ()), (0.2, float_ops)]),
            "inv": mkA("inv_r3 = 1.0 / (r2 * math.sqrt(r2))", 0.8, [(0.55, ()), (0.45, sqrt)]),
            "s": mkA("s = G * bj.mass * inv_r3", 0.97, [(0.8, ()), (0.2, attr)]),
            "ax": mkA("ax += s * dx"),
            "ay": mkA("ay += s * dy"),
            "az": mkA("az += s * dz"),
            "store": mkA("acc[i][0], acc[i][1], acc[i][2] = ax, ay, az"),
            "ret": mkA("return acc"),
        }

    acc_main = acc_acts(L(N, "acc = accelerations(bodies)", func="main"))
    acc_step = acc_acts(L(N, "new_acc = accelerations(bodies)"))
    inner = [("forj", 0.085), ("ifij", 0.05), ("bj", 0.045), ("dx", 0.07), ("dy", 0.07), ("dz", 0.07), ("r2", 0.12),
             ("inv", 0.11), ("s", 0.07), ("ax", 0.045), ("ay", 0.045), ("az", 0.045)]
    n = 120

    def accelerations(acts: Dict[str, Act]) -> None:
        nonlocal t
        t = p.run(MAIN, t, ms(0.012), acts["init"])
        for chunk in range(4):
            rows = n // 4
            t = p.seq(MAIN, t, [(acts["fori"], ms(0.001 * rows)), (acts["bi"], ms(0.0012 * rows)), (acts["zero"], ms(0.001 * rows))])
            for name, us in inner:
                t = p.run(MAIN, t, ms(jit(rng, us * rows * (n - 1) / 1000.0, 0.06)), acts[name])
            t = p.run(MAIN, t, ms(0.0055 * rows), acts["store"])
        t = p.run(MAIN, t, ms(0.0004), acts["ret"])

    step_lines = [A(x, 0.98, func="step", nth=k) for x, k in (
        ("for b, a in zip(bodies, acc):", None), ("b.vx += 0.5 * dt * a[0]", 0), ("b.vy += 0.5 * dt * a[1]", 0),
        ("b.vz += 0.5 * dt * a[2]", 0), ("b.x += dt * b.vx", None), ("b.y += dt * b.vy", None), ("b.z += dt * b.vz", None))]
    kick2 = [A("for b, a in zip(bodies, new_acc):", 0.98)] + [
        A(x, 0.98, func="step", nth=1) for x in ("b.vx += 0.5 * dt * a[0]", "b.vy += 0.5 * dt * a[1]", "b.vz += 0.5 * dt * a[2]")]
    energy_pins = lambda pin: {(N, "total_energy"): pin}  # noqa: E731
    e_first = L(N, "e0 = total_energy(bodies)")
    e_drift = L(N, "drift = abs((total_energy(bodies) - e0) / e0)")

    def energy_acts(pin: Key) -> List[Tuple[Act, float]]:
        pp = energy_pins(pin)
        mkE = lambda needle, pyf, native=None: A(needle, pyf, native, func="total_energy", pins=pp)  # noqa: E731
        return [
            (mkE("pos = np.array([[b.x, b.y, b.z] for b in bodies])", 0.85, [(0.7, ()), (0.3, nat(("_array_fromobject_generic", NPY), ("PyArray_DiscoverDTypeAndShape", NPY)))]), 0.31),
            (mkE("vel = np.array([[b.vx, b.vy, b.vz] for b in bodies])", 0.85), 0.3),
            (mkE("mass = np.array([b.mass for b in bodies])", 0.85), 0.07),
            (mkE("kinetic = 0.5 * np.sum(mass * np.sum(vel * vel, axis=1))", 0.3, [(1.0, ufunc("DOUBLE_multiply_AVX2"))]), 0.03),
            (mkE("diff = pos[:, None, :] - pos[None, :, :]", 0.1, [(1.0, ufunc("DOUBLE_subtract_AVX2"))]), 0.05),
            (mkE("dist = np.sqrt(np.sum(diff * diff, axis=-1) + SOFTENING)", 0.1, [(0.6, ufunc("DOUBLE_sqrt_AVX512F")), (0.4, ufunc("DOUBLE_add_AVX2"))]), 0.07),
            (mkE("np.fill_diagonal(dist, np.inf)", 0.5), 0.004),
            (mkE("potential = -0.5 * G * np.sum(np.outer(mass, mass) / dist)", 0.15, [(1.0, ufunc("DOUBLE_divide_AVX2"))]), 0.08),
        ]

    t = 0.0024
    t = p.run(MAIN, t, 0.142, imp)
    t = p.seq(MAIN, t, [(mk[0], ms(0.4)), (mk[1], ms(0.02)), (mk[2], ms(0.02)), (mk[3], ms(0.01)), (mk[4], ms(0.9))])
    for _ in range(n):
        t = p.seq(MAIN, t, [(mk[5], ms(0.0004)), (mk[6], ms(0.0004))])
    accelerations(acc_main)
    t = p.seq(MAIN, t, [(a, ms(d)) for a, d in energy_acts(e_first)])
    loop = A("for s in range(steps):", 0.99)
    call_step = A("acc = step(bodies, acc, dt)", 0.99)
    every = A("if s % 500 == 0:", 0.99)
    step_ret = A("return new_acc", 0.99)
    printer = A('print(f"step {s:5d}  energy drift {drift:.3e}")', 0.6, [(0.6, nat(("_io_TextIOWrapper_write", M.py), ("write", M.libc))), (0.4, ())])
    edrift = energy_acts(e_drift)
    for st in range(1500):
        t = p.seq(MAIN, t, [(loop, ms(0.0004)), (call_step, ms(0.0006))])
        for a in step_lines:
            t = p.run(MAIN, t, ms(jit(rng, 0.0085 * n / 6)), a)
        accelerations(acc_step)
        for a in kick2:
            t = p.run(MAIN, t, ms(jit(rng, 0.0085 * n / 6)), a)
        t = p.run(MAIN, t, ms(0.0003), step_ret)
        t = p.run(MAIN, t, ms(0.0004), every)
        if st % 500 == 0:
            t = p.seq(MAIN, t, [(a, ms(d)) for a, d in edrift] + [(printer, ms(0.03))])
    t = p.run(MAIN, t, ms(0.05), A('print(f"{steps} steps of {n} bodies in', 0.7))
    p.elapsed = t + 0.0011
    return p.build()


# ---------------------------------------------------------------------------
# huge.json: procedurally generated 40-module package, 12 threads
# ---------------------------------------------------------------------------

HUGE_LAYOUT = [
    # (package, module, target lines)
    ("core", "config", 180), ("core", "registry", 240), ("core", "events", 210), ("core", "pool", 160), ("core", "scheduler", 330),
    ("geometry", "vector", 260), ("geometry", "mesh", 620), ("geometry", "octree", 380), ("geometry", "bvh", 300), ("geometry", "transforms", 190),
    ("physics", "forces", 420), ("physics", "integrators", 360), ("physics", "collisions", 480), ("physics", "constraints", 270), ("physics", "fluids", 700),
    ("io", "readers", 260), ("io", "writers", 230), ("io", "checkpoint", 300), ("io", "compression", 150),
    ("solvers", "linear", 320), ("solvers", "sparse", 1450), ("solvers", "multigrid", 520), ("solvers", "krylov", 410), ("solvers", "preconditioners", 280),
    ("render", "raster", 340), ("render", "shading", 290), ("render", "camera", 120),
    ("analysis", "statistics", 260), ("analysis", "spectra", 310), ("analysis", "clustering", 330), ("analysis", "histograms", 140),
    ("net", "rpc", 250), ("net", "protocol", 200),
    ("utils", "caching", 170), ("utils", "timing", 90), ("utils", "logging_utils", 80), ("utils", "strings", 110),
    ("plugins", "plugin_loader", 150), ("plugins", "thermal", 230),
]

STAGES = [
    # (module, function, domain)
    ("config", "load_config", "main"), ("mesh", "build_mesh", "main"), ("octree", "build_octree", "main"),
    ("fluids", "initialize_fields", "main"), ("integrators", "advance", "main"), ("krylov", "solve_pressure", "main"),
    ("collisions", "resolve_contacts", "worker"), ("checkpoint", "save_state", "main"), ("statistics", "summarize", "main"),
    ("raster", "render_frame", "main"),
]

VERBS = ["compute", "build", "refine", "split", "merge", "project", "apply", "update", "reduce", "gather", "scatter",
         "assemble", "evaluate", "estimate", "normalize", "resolve", "collect", "encode", "decode", "pack", "unpack",
         "sample", "smooth", "relax", "restrict", "prolong", "accumulate", "rebuild", "flush", "index", "sort", "partition",
         "classify", "filter", "transform", "integrate", "interpolate", "advect", "diffuse", "clip"]
NOUNS = ["mesh", "faces", "edges", "vertices", "normals", "bounds", "nodes", "cells", "blocks", "weights", "forces",
         "contacts", "pairs", "residual", "matrix", "rows", "columns", "basis", "spectrum", "histogram", "clusters",
         "samples", "frames", "tiles", "rays", "fragments", "pixels", "buffers", "records", "chunks", "keys", "events",
         "tasks", "fields", "pressure", "velocity", "density", "flux", "gradients", "stencil", "levels", "coefficients"]
VARS = ["acc", "buf", "count", "delta", "dist", "edges", "err", "faces", "grad", "idx", "items", "key", "level", "limit",
        "mask", "nodes", "norm", "offset", "out", "pairs", "pos", "queue", "rate", "residual", "result", "rows", "scale",
        "seen", "size", "state", "tol", "total", "value", "weights", "vel", "flux", "temp", "cell", "block", "chunk",
        "header", "payload", "score", "label", "bins", "hist", "coef", "basis", "theta", "omega", "lam", "alpha", "beta"]
ATTRS = ["data", "shape", "weight", "children", "parent", "bounds", "center", "mass", "energy", "cache", "config",
         "size", "ident", "name", "level", "dirty", "flags", "stride", "origin", "spacing"]
CONSTS = ["0", "1", "2", "3", "0.5", "1e-6", "1e-9", "32", "64", "256", "4096", "0.25", "1.5", "8"]
PHRASES = ["fast path for the common case", "keep the hot loop allocation free", "guard against degenerate input",
           "reuse the scratch buffer", "fall back to the slow path", "amortize the rebuild", "see design notes",
           "numerically stable form", "avoid quadratic behaviour", "matches the reference implementation"]
EXCS = ["KeyError", "ValueError", "IndexError", "OverflowError", "ZeroDivisionError", "OSError"]


class HugeFunc:
    def __init__(self, module: str, name: str, cls: Optional[str], level: int, domain: str):
        self.module, self.name, self.cls, self.level, self.domain = module, name, cls, level, domain
        self.qual = f"{cls}.{name}" if cls else name
        self.callees: List[Tuple["HugeFunc", float]] = []
        self.call_lines: Dict[int, int] = {}  # id(callee) -> line
        self.exec_lines: List[int] = []
        self.line_w: List[float] = []
        self.recursive = False
        self.rec_line = 0


def _expr(r: random.Random, depth: int = 0) -> str:
    v = lambda: r.choice(VARS)  # noqa: E731
    c = lambda: r.choice(CONSTS)  # noqa: E731
    forms = [
        lambda: f"{v()} * {v()} + {c()}",
        lambda: f"math.sqrt({v()} * {v()} + {v()} * {v()})",
        lambda: f"max({v()}, {c()})",
        lambda: f"min({v()}, {v()} + {c()})",
        lambda: f"len({v()})",
        lambda: f"{v()}.get({v()}, {c()})",
        lambda: f"abs({v()} - {v()}) / ({v()} + 1e-12)",
        lambda: f"({v()} << 3) ^ {v()}",
        lambda: f"{v()} if {v()} is not None else {c()}",
        lambda: f"np.clip({v()}, 0.0, 1.0)",
        lambda: f"np.dot({v()}, {v()})",
        lambda: f"{v()} @ {v()}",
        lambda: f"np.linalg.norm({v()} - {v()})",
        lambda: f"[{v()} * {c()} for {v()} in {v()} if {v()}]",
        lambda: f"{{k: w for k, w in {v()}.items() if w > {c()}}}",
        lambda: f"sum(x.{r.choice(ATTRS)} for x in {v()})",
        lambda: f"sorted({v()}, key=lambda e: e.{r.choice(ATTRS)})",
        lambda: f"zlib.crc32({v()})",
        lambda: f"struct.unpack_from(\"<dI\", {v()}, {c()})",
        lambda: f"heapq.heappop({v()})",
        lambda: f"self.{r.choice(ATTRS)}[{v()}]",
        lambda: f"np.zeros(({v()}, {c()}), dtype=np.float64)",
        lambda: f"np.concatenate([{v()}, {v()}])",
        lambda: f"{v()}.reshape(-1, {c()}).mean(axis=0)",
        lambda: f"f\"{{{v()}}}:{{{v()}}}\"",
        lambda: f"bytes({v()}[{c()}:{v()}])",
    ]
    return r.choice(forms)()


def _simple(r: random.Random) -> str:
    v = lambda: r.choice(VARS)  # noqa: E731
    forms = [
        lambda: f"{v()} = {_expr(r)}",
        lambda: f"{v()} = {_expr(r)}",
        lambda: f"{v()} += {_expr(r)}",
        lambda: f"{v()}.append({_expr(r)})",
        lambda: f"{v()}[{v()}] = {_expr(r)}",
        lambda: f"log.debug(\"{r.choice(NOUNS)} %s -> %s\", {v()}, {v()})",
        lambda: f"self.{r.choice(ATTRS)} = {_expr(r)}",
        lambda: f"{v()}, {v()} = {v()}, {v()}",
        lambda: f"heapq.heappush({v()}, ({v()}, {v()}))",
        lambda: f"assert {v()} >= 0, \"negative {r.choice(NOUNS)}\"",
    ]
    return r.choice(forms)()


def _block(r: random.Random, indent: int, budget: int, depth: int, out: List[Tuple[int, Optional[str]]]) -> None:
    """Fill `out` with (indent, text) lines; text None marks a simple-statement slot.
    Always emits at least one statement at `indent` (comments alone are not a block)."""
    start = len(out)
    _block_inner(r, indent, budget, depth, out)
    if not any(ind == indent and (tx is None or not tx.startswith("#")) for ind, tx in out[start:]):
        out.append((indent, None))


def _block_inner(r: random.Random, indent: int, budget: int, depth: int, out: List[Tuple[int, Optional[str]]]) -> None:
    v = lambda: r.choice(VARS)  # noqa: E731
    while budget > 0:
        x = r.random()
        if depth < 3 and budget >= 3 and x < 0.17:
            out.append((indent, r.choice([f"for {v()} in {v()}:", f"for i, {v()} in enumerate({v()}):",
                                          f"for {v()} in range({r.choice(CONSTS[1:])}, len({v()})):",
                                          f"for {v()}, {v()} in zip({v()}, {v()}):"])))
            k = r.randint(1, min(5, budget - 1))
            _block(r, indent + 1, k, depth + 1, out)
            budget -= k + 1
        elif depth < 3 and budget >= 3 and x < 0.29:
            out.append((indent, f"if {r.choice([f'{v()} > {r.choice(CONSTS)}', f'not {v()}', f'{v()} is None', f'{v()} in {v()}', f'len({v()}) < {r.choice(CONSTS)}'])}:"))
            k = r.randint(1, min(4, budget - 1))
            _block(r, indent + 1, k, depth + 1, out)
            budget -= k + 1
            if budget >= 2 and r.random() < 0.35:
                out.append((indent, "else:"))
                k = r.randint(1, min(3, budget - 1))
                _block(r, indent + 1, k, depth + 1, out)
                budget -= k + 1
        elif depth < 3 and budget >= 4 and x < 0.33:
            out.append((indent, "try:"))
            k = r.randint(1, min(3, budget - 2))
            _block(r, indent + 1, k, depth + 1, out)
            a, b = r.sample(EXCS, 2)
            out.append((indent, f"except ({a}, {b}) as exc:"))
            out.append((indent + 1, r.choice([f"log.warning(\"{r.choice(PHRASES)}: %s\", exc)", f"{v()} = None", "raise"])))
            budget -= k + 3
        elif depth < 3 and budget >= 3 and x < 0.36:
            out.append((indent, f"with open({v()}, \"rb\") as fh:"))
            out.append((indent + 1, f"{v()} = fh.read({r.choice(['', '4096', '1 << 20'])})"))
            budget -= 2
        elif depth < 3 and budget >= 3 and x < 0.38:
            out.append((indent, f"while {v()} and {v()} < {r.choice(CONSTS)}:"))
            k = r.randint(1, min(3, budget - 1))
            _block(r, indent + 1, k, depth + 1, out)
            budget -= k + 1
        elif x < 0.41:
            out.append((indent, f"# {r.choice(PHRASES)}"))
            budget -= 1
        else:
            out.append((indent, None))
            budget -= 1


def huge_program() -> Tuple[Dict[str, str], List[HugeFunc], Dict[str, Any]]:
    """Generate module sources and the call graph. Returns (files, funcs, meta)."""
    r = random.Random("huge-code")
    base = "/opt/bigsim/src/bigsim"
    mods = {m: (pkg, f"{base}/{pkg}/{m}.py", n) for pkg, m, n in HUGE_LAYOUT}
    funcs: List[HugeFunc] = []
    by_mod: Dict[str, List[HugeFunc]] = defaultdict(list)
    used: Dict[str, set] = defaultdict(set)
    stage_names = {(m, f) for m, f, _ in STAGES}
    classes: Dict[str, List[str]] = {}
    for _pkg, m, n in HUGE_LAYOUT:
        n_funcs = max(4, n // 26)
        cls_names = [f"{r.choice(NOUNS).title().replace('_', '')}{r.choice(['Builder', 'Cache', 'Solver', 'Index', 'Table', 'Kernel', 'Pool', 'Store', 'Node', 'Field'])}" for _ in range(r.randint(1, 3))]
        if m == "octree":
            cls_names[0] = "OctreeNode"
        if m == "pool":
            cls_names[0] = "WorkerPool"
        cls_names = list(dict.fromkeys(cls_names))
        classes[m] = cls_names
        for k in range(n_funcs):
            cls = r.choice(cls_names) if r.random() < 0.55 else None
            while True:
                name = f"{r.choice(VERBS)}_{r.choice(NOUNS)}"
                if cls and r.random() < 0.25:
                    name = "_" + name
                if (cls, name) not in used[m]:
                    used[m].add((cls, name))
                    break
            f = HugeFunc(m, name, cls, r.choice([2, 3, 3, 4, 4, 4, 5, 5, 6]), "worker" if r.random() < 0.3 else "main")
            funcs.append(f)
            by_mod[m].append(f)
    for m, name, dom in STAGES:
        f = HugeFunc(m, name, None, 1, dom)
        funcs.append(f)
        by_mod[m].insert(0, f)
    sub = HugeFunc("octree", "subdivide", "OctreeNode", 3, "main")
    sub.recursive = True
    funcs.append(sub)
    by_mod["octree"].insert(1, sub)
    wl = HugeFunc("pool", "_worker_loop", "WorkerPool", 0, "worker")
    funcs.append(wl)
    by_mod["pool"].insert(0, wl)
    # call edges: level L -> L+1 / L+2 in the same domain
    by_level: Dict[Tuple[str, int], List[HugeFunc]] = defaultdict(list)
    for f in funcs:
        by_level[(f.domain, f.level)].append(f)
    for f in funcs:
        if f is wl:
            for g in by_level[("worker", 1)] + r.sample(by_level[("worker", 2)], 6):
                f.callees.append((g, r.paretovariate(1.2)))
            continue
        if f.level >= 6 or f.recursive:
            if f.recursive:
                f.callees.append((r.choice(by_level[("main", 4)]), 1.0))
            continue
        pool = by_level[(f.domain, f.level + 1)] + by_level[(f.domain, f.level + 2)]
        if not pool:
            continue
        k = r.randint(1, 4) if f.level > 1 else r.randint(4, 7)
        for g in r.sample(pool, min(k, len(pool))):
            f.callees.append((g, r.paretovariate(1.1)))
        if f.module == "octree" and f.name == "build_octree":
            f.callees.append((sub, 6.0))
    # ---- emit source text ------------------------------------------------------------
    files: Dict[str, str] = {}
    func_lines: Dict[int, Tuple[int, int]] = {}
    for pkg, m, target in HUGE_LAYOUT:
        target = int(target * 0.86)
        path = mods[m][1]
        lines: List[str] = [f'"""bigsim.{pkg}.{m}: {r.choice(VERBS)} {r.choice(NOUNS)} for the {pkg} subsystem."""']
        lines.append("from __future__ import annotations")
        lines.append("")
        imports = ["import heapq", "import logging", "import math", "import struct", "import zlib",
                   "from collections import defaultdict, deque", "from dataclasses import dataclass, field",
                   "from typing import Dict, List, Optional, Sequence, Tuple", "", "import numpy as np", ""]
        refs = sorted({g.module for f in by_mod[m] for g, _ in f.callees if g.module != m})
        imports += [f"from bigsim.{mods[x][0]} import {x}" for x in refs]
        if m != "timing":
            imports.append("from bigsim.utils.timing import timed")
        lines += imports + ["", "log = logging.getLogger(__name__)", ""]
        for _ in range(r.randint(2, 6)):
            lines.append(f"{r.choice(NOUNS).upper()}_{r.choice(['LIMIT', 'TOLERANCE', 'BLOCK', 'STRIDE', 'SCALE'])} = {r.choice(CONSTS)}")
        lines.append("")
        top = [f for f in by_mod[m] if f.cls is None]
        cls_funcs = {c: [f for f in by_mod[m] if f.cls == c] for c in classes[m]}
        budget_per = max(6, (target - 30) // max(1, len(by_mod[m])) - 4)

        def emit_func(f: HugeFunc, indent: int) -> None:
            pad = "    " * indent
            if f.cls is None and r.random() < 0.15 and not f.recursive:
                lines.append(f"{pad}@timed(\"{m}.{f.name}\")")
            elif f.cls is not None and r.random() < 0.08 and not f.recursive and f.name != "_worker_loop":
                lines.append(f"{pad}@staticmethod")
            params = ", ".join(r.sample(VARS, r.randint(1, 4)))
            selfp = "self, " if f.cls is not None and (not lines[-1].strip().startswith("@staticmethod")) else ""
            if f.recursive:
                params = "depth, max_depth=32"
            lines.append(f"{pad}def {f.name}({selfp}{params}):")
            start = len(lines)
            if r.random() < 0.55:
                if r.random() < 0.3:
                    lines.append(f"{pad}    \"\"\"{r.choice(VERBS).title()} the {r.choice(NOUNS)}.")
                    lines.append("")
                    lines.append(f"{pad}    {r.choice(PHRASES).capitalize()}; {r.choice(PHRASES)}.")
                    lines.append(f"{pad}    \"\"\"")
                else:
                    lines.append(f"{pad}    \"\"\"{r.choice(VERBS).title()} {r.choice(NOUNS)} ({r.choice(PHRASES)}).\"\"\"")
            body: List[Tuple[int, Optional[str]]] = []
            budget = max(3, int(r.gauss(budget_per, budget_per * 0.35)))
            if f.recursive:
                body = [(0, "if depth >= max_depth or len(self.children) == 0:"), (1, "return self"), (0, "for child in self.children:"),
                        (1, None), (1, None), (1, "child.subdivide(depth + 1, max_depth)"), (0, None), (0, None)]
            else:
                _block(r, 0, budget, 0, body)
            slots = [i for i, (_, tx) in enumerate(body) if tx is None]
            r.shuffle(slots)
            while len(slots) < len(f.callees):
                body.append((0, None))
                slots.append(len(body) - 1)
            calls = {}
            for (g, _w), si in zip(f.callees, slots):
                var = r.choice(VARS)
                if g.cls is not None and g.module == f.module and g.cls == f.cls:
                    call = f"{var} = self.{g.name}({r.choice(VARS)}, {r.choice(VARS)})"
                elif g.cls is not None and g.recursive:
                    call = f"{var} = {r.choice(VARS)}.subdivide(0)"
                elif g.cls is not None:
                    call = f"{var} = {r.choice(VARS)}.{g.name}({r.choice(VARS)})"
                elif g.module == f.module:
                    call = f"{var} = {g.name}({r.choice(VARS)}, {r.choice(VARS)})"
                else:
                    call = f"{var} = {g.module}.{g.name}({r.choice(VARS)}, {r.choice(VARS)})"
                body[si] = (body[si][0], call)
                calls[si] = g
            for i, (ind, tx) in enumerate(body):
                if tx is None:
                    tx = _simple(r)
                if i in calls:
                    f.call_lines[id(calls[i])] = len(lines) + 1
                if f.recursive and "child.subdivide(" in tx:
                    f.rec_line = len(lines) + 1
                lines.append(f"{pad}    {'    ' * ind}{tx}")
            if not f.recursive:
                lines.append(f"{pad}    return {r.choice(VARS)}")
            func_lines[id(f)] = (start, len(lines))
            lines.append("")

        for c, fs in cls_funcs.items():
            if r.random() < 0.3:
                lines.append("@dataclass")
                lines.append(f"class {c}:")
                lines.append(f"    \"\"\"{r.choice(NOUNS).title()} container ({r.choice(PHRASES)}).\"\"\"")
                lines.append("")
                for a in r.sample(ATTRS, 3):
                    lines.append(f"    {a}: float = {r.choice(CONSTS)}")
                lines.append(f"    children: List[\"{c}\"] = field(default_factory=list)")
                lines.append("")
            else:
                lines.append(f"class {c}:")
                lines.append(f"    \"\"\"{r.choice(VERBS).title()}s {r.choice(NOUNS)} ({r.choice(PHRASES)}).\"\"\"")
                lines.append("")
                lines.append("    def __init__(self, config=None):")
                for a in r.sample(ATTRS, 4):
                    lines.append(f"        self.{a} = {r.choice(['None', '[]', '{}', '0', 'config'])}")
                lines.append("        self.children = []")
                lines.append("")
            if r.random() < 0.5:
                a = r.choice(ATTRS)
                lines.append("    @property")
                lines.append(f"    def {a}_ratio(self):")
                lines.append(f"        return self.{a} / max(1, len(self.children))")
                lines.append("")
            for f in fs:
                emit_func(f, 1)
        for f in top:
            emit_func(f, 0)
        while len(lines) < target:
            filler = HugeFunc(m, f"{r.choice(VERBS)}_{r.choice(NOUNS)}_v{len(lines)}", None, 9, "none")
            emit_func(filler, 0)
        text = "\n".join(lines) + "\n"
        ast.parse(text)
        files[path] = text
    # executable lines per function (for leaf choice)
    for path, text in files.items():
        tree = ast.parse(text)
        m = Path(path).stem
        for f in by_mod[m]:
            a, b = func_lines[id(f)]
            execs = []
            for node in ast.walk(tree):
                if isinstance(node, ast.stmt) and a <= node.lineno <= b and not isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                    if isinstance(node, ast.Expr) and isinstance(getattr(node, "value", None), ast.Constant):
                        continue
                    execs.append(node.lineno)
            f.exec_lines = sorted(set(execs))
            f.line_w = [r.paretovariate(1.3) for _ in f.exec_lines]
    meta = {"mods": mods, "by_mod": by_mod, "wl": wl, "sub": sub}
    return files, funcs, meta


RUN_SIM = '''"""Run a bigsim scenario end to end (meshing, dynamics, pressure solve, output)."""
import argparse
import logging
import sys

from bigsim.analysis import statistics
from bigsim.core import config
from bigsim.core.pool import WorkerPool, partition
from bigsim.geometry import mesh, octree
from bigsim.io import checkpoint
from bigsim.physics import collisions, fluids, integrators
from bigsim.render import raster
from bigsim.solvers import krylov

log = logging.getLogger("bigsim")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", default="scenarios/harbor.toml")
    parser.add_argument("--epochs", type=int, default=24)
    parser.add_argument("--workers", type=int, default=11)
    parser.add_argument("--output", default="out/harbor")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO)
    cfg = config.load_config(args.scenario)
    mesh_obj = mesh.build_mesh(cfg)
    tree = octree.build_octree(mesh_obj, cfg)
    fields = fluids.initialize_fields(mesh_obj, cfg)
    pool = WorkerPool(args.workers)
    residual = None
    for epoch in range(args.epochs):
        fields = integrators.advance(fields, mesh_obj, tree, cfg)
        residual = krylov.solve_pressure(fields, mesh_obj, cfg)
        futures = pool.map(collisions.resolve_contacts, partition(fields, args.workers))
        for fut in futures:
            fut.result()
        if epoch % 4 == 0:
            checkpoint.save_state(fields, epoch, cfg)
            report = statistics.summarize(fields, residual)
            raster.render_frame(fields, mesh_obj, epoch)
            log.info("epoch %d: residual %.3e, %s", epoch, residual, report)
    pool.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''


def build_huge() -> Dict[str, Any]:
    files, funcs, meta = huge_program()
    mods, by_mod, wl, sub = meta["mods"], meta["by_mod"], meta["wl"], meta["sub"]
    ROOT = "/opt/bigsim"
    RUN = f"{ROOT}/run_sim.py"
    PYV = "/usr/local/lib/python3.11"
    PY = "/usr/local/bin/python3.11"
    SP = f"{ROOT}/.venv/lib/python3.11/site-packages"
    NPY = f"{SP}/numpy/core/_multiarray_umath.cpython-311-x86_64-linux-gnu.so"
    BLAS = f"{SP}/numpy.libs/libopenblas64_p-r0-0cf96a72.3.23.dev.so"
    ZLIB = f"{PYV}/lib-dynload/zlib.cpython-311-x86_64-linux-gnu.so"
    STRUCT = f"{PYV}/lib-dynload/_struct.cpython-311-x86_64-linux-gnu.so"
    LIBC = M.libc
    MAIN = 140551905433408
    WORKERS = [140549870917312 + 8392704 * k for k in range(11)]
    p = Prog(
        "huge",
        program=RUN,
        entrypoint_dir=ROOT,
        program_path=ROOT,
        args=[RUN, "--scenario", "scenarios/harbor.toml", "--epochs", "24", "--workers", "11"],
        start_time_absolute=epoch(2026, 10, 21, 2, 17, 45.003912),
        start_time_perf=2207719.408227,
        main_tid=MAIN,
        memory=True,
        gpu=True,
        gpu_device="GPU",
        n_cpus=48,
    )
    rng = random.Random("huge-schedule")
    p.add_source(RUN, RUN_SIM)
    for path, text in files.items():
        p.add_source(path, text)
    for w in WORKERS:
        p.thread(w)
    src_of = lambda f: mods[f.module][1]  # noqa: E731

    # ---- per-line behaviour from the statement text ------------------------------------
    gc = gc_pass(PY)
    gil = gil_wait(PY, LIBC)
    tails = {
        "np.dot": nat(("cfunction_vectorcall_FASTCALL", PY), ("array_function_dispatcher___call__", NPY), ("cblas_ddot", BLAS), ("ddot_k_HASWELL", BLAS)),
        "@": nat(("binary_op1", PY), ("array_matrix_multiply", NPY), ("cblas_dgemm", BLAS), ("dgemm_nn", BLAS), ("dgemm_kernel_HASWELL", BLAS)),
        "linalg": nat(("cfunction_vectorcall_FASTCALL", PY), ("ufunc_generic_fastcall", NPY), ("DOUBLE_sqrt_AVX2", NPY)),
        "np.": nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", PY), ("PyArray_NewFromDescr_int", NPY), ("npy_alloc_cache", NPY), ("malloc", LIBC), ("_int_malloc", LIBC)),
        "zlib": nat(("cfunction_vectorcall_FASTCALL", PY), ("zlib_crc32", ZLIB), ("crc32_z", "/usr/lib/x86_64-linux-gnu/libz.so.1.2.13")),
        "struct": nat(("cfunction_vectorcall_FASTCALL", PY), ("s_unpack_internal", STRUCT), ("nu_double", STRUCT)),
        "read": nat(("_io__Buffered_read", PY), ("_bufferedreader_raw_read", PY), ("_Py_read", PY), ("read", LIBC)),
        "sorted": nat(("cfunction_vectorcall_FASTCALL_KEYWORDS", PY), ("builtin_sorted", PY), ("list_sort_impl", PY), ("unsafe_object_compare", PY)),
        "log.": nat(("_io_TextIOWrapper_write", PY), ("_Py_write", PY), ("write", LIBC)),
        "heapq": nat(("cfunction_vectorcall_FASTCALL", PY), ("_heapq_heappush_impl", PY), ("siftdown", PY)),
        "math.sqrt": nat(("cfunction_vectorcall_O", PY), ("math_sqrt", f"{PYV}/lib-dynload/math.cpython-311-x86_64-linux-gnu.so")),
        "append": nat(("list_append", PY), ("app1", PY), ("list_resize", PY), ("PyMem_Realloc", PY)),
    }
    props: Dict[Key, Tuple[float, float, List[Tuple[float, NativeTail]], float]] = {}

    def line_props(key: Key) -> Tuple[float, float, List[Tuple[float, NativeTail]], float]:
        if key in props:
            return props[key]
        text = p.sources[key[0]].lines[key[1] - 1]
        lr = random.Random(f"{key[0]}:{key[1]}")
        native: List[Tuple[float, NativeTail]] = []
        pyf, util, gpu = 0.95, 0.98, lr.uniform(0.05, 0.3)
        for tok in ("np.dot", "@", "linalg", "zlib", "struct", "read", "sorted", "log.", "heapq", "math.sqrt", "np.", "append"):
            if tok in text:
                t = tails[tok]
                native = [(0.5, t), (0.2, t[:-1]), (0.15, t[:2]), (0.15, ())]
                pyf = 0.25 if tok in ("np.dot", "@", "linalg", "np.", "zlib") else 0.6
                util = 0.45 if tok in ("read", "log.") else 0.97
                gpu = lr.uniform(0.5, 0.95) if tok in ("@", "np.dot", "linalg", "np.") else gpu
                break
        if not native:
            native = [(0.82, ()), (0.1, gc), (0.08, gil)] if lr.random() < 0.3 else [(1.0, ())]
        props[key] = (pyf, util, native, gpu)
        return props[key]

    acts: Dict[tuple, Act] = {}

    def act_for(chain: Tuple[Tuple[str, str, int], ...]) -> Act:
        a = acts.get(chain)
        if a is None:
            key = (chain[-1][0], chain[-1][2])
            pyf, util, native, gpu = line_props(key)
            a = Act(key, pyf=pyf, util=util, native=native, gpu=gpu, chain=chain)
            acts[chain] = a
        return a

    def walk(start: HugeFunc, prefix: Tuple[Tuple[str, str, int], ...], wr: random.Random) -> Tuple[Tuple[str, str, int], ...]:
        chain = list(prefix)
        f = start
        while True:
            if f.recursive:
                depth = min(31, int(wr.expovariate(0.12)))
                for _ in range(depth):
                    chain.append((src_of(f), f.qual, f.rec_line))
            if f.callees and wr.random() < 0.7:
                gs = [g for g, _ in f.callees]
                cum = list(itertools_acc(w for _, w in f.callees))
                g = gs[bisect_right(cum, wr.random() * cum[-1])]
                chain.append((src_of(f), f.qual, f.call_lines[id(g)]))
                f = g
                continue
            cum = list(itertools_acc(f.line_w))
            line = f.exec_lines[bisect_right(cum, wr.random() * cum[-1])]
            chain.append((src_of(f), f.qual, line))
            return tuple(chain)

    run_src = p.sources[RUN]
    entry = (RUN, "<module>", run_src.find("sys.exit(main())"))
    stage_fn = {name: next(f for f in funcs if f.module == m and f.name == name and f.level == 1) for m, name, _ in STAGES}
    stage_call = {
        "load_config": "cfg = config.load_config(args.scenario)", "build_mesh": "mesh_obj = mesh.build_mesh(cfg)",
        "build_octree": "tree = octree.build_octree(mesh_obj, cfg)", "initialize_fields": "fields = fluids.initialize_fields(",
        "advance": "fields = integrators.advance(", "solve_pressure": "residual = krylov.solve_pressure(",
        "save_state": "checkpoint.save_state(", "summarize": "report = statistics.summarize(", "render_frame": "raster.render_frame(",
    }

    def pool_of(name: str, size: int) -> List[Tuple[Tuple[str, str, int], ...]]:
        wr = random.Random(f"pool-{name}")
        prefix = (entry, (RUN, "main", run_src.find(stage_call[name])))
        out = []
        seen = set()
        for _ in range(size * 4):
            ch = walk(stage_fn[name], prefix, wr)
            if ch not in seen:
                seen.add(ch)
                out.append(ch)
            if len(out) >= size:
                break
        return out

    sizes = {"load_config": 55, "build_mesh": 230, "build_octree": 300, "initialize_fields": 150, "advance": 450,
             "solve_pressure": 350, "save_state": 160, "summarize": 150, "render_frame": 200}
    pools = {name: pool_of(name, n) for name, n in sizes.items()}
    zipf = {name: [1.0 / (i + 1) ** 0.95 for i in range(len(ch))] for name, ch in pools.items()}
    worker_pool: List[Tuple[Tuple[str, str, int], ...]] = []
    wr = random.Random("pool-worker")
    seen = set()
    for _ in range(3000):
        ch = walk(wl, (), wr)
        if ch not in seen:
            seen.add(ch)
            worker_pool.append(ch)
        if len(worker_pool) >= 700:
            break
    wzipf = [1.0 / (i + 1) ** 0.9 for i in range(len(worker_pool))]

    def pick(name: str) -> Act:
        ch = pools[name]
        cum = list(itertools_acc(zipf[name]))
        return act_for(ch[bisect_right(cum, rng.random() * cum[-1])])

    wcum = list(itertools_acc(wzipf))

    def run_stage(t: float, name: str, dur: float) -> float:
        end = t + dur
        while t < end:
            a = pick(name)
            t = p.run(MAIN, t, min(end - t, rng.lognormvariate(math.log(0.028), 0.8)), a)
            mem_window(a, t)
        return t

    # memory behaviour per leaf line: chosen among lines the run actually executes
    mem_spec: Dict[Key, Tuple[str, float, float]] = {}
    mr = random.Random("huge-mem")
    leaf_keys = sorted({(ch[-1][0], ch[-1][2]) for pl in list(pools.values()) + [worker_pool] for ch in pl})
    leak_lines: List[Key] = []
    for key in leaf_keys:
        text = p.sources[key[0]].lines[key[1] - 1]
        allocy = any(tok in text for tok in ("np.zeros", "np.concatenate", "bytes(", "fh.read(", ".reshape(", " for ", "sorted(", "np.dot", "{k:", "f\""))
        if ".append(" in text and len(leak_lines) < 3 and mr.random() < 0.25:
            mem_spec[key] = ("grow", mr.uniform(0.4, 1.6), 1.0)
            leak_lines.append(key)
        elif mr.random() < (0.6 if allocy else 0.12):
            mem_spec[key] = ("temp", mr.choice([0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 64.0]) * mr.uniform(0.6, 1.4),
                             mr.choice([0.0, 0.05, 0.4, 0.9, 1.0]))
    mem_n: Dict[Key, int] = defaultdict(int)

    def mem_window(a: Act, t_end: float) -> None:
        spec = mem_spec.get(a.key)
        if not spec:
            return
        kind, mb, pyf = spec
        mem_n[a.key] += 1
        if kind == "temp":
            if mem_n[a.key] % 3:
                return
            ep = p._ep()
            p.mem_events.append(MemEvent(t_end - 0.004, mb * 3, a.key, pyf, ep, a))
            p.mem_events.append(MemEvent(t_end + rng.uniform(0.002, 0.4), -mb * 3, a.key, pyf, None, a))
        else:
            p.mem_events.append(MemEvent(t_end, mb, a.key, pyf, p._ep(), a))

    # ---- schedule -----------------------------------------------------------------------------
    t = 0.0031
    imp_lines = [i for i, x in enumerate(run_src.lines, 1) if x.startswith(("from bigsim", "import "))]
    for ln_ in imp_lines:
        a = Act((RUN, ln_), pyf=0.7, util=0.9, native=[(0.6, ()), (0.4, gc)])
        t = p.run(MAIN, t, rng.uniform(0.05, 0.35), a)
        p.mem_hold(a, rng.uniform(2.0, 14.0), 0.8, chunks=2)
    t = p.run(MAIN, t, 0.012, Act((RUN, run_src.find("return parser.parse_args(argv)")), pyf=0.97, util=0.99,
                                  pins={}, native=[(1.0, ())], chain=(entry, (RUN, "main", run_src.find("args = parse_args(argv)")),
                                                                      (RUN, "parse_args", run_src.find("return parser.parse_args(argv)")))))
    p.gpu_alloc(t + 0.5, 1430.0)
    t = run_stage(t, "load_config", 1.6)
    t0 = t
    t = run_stage(t, "build_mesh", 12.5)
    p.gpu_alloc(t - 2.0, 3180.0)
    big = act_for(pools["build_mesh"][0])
    p.mem_events.append(MemEvent(t0 + 1.0, 1840.0, big.key, 0.02, p._ep(), big))
    t = run_stage(t, "build_octree", 9.2)
    t = run_stage(t, "initialize_fields", 6.4)
    p.gpu_alloc(t - 1.0, 2210.0)
    wait_act = Act((RUN, run_src.find("fut.result()")), pyf=0.5, util=0.05, sleeping=True)
    map_act = Act((RUN, run_src.find("futures = pool.map(")), pyf=0.8, util=0.95,
                  chain=(entry, (RUN, "main", run_src.find("futures = pool.map("))))
    worker_free = {w: 0.0 for w in WORKERS}
    for ep_i in range(24):
        t = run_stage(t, "advance", rng.uniform(2.9, 3.5))
        t = run_stage(t, "solve_pressure", rng.uniform(1.8, 2.4))
        t = p.run(MAIN, t, 0.004, map_act)
        par = rng.uniform(1.5, 1.9)
        active = rng.sample(WORKERS, 9)
        for w in active:
            tw = t + rng.uniform(0.0, 0.02)
            end = t + par * rng.uniform(0.8, 1.0)
            while tw < end:
                ch = worker_pool[bisect_right(wcum, rng.random() * wcum[-1])]
                a = act_for(ch)
                tw = p.run(w, tw, min(end - tw, rng.lognormvariate(math.log(0.06), 0.7)), a)
                mem_window(a, tw)
        t = p.run(MAIN, t, par, wait_act)
        if ep_i % 4 == 0:
            t = run_stage(t, "save_state", rng.uniform(1.6, 2.0))
            t = run_stage(t, "summarize", rng.uniform(0.8, 1.0))
            t = run_stage(t, "render_frame", rng.uniform(1.3, 1.7))
    t = p.run(MAIN, t, 0.2, Act((RUN, run_src.find("pool.shutdown()")), pyf=0.6, util=0.3, chain=(entry, (RUN, "main", run_src.find("pool.shutdown()")))))
    p.elapsed = t + 0.0013
    for lk in leak_lines:
        if any(a.key == lk for a in acts.values()):
            for a in acts.values():
                if a.key == lk:
                    p.leak_acts[id(a)] = round(random.Random(str(lk)).uniform(0.95, 0.999), 4)
                    p.acts[id(a)] = a
                    break
    return p.build()


def itertools_acc(xs):
    total = 0.0
    out = []
    for x in xs:
        total += x
        out.append(total)
    return out


from bisect import bisect_right  # noqa: E402
from pathlib import Path  # noqa: E402
import ast  # noqa: E402
