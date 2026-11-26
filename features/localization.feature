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

  @settings.language @swift-pending
  Scenario: A Japanese menu and approval keep their original actions
    When I choose Japanese as the desktop language
    Then the "ファイル" menu lists "新しいスレッド | 閉じる"
    When I open the thread "Make uploads resume after a crash"
    Then an approval card asks to run "rm -rf .build DerivedData"
    When I press "拒否"
    Then the transcript shows a reply starting "OK, I left it alone"

  @settings.language @swift-pending
  Scenario: Starting a thread in Japanese keeps the message as typed
    When I choose Japanese as the desktop language
    And I start a new thread
    Then the new-thread page asks "何から始めましょうか？"
    When I type "バックアップを確認してください" in the composer
    And I press Return
    Then the transcript shows my message "バックアップを確認してください"
