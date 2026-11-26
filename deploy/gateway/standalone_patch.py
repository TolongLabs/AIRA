"""Standalone Hermes adapter patch for the pinned public source.

Covers ``docs/trd/system.md#standalone-hermes-transport`` and
``docs/trd/deployment.md#hermes-attachment-transaction``. Standard library only.

``patch_source`` inserts the one reviewed branch into the exact original file;
``classify_source`` tells original, patched and foreign trees apart by digest,
rebuilding the original from the added block. The helper module applied beside
the patched file is ``deploy/gateway/standalone_adapter.py``, installed as
``gateway/aira_transport.py``.
"""

from __future__ import annotations

import hashlib
from typing import Literal

TARGET = 'gateway/run_inbound_consumer.py'
ORIGINAL_SHA256 = '792de0590d946b1dc1b3232af0e00c53988ba5cd1bee44b28195326e71a58489'

ANCHOR_FIRST = b'        async with _routed_scope(runner, source):\n'
ANCHOR_SECOND = b'            from hermes_cli.lifecycle import ainvoke_hook, has_hook\n'
ANCHOR = ANCHOR_FIRST + ANCHOR_SECOND

ADDED = b'''            # AIRA: a selected attached profile consumes its admitted text without Hermes fallback.
            if source.platform and source.platform.value == "whatsapp":
                from hermes_constants import get_hermes_home
                _aira_marker = get_hermes_home() / "aira-transport.json"
                try:
                    _aira_marker.lstat()
                except FileNotFoundError:
                    pass
                except OSError:
                    return True, None
                else:
                    try:
                        from gateway.aira_transport import route as _aira_route
                        return True, await _aira_route(_aira_marker, event, source)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        return True, None
'''
PATCHED = ANCHOR_FIRST + ADDED + ANCHOR_SECOND
TYPED_ADDED = ADDED.replace(
    b'from gateway.aira_transport import route as _aira_route\n                        return True, await _aira_route(_aira_marker, event, source)',
    b'from gateway.aira_transport import route_typed as _aira_route\n                        return True, await _aira_route(_aira_marker, event, source, runner)',
)
TYPED_PATCHED = ANCHOR_FIRST + TYPED_ADDED + ANCHOR_SECOND


def patch_source(original: bytes, protocol: int = 1) -> bytes:
    """Insert the adapter branch into the exact original file.

    Raises TypeError for non-bytes input and ValueError when the digest or the
    anchor does not match the pinned source exactly once.
    """
    if isinstance(original, bytearray):
        original = bytes(original)
    if not isinstance(original, bytes):
        raise TypeError('original must be bytes, got %s' % type(original).__name__)
    if hashlib.sha256(original).hexdigest() != ORIGINAL_SHA256:
        raise ValueError('digest mismatch: not the reviewed %s' % TARGET)
    if original.count(ANCHOR) != 1:
        raise ValueError('anchor found %d times in %s, want exactly once' % (original.count(ANCHOR), TARGET))
    if protocol not in (1, 2):
        raise ValueError('unsupported standalone protocol')
    return original.replace(ANCHOR, PATCHED if protocol == 1 else TYPED_PATCHED, 1)


def classify_source(current: bytes | bytearray) -> Literal['original', 'patched', 'typed', 'unsupported']:
    """Classify a candidate file.

    ``patched`` means removing the exact added block once rebuilds bytes whose
    digest matches the pinned original. Anything else is ``unsupported``.
    """
    if isinstance(current, bytearray):
        current = bytes(current)
    if not isinstance(current, bytes):
        raise TypeError('current must be bytes, got %s' % type(current).__name__)
    if hashlib.sha256(current).hexdigest() == ORIGINAL_SHA256:
        return 'original'
    if current.count(PATCHED) == 1:
        restored = current.replace(PATCHED, ANCHOR, 1)
        if hashlib.sha256(restored).hexdigest() == ORIGINAL_SHA256:
            return 'patched'
    if current.count(TYPED_PATCHED) == 1:
        restored = current.replace(TYPED_PATCHED, ANCHOR, 1)
        if hashlib.sha256(restored).hexdigest() == ORIGINAL_SHA256:
            return 'typed'
    return 'unsupported'


def select_protocol(current: bytes, protocol: int) -> bytes:
    """Switch only the exact reviewed consumer insertion, without modifying original bytes."""
    kind = classify_source(current)
    if kind == 'patched':
        current = current.replace(PATCHED, ANCHOR, 1)
    elif kind == 'typed':
        current = current.replace(TYPED_PATCHED, ANCHOR, 1)
    return patch_source(current, protocol)
