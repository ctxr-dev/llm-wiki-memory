# How it works

Three flows, all on-device: a **write path** (a session becomes durable notes), a **read path** (those notes come back as context), and **offline upkeep** (the store refines itself).

**The pieces.** An AI client talks to the MCP server (recall / search / save) and fires lifecycle hooks; an hourly cron does maintenance; both read and write one local, git-versioned Markdown tree, ranked by an on-device embedding index.

```mermaid
%%{init: {"theme":"base","flowchart":{"curve":"linear"},"themeVariables":{"lineColor":"#00B8C4","primaryColor":"#0D0D14","primaryTextColor":"#FCEE0A","primaryBorderColor":"#FCEE0A","secondaryColor":"#16161E","tertiaryColor":"#16161E","clusterBkg":"#16161E","clusterBorder":"#00B8C4","edgeLabelBackground":"#0D0D14","textColor":"#00B8C4"}}}%%
flowchart LR
    CL["AI client<br/>(Claude Code · Cursor · Codex)"]
    MCP["MCP server<br/>recall · search · save"]
    HK["hooks + hourly cron"]
    EM["embedding index<br/>(on-device)"]
    subgraph WIKI["wiki tree — local, git-versioned Markdown"]
      TREES["daily · knowledge · self_improvement · plans · investigations"]
    end
    CL <--> MCP
    CL --> HK
    MCP --> EM
    EM --> WIKI
    MCP <--> WIKI
    HK --> WIKI
```

## Write path — capture then compile

A session is captured to dated `daily/` notes by the flush hooks (and approved plans go straight to `plans/`); the hourly cron then promotes those atoms into the durable `knowledge/` and `self_improvement/` trees, superseding the daily source.

```mermaid
%%{init: {"theme":"base","flowchart":{"curve":"linear"},"themeVariables":{"lineColor":"#00B8C4","primaryColor":"#0D0D14","primaryTextColor":"#FCEE0A","primaryBorderColor":"#FCEE0A","secondaryColor":"#16161E","tertiaryColor":"#16161E","clusterBkg":"#16161E","clusterBorder":"#00B8C4","edgeLabelBackground":"#0D0D14","textColor":"#00B8C4"}}}%%
flowchart LR
    S[AI session]
    S -- "flush hooks<br/>(pre/post-compact, session-end)" --> DA[daily/]
    S -- "ExitPlanMode hook" --> PL[plans/]
    DA -- "compile<br/>(hourly cron + session-start)" --> KSI["knowledge/ + self_improvement/"]
    KSI -. supersedes daily source .-> DA
```

The capture worker chunks oversized transcripts and is recoverable on failure — full detail in [capture.md](capture.md).

## Read path — recall

Before a task (and at session start) the agent calls `recall_lessons` / `search_memory`; the embedding index ranks leaves across the trees and returns the top hits as a briefing or an applied lesson — nothing leaves the machine.

```mermaid
%%{init: {"theme":"base","flowchart":{"curve":"linear"},"themeVariables":{"lineColor":"#00B8C4","primaryColor":"#0D0D14","primaryTextColor":"#FCEE0A","primaryBorderColor":"#FCEE0A","secondaryColor":"#16161E","tertiaryColor":"#16161E","clusterBkg":"#16161E","clusterBorder":"#00B8C4","edgeLabelBackground":"#0D0D14","textColor":"#00B8C4"}}}%%
flowchart LR
    AG["session start /<br/>agent task"] --> RC["recall_lessons ·<br/>search_memory"]
    RC --> EM["embedding index<br/>(cosine rank)"]
    EM --> TR["knowledge · self_improvement · plans"]
    TR --> OUT["ranked hits →<br/>briefing / applied lesson"]
```

How embedding, ranking, and the vector cache work: [embeddings.md](embeddings.md).

## Offline upkeep

An opt-in hourly pass keeps the store from becoming a write-only graveyard (dedup, staleness refresh, housekeeping) and logs each attempt so failures surface next session — see [consolidate.md](consolidate.md).

## See also

- [mcp-tools.md](mcp-tools.md) — the MCP tool surface, `scopes`, and `target`.
- [write-gate.md](write-gate.md) — how self-improvement writes are gated.
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — the per-concern responsibility split (this package vs the underlying engine).
