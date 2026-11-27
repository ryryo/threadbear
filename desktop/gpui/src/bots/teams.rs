use super::*;
use std::collections::HashMap;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TeamCard {
    id: String,
    title: String,
    revision: u64,
    member_ids: Vec<String>,
    chief_ids: Vec<String>,
    chief_enabled: bool,
    grant_by_chief: HashMap<String, Value>,
    audit: Vec<TeamChange>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamChange {
    at: String,
    kind: String,
    bot_id: Option<String>,
    reason: Option<String>,
}

impl Threadbear {
    pub(super) fn open_bot_teams(&mut self, cx: &mut Context<Self>) {
        if self.bots.busy || self.bots.editor.is_some() {
            return;
        }
        self.bots.show_teams = true;
        self.load_bot_teams(cx);
    }

    pub(super) fn load_bot_teams(&mut self, cx: &mut Context<Self>) {
        self.bots.busy = true;
        self.bots.error = None;
        cx.notify();
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let reply = call(client, "bots.teams.list", json!({})).await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match reply {
                    Ok(value) => {
                        match serde_json::from_value::<Vec<TeamCard>>(value["teams"].clone()) {
                            Ok(teams) => {
                                if !teams
                                    .iter()
                                    .any(|team| Some(&team.id) == this.bots.selected_team.as_ref())
                                {
                                    this.bots.selected_team =
                                        teams.first().map(|team| team.id.clone());
                                }
                                this.bots.teams = teams;
                            }
                            Err(_) => {
                                this.bots.error = Some("Could not read the Bot teams.".into())
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

    pub(super) fn render_bot_permission_limit(
        &self,
        bot: &Profile,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut options = h_flex().gap(px(6.)).flex_wrap();
        for (mode, label) in [
            ("ask", "Limit to Ask before edits"),
            ("auto", "Limit to Auto"),
            ("full", "Allow Full access"),
        ] {
            let params =
                json!({ "botId": bot.id, "expectedRevision": bot.revision, "ceiling": mode });
            options = options.child(
                bot_button(
                    SharedString::from(format!("bot-permission-{mode}")),
                    label,
                    disabled,
                )
                .when(bot.permission_ceiling.as_deref() == Some(mode), |button| {
                    button.primary()
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.bot_write(
                        "bots.settings.permissionCeiling",
                        params.clone(),
                        After::Profile,
                        window,
                        cx,
                    )
                })),
            );
        }
        v_flex()
            .gap(px(5.))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Permission limit"),
            )
            .child(options)
            .into_any_element()
    }

    pub(super) fn render_bot_teams(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut page = v_flex().gap(px(12.)).max_w(px(720.)).child(
            div()
                .text_size(px(24.))
                .font_weight(FontWeight::SEMIBOLD)
                .child("Bot teams"),
        );
        let disabled = self.bots.busy || self.bots.editor.is_some();
        let mut tabs = h_flex().gap(px(6.)).flex_wrap().child(
            bot_button("bots-new-team", "New team", disabled)
                .primary()
                .on_click(cx.listener(|this, _, window, cx| {
                    this.edit_bot(Edit::NewTeam, String::new(), window, cx)
                })),
        );
        for team in &self.bots.teams {
            let id = team.id.clone();
            tabs = tabs.child(
                bot_button(
                    SharedString::from(format!("bot-team-{id}")),
                    team.title.clone(),
                    disabled,
                )
                .when(self.bots.selected_team.as_ref() == Some(&id), |button| {
                    button.primary()
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bots.selected_team = Some(id.clone());
                    cx.notify();
                })),
            );
        }
        page = page.child(tabs);
        if let Some(editor) = &self.bots.editor {
            return page
                .child(self.render_bot_editor(editor, cx))
                .into_any_element();
        }
        if let Some(team) = self
            .bots
            .teams
            .iter()
            .find(|team| Some(&team.id) == self.bots.selected_team.as_ref())
        {
            page = page.child(self.render_bot_team(team, cx));
        } else if !self.bots.busy {
            page = page.child(
                "Create a team to appoint a Chief and grant specific management permissions.",
            );
        }
        page.into_any_element()
    }

    fn render_bot_team(&self, team: &TeamCard, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.bots.busy;
        let id = team.id.clone();
        let revision = team.revision;
        let current = team.title.clone();
        let mut actions = h_flex().gap(px(6.)).flex_wrap().child(
            bot_button("bot-team-rename", "Rename team", busy).on_click(cx.listener(
                move |this, _, window, cx| {
                    this.edit_bot(
                        Edit::RenameTeam(id.clone(), revision),
                        current.clone(),
                        window,
                        cx,
                    )
                },
            )),
        );
        if !team.chief_ids.is_empty() {
            actions = actions.child(self.team_action("bot-chief-enable", if team.chief_enabled { "Turn off Chief tools" } else { "Turn on Chief tools" }, "bots.teams.update",
                json!({ "teamId": team.id, "expectedRevision": team.revision, "chiefEnabled": !team.chief_enabled }), cx));
        }
        let mut page = v_flex().gap(px(10.)).child(actions);
        for bot in &self.bots.list {
            if bot.archived_at.is_some() {
                continue;
            }
            let member = team.member_ids.contains(&bot.id);
            let listed_elsewhere = self
                .bots
                .teams
                .iter()
                .any(|other| other.id != team.id && other.member_ids.contains(&bot.id));
            if listed_elsewhere {
                continue;
            }
            let chief = team.chief_ids.contains(&bot.id);
            let members: Vec<_> = if member {
                team.member_ids
                    .iter()
                    .filter(|id| *id != &bot.id)
                    .cloned()
                    .collect()
            } else {
                team.member_ids
                    .iter()
                    .cloned()
                    .chain(std::iter::once(bot.id.clone()))
                    .collect()
            };
            let mut row = h_flex()
                .gap(px(6.))
                .flex_wrap()
                .child(div().min_w(px(120.)).child(bot.name.clone()));
            if !chief {
                row = row.child(self.team_action(SharedString::from(format!("bot-team-member-{}", bot.id)),
                    format!("{} {}", if member { "Remove" } else { "Add" }, bot.name), "bots.teams.update",
                    json!({ "teamId": team.id, "expectedRevision": team.revision, "memberIds": members }), cx));
            }
            if member && bot.privacy.is_none() {
                row = row.children(self.render_chief_tools(team, bot, cx));
            }
            page = page.child(row);
        }
        page.child(self.render_team_history(team, cx))
            .into_any_element()
    }

    fn render_chief_tools(
        &self,
        team: &TeamCard,
        bot: &Profile,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let chief = team.chief_ids.contains(&bot.id);
        let mut actions = h_flex().gap(px(6.));
        if chief {
            if team.chief_ids.len() > 1 {
                actions = actions.child(self.team_action(SharedString::from(format!("remove-chief-{}", bot.id)), format!("Remove {} as Chief", bot.name),
                    "bots.teams.setChief", json!({ "teamId": team.id, "expectedRevision": team.revision, "botId": bot.id, "main": false }), cx));
            }
            let edit = Edit::GrantChief(team.id.clone(), team.revision, bot.id.clone());
            let grant = team.grant_by_chief.get(&bot.id).map_or_else(
                || "{}".to_string(),
                |value| serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into()),
            );
            return Some(
                actions
                    .child(div().child("Chief"))
                    .child(
                        bot_button(
                            SharedString::from(format!("bot-chief-grants-{}", bot.id)),
                            format!("Edit grants for {}", bot.name),
                            self.bots.busy,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.edit_bot(edit.clone(), grant.clone(), window, cx)
                            },
                        )),
                    )
                    .into_any_element(),
            );
        }
        let label = if team.chief_ids.is_empty() {
            format!("Make {} Chief", bot.name)
        } else {
            format!("Replace Chief with {}", bot.name)
        };
        let mut params = json!({ "teamId": team.id, "expectedRevision": team.revision, "botId": bot.id, "main": true });
        if let Some(old) = team.chief_ids.first() {
            params["replace"] = json!(old);
            actions = actions.child(self.team_action(SharedString::from(format!("add-chief-{}", bot.id)), format!("Add {} as Chief", bot.name),
                "bots.teams.setChief", json!({ "teamId": team.id, "expectedRevision": team.revision, "botId": bot.id, "main": true }), cx));
        }
        Some(
            actions
                .child(self.team_action(
                    SharedString::from(format!("bot-make-chief-{}", bot.id)),
                    label,
                    "bots.teams.setChief",
                    params,
                    cx,
                ))
                .into_any_element(),
        )
    }

    fn team_action(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        method: &'static str,
        params: Value,
        cx: &mut Context<Self>,
    ) -> Button {
        bot_button(id, label, self.bots.busy).on_click(cx.listener(move |this, _, window, cx| {
            this.bot_write(method, params.clone(), After::Teams, window, cx);
        }))
    }

    fn render_team_history(&self, team: &TeamCard, cx: &App) -> AnyElement {
        let mut history = v_flex()
            .gap(px(4.))
            .child(div().font_weight(FontWeight::SEMIBOLD).child("Changes"));
        for event in team.audit.iter().rev() {
            let who = event
                .bot_id
                .as_ref()
                .and_then(|id| self.bots.list.iter().find(|bot| &bot.id == id))
                .map(|bot| bot.name.as_str());
            let title = match event.kind.as_str() {
                "created" => "Created team",
                "membership" => "Updated team settings",
                "chief" => "Changed Chief role",
                "grants" => "Changed management grants",
                "bot-created" => "Created Bot",
                "bot-updated" => "Updated Bot",
                "bot-stopped" => "Stopped Bot",
                _ => "Updated team",
            };
            let line = format!(
                "{title}{} · {}",
                who.map_or_else(String::new, |name| format!(" for {name}")),
                event.at
            );
            history = history.child(div().text_color(style::secondary_text(cx)).child(line));
            if let Some(reason) = &event.reason {
                history = history.child(div().child(reason.clone()));
            }
        }
        history.into_any_element()
    }
}
