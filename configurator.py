#!/usr/bin/env python3
"""Local, dependency-free web configurator for the SCM toolkit."""

from __future__ import annotations

import html
import json
import secrets
import shutil
import subprocess
import threading
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from toolkit_settings import load_settings
from codex_colors import validate_color
from branch_names import load_catalog, merge_catalog, parse_imported_packs, parse_name_list, parse_pack_id_list
from chatgpt_integration import import_pgp_secret_key, sync_codex_instructions


OLLAMA_URL = "http://127.0.0.1:11434"
MAX_FORM_BYTES = 512 * 1024


@dataclass(frozen=True)
class Setting:
    name: str
    git_key: str
    label: str
    description: str
    section: str
    kind: str = "bool"


SETTINGS = (
    Setting("branchPicker", "scm-toolkit.branch-picker", "Branch picker", "Show the current branch in the commit-message row.", "Source control"),
    Setting("ponyBranch", "scm-toolkit.pony-branch", "Random branch button", "Create a freshly synced branch using the configured branch-name pool.", "Source control"),
    Setting("shortPlaceholder", "scm-toolkit.short-placeholder", "Short message placeholder", "Use Message instead of the longer built-in placeholder.", "Source control"),
    Setting("sourceControlLabel", "scm-toolkit.source-control-label", "Source Control label", "Override the Source Control view label shown in the app bar.", "Source control", "text"),
    Setting("filledButtons", "scm-toolkit.filled-buttons", "Accent-filled buttons", "Fill the branch and Commit controls with the theme accent instead of outlining them.", "Source control"),
    Setting("commitAndPush", "scm-toolkit.commit-and-push", "Commit and push checkbox", "Show the control backed by git.postCommitCommand.", "Source control"),
    Setting("branchCleanup", "scm-toolkit.branch-cleanup", "Branch cleanup", "Show guarded local-branch cleanup controls.", "Source control"),
    Setting("autocompleteToggle", "scm-toolkit.autocomplete-toggle", "Autocomplete toggle", "Show the inline-suggestion switch in the SCM message row.", "Source control"),
    Setting("codexCoauthor", "scm-toolkit.codex-coauthor", "Codex co-author button", "Show the attributed commit action.", "Source control"),
    Setting("hideOutgoingSyncCount", "scm-toolkit.hide-outgoing-sync-count", "Hide outgoing count", "Remove the outgoing commit count from Sync.", "Source control"),
    Setting("blankStateRefresh", "scm-toolkit.blank-state-refresh", "Refresh blank repositories", "Refresh clean repositories so their first new change appears quickly.", "Source control"),
    Setting("graphOpenWorkingFile", "scm-toolkit.graph-open-working-file", "Open graph files from working tree", "Make Source Control Graph Open File target the checked-out working-tree file instead of the selected commit snapshot.", "Source control"),
    Setting("workspaceSearchActivityBar", "scm-toolkit.workspace-search-activity-bar", "Standalone Activity Bar", "Move Workspace Search into its own Activity Bar container instead of the Source Control view.", "Workspace Search"),
    Setting("workspaceSearchLabel", "scm-toolkit.workspace-search-label", "Standalone label", "Label for the standalone Workspace Search Activity Bar container.", "Workspace Search", "text"),
    Setting("defaultBranch", "scm-toolkit.default-branch", "Default branch", "Protected branch and pull-request base.", "Repository", "text"),
    Setting("remote", "scm-toolkit.remote", "Git remote", "Remote used for branch checks and repository discovery.", "Repository", "text"),
    Setting("branchNameDisabledPacks", "scm-toolkit.branch-name-disabled-packs", "Name packs", "Enable or disable built-in and imported branch-name packs.", "Branch names", "packs"),
    Setting("branchCustomNames", "scm-toolkit.branch-custom-names", "Custom names", "Add your own lowercase branch names, one per line.", "Branch names", "names"),
    Setting("branchNameImports", "scm-toolkit.branch-name-imports", "Imported packs", "Paste third-party packs as JSON using id, label, description, and names.", "Branch names", "imports"),
    Setting("aiCommit", "scm-toolkit.ai-commit", "AI commit titles", "Generate commit messages through the local Ollama service.", "Ollama"),
    Setting("aiDefaultBranchDescription", "scm-toolkit.ai-default-branch-description", "Default-branch descriptions", "Add a short description when generating commits on the default branch.", "Ollama"),
    Setting("aiModelPicker", "scm-toolkit.ai-model-picker", "Model picker command", "Install the separate model-selection helper.", "Ollama"),
    Setting("aiCommitModel", "scm-toolkit.ai-commit-model", "Normal model", "Ollama model used when memory is available.", "Ollama", "model"),
    Setting("aiCommitLowMemoryModel", "scm-toolkit.ai-commit-low-memory-model", "Low-memory model", "Smaller Ollama model used below the memory threshold.", "Ollama", "model"),
    Setting("aiLowMemoryGiB", "scm-toolkit.ai-low-memory-gib", "Low-memory threshold (GiB)", "Available-memory threshold for selecting the smaller model.", "Ollama", "number"),
    Setting("mcpPullRequest", "scm-toolkit.mcp-pull-request", "Pull-request button", "Show the MCP-backed pull-request action.", "Pull requests"),
    Setting("mcpPrServer", "scm-toolkit.mcp-pr-server", "MCP server", "Configured VS Code MCP server name.", "Pull requests", "text"),
    Setting("mcpPrTool", "scm-toolkit.mcp-pr-tool", "MCP tool", "Tool invoked to create a pull request.", "Pull requests", "text"),
    Setting("codexUsageResetCountdown", "scm-toolkit.codex-usage-reset-countdown", "Codex reset countdown", "Show the live usage-reset countdown in Codex limit banners.", "Codex"),
    Setting("codexSendBackground", "scm-toolkit.codex-send-background", "Send button background", "Hex color for the Codex send button. Leave blank to use the theme.", "Codex", "color"),
    Setting("codexSendForeground", "scm-toolkit.codex-send-foreground", "Send button icon", "Hex color for the Codex send icon. Leave blank to use the theme.", "Codex", "color"),
    Setting("codexComposerLabelColor", "scm-toolkit.codex-composer-label-color", "Composer label text", "Hex color for Full access and Work locally controls. Leave blank to use the theme.", "Codex", "color"),
    Setting("chatgptCustomInstructions", "scm-toolkit.chatgpt-custom-instructions", "Custom instructions", "Keep a local copy of ChatGPT web custom instructions and mirror them into Codex global instructions.", "ChatGPT", "textarea"),
    Setting("chatgptWebCodexCoauthor", "scm-toolkit.chatgpt-web-codex-coauthor", "Codex Web co-author", "Require the Codex Web co-author trailer on Git commits made through web or GitHub tools.", "ChatGPT"),
    Setting("codexHideChatTimestamps", "scm-toolkit.codex-hide-chat-timestamps", "Hide chat timestamps", "Hide standalone date/time separators inside Codex conversations.", "Codex"),
    Setting("codexHideDictation", "scm-toolkit.codex-hide-dictation", "Hide dictation button", "Hide the microphone dictation control in Codex chat.", "Codex"),
)


