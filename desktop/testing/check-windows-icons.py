"""Verify Windows PE icon groups against the artwork used by the HTML favicon."""
import ctypes as C
import struct
import sys
from pathlib import Path
from ctypes import wintypes as W

kernel = C.WinDLL('kernel32', use_last_error=True)
def function(name, result, args):
    fn = getattr(kernel, name)
    fn.restype, fn.argtypes = result, args
    return fn

load = function('LoadLibraryExW', W.HMODULE, [W.LPCWSTR, W.HANDLE, W.DWORD])
find = function('FindResourceW', W.HRSRC, [W.HMODULE, C.c_void_p, C.c_void_p])
size = function('SizeofResource', W.DWORD, [W.HMODULE, W.HRSRC])
read = function('LoadResource', W.HGLOBAL, [W.HMODULE, W.HRSRC])
lock = function('LockResource', C.c_void_p, [W.HGLOBAL])
free = function('FreeLibrary', W.BOOL, [W.HMODULE])
callback = C.WINFUNCTYPE(W.BOOL, W.HMODULE, C.c_void_p, C.c_void_p, W.LPARAM)
enumerate_groups = function('EnumResourceNamesW', W.BOOL, [W.HMODULE, C.c_void_p, callback, W.LPARAM])

def resource(module, kind, name):
    info = find(module, name, kind)
    if not info:
        raise C.WinError(C.get_last_error())
    return C.string_at(lock(read(module, info)), size(module, info))

def branding(exe, icon):
    module = load(str(exe.resolve()), None, 2)
    if not module:
        raise C.WinError(C.get_last_error())
    groups = []
    @callback
    def visit(handle, kind, name, param):
        group = resource(handle, kind, name)
        entries = list(struct.iter_unpack('<BBBBHHIH', group[6:]))
        groups.append({(w or 256, h or 256): resource(handle, 3, ident) for w, h, colors, reserved, planes, bits, length, ident in entries})
        return True
    try:
        enumerate_groups(module, 14, visit, 0)
        if not groups or groups[0] != icon:
            raise AssertionError(f'{exe.name}: primary icon group differs from Hayba artwork ({[sorted(g) for g in groups]})')
    finally:
        free(module)
    print(f'{exe.name}: primary Windows icon matches all {len(icon)} branded sizes')

if __name__ == '__main__':
    data = Path(sys.argv[1]).read_bytes()
    count = struct.unpack_from('<H', data, 4)[0]
    icon = {}
    for i in range(count):
        w, h, _, _, _, _, length, offset = struct.unpack_from('<BBBBHHII', data, 6 + i * 16)
        icon[w or 256, h or 256] = data[offset:offset + length]
    for file in sys.argv[2:]:
        branding(Path(file), icon)
