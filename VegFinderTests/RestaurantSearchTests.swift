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
