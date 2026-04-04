# n8n-nodes-one-horizon

Certified-ready n8n community node for [One Horizon](https://onehorizon.ai), powered by One Horizon's MCP endpoint.

This package provides:
- Typed operations for the most-used One Horizon workflows
- OAuth2 authentication with dynamic client registration
- A `Raw Tool Call` operation for full MCP tool coverage

## Installation

### n8n Cloud (verified community node path)
1. Open **Nodes** in n8n.
2. Search for **One Horizon**.
3. Install the verified package.

### n8n Self-Hosted
Install in your n8n environment:

```bash
npm install n8n-nodes-one-horizon
```

Then restart n8n so the node is discovered.

## Credentials

Use the credential type **One Horizon MCP OAuth2 API**.

Default MCP endpoint:

```text
https://mcp.onehorizon.ai/mcp
```

Authentication uses One Horizon OAuth. On first use, n8n opens the consent flow.

## Typed Operations

- `List Planned Work` -> `list-planned-work`
- `List Completed Work` -> `list-completed-work`
- `List Blockers` -> `list-blockers`
- `My Work Recap` -> `my-work-recap`
- `Team Work Recap` -> `team-work-recap`
- `Create Todo` -> `create-todo`
- `Update Todo` -> `update-todo`
- `List Initiatives` -> `list-initiatives`
- `Create Initiative` -> `create-initiative`
- `Update Initiative` -> `update-initiative`
- `List Bugs` -> `list-bugs`
- `Report Bug` -> `report-bug`
- `Update Bug` -> `update-bug`
- `List My Teams` -> `list-my-teams`
- `Find Team Member` -> `find-team-member`
- `Raw Tool Call` -> any MCP tool via `tools/call`

## Raw Tool Call

Use this operation when:
- You need an MCP tool not yet exposed as a typed operation
- You want to pass full custom JSON arguments

`Raw Tool Name` supports:
- Searchable dropdown (hydrated from MCP `tools/list`)
- Manual ID entry

## Output Format

Each execution item returns:
- `operation` and `toolName`
- `toolArguments`
- `isError`
- `text` (joined text blocks, when available)
- `content` (structured MCP content array)
- `rawResult`

## Example Workflows

### 1. Daily personal recap
- Trigger: Cron (08:30 local)
- Node: One Horizon -> `My Work Recap`
- Follow-up: send to Slack/Email

### 2. Auto-log completed work
- Trigger: External event/webhook
- Node: One Horizon -> `Create Todo`
- Params: `status=Completed`, `topic=API`

### 3. Team blocker digest
- Trigger: Cron (weekday afternoon)
- Node: One Horizon -> `List Blockers`
- Optional: set `teamId`
- Follow-up: summarize and post to team channel

## Error Handling

Common failures:
- `401/403`: credential expired or insufficient access
- `429`: rate limiting upstream
- Validation errors: missing required tool arguments

The node surfaces MCP error details in the execution error output.

## Development

```bash
npm ci
npm run lint
npm run build
```

Run local n8n with hot reload:

```bash
npm run dev
```

## Verification and Release

### CI checks
- `npm run lint`
- `npm run build`
- `scan-community-package` (after publish)

### Publish with provenance
Publishing is handled by GitHub Actions and uses npm provenance (`--provenance`).

### Submit for n8n verification
Submit the package through the n8n Creator workflow after:
- Package is publicly available on npm
- Source repository is public and matches published package
- Docs and examples are complete

## Security and Scope

- The node does not use local filesystem access
- The node does not use environment-variable-based runtime behavior
- Access is scoped to the authenticated One Horizon user

## License

MIT
