use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process;

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .expect("Cannot determine home directory")
}

fn clawgod_dir() -> PathBuf {
    home_dir().join(".clawgod")
}

fn provider_json_path() -> PathBuf {
    clawgod_dir().join("provider.json")
}

// ─── Key discovery ───────────────────────────────────────────

fn detect_grok_key() -> Option<String> {
    // 1. GROK_API_KEY env
    if let Ok(key) = env::var("GROK_API_KEY") {
        if !key.is_empty() {
            eprintln!("  Found key in GROK_API_KEY environment variable");
            return Some(key);
        }
    }

    // 2. ~/.grok/user-settings.json
    let settings_path = home_dir().join(".grok").join("user-settings.json");
    if let Ok(contents) = fs::read_to_string(&settings_path) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&contents) {
            if let Some(key) = parsed["apiKey"].as_str() {
                if !key.is_empty() {
                    eprintln!("  Found key in {}", settings_path.display());
                    return Some(key.to_string());
                }
            }
        }
    }

    // 3. XAI_API_KEY env (fallback)
    if let Ok(key) = env::var("XAI_API_KEY") {
        if !key.is_empty() {
            eprintln!("  Found key in XAI_API_KEY environment variable");
            return Some(key);
        }
    }

    None
}

// ─── Key validation ──────────────────────────────────────────

struct ValidationResult {
    valid: bool,
    models: Vec<String>,
    error: Option<String>,
}

fn validate_key(key: &str, base_url: &str) -> ValidationResult {
    let url = format!("{}/models", base_url.trim_end_matches('/'));

    match ureq::get(&url)
        .set("Authorization", &format!("Bearer {}", key))
        .set("Content-Type", "application/json")
        .call()
    {
        Ok(resp) => {
            let body: Value = resp.into_json().unwrap_or(json!({}));
            let models: Vec<String> = body["data"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m["id"].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            ValidationResult {
                valid: true,
                models,
                error: None,
            }
        }
        Err(ureq::Error::Status(401, _)) => ValidationResult {
            valid: false,
            models: vec![],
            error: Some("Invalid API key (401 Unauthorized)".into()),
        },
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            ValidationResult {
                valid: false,
                models: vec![],
                error: Some(format!("HTTP {} — {}", code, body)),
            }
        }
        Err(e) => ValidationResult {
            valid: false,
            models: vec![],
            error: Some(format!("Connection failed: {}", e)),
        },
    }
}

// ─── Provider config ─────────────────────────────────────────

fn write_provider(provider_type: &str, key: &str, base_url: &str, model: &str, small_model: &str) {
    let config = json!({
        "type": provider_type,
        "apiKey": key,
        "baseURL": base_url,
        "model": model,
        "smallModel": small_model,
        "timeoutMs": 3000000
    });

    let path = provider_json_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let content = serde_json::to_string_pretty(&config).unwrap() + "\n";
    fs::write(&path, &content).unwrap_or_else(|e| {
        eprintln!("  Failed to write {}: {}", path.display(), e);
        process::exit(1);
    });

    eprintln!("  Wrote {}", path.display());
}

