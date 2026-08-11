import ProjectDescription

// Dynamic configuration via TUIST_* environment variables.
// The builder sets these before running `tuist generate`.
// For local development, defaults are used.
//
// Mapping:  Environment.camelCase  →  TUIST_CAMEL_CASE
//
let projectName = Environment.projectName.getString(default: "MedianIOS")
let targetName = Environment.targetName.getString(default: "Median")
let bundleId = Environment.bundleId.getString(default: "io.gonative.ios.dev")
let marketingVersion = Environment.marketingVersion.getString(default: "1.0")
let projectVersion = Environment.projectVersion.getString(default: "2")
let appName = Environment.appName.getString(default: "Median")

let project = Project(
    name: projectName,
    organizationName: "GoNative.io",
    options: .options(
        developmentRegion: "en"
    ),
    packages: [
        .remote(url: "median.go-native-core", requirement: .exact("3.0.11")),
        .remote(url: "median.median-icons", requirement: .upToNextMajor(from: "1.2.0")),
        .remote(url: "https://github.com/ZipArchive/ZipArchive", requirement: .upToNextMajor(from: "2.6.0")),
        // Active plugins are injected here by the builder at build time.
        // MARK: BUILDER_PLUGINS
    ],
    targets: [
        .target(
            name: targetName,
            destinations: [.iPhone, .iPad],
            product: .app,
            bundleId: bundleId,
            deploymentTargets: .iOS("15.5"),
            infoPlist: .file(path: "LeanIOS/MedianIOS-Info.plist"),
            sources: [
                "LeanIOS/**/*.swift",
                "LeanIOS/**/*.m",
                "LeanIOS/**/*.h"
            ],
            resources: [
                "LeanIOS/**/*.storyboard",
                "LeanIOS/**/*.xib",
                "LeanIOS/**/*.xcassets",
                "LeanIOS/**/*.json",
                "LeanIOS/**/*.js",
                "LeanIOS/**/*.css",
                "LeanIOS/**/*.html",
                "LeanIOS/**/*.zip",
                "LeanIOS/**/*.wav",
                "LeanIOS/**/*.ttf",
                "LeanIOS/**/*.bundle",
                "LeanIOS/**/*.xcprivacy",
                .glob(pattern: "LeanIOS/**/*.strings"),
                "LeanIOS/iosHeaderImage",
                "LeanIOS/AppIcon",
                "GoogleService-Info.plist"
            ],
            entitlements: "Project.entitlements",
            dependencies: [
                .package(product: "GoNativeCore"),
                .package(product: "MedianIcons"),
                .package(product: "ZipArchive"),
                // Active plugin dependencies are injected here by the builder at build time.
                // MARK: BUILDER_PLUGIN_DEPENDENCIES
                .sdk(name: "Foundation", type: .framework),
                .sdk(name: "UIKit", type: .framework),
                .sdk(name: "CoreGraphics", type: .framework),
                .sdk(name: "AudioToolbox", type: .framework),
                .sdk(name: "CFNetwork", type: .framework),
                .sdk(name: "CoreLocation", type: .framework),
                .sdk(name: "QuartzCore", type: .framework),
                .sdk(name: "Security", type: .framework),
                .sdk(name: "SystemConfiguration", type: .framework),
                .sdk(name: "Accounts", type: .framework),
                .sdk(name: "Social", type: .framework),
                .sdk(name: "MessageUI", type: .framework),
                .sdk(name: "MediaAccessibility", type: .framework),
                .sdk(name: "CoreText", type: .framework),
                .sdk(name: "AppTrackingTransparency", type: .framework)
            ],
            settings: .settings(
                base: [
                    "SWIFT_VERSION": "5.0",
                    "SWIFT_OBJC_BRIDGING_HEADER": "LeanIOS/GonativeIO-Bridging-Header.h",
                    "SWIFT_OBJC_INTERFACE_HEADER_NAME": "GonativeIO-Swift.h",
                    "GCC_PREFIX_HEADER": "LeanIOS/MedianIOS-Prefix.pch",
                    "GCC_PRECOMPILE_PREFIX_HEADER": "YES",
                    "ENABLE_BITCODE": "NO",
                    "CLANG_ENABLE_MODULES": "YES",
                    "OTHER_LDFLAGS": "-ObjC $(inherited)",
                    "MARKETING_VERSION": .string(marketingVersion),
                    "CURRENT_PROJECT_VERSION": .string(projectVersion),
                    "BUILD_SETTINGS_APP_NAME": .string(appName),
                    "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
                    "IPHONEOS_DEPLOYMENT_TARGET": "15.5",
                    "TARGETED_DEVICE_FAMILY": "1,2",
                    "ENABLE_USER_SCRIPT_SANDBOXING": "NO",
                    "DEVELOPMENT_LANGUAGE": "en",
                    "HEADER_SEARCH_PATHS": "$(inherited) $(SRCROOT)/LeanIOS $(SRCROOT)/LeanIOS/REFrostedViewController"
                ],
                configurations: [
                    .debug(name: "Debug", settings: [
                        "SWIFT_OPTIMIZATION_LEVEL": "-Onone",
                        "CODE_SIGN_STYLE": "Automatic",
                        "CODE_SIGN_IDENTITY": "Apple Development",
                        "DEVELOPMENT_TEAM": ""
                    ]),
                    .release(name: "Release", settings: [
                        "SWIFT_OPTIMIZATION_LEVEL": "-O",
                        "SWIFT_COMPILATION_MODE": "wholemodule",
                        "CODE_SIGN_STYLE": "Automatic",
                        "CODE_SIGN_IDENTITY": "Apple Development",
                        "DEVELOPMENT_TEAM": ""
                    ])
                ]
            )
        ),
        .target(
            name: "\(targetName)Tests",
            destinations: [.iPhone, .iPad],
            product: .unitTests,
            bundleId: "\(bundleId)Tests",
            deploymentTargets: .iOS("15.5"),
            infoPlist: .file(path: "LeanIOSTests/MedianIOSTests-Info.plist"),
            sources: ["LeanIOSTests/**/*.m"],
            dependencies: [
                .target(name: targetName)
            ],
            settings: .settings(
                base: [
                    "GCC_PREFIX_HEADER": "LeanIOS/MedianIOS-Prefix.pch",
                    "GCC_PRECOMPILE_PREFIX_HEADER": "YES"
                ]
            )
        ),
        // Extension targets will be added here by scan-extensions.js,
    ]
)