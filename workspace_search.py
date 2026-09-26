#!/usr/bin/env python3
"""Install or remove the SCM Toolkit Workspace Search companion extension."""

from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "workspace-search-extension"


def extension_version() -> str:
    return json.loads((SOURCE / "package.json").read_text())["version"]


def default_extensions_dir() -> Path:
    configured = os.environ.get("SCM_TOOLKIT_VSCODE_EXTENSIONS_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".vscode/extensions"


def extension_destination(extensions_dir: Path | None = None) -> Path:
    root = Path(extensions_dir) if extensions_dir is not None else default_extensions_dir()
    return root / f"jfwooten4.scm-toolkit-workspace-search-{extension_version()}"


def source_files() -> list[Path]:
    return sorted(path for path in SOURCE.rglob("*") if path.is_file())


def destination_matches(destination: Path) -> bool:
    if not destination.is_dir():
        return False
    expected = {path.relative_to(SOURCE) for path in source_files()}
    actual = {path.relative_to(destination) for path in destination.rglob("*") if path.is_file()}
    if expected != actual:
        return False
    return all(
        (SOURCE / relative).read_bytes() == (destination / relative).read_bytes()
        for relative in expected
    )


def installed_versions(extensions_dir: Path) -> list[Path]:
    if not extensions_dir.is_dir():
        return []
    return sorted(extensions_dir.glob("jfwooten4.scm-toolkit-workspace-search-*"))


def sync_extension(*, remove: bool = False, check: bool = False, extensions_dir: Path | None = None) -> bool:
    root = Path(extensions_dir) if extensions_dir is not None else default_extensions_dir()
    destination = extension_destination(root)
    stale = [path for path in installed_versions(root) if path != destination]

    if remove:
        targets = [path for path in installed_versions(root) if path.exists()]
        if check:
            return bool(targets)
        for target in targets:
            if target.is_symlink():
                target.unlink()
            else:
                shutil.rmtree(target)
        return bool(targets)

    changed = bool(stale) or not destination_matches(destination)
    if check or not changed:
        return changed

    root.mkdir(parents=True, exist_ok=True)
    for old in stale:
        if old.is_symlink():
            old.unlink()
        elif old.exists():
            shutil.rmtree(old)
    temp = root / f".{destination.name}.tmp"
    if temp.exists():
        shutil.rmtree(temp)
    shutil.copytree(SOURCE, temp)
    if destination.exists():
        if destination.is_symlink():
            destination.unlink()
        else:
            shutil.rmtree(destination)
    temp.rename(destination)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true", help="Remove Workspace Search")
    parser.add_argument("--check", action="store_true", help="Check whether installation would change anything")
    parser.add_argument("--extensions-dir", type=Path, help="Override the VS Code extensions directory")
    args = parser.parse_args()

    changed = sync_extension(
        remove=args.uninstall,
        check=args.check,
        extensions_dir=args.extensions_dir,
    )
    if args.check:
        print("Workspace Search needs an update." if changed else "Workspace Search is up to date.")
        return
    if args.uninstall:
        print("Removed Workspace Search." if changed else "Workspace Search was not installed.")
        return
    destination = extension_destination(args.extensions_dir)
    print(f"Installed Workspace Search to {destination}.")
    print("Reload or restart Visual Studio Code, then open Source Control → Workspace Search.")


if __name__ == "__main__":
    main()
