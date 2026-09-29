#!/bin/bash
# Mac-only native compiler verification. Does not launch the market backend.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Xcode verification requires your Mac. No native compile was performed."
  exit 1
fi
command -v node >/dev/null || { echo "Install Node 22+ first."; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<22){console.error("Use Node 22+");process.exit(1)}'
command -v xcodebuild >/dev/null || { echo "Install/select full Xcode first."; exit 1; }
xcodebuild -version
xcode_version="$(xcodebuild -version | awk '/^Xcode / {print $2}')"
[[ "${xcode_version%%.*}" -ge 26 ]] || { echo "Use Xcode 26+ for this Capacitor project."; exit 1; }
[[ -d node_modules ]] || { echo "Run npm ci in this folder first."; exit 1; }

npm run test:mobile
npm run test:calculations
npm run ios:sync
npm run ios:preflight
plutil -lint ios/App/App/Info.plist ios/App/App.xcodeproj/project.pbxproj

derived="$PWD/ios/DerivedData"
logs="$derived/verification-logs"
mkdir -p "$logs"
project="ios/App/App.xcodeproj"
xcodebuild -resolvePackageDependencies -project "$project" -scheme App \
  -clonedSourcePackagesDirPath "$derived/SourcePackages" \
  2>&1 | tee "$logs/packages.log"

for configuration in Debug Release; do
  xcodebuild -project "$project" -scheme App -configuration "$configuration" \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$derived" \
    -clonedSourcePackagesDirPath "$derived/SourcePackages" \
    CODE_SIGNING_ALLOWED=NO build 2>&1 | tee "$logs/$configuration.log"
done
echo "PASS: Debug and Release compiled for iOS Simulator."
echo "Next: Run in Simulator, then select your signing team and test on your iPhone."
echo "This does not verify physical-device signing, runtime behavior, live data, or security."
echo "Logs: $logs (inspect/redact local paths and identifiers before sharing)."
