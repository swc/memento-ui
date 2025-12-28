# Agent Monitor (MVP)

Minimal local web UI to show current agent activity.

## Run
```bash
node monitor/server.js
```

## Open
- http://localhost:4317

## Notes
- Uses `.memento/state/activity/YYYY-MM-DD.jsonl` (UTC date) for latest activity.
- Agent list comes from `.memento/config.json` when available.
- Add a headshot at `monitor/ui/assets/agents/product-owner.png` to show the Product Owner card image.
