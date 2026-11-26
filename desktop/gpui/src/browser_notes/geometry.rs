// Crop sizing adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc.
// MIT, docs/third-party/t3-code-MIT.txt (Manager.ts at c2fcbd79523e).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Rect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
}

impl Rect {
    pub(crate) fn between(start: (f64, f64), end: (f64, f64)) -> Self {
        Self {
            x: start.0.min(end.0),
            y: start.1.min(end.1),
            w: (start.0 - end.0).abs(),
            h: (start.1 - end.1).abs(),
        }
    }

    // Like T3 Code, floor the leading edges, ceil the trailing edges, and
    // clamp to the available image. Never substitute an unmarked screenshot.
    pub(crate) fn pixels(self, w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
        let left = (self.x * f64::from(w)).floor().clamp(0., w.into()) as u32;
        let top = (self.y * f64::from(h)).floor().clamp(0., h.into()) as u32;
        let right = ((self.x + self.w) * f64::from(w))
            .ceil()
            .clamp(0., w.into()) as u32;
        let bottom = ((self.y + self.h) * f64::from(h))
            .ceil()
            .clamp(0., h.into()) as u32;
        (right > left && bottom > top).then(|| (left, top, right - left, bottom - top))
    }
}

pub(crate) fn clean_url(url: &str) -> &str {
    // Query parameters and fragments can contain tokens. A page comment only
    // needs the route. Drop URLs with embedded credentials altogether.
    let path = url.split(['?', '#']).next().unwrap_or("");
    let authority = path
        .split_once("://")
        .and_then(|(_, r)| r.split('/').next());
    if authority.is_some_and(|a| a.contains('@')) {
        ""
    } else {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::{clean_url, Rect};
    #[test]
    fn crop_keeps_selected_pixels_and_cannot_fall_back_to_the_full_image() {
        assert_eq!(
            Rect::between((0.51, 0.2), (0.1, 0.8)).pixels(200, 100),
            Some((20, 20, 82, 60))
        );
        assert_eq!(
            Rect {
                x: 2.,
                y: 2.,
                w: 1.,
                h: 1.
            }
            .pixels(200, 100),
            None
        );
    }
    #[test]
    fn page_comment_omits_sensitive_url_parts() {
        assert_eq!(
            clean_url("https://example.test/a?secret=x#y"),
            "https://example.test/a"
        );
        assert_eq!(clean_url("https://login:pass@example.test/a"), "");
    }
}
