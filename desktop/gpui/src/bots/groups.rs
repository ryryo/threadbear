use super::*;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    id: String,
    title: String,
    team_id: String,
    revision: u64,
    member_ids: Vec<String>,
    admin_id: String,
    mode: String,
    ceiling: String,
    archived_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Team {
    id: String,
    title: String,
    member_ids: Vec<String>,
}

#[derive(Deserialize)]
struct Roster {
    groups: Vec<Group>,
    teams: Vec<Team>,
}

#[derive(Deserialize)]
struct Detail {
    group: Group,
    round: Option<Round>,
    frozen: bool,
    queued: u64,
    events: Vec<Row>,
    #[serde(default)]
    tasks: Vec<Task>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    thread_id: String,
    title: String,
    status: String,
}

#[derive(Deserialize)]
struct Round {
    slots: Vec<Slot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Slot {
    call_id: String,
    name: String,
    status: String,
    thread_id: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    seq: u64,
    kind: String,
    member_id: Option<String>,
    text: Option<String>,
    result: Option<Value>,
}

struct Draft {
    operation: String,
    old: Option<Group>,
    title: Entity<TextareaState>,
    team_id: String,
    members: Vec<String>,
    admin: Option<String>,
    mode: String,
    ceiling: String,
}

struct Fields {
    post: Entity<TextareaState>,
    search: Entity<TextareaState>,
}

#[derive(Default)]
pub(super) struct GroupsState {
    pub(super) available: bool,
    pub(super) visible: bool,
    roster: Option<Roster>,
    selected: Option<String>,
    detail: Option<Detail>,
    fields: Option<Fields>,
    draft: Option<Draft>,
    note: Option<(u64, Entity<TextareaState>)>,
    found: Option<Vec<Row>>,
    reply: Option<(u64, String)>,
    pending_post: Option<(String, String, String)>,
    unsent: std::collections::HashMap<String, String>,
    loading: bool,
    dirty: bool,
}

impl Threadbear {
    pub(super) fn group_title(&self, id: &str) -> Option<&str> {
        self.bots
            .groups
            .roster
            .as_ref()?
            .groups
            .iter()
            .find(|group| group.id == id)
            .map(|group| group.title.as_str())
    }

    pub(super) fn open_group_from_thread(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.unfold_threads(cx);
        self.set_mode(SidebarMode::Bots, cx);
        self.select_group(id, window, cx);
        self.open_bot_groups(window, cx);
    }

