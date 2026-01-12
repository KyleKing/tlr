"""Credential storage and retrieval."""

from __future__ import annotations

import getpass
import subprocess
import sys


def _get_from_keychain(service: str, account: str) -> str | None:
    """Retrieve credential from Mac Keychain."""
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError:
        return None


def _store_in_keychain(service: str, account: str, credential: str) -> bool:
    """Store credential in Mac Keychain."""
    try:
        subprocess.run(
            ["security", "add-generic-password", "-s", service, "-a", account, "-w", credential],
            check=True,
            capture_output=True,
        )
        return True
    except subprocess.CalledProcessError:
        try:
            subprocess.run(
                ["security", "delete-generic-password", "-s", service, "-a", account],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["security", "add-generic-password", "-s", service, "-a", account, "-w", credential],
                check=True,
                capture_output=True,
            )
            return True
        except subprocess.CalledProcessError:
            return False


def get_or_prompt_credential(
    service: str,
    account: str,
    prompt_message: str,
    help_url: str | None = None,
) -> str | None:
    """Get credential from keychain or prompt user."""
    if credential := _get_from_keychain(service, account):
        return credential

    print(f"No credential found in Keychain for {service}.", file=sys.stderr)
    if help_url:
        print(f"Get your credential from: {help_url}", file=sys.stderr)
    print(file=sys.stderr)

    credential = getpass.getpass(prompt_message)
    if not credential:
        return None

    if _store_in_keychain(service, account, credential):
        print("Credential stored in Keychain.", file=sys.stderr)
    else:
        print("Warning: Failed to store credential in Keychain.", file=sys.stderr)

    return credential
