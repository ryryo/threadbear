import Foundation
import Testing
@testable import ThreadbearKit

@Test func botActionsKeepTheWorkspaceRevisionAndOperationIdentity() async throws {
    let workspace = try JSONDecoder().decode(PhoneBotWorkspace.self, from: Data("""
        {"workspaceId":"workspace","ownerRunnerId":"mac","epoch":3,"profiles":[],"notes":[],"groups":[],"tasks":[],"requests":[]}
        """.utf8))
    let transport = BotActionTransport()
    let backend = ConvexBackend(transport: transport, token: "fixture")
    let commandId = try await backend.actOnBotWorkspace(
        workspace: workspace,
        action: .editNote(scope: "bot", scopeId: "editor", revision: "rev-3", entryId: "entry", text: "日本語の覚書"),
        operationId: "repeat-safe"
    )
    #expect(commandId == "command")
    let submitted = await transport.submitted
    #expect(submitted == [
        "token": .string("fixture"),
        "runnerId": .string("mac"),
        "input": .object([
            "workspaceId": .string("workspace"), "epoch": .number(3), "operationId": .string("repeat-safe"),
            "action": .object([
                "kind": .string("note.edit"), "scope": .object(["kind": .string("bot"), "id": .string("editor")]),
                "expectedRevision": .string("rev-3"), "entryId": .string("entry"), "text": .string("日本語の覚書"),
            ]),
        ]),
    ])
    let report = try JSONDecoder().decode(PhoneBotEditStatus.self, from: Data("""
        {"state":"done","result":{"outcome":"conflict","revision":"rev-4","rows":[{"id":"entry","text":"確定した覚書","pinned":false}]}}
        """.utf8))
    #expect(report.result?.revision == "rev-4")
    #expect(report.result?.rows?.first?.text == "確定した覚書")
}

private actor BotActionTransport: ConvexTransport {
    var submitted: [String: JSONValue]?

    func mutation(_ name: String, _ args: [String: JSONValue]) async throws -> Data {
        #expect(name == "phone:actOnBotWorkspace")
        submitted = args
        return Data("\"command\"".utf8)
    }

    func query(_ name: String, _ args: [String: JSONValue]) async throws -> Data { throw TransportError.server("Unexpected query") }

    nonisolated func connectionStates() -> AsyncStream<Bool> { AsyncStream { $0.finish() } }

    nonisolated func subscribe(_ name: String, _ args: [String: JSONValue]) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

@Test func onlyConfirmedErasedNoteTargetsClearStoredDrafts() throws {
    let name = "bot-device-erasure-test-" + UUID().uuidString
    let defaults = try #require(UserDefaults(suiteName: name))
    defer { defaults.removePersistentDomain(forName: name) }
    let localKey = "bot-note-draft:old-runner:workspace:1:bot:editor"
    let otherScope = "bot-note-draft:old-runner:workspace:1:group:editor"
    let otherWorkspace = "bot-note-draft:old-runner:other:1:bot:editor"
    let freshDraft = "bot-note-draft:old-runner:workspace:1:bot:fresh"
    let note = PhoneBotNoteDraft(text: "消す下書き", entryId: "shared-id", revision: "old")
    for key in [localKey, otherScope, otherWorkspace] {
        defaults.set(try JSONEncoder().encode(note), forKey: key)
    }
    defaults.set(try JSONEncoder().encode(PhoneBotNoteDraft(text: note.text, revision: "old")), forKey: freshDraft)
    let saved = PhoneBotNoteDraft.saved(in: defaults)
    #expect(saved.count == 3)
    let byKey = saved.map { $0.key == localKey }
    PhoneBotNoteDraft.clearErased(saved, confirmed: [], in: defaults)
    #expect(defaults.data(forKey: localKey) != nil)
    defaults.set(try JSONEncoder().encode(PhoneBotNoteDraft(text: "新しい下書き", entryId: "different-id", revision: "old")), forKey: localKey)
    PhoneBotNoteDraft.clearErased(saved, confirmed: byKey, in: defaults)
    #expect(defaults.data(forKey: localKey) != nil)
    defaults.set(try JSONEncoder().encode(note), forKey: localKey)
    PhoneBotNoteDraft.clearErased(saved, confirmed: byKey, in: defaults)
    #expect(defaults.data(forKey: localKey) == nil)
    for key in [otherScope, otherWorkspace, freshDraft] {
        #expect(defaults.data(forKey: key) != nil)
    }
}

@Test func confirmedBotDraftErasureBlocksAStaleWriteAndKeepsAnotherScope() throws {
    let suite = "bot-managed-drafts-" + UUID().uuidString
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let first = PhoneBotNoteDraft(text: "消す本文", entryId: "same-id", revision: "old")
    let ownKey = "bot-note-draft:source:workspace:1:bot:desk"
    let groupKey = "bot-note-draft:source:workspace:1:group:desk"
    let scope = try #require(first.target(workspaceId: "workspace", kind: "bot", scopeId: "desk"))
    #expect(PhoneBotNoteDraft.storeID(in: defaults) == PhoneBotNoteDraft.storeID(in: defaults))
    #expect(PhoneBotNoteDraft.persist(first, key: ownKey, in: defaults))
    #expect(PhoneBotNoteDraft.persist(first, key: groupKey, in: defaults))
    #expect(PhoneBotNoteDraft.confirmLocalRemoval([scope], in: defaults) == [scope])
    let reopened = try #require(UserDefaults(suiteName: suite))
    #expect(!PhoneBotNoteDraft.persist(first, key: ownKey, in: reopened))
    #expect(reopened.data(forKey: ownKey) == nil)
    #expect(reopened.data(forKey: groupKey) != nil)
    #expect(PhoneBotNoteDraft.confirmLocalRemoval([scope], in: reopened) == [scope])
}
