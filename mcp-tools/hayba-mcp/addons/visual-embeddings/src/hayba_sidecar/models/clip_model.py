import open_clip
import torch
from PIL import Image

_model = None
_preproc = None
_tokenizer = None


class _Clip:
    def __init__(self, model, preproc, tokenizer):
        self.m = model
        self.pre = preproc
        self.tok = tokenizer

    @torch.no_grad()
    def encode_image(self, img: Image.Image):
        device = next(self.m.parameters()).device
        x = self.pre(img).unsqueeze(0).to(device)
        v = self.m.encode_image(x)
        v = v / v.norm(dim=-1, keepdim=True)
        return v[0].cpu().numpy()


def get_clip():
    global _model, _preproc, _tokenizer
    if _model is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _model, _, _preproc = open_clip.create_model_and_transforms(
            "ViT-L-14", pretrained="openai"
        )
        _model = _model.to(device).eval()
        _tokenizer = open_clip.get_tokenizer("ViT-L-14")
    return _Clip(_model, _preproc, _tokenizer)
