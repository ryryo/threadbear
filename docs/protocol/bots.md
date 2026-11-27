# Runner protocol: Bots

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Bot conversations

Bot conversations keep an internal `botLink` on the persisted Thread record
with `botId` and `conversationId`. The Bot workspace reserves the conversation
and Thread IDs before saving the Thread. A retry confirms that same link if the
Thread was already saved. The Thread owns its native CLI session ID and events.
`threads.create` does not accept a Bot link from a client.
Fresh sessions receive the Bot settings and current notes with their startup
instructions. A live or resumed session receives changes before the next normal
message. The Runner tracks the context it sent and retries it if sending fails
or the turn fails to complete.
Inputs queued on a Bot conversation carry `botInput` with an input `id` and
`conversationId`. The same fields go into `user.message`, including when an
input joins a turn already running. The Runner flushes that event before
dispatching the input to the CLI. The turn ID still identifies the whole turn.
`botInput.source` records the authenticated owner or thread for a direct RPC,
the runner, phone or schedule for a tagged delivery, or `unknown` when the
internal caller supplies no verified source. Text and caller-supplied RPC
fields cannot name that source.

On a Runner with the Bot experiment available, the local owner can call
`bots.list`, `bots.get`, `bots.create`, `bots.update` and `bots.archive`.
`bots.get` returns the Bot and its conversation links. Settings edits and archive
require the revision the editor began with. An archived Bot's settings and
history stay readable. `bots.conversations.create` takes `botId` and
`operationId` and returns the persisted conversation link and its `thread`
summary. A local `ThreadSummary` may carry `botLink` so the conversation header
can open the Bot page. `bots.memory.read`,
`bots.memory.search`, `bots.memory.add`, `bots.memory.edit`, `bots.memory.remove`, `bots.memory.history`
and `bots.memory.restore` take `botId` and `threadId`; the thread must belong to
that Bot. Edit and remove take `entryId`, restore takes the history `changeId`,
and history returns up to 50 changes, newest first, with a `more` cursor.

`bots.status` advertises `profilePanel` when the owning Runner can edit the
Bot profile. A local authenticated GPUI connection may call
`bots.profilePanel.open` with the selected `botId`. It receives an `id` and
a loopback URL, with the short-lived capability in the URL fragment. The
panel reads only the selected profile and sends one of `name`, `role` or
`instructions` with its displayed `expectedRevision`. The panel uses the
same profile revision check as `bots.update`. Switching Bots or closing
the view sends `bots.profilePanel.close` with that `id`. Disconnecting or
opening another profile also invalidates the old capability. Its memory
card can read only the selected Bot's note count. Clicking **Manage**
sends `bots.profilePanel.memory` with the capability `id` and `botId`
only to the desktop connection that opened it. The desktop matches both
against the open view before switching to that Bot's Memory tab. The panel
can also update that Bot's avatar or color using the same profile revision.
It keeps the character's original defaults and lets the owner reset either
appearance field with `null`. Uploaded photos are validated as bounded raster
data. The panel link does not enter the Thread, Highlights or the project's
patch summary.

Bot RPCs require the owner's credential. A Thread key cannot use them at any
permission level.

`bots.status` reports whether the owner can open the local Bot workspace and,
when unavailable, gives a reason. Bot conversations stay on the workspace's
owning Runner. A local copy of real threads keeps them as a read-only transcript.
`bots.settings.conversationModel` takes a Bot revision and `threadId`.
When given a linked conversation, its login, model and effort
become the Bot's defaults for new conversations. A null `threadId` restores
the Runner defaults. Existing conversations retain their own settings.

The owner-only `bots.duplicate` takes `botId`, `expectedRevision` and an
`operationId`. It creates a fresh Bot with DS-Bot’s copy naming and profile
rules. A saved receipt makes the same operation safe to retry after a reply
or restart. Private Bots cannot be copied. The copy has its own conversation,
memory and permissions. An unavailable login or model and a missing folder
fall back to the Runner’s usual defaults. An explicitly selected model default
effort stays a model default for a new conversation.
`bots.status` advertises `rosterOperations` when the active Runner supports
copying Bots and attaching existing Threads.

