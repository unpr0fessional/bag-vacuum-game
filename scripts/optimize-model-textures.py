"""Offline release optimization. Geometry, skin weights and animation bytes stay exact.

Requires Pillow. Run once from the repository root; original GLBs remain in git
history (0fdc36c). This only transcodes the embedded texture buffer views.
"""
import io
import json
import struct
from pathlib import Path
from PIL import Image


def optimize(path, max_size, quality):
    raw = path.read_bytes()
    json_size = struct.unpack_from('<I', raw, 12)[0]
    doc = json.loads(raw[20:20 + json_size])
    start = 20 + json_size + 8
    binary = raw[start:]
    replacements = {}
    for entry in doc.get('images', []):
        index = entry['bufferView']
        view = doc['bufferViews'][index]
        offset = view.get('byteOffset', 0)
        image = Image.open(io.BytesIO(binary[offset:offset + view['byteLength']]))
        image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        is_normal = 'normal' in entry.get('name', '').lower()
        if is_normal or image.mode == 'RGBA':
            image.save(output, 'PNG', optimize=True)
            entry['mimeType'] = 'image/png'
        else:
            image.convert('RGB').save(output, 'JPEG', quality=quality, subsampling=0, optimize=True)
            entry['mimeType'] = 'image/jpeg'
        replacements[index] = output.getvalue()
    packed = bytearray()
    for index, view in enumerate(doc['bufferViews']):
        offset = view.get('byteOffset', 0)
        data = replacements.get(index, binary[offset:offset + view['byteLength']])
        packed.extend(b'\0' * (-len(packed) % 4))
        view['byteOffset'] = len(packed)
        view['byteLength'] = len(data)
        packed.extend(data)
    doc['buffers'][0]['byteLength'] = len(packed)
    packed.extend(b'\0' * (-len(packed) % 4))
    meta = json.dumps(doc, separators=(',', ':')).encode()
    meta += b' ' * (-len(meta) % 4)
    result = struct.pack('<4sII', b'glTF', 2, 28 + len(meta) + len(packed))
    result += struct.pack('<II', len(meta), 0x4E4F534A) + meta
    result += struct.pack('<II', len(packed), 0x004E4942) + packed
    path.write_bytes(result)
    print(f'{path}: {len(raw):,} -> {len(result):,} bytes')


if __name__ == '__main__':
    optimize(Path('assets/models/hero.glb'), 2048, 94)
    optimize(Path('assets/models/bag.glb'), 1024, 94)
