# Variables
BUN ?= bun
ACT ?= act
ACT_IMAGE ?= catthehacker/ubuntu:act-latest
ACT_ARCH ?= linux/amd64
DOCKER_HOST ?= unix:///var/run/docker.sock

.PHONY: help install build build-cli build-plugin lint lint-fix typecheck test coverage format format-check check gitleaks act-ci act-gitleaks act-codeql act-semgrep act-zap act-release act-all release-zip

help:
	@echo "Common targets:"
	@echo "  make install        # Install dependencies"
	@echo "  make build          # Build CLI and plugin"
	@echo "  make lint           # Run ESLint"
	@echo "  make lint-fix       # ESLint with --fix"
	@echo "  make typecheck      # TypeScript typecheck"
	@echo "  make test           # Run tests"
	@echo "  make coverage       # Run tests with coverage"
	@echo "  make format         # Prettier format"
	@echo "  make format-check   # Prettier check"
	@echo "  make check          # Typecheck + lint + coverage + format-check"
	@echo "  make gitleaks       # Run gitleaks if installed (optional)"
	@echo "  make act-ci         # Run CI workflow via act"
	@echo "  make act-gitleaks   # Run Gitleaks workflow via act"
	@echo "  make act-codeql     # Run CodeQL workflow via act (heavy)"
	@echo "  make act-semgrep    # Run Semgrep workflow via act (requires token)"
	@echo "  make act-zap        # Run ZAP workflow via act (requires target)"
	@echo "  make act-release    # Run Release workflow via act (simulated tag)"
	@echo "  make act-all        # Run key workflows via act"
	@echo "  make release-zip    # Build plugin.zip locally"

install:
	$(BUN) install --frozen-lockfile || $(BUN) install

build: build-cli build-plugin

build-cli:
	$(BUN) run build:cli

build-plugin:
	$(BUN) run build:plugin

lint:
	$(BUN) run lint

lint-fix:
	$(BUN) run lint:fix

typecheck:
	$(BUN) run typecheck

test:
	$(BUN) run test

coverage:
	$(BUN) run test:coverage

format:
	$(BUN) run format

format-check:
	$(BUN) run format:check

check:
	$(BUN) run check

# Security (optional local run)
gitleaks:
	@if command -v gitleaks >/dev/null 2>&1; then \
	  gitleaks detect -v -c .gitleaks.toml || true; \
	else \
	  echo "gitleaks not installed. See https://github.com/gitleaks/gitleaks"; \
	fi

# Local release packaging
release-zip:
	$(BUN) run build:plugin
	zip -j plugin.zip manifest.json dist/main.js styles.css || zip -j plugin.zip manifest.json dist/main.js
	@ls -lh plugin.zip

# Act runners (require docker + act installed)
act-ci:
	@command -v $(ACT) >/dev/null 2>&1 || { echo "act not installed: https://github.com/nektos/act"; exit 1; }
	DOCKER_HOST=$(DOCKER_HOST) $(ACT) --container-architecture $(ACT_ARCH) -P ubuntu-latest=$(ACT_IMAGE) -W .github/workflows/ci.yml

act-gitleaks:
	@command -v $(ACT) >/dev/null 2>&1 || { echo "act not installed: https://github.com/nektos/act"; exit 1; }
	DOCKER_HOST=$(DOCKER_HOST) $(ACT) --container-architecture $(ACT_ARCH) -P ubuntu-latest=$(ACT_IMAGE) -W .github/workflows/gitleaks.yml

act-codeql:
	@command -v $(ACT) >/dev/null 2>&1 || { echo "act not installed: https://github.com/nektos/act"; exit 1; }
	DOCKER_HOST=$(DOCKER_HOST) $(ACT) --container-architecture $(ACT_ARCH) -P ubuntu-latest=$(ACT_IMAGE) -W .github/workflows/codeql.yml

act-semgrep:
	@command -v $(ACT) >/dev/null 2>&1 || { echo "act not installed: https://github.com/nektos/act"; exit 1; }
	DOCKER_HOST=$(DOCKER_HOST) $(ACT) --container-architecture $(ACT_ARCH) -P ubuntu-latest=$(ACT_IMAGE) -W .github/workflows/semgrep.yml

act-zap:
	@command -v $(ACT) >/dev/null 2>&1 || { echo "act not installed: https://github.com/nektos/act"; exit 1; }
	@if [ -z "$$target" ]; then echo "Usage: make act-zap target=http://localhost:3000"; exit 2; fi
	DOCKER_HOST=$(DOCKER_HOST) $(ACT) --container-architecture $(ACT_ARCH) -P ubuntu-latest=$(ACT_IMAGE) -W .github/workflows/zap-dast.yml -e target=$$target

act-release:
	@command -v $(ACT) >/dev/null 2>&1 || { echo "act not installed: https://github.com/nektos/act"; exit 1; }
	@echo "Using secrets from .act.secrets if present"
	DOCKER_HOST=$(DOCKER_HOST) $(ACT) --container-architecture $(ACT_ARCH) -P ubuntu-latest=$(ACT_IMAGE) -W .github/workflows/release.yml -e .github/act-events/release_tag.json --secret-file .act.secrets || true

act-all: act-ci act-gitleaks