def fetch_ollama_models() -> tuple[list[str], str]:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"{OLLAMA_URL}/api/tags", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return [], "Ollama was not detected at 127.0.0.1:11434. You can still enter model tags manually."

    models = set()
    for item in payload.get("models", []):
        for key in ("name", "model"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                models.add(value.strip())
    names = sorted(models)
    if names:
        return names, f"Detected {len(names)} local Ollama model{'s' if len(names) != 1 else ''}."
    return [], "Ollama is running locally, but it reported no installed models."


def parse_submission(values: dict[str, list[str]]) -> dict[str, bool | str]:
    parsed: dict[str, bool | str] = {}

    imports = parse_imported_packs(values.get("branchNameImports", ["[]"])[0])
    catalog = merge_catalog(load_catalog(), imports)
    known_ids = {str(pack["id"]) for pack in catalog["packs"]}
    rendered_ids = set(values.get("branchNameKnownPack", []))
    enabled_ids = set(values.get("branchNamePack", []))
    unknown_enabled = enabled_ids - known_ids
    if unknown_enabled:
        raise ValueError(f"Unknown branch-name pack: {sorted(unknown_enabled)[0]}")

    disabled = sorted((rendered_ids - enabled_ids) & known_ids)
    parsed["branchNameDisabledPacks"] = ",".join(disabled)
    parsed["branchCustomNames"] = ",".join(
        parse_name_list(values.get("branchCustomNames", [""])[0])
    )
    parsed["branchNameImports"] = json.dumps(imports, separators=(",", ":"))

    for setting in SETTINGS:
        if setting.kind in {"packs", "names", "imports"}:
            continue
        if setting.kind == "bool":
            parsed[setting.name] = setting.name in values
            continue

        raw_value = values.get(setting.name, [""])[0]
        if setting.kind == "color":
            parsed[setting.name] = validate_color(raw_value)
            continue
        if setting.kind == "textarea":
            if "\x00" in raw_value:
                raise ValueError(f"{setting.label} contains an invalid null byte.")
            parsed[setting.name] = raw_value.strip()
            continue

        value = raw_value.strip()
        if not value:
            raise ValueError(f"{setting.label} cannot be empty.")
        if "\x00" in value or "\n" in value or "\r" in value:
            raise ValueError(f"{setting.label} must fit on one line.")
        if setting.kind == "number":
            try:
                if float(value) <= 0:
                    raise ValueError
            except ValueError as error:
                raise ValueError(f"{setting.label} must be greater than zero.") from error
        parsed[setting.name] = value
    return parsed


def save_settings(settings: dict[str, bool | str]) -> None:
    git = shutil.which("git")
    if not git:
        raise RuntimeError("Git was not found on PATH.")

    previous: dict[str, str | None] = {}
    for setting in SETTINGS:
        result = subprocess.run(
            [git, "config", "--global", "--get", setting.git_key],
            capture_output=True,
            text=True,
        )
        if result.returncode not in (0, 1):
            raise RuntimeError(result.stderr.strip() or f"Unable to read {setting.git_key}")
        previous[setting.git_key] = result.stdout.rstrip("\n") if result.returncode == 0 else None

    written: list[Setting] = []
    try:
        for setting in SETTINGS:
            value = settings[setting.name]
            serialized = "true" if value is True else "false" if value is False else str(value)
            result = subprocess.run(
                [git, "config", "--global", "--replace-all", setting.git_key, serialized],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or f"Unable to write {setting.git_key}")
            written.append(setting)
    except Exception:
        for setting in reversed(written):
            old_value = previous[setting.git_key]
            args = [git, "config", "--global"]
            if old_value is None:
                args += ["--unset-all", setting.git_key]
            else:
                args += ["--replace-all", setting.git_key, old_value]
            subprocess.run(args, capture_output=True, text=True)
        raise


def _pack_controls(current: dict[str, object]) -> str:
    disabled = set(parse_pack_id_list(current.get("branchNameDisabledPacks", "")))
    raw_imports = current.get("branchNameImports", "[]")
    try:
        imports = parse_imported_packs(raw_imports)
        catalog = merge_catalog(load_catalog(), imports)
    except ValueError:
        catalog = load_catalog()

    controls = []
    for pack in catalog["packs"]:
        pack_id = str(pack["id"])
        checked = "" if pack_id in disabled else " checked"
        description = str(pack.get("description", ""))
        count = len(pack["names"])
        detail = f"{description} {count} name{'s' if count != 1 else ''}.".strip()
        escaped_id = html.escape(pack_id, quote=True)
        controls.append(
            f'<input type="hidden" name="branchNameKnownPack" value="{escaped_id}">'
            f'<label class="pack-card" title="{html.escape(detail, quote=True)}">'
            f'<input type="checkbox" name="branchNamePack" value="{escaped_id}"{checked}>'
            f'<span><strong>{html.escape(str(pack["label"]))}</strong>'
            f'<small>{count} names</small></span></label>'
        )
    return (
        '<fieldset class="pack-picker"><legend>Name bundles</legend>'
        '<p>Choose the bundles to draw branch names from.</p>'
        '<div class="pack-toolbar"><input type="search" id="pack-search" '
        'aria-label="Find name bundles" placeholder="Find a bundle…">'
        '<output id="pack-count" aria-live="polite"></output></div>'
        '<div class="pack-grid">' + "".join(controls) + '</div>'
        '<p id="pack-empty" hidden>No matching bundles.</p></fieldset>'
    )


def _setting_control(setting: Setting, current: object) -> str:
    label = html.escape(setting.label)
    description = html.escape(setting.description)
    name = html.escape(setting.name, quote=True)
    if setting.kind == "bool":
        checked = " checked" if current is True else ""
        return (
            '<label class="setting toggle-row">'
            f'<span><strong>{label}</strong><small>{description}</small></span>'
            f'<input type="checkbox" name="{name}" value="true"{checked}>'
            '<span class="toggle" aria-hidden="true"></span></label>'
        )

    if setting.kind == "packs":
        return ""

    if setting.kind == "names":
        value = "\n".join(parse_name_list(current))
        return (
            '<label class="setting textarea-row">'
            f'<span><strong>{label}</strong><small>{description}</small></span>'
            f'<textarea name="{name}" rows="6" spellcheck="false" '
            f'placeholder="rainy-day&#10;my-oc">{html.escape(value)}</textarea></label>'
        )

    if setting.kind == "textarea":
        return (
            '<label class="setting textarea-row">'
            f'<span><strong>{label}</strong><small>{description}</small></span>'
            f'<textarea name="{name}" rows="8" spellcheck="true">{html.escape(str(current or ""))}</textarea></label>'
        )

    if setting.kind == "imports":
        raw = str(current or "[]")
        try:
            value = json.dumps(parse_imported_packs(raw), indent=2)
        except ValueError:
            value = raw
        return (
            '<label class="setting textarea-row">'
            f'<span><strong>{label}</strong><small>{description} '
            'Example: [{"id":"friends","label":"Friends","names":["name-one","name-two"]}]'
            '</small></span>'
            f'<textarea name="{name}" rows="8" spellcheck="false">{html.escape(value)}</textarea></label>'
        )

    value = html.escape(str(current), quote=True)
    attrs = ' type="text"'
    if setting.kind == "number":
        attrs = ' type="number" min="0.1" step="0.1" inputmode="decimal"'
    list_attr = ' list="ollama-models"' if setting.kind == "model" else ""
    required = ' placeholder="#43AF49"' if setting.kind == "color" else " required"
    return (
        '<label class="setting field-row">'
        f'<span><strong>{label}</strong><small>{description}</small></span>'
        f'<input{attrs} name="{name}" value="{value}"{list_attr}{required}></label>'
    )


def render_form(
    current: dict[str, object],
    models: list[str],
    ollama_status: str,
    token: str,
    action_label: str,
    error: str = "",
) -> str:
    sections = []
    for section in dict.fromkeys(setting.section for setting in SETTINGS):
        controls = "".join(
            _setting_control(setting, current.get(setting.name, ""))
            for setting in SETTINGS
            if setting.section == section
        )
        if section == "Branch names":
            controls = _pack_controls(current) + controls
        if section == "ChatGPT":
            controls += (
                '<div class="setting textarea-row"><span><strong>Sync from ChatGPT web</strong>'
                '<small>Copy the Custom Instructions text from ChatGPT Personalization, then use this button. '
                'The localhost configurator reads only your clipboard after you click.</small></span>'
                '<button type="button" id="sync-chatgpt-instructions">Sync from web</button></div>'
                '<label class="setting textarea-row"><span><strong>PGP secret key</strong>'
                '<small>Optional. Imported directly into GnuPG through stdin. The private key is never saved '
                'to Git config, rendered back into this page, or written to command output.</small></span>'
                '<textarea name="pgpSecretKey" rows="6" spellcheck="false" autocomplete="off" '
                'placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"></textarea></label>'
            )
        status = ""
        if section == "Ollama":
            status = f'<p class="status">{html.escape(ollama_status)}</p>'
        sections.append(f'<section><h2>{html.escape(section)}</h2>{status}{controls}</section>')

    options = "".join(f'<option value="{html.escape(model, quote=True)}"></option>' for model in models)
    error_html = f'<div class="error" role="alert">{html.escape(error)}</div>' if error else ""
    action = "/save?token=" + urllib.parse.quote(token)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SCM Toolkit Setup</title><style>
:root{{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#f0f6fc;--muted:#8b949e;--accent:#2f81f7;--danger:#f85149}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
main{{width:min(880px,calc(100% - 32px));margin:40px auto 96px}}header{{margin-bottom:24px}}h1{{margin:0 0 8px;font-size:30px}}header p,.status{{color:var(--muted)}}
section{{margin:16px 0;padding:8px 20px;background:var(--panel);border:1px solid var(--line);border-radius:12px}}h2{{font-size:16px;margin:10px 0}}
.setting{{display:flex;align-items:center;gap:20px;min-height:62px;padding:10px 0;border-top:1px solid var(--line)}}.setting:first-of-type{{border-top:0}}.setting>span:first-child{{flex:1;min-width:0}}strong,small{{display:block}}small{{margin-top:2px;color:var(--muted)}}
.field-row input,.textarea-row textarea{{width:min(440px,52%);padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}}.textarea-row textarea{{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}
.toggle-row input{{position:absolute;opacity:0;pointer-events:none}}.toggle{{position:relative;width:42px;height:24px;flex:none;border-radius:99px;background:#484f58;transition:.15s}}.toggle:after{{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:white;transition:.15s}}input:checked+.toggle{{background:var(--accent)}}input:checked+.toggle:after{{transform:translateX(18px)}}input:focus-visible+.toggle,.field-row input:focus,.textarea-row textarea:focus{{outline:2px solid var(--accent);outline-offset:2px}}
.actions{{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:10px;margin-top:24px;padding:16px;background:color-mix(in srgb,var(--bg) 92%,transparent);border:1px solid var(--line);border-radius:12px;backdrop-filter:blur(12px)}}button{{padding:9px 15px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--text);font:inherit;cursor:pointer}}button.primary{{border-color:var(--accent);background:var(--accent);font-weight:600}}.error{{margin-bottom:16px;padding:12px;border:1px solid var(--danger);border-radius:8px;color:#ffb3ad}}
.pack-picker{{margin:12px 0;padding:14px;border:1px solid var(--line);border-radius:10px;min-width:0}}.pack-picker legend{{font-weight:600;padding:0 6px}}.pack-picker p{{margin:0 0 12px;color:var(--muted)}}.pack-toolbar{{display:flex;align-items:center;gap:12px;margin-bottom:12px}}.pack-toolbar input{{width:100%;min-width:0;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);font:inherit}}.pack-toolbar output{{white-space:nowrap;color:var(--muted);font-size:12px}}.pack-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;max-height:320px;overflow:auto;padding:3px}}.pack-card{{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--line);border-radius:8px;cursor:pointer;background:var(--bg);transition:border-color .15s,background .15s}}.pack-card:has(input:checked){{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,var(--bg))}}.pack-card:has(input:focus-visible){{outline:2px solid var(--accent);outline-offset:1px}}.pack-card input{{accent-color:var(--accent);width:16px;height:16px;flex:none}}.pack-card[hidden]{{display:none}}.pack-card strong{{font-size:13px}}.pack-card small{{font-size:12px}}
@media(max-width:620px){{main{{width:min(100% - 20px,880px);margin-top:20px}}.field-row,.textarea-row{{align-items:flex-start;flex-direction:column;gap:8px}}.field-row input,.textarea-row textarea{{width:100%}}}}
</style></head><body><main><header><h1>SCM Toolkit Setup</h1><p>Configure locally, save to global Git config, then return to the terminal. No data leaves this computer.</p></header>
{error_html}<form method="post" action="{action}">{''.join(sections)}<datalist id="ollama-models">{options}</datalist>
<div class="actions"><button type="submit" name="action" value="cancel">Cancel</button><button class="primary" type="submit" name="action" value="save">{html.escape(action_label)}</button></div></form>
<script>
const packSearch = document.getElementById('pack-search');
const packCards = [...document.querySelectorAll('.pack-card')];
function updatePacks() {{
  const query = packSearch.value.trim().toLocaleLowerCase();
  let visible = 0;
  let selected = 0;
  for (const card of packCards) {{
    card.hidden = !card.textContent.toLocaleLowerCase().includes(query);
    if (!card.hidden) visible++;
    if (card.querySelector('input').checked) selected++;
  }}
  document.getElementById('pack-count').textContent = `${{selected}} / ${{packCards.length}} selected`;
  document.getElementById('pack-empty').hidden = visible > 0;
}}
if (packSearch) {{
  packSearch.addEventListener('input', updatePacks);
  for (const card of packCards) card.addEventListener('change', updatePacks);
  updatePacks();
}}
const syncButton = document.getElementById('sync-chatgpt-instructions');
if (syncButton) {{
  syncButton.addEventListener('click', async () => {{
    const target = document.querySelector('textarea[name="chatgptCustomInstructions"]');
    if (!target) return;
    try {{
      const value = await navigator.clipboard.readText();
      if (!value.trim()) throw new Error('Clipboard is empty.');
      target.value = value.trim();
      target.dispatchEvent(new Event('input', {{ bubbles: true }}));
      syncButton.textContent = 'Synced';
    }} catch (error) {{
      syncButton.textContent = 'Copy instructions, then retry';
      syncButton.title = String(error);
    }}
  }});
}}
</script>
</main></body></html>"""


def _result_page(saved: bool) -> str:
    title = "Configuration saved" if saved else "Configuration cancelled"
    detail = "Return to the terminal to continue." if saved else "No settings were changed."
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>body{{margin:0;background:#0d1117;color:#f0f6fc;font:16px system-ui;display:grid;min-height:100vh;place-items:center}}main{{text-align:center;padding:32px}}p{{color:#8b949e}}</style></head><body><main><h1>{title}</h1><p>{detail} You may close this tab.</p></main></body></html>"""


def run_configurator(current: dict[str, object], action_label: str = "Save configuration") -> bool:
    models, ollama_status = fetch_ollama_models()
    token = secrets.token_urlsafe(24)
    outcome: dict[str, bool | None] = {"saved": None}

    class Handler(BaseHTTPRequestHandler):
        def _send(self, content: str, status: int = 200) -> None:
            body = content.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            return secrets.compare_digest(query.get("token", [""])[0], token)

        def do_GET(self) -> None:
            if not self._authorized():
                self._send("<h1>Not found</h1>", 404)
                return
            self._send(render_form(current, models, ollama_status, token, action_label))

        def do_POST(self) -> None:
            if not self._authorized():
                self._send("<h1>Not found</h1>", 404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._send("<h1>Invalid request</h1>", 400)
                return
            if length > MAX_FORM_BYTES:
                self._send("<h1>Request too large</h1>", 413)
                return
            values = urllib.parse.parse_qs(
                self.rfile.read(length).decode("utf-8"), keep_blank_values=True
            )
            if values.get("action", [""])[0] == "cancel":
                outcome["saved"] = False
                self._send(_result_page(False))
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            try:
                parsed = parse_submission(values)
                save_settings(parsed)
                sync_codex_instructions(
                    str(parsed["chatgptCustomInstructions"]),
                    bool(parsed["chatgptWebCodexCoauthor"]),
                )
                import_pgp_secret_key(values.get("pgpSecretKey", [""])[0])
            except (RuntimeError, ValueError) as error:
                self._send(render_form(current, models, ollama_status, token, action_label, str(error)), 400)
                return
            outcome["saved"] = True
            self._send(_result_page(True))
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    url = f"http://127.0.0.1:{server.server_port}/?token={urllib.parse.quote(token)}"
    print(f"SCM Toolkit configurator: {url}")
    if not webbrowser.open(url):
        print("Open the URL above in a browser.")
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        print("\nConfiguration cancelled.")
    finally:
        server.server_close()
    return outcome["saved"] is True


if __name__ == "__main__":
    run_configurator(load_settings())