fn read_current_provider() -> Option<Value> {
    let path = provider_json_path();
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

// ─── Interactive model selection ─────────────────────────────

fn select_model(models: &[String], default: &str) -> String {
    if models.is_empty() {
        return default.to_string();
    }

    eprintln!("\n  Available models:");
    for (i, m) in models.iter().enumerate() {
        let marker = if m == default { " (default)" } else { "" };
        eprintln!("    [{}] {}{}", i + 1, m, marker);
    }

    eprint!("\n  Select model [default: {}]: ", default);
    io::stderr().flush().unwrap();

    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap();
    let input = input.trim();

    if input.is_empty() {
        return default.to_string();
    }

    if let Ok(idx) = input.parse::<usize>() {
        if idx >= 1 && idx <= models.len() {
            return models[idx - 1].clone();
        }
    }

    // Treat as literal model name
    input.to_string()
}

fn prompt_key() -> String {
    eprint!("  Enter API key: ");
    io::stderr().flush().unwrap();
    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap();
    input.trim().to_string()
}

// ─── Subcommands ─────────────────────────────────────────────

fn cmd_grok(args: &[String]) {
    eprintln!("\n  ── Grok / xAI Import ──\n");

    let mut key = None;
    let mut model_override = None;
    let mut small_model_override = None;
    let mut base_url = "https://api.x.ai/v1".to_string();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--key" | "-k" => {
                i += 1;
                key = args.get(i).cloned();
            }
            "--model" | "-m" => {
                i += 1;
                model_override = args.get(i).cloned();
            }
            "--small-model" => {
                i += 1;
                small_model_override = args.get(i).cloned();
            }
            "--base-url" => {
                i += 1;
                if let Some(u) = args.get(i) {
                    base_url = u.clone();
                }
            }
            _ => {}
        }
        i += 1;
    }

    // Detect key
    let api_key = match key {
        Some(k) => {
            eprintln!("  Using provided key");
            k
        }
        None => {
            eprintln!("  Searching for grok-cli credentials...");
            match detect_grok_key() {
                Some(k) => k,
                None => {
                    eprintln!("  No grok-cli key found.");
                    let k = prompt_key();
                    if k.is_empty() {
                        eprintln!("  Aborted.");
                        process::exit(1);
                    }
                    k
                }
            }
        }
    };

    // Validate
    eprintln!("\n  Verifying key with {}...", base_url);
    let result = validate_key(&api_key, &base_url);

    if !result.valid {
        eprintln!("  FAILED: {}", result.error.unwrap_or_default());
        process::exit(1);
    }

    eprintln!("  Key valid.");

    // Model selection
    let default_model = "grok-4";
    let default_small = "grok-3-mini";

    let model = match model_override {
        Some(m) => m,
        None => select_model(&result.models, default_model),
    };

    let small_model = match small_model_override {
        Some(m) => m,
        None => {
            let candidates: Vec<&str> = vec!["grok-3-mini", "grok-3-mini-fast"];
            let auto = result
                .models
                .iter()
                .find(|m| candidates.contains(&m.as_str()))
                .map(|s| s.as_str())
                .unwrap_or(default_small);
            auto.to_string()
        }
    };

    // Write
    eprintln!("\n  model: {}", model);
    eprintln!("  smallModel: {}", small_model);
    write_provider("grok", &api_key, &base_url, &model, &small_model);
    eprintln!("\n  Done. Run `claude` to start.\n");
}

fn cmd_openai_compat(args: &[String]) {
    eprintln!("\n  ── OpenAI-Compatible Import ──\n");

    let mut key = None;
    let mut base_url = None;
    let mut model = None;
    let mut small_model = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--key" | "-k" => {
                i += 1;
                key = args.get(i).cloned();
            }
            "--base-url" | "-u" => {
                i += 1;
                base_url = args.get(i).cloned();
            }
            "--model" | "-m" => {
                i += 1;
                model = args.get(i).cloned();
            }
            "--small-model" => {
                i += 1;
                small_model = args.get(i).cloned();
            }
            _ => {}
        }
        i += 1;
    }

    let api_key = key.unwrap_or_else(|| {
        let k = prompt_key();
        if k.is_empty() {
            eprintln!("  Aborted.");
            process::exit(1);
        }
        k
    });

    let url = base_url.unwrap_or_else(|| {
        eprint!("  Base URL: ");
        io::stderr().flush().unwrap();
        let mut input = String::new();
        io::stdin().read_line(&mut input).unwrap();
        let v = input.trim().to_string();
        if v.is_empty() {
            eprintln!("  Aborted.");
            process::exit(1);
        }
        v
    });

    // Validate
    eprintln!("\n  Verifying key with {}...", url);
    let result = validate_key(&api_key, &url);

    if !result.valid {
        eprintln!("  WARNING: {}", result.error.unwrap_or_default());
        eprintln!("  Continuing anyway (some APIs don't expose /models)...\n");
    } else {
        eprintln!("  Key valid.");
    }

    let selected_model = model.unwrap_or_else(|| {
        if result.valid && !result.models.is_empty() {
            select_model(&result.models, &result.models[0])
        } else {
            eprint!("  Model name: ");
            io::stderr().flush().unwrap();
            let mut input = String::new();
            io::stdin().read_line(&mut input).unwrap();
            input.trim().to_string()
        }
    });

    let selected_small = small_model.unwrap_or_else(|| selected_model.clone());

    eprintln!("\n  model: {}", selected_model);
    eprintln!("  smallModel: {}", selected_small);
    write_provider("openai-compat", &api_key, &url, &selected_model, &selected_small);
    eprintln!("\n  Done. Run `claude` to start.\n");
}

