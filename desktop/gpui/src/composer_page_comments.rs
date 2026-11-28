// An annotation has one inline token. The editor owns its position and Undo;
// its payload is kept here for as long as Undo can make the token active.
use crate::browser_notes::PageNote;
use crate::composer::{Composer, RestoreDraft};
use crate::style::{self, px, size};
use crate::tips::Tip as _;
use gpui_kit::component::input::{InlineToken, InlineTokenContext, InputContent};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use threadbear_core::composer::{draft_words, PICTURE_MARK, PICTURE_MARK_STR};
use threadbear_core::inline_chips::draft_with_page_comments;
use threadbear_core::page_comments::PageCommentRef;
use threadbear_core::reducer::ImageRef;
use threadbear_core::tr;

pub(crate) fn is_comment_token(id: &SharedString) -> bool {
    id.starts_with("page-comment-")
}

pub(crate) fn with_comment_tokens(
    content: InputContent,
    mut comments: Vec<(usize, InlineToken)>,
) -> InputContent {
    let text = content.text().as_ref();
    for (offset, _) in &mut comments {
        if !text.is_char_boundary(*offset) {
            *offset = text.len();
        }
        if let Some(span) = content.tokens().iter().find(|span| {
            let range = span.range();
            range.start < *offset && *offset < range.end
        }) {
            *offset = span.range().end;
        }
    }
    // Stable: comments saved at the same offset are in document order.
    comments.sort_by_key(|(offset, _)| *offset);
    let mut words = String::with_capacity(text.len() + comments.len() * PICTURE_MARK_STR.len());
    let mut ranges = Vec::new();
    let mut at = 0;
    let mut original = content.tokens().iter().peekable();
    for (offset, token) in comments {
        while let Some(span) = original.next_if(|span| span.range().start < offset) {
            let range = span.range();
            words.push_str(&text[at..range.start]);
            let start = words.len();
            words.push_str(&text[range.clone()]);
            ranges.push((start..words.len(), span.token().clone()));
            at = range.end;
        }
        words.push_str(&text[at..offset]);
        let start = words.len();
        words.push_str(PICTURE_MARK_STR);
        ranges.push((start..words.len(), token));
        at = offset;
    }
    for span in original {
        let range = span.range();
        words.push_str(&text[at..range.start]);
        let start = words.len();
        words.push_str(&text[range.clone()]);
        ranges.push((start..words.len(), span.token().clone()));
        at = range.end;
    }
    words.push_str(&text[at..]);
    let mut content = InputContent::new(words);
    for (range, token) in ranges {
        if let Ok(with_token) = content.clone().with_token(range, token) {
            content = with_token;
        }
    }
    content
}

pub(crate) struct ExpandedComments {
    pub(crate) text: String,
    pub(crate) images: Vec<ImageRef>,
    references: Vec<PageCommentRef>,
}

impl ExpandedComments {
    pub(crate) fn sent(self, first: usize) -> (String, Vec<ImageRef>, Vec<PageCommentRef>) {
        self.resolve(first, true)
    }

    pub(crate) fn for_clipboard(self) -> (String, Vec<ImageRef>, Vec<PageCommentRef>) {
        self.resolve(1, false)
    }

    fn resolve(self, first: usize, sending: bool) -> (String, Vec<ImageRef>, Vec<PageCommentRef>) {
        use threadbear_core::composer::{message_text, sent_text};
        let (text, images, mut refs) = (self.text, self.images, self.references);
        let formatted = if sending {
            sent_text(&text, first)
        } else {
            message_text(&text, first)
        };
        let display = if sending {
            formatted.trim()
        } else {
            &formatted
        };
        let start = formatted.len()
            - if sending {
                formatted.trim_start().len()
            } else {
                formatted.len()
            };

        for reference in &mut refs {
            for range in [
                &mut reference.block,
                &mut reference.title,
                &mut reference.url,
                &mut reference.target,
                &mut reference.comment,
            ] {
                for offset in range {
                    *offset = threadbear_core::composer::message_text(&text[..*offset], first)
                        .len()
                        .saturating_sub(start)
                        .min(display.len());
                }
            }
        }
        (display.to_owned(), images, refs)
    }
}

