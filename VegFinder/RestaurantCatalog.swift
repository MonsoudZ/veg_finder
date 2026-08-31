import Combine
import Foundation

struct CatalogResponse: Codable {
    let generatedAt: Date
    let restaurants: [Restaurant]
    /// Watermark for incremental sync. Present from the paged catalog API; absent
    /// in older cached payloads, so it stays optional.
    let syncedAt: Date?
    let nextCursor: String?

    private enum CodingKeys: String, CodingKey {
        case generatedAt, restaurants, syncedAt, nextCursor
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try values.decode(Date.self, forKey: .generatedAt)
        restaurants = try values.decode([Restaurant].self, forKey: .restaurants)
        syncedAt = try values.decodeIfPresent(Date.self, forKey: .syncedAt)
        nextCursor = try values.decodeIfPresent(String.self, forKey: .nextCursor)
    }
}

enum CatalogPhase: Equatable {
    case idle
    case loading
    case ready
    case failed(String)
}

enum CatalogError: LocalizedError {
    case missingEndpoint
    case invalidResponse
    case emptyCatalog

    var errorDescription: String? {
        switch self {
        case .missingEndpoint:
            "The menu catalog URL is not configured."
        case .invalidResponse:
            "The menu service returned an invalid response."
        case .emptyCatalog:
            "The menu service returned no verified restaurants."
        }
    }
}

@MainActor
final class RestaurantCatalog: ObservableObject {
    @Published private(set) var restaurants: [Restaurant] = []
    @Published private(set) var generatedAt: Date?
    @Published private(set) var phase: CatalogPhase = .idle

    /// Set whenever a refresh fails while cached menus are still on screen. Those
    /// menus stay useful, but they can no longer be described as freshly verified.
    @Published private(set) var refreshFailure: String?

    private let endpoint: URL?
    private let session: URLSession
    private let cacheURL: URL

    init(
        endpoint: URL? = nil,
        session: URLSession = .shared,
        cacheURL: URL? = nil
    ) {
        self.endpoint = endpoint ?? Self.configuredEndpoint
        self.session = session
        self.cacheURL = cacheURL ?? Self.defaultCacheURL
    }

    /// Radius covering the Denver metro. The catalog no longer returns every
    /// restaurant it holds, so the app asks for the ones near the diner.
    static let defaultRadiusKm = 25.0
    static let defaultLimit = 100

    func load(latitude: Double, longitude: Double) async {
        if restaurants.isEmpty {
            loadCache()
        }
        await refresh(latitude: latitude, longitude: longitude)
    }

    func refresh(latitude: Double, longitude: Double) async {
        guard let endpoint = Self.nearbyURL(base: endpoint, latitude: latitude, longitude: longitude) else {
            refreshFailure = CatalogError.missingEndpoint.localizedDescription
            if restaurants.isEmpty {
                phase = .failed(CatalogError.missingEndpoint.localizedDescription)
            }
            return
        }

        if restaurants.isEmpty {
            phase = .loading
        }

        do {
            var request = URLRequest(url: endpoint)
            request.cachePolicy = .reloadRevalidatingCacheData
            request.timeoutInterval = 20
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  200..<300 ~= httpResponse.statusCode else {
                throw CatalogError.invalidResponse
            }

            let catalog = try Self.decoder.decode(CatalogResponse.self, from: data)
            guard !catalog.restaurants.isEmpty else {
                throw CatalogError.emptyCatalog
            }

            restaurants = catalog.restaurants
            generatedAt = catalog.generatedAt
            refreshFailure = nil
            phase = .ready
            try? data.write(to: cacheURL, options: .atomic)
        } catch {
            refreshFailure = error.localizedDescription
            if restaurants.isEmpty {
                phase = .failed(error.localizedDescription)
            } else {
                phase = .ready
            }
        }
    }

    private func loadCache() {
        guard let data = try? Data(contentsOf: cacheURL),
              let catalog = try? Self.decoder.decode(CatalogResponse.self, from: data),
              !catalog.restaurants.isEmpty else {
            return
        }
        restaurants = catalog.restaurants
        generatedAt = catalog.generatedAt
        phase = .ready
    }

    private static var configuredEndpoint: URL? {
        if let override = ProcessInfo.processInfo.environment["VEGFINDER_CATALOG_URL"] {
            return URL(string: override)
        }
        guard let value = Bundle.main.object(forInfoDictionaryKey: "VegFinderCatalogURL") as? String else {
            return nil
        }
        return URL(string: value)
    }

    private static func nearbyURL(base: URL?, latitude: Double, longitude: Double) -> URL? {
        guard let base, var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.queryItems = [
            URLQueryItem(name: "lat", value: String(latitude)),
            URLQueryItem(name: "lon", value: String(longitude)),
            URLQueryItem(name: "radiusKm", value: String(defaultRadiusKm)),
            URLQueryItem(name: "limit", value: String(defaultLimit))
        ]
        return components.url
    }

    private static var defaultCacheURL: URL {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return directory.appendingPathComponent("verified-restaurant-catalog.json")
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = ISO8601DateFormatter.withFractionalSeconds.date(from: value)
                ?? ISO8601DateFormatter().date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(value)"
            )
        }
        return decoder
    }()
}

private extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
