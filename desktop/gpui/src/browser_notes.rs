// T3 Code's picker runs in the live page. GPUI owns the comment and the
// review, so a site never receives the comment's keystrokes or the draft ID.

mod geometry;
mod live;

use crate::highlights::{palette, SidePane};
use crate::push_button::PushButton;
use crate::style::px;
use geometry::clean_url;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use live::{Capture, LivePicker};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::rc::Rc;
use threadbear_core::reducer::ImageRef;
use threadbear_core::tr;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct PageNote {
    url: String,
    title: String,
    target: String,
    comment: String,
    image: Option<Value>,
}

impl PageNote {
    pub(crate) fn image(&self) -> Option<ImageRef> {
        self.image.as_ref().and_then(ImageRef::decode)
    }

    pub(crate) fn words(&self) -> String {
        format!(
            "Page comment on {}\n{}\n{}\n{}",
            self.title, self.url, self.target, self.comment
        )
    }
}

pub(crate) struct Pick {
    thread: String,
    live: Rc<LivePicker>,
    loads: u32,
    address: String,
    title: String,
    ready: bool,
    element: bool,
    target: Option<String>,
    comment: Entity<InputState>,
    phase: Phase,
}

enum Phase {
    Selecting,
    Capturing,
    Review {
        capture: Option<Capture>,
        keep: bool,
    },
    Saving,
}

impl Pick {
    fn valid(&self, thread: &str, cx: &App) -> bool {
        self.thread == thread
            && !self.live.page.loading()
            && self.live.page.loads() == self.loads
            && self.live.page.address() == self.address
            && crate::web_panels::browser_page(thread, cx)
                .is_some_and(|page| Rc::ptr_eq(&page, &self.live.page))
    }
}

impl Drop for Pick {
    fn drop(&mut self) {
        self.live.stop();
    }
}