pub(crate) fn expand_comments(
    text: &str,
    mut images: impl Iterator<Item = ImageRef>,
    notes: &[PageNote],
    image_prefix: usize,
) -> ExpandedComments {
    let mut words = String::new();
    let mut attachments = Vec::new();
    let mut references = Vec::new();
    let mut at = 0;
    for note in notes {
        let offset = note
            .offset
            .filter(|&n| n >= at && text.is_char_boundary(n))
            .unwrap_or(text.len());
        let before = &text[at..offset];
        words.push_str(before);
        attachments.extend(images.by_ref().take(before.matches(PICTURE_MARK).count()));
        if !words.is_empty() {
            words.push_str("\n\n");
        }
        let start = words.len();
        words.push_str("Page comment on ");
        let add = |words: &mut String, field: &str| {
            let start = words.len();
            words.push_str(field);
            [start, words.len()]
        };
        let title = add(&mut words, &draft_words(&note.title));
        words.push('\n');
        let url = add(&mut words, &draft_words(&note.url));
        words.push('\n');
        let target = add(&mut words, &draft_words(&note.target));
        let comment_text = draft_words(&note.comment);
        if !comment_text.is_empty() {
            words.push('\n');
        }
        let comment = add(&mut words, &comment_text);
        let image = note.image().map(|image| {
            words.push(' ');
            words.push(PICTURE_MARK);
            let index = image_prefix + attachments.len();
            attachments.push(image);
            index
        });
        references.push(PageCommentRef {
            block: [start, words.len()],
            title,
            url,
            target,
            comment,
            image,
        });
        if offset < text.len() {
            words.push_str("\n\n");
        }
        at = offset;
    }
    words.push_str(&text[at..]);
    attachments.extend(images);
    ExpandedComments {
        text: words,
        images: attachments,
        references,
    }
}

// Reconstruct the original inline references when an edited or held message
// goes back into a composer; the fallback prose is kept for older readers.
pub(crate) fn draft_from_sent(
    text: &str,
    images: &[ImageRef],
    refs: &[PageCommentRef],
) -> RestoreDraft {
    use threadbear_core::composer::{draft_words, edit_draft, picture_markers};
    let plain = || {
        let (text, order) = edit_draft(text, images.len());
        RestoreDraft::plain(
            text,
            order
                .into_iter()
                .filter_map(|i| images.get(i).cloned())
                .collect(),
        )
    };
    if refs.is_empty() {
        return plain();
    }
    let mut words = String::new();
    let mut notes = Vec::new();
    let mut used = std::collections::HashSet::new();
    let mut at = 0;
    for reference in refs {
        let [start, end] = reference.block;
        let Some(comment) = reference.fields(text, images.len()).filter(|_| start >= at) else {
            return plain();
        };
        let before = &text[at..start];
        words.push_str(&draft_words(before.strip_suffix("\n\n").unwrap_or(before)));
        let image = comment.image.and_then(|index| {
            used.insert(index);
            images.get(index).map(crate::composer::image_ref_json)
        });
        notes.push(PageNote {
            id: String::new(),
            offset: Some(words.len()),
            url: comment.url,
            title: comment.title,
            target: comment.target,
            comment: comment.comment,
            image,
        });
        at = if text[end..].starts_with("\n\n") {
            end + 2
        } else {
            end
        };
    }
    words.push_str(&draft_words(&text[at..]));
    let placed = picture_markers(&words, images.len());
    for (range, _) in placed.iter().rev() {
        let shrink = range.len() - PICTURE_MARK_STR.len();
        for offset in notes.iter_mut().filter_map(|n| n.offset.as_mut()) {
            if *offset >= range.end {
                *offset -= shrink;
            }
        }
        words.replace_range(range.clone(), PICTURE_MARK_STR);
    }
    used.extend(placed.iter().map(|(_, index)| *index));
    let missing = (0..images.len())
        .filter(|i| !used.contains(i))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        let mut prefix = PICTURE_MARK_STR.repeat(missing.len());
        prefix.push(' ');
        for offset in notes.iter_mut().filter_map(|n| n.offset.as_mut()) {
            *offset += prefix.len();
        }
        words.insert_str(0, &prefix);
    }
    let mut restore = RestoreDraft::plain(
        words,
        missing
            .into_iter()
            .chain(placed.into_iter().map(|(_, i)| i))
            .filter_map(|i| images.get(i).cloned())
            .collect(),
    );
    restore.page_notes = notes;
    restore
}

impl Composer {
    pub(crate) fn page_comment(&self, id: &str) -> Option<&PageNote> {
        self.page_notes.iter().find(|note| note.id == id)
    }

    fn register_comment(&mut self, mut note: PageNote) -> InlineToken {
        note.identify();
        let token = InlineToken::new(note.id.clone(), PICTURE_MARK_STR).with_label(note.label());
        if self.page_comment(&note.id).is_none() {
            self.page_notes.push(note);
        }
        token
    }

