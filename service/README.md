# VegFinder catalog service

This service is the source of restaurant and menu data for the iPhone app.

## Data contract

`GET /v1/catalog` returns published restaurants and their qualifying menu items in
pages. Dietary status is one of:

- `Vegan`
- `Vegetarian`
- `Can be made vegan`
- `Can be made vegetarian`

Modified items must include `modificationNote`. Each database item also stores source evidence, although evidence is not exposed in the public response yet.

### Query modes

Every response is `{ generatedAt, syncedAt, restaurants, nextCursor }`.

| Mode | Parameters | Behaviour |
| --- | --- | --- |
| Nearby | `lat`, `lon`, `radiusKm` (default 25), `limit` | Restaurants inside the radius, nearest first. What the iPhone app uses. |
| Delta | `since` (ISO-8601), `limit`, `cursor` | Whole restaurant records changed since that watermark. |
| Paged | `limit` (default 100, max 500), `cursor` | Every restaurant by name. |

The restaurant is the unit of synchronisation: any change to it or to its menu
items advances its `updatedAt`. A client stores the `syncedAt` it was given and
passes it back as `since` to fetch only what changed. Follow `nextCursor` until it
is null; cursors are opaque and an unreadable one restarts from the beginning.

`since` and the nearby parameters combine: `?since=…&lat=…&lon=…&radiusKm=…` is
"what changed near me", paged by cursor. Distance ranking cannot be paged — it
reads the whole bounding box — so a delta is ordered by `updatedAt` and the radius
is applied as a filter, which keeps the cursor meaningful. `syncedAt` is the
newest record the page examined, not the last one listed; a watermark taken from
the wrong ordering would skip past changes the client never received.

The iPhone app uses this: a first run fetches the radius in full, and every later
launch sends `since`. On the pilot catalog that is 20,865 bytes once, then 115
bytes per launch when nothing has changed.

Nearby queries prefilter with a bounding box in SQL and then rank by true
distance, so `radiusKm` is exact rather than a box approximation.

## Restaurants with no menu online

Plenty of restaurants publish no menu — paper only, a chalkboard, a phone number.
They are entered with `verificationMethod` instead of a `menuURL`:

| `verificationMethod` | Meaning | Checked how |
| --- | --- | --- |
| `official_url` (default) | A menu page we can fetch | Fingerprinted every cycle |
| `menu_document` | A PDF or image menu at a URL | **Both** — fingerprinted *and* age clock |
| `menu_photo` | Photographed menu | Age clock |
| `phone` | Confirmed by phone | Age clock |
| `in_person` | Confirmed on a visit | Age clock |

`menu_document` is the one source that gets both checks, and it is worth being
precise about why. Its bytes fingerprint perfectly well, so an edit to the PDF is
caught like any other menu change. What no fingerprint can do is notice that a
dish was already wrong when it was written down — and these items were written
down by a person, because nothing can read them. So it carries the age clock too.
It keeps its `checkURL`, unlike the three methods below it.

Hudson Hill is the pilot's example, and it is a good argument for the category.
Its PDF *does* publish a legend (`V - Vegan, VG - Vegetarian, GF - Gluten Free`)
and marks about nine dishes with it, but the file has no usable text layer: the
embedded ToUnicode map renders every `b` as `i`, so extraction reads "Bourion"
for "Bourbon", and most prices cannot be recovered at all. A menu can be
perfectly well labelled and still be unreadable by anything but a person.

`menuURL` is required only for `official_url`. The other three record a human
observation the checker cannot re-verify, so instead of being skipped — which
would leave them published and unexamined forever — they are re-queued for review
once their audit passes `OFFLINE_REVIEW_DAYS` (default 90). Re-auditing clears
them, and the alert names them under "Re-verification due".

## Editing the catalog

The database is the source of truth. `data/catalog.seed.json` only bootstraps an
empty database and backs the tests; it is not where ongoing edits belong.

Both endpoints require `Authorization: Bearer $INTERNAL_API_TOKEN` and return 404
without it, so an unauthenticated caller cannot tell they exist.

The seed is authoritative for `menuProfile` and `verificationMethod` on the
restaurants it contains, the same way it already is for their addresses and menu
URLs. Restaurants created through the admin API and never added to the seed are
untouched by seeding.

`POST /internal/restaurants` creates or updates a restaurant. `menuProfile` is the
operator's assertion about the whole menu — `unknown` (default), `fully_vegan`,
`fully_vegetarian`, or `manual`; see tiered extraction above. `claimURL` is
optional and names a page where the restaurant declares its whole menu vegan or
vegetarian, for the common case where that declaration is not on the menu page. A new one is
deliberately unaudited: it is stored with coverage `Needs review`, no published
items, and a place in the review queue. It cannot appear in the app until its menu
has been reconciled.

```sh
curl -X POST "$BASE/internal/restaurants" \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H 'content-type: application/json' \
  -d '{"id":"<uuid>","name":"Example","neighborhood":"Capitol Hill",
       "address":"100 E Colfax Ave","latitude":39.7402,"longitude":-104.9847,
       "menuURL":"https://example.com/menu"}'
```

