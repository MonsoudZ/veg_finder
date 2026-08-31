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
