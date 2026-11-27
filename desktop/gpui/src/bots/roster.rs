use super::*;
use crate::sidebar::{MenuAction, MenuRow};

#[derive(Default)]
pub(super) struct RosterOperations {
    pub(super) available: bool,
    choosing_thread: bool,
    thread: Option<String>,
}

impl RosterOperations {
    pub(super) fn close_attachment(&mut self) {
        self.choosing_thread = false;
        self.thread = None;
    }
}

impl Threadbear {
    pub(super) fn bot_roster_row(
        &self,
        row: Button,
        bot: &Profile,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !self.bots.roster.available
            || disabled
            || bot.privacy.is_some()
            || bot.archived_at.is_some()
        {
            return row.into_any_element();
        }
        let bot_id = bot.id.clone();
        let revision = bot.revision;
        div()
            .id(SharedString::from(format!("bot-menu-{bot_id}")))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    let rows = vec![MenuRow::item(
                        tr!("Duplicate"),
                        "square.on.square",
                        MenuAction::DuplicateBot(bot_id.clone(), revision),
                    )];
                    this.open_menu(None, rows, ev.position, false, window, cx);
                }),
            )
            .child(row.w_full())
            .into_any_element()
    }

    pub(crate) fn duplicate_bot(
        &mut self,
        bot_id: String,
        revision: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.bot_write(
            "bots.duplicate",
            json!({ "botId": bot_id, "expectedRevision": revision }),
            After::Profile,
            window,
            cx,
        );
    }

    pub(super) fn render_attachment(&self, bot: &Profile, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.bots.roster;
        let busy = self.bots.busy;
        if !state.choosing_thread {
            return bot_button("bot-attach-open", tr!("Attach existing Thread"), busy)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.bots.roster.choosing_thread = true;
                    cx.notify();
                }))
                .into_any_element();
        }

        let choice = state.thread.as_ref().and_then(|id| self.threads.get(id));
        let mut panel = v_flex().gap(px(10.));
        if let Some(thread) = choice {
            let params =
                json!({ "botId": bot.id, "expectedRevision": bot.revision, "threadId": thread.id });
            panel = panel
                .child(thread.title.clone())
                .child(
                    div()
                        .text_color(style::secondary_text(cx))
                        .child(thread.cwd.clone()),
                )
                .child(
                    bot_button("bot-attach-confirm", tr!("Attach this Thread"), busy)
                        .primary()
                        .loading(busy)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.bot_write(
                                "bots.conversations.attach",
                                params.clone(),
                                After::Conversation,
                                window,
                                cx,
                            );
                        })),
                );
        } else {
            let mut candidates: Vec<_> = self
                .threads
                .values()
                .filter(|thread| {
                    thread.status == "idle"
                        && thread.bot_link.is_none()
                        && !thread.is_remote()
                        && !thread.is_archived()
                        && thread.sample != Some(true)
                        && thread.on_old_runner != Some(true)
                })
                .collect();
            candidates.sort_by(|a, b| {
                b.last_activity_at
                    .cmp(&a.last_activity_at)
                    .then_with(|| a.id.cmp(&b.id))
            });
            panel = panel.child(if candidates.is_empty() {
                tr!("There are no idle local Threads to attach.")
            } else {
                tr!("Choose the existing Thread for this Bot.")
            });
            for thread in candidates {
                let id = thread.id.clone();
                panel = panel.child(
                    h_flex()
                        .gap(px(8.))
                        .child(
                            bot_button(
                                SharedString::from(format!("bot-attach-{id}")),
                                thread.title.clone(),
                                busy,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.bots.roster.thread = Some(id.clone());
                                    cx.notify();
                                },
                            )),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_color(style::secondary_text(cx))
                                .child(thread.cwd.clone()),
                        ),
                );
            }
        }
        panel
            .child(
                bot_button("bot-attach-cancel", tr!("Cancel attachment"), busy).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.bots.roster.close_attachment();
                        this.bots.error = None;
                        cx.notify();
                    }),
                ),
            )
            .into_any_element()
    }
}
