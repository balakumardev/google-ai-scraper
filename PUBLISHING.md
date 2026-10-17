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

## Continuous publishing (what CI does on every push to `main`)

| Change under | Workflow | Result |
|---|---|---|
| `server/**` or `npm/**` | `publish.yml` | bumps the patch version, publishes to **PyPI**, then **npm** (same version) |
| `extension/**` | `publish-extension.yml` | bumps the minor version and uploads + publishes to the **Chrome Web Store** |
| `extension/**`, `firefox-extension/**` | `publish-firefox-extension.yml` | re-syncs `firefox-extension/` from `extension/`, bumps the version, lints, signs and submits to **AMO** |
| `store-assets/dist/**`, `store-assets/listing/description.txt` | `amo-listing.yml` | updates the AMO description, icon and screenshots |

Secrets: `UV_PUBLISH_TOKEN` (PyPI), `NPM_TOKEN` (npm automation token; the step is skipped with a notice when unset), `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_EXTENSION_ID` (Chrome), `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` (Firefox).

The Chrome Web Store API only uploads the package. Its listing (description, screenshots, promo tiles, permission text) is edited in the Developer Dashboard; copy from `store-assets/listing/` and upload from `store-assets/dist/`. The Chrome store also rejects an upload while an earlier version is still in review, so re-push after the review clears.

### Store graphics

Everything (icon, screenshots, promo tiles) is rendered from `store-assets/src/` by one script (needs Google Chrome and macOS `sips`):

```bash
python3 store-assets/build.py
```

It also rewrites the toolbar icons in `extension/icons/` and `firefox-extension/icons/`.

## npm (MCP launcher)

`npm/` is a thin package so `npx -y google-ai-scraper` works in MCP configs. Its `bin/cli.js` runs the same-version PyPI release via `uvx` (falling back to `pipx`). CI sets the npm version to the freshly bumped PyPI version; do not publish it by hand.

---

## Chrome Web Store (Extension)

### First-Time Setup

1. **Register as a developer** at https://chrome.google.com/webstore/devconsole
   - Pay $5 one-time fee
   - Enable 2-step verification on your Google account

2. **Prepare the ZIP:**
   ```bash
   cd extension
   zip -r ../google-ai-scraper-extension.zip . -x ".*" -x "__MACOSX/*"
   ```

### Submit

1. Go to https://chrome.google.com/webstore/devconsole
2. Click **New Item** → Upload the ZIP
3. Fill in the **Store Listing** tab:
   - Detailed description: copy from `store-assets/listing/description.txt`
   - Category: **Developer Tools**
   - Language: English
   - Screenshots: upload `store-assets/dist/screenshot-1.png` ... `screenshot-5.png` (1280x800)
   - Small promo tile: `promo-small-440x280.png`; marquee: `promo-marquee-1400x560.png`
4. Fill in the **Privacy Practices** tab:
   - Single purpose: copy from `store-assets/listing/chrome-permissions.md`
   - Permission justifications: copy from `store-assets/listing/chrome-permissions.md`
   - Data disclosures: check "I do not collect any user data"
   - Privacy policy URL: `https://github.com/balakumardev/google-ai-scraper/blob/main/docs/privacy-policy.md`
5. Fill in the **Distribution** tab:
   - Visibility: Public
   - All regions
6. Click **Submit for Review**

Review typically takes 1-3 business days.

### CI Auto-Publish (after first approval)

Once the extension is approved, future pushes to `extension/` auto-publish via GitHub Actions.

**One-time setup — get OAuth credentials:**

1. Go to https://console.cloud.google.com/ → create a project (or use existing)
2. Enable the **Chrome Web Store API**: https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com
3. Create OAuth credentials:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Authorized redirect URI: `https://developers.google.com/oauthplayground`
   - Copy the **Client ID** and **Client Secret**
4. Get a refresh token:
   - Go to https://developers.google.com/oauthplayground/
   - Click gear icon → check "Use your own OAuth credentials" → paste Client ID & Secret
   - In Step 1, enter scope: `https://www.googleapis.com/auth/chromewebstore`
   - Authorize → Exchange authorization code → copy the **Refresh Token**
5. Get your extension ID from the Chrome Web Store Developer Dashboard URL
6. Add GitHub secrets:
   ```bash
   gh secret set CWS_CLIENT_ID --body "your-client-id"
   gh secret set CWS_CLIENT_SECRET --body "your-client-secret"
   gh secret set CWS_REFRESH_TOKEN --body "your-refresh-token"
   gh secret set CWS_EXTENSION_ID --body "your-extension-id"
   ```

After this, any push to `main` that changes `extension/` will auto-bump version, ZIP, upload, and publish.

### Manual Update (alternative)

1. Bump `version` in `extension/manifest.json`
2. Re-ZIP and upload to developer console
3. Submit for review

---

## Firefox Add-ons (Extension)

### First-Time Setup

1. Create an AMO developer account at https://addons.mozilla.org/developers/
2. Create API credentials at https://addons.mozilla.org/developers/addon/api/key/
   - Save the **JWT issuer** and **JWT secret**
3. Confirm the Firefox add-on ID in `firefox-extension/manifest.json`
   - Gecko ID (must stay stable, it is the live listing): `google-ai-overview-scraper@balakumar.dev`

### Local Validation

```bash
npm install --global web-ext

# Lint
web-ext lint --source-dir firefox-extension

# Build unsigned XPI
web-ext build --source-dir firefox-extension --artifacts-dir web-ext-artifacts

# Sign + submit listed add-on
web-ext sign \
  --source-dir firefox-extension \
  --artifacts-dir web-ext-artifacts \
  --api-key YOUR_AMO_JWT_ISSUER \
  --api-secret YOUR_AMO_JWT_SECRET \
  --channel listed \
  --amo-metadata=store-assets/amo-metadata.json
```

### Listing Content

- Description: `store-assets/listing/description.txt`
- AMO metadata for `web-ext sign`: `store-assets/amo-metadata.json`
- Icon and screenshots: `store-assets/dist/`
- Push description/icon/screenshots with `python3 store-assets/amo_listing.py` (needs `AMO_JWT_ISSUER`/`AMO_JWT_SECRET`) or let `amo-listing.yml` do it.

### CI Auto-Publish

`.github/workflows/publish-firefox-extension.yml` runs on every push to `main` that touches `extension/` or `firefox-extension/`. It copies the shared sources from `extension/` into `firefox-extension/` first, so `extension/` is the single source of truth (only `firefox-extension/manifest.json` is Firefox-specific).

### Manual Update (alternative)

1. Bump `version` in `firefox-extension/manifest.json`
2. Run `web-ext lint` and `web-ext build`
3. Run `web-ext sign` with the metadata file
4. Verify the signed XPI in `web-ext-artifacts/`

---
