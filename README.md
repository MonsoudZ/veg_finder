# VegFinder

A focused SwiftUI MVP for finding nearby vegan and vegetarian meals in Denver.

The first version intentionally does only three things:

1. Shows nearby restaurants.
2. Filters by vegan or vegetarian.
3. Shows the menu items that qualify.

Restaurant and menu records are loaded from the catalog API; none are compiled into the iPhone app. The app caches the last successful catalog so a temporary outage does not erase already-loaded results. The initial catalog contains 10 Capitol Hill restaurants and links every record to the restaurant's own menu or ordering page.

The production service uses PostgreSQL for catalog data, item-version history, source snapshots, and menu-check history. SQLite remains the zero-setup local and test database.

## Run

Open `VegFinder.xcodeproj` in Xcode, select an iPhone simulator, and run the `VegFinder` scheme.

Start the local catalog first:

```sh
cd service
npm run seed
npm start
```

The app uses `http://localhost:8787/v1/catalog` in development. Set the `VEGFINDER_CATALOG_URL` launch environment variable to override it.

Run the official-source change checker with:

```sh
cd service
npm run check
```

The checker fingerprints official menu sources. A changed or unreachable source immediately changes its public coverage badge to `Needs review` and enters the internal review queue; it is not silently published as verified food data. JavaScript ordering pages are rendered with headless Chrome or Chromium; set `BROWSER_EXECUTABLE` on a host where it is not in the default location.

Regenerate the project after changing `project.yml`:

```sh
xcodegen generate
```
