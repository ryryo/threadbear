// Compact editor placement from PickPreload.ts at T3 Code c2fcbd79523e.
// Copyright (c) 2026 T3 Tools Inc. MIT, docs/third-party/t3-code-MIT.txt.
use super::live::Anchor;
use gpui_kit::{point, px, Bounds, Pixels, Point, Size};

const GAP: f32 = 8.;

pub(super) fn compact_width(viewport: Size<Pixels>) -> Pixels {
    (viewport.width - px(2. * GAP)).clamp(px(1.), px(360.))
}

pub(super) fn compact_origin(
    page: Bounds<Pixels>,
    anchor: Anchor,
    editor: Size<Pixels>,
) -> Point<Pixels> {
    let vw = f32::from(page.size.width);
    let vh = f32::from(page.size.height);
    let ew = f32::from(editor.width);
    let eh = f32::from(editor.height);
    let left = anchor.x * vw;
    let top = anchor.y * vh;
    let right = (anchor.x + anchor.w) * vw;
    let bottom = (anchor.y + anchor.h) * vh;
    let candidates = [
        (right + GAP, top),
        (left - ew - GAP, top),
        (right - ew, bottom + GAP),
        (right - ew, top - eh - GAP),
    ];
    let overflow = |(x, y): (f32, f32)| {
        (-x).max(0.) + (-y).max(0.) + (x + ew - vw).max(0.) + (y + eh - vh).max(0.)
    };
    let best = candidates
        .into_iter()
        .skip(1)
        .fold(candidates[0], |best, next| {
            if overflow(next) < overflow(best) {
                next
            } else {
                best
            }
        });
    page.origin
        + point(
            px(best.0.clamp(GAP, (vw - ew - GAP).max(GAP))),
            px(best.1.clamp(GAP, (vh - eh - GAP).max(GAP))),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::size;

    #[test]
    fn compact_editor_prefers_the_right_then_the_left() {
        let page = Bounds::new(point(px(40.), px(22.)), size(px(600.), px(400.)));
        let editor = size(px(160.), px(36.));
        let anchor = Anchor {
            x: 0.25,
            y: 0.25,
            w: 0.25,
            h: 0.25,
        };
        assert_eq!(
            compact_origin(page, anchor, editor),
            point(px(348.), px(122.))
        );
        let anchor = Anchor { x: 0.75, ..anchor };
        assert_eq!(
            compact_origin(page, anchor, editor),
            point(px(322.), px(122.))
        );
    }

    #[test]
    fn compact_editor_can_move_above_on_a_narrow_page() {
        let page = Bounds::new(point(px(0.), px(0.)), size(px(200.), px(400.)));
        let editor = size(compact_width(page.size), px(60.));
        let anchor = Anchor {
            x: 0.25,
            y: 0.875,
            w: 0.25,
            h: 0.125,
        };
        assert_eq!(
            compact_origin(page, anchor, editor),
            point(px(8.), px(282.))
        );
    }
}
