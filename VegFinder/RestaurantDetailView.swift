import CoreLocation
import SwiftUI

struct RestaurantDetailView: View {
    let restaurant: Restaurant
    let items: [MenuItem]
    let distanceMeters: CLLocationDistance

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(restaurant.neighborhood)
                        .font(.headline)
                    Label(distanceText, systemImage: "location.fill")
                    Text(restaurant.address)
                }
                .foregroundStyle(.secondary)
            }

            Section("What you can eat") {
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 7) {
                        HStack(alignment: .firstTextBaseline) {
                            DietaryBadge(status: item.dietaryStatus)
                            Text(item.name)
                                .font(.headline)
                            Spacer()
                            // Said plainly rather than left blank. A gap where a
                            // price should be reads as a bug; "no price listed"
                            // is a fact about the menu, and the dish is still
                            // worth showing to somebody deciding where to eat.
                            Text(item.price ?? "No price listed")
                                .font(.subheadline.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .accessibilityLabel(
                                    item.price.map { "Price \($0)" } ?? "No price listed"
                                )
                        }
                        Text(item.description)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if let modificationNote = item.modificationNote {
                            Label(modificationNote, systemImage: "wrench.and.screwdriver.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.blue)
                        }
                    }
                    .padding(.vertical, 5)
                }
            }

            Section("Menu verification") {
                LabeledContent("Status") {
                    Label(restaurant.coverageStatus.displayName, systemImage: coverageIcon)
                        .foregroundStyle(restaurant.coverageStatus == .complete ? .green : .orange)
                }
                Text(restaurant.coverageScope)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                LabeledContent("Menu audited") {
                    Text(restaurant.auditedAt, format: .dateTime.month().day().year())
                }
                LabeledContent("Source checked") {
                    if let lastCheckedAt = restaurant.lastCheckedAt {
                        Text(lastCheckedAt, format: .dateTime.month().day().year())
                    } else {
                        Text("Not checked yet")
                            .foregroundStyle(.secondary)
                    }
                }
                if let menuURL = restaurant.menuURL {
                    Link(destination: menuURL) {
                        Label("View source menu", systemImage: "arrow.up.right.square")
                    }
                } else {
                    Label("No source menu available", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            }
        }
        .navigationTitle(restaurant.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var distanceText: String {
        let miles = distanceMeters / 1_609.344
        return miles < 0.1 ? "Less than 0.1 miles away" : String(format: "%.1f miles away", miles)
    }

    private var coverageIcon: String {
        restaurant.coverageStatus == .complete ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"
    }
}
