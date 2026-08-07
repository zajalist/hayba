"""CLIP image embeddings.

`open_clip` and `torch` are imported inside `get_clip()`, not at module scope.
Importing them here made the whole app unimportable without multi-GB weights
installed — including `/health`, whose entire job is to answer when the models
are *not* there. The SAM loader alongside this one has always been lazy for
exactly that reason; this matches it.
"""
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from PIL import Image

_model = None
_preproc = None
_tokenizer = None


class _Clip:
    def __init__(self, model, preproc, tokenizer):
        self.m = model
        self.pre = preproc
        self.tok = tokenizer

    def encode_image(self, img: "Image.Image"):
        import torch

        with torch.no_grad():
            device = next(self.m.parameters()).device
            x = self.pre(img).unsqueeze(0).to(device)
            v = self.m.encode_image(x)
            v = v / v.norm(dim=-1, keepdim=True)
            return v[0].cpu().numpy()


def available() -> bool:
    """Whether CLIP could run — the import resolves. Reported by /health so the
    client can tell "not installed" apart from "not warmed up"."""
    try:
        import open_clip  # noqa: F401
        import torch  # noqa: F401
    except Exception:
        return False
    return True


def get_clip():
    global _model, _preproc, _tokenizer
    import open_clip
    import torch

    if _model is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _model, _, _preproc = open_clip.create_model_and_transforms(
            "ViT-L-14", pretrained="openai"
        )
        _model = _model.to(device).eval()
        _tokenizer = open_clip.get_tokenizer("ViT-L-14")
    return _Clip(_model, _preproc, _tokenizer)
