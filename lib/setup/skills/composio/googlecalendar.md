## Calendar (toolkit: `googlecalendar`)

Common tools (verify with `composio tools list --toolkit googlecalendar`):

```bash
composio tools execute GOOGLECALENDAR_EVENTS_LIST --params-json '{"calendar_id": "primary", "max_results": 10}'
composio tools execute GOOGLECALENDAR_CREATE_EVENT --params-json '{"summary": "Meeting", "start_datetime": "...", "event_duration_minutes": 30}'
composio tools execute GOOGLECALENDAR_FIND_FREE_SLOTS --params-json '{"time_min": "...", "time_max": "..."}'
```

- Use RFC3339 timestamps with the user's timezone; confirm the timezone if ambiguous.
- Confirm with the user before creating, moving, or deleting events with attendees.
