# Developer Notes

## Local Development

```sh
git clone https://github.com/kyleking/tlr.git
cd tlr
uv sync --all-extras

# See the available tasks
uv run calcipy
# Or use a local 'run' file (so that 'calcipy' can be extended)
./run

# Run the default task list (lint, auto-format, test coverage, etc.)
./run main

# Make code changes and run specific tasks as needed:
./run lint.fix test
```

### Maintenance

Dependency upgrades can be accomplished with:

```sh
uv lock --upgrade
uv sync --all-extras
```

## Publishing

Publishing is automated via GitHub Actions using PyPI Trusted Publishing. Tag creation triggers automated publishing.

```sh
./run release              # Bumps version, creates tag, pushes → triggers publish
./run release --suffix=rc  # For pre-releases
```

### Initial Setup

One-time setup to enable PyPI Trusted Publishing:

**Configure GitHub Environments**

Repository Settings → Environments:
- Create `testpypi` environment (no protection rules)
- Create `pypi` environment with "Required reviewers" enabled

**Register Trusted Publishers**

PyPI: https://pypi.org/manage/project/tlr/settings/publishing/
- Owner: `kyleking`
- Repository: `tlr`
- Workflow: `publish.yml`
- Environment: `pypi`
    - Or environment `testpypi` (for [TestPyPI](https://test.pypi.org/manage/account/publishing))

### Manual Publishing

For emergency manual publish:

```sh
export UV_PUBLISH_TOKEN=pypi-...
uv build
uv publish
```

## Current Status

<!-- {cts} COVERAGE -->
| File                               | Statements | Missing | Excluded | Coverage |
|------------------------------------|-----------:|--------:|---------:|---------:|
| `tlr/__init__.py`                  | 4          | 0       | 0        | 100.0%   |
| `tlr/__main__.py`                  | 17         | 5       | 0        | 66.7%    |
| `tlr/_runtime_type_check_setup.py` | 13         | 0       | 37       | 100.0%   |
| `tlr/cli.py`                       | 32         | 0       | 0        | 100.0%   |
| `tlr/config.py`                    | 181        | 13      | 0        | 89.4%    |
| `tlr/domain/__init__.py`           | 0          | 0       | 0        | 100.0%   |
| `tlr/domain/capacity.py`           | 43         | 0       | 0        | 100.0%   |
| `tlr/http.py`                      | 61         | 3       | 0        | 94.8%    |
| `tlr/render/__init__.py`           | 0          | 0       | 0        | 100.0%   |
| `tlr/render/json.py`               | 15         | 0       | 0        | 100.0%   |
| `tlr/render/markdown.py`           | 22         | 1       | 0        | 92.9%    |
| `tlr/secrets.py`                   | 46         | 0       | 1        | 100.0%   |
| `tlr/services.py`                  | 127        | 41      | 0        | 64.8%    |
| `tlr/sources/__init__.py`          | 0          | 0       | 0        | 100.0%   |
| `tlr/sources/linear.py`            | 115        | 0       | 0        | 100.0%   |
| `tlr/sources/pylon.py`             | 88         | 3       | 0        | 92.5%    |
| `tlr/store.py`                     | 217        | 11      | 0        | 92.1%    |
| **Totals**                         | 981        | 77      | 38       | 89.6%    |

Generated on: 2026-09-02
<!-- {cte} -->
