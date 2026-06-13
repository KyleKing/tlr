# TLR - Tech Lead Reporter

TLR, pronounced "Teller"

Generate progress reports from Linear, Jira, and other project management tools.

## Installation

```bash
uv sync
```

## Usage

### Linear Reports

Generate a progress report for Linear projects:

```bash
# Single project, last 7 days (default)
tlr linear "My Project"

# Multiple projects
tlr linear "Engineering" "Infrastructure" --days 14

# Output to file
tlr linear "ENG" --days 7 --output report.md
```

### API Key Setup

The Linear API key is stored in Mac Keychain. On first run, you'll be prompted to enter your API key.

Get your Linear API key from: https://linear.app/settings/api

## Development

### Setup

```bash
uv sync
```

### Run Tests

```bash
uv run pytest
```

### Type Checking

```bash
uv run mypy
```

### Linting

```bash
uv run ruff check .
uv run ruff format .
```

## Architecture

```
tlr/
├── linear/          # Linear service (API client, models)
├── reporters/       # Output formatters (markdown, json)
├── models.py        # Common data structures
├── secrets.py       # Credential management
└── cli.py           # CLI interface
```

### Adding a New Service

1. Create service directory (e.g., `tlr/jira/`)
2. Implement API client functions
3. Define service-specific Pydantic models
4. Write `transform_to_report()` function returning `ProjectReport`
5. Add CLI subcommand in `cli.py`

The reporting layer (`reporters/markdown.py`) works with any service that returns `ProjectReport`.

## Project Structure

- **Services are NOT interchangeable** - each has unique functionality
- **Composable design** - reporters can combine output from multiple services
- **Testing focus** - comprehensive tests for reporting layer

## Migration from Script

The original `tlr-linear_progress.py` script has been refactored into:

- `tlr/linear/client.py` - Linear API functions
- `tlr/linear/models.py` - Pydantic models for validation
- `tlr/reporters/markdown.py` - Report generation
- `tlr/cli.py` - CLI interface

Run the new version:

```bash
tlr linear "Project Name" --days 7
```
