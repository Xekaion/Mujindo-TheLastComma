# Paperdoll v1 held-gear alignment

`original/weapon` and `original/offhand` preserve the 20 unregistered atlases
that were partitioned from the ten fitted Harin source profiles. The schema 2
alignment report uses the `registered-delta-hand-connected-v2` contract: every
source frame is first registered to the neutral mannequin, then weapon and
offhand pixels are selected from the registered colour delta by semantic
connected-component and correct-hand gates. An owned-delta replacement or a
same-row gait-phase recovery is accepted only when it passes that same strict
gate. Every final held cell is non-empty, has at least three authored-hand
contact pixels and transparent padding, and has zero body-core and foot-core
pollution. The report pins all 20 inputs, 20 outputs, ten fitted source
profiles, and all 640 per-cell decisions by SHA-256.

Rebuild:

```powershell
python scripts/align_paperdoll_held_gear.py
python scripts/audit_paperdoll_held_gear.py `
  --body public/assets/walk/harin-mannequin-v1.png `
  --layers public/assets/paperdoll/v1 `
  --baseline-layers asset-sources/paperdoll/held-gear-v1/original `
  --alignment-report asset-sources/paperdoll/held-gear-v1/alignment-report.json `
  --report asset-sources/paperdoll/held-gear-v1/audit-report.json
python scripts/audit_paperdoll_slot_regions.py --strict
python scripts/build_paperdoll_anchor_report.py
python scripts/build_paperdoll_anchor_report.py --check
```

The current-PNG audit uses the independent `current-png-hand-geometry-v2`
contract. Report classifications are diagnostic only and can never waive the
hand-contact or geometry checks. The before/after contact sheet covers all ten
variants, eight authored directions, four gait phases, and both held slots
(`B` above, `A` below).

Any production rebuild changes the active atlas hashes. Regenerate the active
paperdoll anchor reports and intentionally update the manifest integrity pins
only after the strict slot-region audit passes; the alignment tool does not
edit the runtime manifest itself.
