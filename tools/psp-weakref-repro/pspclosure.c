/* Mirror of PythonScriptPlugin's FPyCFunctionWithClosureObject type (UE 5.8,
 * PyMethodWithClosure.cpp): same struct, same tp_base hack, GC-tracked. Used
 * only to reproduce the GC weakref crash outside the editor. */
#define PY_SSIZE_T_CLEAN
#include <Python.h>

typedef struct {
    PyObject_HEAD
    void* MethodDef;
    PyObject* SelfArg;
    PyObject* ModuleAttr;
} ClosureObject; /* 0x28 bytes, like the plugin's */

static int Traverse(ClosureObject* o, visitproc visit, void* arg) { Py_VISIT(o->SelfArg); Py_VISIT(o->ModuleAttr); return 0; }
static int Clear(ClosureObject* o) { Py_CLEAR(o->SelfArg); Py_CLEAR(o->ModuleAttr); return 0; }
static void Dealloc(ClosureObject* o) { PyObject_GC_UnTrack(o); Clear(o); PyObject_GC_Del(o); }

static PyTypeObject ClosureType = {
    PyVarObject_HEAD_INIT(NULL, 0)
    "builtin_function_or_method_with_closure",
    sizeof(ClosureObject),
};

static PyObject* make(PyObject* mod, PyObject* self_arg)
{
    ClosureObject* o = PyObject_GC_New(ClosureObject, &ClosureType);
    if (!o) return NULL;
    o->MethodDef = NULL;
    Py_INCREF(self_arg);
    o->SelfArg = self_arg;
    o->ModuleAttr = NULL;
    PyObject_GC_Track(o);
    return (PyObject*)o;
}

static PyMethodDef Methods[] = { { "make", make, METH_O, NULL }, { NULL } };
static struct PyModuleDef Module = { PyModuleDef_HEAD_INIT, "pspclosure", NULL, -1, Methods };

PyMODINIT_FUNC PyInit_pspclosure(void)
{
    ClosureType.tp_base = &PyCFunction_Type; /* the plugin's "doc gen" hack */
    ClosureType.tp_dealloc = (destructor)Dealloc;
    ClosureType.tp_traverse = (traverseproc)Traverse;
    ClosureType.tp_clear = (inquiry)Clear;
    ClosureType.tp_getattro = PyObject_GenericGetAttr;
    ClosureType.tp_flags = Py_TPFLAGS_DEFAULT | Py_TPFLAGS_HAVE_GC;
    if (PyType_Ready(&ClosureType) < 0) return NULL;
    PyObject* m = PyModule_Create(&Module);
    Py_INCREF(&ClosureType);
    PyModule_AddObject(m, "ClosureType", (PyObject*)&ClosureType);
    return m;
}
