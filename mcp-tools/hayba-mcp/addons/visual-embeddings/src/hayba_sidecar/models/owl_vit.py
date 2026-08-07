"""OWL-ViT lazy loader for open-vocabulary object detection.

`torch` is imported inside the methods, not at module scope, so importing this
module (and therefore the app, and therefore `/health`) does not require the
heavy optional dependency it exists to wrap.
"""
import warnings
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from PIL import Image

_processor = None
_model = None
_warned = False


class _OwlVit:
    def __init__(self, processor, model):
        self.processor = processor
        self.model = model

    def detect(self, img: "Image.Image", queries: list[str], score_threshold: float = 0.1):
        if self.model is None or self.processor is None:
            return []
        import torch

        with torch.no_grad():
            inputs = self.processor(text=[queries], images=img, return_tensors="pt")
            outputs = self.model(**inputs)
            target_sizes = torch.tensor([img.size[::-1]])
            results = self.processor.post_process_object_detection(
                outputs=outputs, target_sizes=target_sizes, threshold=score_threshold
            )[0]
            out = []
            for box, score, label_idx in zip(
                results["boxes"], results["scores"], results["labels"]
            ):
                out.append(
                    {
                        "label": queries[int(label_idx)],
                        "box": [float(x) for x in box.tolist()],
                        "score": float(score),
                    }
                )
            return out


def get_owl_vit():
    global _processor, _model, _warned
    if _model is None:
        try:
            from transformers import OwlViTForObjectDetection, OwlViTProcessor

            _processor = OwlViTProcessor.from_pretrained("google/owlvit-base-patch32")
            _model = OwlViTForObjectDetection.from_pretrained(
                "google/owlvit-base-patch32"
            ).eval()
        except Exception as e:
            if not _warned:
                warnings.warn(
                    f"OWL-ViT unavailable ({e}); install with `uv sync --extra owlvit`. "
                    "detect() will return []."
                )
                _warned = True
    return _OwlVit(_processor, _model)
