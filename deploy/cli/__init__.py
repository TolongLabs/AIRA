"""AIRA portable host CLI.

Standard-library-only host launcher for standalone installs (P3).
Owns host actions: install discovery, setup, dashboard and status.
"""

from __future__ import annotations

__version__ = "1.0.0"

SCHEMA_VERSION = 1
INSTALL_MANIFEST_VERSION = 1

DEFAULT_SITE_PORT = 9890
DEFAULT_CORE_PORT = 9881
PORT_SCAN_MIN = 9881
PORT_SCAN_MAX = 9999
PORT_REBIND_RETRIES = 3

DEFAULT_IMAGE_REPOSITORY = "ghcr.io/tolonglabs/aira"
DEFAULT_IMAGE_TAG = "stable"

# Bounds mirror scripts/updater/ops.ts so the CLI and the updater share one budget.
DOCKER_PULL_BUDGET_MS = 20 * 60_000
DOCKER_PULL_FIRST_ATTEMPT_MS = 3 * 60_000
DOCKER_PULL_ATTEMPTS = 3
DOCKER_TIMEOUT_S = 90
COMPOSE_START_TIMEOUT_S = 60
HEALTH_VERIFY_TIMEOUT_S = 60
HEALTH_FETCH_TIMEOUT_S = 10
LOCK_WAIT_TIMEOUT_S = 30
BROWSER_TIMEOUT_S = 15

SITE_BIND_LOOPBACK = "127.0.0.1"

EXIT_OK = 0
EXIT_OPERATIONAL = 1
EXIT_ARGS = 2
EXIT_PREREQ = 3
EXIT_CONFLICT = 4
EXIT_ROLLBACK = 5

INSTALLATION_STATES = ("not_installed", "installing", "installed", "repair_required")
SERVICE_STATES = ("starting", "running", "stopped", "unhealthy")
PERSISTENCE_STATES = ("verified", "degraded", "unknown")
CONFIGURATION_STATES = ("setup_required", "configured", "invalid", "pending_activation")
HERMES_STATES = ("not_detected", "detected", "unsupported", "disconnected", "connected")
CHATBOT_STATES = ("inactive", "ready", "degraded")
