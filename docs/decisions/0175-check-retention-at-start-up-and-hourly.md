# ADR-0175: Check Retention at Start-Up and Hourly

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Check retention at start-up and hourly against the newest successful run; record every background attempt and judge
request with its context.

## Rationale

Deploys reset uptime timers. Durable run times preserve retention, and failed attempts must remain visible.

## Source

Migrated from row 13 of the Deployment table in the former `docs/DECISIONS.md`.
