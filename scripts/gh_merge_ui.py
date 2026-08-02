# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "textual>=0.58",
# ]
# ///
"""Textual dashboard for reviewing and merging your open, approved GitHub PRs.

Requires the `gh` CLI to be installed and authenticated.

Run with: uvx gh_merge_ui.py
"""

import asyncio
import json
import logging
import shlex
from dataclasses import dataclass, field
from itertools import cycle
from typing import ClassVar

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.events import Mount
from textual.widgets import ContentSwitcher, DataTable, Footer, Header, RichLog

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger('gh_merge_ui')

PR_COLUMNS = [
    'number',
    'repository',
    'title',
    'createdAt',
    'updatedAt',
    'commentsCount',
    'state',
    'isDraft',
    'isLocked',
]


@dataclass(frozen=True)
class Config:
    """Search filters passed to `gh search prs`."""

    search_kwargs: dict[str, str] = field(
        default_factory=lambda: {'author': '@me', 'review': 'approved', 'state': 'open'},
    )


async def _capture_shell(cmd: str) -> str:
    proc = await asyncio.create_subprocess_shell(
        cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f'Command failed ({proc.returncode}): {cmd}\n{stderr.decode()}')
    return stdout.decode()


async def _safe_cmd(cmd: str) -> str:
    output = ''
    try:
        output = await _capture_shell(cmd)
        logger.debug('cmd=%s output=%s', cmd, output)
    except Exception:
        logger.exception('Error running command: %s', cmd)
    return output


async def list_prs(config: Config) -> list[tuple]:  # type: ignore[type-arg]
    """Return rows of open, approved PRs sorted by most recently updated."""
    gh_cli_args = []
    for key, value in config.search_kwargs.items():
        gh_cli_args += [f'--{key}', str(value)]
    joined_args = shlex.join(gh_cli_args)
    cmd = f"gh search prs --json='{','.join(PR_COLUMNS)}' --sort=updated --order=desc --limit=30 {joined_args}"
    output = await _capture_shell(cmd)
    records = []
    for record in json.loads(output):
        repo = record.pop('repository')
        record['repository'] = repo['nameWithOwner']
        records.append(tuple(record[key] for key in PR_COLUMNS))
    return sorted(records, key=lambda row: row[PR_COLUMNS.index('updatedAt')], reverse=True)


async def open_pr(*, repository: str, pr_id: str) -> None:
    """Open the PR in a browser."""
    await _safe_cmd(f"gh pr view {pr_id} --repo='{repository}' --web")


async def merge_pr(*, repository: str, pr_id: str, use_squash: bool) -> None:
    """Merge the PR."""
    opt_flags = '--squash' if use_squash else ''
    await _safe_cmd(f"gh pr merge {pr_id} --repo='{repository}' --body='' {opt_flags}")


class DebugLog(RichLog):
    """Toggleable debug log docked to the bottom of the screen."""

    DEFAULT_CSS = """
    #debug-log {
        dock: bottom;
        height: 10%;
    }
    """

    _text_logs = cycle(['debug-log', None])

    def compose(self) -> ComposeResult:
        super().compose()
        with ContentSwitcher(id='logs', initial=None):
            yield RichLog(id='debug-log', markup=True, highlight=True)

    def _on_mount(self, event: Mount) -> None:
        super()._on_mount(event)

        log = self.query_one('#debug-log', RichLog)
        handler = logging.Handler()
        handler.emit = lambda record: log.write(handler.format(record))  # type: ignore[method-assign]
        logger.addHandler(handler)

    def action_toggle_text_log(self) -> None:
        text_log_id = next(self._text_logs)
        new_id = self.query_one(f'#{text_log_id}', RichLog).id if text_log_id else None
        self.query_one('#logs', ContentSwitcher).current = new_id


class PRsDataTable(DataTable):  # type: ignore[type-arg]
    """GitHub PRs table."""

    BINDINGS: ClassVar[list[Binding]] = [  # type: ignore[assignment]
        Binding('r', 'refresh_rows', 'Refresh Data'),
        Binding('o', 'open_selected_pr', 'Open in Browser'),
        Binding('m', 'merge_selected_pr', 'Merge'),
        Binding('s', 'squash_selected_pr', 'Squash'),
        Binding('k', 'cursor_up', 'Cursor Up', show=False),
        Binding('j', 'cursor_down', 'Cursor Down', show=False),
    ]

    def __init__(self, *args, config: Config, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._config = config

    def _get_selected_row(self) -> dict:  # type: ignore[type-arg]
        row = self.get_row_at(self.cursor_coordinate.row)
        return dict(zip(PR_COLUMNS, row, strict=True))

    def on_mount(self) -> None:
        super().on_mount()
        self.cursor_type = 'row'
        self.zebra_stripes = True
        self.add_columns(*PR_COLUMNS)
        asyncio.create_task(self.action_refresh_rows())  # noqa: RUF006

    async def action_refresh_rows(self) -> None:
        self.clear()
        self.add_rows(await list_prs(self._config))

    async def action_open_selected_pr(self) -> None:
        row_data = self._get_selected_row()
        await open_pr(repository=row_data['repository'], pr_id=row_data['number'])

    async def action_merge_selected_pr(self) -> None:
        row_data = self._get_selected_row()
        await merge_pr(repository=row_data['repository'], pr_id=row_data['number'], use_squash=False)

    async def action_squash_selected_pr(self) -> None:
        row_data = self._get_selected_row()
        await merge_pr(repository=row_data['repository'], pr_id=row_data['number'], use_squash=True)


class MergeApp(App):  # type: ignore[type-arg]
    """A Textual dashboard for reviewing and merging PRs."""

    TITLE = 'GitOps: Merge UI'

    BINDINGS: ClassVar[list[Binding]] = [  # type: ignore[assignment]
        Binding('q', 'quit', 'Quit'),
        Binding('`', 'toggle_text_log', 'Toggle Debug Log'),
    ]

    def __init__(self, *args, config: Config | None = None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._config = config or Config()

    def compose(self) -> ComposeResult:
        header = Header()
        header.tall = True
        yield header
        yield Footer()
        yield PRsDataTable(id='datatable', config=self._config)
        yield DebugLog()

    def action_toggle_text_log(self) -> None:
        self.query_one(DebugLog).action_toggle_text_log()


if __name__ == '__main__':
    MergeApp().run()
