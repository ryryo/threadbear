//! Bot profiles and their conversations on the local Runner.
use crate::a11y::A11yRole as _;
use crate::app::Threadbear;
use crate::shell::SidebarMode;
use crate::style::{self, px};
use crate::tips::Tip as _;
use crate::{call, now_ms};
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Disableable as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde::Deserialize;
use serde_json::{json, Value};
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::tr;

mod groups;
mod managed_restore;
mod profile_panel;
mod roster;
mod schedules;
mod tasks;
mod teams;
mod workspace_move;
use tasks::TaskCard;
use teams::TeamCard;

const EXPERIMENT: &str = "nativeBots";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    name: String,
    role: String,
    instructions: String,
    revision: u64,
    archived_at: Option<String>,
    model_binding: Option<ModelBinding>,
    permission_ceiling: Option<String>,
    review_enabled: Option<bool>,
    tidy_enabled: Option<bool>,
    privacy: Option<Privacy>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Privacy {
    folder: String,
    operation_id: String,
    moving: Option<Vec<String>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelBinding {
    account_id: String,
    model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Conversation {
    id: Option<String>,
    thread_id: String,
}

#[derive(Deserialize)]
struct Details {
    bot: Profile,
    conversations: Vec<Conversation>,
    #[serde(default)]
    capabilities: Capabilities,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    #[serde(default)]
    reviews: bool,
    #[serde(default)]
    privacy: bool,
    #[serde(default)]
    scoped_memory: bool,
    #[serde(default)]
    requests: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestCard {
    id: String,
    revision: u64,
    target_bot_id: String,
    target_thread_id: String,
    parent_request_id: Option<String>,
    when: String,
    state: RequestStatus,
}

#[derive(Deserialize)]
struct RequestStatus {
    status: String,
    late: Option<serde::de::IgnoredAny>,
    reason: Option<String>,
    #[serde(default)]
    failed: bool,
}

impl RequestStatus {
    fn label(&self) -> &'static str {
        match self.status.as_str() {
            "admitted" => tr!("Accepted"),
            "queued" => tr!("Queued"),
            "running" => tr!("In progress"),
            "returning" => tr!("Returning result"),
            "returned" if self.failed => tr!("Failed with result"),
            "returned" => tr!("Result received"),
            "failed" => tr!("Failed"),
            "uncertain" => tr!("Delivery unconfirmed"),
            "cancelled" => tr!("Cancelled"),
            "abandoned" if self.late.is_some() => tr!("Reply arrived after giving up"),
            "abandoned" => tr!("Gave up waiting"),
            _ => tr!("Status unavailable"),
        }
    }
}

#[derive(Deserialize)]
struct RequestResult {
    text: String,
    whole: bool,
}

#[derive(Clone, Deserialize)]
struct MemoryScope {
    kind: String,
    id: String,
    title: String,
    archived: bool,
}

impl MemoryScope {
    fn target(&self) -> Value {
        json!({ "kind": self.kind, "id": self.id })
    }
}

#[derive(Deserialize)]
struct ReviewReport {
    id: String,
    source: ReviewSource,
    changes: Vec<ReviewChange>,
    diagnostic: Option<String>,
    rejected: u64,
    usage: Option<ReviewUsage>,
}

#[derive(Deserialize)]
struct ReviewSource {
    model: String,
    first: u64,
    through: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    notional_usd: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewChange {
    op: String,
    decision: String,
    text: Option<String>,
    before: Option<String>,
    accepted_text: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Note {
    id: String,
    text: String,
    pinned: bool,
    until: Option<String>,
    topic: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Change {
    id: String,
    time: String,
    op: String,
    before: Option<String>,
    after: Option<String>,
    restored: Option<String>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Tab {
    #[default]
    Conversations,
    Memory,
    Reviews,
    Requests,
    Tasks,
    Settings,
}

#[derive(Clone)]
enum Edit {
    New,
    Name,
    Role,
    Instructions,
    Note(Option<String>),
    Privacy,
    Review(String, usize),
    RequestRerun(String, u64),
    NewTeam,
    RenameTeam(String, u64),
    GrantChief(String, u64, String),
    TaskStart,
    TaskWrite(String),
    TaskRetry(String, u64),
    Worker(String, String),
}

impl Edit {
    fn label(&self) -> &'static str {
        match self {
            Self::New | Self::Name => tr!("Bot name"),
            Self::Role => tr!("Role"),
            Self::Instructions => tr!("Instructions"),
            Self::Note(_) => tr!("Note"),
            Self::Privacy => tr!("Dedicated work folder"),
            Self::Review(_, _) => tr!("Proposed note"),
            Self::RequestRerun(_, _) => tr!("Instructions for the new run"),
            Self::NewTeam | Self::RenameTeam(..) => tr!("Team name"),
            Self::GrantChief(..) => tr!("Management grants"),
            Self::TaskStart => tr!("Task title on the first line, then the brief"),
            Self::TaskWrite(_) => tr!("Instruction for the task"),
            Self::TaskRetry(_, _) => tr!("Brief for the new task run"),
            Self::Worker(_, _) => tr!("Instructions for the other Runner"),
        }
    }
}

struct Editor {
    kind: Edit,
    field: Entity<TextareaState>,
    // Edits keep the revision seen at the start, including after reloads.
    revision: Option<u64>,
    memory_revision: Option<String>,
}

#[derive(Deserialize)]
struct BotWorkerTarget {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotWorkerRequest {
    request_id: String,
    target_runner_id: String,
    state: BotWorkerState,
    result: Option<BotWorkerReply>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotWorkerReply {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum BotWorkerState {
    Queued,
    Running,
    Done,
    Expired,
    #[serde(other)]
    Unknown,
}

#[derive(Default)]
pub(crate) struct BotsState {
    offered: bool,
    available: bool,
    requests_available: bool,
    request_abandonment: bool,
    tasks_available: bool,
    workers_available: bool,
    worker_choices: Option<(String, Vec<BotWorkerTarget>)>,
    worker_history: Option<(String, Vec<BotWorkerRequest>)>,
    teams_available: bool,
    show_teams: bool,
    schedules_available: bool,
    show_schedules: bool,
    schedule_rows: Vec<Value>,
    groups: groups::GroupsState,
    workspace_move: workspace_move::WorkspaceMove,
    roster: roster::RosterOperations,
    restore: managed_restore::ManagedRestore,
    profile_panel: profile_panel::ProfilePanel,
    teams: Vec<TeamCard>,
    selected_team: Option<String>,
    reason: Option<String>,
    list: Vec<Profile>,
    selected: Option<String>,
    detail: Option<Details>,
    tab: Tab,
    source: Option<String>,
    notes: Vec<Note>,
    changes: Vec<Change>,
    more: Option<String>,
    scopes: Vec<MemoryScope>,
    scope: Option<MemoryScope>,
    memory_revision: Option<String>,
    reports: Vec<ReviewReport>,
    review_unavailable: Option<String>,
    requests: Vec<RequestCard>,
    request_result: Option<(String, RequestResult)>,
    tasks: Vec<TaskCard>,
    task_more: Option<String>,
    task_result: Option<(String, RequestResult)>,
    editor: Option<Editor>,
    pending_conversation: Option<(String, String)>,
    pending_write: Option<(&'static str, Value, String)>,
    operation: u64,
    busy: bool,
    error: Option<String>,
}

impl Threadbear {
    pub(crate) fn bots_on(&self) -> bool {
        self.runner_settings_state
            .experiment_on(EXPERIMENT)
            .unwrap_or_else(|| self.bots.offered || self.experiment_on(EXPERIMENT))
    }

    pub(crate) fn discover_bots(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let status = call(client, "bots.status", json!({})).await;
            this.update(cx, |this, cx| {
                let value = status.unwrap_or_default();
                this.bots.offered = value["enabled"].as_bool().unwrap_or(false);
                this.bots.available = value["available"].as_bool().unwrap_or(false);
                this.bots.requests_available = value["requests"].as_bool().unwrap_or(false);
                this.bots.tasks_available = value["tasks"].as_bool().unwrap_or(false);
                this.bots.request_abandonment =
                    value["requestAbandonment"].as_bool().unwrap_or(false);
                this.bots.workers_available = value["workers"].as_bool().unwrap_or(false);
                this.bots.teams_available = value["teams"].as_bool().unwrap_or(false);
                this.bots.schedules_available = value["schedules"].as_bool().unwrap_or(false);
                this.bots.workspace_move.available =
                    value["workspaceMoves"].as_bool().unwrap_or(false);
                this.bots.groups.available = value["groups"].as_bool().unwrap_or(false);
                this.bots.roster.available = value["rosterOperations"].as_bool().unwrap_or(false);
                this.bots.restore.available =
                    value["managedMemoryRestore"].as_bool().unwrap_or(false);
                this.bots.profile_panel.available =
                    value["profilePanel"].as_bool().unwrap_or(false);
                this.bots.reason = value["reason"].as_str().map(str::to_owned);
                if this.bots.available && this.home_page() == Some(SidebarMode::Bots) {
                    this.load_bot_list(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn open_bots(&mut self, cx: &mut Context<Self>) {
        self.unfold_threads(cx);
        self.set_mode(SidebarMode::Bots, cx);
        self.discover_bots(cx);
    }

    fn load_bot_list(&mut self, cx: &mut Context<Self>) {
        if self.bots.busy {
            return;
        }
        self.bots.busy = true;
        let client = self.client.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = call(client, "bots.list", json!({})).await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match result {
                    Ok(value) => {
                        this.bots.list =
                            serde_json::from_value(value["bots"].clone()).unwrap_or_default();
                        this.bots.error = None;
                        if let Some(id) = this.bots.selected.clone() {
                            this.load_bot(id, cx);
                        }
                    }
                    Err(error) => this.bots.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn select_bot(&mut self, id: String, source: Option<String>, cx: &mut Context<Self>) {
        if self.bots.busy || self.bots.editor.is_some() {
            return;
        }
        self.bots.show_teams = false;
        self.bots.show_schedules = false;
        self.bots.groups.visible = false;
        self.bots.workspace_move.visible = false;
        self.bots.roster.close_attachment();
        self.dismiss_bot_profile(false, cx);
        self.bots.selected = Some(id.clone());
        self.bots.detail = None;
        self.bots.source = source;
        self.bots.scope = None;
        self.bots.request_result = None;
        self.bots.tab = if self.bots.source.is_some() {
            Tab::Memory
        } else {
            Tab::Conversations
        };
        self.load_bot(id, cx);
    }

    pub(crate) fn open_bot_from_thread(
        &mut self,
        bot_id: String,
        thread_id: String,
        cx: &mut Context<Self>,
    ) {
        self.unfold_threads(cx);
        self.set_mode(SidebarMode::Bots, cx);
        self.select_bot(bot_id, Some(thread_id), cx);
    }

    fn load_bot(&mut self, id: String, cx: &mut Context<Self>) {
        self.bots.busy = true;
        let client = self.client.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = call(client, "bots.get", json!({ "botId": id })).await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match result {
                    Ok(value) => {
                        match serde_json::from_value::<Details>(value) {
                            Ok(detail) => {
                                if let Some(row) = this
                                    .bots
                                    .list
                                    .iter_mut()
                                    .find(|row| row.id == detail.bot.id)
                                {
                                    *row = detail.bot.clone();
                                }
                                if !detail
                                    .conversations
                                    .iter()
                                    .any(|row| Some(&row.thread_id) == this.bots.source.as_ref())
                                {
                                    this.bots.source = detail
                                        .conversations
                                        .first()
                                        .map(|row| row.thread_id.clone());
                                }
                                if let Some(scope) = this.bots.scope.as_mut().filter(|scope| {
                                    scope.kind == "bot" && scope.id == detail.bot.id
                                }) {
                                    scope.title.clone_from(&detail.bot.name);
                                    scope.archived = detail.bot.archived_at.is_some();
                                }
                                this.bots.detail = Some(detail);
                                this.bots.error = None;
                                if this.bots.tab == Tab::Memory {
                                    this.load_bot_memory(false, cx);
                                } else if this.bots.tab == Tab::Reviews {
                                    this.load_bot_reviews(cx);
                                } else if this.bots.tab == Tab::Requests {
                                    this.load_bot_requests(cx);
                                } else if this.bots.tab == Tab::Tasks {
                                    this.load_bot_tasks(false, cx);
                                }
                            }
                            Err(_) => {
                                this.bots.error =
                                    Some(tr!("Could not read this Bot’s settings.").into())
                            }
                        }
                    }
                    Err(error) => this.bots.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn load_bot_memory(&mut self, append: bool, cx: &mut Context<Self>) {
        if !append {
            self.bots.restore.close();
        }
        let scoped = self.bots.scope.is_some();
        let catalog = !append
            && self
                .bots
                .detail
                .as_ref()
                .is_some_and(|detail| detail.capabilities.scoped_memory);
        let request = if let Some(scope) = &self.bots.scope {
            Some(json!({ "scope": scope.target() }))
        } else {
            self.bots
                .selected
                .as_ref()
                .zip(self.bots.source.as_ref())
                .map(|(bot_id, thread_id)| json!({ "botId": bot_id, "threadId": thread_id }))
        };
        if request.is_none() {
            self.bots.notes.clear();
            self.bots.changes.clear();
            self.bots.more = None;
            self.bots.memory_revision = None;
            if !catalog {
                return;
            }
        }
        if !append {
            self.bots.notes.clear();
            self.bots.changes.clear();
            self.bots.more = None;
            self.bots.memory_revision = None;
        }
        self.bots.busy = true;
        let before = if append { self.bots.more.clone() } else { None };
        let client = self.client.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = async {
                let scopes = if catalog {
                    Some(call(client.clone(), "bots.memory.scopes", json!({})).await?)
                } else {
                    None
                };
                let memory = if let Some(source) = request {
                    let mut history = source.clone();
                    if let Some(before) = before {
                        history["before"] = json!(before);
                    }
                    let read = if scoped {
                        "bots.memory.scope.read"
                    } else {
                        "bots.memory.read"
                    };
                    let recent = if scoped {
                        "bots.memory.scope.history"
                    } else {
                        "bots.memory.history"
                    };
                    let notes = call(client.clone(), read, source).await?;
                    let history = call(client, recent, history).await?;
                    Some((notes, history))
                } else {
                    None
                };
                Ok::<_, crate::RpcError>((scopes, memory))
            }
            .await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match result {
                    Ok((scopes, memory)) => {
                        if let Some(scopes) = scopes {
                            this.bots.scopes = serde_json::from_value(scopes["scopes"].clone())
                                .unwrap_or_default();
                        }
                        if let Some((notes, history)) = memory {
                            this.bots.notes =
                                serde_json::from_value(notes["notes"].clone()).unwrap_or_default();
                            this.bots.memory_revision =
                                notes["revision"].as_str().map(str::to_owned);
                            let rows: Vec<Change> =
                                serde_json::from_value(history["rows"].clone()).unwrap_or_default();
                            if !append {
                                this.bots.changes.clear();
                            }
                            this.bots.changes.extend(rows);
                            this.bots.more = history["more"].as_str().map(str::to_owned);
                        }
                        this.bots.error = None;
                    }
                    Err(error) => this.bots.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    fn load_bot_requests(&mut self, cx: &mut Context<Self>) {
        self.bots.requests.clear();
        self.bots.request_result = None;
        let Some(thread_id) = self.bots.source.clone() else {
            return;
        };
        let client = self.client.clone();
        self.bots.busy = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = call(
                client,
                "bots.requests.list",
                json!({ "threadId": thread_id }),
            )
            .await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match result {
                    Ok(value) => match serde_json::from_value(value["requests"].clone()) {
                        Ok(requests) => {
                            this.bots.requests = requests;
                            this.bots.error = None;
                        }
                        Err(_) => {
                            this.bots.error = Some(tr!("Could not read the Bot requests.").into())
                        }
                    },
                    Err(error) => this.bots.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn load_bot_request_result(&mut self, id: String, cx: &mut Context<Self>) {
        if self.bots.busy {
            return;
        }
        let Some(thread_id) = self.bots.source.clone() else {
            return;
        };
        let client = self.client.clone();
        self.bots.busy = true;
        self.bots.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = call(
                client,
                "bots.requests.get",
                json!({ "threadId": thread_id, "requestId": id }),
            )
            .await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match result {
                    Ok(value) => match serde_json::from_value(value["result"].clone()) {
                        Ok(result) => this.bots.request_result = Some((id, result)),
                        Err(_) => {
                            this.bots.error = Some(tr!("Could not read the request result.").into())
                        }
                    },
                    Err(error) => this.bots.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn load_bot_reviews(&mut self, cx: &mut Context<Self>) {
        self.bots.reports.clear();
        self.bots.review_unavailable = None;
        let (Some(bot_id), Some(thread_id)) =
            (self.bots.selected.clone(), self.bots.source.clone())
        else {
            return;
        };
        let client = self.client.clone();
        self.bots.busy = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = call(
                client,
                "bots.reviews.list",
                json!({ "botId": bot_id, "threadId": thread_id }),
            )
            .await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match result {
                    Ok(value) => {
                        this.bots.reports =
                            serde_json::from_value(value["reports"].clone()).unwrap_or_default();
                        this.bots.review_unavailable =
                            value["unavailable"].as_str().map(str::to_owned);
                        this.bots.error = None;
                    }
                    Err(error) => this.bots.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

fn bot_button(id: impl Into<ElementId>, label: impl Into<SharedString>, busy: bool) -> Button {
    let label = label.into();
    Button::new(id)
        .small()
        .label(label.clone())
        .tooltip(label)
        .disabled(busy)
}

impl Threadbear {
    pub(crate) fn render_bots_list(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let disabled = self.bots.busy || self.bots.editor.is_some();
        let mut list = v_flex()
            .id("bots-list")
            .size_full()
            .overflow_y_scroll()
            .gap(px(6.))
            .p(px(12.));
        list = list.child(
            div()
                .text_size(px(17.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(tr!("Bots")),
        );
        if self.bots.available {
            list = list.child(
                bot_button("new-bot", tr!("New Bot"), disabled)
                    .primary()
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.bots.show_teams = false;
                        this.bots.show_schedules = false;
                        this.bots.groups.visible = false;
                        this.bots.workspace_move.visible = false;
                        this.edit_bot(Edit::New, String::new(), window, cx);
                    })),
            );
        }
        if self.bots.teams_available {
            list = list.child(
                bot_button("bot-teams", tr!("Teams"), disabled)
                    .when(self.bots.show_teams, |button| button.primary())
                    .on_click(cx.listener(|this, _, _, cx| this.open_bot_teams(cx))),
            );
        }
        if self.bots.groups.available {
            list = list.child(
                bot_button("bot-groups", "Groups", disabled)
                    .when(self.bots.groups.visible, |button| button.primary())
                    .on_click(cx.listener(|this, _, window, cx| this.open_bot_groups(window, cx))),
            );
        }
        if self.bots.schedules_available {
            list = list.child(
                bot_button("bot-schedules", "Bot schedules", disabled)
                    .when(self.bots.show_schedules, |button| button.primary())
                    .on_click(cx.listener(|this, _, _, cx| this.open_bot_schedules(cx))),
            );
        }
        if self.bots.workspace_move.available {
            list = list.child(
                bot_button("move-bot-workspace", tr!("Move Bot workspace"), disabled)
                    .when(self.bots.workspace_move.visible, |button| button.primary())
                    .on_click(cx.listener(|this, _, _, cx| this.open_workspace_move(cx))),
            );
        }
        for bot in &self.bots.list {
            let id = bot.id.clone();
            let selected = self.bots.selected.as_ref() == Some(&id);
            let name = if bot.archived_at.is_some() {
                format!("{} · Archived", bot.name)
            } else {
                bot.name.clone()
            };
            let target = id.clone();
            let row = bot_button(SharedString::from(format!("bot-{id}")), name, disabled)
                .when(selected, |button| button.primary())
                .on_click(
                    cx.listener(move |this, _, _, cx| this.select_bot(target.clone(), None, cx)),
                );
            list = list.child(self.bot_roster_row(row, bot, disabled, cx));
        }
        list.into_any_element()
    }

    pub(crate) fn render_bots_page(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.bots.profile_panel.active() {
            if self.bots.show_schedules
                || self.bots.show_teams
                || self.bots.groups.visible
                || self.bots.workspace_move.visible
                || self.bots.editor.is_some()
                || !self.bots.available
                || !self.bots.profile_panel.available
                || self.bots.tab != Tab::Settings
            {
                self.dismiss_bot_profile(false, cx);
            } else {
                return self.render_original_profile(window, cx);
            }
        }
        let mut page = v_flex()
            .id("bots-page")
            .size_full()
            .overflow_y_scroll()
            .p(px(24.))
            .gap(px(16.));
        if let Some(error) = &self.bots.error {
            page = page.child(div().text_color(cx.theme().danger).child(error.clone()));
        }
        if self.bots.busy {
            page = page.child(
                div()
                    .text_color(style::secondary_text(cx))
                    .child(tr!("Waiting for the Runner…")),
            );
        }
        if !self.bots.available {
            return page
                .child(self.bots.reason.clone().unwrap_or_else(|| {
                    tr!("Checking whether Bots are available on this Runner…").into()
                }))
                .into_any_element();
        }
        if self.bots.workspace_move.visible && self.bots.workspace_move.available {
            return page
                .child(self.render_workspace_move(cx))
                .into_any_element();
        }
        if self.bots.show_schedules && self.bots.schedules_available {
            return page.child(self.render_bot_schedules(cx)).into_any_element();
        }
        if self.bots.groups.visible && self.bots.groups.available {
            return page.child(self.render_bot_groups(cx)).into_any_element();
        }
        if self.bots.show_teams && self.bots.teams_available {
            return page.child(self.render_bot_teams(cx)).into_any_element();
        }
        let editor = self.bots.editor.as_ref();
        if let Some(editor) = editor.filter(|editor| matches!(editor.kind, Edit::New)) {
            return page
                .child(self.render_bot_editor(editor, cx))
                .into_any_element();
        }
        let Some(detail) = &self.bots.detail else {
            let prompt = if self.bots.list.is_empty() {
                tr!("Create a Bot to give your conversations shared settings and notes.")
            } else {
                tr!("Select a Bot to open its conversations, memory and settings.")
            };
            return page.child(prompt).into_any_element();
        };
        page = page
            .child(
                div()
                    .text_size(px(24.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(detail.bot.name.clone()),
            )
            .when(detail.bot.archived_at.is_some(), |page| {
                page.child(
                    div()
                        .text_color(style::secondary_text(cx))
                        .child(tr!("Archived")),
                )
            })
            .child(self.render_bot_tabs(&detail.capabilities, cx));
        if let Some(editor) = editor {
            page = page.child(self.render_bot_editor(editor, cx));
        } else {
            page = page.child(match self.bots.tab {
                Tab::Conversations => self.render_bot_conversations(detail, cx),
                Tab::Memory => self.render_bot_memory(detail, cx),
                Tab::Reviews => self.render_bot_reviews(detail, cx),
                Tab::Requests => self.render_bot_requests(detail, cx),
                Tab::Tasks => self.render_bot_tasks(detail, cx),
                Tab::Settings => self.render_bot_settings(detail, cx),
            });
        }
        page.into_any_element()
    }

    fn render_bot_tabs(&self, capabilities: &Capabilities, cx: &mut Context<Self>) -> AnyElement {
        let disabled = self.bots.busy || self.bots.editor.is_some();
        h_flex()
            .gap(px(8.))
            .flex_wrap()
            .children(
                [
                    (
                        Tab::Conversations,
                        "bot-tab-conversations",
                        tr!("Conversations"),
                    ),
                    (Tab::Memory, "bot-tab-memory", tr!("Memory")),
                    (Tab::Reviews, "bot-tab-reviews", tr!("Memory review")),
                    (Tab::Requests, "bot-tab-requests", tr!("Requests")),
                    (Tab::Tasks, "bot-tab-tasks", tr!("Background tasks")),
                    (Tab::Settings, "bot-tab-settings", tr!("Settings")),
                ]
                .into_iter()
                .filter(|(tab, _, _)| match tab {
                    Tab::Reviews => capabilities.reviews,
                    Tab::Requests => capabilities.requests,
                    Tab::Tasks => self.bots.tasks_available,
                    _ => true,
                })
                .map(|(tab, id, label)| {
                    bot_button(id, label, disabled)
                        .when(self.bots.tab == tab, |button| button.primary())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.bots.tab = tab;
                            this.bots.error = None;
                            if tab == Tab::Memory {
                                this.load_bot_memory(false, cx);
                            } else if tab == Tab::Reviews {
                                this.load_bot_reviews(cx);
                            } else if tab == Tab::Requests {
                                this.load_bot_requests(cx);
                            } else if tab == Tab::Tasks {
                                this.load_bot_tasks(false, cx);
                            }
                            cx.notify();
                        }))
                }),
            )
            .into_any_element()
    }

    fn render_bot_requests(&self, detail: &Details, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.bots.busy;
        let mut page = v_flex().gap(px(12.)).max_w(px(680.));
        if detail.conversations.is_empty() {
            return page
                .child(tr!("Start a conversation to see its requests."))
                .into_any_element();
        }
        page = page.child(h_flex().gap(px(6.)).flex_wrap().children(
            detail.conversations.iter().enumerate().map(|(index, row)| {
                let id = row.thread_id.clone();
                let selected = self.bots.source.as_ref() == Some(&id);
                let title = self.bot_conversation_title(index, &id, &detail.bot.name);
                bot_button(
                    SharedString::from(format!("bot-request-source-{id}")),
                    title,
                    busy,
                )
                .when(selected, |button| button.primary())
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bots.source = Some(id.clone());
                    this.load_bot_requests(cx);
                }))
            }),
        ));
        page = page.child(
            bot_button("bot-refresh-requests", tr!("Refresh requests"), busy)
                .loading(busy)
                .on_click(cx.listener(|this, _, _, cx| this.load_bot_requests(cx))),
        );
        if self.bots.requests.is_empty() && !busy {
            page = page.child(tr!("No requests from this conversation yet."));
        }
        for request in self.bots.requests.iter().rev() {
            page = page.child(self.render_bot_request_card(request, cx));
        }
        page.into_any_element()
    }

    fn render_bot_request_card(&self, request: &RequestCard, cx: &mut Context<Self>) -> AnyElement {
        let id = &request.id;
        let busy = self.bots.busy;
        let status = request.state.status.as_str();
        let name = self
            .bots
            .list
            .iter()
            .find(|bot| bot.id == request.target_bot_id)
            .map_or(tr!("Recipient Bot"), |bot| bot.name.as_str());
        let target = request.target_thread_id.clone();
        let payload = json!({ "threadId": self.bots.source, "requestId": id, "expectedRevision": request.revision });
        let presentation = if request.when == "now" {
            tr!("Joined a running turn")
        } else {
            tr!("Queued for the conversation")
        };
        let mut row = v_flex()
            .gap(px(7.))
            .p(px(10.))
            .rounded(px(8.))
            .bg(style::primary_opacity(cx, 0.04))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(format!("{name} · {}", request.state.label())),
            )
            .child(
                div()
                    .text_color(style::secondary_text(cx))
                    .child(presentation),
            );
        if let Some(reason) = &request.state.reason {
            row = row.child(
                div()
                    .text_color(style::secondary_text(cx))
                    .child(reason.clone()),
            );
        }
        row = row.child(
            bot_button(
                SharedString::from(format!("bot-request-recipient-{id}")),
                tr!("Open recipient"),
                busy || !self.threads.contains_key(&target),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_thread_from_page(target.clone(), window, cx)
            })),
        );
        if matches!(
            status,
            "admitted" | "queued" | "running" | "returning" | "uncertain"
        ) {
            let params = payload.clone();
            row = row.child(
                bot_button(
                    SharedString::from(format!("bot-request-cancel-{id}")),
                    tr!("Cancel request"),
                    busy,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.bot_write(
                        "bots.requests.cancel",
                        params.clone(),
                        After::Requests,
                        window,
                        cx,
                    )
                })),
            );
        }
        if self.bots.request_abandonment
            && request.parent_request_id.is_some()
            && matches!(status, "admitted" | "queued" | "running")
        {
            let params = payload.clone();
            row = row.child(
                bot_button(
                    SharedString::from(format!("bot-request-abandon-{id}")),
                    tr!("Give up waiting"),
                    busy,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.bot_write(
                        "bots.requests.abandon",
                        params.clone(),
                        After::Requests,
                        window,
                        cx,
                    )
                })),
            );
        }
        if matches!(status, "returning" | "uncertain") {
            row = row.child(
                bot_button(
                    SharedString::from(format!("bot-request-check-{id}")),
                    tr!("Check delivery"),
                    busy,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.bot_write(
                        "bots.requests.retry",
                        payload.clone(),
                        After::Requests,
                        window,
                        cx,
                    )
                })),
            );
        }
        if matches!(status, "failed" | "cancelled" | "uncertain") || request.state.failed {
            let request_id = id.clone();
            let revision = request.revision;
            row = row.child(
                bot_button(
                    SharedString::from(format!("bot-request-rerun-{id}")),
                    tr!("Start another run"),
                    busy,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_bot(
                        Edit::RequestRerun(request_id.clone(), revision),
                        String::new(),
                        window,
                        cx,
                    )
                })),
            );
        }
        if matches!(status, "returning" | "returned") || request.state.late.is_some() {
            if let Some((_, result)) = self
                .bots
                .request_result
                .as_ref()
                .filter(|(selected, _)| selected == id)
            {
                row = row.child(
                    div()
                        .id("bot-request-result")
                        .test_support()
                        .a11y_role(gpui_kit::Role::GenericContainer)
                        .aria_label(result.text.clone())
                        .child(result.text.clone()),
                );
                if !result.whole {
                    row = row.child(
                        div()
                            .text_color(style::secondary_text(cx))
                            .child(tr!("The full result is unavailable.")),
                    );
                }
            } else {
                let reply = id.clone();
                row = row.child(
                    bot_button(
                        SharedString::from(format!("bot-request-result-{id}")),
                        tr!("Read result"),
                        busy,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.load_bot_request_result(reply.clone(), cx)
                    })),
                );
            }
        }
        row.into_any_element()
    }

    fn render_bot_editor(&self, editor: &Editor, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.bots.busy;
        v_flex()
            .id("bot-edit-form")
            .max_w(px(580.))
            .gap(px(10.))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(editor.kind.label()),
            )
            .child(Textarea::new(&editor.field))
            .child(
                h_flex()
                    .gap(px(8.))
                    .child(
                        bot_button("bot-editor-save", tr!("Save"), busy)
                            .primary()
                            .loading(busy)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.save_bot_editor(window, cx)),
                            ),
                    )
                    .child(
                        bot_button("bot-editor-cancel", tr!("Cancel"), busy).on_click(cx.listener(
                            |this, _, _, cx| {
                                this.bots.editor = None;
                                this.bots.error = None;
                                cx.notify();
                            },
                        )),
                    ),
            )
            .into_any_element()
    }

    fn render_bot_conversations(&self, detail: &Details, cx: &mut Context<Self>) -> AnyElement {
        let bot_id = detail.bot.id.clone();
        let mut list = v_flex().gap(px(10.)).max_w(px(640.));
        if detail.bot.archived_at.is_none() && self.bots.schedules_available {
            let target = json!({ "kind": "newConversation", "botId": bot_id });
            let label = format!("New conversation with {}", detail.bot.name);
            list = list.child(
                bot_button(
                    "schedule-new-bot-conversation",
                    "Schedule a new conversation",
                    self.bots.busy,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_bot_schedule(target.clone(), label.clone(), None, window, cx)
                })),
            );
        }
        if detail.bot.archived_at.is_none() {
            let create_bot_id = bot_id.clone();
            list = list.child(
                bot_button(
                    "bot-new-conversation",
                    tr!("New conversation"),
                    self.bots.busy,
                )
                .primary()
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.new_bot_conversation(create_bot_id.clone(), window, cx)
                })),
            );
        }
        if self.bots.roster.available
            && detail.bot.archived_at.is_none()
            && detail.bot.privacy.is_none()
        {
            list = list.child(self.render_attachment(&detail.bot, cx));
        }
        for (index, row) in detail.conversations.iter().enumerate().rev() {
            let title = self.bot_conversation_title(index, &row.thread_id, &detail.bot.name);
            let thread = row.thread_id.clone();
            let source = thread.clone();
            let worker_source = thread.clone();
            let history_source = thread.clone();
            let missing = !self.threads.contains_key(&thread);
            let scheduled = row.id.as_ref().filter(|_| !missing && self.bots.schedules_available && detail.bot.archived_at.is_none())
                .map(|conversation| json!({ "kind": "conversation", "botId": bot_id, "conversationId": conversation, "threadId": thread }));
            let schedule_title = title.clone();
            let worker = self.bots.workers_available
                && !missing
                && detail.bot.privacy.is_none()
                && detail.bot.archived_at.is_none();
            list = list.child(
                h_flex()
                    .gap(px(8.))
                    .flex_wrap()
                    .child(
                        bot_button(
                            SharedString::from(format!("bot-conversation-{thread}")),
                            title,
                            missing || self.bots.busy,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.open_thread_from_page(thread.clone(), window, cx)
                            },
                        )),
                    )
                    .child(
                        bot_button(
                            SharedString::from(format!("bot-notes-from-{source}")),
                            tr!("Notes"),
                            missing || self.bots.busy,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.bots.tab = Tab::Memory;
                            this.bots.source = Some(source.clone());
                            this.bots.scope = None;
                            this.load_bot_memory(false, cx);
                        })),
                    )
                    .children(worker.then(|| {
                        bot_button(
                            SharedString::from(format!("bot-worker-{index}")),
                            tr!("Run on another Runner"),
                            self.bots.busy,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.bot_write(
                                    "bots.workers.targets",
                                    json!({ "threadId": worker_source }),
                                    After::WorkerChoices(worker_source.clone()),
                                    window,
                                    cx,
                                );
                            },
                        ))
                    }))
                    .children(worker.then(|| {
                        bot_button(
                            SharedString::from(format!("bot-worker-history-{index}")),
                            tr!("Worker requests"),
                            self.bots.busy,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.load_bot_worker_history(history_source.clone(), window, cx);
                            },
                        ))
                    }))
                    .children(scheduled.map(|target| {
                        bot_button(
                            SharedString::from(format!("schedule-bot-conversation-{index}")),
                            "Schedule this conversation",
                            self.bots.busy,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.edit_bot_schedule(
                                    target.clone(),
                                    schedule_title.clone(),
                                    None,
                                    window,
                                    cx,
                                );
                            },
                        ))
                    })),
            );
        }
        if let Some((source, runners)) = self.bots.worker_choices.as_ref().filter(|(source, _)| {
            detail
                .conversations
                .iter()
                .any(|row| &row.thread_id == source)
        }) {
            list = list.child(tr!("Choose a Runner"));
            for runner in runners {
                let source = source.clone();
                let target = runner.id.clone();
                list = list.child(
                    bot_button(
                        SharedString::from(format!("bot-worker-target-{target}")),
                        runner.name.clone(),
                        self.bots.busy,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_bot(
                            Edit::Worker(source.clone(), target.clone()),
                            String::new(),
                            window,
                            cx,
                        );
                    })),
                );
            }
        }
        if let Some((_, requests)) = self.bots.worker_history.as_ref().filter(|(source, _)| {
            detail
                .conversations
                .iter()
                .any(|row| &row.thread_id == source)
        }) {
            if requests.is_empty() {
                list = list.child(tr!("No worker requests for this conversation."));
            }
            for request in requests {
                let state = match request.state {
                    BotWorkerState::Queued => tr!("Queued"),
                    BotWorkerState::Running => tr!("Running"),
                    BotWorkerState::Done => tr!("Finished"),
                    BotWorkerState::Expired => tr!("Expired"),
                    BotWorkerState::Unknown => tr!("Status unavailable"),
                };
                let mut row = h_flex()
                    .gap(px(8.))
                    .child(self.runner_name_of(&request.target_runner_id))
                    .child(state);
                if let Some(result) = &request.result {
                    let thread = result.thread_id.clone();
                    row = row.child(
                        bot_button(
                            SharedString::from(format!("bot-worker-open-{}", request.request_id)),
                            tr!("Open worker Thread"),
                            self.bots.busy,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.open_thread_from_page(thread.clone(), window, cx);
                            },
                        )),
                    );
                }
                list = list.child(row);
            }
        }
        list.into_any_element()
    }

    fn bot_conversation_title(&self, index: usize, id: &str, bot_name: &str) -> String {
        self.threads
            .get(id)
            .filter(|thread| !thread.title.is_empty() && thread.title != bot_name)
            .map_or_else(
                || format!("Conversation {}", index + 1),
                |thread| thread.title.clone(),
            )
    }

    fn render_bot_settings(&self, detail: &Details, cx: &mut Context<Self>) -> AnyElement {
        let bot = &detail.bot;
        let disabled = self.bots.busy || bot.archived_at.is_some();
        let fields = [
            ("bot-edit-name", Edit::Name, &bot.name),
            ("bot-edit-role", Edit::Role, &bot.role),
            (
                "bot-edit-instructions",
                Edit::Instructions,
                &bot.instructions,
            ),
        ];
        let mut section = v_flex().gap(px(14.)).max_w(px(620.));
        if self.bots.profile_panel.available && bot.archived_at.is_none() {
            section = section.child(
                bot_button("bot-open-profile", tr!("Open profile editor"), disabled)
                    .on_click(cx.listener(|this, _, _, cx| this.open_original_profile(cx))),
            );
        }
        for (id, edit, text) in fields {
            let before = text.clone();
            let label = edit.label();
            section = section.child(
                v_flex()
                    .gap(px(4.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(label))
                    .child(div().child(if text.is_empty() {
                        tr!("None").into()
                    } else {
                        text.clone()
                    }))
                    .child(
                        bot_button(id, format!("Edit {}", label.to_lowercase()), disabled)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.edit_bot(edit.clone(), before.clone(), window, cx)
                            })),
                    ),
            );
        }
        section = section.child(self.render_bot_model(bot, disabled, cx));
        if self.bots.teams_available {
            section = section.child(self.render_bot_permission_limit(bot, disabled, cx));
        }
        if let Some(privacy) = &bot.privacy {
            let title = if privacy.moving.is_some() {
                tr!("Moving to a private work folder")
            } else {
                tr!("Private work folder")
            };
            section = section.child(
                v_flex()
                    .gap(px(4.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
                    .child(div().child(privacy.folder.clone())),
            );
            if privacy.moving.is_some() {
                let retry = json!({ "botId": bot.id, "expectedRevision": bot.revision, "folder": privacy.folder, "operationId": privacy.operation_id });
                section = section.child(
                    bot_button(
                        "bot-retry-privacy",
                        tr!("Retry making private"),
                        self.bots.busy,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.bot_write(
                            "bots.settings.privacy",
                            retry.clone(),
                            After::Profile,
                            window,
                            cx,
                        )
                    })),
                );
            }
        } else if detail.capabilities.privacy {
            if !detail.conversations.is_empty() {
                section = section.child(div().text_color(style::secondary_text(cx))
                    .child(tr!("Stop the Bot’s conversations first. Making them private withdraws their copies from sync.")));
            }
            section = section.child(
                bot_button("bot-make-private", tr!("Set private work folder"), disabled).on_click(
                    cx.listener(|this, _, window, cx| {
                        this.edit_bot(Edit::Privacy, String::new(), window, cx)
                    }),
                ),
            );
        }
        let (id, revision) = (bot.id.clone(), bot.revision);
        if bot.archived_at.is_none() {
            section = section.child(
                bot_button("bot-archive", tr!("Archive Bot"), disabled).on_click(cx.listener(
                    move |this, _, window, cx| {
                        this.bot_write(
                            "bots.archive",
                            json!({ "botId": id, "expectedRevision": revision }),
                            After::Profile,
                            window,
                            cx,
                        );
                    },
                )),
            );
        }
        section.into_any_element()
    }

    fn render_bot_model(
        &self,
        bot: &Profile,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let label = bot.model_binding.as_ref().map_or_else(
            || tr!("Runner defaults").to_owned(),
            |binding| {
                let title = self
                    .logins
                    .account(&binding.account_id)
                    .map_or(binding.account_id.as_str(), |account| {
                        account.title.as_str()
                    });
                format!("{} · {title}", binding.model)
            },
        );
        let mut section = v_flex()
            .gap(px(4.))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(tr!("Model for new conversations")),
            )
            .child(div().child(label));
        if let Some(source) = self
            .bots
            .source
            .as_ref()
            .filter(|source| self.threads.contains_key(*source))
        {
            let params =
                json!({ "botId": bot.id, "expectedRevision": bot.revision, "threadId": source });
            section = section.child(
                bot_button(
                    "bot-use-conversation-model",
                    tr!("Use this conversation’s model"),
                    disabled,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.bot_write(
                        "bots.settings.conversationModel",
                        params.clone(),
                        After::Profile,
                        window,
                        cx,
                    )
                })),
            );
        }
        if bot.model_binding.is_some() {
            let params =
                json!({ "botId": bot.id, "expectedRevision": bot.revision, "threadId": null });
            section = section.child(
                bot_button("bot-reset-model", tr!("Use Runner defaults"), disabled).on_click(
                    cx.listener(move |this, _, window, cx| {
                        this.bot_write(
                            "bots.settings.conversationModel",
                            params.clone(),
                            After::Profile,
                            window,
                            cx,
                        )
                    }),
                ),
            );
        }
        section.into_any_element()
    }

    fn render_bot_memory(&self, detail: &Details, cx: &mut Context<Self>) -> AnyElement {
        let mut section = v_flex().gap(px(12.)).max_w(px(640.));
        let scope = self.bots.scope.as_ref();
        let disabled = self.bots.busy
            || scope.map_or(detail.bot.archived_at.is_some(), |scope| scope.archived);
        if detail.capabilities.scoped_memory {
            let options = self
                .bots
                .scopes
                .iter()
                .filter(|scope| scope.kind != "bot" || scope.id == detail.bot.id);
            section = section.child(
                h_flex()
                    .flex_wrap()
                    .gap(px(6.))
                    .child(
                        bot_button(
                            "bot-memory-personal",
                            tr!("Conversation notes"),
                            self.bots.busy || self.bots.source.is_none(),
                        )
                        .when(scope.is_none(), |button| button.primary())
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.bots.scope = None;
                            this.load_bot_memory(false, cx);
                        })),
                    )
                    .children(options.map(|option| {
                        let selected = scope.is_some_and(|scope| {
                            scope.id == option.id && scope.kind == option.kind
                        });
                        let label = match option.kind.as_str() {
                            "project" => format!("Project: {}", option.title),
                            "bot" => format!("Bot: {}", option.title),
                            _ => option.title.clone(),
                        };
                        let option = option.clone();
                        bot_button(
                            SharedString::from(format!(
                                "bot-memory-scope-{}-{}",
                                option.kind, option.id
                            )),
                            label,
                            self.bots.busy,
                        )
                        .when(selected, |button| button.primary())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.bots.scope = Some(option.clone());
                            this.load_bot_memory(false, cx);
                        }))
                    })),
            );
        }
        if let Some(scope) = scope.filter(|scope| {
            self.bots.restore.available
                && !scope.archived
                && matches!(scope.kind.as_str(), "bot" | "group")
        }) {
            section = section.child(self.render_backup_restore(scope, cx));
        }
        let (target, caption) = if let Some(scope) = scope {
            (
                json!({ "scope": scope.target(), "expectedRevision": self.bots.memory_revision }),
                scope.title.clone(),
            )
        } else if let Some(source) = self.bots.source.as_ref() {
            let index = detail
                .conversations
                .iter()
                .position(|row| row.thread_id == *source)
                .unwrap_or(0);
            (
                json!({ "botId": detail.bot.id, "threadId": source }),
                format!(
                    "New notes are filed from {}.",
                    self.bot_conversation_title(index, source, &detail.bot.name)
                ),
            )
        } else {
            return section
                .child(tr!("Start a conversation to file notes from it."))
                .into_any_element();
        };
        section = section
            .child(div().text_color(style::secondary_text(cx)).child(caption))
            .child(
                bot_button("bot-add-note", tr!("Add note"), disabled)
                    .primary()
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.edit_bot(Edit::Note(None), String::new(), window, cx)
                    })),
            );
        if scope.is_some() && detail.bot.model_binding.is_some() && !self.bots.notes.is_empty() {
            let mut tidy = target.clone();
            tidy["botId"] = json!(detail.bot.id);
            section = section.child(
                bot_button("bot-tidy-scope", tr!("Tidy this memory"), disabled).on_click(
                    cx.listener(move |this, _, window, cx| {
                        this.bot_write(
                            "bots.memory.scope.tidy",
                            tidy.clone(),
                            After::Memory,
                            window,
                            cx,
                        )
                    }),
                ),
            );
        }
        if self.bots.notes.is_empty() && !self.bots.busy {
            section = section.child(div().child(tr!("No saved notes.")));
        }
        for note in &self.bots.notes {
            section = section.child(self.render_bot_note(note, &target, disabled, cx));
        }
        section
            .child(self.render_bot_history(&target, disabled, cx))
            .into_any_element()
    }

    fn render_bot_reviews(&self, detail: &Details, cx: &mut Context<Self>) -> AnyElement {
        let bot = &detail.bot;
        let enabled = bot.review_enabled.unwrap_or(false);
        let tidy = bot.tidy_enabled.unwrap_or(false);
        let disabled = self.bots.busy || bot.archived_at.is_some();
        let no_model = bot.model_binding.is_none() || self.bots.review_unavailable.is_some();
        let settings =
            json!({ "botId": bot.id, "expectedRevision": bot.revision, "enabled": !enabled });
        let mut section = v_flex().gap(px(12.)).max_w(px(680.));
        section = section.child(
            bot_button(
                "bot-review-toggle",
                if enabled {
                    tr!("Turn off automatic review")
                } else {
                    tr!("Turn on automatic review")
                },
                disabled || (!enabled && no_model),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.bot_write(
                    "bots.settings.automaticReview",
                    settings.clone(),
                    After::Profile,
                    window,
                    cx,
                )
            })),
        );
        let tidy_settings =
            json!({ "botId": bot.id, "expectedRevision": bot.revision, "enabled": !tidy });
        section = section.child(
            bot_button(
                "bot-tidy-toggle",
                if tidy {
                    tr!("Turn off automatic tidy")
                } else {
                    tr!("Turn on automatic tidy")
                },
                disabled || (!tidy && no_model),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.bot_write(
                    "bots.settings.automaticTidy",
                    tidy_settings.clone(),
                    After::Profile,
                    window,
                    cx,
                )
            })),
        );
        if let Some(reason) = self.bots.review_unavailable.clone().or_else(|| {
            bot.model_binding.is_none().then(|| {
                tr!("Choose a conversation’s login and model in Bot settings first.").to_owned()
            })
        }) {
            section = section.child(div().text_color(style::secondary_text(cx)).child(reason));
        }
        if detail.conversations.is_empty() {
            return section
                .child(tr!("Start a conversation to see its memory reviews."))
                .into_any_element();
        }
        section = section.child(h_flex().flex_wrap().gap(px(6.)).children(
            detail.conversations.iter().enumerate().map(|(index, row)| {
                let thread_id = row.thread_id.clone();
                let selected = self.bots.source.as_ref() == Some(&thread_id);
                let title = self.bot_conversation_title(index, &thread_id, &bot.name);
                bot_button(
                    SharedString::from(format!("bot-review-conversation-{thread_id}")),
                    title,
                    self.bots.busy,
                )
                .when(selected, |button| button.primary())
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bots.source = Some(thread_id.clone());
                    this.load_bot_reviews(cx);
                }))
            }),
        ));
        section = section.child(
            bot_button(
                "bot-refresh-reviews",
                tr!("Refresh reviews"),
                self.bots.busy,
            )
            .on_click(cx.listener(|this, _, _, cx| this.load_bot_reviews(cx))),
        );
        if self.bots.reports.is_empty() && !self.bots.busy {
            section = section.child(tr!("No memory reviews yet."));
        }
        section
            .children(
                self.bots
                    .reports
                    .iter()
                    .map(|report| self.render_bot_review_report(bot, report, disabled, cx)),
            )
            .into_any_element()
    }

    fn render_bot_review_report(
        &self,
        bot: &Profile,
        report: &ReviewReport,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let source = &report.source;
        let mut row = v_flex()
            .gap(px(7.))
            .p(px(10.))
            .rounded(px(8.))
            .bg(style::primary_opacity(cx, 0.04))
            .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                "{} · Events {}–{}",
                source.model, source.first, source.through
            )));
        if let Some(usage) = &report.usage {
            let tokens = usage
                .input_tokens
                .zip(usage.output_tokens)
                .map(|(input, output)| format!("{input} input / {output} output tokens."));
            let cost = usage
                .notional_usd
                .map(|cost| format!(" Estimated API cost ${cost:.4}."));
            if tokens.is_some() || cost.is_some() {
                row = row.child(div().text_color(style::secondary_text(cx)).child(format!(
                    "{}{}",
                    tokens.unwrap_or_default(),
                    cost.unwrap_or_default()
                )));
            }
        }
        if report.diagnostic.is_some() {
            row = row.child(tr!("The model reply could not be read."));
        }
        if report.rejected > 0 {
            row = row.child(format!(
                "{} suggestions could not be used.",
                report.rejected
            ));
        }
        let retry = json!({ "botId": bot.id, "threadId": self.bots.source, "reportId": report.id });
        row = row.child(
            bot_button(
                SharedString::from(format!("bot-review-retry-{}", report.id)),
                tr!("Review these messages again"),
                disabled || self.bots.review_unavailable.is_some(),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.bot_write(
                    "bots.reviews.retry",
                    retry.clone(),
                    After::Reviews,
                    window,
                    cx,
                )
            })),
        );
        for (index, change) in report.changes.iter().enumerate() {
            let action = match change.op.as_str() {
                "add" => tr!("Add"),
                "remove" => tr!("Remove"),
                _ => tr!("Edit"),
            };
            let proposal = change
                .accepted_text
                .as_ref()
                .or(change.text.as_ref())
                .or(change.before.as_ref())
                .cloned()
                .unwrap_or_default();
            let status = match change.decision.as_str() {
                "approved" => tr!("Accepted"),
                "rejected" => tr!("Rejected"),
                _ => tr!("Pending"),
            };
            let mut item = v_flex()
                .gap(px(5.))
                .child(div().child(format!("{status} · {action}")))
                .child(div().child(proposal.clone()));
            if change.op == "edit" {
                if let Some(previous) = &change.before {
                    item = item.child(
                        div()
                            .text_color(style::secondary_text(cx))
                            .child(format!("Previous note: {previous}")),
                    );
                }
            }
            if change.decision == "pending" {
                let params = json!({ "botId": bot.id, "threadId": self.bots.source, "reportId": report.id, "index": index });
                let reject = params.clone();
                let report_id = report.id.clone();
                let mut buttons = h_flex()
                    .gap(px(6.))
                    .child(
                        bot_button(
                            SharedString::from(format!("bot-review-approve-{}-{index}", report.id)),
                            tr!("Accept"),
                            disabled,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.bot_write(
                                    "bots.reviews.approve",
                                    params.clone(),
                                    After::Reviews,
                                    window,
                                    cx,
                                )
                            },
                        )),
                    )
                    .child(
                        bot_button(
                            SharedString::from(format!("bot-review-reject-{}-{index}", report.id)),
                            tr!("Reject"),
                            disabled,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.bot_write(
                                    "bots.reviews.reject",
                                    reject.clone(),
                                    After::Reviews,
                                    window,
                                    cx,
                                )
                            },
                        )),
                    );
                if change.op != "remove" {
                    buttons = buttons.child(
                        bot_button(
                            SharedString::from(format!("bot-review-edit-{}-{index}", report.id)),
                            tr!("Edit and accept"),
                            disabled,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.edit_bot(
                                    Edit::Review(report_id.clone(), index),
                                    proposal.clone(),
                                    window,
                                    cx,
                                )
                            },
                        )),
                    );
                }
                item = item.child(buttons);
            }
            row = row.child(item);
        }
        row.into_any_element()
    }

    fn render_bot_note(
        &self,
        note: &Note,
        target: &Value,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let note_id = note.id.clone();
        let (edit_id, text) = (note_id.clone(), note.text.clone());
        let mut params = target.clone();
        params["entryId"] = json!(note_id);
        let remove = if self.bots.scope.is_some() {
            "bots.memory.scope.remove"
        } else {
            "bots.memory.remove"
        };
        let timing = match (&note.until, note.pinned) {
            (Some(until), _) => format!("Through {until}"),
            (None, true) => tr!("Pinned").into(),
            (None, false) => String::new(),
        };
        let topic = note.topic.as_ref().map(|topic| format!("Topic: {topic}"));
        v_flex()
            .gap(px(7.))
            .p(px(12.))
            .rounded(px(8.))
            .bg(style::primary_opacity(cx, 0.04))
            .child(
                div()
                    .id(SharedString::from(format!("bot-note-{note_id}")))
                    .test_support()
                    .a11y_role(gpui_kit::Role::GenericContainer)
                    .aria_label(note.text.clone())
                    .child(note.text.clone()),
            )
            .when(!timing.is_empty(), |row| {
                row.child(div().text_color(style::secondary_text(cx)).child(timing))
            })
            .when_some(topic, |row, topic| {
                row.child(div().text_color(style::secondary_text(cx)).child(topic))
            })
            .child(
                h_flex()
                    .gap(px(8.))
                    .child(
                        bot_button(
                            SharedString::from(format!("bot-edit-note-{note_id}")),
                            tr!("Edit"),
                            disabled,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.edit_bot(
                                    Edit::Note(Some(edit_id.clone())),
                                    text.clone(),
                                    window,
                                    cx,
                                )
                            },
                        )),
                    )
                    .child(
                        bot_button(
                            SharedString::from(format!("bot-remove-note-{note_id}")),
                            tr!("Remove"),
                            disabled,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.bot_write(remove, params.clone(), After::Memory, window, cx)
                            },
                        )),
                    ),
            )
            .into_any_element()
    }

    fn render_bot_history(
        &self,
        target: &Value,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut history = v_flex().mt(px(8.)).gap(px(8.)).child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .child(tr!("History")),
        );
        if self.bots.changes.is_empty() && !self.bots.busy {
            history = history.child(
                div()
                    .text_color(style::secondary_text(cx))
                    .child(tr!("No changes yet.")),
            );
        }
        for change in &self.bots.changes {
            let action = match change.op.as_str() {
                _ if change.restored.is_some() => tr!("Restored"),
                "add" => tr!("Added"),
                "remove" => tr!("Removed"),
                "tidy" => tr!("Tidied"),
                _ => tr!("Edited"),
            };
            let text = change
                .after
                .as_ref()
                .or(change.before.as_ref())
                .map(|line| line.trim_start_matches("- "))
                .unwrap_or("");
            let text = text.rsplit_once(" [id:").map_or(text, |(body, _)| body);
            let caption = format!(
                "{action} · {}",
                change.time.get(..10).unwrap_or(&change.time)
            );
            let restored = self
                .bots
                .changes
                .iter()
                .any(|later| later.restored.as_ref() == Some(&change.id));
            let mut params = target.clone();
            params["changeId"] = json!(change.id);
            let restore = if self.bots.scope.is_some() {
                "bots.memory.scope.restore"
            } else {
                "bots.memory.restore"
            };
            history = history.child(
                h_flex()
                    .gap(px(10.))
                    .child(
                        v_flex()
                            .flex_1()
                            .gap(px(2.))
                            .child(div().text_color(style::secondary_text(cx)).child(caption))
                            .child(div().child(text.to_owned())),
                    )
                    .child(
                        bot_button(
                            SharedString::from(format!("bot-restore-{}", change.id)),
                            tr!("Undo change"),
                            disabled || restored,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.bot_write(restore, params.clone(), After::Memory, window, cx)
                            },
                        )),
                    ),
            );
        }
        if self.bots.more.is_some() {
            history = history.child(
                bot_button(
                    "bot-more-history",
                    tr!("Load older changes"),
                    self.bots.busy,
                )
                .on_click(cx.listener(|this, _, _, cx| this.load_bot_memory(true, cx))),
            );
        }
        history.into_any_element()
    }

    pub(crate) fn render_bot_chip(
        &self,
        thread: &ThreadSummary,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.bots_on() || thread.is_remote() {
            return None;
        }
        let link = thread.bot_link.as_ref()?;
        if let Some(group_id) = link.group_id.clone() {
            return Some(
                bot_button("thread-bot-group", "Open Bot Group", self.bots.busy)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_group_from_thread(group_id.clone(), window, cx);
                    }))
                    .into_any_element(),
            );
        }

        let (bot_id, thread_id) = (link.bot_id.clone(), thread.id.clone());
        let (request_bot, request_source) = (bot_id.clone(), thread_id.clone());
        let task = link.task_id.is_some();
        let task_action = self.render_task_thread_action(thread, link, cx);
        let label = self
            .bots
            .list
            .iter()
            .find(|bot| bot.id == bot_id)
            .map_or("Bot", |bot| bot.name.as_str())
            .to_owned();
        let tip = if task {
            tr!("Show this Bot’s background tasks")
        } else {
            tr!("Show the Bot’s notes and settings")
        };
        let chip = div()
            .id("thread-bot-chip")
            .flex_none()
            .px(px(7.))
            .py(px(2.))
            .rounded_full()
            .cursor_pointer()
            .bg(style::primary_opacity(cx, 0.06))
            .test_support()
            .a11y_role(gpui_kit::Role::Button)
            .aria_label(tip)
            .tip(tip)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.open_bot_from_thread(bot_id.clone(), thread_id.clone(), cx);
                if task {
                    this.bots.tab = Tab::Tasks;
                    cx.notify();
                }
            }))
            .child(label);
        Some(
            h_flex()
                .gap(px(4.))
                .child(chip)
                .children(task_action)
                .when(self.bots.requests_available && !task, |row| {
                    row.child(
                        bot_button(
                            "thread-bot-requests",
                            tr!("Requests from this conversation"),
                            self.bots.busy,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.open_bot_from_thread(
                                request_bot.clone(),
                                request_source.clone(),
                                cx,
                            );
                            this.bots.tab = Tab::Requests;
                            cx.notify();
                        })),
                    )
                })
                .into_any_element(),
        )
    }
}

