"""
BattleTale battle-art slicer.

Cuts poses out of a sprite sheet (or takes single pictures) and writes the files the BattleTale stage reads:

    <out>/<character name>/idle.png     standing picture (required)
    <out>/<character name>/attack.png   attack pose (optional)
    <out>/<character name>/hit.png      hit pose (optional)
    <out>/<character name>/down.png     knocked-down pose (optional)
    <out>/<character name>/art.json     only when the art faces right: {"facing": "right"}

<out> is SillyTavern's  data/<user>/user/images/BattleTale  folder (use --st to find it from the SillyTavern folder).
Draw/pick pictures that face LEFT (where an enemy stands); BattleTale mirrors them for allies.

Needs Pillow:  pip install pillow

1) See the cell numbers of a sheet (writes <sheet>_grid.png next to it):
     python slice_sprites.py sheet.webp --grid 6x3 --preview
2) Cut the cells you want (number = left to right, top to bottom, from 1; or r2c3 = row 2, column 3):
     python slice_sprites.py sheet.webp --grid 6x3 --idle 1 --attack 8 --hit 13 --down 17 --name "레온" --st "C:\\SillyTavern"
   A slot can also be a separate picture file:  --idle stand.png
"""
import argparse
import json
import os
import re
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit('Pillow가 필요해요:  pip install pillow')

SLOTS = ['idle', 'attack', 'hit', 'down']
MAX_H = 720          # tallest side the stage needs (zoomed in on a phone)
SOLID = 24           # alpha below this does not count as part of the figure (dust, faint glow)


def load(path):
    return Image.open(path).convert('RGBA')


def clear_background(img, mode, tol):
    """Make a flat background transparent, filling only from the edges so whites inside the figure survive."""
    if mode == 'none':
        return img
    img = img.copy()
    w, h = img.size
    px = img.load()
    if mode == 'auto':
        corner = px[0, 0]
        if corner[3] < SOLID:
            return img                        # already transparent
        mode_color = corner[:3]
    else:
        mode_color = (255, 255, 255)
    seeds = [(x, 0) for x in range(0, w, 8)] + [(x, h - 1) for x in range(0, w, 8)] + [(0, y) for y in range(0, h, 8)] + [(w - 1, y) for y in range(0, h, 8)]
    for sx, sy in seeds:
        r, g, b, a = px[sx, sy]
        if a < SOLID:
            continue
        if max(abs(r - mode_color[0]), abs(g - mode_color[1]), abs(b - mode_color[2])) <= tol:
            ImageDraw.floodfill(img, (sx, sy), (0, 0, 0, 0), thresh=tol)
    return img


def solid_bbox(img):
    alpha = img.getchannel('A').point(lambda a: 255 if a >= SOLID else 0)
    return alpha.getbbox()


def cell_box(spec, cols, rows, w, h):
    spec = str(spec).strip().lower()
    m = re.fullmatch(r'r(\d+)c(\d+)', spec)
    if m:
        r, c = int(m.group(1)) - 1, int(m.group(2)) - 1
    elif spec.isdigit():
        n = int(spec) - 1
        r, c = divmod(n, cols)
    else:
        return None
    if not (0 <= r < rows and 0 <= c < cols):
        sys.exit(f'칸 {spec}는 {cols}x{rows} 격자 밖이에요.')
    cw, rh = w / cols, h / rows
    return (round(c * cw), round(r * rh), round((c + 1) * cw), round((r + 1) * rh))


def preview(sheet_path, cols, rows, bg, tol):
    img = clear_background(load(sheet_path), bg, tol)
    w, h = img.size
    board = Image.new('RGBA', img.size, (40, 42, 50, 255))
    board.alpha_composite(img)
    d = ImageDraw.Draw(board)
    try:
        font = ImageFont.truetype('arial.ttf', max(14, int(min(w / cols, h / rows) / 8)))
    except OSError:
        font = ImageFont.load_default()
    for r in range(rows):
        for c in range(cols):
            x0, y0, x1, y1 = cell_box(r * cols + c + 1, cols, rows, w, h)
            d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(255, 210, 74, 255), width=2)
            d.text((x0 + 6, y0 + 4), str(r * cols + c + 1), fill=(255, 210, 74, 255), font=font, stroke_width=3, stroke_fill=(0, 0, 0, 255))
    out = os.path.splitext(sheet_path)[0] + '_grid.png'
    board.convert('RGB').save(out)
    print('칸 번호 미리보기:', out)


def fit(img):
    if img.height > MAX_H:
        img = img.resize((max(1, round(img.width * MAX_H / img.height)), MAX_H), Image.LANCZOS)
    return img


