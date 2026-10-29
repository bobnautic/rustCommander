// The web UI is embedded from ui/dist. Make sure the folder exists so the crate also
// builds before the UI was built (a placeholder page explains how to build it).
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist");
    if !dist.join("index.html").exists() {
        std::fs::create_dir_all(&dist).expect("create ui/dist");
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><meta charset=utf-8><title>Rust Commander</title>\
             <body style=\"font-family:sans-serif;padding:2em\"><h1>Rust Commander</h1>\
             <p>The web UI has not been built. Run <code>npm --prefix ui ci &amp;&amp; npm --prefix ui run build</code> \
             and rebuild the server.</p></body>",
        )
        .expect("write placeholder");
    }
    println!("cargo:rerun-if-changed=../../ui/dist");
}