The owner-only `bots.conversations.attach` takes `botId`, `expectedRevision`,
`threadId` and an `operationId`. It associates an idle, local Thread that has
no previous Bot link with an active non-Private Bot. The Thread must already
fit the Bot’s login, model, permission ceiling and folder restrictions. The
Runner reserves the identity before saving the link in the ThreadStore.
Repeating the operation completes the same reserved link. It retains the
original transcript and CLI session settings. Copy receipts and attachment
reservations require Bot data format 11. The recorded copies and attached
links use workspace envelope version 3 when they move.

## Bot memory review and visibility

The Runner identifies the author of a review input from the persisted
`botInput.source`, matched to the conversation. Only a new authenticated owner
message can start an automatic review. The review can include the Bot's reply
for context. It ignores quoted text, fenced blocks and tool events. The review
records the source conversation and event sequence range with its result. The
owner must enable automatic review for each Bot, and reviews use that Bot's
selected model and account. An unsupported binding leaves review unavailable.
The cursor and corresponding outcome are one durable checkpoint. A failed
read, model call or save can retry that range. A malformed reply advances the
checkpoint with a diagnostic code and retains no raw answer. A result with
proposed changes waits for the owner to decide. Its evidence includes the
Thread, conversation, Bot settings revision, model and sequence range.
`bots.settings.automaticReview` takes `botId`, `expectedRevision`, `operationId`
and `enabled`.
`bots.reviews.list` takes `botId` and a linked `threadId`; `bots.reviews.reject`
also takes `reportId`, zero-based `index` and `operationId`. These methods are
local owner operations, with the same authentication as the Bot settings.
`bots.reviews.approve` takes the same IDs as reject and accepts optional
replacement `text` for an add or edit. The Runner checks that the previous
note still matches and is unpinned at the time of the write. It records the
decision, source and operation ID in memory history and can recover the
decision after a restart if the history write completed first.
`bots.reviews.retry` takes `botId`, `threadId`, `reportId` and `operationId`
to review the same event range again with the Bot's current binding. It adds
a report linked to the previous one and leaves the automatic cursor alone.

Memory access uses the actor established by the Runner and current scope
membership. A Bot's own scope, a team, a group and a project are distinct
scopes. A shared Bot's notes require an explicit same-team read or grant.
Project access requires both the active conversation's project and a grant.
Group access requires current membership and must be in the group's context.
`bots.memory.scopes` lists available scope IDs and labels for the owner.
`bots.memory.scope.read`, `.search`, `.add`, `.edit`, `.remove`, `.history`
and `.restore` take `{ scope: { kind, id } }` along with the corresponding
entry, query or change fields. The owning Runner resolves the scope IDs.
The initial shared team is the Bot workspace. Project IDs resolve against
Threadbear Projects. Each scope has its own notes and change journal.
Scope reads report the current `revision`. Scope writes require that revision
as `expectedRevision` and an `operationId`. Repeating an accepted operation
returns its recorded result. A different payload with that ID or a stale
revision is refused before touching any notes.
`bots.memory.scope.tidy` uses a Bot's selected login and model for a changed
scope. It takes the scope write fields and `botId`. It reports merged, moved
and retired counts. Pinned notes are out of scope. The journal retains the
affected files and can undo the batch if none of those files has changed.
`bots.settings.automaticTidy` uses the same settings fields as automatic
review. When enabled, accepting a new proposal queues a tidy for that Bot's
changed scope. It shares the Runner's single model queue with reviews.

Private conversations and their notes are owner-local. Thread RPC and agent
tools enforce visibility at each read, including filtered lists and searches,
and before replaying or sending another live event to a subscriber. The same
restriction holds for archived Bot data. A private conversation must stay out
of the synchronization projection and notifications. Thread keys cannot
change those rules. Private protects these Runner interfaces. It does not
provide filesystem isolation from another process using the same OS account.

`bots.settings.privacy` takes `botId`, `expectedRevision`, `operationId` and an
existing dedicated `folder`. It rejects overlapping work folders,
including filesystem aliases. The Runner writes the new data format marker
before saving Private state. New conversations and their child threads keep
the Private identity on disk from creation, including after archive.
Converting a Bot with existing conversations requires all affected threads
to be stopped. It records a pending conversion and blocks further sync and
execution before changing the folders. It reports success after the old
mirror rows and their sidebar entries have been withdrawn. The same operation
can resume a pending conversion after an interruption or a failed withdrawal.
An agent's `send_message` from a Private Bot to a local ordinary thread
requires a one-use approval card. The card carries the destination thread
ID, the entire text and its SHA-256 hash. Approval is local and owner-only.
If the destination changes or the sender loses its Private context while
the card is open, the message is not delivered.

