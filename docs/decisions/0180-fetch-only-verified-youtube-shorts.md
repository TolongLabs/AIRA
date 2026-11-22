# ADR-0180: Fetch Only Verified YouTube Shorts

- **Date:** 2026-11-23
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Partially supersedes:** [ADR-0108](0108-require-verified-native-attachments-for-group-autofetch.md)

## Decision

Allow the existing chat autofetch setting to deliver a verified YouTube Short. Confirm the canonical Shorts page,
media identity and non-live status before delivering an MP4. Standard and live YouTube links remain watch-only.
Use the verified file to recover a failed whole-Short URL watch within the remaining intake budget.

## Rationale

A short duration and a user-supplied Shorts path do not establish the video type.
The two checks keep ordinary videos out of delivery while the file gives the watcher a second input when URL reading fails.
See [media pipelines](../trd/media-pipelines.md#autofetch) and [issue #349](https://github.com/TolongLabs/AIRA/issues/349).