    pub(crate) fn draft_from_content(&self, content: InputContent) -> RestoreDraft {
        let len = content.text().len();
        self.draft_from_range(content, 0..len)
    }

    pub(crate) fn draft_from_range(
        &self,
        content: InputContent,
        range: std::ops::Range<usize>,
    ) -> RestoreDraft {
        let text = content.text().as_ref();
        let tokens = self.serialized_tokens(content.tokens());
        let buffer = draft_with_page_comments(text, &tokens, range);
        let mut draft = RestoreDraft::plain(buffer.text, buffer.images);
        draft.page_notes = buffer
            .page_comments
            .into_iter()
            .filter_map(|(id, offset)| {
                let mut note = self.page_comment(&id)?.clone();
                note.offset = Some(offset);
                Some(note)
            })
            .collect();
        draft
    }

    pub(crate) fn comment_content(
        &mut self,
        base: InputContent,
        notes: Vec<PageNote>,
    ) -> InputContent {
        if notes.is_empty() {
            return base;
        }
        let end = base.text().len();
        let comments = notes
            .into_iter()
            .map(|note| {
                let offset = note.offset.unwrap_or(end);
                (offset, self.register_comment(note))
            })
            .collect();
        with_comment_tokens(base, comments)
    }

    fn page_note_position(&self, cx: &App) -> usize {
        let (content, end) = if let Some(saved) = self
            .editing
            .as_ref()
            .map(|edit| &edit.before)
            .or(self.pending_saved.as_ref())
        {
            (saved.content.clone(), saved.selection.end)
        } else {
            let input = self.input.read(cx);
            (input.content(), input.selected_range().end)
        };
        self.draft_from_range(content, 0..end).text.len()
    }

    pub(crate) fn begin_page_note(&mut self, mut note: PageNote, cx: &mut Context<Self>) {
        note.offset = Some(self.page_note_position(cx));
        self.capturing_page_comments.push(note);
        self.send_context_revision = self.send_context_revision.wrapping_add(1);
        cx.notify();
    }

    pub(crate) fn finish_page_note_capture(&mut self, id: &str) {
        self.capturing_page_comments.retain(|note| note.id != id);
    }

    pub(crate) fn queue_page_note(&mut self, mut note: PageNote, cx: &mut Context<Self>) {
        note.offset = Some(self.page_note_position(cx));
        self.pending_page_comments.push(note);
        self.send_context_revision = self.send_context_revision.wrapping_add(1);
        cx.notify();
    }

    pub(crate) fn add_page_note(
        &mut self,
        note: PageNote,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.insert_page_note(&note, window, cx) {
            self.queue_page_note(note, cx);
            return false;
        }
        self.send_context_revision = self.send_context_revision.wrapping_add(1);
        true
    }

    fn insert_page_note(
        &mut self,
        note: &PageNote,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.editing.is_some()
            || self.pending_saved.is_some()
            || self.restore.is_some()
            || self.input.read(cx).has_composition()
        {
            return false;
        }
        let token = InlineToken::new(note.id.clone(), PICTURE_MARK_STR).with_label(note.label());
        let result = self.input.update(cx, |input, cx| {
            let offset = input.selected_range().end;
            input.replace_range_with_token(offset..offset, token, window, cx)
        });
        if result.is_ok() {
            self.page_notes.push(note.clone());
            cx.notify();
        }
        result.is_ok()
    }

    pub(crate) fn place_pending_page_comments(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut moved = false;
        for note in std::mem::take(&mut self.pending_page_comments) {
            if self.insert_page_note(&note, window, cx) {
                moved = true;
            } else {
                self.pending_page_comments.push(note);
            }
        }
        if moved {
            self.page_notes_changed(cx);
        }
    }

    pub(crate) fn render_page_comment_chip(
        &self,
        ctx: &InlineTokenContext,
        cx: &App,
    ) -> AnyElement {
        h_flex()
            .id(ElementId::Name(ctx.token().id().clone()))
            .h(px(size::CHIP_HEIGHT))
            .items_center()
            .gap(px(5.))
            .px(px(6.))
            .rounded(px(6.))
            .border_1()
            .border_color(if ctx.is_selected() {
                style::accent(cx)
            } else {
                style::hairline(cx)
            })
            .bg(style::chip_fill(cx))
            .child(crate::icons::symbol("cursorarrow.click").size(px(13.)))
            .child(
                div()
                    .max_w(px(230.))
                    .truncate()
                    .text_size(px(13.))
                    .child(ctx.token().label().clone()),
            )
            .tip(tr!("Show page comment"))
            .into_any_element()
    }