## Requests between Bot conversations

The owning Runner resolves a Bot's recipient conversation when it accepts
a request. It keeps that conversation and Thread ID on the receipt. A retry
keeps the same recipient even if a different conversation is selected later.
The caller identity and source conversation come from its authenticated
Thread, never from the message or tool arguments. A name and a fingerprint
of the requested payload identify the same delivery within that conversation.
Reusing the name for different words or a different destination is refused.

An updated `bots.status` includes `requests` when the Runner can accept
requests. The originating conversation can open its request list directly.
Owner-only `bots.requests.send` accepts the originating `threadId`, recipient
`botId`, optional recipient `conversationId`, `name`, `text` and a `when`
of `queue` or `now`. The receipt returns `requestId`, `threadId`, `turnId`
and the effective `when`. An unavailable steer becomes a queued message.
Only the Runner can put `requestId` and its role on `botInput`. A queued
request is saved in the recipient's Thread record before starting its CLI.
An input joining an existing turn has a flushed `user.message` receipt
with that ID before it reaches the CLI. Both use the same existing
permission checks as a message from one Thread to another, including its
saved ceiling when the input leaves the queue.

`bots.requests.list` uses the originating `threadId`. `bots.requests.get`
takes that ID and `requestId`. The request includes its source, destination,
state and revision. `bots.requests.cancel` takes these IDs and
`expectedRevision`. The durable cancellation stops queued input and
prevents later returns, including if the recipient is in a turn that is
doing other work. It does not stop unrelated work in that turn.
When `bots.status` reports `requestAbandonment`, the owner can call
`bots.requests.abandon` with the same IDs and revision for a child of a waiting
Bot request. It records that single child as `abandoned` and queues one
no-reply result to the parent’s original conversation. Other children still
have to finish. An already running turn can finish, while any queued input
for the abandoned child is dropped. A late answer remains readable through `bots.requests.get`
and does not queue another result. Saving this state requires Bot data
format 10. Its workspace transfer uses envelope version 2 so an unsupported
target cannot stage or claim it.

A memory journal with a permanent-erasure record requires Bot data format 11
and uses workspace envelope version 3. The receiver must protect format 11
before saving the pack or recording a claim. An interrupted journal rewrite must
be recovered before it can travel with the workspace.
`bots.requests.retry` takes the same fields and reconciles delivery state.
`bots.requests.rerun` takes those fields, a new or edited `text` and an
`operationId`. The owner creates a new attempt linked by `rerunOf` to the
failed, cancelled or unconfirmed request. It keeps the exact recipient and
origin. Repeating the operation returns the new attempt's previous receipt.

The Runner resolves the parent link from the current authenticated Bot
input. It rejects work addressed to the same Bot or an ancestor, and
bounds the depth and the total number of children in each request tree.
When a recipient delegates further, its original request waits for those
results and for the recipient's continuation. Cancelling a request suppresses
new inputs and replies for its descendants.
A result goes to the exact original conversation. Its ID belongs to the
original request, so two requests in one failed turn keep separate returns.
The full result stays in the recipient Thread's saved events. A request
also keeps a preview and the event reference. If the event is unavailable
the owner can still read the preview with its incomplete status.
On recovery the Runner checks the queued input, the saved event and the
reply receipt before deciding whether it has any delivery left to do.
Missing evidence of an input which could have run leaves it uncertain.
No recovery or retry automatically creates a second run of it.

Reply delivery uses the same conversation visibility and access checks.
An archived or inaccessible source retains the request result for the
owner to inspect. It is not redirected to another conversation. A Private
request cannot send its input or reply outside the approval's recorded
destination and text. These RPCs and their contents are local to the
owning Runner. Older clients ignore the extra Bot input fields.
## Background Bot tasks

A Bot runs a task in its own Thread. The Bot's normal conversation keeps its
existing Thread and native CLI session. The task has an independent `taskId`,
execution `threadId` and, when it belongs to delegated work, an
`originRequestId`. Its stable reservation precedes creation of its Thread.
The owning Runner creates the Task using the original conversation's Bot
identity, login, model, permission ceiling and approved scope. An agent
choosing a task folder uses the existing Thread approval path.

