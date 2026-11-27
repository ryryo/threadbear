import SwiftUI
import ThreadbearKit

struct DeviceBotsView: View {
    @Environment(AppModel.self) private var model
    @State private var workspaces: [PhoneBotWorkspace] = []
    @State private var loaded = false
    @State private var problem: String?

    var body: some View {
        List {
            if let problem { Text(problem).foregroundStyle(.secondary) }
            if !loaded && problem == nil { ProgressView() }
            if loaded && workspaces.isEmpty { Text("No Bot workspace is available.") }
            ForEach(workspaces) { workspace in
                ForEach(workspace.profiles) { bot in
                    NavigationLink {
                        DeviceBotProfileView(workspace: workspace, profile: bot)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(bot.name)
                            if !bot.role.isEmpty { Text(bot.role).foregroundStyle(.secondary) }
                        }
                    }
                }
                ForEach(workspace.groups) { group in
                    Section(group.title) {
                        NavigationLink(group.title) {
                            DeviceBotGroupView(workspace: workspace, group: group)
                        }
                        Text(group.status.capitalized).foregroundStyle(.secondary)
                    }
                }
                if !workspace.tasks.isEmpty || !workspace.requests.isEmpty {
                    Section("Work") {
                        ForEach(workspace.tasks + workspace.requests) { row in
                            VStack(alignment: .leading) {
                                Text(row.title ?? "Bot request")
                                Text(row.status).foregroundStyle(.secondary)
                                if let revision = row.revision, ["reserved", "queued", "running", "waiting_work"].contains(row.status) {
                                    DeviceBotStopTask(workspace: workspace, row: row, revision: revision)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Bots")
        .background {
            if (model.apiVersion ?? 0) >= botNoteErasureAPIVersion {
                StoredBotNoteSweep()
            }
        }
        .task {
            guard let backend = model.backend else { return }
            do {
                for try await snapshot in backend.botWorkspaces() {
                    workspaces = snapshot
                    loaded = true
                }
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

private struct DeviceBotDraft: Codable, Equatable {
    var base: PhoneBotProfile
    var edits: [String: String] = [:]
    var operationId: String = UUID().uuidString
    var commandId: String?
}

private struct DeviceBotProfileView: View {
    @Environment(AppModel.self) private var model
    let workspace: PhoneBotWorkspace
    let profile: PhoneBotProfile
    @State private var draft: DeviceBotDraft
    @State private var waiting = false
    @State private var note: String?
    @State private var conflict: PhoneBotProfile?
    private let draftKey: String

    init(workspace: PhoneBotWorkspace, profile: PhoneBotProfile) {
        self.workspace = workspace
        self.profile = profile
        let key = "bot-draft:\(workspace.ownerRunnerId):\(workspace.id):\(workspace.epoch):\(profile.id)"
        draftKey = key
        let saved = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(DeviceBotDraft.self, from: $0) }
        _draft = State(initialValue: saved ?? DeviceBotDraft(base: profile))
    }

    private func value(_ key: String, _ original: KeyPath<PhoneBotProfile, String>) -> Binding<String> {
        Binding {
            draft.edits[key] ?? draft.base[keyPath: original]
        } set: { newValue in
            draft.edits[key] = newValue == draft.base[keyPath: original] ? nil : newValue
            draft.operationId = UUID().uuidString
            draft.commandId = nil
        }
    }

    var body: some View {
        Form {
            Section("Settings") {
                TextField("Bot name", text: value("name", \.name))
                TextField("Role", text: value("role", \.role))
                TextField("Instructions", text: value("instructions", \.instructions), axis: .vertical)
                Button("Save settings") { Task { await save() } }
                    .disabled(waiting || draft.edits.isEmpty || conflict != nil)
            }
            .disabled(waiting)
            if waiting { ProgressView("Waiting for Runner") }
            if let note { Text(note).foregroundStyle(.secondary) }
            if let conflict {
                Section("Settings changed on the Runner") {
                    if let edited = draft.edits["name"] { Text("Saved: \(conflict.name)"); Text("Draft: \(edited)") }
                    if let edited = draft.edits["role"] { Text("Saved: \(conflict.role)"); Text("Draft: \(edited)") }
                    if let edited = draft.edits["instructions"] { Text("Saved: \(conflict.instructions)"); Text("Draft: \(edited)") }
                    Button("Use saved settings") { draft = DeviceBotDraft(base: conflict); self.conflict = nil }
                    Button("Continue editing my draft") {
                        draft = DeviceBotDraft(base: conflict, edits: draft.edits)
                        self.conflict = nil
                    }
                }
            }
            if let scope = workspace.notes.first(where: { $0.scope == "bot" && $0.scopeId == profile.id }) {
                DeviceBotNotes(workspace: workspace, scope: scope)
            }
        }
        .navigationTitle(draft.base.name)
        .onChange(of: draft) { _, next in
            if next.edits.isEmpty && next.commandId == nil { UserDefaults.standard.removeObject(forKey: draftKey) }
            else { UserDefaults.standard.set(try? JSONEncoder().encode(next), forKey: draftKey) }
        }
        .task(id: draft.commandId) {
            guard let id = draft.commandId, let backend = model.backend else { return }
            waiting = true
            defer { waiting = false }
            do {
                for try await status in backend.botEditStatus(id) {
                    guard let status else { note = "The Runner could not confirm this edit."; break }
                    if status.state == .failed { note = status.note ?? "The Runner could not confirm this edit."; break }
                    guard status.state == .done else { continue }
                    if let current = status.result?.current {
                        conflict = current
                    } else if let saved = status.result?.bot {
                        draft = DeviceBotDraft(base: saved)
                        note = "Settings saved."
                    } else {
                        note = "The Runner did not return the saved Bot."
                    }
                    break
                }
            } catch {
                note = error.localizedDescription
            }
        }
    }

    private func save() async {
        guard let backend = model.backend, !waiting else { return }
        waiting = true
        note = nil
        defer { waiting = false }
        do {
            draft.commandId = try await backend.editBotProfile(workspace: workspace, profile: draft.base, settings: draft.edits, operationId: draft.operationId)
        } catch {
            note = error.localizedDescription
        }
    }
}

private struct DeviceBotCommand {
    let operationId: String
    let action: PhoneBotAction

    func submit(workspace: PhoneBotWorkspace, backend: any Backend, accepted: (String) -> Void) async throws -> PhoneBotEditStatus.Result {
        let id = try await backend.actOnBotWorkspace(workspace: workspace, action: action, operationId: operationId)
        accepted(id)
        return try await Self.result(id, backend: backend)
    }

    static func result(_ id: String, backend: any Backend) async throws -> PhoneBotEditStatus.Result {
        for try await status in backend.botEditStatus(id) {
            guard let status else { break }
            if status.state == .failed { throw TransportError.server(status.note ?? "The Runner refused the action.") }
            if status.state == .done, let result = status.result { return result }
        }
        try Task.checkCancellation()
        throw TransportError.server("The Runner could not confirm this action.")
    }
}

private struct StoredBotNoteSweep: View {
    @Environment(AppModel.self) private var model
    @State private var drafts = PhoneBotNoteDraft.saved()

    var body: some View {
        ForEach(Array(stride(from: 0, to: drafts.count, by: 32)), id: \.self) { start in
            let batch = Array(drafts[start..<min(start + 32, drafts.count)])
            Color.clear.task(id: batch) {
                guard let backend = model.backend else { return }
                do {
                    for try await erased in backend.botNoteErasures(batch.map(\.target)) {
                        PhoneBotNoteDraft.clearErased(batch, confirmed: erased)
                    }
                } catch {
                    // An unavailable backend does not confirm an erasure.
                }
            }
        }
    }
}

private struct DeviceBotNotes: View {
    @Environment(AppModel.self) private var model
    let workspace: PhoneBotWorkspace
    let scope: PhoneBotWorkspace.NoteScope
    @State private var conflictRows: [PhoneBotWorkspace.Note]?
    @State private var draft: PhoneBotNoteDraft
    @State private var conflictRevision: String?
    @State private var waiting = false
    @State private var problem: String?
    let draftKey: String

    init(workspace: PhoneBotWorkspace, scope: PhoneBotWorkspace.NoteScope) {
        self.workspace = workspace
        self.scope = scope
        let key = "bot-note-draft:\(workspace.ownerRunnerId):\(workspace.id):\(workspace.epoch):\(scope.scope):\(scope.scopeId)"
        draftKey = key
        let saved = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(PhoneBotNoteDraft.self, from: $0) }
        _draft = State(initialValue: saved ?? PhoneBotNoteDraft(revision: scope.revision))
    }

    private var erasureTarget: PhoneBotNoteTarget? {
        guard (model.apiVersion ?? 0) >= botNoteErasureAPIVersion else { return nil }
        return draft.target(workspaceId: workspace.id, kind: scope.scope, scopeId: scope.scopeId)
    }

    private var conflictTargets: [PhoneBotNoteTarget] {
        guard (model.apiVersion ?? 0) >= botNoteErasureAPIVersion else { return [] }
        return (conflictRows ?? []).compactMap {
            PhoneBotNoteTarget(workspaceId: workspace.id, kind: scope.scope, scopeId: scope.scopeId, entryId: $0.id)
        }
    }

    var body: some View {
        Section("Notes") {
            ForEach(conflictRows ?? scope.rows) { row in
                VStack(alignment: .leading) {
                    Text(row.text)
                    if row.pinned != true {
                        HStack {
                            Button("Edit") { draft = PhoneBotNoteDraft(text: row.text, entryId: row.id, revision: draft.revision) }
                            Button("Remove", role: .destructive) {
                                if draft.removingEntryId != row.id {
                                    draft = PhoneBotNoteDraft(removingEntryId: row.id, revision: scope.revision)
                                }
                                Task { await submit(.removeNote(scope: scope.scope, scopeId: scope.scopeId, revision: draft.revision, entryId: row.id)) }
                            }
                            .disabled(!draft.text.isEmpty)
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
            if let id = draft.removingEntryId, !scope.rows.contains(where: { $0.id == id }) {
                Button("Retry removal") {
                    Task { await submit(.removeNote(scope: scope.scope, scopeId: scope.scopeId, revision: draft.revision, entryId: id)) }
                }
            }
            TextField(draft.entryId == nil ? "Add note" : "Edit note", text: Binding(
                get: { draft.text },
                set: { value in
                    if draft.removingEntryId != nil { discardDraft() }
                    draft.text = String(value.prefix(300))
                    draft.operationId = UUID().uuidString
                    draft.commandId = nil
                }
            ), axis: .vertical)
            Button("Save note") {
                let action: PhoneBotAction
                if let id = draft.entryId {
                    action = .editNote(scope: scope.scope, scopeId: scope.scopeId, revision: draft.revision, entryId: id, text: draft.text)
                } else {
                    action = .addNote(scope: scope.scope, scopeId: scope.scopeId, revision: draft.revision, text: draft.text)
                }
                Task { await submit(action) }
            }
            .disabled(draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if !draft.text.isEmpty || draft.entryId != nil || draft.removingEntryId != nil {
                Button("Discard draft") { discardDraft() }
            }
        }
        .disabled(waiting || conflictRevision != nil)
        if waiting { ProgressView("Waiting for Runner") }
        if let problem { Text(problem).foregroundStyle(.secondary) }
        if let revision = conflictRevision {
            Section("Notes changed on the Runner") {
                Button("Use saved notes") {
                    draft = PhoneBotNoteDraft(revision: revision)
                    conflictRevision = nil
                    conflictRows = nil
                }
                if !draft.text.isEmpty {
                    Button("Continue editing my draft") {
                        draft.revision = revision
                        draft.operationId = UUID().uuidString
                        conflictRevision = nil
                    conflictRows = nil
                    }
                }
            }
        }
        Color.clear.frame(height: 0)
            .background {
                let targets = conflictTargets
                ForEach(Array(stride(from: 0, to: targets.count, by: 32)), id: \.self) { start in
                    let batch = Array(targets[start..<min(start + 32, targets.count)])
                    Color.clear.task(id: batch) {
                        guard let backend = model.backend else { return }
                        do {
                            for try await erased in backend.botNoteErasures(batch) {
                                guard erased.count == batch.count, !Task.isCancelled else { continue }
                                let ids = Set(zip(batch, erased).compactMap { $0.1 ? $0.0.entryId : nil })
                                if !ids.isEmpty { conflictRows?.removeAll { ids.contains($0.id) } }
                            }
                        } catch {
                            // Unconfirmed rows stay until the next authoritative result.
                        }
                    }
                }
            }
            .onChange(of: draft) { _, next in
                if next.text.isEmpty && next.commandId == nil && next.removingEntryId == nil { UserDefaults.standard.removeObject(forKey: draftKey) }
                else { UserDefaults.standard.set(try? JSONEncoder().encode(next), forKey: draftKey) }
            }
            .onChange(of: scope.revision) { _, revision in
                guard !waiting && conflictRevision == nil else { return }
                if draft.text.isEmpty && draft.removingEntryId == nil { draft.revision = revision }
            }
            .task(id: erasureTarget) {
                guard let target = erasureTarget, let backend = model.backend else { return }
                do {
                    for try await erased in backend.botNoteErasures([target]) {
                        guard erased == [true], erasureTarget == target else { continue }
                        UserDefaults.standard.removeObject(forKey: draftKey)
                        discardDraft()
                        conflictRows = nil
                        conflictRevision = nil
                        return
                    }
                } catch {
                    // Keep drafts if the backend cannot check them.
                }
            }
            .task {
                guard let id = draft.commandId, let backend = model.backend else { return }
                let operationId = draft.operationId
                waiting = true
                defer { waiting = false }
                do {
                    let result = try await DeviceBotCommand.result(id, backend: backend)
                    if operationId == draft.operationId { show(result) }
                } catch is CancellationError {
                } catch {
                    if operationId == draft.operationId { problem = error.localizedDescription }
                }
            }
    }

    private func discardDraft() {
        draft = PhoneBotNoteDraft(revision: scope.revision)
        problem = nil
    }

    private func submit(_ action: PhoneBotAction) async {
        guard let backend = model.backend, !waiting else { return }
        waiting = true
        problem = nil
        defer { waiting = false }
        let operationId = draft.operationId
        let command = DeviceBotCommand(operationId: operationId, action: action)
        do {
            let result = try await command.submit(workspace: workspace, backend: backend) { id in
                if operationId == draft.operationId { draft.commandId = id }
            }
            if operationId == draft.operationId { show(result) }
        } catch is CancellationError {
        } catch {
            if operationId == draft.operationId { problem = error.localizedDescription }
        }
    }

    private func show(_ result: PhoneBotEditStatus.Result) {
        if result.outcome == "conflict", let revision = result.revision {
            conflictRows = result.rows
            conflictRevision = revision
            draft.commandId = nil
        } else if result.outcome == "saved" {
            draft = PhoneBotNoteDraft(revision: result.revision ?? scope.revision)
            problem = "Note saved."
        }
    }
}

private struct DeviceBotGroupView: View {
    @Environment(AppModel.self) private var model
    let workspace: PhoneBotWorkspace
    let group: PhoneBotWorkspace.Group
    @State private var draft: PhoneBotNoteDraft
    @State private var waiting = false
    @State private var message: String?
    let draftKey: String

    init(workspace: PhoneBotWorkspace, group: PhoneBotWorkspace.Group) {
        self.workspace = workspace
        self.group = group
        let key = "bot-group-draft:\(workspace.ownerRunnerId):\(workspace.id):\(workspace.epoch):\(group.id)"
        draftKey = key
        let saved = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(PhoneBotNoteDraft.self, from: $0) }
        _draft = State(initialValue: saved ?? PhoneBotNoteDraft(revision: ""))
    }

    var body: some View {
        Form {
            Section("Conversation") {
                ForEach(group.events) { row in Text(row.text) }
                TextField("Message the Group", text: Binding(
                    get: { draft.text },
                    set: { value in
                        draft.text = String(value.prefix(30_000))
                        draft.operationId = UUID().uuidString
                        draft.commandId = nil
                    }
                ), axis: .vertical)
                Button("Post to Group") { Task { await post() } }
                    .disabled(draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .disabled(waiting)
            if waiting { ProgressView("Waiting for Runner") }
            if let message { Text(message).foregroundStyle(.secondary) }
            if let scope = workspace.notes.first(where: { $0.scope == "group" && $0.scopeId == group.id }) {
                DeviceBotNotes(workspace: workspace, scope: scope)
            }
        }
        .navigationTitle(group.title)
        .onChange(of: draft) { _, next in
            if next.text.isEmpty && next.commandId == nil { UserDefaults.standard.removeObject(forKey: draftKey) }
            else { UserDefaults.standard.set(try? JSONEncoder().encode(next), forKey: draftKey) }
        }
        .task {
            guard let id = draft.commandId, let backend = model.backend else { return }
            waiting = true
            defer { waiting = false }
            do { show(try await DeviceBotCommand.result(id, backend: backend)) }
            catch is CancellationError {}
            catch { message = error.localizedDescription }
        }
    }

    private func post() async {
        guard let backend = model.backend, !waiting else { return }
        waiting = true
        message = nil
        defer { waiting = false }
        let command = DeviceBotCommand(operationId: draft.operationId, action: .postToGroup(groupId: group.id, text: draft.text))
        do {
            let result = try await command.submit(workspace: workspace, backend: backend) { draft.commandId = $0 }
            show(result)
        } catch is CancellationError {
        } catch {
            message = error.localizedDescription
        }
    }

    private func show(_ result: PhoneBotEditStatus.Result) {
        if result.outcome == "saved" {
            draft = PhoneBotNoteDraft(revision: "")
            message = "Message posted."
        }
    }
}

private struct DeviceBotStopTask: View {
    @Environment(AppModel.self) private var model
    let workspace: PhoneBotWorkspace
    let row: PhoneBotWorkspace.Work
    let revision: Int
    @State private var operationId = UUID().uuidString
    @State private var waiting = false
    @State private var stopped = false
    @State private var problem: String?

    var body: some View {
        Button(waiting ? "Stopping task…" : "Stop task", role: .destructive) { Task { await stop() } }
            .buttonStyle(.borderless)
            .disabled(waiting || stopped)
        if let problem { Text(problem).foregroundStyle(.secondary) }
    }

    private func stop() async {
        guard let backend = model.backend, !waiting else { return }
        waiting = true
        problem = nil
        defer { waiting = false }
        do {
            let command = DeviceBotCommand(operationId: operationId, action: .stopTask(taskId: row.id, revision: revision))
            stopped = try await command.submit(workspace: workspace, backend: backend) { _ in }.outcome == "saved"
        } catch is CancellationError {
        } catch {
            problem = error.localizedDescription
        }
    }
}
