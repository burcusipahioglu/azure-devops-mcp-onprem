# Contributing

Thanks for your interest in this project! It's maintained part-time, so please help keep the workflow lean.

## Before opening a pull request

**Open an issue first.** Describe the change you want to make and wait for a brief discussion on direction. This keeps everyone's time well spent — drive-by PRs without prior discussion may be closed without review.

## Especially welcome

- **Bug reports** — especially ones that include the Azure DevOps Server version and reproducible steps.
- **TFS version-specific edge cases** — different TFS deployments surface different quirks; concrete repros help.
- **New TFVC or on-prem tools** — niches the official Azure DevOps MCP Server doesn't cover are the sweet spot here.
- **Documentation improvements** — especially real-world configuration examples.

## Please avoid

- Large refactors without prior discussion.
- Adding new dependencies without justification.
- Features that only make sense for cloud Azure DevOps (those belong upstream).

## Local development

```bash
npm install
npm run build
npm start          # runs against whatever .env / .env.<profile> is configured
```

Tests aren't extensive yet; if you add a tool, a short sanity check in the PR description of how you verified it (against which TFS version) is appreciated.

## Code style

- TypeScript, ES modules.
- Follow existing patterns in `src/tools/*.ts` — each tool registers via `server.registerTool(...)` with a Zod input schema.
- Use `withErrorHandling()` + `jsonResponse()` / `textResponse()` from `utils/tool-response.ts`.
- No new dependencies without an issue discussion.

## Questions

Open a `Question` issue — happy to help if time permits. No promises on response SLA.