Owner-only `bots.tasks.start` takes the originating `threadId`, `title`,
`brief`, an optional `folder` and an `operationId`. Repeating the operation
after a restart keeps the execution Thread. A different brief under that
operation is refused. The Runner accepts four active tasks in the workspace
and two per Bot. A task cannot start another background task.

`bots.tasks.list` returns pages for a Bot, including completed tasks.
`bots.tasks.read` takes a `taskId` and resolves it to the saved Thread.
`bots.tasks.send` gives an active task a new instruction. Task questions and
approvals still belong to its execution Thread. `bots.tasks.cancel` takes
`expectedRevision`, stops the task's queue, CLI and outstanding work, and
reports whether the stop was saved. These operations never stop the source
conversation. `bots.tasks.retry` creates a separate execution attempt and
retains its link to the earlier task.

The terminal record preserves a reference to the full answer and any reply
still due to the original conversation in one write. An unavailable
transcript leaves a preview. The Runner keeps completed history, checks the
native queue, approvals, job state, handover and child requests on recovery,
and marks interrupted tasks when nothing still owns them.

## Teams and Chiefs

The owner can add a team, change its membership and give a member a Chief
role. `bots.teams.list` and `bots.teams.get` expose the saved roster and
chronological changes. `bots.teams.create`, `bots.teams.update`,
`bots.teams.setChief` and `bots.teams.setGrants` use the same Runner and
workspace as the Bot profiles. Writes against an existing team take
`expectedRevision`. A team may start with no Chief. Enabling the role takes
a first Chief, and an active team must keep at least one. Replacing a Chief
changes the roster in one write and removes the previous Chief's grants.
A Private Bot cannot become a Chief or receive team management grants.

Management grants are per Chief and per operation. `createBot` allows
specific owner-saved templates with a model, login, folder and permission
ceiling, up to an owner-set total. `updateOtherBot` allows named profile
fields on specific Bots. `stopOtherBot` names the Bots it may stop. Group
grants are saved independently for creation and updates. An empty grant
set gives the Chief no management authority.

`bots.settings.permissionCeiling` takes a Bot ID, expected revision and the
highest native permission mode it can use. A narrower limit stops an active
CLI with broader permissions and applies to queued input and future
conversations. A higher limit takes effect when the owner changes the Thread setting. Failed updates keep
the last saved limit and restore the affected Thread settings when safe.

## Groups and rounds

A Group belongs to one Bot team. Its saved roster includes an admin, mode,
permission ceiling and configuration revision. A Bot has its own Thread
in each Group. Creating the Group starts no model. A Group message is
recorded with its resolved member IDs before the first model call.

A round owns its queued calls, replies and summaries. Explicit mentions
can start in parallel. The everyone mode preserves the ordered calls.
A member cannot speak twice at once in one Group. Posts received while a
round is active are kept in order for the next round.

The Group book records a durable sequence and event identity. A result
points to the Thread and event that hold the complete reply. On a
restart the Runner checks admitted inputs and terminal events before
scheduling new work. The owner can stop a Group, which freezes the
active round before cancelling any of its calls.


Group replies and background task replies keep their producing Thread event
reference. `bots.groups.result` opens its retained text and returns
`{text, whole}`. The owner's `bots.groups.find {groupId, query, before?}`
searches the saved Group history and the full replies those events reference.
It returns up to twenty matching `events`, newest first, with `hasMore`.
Use the last match's sequence as `before` to continue to older results.
Preview and reply references keep the same shape as `bots.groups.read`.
An owner can review a reply as a Group note.
`bots.groups.memory.approve {groupId, seq, operationId, text}` applies the
approved text through the memory journal with the source event and a retry
receipt. Posting and replying alone do not add notes.

Group creation and posting use caller-provided operation IDs to recover the
same receipt when a connection drops.

A member can use `call_group_members` within its own current native Group
call. The group, member, parent call and permissions are resolved from that
Thread. A background Task started in a Group is linked to that call,
retains its own Thread and approvals, and records its result in the Group.

### Scheduled Bot work

A schedule can target an existing Bot conversation, a new conversation of
a specific Bot on each fire, or a Group. Its target is saved in the existing
schedule record. The owning Runner resolves the same target at fire time.
It keeps the Schedule's run ID as the conversation reservation or Group
post receipt. This lets a Runner retry without generating another input or
a second conversation for the same fire.

