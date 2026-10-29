//! Batch scripting: `open`, `ls`, `cd`, `get`, `put`, `synchronize`, ...

use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};

use rc_core::jobs::{JobKind, JobQueue, JobSpec, JobState};
use rc_core::mask::FileMask;
use rc_core::path as vpath;
use rc_core::store::{SiteStore, Vault};
use rc_core::sync::{SyncDirection, SyncMode, SyncParams};
use rc_core::transfer::{DeleteTask, Endpoint, OverwriteMode, TransferOptions, TransferTask};
use rc_core::{ChecksumAlgo, ConnectContext, FileEntry, KnownHosts, LocalVfs, SiteConfig, Vfs};

use crate::prompt::CliPrompter;

struct Remote {
    name: String,
    vfs: Arc<dyn Vfs>,
    cwd: String,
}

pub struct Script {
    known_hosts: Arc<KnownHosts>,
    sites: SiteStore,
    queue: JobQueue,
    local: Arc<dyn Vfs>,
    lcwd: String,
    remote: Option<Remote>,
    interactive: bool,
}

/// Split a command line; double quotes group, `""` inside quotes is a literal quote.
pub fn tokenize(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut has = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if in_q && chars.peek() == Some(&'"') => {
                chars.next();
                cur.push('"');
            }
            '"' => {
                in_q = !in_q;
                has = true;
            }
            c if c.is_whitespace() && !in_q => {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => cur.push(c),
        }
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    out
}

struct Args {
    switches: Vec<(String, Option<String>)>,
    params: Vec<String>,
}

impl Args {
    fn parse(tokens: &[String]) -> Args {
        let mut switches = Vec::new();
        let mut params = Vec::new();
        for t in tokens {
            if let Some(s) = t
                .strip_prefix('-')
                .filter(|s| !s.is_empty() && !s.starts_with('-') && !s.chars().next().unwrap_or('0').is_ascii_digit())
            {
                match s.split_once('=') {
                    Some((k, v)) => switches.push((k.to_ascii_lowercase(), Some(v.to_string()))),
                    None => switches.push((s.to_ascii_lowercase(), None)),
                }
            } else {
                params.push(t.clone());
            }
        }
        Args { switches, params }
    }
    fn flag(&self, name: &str) -> bool {
        self.switches.iter().any(|(k, _)| k == name)
    }
    fn value(&self, name: &str) -> Option<String> {
        self.switches.iter().find(|(k, _)| k == name).and_then(|(_, v)| v.clone())
    }
}

fn has_wildcard(s: &str) -> bool {
    s.contains(['*', '?', '['])
}

fn human(n: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", U[i])
    }
}

fn format_entry(e: &FileEntry) -> String {
    let kind = match e.kind {
        rc_core::FileKind::Dir => 'd',
        rc_core::FileKind::Symlink => 'l',
        _ => '-',
    };
    let perms = e.permission_string().unwrap_or_else(|| "---------".into());
    let date = e
        .modified
        .and_then(|m| chrono::DateTime::from_timestamp(m, 0))
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    let link = e.link_target.as_ref().map(|t| format!(" -> {t}")).unwrap_or_default();
    format!(
        "{kind}{perms} {:<8} {:<8} {:>12} {date} {}{link}",
        e.owner.as_deref().unwrap_or(""),
        e.group.as_deref().unwrap_or(""),
        e.size,
        e.name
    )
}

impl Script {
    pub async fn new(config_dir: Option<PathBuf>, interactive: bool) -> Result<Script> {
        let dir = config_dir.unwrap_or_else(rc_core::store::config_dir);
        let vault = Arc::new(Vault::open(dir.clone())?);
        let sites = SiteStore::load(dir.join("sites.json"), vault);
        let known_hosts = Arc::new(KnownHosts::load(dir.join("known_hosts.json")));
        let local: Arc<dyn Vfs> = Arc::new(LocalVfs::new());
        let lcwd = rc_core::local::from_native(&std::env::current_dir()?);
        Ok(Script {
            known_hosts,
            sites,
            queue: JobQueue::new(1, Arc::new(|_| {})),
            local,
            lcwd,
            remote: None,
            interactive,
        })
    }

    fn remote(&self) -> Result<&Remote> {
        self.remote.as_ref().ok_or_else(|| anyhow!("no session open (use `open`)"))
    }

    fn rpath(&self, p: &str) -> Result<String> {
        Ok(vpath::join(&self.remote()?.cwd, p))
    }

