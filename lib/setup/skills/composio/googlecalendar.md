## Calendar (toolkit: `googlecalendar`)

Common tools (verify slugs with `composio search "..." --toolkits googlecalendar` or `--get-schema`):

```bash
composio execute GOOGLECALENDAR_EVENTS_LIST -d '{"calendar_id": "primary", "max_results": 10}'
composio execute GOOGLECALENDAR_CREATE_EVENT -d '{"summary": "Meeting", "start_datetime": "...", "event_duration_minutes": 30}'
composio execute GOOGLECALENDAR_FIND_FREE_SLOTS -d '{"time_min": "...", "time_max": "..."}'
```

- Use RFC3339 timestamps with the user's timezone; confirm the timezone if ambiguous.
- Confirm with the user before creating, moving, or deleting events with attendees.
