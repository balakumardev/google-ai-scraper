#!/usr/bin/env python3
"""Generate Chrome Web Store promotional images for Google AI Overview Scraper."""

from PIL import Image, ImageDraw, ImageFont
import os

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))

# --- Font Helpers ---

def load_font(size, bold=False):
    """Load a font, trying macOS system fonts with fallbacks."""
    candidates = []
    if bold:
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
        ]
    else:
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def load_mono_font(size):
    """Load a monospace font for code blocks."""
    candidates = [
        "/System/Library/Fonts/SFMono.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/System/Library/Fonts/Courier.ttc",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


# --- Drawing Helpers ---

def draw_gradient_rect(draw, bbox, color1, color2, direction="vertical"):
    """Draw a gradient-filled rectangle."""
    x0, y0, x1, y1 = bbox
    if direction == "vertical":
        for y in range(y0, y1):
            ratio = (y - y0) / max(1, (y1 - y0))
            r = int(color1[0] + (color2[0] - color1[0]) * ratio)
            g = int(color1[1] + (color2[1] - color1[1]) * ratio)
            b = int(color1[2] + (color2[2] - color1[2]) * ratio)
            draw.line([(x0, y), (x1, y)], fill=(r, g, b))
    else:
        for x in range(x0, x1):
            ratio = (x - x0) / max(1, (x1 - x0))
            r = int(color1[0] + (color2[0] - color1[0]) * ratio)
            g = int(color1[1] + (color2[1] - color1[1]) * ratio)
            b = int(color1[2] + (color2[2] - color1[2]) * ratio)
            draw.line([(x, y0), (x, y1)], fill=(r, g, b))


def draw_rounded_rect(draw, bbox, radius, fill=None, outline=None, width=1):
    """Draw a rounded rectangle."""
    x0, y0, x1, y1 = bbox
    draw.rounded_rectangle(bbox, radius=radius, fill=fill, outline=outline, width=width)


def draw_arrow(draw, start, end, color, width=3, head_size=12):
    """Draw an arrow from start to end."""
    import math
    x0, y0 = start
    x1, y1 = end
    draw.line([start, end], fill=color, width=width)
    angle = math.atan2(y1 - y0, x1 - x0)
    # Arrowhead
    left_x = x1 - head_size * math.cos(angle - math.pi / 6)
    left_y = y1 - head_size * math.sin(angle - math.pi / 6)
    right_x = x1 - head_size * math.cos(angle + math.pi / 6)
    right_y = y1 - head_size * math.sin(angle + math.pi / 6)
    draw.polygon([(x1, y1), (int(left_x), int(left_y)), (int(right_x), int(right_y))], fill=color)


def draw_magnifying_glass(draw, cx, cy, size, color, width=3):
    """Draw a magnifying glass icon."""
    import math
    r = size // 2
    # Circle
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=width)
    # Handle (bottom-right)
    handle_len = int(r * 0.8)
    angle = math.pi / 4
    hx = cx + int((r + 2) * math.cos(angle))
    hy = cy + int((r + 2) * math.sin(angle))
    ex = hx + int(handle_len * math.cos(angle))
    ey = hy + int(handle_len * math.sin(angle))
    draw.line([(hx, hy), (ex, ey)], fill=color, width=width + 1)


def draw_sparkle(draw, cx, cy, size, color):
    """Draw a 4-pointed sparkle/star."""
    # Vertical line
    draw.line([(cx, cy - size), (cx, cy + size)], fill=color, width=2)
    # Horizontal line
    draw.line([(cx - size, cy), (cx + size, cy)], fill=color, width=2)
    # Diagonal lines (shorter)
    s = int(size * 0.5)
    draw.line([(cx - s, cy - s), (cx + s, cy + s)], fill=color, width=2)
    draw.line([(cx + s, cy - s), (cx - s, cy + s)], fill=color, width=2)


def draw_checkmark(draw, x, y, size, color, width=3):
    """Draw a checkmark."""
    # Short down-right stroke then long up-right stroke
    mid_x = x + size * 0.35
    mid_y = y + size * 0.7
    draw.line([(x, y + size * 0.4), (mid_x, mid_y)], fill=color, width=width)
    draw.line([(mid_x, mid_y), (x + size, y)], fill=color, width=width)


