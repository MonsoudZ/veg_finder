import CoreLocation
import XCTest
@testable import VegFinder

final class RestaurantSearchTests: XCTestCase {
    func testVeganFilterIncludesExplicitAndSupportedModificationItems() {
        let results = RestaurantSearch.results(
            restaurants: [sampleRestaurant],
            filter: .vegan,
            origin: RestaurantSearch.pilotCenter
        )

        XCTAssertEqual(results.first?.items.map(\.dietaryStatus), [.vegan, .veganWithModification])
    }

    func testModificationFilterKeepsOnlyItemsServedForTheSelectedDiet() {
        let results = RestaurantSearch.results(
            restaurants: [sampleRestaurant],
            filter: .vegan,
            includeModifications: false,
            origin: RestaurantSearch.pilotCenter
        )

        XCTAssertEqual(results.first?.items.map(\.dietaryStatus), [.vegan])
    }

    func testModificationFilterRemovesRestaurantsWithNoAsServedMatches() {
        let modificationOnly = Restaurant(
            name: "Modification only",
            neighborhood: "Capitol Hill",
            address: "Denver",
            latitude: 39.734,
            longitude: -104.980,
            menuItems: [sampleItem(status: .veganWithModification, note: "Remove cheese")],
            verifiedAt: .now
        )

        let results = RestaurantSearch.results(
            restaurants: [modificationOnly],
            filter: .vegan,
            includeModifications: false,
            origin: RestaurantSearch.pilotCenter
        )

        XCTAssertTrue(results.isEmpty)
    }

    func testVegetarianFilterIncludesEveryDietaryStatus() {
        let items = sampleRestaurant.matchingItems(for: .vegetarian)
        XCTAssertEqual(items.count, 4)
    }

    func testResultsAreSortedByDistance() {
        let nearby = sampleRestaurant
        let farther = Restaurant(
            name: "Farther",
            neighborhood: "Capitol Hill",
            address: "Denver",
            latitude: 39.75,
            longitude: -105.00,
            menuItems: [sampleItem(status: .vegan)],
            verifiedAt: .now
        )

        let results = RestaurantSearch.results(
            restaurants: [farther, nearby],
            filter: .both,
            origin: RestaurantSearch.pilotCenter
        )
        XCTAssertEqual(results.map(\.restaurant.name), [nearby.name, farther.name])
    }

    @MainActor
    func testCatalogDecoderKeepsEveryReturnedMenuItem() throws {
        let data = Data(catalogJSON.utf8)
        let catalog = try RestaurantCatalog.decoder.decode(CatalogResponse.self, from: data)

        XCTAssertEqual(catalog.restaurants.count, 1)
        XCTAssertEqual(catalog.restaurants[0].menuItems.count, 2)
        XCTAssertEqual(catalog.restaurants[0].menuItems[1].modificationNote, "Remove cheese")
        XCTAssertEqual(catalog.restaurants[0].coverageStatus, .complete)
        XCTAssertEqual(catalog.restaurants[0].coverageScope, "All qualifying dishes")
        XCTAssertNotNil(catalog.restaurants[0].lastCheckedAt)
    }

    @MainActor
    func testCatalogDecoderTreatsAnUnknownCoverageStatusAsNeedingReview() throws {
        let catalog = try RestaurantCatalog.decoder.decode(
            CatalogResponse.self, from: Data(minimalCatalogJSON.utf8)
        )

        // A catalog that omits coverage must never be presented as audited.
        XCTAssertEqual(catalog.restaurants[0].coverageStatus, .needsReview)
        XCTAssertNil(catalog.restaurants[0].lastCheckedAt)
        XCTAssertEqual(catalog.restaurants[0].auditedAt, catalog.restaurants[0].verifiedAt)
    }

    func testCoverageStatusDisplayNamesDistinguishAuditedFromUnverified() {
        XCTAssertEqual(CatalogCoverageStatus.complete.displayName, "Official menu audited")
        XCTAssertEqual(CatalogCoverageStatus.needsReview.displayName, "Needs review")
    }

