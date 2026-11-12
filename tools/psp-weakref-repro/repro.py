"""Reproduce the python311 GC crash of UE's closure type, then show the hotfix.

    repro.py          -> process dies with 0xC0000005 (as the editor did)
    repro.py --fix    -> applies hayba_psp_hotfix.fix_type first, survives
"""
import gc, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'unreal', 'HaybaMCPToolkit', 'Resources', 'Python'))
import pspclosure, hayba_psp_hotfix

T = pspclosure.ClosureType
print('weakrefoffset', T.__weakrefoffset__, 'basicsize', T.__basicsize__, 'broken', hayba_psp_hotfix.is_broken(T), flush=True)
if '--fix' in sys.argv:
    print('fix_type ->', hayba_psp_hotfix.fix_type(T), 'weakrefoffset now', T.__weakrefoffset__, flush=True)

class C:
    def m(self):
        pass

gc.disable()
c = C()
for _ in range(20):
    seed = [c.m for _ in range(50000)]  # bound methods leave a code pointer at +0x28 of each 64-byte block
    del seed
    for _ in range(50000):
        d = {}
        d['f'] = pspclosure.make(d)  # closure object in a cycle, like a script namespace holding a bound method
    gc.collect()
print('survived', flush=True)
