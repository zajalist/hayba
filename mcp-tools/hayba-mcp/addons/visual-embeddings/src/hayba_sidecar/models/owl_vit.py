"""OWL-ViT lazy loader for open-vocabulary object detection."""
import warnings

import torch
from PIL import Image

_processor = None
_model = None
_warned = False


class _OwlVit:
    def __init__(self, processor, model):
        self.processor = processor
        self.model = model

    @torch.no_grad()
    def detect(self, img: Image.Image, queries: list[str], score_threshold: float = 0.1):
        if self.model is None or self.processor is None:
            return []
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
