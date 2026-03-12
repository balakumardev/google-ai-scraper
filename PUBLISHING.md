# Publishing Guide

## PyPI (MCP Server)

### First-Time Setup

1. **Create a PyPI account** at https://pypi.org/account/register/
2. **Enable 2FA** (required for new projects)
3. **Create an API token:**
   - Go to https://pypi.org/manage/account/token/
   - Token name: `google-ai-scraper`
   - Scope: `Entire account` (first time), then scope to this project after first upload
   - Copy the token (starts with `pypi-`)

### Publish

```bash
cd server

# Build
uv build

# Publish (paste token when prompted, or use --token flag)
uv publish --token pypi-YOUR_TOKEN_HERE

# Or set as env var
export UV_PUBLISH_TOKEN=pypi-YOUR_TOKEN_HERE
uv publish
```

### Verify

```bash
# Install from PyPI in a clean env
uvx google-ai-scraper --help

# Or test the health endpoint
uvx google-ai-scraper &
sleep 2
curl -s http://localhost:15551/health
kill %1
```

### Version Bumps

1. Update version in `server/google_ai_scraper/__init__.py`
2. Update version in `server/pyproject.toml`
3. `cd server && uv build && uv publish`

---

## Chrome Web Store (Extension)

### First-Time Setup

1. **Register as a developer** at https://chrome.google.com/webstore/devconsole
   - Pay $5 one-time fee
   - Enable 2-step verification on your Google account

2. **Prepare the ZIP:**
   ```bash
   cd extension
   zip -r ../chrome-store-assets/google-ai-scraper-extension.zip . \
     -x ".*" -x "__MACOSX/*"
   ```

### Submit

1. Go to https://chrome.google.com/webstore/devconsole
2. Click **New Item** → Upload the ZIP
3. Fill in the **Store Listing** tab:
   - Detailed description: copy from `chrome-store-listing.md`
   - Category: **Developer Tools**
   - Language: English
   - Screenshots: upload from `chrome-store-assets/` (1280x800 PNGs)
   - Small promo tile: upload `promo-tile-440x280.png`
4. Fill in the **Privacy Practices** tab:
   - Single purpose: copy from `chrome-store-listing.md`
   - Permission justifications: copy from `chrome-store-listing.md`
   - Data disclosures: check "I do not collect any user data"
   - Privacy policy URL: `https://github.com/balakumardev/google-ai-scraper/blob/main/docs/privacy-policy.md`
5. Fill in the **Distribution** tab:
   - Visibility: Public
   - All regions
6. Click **Submit for Review**

Review typically takes 1-3 business days.

### Update Extension

1. Bump `version` in `extension/manifest.json`
2. Re-ZIP and upload to developer console
3. Submit for review

---

## All CWS Listing Text

All text content (description, permission justifications, etc.) is pre-written in:
**`chrome-store-listing.md`** — copy/paste directly into the Chrome Web Store dashboard.

All images are in:
**`chrome-store-assets/`** — upload directly.
