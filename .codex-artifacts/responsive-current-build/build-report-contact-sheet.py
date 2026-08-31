from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
CANVAS = Image.new('RGB', (1400, 1100), '#111111')
DRAW = ImageDraw.Draw(CANVAS)
FONT_PATH = '/System/Library/Fonts/SFNS.ttf'


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size=size)


def place(source: str, box: tuple[int, int, int, int]) -> None:
    image = Image.open(ROOT / source).convert('RGB')
    image.thumbnail((box[2], box[3]), Image.Resampling.LANCZOS)
    x = box[0] + (box[2] - image.width) // 2
    y = box[1]
    CANVAS.paste(image, (x, y))
    DRAW.rectangle((x - 1, y - 1, x + image.width, y + image.height), outline='#737373', width=1)


DRAW.text((36, 20), 'Current production renderer evidence', fill='#f5f5f5', font=font(29))
DRAW.text((36, 56), 'index-CRQdtD_D.js   |   index-CBgcGntf.css', fill='#b8b8b8', font=font(16))

DRAW.text((219, 93), '390 × 844', fill='#f5f5f5', font=font(22))
DRAW.text((470, 93), '768 × 1024', fill='#f5f5f5', font=font(22))
DRAW.text((844, 93), '200% equivalent, scrolled', fill='#f5f5f5', font=font(22))

place('phone-390x844.png', (219, 123, 201, 432))
place('tablet-768x1024.png', (470, 123, 324, 432))
place('zoom-200-phone-scrolled.png', (844, 123, 201, 432))

DRAW.text((277, 592), '844 × 390 landscape', fill='#f5f5f5', font=font(22))
place('landscape-844x390.png', (277, 622, 846, 390))

CANVAS.save(ROOT / 'report-contact-sheet.png', optimize=True)
