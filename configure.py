#!/usr/bin/env python3
"""Open the local SCM Toolkit configuration interface."""

from configurator import run_configurator
from toolkit_settings import load_settings


if __name__ == "__main__":
    if run_configurator(load_settings()):
        print("Saved SCM Toolkit settings. Run python3 install.py to apply them.")
