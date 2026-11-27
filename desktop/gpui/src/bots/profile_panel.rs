use super::*;

const PANEL: &str = "bot.original-profile";

#[derive(Default)]
pub(super) struct ProfilePanel {
    pub(super) available: bool,
    current: Option<View>,
}

#[derive(Deserialize)]
struct Lease {
    id: String,
    url: String,
}

struct View {
    id: String,
    bot_id: String,
    panel: ThreadSummary,
}

impl ProfilePanel {
    pub(super) fn active(&self) -> bool {
        self.current.is_some()
    }
}

impl Lease {
    fn address(&self, language: &str, theme: &str) -> Option<String> {
        let (url, fragment) = self.url.split_once('#')?;
        let port: u16 = url
            .strip_prefix("http://127.0.0.1:")?
            .strip_suffix('/')?
            .parse()
            .ok()?;
        if port == 0
            || fragment != self.id
            || fragment.len() != 64
            || !fragment
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return None;
        }
        Some(format!(
            "http://127.0.0.1:{port}/?lang={language}&theme={theme}#{fragment}"
        ))
    }
}

impl Threadbear {
    pub(super) fn open_original_profile(&mut self, cx: &mut Context<Self>) {
        let Some(detail) = &self.bots.detail else {
            return;
        };
        if self.bots.busy || !self.bots.profile_panel.available || detail.bot.archived_at.is_some()
        {
            return;
        }
        let bot = detail.bot.id.clone();
        let client = self.client.clone();
        self.bots.busy = true;
        self.bots.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = call(client, "bots.profilePanel.open", json!({ "botId": bot })).await;
            this.update(cx, |this, cx| {
                this.bots.busy = false;
                let value = match result {
                    Ok(value) => value,
                    Err(error) => {
                        this.bots.error = Some(error.message);
                        cx.notify();
                        return;
                    }
                };
                let Ok(lease) = serde_json::from_value::<Lease>(value) else {
                    this.bots.error = Some(tr!("Could not open the Bot profile.").into());
                    cx.notify();
                    return;
                };
                if this.home_page() == Some(SidebarMode::Bots) && this.bots.tab == Tab::Settings
                    && this.bots.selected.as_ref() == Some(&bot) && this.open_project().is_none()
                {
                    let language = threadbear_core::i18n::active_locale().name();
                    let theme = if cx.theme().mode.is_dark() { "dark" } else { "light" };
                    if let Some(address) = lease.address(language, theme) {
                        // The existing patch URL panel renderer reads this local
                        // adapter. No thread actually owns this panel or its URL.
                        let panel = ThreadSummary {
                            panels: Some(vec![json!({ "id": PANEL, "title": tr!("Profile"), "kind": "url", "url": address })]),
                            ..Default::default()
                        };
                        this.bots.profile_panel.current = Some(View { id: lease.id, bot_id: bot, panel });
                        cx.notify();
                        return;
                    }
                    this.bots.error = Some(tr!("Could not open the Bot profile.").into());
                }
                this.revoke_profile(lease.id, cx);
                cx.notify();
            }).ok();
        }).detach();
    }

    pub(crate) fn manage_profile_memory(&mut self, params: &Value, cx: &mut Context<Self>) {
        let Some(view) = self.bots.profile_panel.current.as_ref() else {
            return;
        };
        let Some(detail) = &self.bots.detail else {
            return;
        };
        if self.home_page() != Some(SidebarMode::Bots)
            || self.open_project().is_some()
            || self.bots.tab != Tab::Settings
            || self.bots.selected.as_ref() != Some(&view.bot_id)
            || detail.bot.id != view.bot_id
            || params["id"].as_str() != Some(view.id.as_str())
            || params["botId"].as_str() != Some(view.bot_id.as_str())
        {
            return;
        }
        let id = view.bot_id.clone();
        self.bots.scope = Some(MemoryScope {
            kind: "bot".into(),
            id: id.clone(),
            title: detail.bot.name.clone(),
            archived: false,
        });
        self.dismiss_bot_profile(false, cx);
        self.bots.tab = Tab::Memory;
        self.load_bot(id, cx);
    }

    fn revoke_profile(&self, id: String, cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |_, _| {
            let _ = call(client, "bots.profilePanel.close", json!({ "id": id })).await;
        })
        .detach();
    }

    pub(crate) fn dismiss_bot_profile(&mut self, refresh: bool, cx: &mut Context<Self>) {
        let Some(view) = self.bots.profile_panel.current.take() else {
            return;
        };
        self.revoke_profile(view.id, cx);
        if refresh {
            if let Some(bot) = self.bots.selected.clone() {
                self.load_bot(bot, cx);
            }
        }
        cx.notify();
    }

    pub(super) fn render_original_profile(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let body = self.bots.profile_panel.current.as_ref().and_then(|view| {
            crate::web_panels::section(self, &view.panel, PANEL, false, window, cx)
        });
        v_flex()
            .id("bot-original-profile")
            .size_full()
            .gap(px(8.))
            .p(px(16.))
            .child(
                bot_button("bot-profile-close", tr!("Close profile editor"), false).on_click(
                    cx.listener(|this, _, window, cx| {
                        crate::web_panels::keyboard_to_app(window);
                        this.dismiss_bot_profile(true, cx);
                    }),
                ),
            )
            .child(div().flex_1().min_h_0().children(body))
            .into_any_element()
    }
}
