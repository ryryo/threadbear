// English source messages and an offline Japanese catalog, following T3 Code's
// resolve-at-display-time and English fallback rules. Keys carry context when
// the same English words need different translations.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LanguageSetting {
    #[default]
    System,
    English,
    Japanese,
}

impl LanguageSetting {
    pub const ALL: [Self; 3] = [Self::System, Self::English, Self::Japanese];

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "system" => Some(Self::System),
            "en" => Some(Self::English),
            "ja" => Some(Self::Japanese),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::English => "en",
            Self::Japanese => "ja",
        }
    }

    pub fn resolve(self, system_languages: impl IntoIterator<Item = impl AsRef<str>>) -> Locale {
        match self {
            Self::English => Locale::English,
            Self::Japanese => Locale::Japanese,
            Self::System => system_languages
                .into_iter()
                .find_map(|tag| Locale::from_tag(tag.as_ref()))
                .unwrap_or_default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Locale {
    #[default]
    English,
    Japanese,
}

static JAPANESE: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../i18n/ja.json")).unwrap_or_default());
static JAPANESE_ACTIVE: AtomicBool = AtomicBool::new(false);

impl Locale {
    pub fn from_tag(tag: &str) -> Option<Self> {
        let primary = tag.trim().split(['-', '_', '.', '@']).next()?;
        if primary.eq_ignore_ascii_case("en") {
            Some(Self::English)
        } else if primary.eq_ignore_ascii_case("ja") {
            Some(Self::Japanese)
        } else {
            None
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::Japanese => "ja",
        }
    }

    pub fn message<'a>(self, key: &str, source: &'a str) -> &'a str {
        match self {
            Self::Japanese => JAPANESE
                .get(key)
                .map(String::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(source),
            Self::English => source,
        }
    }
}

/// The GPUI process uses one display language across its windows. Core and
/// headless callers start in English and can use Locale directly for tests.
pub fn set_locale(locale: Locale) -> bool {
    let japanese = locale == Locale::Japanese;
    JAPANESE_ACTIVE.swap(japanese, Ordering::Relaxed) != japanese
}

pub fn active_locale() -> Locale {
    if JAPANESE_ACTIVE.load(Ordering::Relaxed) {
        Locale::Japanese
    } else {
        Locale::English
    }
}

/// Interpolate the template in one pass, so text supplied as a value cannot
/// be interpreted as another placeholder.
pub fn interpolate(template: &str, variables: &[(&str, &dyn std::fmt::Display)]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(template.len());
    let mut tail = template;
    while let Some(open) = tail.find('{') {
        output.push_str(&tail[..open]);
        tail = &tail[open + 1..];
        if let Some(close) = tail
            .find(['{', '}'])
            .filter(|&i| tail.as_bytes()[i] == b'}')
        {
            let name = &tail[..close];
            if let Some((_, value)) = variables.iter().find(|(key, _)| *key == name) {
                let _ = write!(output, "{value}");
            } else {
                output.push('{');
                output.push_str(&tail[..=close]);
            }
            tail = &tail[close + 1..];
        } else {
            output.push('{');
        }
    }
    output.push_str(tail);
    output
}

#[macro_export]
macro_rules! tr {
    (context $context:literal, $source:literal $(,)?) => {
        $crate::i18n::active_locale().message(concat!($context, "\u{4}", $source), $source)
    };
    ($source:literal $(,)?) => {
        $crate::i18n::active_locale().message($source, $source)
    };
}

#[macro_export]
macro_rules! trf {
    (context $context:literal, $source:literal, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::interpolate(
            $crate::i18n::active_locale().message(concat!($context, "\u{4}", $source), $source),
            &[$((stringify!($name), &$value)),+],
        )
    };
    ($source:literal, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::interpolate(
            $crate::i18n::active_locale().message($source, $source),
            &[$((stringify!($name), &$value)),+],
        )
    };
}

#[macro_export]
macro_rules! trn {
    ($one:literal, $many:literal, $count:expr $(,)?) => {{
        let count = $count;
        let source = if count == 1 { $one } else { $many };
        let message = $crate::i18n::active_locale().message(source, source);
        $crate::i18n::interpolate(message, &[("count", &count)])
    }};
}