fn cmd_orcarouter(args: &[String]) {
    eprintln!("\n  ── OrcaRouter Import ──\n");

    let mut key = None;
    let mut model_override = None;
    let mut small_model_override = None;
    let mut base_url = "https://api.orcarouter.ai/v1".to_string();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--key" | "-k" => {
                i += 1;
                key = args.get(i).cloned();
            }
            "--model" | "-m" => {
                i += 1;
                model_override = args.get(i).cloned();
            }
            "--small-model" => {
                i += 1;
                small_model_override = args.get(i).cloned();
            }
            "--base-url" => {
                i += 1;
                if let Some(u) = args.get(i) {
                    base_url = u.clone();
                }
            }
            _ => {}
        }
        i += 1;
    }

    // Detect key (ORCAROUTER_API_KEY env, or prompt)
    let api_key = match key {
        Some(k) => {
            eprintln!("  Using provided key");
            k
        }
        None => {
            if let Ok(k) = env::var("ORCAROUTER_API_KEY") {
                if !k.is_empty() {
                    eprintln!("  Found key in ORCAROUTER_API_KEY environment variable");
                    k
                } else {
                    let k = prompt_key();
                    if k.is_empty() {
                        eprintln!("  Aborted.");
                        process::exit(1);
                    }
                    k
                }
            } else {
                let k = prompt_key();
                if k.is_empty() {
                    eprintln!("  Aborted.");
                    process::exit(1);
                }
                k
            }
        }
    };

    // Validate
    eprintln!("\n  Verifying key with {}...", base_url);
    let result = validate_key(&api_key, &base_url);

    if !result.valid {
        eprintln!("  FAILED: {}", result.error.unwrap_or_default());
        process::exit(1);
    }

    eprintln!("  Key valid.");

    // Model selection
    let default_model = "orcarouter/auto";
    let default_small = "orcarouter/fusion-flash";

    let model = match model_override {
        Some(m) => m,
        None => select_model(&result.models, default_model),
    };

    let small_model = match small_model_override {
        Some(m) => m,
        None => {
            let candidates: Vec<&str> = vec!["orcarouter/fusion-flash", "orcarouter/auto"];
            let auto = result
                .models
                .iter()
                .find(|m| candidates.contains(&m.as_str()))
                .map(|s| s.as_str())
                .unwrap_or(default_small);
            auto.to_string()
        }
    };

    // Write
    eprintln!("\n  model: {}", model);
    eprintln!("  smallModel: {}", small_model);
    write_provider("orcarouter", &api_key, &base_url, &model, &small_model);
    eprintln!("\n  Done. Run `claude` to start.\n");
}