    pub(crate) fn show_page_comment(
        &mut self,
        id: &SharedString,
        bounds: Bounds<Pixels>,
        cx: &mut Context<Self>,
    ) {
        self.open_page_comment = if self
            .open_page_comment
            .as_ref()
            .is_some_and(|(open, _)| open == id)
        {
            None
        } else {
            Some((id.clone(), bounds))
        };
        cx.notify();
    }

    pub(crate) fn render_page_comment_detail(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (id, bounds) = self.open_page_comment.as_ref()?;
        if !self
            .input
            .read(cx)
            .tokens()
            .iter()
            .any(|span| span.token().id() == id)
        {
            return None;
        }
        let note = self.page_comment(id)?;
        let image = note.image();
        let remove = cx.listener({
            let id = id.clone();
            move |this, _: &ClickEvent, _, cx| {
                if let Some(note) = this
                    .page_notes
                    .iter_mut()
                    .find(|note| note.id == id.as_ref())
                {
                    note.image = None;
                    this.send_context_revision = this.send_context_revision.wrapping_add(1);
                    this.page_notes_changed(cx);
                }
            }
        });
        let crop = image
            .as_ref()
            .map_or_else(missing_crop, |image| comment_crop(&image.path));
        let card = comment_detail(
            &note.comment,
            &note.title,
            &note.url,
            &note.target,
            Some(crop),
            cx,
        )
        .when(image.is_some(), |card| {
            card.child(
                crate::push_button::PushButton::new(
                    "page-comment-delete-image",
                    tr!("Remove picture"),
                    tr!("Remove picture from page comment"),
                )
                .small()
                .render(cx, remove),
            )
        });
        Some(
            deferred(
                anchored()
                    .position(bounds.origin)
                    .anchor(Anchor::BottomLeft)
                    .snap_to_window()
                    .offset(point(px(0.), px(-5.)))
                    .child(card),
            )
            .with_priority(2)
            .into_any_element(),
        )
    }
}

pub(crate) fn comment_crop(path: &str) -> AnyElement {
    img(crate::rows::markdown::file_picture(path))
        .max_w(px(275.))
        .max_h(px(180.))
        .object_fit(ObjectFit::Contain)
        .into_any_element()
}

pub(crate) fn missing_crop() -> AnyElement {
    div()
        .text_size(px(11.))
        .child(tr!("No image attached"))
        .into_any_element()
}

pub(crate) fn comment_detail(
    comment: &str,
    title: &str,
    url: &str,
    target: &str,
    crop: Option<AnyElement>,
    cx: &App,
) -> Stateful<Div> {
    v_flex()
        .id("page-comment-detail")
        .w(px(295.))
        .max_h(px(400.))
        .overflow_y_scroll()
        .occlude()
        .gap(px(6.))
        .p(px(10.))
        .rounded(px(8.))
        .border_1()
        .border_color(style::hairline(cx))
        .bg(cx.theme().popover)
        .shadow_lg()
        .children(crop)
        .child(div().text_size(px(13.)).child(comment.to_owned()))
        .child(div().text_size(px(12.)).child(title.to_owned()))
        .child(
            div()
                .text_size(px(11.))
                .text_color(style::secondary_label(cx))
                .child(url.to_owned()),
        )
        .child(div().text_size(px(12.)).child(target.to_owned()))
}