    // Xcode silently drops INFOPLIST_KEY_* settings for keys it does not recognise,
    // which once left the shipped app with no catalog endpoint at all while every
    // other test still passed. These assert the bundle wiring itself.
    func testAppBundleDeclaresAUsableCatalogEndpoint() throws {
        let value = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: "VegFinderCatalogURL") as? String,
            "the app bundle must declare VegFinderCatalogURL"
        )
        let url = try XCTUnwrap(URL(string: value), "VegFinderCatalogURL must parse as a URL")
        XCTAssertNotNil(url.host, "VegFinderCatalogURL must include a host")
        XCTAssertTrue(
            url.path.hasSuffix("/v1/catalog"),
            "expected the catalog endpoint path, got \(url.path)"
        )
    }

    func testAppBundleDeclaresTheLocationUsageDescription() throws {
        let description = Bundle.main.object(
            forInfoDictionaryKey: "NSLocationWhenInUseUsageDescription"
        ) as? String
        XCTAssertFalse(
            (description ?? "").isEmpty,
            "a missing usage description crashes the app on the first location request"
        )
    }

    // MARK: - Delta sync

    private func restaurant(
        _ name: String, id: String, lat: Double = 39.734, lon: Double = -104.980, items: Int = 1
    ) -> Restaurant {
        Restaurant(
            id: UUID(uuidString: id)!, name: name, neighborhood: "Capitol Hill", address: "Denver",
            latitude: lat, longitude: lon,
            menuItems: (0..<items).map { _ in sampleItem(status: .vegan) },
            verifiedAt: .now
        )
    }

    func testMergeReplacesAChangedRestaurantRatherThanDuplicatingIt() {
        let id = "00000000-0000-4000-8000-000000000001"
        let existing = [restaurant("Old Name", id: id)]
        let merged = CatalogMerge.apply(
            changes: [restaurant("New Name", id: id, items: 3)], to: existing,
            origin: RestaurantSearch.pilotCenter, radiusKm: 25
        )

        XCTAssertEqual(merged.count, 1, "a change to a known restaurant must not add a second copy")
        XCTAssertEqual(merged.first?.name, "New Name")
        XCTAssertEqual(merged.first?.menuItems.count, 3)
    }

    func testMergeAddsRestaurantsNotSeenBefore() {
        let merged = CatalogMerge.apply(
            changes: [restaurant("Newcomer", id: "00000000-0000-4000-8000-000000000002")],
            to: [restaurant("Known", id: "00000000-0000-4000-8000-000000000001")],
            origin: RestaurantSearch.pilotCenter, radiusKm: 25
        )
        XCTAssertEqual(merged.map(\.name), ["Known", "Newcomer"])
    }

    func testMergeDropsARestaurantWhoseItemsWereAllUnpublished() {
        // The server sends the restaurant back with an empty menu; leaving it in
        // the cache would keep an unqualified restaurant on screen forever.
        let id = "00000000-0000-4000-8000-000000000001"
        let merged = CatalogMerge.apply(
            changes: [restaurant("Gone Veg-free", id: id, items: 0)],
            to: [restaurant("Was Fine", id: id, items: 2)],
            origin: RestaurantSearch.pilotCenter, radiusKm: 25
        )
        XCTAssertTrue(merged.isEmpty)
    }

    func testMergeDropsRestaurantsOutsideTheRadius() {
        // Left over from an earlier, wider sync.
        let far = restaurant("Far Away", id: "00000000-0000-4000-8000-000000000002", lat: 41.0, lon: -104.98)
        let merged = CatalogMerge.apply(
            changes: [], to: [restaurant("Near", id: "00000000-0000-4000-8000-000000000001"), far],
            origin: RestaurantSearch.pilotCenter, radiusKm: 25
        )
        XCTAssertEqual(merged.map(\.name), ["Near"])
    }

    @MainActor
    func testCatalogURLAsksForEverythingWhenThereIsNoWatermark() throws {
        let url = try XCTUnwrap(RestaurantCatalog.catalogURL(
            base: URL(string: "https://example.com/v1/catalog"), latitude: 39.734, longitude: -104.98
        ))
        let query = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(query.first { $0.name == "lat" }?.value, "39.734")
        XCTAssertNil(query.first { $0.name == "since" }, "a first sync must not filter by time")
        XCTAssertNil(query.first { $0.name == "cursor" })
    }

    @MainActor
    func testCatalogURLCarriesTheWatermarkAndCursorWhenSyncingChanges() throws {
        let since = Date(timeIntervalSince1970: 1_788_000_000.25)
        let url = try XCTUnwrap(RestaurantCatalog.catalogURL(
            base: URL(string: "https://example.com/v1/catalog"), latitude: 39.734, longitude: -104.98,
            since: since, cursor: "abc123"
        ))
        let query = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        let sent = try XCTUnwrap(query.first { $0.name == "since" }?.value)
        XCTAssertEqual(query.first { $0.name == "cursor" }?.value, "abc123")
        // The server compares timestamps, so a lossy format would lose updates.
        XCTAssertTrue(sent.contains(".250"), "the watermark must keep sub-second precision, got \(sent)")
        XCTAssertEqual(
            try XCTUnwrap(RestaurantCatalog.decoder.decode(
                [Date].self, from: Data("[\"\(sent)\"]".utf8)
            ).first).timeIntervalSince1970,
            since.timeIntervalSince1970, accuracy: 0.001,
            "the watermark must survive the round trip it will be compared against"
        )
    }

    @MainActor
    func testCachedSnapshotSurvivesARoundTrip() throws {
        // A snapshot that cannot be read back means every launch is a full sync.
        let snapshot = CatalogSnapshot(
            syncedAt: Date(timeIntervalSince1970: 1_788_000_000.5),
            latitude: 39.734, longitude: -104.98,
            restaurants: [restaurant("Cached", id: "00000000-0000-4000-8000-000000000001", items: 2)]
        )
        let data = try RestaurantCatalog.encoder.encode(snapshot)
        let restored = try RestaurantCatalog.decoder.decode(CatalogSnapshot.self, from: data)

        XCTAssertEqual(restored.restaurants.map(\.name), ["Cached"])
        XCTAssertEqual(restored.restaurants.first?.menuItems.count, 2)
        XCTAssertEqual(restored.latitude, 39.734)
        XCTAssertEqual(
            try XCTUnwrap(restored.syncedAt).timeIntervalSince1970,
            1_788_000_000.5, accuracy: 0.001
        )
    }

    @MainActor
    func testAnUnsyncedCatalogNeverClaimsToCoverAPlace() {
        let catalog = RestaurantCatalog(
            endpoint: URL(string: "http://127.0.0.1:1/v1/catalog"),
            cacheURL: FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString + ".json")
        )
        // Before anything has synced, a location fix must still trigger a fetch.
        XCTAssertFalse(catalog.alreadyCovers(latitude: 39.7340, longitude: -104.9800))
    }

    private var minimalCatalogJSON: String {
        """
        {
          "generatedAt": "2026-08-29T12:00:00.000Z",
          "restaurants": [{
            "id": "00000000-0000-4000-8000-000000000002",
            "name": "Sparse",
            "neighborhood": "Capitol Hill",
            "address": "Denver",
            "latitude": 39.734,
            "longitude": -104.980,
            "verifiedAt": "2026-08-29T12:00:00.000Z",
            "menuItems": []
          }]
        }
        """
    }

    private var sampleRestaurant: Restaurant {
        Restaurant(
            name: "Sample",
            neighborhood: "Capitol Hill",
            address: "Denver",
            latitude: 39.734,
            longitude: -104.980,
            menuItems: [
                sampleItem(status: .vegan),
                sampleItem(status: .veganWithModification, note: "Remove cheese"),
                sampleItem(status: .vegetarian),
                sampleItem(status: .vegetarianWithModification, note: "Remove meat")
            ],
            verifiedAt: .now
        )
    }

    private func sampleItem(status: DietaryStatus, note: String? = nil) -> MenuItem {
        MenuItem(
            name: status.rawValue,
            description: "Description",
            price: "$10",
            dietaryStatus: status,
            modificationNote: note
        )
    }

    private var catalogJSON: String {
        """
        {
          "generatedAt": "2026-08-29T12:00:00.000Z",
          "restaurants": [{
            "id": "00000000-0000-4000-8000-000000000001",
            "name": "Restaurant",
            "neighborhood": "Capitol Hill",
            "address": "Denver",
            "latitude": 39.734,
            "longitude": -104.980,
            "verifiedAt": "2026-08-29T12:00:00.000Z",
            "auditedAt": "2026-08-29T12:00:00.000Z",
            "lastCheckedAt": "2026-08-30T12:00:00.000Z",
            "coverageStatus": "Complete",
            "coverageScope": "All qualifying dishes",
            "menuURL": "https://example.com/menu",
            "menuItems": [
              {
                "id": "10000000-0000-4000-8000-000000000001",
                "name": "Vegan Bowl",
                "description": "A bowl",
                "price": "$12",
                "dietaryStatus": "Vegan",
                "modificationNote": null
              },
              {
                "id": "10000000-0000-4000-8000-000000000002",
                "name": "Tacos",
                "description": "Three tacos",
                "price": "$13",
                "dietaryStatus": "Can be made vegan",
                "modificationNote": "Remove cheese"
              }
            ]
          }]
        }
        """
    }
}
