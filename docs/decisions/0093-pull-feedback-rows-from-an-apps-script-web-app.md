# ADR-0093: Pull Feedback Rows From an Apps Script Web App

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core pulls feedback rows from an Apps Script web app only while a report is open; Google never calls the host.

## Rationale

The host is behind Tailscale. An outbound TLS POST with a shared secret avoids a public callback and a Google Cloud
service-account key.

## Source

Migrated from row 93 of the Architecture table in the former `docs/DECISIONS.md`.
