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
