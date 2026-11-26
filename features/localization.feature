Feature: Desktop language

  Background:
    Given the app is connected to a runner with the demo threads
    When I open Settings

  @settings.language @swift-pending
  Scenario: Japanese and English apply without restarting
    Then the Settings title is "General" in "en"
    When I choose Japanese as the desktop language
    Then the Settings title is "一般" in "ja"
    And the "ファイル" menu lists "閉じる"
    When I relaunch the localized desktop
    And I open Settings
    Then the Settings title is "一般" in "ja"
    When I choose English as the desktop language
    Then the Settings title is "General" in "en"
    And the "File" menu lists "Close"
