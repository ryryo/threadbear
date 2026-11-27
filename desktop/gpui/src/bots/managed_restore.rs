use super::*;

#[derive(Default)]
pub(super) struct ManagedRestore {
    pub(super) available: bool,
    backups: Option<Vec<Backup>>,
    preview: Option<(String, Preview)>,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    id: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct Preview {
    checksum: String,
    revision: String,
    notes: Vec<BackupNote>,
}

#[derive(Deserialize)]
struct BackupNote {
    id: String,
    text: String,
}

impl ManagedRestore {
    pub(super) fn close(&mut self) {
        self.backups = None;
        self.preview = None;
        self.note = None;
    }

    pub(super) fn show_backups(&mut self, mut value: Value) -> Result<(), serde_json::Error> {
        self.close();
        self.backups = Some(serde_json::from_value(value["backups"].take())?);
        Ok(())
    }

    pub(super) fn show_notes(
        &mut self,
        backup: String,
        value: Value,
    ) -> Result<(), serde_json::Error> {
        self.note = None;
        self.preview = Some((backup, serde_json::from_value(value)?));
        Ok(())
    }
}

impl Threadbear {
    pub(super) fn render_backup_restore(
        &self,
        scope: &MemoryScope,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let state = &self.bots.restore;
        let busy = self.bots.busy;
        let Some(backups) = &state.backups else {
            return bot_button("bot-backups", tr!("Open note backups"), busy)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.bot_write(
                        "bots.memory.backups",
                        json!({}),
                        After::BackupIndex,
                        window,
                        cx,
                    );
                }))
                .into_any_element();
        };

        let mut section = v_flex().gap(px(8.));
        if let Some((backup, preview)) = &state.preview {
            section = section.child(self.render_backup_notes(scope, backup, preview, cx));
        } else if backups.is_empty() {
            section = section.child(tr!("This Runner has no staged Bot backups."));
        } else {
            section = section.child(tr!("Choose a backup to see which notes can be restored."));
            for backup in backups {
                let id = backup.id.clone();
                let params = json!({ "backupId": id, "scope": scope.target() });
                let short_id: String = id.chars().take(8).collect();
                let label = format!("{} · {short_id}", backup.updated_at);
                section = section.child(
                    bot_button(SharedString::from(format!("bot-backup-{id}")), label, busy)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.bot_write(
                                "bots.memory.backupNotes",
                                params.clone(),
                                After::BackupNotes(id.clone()),
                                window,
                                cx,
                            );
                        })),
                );
            }
        }
        section
            .child(
                bot_button("bot-backups-close", tr!("Close backups"), busy).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.bots.restore.close();
                        this.bots.error = None;
                        cx.notify();
                    },
                )),
            )
            .into_any_element()
    }

    fn render_backup_notes(
        &self,
        scope: &MemoryScope,
        backup: &str,
        preview: &Preview,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let busy = self.bots.busy;
        let mut notes = v_flex().gap(px(8.));
        if let Some(note) = preview
            .notes
            .iter()
            .find(|note| Some(&note.id) == self.bots.restore.note.as_ref())
        {
            let params = json!({
                "backupId": backup, "checksum": preview.checksum, "scope": scope.target(),
                "entryId": note.id, "expectedRevision": preview.revision,
            });
            return notes
                .child(note.text.clone())
                .child(
                    bot_button("bot-backup-confirm", tr!("Restore this note"), busy)
                        .primary()
                        .loading(busy)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.bot_write(
                                "bots.memory.recoverFromBackup",
                                params.clone(),
                                After::Memory,
                                window,
                                cx,
                            );
                        })),
                )
                .child(
                    bot_button("bot-backup-other-note", tr!("Choose another note"), busy).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.bots.restore.note = None;
                            this.bots.error = None;
                            cx.notify();
                        }),
                    ),
                )
                .into_any_element();
        }
        if preview.notes.is_empty() {
            notes = notes.child(tr!("This backup has no notes that can be restored here."));
        }
        for note in &preview.notes {
            let id = note.id.clone();
            notes = notes.child(
                bot_button(
                    SharedString::from(format!("bot-backup-note-{id}")),
                    note.text.clone(),
                    busy,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bots.restore.note = Some(id.clone());
                    cx.notify();
                })),
            );
        }
        notes
            .child(
                bot_button("bot-backups-back", tr!("Back to backups"), busy).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.bots.restore.preview = None;
                        this.bots.error = None;
                        cx.notify();
                    },
                )),
            )
            .into_any_element()
    }
}