    fn lpath(&self, p: &str) -> String {
        vpath::join(&self.lcwd, &p.replace('\\', "/"))
    }

    /// Expand wildcards in the last path component.
    async fn expand(&self, vfs: &dyn Vfs, path: &str) -> Result<Vec<String>> {
        let name = vpath::file_name(path);
        if !has_wildcard(name) {
            return Ok(vec![path.to_string()]);
        }
        let dir = vpath::parent(path);
        let mask = FileMask::parse(name).map_err(|e| anyhow!(e))?;
        let mut out: Vec<String> = vfs
            .list(&dir)
            .await?
            .into_iter()
            .filter(|e| {
                mask.matches_name(&e.name)
                    || (e.is_dir()
                        && mask.matches(&rc_core::mask::MaskTarget {
                            name: &e.name,
                            rel_path: &e.name,
                            is_dir: false,
                            size: 0,
                            modified: None,
                        }))
            })
            .map(|e| e.path)
            .collect();
        out.sort();
        if out.is_empty() {
            bail!("no file matches {path}");
        }
        Ok(out)
    }

    async fn run_job(
        &self,
        kind: JobKind,
        title: String,
        task: Arc<dyn rc_core::jobs::JobTask>,
        speed: u64,
    ) -> Result<()> {
        let job = self.queue.submit(kind, JobSpec { title: title.clone(), ..Default::default() }, task, speed);
        let tty = std::io::stderr().is_terminal();
        loop {
            let j = self.queue.get(&job.id)?;
            if let Some(c) = &j.conflict {
                // Scripts never ask: overwrite.
                self.queue.resolve_conflict(
                    &j.id,
                    &c.id,
                    rc_core::jobs::ConflictDecision {
                        action: rc_core::jobs::ConflictAction::Overwrite,
                        new_name: None,
                    },
                    true,
                )?;
            }
            if j.state.is_finished() {
                if tty {
                    eprint!("\r\x1b[K");
                }
                for e in &j.errors {
                    eprintln!("Error: {}: {}", e.path, e.message);
                }
                println!("{title}: {} file(s), {} — {:?}", j.files_done, human(j.bytes_done), j.state);
                return match j.state {
                    JobState::Completed => Ok(()),
                    _ => Err(anyhow!("{title} failed")),
                };
            }
            if tty {
                let pct = (j.bytes_done * 100).checked_div(j.bytes_total).unwrap_or(0);
                let cur = j.current_file.as_deref().map(vpath::file_name).unwrap_or("");
                eprint!(
                    "\r\x1b[K{pct:>3}% {} / {}  {}/s  {cur}",
                    human(j.bytes_done),
                    human(j.bytes_total),
                    human(j.speed as u64)
                );
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    fn transfer_options(args: &Args) -> TransferOptions {
        let mut o = TransferOptions { overwrite: OverwriteMode::Overwrite, ..Default::default() };
        o.move_files = args.flag("delete");
        if args.flag("resume") || args.flag("resumesupport") {
            o.overwrite = OverwriteMode::Resume;
        }
        if args.flag("neweronly") {
            o.overwrite = OverwriteMode::Newer;
        }
        if args.flag("nopreservetime") {
            o.preserve_timestamps = false;
        }
        if args.flag("nopermissions") {
            o.preserve_permissions = false;
        }
        if let Some(m) = args.value("permissions") {
            o.permissions = u32::from_str_radix(&m, 8).ok();
        }
        if let Some(m) = args.value("filemask") {
            o.file_mask = m;
        }
        if let Some(s) = args.value("speed") {
            o.speed_limit = s.parse::<u64>().unwrap_or(0) * 1024;
        }
        if args.flag("transfer=ascii") || args.value("transfer").as_deref() == Some("ascii") {
            o.mode = rc_core::transfer::TransferMode::Text;
        }
        o.verify_checksum = args.flag("verify");
        o.parallel = args.value("parallel").and_then(|p| p.parse().ok()).unwrap_or(2);
        o
    }

    pub async fn execute(&mut self, line: &str) -> Result<bool> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return Ok(true);
        }
        let tokens = tokenize(line);
        let cmd = tokens[0].to_ascii_lowercase();
        let args = Args::parse(&tokens[1..]);
        let p = &args.params;
        match cmd.as_str() {
            "exit" | "bye" | "quit" => {
                if let Some(r) = self.remote.take() {
                    let _ = r.vfs.close().await;
                }
                return Ok(false);
            }
            "help" | "?" => println!("{HELP}"),
            "echo" => println!("{}", p.join(" ")),
            "option" => println!("option {} (ignored)", p.join(" ")),
            "open" => {
                let target = p.first().ok_or_else(|| anyhow!("usage: open <url|site>"))?;
                let mut site = if target.contains("://") {
                    SiteConfig::from_url(target).map(|(s, _)| s).ok_or_else(|| anyhow!("cannot parse {target}"))?
                } else {
                    let all = self.sites.list_masked();
                    let found = all
                        .iter()
                        .find(|s| s.name == *target || format!("{}/{}", s.folder, s.name) == *target)
                        .or_else(|| all.iter().find(|s| s.name.eq_ignore_ascii_case(target)))
                        .ok_or_else(|| anyhow!("no saved site named {target}"))?;
                    self.sites.get_decrypted(&found.id)?
                };
                if let Some(pw) = args.value("password") {
                    site.password = Some(pw);
                }
                if let Some(k) = args.value("privatekey") {
                    site.ssh.private_key_path = Some(k);
                }
                if let Some(t) = args.value("timeout").and_then(|t| t.parse().ok()) {
                    site.timeout_secs = t;
                }
                if args.flag("scp") {
                    site.protocol = rc_core::Protocol::Scp;
                }
                let prompter = CliPrompter {
                    interactive: self.interactive,
                    hostkey: args.value("hostkey"),
                    password: site.password.clone(),
                };
                let ctx = ConnectContext {
                    prompter: Arc::new(prompter),
                    known_hosts: self.known_hosts.clone(),
                    session_id: "script".into(),
                };
                if let Some(r) = self.remote.take() {
                    let _ = r.vfs.close().await;
                }
                let vfs = rc_core::connect(&site, &ctx)
                    .await
                    .with_context(|| format!("connecting to {}", site.display_name()))?;
                let home = vfs.home().await.unwrap_or_else(|_| "/".into());
                let cwd = if site.remote_dir.is_empty() { home } else { site.remote_dir.clone() };
                println!("Connected to {} ({})", site.display_name(), cwd);
                self.remote = Some(Remote { name: site.display_name(), vfs, cwd });
            }
            "close" => {
                if let Some(r) = self.remote.take() {
                    let _ = r.vfs.close().await;
                    println!("Session '{}' closed.", r.name);
                }
            }
            "pwd" => println!("{}", self.remote()?.cwd),
            "lpwd" => println!("{}", self.lcwd),
            "cd" => {
                let target = match p.first() {
                    Some(d) => self.rpath(d)?,
                    None => self.remote()?.vfs.home().await?,
                };
                let r = self.remote()?;
                let canon = r.vfs.canonicalize(&target).await.unwrap_or(target);
                if !r.vfs.stat(&canon).await?.is_dir() {
                    bail!("{canon} is not a directory");
                }
                if let Some(r) = self.remote.as_mut() {
                    r.cwd = canon.clone();
                }
                println!("{canon}");
            }
            "lcd" => {
                let d = self.lpath(p.first().map(|s| s.as_str()).unwrap_or("."));
                let canon = self.local.canonicalize(&d).await?;
                self.lcwd = canon.clone();
                println!("{canon}");
            }
            "ls" | "dir" | "lls" | "ldir" => {
                let (vfs, base) = if cmd.starts_with('l') && cmd != "ls" {
                    (self.local.clone(), self.lcwd.clone())
                } else {
                    let r = self.remote()?;
                    (r.vfs.clone(), r.cwd.clone())
                };
                let target = p.first().map(|x| vpath::join(&base, x)).unwrap_or(base);
                let (dir, mask) = if has_wildcard(vpath::file_name(&target)) {
                    (vpath::parent(&target), Some(FileMask::parse(vpath::file_name(&target)).map_err(|e| anyhow!(e))?))
                } else {
                    (target, None)
                };
                let mut entries = vfs.list(&dir).await?;
                entries.sort_by(|a, b| b.is_dir().cmp(&a.is_dir()).then(a.name.cmp(&b.name)));
                for e in entries.iter().filter(|e| mask.as_ref().is_none_or(|m| m.matches_name(&e.name))) {
                    println!("{}", format_entry(e));
                }
            }
            "get" | "recv" | "mget" | "put" | "send" | "mput" => {
                let upload = matches!(cmd.as_str(), "put" | "send" | "mput");
                if p.is_empty() {
                    bail!("usage: {cmd} <source...> [target]");
                }
                let (sources, target) =
                    if p.len() >= 2 { (&p[..p.len() - 1], Some(p[p.len() - 1].clone())) } else { (&p[..], None) };
                let remote = self.remote()?;
                let (src_vfs, dst_vfs) = if upload {
                    (self.local.clone(), remote.vfs.clone())
                } else {
                    (remote.vfs.clone(), self.local.clone())
                };
                let mut src_paths = Vec::new();
                for s in sources {
                    let full = if upload { self.lpath(s) } else { self.rpath(s)? };
                    src_paths.extend(self.expand(src_vfs.as_ref(), &full).await?);
                }
                let mut opts = Self::transfer_options(&args);
                let dst_dir = match &target {
                    None => {
                        if upload {
                            remote.cwd.clone()
                        } else {
                            self.lcwd.clone()
                        }
                    }
                    Some(t) => {
                        let full = if upload { self.rpath(t)? } else { self.lpath(t) };
                        let ends_dir = t.ends_with('/') || t.ends_with('\\');
                        match dst_vfs.try_stat(&full).await? {
                            Some(e) if e.is_dir() => full,
                            _ if ends_dir => full,
                            _ if src_paths.len() == 1 => {
                                opts.new_name = Some(vpath::file_name(&full).to_string());
                                vpath::parent(&full)
                            }
                            _ => full,
                        }
                    }
                };
                let speed = opts.speed_limit;
                let (src_ep, dst_ep) = (Endpoint::new("src", src_vfs), Endpoint::new("dst", dst_vfs));
                let task =
                    TransferTask { src: src_ep, src_paths, dst: dst_ep, dst_dir: dst_dir.clone(), options: opts };
                self.run_job(
                    JobKind::Transfer,
                    format!("{} → {dst_dir}", if upload { "Upload" } else { "Download" }),
                    Arc::new(task),
                    speed,
                )
                .await?;
            }
            "rm" | "rmdir" => {
                let r = self.remote()?;
                let mut paths = Vec::new();
                for x in p {
                    paths.extend(self.expand(r.vfs.as_ref(), &self.rpath(x)?).await?);
                }
                if paths.is_empty() {
                    bail!("usage: {cmd} <path...>");
                }
                let task = DeleteTask { target: Endpoint::new("r", r.vfs.clone()), paths };
                self.run_job(JobKind::Delete, "Delete".into(), Arc::new(task), 0).await?;
            }
            "mkdir" => {
                let d = self.rpath(p.first().ok_or_else(|| anyhow!("usage: mkdir <dir>"))?)?;
                self.remote()?.vfs.mkdir_all(&d).await?;
            }
            "mv" | "rename" => {
                if p.len() < 2 {
                    bail!("usage: mv <from> <to>");
                }
                let r = self.remote()?;
                let from = self.rpath(&p[0])?;
                let mut to = self.rpath(&p[1])?;
                if r.vfs.try_stat(&to).await?.is_some_and(|e| e.is_dir()) {
                    to = vpath::join(&to, vpath::file_name(&from));
                }
                r.vfs.rename(&from, &to).await?;
            }
            "cp" => {
                if p.len() < 2 {
                    bail!("usage: cp <from> <to-dir>");
                }
                let r = self.remote()?;
                let ep = Endpoint::new("r", r.vfs.clone());
                let task = TransferTask {
                    src: ep.clone(),
                    src_paths: vec![self.rpath(&p[0])?],
                    dst: ep,
                    dst_dir: self.rpath(&p[1])?,
                    options: TransferOptions { overwrite: OverwriteMode::Overwrite, ..Default::default() },
                };
                self.run_job(JobKind::Transfer, "Copy".into(), Arc::new(task), 0).await?;
            }
            "chmod" => {
                if p.len() < 2 {
                    bail!("usage: chmod <mode> <path...>");
                }
                let mode = u32::from_str_radix(&p[0], 8).map_err(|_| anyhow!("mode must be octal, e.g. 644"))?;
                let r = self.remote()?;
                for x in &p[1..] {
                    for path in self.expand(r.vfs.as_ref(), &self.rpath(x)?).await? {
                        r.vfs.set_permissions(&path, mode).await?;
                    }
                }
            }
            "ln" | "symlink" => {
                if p.len() < 2 {
                    bail!("usage: ln <target> <link>");
                }
                let link = self.rpath(&p[1])?;
                self.remote()?.vfs.symlink(&p[0], &link).await?;
            }
            "stat" => {
                let e = self
                    .remote()?
                    .vfs
                    .stat(&self.rpath(p.first().ok_or_else(|| anyhow!("usage: stat <path>"))?)?)
                    .await?;
                println!("{}", format_entry(&e));
            }
            "checksum" => {
                if p.len() < 2 {
                    bail!("usage: checksum <md5|sha-1|sha-256> <path>");
                }
                let algo = match p[0].to_ascii_lowercase().replace('-', "").as_str() {
                    "md5" => ChecksumAlgo::Md5,
                    "sha1" => ChecksumAlgo::Sha1,
                    "sha256" => ChecksumAlgo::Sha256,
                    a => bail!("unknown algorithm {a}"),
                };
                let path = self.rpath(&p[1])?;
                println!("{}  {}", rc_core::ops::checksum(self.remote()?.vfs.as_ref(), &path, algo).await?, p[1]);
            }
            "call" | "exec" | "!" => {
                let command = line.split_once(char::is_whitespace).map(|x| x.1).unwrap_or("").trim();
                let r = self.remote()?;
                let out = r.vfs.exec(command, Some(&r.cwd)).await?;
                print!("{}", out.stdout);
                eprint!("{}", out.stderr);
                if out.exit_code.unwrap_or(0) != 0 {
                    bail!("command exited with {}", out.exit_code.unwrap_or(-1));
                }
            }
            "synchronize" | "sync" => {
                let dir = p
                    .first()
                    .ok_or_else(|| anyhow!("usage: synchronize <local|remote|both> [local] [remote]"))?
                    .to_ascii_lowercase();
                let direction = match dir.as_str() {
                    "remote" => SyncDirection::LeftToRight,
                    "local" => SyncDirection::RightToLeft,
                    "both" => SyncDirection::Both,
                    d => bail!("unknown direction {d}"),
                };
                let lpath = p.get(1).map(|x| self.lpath(x)).unwrap_or_else(|| self.lcwd.clone());
                let rpath = match p.get(2) {
                    Some(x) => self.rpath(x)?,
                    None => self.remote()?.cwd.clone(),
                };
                let criteria = args.value("criteria").unwrap_or_else(|| "time".into()).to_ascii_lowercase();
                let params = SyncParams {
                    left_session: "local".into(),
                    left_path: lpath,
                    right_session: "remote".into(),
                    right_path: rpath,
                    direction,
                    mode: if args.flag("mirror") { SyncMode::Mirror } else { SyncMode::Update },
                    delete_obsolete: args.flag("delete"),
                    compare_size: criteria != "time",
                    compare_time: criteria == "time" || criteria == "either",
                    compare_checksum: criteria == "checksum",
                    file_mask: args.value("filemask").unwrap_or_default(),
                    ..Default::default()
                };
                let left = Endpoint::new("local", self.local.clone());
                let right = Endpoint::new("remote", self.remote()?.vfs.clone());
                let plan = rc_core::sync::compare(left.vfs.as_ref(), right.vfs.as_ref(), &params, |_| {}).await?;
                for a in &plan.actions {
                    println!("{:<16} {}", format!("{:?}", a.action), a.rel_path);
                }
                if plan.actions.is_empty() {
                    println!("Nothing to synchronize.");
                    return Ok(true);
                }
                if args.flag("preview") {
                    return Ok(true);
                }
                let actions: Vec<_> =
                    plan.actions.into_iter().filter(|a| a.action != rc_core::sync::SyncActionKind::Conflict).collect();
                let task =
                    rc_core::sync::SyncTask { left, right, params, actions, options: Self::transfer_options(&args) };
                self.run_job(JobKind::Sync, "Synchronize".into(), Arc::new(task), 0).await?;
            }
            "keepuptodate" => {
                let lpath = p.first().map(|x| self.lpath(x)).unwrap_or_else(|| self.lcwd.clone());
                let rpath = match p.get(1) {
                    Some(x) => self.rpath(x)?,
                    None => self.remote()?.cwd.clone(),
                };
                let w = rc_core::watch::start(
                    rc_core::watch::WatchParams {
                        local_path: lpath.clone(),
                        remote: Endpoint::new("remote", self.remote()?.vfs.clone()),
                        remote_path: rpath.clone(),
                        delete_remote: args.flag("delete"),
                        file_mask: args.value("filemask").unwrap_or_default(),
                        options: Self::transfer_options(&args),
                    },
                    Endpoint::new("local", self.local.clone()),
                    self.queue.clone(),
                    Arc::new(|s| println!("{}", s.last_event.unwrap_or_default())),
                )?;
                println!("Watching {lpath} → {rpath}. Press Ctrl+C to stop.");
                tokio::signal::ctrl_c().await?;
                w.stop();
            }
            other => bail!("unknown command '{other}' (try `help`)"),
        }
        Ok(true)
    }
}

const HELP: &str = "Commands:
  open <url|site> [-hostkey=<fp>|*] [-password=..] [-privatekey=..]   connect (sftp://, scp://, ftp://, ftpes://, ftps://, davs://, s3://, rcmd://)
  close | exit
  pwd | cd [dir] | ls [path|mask]          remote navigation
  lpwd | lcd <dir> | lls [path|mask]       local navigation
  get <remote...> [local]                  download   (-delete -resume -neweronly -nopreservetime -filemask= -speed=KB -verify)
  put <local...> [remote]                  upload     (same switches, -permissions=644)
  rm <path...> | rmdir <dir> | mkdir <dir> | mv <from> <to> | cp <from> <dir>
  chmod <mode> <path...> | ln <target> <link> | stat <path> | checksum <alg> <path>
  synchronize <remote|local|both> [local] [remote] [-delete] [-mirror] [-criteria=time|size|either|checksum] [-filemask=] [-preview]
  keepuptodate [local] [remote] [-delete] [-filemask=]
  call <command>                           run a command on the server
  echo <text> | help";

pub async fn run_lines(config_dir: Option<PathBuf>, lines: &[String], keep_going: bool) -> Result<()> {
    let mut s = Script::new(config_dir, std::io::stdin().is_terminal()).await?;
    let mut failed = false;
    for line in lines {
        if !line.trim().is_empty() && !line.trim_start().starts_with('#') {
            eprintln!("> {}", line.trim());
        }
        match s.execute(line).await {
            Ok(true) => {}
            Ok(false) => break,
            Err(e) => {
                eprintln!("Error: {e:#}");
                failed = true;
                if !keep_going {
                    break;
                }
            }
        }
    }
    if failed {
        bail!("script failed");
    }
    Ok(())
}

pub async fn interactive(config_dir: Option<PathBuf>) -> Result<()> {
    let mut s = Script::new(config_dir, true).await?;
    println!("Rust Commander {} scripting console — `help` for commands, `exit` to quit.", rc_core::VERSION);
    let stdin = std::io::stdin();
    loop {
        let prompt = match &s.remote {
            Some(r) => format!("{}:{}> ", r.name, r.cwd),
            None => "rcmd> ".into(),
        };
        print!("{prompt}");
        std::io::stdout().flush()?;
        let mut line = String::new();
        if stdin.lock().read_line(&mut line)? == 0 {
            break;
        }
        match s.execute(&line).await {
            Ok(true) => {}
            Ok(false) => break,
            Err(e) => eprintln!("Error: {e:#}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        assert_eq!(tokenize(r#"put "my file.txt" /tmp/ -delete"#), vec!["put", "my file.txt", "/tmp/", "-delete"]);
        assert_eq!(tokenize(r#"echo "say ""hi""""#), vec!["echo", "say \"hi\""]);
        assert_eq!(tokenize(r#"cd """#), vec!["cd", ""]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn local_script_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let base = rc_core::local::from_native(dir.path());
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.txt"), b"hello").unwrap();
        std::fs::create_dir_all(dir.path().join("remote")).unwrap();
        let cfg = tempfile::tempdir().unwrap();
        let mut s = Script::new(Some(cfg.path().to_path_buf()), false).await.unwrap();
        // A "remote" session on the local file system via file:// is not a protocol, so
        // open the local vfs directly for the test.
        s.remote =
            Some(Remote { name: "test".into(), vfs: Arc::new(LocalVfs::new()), cwd: vpath::join(&base, "remote") });
        s.lcwd = vpath::join(&base, "src");
        s.execute("put *.txt").await.unwrap();
        assert!(dir.path().join("remote/a.txt").exists());
        s.execute("mkdir sub/deeper").await.unwrap();
        s.execute("cd sub").await.unwrap();
        s.execute("synchronize remote").await.unwrap();
        assert!(dir.path().join("remote/sub/a.txt").exists());
        s.execute("rm a.txt").await.unwrap();
        assert!(!dir.path().join("remote/sub/a.txt").exists());
        assert!(s.execute("bogus").await.is_err());
    }
}
