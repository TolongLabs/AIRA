"""Finite source and adapter registry for the standalone v1 text contract."""

import hashlib

BASELINE_ADAPTER_VERSION = "hermes-v0.23.4"
SOURCE_REVISIONS = {
    "ae2a81ccc00e9b7c06301523e5bb09608397149c": "hermes-v0.23.2",
    "caafe5389ae585ef77387a962aee05b1bcf17029": "hermes-v0.23.3",
    "8fc0374447313e276f6b9a2764bfc750190c966a": BASELINE_ADAPTER_VERSION,
}
ADAPTER_VERSIONS = tuple(SOURCE_REVISIONS.values())
_BASELINE_LINE = b'ADAPTER_VERSION = "hermes-v0.23.4"\n'
_BASELINE_SHA256 = "a530e9ca079c55c08e973f35ccf7138ba044ecb959d19eff15c593f4dca018fe"


def version_for_head(head: str) -> str | None:
    """Return the version only for an exact reviewed public source commit."""
    return SOURCE_REVISIONS.get(head)


def render_helper(template: bytes, version: str) -> bytes:
    """Select the helper version without changing any other reviewed bytes."""
    if (version not in ADAPTER_VERSIONS or hashlib.sha256(template).hexdigest() != _BASELINE_SHA256
            or template.count(_BASELINE_LINE) != 1):
        raise ValueError("unfamiliar Hermes helper template or version")
    return template.replace(_BASELINE_LINE, f'ADAPTER_VERSION = "{version}"\n'.encode(), 1)


def known_helper_version(template: bytes, current: bytes) -> str | None:
    """Recognize only exact rendered helper bytes, including the prior v1 helper."""
    return next((version for version in ADAPTER_VERSIONS if render_helper(template, version) == current), None)