def main():
    ap = argparse.ArgumentParser(description='BattleTale 전투 일러 자르기', formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument('sheet', nargs='?', help='스프라이트 시트 (칸 번호를 쓸 때)')
    ap.add_argument('--grid', default='', help='열x행, 예: 6x3')
    ap.add_argument('--preview', action='store_true', help='칸 번호를 그린 미리보기만 만들기')
    for s in SLOTS:
        ap.add_argument(f'--{s}', default=None, help='칸 번호(1, r2c3) 또는 그림 파일')
    ap.add_argument('--name', help='캐릭터 이름 (BattleTale 시트·도감에 적힌 이름 그대로)')
    ap.add_argument('--out', help='출력 폴더 (…/user/images/BattleTale)')
    ap.add_argument('--st', help='SillyTavern 폴더 (출력 폴더를 대신 찾아줌)')
    ap.add_argument('--user', default='default-user', help='SillyTavern 사용자 폴더 이름 (기본 default-user)')
    ap.add_argument('--facing', choices=['left', 'right'], default='left', help='그림이 보는 방향 (기본 left)')
    ap.add_argument('--bg', choices=['auto', 'white', 'none'], default='auto', help='배경 지우기: auto(가장자리 색) / white / none')
    ap.add_argument('--tol', type=int, default=18, help='배경 색 허용 오차')
    ap.add_argument('--pad', type=int, default=6, help='그림 둘레 여백(px)')
    a = ap.parse_args()

    cols = rows = 0
    if a.grid:
        m = re.fullmatch(r'(\d+)\s*[xX*]\s*(\d+)', a.grid)
        if not m:
            sys.exit('--grid 는 6x3 처럼 열x행으로 적어 주세요.')
        cols, rows = int(m.group(1)), int(m.group(2))
    if a.preview:
        if not a.sheet or not cols:
            sys.exit('미리보기는 시트와 --grid 가 필요해요.')
        return preview(a.sheet, cols, rows, a.bg, a.tol)

    picks = {s: getattr(a, s) for s in SLOTS if getattr(a, s)}
    if 'idle' not in picks:
        sys.exit('--idle (기본 스탠딩)은 꼭 있어야 해요.')
    if not a.name:
        sys.exit('--name 으로 캐릭터 이름을 적어 주세요.')
    out_root = a.out or (os.path.join(a.st, 'data', a.user, 'user', 'images', 'BattleTale') if a.st else None)
    if not out_root:
        sys.exit('--out 또는 --st 로 저장할 곳을 알려 주세요.')
    name = re.sub(r'[\\/:*?"<>|]', '', a.name).strip()
    out_dir = os.path.join(out_root, name)
    os.makedirs(out_dir, exist_ok=True)

    sheet = None
    frames = {}
    for slot, spec in picks.items():
        if os.path.isfile(spec):
            frames[slot] = ('file', clear_background(load(spec), a.bg, a.tol))
            continue
        if not a.sheet or not cols:
            sys.exit(f'--{slot} {spec}: 파일이 없고, 칸 번호로 쓰려면 시트와 --grid 가 필요해요.')
        if sheet is None:
            sheet = clear_background(load(a.sheet), a.bg, a.tol)
        box = cell_box(spec, cols, rows, *sheet.size)
        if not box:
            sys.exit(f'--{slot} {spec}: 칸 번호(예: 7, r2c1)나 그림 파일이어야 해요.')
        frames[slot] = ('cell', sheet.crop(box))

    # Cells from one sheet share one box (their combined outline), so the figure keeps its size and stands
    # on the same spot in every pose; a lying-down pose stays low instead of being stretched to full height.
    cells = {s: im for s, (kind, im) in frames.items() if kind == 'cell'}
    union = None
    for im in cells.values():
        bb = solid_bbox(im)
        if bb:
            union = bb if union is None else (min(union[0], bb[0]), min(union[1], bb[1]), max(union[2], bb[2]), max(union[3], bb[3]))
    for slot, (kind, im) in frames.items():
        bb = union if kind == 'cell' else solid_bbox(im)
        if not bb:
            print(f'  {slot}: 비어 있는 칸이라 건너뛰었어요.')
            continue
        p = a.pad
        crop = im.crop((max(0, bb[0] - p), max(0, bb[1] - p), min(im.width, bb[2] + p), min(im.height, bb[3] + p)))
        crop = fit(crop)
        path = os.path.join(out_dir, f'{slot}.png')
        crop.save(path, optimize=True)
        print(f'  {slot}: {path}  ({crop.width}x{crop.height})')
    for s in SLOTS:                     # a pose left out this time should not linger from an earlier run
        if s not in frames:
            for ext in ('png', 'webp'):
                old = os.path.join(out_dir, f'{s}.{ext}')
                if os.path.exists(old):
                    print(f'  참고: 예전 {s}.{ext} 가 남아 있어요 (지우려면 직접 삭제).')
    cfg = os.path.join(out_dir, 'art.json')
    if a.facing == 'right':
        with open(cfg, 'w', encoding='utf-8') as f:
            json.dump({'facing': 'right'}, f)
    elif os.path.exists(cfg):
        os.remove(cfg)
    print(f'완료: {out_dir}\nBattleTale 캐릭터 카드의 "전투 일러"에서 [다시 찾기]를 누르거나 페이지를 새로고침하면 보여요.')


if __name__ == '__main__':
    main()
