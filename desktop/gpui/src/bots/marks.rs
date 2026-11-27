use super::*;
use std::sync::Arc;

#[derive(Clone, Deserialize)]
pub(super) struct RosterMark {
    light: String,
    dark: Option<String>,
}

#[derive(Clone, Default)]
pub(super) struct Pictures {
    photo: Option<Arc<Image>>,
    light: Option<Arc<Image>>,
    dark: Option<Arc<Image>>,
}

fn raster(data_url: &str) -> Option<Arc<Image>> {
    if data_url.len() > 160_000 {
        return None;
    }
    let (kind, data) = data_url.split_once(',')?;
    let format = match kind {
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        "data:image/webp;base64" => ImageFormat::Webp,
        "data:image/gif;base64" => ImageFormat::Gif,
        _ => return None,
    };
    let bytes = threadbear_core::folders::base64_decode(data)?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}

fn svg(mark: &str) -> Option<Arc<Image>> {
    (mark.len() <= 32 * 1024 && mark.starts_with("<svg ")).then(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Svg,
            mark.as_bytes().to_vec(),
        ))
    })
}

fn character(mark: Arc<Image>) -> AnyElement {
    img(crate::fit_picture::file_bytes_source(mark))
        .size(px(18.))
        .object_fit(ObjectFit::Contain)
        .into_any_element()
}

pub(super) fn roster_picture(bot: &Profile, dark: bool) -> Option<AnyElement> {
    let pictures = bot.pictures.get_or_init(|| Pictures {
        photo: bot
            .avatar
            .get("image")
            .and_then(Value::as_str)
            .and_then(raster),
        light: bot.roster_mark.as_ref().and_then(|mark| svg(&mark.light)),
        dark: bot
            .roster_mark
            .as_ref()
            .and_then(|mark| mark.dark.as_deref())
            .and_then(svg),
    });
    let mark = if dark {
        pictures.dark.as_ref().or(pictures.light.as_ref())
    } else {
        pictures.light.as_ref()
    }
    .cloned();
    if let Some(photo) = &pictures.photo {
        return Some(
            img(crate::fit_picture::bytes_source(photo.clone()))
                .size(px(18.))
                .rounded_full()
                .object_fit(ObjectFit::Cover)
                .with_fallback(move || {
                    mark.clone()
                        .map(character)
                        .unwrap_or_else(|| div().into_any_element())
                })
                .into_any_element(),
        );
    }
    mark.map(character)
}
