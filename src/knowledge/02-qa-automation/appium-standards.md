# Mobile Automation & Appium Standards

## 1. Cross-Platform Parity
- iOS and Android UI components must share the same semantic identifiers whenever possible to allow for shared test scripts.

## 2. Locator Strategies
- **iOS Locators:** Prioritize native iOS Class Chain (`-ios class chain`) and Predicate String (`-ios predicate string`) locators for maximum performance. Avoid XPath on iOS entirely.
- **Android Locators:** Utilize Jetpack Compose `testTag` modifiers and accessibility content descriptions to target elements. 

## 3. Application Code Testability
- **iOS:** Attach `.accessibilityIdentifier("ScreenName.ElementName")` to all interactive SwiftUI views.
- **Android:** Apply `Modifier.testTag("ScreenName.ElementName")` to all interactive Compose nodes.
