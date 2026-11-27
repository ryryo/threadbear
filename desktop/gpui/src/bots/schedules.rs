use super::*;

impl Threadbear {
    pub(super) fn open_bot_schedules(&mut self, cx: &mut Context<Self>) {
        self.bots.show_schedules = true;
        self.bots.groups.visible = false;
        self.bots.show_teams = false;
        self.load_bot_schedules(cx);
    }

    pub(crate) fn load_bot_schedules(&mut self, cx: &mut Context<Self>) {
        self.bot_schedule_call("bots.schedules.list", json!({}), cx);
    }

    fn bot_schedule_call(&mut self, method: &'static str, params: Value, cx: &mut Context<Self>) {
        if self.bots.busy {
            return;
        }
        let client = self.client.clone();
        self.bots.busy = true;
        self.bots.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = call(client, method, params).await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match result {
                    Ok(value) if method == "bots.schedules.list" => {
                        this.bots.schedule_rows =
                            value["schedules"].as_array().cloned().unwrap_or_default();
                    }
                    Ok(_) => this.load_bot_schedules(cx),
                    Err(error) => this.bots.error = Some(error.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn scheduled_bot_label(&self, target: &Value) -> String {
        if let Some(id) = target["threadId"].as_str() {
            return self
                .threads
                .get(id)
                .map_or_else(|| "Bot conversation".into(), |thread| thread.title.clone());
        }
        if let Some(id) = target["botId"].as_str() {
            let name = self
                .bots
                .list
                .iter()
                .find(|bot| bot.id == id)
                .map_or("Bot", |bot| bot.name.as_str());
            return format!("New conversation with {name}");
        }
        self.group_title(target["groupId"].as_str().unwrap_or_default())
            .unwrap_or("Bot Group")
            .to_owned()
    }

    pub(super) fn render_bot_schedules(&self, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.bots.busy;
        let mut page = v_flex().gap(px(12.)).max_w(px(720.)).child(
            div()
                .text_size(px(24.))
                .font_weight(FontWeight::SEMIBOLD)
                .child("Bot schedules"),
        );
        for row in &self.bots.schedule_rows {
            let Some(id) = row["id"].as_str() else {
                continue;
            };
            let id = id.to_owned();
            let target = row["botTarget"].clone();
            let title = row["title"]
                .as_str()
                .unwrap_or("Scheduled message")
                .to_owned();
            let label = row["botTargetLabel"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| self.scheduled_bot_label(&target));
            let target_line = label.clone();
            let saved = row.clone();
            let when = if row["paused"] == true {
                "Paused"
            } else {
                row["whenText"].as_str().unwrap_or_default()
            };
            let mut actions = h_flex().gap(px(6.)).flex_wrap().child(
                bot_button(
                    SharedString::from(format!("bot-schedule-edit-{id}")),
                    "Edit schedule",
                    busy,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_bot_schedule(target.clone(), label.clone(), Some(&saved), window, cx)
                })),
            );
            for (name, method, params) in [
                ("Run now", "bots.schedules.run", json!({ "scheduleId": id })),
                (
                    if row["paused"] == true {
                        "Resume schedule"
                    } else {
                        "Pause schedule"
                    },
                    "bots.schedules.update",
                    json!({ "scheduleId": id, "paused": row["paused"] != true, "expectedUpdatedAt": row["updatedAt"] }),
                ),
                (
                    "Delete schedule",
                    "bots.schedules.delete",
                    json!({ "scheduleId": id }),
                ),
            ] {
                actions = actions.child(
                    bot_button(SharedString::from(format!("{method}-{id}")), name, busy).on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.bot_schedule_call(method, params.clone(), cx)
                        }),
                    ),
                );
            }
            page = page.child(
                v_flex()
                    .gap(px(5.))
                    .child(title)
                    .child(target_line)
                    .child(when.to_owned())
                    .children(row["lastRun"]["note"].as_str().map(str::to_owned))
                    .child(actions),
            );
        }
        if self.bots.schedule_rows.is_empty() && !busy {
            page = page.child("Create a schedule from a Bot conversation or Group.");
        }
        page.into_any_element()
    }
}
