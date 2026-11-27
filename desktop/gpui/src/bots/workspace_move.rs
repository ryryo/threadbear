use super::*;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct WorkspaceMove {
    pub(super) available: bool,
    pub(super) visible: bool,
    preview: Option<MovePreview>,
    runner: Option<String>,
    choices: BTreeMap<String, Option<String>>,
    move_id: Option<String>,
    status: Option<MoveStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MovePreview {
    runners: Vec<BotWorkerTarget>,
    projects: Vec<MoveProject>,
    destination_projects: Option<Vec<MoveProject>>,
}

#[derive(Clone, Deserialize)]
struct MoveProject {
    id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveStatus {
    move_id: String,
    state: TransferState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum TransferState {
    Preparing,
    Frozen,
    Receiving,
    Moved,
    Accepted,
    Cancelled,
    #[serde(other)]
    Unknown,
}

impl TransferState {
    fn label(&self) -> &'static str {
        match self {
            Self::Preparing => tr!("Preparing the workspace"),
            Self::Frozen => tr!("Waiting for the destination Runner"),
            Self::Receiving => tr!("Receiving the workspace"),
            Self::Moved => tr!("Workspace transferred"),
            Self::Accepted => tr!("Workspace received"),
            Self::Cancelled => tr!("Transfer cancelled"),
            Self::Unknown => tr!("Status unavailable"),
        }
    }

    fn cancellable(&self) -> bool {
        matches!(self, Self::Preparing | Self::Frozen)
    }

    fn can_preview(&self) -> bool {
        matches!(self, Self::Cancelled | Self::Accepted)
    }
}

impl Threadbear {
    pub(super) fn open_workspace_move(&mut self, cx: &mut Context<Self>) {
        self.bots.workspace_move.visible = true;
        self.refresh_workspace_move(cx);
    }

    fn refresh_workspace_move(&mut self, cx: &mut Context<Self>) {
        self.workspace_move_call(None, cx);
    }

    fn choose_workspace_runner(&mut self, runner: String, cx: &mut Context<Self>) {
        let transfer = &mut self.bots.workspace_move;
        transfer.runner = Some(runner);
        transfer.choices.clear();
        transfer.move_id = None;
        self.refresh_workspace_move(cx);
    }

    fn start_workspace_move(&mut self, cx: &mut Context<Self>) {
        let transfer = &mut self.bots.workspace_move;
        let Some(runner) = transfer.runner.clone().filter(|_| transfer.ready()) else {
            return;
        };
        let id = transfer.move_id.get_or_insert_with(|| {
            self.bots.operation += 1;
            format!(
                "desktop-{}-{}-{}",
                std::process::id(),
                now_ms(),
                self.bots.operation
            )
        });
        let params = json!({
            "moveId": id, "runnerId": runner, "projects": { "assign": transfer.choices },
        });
        self.workspace_move_call(Some(("bots.workspace.move", params)), cx);
    }

    fn workspace_move_call(
        &mut self,
        action: Option<(&'static str, Value)>,
        cx: &mut Context<Self>,
    ) {
        if self.bots.busy {
            return;
        }
        self.bots.busy = true;
        self.bots.error = None;
        cx.notify();
        let client = self.client.clone();
        let runner = self.bots.workspace_move.runner.clone();
        cx.spawn(async move |this, cx| {
            let error = if let Some((method, params)) = action {
                call(client.clone(), method, params)
                    .await
                    .err()
                    .map(|e| e.message)
            } else {
                None
            };
            let state = call(client.clone(), "bots.workspace.moveStatus", json!({})).await;
            let (status, status_error) = match state {
                Ok(value) => (
                    serde_json::from_value::<Option<MoveStatus>>(value["move"].clone()).ok(),
                    None,
                ),
                Err(error) => (None, Some(error.message)),
            };
            let preview = if status.as_ref().is_some_and(|state| {
                state
                    .as_ref()
                    .is_none_or(|current| current.state.can_preview())
            }) {
                let params = runner.map_or_else(|| json!({}), |id| json!({ "runnerId": id }));
                Some(call(client, "bots.workspace.movePreview", params).await)
            } else {
                None
            };
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                this.bots.error = error.or(status_error);
                let transfer = &mut this.bots.workspace_move;
                if let Some(status) = status {
                    if status
                        .as_ref()
                        .is_some_and(|move_| matches!(move_.state, TransferState::Cancelled))
                        && transfer.move_id.as_ref() == status.as_ref().map(|move_| &move_.move_id)
                    {
                        transfer.move_id = None;
                    }
                    transfer.status = status;
                }
                transfer.preview = match preview {
                    Some(Ok(value)) => serde_json::from_value(value).ok(),
                    Some(Err(error)) => {
                        this.bots.error.get_or_insert(error.message);
                        None
                    }
                    None => None,
                };
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn render_workspace_move(&self, cx: &mut Context<Self>) -> AnyElement {
        let transfer = &self.bots.workspace_move;
        let busy = self.bots.busy;
        let mut page = v_flex()
            .gap(px(12.))
            .max_w(px(720.))
            .child(div().text_size(px(24.)).child(tr!("Move Bot workspace")))
            .child(
                bot_button("bot-move-refresh", tr!("Refresh transfer status"), busy)
                    .on_click(cx.listener(|this, _, _, cx| this.refresh_workspace_move(cx))),
            );
        if let Some(status) = &transfer.status {
            let label = status.state.label();
            page = page.child(
                div()
                    .id("bot-workspace-transfer-status")
                    .test_support()
                    .a11y_role(Role::Status)
                    .aria_label(label)
                    .child(label),
            );
            if status.state.cancellable() {
                let id = status.move_id.clone();
                page = page.child(
                    bot_button("bot-move-cancel", tr!("Cancel workspace transfer"), busy).on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.workspace_move_call(
                                Some(("bots.workspace.cancelMove", json!({ "moveId": id }))),
                                cx,
                            )
                        }),
                    ),
                );
            }
        }
        let Some(preview) = &transfer.preview else {
            return page.into_any_element();
        };
        if preview.runners.is_empty() {
            return page
                .child(tr!("No other Runner is available."))
                .into_any_element();
        }
        let mut targets = h_flex().gap(px(8.)).flex_wrap();
        for runner in &preview.runners {
            let id = runner.id.clone();
            targets = targets.child(
                bot_button(
                    SharedString::from(format!("bot-move-target-{id}")),
                    runner.name.clone(),
                    busy,
                )
                .when(transfer.runner.as_ref() == Some(&id), |button| {
                    button.primary()
                })
                .on_click(
                    cx.listener(move |this, _, _, cx| this.choose_workspace_runner(id.clone(), cx)),
                ),
            );
        }
        page = page.child(tr!("Choose a Runner")).child(targets);
        if let Some(projects) = &preview.destination_projects {
            for source in &preview.projects {
                page = page.child(self.render_workspace_project(source, projects, cx));
            }
            page = page.child(
                bot_button(
                    "bot-move-start",
                    tr!("Start workspace transfer"),
                    busy || !transfer.ready(),
                )
                .primary()
                .on_click(cx.listener(|this, _, _, cx| this.start_workspace_move(cx))),
            );
        }
        page.into_any_element()
    }

    fn render_workspace_project(
        &self,
        source: &MoveProject,
        destinations: &[MoveProject],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let source_id = source.id.clone();
        let choices = &self.bots.workspace_move.choices;
        let selected = choices.get(&source_id);
        let options: Vec<(Option<String>, String)> =
            std::iter::once((None, tr!("Leave on this Runner").into()))
                .chain(
                    destinations
                        .iter()
                        .filter(|project| {
                            !choices.iter().any(|(from, to)| {
                                from != &source_id && to.as_ref() == Some(&project.id)
                            })
                        })
                        .map(|project| (Some(project.id.clone()), project.title.clone())),
                )
                .collect();
        let label = selected
            .and_then(|id| options.iter().find(|(choice, _)| choice == id))
            .map(|(_, title)| title.clone())
            .unwrap_or_else(|| tr!("Choose a destination").into());
        let options: Vec<_> = options
            .into_iter()
            .map(|(id, title)| {
                let checked = selected == Some(&id);
                (id, title, checked)
            })
            .collect();
        let tip = threadbear_core::trf!(
            "Choose a destination for {project}",
            project = &source.title
        );
        let entity = cx.entity().downgrade();
        h_flex()
            .gap(px(8.))
            .child(source.title.clone())
            .child(
                div()
                    .id(SharedString::from(format!(
                        "bot-move-project-picker-{source_id}"
                    )))
                    .test_support()
                    .a11y_role(Role::GenericContainer)
                    .aria_label(tip.clone())
                    .child(
                        Button::new(SharedString::from(format!("bot-move-project-{source_id}")))
                            .label(label)
                            .small()
                            .outline()
                            .dropdown_caret(true)
                            .tooltip(tip)
                            .disabled(self.bots.busy)
                            .dropdown_menu(move |menu: PopupMenu, _, _| {
                                options.iter().fold(menu, |menu, (id, name, checked)| {
                                    let source = source_id.clone();
                                    let target = id.clone();
                                    let entity = entity.clone();
                                    menu.item(
                                        PopupMenuItem::new(name.clone())
                                            .checked(*checked)
                                            .on_click(move |_, _, cx| {
                                                entity
                                                    .update(cx, |this, cx| {
                                                        let transfer =
                                                            &mut this.bots.workspace_move;
                                                        transfer
                                                            .choices
                                                            .insert(source.clone(), target.clone());
                                                        transfer.move_id = None;
                                                        cx.notify();
                                                    })
                                                    .ok();
                                            }),
                                    )
                                })
                            }),
                    ),
            )
            .into_any_element()
    }
}

impl WorkspaceMove {
    fn ready(&self) -> bool {
        self.preview.as_ref().is_some_and(|preview| {
            let Some(destinations) = &preview.destination_projects else {
                return false;
            };
            preview.projects.iter().all(|project| {
                self.choices.get(&project.id).is_some_and(|selected| {
                    selected
                        .as_ref()
                        .is_none_or(|id| destinations.iter().any(|project| &project.id == id))
                })
            })
        })
    }
}
