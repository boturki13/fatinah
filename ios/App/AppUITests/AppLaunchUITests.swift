import XCTest

@MainActor
final class AppLaunchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testArabicWebAppLaunchesWithoutAnImmediateSystemPrompt() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-FatinahUITests"]
        app.launch()

        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 12), "يجب أن تظهر واجهة فطنة داخل WKWebView")
        XCTAssertEqual(app.alerts.count, 0, "لا ينبغي طلب إذن الإشعارات عند الإقلاع")

        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Fatinah launch"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