A scheduled delivery uses the lower of the recorded permission ceiling
and the current Bot or Group limit. A schedule still points to the same
conversation if the user opens another one. When the configured Bot or
Group is archived, the schedule cannot create or start work. Pause and
delete withdraw pending inputs. A turn that has already started can be
stopped separately in its Thread or Group.

### Connected devices

A capable backend can mirror the owning Runner's public Bot profiles, approved
Bot and Group notes, Group history previews, and the status of requests and
background tasks. The owning Runner removes Private Bot records before sending
the view. It withdraws the earlier public profile before making a Bot private
on a backend that can mirror Bot workspaces.

An edit names its workspace, owner epoch, Bot ID, base revision and operation
ID. The backend queues it through the ordinary command lifecycle. Only the
owning primary Runner can apply it. The profile and its acceptance receipt
are saved together. A retry with the same operation ID can read that receipt.
A conflict returns the saved profile and the submitted draft. A paired
device receives the same five profile fields from a snapshot, a save receipt,
or a conflict: ID, name, role, instructions and revision. Local settings
such as model bindings and work folders stay on the owning Runner. Editing in a
connected browser or app keeps the draft until the owner settles it.

Backend API 106 and Bot storage format 8 add device editing. A Bot Thread
row sent to that backend carries `botLink` with its existing Bot,
conversation, and optional task and Group IDs. Older backends receive
the usual Thread row. Private Bot threads and their links stay local.

The same device command queue accepts a note change at its memory
revision, a Group message under a stable operation ID, and a stop at
the Task revision. The owning Runner checks that the target still
belongs to the visible workspace before doing the work. Completion and
conflict are sent in the command's result. A kept Group turn can call
members through the new primary after a restart. The primary checks
the saved turn and Group call before accepting the operation. It
records the batch on the primary immediately and starts the queued
Group work when the handover clears. While a draining Runner still has a recipient conversation, its saved
completion can settle the request on the primary. Only a Thread kept by
a connected handover peer is eligible. The primary reads complete
journal lines without editing that Thread, and the existing result ID
keeps delivery repeatable across a duplicate notice or later adoption.
If the source is also still on the old Runner, delivery waits for its
handover.

`bot_remember` saves a note to the calling Bot's own memory, or to the
current Group's memory during a Group turn. The Runner resolves the scope
from the conversation and records the Bot, Thread, turn and input event.
During a handover the old Runner forwards the same operation ID to the
primary, which verifies the peer's active turn and saves the change in
the scope's existing journal. It returns the stored receipt for a retry
of that operation. If it cannot reach the primary, the old Runner does
not write a copy.

With backend API 108, a Runner can submit a scoped note erasure to the mirror only while it owns
an unfrozen workspace. The mirror remembers the workspace ID, scope kind,
scope ID and note ID across changes of Runner and epoch. It removes that row
from its device projection and ignores the same row in later projections,
including a projection sent before the erasure. A connected device cannot
queue another edit or removal for the erased ID. An already queued edit or
removal does not reach the Runner, and a late command completion for that ID
cannot save the result or draft text. The mirror retains the scope with
new note-command receipts. As soon as it remembers the erasure, reads omit the
erased row and any draft addressed to that row. Repeating the erasure request
with the same IDs redacts retained receipts in bounded transactions. Its
`done` field confirms that the mirror checked scoped receipts and older
receipts that might contain the erased note. When scope cannot be recovered
from a retained result, the mirror keeps that result until the ordinary
command-retention sweep expires it and replies with `waitingForLegacy`.
The same request can resume checking without guessing a scope. The operation
is internal to the Runner.
The owning Runner records a body-free intent after the journal has validated
the requested change and before it writes. Subsequent successful sync
heartbeats resume the journal, linked review checkpoints and mirror steps
with the same identity. A failure to sanitize a linked review leaves the
intent pending, and the next pass can continue after a partial write.
Running a workspace move waits for the saved erasure intent to clear.
A workspace that has erased notes must carry the authority’s current note
erasure revision in both its offer and its claim. Only the owner and that
move's intended recipient can read the paged requirements. Before accepting
the pack, each checks the matching journal receipts and absence of erased
note bodies in the relevant memory scope. Older Runners can still move
workspaces that have no permanent note erasures. A managed restore preflight
checks the workspace and owner epoch of the backup candidate, then verifies
the same current erasure records. It refuses stale or mixed copies. Checking
a frozen candidate does not change the backup or install it.

