import Foundation

public let botWorkspaceAPIVersion = 108

public struct PhoneBotProfile: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let revision: Int
    public let name: String
    public let role: String
    public let instructions: String
}

public struct PhoneBotWorkspace: Decodable, Sendable, Identifiable {
    public var id: String { workspaceId }
    public let ownerRunnerId: String
    public let workspaceId: String
    public let epoch: Int
    public let profiles: [PhoneBotProfile]
    public let notes: [NoteScope]
    public let tasks: [Work]
    public let requests: [Work]
    public let groups: [Group]

    public struct NoteScope: Decodable, Sendable {
        public let scope: String
        public let scopeId: String
        public let revision: String
        public let rows: [Note]
    }

    public struct Note: Decodable, Sendable, Identifiable {
        public let id: String
        public let text: String
        public let pinned: Bool?
    }

    public struct Work: Decodable, Sendable, Identifiable {
        public let id: String
        public let threadId: String
        public let title: String?
        public let revision: Int?
        public let status: String
    }

    public struct Group: Decodable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let status: String
        public let queued: Int
        public let events: [Note]
    }
}

public struct PhoneBotEditStatus: Decodable, Sendable {
    public let state: CommandState
    public let note: String?
    public let result: Result?

    public struct Result: Decodable, Sendable {
        public let outcome: String
        public let bot: PhoneBotProfile?
        public let current: PhoneBotProfile?
        public let revision: String?
        public let rows: [PhoneBotWorkspace.Note]?
    }
}

public enum PhoneBotAction: Sendable {
    case addNote(scope: String, scopeId: String, revision: String, text: String)
    case editNote(scope: String, scopeId: String, revision: String, entryId: String, text: String)
    case removeNote(scope: String, scopeId: String, revision: String, entryId: String)
    case postToGroup(groupId: String, text: String)
    case stopTask(taskId: String, revision: Int)

    var arguments: [String: JSONValue] {
        switch self {
        case let .addNote(scope, id, revision, text):
            Self.note("note.add", scope, id, revision, ["text": .string(text)])
        case let .editNote(scope, id, revision, entryId, text):
            Self.note("note.edit", scope, id, revision, ["entryId": .string(entryId), "text": .string(text)])
        case let .removeNote(scope, id, revision, entryId):
            Self.note("note.remove", scope, id, revision, ["entryId": .string(entryId)])
        case let .postToGroup(groupId, text):
            ["kind": .string("group.post"), "groupId": .string(groupId), "text": .string(text)]
        case let .stopTask(taskId, revision):
            ["kind": .string("task.stop"), "taskId": .string(taskId), "expectedRevision": .number(Double(revision))]
        }
    }

    private static func note(_ kind: String, _ scope: String, _ id: String, _ revision: String, _ changes: [String: JSONValue]) -> [String: JSONValue] {
        var result = changes
        result["kind"] = .string(kind)
        result["scope"] = .object(["kind": .string(scope), "id": .string(id)])
        result["expectedRevision"] = .string(revision)
        return result
    }
}
