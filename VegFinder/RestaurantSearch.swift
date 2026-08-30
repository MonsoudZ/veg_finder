import CoreLocation
import Foundation

struct RestaurantResult: Identifiable {
    let restaurant: Restaurant
    let distanceMeters: CLLocationDistance
    let items: [MenuItem]

    var id: UUID { restaurant.id }
}

enum RestaurantSearch {
    static let pilotCenter = CLLocation(latitude: 39.7340, longitude: -104.9800)

    static func results(
        restaurants: [Restaurant],
        filter: DietaryFilter,
        origin: CLLocation
    ) -> [RestaurantResult] {
        restaurants.compactMap { restaurant in
            let items = restaurant.matchingItems(for: filter)
            guard !items.isEmpty else { return nil }
            return RestaurantResult(
                restaurant: restaurant,
                distanceMeters: origin.distance(from: restaurant.location),
                items: items
            )
        }
        .sorted { $0.distanceMeters < $1.distanceMeters }
    }
}
