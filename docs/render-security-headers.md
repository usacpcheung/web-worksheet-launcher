# Worksheet Render Route Security Headers (`/worksheet/render.html`)

This document defines deployment headers for the popup renderer delivery path:

- HTML route: `server/worksheet_launcher/render.html`
- Static assets required by that route:
  - `server/worksheet_launcher/render.js`
  - `server/worksheet_launcher/render.css`
  - `server/worksheet_launcher/widgets/rewrite-widget.js`
  - `server/worksheet_launcher/widgets/rewrite-widget.css`

## Recommended response headers

Apply these headers on the `render.html` response (and optionally on static assets where applicable).

### 1) Content-Security-Policy

Recommended baseline for current implementation:

```http
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; upgrade-insecure-requests
```

Notes:

- `script-src 'self'` allows:
  - `render.js`
  - `widgets/rewrite-widget.js`
- `style-src 'self'` allows:
  - `render.css`
  - `widgets/rewrite-widget.css`
- `style-src 'unsafe-inline'` is a temporary exception required by the current widget implementation because `rewrite-widget.js` injects a runtime `<style>` block into the document.
- `connect-src 'self'` permits same-origin model status/rewrite API calls used by the rewrite widget.
- `frame-ancestors 'none'` blocks framing by other origins (recommended for popup route).

### 2) X-Frame-Options (legacy compatibility)

```http
X-Frame-Options: DENY
```

### 3) X-Content-Type-Options

```http
X-Content-Type-Options: nosniff
```

### 4) Referrer-Policy

```http
Referrer-Policy: no-referrer
```

### 5) Permissions-Policy

```http
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()
```

## Inline exception strategy (nonce/hash)

Current `render.html` has no inline `<script>` or `<style>` blocks.

If an inline script/style exception is introduced later, do not add broad `unsafe-inline` to `script-src`.
Use one of:

1. **Nonce-based policy** (`script-src 'self' 'nonce-<random>'`) and set the same nonce on the inline tag.
2. **Hash-based policy** (`script-src 'self' 'sha256-...'`) for stable, short inline snippets.

For styles, prefer moving CSS to external files. If inline style is unavoidable, use a nonce/hash where possible.
Keep `style-src 'unsafe-inline'` only as long as the shared widget requires runtime style injection.

## Validation checklist

When updating CSP for this route, verify all of the following still load and function:

- `render.js` executes.
- `widgets/rewrite-widget.js` executes.
- `render.css` and `widgets/rewrite-widget.css` load.
- Rewrite widget renders in `#rw_host_0`.
- `GET /api/rewrite-bridge/model-status` and `POST /api/rewrite-bridge/rewrite` are not blocked by CSP `connect-src`.
