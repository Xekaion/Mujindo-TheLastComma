# Paperdoll v1 held-gear alignment

`original/weapon` and `original/offhand` preserve the 20 unregistered atlases
that were partitioned from the ten fitted Harin source sheets. Production
atlases are rebuilt with integer-only rigid translation; no layer pixel is
scaled, rotated, interpolated, or repainted.

Rebuild:

```powershell
python scripts/align_paperdoll_held_gear.py
python scripts/audit_paperdoll_held_gear.py `
  --body public/assets/walk/harin-mannequin-v1.png `
  --layers public/assets/paperdoll/v1 `
  --baseline-layers asset-sources/paperdoll/held-gear-v1/original `
  --alignment-report asset-sources/paperdoll/held-gear-v1/alignment-report.json `
  --report asset-sources/paperdoll/held-gear-v1/audit-report.json
```

The audit distinguishes visible contact-eligible silhouettes from tiny,
compact, lower-body-overlay, hidden-grip, and authoring-occluded fragments.
Those fragments keep their source geometry instead of being dragged to an
arbitrary torso pixel. Body-core overlap is reported as an attachment
diagnostic; foot-core growth is the hard pollution guard. The before/after
contact sheet covers all 10 variants, 8 authored directions, 4 gait phases,
and both held slots (`B` above, `A` below).

Any production rebuild changes the active atlas hashes. Regenerate the active
paperdoll anchor report after running this pipeline; the alignment tool does
not edit the runtime anchor manifest itself.
