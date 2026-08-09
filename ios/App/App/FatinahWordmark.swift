import SwiftUI

// MARK: — Font Registration

private enum KOMediaBlack {
    /// PostScript name used by UIFont / Font.custom.
    /// Verified from the font's name table (nameID 6): "KOMedia-Black".
    static let postScriptName = "KOMedia-Black"

    /// Filename as it appears in "Copy Bundle Resources" in Xcode.
    static let bundleFilename = "alfont_com_KOMedia-Black.otf"

    static var isAvailable: Bool {
        UIFont(name: postScriptName, size: 12) != nil
    }
}

// MARK: — FatinahWordmark

/// Hero typography view: renders "فطنة" in KO Media Black with a fire gradient
/// and warm glow. Falls back to a clear setup guide when the font is missing.
///
///     FatinahWordmark()                          // default
///     FatinahWordmark(showDiagnostics: true)     // development
struct FatinahWordmark: View {

    /// Show a status indicator and font-name badge at the bottom edge.
    var showDiagnostics: Bool = false

    @Environment(\.colorScheme) private var colorScheme

    // Tracks the user's Dynamic Type preference, anchored to largeTitle (34 pt).
    // Ratio = scaleAnchor / 34  →  1.0 at default, ~1.56 at AX3, ~0.82 at xSmall.
    @ScaledMetric(relativeTo: .largeTitle) private var scaleAnchor: CGFloat = 34

    private var dynamicTypeScale: CGFloat { scaleAnchor / 34 }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                background
                VStack(spacing: 0) {
                    Spacer()
                    if KOMediaBlack.isAvailable {
                        wordmark(containerWidth: proxy.size.width)
                    } else {
                        fontUnavailableNotice
                    }
                    Spacer()
                    if showDiagnostics {
                        diagnosticsBadge
                    }
                }
            }
        }
        .ignoresSafeArea()
    }

    // MARK: — Font Size

    /// 30 % of container width, scaled by Dynamic Type preference.
    /// minimumScaleFactor(0.4) on the Text view handles overflow gracefully.
    private func fontSize(for width: CGFloat) -> CGFloat {
        width * 0.30 * dynamicTypeScale
    }

    // MARK: — Background

    private var background: some View {
        // Same deep navy/violet as the app's --bg token (#120B24).
        // Slightly lighter top edge adds perceived depth.
        LinearGradient(
            colors: colorScheme == .dark
                ? [Color(r: 22, g: 14, b: 42), Color(r: 8, g: 4, b: 16)]
                : [Color(r: 28, g: 16, b: 52), Color(r: 10, g: 6, b: 22)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }

    // MARK: — Wordmark

    private func wordmark(containerWidth: CGFloat) -> some View {
        Text("فطنة")
            .font(.custom(KOMediaBlack.postScriptName, size: fontSize(for: containerWidth)))
            // Three-layer glow: tight halo → mid diffuse → deep ambient
            .shadow(color: Color(r: 255, g: 183, b: 77,  opacity: 0.80), radius: 12, x: 0, y:  0)
            .shadow(color: Color(r: 255, g: 107, b: 0,   opacity: 0.50), radius: 38, x: 0, y: 10)
            .shadow(color: Color(r: 255, g: 45,  b: 85,  opacity: 0.20), radius: 72, x: 0, y: 22)
            .foregroundStyle(fireGradient)
            .minimumScaleFactor(0.4)
            .lineLimit(1)
            .padding(.horizontal, 32)
            // Force RTL shaping regardless of the device's system language.
            .environment(\.layoutDirection, .rightToLeft)
            .accessibilityLabel("فطنة")
    }

    private var fireGradient: LinearGradient {
        LinearGradient(
            stops: [
                .init(color: Color(r: 255, g: 248, b: 168), location: 0.00), // warm white
                .init(color: Color(r: 255, g: 215, b: 0),   location: 0.22), // gold
                .init(color: Color(r: 255, g: 140, b: 0),   location: 0.60), // amber
                .init(color: Color(r: 255, g: 69,  b: 0),   location: 1.00), // ember
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    // MARK: — Font Unavailable Notice

    private var fontUnavailableNotice: some View {
        VStack(spacing: 22) {
            Image(systemName: "character.textbox")
                .font(.system(size: 54, weight: .light))
                .foregroundStyle(Color(r: 255, g: 140, b: 0, opacity: 0.85))

            Text("الخط غير متوفر")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)

            fontNameBadge

            setupSteps
        }
        .padding(28)
        .multilineTextAlignment(.center)
        .environment(\.layoutDirection, .rightToLeft)
    }

    private var fontNameBadge: some View {
        Text(KOMediaBlack.postScriptName)
            .font(.system(.body, design: .monospaced).weight(.medium))
            .foregroundStyle(Color(r: 255, g: 215, b: 0))
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(
                Capsule()
                    .fill(.white.opacity(0.07))
                    .overlay(Capsule().strokeBorder(.white.opacity(0.18), lineWidth: 1))
            )
    }

    private var setupSteps: some View {
        VStack(alignment: .leading, spacing: 10) {
            step(1, "أضف ملف \(KOMediaBlack.bundleFilename) إلى الـ Target في Xcode")
            step(2, "فعّل \"Copy Bundle Resources\" لهذا الملف")
            step(3, "أضف اسم الملف في UIAppFonts داخل Info.plist")
            step(4, "ابنِ المشروع من جديد (⌘B)")
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(.white.opacity(0.05)))
        .padding(.horizontal, 4)
    }

    private func step(_ n: Int, _ label: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)")
                .font(.caption2.weight(.bold))
                .monospacedDigit()
                .frame(width: 18, height: 18)
                .background(Circle().fill(Color(r: 255, g: 140, b: 0, opacity: 0.45)))
                .foregroundStyle(.white)
            Text(label)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.65))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    // MARK: — Diagnostics

    private var diagnosticsBadge: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(KOMediaBlack.isAvailable ? Color.green : Color.red)
                .frame(width: 7, height: 7)
            Text(
                KOMediaBlack.isAvailable
                    ? "✓ \(KOMediaBlack.postScriptName) مُسجَّل"
                    : "✗ \(KOMediaBlack.postScriptName) غير مُسجَّل"
            )
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.white.opacity(0.45))
        }
        .padding(.bottom, 20)
    }
}

// MARK: — Color Helper

private extension Color {
    /// Convenience initialiser for 0–255 component values.
    init(r: Double, g: Double, b: Double, opacity: Double = 1) {
        self.init(red: r / 255, green: g / 255, blue: b / 255, opacity: opacity)
    }
}

// MARK: — Previews

#Preview("Dark — diagnostics") {
    FatinahWordmark(showDiagnostics: true)
        .preferredColorScheme(.dark)
}

#Preview("Light") {
    FatinahWordmark(showDiagnostics: true)
        .preferredColorScheme(.light)
}

#Preview("iPhone SE") {
    FatinahWordmark()
        .preferredColorScheme(.dark)
}

#Preview("iPad") {
    FatinahWordmark()
        .preferredColorScheme(.dark)
}

#Preview("Accessibility — AX3") {
    FatinahWordmark(showDiagnostics: true)
        .preferredColorScheme(.dark)
        .dynamicTypeSize(.accessibility3)
}
