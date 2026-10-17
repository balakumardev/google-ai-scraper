#!/usr/bin/env python3
"""Render every store graphic (icons, screenshots, promo tiles) from HTML/SVG.

Output goes to store-assets/dist and, for the icons, into both extension
packages. Needs only Google Chrome (headless) and macOS `sips`.

    python3 store-assets/build.py
"""
import json, shutil, subprocess, sys, tempfile, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC, DIST = HERE / "src", HERE / "dist"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def shot(url: str, out: Path, w: int, h: int, transparent=False):
    prof = tempfile.mkdtemp(prefix="gas-chrome-")
    cmd = [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
           "--no-first-run", f"--user-data-dir={prof}",
           "--force-device-scale-factor=1", "--allow-file-access-from-files",
           "--virtual-time-budget=4000", f"--window-size={w},{h}",
           f"--screenshot={out}", url]
    if transparent:
        cmd.insert(2, "--default-background-color=00000000")
    subprocess.run(cmd, check=True, capture_output=True)
    shutil.rmtree(prof, ignore_errors=True)
    print("wrote", out.relative_to(ROOT))


def resize(src: Path, out: Path, size: int):
    subprocess.run(["sips", "-z", str(size), str(size), str(src), "--out", str(out)],
                   check=True, capture_output=True)


def build_icons():
    wrapper = SRC / "_icon.html"
    wrapper.write_text('<body style="margin:0;background:transparent">'
                       '<img src="icon.svg" width="512" height="512" style="display:block"></body>')
    big = DIST / "icon-512.png"
    shot(wrapper.as_uri(), big, 512, 512, transparent=True)
    wrapper.unlink()
    for size in (16, 32, 48, 128):
        resize(big, DIST / f"icon-{size}.png", size)
        for pkg in ("extension", "firefox-extension"):
            shutil.copy(DIST / f"icon-{size}.png", ROOT / pkg / "icons" / f"icon{size}.png")


STUB = """<script>
const NOW = Date.now();
const acc = (i, name, email) => ({ index: i, name, email, photo: null });
const accounts = [acc(0, "Alex Morgan", "alex@example.com"),
                  acc(1, "Alex Morgan", "alex.work@example.com"),
                  acc(2, "Research", "research@example.com")];
window.chrome = { runtime: { lastError: null,
  openOptionsPage() {},
  sendMessage(msg, cb) {
    const state = { authuser: 0, accounts, selectedAccount: accounts[0],
      accountsUpdatedAt: NOW - 5 * 60000, accountsLastError: null,
      accountsStale: false, isRefreshingAccounts: false, serverUrl: "http://localhost:15551" };
    const health = { ok: true, data: { extension_status: "connected", last_poll_age_seconds: 1 } };
    setTimeout(() => cb({ ok: true, state, health }), 0);
  } } };
</script>"""


def build_popup_demo():
    html = (ROOT / "extension" / "popup.html").read_text()
    html = html.replace('href="popup.css"', 'href="../../extension/popup.css"')
    html = html.replace('src="icons/', 'src="../../extension/icons/')
    html = html.replace('<script src="popup.js"></script>',
                        STUB + '<script src="../../extension/popup.js"></script>')
    (SRC / "popup-demo.html").write_text(html)


def main():
    DIST.mkdir(exist_ok=True)
    build_icons()
    build_popup_demo()
    for i in range(1, 6):
        shot((SRC / f"s{i}.html").as_uri(), DIST / f"screenshot-{i}.png", 1280, 800)
    shot((SRC / "promo-small.html").as_uri(), DIST / "promo-small-440x280.png", 440, 280)
    shot((SRC / "promo-marquee.html").as_uri(), DIST / "promo-marquee-1400x560.png", 1400, 560)


if __name__ == "__main__":
    sys.exit(main())
