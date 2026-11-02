# Starting this in Claude Code

1. Unzip `owner-exit-workspace.zip` into a new folder and `cd` into it (or push the folder to a GitHub repo and open it from Claude Code's repo picker).
2. Run `claude` in that folder. It reads `CLAUDE.md` automatically; that file is the compressed version of the design conversation.
3. First prompt suggestion:

   > Read CLAUDE.md and the docs it points to. Then open prototype/front-door.html in a browser, exercise the loop (import → intake → path → scan → confirm → board), and propose a repo structure and stack for the production build that preserves the data model and the non-negotiable rules. Start with build-order item 1 (shared state file, two tiers, roles). Ask before choosing between monday.com and a custom board.

4. The artifact URL for the live prototype is in this conversation's history on claude.ai; Claude Code cannot open it, so the file in `prototype/` is the source of truth.
5. Keep the `docs/` files as the spec; edit them in place as decisions change so CLAUDE.md stays short.
