import Foundation

public let botWorkspaceAPIVersion = 106
public let botNoteErasureAPIVersion = 108

public struct PhoneBotNoteTarget: Sendable, Hashable {
    public let workspaceId: String
    public let kind: String
    public let scopeId: String
    public let entryId: String

    public init?(workspaceId: String, kind: String, scopeId: String, entryId: String) {
        guard ["bot", "group"].contains(kind),
              [workspaceId, scopeId, entryId].allSatisfy({ !$0.isEmpty && $0.utf16.count <= 128 }) else { return nil }
        self.workspaceId = workspaceId
        self.kind = kind
        self.scopeId = scopeId
        self.entryId = entryId
    }

    var arguments: JSONValue {
        .object(["workspaceId": .string(workspaceId), "scope": .object(["kind": .string(kind), "id": .string(scopeId)]),
                 "entryId": .string(entryId)])
    }
}

public struct PhoneBotNoteDraft: Codable, Equatable {
    public var text = ""
    public var entryId: String?
    public var removingEntryId: String?
    public var revision: String
    public var operationId = UUID().uuidString
    public var commandId: String?

    public init(text: String = "", entryId: String? = nil, removingEntryId: String? = nil, revision: String) {
        self.text = text
        self.entryId = entryId
        self.removingEntryId = removingEntryId
        self.revision = revision
    }

    public func target(workspaceId: String, kind: String, scopeId: String) -> PhoneBotNoteTarget? {
        guard let noteId = entryId ?? removingEntryId else { return nil }
        return PhoneBotNoteTarget(workspaceId: workspaceId, kind: kind, scopeId: scopeId, entryId: noteId)
    }

    public struct Stored: Hashable, Sendable {
        public let key: String
        public let target: PhoneBotNoteTarget
    }

    private static func stored(_ key: String, defaults: UserDefaults) -> Stored? {
        let parts = key.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 6, parts[0] == "bot-note-draft", Int(parts[3]) != nil,
              let data = defaults.data(forKey: key), let draft = try? JSONDecoder().decode(Self.self, from: data),
              let target = draft.target(workspaceId: String(parts[2]), kind: String(parts[4]), scopeId: String(parts[5])) else { return nil }
        return Stored(key: key, target: target)
    }

    public static func saved(in defaults: UserDefaults = .standard) -> [Stored] {
        defaults.dictionaryRepresentation().keys.sorted().compactMap { stored($0, defaults: defaults) }
    }

    public static func clearErased(_ drafts: [Stored], confirmed: [Bool], in defaults: UserDefaults = .standard) {
        guard drafts.count == confirmed.count else { return }
        for (draft, erased) in zip(drafts, confirmed) where erased && stored(draft.key, defaults: defaults) == draft {
            defaults.removeObject(forKey: draft.key)
        }
    }
}


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
