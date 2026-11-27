# App Versioning Convention

Starting from version `1.0.3`, the project follows this exact numbering progression:
- Next version: `1.0.04`
- Followed by: `1.0.05`, `1.0.06` ... up to `1.0.999`
- After `1.0.999`: `1.1.0`

Rules:
1. `versionName` in `android/app/build.gradle` and git release tags (`v1.0.XX-app`) must use this exact string format.
2. `versionCode` in `android/app/build.gradle` must always increment by 1 (e.g. 4, 5, 6...).
3. Single APK asset naming: `AyushServer-v<version>.apk`.