def text_bbox_size(draw, text, font):
    """Get width and height of text."""
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


# ============================================================
# IMAGE 1: Small Promotional Tile (440x280)
# ============================================================

def create_promo_tile():
    W, H = 440, 280
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)

    # Blue gradient background
    draw_gradient_rect(draw, (0, 0, W, H), (66, 133, 244), (26, 115, 232))

    # Subtle decorative circles in background (use alpha compositing)
    for cx, cy, r, alpha in [(380, 40, 60, 30), (60, 230, 45, 25), (350, 220, 35, 20)]:
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        overlay_draw = ImageDraw.Draw(overlay)
        overlay_draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, alpha))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(img)

    # Magnifying glass icon
    draw_magnifying_glass(draw, 85, 100, 40, "white", width=4)

    # Sparkles around the magnifying glass
    draw_sparkle(draw, 125, 70, 10, (255, 223, 100))
    draw_sparkle(draw, 50, 75, 7, (255, 223, 100))
    draw_sparkle(draw, 115, 135, 8, (255, 223, 100))

    # Title text
    font_title = load_font(28, bold=True)
    font_tagline = load_font(16)

    title = "Google AI Overview"
    title2 = "Scraper"
    tagline = "AI Overviews \u2192 Structured Markdown"

    tw1, th1 = text_bbox_size(draw, title, font_title)
    tw2, th2 = text_bbox_size(draw, title2, font_title)
    tw3, th3 = text_bbox_size(draw, tagline, font_tagline)

    # Position title block
    block_x = 150
    title_y = 80
    draw.text((block_x, title_y), title, fill="white", font=font_title)
    draw.text((block_x, title_y + th1 + 6), title2, fill="white", font=font_title)

    # Tagline
    draw.text((block_x, title_y + th1 + th2 + 30), tagline, fill=(220, 230, 255), font=font_tagline)

    # Bottom accent line
    draw.rectangle([40, H - 40, W - 40, H - 37], fill=(255, 223, 100))

    # MCP badge
    font_badge = load_font(13, bold=True)
    badge_text = "MCP Server"
    bw, bh = text_bbox_size(draw, badge_text, font_badge)
    badge_x = W - 50 - bw
    badge_y = H - 65
    draw_rounded_rect(draw, (badge_x - 10, badge_y - 5, badge_x + bw + 10, badge_y + bh + 5),
                       radius=12, fill=(255, 255, 255, 40), outline=(255, 255, 255, 100))
    draw.text((badge_x, badge_y), badge_text, fill="white", font=font_badge)

    img.save(os.path.join(OUTPUT_DIR, "promo-tile-440x280.png"))
    print("Created promo-tile-440x280.png")


# ============================================================
# IMAGE 2: Screenshot 1 — "How It Works" (1280x800)
# ============================================================

