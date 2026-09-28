"""Secret resolution for every service adapter: env var first, macOS keychain second."""

from __future__ import annotations

import os
import subprocess  # ruff:ignore[suspicious-subprocess-import]
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from beartype.typing import Protocol

SECURITY_BINARY = 'security'


@dataclass(frozen=True)
class SecretSpec:
    """Where one secret lives: its env var and its keychain service/account."""

    env_var: str
    keychain_service: str
    keychain_account: str


SECRETS: dict[str, SecretSpec] = {
    'linear': SecretSpec(env_var='LINEAR_API_KEY', keychain_service='tlr-linear', keychain_account='api-key'),
    'linear-demo': SecretSpec(
        env_var='LINEAR_DEMO_API_KEY',
        keychain_service='tlr-linear',
        keychain_account='demo-key',
    ),
    'pylon': SecretSpec(env_var='PYLON_API_TOKEN', keychain_service='tlr-pylon', keychain_account='api-token'),
    'sentry': SecretSpec(env_var='SENTRY_AUTH_TOKEN', keychain_service='tlr-sentry', keychain_account='api-token'),
    'incidentio': SecretSpec(
        env_var='INCIDENT_IO_TOKEN',
        keychain_service='tlr-incidentio',
        keychain_account='api-key',
    ),
    'slack': SecretSpec(env_var='SLACK_USER_TOKEN', keychain_service='tlr-slack', keychain_account='user-token'),
}


class SecretStore(Protocol):
    """Resolves a secret by its `SECRETS` registry name."""

    def read_secret(self, name: str) -> str:
        """Return the secret value, raising when it is configured nowhere."""
        ...  # ruff:ignore[unnecessary-placeholder]


SecurityRunner = Callable[[list[str]], subprocess.CompletedProcess[str]]


def _run_security(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, check=False, text=True)  # noqa: S603


def _trimmed(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


@dataclass(frozen=True)
class EnvKeychainSecretStore:
    """Default `SecretStore`: an env var, then a `security find-generic-password` lookup."""

    environ: Mapping[str, str] = field(default_factory=lambda: dict(os.environ))
    run_security: SecurityRunner = _run_security

    def read_secret(self, name: str) -> str:
        """Return the secret for `name`, raising when it is configured nowhere."""
        spec = SECRETS[name]
        if (value := _trimmed(self.environ.get(spec.env_var))) is not None:
            return value
        if (value := self._read_keychain(spec)) is not None:
            return value
        msg = (
            f'no secret for {name!r}: set {spec.env_var} or run '
            f'security add-generic-password -s {spec.keychain_service} -a {spec.keychain_account} -w'
        )
        raise LookupError(msg)

    def _read_keychain(self, spec: SecretSpec) -> str | None:
        args = [
            SECURITY_BINARY,
            'find-generic-password',
            '-s',
            spec.keychain_service,
            '-a',
            spec.keychain_account,
            '-w',
        ]
        try:
            result = self.run_security(args)
        except FileNotFoundError:
            return None
        if result.returncode != 0:
            return None
        return _trimmed(result.stdout)


def read_secret(name: str) -> str:
    """Resolve `name` from the registry via the default env/keychain store."""
    return EnvKeychainSecretStore().read_secret(name)