`POST /internal/restaurants/:id/reconcile` publishes an audited menu. This is the
one operation that advances `auditedAt`, so reconciling is what clears a review
the checker raised, restores coverage, and clears any recorded check error.
Publishing an empty menu unpublishes everything for that restaurant.

```sh
curl -X POST "$BASE/internal/restaurants/<uuid>/reconcile" \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H 'content-type: application/json' \
  -d '{"coverageStatus":"Complete","coverageScope":"All qualifying dishes",
       "menuItems":[{"id":"<uuid>","name":"Chana Bowl","description":"Chickpeas",
                     "price":"$12","dietaryStatus":"Vegan",
                     "sourceEvidence":"Menu marks this VG"}]}'
```

Input is validated before anything is stored: ids must be UUIDs, a
`Can be made ...` item must carry a `modificationNote`, an unmodified item must
not, and every item needs `sourceEvidence`. Invalid input returns 422 listing each
problem.

Production uses PostgreSQL whenever `DATABASE_URL` is set. With no `DATABASE_URL`, the service uses SQLite for local development and tests. PostgreSQL retains item versions, source snapshots, and every check run; SQLite implements the same contract for zero-setup development.

## Tiered extraction

Auditing every menu by hand does not scale past a few hundred restaurants, so
`npm run propose` drafts menus from official sources. It only ever restates a
claim the restaurant already makes. Two things count as such a claim:

| Tier | The restaurant's claim | Publishes without review |
| --- | --- | --- |
| `fully_vegan` | The whole menu is vegan | Yes, by default — unless the claim came from a `claimURL` |
| `fully_vegetarian` | The whole menu is meat-free | Yes, by default — unless the claim came from a `claimURL` |
| `labelled_menu` | The menu marks a dish, *and* publishes a legend defining that mark | Only if enabled |
| `llm_assisted` | Neither — a model drafts, a person confirms | **Never** |
| `manual` | Neither, and no model configured | Never |

Nothing is inferred from a dish name or its ingredients. "Veggie Burger",
"garden salad" and "contains no meat" are not evidence. A marker such as `(V)` is
interpreted **only** when the same page defines it, because `V` means vegan on
some menus and vegetarian on others; a menu that defines one symbol two ways
defines nothing usable. Every proposed item carries the exact source line as its
evidence, so a reviewer can check it without refetching.

A whole-menu claim is only read when it is unconditional. City, O' City's menu
says `EVERYTHING is vegan unless you choose dairy mozzarella or egg` — a true
statement with a carve-out, and the carve-out is the whole point: six of its
pizzas are vegan only if the diner picks the right cheese. Broadening the claim
patterns to match "everything is vegan" would swallow the `unless` and publish
those six as `Vegan`. They are `Can be made vegan`, each with the instruction
attached, and that distinction is a human's to make.

Extraction never proposes a `Can be made ...` status. Those dishes need a specific
instruction to the diner, and inventing that instruction is exactly the inference
this pipeline refuses to make, so they stay human work.

### Claims that are not on the menu page

A restaurant whose whole menu is vegan usually says so on its home or about page
and lets the menu just list food. The Cake Bar is the pilot's example: 32 baked
goods, not one use of the word "vegan" on the menu page, and `Denver's Favorite
Vegan Bakery` on the home page. Reading only the menu missed the single
highest-confidence claim on the site and left the whole restaurant as hand work.

`claimURL` on a restaurant names the page carrying that claim. It is read for a
whole-menu claim and nothing else — never for dishes, prices, or per-dish
labelling.

```json
{ "menuURL": "https://thecakebardenver.com/menu/",
  "claimURL": "https://www.thecakebardenver.com/" }
```

A claim found this way **does not publish without review**, unlike one printed
on the menu itself. The reason is specific: a claim on the menu is self-evidently
about that menu, while a claim on another page is about *some* business and not
always this one. City, O' City's about page calls Watercourse Foods "a fully
plant-based scratch kitchen" — true, and about a different, sister restaurant.
Read as City, O' City's own claim it would publish `Vegan` across a menu that
serves dairy. So a linked claim drafts every dish and waits for one confirmation,
which covers the entire menu at one click rather than one per dish.

The matched sentence is quoted verbatim in the proposal's reasons, so whoever
confirms it is looking at the restaurant's own words. If the claim page stops
resolving, the restaurant falls back to whatever its menu says alone — less
coverage, never a wrong claim — and the failure is reported rather than being
indistinguishable from a restaurant that never made a claim.

### Sources that cannot be read as text

A PDF or image menu still gets change detection: its fingerprint is taken over
the whole file, so an edit is noticed. It cannot be extracted, because there is
no text to read, and the proposal says exactly that instead of reporting a
missing dietary legend. Hudson Hill is the pilot's example. Those menus are
recorded by a person; see **Restaurants with no menu online** above.

### Hand-drafted menus