impl SidePane {
    pub(crate) fn start_browser_note(
        &mut self,
        element: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(thread) = self.thread(cx) else {
            return;
        };
        let Some(page) = crate::web_panels::browser_page(&thread.id, cx).filter(|p| !p.loading())
        else {
            return;
        };
        self.browser_note_error = None;
        let comment = cx.new(|cx| InputState::new(window, cx));
        comment.update(cx, |s, cx| {
            s.set_placeholder(tr!("Describe what to change"), window, cx)
        });
        let live = Rc::new(LivePicker::new(page.clone()));
        self.browser_pick = Some(Pick {
            thread: thread.id,
            loads: page.loads(),
            address: page.address(),
            title: page.title(),
            live: live.clone(),
            ready: false,
            element,
            target: None,
            comment,
            phase: Phase::Selecting,
        });
        cx.spawn_in(window, async move |this, cx| {
            let ready = live.start(element, cx).await.is_some();
            let _ = this.update_in(cx, |this, _, cx| {
                let Some(pick) = this.pick_for(&live) else {
                    return;
                };
                if ready {
                    pick.ready = true;
                } else {
                    this.cancel_browser_note();
                    this.browser_note_error = Some("Couldn't start selection on this page.");
                }
                cx.notify();
            });
            if !ready {
                return;
            }

            while let Some(selection) = live.next().await {
                let updated = this.update_in(cx, |this, window, cx| {
                    let Some(pick) = this.pick_for(&live) else {
                        return false;
                    };
                    if !matches!(pick.phase, Phase::Selecting) {
                        return true;
                    }
                    let target = selection.label();
                    if target.is_some() && !selection.frame && !selection.small {
                        crate::web_panels::keyboard_to_app(window);
                        pick.comment.update(cx, |s, cx| s.focus(window, cx));
                    }
                    pick.target = target;
                    this.browser_note_error = if selection.frame {
                        Some("Use Select area to mark something inside a frame.")
                    } else if selection.small {
                        Some("Drag a larger area to mark it.")
                    } else if selection.lost {
                        Some("The page moved. Choose the area again.")
                    } else {
                        None
                    };
                    cx.notify();
                    true
                });
                if !matches!(updated, Ok(true)) {
                    return;
                }
            }
            let _ = this.update_in(cx, |this, _, cx| {
                if this
                    .pick_for(&live)
                    .is_some_and(|p| matches!(p.phase, Phase::Selecting))
                {
                    this.cancel_browser_note();
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn pick_for(&mut self, live: &LivePicker) -> Option<&mut Pick> {
        self.browser_pick
            .as_mut()
            .filter(|p| std::ptr::eq(p.live.as_ref(), live))
    }

    pub(crate) fn cancel_browser_note(&mut self) {
        self.browser_pick = None;
        self.browser_note_error = None;
    }

    pub(crate) fn sync_browser_note(&mut self, thread: &str, cx: &mut Context<Self>) {
        if self
            .browser_pick
            .as_ref()
            .is_some_and(|p| !p.valid(thread, cx))
        {
            self.cancel_browser_note();
        }
    }

    #[cfg(feature = "automation")]
    pub(crate) fn browser_note_dump(&self, thread: &str, cx: &App) -> Value {
        let Some(pick) = self
            .browser_pick
            .as_ref()
            .filter(|pick| pick.thread == thread)
        else {
            return Value::Null;
        };
        let Phase::Review { capture, .. } = &pick.phase else {
            return json!({
                "ready": pick.ready,
                "target": pick.target,
                "comment": pick.comment.read(cx).value().to_string(),
            });
        };
        json!({
            "ready": true,
            "target": pick.target,
            "comment": pick.comment.read(cx).value().to_string(),
            "review": true,
            "crop": capture.as_ref().map(|capture| &capture.proof),
        })
    }

    fn review_browser_note(&mut self, cx: &mut Context<Self>) {
        let Some(pick) = self
            .browser_pick
            .as_mut()
            .filter(|p| p.target.is_some() && matches!(p.phase, Phase::Selecting))
        else {
            return;
        };
        pick.phase = Phase::Capturing;
        self.browser_note_error = None;
        let live = pick.live.clone();
        cx.spawn(async move |this, cx| {
            let capture = live.capture(cx).await;
            let _ = this.update(cx, |this, cx| {
                let Some(pick) = this
                    .pick_for(&live)
                    .filter(|p| matches!(p.phase, Phase::Capturing))
                else {
                    return;
                };
                pick.phase = Phase::Review {
                    keep: capture.is_some(),
                    capture,
                };
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn attach_browser_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread) = self.thread(cx) else {
            return;
        };
        let Some(pick) = self
            .browser_pick
            .as_mut()
            .filter(|p| p.valid(&thread.id, cx))
        else {
            return;
        };
        let Phase::Review { capture, keep } = &pick.phase else {
            return;
        };
        let Some(target) = pick.target.clone() else {
            return;
        };
        let mut note = PageNote {
            url: clean_url(&pick.address).to_owned(),
            title: pick.title.clone(),
            target,
            comment: pick.comment.read(cx).value().trim().to_owned(),
            image: None,
        };
        let image = capture
            .as_ref()
            .filter(|_| *keep)
            .map(|capture| capture.image.clone());
        let wants_image = image.is_some();
        let client = self.client.clone();
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let composer = app.update(cx, |app, cx| app.composer_for(&thread.id, window, cx));
        let live = pick.live.clone();
        live.stop();
        pick.phase = Phase::Saving;
        cx.spawn(async move |this, cx| {
            if let Some(image) = image {
                let staged = cx
                    .background_executor()
                    .spawn(async move {
                        crate::composer::stage_private(
                            &crate::composer::paste_base(),
                            "page-comment.png",
                            &image.bytes,
                        )
                    })
                    .await;
                if let Some(path) = staged {
                    let imported = crate::call(client, "media.import", json!({"path":path}))
                        .await
                        .ok();
                    note.image = imported.and_then(|val| {
                        ImageRef::decode(&val["image"]).map(|i| crate::composer::image_ref_json(&i))
                    });
                    crate::composer::unstage(&path);
                }
            }
            let failed = wants_image && note.image.is_none();
            let _ = this.update(cx, |this, cx| {
                composer.update(cx, |composer, cx| composer.add_page_note(note, cx));
                if this.pick_for(&live).is_some() {
                    this.cancel_browser_note();
                    if failed {
                        this.browser_note_error =
                            Some(tr!("The comment was added without an image."));
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn render_browser_note_controls(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let pick = self.browser_pick.as_ref()?;
        let p = palette(cx);
        let summary = self.browser_note_error.unwrap_or(match &pick.phase {
            Phase::Selecting if !pick.ready => "Starting selection…",
            Phase::Selecting => pick.target.as_deref().unwrap_or(if pick.element {
                "Click an element to select it."
            } else {
                "Drag over the area to select it."
            }),
            Phase::Capturing => "Capturing the selected area…",
            Phase::Review { capture: None, .. } => {
                "No image was captured. You can still add the comment."
            }
            Phase::Review { .. } => "Review the image and comment.",
            Phase::Saving => "Adding the comment to the draft…",
        });
        let cancel = cx.listener(|this, _: &ClickEvent, _, cx| {
            this.cancel_browser_note();
            cx.notify();
        });
        let mut controls = h_flex().flex_wrap().gap(px(5.)).child(
            PushButton::new(
                "browser-note-cancel",
                tr!("Cancel"),
                tr!("Cancel page comment"),
            )
            .small()
            .disabled(matches!(pick.phase, Phase::Saving))
            .render(cx, cancel),
        );
        match &pick.phase {
            Phase::Selecting | Phase::Capturing => {
                let review =
                    cx.listener(|this, _: &ClickEvent, _, cx| this.review_browser_note(cx));
                controls = controls.child(
                    PushButton::new("browser-note-review", "Review", "Review selected page area")
                        .small()
                        .busy(matches!(pick.phase, Phase::Capturing))
                        .disabled(pick.target.is_none())
                        .render(cx, review),
                );
                let mode = cx.listener(|this, _: &ClickEvent, _, cx| {
                    if let Some(pick) = &mut this.browser_pick {
                        pick.element = !pick.element;
                        pick.target = None;
                        pick.live.switch_mode(pick.element);
                        this.browser_note_error = None;
                        cx.notify();
                    }
                });
                controls = controls.child(
                    PushButton::new(
                        "browser-note-switch",
                        if pick.element {
                            tr!("Select area")
                        } else {
                            tr!("Pick element")
                        },
                        "Switch selection mode without clearing the comment",
                    )
                    .small()
                    .disabled(!pick.ready || !matches!(pick.phase, Phase::Selecting))
                    .render(cx, mode),
                );
            }
            Phase::Review { keep, capture } => {
                let retry = cx.listener(|this, _: &ClickEvent, _, cx| {
                    if let Some(pick) = &mut this.browser_pick {
                        pick.live.resume();
                        pick.phase = Phase::Selecting;
                        cx.notify();
                    }
                });
                let image = cx.listener(|this, _: &ClickEvent, _, cx| {
                    if let Some(Pick {
                        phase: Phase::Review { keep, .. },
                        ..
                    }) = &mut this.browser_pick
                    {
                        *keep = !*keep;
                        cx.notify();
                    }
                });
                let attach = cx.listener(|this, _: &ClickEvent, window, cx| {
                    this.attach_browser_note(window, cx)
                });
                controls = controls
                    .child(
                        PushButton::new(
                            "browser-note-retry",
                            "Choose again",
                            "Return to page selection",
                        )
                        .small()
                        .render(cx, retry),
                    )
                    .when(capture.is_some(), |controls| {
                        controls.child(
                            PushButton::new(
                                "browser-note-image",
                                if *keep {
                                    tr!("Skip image")
                                } else {
                                    tr!("Include image")
                                },
                                tr!("Choose whether the cutout is attached"),
                            )
                            .small()
                            .render(cx, image),
                        )
                    })
                    .child(
                        PushButton::new(
                            "browser-note-add",
                            tr!("Add to draft"),
                            tr!("Attach to this thread's draft"),
                        )
                        .small()
                        .render(cx, attach),
                    );
            }
            Phase::Saving => {}
        }
        Some(
            v_flex()
                .p(px(6.))
                .gap(px(4.))
                .flex_none()
                .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                    if event.keystroke.key == "escape"
                        && this
                            .browser_pick
                            .as_ref()
                            .is_some_and(|p| !matches!(p.phase, Phase::Saving))
                    {
                        this.cancel_browser_note();
                        cx.stop_propagation();
                        cx.notify();
                    }
                }))
                .child(
                    div()
                        .text_color(p.secondary)
                        .truncate()
                        .child(summary.to_owned()),
                )
                .child(
                    Input::new(&pick.comment)
                        .small()
                        .disabled(matches!(pick.phase, Phase::Saving)),
                )
                .child(controls)
                .into_any_element(),
        )
    }

    pub(crate) fn render_browser_note_review(&self, cx: &App) -> Option<AnyElement> {
        match &self.browser_pick.as_ref()?.phase {
            Phase::Review {
                capture: Some(capture),
                keep: true,
            } => Some(
                img(crate::fit_picture::bytes_source(capture.image.clone()))
                    .size_full()
                    .object_fit(ObjectFit::Contain)
                    .into_any_element(),
            ),
            Phase::Review { .. } => Some(
                crate::files::pane_note("No image will be attached.", palette(cx))
                    .into_any_element(),
            ),
            Phase::Saving => Some(div().into_any_element()),
            _ => None,
        }
    }
}
