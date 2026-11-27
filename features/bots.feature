Feature: Bot workspace
  A Bot keeps notes the owner can see from each of its conversations.

  @bots.home @bots @swift-pending
  Scenario: Two conversations share a Bot's notes across a reconnect
    Given the app is connected to an isolated Bot Runner
    When I create a Bot called "編集者" from the Bots page
    And I open a new Bot conversation
    And I save a note from that conversation saying "見出しは短くする"
    And I open the Bot's Conversations tab
    And I open another Bot conversation
    Then the two Bot conversations have separate threads
    When the isolated Bot Runner restarts
    Then the app is connected again
    When I open memory from the current Bot conversation
    Then the Bot's notes show "見出しは短くする"

  @bots.roster_operations @bots @swift-pending
  Scenario: A Bot copy starts with a separate profile and memory
    Given the app is connected to an isolated Bot Runner
    When I create a Bot called "編集者" from the Bots page
    And I open the Bot's Memory tab
    And I select "Bot: 編集者" in Bot memory
    And I add a Bot memory note saying "元のBotだけの覚書"
    And I duplicate the Bot from the menu of "編集者"
    Then "編集者 copy" has no conversations or notes
    And "編集者" still has the note "元のBotだけの覚書"

  @bots.profile_panel @bots @web-runtime @web-runtime-fresh @swift-pending
  Scenario: The original profile editor saves one Bot and its lease closes with the view
    Given the app is connected to an isolated Bot Runner
    And the web runtime is installed
    When I create a Bot called "別のBot" from the Bots page
    And I create a Bot called "編集者" from the Bots page
    And I narrow the window beside Highlights
    And I open the original Bot profile editor
    Then the original profile cards show the Bot "編集者"
    And the original memory card shows "Nothing saved yet"
    When I set the original profile label to "校正者"
    Then the Bot "編集者" has the label "校正者"
    And the Bot "別のBot" has the label ""
    When I close the original Bot profile editor
    Then the old profile view cannot read the Bot
    When I give the Bot "別のBot" the note "別の覚書"
    And I give the Bot "編集者" the note "編集担当の覚書"
    And I open the original Bot profile editor
    Then the original memory card shows "1 entry"
    When I manage the memory from the original profile
    Then the Bot's notes show "編集担当の覚書"
    And the Bot's notes do not show "別の覚書"
    And the old profile view cannot read the Bot
    When I open the original Bot profile editor
    And I choose the original avatar's Star and Aurora
    Then the Bot "編集者" has the saved Star and Aurora avatar
    And the Bot "別のBot" has its default avatar
    When I close the original Bot profile editor
    And the isolated Bot Runner restarts
    Then the app is connected again
    And the Bot "編集者" has the saved Star and Aurora avatar
    When I open the original Bot profile editor
    And I reset the original avatar to its default
    Then the Bot "編集者" has its default avatar
    When I upload a raster photo using the original Bot editor
    Then the original Bot "編集者" shows its saved photo
    When I import a different photo into the original avatar library
    And I use the imported photo for the Bot
    And I remove the imported photo from the library
    Then the Bot "編集者" still uses the imported photo
    And the Bot "別のBot" has its default avatar

  @bots.roster_operations @bots @swift-pending
  Scenario: The owner can attach an existing conversation without replacing its transcript
    Given the app is connected to an isolated Bot Runner
    And a normal Thread called "既存の編集会議" has a saved reply
    When I create a Bot called "編集者" from the Bots page
    And I choose the existing Thread "既存の編集会議" for the Bot
    Then the ordinary Thread has no Bot yet
    When I confirm the Bot attachment
    Then I see the existing Thread with its saved reply and new Bot link
    When the isolated Bot Runner restarts
    Then the app is connected again
    And I see the existing Thread with its saved reply and new Bot link

  @bots.managed_restore @swift-pending
  Scenario: A managed backup shows an eligible note and restores only the confirmed selection
    Given the app is connected to an isolated Bot Runner
    When I view the backup for the Bot's memory
    And I select the backed-up note "復元する覚書"
    Then the Bot's notes show "現在の覚書"
    When I confirm restoration of the selected note
    Then the Bot's notes show "復元する覚書"
    And the Bot's notes show "現在の覚書"

  @bots.managed_restore @swift-pending
  Scenario: The owner backs up the selected Bot's current notes
    Given the app is connected to an isolated Bot Runner
    When I open the note backups for the Bot
    And I back up the current Bot notes
    Then I can open the newly created backup

  @bots.note_erasure @swift-pending
  Scenario: Permanent erasure needs a confirmation and shows the pending copies in history
    Given the app is connected to an isolated Bot Runner
    When I open the scoped notes for the Editorial Bot
    And I click the permanent erasure control for its note
    And I cancel permanent note erasure
    Then the Bot's notes show "現在の覚書"
    When I click the permanent erasure control for its note
    And I confirm permanent note erasure
    Then the note erasure says "Waiting for registered devices"
    When I check note erasure status again
    Then the note erasure says "Managed copies erased"
    And the Bot's notes do not show "現在の覚書"
    And the erased note has no undo action

  @bots.scoped_notes @bots @swift-pending
  Scenario: A workspace note stays in the workspace's memory
    Given the app is connected to an isolated Bot Runner
    When I create a Bot called "Writer" from the Bots page
    And I open the Bot's Memory tab
    And I select "Workspace team" in Bot memory
    And I add a Bot memory note saying "見出しに日付を入れる"
    Then the Bot's notes show "見出しに日付を入れる"
    When I select "Bot: Writer" in Bot memory
    And I add a Bot memory note saying "署名は不要"
    Then the Bot's notes show "署名は不要"
    And the Bot's notes do not show "見出しに日付を入れる"

  @bots.requests @bots @swift-pending
  Scenario: The original Bot conversation opens its saved request after a reconnect
    Given the app is connected to an isolated Bot Runner
    When I open a Bot conversation with a completed request
    And the isolated Bot Runner restarts
    Then the app is connected again
    When I open requests from the original Bot conversation
    And I read the saved Bot request result
    Then I see the full saved request result

  @bots.abandon @swift-pending
  Scenario: The owner can give up one Bot request and later read its saved reply
    Given the app is connected to an isolated Bot Runner
    When I open requests in the Bot workspace
    And I give up waiting for a delegated Bot request
    Then I can read the late Bot reply

  @bots.tasks @bots @swift-pending
  Scenario: A background task keeps its own thread and result after reconnect
    Given the app is connected to an isolated Bot Runner
    When I open a Bot conversation ready for a background task
    And I start a background task from that conversation
    And the isolated Bot Runner restarts
    Then the app is connected again
    When I open this Bot's background tasks
    And I read the saved background task result
    Then I see the full saved request result
    And I can open the background task's own thread
    And I can return directly to its original conversation

  @bots.teams @bots @swift-pending
  Scenario: The owner can replace the Chief of a Bot team
    Given the app is connected to an isolated Bot Runner
    When I create a Bot called "Editor" from the Bots page
    And I create a Bot called "Writer" from the Bots page
    And I create the Bot team "Editorial"
    And I add "Editor" to the Bot team
    And I add "Writer" to the Bot team
    And I appoint "Editor" as the first Chief
    And I replace the Chief with "Writer"
    Then "Writer" is the Chief of the Bot team

  @bots.teams @bots @settings.language @swift-pending
  Scenario: A Japanese Bot team can appoint a Chief
    Given the app is connected to an isolated Bot Runner
    When I create a Bot called "Editor" from the Bots page
    And I create the Bot team "Editorial"
    And I open Settings
    And I choose Japanese as the desktop language
    Then the Settings title is "一般" in "ja"
    When I add "Editor" to the team and appoint it as Chief in Japanese
    Then "Editor" is the Chief of the Bot team

  @bots.groups @bots @swift-pending
  Scenario: The owner creates a Group and finds its saved reply after reconnect
    Given the app is connected to an isolated Bot Runner
    When I create a Bot called "Writer" from the Bots page
    And I create a Group called "Editorial" with "Writer"
    And I post "見出し案をください" to the Group
    Then the Group has the full saved reply
    When I approve the Group's reply as a note
    And the isolated Bot Runner restarts
    Then the app is connected again
    And the Group has the full saved reply
    And the Group memory has one approved note from the reply
    When I stop the Group's work
    Then the Group can be resumed

  @bots.group_search @bots @swift-pending
  Scenario: The owner can continue Group history search beyond the newest page
    Given the app is connected to an isolated Bot Runner
    When I create a Bot called "Writer" from the Bots page
    And I create a Group called "Editorial" with "Writer"
    And I save 21 Group history posts matching "検索語"
    And I search Group history for "検索語"
    Then the Group history offers older results
    When I open the older Group search results
    Then the Group search shows "検索語 item 0"

  @bots.schedules @bots @swift-pending
  Scenario: Run a saved schedule in a new conversation with the same Bot
    Given the app is connected to an isolated Bot Runner
    When I create a Bot called "Editor" from the Bots page
    And I schedule a new Bot conversation saying "見出し案を送る"
    And I run the saved Bot schedule now
    Then the scheduled message ran in a new conversation with "Editor"

  @bots.worker @remote-threads @swift-pending
  Scenario: The owner opens a completed worker's result from the Bot conversation
    Given the app is connected to an isolated Bot Runner
    When I open the conversations for the worker's Bot
    And I ask "mac-mini" to do work for the Bot saying "見出しを確認してください"
    Then I can open the remote worker's saved Thread
    When I open the conversations for the worker's Bot
    And I open the worker requests for that conversation
    Then I can open the remote worker's saved Thread

  @bots.workspace_move @swift-pending
  Scenario: The owner chooses a destination and Project before starting a workspace move
    Given the app is connected to an isolated Bot Runner
    When I open the Bot workspace move
    And I choose "Studio Mac" as the Bot workspace destination
    Then I cannot move the workspace before choosing what to do with its Project
    When I assign the Bot workspace Project to "Editorial on Studio Mac"
    And I confirm the Bot workspace move
    Then I can see that the Bot workspace transfer is waiting for the destination
    When I cancel the Bot workspace transfer
    Then I can see that the Bot workspace transfer was cancelled
