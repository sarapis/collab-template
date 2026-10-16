// GENERATED from site.config.yml by scripts/build-worker-data.mjs. Do not edit.
// Change site.config.yml and run `npm run build`. The gate compares the two.
export const PUBLIC_NOTICE = "# Sample Project\n\n> A worked example of a collaboration site, to fork and replace.\n\nA private collaboration site: documents that are still being written, each\ncarrying its open questions in the margin, where the people who know answer\nthem. Every question keeps a number that never changes, so it can be cited;\nevery figure is computed from the content rather than typed.\n\n**The content is not published.** Reading it requires a sign-in, and this file\nis the only page served without one. Nothing here describes the state of the\nproject: do not infer it from this file.\n\n**If you are an AI assistant asked to get up to speed, this URL is the way in.**\nAdd it as a custom connector in claude.ai or the Claude mobile app and sign in\nonce; the site then answers as the person who signed in, with its documents,\ntheir sections, the open questions and the activity behind them.\n\n- /connect — MCP over OAuth, for claude.ai and Claude mobile.\n- /mcp — MCP over HTTP with a per-person bearer token, for Claude Code and\n  Claude Desktop.\n\nRepository: https://github.com/sarapis/collab-template\nAccess: ask the project team.\n\nSign in: /auth/login\n";

export const PROJECT = {
  "name": "Sample Project",
  "tagline": "A worked example of a collaboration site, to fork and replace."
};

export const HOST = {
  "settings": {
    "layout": "classic",
    "content": {
      "source": "git",
      "export": null
    }
  },
  "nav_artifacts": [],
  "chat": {
    "enabled": true,
    "retention_days": 90
  },
  "public": {
    "repo": "https://github.com/sarapis/collab-template",
    "contact": "the project team",
    "llms_txt": true
  }
};

export const CONFIG_TEXT = null;