fn cmd_status() {
    eprintln!("\n  ── Provider Status ──\n");

    match read_current_provider() {
        Some(config) => {
            let ptype = config["type"].as_str().unwrap_or("anthropic");
            let model = config["model"].as_str().unwrap_or("(default)");
            let small = config["smallModel"].as_str().unwrap_or("(default)");
            let url = config["baseURL"].as_str().unwrap_or("https://api.anthropic.com");
            let has_key = config["apiKey"].as_str().map(|k| !k.is_empty()).unwrap_or(false);

            eprintln!("  type:       {}", ptype);
            eprintln!("  model:      {}", model);
            eprintln!("  smallModel: {}", small);
            eprintln!("  baseURL:    {}", url);
            eprintln!("  apiKey:     {}", if has_key { "(set)" } else { "(empty — using OAuth)" });

            if has_key && (ptype == "grok" || ptype == "orcarouter" || ptype == "openai-compat") {
                let key = config["apiKey"].as_str().unwrap();
                eprintln!("\n  Verifying...");
                let result = validate_key(key, url);
                if result.valid {
                    eprintln!("  Key valid. {} model(s) available.", result.models.len());
                } else {
                    eprintln!("  Key INVALID: {}", result.error.unwrap_or_default());
                }
            }
        }
        None => {
            eprintln!("  No provider.json found at {}", provider_json_path().display());
            eprintln!("  Using default (Anthropic OAuth).");
        }
    }
    eprintln!();
}

fn cmd_reset() {
    let default_config = json!({
        "apiKey": "",
        "baseURL": "https://api.anthropic.com",
        "model": "",
        "smallModel": "",
        "timeoutMs": 3000000
    });

    let path = provider_json_path();
    let content = serde_json::to_string_pretty(&default_config).unwrap() + "\n";
    fs::write(&path, &content).unwrap_or_else(|e| {
        eprintln!("  Failed to write {}: {}", path.display(), e);
        process::exit(1);
    });
    eprintln!("\n  Reset provider.json to default (Anthropic).\n");
}

// ─── Main ────────────────────────────────────────────────────

fn print_usage() {
    eprintln!(
        r#"
  clawgod-import — Import third-party API providers into clawgod

  Usage:
    clawgod-import grok [options]          Import from grok-cli / xAI
    clawgod-import orcarouter [options]    Import from OrcaRouter
    clawgod-import openai-compat [options] Import any OpenAI-compatible API
    clawgod-import status                  Show current provider config
    clawgod-import reset                   Reset to default (Anthropic)

  Options (grok):
    -k, --key <KEY>           API key (auto-detects from ~/.grok/ if omitted)
    -m, --model <MODEL>       Model name (default: grok-4)
    --small-model <MODEL>     Small/fast model (default: grok-3-mini)
    --base-url <URL>          API base URL (default: https://api.x.ai/v1)

  Options (orcarouter):
    -k, --key <KEY>           API key (defaults to ORCAROUTER_API_KEY env)
    -m, --model <MODEL>       Model name (default: orcarouter/auto)
    --small-model <MODEL>     Small/fast model (default: orcarouter/fusion-flash)
    --base-url <URL>          API base URL (default: https://api.orcarouter.ai/v1)

  Options (openai-compat):
    -k, --key <KEY>           API key
    -u, --base-url <URL>      API base URL (required)
    -m, --model <MODEL>       Model name
    --small-model <MODEL>     Small/fast model

  Examples:
    clawgod-import grok                           # auto-detect grok-cli key
    clawgod-import grok -k xai-abc123             # manual key
    clawgod-import orcarouter                     # use ORCAROUTER_API_KEY env
    clawgod-import openai-compat -k sk-xxx \
      -u https://api.deepseek.com/v1 -m deepseek-chat
"#
    );
}

fn main() {
    let args: Vec<String> = env::args().collect();

    match args.get(1).map(|s| s.as_str()) {
        Some("grok") => cmd_grok(&args[2..]),
        Some("orcarouter") => cmd_orcarouter(&args[2..]),
        Some("openai-compat") | Some("openai") => cmd_openai_compat(&args[2..]),
        Some("status") => cmd_status(),
        Some("reset") => cmd_reset(),
        Some("--help") | Some("-h") | Some("help") => print_usage(),
        _ => {
            print_usage();
            if args.len() > 1 {
                process::exit(1);
            }
        }
    }
}
