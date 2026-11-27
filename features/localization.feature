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
    And the instructions field shows the hint "例：React、TypeScript、Convexで開発します。簡潔で分かりやすく書いてください。"
    When I relaunch the localized desktop
    And I open Settings
    Then the Settings title is "一般" in "ja"
    When I choose English as the desktop language
    Then the Settings title is "General" in "en"
    And the "File" menu lists "Close"
    And the instructions field shows the hint "For example: I build with React, TypeScript and Convex. Write plainly and briefly."

  @settings.language @swift-pending @mac-pending @windows-pending
  Scenario: System follows the locale of the Linux desktop session
    When I choose Japanese as the desktop language
    And I choose the system language for the desktop
    And I relaunch the desktop with a Japanese Linux session locale
    And I open Settings
    Then the desktop's language preference is "system"
    And the Settings title is "一般" in "ja"

  @settings.language @swift-pending
  Scenario: Settings keeps its selected language when changing tabs
    When I choose Japanese as the desktop language
    And I open Settings on "models"
    Then the Settings title is "モデル" in "ja"
    When I open Settings on "pools"
    Then the Settings title is "プール" in "ja"
    When I open Settings on "devices"
    Then the Settings title is "スマホとブラウザ" in "ja"
    When I open Settings on "keyboard"
    Then the Settings title is "キーボード" in "ja"

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
    And the "permission" menu shows "フルアクセス" ticked
    When I pick "編集・実行前に確認" from the "permission" menu
    Then the composer's permission mode is "ask"
    When I type "バックアップを確認してください" in the composer
    And I press Return
    Then the transcript shows my message "バックアップを確認してください"

  @settings.language @swift-pending
  Scenario: Allowing an action in Japanese lets the agent continue
    When I choose Japanese as the desktop language
    And I open the thread "Make uploads resume after a crash"
    And I press "許可"
    Then the approval card has gone
    And the transcript shows a reply starting "Done"

  @settings.language @swift-pending
  Scenario: A Japanese reply menu copies the original message
    When I choose Japanese as the desktop language
    And I open the thread "Make uploads resume after a crash"
    And I choose "メッセージをコピー" from the menu of the reply starting "Uploads now pick up"
    Then the clipboard holds "Uploads now pick up where they stopped"

  @settings.language @swift-pending
  Scenario: Japanese inbox actions still move the thread to the right section
    When I choose Japanese as the desktop language
    Then the "受信トレイ" section lists "Morning brief"
    When I search the threads for "poster"
    Then the sidebar lists "Make a poster for the meetup"
    And the sidebar doesn't list "Morning brief"
    When I clear the search
    And I right-click the row "Morning brief"
    Then the row's menu offers "名前を変更 | スターを付ける | 休止 | アーカイブ | スレッドIDをコピー"
    When I open the Hibernate menu for "Morning brief"
    And I choose "1時間" in the menu
    Then the "休止中" section lists "Morning brief"
    When I open the thread "Rename the Settings tabs"
    And I archive the open thread
    Then the "アーカイブ済み" section lists "Rename the Settings tabs"
