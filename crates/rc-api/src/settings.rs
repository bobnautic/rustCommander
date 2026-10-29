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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub language: String,
    pub theme: String,
    pub show_hidden: bool,
    pub confirm_delete: bool,
    pub confirm_overwrite: bool,
    pub double_click_action: String,
    pub size_format: String,
    pub max_concurrent_jobs: u32,
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
            show_hidden: false,
            confirm_delete: true,
            confirm_overwrite: true,
            double_click_action: "edit".into(),
            size_format: "auto".into(),
            max_concurrent_jobs: 3,
            transfer: TransferOptions::default(),
            discovery: DiscoverySettings::default(),
            server: ServerSettings::default(),
            editor: EditorSettings::default(),
            terminal: TerminalSettings::default(),
        }
    }
}
