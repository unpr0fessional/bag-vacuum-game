# источники визуальных ассетов

## материалы

Материалы ambientCG, 1K JPG:

- [Leather037](https://ambientcg.com/a/Leather037) — зерно кожи.
- [Fabric030](https://ambientcg.com/a/Fabric030) — ткань.
- [WoodFloor051](https://ambientcg.com/a/WoodFloor051) — деревянный пол.
- [Plaster003](https://ambientcg.com/a/Plaster003) — штукатурка.

[Лицензия CC0](https://docs.ambientcg.com/license/). Карты Color — sRGB,
NormalGL и Roughness — линейные данные. Для кожи, ткани и стен базовый цвет настроен
отдельно от скачанного albedo. У дерева насыщенность снижена в шейдере, карты рельефа сохранены.
В комплекте сохранены исходные albedo, normal и roughness выбранных материалов.

## ImageGen

Встроенный ImageGen, 25.09.26; референсы — кадры предоставленного автором видео.
Сгенерированные образы являются художественной интерпретацией, не извлечёнными из видео текстурами.

- `face-albedo.jpg` — 512 × 512, лицевая проекция на объёмную геометрию головы.
- `balcony-v2.jpg` — 1536 × 1024, дальний пейзаж за 3D-окном.

Промпт лица:

> Use case: identity-preserve. Asset type: photographic front-projection diffuse texture for the face mesh of a real-time 3D game character. The reference is the user's own fashion video. Recreate the adult woman's visible facial appearance: slender adult face, subtle natural dark brows, medium olive-light skin, straight nose, natural muted lips, expression neutral. Deliver ONLY a perfectly frontal orthographic close-up of her face as a square 1024x1024 albedo texture, no hood, no hair over the face, no clothing, no neck, no scenery, no text. The face must be symmetrical front-facing with no perspective tilt. Top of forehead touches the top edge, tip of chin touches the bottom edge; cheek-to-cheek facial skin spans the full width. Extend skin color smoothly to fill every corner: this is a rectangular face texture, not a portrait on a background. Eyes horizontally at 63% from bottom, nose at 40%, closed lips at 23%. Flat even soft lighting, no cast shadow, no specular shine, no makeup glamor, no beauty retouch. Preserve believable fine skin texture, slight natural under-eye shading, nostril and lip detail. This texture will be wrapped on actual 3D sculpted facial geometry; it must not contain clothing, a body, a hood, or a 3D scene.

Промпт пейзажа:

> Create a photographic environment texture for the outdoor view in the reference video game reconstruction. Reference image is user's video frame, use its outdoor sky and trees ONLY as art direction. Output landscape 1536x1024. A softly defocused, slightly overexposed view of pale blue-green tropical daylight sky, a distant row of realistic leafy muted green trees along the middle-lower third, distant low grey residential boundary wall at the bottom. Natural photographic flat cloudy afternoon light, cool cyan grey palette, lightly grainy candid-camera video look. No people, no clothing, no furniture, no table, no handbag, no text, no window frame, no poles, no railings, no roof. Only the distant exterior landscape plate. All framing, balcony rails, and architecture will be real 3D geometry drawn on top. Photorealistic, understated, reference-faithful. Sky occupies upper 60%, tree tops around 60-80%, wall bottom 20%. Avoid dramatic mountains, lush jungle, bright saturated green, golden-hour sunlight.

## 3D-модели

`hero-reference.png` — A-pose референс взрослой героини, созданный встроенным ImageGen
25.09.26 по кадру видео. По нему через Higgsfield image-to-3D получен `models/hero.glb`.
Для сумки аналогично получены `bag-reference.png` и `models/bag.glb`. В версии 1.0
персонаж использует исходный скелет GLB и аппаратную анимацию. Сумка и шланг крепятся
к сокетам ладоней; воротник шланга совмещён с боковой стенкой сумки.

26.09.26 текстуры внутри GLB перекодированы для релиза: albedo героини — JPEG 2048,
карты сумки — 1024 (normal остаётся PNG). Модели уменьшены с 16,6 до 5,4 МБ.
Геометрия, веса, иерархия и анимации сравнены с оригиналами побайтно и не изменены.
Оригиналы сохранены в истории git (`0fdc36c`). Скрипт оптимизации —
`scripts/optimize-model-textures.py`.

В 1.0.2 в памяти игры сгибаются исходные вершины пальцев (в GLB нет отдельных
суставов пальцев). UV-развёртка, веса и исходный файл сохранены; исправленный хват
следует за существующими костями кистей. Для прыжка поверх анимации добавляется
небольшое сгибание коленей с восстановлением исходной позы при приземлении.