def create_screenshot_how_it_works():
    W, H = 1280, 800
    img = Image.new("RGB", (W, H), color=(26, 26, 46))
    draw = ImageDraw.Draw(img)

    # Subtle grid pattern
    for x in range(0, W, 40):
        draw.line([(x, 0), (x, H)], fill=(35, 35, 60), width=1)
    for y in range(0, H, 40):
        draw.line([(0, y), (W, y)], fill=(35, 35, 60), width=1)

    # Title
    font_title = load_font(48, bold=True)
    font_subtitle = load_font(22)
    font_box = load_font(18, bold=True)
    font_box_small = load_font(14)
    font_arrow_label = load_font(13)

    title = "How It Works"
    tw, th = text_bbox_size(draw, title, font_title)
    draw.text(((W - tw) // 2, 40), title, fill="white", font=font_title)

    subtitle = "Extension-driven relay \u2014 no browser focus stealing"
    sw, sh = text_bbox_size(draw, subtitle, font_subtitle)
    draw.text(((W - sw) // 2, 100), subtitle, fill=(160, 170, 200), font=font_subtitle)

    # Flow boxes
    boxes = [
        {"label": "MCP Client", "sub": "Claude Code / Cursor", "color": (66, 133, 244), "x": 80},
        {"label": "MCP Server", "sub": "Python (stdio/SSE)", "color": (52, 168, 83), "x": 340},
        {"label": "FastAPI", "sub": "localhost:15551", "color": (251, 188, 4), "x": 600},
        {"label": "Chrome Extension", "sub": "Background Tab", "color": (234, 67, 53), "x": 860},
    ]

    box_y = 220
    box_w = 200
    box_h = 90

    for b in boxes:
        bx = b["x"]
        # Box shadow
        draw_rounded_rect(draw, (bx + 3, box_y + 3, bx + box_w + 3, box_y + box_h + 3),
                           radius=12, fill=(10, 10, 20))
        # Box
        draw_rounded_rect(draw, (bx, box_y, bx + box_w, box_y + box_h),
                           radius=12, fill=b["color"], outline=(255, 255, 255, 60), width=1)
        # Label
        lw, lh = text_bbox_size(draw, b["label"], font_box)
        draw.text((bx + (box_w - lw) // 2, box_y + 20), b["label"], fill="white", font=font_box)
        # Sub
        sw2, sh2 = text_bbox_size(draw, b["sub"], font_box_small)
        draw.text((bx + (box_w - sw2) // 2, box_y + 52), b["sub"], fill=(240, 240, 240), font=font_box_small)

    # Arrows between boxes
    arrow_y = box_y + box_h // 2
    for i in range(len(boxes) - 1):
        ax0 = boxes[i]["x"] + box_w + 5
        ax1 = boxes[i + 1]["x"] - 5
        draw_arrow(draw, (ax0, arrow_y), (ax1, arrow_y), (200, 210, 230), width=3, head_size=10)

    # Second row: Google + Output
    row2_y = 420
    boxes2 = [
        {"label": "Google Search", "sub": "AI Mode (udm=50)", "color": (66, 133, 244), "x": 340},
        {"label": "Markdown Output", "sub": "+ Citations + Thread ID", "color": (52, 168, 83), "x": 740},
    ]

    for b in boxes2:
        bx = b["x"]
        draw_rounded_rect(draw, (bx + 3, row2_y + 3, bx + box_w + 3, row2_y + box_h + 3),
                           radius=12, fill=(10, 10, 20))
        draw_rounded_rect(draw, (bx, row2_y, bx + box_w, row2_y + box_h),
                           radius=12, fill=b["color"], outline=(255, 255, 255, 60), width=1)
        lw, lh = text_bbox_size(draw, b["label"], font_box)
        draw.text((bx + (box_w - lw) // 2, row2_y + 20), b["label"], fill="white", font=font_box)
        sw2, sh2 = text_bbox_size(draw, b["sub"], font_box_small)
        draw.text((bx + (box_w - sw2) // 2, row2_y + 52), b["sub"], fill=(240, 240, 240), font=font_box_small)

    # Vertical arrow from Chrome Extension down to Google
    ext_cx = boxes[3]["x"] + box_w // 2
    draw_arrow(draw, (ext_cx, box_y + box_h + 5), (boxes2[0]["x"] + box_w, row2_y + box_h // 2),
               (200, 210, 230), width=3, head_size=10)

    # Arrow from Google to Markdown Output
    draw_arrow(draw, (boxes2[0]["x"] + box_w + 5, row2_y + box_h // 2),
               (boxes2[1]["x"] - 5, row2_y + box_h // 2),
               (200, 210, 230), width=3, head_size=10)

    # Arrow from Markdown back up to MCP Client (return path)
    md_cx = boxes2[1]["x"] + box_w // 2
    client_cx = boxes[0]["x"] + box_w // 2
    # Down from markdown output, then left, then up to client
    draw.line([(md_cx, row2_y + box_h + 5), (md_cx, row2_y + box_h + 50)], fill=(160, 200, 160), width=2)
    draw.line([(md_cx, row2_y + box_h + 50), (client_cx, row2_y + box_h + 50)], fill=(160, 200, 160), width=2)
    draw_arrow(draw, (client_cx, row2_y + box_h + 50), (client_cx, box_y + box_h + 5),
               (160, 200, 160), width=2, head_size=10)

    # Return label
    draw.text((400, row2_y + box_h + 55), "Response: markdown + citations + thread_id",
              fill=(160, 200, 160), font=font_arrow_label)

    # Feature highlights at bottom (draw bullet icons instead of emoji)
    features_y = 620
    font_feat = load_font(18)
    features = [
        ("Fully parallel \u2014 concurrent queries", (66, 133, 244)),
        ("Conversational follow-ups via threads", (52, 168, 83)),
        ("Background tabs, no focus stealing", (189, 147, 249)),
    ]
    for i, (feat, color) in enumerate(features):
        fy = features_y + i * 40
        # Draw a colored bullet dot
        draw.ellipse([160, fy + 5, 174, fy + 19], fill=color)
        draw.text((185, fy), feat, fill=(180, 190, 210), font=font_feat)

    # Bottom accent
    draw_gradient_rect(draw, (0, H - 4, W, H), (66, 133, 244), (52, 168, 83), direction="horizontal")

    img.save(os.path.join(OUTPUT_DIR, "screenshot-1-how-it-works-1280x800.png"))
    print("Created screenshot-1-how-it-works-1280x800.png")


# ============================================================
# IMAGE 3: Screenshot 2 — "Easy Setup" (1280x800)
# ============================================================

def create_screenshot_easy_setup():
    W, H = 1280, 800
    img = Image.new("RGB", (W, H), color=(30, 30, 46))
    draw = ImageDraw.Draw(img)

    font_title = load_font(48, bold=True)
    font_subtitle = load_font(22)
    font_code = load_mono_font(20)
    font_label = load_font(16)

    # Title
    title = "One Command Setup"
    tw, th = text_bbox_size(draw, title, font_title)
    draw.text(((W - tw) // 2, 40), title, fill="white", font=font_title)

    subtitle = "Add to your MCP client configuration"
    sw, sh = text_bbox_size(draw, subtitle, font_subtitle)
    draw.text(((W - sw) // 2, 100), subtitle, fill=(160, 170, 200), font=font_subtitle)

    # Code editor frame
    editor_x = 140
    editor_y = 170
    editor_w = W - 280
    editor_h = 380

    # Editor window chrome (title bar)
    draw_rounded_rect(draw, (editor_x, editor_y, editor_x + editor_w, editor_y + editor_h),
                       radius=12, fill=(40, 42, 54))
    # Title bar
    draw.rectangle([editor_x, editor_y, editor_x + editor_w, editor_y + 35], fill=(50, 52, 64))
    draw_rounded_rect(draw, (editor_x, editor_y, editor_x + editor_w, editor_y + 20),
                       radius=12, fill=(50, 52, 64))
    # Traffic lights
    draw.ellipse([editor_x + 15, editor_y + 10, editor_x + 27, editor_y + 22], fill=(255, 95, 86))
    draw.ellipse([editor_x + 35, editor_y + 10, editor_x + 47, editor_y + 22], fill=(255, 189, 46))
    draw.ellipse([editor_x + 55, editor_y + 10, editor_x + 67, editor_y + 22], fill=(39, 201, 63))
    # Filename
    draw.text((editor_x + 80, editor_y + 8), ".mcp.json", fill=(180, 180, 200), font=font_label)

    # JSON code with syntax highlighting
    code_x = editor_x + 30
    code_y = editor_y + 55
    line_h = 32

    # Color scheme (Dracula-inspired)
    C_BRACE = (248, 248, 242)       # white - braces
    C_KEY = (189, 147, 249)         # purple - keys
    C_STRING = (80, 250, 123)       # green - string values
    C_COLON = (248, 248, 242)       # white - colons
    C_LINE_NUM = (100, 100, 130)    # dim - line numbers

    lines = [
        (1, [("{", C_BRACE)]),
        (2, [('  "mcpServers"', C_KEY), (": {", C_BRACE)]),
        (3, [('    "google-ai-scraper"', C_KEY), (": {", C_BRACE)]),
        (4, [('      "command"', C_KEY), (": ", C_COLON), ('"uvx"', C_STRING), (",", C_BRACE)]),
        (5, [('      "args"', C_KEY), (": ", C_COLON), ('["google-ai-scraper"]', C_STRING)]),
        (6, [("    }", C_BRACE)]),
        (7, [("  }", C_BRACE)]),
        (8, [("}", C_BRACE)]),
    ]

    for line_num, segments in lines:
        # Line number
        draw.text((code_x - 5, code_y + (line_num - 1) * line_h),
                  str(line_num), fill=C_LINE_NUM, font=font_code, anchor="ra")
        # Code
        x_offset = code_x + 20
        for text, color in segments:
            draw.text((x_offset, code_y + (line_num - 1) * line_h), text, fill=color, font=font_code)
            tw2, _ = text_bbox_size(draw, text, font_code)
            x_offset += tw2

    # Supported clients section below the editor
    clients_y = editor_y + editor_h + 40
    font_client = load_font(18, bold=True)
    font_client_sub = load_font(16)

    draw.text(((W - text_bbox_size(draw, "Works with:", font_client)[0]) // 2, clients_y),
              "Works with:", fill=(160, 170, 200), font=font_client)

    clients = ["Claude Code", "Cursor", "Claude Desktop", "Any MCP Client"]
    total_w = sum(text_bbox_size(draw, c, font_client_sub)[0] for c in clients) + 60 * (len(clients) - 1)
    cx = (W - total_w) // 2
    for client in clients:
        cw, ch = text_bbox_size(draw, client, font_client_sub)
        # Pill background
        draw_rounded_rect(draw, (cx - 15, clients_y + 40, cx + cw + 15, clients_y + 40 + ch + 16),
                           radius=16, fill=(66, 133, 244, 80), outline=(66, 133, 244))
        draw.text((cx, clients_y + 48), client, fill="white", font=font_client_sub)
        cx += cw + 60

    # Also works via pip
    pip_y = clients_y + 110
    font_pip = load_font(18)
    pip_text = "Install:  pip install google-ai-scraper   or   uvx google-ai-scraper"
    pw, ph = text_bbox_size(draw, pip_text, font_pip)
    draw.text(((W - pw) // 2, pip_y), pip_text, fill=(120, 130, 160), font=font_pip)

    # Bottom accent
    draw_gradient_rect(draw, (0, H - 4, W, H), (66, 133, 244), (52, 168, 83), direction="horizontal")

    img.save(os.path.join(OUTPUT_DIR, "screenshot-2-easy-setup-1280x800.png"))
    print("Created screenshot-2-easy-setup-1280x800.png")


# ============================================================
# IMAGE 4: Screenshot 3 — "MCP Tools" (1280x800)
# ============================================================

def create_screenshot_mcp_tools():
    W, H = 1280, 800
    img = Image.new("RGB", (W, H), color=(26, 26, 46))
    draw = ImageDraw.Draw(img)

    font_title = load_font(48, bold=True)
    font_subtitle = load_font(22)
    font_tool_name = load_font(26, bold=True)
    font_tool_desc = load_font(18)
    font_tool_params = load_mono_font(15)

    # Title
    title = "3 MCP Tools"
    tw, th = text_bbox_size(draw, title, font_title)
    draw.text(((W - tw) // 2, 40), title, fill="white", font=font_title)

    subtitle = "Simple, powerful interface for AI agents"
    sw, sh = text_bbox_size(draw, subtitle, font_subtitle)
    draw.text(((W - sw) // 2, 100), subtitle, fill=(160, 170, 200), font=font_subtitle)

    # Three cards
    cards = [
        {
            "name": "search",
            "desc": "Search Google AI Overview",
            "details": "Returns markdown + citations\n+ thread_id for follow-ups",
            "params": "query: str",
            "color": (66, 133, 244),
            "icon_type": "search",
        },
        {
            "name": "follow_up",
            "desc": "Continue conversation",
            "details": "Reuses existing thread tab\nDelta extraction for new content",
            "params": "query: str, thread_id: str",
            "color": (52, 168, 83),
            "icon_type": "chat",
        },
        {
            "name": "health",
            "desc": "Check system status",
            "details": "Server, extension connectivity\nQueue depth, active threads",
            "params": "(no parameters)",
            "color": (251, 188, 4),
            "icon_type": "health",
        },
    ]

    card_w = 340
    card_h = 420
    card_gap = 40
    total_cards_w = card_w * 3 + card_gap * 2
    start_x = (W - total_cards_w) // 2
    card_y = 170

    for i, card in enumerate(cards):
        cx = start_x + i * (card_w + card_gap)

        # Card shadow
        draw_rounded_rect(draw, (cx + 4, card_y + 4, cx + card_w + 4, card_y + card_h + 4),
                           radius=16, fill=(10, 10, 20))
        # Card background
        draw_rounded_rect(draw, (cx, card_y, cx + card_w, card_y + card_h),
                           radius=16, fill=(40, 42, 58), outline=(60, 62, 80), width=1)
        # Color accent bar at top
        draw_rounded_rect(draw, (cx, card_y, cx + card_w, card_y + 8),
                           radius=4, fill=card["color"])

        # Icon area
        icon_cx = cx + card_w // 2
        icon_cy = card_y + 65

        if card["icon_type"] == "search":
            draw_magnifying_glass(draw, icon_cx, icon_cy, 30, card["color"], width=3)
            draw_sparkle(draw, icon_cx + 25, icon_cy - 20, 8, (255, 223, 100))
        elif card["icon_type"] == "chat":
            # Chat bubble
            draw_rounded_rect(draw, (icon_cx - 25, icon_cy - 18, icon_cx + 25, icon_cy + 12),
                               radius=10, fill=None, outline=card["color"], width=3)
            # Tail
            draw.polygon([(icon_cx - 10, icon_cy + 12), (icon_cx - 18, icon_cy + 25),
                          (icon_cx, icon_cy + 12)], fill=card["color"])
            # Dots inside
            for dx in [-12, 0, 12]:
                draw.ellipse([icon_cx + dx - 3, icon_cy - 6, icon_cx + dx + 3, icon_cy],
                             fill=card["color"])
        elif card["icon_type"] == "health":
            # Heart/pulse icon
            # Simple pulse line
            pts = [(icon_cx - 30, icon_cy), (icon_cx - 15, icon_cy),
                   (icon_cx - 8, icon_cy - 20), (icon_cx, icon_cy + 15),
                   (icon_cx + 8, icon_cy - 10), (icon_cx + 15, icon_cy),
                   (icon_cx + 30, icon_cy)]
            draw.line(pts, fill=card["color"], width=3)

        # Tool name
        name_text = card["name"]
        nw, nh = text_bbox_size(draw, name_text, font_tool_name)
        draw.text((cx + (card_w - nw) // 2, card_y + 110), name_text, fill="white", font=font_tool_name)

        # Description
        desc_text = card["desc"]
        dw, dh = text_bbox_size(draw, desc_text, font_tool_desc)
        draw.text((cx + (card_w - dw) // 2, card_y + 155), desc_text, fill=(200, 210, 230), font=font_tool_desc)

        # Separator line
        draw.line([(cx + 30, card_y + 195), (cx + card_w - 30, card_y + 195)], fill=(60, 62, 80), width=1)

        # Details
        detail_lines = card["details"].split("\n")
        for j, line in enumerate(detail_lines):
            lw, lh = text_bbox_size(draw, line, font_tool_desc)
            draw.text((cx + (card_w - lw) // 2, card_y + 215 + j * 30), line,
                      fill=(160, 170, 200), font=font_tool_desc)

        # Params box
        params_y = card_y + card_h - 70
        draw_rounded_rect(draw, (cx + 20, params_y, cx + card_w - 20, params_y + 40),
                           radius=8, fill=(30, 30, 50))
        pw2, ph2 = text_bbox_size(draw, card["params"], font_tool_params)
        draw.text((cx + (card_w - pw2) // 2, params_y + 10), card["params"],
                  fill=(189, 147, 249), font=font_tool_params)

    # Bottom accent
    draw_gradient_rect(draw, (0, H - 4, W, H), (66, 133, 244), (52, 168, 83), direction="horizontal")

    img.save(os.path.join(OUTPUT_DIR, "screenshot-3-mcp-tools-1280x800.png"))
    print("Created screenshot-3-mcp-tools-1280x800.png")


# ============================================================
# IMAGE 5: Screenshot 4 — "Features" (1280x800)
# ============================================================

def create_screenshot_features():
    W, H = 1280, 800
    img = Image.new("RGB", (W, H), color=(26, 26, 46))
    draw = ImageDraw.Draw(img)

    font_title = load_font(48, bold=True)
    font_subtitle = load_font(22)
    font_feature = load_font(24)
    font_detail = load_font(16)

    # Title
    title = "Features"
    tw, th = text_bbox_size(draw, title, font_title)
    draw.text(((W - tw) // 2, 40), title, fill="white", font=font_title)

    subtitle = "Everything you need, nothing you don't"
    sw, sh = text_bbox_size(draw, subtitle, font_subtitle)
    draw.text(((W - sw) // 2, 100), subtitle, fill=(160, 170, 200), font=font_subtitle)

    # Feature list
    features = [
        {
            "text": "No API Keys Needed",
            "detail": "Uses your existing Chrome browser session",
            "color": (52, 168, 83),
        },
        {
            "text": "Background Tabs",
            "detail": "No focus stealing \u2014 tabs open in the background",
            "color": (66, 133, 244),
        },
        {
            "text": "Conversational Follow-ups",
            "detail": "Thread-based conversations with persistent tab sessions",
            "color": (189, 147, 249),
        },
        {
            "text": "Structured Markdown Output",
            "detail": "Clean markdown with extracted citations and source links",
            "color": (255, 183, 77),
        },
        {
            "text": "Works with Any MCP Client",
            "detail": "Claude Code, Cursor, Claude Desktop, and more",
            "color": (66, 133, 244),
        },
        {
            "text": "Fully Parallel Queries",
            "detail": "Concurrent queries each get their own isolated tab",
            "color": (234, 67, 53),
        },
    ]

    list_x = 200
    list_y = 180
    item_h = 90

    for i, feat in enumerate(features):
        fy = list_y + i * item_h

        # Checkmark circle
        check_r = 18
        check_cx = list_x + check_r
        check_cy = fy + 15
        draw.ellipse([check_cx - check_r, check_cy - check_r,
                       check_cx + check_r, check_cy + check_r],
                      fill=feat["color"], outline=None)
        # White checkmark inside
        draw_checkmark(draw, check_cx - 10, check_cy - 7, 20, "white", width=3)

        # Feature text
        draw.text((list_x + 55, fy + 2), feat["text"], fill="white", font=font_feature)

        # Detail text
        draw.text((list_x + 55, fy + 35), feat["detail"], fill=(140, 150, 180), font=font_detail)

        # Subtle line separator (except last)
        if i < len(features) - 1:
            draw.line([(list_x + 55, fy + item_h - 10), (W - 200, fy + item_h - 10)],
                      fill=(40, 42, 58), width=1)

    # Right side decorative element
    # Abstract shapes suggesting data flow
    dec_x = 920
    for i in range(5):
        dy = 220 + i * 110
        w = 80 + (i % 3) * 40
        alpha_colors = [(66, 133, 244), (52, 168, 83), (189, 147, 249), (255, 183, 77), (234, 67, 53)]
        c = alpha_colors[i % len(alpha_colors)]
        draw_rounded_rect(draw, (dec_x, dy, dec_x + w, dy + 20), radius=10, fill=(*c, 60))
        draw_rounded_rect(draw, (dec_x + 20, dy + 30, dec_x + w + 50, dy + 50), radius=10, fill=(*c, 40))

    # Bottom accent
    draw_gradient_rect(draw, (0, H - 4, W, H), (66, 133, 244), (52, 168, 83), direction="horizontal")

    img.save(os.path.join(OUTPUT_DIR, "screenshot-4-features-1280x800.png"))
    print("Created screenshot-4-features-1280x800.png")


# ============================================================
# Generate all images
# ============================================================

if __name__ == "__main__":
    print(f"Output directory: {OUTPUT_DIR}")
    create_promo_tile()
    create_screenshot_how_it_works()
    create_screenshot_easy_setup()
    create_screenshot_mcp_tools()
    create_screenshot_features()
    print("\nAll images generated successfully!")
