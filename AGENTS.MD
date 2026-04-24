## Memory

You have persistent memory via agent-memory-store MCP tools.

**Before acting on any task:**

1. `search_context` with 2–3 queries related to the task. Check for prior decisions, conventions, and relevant outputs.
2. `get_state("project_tags")` to load the tag vocabulary. If empty, this is a new project — ask the user about stack, conventions, and structure, then persist them with `write_context` and `set_state`.

**After completing work:**

1. `write_context` to persist decisions (with rationale), outputs (with file paths), and discoveries (with impact).
2. Use short, lowercase tags consistent with the vocabulary: `auth`, `config`, `decision`, `output`, `discovery`.
3. Set `importance: "critical"` for decisions other agents depend on, `"high"` for outputs, `"medium"` for background context.

**Before every write:**

1. `search_context` for the same topic first. If a chunk exists, `delete_context` it, then write the updated version. One chunk per topic.

**Rules:**

- Never guess a fact that might be in memory — search first, it costs <10ms.
- Never store secrets — write references to where they live, not the values.
- `set_state` is for mutable values (current phase, counters). `write_context` is for searchable knowledge (decisions, outputs). Don't mix them.
- Use `search_mode: "semantic"` when exact terms don't match (e.g., searching "autenticação" when the chunk says "auth").