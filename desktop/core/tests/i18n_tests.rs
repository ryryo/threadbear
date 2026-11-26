use threadbear_core::i18n::{interpolate, LanguageSetting, Locale};

#[test]
fn follows_the_first_supported_system_language() {
    assert_eq!(
        LanguageSetting::System.resolve(["zh-Hant", "ja-JP", "en-US"]),
        Locale::Japanese
    );
    assert_eq!(
        LanguageSetting::System.resolve([" EN_us ", "ja"]),
        Locale::English
    );
    assert_eq!(
        LanguageSetting::System.resolve(["zh-Hant", "unknown"]),
        Locale::English
    );
    assert_eq!(LanguageSetting::Japanese.resolve(["en"]), Locale::Japanese);
    assert_eq!(LanguageSetting::English.resolve(["ja"]), Locale::English);
    assert_eq!(
        LanguageSetting::parse("unknown").unwrap_or_default(),
        LanguageSetting::System
    );
}

#[test]
fn fallback_and_formatting_preserve_english_and_caller_data() {
    assert_eq!(
        Locale::Japanese.message("Never translated", "Never translated"),
        "Never translated"
    );
    assert_eq!(Locale::English.message("General", "General"), "General");
    assert_eq!(
        interpolate(
            "{name} / {pid} / {missing}",
            &[("name", &"{pid}"), ("pid", &12345)]
        ),
        "{pid} / 12345 / {missing}"
    );
    assert_eq!(
        threadbear_core::trn!("{count} thread", "{count} threads", 1),
        "1 thread"
    );
    assert_eq!(
        threadbear_core::trn!("{count} thread", "{count} threads", 12345),
        "12345 threads"
    );
}

#[test]
fn japanese_catalog_resolves_context_and_unmarked_input_can_stay_english() {
    assert_eq!(Locale::Japanese.message("General", "General"), "一般");
    assert_eq!(
        Locale::Japanese.message("closes a window\u{4}Close", "Close"),
        "閉じる"
    );
    assert_eq!(Locale::Japanese.message("Close", "Close"), "Close");
}
