//! Application preferences (`settings.json`).

use serde::{Deserialize, Serialize};

use rc_core::transfer::TransferOptions;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoverySettings {
    pub enabled: bool,
    pub port: u16,
    /// Empty = host name.
    pub instance_name: String,
    pub interval_secs: u64,
}

impl Default for DiscoverySettings {
    fn default() -> Self {
        DiscoverySettings {
            enabled: true,
            port: rc_discovery::DEFAULT_PORT,
            instance_name: String::new(),
            interval_secs: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerSettings {
    /// Start the embedded web server when the desktop app starts.
    pub auto_start: bool,
    pub bind: String,
    pub port: u16,
    pub tls: bool,
    /// Allow web clients to open shells / run commands on this machine.
    pub allow_terminal: bool,
}

impl Default for ServerSettings {
    fn default() -> Self {
        ServerSettings { auto_start: false, bind: "0.0.0.0".into(), port: 8822, tls: true, allow_terminal: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    pub font_size: u32,
    pub word_wrap: bool,
    /// Indentation width for new files (existing files keep the one they use).
    pub tab_size: u32,
    /// Show syntax errors and other problems while typing.
    pub lint: bool,
    /// Run the formatter of the file's language before saving.
    pub format_on_save: bool,
    /// Line width the formatters aim for.
    pub print_width: u32,
}

impl Default for EditorSettings {
    fn default() -> Self {
        EditorSettings {
            font_size: 13,
            word_wrap: false,
            tab_size: 4,
            lint: true,
            format_on_save: false,
            print_width: 80,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalSettings {
    pub font_size: u32,
    pub font_family: String,
    pub scrollback: u32,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        TerminalSettings {
            font_size: 13,
            font_family: "'JetBrains Mono', 'Cascadia Mono', 'DejaVu Sans Mono', Menlo, Consolas, monospace".into(),
            scrollback: 5000,
        }
    }
}

/// Look of the user interface: a skin plus the user's own adjustments on top of it.
/// `None` = what the skin says.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    /// Id of a built-in skin or of a file in `<config dir>/skins/`. Unknown ids fall back
    /// to "default".
    pub skin: String,
    /// Accent color (CSS color), for both the light and the dark variant.
    pub accent: Option<String>,
    /// File list density: "compact", "normal" or "comfortable".
    pub density: Option<String>,
    /// Font size of the file lists in pixels.
    pub list_font_size: Option<u32>,
    /// Corner radius of controls in pixels.
    pub radius: Option<u32>,
    /// Alternating row backgrounds in the file lists.
    pub stripes: Option<bool>,
    /// Font of the user interface (CSS font-family).
    pub font_ui: Option<String>,
    /// Monospaced font (paths, editor, permissions).
    pub font_mono: Option<String>,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        AppearanceSettings {
            skin: "default".into(),
            accent: None,
            density: None,
            list_font_size: None,
            radius: None,
            stripes: None,
            font_ui: None,
            font_mono: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub language: String,
    /// "system", "light" or "dark": which variant of the skin to show.
    pub theme: String,
    pub appearance: AppearanceSettings,
    pub show_hidden: bool,
    pub confirm_delete: bool,
    pub confirm_overwrite: bool,
    pub double_click_action: String,
    pub size_format: String,
    pub max_concurrent_jobs: u32,
    /// Move local files to the system trash when deleting (Shift+Delete deletes for good).
    pub use_trash: bool,
    /// Connect the sessions that were open when the application was closed.
    pub restore_sessions: bool,
    /// Continue interrupted transfers after a restart (otherwise they come back paused).
    pub resume_jobs: bool,
    /// Keyboard layout: "norton" (Norton Commander), "total" (Total Commander) or "rust"
    /// (the layout of Rust Commander 0.1). Unknown values are treated as "norton".
    pub keymap: String,
    /// Show the function key bar (F1–F10) above the status bar.
    pub show_key_bar: bool,
    pub transfer: TransferOptions,
    pub discovery: DiscoverySettings,
    pub server: ServerSettings,
    pub editor: EditorSettings,
    pub terminal: TerminalSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            language: "auto".into(),
            theme: "system".into(),
            appearance: AppearanceSettings::default(),
            show_hidden: false,
            confirm_delete: true,
            confirm_overwrite: true,
            double_click_action: "edit".into(),
            size_format: "auto".into(),
            max_concurrent_jobs: 3,
            use_trash: true,
            restore_sessions: true,
            resume_jobs: true,
            keymap: "norton".into(),
            show_key_bar: true,
            transfer: TransferOptions::default(),
            discovery: DiscoverySettings::default(),
            server: ServerSettings::default(),
            editor: EditorSettings::default(),
            terminal: TerminalSettings::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyboard_layout_defaults_to_norton_commander() {
        // settings.json written before keyboard layouts existed
        let s: Settings = serde_json::from_str(r#"{ "theme": "dark", "showHidden": true }"#).unwrap();
        assert_eq!(s.keymap, "norton");
        assert!(s.show_key_bar);
        assert_eq!(s.theme, "dark");

        let s: Settings = serde_json::from_str(r#"{ "keymap": "total", "showKeyBar": false }"#).unwrap();
        assert_eq!(s.keymap, "total");
        assert!(!s.show_key_bar);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["keymap"], "total");
        assert_eq!(v["showKeyBar"], false);
    }

    #[test]
    fn appearance_defaults_to_the_default_skin() {
        let s: Settings = serde_json::from_str(r#"{ "theme": "dark" }"#).unwrap();
        assert_eq!(s.appearance.skin, "default");
        assert!(s.appearance.accent.is_none());

        let s: Settings =
            serde_json::from_str(r##"{ "appearance": { "skin": "nord", "accent": "#ff8800", "stripes": true } }"##)
                .unwrap();
        assert_eq!(s.appearance.skin, "nord");
        assert_eq!(s.appearance.accent.as_deref(), Some("#ff8800"));
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["appearance"]["stripes"], true);
        assert_eq!(v["appearance"]["listFontSize"], serde_json::Value::Null);
    }
}
