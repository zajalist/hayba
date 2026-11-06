"""Hayba hotfix for a crash in Unreal's PythonScriptPlugin (CPython 3.11, x64).

PythonScriptPlugin defines the type `builtin_function_or_method_with_closure`
(every bound Unreal method, e.g. `unreal.BlueprintEditorLibrary.compile_blueprint`)
with `tp_base = &PyCFunction_Type` but a 0x28-byte struct. PyType_Ready copies
PyCFunction's `tp_weaklistoffset` (0x28), which points one slot PAST the object,
into pymalloc padding that still holds a previous occupant's bytes. When such
an object is cyclic garbage, CPython's GC (gcmodule.c handle_weakrefs) reads
that padding as a weakref list and writes through it:
EXCEPTION_ACCESS_VIOLATION in python311 (+0xd8b0d write / +0xd8b06 read).
Any GC can hit it: gc.collect(), automatic collection, and Unreal's
pre-GC hook, which every Blueprint compile reaches through reinstancing.

The struct has no weaklist slot, so the true value is 0 ("no weakrefs").
`apply()` writes that, only when the offset really points outside the object.
"""
import ctypes

# offsetof(PyTypeObject, tp_weaklistoffset) for CPython 3.11 on 64-bit.
_TP_WEAKLISTOFFSET = 0xD0
_PTR = ctypes.sizeof(ctypes.c_void_p)


def _slot(t):
    return ctypes.c_ssize_t.from_address(id(t) + _TP_WEAKLISTOFFSET)


def _layout_ok():
    # Prove the hard-coded field offset against types whose value Python exposes.
    return all(_slot(t).value == t.__weakrefoffset__ for t in (type(_layout_ok), type, int))


def is_broken(t):
    off = t.__weakrefoffset__
    return off > 0 and t.__itemsize__ == 0 and off + _PTR > t.__basicsize__


def fix_type(t):
    """Zero t's weaklist offset if it points outside the object. True when t is now safe."""
    if not is_broken(t):
        return True
    if not _layout_ok():
        return False
    _slot(t).value = 0
    return t.__weakrefoffset__ == 0


def closure_type():
    import unreal
    return type(unreal.SystemLibrary.get_engine_version)


def apply():
    """Fix the live editor's closure type. Returns 'patched', 'ok' or 'unsupported'."""
    t = closure_type()
    if not is_broken(t):
        return 'ok'
    return 'patched' if fix_type(t) else 'unsupported'
