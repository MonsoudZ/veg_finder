import Combine
import CoreLocation
import Foundation

/// What the app keeps on disk between launches: the catalog it last showed, the
/// point it was fetched around, and how far the server had got when it was sent.
struct CatalogSnapshot: Codable {
    var syncedAt: Date?
    var latitude: Double
    var longitude: Double
    var restaurants: [Restaurant]

    var origin: CLLocation { CLLocation(latitude: latitude, longitude: longitude) }
}

/// Applying server changes to a local catalog. Pure, so it can be tested without
/// a network or a disk.
enum CatalogMerge {
    /// Restaurants beyond this distance from the snapshot's origin mean the user
    /// has moved somewhere the previous radius no longer describes, so the next
    /// sync starts over rather than patching a window that has shifted.
    static let resyncDistanceKm = 5.0

    static func apply(
        changes: [Restaurant],
        to existing: [Restaurant],
        origin: CLLocation,
        radiusKm: Double
    ) -> [Restaurant] {
        var byID = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        for restaurant in changes {
            byID[restaurant.id] = restaurant
        }
        return byID.values
            // A restaurant whose qualifying items were all unpublished arrives with
            // an empty menu. It has nothing to offer, so it is dropped rather than
            // left in the cache forever.
            .filter { !$0.menuItems.isEmpty }
            // A delta is scoped to a radius, but the local copy also holds whatever
            // an earlier, wider sync left behind.
            .filter { origin.distance(from: $0.location) / 1_000 <= radiusKm }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

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
    /// A guard against a server that keeps handing out cursors.
    static let maximumSyncPages = 50

    /// A location fix landing within this distance of what the catalog already
    /// covers describes the same place, so reacting to it would repeat the sync
    /// that just ran.
    static let duplicateSyncKm = 1.0

    /// How far the server had got when the local copy was last written.
    private var syncedAt: Date?
    private var syncedOrigin: CLLocation?
    /// The place a sync is currently running for, if any.
    private var syncInFlight: CLLocation?

    /// Whether an automatic trigger — a first location fix, say — would be asking
    /// for a place the catalog has already synced. Opening the app still refreshes
    /// unconditionally; this only suppresses the redundant follow-up.
    func alreadyCovers(latitude: Double, longitude: Double) -> Bool {
        guard syncedAt != nil, let syncedOrigin else { return false }
        return syncedOrigin.distance(from: CLLocation(latitude: latitude, longitude: longitude)) / 1_000
            <= Self.duplicateSyncKm
    }

    func load(latitude: Double, longitude: Double) async {
        if restaurants.isEmpty {
            loadCache()
        }
        await refresh(latitude: latitude, longitude: longitude)
    }

    func refresh(latitude: Double, longitude: Double) async {
        guard endpoint != nil else {
            refreshFailure = CatalogError.missingEndpoint.localizedDescription
            if restaurants.isEmpty {
                phase = .failed(CatalogError.missingEndpoint.localizedDescription)
            }
            return
        }

        if restaurants.isEmpty {
            phase = .loading
        }

        let origin = CLLocation(latitude: latitude, longitude: longitude)
        // The launch task and the first location fix overlap: the fix usually
        // lands while the opening sync is still waiting on the network. A sync
        // already running for this place covers this request too.
        if let running = syncInFlight,
           running.distance(from: origin) / 1_000 <= Self.duplicateSyncKm {
            return
        }
        syncInFlight = origin
        defer { syncInFlight = nil }

        do {
            // Only ask for changes when the previous sync described the same place.
            // If the diner has moved, the old radius no longer describes where they
            // are and patching it would leave the catalog wrong in both directions.
            let movedKm = syncedOrigin.map { origin.distance(from: $0) / 1_000 } ?? .infinity
            if let since = syncedAt, movedKm <= CatalogMerge.resyncDistanceKm {
                try await syncChanges(since: since, origin: origin)
            } else {
                try await syncEverything(origin: origin)
            }
            refreshFailure = nil
            phase = .ready
        } catch {
            refreshFailure = error.localizedDescription
            phase = restaurants.isEmpty ? .failed(error.localizedDescription) : .ready
        }
    }

    /// Replaces the local catalog outright. Used on a first run and whenever the
    /// diner has moved far enough that the previous window no longer applies.
    private func syncEverything(origin: CLLocation) async throws {
        let page = try await fetchPage(origin: origin, since: nil, cursor: nil)
        guard !page.restaurants.isEmpty else { throw CatalogError.emptyCatalog }
        restaurants = CatalogMerge.apply(
            changes: page.restaurants, to: [], origin: origin, radiusKm: Self.defaultRadiusKm
        )
        generatedAt = page.generatedAt
        persist(syncedAt: page.syncedAt, origin: origin)
    }

    /// Asks only for what changed. Follows the server's cursor to the end, because
    /// a delta larger than one page would otherwise be silently truncated.
    private func syncChanges(since: Date, origin: CLLocation) async throws {
        var merged = restaurants
        var watermark = since
        var cursor: String?
        var pages = 0

        repeat {
            let page = try await fetchPage(origin: origin, since: watermark, cursor: cursor)
            merged = CatalogMerge.apply(
                changes: page.restaurants, to: merged,
                origin: origin, radiusKm: Self.defaultRadiusKm
            )
            generatedAt = page.generatedAt
            // The watermark only advances on a page the server actually stamped.
            if let syncedAt = page.syncedAt { watermark = syncedAt }
            cursor = page.nextCursor
            pages += 1
        } while cursor != nil && pages < Self.maximumSyncPages

        restaurants = merged
        persist(syncedAt: watermark, origin: origin)
    }

    private func fetchPage(origin: CLLocation, since: Date?, cursor: String?) async throws -> CatalogResponse {
        guard let url = Self.catalogURL(
            base: endpoint,
            latitude: origin.coordinate.latitude,
            longitude: origin.coordinate.longitude,
            since: since,
            cursor: cursor
        ) else { throw CatalogError.missingEndpoint }

        var request = URLRequest(url: url)
        request.cachePolicy = .reloadRevalidatingCacheData
        request.timeoutInterval = 20
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              200..<300 ~= httpResponse.statusCode else {
            throw CatalogError.invalidResponse
        }
        return try Self.decoder.decode(CatalogResponse.self, from: data)
    }

    private func persist(syncedAt: Date?, origin: CLLocation) {
        self.syncedAt = syncedAt
        syncedOrigin = origin
        let snapshot = CatalogSnapshot(
            syncedAt: syncedAt,
            latitude: origin.coordinate.latitude,
            longitude: origin.coordinate.longitude,
            restaurants: restaurants
        )
        if let data = try? Self.encoder.encode(snapshot) {
            try? data.write(to: cacheURL, options: .atomic)
        }
    }

    private func loadCache() {
        guard let data = try? Data(contentsOf: cacheURL),
              let snapshot = try? Self.decoder.decode(CatalogSnapshot.self, from: data),
              !snapshot.restaurants.isEmpty else {
            return
        }
        restaurants = snapshot.restaurants
        syncedAt = snapshot.syncedAt
        syncedOrigin = snapshot.origin
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

    static func catalogURL(
        base: URL?, latitude: Double, longitude: Double,
        since: Date? = nil, cursor: String? = nil
    ) -> URL? {
        guard let base, var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return nil
        }
        var items = [
            URLQueryItem(name: "lat", value: String(latitude)),
            URLQueryItem(name: "lon", value: String(longitude)),
            URLQueryItem(name: "radiusKm", value: String(defaultRadiusKm)),
            URLQueryItem(name: "limit", value: String(defaultLimit))
        ]
        if let since {
            items.append(URLQueryItem(name: "since", value: watermarkFormatter.string(from: since)))
        }
        if let cursor {
            items.append(URLQueryItem(name: "cursor", value: cursor))
        }
        components.queryItems = items
        return components.url
    }

    /// The watermark goes back to the server as a string, so it must round-trip
    /// exactly: the server compares timestamps, and a lossy format loses updates.
    private static let watermarkFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(watermarkFormatter.string(from: date))
        }
        return encoder
    }()

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
