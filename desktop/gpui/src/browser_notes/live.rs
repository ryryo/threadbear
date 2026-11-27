use super::geometry::Rect;
use gpui_kit::{AsyncApp, Image, ImageFormat};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use threadbear_web::PanelPage;

const PICKER: &str = include_str!("picker.js");
static NEXT_PICKER: AtomicU32 = AtomicU32::new(1);

pub(super) struct Capture {
    pub(super) image: Arc<Image>,
    #[cfg(feature = "automation")]
    pub(super) proof: Value,
}

#[derive(Deserialize)]
pub(super) struct Selection {
    target: Option<String>,
    pub(super) anchor: Option<Anchor>,
    #[serde(default)]
    pub(super) moved: bool,
    #[serde(default)]
    pub(super) frame: bool,
    #[serde(default)]
    pub(super) small: bool,
    #[serde(default)]
    pub(super) lost: bool,
}

/// The outline rectangle, in fractions of the visible page.
#[derive(Clone, Copy, Deserialize)]
pub(super) struct Anchor {
    pub(super) x: f32,
    pub(super) y: f32,
    pub(super) w: f32,
    pub(super) h: f32,
}

impl Selection {
    pub(super) fn label(&self) -> Option<String> {
        let target = self.target.as_deref()?;
        if target == "region" {
            return Some("Selected region".to_owned());
        }
        if target.is_empty()
            || target.len() > 64
            || !target
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return None;
        }
        Some(format!("Element: <{target}>"))
    }
}

#[derive(Deserialize, PartialEq)]
struct Stamp {
    view: View,
    rect: CssRect,
    target: String,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct View {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scroll_x: f64,
    scroll_y: f64,
    scale: f64,
    device_pixel_ratio: f64,
}

#[derive(Deserialize, PartialEq)]
struct CssRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Stamp {
    fn rect(&self) -> Option<Rect> {
        let view = &self.view;
        if view.width <= 0. || view.height <= 0. {
            return None;
        }
        let x = (self.rect.x - view.x) / view.width;
        let y = (self.rect.y - view.y) / view.height;
        Some(Rect::between(
            (x, y),
            (
                x + self.rect.width / view.width,
                y + self.rect.height / view.height,
            ),
        ))
    }
}

pub(super) struct LivePicker {
    pub(super) page: Rc<PanelPage>,
    id: u32,
    context: Cell<Option<i64>>,
    stopped: Cell<bool>,
}

impl LivePicker {
    pub(super) fn new(page: Rc<PanelPage>) -> Self {
        Self {
            page,
            id: NEXT_PICKER.fetch_add(1, Ordering::Relaxed),
            context: Cell::new(None),
            stopped: Cell::new(false),
        }
    }

    fn eval_params(&self, expression: String) -> Option<Value> {
        Some(json!({
            "expression": expression,
            "contextId": self.context.get()?,
            "returnByValue": true,
            "awaitPromise": true,
            "silent": true,
        }))
    }

    fn command(&self, command: &str) -> Option<Value> {
        self.eval_params(format!(
            "globalThis.threadbearPicker?.id === {} ? globalThis.threadbearPicker.{command} : null",
            self.id,
        ))
    }

    async fn eval(&self, params: Value, cx: &AsyncApp) -> Option<Value> {
        value(call(&self.page, "Runtime.evaluate", params, cx).await?)
    }

    pub(super) async fn start(&self, element: bool, cx: &AsyncApp) -> Option<()> {
        let frame = call(&self.page, "Page.getFrameTree", json!({}), cx).await?;
        let frame_id = frame["frameTree"]["frame"]["id"].as_str()?;
        let world = call(
            &self.page,
            "Page.createIsolatedWorld",
            json!({"frameId": frame_id, "worldName": "threadbear-picker", "grantUniveralAccess": false}),
            cx,
        )
        .await?;
        self.context.set(world["executionContextId"].as_i64());
        if self.stopped.get() {
            return None;
        }
        let installed = self
            .eval(
                self.eval_params(format!("{PICKER}({}, {element})", self.id))?,
                cx,
            )
            .await;
        if self.stopped.get() || installed != Some(json!(true)) {
            self.stop();
            return None;
        }
        Some(())
    }

    // Only one outstanding listener. It finishes on selection, explicit
    // teardown, or destruction of this specific document's isolated world.
    pub(super) async fn next(&self) -> Option<Selection> {
        let response = self
            .page
            .devtools("Runtime.evaluate", self.command("next()")?)
            .await;
        serde_json::from_value(value(response.ok()?.ok()?)?).ok()
    }

    pub(super) fn stop(&self) {
        self.stopped.set(true);
        if let Some(params) = self.command("stop()") {
            drop(self.page.devtools("Runtime.evaluate", params));
        }
    }

    pub(super) fn resume(&self) {
        if let Some(params) = self.command("resume()") {
            drop(self.page.devtools("Runtime.evaluate", params));
        }
    }

    pub(super) fn switch_mode(&self, element: bool) {
        if let Some(params) = self.command(&format!("switchMode({element})")) {
            drop(self.page.devtools("Runtime.evaluate", params));
        }
    }

    pub(super) async fn capture(&self, cx: &AsyncApp) -> Option<Capture> {
        let before: Stamp =
            serde_json::from_value(self.eval(self.command("prepare()")?, cx).await?).ok()?;
        let picture = call(
            &self.page,
            "Page.captureScreenshot",
            json!({"format": "png", "captureBeyondViewport": false}),
            cx,
        )
        .await?;
        let after: Stamp =
            serde_json::from_value(self.eval(self.command("stamp()")?, cx).await?).ok()?;
        if self.stopped.get() || before != after {
            return None;
        }
        let png = picture["data"].as_str()?;
        if png.len() > 28 * 1024 * 1024 {
            return None;
        }
        let bytes = threadbear_core::folders::base64_decode(png)?;
        let rect = before.rect()?;
        cx.background_executor()
            .spawn(async move { crop(&bytes, rect) })
            .await
    }
}

fn value(mut result: Value) -> Option<Value> {
    (result.get("exceptionDetails").is_none()).then(|| result["result"]["value"].take())
}

async fn call(page: &PanelPage, method: &str, params: Value, cx: &AsyncApp) -> Option<Value> {
    let response = page.devtools(method, params);
    let timeout = cx.background_executor().timer(Duration::from_secs(5));
    futures::pin_mut!(timeout);
    match futures::future::select(response, timeout).await {
        futures::future::Either::Left((Ok(Ok(result)), _)) => Some(result),
        _ => None,
    }
}

fn crop(bytes: &[u8], rect: Rect) -> Option<Capture> {
    use image::{ImageDecoder as _, ImageEncoder as _};
    let mut decoder = image::codecs::png::PngDecoder::new(std::io::Cursor::new(bytes)).ok()?;
    let profile = decoder.icc_profile().ok().flatten();
    let picture = image::DynamicImage::from_decoder(decoder).ok()?;
    let (x, y, w, h) = rect.pixels(picture.width(), picture.height())?;
    let picture = picture.crop_imm(x, y, w, h);
    let mut out = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut out);
    if let Some(profile) = profile {
        encoder.set_icc_profile(profile).ok()?;
    }
    picture.write_with_encoder(encoder).ok()?;
    Some(Capture {
        image: Arc::new(Image::from_bytes(ImageFormat::Png, out)),
        #[cfg(feature = "automation")]
        proof: {
            use image::GenericImageView as _;
            let edge = picture.get_pixel(w / 8, h / 8).0;
            json!({"width": w, "height": h, "pixel": edge})
        },
    })
}
