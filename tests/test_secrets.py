"""Tests for tlr.secrets."""

from __future__ import annotations

import subprocess  # ruff:ignore[suspicious-subprocess-import]

import pytest

from tlr.secrets import SECRETS, EnvKeychainSecretStore


def _keychain_result(returncode: int, stdout: str = '') -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr='')


def _never_called(args: list[str]) -> subprocess.CompletedProcess[str]:
    msg = f'keychain should not be consulted, got {args}'
    raise AssertionError(msg)


def test_env_var_wins_over_keychain() -> None:
    store = EnvKeychainSecretStore(
        environ={'LINEAR_API_KEY': ' from-env '},
        run_security=_never_called,
    )
    assert store.read_secret('linear') == 'from-env'


def test_blank_env_var_falls_through_to_keychain() -> None:
    store = EnvKeychainSecretStore(
        environ={'LINEAR_API_KEY': '   '},
        run_security=lambda _args: _keychain_result(0, 'from-keychain\n'),
    )
    assert store.read_secret('linear') == 'from-keychain'


def test_keychain_used_when_env_var_missing() -> None:
    store = EnvKeychainSecretStore(environ={}, run_security=lambda _args: _keychain_result(0, 'from-keychain'))
    assert store.read_secret('pylon') == 'from-keychain'


@pytest.mark.parametrize('name', list(SECRETS))
def test_every_registry_entry_is_resolvable(name: str) -> None:
    spec = SECRETS[name]
    store = EnvKeychainSecretStore(environ={}, run_security=lambda _args: _keychain_result(0, 'a-secret-value'))
    assert store.read_secret(name) == 'a-secret-value'
    assert spec.env_var
    assert spec.keychain_service
    assert spec.keychain_account


def test_nonzero_exit_falls_through_to_not_found() -> None:
    store = EnvKeychainSecretStore(environ={}, run_security=lambda _args: _keychain_result(1))
    with pytest.raises(LookupError, match='no secret for'):
        store.read_secret('slack')


def test_missing_security_binary_resolves_to_not_found() -> None:
    def _raise_missing(_args: list[str]) -> subprocess.CompletedProcess[str]:
        raise FileNotFoundError

    store = EnvKeychainSecretStore(environ={}, run_security=_raise_missing)
    with pytest.raises(LookupError, match='no secret for'):
        store.read_secret('incidentio')


def test_missing_secret_names_the_fix_command_without_leaking_a_value() -> None:
    a_real_looking_token = 'super-secret-token-should-never-appear'  # ruff:ignore[hardcoded-password-string]
    store = EnvKeychainSecretStore(
        environ={'INCIDENT_IO_TOKEN': a_real_looking_token},
        run_security=_never_called,
    )
    assert store.read_secret('incidentio') == a_real_looking_token

    empty_store = EnvKeychainSecretStore(environ={}, run_security=lambda _args: _keychain_result(1))
    with pytest.raises(LookupError) as exc_info:
        empty_store.read_secret('incidentio')

    message = str(exc_info.value)
    assert a_real_looking_token not in message
    assert 'security add-generic-password -s tlr-incidentio -a api-key -w' in message
    assert 'INCIDENT_IO_TOKEN' in message


def test_keychain_args_never_carry_a_secret_value() -> None:
    seen_args: list[list[str]] = []

    def _capture(args: list[str]) -> subprocess.CompletedProcess[str]:
        seen_args.append(args)
        return _keychain_result(0, 'the-secret-value')

    store = EnvKeychainSecretStore(environ={}, run_security=_capture)
    assert store.read_secret('linear') == 'the-secret-value'
    assert len(seen_args) == 1
    assert 'the-secret-value' not in seen_args[0]