#[cfg(feature = "automation")]
impl Composer {
    pub(crate) fn dump_page_comments(&self, out: &mut serde_json::Value, cx: &App) {
        use serde_json::json;
        let input = self.input.read(cx);
        let draft = self.draft_from_content(input.content());
        let details = |note: &PageNote| {
            let bounds = input
                .tokens()
                .iter()
                .find(|span| span.token().id().as_ref() == note.id)
                .and_then(|span| input.range_to_bounds(&span.range()))
                .map(|b| {
                    [
                        f32::from(b.origin.x),
                        f32::from(b.origin.y),
                        f32::from(b.size.width),
                        f32::from(b.size.height),
                    ]
                });
            json!({
                "bounds": bounds,
                "offset": note.offset,
                "title": note.title,
                "target": note.target,
                "comment": note.comment,
                "image": note.image().is_some(),
            })
        };
        if !draft.page_notes.is_empty() {
            out["words"] = json!(draft.text);
            out["pageComments"] = json!(draft.page_notes.iter().map(details).collect::<Vec<_>>());
        }
        if let Some(note) = self
            .open_page_comment
            .as_ref()
            .and_then(|(id, _)| draft.page_notes.iter().find(|note| note.id == id.as_ref()))
        {
            let mut detail = details(note);
            detail["crop"] = note.image()
                .and_then(|attachment| image::open(&attachment.path).ok())
                .map(|image| {
                    use image::GenericImageView as _;
                    let (width, height) = image.dimensions();
                    json!({"width": width, "height": height, "pixel": image.get_pixel(width / 8, height / 8).0})
                })
                .unwrap_or_default();
            out["pageCommentDetail"] = detail;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        draft_from_sent, expand_comments, ImageRef, PageNote, RestoreDraft, PICTURE_MARK,
        PICTURE_MARK_STR,
    };

    fn image(path: &str) -> ImageRef {
        ImageRef::decode(&serde_json::json!({"path": path, "mediaType": "image/png"})).unwrap()
    }

    fn note(comment: &str, offset: usize, image: Option<&ImageRef>) -> PageNote {
        PageNote {
            id: String::new(),
            offset: Some(offset),
            url: "https://example.org".to_owned(),
            title: "頁".to_owned(),
            target: "Element: <a>".to_owned(),
            comment: comment.to_owned(),
            image: image.map(crate::composer::image_ref_json),
        }
    }

    #[test]
    fn sent_reference_recovers_its_place_and_picture_in_unicode_text() {
        let other = image("/tmp/first.png");
        let cutout = image("/tmp/cutout.png");
        let note_at = "前 \u{fffc} ".len();
        let text = "前 \u{fffc} 後";
        let original = [note("注釈🦊", note_at, Some(&cutout))];
        let (wire, images, references) =
            expand_comments(text, [other.clone()].into_iter(), &original, 0).sent(1);
        assert!(references[0].valid(&wire, 2));
        assert_eq!(references[0].image, Some(1));
        assert_eq!(images, vec![other.clone(), cutout.clone()]);
        let restored = draft_from_sent(&wire, &images, &references);
        assert_eq!(restored.text, text);
        assert_eq!(restored.images, vec![other]);
        assert_eq!(restored.page_notes[0].offset, Some(note_at));
        assert_eq!(restored.page_notes[0].comment, "注釈🦊");
        assert_eq!(restored.page_notes[0].image(), Some(cutout));
    }

    #[test]
    fn web_text_does_not_number_its_own_picture_marks() {
        let crop = image("/tmp/cutout.png");
        let mut selected = note(PICTURE_MARK_STR, 0, Some(&crop));
        selected.title = format!("Page{PICTURE_MARK}");
        let (wire, images, references) =
            expand_comments("", std::iter::empty(), &[selected], 0).sent(1);
        assert_eq!(images, vec![crop]);
        assert_eq!(references[0].image, Some(0));
        assert!(references[0].valid(&wire, 1));
        assert_eq!(wire.matches("[Picture 1]").count(), 1);
        assert!(!wire.contains("[Picture 2]"));
    }

    #[test]
    fn annotations_at_one_position_keep_submission_order_and_allow_empty_text() {
        let notes = [note("", 0, None), note("次", 0, None)];
        let (wire, images, refs) = expand_comments("後", std::iter::empty(), &notes, 0).sent(1);
        assert!(refs.iter().all(|r| r.valid(&wire, 0)));
        let restored = draft_from_sent(&wire, &images, &refs);
        assert_eq!(restored.text, "後");
        let restored = restored
            .page_notes
            .iter()
            .map(|n| (n.offset, n.comment.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(restored, [(Some(0), ""), (Some(0), "次")]);
    }

    #[test]
    fn legacy_notes_and_held_drafts_use_their_own_offsets_when_joined() {
        let old = serde_json::from_value::<PageNote>(serde_json::json!({
            "title":"旧", "url":"https://example.org", "target":"Selected region", "comment":"移行", "image":null
        })).unwrap();
        assert_eq!(old.offset, None);
        let mut first = RestoreDraft::plain("待機".into(), Vec::new());
        first.page_notes.push(old);
        let mut then = RestoreDraft::plain(String::new(), Vec::new());
        then.page_notes.push(note("後の指摘", 0, None));
        let combined = RestoreDraft::joined(first, then);
        assert_eq!(combined.text, "待機\n\n");
        assert_eq!(combined.page_notes[0].offset, Some("待機".len()));
        assert_eq!(combined.page_notes[1].offset, Some("待機\n\n".len()));
    }
}
