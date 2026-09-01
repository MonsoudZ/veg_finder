import CoreLocation
import Foundation

enum DietaryStatus: String, Codable, CaseIterable, Hashable {
    case vegan = "Vegan"
    case vegetarian = "Vegetarian"
    case veganWithModification = "Can be made vegan"
    case vegetarianWithModification = "Can be made vegetarian"

    var requiresModification: Bool {
        switch self {
        case .vegan, .vegetarian:
            return false
        case .veganWithModification, .vegetarianWithModification:
            return true
        }
    }
}

enum DietaryFilter: String, CaseIterable, Identifiable {
    case both = "All"
    case vegan = "Vegan"
    case vegetarian = "Vegetarian"

    var id: Self { self }

    func includes(_ status: DietaryStatus) -> Bool {
        switch self {
        case .both:
            return true
        case .vegan:
            return status == .vegan || status == .veganWithModification
        case .vegetarian:
            // Vegan dishes and vegan modifications also satisfy a vegetarian diet.
            return true
        }
    }
}

enum CatalogCoverageStatus: String, Codable, Hashable {
    case complete = "Complete"
    case needsReview = "Needs review"

    var displayName: String {
        switch self {
        case .complete: "Official menu audited"
        case .needsReview: "Needs review"
        }
    }
}

struct MenuItem: Identifiable, Codable, Hashable {
    let id: UUID
    let name: String
    let description: String
    // Optional because plenty of menus publish no price, and a document menu
    // transcribed by a person often yields readable dishes whose prices are not
    // recoverable. A missing price endangers nobody; hiding the dish would cost
    // somebody a meal they could have eaten.
    let price: String?
    let dietaryStatus: DietaryStatus
    let modificationNote: String?

    init(
        id: UUID = UUID(),
        name: String,
        description: String,
        price: String? = nil,
        dietaryStatus: DietaryStatus,
        modificationNote: String? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.price = price
        self.dietaryStatus = dietaryStatus
        self.modificationNote = modificationNote
    }
}

struct Restaurant: Identifiable, Codable, Hashable {
    let id: UUID
    let name: String
    let neighborhood: String
    let address: String
    let latitude: Double
    let longitude: Double
    let menuItems: [MenuItem]
    let verifiedAt: Date
    let menuURL: URL?
    let coverageStatus: CatalogCoverageStatus
    let coverageScope: String
    let auditedAt: Date
    let lastCheckedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id, name, neighborhood, address, latitude, longitude, menuItems
        case verifiedAt, menuURL, coverageStatus, coverageScope, auditedAt, lastCheckedAt
    }

    init(
        id: UUID = UUID(),
        name: String,
        neighborhood: String,
        address: String,
        latitude: Double,
        longitude: Double,
        menuItems: [MenuItem],
        verifiedAt: Date,
        menuURL: URL? = nil,
        coverageStatus: CatalogCoverageStatus = .needsReview,
        coverageScope: String = "Qualifying items found on the official menu",
        auditedAt: Date? = nil,
        lastCheckedAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.neighborhood = neighborhood
        self.address = address
        self.latitude = latitude
        self.longitude = longitude
        self.menuItems = menuItems
        self.verifiedAt = verifiedAt
        self.menuURL = menuURL
        self.coverageStatus = coverageStatus
        self.coverageScope = coverageScope
        self.auditedAt = auditedAt ?? verifiedAt
        self.lastCheckedAt = lastCheckedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        neighborhood = try values.decode(String.self, forKey: .neighborhood)
        address = try values.decode(String.self, forKey: .address)
        latitude = try values.decode(Double.self, forKey: .latitude)
        longitude = try values.decode(Double.self, forKey: .longitude)
        menuItems = try values.decode([MenuItem].self, forKey: .menuItems)
        verifiedAt = try values.decode(Date.self, forKey: .verifiedAt)
        menuURL = try values.decodeIfPresent(URL.self, forKey: .menuURL)
        coverageStatus = try values.decodeIfPresent(CatalogCoverageStatus.self, forKey: .coverageStatus) ?? .needsReview
        coverageScope = try values.decodeIfPresent(String.self, forKey: .coverageScope)
            ?? "Qualifying items found on the official menu"
        auditedAt = try values.decodeIfPresent(Date.self, forKey: .auditedAt) ?? verifiedAt
        lastCheckedAt = try values.decodeIfPresent(Date.self, forKey: .lastCheckedAt)
    }

    var location: CLLocation {
        CLLocation(latitude: latitude, longitude: longitude)
    }

    func matchingItems(
        for filter: DietaryFilter,
        includeModifications: Bool = true
    ) -> [MenuItem] {
        menuItems.filter { item in
            filter.includes(item.dietaryStatus)
                && (includeModifications || !item.dietaryStatus.requiresModification)
        }
    }
}
