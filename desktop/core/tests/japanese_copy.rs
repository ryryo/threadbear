use chrono::{TimeZone, Utc};
use serde_json::json;
use threadbear_core::{
    i18n::{set_locale, Locale},
    reducer::{ApprovalRequest, ApprovalText},
    sidebar::relative_short,
};

#[test]
fn japanese_approval_copy_preserves_user_values_and_drops_question_mark_from_summary() {
    set_locale(Locale::Japanese);
    let command = ApprovalRequest::new("1", "Bash", "", json!({"command": "echo hello"}));
    assert_eq!(
        ApprovalText::title(&command),
        "このコマンドを実行しますか？"
    );
    assert_eq!(ApprovalText::target(&command), "echo hello");
    let edit = ApprovalRequest::new("2", "Edit", "", json!({"file_path": "/tmp/{file}.sh"}));
    assert_eq!(ApprovalText::title(&edit), "{file}.sh を編集しますか？");
    assert_eq!(ApprovalText::target(&edit), "{file}.sh を編集");
    let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
    assert_eq!(relative_short(now.timestamp_millis(), &now), "たった今");
    assert_eq!(
        relative_short(now.timestamp_millis() - 300_000, &now),
        "5分前"
    );
}