On an owning Runner with a compatible supervisor and backend,
`bots.status` advertises `managedMemoryRestore`. The owner can list the
Runner’s staged backup IDs and saved times with `bots.memory.backups`.
`bots.memory.createBackup` takes a Bot or Group `scope`, its
`expectedRevision`, and an `operationId`. It saves the scope's current
notes to the Runner's `bot-backups` folder and returns the updated backup
list. It copies neither note history nor conversation content. The same
operation ID can recover the saved result after a lost reply. The backup
is refused if the scope, its revision or the owning Runner changes while
the current erasure records are checked.
`bots.memory.backupNotes` takes `backupId` and `scope` and returns the
verified `checksum`, the live scope `revision`, and `notes` containing
only the ID and text of each restorable note in that scope. Listing the
archive does not write a note. The owner then explicitly selects a note.

The owner can recover a specific note with `bots.memory.recoverFromBackup`.
It takes `backupId`, `checksum`, `scope`, `entryId`, `expectedRevision`
and `operationId`. It reads only the chosen pre-staged local pack at
`bot-backups/<backupId>.pack`. The Runner verifies its checksum, owner
epoch and current erasures before applying a change. It uses the current
scope’s existing journal to append the selected note, with its original
ID and metadata, only if both its topic and the scope remain valid.
It refuses a changed live revision or an existing or erased note, and
rechecks the current secret policy. The backup, other notes and the
Runner’s other records stay intact. A successful or interrupted write
can be retried with the same operation ID.
A paired device can query `phone:botNoteErasures` with at most 32 exact
workspace, scope and note IDs from its own drafts. The booleans in the
reply follow the input order. Neither the old Runner nor whether the
scope currently appears in the mirror affects the lookup. An absent note
or an unsupported backend gives the device no reason to discard a draft.

### Workers on another Runner

A workspace owner can give a regular public Bot conversation a worker
on another connected Runner. `bots.workers.start` takes its Thread ID,
the other Runner's ID, the prompt, and a stable operation ID. The owner
seals the approved Bot context to that Runner's key. The backend queues
only its workspace and request IDs through the usual command queue.
The worker then claims the bounded grant and runs one native Thread
under its permission ceiling. Private Bots stay on their owning Runner.

The worker keeps the answer in its own Thread events.
`bots.workers.result` takes the originating Thread ID and request ID
and returns the worker Thread and the saved result sequence once ready.
`bots.workers.history` takes the originating Thread ID and returns up to
20 recent requests with their Runner, state and saved result reference.
Both reads use the request's original conversation. The current workspace
owner can read those requests after a workspace transfer.
A transport retry uses the original request. Only the workspace owner
has access to the grant's result. A worker's grant does not give it
permission to update the owner's Bot settings or workspace.

### Workspace moves

While a workspace is preparing, frozen or being received, the Runner
holds linked conversation queues. It refuses new messages, settings
changes and deletion of those conversations, including after a restart.
If the owner cancels before an offer, the existing queues can resume.
Once the ownership claim succeeds, the source can no longer change
those conversations.

When `bots.status` reports `workspaceMoves`, the owner can start a move
with `bots.workspace.move`. It takes a destination Runner ID, a stable
move ID and an explicit Project choice. `bots.workspace.movePreview`
lists the source Project IDs, including scopes with saved notes, and the
available destination Runners. With a `runnerId` it also lists active
Projects on that Runner. The destination checks the selected IDs again
before claiming.
Use `projects: "detach"` to detach every Project or
`projects: {assign: {sourceId: targetId}}` to name each destination
by ID. An assignment to the same ID keeps that scope. An assignment to
null leaves that Project behind. Titles do not select destinations.
Detaching leaves Project memberships and Project-scoped notes on the
source. Bot, Team and Group notes travel with the workspace.
`bots.workspace.moveStatus` returns the local transfer state.
`bots.workspace.cancelMove` takes that same move ID. A frozen source
reopens only with a cancellation from the authority. A target places
the validated Threads before claiming and opens them after the claim.
Bot reservations already in the backend move in the same claim as the
workspace and its Threads. They retain their IDs, timing, run history
and permission ceilings. A reservation with an unsettled run prevents
the move. A reservation cannot start or be edited during the claim.
The authority also remembers a cancellation issued before the offer
arrives. A late copy of the cancelled offer cannot freeze the workspace.
