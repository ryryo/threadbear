// Capture a visible CEF page, then select on its still in GPUI. The page never
// receives the pointer events used to mark it.

mod geometry;

use crate::highlights::{palette, SidePane};
use crate::push_button::PushButton;
use crate::style::px;
use geometry::{clean_url, Rect};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use threadbear_core::reducer::ImageRef;
use threadbear_web::PanelPage;

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

struct Still {
    preview: Arc<Image>,
    width: f64,
    height: f64,
}

pub(crate) struct Pick {
    thread: String,
    page: Rc<PanelPage>,
    loads: u32,
    address: String,
    title: String,
    still: Option<Still>,
    bounds: Rc<Cell<Bounds<Pixels>>>,
    drag: Option<(f64, f64)>,
    rect: Option<Rect>,
    element: bool,
    locating: bool,
    committing: bool,
    target: Option<String>,
    comment: Entity<InputState>,
    keep_image: bool,
}

impl Pick {
    fn valid(&self, thread: &str, cx: &App) -> bool {
        self.thread == thread
            && self.page.loads() == self.loads
            && self.page.address() == self.address
            && crate::web_panels::browser_page(thread, cx)
                .is_some_and(|page| Rc::ptr_eq(&page, &self.page))
    }

    fn point(&self, position: Point<Pixels>) -> (f64, f64) {
        let bounds = self.bounds.get();
        let relative = position - bounds.origin;
        let convert = |offset: Pixels, edge: Pixels| {
            (f64::from(f32::from(offset)) / f64::from(f32::from(edge)).max(1.)).clamp(0., 1.)
        };
        (
            convert(relative.x, bounds.size.width),
            convert(relative.y, bounds.size.height),
        )
    }
}

async fn devtools(page: &PanelPage, method: &str, params: Value, cx: &AsyncApp) -> Option<Value> {
    let response = page.devtools(method, params);
    let timeout = cx
        .background_executor()
        .timer(std::time::Duration::from_secs(5));
    futures::pin_mut!(timeout);
    match futures::future::select(response, timeout).await {
        futures::future::Either::Left((Ok(Ok(result)), _)) => Some(result),
        _ => None,
    }
}

async fn freeze(page: &PanelPage, cx: &AsyncApp) -> Option<Still> {
    let metrics = devtools(page, "Page.getLayoutMetrics", json!({}), cx).await?;
    let width = metrics["cssVisualViewport"]["clientWidth"].as_f64()?;
    let height = metrics["cssVisualViewport"]["clientHeight"].as_f64()?;
    if width <= 0. || height <= 0. {
        return None;
    }
    let screenshot = devtools(page, "Page.captureScreenshot", json!({"format":"png"}), cx).await?;
    let data = screenshot["data"].as_str()?;
    if data.len() > 28 * 1024 * 1024 {
        return None;
    }
    let image = threadbear_core::folders::base64_decode(data)?;
    Some(Still {
        preview: Arc::new(Image::from_bytes(ImageFormat::Png, image)),
        width,
        height,
    })
}

async fn find_element(
    page: &PanelPage,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    cx: &AsyncApp,
) -> Option<(String, Rect)> {
    let node = devtools(
        page,
        "DOM.getNodeForLocation",
        json!({"x": x.floor(), "y": y.floor()}),
        cx,
    )
    .await?;
    let id = node["backendNodeId"].as_i64()?;
    let desc = devtools(page, "DOM.describeNode", json!({"backendNodeId":id}), cx).await?;
    let model = devtools(page, "DOM.getBoxModel", json!({"backendNodeId":id}), cx).await?;
    let quad = model["model"]["border"].as_array()?;
    let mut points = quad
        .as_chunks::<2>()
        .0
        .iter()
        .map(|xy| Some((xy[0].as_f64()? / w, xy[1].as_f64()? / h)));
    let first = points.next()??;
    let ((left, top), (right, bottom)) = points.try_fold((first, first), |(a, b), p| {
        let (x, y) = p?;
        Some(((a.0.min(x), a.1.min(y)), (b.0.max(x), b.1.max(y))))
    })?;
    let rect = Rect::between(
        (left.clamp(0., 1.), top.clamp(0., 1.)),
        (right.clamp(0., 1.), bottom.clamp(0., 1.)),
    );
    if rect.w == 0.
        || rect.h == 0.
        || !(rect.x..=rect.x + rect.w).contains(&(x / w))
        || !(rect.y..=rect.y + rect.h).contains(&(y / h))
    {
        return None;
    }
    let tag: String = desc["node"]["localName"]
        .as_str()?
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    Some((format!("Element: <{tag}>"), rect))
}

