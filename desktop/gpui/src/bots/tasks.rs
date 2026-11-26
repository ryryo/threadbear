use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskCard {
    id: String,
    title: String,
    thread_id: String,
    source_thread_id: String,
    revision: u64,
    state: TaskStatus,
}

#[derive(Deserialize)]
struct TaskStatus {
    status: String,
    outcome: Option<TaskOutcome>,
}

#[derive(Deserialize)]
struct TaskOutcome {
    summary: String,
}

impl TaskStatus {
    fn label(&self) -> &'static str {
        match self.status.as_str() {
            "reserved" => "Starting",
            "queued" => "Queued",
            "running" => "Running",
            "waiting_work" => "Waiting for replies",
            "completed" => "Completed",
            "failed" => "Failed",
            "interrupted" => "Interrupted",
            "stopped" => "Stopped",
            _ => "Status unavailable",
        }
    }
}

fn task_origin(thread: &ThreadSummary) -> Option<&str> {
    let start = thread.started_by.as_ref()?;
    (start["kind"].as_str() == Some("thread"))
        .then(|| start["threadId"].as_str())
        .flatten()
}

impl Threadbear {
    pub(super) fn render_task_thread_action(
        &self,
        thread: &ThreadSummary,
        link: &threadbear_core::inbox::BotLink,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.bots.tasks_available {
            return None;
        }
        if link.task_id.is_some() {
            let source = task_origin(thread)?.to_owned();
            return Some(
                bot_button(
                    "thread-task-source",
                    "Original conversation",
                    !self.threads.contains_key(&source),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_thread_from_page(source.clone(), window, cx)
                }))
                .into_any_element(),
            );
        }
        let active = self
            .threads
            .values()
            .filter(|other| {
                other.bot_link.as_ref().is_some_and(|other_link| {
                    other_link.task_id.is_some() && other_link.bot_id == link.bot_id
                }) && task_origin(other) == Some(thread.id.as_str())
                    && matches!(other.status.as_str(), "starting" | "running" | "waiting")
            })
            .count();
        let label = match active {
            0 => "Background tasks".to_string(),
            1 => "1 active background task".to_string(),
            _ => format!("{active} active background tasks"),
        };
        let bot = link.bot_id.clone();
        let thread = thread.id.clone();
        Some(
            bot_button("thread-background-tasks", label, self.bots.busy)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_bot_from_thread(bot.clone(), thread.clone(), cx);
                    this.bots.tab = Tab::Tasks;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    pub(super) fn load_bot_tasks(&mut self, append: bool, cx: &mut Context<Self>) {
        let Some(bot_id) = self.bots.selected.clone() else {
            return;
        };
        let before = if append {
            self.bots.task_more.clone()
        } else {
            None
        };
        if !append {
            self.bots.tasks.clear();
            self.bots.task_result = None;
        }
        let client = self.client.clone();
        self.bots.busy = true;
        self.bots.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let mut params = json!({ "botId": bot_id });
            if let Some(cursor) = before {
                params["before"] = json!(cursor);
            }
            let reply = call(client, "bots.tasks.list", params).await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match reply {
                    Ok(value) => {
                        match serde_json::from_value::<Vec<TaskCard>>(value["rows"].clone()) {
                            Ok(rows) => {
                                this.bots.tasks.extend(rows);
                                this.bots.task_more = value["more"].as_str().map(str::to_owned);
                            }
                            Err(_) => {
                                this.bots.error = Some("Could not read this Bot’s tasks.".into())
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

    fn load_task_result(&mut self, id: String, cx: &mut Context<Self>) {
        if self.bots.busy {
            return;
        }
        self.bots.busy = true;
        self.bots.error = None;
        cx.notify();
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let reply = call(client, "bots.tasks.read", json!({ "taskId": id })).await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                match reply {
                    Ok(value) => {
                        match serde_json::from_value::<RequestResult>(value["result"].clone()) {
                            Ok(result) => this.bots.task_result = Some((id, result)),
                            Err(_) => {
                                this.bots.error = Some("This task has no saved answer.".into())
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

    pub(super) fn render_bot_tasks(&self, details: &Details, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.bots.busy;
        let mut page = v_flex().gap(px(12.)).max_w(px(680.));
        if details.conversations.is_empty() {
            return page
                .child("Start a conversation before starting a background task.")
                .into_any_element();
        }
        page = page
            .child(
                h_flex().gap(px(6.)).flex_wrap().children(
                    details
                        .conversations
                        .iter()
                        .enumerate()
                        .map(|(index, row)| {
                            let source = row.thread_id.clone();
                            let chosen = self.bots.source.as_ref() == Some(&source);
                            let title =
                                self.bot_conversation_title(index, &source, &details.bot.name);
                            bot_button(
                                SharedString::from(format!("bot-task-source-{source}")),
                                title,
                                busy,
                            )
                            .when(chosen, |button| button.primary())
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.bots.source = Some(source.clone());
                                    cx.notify();
                                },
                            ))
                        }),
                ),
            )
            .child(
                h_flex()
                    .gap(px(8.))
                    .child(
                        bot_button(
                            "bot-start-task",
                            "New background task",
                            busy || details.bot.archived_at.is_some(),
                        )
                        .primary()
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.edit_bot(Edit::TaskStart, String::new(), window, cx)
                        })),
                    )
                    .child(
                        bot_button("bot-refresh-tasks", "Refresh tasks", busy)
                            .loading(busy)
                            .on_click(cx.listener(|this, _, _, cx| this.load_bot_tasks(false, cx))),
                    ),
            );
        if self.bots.tasks.is_empty() && !busy {
            page = page.child("No background tasks yet.");
        }
        for task in &self.bots.tasks {
            page = page.child(self.render_background_bot_task_card(task, cx));
        }
        if self.bots.task_more.is_some() {
            page = page.child(
                bot_button("bot-more-tasks", "Older tasks", busy)
                    .on_click(cx.listener(|this, _, _, cx| this.load_bot_tasks(true, cx))),
            );
        }
        page.into_any_element()
    }

    fn render_background_bot_task_card(
        &self,
        task: &TaskCard,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = &task.id;
        let busy = self.bots.busy;
        let task_thread = task.thread_id.clone();
        let origin = task.source_thread_id.clone();
        let mut controls = h_flex()
            .gap(px(7.))
            .flex_wrap()
            .child(
                bot_button(
                    SharedString::from(format!("bot-task-open-{id}")),
                    "Open task",
                    busy || !self.threads.contains_key(&task_thread),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_thread_from_page(task_thread.clone(), window, cx)
                })),
            )
            .child(
                bot_button(
                    SharedString::from(format!("bot-task-origin-{id}")),
                    "Open original conversation",
                    busy || !self.threads.contains_key(&origin),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_thread_from_page(origin.clone(), window, cx)
                })),
            );
        let mut row = v_flex()
            .gap(px(7.))
            .p(px(10.))
            .rounded(px(8.))
            .bg(style::primary_opacity(cx, 0.04))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(task.title.clone()),
            )
            .child(
                div()
                    .text_color(style::secondary_text(cx))
                    .child(task.state.label()),
            );
        if let Some(outcome) = &task.state.outcome {
            if !outcome.summary.is_empty() {
                row = row.child(outcome.summary.clone());
            }
            let result_id = id.clone();
            controls = controls.child(
                bot_button(
                    SharedString::from(format!("bot-task-result-{id}")),
                    "Read task result",
                    busy,
                )
                .on_click(
                    cx.listener(move |this, _, _, cx| this.load_task_result(result_id.clone(), cx)),
                ),
            );
            let retry_id = id.clone();
            let revision = task.revision;
            controls = controls.child(
                bot_button(
                    SharedString::from(format!("bot-task-retry-{id}")),
                    "Start another task run",
                    busy,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_bot(
                        Edit::TaskRetry(retry_id.clone(), revision),
                        String::new(),
                        window,
                        cx,
                    )
                })),
            );
        } else {
            let to = id.clone();
            let stop = json!({ "taskId": id, "expectedRevision": task.revision });
            controls = controls
                .child(
                    bot_button(
                        SharedString::from(format!("bot-task-send-{id}")),
                        "Send instruction",
                        busy,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_bot(Edit::TaskWrite(to.clone()), String::new(), window, cx)
                    })),
                )
                .child(
                    bot_button(
                        SharedString::from(format!("bot-task-stop-{id}")),
                        "Stop task",
                        busy,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.bot_write("bots.tasks.cancel", stop.clone(), After::Tasks, window, cx)
                    })),
                );
        }
        row = row.child(controls);
        if let Some((_, result)) = self
            .bots
            .task_result
            .as_ref()
            .filter(|(selected, _)| selected == id)
        {
            row = row.child(
                div()
                    .id("bot-task-full-result")
                    .test_support()
                    .a11y_role(gpui_kit::Role::GenericContainer)
                    .aria_label(result.text.clone())
                    .child(result.text.clone()),
            );
            if !result.whole {
                row = row.child("The full result is unavailable.");
            }
        }
        row.into_any_element()
    }
}
