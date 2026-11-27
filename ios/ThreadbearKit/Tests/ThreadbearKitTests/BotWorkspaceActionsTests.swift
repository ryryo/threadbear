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
