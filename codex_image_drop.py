"""Guarded, reversible capture of file drops throughout the Codex webview."""

import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
START = '\n/* scm-toolkit-codex-image-drop:start */\n'
END = '\n/* scm-toolkit-codex-image-drop:end */\n'


def transform(source, remove=False):
    if source.count(START) != source.count(END) or source.count(START) > 1:
        raise ValueError('Incomplete Codex image-drop patch.')
    if START in source:
        before, remainder = source.split(START, 1)
        payload, after = remainder.split(END, 1)
        metadata = re.search(r'^/\* edit:(.*?) \*/$', payload, re.MULTILINE)
        if metadata is None:
            raise ValueError('Codex image-drop restoration metadata is missing.')
        original, replacement = json.loads(metadata.group(1))
        source = before + after
        if source.count(replacement) != 1:
            raise ValueError('Installed Codex image-drop patch changed.')
        source = source.replace(replacement, original, 1)
    if remove or 'dragCounterRef:' not in source:
        return source
    ident = r'[A-Za-z_$][\w$]*'
    pattern = re.compile(
        rf'if\((?P<root>{ident})!=null\)return '
        rf'(?P=root)\.addEventListener\(`dragenter`,(?P<enter>{ident}),!0\),'
        rf'(?P=root)\.addEventListener\(`dragover`,(?P=enter),!0\),'
        rf'(?P=root)\.addEventListener\(`dragleave`,(?P<leave>{ident}),!0\),'
        rf'(?P=root)\.addEventListener\(`drop`,(?P<drop>{ident}),!0\),'
        rf'\(\)=>\{{(?P=root)\.removeEventListener\(`dragenter`,(?P=enter),!0\),'
        rf'(?P=root)\.removeEventListener\(`dragover`,(?P=enter),!0\),'
        rf'(?P=root)\.removeEventListener\(`dragleave`,(?P=leave),!0\),'
        rf'(?P=root)\.removeEventListener\(`drop`,(?P=drop),!0\)\}}'
    )
    matches = list(pattern.finditer(source))
    if len(matches) != 1:
        raise ValueError('Unsupported Codex build: image-drop listeners do not match.')
    match = matches[0]
    original = match.group(0)
    replacement = ('return scmToolkitRegisterImageDropTarget('
                   + ','.join(match[name] for name in ('root', 'enter', 'leave', 'drop')) + ')')
    source = source.replace(original, replacement, 1)
    return (source + START + '/* edit:' + json.dumps([original, replacement]) + ' */\n'
            + (HERE / 'codex-image-drop.js').read_text() + END)
