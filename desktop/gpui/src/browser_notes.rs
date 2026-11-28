// T3 Code's picker runs in the live page. GPUI owns the comment, so the site
// never receives the comment's keystrokes or its destination draft.

mod geometry;
mod live;
mod placement;

use crate::highlights::{palette, SidePane};
use crate::push_button::PushButton;
use crate::style::px;
use geometry::clean_url;
use gpui_kit::component::input::{Enter, Escape, InputEvent, Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _, WindowExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use live::{Anchor, LivePicker};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use threadbear_core::reducer::ImageRef;
use threadbear_core::tr;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct PageNote {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) id: String,
    /// UTF-8 offset in the serialized draft. Older comments had no position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) offset: Option<usize>,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) target: String,
    pub(crate) comment: String,
    pub(crate) image: Option<Value>,
}

impl PageNote {
    pub(crate) fn identify(&mut self) {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        if self.id.is_empty() {
            self.id = format!(
                "page-comment-{}-{}",
                crate::now_ms(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
        }
    }

    pub(crate) fn label(&self) -> String {
        threadbear_core::page_comments::label(&self.comment, &self.title)
            .unwrap_or_else(|| tr!("Page comment").into())
    }

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
    version: u32,
    prior_focus: Option<FocusHandle>,
    anchor: Option<Anchor>,
    editor: Rc<Cell<Option<Bounds<Pixels>>>>,
    comment: Entity<TextareaState>,
    _comment_events: Subscription,
    phase: Phase,
}

enum Phase {
    Selecting,
    Attaching,
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
        if matches!(self.phase, Phase::Selecting) {
            self.live.stop();
        }
    }
}

/// AnnotationKeyboard.ts at T3 Code c2fcbd79523e accepts Control as well as
/// Command. The ordinary GPUI text area uses the platform's command key.
pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(
        "ctrl-enter",
        Enter {
            secondary: true,
            shift: false,
        },
        Some("BrowserNote"),
    )]);
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
        let comment = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(tr!("Describe what to change"))
                .auto_grow(1, 4)
                .submit_on_enter(true)
        });
        let comment_events = cx.subscribe(&comment, |_, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
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
            version: 0,
            prior_focus: window.focused(cx),
            anchor: None,
            editor: Rc::new(Cell::new(None)),
            comment,
            _comment_events: comment_events,
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
                    this.browser_note_error = Some(tr!("Couldn't start selection on this page."));
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
                    pick.anchor = selection.anchor;
                    if selection.moved && selection.version == pick.version {
                        cx.notify();
                        return true;
                    }
                    if target.is_some() && !selection.frame && !selection.small {
                        pick.comment.update(cx, |s, cx| s.focus(window, cx));
                        crate::web_panels::keyboard_to_app(window);
                    }
                    pick.target = target;
                    pick.version = selection.version;
                    this.browser_note_error = if selection.frame {
                        Some(tr!("Use Select area to mark something inside a frame."))
                    } else if selection.small {
                        Some(tr!("Drag a larger area to mark it."))
                    } else if selection.lost {
                        Some(tr!("The page moved. Choose the area again."))
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

    pub(crate) fn cancel_browser_note(&mut self) -> bool {
        let pick = self.browser_pick.take();
        let error = self.browser_note_error.take();
        pick.is_some() || error.is_some()
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
        let (x, y, w, h) = pick.live.page.bounds();
        let editor = pick
            .editor
            .get()
            .filter(|_| pick.anchor.is_some())
            .map(|b| {
                [
                    f32::from(b.origin.x) - x,
                    f32::from(b.origin.y) - y,
                    f32::from(b.size.width),
                    f32::from(b.size.height),
                ]
            });
        json!({
            "editor": editor,
            "targetRect": pick.anchor.map(|a| [a.x * w, a.y * h, a.w * w, a.h * h]),
            "ready": pick.ready,
            "target": pick.target,
            "comment": pick.comment.read(cx).value().to_string(),
            "attaching": matches!(pick.phase, Phase::Attaching),
        })
    }

    fn confirm_browser_note(&mut self, send: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread) = self.thread(cx) else {
            return;
        };
        let Some(pick) = self.browser_pick.as_mut().filter(|p| {
            matches!(p.phase, Phase::Selecting)
                && p.valid(&thread.id, cx)
                && !p.comment.read(cx).has_composition()
        }) else {
            return;
        };
        let Some(target) = pick.target.clone() else {
            return;
        };
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let composer = app.update(cx, |app, cx| app.composer_for(&thread.id, window, cx));
        if send && !composer.read(cx).browser_comment_can_send(cx) {
            return;
        }
        let mut note = PageNote {
            id: String::new(),
            offset: None,
            url: clean_url(&pick.address).to_owned(),
            title: pick.title.clone(),
            target,
            comment: pick.comment.read(cx).value().trim().to_owned(),
            image: None,
        };
        note.identify();
        composer.update(cx, |composer, cx| {
            composer.begin_page_note(note.clone(), cx)
        });
        let send_state = send.then(|| composer.read(cx).browser_comment_send_state(cx));
        app.update(cx, |app, cx| app.persist_page_comment(cx));
        let live = pick.live.clone();
        let version = pick.version;
        let client = self.client.clone();
        let prior_focus = pick.prior_focus.clone();
        let comment_focus = pick.comment.read(cx).focus_handle(cx);
        let origin = thread.id;
        self.browser_note_error = None;
        pick.phase = Phase::Attaching;
        pick.editor.set(None);

        cx.spawn_in(window, async move |pane, cx| {
            // Once accepted, capture and attachment belong to the originating
            // composer even if the page or the pane is closed meanwhile.
            let capture = live.capture(version, cx).await;
            live.stop();
            if let Some(capture) = capture {
                let path = cx
                    .background_executor()
                    .spawn(async move {
                        crate::composer::stage_private(
                            &crate::composer::paste_base(),
                            "page-comment.png",
                            &capture.image.bytes,
                        )
                    })
                    .await;
                if let Some(path) = path {
                    let imported = crate::call(client, "media.import", json!({"path": path}))
                        .await
                        .ok();
                    note.image = imported.and_then(|reply| {
                        ImageRef::decode(&reply["image"])
                            .map(|image| crate::composer::image_ref_json(&image))
                    });
                    crate::composer::unstage(&path);
                }
            }
            let mut accepted = Some(note);
            let _ = cx.update(|window, cx| {
                let Some(note) = accepted.take() else { return };
                let no_image = note.image.is_none();
                let visible = pane
                    .update(cx, |pane, cx| {
                        let current = pane.pick_for(&live).is_some();
                        let valid = current
                            && pane.dock_showing(crate::highlights::BROWSER, cx)
                            && pane
                                .browser_pick
                                .as_ref()
                                .is_some_and(|pick| pick.valid(&origin, cx));
                        if current {
                            pane.cancel_browser_note();
                            cx.notify();
                        }
                        valid
                    })
                    .unwrap_or(false);
                let visible = visible && app.read(cx).selected.as_deref() == Some(origin.as_str());
                let send = composer.update(cx, |composer, cx| {
                    composer.finish_page_note_capture(&note.id);
                    let send = send_state.as_ref().is_some_and(|before| {
                        visible
                            && composer.browser_comment_can_send(cx)
                            && before == &composer.browser_comment_send_state(cx)
                    });
                    composer.add_page_note(note, window, cx) && send
                });
                if visible && no_image {
                    window.push_notification(tr!("The comment was added without an image."), cx);
                }
                // Persist the attached payload before trying to send it.
                let saved = app.update(cx, |app, cx| app.persist_page_comment(cx));
                if send && saved {
                    composer.update(cx, |composer, cx| composer.send(window, cx));
                }
                let focus = window.focused(cx);
                if visible && (focus.is_none() || focus.as_ref() == Some(&comment_focus)) {
                    if let Some(focus) = prior_focus {
                        window.focus(&focus, cx);
                    }
                    crate::web_panels::keyboard_to_app(window);
                }
            });
            if let Some(note) = accepted {
                // An accepted comment still belongs to its draft when its
                // floating browser window closes during the image import.
                composer.update(cx, |composer, cx| {
                    composer.finish_page_note_capture(&note.id);
                    composer.queue_page_note(note, cx);
                });
                app.update(cx, |app, cx| app.persist_page_comment(cx));
            }
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn render_browser_note_toolbar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let pick = self.browser_pick.as_ref()?;
        if !matches!(pick.phase, Phase::Selecting) {
            return None;
        }
        let mode = cx.listener(|this, _: &ClickEvent, _, cx| {
            if let Some(pick) = &mut this.browser_pick {
                pick.element = !pick.element;
                pick.target = None;
                pick.anchor = None;
                pick.live.switch_mode(pick.element);
                this.browser_note_error = None;
                cx.notify();
            }
        });
        let cancel = cx.listener(|this, _: &ClickEvent, window, cx| {
            if let Some(focus) = this
                .browser_pick
                .as_ref()
                .and_then(|pick| pick.prior_focus.as_ref())
            {
                window.focus(focus, cx);
            }
            crate::web_panels::keyboard_to_app(window);
            this.cancel_browser_note();
            cx.notify();
        });
        Some(
            h_flex()
                .gap(px(5.))
                .px(px(6.))
                .pb(px(6.))
                .flex_none()
                .child(
                    PushButton::new(
                        "browser-note-switch",
                        if pick.element {
                            tr!("Select area")
                        } else {
                            tr!("Pick element")
                        },
                        tr!("Switch selection mode without clearing the comment"),
                    )
                    .small()
                    .disabled(!pick.ready)
                    .render(cx, mode),
                )
                .child(
                    PushButton::new(
                        "browser-note-stop",
                        tr!("Cancel"),
                        tr!("Cancel page comment"),
                    )
                    .small()
                    .render(cx, cancel),
                )
                .into_any_element(),
        )
    }

    pub(crate) fn render_browser_note_overlay(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let pick = self.browser_pick.as_ref()?;
        let anchor = pick.anchor?;
        if !matches!(pick.phase, Phase::Selecting) {
            return None;
        }
        let page = pick.live.page.clone();
        let editor = pick.editor.clone();
        let background = cx.theme().popover;
        let border = palette(cx).card_border;
        let card = self.render_browser_note_controls(cx)?;
        Some(
            canvas(
                move |bounds, window, cx| {
                    let width = placement::compact_width(bounds.size);
                    let mut element = div()
                        .w(width)
                        .bg(background)
                        .border_1()
                        .border_color(border)
                        .occlude()
                        .child(card)
                        .into_any_element();
                    let measured = element.layout_as_root(
                        size(AvailableSpace::Definite(width), AvailableSpace::MinContent),
                        window,
                        cx,
                    );
                    let origin = placement::compact_origin(bounds, anchor, measured);
                    let rect = Bounds::new(origin, measured);
                    element.prepaint_at(origin, window, cx);
                    editor.set(Some(rect));
                    crate::web_panels::place_browser_comment(&page, rect);
                    element
                },
                |_, mut element, window, cx| element.paint(window, cx),
            )
            .absolute()
            .inset_0()
            .into_any_element(),
        )
    }

    fn render_browser_note_controls(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let pick = self.browser_pick.as_ref()?;
        let attach = cx.listener(|this, _: &ClickEvent, window, cx| {
            this.confirm_browser_note(false, window, cx)
        });
        Some(
            v_flex()
                .key_context("BrowserNote")
                .p(px(6.))
                .gap(px(4.))
                .flex_none()
                .on_action(cx.listener(|this, enter: &Enter, window, cx| {
                    if enter.shift {
                        cx.propagate();
                    } else {
                        this.confirm_browser_note(enter.secondary, window, cx);
                    }
                }))
                .on_action(cx.listener(|this, _: &Escape, window, cx| {
                    let Some(pick) = this.browser_pick.as_ref().filter(|pick| {
                        matches!(pick.phase, Phase::Selecting)
                            && !pick.comment.read(cx).has_composition()
                    }) else {
                        return;
                    };
                    if let Some(focus) = pick.prior_focus.clone() {
                        window.focus(&focus, cx);
                    }
                    crate::web_panels::keyboard_to_app(window);
                    this.cancel_browser_note();
                    cx.notify();
                }))
                .when_some(self.browser_note_error, |card, error| {
                    card.child(
                        div()
                            .text_color(palette(cx).failed)
                            .truncate()
                            .child(error.to_owned()),
                    )
                })
                .child(
                    h_flex()
                        .items_start()
                        .gap(px(6.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(Textarea::new(&pick.comment).small()),
                        )
                        .child(
                            PushButton::new(
                                "browser-note-attach",
                                tr!("Attach"),
                                tr!("Attach to this thread's draft"),
                            )
                            .small()
                            .disabled(pick.target.is_none())
                            .render(cx, attach),
                        ),
                )
                .into_any_element(),
        )
    }
}
