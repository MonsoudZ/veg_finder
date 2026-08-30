# VegFinder catalog service

This service is the source of restaurant and menu data for the iPhone app.

## Data contract

`GET /v1/catalog` returns every published restaurant and all of its qualifying menu items. Dietary status is one of:

- `Vegan`
- `Vegetarian`
- `Can be made vegan`
- `Can be made vegetarian`

Modified items must include `modificationNote`. Each database item also stores source evidence, although evidence is not exposed in the public response yet.

Production uses PostgreSQL whenever `DATABASE_URL` is set. With no `DATABASE_URL`, the service uses SQLite for local development and tests. PostgreSQL retains item versions, source snapshots, and every check run; SQLite implements the same contract for zero-setup development.

## Verification workflow

1. `npm run check` fetches every official source and records a normalized SHA-256 fingerprint.
2. A changed or unreachable source sets public coverage to `Needs review` and queues review rather than overwriting verified items.
3. An operator or a high-confidence source adapter reconciles the complete menu against the source.
4. Only after reconciliation are items published, coverage returns to `Complete`, and the audit timestamps advance.

The API exposes separate `auditedAt` and `lastCheckedAt` values. An audit means the qualifying items were reconciled; a source check only means the official page was reachable and whether its fingerprint changed.

This avoids relying on user reports while also avoiding unsafe guesses from ingredient names. Sources marked `browser_required` run through headless Chrome or Chromium. Set `BROWSER_EXECUTABLE` when the browser is not in its default location.

## Local development

```sh
npm install
npm run seed
npm start
```

This creates `data/vegfinder.sqlite`. Run `npm test` for the SQLite suite.

## PostgreSQL production

Create a database, set `DATABASE_URL`, apply the schema, then import the audited seed:

```sh
export DATABASE_URL=postgresql://user:password@host:5432/vegfinder
npm run migrate
npm run seed
npm start
```

If the provider requires TLS, use its supplied connection string or append its required `sslmode` setting; do not disable certificate verification unless the provider explicitly documents that configuration.

Migrations also run safely at service startup. Scheduled checks use a PostgreSQL advisory lock, so only one replica performs a check cycle.

Set `INTERNAL_API_TOKEN` to a long random value. The review queue is unavailable when no token is configured and otherwise requires `Authorization: Bearer <token>`. Public catalog responses may be cached for five minutes; internal responses are always `no-store`. The `/health` endpoint verifies database connectivity.

## Production container

The container includes Chromium, runs the API on port 8787, and checks menus every 24 hours. Pass the managed PostgreSQL connection string as `DATABASE_URL`.

```sh
docker build -t vegfinder-catalog .
docker run -p 8787:8787 -e DATABASE_URL="$DATABASE_URL" vegfinder-catalog
```

Point the production iOS configuration at the deployed HTTPS `/v1/catalog` URL. The checked-in project setting remains localhost-only for development.
