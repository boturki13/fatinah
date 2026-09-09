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
        XCTAssertTrue(answerOption(for: "النجوم", in: app).waitForExistence(timeout: 5), "يجب أن يظهر السؤال مع أربعة خيارات")
        XCTAssertEqual(answerOptions(for: "النجوم", in: app).count, 4, "يجب أن يظهر أربعة خيارات للفريق")
        keepScreenshot(named: "Question portrait — hidden answer", app: app)

        let pause = app.buttons["وقّف العداد مؤقتًا"]
        XCTAssertTrue(pause.isHittable, "زر إيقاف العداد يجب أن يكون قابلاً للمس")
        pause.tap()
        let resume = app.buttons["كمّل العداد وأظهر السؤال"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3), "يجب إظهار زر استكمال واضح بعد إيقاف الوقت")
        XCTAssertTrue(app.staticTexts["وقفنا الوقت"].exists, "يجب إعلان حالة الإيقاف للمستخدم")
        XCTAssertFalse(answerOption(for: "النجوم", in: app).exists, "يجب إخفاء خيارات السؤال أثناء الإيقاف")
        resume.tap()
        XCTAssertTrue(answerOption(for: "النجوم", in: app).waitForExistence(timeout: 3), "يجب أن يعود السؤال بعد استئناف الوقت")

        let double = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "مضاعفة السؤال")
        ).firstMatch
        XCTAssertTrue(makeHittable(double, in: app), "وسيلة مضاعفة السؤال يجب أن تكون قابلة للمس")
        double.tap()
        answerCurrentQuestionForAllTeams(in: app)
        XCTAssertTrue(app.staticTexts["الإجابة الصحيحة"].waitForExistence(timeout: 3), "يجب ظهور الإجابة مع السؤال")
        keepScreenshot(named: "Question portrait — revealed answer", app: app)
        app.buttons["التالي"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "سؤال ")).firstMatch.waitForExistence(timeout: 3), "يجب العودة للوحة بعد احتساب نتيجة السؤال")

        openNextQuestion(in: app)
        let skip = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "تغيير السؤال")
        ).firstMatch
        XCTAssertTrue(makeHittable(skip, in: app), "وسيلة تغيير السؤال يجب أن تكون قابلة للمس")
        skip.tap()
        answerCurrentQuestionForAllTeams(in: app)
        app.buttons["التالي"].tap()

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(waitForLandscapeLayout(in: app), "يجب أن تتمدد واجهة التطبيق فعليًا بعرض الوضع الأفقي")
        openNextQuestion(in: app)
        XCTAssertTrue(answerOption(for: "النجوم", in: app).waitForExistence(timeout: 4), "يجب فتح السؤال في الوضع الأفقي")
        let pass = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "مرّرها للخصم")
        ).firstMatch
        XCTAssertTrue(makeHittable(pass, in: app), "وسيلة تمرير السؤال يجب أن تكون قابلة للمس")
        pass.tap()
        keepScreenshot(named: "Question landscape", app: app)
        let passedOption = answerOption(for: "الصقور", in: app)
        XCTAssertTrue(makeHittable(passedOption, in: app), "يجب أن يتسلم فريق الصقور الخيارات بعد التمرير")
        passedOption.tap()
        XCTAssertTrue(app.staticTexts["الإجابة الصحيحة"].waitForExistence(timeout: 3))
        app.buttons["التالي"].tap()

        for _ in 0..<9 {
            openNextQuestion(in: app)
            XCTAssertTrue(activeAnswerOptions(in: app).firstMatch.waitForExistence(timeout: 3), "يجب فتح كل سؤال متبقٍ للفريق صاحب الدور")
            answerCurrentQuestionForAllTeams(in: app)
            app.buttons["التالي"].tap()
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
        app.launchEnvironment["FATINAH_GAME_FLOW_UI_TEST"] = "1"
        app.launchEnvironment["FATINAH_IMAGE_FLOW_UI_TEST"] = "1"
        app.launch()

        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 12), "يجب ظهور WKWebView")
        let option = answerOption(for: "النجوم", in: app)
        guard option.waitForExistence(timeout: 30) else {
            let marker = app.staticTexts.matching(
                NSPredicate(format: "label BEGINSWITH %@", "UI_TEST_ERROR:")
            ).firstMatch
            let detail = marker.waitForExistence(timeout: 2) ? marker.label : "no JavaScript error marker"
            XCTFail("يجب فتح السؤال المصوّر من fixture محلي: \(detail)")
            return
        }
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
        XCTAssertTrue(option.exists, "يجب أن تبقى خيارات الإجابة ظاهرة بعد التدوير")
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

        let option = answerOption(for: "النجوم", in: app)
        XCTAssertTrue(option.waitForExistence(timeout: 45), "يجب انتظار اكتمال إقلاع محتوى WKWebView")
        XCTAssertTrue(makeHittable(option, in: app), "خيارات الإجابة تبقى قابلة للمس مع أكبر Dynamic Type")
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
        app.launchEnvironment["FATINAH_GAME_FLOW_UI_TEST"] = "1"
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 12), "يجب ظهور WKWebView")
        let firstBoardCell = app.buttons.matching(
            NSPredicate(format: "isEnabled == true AND label BEGINSWITH %@", "سؤال ")
        ).firstMatch
        XCTAssertTrue(firstBoardCell.waitForExistence(timeout: 45), "يجب انتظار اكتمال إقلاع لوحة الجولة")
        return app
    }

    private func openNextQuestion(in app: XCUIApplication) {
        let existingOption = activeAnswerOptions(in: app).firstMatch
        if existingOption.exists {
            let questionClosed = NSPredicate { object, _ in
                guard let element = object as? XCUIElement else { return false }
                return !element.exists
            }
            let expectation = XCTNSPredicateExpectation(predicate: questionClosed, object: existingOption)
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
                let hitPoint = CGPoint(x: visibleFrame.midX, y: visibleFrame.midY)
                let appFrame = app.frame
                let point = CGVector(
                    dx: (hitPoint.x - appFrame.minX) / appFrame.width,
                    dy: (hitPoint.y - appFrame.minY) / appFrame.height
                )
                let label = element.label
                openedQuestionLabels.insert(label)
                app.coordinate(withNormalizedOffset: point).tap()
                let opened = activeAnswerOptions(in: app).firstMatch.waitForExistence(timeout: 3)
                if !opened { openedQuestionLabels.remove(label) }
                return opened
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

    private func answerOptions(for team: String, in app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "اختيار فريق \(team)"))
    }

    private func answerOption(for team: String, in app: XCUIApplication) -> XCUIElement {
        answerOptions(for: team, in: app).firstMatch
    }

    private func activeAnswerOptions(in app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "اختيار فريق "))
    }

    private func answerCurrentQuestionForAllTeams(in app: XCUIApplication) {
        let ownerOptions = activeAnswerOptions(in: app)
        XCTAssertTrue(ownerOptions.firstMatch.waitForExistence(timeout: 3), "يجب ظهور خيارات الفريق صاحب الدور")
        XCTAssertEqual(ownerOptions.count, 4, "يجب إتاحة أربعة خيارات للفريق صاحب الدور")
        let ownerOption = ownerOptions.firstMatch
        XCTAssertTrue(makeHittable(ownerOption, in: app), "يجب أن يكون خيار الفريق صاحب الدور قابلاً للمس")

        let ownerIsStars = ownerOption.label.contains("اختيار فريق النجوم")
        let ownerIsFalcons = ownerOption.label.contains("اختيار فريق الصقور")
        XCTAssertTrue(ownerIsStars || ownerIsFalcons, "يجب تحديد الفريق صاحب الدور من تسمية خيار الإجابة")
        guard ownerIsStars || ownerIsFalcons else { return }
        let secondTeam = ownerIsStars ? "الصقور" : "النجوم"
        ownerOption.tap()

        let secondOptions = answerOptions(for: secondTeam, in: app)
        XCTAssertTrue(secondOptions.firstMatch.waitForExistence(timeout: 3), "يجب ظهور خيارات الفريق الثاني قبل كشف الحل")
        XCTAssertEqual(secondOptions.count, 4, "يجب إعادة الخيارات للفريق الثاني")
        let secondOption = secondOptions.firstMatch
        XCTAssertTrue(makeHittable(secondOption, in: app), "يجب أن ينتقل السؤال للفريق الثاني قبل كشف الحل")
        XCTAssertFalse(app.staticTexts["الإجابة الصحيحة"].exists, "يجب ألا تنكشف الإجابة قبل إجابة الفريق الثاني")
        secondOption.tap()
        XCTAssertTrue(app.staticTexts["الإجابة الصحيحة"].waitForExistence(timeout: 3), "يجب كشف الحل بعد إجابة الفريقين")
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