    pub(super) fn open_bot_groups(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.bots.show_teams = false;
        self.bots.show_schedules = false;
        self.bots.groups.visible = true;
        self.bots.error = None;
        if self.bots.groups.fields.is_none() {
            let post = cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(2, 8)
                    .placeholder("Message the Group")
            });
            let search = cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(1, 2)
                    .placeholder("Search Group history")
            });
            crate::unsent::watch(&post, "a Group message being written", cx);
            self.bots.groups.fields = Some(Fields { post, search });
        }
        self.load_group_roster(cx);
    }

    fn load_group_roster(&mut self, cx: &mut Context<Self>) {
        self.bots.busy = true;
        cx.notify();
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let result = call(client, "bots.groups.list", json!({})).await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match result {
                    Ok(value) => match serde_json::from_value::<Roster>(value) {
                        Ok(roster) => {
                            let groups = &mut this.bots.groups;
                            if !roster
                                .groups
                                .iter()
                                .any(|g| Some(&g.id) == groups.selected.as_ref())
                            {
                                groups.selected = roster.groups.first().map(|g| g.id.clone());
                            }
                            groups.roster = Some(roster);
                            this.refresh_group(cx);
                        }
                        Err(_) => this.bots.error = Some("Could not read the Groups.".into()),
                    },
                    Err(error) => this.bots.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn note_group_thread_update(
        &mut self,
        thread: &ThreadSummary,
        cx: &mut Context<Self>,
    ) {
        let id = thread
            .bot_link
            .as_ref()
            .and_then(|link| link.group_id.as_deref());
        if id.is_some() && id == self.bots.groups.selected.as_deref() {
            self.refresh_group(cx);
        }
    }

    fn refresh_group(&mut self, cx: &mut Context<Self>) {
        let groups = &mut self.bots.groups;
        let Some(id) = groups.selected.clone().filter(|_| groups.visible) else {
            return;
        };
        if groups.loading || self.bots.busy {
            groups.dirty = true;
            return;
        }
        groups.loading = true;
        groups.dirty = false;
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let result = call(client, "bots.groups.read", json!({ "groupId": id })).await;
            this.update(cx, |this, cx| {
                let groups = &mut this.bots.groups;
                groups.loading = false;
                if groups.selected.as_ref() == Some(&id) {
                    match result {
                        Ok(value) => match serde_json::from_value::<Detail>(value) {
                            Ok(detail) => groups.detail = Some(detail),
                            Err(_) => this.bots.error = Some("Could not read this Group.".into()),
                        },
                        Err(error) => this.bots.error = Some(error.message),
                    }
                }
                if groups.dirty {
                    this.refresh_group(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn select_group(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let groups = &mut self.bots.groups;
        if groups.selected.as_ref() == Some(&id) {
            return;
        }
        if let Some(fields) = &groups.fields {
            if let Some(previous) = &groups.selected {
                groups
                    .unsent
                    .insert(previous.clone(), fields.post.read(cx).value().to_string());
            }
            let next = groups.unsent.remove(&id).unwrap_or_default();
            fields
                .post
                .update(cx, |state, cx| state.set_value(next, window, cx));
        }
        groups.selected = Some(id);
        groups.detail = None;
        groups.found = None;
        groups.reply = None;
        groups.note = None;
        self.refresh_group(cx);
        cx.notify();
    }

    fn edit_group(&mut self, old: Option<Group>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(team) = self
            .bots
            .groups
            .roster
            .as_ref()
            .and_then(|r| r.teams.first())
        else {
            return;
        };
        let title = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 2)
                .placeholder("Group name")
                .default_value(old.as_ref().map(|g| g.title.clone()).unwrap_or_default())
        });
        crate::unsent::watch(&title, "a Group being edited", cx);
        title.update(cx, |field, cx| field.focus(window, cx));
        crate::web_panels::keyboard_to_app(window);
        self.bots.operation += 1;
        self.bots.groups.draft = Some(Draft {
            operation: format!("gpui-group-{}-{}", now_ms(), self.bots.operation),
            team_id: old
                .as_ref()
                .map(|g| g.team_id.clone())
                .unwrap_or_else(|| team.id.clone()),
            members: old
                .as_ref()
                .map(|g| g.member_ids.clone())
                .unwrap_or_default(),
            admin: old.as_ref().map(|g| g.admin_id.clone()),
            mode: old
                .as_ref()
                .map(|g| g.mode.clone())
                .unwrap_or_else(|| "admin".into()),
            ceiling: old
                .as_ref()
                .map(|g| g.ceiling.clone())
                .unwrap_or_else(|| "ask".into()),
            old,
            title,
        });
        cx.notify();
    }

    fn save_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = &self.bots.groups.draft else {
            return;
        };
        let changes = json!({
            "title": draft.title.read(cx).value().trim(), "memberIds": draft.members,
            "adminId": draft.admin, "mode": draft.mode, "ceiling": draft.ceiling,
        });
        if let Some(old) = &draft.old {
            self.group_action(
                "bots.groups.update",
                json!({ "groupId": old.id, "expectedRevision": old.revision, "changes": changes }),
                window,
                cx,
            );
        } else {
            let mut params = changes;
            params["teamId"] = json!(draft.team_id);
            params["operationId"] = json!(draft.operation);
            self.group_action("bots.groups.create", params, window, cx);
        }
    }

    fn group_action(
        &mut self,
        method: &'static str,
        params: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.bots.busy {
            return;
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
                        if let Some(id) = value["group"]["id"].as_str() {
                            this.select_group(id.to_owned(), window, cx);
                        }
                        this.bots.groups.draft = None;
                        this.bots.groups.note = None;
                        this.load_group_roster(cx);
                    }
                    Err(error) => {
                        this.bots.error = Some(error.message);
                        this.refresh_group(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn review_group_note(
        &mut self,
        seq: u64,
        before: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(2, 5)
                .placeholder("Group note")
                .default_value(before)
        });
        crate::unsent::watch(&field, "a Group note being reviewed", cx);
        field.update(cx, |state, cx| state.focus(window, cx));
        crate::web_panels::keyboard_to_app(window);
        self.bots.groups.note = Some((seq, field));
        cx.notify();
    }

    fn save_group_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.bots.groups.selected.clone() else {
            return;
        };
        let Some((seq, field)) = &self.bots.groups.note else {
            return;
        };
        let text = field.read(cx).value().trim().to_owned();
        if text.is_empty() {
            return;
        }
        self.group_action("bots.groups.memory.approve", json!({
            "groupId": id, "seq": seq, "text": text, "operationId": format!("group-note-{id}-{seq}"),
        }), window, cx);
    }

    fn query_group(&mut self, method: &'static str, number: Option<u64>, cx: &mut Context<Self>) {
        if self.bots.busy {
            return;
        }
        let groups = &self.bots.groups;
        let Some(id) = groups.selected.clone() else {
            return;
        };
        let mut params = json!({ "groupId": id });
        if let Some(seq) = number {
            params["seq"] = json!(seq);
        } else if let Some(fields) = &groups.fields {
            let query = fields.search.read(cx).value().trim().to_owned();
            if query.is_empty() {
                self.bots.groups.found = None;
                cx.notify();
                return;
            }
            params["query"] = json!(query);
        }
        self.bots.busy = true;
        self.bots.error = None;
        cx.notify();
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let result = call(client, method, params).await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                if this.bots.groups.selected.as_ref() == Some(&id) {
                    match result {
                        Ok(value) => {
                            if let Some(seq) = number {
                                if let Some(text) = value["text"].as_str() {
                                    this.bots.groups.reply = Some((seq, text.to_owned()));
                                }
                            } else {
                                this.bots.groups.found =
                                    serde_json::from_value(value["events"].clone()).ok();
                            }
                        }
                        Err(error) => this.bots.error = Some(error.message),
                    }
                }
                if this.bots.groups.dirty {
                    this.refresh_group(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn post_to_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.bots.busy {
            return;
        }
        let groups = &mut self.bots.groups;
        let Some(id) = groups.selected.clone() else {
            return;
        };
        let Some(field) = groups.fields.as_ref().map(|f| f.post.clone()) else {
            return;
        };
        let text = field.read(cx).value().trim().to_owned();
        if text.is_empty() {
            return;
        }
        self.bots.operation += 1;
        let operation = groups
            .pending_post
            .as_ref()
            .filter(|(group, body, _)| group == &id && body == &text)
            .map(|(_, _, operation)| operation.clone())
            .unwrap_or_else(|| format!("gpui-group-{}-{}", now_ms(), self.bots.operation));
        groups.pending_post = Some((id.clone(), text.clone(), operation.clone()));
        self.bots.busy = true;
        self.bots.error = None;
        let client = self.client.clone();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = call(
                client,
                "bots.groups.post",
                json!({ "groupId": id, "text": text, "operationId": operation }),
            )
            .await;
            this.update_in(cx, |this, window, cx| {
                this.bots.busy = false;
                match result {
                    Ok(_) => {
                        this.bots.groups.pending_post = None;
                        if field.read(cx).value().trim() == text {
                            field.update(cx, |state, cx| state.set_value("", window, cx));
                        }
                    }
                    Err(error) => this.bots.error = Some(error.message),
                }
                this.refresh_group(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn render_bot_groups(&self, cx: &mut Context<Self>) -> AnyElement {
        let groups = &self.bots.groups;
        let disabled = self.bots.busy || groups.draft.is_some() || groups.note.is_some();
        let mut tabs = h_flex().gap(px(6.)).flex_wrap().child(
            bot_button("bots-new-group", "New group", disabled)
                .primary()
                .on_click(cx.listener(|this, _, window, cx| this.edit_group(None, window, cx))),
        );
        if let Some(roster) = &groups.roster {
            for group in &roster.groups {
                let id = group.id.clone();
                let title = if group.archived_at.is_some() {
                    format!("{} · Archived", group.title)
                } else {
                    group.title.clone()
                };
                tabs = tabs.child(
                    bot_button(
                        SharedString::from(format!("bots-group-{id}")),
                        title,
                        disabled,
                    )
                    .when(groups.selected.as_ref() == Some(&id), |button| {
                        button.primary()
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.select_group(id.clone(), window, cx);
                    })),
                );
            }
        }
        let mut page = v_flex().gap(px(14.)).max_w(px(760.)).child(tabs);
        if let Some(draft) = &groups.draft {
            page = page.child(self.render_group_draft(draft, cx));
        } else if let Some((_, field)) = &groups.note {
            page = page
                .child("Review Group note")
                .child(Textarea::new(field))
                .child(
                    h_flex()
                        .gap(px(6.))
                        .child(
                            bot_button("group-note-approve", "Approve note", self.bots.busy)
                                .primary()
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.save_group_note(window, cx)
                                })),
                        )
                        .child(
                            bot_button("group-note-discard", "Discard draft", self.bots.busy)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.bots.groups.note = None;
                                    cx.notify();
                                })),
                        ),
                );
        } else if let Some(detail) = &groups.detail {
            page = page.child(self.render_group_detail(detail, cx));
        }
        page.into_any_element()
    }

    fn render_group_draft(&self, draft: &Draft, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.bots.busy;
        let mut page = v_flex().gap(px(8.)).child(Textarea::new(&draft.title));
        if let Some(roster) = &self.bots.groups.roster {
            let mut teams = h_flex().gap(px(6.)).flex_wrap();
            for team in &roster.teams {
                let id = team.id.clone();
                teams = teams.child(
                    bot_button(
                        SharedString::from(format!("group-team-{id}")),
                        team.title.clone(),
                        busy || draft.old.is_some(),
                    )
                    .when(draft.team_id == id, |button| button.primary())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(draft) = &mut this.bots.groups.draft {
                            draft.team_id = id.clone();
                            draft.members.clear();
                            draft.admin = None;
                        }
                        cx.notify();
                    })),
                );
            }
            page = page.child(teams);
            if let Some(team) = roster.teams.iter().find(|team| team.id == draft.team_id) {
                for bot in self.bots.list.iter().filter(|bot| {
                    team.member_ids.contains(&bot.id)
                        && bot.privacy.is_none()
                        && bot.archived_at.is_none()
                }) {
                    page = page.child(self.render_group_member(draft, bot, cx));
                }
            }
        }
        for choices in [
            [
                ("admin", "Notify only admin"),
                ("everyone", "Notify everyone in order"),
            ]
            .as_slice(),
            [
                ("ask", "Ask before edits"),
                ("auto", "Auto"),
                ("full", "Full access"),
            ]
            .as_slice(),
        ] {
            let mut row = h_flex().gap(px(6.)).flex_wrap();
            for &(mode, name) in choices {
                row = row.child(
                    bot_button(
                        SharedString::from(format!("group-choice-{mode}")),
                        name,
                        busy,
                    )
                    .when(mode == draft.mode || mode == draft.ceiling, |button| {
                        button.primary()
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(draft) = &mut this.bots.groups.draft {
                            if mode == "admin" || mode == "everyone" {
                                draft.mode = mode.into();
                            } else {
                                draft.ceiling = mode.into();
                            }
                        }
                        cx.notify();
                    })),
                );
            }
            page = page.child(row);
        }
        page.child(
            h_flex()
                .gap(px(6.))
                .child(
                    bot_button("group-save", "Save group", busy || draft.admin.is_none())
                        .primary()
                        .on_click(cx.listener(|this, _, window, cx| this.save_group(window, cx))),
                )
                .child(
                    bot_button("group-cancel", "Cancel", busy).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.bots.groups.draft = None;
                            cx.notify();
                        },
                    )),
                ),
        )
        .into_any_element()
    }

    fn render_group_member(
        &self,
        draft: &Draft,
        bot: &Profile,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = bot.id.clone();
        let admin = id.clone();
        let present = draft.members.contains(&id);
        let is_admin = draft.admin.as_ref() == Some(&id);
        let busy = self.bots.busy;
        h_flex()
            .gap(px(6.))
            .flex_wrap()
            .child(div().min_w(px(112.)).child(bot.name.clone()))
            .child(
                bot_button(
                    SharedString::from(format!("group-member-{id}")),
                    format!("{} {}", if present { "Remove" } else { "Add" }, bot.name),
                    busy || (!present && draft.members.len() == 12),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(draft) = &mut this.bots.groups.draft {
                        if present {
                            draft.members.retain(|member| member != &id);
                            if draft.admin.as_ref() == Some(&id) {
                                draft.admin = draft.members.first().cloned();
                            }
                        } else {
                            draft.members.push(id.clone());
                            if draft.admin.is_none() {
                                draft.admin = Some(id.clone());
                            }
                        }
                    }
                    cx.notify();
                })),
            )
            .when(present, |row| {
                row.child(
                    bot_button(
                        SharedString::from(format!("group-admin-{admin}")),
                        if is_admin { "Admin" } else { "Make admin" },
                        busy || is_admin,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(draft) = &mut this.bots.groups.draft {
                            draft.admin = Some(admin.clone());
                        }
                        cx.notify();
                    })),
                )
            })
            .into_any_element()
    }

    fn render_group_detail(&self, detail: &Detail, cx: &mut Context<Self>) -> AnyElement {
        let group = &detail.group;
        let busy = self.bots.busy;
        let mut page = v_flex().gap(px(10.)).child(
            div()
                .text_size(px(24.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(group.title.clone()),
        );
        if group.archived_at.is_none() {
            let previous = group.clone();
            let pause = if detail.frozen {
                "bots.groups.resume"
            } else {
                "bots.groups.stop"
            };
            let params = json!({ "groupId": group.id });
            let scheduled = json!({"kind": "group", "groupId": group.id });
            let schedule_title = group.title.clone();
            let archive = json!({ "groupId": group.id, "expectedRevision": group.revision });
            page = page.child(
                h_flex()
                    .gap(px(6.))
                    .flex_wrap()
                    .child(
                        bot_button("group-settings", "Group settings", busy).on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.edit_group(Some(previous.clone()), window, cx)
                            },
                        )),
                    )
                    .child(
                        bot_button(
                            "group-stop-resume",
                            if detail.frozen { "Resume" } else { "Stop work" },
                            busy,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.group_action(pause, params.clone(), window, cx)
                            },
                        )),
                    )
                    .when(self.bots.schedules_available, |row| {
                        row.child(
                            bot_button("group-schedule", "Schedule a Group post", busy).on_click(
                                cx.listener(move |this, _, window, cx| {
                                    this.edit_bot_schedule(
                                        scheduled.clone(),
                                        schedule_title.clone(),
                                        None,
                                        window,
                                        cx,
                                    )
                                }),
                            ),
                        )
                    })
                    .child(bot_button("group-archive", "Archive group", busy).on_click(
                        cx.listener(move |this, _, window, cx| {
                            this.group_action("bots.groups.archive", archive.clone(), window, cx)
                        }),
                    )),
            );
        }
        if detail.queued != 0 {
            page = page.child(
                div()
                    .text_color(style::secondary_text(cx))
                    .child(format!("Queued messages: {}", detail.queued)),
            );
        }
        if let Some(round) = &detail.round {
            for slot in &round.slots {
                let summary = slot.thread_id.as_ref().and_then(|id| self.threads.get(id));
                let status = match slot.status.as_str() {
                    "speaking" if summary.is_some_and(|t| t.needs_you) => "Waiting for you",
                    "speaking" => "Working",
                    "waiting" => "Queued",
                    "done" => "Finished",
                    "failed" => "Failed",
                    _ => "Stopped",
                };
                let mut row = h_flex()
                    .gap(px(8.))
                    .child(format!("{} · {status}", slot.name));
                if let Some(id) = &slot.thread_id {
                    let thread = id.clone();
                    row = row.child(
                        bot_button(
                            SharedString::from(format!("group-call-{}", slot.call_id)),
                            "Open thread",
                            summary.is_none(),
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.open_thread_from_page(thread.clone(), window, cx)
                            },
                        )),
                    );
                }
                page = page.child(row);
            }
        }
        for task in &detail.tasks {
            let thread = task.thread_id.clone();
            let enabled = self.threads.contains_key(&thread);
            let status = match task.status.as_str() {
                "reserved" | "queued" => "Queued",
                "running" | "waiting_work" => "Working",
                "completed" => "Finished",
                "failed" => "Failed",
                _ => "Stopped",
            };
            page = page.child(
                h_flex()
                    .gap(px(8.))
                    .child(format!("{} · {status}", task.title))
                    .child(
                        bot_button(
                            SharedString::from(format!("group-task-{}", task.id)),
                            "Open background task",
                            !enabled,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.open_thread_from_page(thread.clone(), window, cx)
                            },
                        )),
                    ),
            );
        }
        if let Some(fields) = &self.bots.groups.fields {
            if group.archived_at.is_none() {
                page = page
                    .child(
                        div()
                            .id("group-message-field")
                            .test_support()
                            .aria_label("Group message")
                            .a11y_role(gpui_kit::Role::GenericContainer)
                            .tip("Group message")
                            .child(Textarea::new(&fields.post)),
                    )
                    .child(
                        bot_button("group-post", "Post to group", busy)
                            .primary()
                            .on_click(
                                cx.listener(|this, _, window, cx| this.post_to_group(window, cx)),
                            ),
                    );
            }
            page = page.child(
                h_flex()
                    .gap(px(6.))
                    .child(Textarea::new(&fields.search))
                    .child(
                        bot_button("group-find", "Search history", busy).on_click(cx.listener(
                            |this, _, _, cx| this.query_group("bots.groups.find", None, cx),
                        )),
                    ),
            );
        }
        page.child(self.render_group_rows(detail, cx))
            .into_any_element()
    }

    fn render_group_rows(&self, detail: &Detail, cx: &mut Context<Self>) -> AnyElement {
        let group = &detail.group;
        let busy = self.bots.busy;
        let mut page = v_flex().gap(px(10.));
        let rows = self.bots.groups.found.as_ref().unwrap_or(&detail.events);
        for row in rows {
            if let Some(text) = &row.text {
                let author = row
                    .member_id
                    .as_deref()
                    .and_then(|id| self.bots.list.iter().find(|bot| bot.id == id))
                    .map_or(if row.kind == "post" { "You" } else { "Group" }, |bot| {
                        bot.name.as_str()
                    });
                let seq = row.seq;
                let expanded = self
                    .bots
                    .groups
                    .reply
                    .as_ref()
                    .filter(|(opened, _)| *opened == seq);
                let note: String = text.chars().take(250).collect();
                let reply = row.result.is_some();
                page = page.child(
                    v_flex()
                        .gap(px(3.))
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(author.to_owned()),
                        )
                        .when(reply && expanded.is_none(), |line| {
                            line.child(
                                bot_button(
                                    SharedString::from(format!("group-result-{seq}")),
                                    "Open full result",
                                    busy,
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.query_group("bots.groups.result", Some(seq), cx)
                                    },
                                )),
                            )
                        })
                        .when(reply && group.archived_at.is_none(), |line| {
                            line.child(
                                bot_button(
                                    SharedString::from(format!("group-note-{seq}")),
                                    "Review as note",
                                    busy,
                                )
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.review_group_note(seq, note.clone(), window, cx)
                                    },
                                )),
                            )
                        })
                        .child(expanded.map_or_else(|| text.clone(), |(_, full)| full.clone())),
                );
            }
        }
        page.into_any_element()
    }
}
