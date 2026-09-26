#!/usr/bin/env python3
"""Open the local SCM Toolkit configuration interface."""

import install
from configurator import run_configurator


if __name__ == "__main__":
    if run_configurator(install.load_settings()):
        print("Saved SCM Toolkit settings. Run python3 install.py to apply them.")
