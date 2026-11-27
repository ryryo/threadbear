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
Bot RPCs require the owner's credential. A Thread key cannot use them at any
permission level.

`bots.status` reports whether the owner can open the local Bot workspace and,
when unavailable, gives a reason. Bot conversations stay on the workspace's
owning Runner. A local copy of real threads keeps them as a read-only transcript.
`bots.settings.conversationModel` takes a Bot revision and `threadId`.
When given a linked conversation, its login, model and effort
become the Bot's defaults for new conversations. A null `threadId` restores
the Runner defaults. Existing conversations retain their own settings.

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
`{text, whole}`. An owner can review a reply as a Group note.
`bots.groups.memory.approve {groupId, seq, operationId, text}` applies the
approved text through the memory journal with the source event and a retry
receipt. Posting and replying alone do not add notes.

Group creation and posting use caller-provided operation IDs to recover the
same receipt when a connection drops.

A member can use `call_group_members` within its own current native Group
call. The group, member, parent call and permissions are resolved from that
Thread. A background Task started in a Group is linked to that call,
retains its own Thread and approvals, and records its result in the Group.
