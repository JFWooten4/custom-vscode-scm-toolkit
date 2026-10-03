"""Guarded, reversible fixes for the installed GitHub Pull Requests extension."""
import json
import re
from pathlib import Path

START = '\n/* sweetiebot-github-pr:start */\n'
END = '\n/* sweetiebot-github-pr:end */\n'
CLEANUP = re.compile(
    r'else if\(\(await [\w$]+\.githubRepository\.getMetadata\(\)\)\.delete_branch_on_merge\)'
    r'\{const ([\w$]+)=await [\w$]+\([\w$]+,[\w$]+\);return \1\.isReply\?void 0:\1\.message\}'
)
NUMBER_LINK = re.compile(
    r'href:([\w$]+),title:\1,"data-vscode-context":JSON\.stringify\([\w$]+\),'
    r'onClick:[\w$]+\(([\w$]+)=>\{\2\.preventDefault\(\),([\w$]+)\(\)\},"onClick"\)'
)


def transform(source, kind, remove=False):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete GitHub PR patch; refusing to overwrite it.')
    if START in source:
        before, remainder = source.split(START)
        metadata, after = remainder.split(END)
        original, replacement = json.loads(metadata.removeprefix("/* edit:").removesuffix(" */"))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('GitHub PR patch changed; refusing to overwrite it.')
        source = source.replace(replacement, original, 1)
    if remove:
        return source
    pattern = CLEANUP if kind == 'host' else NUMBER_LINK
    matches = list(pattern.finditer(source))
    if len(matches) != 1:
        raise ValueError(f'Unsupported GitHub PR {kind} build: expected one matching anchor.')
    original = matches[0].group()
    if kind == 'host':
        # Leave explicitly configured native automatic deletion and manual deletion intact.
        replacement = original[:original.index('{')] + '{return void 0}'
    else:
        # React's existing handler remains the sole opener; workbench link interception sees no href.
        opener = matches[0].group(3)
        replacement = ('role:"link",tabIndex:0,onKeyDown:event=>{if(event.key==="Enter")'
                       '{event.preventDefault();' + opener + '()}},'
                       + original.replace('href:', '"data-sweetiebot-url":', 1))
    return source.replace(original, replacement, 1) + START + "/* edit:" + json.dumps([original, replacement]) + " */" + END


def patch_files(extension_path=None, remove=False):
    candidates = ([Path(extension_path)] if extension_path else
                  sorted((Path.home() / '.vscode/extensions').glob('github.vscode-pull-request-github-*')))
    edits = []
    for extension in candidates:
        for filename, kind in [('extension.js', 'host'), ('browser/extension.js', 'host'),
                               ('webview-pr-description.js', 'webview')]:
            path = extension / 'dist' / filename
            if not path.is_file():
                continue
            old = path.read_text()
            if remove and START not in old:
                continue
            try:
                new = transform(old, kind, remove)
            except ValueError:
                if START in old:
                    raise
                print(f'Warning: unsupported GitHub PR asset {path.name}; skipping this optional fix.')
                continue
            edits.append((path, old, new))
    return edits