fn crop_png(still: Option<Arc<Image>>, rect: Option<Rect>) -> Option<Vec<u8>> {
    let bytes = still?;
    let picture =
        image::load_from_memory_with_format(&bytes.bytes, image::ImageFormat::Png).ok()?;
    let (x, y, w, h) = rect?.pixels(picture.width(), picture.height())?;
    let mut out = std::io::Cursor::new(Vec::new());
    picture
        .crop_imm(x, y, w, h)
        .write_to(&mut out, image::ImageFormat::Png)
        .ok()?;
    Some(out.into_inner())
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
            s.set_placeholder("Describe what to change", window, cx)
        });
        // The actual browser stays painted until a capture is ready.
        self.browser_pick = Some(Pick {
            thread: thread.id,
            loads: page.loads(),
            address: page.address(),
            title: page.title(),
            page: page.clone(),
            still: None,
            bounds: Rc::default(),
            drag: None,
            rect: None,
            element,
            locating: false,
            committing: false,
            target: None,
            comment,
            keep_image: true,
        });
        let ticket = self.browser_pick.as_ref().map(|p| p.bounds.clone());
        cx.spawn(async move |this, cx| {
            let picture = freeze(&page, cx).await;
            let _ = this.update(cx, |this, cx| {
                let Some(pick) = this
                    .browser_pick
                    .as_mut()
                    .filter(|p| ticket.as_ref().is_some_and(|t| Rc::ptr_eq(&p.bounds, t)))
                else {
                    return;
                };
                if let Some(picture) = picture {
                    pick.still = Some(picture);
                } else {
                    this.browser_pick = None;
                    this.browser_note_error =
                        Some("Couldn't capture the page. Try again after it loads.");
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn cancel_browser_note(&mut self) {
        self.browser_pick = None;
        self.browser_note_error = None;
    }

    #[cfg(feature = "automation")]
    pub(crate) fn browser_note_dump(&self, thread: &str) -> Value {
        let Some(pick) = self
            .browser_pick
            .as_ref()
            .filter(|pick| pick.thread == thread)
        else {
            return Value::Null;
        };
        let b = pick.bounds.get();
        json!({
            "ready": pick.still.is_some(),
            "target": pick.target,
            "bounds": [f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height)],
        })
    }

    fn browser_select(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(pick) = self.browser_pick.as_mut() else {
            return;
        };
        if pick.locating || pick.committing || pick.target.is_some() {
            return;
        }
        let point = pick.point(position);
        let Some(start) = pick.drag.take() else {
            return;
        };
        if !pick.element {
            let rect = Rect::between(start, point);
            if rect.w < 0.005 || rect.h < 0.005 {
                pick.rect = None;
            } else {
                pick.target = Some("Selected region".to_owned());
                pick.rect = Some(rect);
            }
            cx.notify();
            return;
        }
        let Some(still) = pick.still.as_ref() else {
            return;
        };
        let (w, h) = (still.width, still.height);
        let page = pick.page.clone();
        let ticket = pick.bounds.clone();
        pick.locating = true;
        cx.spawn(async move |this, cx| {
            let element = find_element(&page, point.0 * w, point.1 * h, w, h, cx).await;
            let _ = this.update(cx, |this, cx| {
                let Some(pick) = this
                    .browser_pick
                    .as_mut()
                    .filter(|p| Rc::ptr_eq(&p.bounds, &ticket))
                else {
                    return;
                };
                pick.locating = false;
                if let Some((target, rect)) = element {
                    pick.target = Some(target);
                    pick.rect = Some(rect);
                } else {
                    pick.element = false;
                    this.browser_note_error =
                        Some("That element couldn't be selected. Drag a region instead.");
                }
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
        if !self
            .browser_pick
            .as_ref()
            .is_some_and(|p| p.valid(&thread.id, cx) && !p.committing)
        {
            return;
        }
        let Some(pick) = self.browser_pick.as_mut() else {
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
        let still = pick
            .still
            .as_ref()
            .filter(|_| pick.keep_image)
            .map(|s| s.preview.clone());
        let wants_image = still.is_some();
        let rect = pick.rect;
        let ticket = pick.bounds.clone();
        let client = self.client.clone();
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let composer = app.update(cx, |app, cx| app.composer_for(&thread.id, window, cx));
        pick.committing = true;
        cx.spawn(async move |this, cx| {
            if wants_image {
                let staged = cx
                    .background_executor()
                    .spawn(async move {
                        let bytes = crop_png(still, rect)?;
                        crate::composer::stage_private(
                            &crate::composer::paste_base(),
                            "page-comment.png",
                            &bytes,
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
                if this
                    .browser_pick
                    .as_ref()
                    .is_some_and(|p| Rc::ptr_eq(&p.bounds, &ticket))
                {
                    this.browser_pick = None;
                    if failed {
                        this.browser_note_error = Some("The comment was added without an image.");
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn render_browser_note(
        &mut self,
        thread: &str,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self
            .browser_pick
            .as_ref()
            .is_some_and(|p| !p.valid(thread, cx))
        {
            self.cancel_browser_note();
        }
        let pick = self.browser_pick.as_ref()?;
        let still = pick.still.as_ref()?;
        let p = palette(cx);
        let bounds = pick.bounds.clone();
        let down = cx.listener(|this, event: &MouseDownEvent, _, cx| {
            if let Some(pick) = this
                .browser_pick
                .as_mut()
                .filter(|p| p.target.is_none() && !p.locating)
            {
                pick.drag = Some(pick.point(event.position));
                pick.rect = None;
                cx.notify();
            }
        });
        let moved = cx.listener(|this, event: &MouseMoveEvent, _, cx| {
            if let Some(pick) = this.browser_pick.as_mut().filter(|p| !p.element) {
                if let Some(start) = pick.drag {
                    pick.rect = Some(Rect::between(start, pick.point(event.position)));
                    cx.notify();
                }
            }
        });
        let up = cx
            .listener(|this, event: &MouseUpEvent, _, cx| this.browser_select(event.position, cx));
        let selected = pick.rect;
        let view = div()
            .id("browser-note-still")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .cursor(CursorStyle::Crosshair)
            .child(
                img(crate::fit_picture::bytes_source(still.preview.clone()))
                    .size_full()
                    .object_fit(ObjectFit::Fill),
            )
            .child(
                canvas(
                    move |bounds_at, _, _| {
                        bounds.set(bounds_at);
                        bounds_at
                    },
                    move |b, _, window, _| {
                        if let Some(r) = selected {
                            let area = Bounds::new(
                                b.origin
                                    + point(b.size.width * r.x as f32, b.size.height * r.y as f32),
                                size(b.size.width * r.w as f32, b.size.height * r.h as f32),
                            );
                            window.paint_quad(fill(area, p.accent.opacity(0.30)));
                        }
                    },
                )
                .absolute()
                .inset_0(),
            )
            .on_mouse_down(MouseButton::Left, down)
            .on_mouse_move(moved)
            .on_mouse_up(MouseButton::Left, up);
        let cancel = cx.listener(|this, _: &ClickEvent, _, cx| {
            this.cancel_browser_note();
            cx.notify();
        });
        let attach =
            cx.listener(|this, _: &ClickEvent, window, cx| this.attach_browser_note(window, cx));
        let image = cx.listener(|this, _: &ClickEvent, _, cx| {
            if let Some(pick) = &mut this.browser_pick {
                pick.keep_image = !pick.keep_image;
                cx.notify();
            }
        });
        let mut controls = h_flex().gap(px(5.)).child(
            PushButton::new("browser-note-cancel", "Cancel", "Cancel page comment")
                .small()
                .render(cx, cancel),
        );
        let summary = pick.target.as_deref().unwrap_or(if pick.locating {
            "Finding the element…"
        } else if pick.element {
            "Click an element to mark it."
        } else {
            "Drag over the area to mark."
        });
        let mut editor = v_flex()
            .p(px(6.))
            .gap(px(4.))
            .child(div().text_color(p.secondary).child(summary.to_owned()));
        if pick.target.is_some() {
            controls = controls
                .child(
                    PushButton::new(
                        "browser-note-image",
                        if pick.keep_image {
                            "Skip image"
                        } else {
                            "Include image"
                        },
                        "Choose whether the cutout is attached",
                    )
                    .small()
                    .disabled(pick.committing)
                    .render(cx, image),
                )
                .child(
                    PushButton::new(
                        "browser-note-add",
                        "Add to draft",
                        "Attach to this thread's draft",
                    )
                    .small()
                    .busy(pick.committing)
                    .render(cx, attach),
                );
            editor = editor.child(Input::new(&pick.comment).small().disabled(pick.committing));
        }
        Some(
            v_flex()
                .size_full()
                .child(view)
                .child(editor.child(controls))
                .into_any_element(),
        )
    }
}
