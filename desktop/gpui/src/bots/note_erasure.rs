use super::*;
use gpui_kit::component::button::ButtonVariant;
use gpui_kit::component::dialog::DialogButtonProps;
use gpui_kit::component::WindowExt as _;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ErasureStatus {
    workspace_id: String,
    epoch: u64,
    available: bool,
    pending: Vec<Pending>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    entry_id: String,
    state: ErasureProgress,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ErasureProgress {
    Queued,
    WaitingForLocalCopies,
    WaitingForSync,
    WaitingForLegacy,
    WaitingForSources,
    WaitingForDevices,
    #[serde(other)]
    Unknown,
}

impl ErasureProgress {
    fn label(&self) -> &'static str {
        match self {
            Self::Queued => tr!("Note erasure queued"),
            Self::WaitingForLocalCopies => tr!("Waiting for copies on this Runner"),
            Self::WaitingForSync => tr!("Checking synced copies"),
            Self::WaitingForLegacy => tr!("Waiting for older sync results to expire"),
            Self::WaitingForSources => tr!("Waiting for previous Runners"),
            Self::WaitingForDevices => tr!("Waiting for registered devices"),
            Self::Unknown => tr!("Note erasure pending"),
        }
    }
}

fn status_label(id: &str, label: &'static str, cx: &App) -> AnyElement {
    div()
        .id(SharedString::from(format!("bot-note-erasure-{id}")))
        .test_support()
        .a11y_role(gpui_kit::Role::GenericContainer)
        .aria_label(label)
        .text_color(style::secondary_text(cx))
        .child(label)
        .into_any_element()
}

impl Threadbear {
    pub(super) fn render_note_erasure_pending(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let status = self
            .bots
            .note_erasure
            .as_ref()
            .filter(|status| !status.pending.is_empty())?;
        Some(
            v_flex()
                .gap(px(4.))
                .children(status.pending.iter().filter_map(|pending| {
                    let shown = self.bots.changes.iter().any(|change| {
                        change.op == "erase" && change.entry_id.as_ref() == Some(&pending.entry_id)
                    });
                    (!shown).then(|| status_label(&pending.entry_id, pending.state.label(), cx))
                }))
                .child(
                    bot_button(
                        "bot-erasure-refresh",
                        tr!("Check note erasure status"),
                        self.bots.busy,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.load_bot_memory(false, cx))),
                )
                .into_any_element(),
        )
    }

    pub(super) fn note_erasure_caption(&self, id: Option<&str>, cx: &App) -> AnyElement {
        let label = match (self.bots.note_erasure.as_ref(), id) {
            (Some(status), Some(id)) => status
                .pending
                .iter()
                .find(|row| row.entry_id == id)
                .map_or_else(|| tr!("Managed copies erased"), |row| row.state.label()),
            _ => tr!("Erasure status unavailable"),
        };
        status_label(id.unwrap_or("unknown"), label, cx)
    }

    pub(super) fn note_erase_button(
        &self,
        id: &str,
        text: &str,
        row: &str,
        cx: &mut Context<Self>,
    ) -> Option<Button> {
        let status = self.bots.note_erasure.as_ref()?;
        if !status.available
            || status.pending.iter().any(|row| row.entry_id == id)
            || self.bots.memory_revision.is_none()
        {
            return None;
        }
        let (id, text) = (id.to_owned(), text.to_owned());
        Some(
            bot_button(
                SharedString::from(format!("bot-erase-note-{row}")),
                tr!("Erase note permanently"),
                self.bots.busy,
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.confirm_note_erasure(&id, &text, window, cx);
            })),
        )
    }

    fn confirm_note_erasure(
        &mut self,
        id: &str,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(scope), Some(revision), Some(status)) = (
            &self.bots.scope,
            &self.bots.memory_revision,
            &self.bots.note_erasure,
        ) else {
            return;
        };
        if self.bots.busy || !status.available {
            return;
        }
        let params = json!({ "workspaceId": status.workspace_id, "epoch": status.epoch,
            "scope": scope.target(), "entryId": id, "expectedRevision": revision, "confirmed": true });
        let (caption, text) = (scope.title.clone(), text.to_owned());
        let app = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (app, params) = (app.clone(), params.clone());
            alert
                .title(tr!("Erase this note permanently?"))
                .description(v_flex().gap(px(8.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(caption.clone()))
                    .child(text.clone())
                    .child(tr!("This erases the note, its memory history, and copies Threadbear manages."))
                    .child(tr!("Conversation history, provider copies, external backups, and unregistered drafts can still contain this note.")))
                .button_props(DialogButtonProps::default().show_cancel(true)
                    .cancel_text(tr!("Cancel"))
                    .ok_text(tr!("Erase permanently"))
                    .ok_variant(ButtonVariant::Danger))
                .on_ok(move |_, window, cx| {
                    app.update(cx, |this, cx| {
                        this.bot_write("bots.memory.erase", params.clone(), After::Memory, window, cx);
                    }).ok();
                    true
                })
        });
    }
}
