Median iOS
============

This is the native iOS code used by https://median.co/

It allows the creation of full-featured native apps from existing mobile-optimized websites.

How to use
------------

This project uses [Tuist](https://tuist.io/) for project generation and dependency management.

### Prerequisites

Install Tuist:
```bash
curl -Ls https://install.tuist.io | bash
```

### Generate the Xcode Project

```bash
tuist generate
```

This will:
- Generate `MedianIOS.xcworkspace` and `MedianIOS.xcodeproj`
- Resolve Swift Package Manager dependencies
- Configure targets and build settings

### Build the Project

After generation, open the workspace:
```bash
open MedianIOS.xcworkspace
```

Or build from the command line:
```bash
tuist build Median
```

### Additional Commands

- `tuist clean` - Clean generated files
- `tuist edit` - Edit Tuist manifests in Xcode
- `tuist graph` - Visualize project dependencies

For more details, see the [build documentation](https://median.co/docs/build-ios-from-source).

### Troubleshooting

#### Checksum mismatch error when resolving packages

If `tuist generate` fails with an error like:

```
invalid registry source archive checksum '...', expected '...'
```

This is caused by a stale fingerprint entry in SPM's security store (separate from all other caches). It occurs when a package version is deleted and republished on the registry. Fix it by deleting the cached fingerprint for the affected package:

```bash
rm ~/.swiftpm/security/fingerprints/median.go-native-core.json
```

Then re-run `tuist generate`. SPM will re-trust the new checksum on first fetch.

Licensing information available at https://median.co/license
