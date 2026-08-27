import XCTest

@MainActor
final class AppLaunchUITests: XCTestCase {
    private var openedQuestionLabels = Set<String>()

    override func setUpWithError() throws {
        continueAfterFailure = false
        openedQuestionLabels.removeAll()
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

    func testFullQuestionRoundInPortraitAndLandscape() throws {
        let app = launchGameFlowApp()
        let boardCell = app.buttons.matching(
            NSPredicate(format: "isEnabled == true AND label BEGINSWITH %@", "سؤال ")
        ).firstMatch
        XCTAssertTrue(boardCell.waitForExistence(timeout: 12), "يجب أن تظهر لوحة الجولة التجريبية")

        XCUIDevice.shared.orientation = .portrait
        openNextQuestion(in: app)
        let reveal = app.buttons["👁️ اكشف الإجابة"]
        XCTAssertTrue(reveal.waitForExistence(timeout: 5), "يجب فتح السؤال في الوضع العمودي")
        keepScreenshot(named: "Question portrait — hidden answer", app: app)

        let pause = app.buttons["وقّف العداد مؤقتًا"]
        XCTAssertTrue(pause.isHittable, "زر إيقاف العداد يجب أن يكون قابلاً للمس")
        pause.tap()
        let resume = app.buttons["▶ كمّل"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3), "يجب إخفاء السؤال عند إيقاف الوقت")
        resume.tap()
        XCTAssertTrue(reveal.waitForExistence(timeout: 3), "يجب أن يعود السؤال بعد استئناف الوقت")

        let double = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "مضاعفة السؤال")
        ).firstMatch
        XCTAssertTrue(makeHittable(double, in: app), "وسيلة مضاعفة السؤال يجب أن تكون قابلة للمس")
        double.tap()
        reveal.tap()
        XCTAssertTrue(app.staticTexts["الإجابة الصحيحة"].waitForExistence(timeout: 3), "يجب ظهور الإجابة مع السؤال")
        keepScreenshot(named: "Question portrait — revealed answer", app: app)
        app.buttons["✅ النجوم"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "النجوم، 200 نقطة")
        ).firstMatch.waitForExistence(timeout: 3), "يجب إضافة النقاط المضاعفة للفريق")

        openNextQuestion(in: app)
        let skip = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "تغيير السؤال")
        ).firstMatch
        XCTAssertTrue(makeHittable(skip, in: app), "وسيلة تغيير السؤال يجب أن تكون قابلة للمس")
        skip.tap()
        app.buttons["👁️ اكشف الإجابة"].tap()
        app.buttons["❌ محد جاوب صح"].tap()

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(waitForLandscapeLayout(in: app), "يجب أن تتمدد واجهة التطبيق فعليًا بعرض الوضع الأفقي")
        openNextQuestion(in: app)
        XCTAssertTrue(app.buttons["👁️ اكشف الإجابة"].waitForExistence(timeout: 4), "يجب فتح السؤال في الوضع الأفقي")
        let pass = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "مرّرها للخصم")
        ).firstMatch
        XCTAssertTrue(makeHittable(pass, in: app), "وسيلة تمرير السؤال يجب أن تكون قابلة للمس")
        pass.tap()
        keepScreenshot(named: "Question landscape", app: app)
        app.buttons["👁️ اكشف الإجابة"].tap()
        app.buttons["❌ محد جاوب صح"].tap()

        for _ in 0..<9 {
            openNextQuestion(in: app)
            let revealNext = app.buttons["👁️ اكشف الإجابة"]
            XCTAssertTrue(revealNext.waitForExistence(timeout: 3), "يجب فتح كل سؤال متبقٍ")
            revealNext.tap()
            app.buttons["❌ محد جاوب صح"].tap()
        }

        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "النجوم")
        ).firstMatch.waitForExistence(timeout: 6), "يجب الوصول إلى صفحة النتيجة بعد 12 سؤالاً")
        let achievementToast = app.staticTexts["إنجاز يديد!"]
        if achievementToast.exists {
            let toastAnimation = XCTestExpectation(description: "انتظار خروج إشعار الإنجاز من الشاشة")
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.2) { toastAnimation.fulfill() }
            XCTAssertEqual(XCTWaiter.wait(for: [toastAnimation], timeout: 4), .completed)
        }
        let resultTitle = app.staticTexts["خلصت الجولة! 🎊"]
        XCTAssertTrue(resultTitle.waitForExistence(timeout: 3), "يجب ظهور عنوان النتيجة")
        let webViewFrame = app.webViews.firstMatch.frame
        XCTAssertGreaterThanOrEqual(resultTitle.frame.minY, webViewFrame.minY, "عنوان النتيجة يجب ألا يكون مقصوصًا من الأعلى")
        XCTAssertLessThanOrEqual(resultTitle.frame.maxY, webViewFrame.maxY, "عنوان النتيجة يجب أن يبقى داخل الشاشة")
        keepScreenshot(named: "Round result", app: app)
    }

    func testImageQuestionLoadsInPortraitAndLandscape() throws {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments += ["-FatinahGameFlowUITests", "-FatinahImageFlowUITests"]
        app.launch()

        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 12), "يجب ظهور WKWebView")
        let reveal = app.buttons["👁️ اكشف الإجابة"]
        XCTAssertTrue(reveal.waitForExistence(timeout: 75), "يجب فتح السؤال المصوّر بعد تنزيل صورته")
        let questionImage = app.images.firstMatch
        XCTAssertTrue(questionImage.waitForExistence(timeout: 8), "يجب عرض صورة السؤال")
        XCTAssertFalse(questionImage.label.isEmpty, "يجب أن تحمل الصورة وصفاً صوتياً")
        XCTAssertFalse(app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "الصورة مو متوفرة")
        ).firstMatch.exists, "يجب ألا يبدأ السؤال بحالة الصورة البديلة")
        keepScreenshot(named: "Image question — portrait", app: app)

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(waitForLandscapeLayout(in: app), "يجب أن تتكيف واجهة الصورة مع الوضع الأفقي")
        XCTAssertTrue(questionImage.exists, "يجب أن تبقى صورة السؤال ظاهرة بعد التدوير")
        XCTAssertTrue(reveal.exists, "يجب أن يبقى زر كشف الإجابة ظاهراً بعد التدوير")
        keepScreenshot(named: "Image question — landscape", app: app)
    }

    func testSearchLifelineStartsItsCountdown() throws {
        let app = launchGameFlowApp()
        openNextQuestion(in: app)
        let search = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "بحث بالجوال")
        ).firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5), "يجب ظهور وسيلة البحث")
        search.tap()
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "🔍 باقي للبحث:")
        ).firstMatch.waitForExistence(timeout: 3), "يجب بدء عداد البحث لمدة 45 ثانية")
        let finishSearch = app.buttons["حصلنا الإجابة، وقف البحث وكمّل السؤال"]
        XCTAssertTrue(finishSearch.waitForExistence(timeout: 3), "يجب إتاحة إنهاء البحث قبل انتهاء المهلة")
        XCTAssertTrue(finishSearch.isEnabled, "زر إنهاء البحث يجب أن يكون قابلاً للضغط")
        XCTAssertFalse(app.buttons["وقّف العداد مؤقتًا"].isEnabled, "يجب تعطيل الإيقاف أثناء مهلة البحث")
        finishSearch.tap()
        XCTAssertFalse(app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "🔍 باقي للبحث:")
        ).firstMatch.exists, "يجب إخفاء عداد البحث فور إنهائه")
        XCTAssertTrue(app.buttons["وقّف العداد مؤقتًا"].isEnabled, "يجب إعادة تفعيل عداد السؤال بعد إنهاء البحث")
        keepScreenshot(named: "Search lifeline countdown", app: app)
    }

    func testQuestionAtLargestAccessibilityTextSize() throws {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments += [
            "-FatinahGameFlowUITests",
            "-FatinahDynamicTypeUITests",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 12), "يجب ظهور WKWebView بالحجم الكبير")

        let reveal = app.buttons["👁️ اكشف الإجابة"]
        XCTAssertTrue(makeHittable(reveal, in: app), "زر كشف الإجابة يبقى قابلاً للمس مع أكبر Dynamic Type")
        let readableTexts = app.staticTexts.allElementsBoundByIndex.filter { $0.label.count >= 18 }
        XCTAssertFalse(readableTexts.isEmpty, "يجب أن يبقى نص السؤال الطويل ظاهراً في شجرة الوصول")
        let webFrame = app.webViews.firstMatch.frame
        XCTAssertTrue(readableTexts.contains { $0.frame.intersects(webFrame) }, "نص السؤال يجب أن يبقى داخل مساحة WebView")
        keepScreenshot(named: "Question — largest Dynamic Type", app: app)
    }

    private func launchGameFlowApp() -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments += ["-FatinahGameFlowUITests"]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 12), "يجب ظهور WKWebView")
        return app
    }

    private func openNextQuestion(in app: XCUIApplication) {
        let reveal = app.buttons["👁️ اكشف الإجابة"]
        if reveal.exists {
            let questionClosed = NSPredicate { object, _ in
                guard let element = object as? XCUIElement else { return false }
                return !element.exists
            }
            let expectation = XCTNSPredicateExpectation(predicate: questionClosed, object: reveal)
            XCTAssertEqual(
                XCTWaiter.wait(for: [expectation], timeout: 4),
                .completed,
                "يجب الرجوع للوحة قبل فتح السؤال التالي"
            )
        }

        let cells = app.buttons.matching(
            NSPredicate(format: "isEnabled == true AND label BEGINSWITH %@", "سؤال ")
        )
        XCTAssertTrue(cells.firstMatch.waitForExistence(timeout: 5), "يجب وجود سؤال غير مستخدم")

        // بعد تدوير WKWebView قد يبقى firstMatch سؤالاً صحيحاً لكنه خارج إطار
        // الشاشة، فيحاول XCUITest الضغط على إحداثية من التخطيط العمودي القديم.
        // اختر سؤالاً ظاهراً فعلياً، وابحث في الاتجاهين لأن موضع تمرير اللوحة
        // يبقى محفوظاً بين الأسئلة في الوضع الأفقي.
        let webView = app.webViews.firstMatch
        func tapVisibleUnusedCell() -> Bool {
            let viewport = webView.frame.insetBy(dx: 8, dy: 8)
            for element in cells.allElementsBoundByIndex {
                let frame = element.frame
                guard !frame.isNull,
                      !frame.isInfinite,
                      frame.width > 0,
                      frame.height > 0,
                      frame.intersects(viewport),
                      !openedQuestionLabels.contains(element.label) else { continue }
                let visibleFrame = frame.intersection(viewport)
                guard visibleFrame.width >= 44, visibleFrame.height >= 44 else { continue }
                openedQuestionLabels.insert(element.label)
                let appFrame = app.frame
                let point = CGVector(
                    dx: visibleFrame.midX / appFrame.width,
                    dy: visibleFrame.midY / appFrame.height
                )
                app.coordinate(withNormalizedOffset: point).tap()
                return true
            }
            return false
        }

        if tapVisibleUnusedCell() { return }
        for _ in 0..<6 {
            webView.swipeUp()
            if tapVisibleUnusedCell() { return }
        }
        for _ in 0..<12 {
            webView.swipeDown()
            if tapVisibleUnusedCell() { return }
        }

        XCTFail("يجب أن يكون أحد الأسئلة غير المستخدمة قابلاً للمس")
    }

    private func makeHittable(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        guard element.waitForExistence(timeout: 4) else { return false }
        if element.isHittable { return true }
        let webView = app.webViews.firstMatch
        for _ in 0..<3 {
            webView.swipeUp()
            if element.isHittable { return true }
        }
        return false
    }

    private func waitForLandscapeLayout(in app: XCUIApplication) -> Bool {
        let webView = app.webViews.firstMatch
        let landscape = NSPredicate { object, _ in
            guard let element = object as? XCUIElement, element.exists else { return false }
            return element.frame.width > element.frame.height
        }
        let expectation = XCTNSPredicateExpectation(predicate: landscape, object: webView)
        return XCTWaiter.wait(for: [expectation], timeout: 6) == .completed
    }

    private func keepScreenshot(named name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
