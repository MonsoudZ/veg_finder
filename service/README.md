# VegFinder catalog service

This service is the source of restaurant and menu data for the iPhone app.

## Data contract

`GET /v1/catalog` returns every published restaurant and all of its qualifying menu items. Dietary status is one of:

- `Vegan`
- `Vegetarian`
- `Can be made vegan`
- `Can be made vegetarian`

Modified items must include `modificationNote`. Each database item also stores source evidence, although evidence is not exposed in the public response yet.

## Verification workflow

1. `npm run check` fetches every official source and records a normalized SHA-256 fingerprint.
2. A changed or unreachable source sets public coverage to `Needs review` and queues review rather than overwriting verified items.
3. An operator or a high-confidence source adapter reconciles the complete menu against the source.
4. Only after reconciliation are items published, coverage returns to `Complete`, and the audit timestamps advance.

This avoids relying on user reports while also avoiding unsafe guesses from ingredient names. Sources marked `browser_required` run through headless Chrome or Chromium. Set `BROWSER_EXECUTABLE` when the browser is not in its default location.

## Production container

The container includes Chromium, runs the API on port 8787, and checks menus every 24 hours. Mount persistent storage at `/data` so the source fingerprints and review queue survive deploys.

```sh
docker build -t vegfinder-catalog .
docker run -p 8787:8787 -v vegfinder-data:/data vegfinder-catalog
```

Point the production iOS configuration at the deployed HTTPS `/v1/catalog` URL. The checked-in project setting remains localhost-only for development.
