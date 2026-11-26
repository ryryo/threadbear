// Language is a desktop setting, independent of the runner and its protocol.
use crate::settings::Saved;
use threadbear_core::i18n::{set_locale, LanguageSetting};

pub(crate) fn selection(saved: &Saved) -> LanguageSetting {
    saved
        .language
        .as_deref()
        .and_then(LanguageSetting::parse)
        .unwrap_or_default()
}

pub(crate) fn apply_saved(saved: &Saved) -> bool {
    let override_language = std::env::var("THREADBEAR_LANGUAGE")
        .ok()
        .as_deref()
        .and_then(LanguageSetting::parse);
    let language = override_language.unwrap_or_else(|| {
        if crate::scripted::scripted()
            && saved
                .language
                .as_deref()
                .and_then(LanguageSetting::parse)
                .is_none()
        {
            LanguageSetting::English
        } else {
            selection(saved)
        }
    });
    apply(language)
}

pub(crate) fn apply(language: LanguageSetting) -> bool {
    let locale = if language == LanguageSetting::System {
        language.resolve(system_languages())
    } else {
        language.resolve(std::iter::empty::<&str>())
    };
    set_locale(locale)
}

#[cfg(target_os = "macos")]
fn system_languages() -> Vec<String> {
    objc2_foundation::NSLocale::preferredLanguages()
        .iter()
        .map(|language| language.to_string())
        .collect()
}

#[cfg(target_os = "windows")]
fn system_languages() -> Vec<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserPreferredUILanguages(
            flags: u32,
            count: *mut u32,
            names: *mut u16,
            size: *mut u32,
        ) -> i32;
    }
    const LANGUAGE_NAME: u32 = 0x8;
    let mut count = 0;
    let mut size = 0;
    // SAFETY: a null buffer queries the required size in UTF-16 units.
    let found = unsafe {
        GetUserPreferredUILanguages(LANGUAGE_NAME, &mut count, std::ptr::null_mut(), &mut size)
    };
    if found == 0 || size == 0 {
        return Vec::new();
    }
    let mut names = vec![0; size as usize];
    // SAFETY: names has the capacity reported by Windows and size describes
    // that buffer. The returned names are separated and terminated by NUL.
    let found = unsafe {
        GetUserPreferredUILanguages(LANGUAGE_NAME, &mut count, names.as_mut_ptr(), &mut size)
    };
    if found == 0 {
        return Vec::new();
    }
    names
        .split(|&unit| unit == 0)
        .take_while(|name| !name.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_languages() -> Vec<String> {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| !value.is_empty());
    if matches!(locale.as_deref(), Some("C" | "POSIX")) {
        return Vec::new();
    }
    let languages = std::env::var("LANGUAGE").unwrap_or_default();
    languages
        .split(':')
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .chain(locale)
        .collect()
}