enum After {
    WorkerChoices(String),
    WorkerQueued(String),
    WorkerHistory(String),
    Requests,
    Tasks,
    Teams,
    Profile,
    Conversation,
    Memory,
    BackupIndex,
    BackupNotes(String),
    Reviews,
}

impl Threadbear {
    fn edit_bot(
        &mut self,
        kind: Edit,
        before: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.bots.busy || self.bots.editor.is_some() {
            return;
        }
        let rows = if matches!(kind, Edit::Instructions | Edit::GrantChief(..)) {
            (4, 14)
        } else {
            (2, 6)
        };
        let placeholder = kind.label();
        let field = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(rows.0, rows.1)
                .placeholder(placeholder)
                .default_value(before)
        });
        crate::unsent::watch(&field, "a Bot setting or note being edited", cx);
        field.update(cx, |state, cx| state.focus(window, cx));
        crate::web_panels::keyboard_to_app(window);
        self.bots.editor = Some(Editor {
            kind,
            field,
            revision: self.bots.detail.as_ref().map(|detail| detail.bot.revision),
            memory_revision: self.bots.memory_revision.clone(),
        });
        self.bots.error = None;
        cx.notify();
    }

    fn save_bot_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = &self.bots.editor else {
            return;
        };
        let text = editor.field.read(cx).value().trim().to_owned();
        let id = self.bots.selected.clone();
        let revision = editor.revision;
        let (method, params, after) = match &editor.kind {
            Edit::New => ("bots.create", json!({ "name": text }), After::Profile),
            Edit::Privacy => (
                "bots.settings.privacy",
                json!({ "botId": id, "expectedRevision": revision, "folder": text }),
                After::Profile,
            ),
            Edit::Review(report_id, index) => (
                "bots.reviews.approve",
                json!({ "botId": id, "threadId": self.bots.source, "reportId": report_id, "index": index, "text": text }),
                After::Reviews,
            ),
            Edit::NewTeam => (
                "bots.teams.create",
                json!({ "title": text, "memberIds": [] }),
                After::Teams,
            ),
            Edit::RenameTeam(team_id, revision) => (
                "bots.teams.update",
                json!({ "teamId": team_id, "expectedRevision": revision, "title": text }),
                After::Teams,
            ),
            Edit::GrantChief(team_id, revision, bot_id) => {
                let Ok(grant) = serde_json::from_str::<Value>(&text) else {
                    self.bots.error = Some(
                        tr!("Enter a JSON object with the permissions for this Chief.").into(),
                    );
                    cx.notify();
                    return;
                };
                (
                    "bots.teams.setGrants",
                    json!({ "teamId": team_id, "expectedRevision": revision, "botId": bot_id, "grant": grant }),
                    After::Teams,
                )
            }
            Edit::TaskStart => {
                let Some((title, brief)) = text.split_once('\n') else {
                    self.bots.error = Some(
                        tr!("Write the task title on the first line, then add a brief.").into(),
                    );
                    cx.notify();
                    return;
                };
                (
                    "bots.tasks.start",
                    json!({ "threadId": self.bots.source, "title": title.trim(), "brief": brief.trim() }),
                    After::Tasks,
                )
            }
            Edit::Worker(source, target) => (
                "bots.workers.start",
                json!({ "threadId": source, "targetRunnerId": target, "text": text }),
                After::WorkerQueued(source.clone()),
            ),
            Edit::TaskWrite(task_id) => (
                "bots.tasks.send",
                json!({ "taskId": task_id, "text": text }),
                After::Tasks,
            ),
            Edit::TaskRetry(task_id, revision) => (
                "bots.tasks.retry",
                json!({ "taskId": task_id, "expectedRevision": revision, "brief": text }),
                After::Tasks,
            ),
            Edit::RequestRerun(request_id, expected_revision) => (
                "bots.requests.rerun",
                json!({ "threadId": self.bots.source, "requestId": request_id, "expectedRevision": expected_revision, "text": text }),
                After::Requests,
            ),
            Edit::Note(entry) => {
                let scoped = self.bots.scope.is_some();
                let mut params = if let Some(scope) = &self.bots.scope {
                    json!({ "scope": scope.target(), "expectedRevision": editor.memory_revision, "text": text })
                } else {
                    json!({ "botId": id, "threadId": self.bots.source, "text": text })
                };
                let method = if let Some(entry) = entry {
                    params["entryId"] = json!(entry);
                    if scoped {
                        "bots.memory.scope.edit"
                    } else {
                        "bots.memory.edit"
                    }
                } else {
                    if scoped {
                        "bots.memory.scope.add"
                    } else {
                        "bots.memory.add"
                    }
                };
                (method, params, After::Memory)
            }
            kind => {
                let field = match kind {
                    Edit::Name => "name",
                    Edit::Role => "role",
                    _ => "instructions",
                };
                let mut params = json!({ "botId": id, "expectedRevision": revision });
                params[field] = json!(text);
                ("bots.update", params, After::Profile)
            }
        };
        self.bot_write(method, params, after, window, cx);
    }

    fn new_bot_conversation(
        &mut self,
        bot_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.bots.busy {
            return;
        }
        let operation = match &self.bots.pending_conversation {
            Some((id, operation)) if id == &bot_id => operation.clone(),
            _ => {
                self.bots.operation += 1;
                let operation = format!(
                    "desktop-{}-{}-{}",
                    std::process::id(),
                    now_ms(),
                    self.bots.operation
                );
                self.bots.pending_conversation = Some((bot_id.clone(), operation.clone()));
                operation
            }
        };
        self.bot_write(
            "bots.conversations.create",
            json!({ "botId": bot_id, "operationId": operation }),
            After::Conversation,
            window,
            cx,
        );
    }

    fn bot_write(
        &mut self,
        method: &'static str,
        mut params: Value,
        after: After,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.bots.busy {
            return;
        }
        if params["operationId"].is_null()
            && (method.starts_with("bots.reviews.")
                || method.starts_with("bots.memory.scope.")
                || matches!(
                    method,
                    "bots.settings.privacy"
                        | "bots.settings.automaticReview"
                        | "bots.settings.automaticTidy"
                        | "bots.requests.rerun"
                        | "bots.tasks.start"
                        | "bots.workers.start"
                        | "bots.tasks.send"
                        | "bots.tasks.retry"
                        | "bots.duplicate"
                        | "bots.conversations.attach"
                        | "bots.memory.createBackup"
                        | "bots.memory.recoverFromBackup"
                ))
        {
            let operation = match &self.bots.pending_write {
                Some((previous, payload, id)) if *previous == method && *payload == params => {
                    id.clone()
                }
                _ => {
                    self.bots.operation += 1;
                    let operation = format!(
                        "desktop-{}-{}-{}",
                        std::process::id(),
                        now_ms(),
                        self.bots.operation
                    );
                    self.bots.pending_write = Some((method, params.clone(), operation.clone()));
                    operation
                }
            };
            params["operationId"] = json!(operation);
        }
        self.bots.busy = true;
        self.bots.error = None;
        let client = self.client.clone();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = call(client, method, params).await;
            this.update_in(cx, |this, window, cx| {
                this.bots.busy = false;
                match result {
                    Ok(value) => {
                        this.bots.pending_write = None;
                        this.bot_written(after, value, window, cx);
                    }
                    Err(error) => this.bots.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn load_bot_worker_history(
        &mut self,
        source: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.bot_write(
            "bots.workers.history",
            json!({ "threadId": source }),
            After::WorkerHistory(source),
            window,
            cx,
        );
    }

    fn bot_written(
        &mut self,
        after: After,
        value: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match after {
            After::WorkerChoices(source) => {
                let runners =
                    serde_json::from_value::<Vec<BotWorkerTarget>>(value["runners"].clone())
                        .unwrap_or_default();
                if runners.is_empty() {
                    self.bots.worker_choices = None;
                    self.bots.error =
                        Some(tr!("No other Runner can take Bot work right now.").into());
                } else {
                    self.bots.worker_choices = Some((source, runners));
                }
            }
            After::WorkerQueued(source) => {
                if value["requestId"].as_str().is_some() {
                    self.bots.editor = None;
                    self.bots.worker_choices = None;
                    self.load_bot_worker_history(source, window, cx);
                } else {
                    self.bots.error =
                        Some(tr!("The Runner did not return the worker request.").into());
                }
            }
            After::WorkerHistory(source) => {
                match serde_json::from_value::<Vec<BotWorkerRequest>>(value) {
                    Ok(rows) => self.bots.worker_history = Some((source, rows)),
                    Err(_) => {
                        self.bots.error = Some(tr!("Worker requests could not be read.").into())
                    }
                }
            }
            After::Profile => {
                let Ok(profile) = serde_json::from_value::<Profile>(value["bot"].clone()) else {
                    self.bots.error = Some(tr!("The Runner did not return the saved Bot.").into());
                    return;
                };
                self.bots.editor = None;
                let id = profile.id.clone();
                self.bots.list.retain(|bot| bot.id != id);
                self.bots.list.push(profile);
                if self.bots.selected.as_ref() != Some(&id) {
                    self.select_bot(id, None, cx);
                } else {
                    self.load_bot(id, cx);
                }
            }
            After::Conversation => {
                let Ok(thread) = serde_json::from_value::<ThreadSummary>(value["thread"].clone())
                else {
                    self.bots.error =
                        Some(tr!("The Runner did not return the new conversation.").into());
                    return;
                };
                self.bots.pending_conversation = None;
                self.bots.roster.close_attachment();
                let id = thread.id.clone();
                self.store_reply_summary(thread);
                if self.home_page() == Some(SidebarMode::Bots) {
                    self.open_thread_from_page(id, window, cx);
                }
                self.load_list(cx);
            }
            After::Memory => {
                self.bots.editor = None;
                self.load_bot_memory(false, cx);
            }
            After::BackupIndex => {
                if self.bots.restore.show_backups(value).is_err() {
                    self.bots.error =
                        Some(tr!("The Runner could not return the Bot backups.").into());
                }
            }
            After::BackupNotes(backup_id) => {
                if self.bots.restore.show_notes(backup_id, value).is_err() {
                    self.bots.error =
                        Some(tr!("The Runner could not preview this Bot backup.").into());
                }
            }
            After::Teams => {
                self.bots.editor = None;
                self.bots.selected_team = value["team"]["id"].as_str().map(str::to_owned);
                self.load_bot_teams(cx);
            }
            After::Tasks => {
                self.bots.editor = None;
                self.load_bot_tasks(false, cx);
                if value["saved"].as_bool() == Some(false) {
                    self.bots.error = Some(
                        tr!("The task stopped, but the Runner could not save the stop.").into(),
                    );
                }
            }
            After::Requests => {
                self.bots.editor = None;
                self.load_bot_requests(cx);
            }
            After::Reviews => {
                self.bots.editor = None;
                self.load_bot_reviews(cx);
            }
        }
    }
}
