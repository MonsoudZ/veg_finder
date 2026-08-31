import CoreLocation
import SwiftUI

struct NearbyRestaurantsView: View {
    @StateObject private var locationManager = LocationManager()
    @StateObject private var catalog = RestaurantCatalog()
    @State private var filter: DietaryFilter = .both
    @State private var includeModifications = true

    private var origin: CLLocation {
        locationManager.location ?? RestaurantSearch.pilotCenter
    }

    private var results: [RestaurantResult] {
        RestaurantSearch.results(
            restaurants: catalog.restaurants,
            filter: filter,
            includeModifications: includeModifications,
            origin: origin
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 14) {
                    verificationNotice

                    if catalog.restaurants.isEmpty {
                        catalogState
                    } else if results.isEmpty {
                        noMatchesState
                    }

                    ForEach(results) { result in
                        NavigationLink(value: result.restaurant) {
                            RestaurantCard(result: result, filter: filter)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Eat nearby")
            .navigationDestination(for: Restaurant.self) { restaurant in
                RestaurantDetailView(
                    restaurant: restaurant,
                    items: restaurant.matchingItems(
                        for: filter,
                        includeModifications: includeModifications
                    ),
                    distanceMeters: origin.distance(from: restaurant.location)
                )
            }
            .safeAreaInset(edge: .top) {
                filterBar
            }
            .task {
                locationManager.requestLocation()
                await catalog.load(
                    latitude: origin.coordinate.latitude,
                    longitude: origin.coordinate.longitude
                )
            }
            .refreshable {
                await catalog.refresh(
                    latitude: origin.coordinate.latitude,
                    longitude: origin.coordinate.longitude
                )
            }
            .onChange(of: locationManager.location) { _, newLocation in
                // The first fix usually arrives after the initial load, and the
                // catalog is now scoped to a radius rather than the whole city.
                guard let newLocation else { return }
                Task {
                    await catalog.refresh(
                        latitude: newLocation.coordinate.latitude,
                        longitude: newLocation.coordinate.longitude
                    )
                }
            }
        }
        .tint(.green)
    }

    private var filterBar: some View {
        VStack(spacing: 8) {
            Picker("Diet", selection: $filter) {
                ForEach(DietaryFilter.allCases) { option in
                    Text(option.rawValue).tag(option)
                }
            }
            .pickerStyle(.segmented)

            Toggle(isOn: $includeModifications) {
                Label("Include dishes that need changes", systemImage: "wrench.and.screwdriver")
                    .font(.subheadline)
            }
            .tint(.green)

            HStack(spacing: 5) {
                Image(systemName: locationIcon)
                Text(locationDescription)
                Spacer()
                Text(placesSummary)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var noMatchesState: some View {
        ContentUnavailableView {
            Label("No matching meals", systemImage: "leaf")
        } description: {
            if includeModifications {
                Text("No restaurants in this catalog have items matching this diet.")
            } else {
                Text("Try including dishes that can qualify with a confirmed modification.")
            }
        } actions: {
            if !includeModifications {
                Button("Include modifications") {
                    includeModifications = true
                }
            }
        }
        .padding(.vertical, 24)
    }

    private var verificationNotice: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: showingStaleMenus ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                .foregroundStyle(showingStaleMenus ? .orange : .green)
            Text(verificationText)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(
            (showingStaleMenus ? Color.orange : Color.green).opacity(0.10),
            in: RoundedRectangle(cornerRadius: 12)
        )
    }

    /// Cached menus are on screen but the catalog could not be refreshed, so the
    /// service may have demoted a restaurant to `Needs review` without us hearing it.
    private var showingStaleMenus: Bool {
        catalog.refreshFailure != nil && !catalog.restaurants.isEmpty
    }

    @ViewBuilder
    private var catalogState: some View {
        switch catalog.phase {
        case .idle, .loading:
            ProgressView("Loading audited menus…")
                .frame(maxWidth: .infinity)
                .padding(32)
        case let .failed(message):
            ContentUnavailableView {
                Label("Menus unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") {
                    Task {
                        await catalog.refresh(
                            latitude: origin.coordinate.latitude,
                            longitude: origin.coordinate.longitude
                        )
                    }
                }
            }
        case .ready:
            EmptyView()
        }
    }

    private var verificationText: String {
        guard let generatedAt = catalog.generatedAt else {
            return "Capitol Hill pilot · loading the verified menu catalog."
        }
        let refreshed = generatedAt.formatted(date: .abbreviated, time: .shortened)
        if showingStaleMenus {
            return "Saved menus from \(refreshed). The catalog could not be refreshed, so these items may no longer be accurate — check the restaurant's own menu before ordering."
        }
        return "Catalog refreshed \(refreshed). Availability can change; tap to verify."
    }

    private var placesSummary: String {
        let places = "\(results.count) places"
        switch needsReviewCount {
        case 0: return places
        case 1: return "\(places) · 1 needs review"
        default: return "\(places) · \(needsReviewCount) need review"
        }
    }

    private var needsReviewCount: Int {
        results.filter { $0.restaurant.coverageStatus == .needsReview }.count
    }

    private var locationIcon: String {
        locationManager.location == nil ? "mappin.and.ellipse" : "location.fill"
    }

    private var locationDescription: String {
        if locationManager.location != nil {
            return "Sorted from your location"
        }
        if locationManager.authorizationStatus == .denied {
            return "Using Capitol Hill center · location denied"
        }
        return "Using Capitol Hill center"
    }
}

private struct RestaurantCard: View {
    let result: RestaurantResult
    let filter: DietaryFilter

    private var needsReview: Bool {
        result.restaurant.coverageStatus == .needsReview
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(result.restaurant.name)
                        .font(.headline)
                    Text("\(result.restaurant.neighborhood) · \(distanceText)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.bold())
                    .foregroundStyle(.tertiary)
            }

            if needsReview {
                reviewNotice
            }

            Text(summaryText)
                .font(.caption.weight(.semibold))
                .foregroundStyle(needsReview ? Color.secondary : Color.green)

            VStack(alignment: .leading, spacing: 8) {
                ForEach(result.items.prefix(3)) { item in
                    HStack(spacing: 8) {
                        DietaryBadge(status: item.dietaryStatus)
                        Text(item.name)
                            .font(.subheadline)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(item.price)
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }

                if result.items.count > 3 {
                    Label(
                        "+\(result.items.count - 3) more qualifying \(result.items.count - 3 == 1 ? "item" : "items")",
                        systemImage: "arrow.right.circle.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.green)
                }
            }
        }
        .padding(16)
        .background(.background, in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(.quaternary, lineWidth: 0.5)
        }
    }

    private var reviewNotice: some View {
        Label {
            Text("\(result.restaurant.coverageStatus.displayName) · verify on the official menu")
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.orange)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel(
            "Needs review. The official menu could not be confirmed since this restaurant was audited."
        )
    }

    private var distanceText: String {
        let miles = result.distanceMeters / 1_609.344
        return miles < 0.1 ? "< 0.1 mi" : String(format: "%.1f mi", miles)
    }

    private var summaryText: String {
        let asServed = result.items.filter { !$0.dietaryStatus.requiresModification }.count
        let modified = result.items.count - asServed
        if filter == .both {
            let firstPart = "\(asServed) as served"
            return modified > 0 ? "\(firstPart) · \(modified) with modification" : firstPart
        }
        let diet = filter == .vegan ? "vegan" : "vegetarian"
        let firstPart = "\(asServed) \(diet)"
        guard modified > 0 else { return firstPart }
        return "\(firstPart) · \(modified) can be made \(diet)"
    }
}

struct DietaryBadge: View {
    let status: DietaryStatus

    var body: some View {
        Text(label)
            .font(.caption2.bold())
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .frame(height: 20)
            .background(
                color.opacity(0.12),
                in: Capsule()
            )
            .accessibilityLabel(status.rawValue)
    }

    private var label: String {
        switch status {
        case .vegan: "Vegan"
        case .vegetarian: "Veg"
        case .veganWithModification: "Vegan · modify"
        case .vegetarianWithModification: "Veg · modify"
        }
    }

    private var color: Color {
        switch status {
        case .vegan, .veganWithModification: .green
        case .vegetarian, .vegetarianWithModification: .orange
        }
    }
}