`npm run load-drafts` loads hand-written drafts from `data/drafts/*.json` through
the same gate a model's draft goes through: every entry carries a quote, each
restaurant's live page is re-fetched, and any entry whose quote is not on the
page is discarded rather than trusted. It exists because a menu with no legend
and no whole-menu claim is out of reach of every automatic tier, and on the
Capitol Hill pilot that is a third of the restaurants. Nothing it loads
publishes; it fills the review queue.

```sh
npm run load-drafts                          # the default drafts file
npm run load-drafts -- data/drafts/other.json
```

A `menu_document` restaurant has no fetchable text to check quotes against, so
its drafts may instead carry a `transcript` — the transcription a person made
from the document — and evidence is checked against that. This is weaker than
checking a live page, so it is refused for any other verification method;
otherwise a transcript would be a way to smuggle unverifiable claims past the
guard for a menu that is perfectly readable. The transcription does not go stale
in silence: the document is still fingerprinted every cycle, so an edit to it
demotes the restaurant and sends the transcription back to a person.

### Model-assisted drafting

Most menus publish no legend, and a human reading each one is what caps the
catalog at a few hundred restaurants. When `ANTHROPIC_API_KEY` is set, those
menus go to `claude-opus-5` (override with `EXTRACTION_MODEL`), which drafts
qualifying dishes for a person to confirm.

Every drafted item must quote the menu **verbatim**, and every quote is checked
against the fetched page before the draft exists. A quote that is not in the
source is discarded automatically — so a fabricated dish, or a real dish with an
invented justification, never reaches a reviewer. Verification normalises
whitespace and dash and quote characters, because HTML rendering changes those;
it does not tolerate a changed word.

`llm_assisted` is **never publishable**. Listing it in `AUTO_PUBLISH_TIERS` logs
a warning and is ignored — a model reading an unlabelled menu is inferring, and
inference does not publish here.

Cost scales with menus, not restaurants: the system prompt is cached, so a batch
pays for it once per five-minute window. Budget roughly a few cents per menu at
Claude Opus 5 rates. Without a key, unlabelled menus fall through to `manual`
exactly as before.

`AUTO_PUBLISH_TIERS` controls what may publish unreviewed. It defaults to
`fully_vegan,fully_vegetarian` — both are whole-restaurant facts an operator
records via `menuProfile`, not judgements the extractor makes, so no per-dish
decision is left open. A fully vegetarian restaurant is meat-free but not
dairy-free, so its dishes publish as `Vegetarian`. Setting `menuProfile` to `manual` opts a restaurant out of
automated extraction entirely. Set `AUTO_PUBLISH_TIERS=` to make everything a
proposal.

```sh
npm run propose                                        # draft menus for everything in the queue
AUTO_PUBLISH_TIERS=fully_vegan,labelled_menu npm run propose
```

`POST /internal/restaurants/:id/propose` runs the same extraction for one
restaurant and returns the tier, the reasons, and the drafted items. When the tier
is not configured to publish, nothing is written and the response is a draft to
review and send back to `/reconcile`.

## Reviewing drafts

Anything a tier could not publish on its own is stored rather than returned and
forgotten, so drafting and reviewing can happen days apart — which matters most
for the model tier, where re-drafting costs money.

`GET /review` serves the review page. It holds no data and no secret: it asks for
`INTERNAL_API_TOKEN` once and fetches everything through the authenticated
endpoints, which still return 404 without it.

A reviewer sees, per restaurant, the drafts awaiting a decision — each with the
verbatim menu line it came from — beside what is currently published. Accept or
reject each draft, untick any published item that should go, and publish. A draft
naming a dish that is already live is marked, so nobody re-decides settled work.

Publishing sends the kept and accepted items to `/reconcile`, which is what makes
the audit timestamp advance and clears the review. Decisions are recorded: a
proposal can be decided once, and a later re-draft replaces what is still pending
while leaving earlier decisions as history.

| Endpoint | Purpose |
| --- | --- |
| `GET /internal/proposals?status=&restaurantId=` | Drafts, filterable |
| `POST /internal/proposals/:id/decision` | `{"status":"accepted"\|"rejected","note":"…"}`; 409 if already decided |
| `POST /internal/restaurants/:id/reconcile` | Publish the reviewed menu |

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

## Configuration

Every entry point loads `service/.env` when it is there, so the variables
documented in `.env.example` work without exporting anything. The file is
gitignored; copy `.env.example` and fill it in.

The test suite deliberately does **not** load it. Tests that read configuration
from the environment stop testing the code and start testing the machine — and
with a real `ANTHROPIC_API_KEY` present, a test reaching the model tier would
make a billable call. Nothing outside an entry point reads `process.env`: the
model client and the publish policy are passed in.

## Local development

```sh
npm install
npm run seed
npm start
```

This creates `data/vegfinder.sqlite` and imports the seed because the database is
empty. Run `npm test` for the SQLite suite; set `TEST_DATABASE_URL` to also run the
PostgreSQL suite.

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
