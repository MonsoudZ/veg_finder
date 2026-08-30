import Combine
import Foundation

struct CatalogResponse: Codable {
    let generatedAt: Date
    let restaurants: [Restaurant]
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

    func load() async {
        if restaurants.isEmpty {
            loadCache()
        }
        await refresh()
    }

    func refresh() async {
        guard let endpoint else {
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
            phase = .ready
            try? data.write(to: cacheURL, options: .atomic)
        } catch {
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
