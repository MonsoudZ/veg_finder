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

Step 4 is enforced by the seed import, not by convention. A restaurant's `auditedAt`
advancing past the stored value is the operator's record that the menu was actually
reconciled, and it is the only thing that clears a review: it restores the seed's
`coverageStatus`, drops the restaurant from the review queue, and clears any recorded
check error. Re-running `npm run seed` with an unchanged `auditedAt` therefore cannot
re-publish a restaurant the checker demoted. A seed may always demote in the other
direction — setting `coverageStatus` to `Needs review` takes effect immediately and
queues the restaurant for review.

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

## Review alerts

Set `ALERT_WEBHOOK_URL` to a Slack or Discord incoming webhook, or any endpoint
accepting a JSON POST. After every check cycle the service posts a summary naming
the restaurants whose official menu changed or whose source was unreachable, plus
anything still sitting unreconciled from an earlier cycle. The body carries `text`
(what Slack renders), `content` (what Discord renders), and structured
`changed`/`failed`/`reviewQueueSize` fields for anything else.

A clean cycle over an empty review queue sends nothing. A webhook that is
unreachable or returns an error is logged and never fails the check cycle. If the
variable is unset the service says so at startup, because the review queue then has
to be polled by hand and a demoted restaurant can otherwise sit unnoticed.

```sh
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/... npm run check
```

Set `INTERNAL_API_TOKEN` to a long random value. The review queue is unavailable when no token is configured and otherwise requires `Authorization: Bearer <token>`. Public catalog responses may be cached for five minutes; internal responses are always `no-store`. The `/health` endpoint verifies database connectivity.

## Production container

The container includes Chromium and runs the API on port 8787. Pass the managed PostgreSQL connection string as `DATABASE_URL`.

```sh
docker build -t vegfinder-catalog .
docker run -p 8787:8787 -e DATABASE_URL="$DATABASE_URL" vegfinder-catalog
```

Point the production iOS configuration at the deployed HTTPS `/v1/catalog` URL. The checked-in project setting remains localhost-only for development.

## Deploy to Railway

Deploy the `service` directory as one persistent Railway service and add Railway PostgreSQL to the same project. The container starts the API, applies migrations, imports the audited seed when the database is empty, and checks official menu sources every 24 hours. A PostgreSQL advisory lock prevents duplicate checks if deployments briefly overlap.

For a GitHub deployment:

1. Create a Railway project and add PostgreSQL.
2. Add this GitHub repository as a service and set its root directory to `/service`.
3. Add `DATABASE_URL=${{Postgres.DATABASE_URL}}` as a reference variable on the API service. Keep the database private; the API can reach it over Railway's project network.
4. Set `ALERT_WEBHOOK_URL` to the webhook that should receive review alerts, then
   generate a long random `INTERNAL_API_TOKEN` and seal it. This enables the protected review queue without exposing the token in the dashboard after creation.
5. Generate a public Railway domain for the API service.
6. Confirm `GET /health` returns `200` and `GET /v1/catalog` returns the seeded restaurants and full item lists.
7. Point the iOS app at the assigned HTTPS `/v1/catalog` URL. The app reads the
   `VegFinderCatalogURL` Info.plist key, set from `INFOPLIST_KEY_VegFinderCatalogURL`
   in `project.yml`; the checked-in value is localhost, so a release build must
   override it. `VEGFINDER_CATALOG_URL` in the scheme environment overrides it for
   local runs.

Railway injects `PORT`; the image already listens on it at `0.0.0.0`. Do not attach a volume to the API or expose PostgreSQL publicly. Persistent catalog state belongs in PostgreSQL, while the API container remains disposable.
