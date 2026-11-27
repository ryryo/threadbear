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
