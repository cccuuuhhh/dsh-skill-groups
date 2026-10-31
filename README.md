# dsh-skill-groups

Quick-switch named **skill groups** for DSH. Some skills are situational: you want them the moment you are doing research or trading, and you do not want them adding noise to the model's catalog the rest of the time. This plugin groups skills and switches between the groups in one click.

## What it actually changes

Only **which skills the model can discover**. A masked skill:

- disappears from the session skill catalog (saving context on every step),
- is still invocable by you with `/skill-name`,
- **is not deleted, moved, or rewritten on disk**, and
- keeps its real instructions — the plugin holds the captured body from the discovered provider, so a masked skill never degrades into a stub.

That last point is the reason the plugin does not rename files or edit `SKILL.md` frontmatter the way some skill managers do: those approaches pollute git and desynchronise every `SKILL.md` on every switch.

## Two kinds of group

| Kind | Behaviour |
| --- | --- |
| **Exclusive** | The "mode". Applying one automatically deactivates the other exclusive groups. |
| **Additive** | Overlays. Any number can be on at once, for the handful of skills you always want. |

A skill in no group is governed by the *default policy* — visible by default, so installing this plugin can never silently take skills away.

## Where to switch

- **Composer chip** (`conversation.input.left`) — the group name sits beside the input box; click to switch.
- **`/skillset <group>`** — from the composer. Also `/skillset off`, `/skillset add <group>`, `/skillset rm <group>`.
- **`/skillset`** with no argument lists every group and its current state.
- **Sidebar panel** — the full manager: groups, members, cost preview, auto rules, import/export, undo.
- **Model tools** — `skillgroup_current`, `skillgroup_list`, `skillgroup_apply`, `skillgroup_toggle`, `skillgroup_create`, `skillgroup_set_members`, `skillgroup_clear`, so you can just say "switch me to research mode".

## Per-session, not global

A switch scopes to the session you made it in. Two conversations can run different groups at once, and a new session falls back to your default. This is implemented with an agent-scoped skill provider rather than a global one, so the isolation is real rather than cosmetic.

## Cost preview

Before switching you can see roughly what the group costs: the catalog characters and estimated tokens it puts in front of the model. Descriptions are counted at the host's own 500-character cap, so the number matches what the model actually receives.

## Auto-activation rules

Optional, off by default. A rule can activate a group by workspace path, agent preset, or keywords. Rules only ever **activate** — an explicit switch always wins, and rules never deactivate something you chose.

## Configuration

Installed through the plugin manager. Two switches: the sidebar entry and the composer chip. State lives in `$DSH_HOME/skill-groups/state.json` (atomic write; a corrupt file degrades to defaults rather than throwing).

## Known limits

- Skills the host does not expose to `ctx.skills` cannot be grouped.
- MCP servers do **not** follow a group. The host has no runtime MCP toggle, so coupling them would require a restart — out of scope rather than faked.
- `/skillset --for-turn` depends on a turn counter; if it cannot be resolved the switch is made persistent and says so.
