"""One-shot local perception. Models are unloaded when this process exits."""
import base64
import contextlib
import json
import os
import sys
import tempfile

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
request = json.load(sys.stdin)
with contextlib.redirect_stdout(sys.stderr):
    import mlx.core as mx
    mx.set_cache_limit(64 * 1024 * 1024)
    mx.set_memory_limit(4 * 1024 * 1024 * 1024)
    with tempfile.TemporaryDirectory(prefix="wb-media-") as directory:
        filename = os.path.join(directory, "input." + request["format"])
        with open(filename, "wb") as output:
            output.write(base64.b64decode(request["data"], validate=True))
        if request["type"] == "image":
            from PIL import Image, ImageOps
            Image.MAX_IMAGE_PIXELS = 16_000_000
            with Image.open(filename) as image:
                if image.width * image.height > 16_000_000:
                    raise ValueError("图片像素超过1600万")
                image = ImageOps.exif_transpose(image)
                image.thumbnail((768, 768))
                image.convert("RGB").save(os.path.join(directory, "scaled.png"))
            filename = os.path.join(directory, "scaled.png")
            from mlx_vlm import load, generate
            from mlx_vlm.prompt_utils import apply_chat_template
            model, processor = load(request["model"])
            prompt = apply_chat_template(processor, model.config,
                "Describe the image accurately in Chinese, including visible text and layout. Do not invent details. User question: " + request["question"][:2000], num_images=1)
            result = generate(model, processor, prompt, image=[filename], max_tokens=384, verbose=False)
            text = result.text
        else:
            import miniaudio
            import numpy as np
            import mlx_whisper
            info = miniaudio.get_file_info(filename)
            if info.duration > 120:
                raise ValueError("音频最长120秒")
            decoded = miniaudio.decode_file(filename, output_format=miniaudio.SampleFormat.FLOAT32, nchannels=1, sample_rate=16000)
            audio = np.asarray(decoded.samples, dtype=np.float32)
            if audio.size > 16000 * 120:
                raise ValueError("音频最长120秒")
            text = mlx_whisper.transcribe(audio, path_or_hf_repo=request["model"])["text"]
        if not isinstance(text, str) or not text.strip():
            raise ValueError("本地识别结果为空")
print(json.dumps({"text": text.strip()}, ensure_ascii=False))
