// Sent browser annotations carry display ranges into their readable fallback
// text. The same text and images go to old clients and to the agent.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageCommentRef {
    pub block: [usize; 2],
    pub title: [usize; 2],
    pub url: [usize; 2],
    pub target: [usize; 2],
    pub comment: [usize; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<usize>,
}

pub const MAX_PAGE_COMMENTS: usize = 64;

impl PageCommentRef {
    pub fn decode(value: &Value, text: &str, images: usize) -> Vec<Self> {
        let Some(refs) = value.as_array().filter(|a| a.len() <= MAX_PAGE_COMMENTS) else {
            return Vec::new();
        };
        let mut current = 0;
        let mut output = Vec::with_capacity(refs.len());
        for value in refs {
            let Ok(reference) = serde_json::from_value::<Self>(value.clone()) else {
                return Vec::new();
            };
            if !reference.valid(text, images) || reference.block[0] < current {
                return Vec::new();
            }
            current = reference.block[1];
            output.push(reference);
        }
        output
    }

    pub fn valid(&self, text: &str, images: usize) -> bool {
        let [start, end] = self.block;
        if !text
            .get(start..end)
            .is_some_and(|s| s.starts_with("Page comment on "))
            || self.image.is_some_and(|i| i >= images)
        {
            return false;
        }
        let mut current = start;
        for [from, to] in [self.title, self.url, self.target, self.comment] {
            if from < current || to > end || text.get(from..to).is_none() {
                return false;
            }
            current = to;
        }
        let after_target = if self.comment[0] == self.comment[1] {
            ""
        } else {
            "\n"
        };
        if self.title[0] != start + "Page comment on ".len()
            || &text[self.title[1]..self.url[0]] != "\n"
            || &text[self.url[1]..self.target[0]] != "\n"
            || &text[self.target[1]..self.comment[0]] != after_target
        {
            return false;
        }
        let tail = &text[self.comment[1]..end];
        self.image.map_or_else(
            || tail.is_empty(),
            |image| tail == format!(" [Picture {}]", image + 1),
        )
    }

    pub fn shift(&mut self, from: usize, to: usize) {
        for pair in [
            &mut self.block,
            &mut self.title,
            &mut self.url,
            &mut self.target,
            &mut self.comment,
        ] {
            for offset in pair {
                *offset = *offset - from + to;
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageComment {
    pub title: String,
    pub url: String,
    pub target: String,
    pub comment: String,
    pub image: Option<usize>,
}

impl PageCommentRef {
    pub fn fields(&self, text: &str, image_count: usize) -> Option<PageComment> {
        if !self.valid(text, image_count) {
            return None;
        }
        let field = |[start, end]: [usize; 2]| text[start..end].to_owned();
        Some(PageComment {
            title: field(self.title),
            url: field(self.url),
            target: field(self.target),
            comment: field(self.comment),
            image: self.image,
        })
    }
}

// T3 Code c2fcbd79523e: composerContextRecords.ts, previewAnnotationContextLabel.
pub fn label(comment: &str, title: &str) -> Option<String> {
    let comment = comment.split_whitespace().collect::<Vec<_>>().join(" ");
    if comment.is_empty() {
        let title = title.trim();
        return (!title.is_empty()).then(|| title.to_owned());
    }
    if comment.encode_utf16().count() <= 48 {
        return Some(comment);
    }
    let mut remaining = 47;
    let end = comment
        .char_indices()
        .find_map(|(at, ch)| {
            let units = ch.len_utf16();
            if units > remaining {
                return Some(at);
            }
            remaining -= units;
            None
        })
        .unwrap_or(comment.len());
    Some(format!("{}…", comment[..end].trim_end()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_label_follows_utf16_limit_without_splitting_emoji() {
        let input = format!("{}🦊 tail", "頁".repeat(46));
        assert_eq!(
            label(&input, "").as_deref(),
            Some(format!("{}…", "頁".repeat(46)).as_str())
        );
        assert_eq!(label("  一\n\t二  ", "").as_deref(), Some("一 二"));
        assert_eq!(label(" ", "  Page title  ").as_deref(), Some("Page title"));
    }
}
